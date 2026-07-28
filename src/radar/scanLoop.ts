/**
 * Quality-candidate hunter. Every `cfg.scan.intervalMin` it screens GMGN trending (thesis + LLM),
 * keeps only survivors that ALSO have a v4 pool in the 3-5% fee band with real volume, and alerts
 * with a 1-tap LP button. This is the focused replacement for the old "every new token" feed spam.
 */
import { cfg, env } from "../config.js";
import { screenTokens, type ScreenResult } from "./screen.js";
import { qualifyCandidate, type QualifiedPool } from "../chain/candidate.js";
import { logger } from "../util/log.js";

const log = logger("hunt");

export interface ScanHooks {
  onCandidate: (r: ScreenResult, pool: QualifiedPool) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ScanHooks | null = null;
const alerted = new Map<string, number>(); // token → last alert ts (cooldown)
const stats = { scans: 0, alerts: 0, lastAt: 0, lastFound: 0, lastScanned: 0 };

/** Register hooks (pass at boot) and start the timer when enabled. Called again by /hunt on. */
export function startScan(h?: ScanHooks): void {
  if (h) hooks = h;
  if (timer || !hooks || !cfg.scan.enabled) return; // hooks stored, but only run when enabled
  void tick();
  timer = setInterval(() => void tick(), cfg.scan.intervalMin * 60_000);
  log.info(
    `hunt ON — tiap ${cfg.scan.intervalMin}m · fee ${(cfg.scan.feeMinPpm / 10000).toFixed(0)}-${(cfg.scan.feeMaxPpm / 10000).toFixed(0)}% · vol≥$${cfg.scan.minVolUsd} · skor≥${cfg.scan.minScore}`,
  );
}

export function stopScan(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("hunt OFF");
  }
}

export function isScanOn(): boolean {
  return timer !== null;
}

export function scanStatus(): { on: boolean } & typeof cfg.scan & typeof stats {
  return { on: isScanOn(), ...cfg.scan, ...stats };
}

/** Run one scan immediately (used by /hunt now). */
export async function scanNow(): Promise<{ found: number; scanned: number }> {
  return runScan();
}

async function tick(): Promise<void> {
  try {
    await runScan();
  } catch (e) {
    log.warn(`scan gagal: ${(e as Error).message.slice(0, 90)}`);
  }
}

async function runScan(): Promise<{ found: number; scanned: number }> {
  const s = cfg.scan;
  // Loose GMGN gates (the 3-5% pools live on smaller tokens) + thesis/LLM screening.
  const { results, scanned } = await screenTokens({
    llm: !!env.openrouterKey,
    minMarketCap: s.screenMinMcap,
    minVolume: s.screenMinVol,
    minLiquidity: s.screenMinLiq,
    limit: 40,
  });
  stats.scans++;
  stats.lastAt = Date.now();
  stats.lastScanned = scanned;
  const now = Date.now();
  // survivors past the score/verdict floor and out of cooldown → check the 3-5% pool in parallel
  const cand = results
    .filter(
      (r) =>
        r.token.address &&
        r.score >= s.minScore &&
        r.verdict !== "skip" &&
        (s.screenMaxMcap <= 0 || (r.token.marketCap ?? 0) <= s.screenMaxMcap) && // farm SMALL-cap (bigger fee share for small capital)
        now - (alerted.get(r.token.address.toLowerCase()) ?? 0) >= s.cooldownMin * 60_000,
    )
    .slice(0, 20);
  const { mapLimit } = await import("../chain/blockscout.js");
  const qualified = await mapLimit(cand, 5, async (r) => {
    const pool = await qualifyCandidate(r.token.address).catch(() => null);
    return pool ? { r, pool } : null;
  });
  let found = 0;
  for (const q of qualified) {
    if (!q) continue;
    alerted.set(q.r.token.address.toLowerCase(), now);
    found++;
    stats.alerts++;
    const mc = q.r.token.marketCap ?? 0;
    log.info(
      `kandidat ${q.r.token.symbol} · mcap $${(mc / 1e3).toFixed(0)}k · pool ${(q.pool.fee / 10000).toFixed(2)}% vol $${(q.pool.volUsd / 1e3).toFixed(1)}k fees $${q.pool.feesUsd.toFixed(0)} · skor ${q.r.score}`,
    );
    hooks?.onCandidate(q.r, q.pool);
  }
  stats.lastFound = found;
  log.info(`hunt scan: ${scanned} trending → ${cand.length} lolos screening → ${found} kandidat (pool 3-5% rame)`);
  return { found, scanned };
}
