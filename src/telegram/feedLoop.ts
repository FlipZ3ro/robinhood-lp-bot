/** Owns the sequencer-feed monitor lifecycle. Separate from handlers to avoid cycles. */
import { cfg } from "../config.js";
import { FeedMonitor } from "../feed/monitor.js";
import { notifyOutOfRange } from "./notify.js";
import { handleNewToken } from "./pipeline.js";
import { logger } from "../util/log.js";

const log = logger("feed");
let monitor: FeedMonitor | null = null;

export function isFeedOn(): boolean {
  return monitor !== null;
}

export async function startFeed(): Promise<void> {
  if (monitor || !cfg.feed.enabled) return;
  monitor = new FeedMonitor({
    onNewToken: (ev) => void handleNewToken(ev).catch(() => {}),
    onOutOfRange: (ev) => void notifyOutOfRange(ev).catch(() => {}),
  });
  try {
    await monitor.start();
  } catch (e) {
    log.error(`gagal start: ${(e as Error).message}`);
    monitor = null;
  }
}

export function stopFeed(): void {
  if (monitor) {
    monitor.stop();
    monitor = null;
  }
}

export function feedStatus(): { on: boolean; seen: number; positions: number; newTokens: number; rangeAlerts: number } {
  if (!monitor) return { on: false, seen: 0, positions: 0, newTokens: 0, rangeAlerts: 0 };
  const s = monitor.status();
  return { on: true, seen: s.seen, positions: s.positions, newTokens: s.newTokens, rangeAlerts: s.rangeAlerts };
}
