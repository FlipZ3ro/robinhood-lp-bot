/**
 * Telegram transport + the auth boundary.
 *
 * SECURITY: valid commands come only from the OWNER chat. The wallet key sits behind
 * this bot; without an owner check anyone who finds the bot could /closeall or mint with
 * your funds. Owner is RH_TG_CHAT if set, otherwise the FIRST chat to /start (then
 * locked and persisted). Every inbound update is checked with isOwner() before routing.
 */
import { env, cfg, persist } from "../config.js";
import { MENU_KEYBOARD } from "./menu.js";
import { logger } from "../util/log.js";

const log = logger("tg");
const BASE = `https://api.telegram.org/bot${env.tgToken}`;

let owner = env.ownerChat; // may be "" until first /start locks it

export function isOwner(chatId: string | number): boolean {
  if (!owner) return true; // not locked yet — first message will lock it
  return String(chatId) === String(owner);
}

/** Lock the bot to this chat (first /start when no RH_TG_CHAT was configured). */
export function lockOwner(chatId: string | number): void {
  const id = String(chatId);
  if (!owner) {
    owner = id;
    cfg.telegramChatId = id;
    persist();
    log.info(`owner terkunci ke chat ${id} (set RH_TG_CHAT untuk permanen)`);
  }
}

export function ownerChat(): string {
  return owner;
}

/** Raw Telegram Bot API call. */
export async function call(method: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    return await r.json();
  } catch {
    return null;
  }
}

type Extra = Record<string, unknown>;

/** Send a message to the owner chat. */
export function send(text: string, extra: Extra = {}): Promise<any> {
  if (!owner) return Promise.resolve(null); // nothing to send to yet
  // NOTE: do NOT auto-attach the reply keyboard here — a message sent with a reply keyboard
  // CANNOT be edited later ("message can't be edited"), which breaks every send-then-edit
  // flow (/list "Memuat posisi…" → results). The keyboard is is_persistent (set on /start)
  // and re-affirmed only on final, non-edited responses via sendMenu().
  return call("sendMessage", {
    chat_id: owner,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/** Send a FINAL text response that also re-affirms the persistent bottom menu.
 * Use ONLY for messages that will NOT be edited afterwards. */
export function sendMenu(text: string): Promise<any> {
  return send(text, { reply_markup: MENU_KEYBOARD });
}

/** Edit a message in the owner chat. */
export function edit(messageId: number, text: string, extra: Extra = {}): Promise<any> {
  if (!owner) return Promise.resolve(null);
  return call("editMessageText", {
    chat_id: owner,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/** Send a PNG photo (profit card) to the owner chat via multipart upload. */
export async function sendPhoto(png: Buffer, caption?: string, extra: Extra = {}): Promise<any> {
  if (!owner) return null;
  try {
    const fd = new FormData();
    fd.append("chat_id", String(owner));
    if (caption) {
      fd.append("caption", caption);
      fd.append("parse_mode", "HTML");
    }
    fd.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "profit.png");
    for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    const r = await fetch(`${BASE}/sendPhoto`, { method: "POST", body: fd, signal: AbortSignal.timeout(45_000) });
    return await r.json();
  } catch (e) {
    log.warn(`sendPhoto gagal: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** Download a Telegram file (by file_id) to a Buffer, or null on failure. */
export async function downloadTgFile(fileId: string): Promise<Buffer | null> {
  try {
    const info = await call("getFile", { file_id: fileId });
    const fp = info?.result?.file_path;
    if (!fp) return null;
    const r = await fetch(`https://api.telegram.org/file/bot${env.tgToken}/${fp}`, { signal: AbortSignal.timeout(30_000) });
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    log.warn(`downloadTgFile gagal: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

export function answerCallback(id: string, opts: Extra = {}): Promise<any> {
  return call("answerCallbackQuery", { callback_query_id: id, ...opts });
}

export const explorerTx = (hash: string): string => cfg.explorer + "/tx/" + hash;
