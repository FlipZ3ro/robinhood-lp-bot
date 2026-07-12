/** Long-poll loop + routing. The auth guard lives here: non-owner updates are dropped. */
import { call, send, isOwner, lockOwner } from "./tg.js";
import { resolveMenu } from "./menu.js";
import { startWatch } from "./watchLoop.js";
import { startFeed, stopFeed } from "./feedLoop.js";
import { wallet } from "../chain/client.js";
import { cfg } from "../config.js";
import { logger } from "../util/log.js";
import * as H from "./handlers.js";

const log = logger("bot");
let running = true;

const CA_RE = /^0x[a-fA-F0-9]{40}$/;
const NUM_RE = /^[0-9]*\.?[0-9]+$/;

async function routeCallback(cq: any): Promise<void> {
  const chatId = String(cq.message.chat.id);
  const d: string = cq.data;
  const mid: number = cq.message.message_id;
  if (!isOwner(chatId)) {
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ bukan owner", show_alert: true });
    return;
  }
  await call("answerCallbackQuery", {
    callback_query_id: cq.id,
    ...(d === "refresh" ? { text: "🔄 Ambil data on-chain…" } : {}),
  });

  if (d.startsWith("ca:")) return H.onCA(d.slice(3));
  if (d === "refresh") return H.onList(mid);
  if (d === "lgrb") return H.onLedgerRebuild(mid);
  if (d.startsWith("lg:")) return H.onLedger(Number(d.split(":")[1]), mid);
  if (d.startsWith("pool:")) return H.onPick(Number(d.split(":")[1]), mid);
  if (d.startsWith("mint:")) return H.onMint(mid, d.slice(5)); // single|inrange|v4|v4r
  if (d === "mint") return H.onMint(mid, "single");
  if (d === "cancel") {
    H.cancelPending();
    await call("editMessageText", { chat_id: chatId, message_id: mid, text: "❌ Dibatalkan.", parse_mode: "HTML" });
    return;
  }
  if (d.startsWith("v4c:")) return H.onV4Close("/v4close " + d.split(":")[1]);
  if (d.startsWith("close:")) return H.onCloseAsk(d.split(":")[1]!, mid);
  if (d.startsWith("cs:")) return H.onClose(d.split(":")[1]!, mid, true);
  if (d.startsWith("ck:")) return H.onClose(d.split(":")[1]!, mid, false);
  if (d === "closeall") {
    await call("editMessageText", { chat_id: chatId, message_id: mid, text: "🗑🗑 memproses Close ALL…", parse_mode: "HTML" });
    return H.onCloseAll();
  }
}

async function routeMessage(m: any): Promise<void> {
  const chatId = String(m.chat.id);
  const t: string = resolveMenu(String(m.text).trim()); // map bottom-menu labels → commands

  // /start (and /help) is the only thing that can LOCK an unclaimed bot to a chat
  if (t === "/start" || t === "/help") lockOwner(chatId);
  if (!isOwner(chatId)) {
    log.warn(`update ditolak dari chat non-owner ${chatId}`);
    return;
  }

  if (t === "/start" || t === "/help") return H.onHelp();
  if (t === "/list") return H.onList();
  if (t === "/ledger") return H.onLedger(0);
  if (t === "/scan") return H.onScan();
  if (t.startsWith("/watch")) return H.onWatch(t.split(/\s+/)[1]);
  if (t.startsWith("/feed")) return H.onFeed(t.split(/\s+/)[1]);
  if (t.startsWith("/auto")) return H.onAuto(t.split(/\s+/)[1]);
  if (t.startsWith("/v4lp")) return H.onV4Lp(t);
  if (t.startsWith("/v4close")) return H.onV4Close(t);
  if (t.startsWith("/v4")) return H.onV4(t.split(/\s+/)[1]);
  if (t === "/pnl") return H.onPnl();
  if (t === "/sell") return H.onSell();
  if (t === "/closeall") return H.onCloseAll();
  if (t === "/wallet") return H.onWallet();
  if (t === "/settings") return H.onSettings();
  if (t.startsWith("/set ")) return H.onSet(t);
  if (CA_RE.test(t)) return H.onCA(t);
  if (H.isAwaitingAmount() && NUM_RE.test(t)) return H.onAmount(t);
  if (t.startsWith("/")) return; // unknown command
  await send("Paste alamat kontrak token (0x… 40 hex) buat buka LP.");
}

async function handle(u: any): Promise<void> {
  if (u.callback_query) return routeCallback(u.callback_query);
  if (u.message?.text) return routeMessage(u.message);
}

async function registerCommands(): Promise<void> {
  // Remove the "/" command menu + Menu button. They share the bottom bar with the persistent
  // reply keyboard, so Telegram collapses the keyboard whenever the command menu is available
  // (the "menu keeps disappearing" bug). The bottom keyboard covers the common actions;
  // parameterized commands (/v4, /v4lp, /set, /v4close) are still typed manually.
  await call("deleteMyCommands", {});
  await call("setChatMenuButton", { menu_button: { type: "default" } });
}

export function stop(): void {
  running = false;
  stopFeed();
}

export async function run(): Promise<void> {
  await registerCommands();
  log.info(`Robinhood LP Bot v2 jalan — chain ${cfg.chainId}, wallet ${wallet().address}`);
  startWatch();
  void startFeed(); // no-op unless cfg.feed.enabled
  let offset = 0;
  while (running) {
    try {
      const r = await call("getUpdates", { offset, timeout: 25 });
      for (const u of r?.result ?? []) {
        offset = u.update_id + 1;
        await handle(u).catch((e: Error) => log.error("handle err: " + e.message));
      }
    } catch (e) {
      log.error("loop: " + String((e as Error).message).slice(0, 60));
      await new Promise((s) => setTimeout(s, 2000));
    }
  }
  log.info("loop berhenti.");
}
