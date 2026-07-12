/**
 * Candidate pipeline: score once → notify with the verdict → maybe auto-LP.
 * Single place that ties detection (feed/watch) to radar + notifications + autonomous LP,
 * so the LLM/GMGN verdict is computed exactly once and reused everywhere.
 */
import { cfg } from "../config.js";
import { scoreCandidate, type Candidate, type Verdict } from "../radar/radar.js";
import { maybeAutoLp } from "../radar/autolp.js";
import { notifySpike, notifyNewToken, notifyAutoLp } from "./notify.js";
import { logger } from "../util/log.js";
import type { SpikeHit } from "../types.js";
import type { NewTokenAlert } from "../feed/monitor.js";

const log = logger("pipeline");

async function runAuto(candidate: Candidate, verdict: Verdict | null): Promise<void> {
  try {
    const r = await maybeAutoLp(candidate, verdict);
    if (r?.opened) await notifyAutoLp(r);
  } catch (e) {
    log.error(`auto-lp err: ${(e as Error).message}`);
  }
}

/** Watch/scan spike → verdict → notify → auto-LP. */
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
  const verdict = cfg.radar.attachToWatch ? await scoreCandidate(candidate).catch(() => null) : null;
  await notifySpike(h, verdict);
  await runAuto(candidate, verdict);
}

/** Feed new-token → verdict → notify → auto-LP. */
export async function handleNewToken(a: NewTokenAlert): Promise<void> {
  const candidate: Candidate = {
    token: a.token,
    symbol: a.symbol,
    source: "feed-new",
    fee: a.fee,
    wethSeed: a.wethSeed,
    onchainBackPct: a.backPct,
  };
  const verdict = cfg.radar.attachToNewToken ? await scoreCandidate(candidate).catch(() => null) : null;
  await notifyNewToken(a, verdict);
  await runAuto(candidate, verdict);
}
