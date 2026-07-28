/** Long-poll loop + routing. The auth guard lives here: non-owner updates are dropped. */
import { call, send, isOwner, lockOwner } from "./tg.js";
import { resolveMenu } from "./menu.js";
import { startWatch } from "./watchLoop.js";
import { startFeed, stopFeed } from "./feedLoop.js";
import { startScan, stopScan } from "../radar/scanLoop.js";
import { startManage, stopManage } from "../radar/automanage.js";
import { handleHuntCandidate } from "./pipeline.js";
import { notifyCandidate, notifyAutoClose } from "./notify.js";
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
  if (d === "refresh") return H.onList(mid, true); // force = bypass cache, fetch fresh
  if (d === "screen") return H.onScreen();
  if (d === "card") return H.onCard();
  if (d.startsWith("cardp:")) return H.onCardFor(d.slice(6));
  if (d === "swapdo") return H.onSwapDo(mid);
  if (d === "swap") return H.onSwap("/swap"); // 🔙 back to token menu
  if (d.startsWith("swf:")) return H.onSwapFrom(d.slice(4), mid); // pick token to sell
  if (d.startsWith("swp:")) return H.onSwapPct(Number(d.split(":")[1]), mid); // pick % amount
  if (d === "lgrb") return H.onLedgerRebuild(mid);
  if (d.startsWith("lg:")) return H.onLedger(Number(d.split(":")[1]), mid);
  if (d.startsWith("pool:")) return H.onPick(Number(d.split(":")[1]), mid);
  if (d === "ballp") return H.onBalancedLp(mid);
  if (d === "usdgw") return H.onUseWalletUsdg(mid); // single-side pakai USDG di wallet (no swap/input)
  if (d.startsWith("mint:")) return H.onMint(mid, d.slice(5)); // single|inrange|v4|v4r
  if (d === "mint") return H.onMint(mid, "single");
  if (d === "cancel") {
    H.cancelPending();
    await call("editMessageText", { chat_id: chatId, message_id: mid, text: "❌ Dibatalkan.", parse_mode: "HTML" });
    return;
  }
  if (d.startsWith("v4f:")) return H.onV4Collect(d.split(":")[1]!);
  if (d.startsWith("v4c:")) return H.onV4Close("/v4close " + d.split(":")[1]);
  if (d.startsWith("v2c:")) return H.onV2Close(d.slice(4));
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
  // owner sends a photo → use it as the profit-card background
  if (Array.isArray(m.photo) && m.photo.length) {
    if (!isOwner(chatId)) return;
    return H.onSetBg(m.photo[m.photo.length - 1].file_id);
  }
  const t: string = resolveMenu(String(m.text ?? "").trim()); // map bottom-menu labels → commands

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
  if (t.startsWith("/hunt")) return H.onHunt(t.split(/\s+/)[1]);
  if (t === "/card") return H.onCard();
  if (t.startsWith("/swap")) return H.onSwap(t);
  if (t.startsWith("/screen")) return H.onScreen(t.split(/\s+/)[1]);
  if (t.startsWith("/watch")) return H.onWatch(t.split(/\s+/)[1]);
  if (t.startsWith("/feed")) return H.onFeed(t.split(/\s+/)[1]);
  if (t.startsWith("/auto")) return H.onAuto(t.replace(/^\/auto\s*/i, ""));
  if (t.startsWith("/v4lp")) return H.onV4Lp(t);
  if (t.startsWith("/v4close")) return H.onV4Close(t);
  if (t.startsWith("/v4")) return H.onV4(t.split(/\s+/)[1]);
  if (t.startsWith("/v2close")) return H.onV2Close(t.split(/\s+/)[1] ?? "");
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
  if (u.message?.text || u.message?.photo) return routeMessage(u.message);
}

async function registerCommands(): Promise<void> {
  // Both the "/" command menu AND the persistent bottom reply keyboard. The keyboard now
  // re-affirms on every plain-text send() (see tg.ts) so it no longer gets lost.
  await call("setChatMenuButton", { menu_button: { type: "commands" } });
  await call("setMyCommands", {
    commands: [
      { command: "list", description: "📋 Posisi LP terbuka (v3+v4) + close" },
      { command: "ledger", description: "📒 Riwayat posisi ditutup (realized PnL)" },
      { command: "pnl", description: "💰 PnL seumur hidup" },
      { command: "feed", description: "📡 Monitor sequencer real-time" },
      { command: "watch", description: "👁 Pemantau lonjakan volume" },
      { command: "scan", description: "🔍 Cek lonjakan volume sekarang" },
      { command: "screen", description: "🧪 Screening GMGN 24h (mcap>500k, vol>1M, no flap)" },
      { command: "hunt", description: "🎯 Hunter kandidat LP (fee 3-5% + rame + screening)" },
      { command: "card", description: "📸 Kartu profit shareable (portfolio)" },
      { command: "swap", description: "🔄 Swap token via KyberSwap (rute terbaik)" },
      { command: "auto", description: "🤖 Auto-LP (radar → buka otomatis)" },
      { command: "v4", description: "🦄 Cek pool Uniswap v4 sebuah token CA" },
      { command: "closeall", description: "🗑 Tutup SEMUA posisi" },
      { command: "sell", description: "💸 Jual token nyangkut → ETH" },
      { command: "wallet", description: "👛 Saldo hot wallet" },
      { command: "settings", description: "⚙️ Width, slippage, dll" },
      { command: "help", description: "❔ Bantuan + menu" },
    ],
  });
}

export function stop(): void {
  running = false;
  stopFeed();
  stopScan();
  stopManage();
}

export async function run(): Promise<void> {
  await registerCommands();
  log.info(`Robinhood LP Bot v2 jalan — chain ${cfg.chainId}, wallet ${wallet().address}`);
  startWatch();
  void startFeed(); // no-op unless cfg.feed.enabled
  startScan({
    onCandidate: (r, p) => {
      void notifyCandidate(r, p).catch(() => {}); // alert
      void handleHuntCandidate(r, p).catch(() => {}); // auto-LP if /auto on + gate met
    },
  }); // hunter (cfg.scan.enabled)
  startManage({ onAutoClose: (i) => void notifyAutoClose(i).catch(() => {}) }); // auto-close TP/SL/OOR (gated by cfg.autoLp)
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
