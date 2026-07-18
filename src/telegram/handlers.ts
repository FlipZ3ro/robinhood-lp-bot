/** Command + callback handlers. Each renders through tg.send/edit (owner chat only). */
import { cfg, env, persist } from "../config.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools } from "../chain/pools.js";
import { discoverV4Pools, type V4Pool } from "../chain/v4/discover.js";
import { previewRange, openPosition, listPositions, closePosition } from "../chain/positions.js";
import { readLedger, ledgerSummary, backfillLedger } from "../chain/ledger.js";
import { lifetimePnl } from "../chain/analytics.js";
import { balances, sellAllTokens } from "../chain/holdings.js";
import { ethUsd } from "../chain/price.js";
import { topVolumeNow, wcfg, usingOwnWatchRpc } from "../watch/scanner.js";
import { startWatch, stopWatch, restartWatch, isWatchOn } from "./watchLoop.js";
import { startFeed, stopFeed, feedStatus } from "./feedLoop.js";
import { autoLpStatus } from "../radar/autolp.js";
import { send, sendMenu, edit, explorerTx } from "./tg.js";
import { esc, pre, padR, padL, sg, money, tokenEmoji } from "./format.js";
import { fmtMcap, fmtAge } from "../util/format.js";
import type { PoolInfo, TokenMeta, MintMode } from "../types.js";

/** Unified candidate pool across Uniswap versions (v3 + v4). */
interface UPool {
  version: "v3" | "v4";
  fee: number;
  liqLabel: string; // display, e.g. "WETH 0.5" or "✅ liq"
  v3?: PoolInfo;
  v4?: V4Pool;
}
interface Pending {
  token: string;
  meta: TokenMeta;
  pools: UPool[];
  chosen?: UPool;
  awaitingAmount?: boolean;
  ethAmt?: string;
}
let pending: Pending | null = null;

const GAS_RESERVE = 0.0004; // native ETH kept for gas (~4-5 tx at ~0.0001 each)
const usableEth = (b: { weth: string; eth: string }): number =>
  Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);

// ══════════ open flow ══════════

export async function onCA(addr: string): Promise<void> {
  await send(`🔎 <b>Cari pool v3 + v4</b> di Robinhood Chain\n<code>${addr}</code>`);
  let meta: TokenMeta;
  const pools: UPool[] = [];
  try {
    meta = await tokenMeta(addr);
    // v3 (token/WETH) + v4 (token/ETH) in parallel
    const [v3, v4] = await Promise.all([
      findPools(addr).catch(() => [] as PoolInfo[]),
      discoverV4Pools(addr).catch(() => [] as V4Pool[]),
    ]);
    for (const p of v3) pools.push({ version: "v3", fee: p.fee, liqLabel: `WETH ${p.wethInPool.toFixed(3)}`, v3: p });
    for (const p of v4) if (p.liquidity > 0n) pools.push({ version: "v4", fee: p.fee, liqLabel: "✅ liq", v4: p });
  } catch (e) {
    await send(`❌ Gagal baca token/pool: ${short(e, 80)}`);
    return;
  }
  if (!pools.length) {
    await send(`⚠️ Tidak ada pool ${meta.symbol} (v3/WETH atau v4/ETH) dengan likuiditas. Belum bisa LP.`);
    return;
  }
  // sort: highest fee first (memecoin farming preference), v4 before v3 on ties
  pools.sort((a, b) => b.fee - a.fee || (a.version === "v4" ? -1 : 1));
  pending = { token: addr, meta, pools };
  const rows = pools.map((p, i) => [
    {
      text: `${i + 1}. ${p.version.toUpperCase()} · fee ${(p.fee / 10000).toFixed(2)}% · ${p.liqLabel}`,
      callback_data: `pool:${i}`,
    },
  ]);
  const nV3 = pools.filter((p) => p.version === "v3").length;
  const nV4 = pools.filter((p) => p.version === "v4").length;
  await send(`Ketemu <b>${pools.length}</b> pool ${esc(meta.symbol)} (${nV3} v3 + ${nV4} v4). Pilih:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

export async function onPick(idx: number, mid: number): Promise<void> {
  if (!pending) return;
  const p = pending.pools[idx];
  if (!p) return;
  pending.chosen = p;
  pending.awaitingAmount = true;
  const b = await balances().catch(() => null);
  await edit(
    mid,
    [
      `<b>${esc(pending.meta.symbol)}</b> · <b>${p.version.toUpperCase()}</b> fee ${(p.fee / 10000).toFixed(2)}% dipilih.`,
      b
        ? `Saldo bisa di-LP: <b>${usableEth(b).toFixed(5)} ETH</b>  <i>(WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)})</i>`
        : "",
      ``,
      `💬 <b>Ketik jumlah ETH</b> yang mau di-LP (contoh: <code>0.005</code>)`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function onAmount(text: string): Promise<void> {
  if (!pending?.awaitingAmount || !pending.chosen) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send("Masukin angka ETH yang bener, contoh: 0.005");
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(
      `⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH (WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)}, sisain gas). Ketik lebih kecil.`,
    );
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(
      `⚠️ ETH native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (butuh min ${GAS_RESERVE}). Isi sedikit ETH native, ATAU unwrap dikit WETH → ETH.`,
    );
    return;
  }
  pending.ethAmt = String(eth);
  pending.awaitingAmount = false;

  // ── v4 pool → single-side / in-range (farming) ──
  if (pending.chosen.version === "v4") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    await send(
      [
        `<b>Konfirmasi mint · Uniswap v4</b> 🦄`,
        `${esc(pending.meta.symbol)} · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b> · pair native ETH`,
        ``,
        `🎯 <b>In-range (farming)</b> — swap ~separuh ETH → token, mint di sekitar harga. <b>Fee ${feePct}% jalan LANGSUNG.</b> Tapi langsung pegang token (rug = rugi ~separuh).`,
        ``,
        `🛡 <b>Single-side ETH</b> — parkir ETH, range di atas harga. Fee cuma pas harga NAIK masuk range. Aman dari rug.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range farming ${feePct}%`, callback_data: "mint:v4r" }],
            [{ text: `🛡 Single-side ETH ${feePct}%`, callback_data: "mint:v4" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 pool → single / in-range ──
  const v3pool = pending.chosen.v3!.pool;
  const [pS, pI] = await Promise.all([
    previewRange(pending.token, v3pool, "single").catch(() => null),
    previewRange(pending.token, v3pool, "inrange").catch(() => null),
  ]);
  const rng = (p: typeof pS): string => (p ? `${fmtMcap(p.rangeMcapLow)} → ${fmtMcap(p.rangeMcapHigh)}` : "?");
  await send(
    [
      `<b>Konfirmasi mint · Uniswap v3</b>`,
      `${esc(pending.meta.symbol)} · fee ${(pending.chosen.fee / 10000).toFixed(2)}% · deposit <b>${eth} ETH</b> · width ${cfg.lp.widthPct}%`,
      pS ? `📊 MCAP now: <b>${fmtMcap(pS.mcapNow)}</b>` : "",
      ``,
      `🛡 <b>Single-side ETH</b> — range ${rng(pS)}`,
      `   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.`,
      ``,
      `🎯 <b>In-range</b> — range ${rng(pI)}`,
      `   swap ~<b>${pI?.swapPct ?? "?"}%</b> modal → ${esc(pending.meta.symbol)} duluan. Fee LANGSUNG jalan,`,
      `   tapi lu langsung pegang token (rug = rugi ${pI?.swapPct ?? "?"}% instan).`,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎯 In-range (swap ~${pI?.swapPct ?? "?"}%)`, callback_data: "mint:inrange" }],
          [{ text: "🛡 Single-side ETH", callback_data: "mint:single" }],
          [{ text: "❌ Cancel", callback_data: "cancel" }],
        ],
      },
    },
  );
}

export async function onMint(mid: number, action = "single"): Promise<void> {
  if (!pending?.chosen || !pending.ethAmt) return;
  if (pending.chosen.version === "v4") return onMintV4(mid, action === "v4r" ? "inrange" : "single");

  const mode: MintMode = action === "inrange" ? "inrange" : "single";
  const inR = mode === "inrange";
  await edit(
    mid,
    `⏳ <b>Minting v3 ${pending.ethAmt} ETH…</b> ${inR ? "(wrap → swap → approve → mint)" : "(wrap → approve → mint)"}`,
  );
  try {
    const r = await openPosition(pending.token, pending.chosen.v3!.pool, pending.ethAmt, { mode });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v3] ${inR ? "🎯 IN-RANGE" : "🛡 single-side"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ${r.swappedPct}% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `range tick ${r.tickLower}..${r.tickUpper}`,
        `📊 entry MCAP ${fmtMcap(r.entryMcap)} · ${r.side}`,
        `deposit ~${Number(r.depositEth).toFixed(5)}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint gagal: ${short(e, 160)}`);
  }
}

async function onMintV4(mid: number, mode: "single" | "inrange"): Promise<void> {
  if (!pending?.chosen?.v4 || !pending.ethAmt) return;
  const fee = pending.chosen.v4.fee;
  const inR = mode === "inrange";
  await edit(mid, `⏳ <b>Minting v4 ${pending.ethAmt} ETH…</b> ${inR ? "(swap → Permit2 → mint in-range)" : "(simulasi → mint single-side)"}`);
  try {
    const { openV4SingleSide, openV4InRange } = await import("../chain/v4/mint.js");
    const r = inR
      ? await openV4InRange(pending.token, pending.ethAmt, { fee })
      : await openV4SingleSide(pending.token, pending.ethAmt, { fee });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v4] 🦄 ${inR ? "🎯 IN-RANGE (farming)" : "single-side"}`,
        inR && (r as any).swapHash ? `swap ${(r as any).swappedPct}% → ${esc(sym)}: <a href="${explorerTx((r as any).swapHash)}">tx</a>` : "",
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

// ══════════ /list ══════════

export async function onList(mid: number | null = null): Promise<void> {
  if (!mid) {
    const m = await send("⏳ Memuat posisi…");
    mid = m?.result?.message_id ?? null;
  }
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listV4Positions } = await import("../chain/v4/list.js");
  // v3 + v4 in parallel (was sequential → slow "Memuat posisi…")
  const [rowsRes, v4rows] = await Promise.all([
    listPositions().then((r) => ({ ok: true as const, r })).catch((e) => ({ ok: false as const, e })),
    listV4Positions().catch(() => []),
  ]);
  if (!rowsRes.ok) {
    await out(`❌ ${short(rowsRes.e, 80)}`);
    return;
  }
  const rows = rowsRes.r;
  const refreshBtn = [{ text: "🔄 Refresh", callback_data: "refresh" }];
  if (!rows.length && !v4rows.length) {
    await out("Tidak ada posisi LP terbuka (v3/v4).", { reply_markup: { inline_keyboard: [refreshBtn] } });
    return;
  }
  const px = await ethUsd().catch(() => 0);
  const usd = (e: number) => (px ? `$${(e * px).toFixed(2)}` : "?");
  let totEth = 0, totPnl = 0, totFee = 0, totDep = 0;

  const T: string[] = [];
  rows.forEach((r, i) => {
    totEth += r.valEth || 0;
    totFee += r.feeEth || 0;
    totDep += r.depEth || 0;
    if (r.pnlEth != null) totPnl += r.pnlEth;
    const hrs = r.ageMs ? r.ageMs / 3_600_000 : 0;
    const rate = hrs > 0.05 && r.feeEth ? `${usd(r.feeEth / hrs)}/jam` : "—";
    const tag = `${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.mode === "inrange" ? " · 🎯" : ""}`;
    if (i) T.push("");
    T.push(`${tokenEmoji(r.tokenSym)} ${r.tokenSym}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
    T.push(`   ${tag}`);
    T.push("   " + "─".repeat(34));
    T.push(`   ${padR("modal", 7)} ${padL(r.depEth != null ? r.depEth.toFixed(6) + "Ξ" : "—", 11)}  ${padL(r.depEth != null ? usd(r.depEth) : "—", 9)}`);
    T.push(`   ${padR("nilai", 7)} ${padL(r.valEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.valEth), 9)}`);
    T.push(`   ${padR("fee", 7)} ${padL(r.feeEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.feeEth), 9)}`);
    T.push(`   ${padR("umur", 7)} ${padL(fmtAge(r.ageMs) + (r.ageSource === "onchain" ? " ⛓" : ""), 11)}  ${rate}`);
    T.push(`   ${padR("MCAP", 7)} ${padL(fmtMcap(r.mcapNow), 11)}  ${r.entryMcap ? "entry " + fmtMcap(r.entryMcap) : "—"}`);
    T.push(`   ${padR("range", 7)} ${fmtMcap(r.rangeMcapLow)} → ${fmtMcap(r.rangeMcapHigh)}`);
    if (r.pnlEth != null) {
      T.push(`   ${padR("PnL", 7)} ${padL(sg(r.pnlEth, 6) + "Ξ", 11)}  ${padL((r.pnlEth >= 0 ? "+" : "-") + "$" + Math.abs(r.pnlEth * px).toFixed(2), 9)}  ${sg(r.pnlPct ?? 0, 1)}%`);
    } else {
      T.push(`   ${padR("PnL", 7)} — (deposit tak tercatat)`);
    }
  });

  const S: string[] = [];
  S.push(`TOTAL ${rows.length} posisi`);
  S.push("─".repeat(37));
  S.push(`${padR("modal", 7)} ${padL(totDep.toFixed(6) + "Ξ", 11)}  ${padL(usd(totDep), 9)}`);
  S.push(`${padR("nilai", 7)} ${padL(totEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(totEth), 9)}`);
  S.push(`${padR("fee", 7)} ${padL(totFee.toFixed(6) + "Ξ", 11)}  ${padL(usd(totFee), 9)}`);
  S.push(`${padR("PnL", 7)} ${padL(sg(totPnl, 6) + "Ξ", 11)}  ${padL((totPnl >= 0 ? "+" : "-") + "$" + Math.abs(totPnl * px).toFixed(2), 9)}`);

  const dupe: Record<string, number> = {};
  rows.forEach((r) => (dupe[r.tokenSym] = (dupe[r.tokenSym] || 0) + 1));
  const btns: object[] = [refreshBtn];
  rows.forEach((r) => {
    const p =
      r.pnlEth != null
        ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)} · ${sg(r.pnlPct ?? 0, 1)}%`
        : "";
    const id = dupe[r.tokenSym]! > 1 ? ` #${r.tokenId}` : "";
    btns.push([{ text: `${tokenEmoji(r.tokenSym)} Close ${r.tokenSym}${id}${p}`, callback_data: `close:${r.tokenId}` }]);
  });
  if (rows.length > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${rows.length} posisi)`, callback_data: "closeall" }]);

  // ── v4 positions block ──
  const T4: string[] = [];
  if (v4rows.length) {
    T4.push(`🦄 UNISWAP v4 · ${v4rows.length} posisi`);
    T4.push("─".repeat(37));
    v4rows.forEach((r, i) => {
      if (i) T4.push("");
      T4.push(`${tokenEmoji(r.sym)} ${r.pair}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
      T4.push(`   ${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.ethPaired ? "" : " · non-ETH pair"}`);
      T4.push(`   ${padR("nilai", 7)} $${r.valueUsd.toFixed(2)}`);
      T4.push(`   ${padR("isi", 7)} ${r.amount0} ${r.sym0} + ${r.amount1} ${r.sym1}`);
      T4.push(`   ${padR("fee", 7)} $${r.feeUsd.toFixed(2)} earned`);
      if (r.depEth != null) T4.push(`   ${padR("modal", 7)} ${r.depEth.toFixed(6)}Ξ (${usd(r.depEth)})`);
      T4.push(`   ${padR("umur", 7)} ${fmtAge(r.ageMs)}`);
    });
    for (const r of v4rows) {
      const feeTag = r.feeUsd > 0.01 ? ` 💵$${r.feeUsd.toFixed(2)}` : "";
      btns.push([
        { text: `🧲 Claim fee ${r.sym}${feeTag}`, callback_data: `v4f:${r.tokenId}` },
        { text: `🦄 Close #${r.tokenId}`, callback_data: `v4c:${r.tokenId}` },
      ]);
    }
  }

  const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const head = `📋 <b>Posisi LP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${jam}</i>`;
  const body =
    (rows.length ? pre(T.join("\n")) + pre(S.join("\n")) : "") + (T4.length ? pre(T4.join("\n")) : "");
  await out(head + "\n" + body, { reply_markup: { inline_keyboard: btns } });
}

// ══════════ /ledger ══════════

const LEDGER_PER_PAGE = 5;
export async function onLedger(page = 0, mid: number | null = null): Promise<void> {
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listClosedV4Positions } = await import("../chain/v4/list.js");
  const v3all = readLedger().slice().sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const v4closed = await listClosedV4Positions().catch(() => [] as Awaited<ReturnType<typeof listClosedV4Positions>>);
  const sum = ledgerSummary();

  if (!v3all.length && !v4closed.length) {
    await out("⏳ <b>Ledger kosong — rebuild dari on-chain…</b>");
    try {
      await backfillLedger();
    } catch (e) {
      await out(`❌ Rebuild gagal: ${short(e, 90)}`);
      return;
    }
    if (!readLedger().length) {
      await out("📒 Belum ada posisi LP yang pernah ditutup.\n<i>Keisi otomatis tiap lu close posisi.</i>");
      return;
    }
    return onLedger(page, mid);
  }

  // unified closed list: v3 (rich PnL) + v4 (pair only), one paginated stream
  type LedRow = { v3?: (typeof v3all)[number]; v4?: (typeof v4closed)[number] };
  const combined: LedRow[] = [...v3all.map((e) => ({ v3: e })), ...v4closed.map((c) => ({ v4: c }))];
  const pages = Math.max(1, Math.ceil(combined.length / LEDGER_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = combined.slice(page * LEDGER_PER_PAGE, page * LEDGER_PER_PAGE + LEDGER_PER_PAGE);
  const px = await ethUsd().catch(() => 0);
  const when = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";

  const T: string[] = [];
  slice.forEach((row, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    if (row.v3) {
      const e = row.v3;
      const win = e.pnlEth == null ? "⬜" : e.pnlEth >= 0 ? "🟩" : "🟥";
      T.push(`${win} ${tokenEmoji(e.sym)} ${e.sym} · v3${e.mode === "inrange" ? " 🎯" : ""}   ${n}/${combined.length}`);
      T.push(`   ${when(e.closedAt)} · hold ${fmtAge(e.heldMs)}`);
      T.push(`   modal ${(e.depEth ?? 0).toFixed(5)}Ξ → balik ${(e.outEth ?? 0).toFixed(5)}Ξ`);
      if (e.pnlEth != null) T.push(`   PnL ${sg(e.pnlEth, 5)}Ξ  ${e.pnlUsd != null ? money(e.pnlUsd) : "—"}  ${sg(e.pnlPct ?? 0, 1)}%`);
      else T.push(`   PnL — (modal tak tercatat)`);
      if ((e.unsoldEth ?? 0) > 0) T.push(`   🪙 nyangkut ~${(e.unsoldEth ?? 0).toFixed(5)}Ξ (blm dijual)`);
    } else if (row.v4) {
      const c = row.v4;
      T.push(`⬜ ${tokenEmoji(c.pair)} ${c.pair} · v4 🦄   ${n}/${combined.length}`);
      T.push(`   fee ${(c.fee / 10000).toFixed(2)}% · #${c.tokenId}`);
      T.push(`   PnL — (v4 historis)${c.depEth != null ? ` · modal ${c.depEth.toFixed(5)}Ξ` : ""}`);
    }
  });

  const net = sum.pnlEth + sum.unsoldEth;
  const S: string[] = [];
  S.push(`${combined.length} DITUTUP · ${v3all.length} v3 · ${v4closed.length} v4`);
  S.push("─".repeat(34));
  S.push(`${padR("menang", 9)} ${sum.wins}W / ${sum.losses}L · ${sum.winRate.toFixed(0)}%`);
  S.push(`${padR("modal", 9)} ${sum.depEth.toFixed(5)}Ξ · fee ${sum.feeEth.toFixed(5)}Ξ`);
  S.push(`${padR("REALIZED", 9)} ${sg(sum.pnlEth, 5)}Ξ · ${money(sum.pnlUsd)}`);
  if (sum.unsoldEth > 0) S.push(`${padR("nyangkut", 9)} +${sum.unsoldEth.toFixed(5)}Ξ · +$${(sum.unsoldEth * px).toFixed(2)}`);
  S.push(`${padR("NET", 9)} ${sg(net, 5)}Ξ · ${money(net * px)}`);

  const nav: object[] = [];
  if (page > 0) nav.push({ text: "◀️ Back", callback_data: `lg:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `lg:${page}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `lg:${page + 1}` });

  const head = `📒 <b>Ledger LP</b> · ${combined.length} posisi ditutup`;
  const foot = v4closed.length ? `<i>Stats di atas = v3. PnL historis v4 belum direkonstruksi.</i>` : "";
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")) + foot, {
    reply_markup: { inline_keyboard: [nav, [{ text: "🔄 Rebuild dari on-chain", callback_data: "lgrb" }]] },
  });
}

export async function onLedgerRebuild(mid: number): Promise<void> {
  try {
    const r = await backfillLedger((msg) => {
      void edit(mid, `⏳ <b>Rebuild ledger dari on-chain</b>\n<i>${esc(msg)}</i>`).catch(() => {});
    });
    await edit(mid, `✅ Rebuild selesai — ${r.rebuilt} posisi dari on-chain, total ${r.total}.`);
    await onLedger(0);
  } catch (e) {
    await edit(mid, `❌ Rebuild gagal: ${short(e, 100)}`);
  }
}

// ══════════ /scan (manual) ══════════

export async function onScan(): Promise<void> {
  const { scanOnce } = await import("../watch/scanner.js");
  const m = await send("🔍 Scan volume…");
  const mid = m?.result?.message_id;
  try {
    const hits = await scanOnce((msg) => {
      if (mid) void edit(mid, `🔍 <i>${esc(msg)}</i>`).catch(() => {});
    });
    const { handleSpike } = await import("./pipeline.js");
    if (!hits.length) {
      await edit(mid, "🔍 Nggak ada token yang lolos filter barusan.\n<i>(butuh 2 scan buat ngukur kenaikan — coba lagi bentar)</i>");
      return;
    }
    await edit(mid, `🔍 <b>${hits.length} token</b> lolos:`);
    for (const h of hits) await handleSpike(h);
  } catch (e) {
    await edit(mid, `❌ Scan gagal: ${short(e, 90)}`);
  }
}

// ══════════ /watch ══════════

export async function onWatch(arg?: string): Promise<void> {
  const w = wcfg();
  if (arg === "on") {
    cfg.watch.enabled = true;
    persist();
    startWatch();
    await send("👁 Watch <b>ON</b>.");
    return;
  }
  if (arg === "off") {
    cfg.watch.enabled = false;
    persist();
    stopWatch();
    await send("👁 Watch <b>OFF</b>.");
    return;
  }
  const T = [
    `${padR("status", 12)} ${isWatchOn() ? "ON" : "OFF"}`,
    `${padR("scan tiap", 12)} ${w.intervalSec}s`,
    `${padR("vol 5m min", 12)} $${(w.minVol5m / 1000).toFixed(0)}k`,
    `${padR("naik min", 12)} ${w.riseFactor}× vs scan sebelumnya`,
    `${padR("vol 1h min", 12)} $${(w.minVol1h / 1000).toFixed(0)}k`,
    `${padR("likuid min", 12)} $${(w.minLiqUsd / 1000).toFixed(0)}k`,
    `${padR("tax maks", 12)} ${w.maxTaxPct}%`,
    `${padR("cooldown", 12)} ${w.cooldownMin} menit/token`,
    `${padR("RPC", 12)} ${usingOwnWatchRpc ? "terpisah (khusus scan)" : "numpang RPC LP"}`,
  ];
  const top = await topVolumeNow(3).catch(() => []);
  if (top.length) {
    T.push("");
    T.push("VOL 5m TERTINGGI SEKARANG");
    for (const t of top) {
      const pass = t.vol5m >= w.minVol5m;
      T.push(`  ${pass ? "✓" : " "} ${padR(t.symbol.slice(0, 10), 11)} $${(t.vol5m / 1000).toFixed(0)}k`);
    }
    const gap = w.minVol5m / Math.max(top[0]!.vol5m, 1);
    T.push(gap > 1 ? `  → ambang ${gap.toFixed(1)}× di atas puncak: SEPI` : `  → ada yang lewat ambang`);
  }
  await send(
    `👁 <b>Volume Watch</b>${pre(T.join("\n"))}<code>/watch on</code> · <code>/watch off</code> · <code>/scan</code> (cek sekarang)\nUbah: <code>/set vol5m 200000</code> · <code>/set rise 2</code> · <code>/set liq 100000</code>`,
  );
}

// ══════════ /feed (real-time sequencer monitor) ══════════

export async function onFeed(arg?: string): Promise<void> {
  if (arg === "on") {
    cfg.feed.enabled = true;
    persist();
    await startFeed();
    await send("📡 Feed monitor <b>ON</b> — deteksi token baru + posisi out-of-range real-time.");
    return;
  }
  if (arg === "off") {
    cfg.feed.enabled = false;
    persist();
    stopFeed();
    await send("📡 Feed monitor <b>OFF</b>.");
    return;
  }
  const s = feedStatus();
  const f = cfg.feed;
  const r = cfg.radar;
  const T = [
    `${padR("status", 16)} ${s.on ? "ON" : "OFF"}`,
    `${padR("new-token alert", 16)} ${f.newToken ? "on" : "off"}`,
    `${padR("position monitor", 16)} ${f.positionMonitor ? "on" : "off"}`,
    `${padR("auto-close OOR", 16)} ${f.autoCloseOutOfRange ? "⚠️ ON" : "off"}`,
    `${padR("min WETH seed", 16)} ${f.newTokenMinWethSeed}Ξ`,
    ``,
    `${padR("radar LLM", 16)} ${r.enabled ? (env.openrouterKey ? "on" : "on (no key!)") : "off"}`,
    `${padR("radar model", 16)} ${env.openrouterModel}`,
    `${padR("radar GMGN", 16)} ${r.useGmgn ? "on" : "off"}`,
    `${padR("fast-submit", 16)} ${env.fastSubmit ? "ON → sequencer" : "off (via RPC)"}`,
    ``,
    `${padR("token dikenal", 16)} ${s.seen}`,
    `${padR("posisi dipantau", 16)} ${s.positions}`,
    `${padR("token baru", 16)} ${s.newTokens}`,
    `${padR("alert range", 16)} ${s.rangeAlerts}`,
  ];
  await send(
    `📡 <b>Sequencer Feed Monitor</b>${pre(T.join("\n"))}` +
      `<code>/feed on</code> · <code>/feed off</code>\n` +
      `Toggle: <code>/set newtoken 1</code> · <code>/set posmon 1</code> · <code>/set autoclose 0</code>\n` +
      `Radar: <code>/set radar 1</code> · <code>/set gmgn 1</code>\n` +
      `<i>⚠️ Lokal (Telkomsel) butuh RH_FEED_IP=172.66.147.70. fast-submit: RH_FAST_SUBMIT=1. radar: RH_OPENROUTER_KEY.</i>`,
  );
}

// ══════════ /v4 (detect v4 pools) ══════════

export async function onV4(ca?: string): Promise<void> {
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca)) {
    await send("Format: <code>/v4 0x…</code> (CA token) — liat pool v4/ETH + fee + likuiditas.");
    return;
  }
  const m = await send(`🔎 Cek pool v4 <code>${ca}</code>…`);
  const mid = m?.result?.message_id;
  try {
    const { discoverV4Pools, pickV4Pool } = await import("../chain/v4/discover.js");
    const meta = await tokenMeta(ca).catch(() => null);
    const pools = await discoverV4Pools(ca);
    if (!pools.length) {
      await edit(mid, `Nggak ada pool v4/ETH buat ${meta?.symbol ?? "token"} ini.`);
      return;
    }
    const T = pools
      .sort((a, b) => b.fee - a.fee)
      .map((p) => `  ${padR((p.fee / 10000).toFixed(2) + "%", 7)} ${p.liquidity > 0n ? "✅ ada likuiditas" : "— kosong"}  tick ${p.tick}`);
    const pick = pickV4Pool(pools);
    await edit(
      mid,
      `🦄 <b>Pool v4/ETH · ${esc(meta?.symbol ?? "?")}</b>${pre(T.join("\n"))}` +
        (pick ? `Target LP (fee tertinggi + likuid): <b>${(pick.fee / 10000).toFixed(2)}%</b>\n` : "") +
        `<i>Mint/close v4 = Fase 2 (lagi dibangun). Sekarang deteksi doang.</i>`,
    );
  } catch (e) {
    await edit(mid, `❌ ${short(e, 90)}`);
  }
}

// ══════════ /v4lp /v4close (v4 LP execution — single-side ETH) ══════════

export async function onV4Lp(text: string): Promise<void> {
  const [, ca, ethStr] = text.split(/\s+/);
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !ethStr || !(parseFloat(ethStr) > 0)) {
    await send("Format: <code>/v4lp 0x… 0.001</code> — buka LP v4 single-side ETH di pool fee-tertinggi.");
    return;
  }
  const eth = parseFloat(ethStr);
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Kegedean. Bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH.`);
    return;
  }
  const m = await send(`⏳ <b>Mint v4 ${eth} ETH…</b> (discover pool → simulasi → mint native ETH)`);
  const mid = m?.result?.message_id;
  try {
    const { openV4SingleSide } = await import("../chain/v4/mint.js");
    const r = await openV4SingleSide(ca, String(eth));
    await edit(
      mid,
      [
        `✅ <b>v4 LP dibuka</b> #${r.tokenId ?? "?"} 🦄`,
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · single-side ETH`,
        `range tick ${r.tickLower}..${r.tickUpper} · deposit ${r.depositEth}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

export async function onV4Close(text: string): Promise<void> {
  const [, tokenId] = text.split(/\s+/);
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    await send("Format: <code>/v4close &lt;tokenId&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV4Position } = await import("../chain/v4/close.js");
    const r = await closeV4Position(tokenId);
    await edit(
      mid,
      [
        `✅ <b>v4 #${tokenId} closed</b> · fee ${(r.fee / 10000).toFixed(2)}%`,
        `Balik: ${r.recv0 > 0 ? `${r.recv0.toFixed(6)} ${r.sym0}` : ""}${r.recv0 > 0 && r.recv1 > 0 ? " + " : ""}${r.recv1 > 0 ? `${r.recv1.toFixed(6)} ${r.sym1}` : ""}`,
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ v4 close gagal: ${short(e, 160)}`);
  }
}

export async function onV4Collect(tokenId: string): Promise<void> {
  const m = await send(`⏳ Claim fee v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { collectV4Fees } = await import("../chain/v4/close.js");
    const r = await collectV4Fees(tokenId);
    const got = [r.fee0 > 0 ? `${r.fee0.toFixed(6)} ${r.sym0}` : "", r.fee1 > 0 ? `${r.fee1.toFixed(6)} ${r.sym1}` : ""].filter(Boolean).join(" + ");
    await edit(
      mid,
      [
        `✅ <b>Fee di-claim · v4 #${tokenId}</b>`,
        got ? `Dapet: ${got}` : `Nggak ada fee buat di-claim.`,
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ Claim fee gagal: ${short(e, 160)}`);
  }
}

// ══════════ /auto (autonomous LP) ══════════

export async function onAuto(arg?: string): Promise<void> {
  const a = cfg.autoLp;
  if (arg === "on") {
    cfg.autoLp.enabled = true;
    persist();
    await send(
      [
        `🤖 <b>AUTO-LP ON</b> ⚠️`,
        `Bot bakal buka posisi OTOMATIS (pakai dana beneran) kalau kandidat lolos radar + semua gate.`,
        ``,
        `Gate sekarang:`,
        `• source: ${a.sources.join(", ")}`,
        `• verdict LLM: ${a.requireAction} & skor ≥ ${a.minScore}`,
        `• ukuran: <b>${a.sizeEth}Ξ</b> · mode: ${a.mode}`,
        `• likuiditas min $${a.minLiqUsd} · tax maks ${a.maxTaxPct}%`,
        `• cap: ${a.maxOpen} posisi · ${a.maxPerHour}/jam · ${a.dailyCapEth}Ξ/hari`,
        ``,
        `Matiin: <code>/auto off</code>`,
      ].join("\n"),
    );
    return;
  }
  if (arg === "off") {
    cfg.autoLp.enabled = false;
    persist();
    await send("🤖 <b>AUTO-LP OFF</b>. Balik ke manual (notif + tombol).");
    return;
  }
  const s = autoLpStatus();
  const T = [
    `${padR("status", 14)} ${a.enabled ? "🟢 ON" : "off"}`,
    `${padR("ukuran", 14)} ${a.sizeEth}Ξ · ${a.mode}`,
    `${padR("trigger", 14)} ${a.requireAction} & skor ≥ ${a.minScore}`,
    `${padR("source", 14)} ${a.sources.join(", ")}`,
    `${padR("likuid min", 14)} $${a.minLiqUsd}`,
    `${padR("tax maks", 14)} ${a.maxTaxPct}%`,
    `${padR("cap posisi", 14)} ${a.maxOpen}`,
    `${padR("cap /jam", 14)} ${a.maxPerHour}`,
    `${padR("cap /hari", 14)} ${a.dailyCapEth}Ξ`,
    ``,
    `${padR("hari ini", 14)} ${s.opensToday} open · ${s.spentToday.toFixed(4)}Ξ`,
    `${padR("jam ini", 14)} ${s.lastHour} open`,
  ];
  await send(
    `🤖 <b>Auto-LP</b>${pre(T.join("\n"))}` +
      `<code>/auto on</code> · <code>/auto off</code>\n` +
      `Tune: <code>/set alpsize 0.001</code> · <code>/set alpscore 75</code> · <code>/set alpmaxopen 3</code> · <code>/set alpdaily 0.01</code> · <code>/set alpminliq 20000</code>\n` +
      `<i>⚠️ Eksekusi tx otomatis pakai dana real. Default single-side (rug-safe). Butuh radar aktif (/set radar 1).</i>`,
  );
}

// ══════════ close ══════════

export async function onCloseAsk(tokenId: string, mid: number): Promise<void> {
  await edit(mid, `Close #${tokenId} — fee/token-nya mau diapain?\n<i>(LP principal tetap balik jadi ETH)</i>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Swap token → ETH (full ETH)", callback_data: `cs:${tokenId}` }],
        [{ text: "🪙 Simpen token (WETH + token)", callback_data: `ck:${tokenId}` }],
      ],
    },
  });
}

export async function onClose(tokenId: string, mid: number, swapToken = true): Promise<void> {
  await edit(mid, `⏳ Closing #${tokenId}… ${swapToken ? "(swap token→ETH)" : "(simpen token)"}`);
  try {
    const r = await closePosition(tokenId, { swapToken });
    const px = await ethUsd().catch(() => 0);
    const pnl =
      r.pnlEth != null
        ? `\n💰 <b>PnL ETH: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ</b> (${r.pnlPct! >= 0 ? "+" : ""}${r.pnlPct!.toFixed(1)}%)\n💵 <b>PnL USD: ${r.pnlEth >= 0 ? "+" : ""}$${px ? (r.pnlEth * px).toFixed(2) : "?"}</b>`
        : `\nPnL: — (deposit tak tercatat)`;
    await send(
      [
        `✅ <b>Closed #${tokenId}</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}`,
        r.heldMs != null ? `⏱ di-hold <b>${fmtAge(r.heldMs)}</b>` : "",
        `Tarik: ${r.recvWeth.toFixed(6)} ${r.wethSym}${r.recvToken > 0 ? ` + ${r.recvToken.toFixed(2)} ${r.tokenSym}` : ""}`,
        r.swappedWeth > 0
          ? `🔄 Swap ${r.tokenSym} → +${r.swappedWeth.toFixed(6)} WETH`
          : r.tokenStuck > 0
            ? swapToken
              ? `⚠️ ${r.tokenStuck.toFixed(2)} ${r.tokenSym} gagal dijual (rug) — nyangkut`
              : `🪙 ${r.tokenStuck.toFixed(2)} ${r.tokenSym} disimpen (senilai ~$${px ? ((r.valEth - r.recvWeth) * px).toFixed(2) : "?"})`
            : "",
        `Total balik: <b>${r.valEth.toFixed(6)}Ξ / $${px ? (r.valEth * px).toFixed(2) : "?"}</b>${r.depEth != null ? ` (deposit ${r.depEth.toFixed(6)}Ξ)` : ""}${pnl}`,
        r.topUp ? `⛽ Top-up gas: unwrap ${r.topUp.unwrapped.toFixed(5)} WETH → ETH native (${r.topUp.nativeAfter.toFixed(4)}Ξ)` : "",
        r.collectHash ? `tx: <a href="${explorerTx(r.collectHash)}">collect</a>${r.swapHash ? ` · <a href="${explorerTx(r.swapHash)}">swap</a>` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Close gagal: ${short(e, 120)}`);
  }
}

export async function onCloseAll(): Promise<void> {
  let rows;
  try {
    rows = await listPositions();
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
    return;
  }
  if (!rows.length) {
    await send("Tidak ada posisi buat ditutup.");
    return;
  }
  const px = await ethUsd().catch(() => 0);
  await send(`🗑🗑 <b>Menutup ${rows.length} posisi…</b> (satu per satu)`);
  let totPnl = 0, ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const r = await closePosition(row.tokenId);
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(
        `✅ #${row.tokenId} ${row.tokenSym} closed · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`,
      );
    } catch (e) {
      fail++;
      await send(`❌ #${row.tokenId} gagal: ${short(e, 70)}`);
    }
  }
  await send(
    [
      `🏁 <b>Close ALL selesai</b> — ${ok} sukses${fail ? `, ${fail} gagal` : ""}`,
      `💰 Total PnL ETH: <b>${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(6)}Ξ</b>`,
      px ? `💵 Total PnL USD: <b>${totPnl >= 0 ? "+" : ""}$${(totPnl * px).toFixed(2)}</b>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ══════════ misc ══════════

export async function onPnl(): Promise<void> {
  await send("📊 Menghitung PnL seumur hidup… (scan history + rug, ±20 detik)");
  let r;
  try {
    r = await lifetimePnl();
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
    return;
  }
  const u = (e: number) => (r.px ? `$${(e * r.px).toFixed(2)}` : "?");
  const emo = r.pnlEth > 0 ? "🟢" : r.pnlEth < 0 ? "🔴" : "⚪";
  await sendMenu(
    [
      `📊 <b>PnL SEUMUR HIDUP</b>${r.px ? ` · ETH $${r.px.toFixed(0)}` : ""}`,
      ``,
      `💵 Modal disetor : <b>${r.capIn.toFixed(5)}Ξ</b> (${u(r.capIn)})`,
      r.capOut > 0 ? `↩️ Ditarik keluar: ${r.capOut.toFixed(5)}Ξ (${u(r.capOut)})` : "",
      `💰 Nilai sekarang: <b>${r.valueNowEth.toFixed(5)}Ξ</b> (${u(r.valueNowEth)})`,
      `   • native ${r.nativeEth.toFixed(4)}Ξ · WETH ${r.wethHeld.toFixed(4)}Ξ`,
      `   • LP terbuka ${r.openLpEth.toFixed(4)}Ξ · token $${r.tokensUsd.toFixed(2)}`,
      `━━━━━━━━━`,
      `${emo} <b>NET PnL: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(5)}Ξ (${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlUsd).toFixed(2)})</b>`,
      r.graveyardCount ? `\n🪦 <b>${r.graveyardCount} token rug</b> nyangkut worth ~$0:\n<i>${r.graveyard.join(", ")}${r.graveyardCount > 12 ? "…" : ""}</i>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function onSell(): Promise<void> {
  await send("🔄 <b>Menjual semua token nyangkut → ETH…</b>\n(skip yang rug/pool kering)");
  try {
    const r = await sellAllTokens((msg) => {
      void send(msg).catch(() => {});
    });
    await sendMenu(
      [
        `🏁 <b>Selesai jual</b> — ${r.sold} token → ETH${r.skipped ? `, ${r.skipped} di-skip (rug)` : ""}`,
        `💰 Total dapet: <b>+${r.soldEth.toFixed(6)} WETH ($${r.soldUsd.toFixed(2)})</b>`,
      ].join("\n"),
    );
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
  }
}

export async function onWallet(): Promise<void> {
  try {
    const b = await balances();
    await sendMenu(`👛 <code>${b.address}</code>\nETH: ${Number(b.eth).toFixed(5)} · WETH: ${Number(b.weth).toFixed(5)}`);
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
  }
}

export async function onSettings(): Promise<void> {
  const T = [
    `${padR("width", 12)} ${cfg.lp.widthPct}%`,
    `${padR("slippage", 12)} ${cfg.lp.slippagePct}%`,
    `${padR("fee floor LP", 12)} ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`,
    `${padR("gas target", 12)} ${cfg.lp.nativeTargetEth}Ξ`,
    `${padR("auto-wrap", 12)} ${cfg.lp.autoWrap ? "on" : "off"}`,
    ``,
    `${padR("radar LLM", 12)} ${cfg.radar.enabled ? "on" : "off"}`,
    `${padR("feed", 12)} ${cfg.feed.enabled ? "on" : "off"}`,
    `${padR("auto-LP", 12)} ${cfg.autoLp.enabled ? "🟢 ON" : "off"}`,
    `${padR("fast-submit", 12)} ${env.fastSubmit ? "on" : "off"}`,
  ];
  await sendMenu(
    `⚙️ <b>Setting</b>${pre(T.join("\n"))}` +
      `Ubah: <code>/set width 40</code> · <code>/set slippage 5</code> · <code>/set gastarget 0.015</code>\n` +
      `<i>Watch/Feed/Auto/Radar diatur di menu masing-masing.</i>`,
  );
}

const LP_MAP: Record<string, keyof typeof cfg.lp> = {
  width: "widthPct",
  deposit: "depositUsd",
  slippage: "slippagePct",
  gastarget: "nativeTargetEth",
};
const WATCH_MAP: Record<string, keyof typeof cfg.watch> = {
  vol5m: "minVol5m",
  vol1h: "minVol1h",
  rise: "riseFactor",
  liq: "minLiqUsd",
  tax: "maxTaxPct",
  cooldown: "cooldownMin",
  interval: "intervalSec",
};
const FEED_NUM_MAP: Record<string, keyof typeof cfg.feed> = {
  minseed: "newTokenMinWethSeed",
  activity: "activityThreshold",
  feedcooldown: "cooldownMin",
};
const FEED_BOOL_MAP: Record<string, keyof typeof cfg.feed> = {
  newtoken: "newToken",
  posmon: "positionMonitor",
  autoclose: "autoCloseOutOfRange",
};
const RADAR_BOOL_MAP: Record<string, keyof typeof cfg.radar> = {
  radar: "enabled",
  gmgn: "useGmgn",
};
const AUTOLP_NUM_MAP: Record<string, keyof typeof cfg.autoLp> = {
  alpsize: "sizeEth",
  alpscore: "minScore",
  alpmaxopen: "maxOpen",
  alpperhour: "maxPerHour",
  alpdaily: "dailyCapEth",
  alpminliq: "minLiqUsd",
  alpmaxtax: "maxTaxPct",
};
const SET_HELP =
  "LP: width, deposit, slippage, gastarget\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval\nFeed: minseed, activity, feedcooldown · toggle: newtoken/posmon/autoclose (0/1)\nRadar: radar/gmgn (0/1)\nAuto-LP: alpsize, alpscore, alpmaxopen, alpperhour, alpdaily, alpminliq, alpmaxtax";

export async function onSet(text: string): Promise<void> {
  const [, k, v] = text.split(/\s+/);
  if (!k || v == null || isNaN(Number(v))) {
    await send(`Format: <code>/set &lt;key&gt; &lt;angka&gt;</code>\n${SET_HELP}`);
    return;
  }
  if (LP_MAP[k]) {
    (cfg.lp[LP_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ ${k} → ${v}`);
    return;
  }
  if (WATCH_MAP[k]) {
    (cfg.watch[WATCH_MAP[k]] as number) = Number(v);
    persist();
    if (k === "interval") restartWatch();
    await send(`✓ watch.${k} → ${v}`);
    return;
  }
  if (FEED_NUM_MAP[k]) {
    (cfg.feed[FEED_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ feed.${k} → ${v}`);
    return;
  }
  if (FEED_BOOL_MAP[k]) {
    (cfg.feed[FEED_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    await send(`✓ feed.${k} → ${Number(v) !== 0 ? "on" : "off"}${k === "autoclose" && Number(v) !== 0 ? " ⚠️" : ""}`);
    return;
  }
  if (RADAR_BOOL_MAP[k]) {
    (cfg.radar[RADAR_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    const warn = k === "radar" && Number(v) !== 0 && !env.openrouterKey ? " ⚠️ RH_OPENROUTER_KEY belum diset" : "";
    await send(`✓ radar.${k} → ${Number(v) !== 0 ? "on" : "off"}${warn}`);
    return;
  }
  if (AUTOLP_NUM_MAP[k]) {
    (cfg.autoLp[AUTOLP_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ autoLp.${k} → ${v}`);
    return;
  }
  await send(`Key nggak dikenal.\n${SET_HELP}`);
}

export async function onHelp(): Promise<void> {
  const body = [
    `🤖 <b>Robinhood LP Bot</b>  <i>v2 · Uniswap v3+v4</i>`,
    `Paste <b>CA token</b> (0x…) → pilih pool (v3/v4) → jumlah ETH → LP.`,
    ``,
    `<b>━━━ 📊 POSISI ━━━</b>`,
    `📋 /list — posisi terbuka + PnL + close`,
    `📒 /ledger — riwayat ditutup (realized)`,
    `💰 /pnl — PnL seumur hidup`,
    ``,
    `<b>━━━ 🎯 RADAR & AUTO ━━━</b>`,
    `📡 /feed — monitor sequencer real-time`,
    `👁 /watch — scanner volume nanjak`,
    `🔍 /scan — cek volume sekarang`,
    `🤖 /auto — auto-LP (radar → buka sendiri)`,
    `🦄 /v4 <code>&lt;ca&gt;</code> — cek pool v4 fee-tinggi`,
    ``,
    `<b>━━━ ⚡ AKSI ━━━</b>`,
    `🗑 /closeall · 💸 /sell · 👛 /wallet`,
    `⚙️ /settings · /set <code>&lt;k&gt; &lt;v&gt;</code>`,
    ``,
    `<i>Menu cepat ada di bawah 👇 — nggak perlu ngetik.</i>`,
  ].join("\n");
  await sendMenu(body);
}

// per-message pending accessors for bot.ts routing
export const isAwaitingAmount = (): boolean => !!pending?.awaitingAmount;
export const cancelPending = (): void => {
  pending = null;
};

function short(e: unknown, n: number): string {
  return String((e as Error)?.message ?? e).slice(0, n);
}
