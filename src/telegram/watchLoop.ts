/** Owns the volume-scanner timer. Kept separate from handlers to avoid import cycles. */
import { scanOnce, wcfg } from "../watch/scanner.js";
import { handleSpike } from "./pipeline.js";
import { logger } from "../util/log.js";

const log = logger("watch");

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function tick(): Promise<void> {
  if (busy) return; // a slow scan must not overlap the next tick
  busy = true;
  try {
    const hits = await scanOnce();
    for (const h of hits) await handleSpike(h);
    if (hits.length) log.info(`${hits.length} spike → pipeline`);
  } catch (e) {
    log.error(`scan error: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

export function isWatchOn(): boolean {
  return timer !== null;
}

export function startWatch(): void {
  const w = wcfg();
  if (!w.enabled || timer) return;
  timer = setInterval(tick, w.intervalSec * 1000);
  log.info(`ON — scan tiap ${w.intervalSec}s (vol5m ≥ $${(w.minVol5m / 1000).toFixed(0)}k, naik ${w.riseFactor}×)`);
  void tick(); // first scan seeds the baseline
}

export function stopWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("OFF");
  }
}

/** Restart the timer (after interval changes). */
export function restartWatch(): void {
  stopWatch();
  startWatch();
}
