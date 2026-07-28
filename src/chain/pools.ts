/**
 * Pool discovery + state, and range math.
 *
 * All tick↔price conversions go through the Uniswap SDK (`Pool`, `tickToPrice`) so we
 * never hand-roll Math.pow(1.0001, tick) again — that was the source of the float
 * precision drift in the old build.
 */
import { ethers } from "ethers";
// @uniswap/v3-sdk ships CommonJS — under Node ESM its named exports aren't statically
// detected, so import the default and destructure the runtime values.
import v3 from "@uniswap/v3-sdk";
import type { Pool as PoolT } from "@uniswap/v3-sdk";
import type { Token } from "@uniswap/sdk-core";
const { Pool, tickToPrice, TickMath } = v3;
import { cfg, C } from "../config.js";
import { provider } from "./client.js";
import { FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import { sdkToken } from "./tokens.js";
import type { PoolInfo, MintMode } from "../types.js";

const LN_10001 = Math.log(1.0001);

/** Robinhood Chain stablecoin. Some tokens keep their v3 liquidity in token/USDG, not token/WETH. */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;

/** All WETH-paired pools for a token that actually have liquidity, ranked by depth. */
export async function findPools(tokenAddr: string): Promise<PoolInfo[]> {
  const token = ethers.getAddress(tokenAddr);
  const weth = ethers.getAddress(C.weth);
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const wc = new ethers.Contract(weth, ERC20_ABI, provider);
  const out: PoolInfo[] = [];

  for (const fee of cfg.lp.feeTiers) {
    const pool: string = await factory.getPool!(token, weth, fee).catch(() => ethers.ZeroAddress);
    if (pool === ethers.ZeroAddress) continue;
    const pc = new ethers.Contract(pool, POOL_ABI, provider);
    const [liq, t0] = await Promise.all([pc.liquidity!(), pc.token0!()]);
    if (liq === 0n) continue;
    const wbal: bigint = await wc.balanceOf!(pool).catch(() => 0n);
    out.push({
      pool,
      fee,
      liquidity: liq,
      token0: ethers.getAddress(t0),
      wethInPool: Number(ethers.formatEther(wbal)),
    });
  }
  out.sort((a, b) => b.wethInPool - a.wethInPool);
  return out;
}

/**
 * All token/USDG v3 pools with liquidity. The WETH-only `findPools` misses these — some tokens
 * (e.g. JACKET) keep their real v3 liquidity in a token/USDG pool, so without this the bot shows
 * "0 v3" for a token that actually has a live, deep v3 pool. Ranked by USDG depth.
 */
export async function findUsdgPools(tokenAddr: string): Promise<PoolInfo[]> {
  const token = ethers.getAddress(tokenAddr);
  const usdg = ethers.getAddress(USDG);
  if (token.toLowerCase() === usdg.toLowerCase()) return [];
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const uc = new ethers.Contract(usdg, ERC20_ABI, provider);
  const out: PoolInfo[] = [];
  for (const fee of cfg.lp.feeTiers) {
    const pool: string = await factory.getPool!(token, usdg, fee).catch(() => ethers.ZeroAddress);
    if (pool === ethers.ZeroAddress) continue;
    const pc = new ethers.Contract(pool, POOL_ABI, provider);
    const [liq, t0] = await Promise.all([pc.liquidity!(), pc.token0!()]);
    if (liq === 0n) continue;
    const ubal: bigint = await uc.balanceOf!(pool).catch(() => 0n);
    out.push({
      pool,
      fee,
      liquidity: liq,
      token0: ethers.getAddress(t0),
      wethInPool: 0,
      quote: "usd",
      usdgInPool: Number(ethers.formatUnits(ubal, USDG_DECIMALS)),
    });
  }
  out.sort((a, b) => (b.usdgInPool ?? 0) - (a.usdgInPool ?? 0));
  return out;
}

/**
 * Choose which pool to LP into, honoring the fee focus (cfg.lp.minFeePpm / preferHighestFee).
 * Returns null when no pool meets the fee floor — auto-LP should then skip. Memecoin fee
 * income is thin at low tiers, so we prefer the highest eligible fee that still has depth.
 */
export function pickLpPool(pools: PoolInfo[]): PoolInfo | null {
  const eligible = pools.filter((p) => p.fee >= cfg.lp.minFeePpm && p.wethInPool > 0);
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    cfg.lp.preferHighestFee ? b.fee - a.fee || b.wethInPool - a.wethInPool : b.wethInPool - a.wethInPool,
  );
  return eligible[0]!;
}

export interface PoolState {
  pool: string;
  sdkPool: PoolT;
  fee: number;
  tick: number;
  spacing: number;
  token0: string;
  token1: string;
  token0Sdk: Token;
  token1Sdk: Token;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  wethIsToken0: boolean;
}

/** Read a pool's live state and wrap it in an SDK `Pool`. */
export async function getPoolState(poolAddr: string): Promise<PoolState> {
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [slot0, spacing, token0, token1, fee, liquidity] = await Promise.all([
    pc.slot0!(),
    pc.tickSpacing!(),
    pc.token0!(),
    pc.token1!(),
    pc.fee!(),
    pc.liquidity!(),
  ]);
  const t0 = ethers.getAddress(token0);
  const t1 = ethers.getAddress(token1);
  const [token0Sdk, token1Sdk] = await Promise.all([sdkToken(t0), sdkToken(t1)]);
  const tick = Number(slot0.tick);
  const sdkPool = new Pool(
    token0Sdk,
    token1Sdk,
    Number(fee),
    slot0.sqrtPriceX96.toString(),
    liquidity.toString(),
    tick,
  );
  return {
    pool: poolAddr,
    sdkPool,
    fee: Number(fee),
    tick,
    spacing: Number(spacing),
    token0: t0,
    token1: t1,
    token0Sdk,
    token1Sdk,
    sqrtPriceX96: slot0.sqrtPriceX96,
    liquidity,
    wethIsToken0: t0.toLowerCase() === C.weth.toLowerCase(),
  };
}

/** MCAP (USD) of the non-WETH token at a given tick. Uses SDK price math. */
export function mcapAtTick(st: PoolState, tick: number, ethUsd: number, supplyUi: number): number {
  const tokenSdk = st.wethIsToken0 ? st.token1Sdk : st.token0Sdk;
  const wethSdk = st.wethIsToken0 ? st.token0Sdk : st.token1Sdk;
  const clamped = Math.min(Math.max(tick, TickMath.MIN_TICK), TickMath.MAX_TICK);
  const priceInEth = Number(tickToPrice(tokenSdk, wethSdk, clamped).toSignificant(18));
  return priceInEth * ethUsd * supplyUi;
}

/** Width of the range in ticks, from widthPct, snapped to the pool's spacing. */
export function widthInTicks(spacing: number): number {
  const raw = Math.log(1 + cfg.lp.widthPct / 100) / LN_10001;
  return Math.max(spacing, Math.round(raw / spacing) * spacing);
}

export interface ComputedRange {
  tickLower: number;
  tickUpper: number;
  swapFraction: number; // 0..1, only meaningful for inrange mode
}

/**
 * Ticks for a new position.
 *   single: range fully on ONE side of price (single-sided WETH), with a buffer so a
 *           moving price doesn't cross it before the tx lands.
 *   inrange: range straddles price → needs both tokens → we swap `swapFraction` of WETH.
 */
export function computeRange(st: PoolState, mode: MintMode, bufferSpacings = cfg.lp.rangeBufferSpacings): ComputedRange {
  const sp = st.spacing;
  const width = widthInTicks(sp);

  if (mode === "inrange") {
    const half = Math.max(sp, Math.round(width / 2 / sp) * sp);
    const anchor = Math.floor(st.tick / sp) * sp;
    const tickLower = anchor - half;
    const tickUpper = anchor + half;
    return { tickLower, tickUpper, swapFraction: swapFractionForRange(st, tickLower, tickUpper) };
  }

  let tickLower: number;
  let tickUpper: number;
  if (st.wethIsToken0) {
    tickLower = (Math.floor(st.tick / sp) + bufferSpacings) * sp;
    tickUpper = tickLower + width;
  } else {
    tickUpper = (Math.floor(st.tick / sp) - bufferSpacings + 1) * sp;
    tickLower = tickUpper - width;
  }
  return { tickLower, tickUpper, swapFraction: 0 };
}

/**
 * Fraction of WETH to swap into the token so a straddling range [tl,tu] fills fully.
 *   amount0 = L·(√B−√P)/(√P·√B)   amount1 = L·(√P−√A)
 * Denominate both in token0, take the counter-token share. Clamped to [0.02, 0.95].
 */
export function swapFractionForRange(st: PoolState, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, st.tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return st.wethIsToken0 ? 0 : 1;
  if (sP >= sB) return st.wethIsToken0 ? 1 : 0;
  const a0 = (sB - sP) / (sP * sB);
  const a1in0 = (sP - sA) / (sP * sP);
  const fracToken1 = a1in0 / (a0 + a1in0);
  const f = st.wethIsToken0 ? fracToken1 : 1 - fracToken1;
  return Math.min(0.95, Math.max(0.02, f));
}
