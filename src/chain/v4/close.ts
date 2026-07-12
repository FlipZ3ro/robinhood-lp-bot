/**
 * v4 LP close — remove 100% liquidity + collect fees + burn the position NFT.
 * Reconstructs the Position from on-chain (PoolKey + packed PositionInfo + live pool
 * state), builds removeCallParameters via the SDK, simulates, then broadcasts. Native ETH
 * comes back automatically (TAKE_PAIR on the native currency).
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

export interface V4CloseResult {
  txHash: string;
  fee: number;
  recvEth: number;
  recvToken: number;
  tokenSym: string;
  depEth: number | null;
  pnlEth: number | null;
}

/** Decode int24 from a 24-bit two's-complement value. */
function signed24(v: number): number {
  return v >= 0x800000 ? v - 0x1000000 : v;
}

export async function closeV4Position(tokenId: string): Promise<V4CloseResult> {
  const w = wallet();
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, w);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const liquidity: bigint = await posm.getPositionLiquidity!(tokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));

  const currency0: string = pk.currency0;
  const currency1: string = pk.currency1;
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const tokenAddr = currency0.toLowerCase() === NATIVE ? currency1 : currency0; // non-native side
  const meta = await tokenMeta(tokenAddr).catch(() => ({ symbol: "?", decimals: 18 }));

  // live pool state
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [currency0, currency1, fee, tickSpacing, pk.hooks],
    ),
  );
  const s0 = await sv.getSlot0!(poolId);
  const poolLiq: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);

  const eth = Ether.onChain(cfg.chainId);
  const tok = new Token(cfg.chainId, ethers.getAddress(tokenAddr), meta.decimals, meta.symbol);
  const sdkPool = new Pool(eth, tok, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), poolLiq.toString(), Number(s0.tick));
  const position = new Position({ pool: sdkPool, liquidity: liquidity.toString(), tickLower, tickUpper });

  const { calldata, value } = V4PositionManager.removeCallParameters(position, {
    tokenId,
    liquidityPercentage: new Percent(100, 100),
    slippageTolerance: new Percent(Math.round(cfg.lp.slippagePct || 5), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    burnToken: true,
    collectOptions: {
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(sdkPool.currency0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(sdkPool.currency1, 0),
      recipient: w.address,
    },
  });

  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi close v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }

  const ethBefore = await provider.getBalance(w.address);
  const erc = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], provider);
  const tokBefore: bigint = await erc.balanceOf!(w.address).catch(() => 0n);

  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  await tx.wait();

  const ethAfter = await provider.getBalance(w.address);
  const tokAfter: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  const recvEth = Number(ethers.formatEther(ethAfter - ethBefore)); // net of gas — approximate
  const recvToken = Number(ethers.formatUnits(tokAfter - tokBefore, meta.decimals));

  const dep = loadV4Deposit(String(tokenId));
  const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;
  // realized value = ETH back (+ token still valued elsewhere). Simple PnL on ETH returned.
  const pnlEth = depEth != null ? recvEth - depEth : null;

  // drop the deposit record
  try {
    const d = readJson<Record<string, unknown>>(dataPath("v4-positions.json"), {});
    delete d[String(tokenId)];
    writeJson(dataPath("v4-positions.json"), d);
  } catch {
    /* */
  }

  log.info(`close v4 #${tokenId} ${meta.symbol} recvEth=${recvEth.toFixed(6)}`);
  return { txHash: tx.hash, fee, recvEth, recvToken, tokenSym: meta.symbol, depEth, pnlEth };
}
