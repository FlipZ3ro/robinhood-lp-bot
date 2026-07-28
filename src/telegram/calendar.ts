/**
 * Profit Calendar — a monthly grid PNG where each day shows the realized PnL (LP-vs-HODL, fees
 * included) of positions CLOSED that day. Day boundary = 00:00 UTC = 07:00 WIB (matches the "days
 * reset at 07:00 WIB" convention). Rendered with @napi-rs/canvas (same infra as the profit cards).
 */
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { readLedger } from "../chain/ledger.js";
import { loadBg, drawCover } from "./card.js";

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const reg: Array<[string, string]> = [
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "CalSans"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "CalSansB"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "CalMonoB"],
  ];
  for (const [p, n] of reg) {
    try {
      if (existsSync(p)) GlobalFonts.registerFromPath(p, n);
    } catch {
      /* fall back to default family */
    }
  }
  fontsReady = true;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GREEN = "#2fe38f";
const RED = "#ff5c72";
const MUTED = "#7c8598";
const WHITE = "#f4f6fb";

export interface DayPnl {
  pnlUsd: number;
  trades: number;
}

/** Realized PnL by UTC day for a month (day boundary 00:00 UTC = 07:00 WIB). */
export function monthlyDailyPnl(year: number, month0: number): Map<number, DayPnl> {
  const m = new Map<number, DayPnl>();
  for (const e of readLedger()) {
    if (e.closedAt == null || e.pnlUsd == null) continue;
    const d = new Date(e.closedAt);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0) continue;
    const day = d.getUTCDate();
    const cur = m.get(day) ?? { pnlUsd: 0, trades: 0 };
    cur.pnlUsd += e.pnlUsd;
    cur.trades += 1;
    m.set(day, cur);
  }
  return m;
}

function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const body = a >= 1000 ? (a / 1000).toFixed(1) + "k" : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return (v >= 0 ? "+$" : "-$") + body;
}

function rr(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Render the month's profit calendar → PNG Buffer. */
export async function renderCalendar(year: number, month0: number): Promise<Buffer> {
  ensureFonts();
  const data = monthlyDailyPnl(year, month0);
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const weeks = Math.ceil((firstDow + daysInMonth) / 7);

  let up = 0;
  let down = 0;
  let total = 0;
  for (const [, v] of data) {
    if (v.pnlUsd > 0.005) up++;
    else if (v.pnlUsd < -0.005) down++;
    total += v.pnlUsd;
  }

  const PAD = 52;
  const gap = 16;
  const cols = 7;
  const cellW = 140;
  const cellH = 116;
  const gridW = cols * cellW + (cols - 1) * gap;
  const W = gridW + PAD * 2; // ≈ 1160px, matches the reference's generous width
  const headerH = 184;
  const wdH = 52;
  const footH = 84;
  const H = headerH + wdH + weeks * (cellH + gap) + footH;

  const c = createCanvas(W, H);
  const g = c.getContext("2d");

  // background: custom image (SAME source as the profit cards — send a photo to the bot, or
  // RH_CARD_BG / assets/card-bg.jpg) darkened for legibility, else a dark gradient. The inner panel
  // + empty cells go translucent over an image so the photo shows through.
  const bgImg = await loadBg();
  if (bgImg) {
    drawCover(g, bgImg, W, H);
    g.fillStyle = "rgba(6,10,18,0.60)"; // scrim so the calendar reads over any photo
    g.fillRect(0, 0, W, H);
  } else {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0a1018");
    bg.addColorStop(1, "#0f1826");
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }
  rr(g, 20, 20, W - 40, H - 40, 26);
  g.fillStyle = bgImg ? "rgba(10,16,28,0.55)" : "#0c1420";
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.06)";
  g.lineWidth = 1;
  g.stroke();

  g.textBaseline = "alphabetic";

  // header
  g.fillStyle = MUTED;
  g.font = "22px CalSansB";
  g.fillText("PROFIT HISTORY", PAD, 82);
  const mon = MONTHS[month0]!;
  g.fillStyle = WHITE;
  g.font = "58px CalSansB";
  g.fillText(mon, PAD, 148);
  const monW = g.measureText(mon).width;
  g.fillStyle = MUTED;
  g.font = "30px CalSans";
  g.fillText(String(year), PAD + monW + 20, 148);

  g.textAlign = "right";
  g.fillStyle = MUTED;
  g.font = "24px CalSans";
  g.fillText(`${up} up · ${down} down`, W - PAD, 84);
  g.fillStyle = total >= 0 ? GREEN : RED;
  g.font = "40px CalMonoB";
  g.fillText(fmtUsd(total), W - PAD, 136);
  g.textAlign = "left";

  // weekday labels
  const gx = PAD;
  const gy = headerH;
  g.font = "22px CalSansB";
  g.textAlign = "center";
  for (let i = 0; i < 7; i++) {
    g.fillStyle = i === 0 || i === 6 ? "#5a6478" : MUTED;
    g.fillText(WD[i]!, gx + i * (cellW + gap) + cellW / 2, gy + 30);
  }
  g.textAlign = "left";

  // day cells
  const top = gy + wdH;
  let dow = firstDow;
  let row = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const cx = gx + dow * (cellW + gap);
    const cy = top + row * (cellH + gap);
    const d = data.get(day);
    rr(g, cx, cy, cellW, cellH, 14);
    g.fillStyle = d ? (d.pnlUsd >= 0 ? "rgba(47,227,143,0.16)" : "rgba(255,92,114,0.16)") : bgImg ? "rgba(255,255,255,0.06)" : "#131c2b";
    g.fill();
    if (d) {
      g.strokeStyle = d.pnlUsd >= 0 ? "rgba(47,227,143,0.45)" : "rgba(255,92,114,0.45)";
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.fillStyle = d ? WHITE : "#586074";
    g.font = "22px CalSansB";
    g.fillText(String(day), cx + 14, cy + 34);
    if (d) {
      g.fillStyle = d.pnlUsd >= 0 ? GREEN : RED;
      g.font = "26px CalMonoB";
      g.textAlign = "center";
      g.fillText(fmtUsd(d.pnlUsd), cx + cellW / 2, cy + cellH / 2 + 28);
      g.textAlign = "left";
    }
    dow++;
    if (dow > 6) {
      dow = 0;
      row++;
    }
  }

  // footer
  g.fillStyle = MUTED;
  g.font = "19px CalSans";
  g.fillText("Days reset at 07:00 WIB (00:00 UTC) · realized PnL per close-day, fees included", PAD, H - 44);

  return c.toBuffer("image/png");
}
