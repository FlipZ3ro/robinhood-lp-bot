/**
 * Tiny structured logger. Writes to stdout and (optionally) appends to bot.log.
 * No dependency — a bot that touches a private key shouldn't pull a logging framework.
 */
import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
const FILE = process.env.LOG_FILE?.trim();

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  const line = `[${ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope} · ${msg}`;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) sink(line, extra);
  else sink(line);
  if (FILE) {
    try {
      fs.appendFileSync(
        path.resolve(FILE),
        `${ts} ${level} ${scope} ${msg}${extra !== undefined ? " " + safe(extra) : ""}\n`,
      );
    } catch {
      /* logging must never throw */
    }
  }
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** `logger("chain")` → a scoped logger prefixing every line with `chain`. */
export function logger(scope: string): Logger {
  return {
    debug: (m, e) => write("debug", scope, m, e),
    info: (m, e) => write("info", scope, m, e),
    warn: (m, e) => write("warn", scope, m, e),
    error: (m, e) => write("error", scope, m, e),
  };
}
