/**
 * Candidate pipeline: score once → notify with the verdict → maybe auto-LP.
 * Single place that ties detection (feed/watch) to radar + notifications + autonomous LP,
 * so the LLM/GMGN verdict is computed exactly once and reused everywhere.
 */
import { cfg } from "../config.js";
import { scoreCandidate, type Candidate, type Verdict } from "../radar/radar.js";
import { qualifyCandidate } from "../chain/candidate.js";
import { maybeAutoLp } from "../radar/autolp.js";
import { notifySpike, notifyNewToken, notifyAutoLp } from "./notify.js";
import { logger } from "../util/log.js";
import type { SpikeHit } from "../types.js";
import type { NewTokenAlert } from "../feed/monitor.js";
import type { ScreenResult } from "../radar/screen.js";
import type { QualifiedPool } from "../chain/candidate.js";

const log = logger("pipeline");

async function runAuto(candidate: Candidate, verdict: Verdict | null): Promise<void> {
  try {
    const r = await maybeAutoLp(candidate, verdict);
    if (r?.opened) await notifyAutoLp(r);
  } catch (e) {
    log.error(`auto-lp err: ${(e as Error).message}`);
  }
}

/**
 * Does the screening verdict REJECT this candidate? A funded 3-5% pool isn't enough — the token
 * must also pass screening. This is why RIALTOES leaked before: it HAD a 5% pool with volume, but
 * the radar said SKIP (GMGN honeypot). "lolos screening + tx rame + pool fee 3-5%" needs all three.
 */
function screenBlocks(verdict: Verdict | null): boolean {
  const v = verdict?.llm;
  if (v && (v.action === "skip" || v.score < cfg.scan.minScore)) return true;
  const g = verdict?.gmgn;
  if (g && (g.isHoneypot === "yes" || (g.isHoneypot as unknown) === true)) return true;
  return false;
}

/** Watch/scan spike → quality gate (3-5% pool + screening) → notify → auto-LP. */
export async function handleSpike(h: SpikeHit): Promise<void> {
  const candidate: Candidate = {
    token: h.addr,
    symbol: h.symbol,
    source: "watch-spike",
    vol5m: h.vol5m,
    vol1h: h.vol1h,
    liq: h.liq,
    fdv: h.fdv,
    onchainBackPct: h.safe.backPct,
    onchainTaxPct: h.safe.taxPct,
  };
  const verdict = await scoreCandidate(candidate).catch(() => null);
  let pool = null;
  if (cfg.scan.enabled) {
    pool = await qualifyCandidate(h.addr).catch(() => null);
    if (!pool || screenBlocks(verdict)) return; // needs a busy 3-5% pool AND a passing screen
  }
  await notifySpike(h, verdict, pool);
  await runAuto(candidate, verdict);
}

/** Feed new-token → quality gate (3-5% pool + screening) → notify → auto-LP. */
export async function handleNewToken(a: NewTokenAlert): Promise<void> {
  const candidate: Candidate = {
    token: a.token,
    symbol: a.symbol,
    source: "feed-new",
    fee: a.fee,
    wethSeed: a.wethSeed,
    onchainBackPct: a.backPct,
  };
  const verdict = await scoreCandidate(candidate).catch(() => null);
  if (cfg.scan.enabled) {
    const pool = await qualifyCandidate(a.token).catch(() => null);
    if (!pool || screenBlocks(verdict)) return; // needs a busy 3-5% pool AND a passing screen
  }
  await notifyNewToken(a, verdict);
  await runAuto(candidate, verdict);
}

/**
 * Hunter candidate (already screened + has a busy 3-5% pool) → auto-LP. The hunter's screening IS
 * the verdict here, so auto-open fires when the operator's gate (requireAction/minScore) is met and
 * "hunt" is an allowed source. maybeAutoLp then opens SINGLE-SIDE on that 3-5% pool.
 */
export async function handleHuntCandidate(r: ScreenResult, pool: QualifiedPool): Promise<void> {
  const candidate: Candidate = {
    token: r.token.address,
    symbol: r.token.symbol,
    source: "hunt",
    liq: pool.liqUsd || r.token.liquidity,
    vol1h: r.token.volume,
    fdv: r.token.marketCap,
  };
  // Use the LLM verdict when present; otherwise synthesize one from the thesis score so a qualified
  // 3-5% candidate outside the LLM top-N is still eligible for auto-add (screen already vetted it).
  const action = r.verdict ?? (r.score >= 75 ? "ape" : r.score >= cfg.scan.minScore ? "watch" : "skip");
  const verdict: Verdict = {
    llm: { action, score: r.score, summary: r.thesis ?? `${r.kind} · ${r.community} (heuristik)` },
    gmgn: null,
  };
  await runAuto(candidate, verdict);
}
