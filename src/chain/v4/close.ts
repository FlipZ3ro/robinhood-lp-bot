/**
 * v4 close + fee-collect. Works for ANY pair (token/ETH, token/USDG, token/token) by
 * reconstructing the Position from the REAL pool currencies — the earlier code forced
 * native ETH as currency0, which produced wrong calldata and reverted on non-ETH pools.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { loadV4Deposit } from "./mint.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, Percent, CurrencyAmount } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4close");

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return addr.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/** Reconstruct the SDK Pool + Position for a tokenId from real on-chain currencies. */
async function loadPosition(tokenId: string) {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const liquidity: bigint = await posm.getPositionLiquidity!(tokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const [m0, m1] = await Promise.all([
    c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]),
  );
  const s0 = await sv.getSlot0!(poolId);
  const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
  const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
  const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", Number(s0.tick));
  const position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
  return { pool, position, cur0, cur1, c0, c1, m0, m1, fee, tickLower, tickUpper };
}

async function simulateAndSend(calldata: string, value: string, label: string): Promise<string> {
  const w = wallet();
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi ${label} v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  await tx.wait();
  return tx.hash;
}

export interface V4CloseResult {
  txHash: string;
  fee: number;
  recv0: number;
  sym0: string;
  recv1: number;
  sym1: string;
  depEth: number | null;
}

export async function closeV4Position(tokenId: string): Promise<V4CloseResult> {
  const w = wallet();
  const { pool, position, c0, c1, m0, m1, fee } = await loadPosition(tokenId);

  const { calldata, value } = V4PositionManager.removeCallParameters(position, {
    tokenId,
    liquidityPercentage: new Percent(100, 100),
    slippageTolerance: new Percent(Math.round(cfg.lp.slippagePct || 5), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    burnToken: true,
    collectOptions: {
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(pool.currency0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(pool.currency1, 0),
      recipient: w.address,
    },
  });

  const [bal0Before, bal1Before] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  const txHash = await simulateAndSend(calldata, value, "close");
  const [bal0After, bal1After] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);

  const dep = loadV4Deposit(String(tokenId));
  const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;
  dropDeposit(tokenId);
  log.info(`close v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return {
    txHash,
    fee,
    recv0: Math.max(0, bal0After - bal0Before),
    sym0: m0.symbol,
    recv1: Math.max(0, bal1After - bal1Before),
    sym1: m1.symbol,
    depEth,
  };
}

export interface V4CollectResult {
  txHash: string;
  fee0: number;
  sym0: string;
  fee1: number;
  sym1: string;
}

/**
 * Collect accrued fees WITHOUT removing liquidity. The SDK's removeCallParameters rejects
 * 0% liquidity, so we manually encode the standard v4 collect: DECREASE_LIQUIDITY(0) which
 * settles fees into owed balances, then TAKE_PAIR to sweep them to the wallet.
 */
export async function collectV4Fees(tokenId: string): Promise<V4CollectResult> {
  const w = wallet();
  const { c0, c1, m0, m1 } = await loadPosition(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = "0x0111"; // DECREASE_LIQUIDITY(0x01), TAKE_PAIR(0x11)
  const decParams = coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [tokenId, 0, 0, 0, "0x"]);
  const takeParams = coder.encode(["address", "address", "address"], [c0, c1, w.address]);
  const unlockData = coder.encode(["bytes", "bytes[]"], [actions, [decParams, takeParams]]);
  const iface = new ethers.Interface(["function modifyLiquidities(bytes,uint256) payable"]);
  const calldata = iface.encodeFunctionData("modifyLiquidities", [unlockData, Math.floor(Date.now() / 1000 + 600)]);

  const [b0, b1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  const txHash = await simulateAndSend(calldata, "0", "collect");
  const [a0, a1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  log.info(`collect v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return { txHash, fee0: Math.max(0, a0 - b0), sym0: m0.symbol, fee1: Math.max(0, a1 - b1), sym1: m1.symbol };
}

async function balOf(addr: string, dec: number): Promise<number> {
  const w = wallet();
  if (addr.toLowerCase() === NATIVE) return Number(ethers.formatEther(await provider.getBalance(w.address)));
  const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  return Number(ethers.formatUnits(await erc.balanceOf!(w.address).catch(() => 0n), dec));
}

function dropDeposit(tokenId: string): void {
  try {
    const d = readJson<Record<string, unknown>>(dataPath("v4-positions.json"), {});
    delete d[String(tokenId)];
    writeJson(dataPath("v4-positions.json"), d);
  } catch {
    /* */
  }
}
