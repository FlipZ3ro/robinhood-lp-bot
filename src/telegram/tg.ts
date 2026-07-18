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
  // Re-affirm the persistent bottom menu on every plain-text message so it never gets lost.
  // Messages that carry their own inline keyboard keep it (reply keyboard persists separately).
  const reply_markup = (extra as { reply_markup?: unknown }).reply_markup ?? MENU_KEYBOARD;
  return call("sendMessage", {
    chat_id: owner,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
    reply_markup,
  });
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

export function answerCallback(id: string, opts: Extra = {}): Promise<any> {
  return call("answerCallbackQuery", { callback_query_id: id, ...opts });
}

export const explorerTx = (hash: string): string => cfg.explorer + "/tx/" + hash;
