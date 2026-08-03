/**
 * Daily briefing — a once-a-day narrative (07:00 WIB / 00:00 UTC) over the last 24h of LP activity.
 *
 * Gathers: positions CLOSED in the last 24h (with WHY each closed — TP/SL/OOR/VFADE/manual),
 * the currently OPEN positions (value + unrealized), and lifetime stats. Then asks the briefing
 * LLM gateway (cc/claude-sonnet-5) to explain what went right/wrong — was the entry placed well? —
 * and suggest the ONE knob to tune so the bot gets smarter each day. A deterministic rule-based
 * analysis is used as fallback whenever the LLM is unavailable, so a briefing always goes out.
 *
 * The gateway key is a SECRET → lives in .env (RH_BRIEF_KEY), never in code. See config.ts env.
 */
import { readLedger, ledgerSummary } from "../chain/ledger.js";
import { listPositions } from "../chain/positions.js";
import { listV4Positions } from "../chain/v4/list.js";
import { ethUsd } from "../chain/price.js";
import { cfg, env } from "../config.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { send } from "./tg.js";
import { esc } from "./format.js";
import { logger } from "../util/log.js";
import type { LedgerEntry } from "../types.js";

const log = logger("briefing");
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = dataPath("briefing.json");

// ── formatting helpers ───────────────────────────────────────────────────────
const usd = (v: number) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
const pctS = (v: number | null) => (v == null ? "?" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
const dur = (ms: number | null) => {
  if (!ms || ms <= 0) return "?";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 24) return `${h.toFixed(1)}j`;
  return `${(h / 24).toFixed(1)}h`;
};
const clip = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Ledger entries closed BEFORE the `reason` field existed default to "manual". Infer a meaningful
// close reason from the realized PnL vs the configured TP/SL bands so historical days still read
// sensibly (going forward, auto-closes carry the real TP/SL/OOR/VFADE reason and this is a no-op).
function effReason(e: LedgerEntry): "TP" | "SL" | "OOR" | "VFADE" | "manual" {
  if (e.reason && e.reason !== "manual") return e.reason;
  const p = e.pnlPct;
  if (p == null) return e.reason ?? "manual";
  const tp = cfg.autoLp.tpPct || 8,
    sl = cfg.autoLp.slPct || 15;
  if (p >= tp * 0.8) return "TP";
  if (p <= -sl * 0.8) return "SL";
  if (Math.abs(p) < 1.5) return "OOR"; // near-breakeven exit ≈ range/volume close
  return e.reason ?? "manual";
}
// The analysis renders as a clean MONOSPACE block (<pre>) — reads like a terminal log. The LLM
// answers in Markdown, and bold can't nest inside <pre>, so strip the markers (keep the emoji
// section labels) and escape < > & so the content can't break the HTML parse.
function analysisMono(raw: string): string {
  const s = raw
    .trim()
    .replace(/\*\*(.+?)\*\*/gs, "$1") // drop **bold** markers (no bold inside <pre>)
    .replace(/__(.+?)__/gs, "$1")
    .replace(/`([^`]+)`/g, "$1") // drop `code` backticks
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // drop "# " headings
    .replace(/\n{3,}/g, "\n\n"); // collapse big gaps
  return "<pre>" + esc(s) + "</pre>";
}

// WIB (UTC+7) calendar date/time — used for the 07:00 trigger + the header stamp.
function wibParts() {
  const w = new Date(Date.now() + 7 * 3_600_000);
  return { date: w.toISOString().slice(0, 10), hour: w.getUTCHours(), label: w.toISOString().slice(0, 16).replace("T", " ") + " WIB" };
}

interface BriefData {
  closes: LedgerEntry[]; // closed by the bot in the last 24h (pnl known)
  openCount: number;
  openValUsd: number;
  openUnrealUsd: number;
  openOor: number;
  openList: { sym: string; inRange: boolean; pnlUsd: number | null; ver: "v3" | "v4" }[];
  life: ReturnType<typeof ledgerSummary>;
  ethPx: number;
  dayPnlUsd: number;
  dayFeeUsd: number;
  wins: number;
  losses: number;
  byReason: Record<string, { n: number; pnlUsd: number }>;
}

// ── data gathering ───────────────────────────────────────────────────────────
async function gather(): Promise<BriefData> {
  const now = Date.now();
  const closes = readLedger()
    .filter((e) => e.source === "bot" && e.closedAt != null && now - e.closedAt < DAY_MS && e.pnlEth != null)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map((e) => ({ ...e, reason: effReason(e) })); // fill inferred reason for pre-`reason` history

  const ethPx = await ethUsd().catch(() => 0);

  // open positions — best-effort; a slow RPC must never block the briefing
  const [v3, v4] = await Promise.all([
    listPositions().catch((e) => {
      log.warn(`brief listPositions gagal: ${(e as Error).message.slice(0, 80)}`);
      return [] as Awaited<ReturnType<typeof listPositions>>;
    }),
    listV4Positions(0).catch((e) => {
      log.warn(`brief listV4Positions gagal: ${(e as Error).message.slice(0, 80)}`);
      return [] as Awaited<ReturnType<typeof listV4Positions>>;
    }),
  ]);

  let openValUsd = 0,
    openUnrealUsd = 0,
    openOor = 0;
  const openList: BriefData["openList"] = [];
  for (const r of v4) {
    openValUsd += r.valueUsd || 0;
    const unreal = r.depEth != null && ethPx ? (r.valueUsd || 0) - r.depEth * ethPx : null;
    if (unreal != null) openUnrealUsd += unreal;
    if (!r.inRange) openOor++;
    openList.push({ sym: r.pair || r.sym, inRange: r.inRange, pnlUsd: unreal, ver: "v4" });
  }
  for (const r of v3) {
    if (ethPx) {
      openValUsd += (r.valEth || 0) * ethPx;
      if (r.pnlEth != null) openUnrealUsd += r.pnlEth * ethPx;
    }
    if (!r.inRange) openOor++;
    openList.push({ sym: r.tokenSym, inRange: r.inRange, pnlUsd: r.pnlEth != null && ethPx ? r.pnlEth * ethPx : null, ver: "v3" });
  }

  let dayPnlUsd = 0,
    dayFeeUsd = 0,
    wins = 0,
    losses = 0;
  const byReason: Record<string, { n: number; pnlUsd: number }> = {};
  for (const e of closes) {
    const pu = e.pnlUsd ?? (e.pnlEth != null && ethPx ? e.pnlEth * ethPx : 0);
    dayPnlUsd += pu;
    dayFeeUsd += (e.feeEth || 0) * ethPx;
    if ((e.pnlEth ?? 0) > 0) wins++;
    else losses++;
    const k = e.reason ?? "manual";
    (byReason[k] ??= { n: 0, pnlUsd: 0 }).n++;
    byReason[k].pnlUsd += pu;
  }

  return {
    closes,
    openCount: v3.length + v4.length,
    openValUsd,
    openUnrealUsd,
    openOor,
    openList,
    life: ledgerSummary(),
    ethPx,
    dayPnlUsd,
    dayFeeUsd,
    wins,
    losses,
    byReason,
  };
}

// ── LLM analysis (briefing gateway) ──────────────────────────────────────────
function llmDataBlock(d: BriefData): string {
  const a = cfg.autoLp,
    s = cfg.scan;
  const L: string[] = [];
  L.push(`ETH=$${d.ethPx.toFixed(0)}`);
  L.push(`24h: closed=${d.closes.length} win=${d.wins} loss=${d.losses} realizedPnL=${usd(d.dayPnlUsd)} feesEarned=$${d.dayFeeUsd.toFixed(2)}`);
  L.push(`open=${d.openCount} value=$${d.openValUsd.toFixed(0)} unrealized=${usd(d.openUnrealUsd)} outOfRange=${d.openOor}`);
  L.push(`lifetime: trades=${d.life.count} winRate=${d.life.winRate.toFixed(0)}% totalPnL=${usd(d.life.pnlUsd)} feesTotal=~${(d.life.feeEth * d.ethPx).toFixed(2)}`);
  L.push("");
  L.push("CLOSED_24H  (token | reason | pnl% | pnlUsd | heldTime | mintMode):");
  if (!d.closes.length) L.push("  (nothing closed in the last 24h)");
  for (const e of d.closes.slice(0, 12)) {
    L.push(`  ${clip(e.pair || e.sym, 28)} | ${e.reason || "manual"} | ${pctS(e.pnlPct)} | ${usd(e.pnlUsd ?? 0)} | ${dur(e.heldMs)} | ${e.mode}`);
  }
  L.push("");
  L.push("OPEN_NOW (token | inRange | unrealizedUsd):");
  if (!d.openList.length) L.push("  (none)");
  for (const o of d.openList.slice(0, 20)) L.push(`  ${clip(o.sym, 28)} | ${o.inRange ? "in" : "OUT"} | ${o.pnlUsd == null ? "?" : usd(o.pnlUsd)}`);
  L.push("");
  L.push("STRATEGY_CONFIG (the knobs you can suggest tuning):");
  L.push(`  autoClose: tp=${a.tpPct}% sl=${a.slPct}% closeOor=${a.closeOor} oorGraceMin=${a.oorGraceMin} oorAction=${a.oorAction} volFadeX=${a.volFadeX} compound=${a.compound}`);
  L.push(`  hunt: minScore=${s.minScore} mcap=$${s.screenMinMcap}-${s.screenMaxMcap || "∞"} minVol=$${s.minVolUsd} minPoolFees=$${s.minPoolFeesUsd} minPoolLiq=$${s.minPoolLiqUsd} minSpikeX=${s.minSpikeX} cooldownMin=${s.cooldownMin} maxOpen=${a.maxOpen} dailyCapEth=${a.dailyCapEth}`);
  return L.join("\n");
}

async function briefLlm(dataBlock: string): Promise<string | null> {
  if (!env.briefKey) {
    log.info("brief LLM skip — RH_BRIEF_KEY kosong (pakai fallback deterministik)");
    return null;
  }
  const system =
    "Kamu analis kuantitatif buat bot liquidity-provider (LP) di DEX Uniswap v4 (chain Robinhood). " +
    "Bot auto-hunt token, buka LP di pool fee tinggi (3-5%), lalu auto-close pas take-profit (TP), stop-loss (SL), " +
    "keluar-range (OOR), atau volume-fade (VFADE). Kamu dikasih ringkasan aktivitas 24 jam terakhir + config strategi. " +
    "Tulis analisa SINGKAT & TAJAM dalam Bahasa Indonesia gaya operator (lo/gue boleh), bukan formal.\n" +
    "Format PERSIS 3 bagian, tiap bagian 1 paragraf pendek, MULAI dengan label diapit **...** :\n" +
    "**💚 CUAN** — kenapa yang profit itu profit, entry/range-nya udah pas apa belum.\n" +
    "**🩸 LOSS** — kenapa yang loss itu loss: apakah kita salah pasang posisi? (entry telat pas volume udah puncak? range kesempitan jadi cepet OOR? token emang jelek/rug?). Jujur, jangan sok positif.\n" +
    "**🔧 FIX** — SATU perubahan config paling berdampak buat besok (sebut knob + angka konkret).\n" +
    "Boleh **tebalin** nama token/angka penting. JANGAN pakai heading markdown (#) atau tag HTML. " +
    "Pakai angka & nama token nyata dari data. Total maksimal ~180 kata, langsung insight, jangan ngulang data mentah.";
  const body = JSON.stringify({
    model: env.briefModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: dataBlock },
    ],
    stream: false,
    temperature: 0.4,
    // cc/claude-sonnet-5 spends completion tokens on THINKING before it writes any content; a big
    // analytical prompt can burn a small budget entirely on thinking (→ finish=max_tokens, empty
    // content). Give generous headroom so thinking + the ~180-word answer both fit. It's a once-a-day
    // call — the extra tokens are free in practice.
    max_tokens: 4000,
  });
  // Retry once: the gateway occasionally returns HTTP 200 with an EMPTY content body (cold model /
  // transient). A second attempt almost always fills it; only then do we fall back to the rule-based text.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.briefUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.briefKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(70_000),
      });
      if (!res.ok) {
        log.warn(`brief LLM HTTP ${res.status} (attempt ${attempt + 1})`);
        if (attempt === 0) continue;
        return null;
      }
      const j: any = await res.json();
      const ch = j?.choices?.[0] ?? {};
      const msg = ch.message ?? {};
      const text = String(msg.content || msg.reasoning || msg.reasoning_content || ch.text || "").trim();
      if (text) return text;
      log.warn(`brief LLM kosong — finish=${ch.finish_reason} usage=${JSON.stringify(j?.usage)} (attempt ${attempt + 1})`);
      if (attempt === 0) continue;
      return null;
    } catch (e) {
      log.warn(`brief LLM gagal: ${(e as Error).message.slice(0, 100)} (attempt ${attempt + 1})`);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

// Deterministic analysis — rule-based, always available so a briefing never comes out empty.
function fallbackAnalysis(d: BriefData): string {
  const R = d.byReason;
  const out: string[] = [];
  if (R.TP?.n) out.push(`🎯 ${R.TP.n} kena take-profit (${usd(R.TP.pnlUsd)}) — entry pas, range nangkep gerakan. Pola ini dipertahanin.`);
  if (R.VFADE?.n) out.push(`📉 ${R.VFADE.n} exit volume-fade (${usd(R.VFADE.pnlUsd)}) — keluar sebelum pool mati, timing bagus.`);
  if (R.SL?.n) out.push(`🛑 ${R.SL.n} kena stop-loss (${usd(R.SL.pnlUsd)}) — kemungkinan entry telat (masuk pas volume udah puncak) atau token-nya emang dump. Cek apakah minSpikeX kekecilan jadi ngejar spike yang udah lewat.`);
  if (R.OOR?.n) out.push(`↔️ ${R.OOR.n} out-of-range (${usd(R.OOR.pnlUsd)}) — harga kabur dari band; range kemungkinan kesempitan buat volatilitas token itu${cfg.autoLp.oorAction === "close" ? " (oorAction masih close, gak re-center)" : ""}.`);
  if (!d.closes.length) out.push("Gak ada posisi ditutup 24 jam terakhir — bot nahan atau candidate sepi.");

  // one concrete suggestion, picked by the dominant failure mode
  let sugg: string;
  const sl = R.SL?.n ?? 0,
    oor = R.OOR?.n ?? 0;
  if (oor >= 2 && oor >= sl) sugg = "Lebarin band range (mode in-range width) atau naikin oorGraceMin — mayoritas exit karena OOR = range kesempitan.";
  else if (sl >= 2) sugg = `Perketat entry: naikin minSpikeX (skrg ${cfg.scan.minSpikeX}) biar cuma masuk pool yang lagi panas beneran, kurangi SL dari entry telat.`;
  else if (!d.closes.length) sugg = `Longgarin gate hunt: turunin minScore (skrg ${cfg.scan.minScore}) atau naikin screenMaxMcap biar candidate lebih rame.`;
  else if (d.wins >= d.losses && d.wins > 0) sugg = `Strategi udah net-positif — coba naikin maxOpen (skrg ${cfg.autoLp.maxOpen}) / dailyCapEth (skrg ${cfg.autoLp.dailyCapEth}) biar deploy modal lebih banyak.`;
  else sugg = "Sample masih kecil — kumpulin data beberapa hari dulu sebelum tuning agresif.";
  out.push("");
  out.push("🧠 Saran besok: " + sugg);
  return out.join("\n");
}

// ── render ───────────────────────────────────────────────────────────────────
export async function buildBriefing(): Promise<string> {
  const d = await gather();
  const analysis = (await briefLlm(llmDataBlock(d))) || fallbackAnalysis(d);
  const { label } = wibParts();

  const H: string[] = [];
  H.push(`📋 <b>BRIEFING HARIAN</b> — <i>${esc(label)}</i>`);
  H.push("━━━━━━━━━━━━━━━━━━━");
  const wl = `${d.wins}W/${d.losses}L`;
  H.push(`💰 <b>PnL 24h:</b> ${esc(usd(d.dayPnlUsd))}  (${wl}) · fee ~$${d.dayFeeUsd.toFixed(2)}`);
  H.push(`📊 <b>Open:</b> ${d.openCount} · nilai $${d.openValUsd.toFixed(0)} · unreal ${esc(usd(d.openUnrealUsd))}${d.openOor ? ` · <b>${d.openOor} OOR</b>` : ""}`);
  H.push(`🏆 <b>Lifetime:</b> ${d.life.count} trade · ${d.life.winRate.toFixed(0)}% win · ${esc(usd(d.life.pnlUsd))}`);

  // per-position 24h closes — GROUPED by reason (with breathing room between groups) so it isn't a
  // dense wall; the flat "dead-pool" OOR parks (usually ~$0, same token 3×) collapse to one line.
  H.push("");
  H.push(`📕 <b>DITUTUP 24 JAM</b> · ${d.closes.length} pos`);
  if (!d.closes.length) {
    H.push("   <i>— gak ada —</i>");
  } else {
    const groups: [string, string, NonNullable<LedgerEntry["reason"]>][] = [
      ["🎯", "TAKE-PROFIT", "TP"],
      ["🛑", "STOP-LOSS", "SL"],
      ["📉", "VOLUME-FADE", "VFADE"],
      ["✋", "MANUAL", "manual"],
    ];
    for (const [emo, label, reason] of groups) {
      const g = d.closes.filter((e) => e.reason === reason);
      if (!g.length) continue;
      H.push("");
      H.push(`${emo} <b>${label}</b> · ${g.length}`);
      for (const e of g.slice(0, 8)) {
        H.push(`   <code>${esc(clip(e.pair || e.sym, 22))}</code>  ${esc(pctS(e.pnlPct))} · ${esc(usd(e.pnlUsd ?? 0))} · ${esc(dur(e.heldMs))}`);
      }
      if (g.length > 8) H.push(`   <i>…+${g.length - 8} lagi</i>`);
    }
    // OOR cluster → one collapsed line (token×count + total pnl) instead of many repeated ~$0 rows
    const oor = d.closes.filter((e) => e.reason === "OOR");
    if (oor.length) {
      const cnt: Record<string, number> = {};
      for (const e of oor) {
        const nm = (e.pair || e.sym).split("/").find((x) => x !== "USDG" && x !== "ETH" && x !== "WETH") || (e.pair || e.sym);
        cnt[nm] = (cnt[nm] || 0) + 1;
      }
      const names = Object.entries(cnt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, c]) => (c > 1 ? `${clip(n, 12)}×${c}` : clip(n, 12)));
      const oorPnl = oor.reduce((s, e) => s + (e.pnlUsd ?? 0), 0);
      H.push("");
      H.push(`↔️ <b>OUT-OF-RANGE</b> · ${oor.length} · ${esc(usd(oorPnl))}`);
      H.push(`   <i>${esc(names.join(", "))}${Object.keys(cnt).length > names.length ? "…" : ""} — range mati, ~0 fee</i>`);
    }
  }

  // open positions snapshot (compact)
  if (d.openList.length) {
    H.push("");
    H.push("📗 <b>POSISI TERBUKA:</b>");
    for (const o of d.openList.slice(0, 12)) {
      H.push(`${o.inRange ? "🟢" : "🔴"} <b>${esc(clip(o.sym, 26))}</b> ${o.pnlUsd == null ? "" : esc(usd(o.pnlUsd))} ${o.inRange ? "" : "<i>(OOR)</i>"}`.trimEnd());
    }
    if (d.openList.length > 12) H.push(`   <i>…+${d.openList.length - 12} lagi</i>`);
  }

  H.push("");
  H.push("🧠 <b>ANALISA</b>" + (env.briefKey ? "" : " <i>(rule-based)</i>") + ":");
  H.push(analysisMono(analysis));

  return H.join("\n");
}

// Telegram caps a message at 4096 chars — split on line boundaries.
async function sendChunked(text: string): Promise<void> {
  const LIMIT = 3900;
  if (text.length <= LIMIT) {
    await send(text);
    return;
  }
  const lines = text.split("\n");
  let buf = "";
  for (const ln of lines) {
    if (buf.length + ln.length + 1 > LIMIT) {
      await send(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + ln;
  }
  if (buf) await send(buf);
}

/** Build + push the briefing to the owner chat. `src` is just for the log line. */
export async function runBriefing(src: "auto" | "manual" = "manual"): Promise<void> {
  try {
    log.info(`briefing (${src}) — nyusun…`);
    const text = await buildBriefing();
    await sendChunked(text);
    log.info(`briefing (${src}) terkirim (${text.length} char)`);
  } catch (e) {
    log.warn(`briefing (${src}) gagal: ${(e as Error).message.slice(0, 120)}`);
    if (src === "manual") await send(`❌ Briefing gagal: ${esc((e as Error).message.slice(0, 120))}`);
  }
}

// ── scheduler: fire once per WIB day, at/after 07:00 WIB (00:00 UTC) ──────────
// Keyed on the WIB calendar date persisted to disk, so a restart never double-fires and a bot that
// was down at exactly 07:00 still catches up the moment it comes back (as long as it's still that day).
let lastFiredWib = "";

function tick(): void {
  const { date, hour } = wibParts();
  if (date !== lastFiredWib && hour >= 7) {
    lastFiredWib = date;
    try {
      writeJson(STATE_FILE, { lastFiredWib: date });
    } catch {
      /* non-fatal */
    }
    void runBriefing("auto");
  }
}

export function startBriefingScheduler(): void {
  lastFiredWib = readJson<{ lastFiredWib?: string }>(STATE_FILE, {}).lastFiredWib ?? "";
  // If we boot on a fresh day BEFORE 7am WIB, don't fire a briefing for the day that just ended.
  // Seeding lastFiredWib="" would make the first post-7am tick fire — which is what we want. But if we
  // boot fresh and it's already well past 7am with no state yet, seed to "yesterday" so we DO catch up
  // today. Simplest correct behaviour: leave persisted value as-is; empty → first tick after 7am fires.
  setInterval(tick, 5 * 60_000); // check every 5 min
  setTimeout(tick, 20_000); // and once shortly after boot (catch-up if we're already past 7am)
  log.info(`briefing scheduler aktif (07:00 WIB) — last=${lastFiredWib || "belum pernah"}`);
}
