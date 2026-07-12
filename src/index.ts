/**
 * Entrypoint. Validates secrets, takes a single-instance lock, wires graceful shutdown,
 * then starts the Telegram loop.
 *
 * Run: node --env-file=.env --import tsx src/index.ts
 *   (or: RH_* set in the environment, then `npm start`)
 */
import { assertSecrets } from "./config.js";
import { acquireLock } from "./util/files.js";
import { logger } from "./util/log.js";
import { run, stop } from "./telegram/bot.js";

const log = logger("main");

async function main(): Promise<void> {
  assertSecrets();
  const release = acquireLock();

  const shutdown = (sig: string) => {
    log.info(`${sig} — matiin bersih…`);
    stop();
    release();
    // give in-flight Telegram calls a beat, then exit
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log.error("uncaughtException", e));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));

  await run();
  release();
}

main().catch((e) => {
  log.error(String(e?.message ?? e));
  process.exit(1);
});
