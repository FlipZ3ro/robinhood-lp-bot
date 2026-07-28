/**
 * Candidate qualifier — does a token have a v4 pool in the target fee band (3-5%) with real 24h
 * volume? This is the "hard gate" shared by the hunter scanner and the feed: a token only counts
 * as a farmable LP candidate if there's an actual high-fee pool with turnover to earn from.
 */
import { cfg } from "../config.js";
import { discoverV4Pools, discoverV4UsdgPools, type V4Pool } from "./v4/discover.js";
import { dexPairs } from "./dexscreener.js";

export interface QualifiedPool {
  v4: V4Pool;
  fee: number;
  quote: "eth" | "usd";
  volUsd: number; // pool 24h volume (DexScreener)
  liqUsd: number;
  feesUsd: number; // est. 24h fees the pool generated = volUsd × feeRate
  feeYieldPct: number; // daily fee yield vs TVL (0 when TVL unreadable)
}

/**
 * Best v4 pool for `token` inside [feeMinPpm, feeMaxPpm]. Gates (#1 fee-yield):
 *   - volume ≥ minVolUsd (busy)
 *   - 24h fees generated (vol × feeRate) ≥ minPoolFeesUsd — weights a busy HIGH-fee pool over raw
 *     volume (a 5% pool at $8k vol beats a 3% pool at $9k), which is exactly what we farm.
 *   - daily fee/TVL yield ≥ minFeeYieldPct — only when TVL is readable (v4 singleton often reads $0,
 *     so this is skipped rather than blocking).
 * Ranks the survivors by absolute 24h fees (the real earning signal), not raw volume.
 */
export async function qualifyCandidate(token: string): Promise<QualifiedPool | null> {
  const s = cfg.scan;
  const [eth, usd, dex] = await Promise.all([
    discoverV4Pools(token).catch(() => [] as V4Pool[]),
    discoverV4UsdgPools(token).catch(() => [] as V4Pool[]),
    dexPairs(token, Date.now()).catch(() => new Map()),
  ]);
  let best: QualifiedPool | null = null;
  for (const p of [...eth, ...usd]) {
    if (p.fee < s.feeMinPpm || p.fee > s.feeMaxPpm) continue; // outside the 3-5% band
    const d = dex.get(p.poolId.toLowerCase());
    const volUsd = d?.vol24h ?? 0;
    if (volUsd < s.minVolUsd) continue; // not busy enough
    const liqUsd = d?.liqUsd ?? 0;
    const feesUsd = volUsd * (p.fee / 1e6); // fee ppm → rate (30000ppm = 3%)
    if (feesUsd < s.minPoolFeesUsd) continue; // #1: not enough fees generated to be worth farming
    const feeYieldPct = liqUsd > 0 ? (feesUsd / liqUsd) * 100 : 0;
    if (liqUsd > 0 && s.minFeeYieldPct > 0 && feeYieldPct < s.minFeeYieldPct) continue; // #1: TVL-relative yield too thin
    if (!best || feesUsd > best.feesUsd) best = { v4: p, fee: p.fee, quote: p.quote, volUsd, liqUsd, feesUsd, feeYieldPct };
  }
  return best;
}
