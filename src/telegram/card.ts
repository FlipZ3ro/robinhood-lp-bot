/**
 * Shareable profit cards (PNG) — a Meteora-style "flex" graphic the operator can post.
 * Rendered with @napi-rs/canvas (prebuilt, no system deps) using the host's sans-serif font.
 * Two flavours: a whole-portfolio card (/card) and a per-close card (auto-sent on close).
 */
import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D, type Image } from "@napi-rs/canvas";
import { readLedger, ledgerSummary } from "../chain/ledger.js";
import { listPositions } from "../chain/positions.js";
import { ethUsd } from "../chain/price.js";
import { logger } from "../util/log.js";

const log = logger("card");

// STRIX-style palette: neon green profit, red loss, techy monospace, dark on-image text.
const GREEN = "#2fe38f";
const RED = "#ff5c72";
const MUTED = "#8b93a3";
const WHITE = "#f4f6fb";
const BRAND = process.env.RH_CARD_BRAND || "0xRapzz";
const TAGLINE = process.env.RH_CARD_TAG || "LP · ONCHAIN WATCH";

// Register fonts explicitly — the VPS has no fontconfig defaults, so canvas draws blank text
// without this. STRIX aesthetic = monospace everywhere; DejaVu Sans Mono matches it.
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const reg: Array<[string, string]> = [
    ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "CardMono"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "CardMonoB"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "CardSans"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "CardSansB"],
  ];
  for (const [path, name] of reg) {
    try {
      if (existsSync(path)) GlobalFonts.registerFromPath(path, name);
    } catch {
      /* fall back to default family */
    }
  }
  fontsReady = true;
}
const MONO = "CardMono";
const MONOB = "CardMonoB";

/** Optional custom background image (pic2). Set RH_CARD_BG or drop assets/card-bg.{jpg,png}. */
function bgImagePath(): string | null {
  const cands = [process.env.RH_CARD_BG, "assets/card-bg.jpg", "assets/card-bg.png", "assets/card-bg.jpeg"].filter(Boolean) as string[];
  return cands.find((p) => existsSync(p)) ?? null;
}
async function loadBg(): Promise<Image | null> {
  const p = bgImagePath();
  if (!p) return null;
  try {
    return await loadImage(p);
  } catch {
    return null;
  }
}
/** Draw an image cover-fit (fill the canvas, crop overflow). */
function drawCover(g: SKRSContext2D, img: Image, W: number, H: number): void {
  const s = Math.max(W / img.width, H / img.height);
  const w = img.width * s;
  const h = img.height * s;
  g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

export interface CardStat {
  label: string;
  value: string;
  color?: string;
}
export interface CardData {
  title: string; // pair or "ALL-TIME"
  headline: string; // "$59.03 USD" / "+0.013 ETH"
  positive: boolean;
  subtitle?: string; // "(226.37%)"
  stats: CardStat[]; // up to 4, laid out in the corners
  date: string;
  hold?: string; // "00:20:19" — shown under the title if present
}

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** L-shaped bracket corners framing the whole card (STRIX look). */
function cornerBrackets(g: SKRSContext2D, W: number, H: number): void {
  const m = 30;
  const len = 46;
  g.strokeStyle = "rgba(220,225,235,0.55)";
  g.lineWidth = 2;
  const corner = (x: number, y: number, dx: number, dy: number) => {
    g.beginPath();
    g.moveTo(x + dx * len, y);
    g.lineTo(x, y);
    g.lineTo(x, y + dy * len);
    g.stroke();
  };
  corner(m, m, 1, 1);
  corner(W - m, m, -1, 1);
  corner(m, H - m, 1, -1);
  corner(W - m, H - m, -1, -1);
}

/** Small diamond logo mark. */
function logoMark(g: SKRSContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.strokeStyle = WHITE;
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s, 0);
  g.lineTo(0, s);
  g.lineTo(-s, 0);
  g.closePath();
  g.stroke();
  g.fillStyle = GREEN;
  g.beginPath();
  g.arc(0, 0, s * 0.32, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/**
 * Render a profit card — STRIX "onchain watch" aesthetic: full-bleed art, corner brackets,
 * monospace type, a PROFIT/LOSS badge, big neon PnL, and four corner stats. No glass panel;
 * a left-side dark gradient keeps the text legible over the image.
 */
export async function renderCard(d: CardData): Promise<Buffer> {
  ensureFonts();
  const W = 1280;
  const H = 720;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  const accent = d.positive ? GREEN : RED;

  // ── background art (pic2) cover-fit, else dark gradient ──
  const bg = await loadBg();
  if (bg) drawCover(g, bg, W, H);
  else {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#0a0616");
    grad.addColorStop(1, "#241049");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }
  // darken the LEFT (where the text lives) + a top/bottom scrim for header/footer legibility
  const dark = g.createLinearGradient(0, 0, W, 0);
  dark.addColorStop(0, "rgba(6,4,14,0.82)");
  dark.addColorStop(0.5, "rgba(6,4,14,0.35)");
  dark.addColorStop(1, "rgba(6,4,14,0)");
  g.fillStyle = dark;
  g.fillRect(0, 0, W, H);
  const scrim = g.createLinearGradient(0, 0, 0, H);
  scrim.addColorStop(0, "rgba(6,4,14,0.45)");
  scrim.addColorStop(0.25, "rgba(6,4,14,0)");
  scrim.addColorStop(0.62, "rgba(6,4,14,0)");
  scrim.addColorStop(0.82, "rgba(6,4,14,0.75)"); // darken the bottom stat row so it reads over the art
  scrim.addColorStop(1, "rgba(6,4,14,0.88)");
  g.fillStyle = scrim;
  g.fillRect(0, 0, W, H);

  cornerBrackets(g, W, H);

  const MX = 64;
  g.textBaseline = "alphabetic";

  // ── header: logo + brand (left) · tagline + PROFIT/LOSS badge (right) ──
  logoMark(g, MX + 12, 76, 13);
  g.textAlign = "left";
  g.fillStyle = WHITE;
  g.font = `22px ${MONOB}`;
  g.fillText(BRAND.toUpperCase(), MX + 36, 84);
  g.textAlign = "right";
  g.fillStyle = MUTED;
  g.font = `16px ${MONO}`;
  g.fillText(TAGLINE.toUpperCase(), W - MX, 76);

  // ── pair / title + PROFIT/LOSS badge beside it + HOLD ──
  g.textAlign = "left";
  g.fillStyle = WHITE;
  g.font = `52px ${MONOB}`;
  const title = d.title.toUpperCase();
  g.fillText(title, MX, 230);
  const titleW = g.measureText(title).width;
  const badge = d.positive ? "PROFIT" : "LOSS";
  g.font = `18px ${MONOB}`;
  const bw = g.measureText(badge).width + 26;
  const bx = MX + titleW + 22;
  const by = 196;
  roundRect(g, bx, by, bw, 34, 8);
  g.fillStyle = accent;
  g.fill();
  g.fillStyle = "#06120c";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(badge, bx + bw / 2, by + 18);
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  g.fillStyle = MUTED;
  g.font = `20px ${MONO}`;
  g.fillText(d.hold ? `HOLD ${d.hold}` : d.date.toUpperCase(), MX, 272);

  // ── big PnL headline; the ($ / %) sub sits SMALL & inline, right after the ETH value ──
  let hSize = 84;
  do {
    g.font = `${hSize}px ${MONOB}`;
    if (g.measureText(d.headline).width <= W * 0.55) break;
    hSize -= 3;
  } while (hSize > 40);
  g.fillStyle = accent;
  g.font = `${hSize}px ${MONOB}`;
  g.textAlign = "left";
  g.fillText(d.headline, MX, 425);
  if (d.subtitle) {
    const hw = g.measureText(d.headline).width;
    let ss = 28;
    g.font = `${ss}px ${MONO}`;
    while (MX + hw + 22 + g.measureText(d.subtitle).width > W * 0.7 && ss > 16) {
      ss -= 1;
      g.font = `${ss}px ${MONO}`;
    }
    g.fillStyle = accent;
    g.fillText(d.subtitle, MX + hw + 22, 425); // baseline-aligned, small, behind the ETH
  }

  // ── stats: one row spread across the FULL width (bottom is darkened so they read over the
  //    art). Each value auto-shrinks to its column. ──
  const s = d.stats.slice(0, 4);
  const labelY = H - 96;
  const region = W - 2 * MX;
  const colW = region / Math.max(1, s.length);
  s.forEach((st, i) => {
    const x = MX + i * colW;
    g.textAlign = "left";
    g.fillStyle = MUTED;
    g.font = `15px ${MONO}`;
    g.fillText(st.label.toUpperCase(), x, labelY);
    let vs = 30;
    g.font = `${vs}px ${MONOB}`;
    while (g.measureText(st.value).width > colW - 22 && vs > 15) {
      vs -= 1;
      g.font = `${vs}px ${MONOB}`;
    }
    g.fillStyle = st.color ?? WHITE;
    g.fillText(st.value, x, labelY + 38);
  });

  return c.toBuffer("image/png");
}

const signed = (n: number, dp: number): string => (n >= 0 ? "+" : "") + n.toFixed(dp);
function today(): string {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** Sum of unrealized PnL across open positions (best-effort; v3 exact, v4/v2 via value−deposit). */
async function unrealizedEth(px: number): Promise<number> {
  let u = 0;
  try {
    const v3 = await listPositions();
    for (const r of v3) if (r.pnlEth != null) u += r.pnlEth;
  } catch {
    /* skip */
  }
  try {
    const { listV4Positions } = await import("../chain/v4/list.js");
    const v4 = await listV4Positions();
    for (const r of v4) if (r.depEth != null && px) u += r.valueUsd / px - r.depEth;
  } catch {
    /* skip */
  }
  try {
    const { listV2Positions } = await import("../chain/v2/list.js");
    const v2 = await listV2Positions();
    for (const r of v2) if (r.pnlEth != null) u += r.pnlEth;
  } catch {
    /* skip */
  }
  return u;
}

/** Whole-portfolio profit card (realized from ledger + unrealized from open positions). */
export async function portfolioCardData(): Promise<CardData> {
  const sum = ledgerSummary();
  const px = await ethUsd().catch(() => 0);
  const entries = readLedger().filter((e) => e.pnlEth != null);
  const biggest = entries.reduce<(typeof entries)[number] | null>((b, e) => ((e.pnlEth ?? -Infinity) > (b?.pnlEth ?? -Infinity) ? e : b), null);
  const unreal = await unrealizedEth(px).catch(() => 0);
  const dol = (eth: number) => `${eth >= 0 ? "+" : "-"}$${Math.abs(eth * px).toFixed(2)}`;
  return {
    title: "ALL-TIME",
    // USD-led (ETH shown small inline behind it)
    headline: px ? dol(sum.pnlEth) : `${signed(sum.pnlEth, 4)} ETH`,
    positive: sum.pnlEth >= 0,
    subtitle: px ? `(${signed(sum.pnlEth, 4)} ETH)` : undefined,
    stats: [
      { label: "Realized", value: dol(sum.pnlEth), color: sum.pnlEth >= 0 ? GREEN : RED },
      { label: "Unrealized", value: dol(unreal), color: unreal >= 0 ? GREEN : RED },
      { label: "Biggest Win", value: biggest && biggest.pnlEth != null ? dol(biggest.pnlEth) : "—", color: GREEN },
      { label: "Win Rate", value: `${sum.winRate.toFixed(0)}% (${sum.wins}/${sum.losses})` },
    ],
    date: today(),
  };
}

export interface ClosePnl {
  name: string; // symbol or pair
  version: "v2" | "v3" | "v4";
  quote?: "eth" | "usd"; // "usd" for USDG-paired pools → headline/stats in $
  depEth: number | null;
  outEth: number;
  pnlEth: number | null;
  pnlPct?: number | null;
  feeEth?: number;
  heldMs?: number | null;
  ethUsd?: number; // ETH/USD at close (for stable pairs); falls back to live rate
}

/** hh:mm:ss from a duration in ms (STRIX "HOLD 00:20:19"). */
function fmtHold(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
}

/** Per-close profit card — USD-led (ETH small inline). Amounts stored in ETH-equiv, shown in $. */
export async function closeCardData(p: ClosePnl): Promise<CardData> {
  const px = p.ethUsd || (await ethUsd().catch(() => 0));
  const pnl = p.pnlEth ?? 0;
  const has = p.pnlEth != null;
  const dol = (eth: number) => `$${(eth * px).toFixed(2)}`;

  const stats: CardStat[] = [
    { label: "Entry", value: p.depEth != null ? dol(p.depEth) : "—" },
    { label: "Fee", value: dol(p.feeEth || 0), color: GREEN },
    { label: "Exit", value: dol(p.outEth) },
  ];

  const headline = has && px ? `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl * px).toFixed(2)}` : has ? `${signed(pnl, 4)} ETH` : "—";
  const subtitle = has && px ? `(${signed(pnl, 4)} ETH)` : undefined; // ETH small, inline behind the $
  return {
    title: p.name,
    headline,
    positive: pnl >= 0,
    subtitle,
    stats,
    date: today(),
    hold: p.heldMs != null ? fmtHold(p.heldMs) : undefined,
  };
}

export { log as cardLog };
