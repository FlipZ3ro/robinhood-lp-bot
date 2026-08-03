/**
 * DexScreener enrichment — per-pool 24h VOLUME + liquidity for a token. On Robinhood Chain v4 uses
 * a singleton PoolManager, so neither DexScreener nor an on-chain `getLiquidity()` snapshot reports
 * standing TVL reliably (both read ~$0 for live, high-volume v4 pools). VOLUME, however, IS reported
 * and is the signal that matters for high-fee farming (small capital · high fee · high turnover).
 *
 * Match key (DexScreener `pairAddress`, lowercased):
 *   • v2 / v3 → the pool CONTRACT address
 *   • v4      → the 32-byte POOL ID (verified: pairAddress === keccak poolId)
 */
import { logger } from "../util/log.js";

const log = logger("dexscreener");

export interface DexPair {
  pairAddr: string; // lowercased pool address (v2/v3) or poolId (v4)
  vol24h: number;
  liqUsd: number; // DexScreener's liquidity — accurate for v2/v3, ~0 for v4 on Robinhood
  dexId: string;
  version: string; // "v2" | "v3" | "v4" | ""
  chgH1: number; // % price change 1h (signed) — volatility signal for adaptive range width
  chgH6: number; // % price change 6h (signed)
  volH1: number; // 1h volume ($) — spike/fade signal (recent activity vs 24h average)
}

const cache = new Map<string, { at: number; map: Map<string, DexPair> }>();
const TTL_MS = 30_000;

/** Pairs for a token keyed by lowercased pairAddress. Cached ~30s; empty map on any failure. */
export async function dexPairs(token: string, now: number): Promise<Map<string, DexPair>> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.map;

  const map = new Map<string, DexPair>();
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json().catch(() => null);
    for (const p of j?.pairs ?? []) {
      const pa = String(p.pairAddress ?? "").toLowerCase();
      if (!pa) continue;
      map.set(pa, {
        pairAddr: pa,
        vol24h: Number(p.volume?.h24 ?? 0),
        liqUsd: Number(p.liquidity?.usd ?? 0),
        dexId: String(p.dexId ?? ""),
        version: (p.labels ?? []).find((l: string) => /^v[234]$/.test(String(l).toLowerCase())) ?? "",
        chgH1: Number(p.priceChange?.h1 ?? 0),
        chgH6: Number(p.priceChange?.h6 ?? 0),
        volH1: Number(p.volume?.h1 ?? 0),
      });
    }
  } catch (e) {
    log.warn(`dexPairs gagal: ${(e as Error).message.slice(0, 80)}`);
  }
  cache.set(key, { at: now, map });
  return map;
}
