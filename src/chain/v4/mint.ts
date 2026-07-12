/**
 * v4 LP open — single-sided native ETH (rug-safe, no Permit2, no token needed).
 *
 * Verified by staticCall simulation on chain 4663: single-sided ETH means a range ABOVE
 * the current tick (ETH = currency0, not yet converted to token). The @uniswap/v4-sdk
 * generates the modifyLiquidities calldata + native value; we simulate every mint with
 * eth_call BEFORE broadcasting, so a mint that would revert never costs gas.
 *
 * In-range (both-sided) v4 needs the token via Permit2 + a pre-swap — deferred.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { discoverV4Pools, pickV4Pool, type V4Pool } from "./discover.js";
import { swapEthToTokenV4 } from "./swap.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, Percent } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4mint");
const POS_FILE = dataPath("v4-positions.json");
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // canonical, all chains

export interface V4OpenResult {
  tokenId: string | null;
  txHash: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  depositEth: string;
  poolId: string;
}

type V4Dep = { depositWei: string; ts: number; poolId: string; fee: number; tickLower: number; tickUpper: number; mode: string };

export function saveV4Deposit(tokenId: string, rec: V4Dep): void {
  const d = readJson<Record<string, V4Dep>>(POS_FILE, {});
  d[tokenId] = rec;
  writeJson(POS_FILE, d);
}
export function loadV4Deposit(tokenId: string): V4Dep | null {
  return readJson<Record<string, V4Dep>>(POS_FILE, {})[tokenId] ?? null;
}

function buildSdkPool(token: string, decimals: number, symbol: string, pool: V4Pool) {
  const eth = Ether.onChain(cfg.chainId);
  const tok = new Token(cfg.chainId, ethers.getAddress(token), decimals, symbol);
  return new Pool(
    eth,
    tok,
    pool.fee,
    pool.tickSpacing,
    pool.poolKey.hooks,
    pool.sqrtPriceX96.toString(),
    pool.liquidity.toString(),
    pool.tick,
  );
}

/**
 * Open a single-sided native-ETH v4 position at the highest-fee pool with liquidity
 * (or a specific fee tier). Simulates before broadcasting.
 */
export async function openV4SingleSide(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult> {
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error("tidak ada pool v4/ETH dengan likuiditas");

  const meta = await tokenMeta(token);
  const sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, pool);

  // single-sided ETH → range ABOVE current tick (ETH not yet sold into token)
  const sp = pool.tickSpacing;
  const width = Math.max(1, opts.widthSpacings ?? Math.round((cfg.lp.widthPct / 100) / (Math.pow(1.0001, sp) - 1)));
  const tickLower = Math.ceil(pool.tick / sp) * sp + sp;
  const tickUpper = tickLower + width * sp;
  const amountWei = ethers.parseEther(amountEthStr);

  const position = Position.fromAmount0({
    pool: sdkPool,
    tickLower,
    tickUpper,
    amount0: amountWei.toString(),
    useFullPrecision: true,
  });
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil buat range ini");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(Math.round((cfg.lp.slippagePct || 5)), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  // SIMULATE before spending gas
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi mint v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }

  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, {
      depositWei: amountWei.toString(),
      ts: Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "single",
    });
  }
  log.info(`open v4 #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% ${amountEthStr}Ξ`);
  return { tokenId, txHash: tx.hash, fee: pool.fee, tickLower, tickUpper, depositEth: amountEthStr, poolId: pool.poolId };
}

/**
 * Open an IN-RANGE native-ETH v4 position (farming: earns fees immediately). Swaps part of
 * the ETH → token via the UniversalRouter, approves the token through Permit2, then mints a
 * range straddling the current price. Simulates before broadcasting.
 */
export async function openV4InRange(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error("tidak ada pool v4/ETH dengan likuiditas");
  const meta = await tokenMeta(token);
  const sp = pool.tickSpacing;

  // symmetric range straddling current tick
  const halfSpacings = Math.max(1, Math.round((opts.widthSpacings ?? 8) / 2));
  const anchor = Math.floor(pool.tick / sp) * sp;
  const tickLower = anchor - halfSpacings * sp;
  const tickUpper = anchor + halfSpacings * sp;

  const total = ethers.parseEther(amountEthStr);
  const frac = Math.min(0.9, Math.max(0.05, swapFractionV4(pool.tick, tickLower, tickUpper) * 0.98));
  const ethToSwap = (total * BigInt(Math.round(frac * 1e6))) / 1_000_000n;

  // 1) swap ETH → token
  const sw = await swapEthToTokenV4(pool.poolKey, ethToSwap);
  const tokenGot = sw.amountOut;
  if (tokenGot <= 0n) throw new Error("swap v4 ETH→token gagal (pool kering?)");

  // 2) approve token via Permit2 (ERC20 → Permit2, Permit2 → PositionManager)
  const erc = new ethers.Contract(
    token,
    ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    w,
  );
  if ((await erc.allowance!(w.address, PERMIT2)) < tokenGot) {
    await (await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides())).wait();
  }
  const permit2 = new ethers.Contract(PERMIT2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)"], w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await (await permit2.approve!(token, C.v4PositionManager!, (1n << 160n) - 1n, exp, await overrides())).wait();

  // 3) build both-sided position
  const ethLeft = total - ethToSwap;
  const sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, { ...pool });
  const isC0Native = pool.poolKey.currency0.toLowerCase().startsWith("0x000000000000000000");
  const position = Position.fromAmounts({
    pool: sdkPool,
    tickLower,
    tickUpper,
    amount0: (isC0Native ? ethLeft : tokenGot).toString(),
    amount1: (isC0Native ? tokenGot : ethLeft).toString(),
    useFullPrecision: true,
  });
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(Math.round(cfg.lp.slippagePct || 5), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi mint v4 in-range revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, { depositWei: total.toString(), ts: Date.now(), poolId: pool.poolId, fee: pool.fee, tickLower, tickUpper, mode: "inrange" });
  }
  log.info(`open v4 IN-RANGE #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% swapped ${Math.round(frac * 100)}%`);
  return {
    tokenId,
    txHash: tx.hash,
    swapHash: sw.tx,
    swappedPct: Math.round(frac * 100),
    fee: pool.fee,
    tickLower,
    tickUpper,
    depositEth: amountEthStr,
    poolId: pool.poolId,
  };
}

/** Fraction of ETH (currency0) to swap into token so a straddling range fills. */
function swapFractionV4(tick: number, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return 0;
  if (sP >= sB) return 1;
  const a0 = (sB - sP) / (sP * sB); // currency0 (ETH) per L
  const a1in0 = (sP - sA) / (sP * sP); // currency1 (token) per L, valued in currency0
  return a1in0 / (a0 + a1in0);
}

/** ERC721 Transfer(0x0 → recipient) → minted tokenId. */
function tokenIdFromReceipt(rc: ethers.TransactionReceipt): string | null {
  const posm = C.v4PositionManager!.toLowerCase();
  const ZERO = "0x" + "0".repeat(64);
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === posm && lg.topics.length === 4 && lg.topics[1] === ZERO) {
      return BigInt(lg.topics[3]!).toString();
    }
  }
  return null;
}
