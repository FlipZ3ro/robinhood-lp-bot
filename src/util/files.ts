/**
 * Atomic JSON persistence + a process lock.
 *
 * Why atomic: the ledger (lp-ledger.json) and positions.json are the ONLY record of
 * realized PnL. A plain fs.writeFileSync that is interrupted mid-write (crash, SIGKILL,
 * disk full) leaves a truncated, unparseable file → history gone. We write to a temp
 * file and rename() over the target — rename is atomic on the same filesystem, so a
 * reader always sees either the old or the new whole file, never a half.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (one level up from src/util). All state files live under data/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = path.join(ROOT, "data");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Absolute path for a state file name (e.g. "positions.json"). */
export function dataPath(name: string): string {
  return path.join(DATA_DIR, name);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file + rename. Never leaves a partial file behind. */
export function writeJson(file: string, value: unknown): void {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Single-instance lock. Two bot processes polling the same Telegram token fight over
 * getUpdates (409 Conflict) and can double-close positions. acquireLock() refuses to
 * start a second instance unless the lock is stale (previous process is gone).
 * Returns a release() to call on shutdown.
 */
export function acquireLock(name = "bot.lock"): () => void {
  ensureDataDir();
  const file = dataPath(name);
  const existing = readJson<{ pid: number } | null>(file, null);
  if (existing && isAlive(existing.pid) && existing.pid !== process.pid) {
    throw new Error(
      `Instance lain lagi jalan (pid ${existing.pid}). Matiin dulu, atau hapus ${file} kalau yakin mati.`,
    );
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return () => {
    try {
      const cur = readJson<{ pid: number } | null>(file, null);
      if (cur?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}
