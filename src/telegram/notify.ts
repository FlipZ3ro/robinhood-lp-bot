/** Spike notification — CA + DexScreener link + a one-tap LP button. */
import { send } from "./tg.js";
import { esc, pre, padR, tokenEmoji } from "./format.js";
import { fmtMcap } from "../util/format.js";
import { explorerTx } from "./tg.js";
import type { Verdict } from "../radar/radar.js";
import type { AutoLpResult } from "../radar/autolp.js";
import type { SpikeHit } from "../types.js";
import type { NewTokenAlert, OutOfRangeAlert } from "../feed/monitor.js";
import type { ScreenResult } from "../radar/screen.js";
import type { QualifiedPool } from "../chain/candidate.js";
import type { AutoCloseInfo, RebalanceInfo, CompoundInfo } from "../radar/automanage.js";

/** Render an LLM/GMGN radar verdict as message lines (empty if no verdict). */
function radarLines(v: Verdict | null): string[] {
  if (!v) return [];
  const out: string[] = [];
  if (v.llm) {
    const emo = v.llm.action === "ape" ? "🟢" : v.llm.action === "watch" ? "🟡" : "🔴";
    out.push(`🧠 <b>Radar:</b> ${emo} ${v.llm.action.toUpperCase()} (${v.llm.score}/100)`);
    if (v.llm.summary) out.push(`   <i>${esc(v.llm.summary)}</i>`);
  }
  const g = v.gmgn;
  if (g) {
    const p: string[] = [];
    if (g.smartWallets != null) p.push(`SM ${g.smartWallets}`);
    if (g.kolWallets != null) p.push(`KOL ${g.kolWallets}`);
    if (g.holders != null) p.push(`hold ${g.holders}`);
    if (g.rugRatio != null) p.push(`rug ${(g.rugRatio * 100).toFixed(0)}%`);
    if (g.top10Rate != null) p.push(`top10 ${(g.top10Rate * 100).toFixed(0)}%`);
    if (g.sellTax != null) p.push(`tax ${(g.sellTax * 100).toFixed(0)}%`);
    if (p.length) out.push(`📊 <b>GMGN:</b> ${esc(p.join(" · "))}`);
  }
  return out;
}

export async function notifySpike(h: SpikeHit, verdict: Verdict | null = null, pool: QualifiedPool | null = null): Promise<void> {
  const arrow =
    h.prevVol5m > 0
      ? `$${(h.prevVol5m / 1000).toFixed(0)}k → $${(h.vol5m / 1000).toFixed(0)}k`
      : `$${(h.vol5m / 1000).toFixed(0)}k`;
  const T = [
    `${padR("vol 5m", 8)} ${arrow}  (${(h.vol5m / Math.max(h.prevVol5m, 1)).toFixed(1)}×)`,
    `${padR("vol 1h", 8)} $${(h.vol1h / 1000).toFixed(0)}k`,
    `${padR("likuid", 8)} $${(h.liq / 1000).toFixed(0)}k`,
  ];
  if (h.fdv) T.push(`${padR("MCAP", 8)} ${fmtMcap(h.fdv)}`);
  if (pool) T.push(`${padR("pool LP", 8)} v4 ${pool.quote.toUpperCase()} · fee ${(pool.fee / 10000).toFixed(2)}% · vol $${(pool.volUsd / 1000).toFixed(0)}k`);
  T.push(
    `${padR("harga", 8)} ${h.chg5m >= 0 ? "+" : ""}${h.chg5m.toFixed(1)}% (5m) · ${h.chg1h >= 0 ? "+" : ""}${h.chg1h.toFixed(1)}% (1h)`,
  );
  T.push("");
  T.push(`✅ AMAN — ${h.safe.reason}`);
  T.push(`   tes beli 0.01Ξ → jual balik: ${h.safe.backPct.toFixed(1)}%`);

  await send(
    [
      `🚨 <b>VOLUME NANJAK</b> · ${tokenEmoji(h.symbol)} <b>${esc(h.symbol)}</b>`,
      pre(T.join("\n")),
      ...radarLines(verdict),
      `<code>${h.addr}</code>`,
      `<a href="${h.url}">📈 DexScreener</a>`,
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `🎯 LP ${h.symbol}`, callback_data: `ca:${h.addr}` },
            { text: "📈 Chart", url: h.url },
          ],
        ],
      },
    },
  );
}

/** New WETH pool / first mint spotted on the sequencer feed — before DexScreener sees it. */
export async function notifyNewToken(a: NewTokenAlert, verdict: Verdict | null = null): Promise<void> {
  const T = [
    `${padR("event", 9)} ${a.kind === "mint" ? "first liquidity (mint)" : "pool created"}`,
    `${padR("fee", 9)} ${(a.fee / 10000).toFixed(2)}%`,
    a.wethSeed > 0 ? `${padR("WETH seed", 9)} ${a.wethSeed.toFixed(4)}Ξ` : "",
    ``,
    `✅ honeypot check — ${a.safeReason}`,
    `   beli 0.01Ξ → jual balik: ${a.backPct.toFixed(1)}%`,
  ].filter(Boolean);

  await send(
    [
      `🆕 <b>TOKEN BARU (feed)</b> · ${tokenEmoji(a.symbol)} <b>${esc(a.symbol)}</b>`,
      `<i>ketangkep real-time dari sequencer — DexScreener kemungkinan belum index</i>`,
      pre(T.join("\n")),
      ...radarLines(verdict),
      `<code>${a.token}</code>`,
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `🎯 LP ${a.symbol}`, callback_data: `ca:${a.token}` },
            { text: "📈 DexScreener", url: `https://dexscreener.com/robinhood/${a.token}` },
          ],
        ],
      },
    },
  );
}

/** Quality LP candidate from the hunter: passed screening + busy + has a 3-5% v4 pool. */
export async function notifyCandidate(r: ScreenResult, pool: QualifiedPool): Promise<void> {
  const t = r.token;
  const verd = r.verdict === "ape" ? "🟢 APE" : r.verdict === "watch" ? "🟡 WATCH" : r.verdict === "skip" ? "🔴 SKIP" : "";
  const turnover = t.liquidity > 0 ? (t.volume / t.liquidity).toFixed(1) + "×" : "?";
  const T = [
    `${padR("pool", 9)} v4 ${pool.quote.toUpperCase()} · fee ${(pool.fee / 10000).toFixed(2)}%`,
    `${padR("vol pool", 9)} $${(pool.volUsd / 1000).toFixed(1)}k (24h)`,
    `${padR("liq pool", 9)} $${(pool.liqUsd / 1000).toFixed(1)}k`,
    `${padR("mcap", 9)} ${fmtMcap(t.marketCap)} · turnover ${turnover}`,
    `${padR("jenis", 9)} ${r.kind} · komunitas ${r.community}`,
    `${padR("skor", 9)} ${r.score}/100 · FOMO ${r.fomo}/100`,
  ];
  await send(
    [
      `🎯 <b>KANDIDAT LP</b> · ${tokenEmoji(t.symbol)} <b>${esc(t.symbol)}</b> ${verd}`,
      `<i>lolos screening + tx rame + pool fee 3-5%</i>`,
      pre(T.join("\n")),
      r.thesis ? `🧠 <i>${esc(r.thesis)}</i>` : "",
      r.flags.length ? `🚩 ${esc(r.flags.slice(0, 4).join(" · "))}` : "",
      `<code>${t.address}</code>`,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `🎯 LP ${t.symbol}`, callback_data: `ca:${t.address}` },
            { text: "📈 Chart", url: `https://dexscreener.com/robinhood/${t.address}` },
          ],
        ],
      },
    },
  );
}

/** Autonomous LP fired — report the opened position. Skips are logged, not sent. */
export async function notifyAutoLp(r: AutoLpResult): Promise<void> {
  if (!r.opened || !r.result) return;
  const res = r.result;
  await send(
    [
      `🤖 <b>AUTO-LP</b> · ${tokenEmoji(r.symbol)} <b>${esc(r.symbol)}</b> #${res.tokenId ?? "?"} ${res.mode === "inrange" ? "🎯" : "🛡"}`,
      `Otomatis dibuka ${r.sizeEth}Ξ single-side (${esc(res.side ?? "parkir quote asset")})`,
      `${res.entryMcap ? `entry MCAP ${fmtMcap(res.entryMcap)} · ` : ""}range tick ${res.tickLower}..${res.tickUpper}`,
      res.swapHash ? `swap: <a href="${explorerTx(res.swapHash)}">tx</a> · mint: <a href="${explorerTx(res.txHash)}">tx</a>` : `mint: <a href="${explorerTx(res.txHash)}">tx</a>`,
      `<i>Cek /list · tutup manual kapan aja</i>`,
    ].join("\n"),
  );
}

/** Auto-manage closed a position (take-profit / stop-loss / out-of-range). */
export async function notifyAutoClose(i: AutoCloseInfo): Promise<void> {
  const emo = i.reason === "TP" ? "🎯💰" : i.reason === "SL" ? "🛑" : i.reason === "VFADE" ? "📉" : i.reason === "FVLOW" ? "🐌" : "🚪";
  const label =
    i.reason === "TP" ? "TAKE PROFIT" : i.reason === "SL" ? "STOP LOSS" : i.reason === "VFADE" ? "VOLUME FADE" : i.reason === "FVLOW" ? "FEE MATI (rotasi slot)" : "OUT OF RANGE";
  const pnl =
    i.pnlPct != null
      ? `${i.pnlPct >= 0 ? "+" : ""}${i.pnlPct.toFixed(1)}%${i.pnlEth != null ? ` (${i.pnlEth >= 0 ? "+" : ""}${i.pnlEth.toFixed(6)}Ξ)` : ""}`
      : "—";
  await send(
    [
      `${emo} <b>AUTO-CLOSE · ${label}</b> · ${tokenEmoji(i.sym)} <b>${esc(i.sym)}</b> #${i.tokenId} [${i.version}]`,
      `PnL: <b>${pnl}</b>`,
      `<i>ditutup otomatis oleh auto-manage. Cek /list · /ledger</i>`,
    ].join("\n"),
  );
}

/** #1 An OOR position was closed AND re-opened recentered on the current price (rebalance). */
export async function notifyRebalance(i: RebalanceInfo): Promise<void> {
  await send(
    [
      `♻️ <b>REBALANCE</b> · ${tokenEmoji(i.sym)} <b>${esc(i.sym)}</b>`,
      `posisi OOR #${i.oldTokenId} ditutup → dibuka ulang recentered #${i.newTokenId ?? "?"} di harga skarang.`,
      `<i>modal balik in-range, lanjut makan fee. Cek /list</i>`,
    ].join("\n"),
  );
}

/** #3 A position's accrued fees were harvested and folded back in as liquidity (compound). */
export async function notifyCompound(i: CompoundInfo): Promise<void> {
  await send(
    [
      `🔁 <b>COMPOUND</b> · ${tokenEmoji(i.sym)} <b>${esc(i.sym)}</b> #${i.tokenId}`,
      `fee ~$${i.feeUsd.toFixed(2)} di-harvest & di-add balik ke posisi (auto-compound).`,
      `<i>Cek /list</i>`,
    ].join("\n"),
  );
}

/** A live position just left its range (feed-triggered, tick-confirmed). */
export async function notifyOutOfRange(a: OutOfRangeAlert): Promise<void> {
  const head = a.autoClosed
    ? `🚪 <b>OUT OF RANGE → AUTO-CLOSED</b>`
    : a.closeError
      ? `⚠️ <b>OUT OF RANGE — auto-close GAGAL</b>`
      : `🔴 <b>OUT OF RANGE</b>`;
  await send(
    [
      `${head} · ${tokenEmoji(a.symbol)} <b>${esc(a.symbol)}</b> #${a.tokenId}`,
      `Harga nembus ke <b>${a.side}</b> range — posisi berhenti makan fee.`,
      `tick ${a.tick} · range ${a.tickLower}..${a.tickUpper}`,
      a.closeError ? `❌ ${esc(a.closeError)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    a.autoClosed
      ? {}
      : {
          reply_markup: {
            inline_keyboard: [[{ text: `Close #${a.tokenId}`, callback_data: `close:${a.tokenId}` }]],
          },
        },
  );
}
