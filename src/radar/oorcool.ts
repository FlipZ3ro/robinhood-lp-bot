/**
 * #2 OOR cooldown — after a token's position has been OOR-closed `oorCooldownCount` times, blacklist
 * that token for `oorCooldownHours`. Stops the rotation from re-entering a token that keeps parking
 * out-of-range and never fills (each re-entry just burns swap + gas). Ported from Meridian's
 * oorCooldownTriggerCount/oorCooldownHours.
 *
 * Keyed by token ADDRESS (lowercased) so it matches the auto-LP candidate. State persists to disk so
 * a restart doesn't wipe active cooldowns.
 */
import { cfg } from "../config.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";

const log = logger("oorcool");
const FILE = dataPath("oor-cooldown.json");

interface Entry {
  count: number; // consecutive OOR-closes within the window
  lastOorTs: number; // last OOR-close time
  cooldownUntil: number; // 0 = not cooling down
}
type State = Record<string, Entry>;

const load = (): State => readJson<State>(FILE, {});
const save = (s: State): void => writeJson(FILE, s);
const key = (addr: string): string => addr.toLowerCase();

/** Record an OOR-close for a token; trips a cooldown once the count threshold is hit. */
export function recordOor(addr: string): void {
  if (!addr) return;
  const now = Date.now();
  const s = load();
  const k = key(addr);
  const windowMs = Math.max(1, cfg.autoLp.oorCooldownHours) * 3600_000;
  const e: Entry = s[k] ?? { count: 0, lastOorTs: 0, cooldownUntil: 0 };
  // decay: OOR events older than one window don't count toward the streak
  if (now - e.lastOorTs > windowMs) e.count = 0;
  e.count += 1;
  e.lastOorTs = now;
  if (e.count >= cfg.autoLp.oorCooldownCount) {
    e.cooldownUntil = now + windowMs;
    e.count = 0; // reset the streak once the cooldown trips
    log.info(`OOR cooldown ${addr} → ${cfg.autoLp.oorCooldownHours}j (kebuka-tutup OOR ${cfg.autoLp.oorCooldownCount}×)`);
  }
  s[k] = e;
  save(s);
}

/** Is this token currently blacklisted by an active OOR cooldown? */
export function inOorCooldown(addr: string): boolean {
  if (!addr) return false;
  const e = load()[key(addr)];
  return !!e && e.cooldownUntil > Date.now();
}

/** Minutes remaining on a token's cooldown (0 if none) — for status/logging. */
export function oorCooldownLeftMin(addr: string): number {
  const e = load()[key(addr)];
  if (!e || e.cooldownUntil <= Date.now()) return 0;
  return Math.ceil((e.cooldownUntil - Date.now()) / 60_000);
}
