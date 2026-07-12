/**
 * Persistent bottom menu (Telegram reply keyboard) so common actions are one tap away —
 * no scrolling. Buttons send their label as text; resolveMenu() maps the label back to a
 * command before routing.
 */

export const MENU_KEYBOARD = {
  keyboard: [
    ["📋 Posisi", "📒 Ledger", "💰 PnL"],
    ["📡 Feed", "👁 Watch", "🤖 Auto"],
    ["🔍 Scan", "👛 Wallet", "⚙️ Setting"],
    ["🗑 Close All", "💸 Sell", "❔ Help"],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MENU_MAP: Record<string, string> = {
  "📋 Posisi": "/list",
  "📒 Ledger": "/ledger",
  "💰 PnL": "/pnl",
  "📡 Feed": "/feed",
  "👁 Watch": "/watch",
  "🤖 Auto": "/auto",
  "🔍 Scan": "/scan",
  "👛 Wallet": "/wallet",
  "⚙️ Setting": "/settings",
  "🗑 Close All": "/closeall",
  "💸 Sell": "/sell",
  "❔ Help": "/help",
};

/** Menu label → command, or the text unchanged. */
export function resolveMenu(text: string): string {
  return MENU_MAP[text] ?? text;
}
