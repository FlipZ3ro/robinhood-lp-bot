/** Command + callback handlers. Each renders through tg.send/edit (owner chat only). */
import { cfg, env, persist } from "../config.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools } from "../chain/pools.js";
import { discoverV4Pools, type V4Pool } from "../chain/v4/discover.js";
import { readV2Pool, type V2Pool } from "../chain/v2/pair.js";
import { previewRange, openPosition, listPositions, closePosition } from "../chain/positions.js";
import { readLedger, ledgerSummary, backfillLedger } from "../chain/ledger.js";
import { lifetimePnl } from "../chain/analytics.js";
import { balances, sellAllTokens } from "../chain/holdings.js";
import { tokenBalanceRaw } from "../chain/swaps.js";
import { ethUsd } from "../chain/price.js";
import { topVolumeNow, wcfg, usingOwnWatchRpc } from "../watch/scanner.js";
import { startWatch, stopWatch, restartWatch, isWatchOn } from "./watchLoop.js";
import { startFeed, stopFeed, feedStatus } from "./feedLoop.js";
import { autoLpStatus } from "../radar/autolp.js";
import { send, sendMenu, edit, explorerTx, sendPhoto, downloadTgFile } from "./tg.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { esc, pre, padR, padL, sg, money, tokenEmoji } from "./format.js";
import { fmtMcap, fmtAge } from "../util/format.js";
import type { PoolInfo, TokenMeta, MintMode } from "../types.js";

/** Unified candidate pool across Uniswap versions (v2 + v3 + v4). */
interface UPool {
  version: "v2" | "v3" | "v4";
  fee: number;
  liqLabel: string; // display, e.g. "WETH 0.5" or "✅ liq"
  v2?: V2Pool;
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
  heldTokenUi?: number; // token already in wallet (reused for dual-side)
  balancedEth?: number; // ETH that balances the held token for a dual-side mint
}
let pending: Pending | null = null;

const GAS_RESERVE = 0.0004; // native ETH kept for gas (~4-5 tx at ~0.0001 each)
const usableEth = (b: { weth: string; eth: string }): number =>
  Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);

// ══════════ open flow ══════════

export async function onCA(addr: string): Promise<void> {
  await send(`🔎 <b>Cari pool v2 + v3 + v4</b> di Robinhood Chain\n<code>${addr}</code>`);
  let meta: TokenMeta;
  const pools: UPool[] = [];
  try {
    meta = await tokenMeta(addr);
    const { discoverV4UsdgPools } = await import("../chain/v4/discover.js");
    // v2/v3 (token/WETH) + v4 (token/ETH) + v4 (token/USDG) in parallel
    const [v2, v3, v4, v4usd] = await Promise.all([
      readV2Pool(addr).catch(() => null as V2Pool | null),
      findPools(addr).catch(() => [] as PoolInfo[]),
      discoverV4Pools(addr).catch(() => [] as V4Pool[]),
      discoverV4UsdgPools(addr).catch(() => [] as V4Pool[]),
    ]);
    if (v2) pools.push({ version: "v2", fee: 3000, liqLabel: `WETH ${v2.wethInPool.toFixed(3)}`, v2 });
    for (const p of v3) pools.push({ version: "v3", fee: p.fee, liqLabel: `WETH ${p.wethInPool.toFixed(3)}`, v3: p });
    for (const p of v4) if (p.liquidity > 0n) pools.push({ version: "v4", fee: p.fee, liqLabel: "ETH ✅", v4: p });
    for (const p of v4usd) if (p.liquidity > 0n) pools.push({ version: "v4", fee: p.fee, liqLabel: "USDG ✅", v4: p });
  } catch (e) {
    await send(`❌ Gagal baca token/pool: ${short(e, 80)}`);
    return;
  }
  if (!pools.length) {
    await send(`⚠️ Tidak ada pool ${esc(meta.symbol)} (v2/v3 WETH, v4 ETH/USDG) dengan likuiditas. Belum bisa LP.`);
    return;
  }
  // sort: highest fee first (memecoin farming preference); on ties v4 > v3 > v2
  const vRank = (v: string) => (v === "v4" ? 0 : v === "v3" ? 1 : 2);
  pools.sort((a, b) => b.fee - a.fee || vRank(a.version) - vRank(b.version));
  pending = { token: addr, meta, pools };
  const rows = pools.map((p, i) => [
    {
      text: `${i + 1}. ${p.version.toUpperCase()} · fee ${(p.fee / 10000).toFixed(2)}% · ${p.liqLabel}`,
      callback_data: `pool:${i}`,
    },
  ]);
  const nV2 = pools.filter((p) => p.version === "v2").length;
  const nV3 = pools.filter((p) => p.version === "v3").length;
  const nV4 = pools.filter((p) => p.version === "v4").length;
  await send(`Ketemu <b>${pools.length}</b> pool ${esc(meta.symbol)} (${nV2} v2 + ${nV3} v3 + ${nV4} v4). Pilih:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

export async function onPick(idx: number, mid: number): Promise<void> {
  if (!pending) return;
  const p = pending.pools[idx];
  if (!p) return;
  pending.chosen = p;
  pending.awaitingAmount = true;
  const [b, tokRaw] = await Promise.all([
    balances().catch(() => null),
    tokenBalanceRaw(pending.token).catch(() => 0n),
  ]);
  // token already in the wallet (e.g. bought on a prior attempt) — in-range LP reuses it, no re-buy
  const tokUi = tokRaw > 0n ? Number(tokRaw) / 10 ** pending.meta.decimals : 0;
  pending.heldTokenUi = tokUi;

  // for a v4 dual-side (in-range) mint, compute the ETH that BALANCES the held token so the
  // two sides fill evenly (no swap, minimal leftover) — this is the "hitungan sama" the user wants
  let balanced = 0;
  if (tokUi > 0 && p.version === "v4" && p.v4) {
    try {
      const { balancedEthForHeldToken } = await import("../chain/v4/mint.js");
      balanced = balancedEthForHeldToken(pending.token, pending.meta, p.v4, tokRaw);
    } catch {
      /* suggestion is best-effort */
    }
  }
  pending.balancedEth = balanced;

  const reuseLine =
    tokUi > 0 && (p.version === "v4" || p.version === "v2")
      ? `♻️ <b>${tokUi.toPrecision(4)} ${esc(pending.meta.symbol)}</b> udah di wallet — bakal <b>dipake ulang</b> (nggak beli lagi).`
      : "";
  const balLine = balanced > 0 ? `⚖️ Buat <b>dual-side seimbang</b> sama token itu: pasang <b>~${balanced.toFixed(5)} ETH</b>.` : "";
  const extra =
    balanced > 0
      ? { reply_markup: { inline_keyboard: [[{ text: `⚖️ Dual-side seimbang (~${balanced.toFixed(4)} Ξ)`, callback_data: "ballp" }]] } }
      : {};
  await edit(
    mid,
    [
      `<b>${esc(pending.meta.symbol)}</b> · <b>${p.version.toUpperCase()}</b> fee ${(p.fee / 10000).toFixed(2)}% dipilih.`,
      b
        ? `Saldo bisa di-LP: <b>${usableEth(b).toFixed(5)} ETH</b>  <i>(WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)})</i>`
        : "",
      reuseLine,
      balLine,
      ``,
      `💬 <b>Ketik jumlah ETH</b> yang mau di-LP (contoh: <code>0.005</code>)${balanced > 0 ? " — atau tap tombol di bawah." : ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
    extra,
  );
}

/** One-tap: dual-side v4 mint with the ETH amount that balances the held token. */
export async function onBalancedLp(mid: number): Promise<void> {
  if (!pending?.chosen?.v4 || !pending.balancedEth) return;
  pending.ethAmt = String(pending.balancedEth);
  pending.awaitingAmount = false;
  await onMintV4(mid, "inrange");
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

  // ── v2 pool → zap (full-range, always both-sided) ──
  if (pending.chosen.version === "v2") {
    await send(
      [
        `<b>Konfirmasi LP · Uniswap v2</b>`,
        `${esc(pending.meta.symbol)} · fee <b>0.30%</b> · deposit <b>${eth} ETH</b> · full-range`,
        ``,
        `🎯 v2 selalu <b>both-sided 50/50</b>: bot swap ~separuh ETH → ${esc(pending.meta.symbol)}, sisanya jadi pasangan LP. <b>Fee jalan LANGSUNG.</b>`,
        `⚠️ Langsung pegang token (rug = rugi ~separuh). Nggak ada single-side di v2.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 LP v2 (zap ${eth}Ξ)`, callback_data: "mint:v2" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v4 pool → single-side / in-range (farming) ──
  if (pending.chosen.version === "v4") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    const isUsd = pending.chosen.v4?.quote === "usd";
    if (isUsd) {
      // USDG-paired pool: both sides are ERC20 → only both-sided in-range makes sense.
      await send(
        [
          `<b>Konfirmasi LP · Uniswap v4 · USDG</b> 🦄`,
          `${esc(pending.meta.symbol)}/USDG · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b>`,
          ``,
          `🎯 <b>In-range (farming)</b> — bot beli USDG + ${esc(pending.meta.symbol)} dari ETH lo (rute terbaik via Kyber), terus mint both-sided. <b>Fee ${feePct}% jalan LANGSUNG.</b>`,
          `⚠️ Langsung pegang token (rug = rugi). Nggak ada single-side di pair USDG.`,
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 LP USDG ${feePct}% (${eth}Ξ)`, callback_data: "mint:v4r" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        },
      );
      return;
    }
    await send(
      [
        `<b>Konfirmasi mint · Uniswap v4</b> 🦄`,
        `${esc(pending.meta.symbol)} · fee <b>${feePct}%</b> · deposit <b>${eth} ETH</b> · pair native ETH`,
        ``,
        `🎯 <b>In-range (farming)</b> — beli token via rute terbaik (Kyber), mint di sekitar harga. <b>Fee ${feePct}% jalan LANGSUNG.</b> Tapi langsung pegang token (rug = rugi ~separuh).`,
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
  invalidateListCache();
  if (!pending?.chosen || !pending.ethAmt) return;
  if (pending.chosen.version === "v2") return onMintV2(mid);
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
  invalidateListCache();
  if (!pending?.chosen?.v4 || !pending.ethAmt) return;
  const fee = pending.chosen.v4.fee;
  const isUsd = pending.chosen.v4.quote === "usd";
  const inR = mode === "inrange" || isUsd; // USDG pairs are always both-sided in-range
  const v4pool = pending.chosen.v4;
  await edit(mid, `⏳ <b>Minting v4 ${pending.ethAmt} ETH…</b> ${isUsd ? "(Kyber → USDG+token → mint)" : inR ? "(swap → Permit2 → mint in-range)" : "(simulasi → mint single-side)"}`);
  try {
    const { openV4SingleSide, openV4InRange, openV4UsdgInRange } = await import("../chain/v4/mint.js");
    const r = isUsd
      ? await openV4UsdgInRange(v4pool, pending.ethAmt)
      : inR
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

async function onMintV2(mid: number): Promise<void> {
  if (!pending?.chosen?.v2 || !pending.ethAmt) return;
  await edit(mid, `⏳ <b>LP v2 ${pending.ethAmt} ETH…</b> (wrap → swap ~50% → add liquidity)`);
  try {
    const { openV2 } = await import("../chain/v2/mint.js");
    const r = await openV2(pending.token, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}</b> [v2] 🎯 full-range LP`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ~50% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>0.30%</b> · deposit ${r.depositEth}Ξ`,
        `add-LP: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `pair <code>${r.pair}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v2 LP gagal: ${short(e, 160)}`);
  }
}

// ══════════ /list ══════════

// cache the assembled /list payload so re-opening or spamming isn't a fresh multi-second on-chain
// scan each time. Refresh (force) bypasses it; any close/mint invalidates it.
let listCache: { head: string; body: string; btns: object[]; at: number } | null = null;
export function invalidateListCache(): void {
  listCache = null;
}
const LIST_TTL_MS = 20_000;

export async function onList(mid: number | null = null, force = false): Promise<void> {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    const c = listCache;
    const km = { reply_markup: { inline_keyboard: c.btns } };
    await (mid ? edit(mid, c.head + "\n" + c.body, km) : send(c.head + "\n" + c.body, km));
    return;
  }
  if (!mid) {
    const m = await send("⏳ Memuat posisi…");
    mid = m?.result?.message_id ?? null;
  }
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listV4Positions } = await import("../chain/v4/list.js");
  const { listV2Positions } = await import("../chain/v2/list.js");
  // v2 + v3 + v4 in parallel (was sequential → slow "Memuat posisi…")
  const [rowsRes, v4rows, v2rows] = await Promise.all([
    listPositions().then((r) => ({ ok: true as const, r })).catch((e) => ({ ok: false as const, e })),
    listV4Positions().catch(() => []),
    listV2Positions().catch(() => []),
  ]);
  if (!rowsRes.ok) {
    await out(`❌ ${short(rowsRes.e, 80)}`);
    return;
  }
  const rows = rowsRes.r;
  const refreshBtn = [{ text: "🔄 Refresh", callback_data: "refresh" }];
  if (!rows.length && !v4rows.length && !v2rows.length) {
    await out("Tidak ada posisi LP terbuka (v2/v3/v4).", { reply_markup: { inline_keyboard: [refreshBtn] } });
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
    T.push(`${tokenEmoji(r.tokenSym)} ${r.tokenSym}/WETH  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
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

  const dupe: Record<string, number> = {};
  rows.forEach((r) => (dupe[r.tokenSym] = (dupe[r.tokenSym] || 0) + 1));
  const btns: object[] = [refreshBtn];
  rows.forEach((r) => {
    const p =
      r.pnlEth != null
        ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)} · ${sg(r.pnlPct ?? 0, 1)}%`
        : "";
    const id = dupe[r.tokenSym]! > 1 ? ` #${r.tokenId}` : "";
    btns.push([{ text: `Close ${r.tokenSym}${id}${p}`, callback_data: `close:${r.tokenId}` }]);
  });
  if (rows.length > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${rows.length} posisi)`, callback_data: "closeall" }]);

  // ── v4 positions block ──
  const T4: string[] = [];
  if (v4rows.length) {
    T4.push(`🦄 UNISWAP v4 · ${v4rows.length} posisi`);
    T4.push("─".repeat(37));
    v4rows.forEach((r, i) => {
      const vEth = px ? r.valueUsd / px : 0;
      const fEth = px ? r.feeUsd / px : 0;
      totEth += vEth;
      totFee += fEth;
      if (r.depEth != null) {
        totDep += r.depEth;
        totPnl += vEth - r.depEth;
      }
      if (i) T4.push("");
      T4.push(`${tokenEmoji(r.sym)} ${r.pair}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
      T4.push(`   ${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.ethPaired ? "" : " · non-ETH pair"}`);
      T4.push(`   ${padR("nilai", 7)} $${r.valueUsd.toFixed(2)}`);
      T4.push(`   ${padR("isi", 7)} ${r.amount0} ${r.sym0} + ${r.amount1} ${r.sym1}`);
      T4.push(`   ${padR("fee", 7)} $${r.feeUsd.toFixed(2)} earned`);
      if (r.depEth != null) T4.push(`   ${padR("modal", 7)} ${r.depEth.toFixed(6)}Ξ (${usd(r.depEth)})`);
      T4.push(`   ${padR("umur", 7)} ${fmtAge(r.ageMs)}`);
    });
    const dupe4: Record<string, number> = {};
    v4rows.forEach((r) => (dupe4[r.sym] = (dupe4[r.sym] || 0) + 1));
    for (const r of v4rows) {
      const idTag = dupe4[r.sym]! > 1 ? ` #${r.tokenId}` : "";
      const row: object[] = [];
      // only offer Claim when there's fee worth claiming
      if (r.feeUsd > 0.01) row.push({ text: `💰 Claim`, callback_data: `v4f:${r.tokenId}` });
      row.push({ text: `Close ${r.sym}${idTag}`, callback_data: `v4c:${r.tokenId}` });
      btns.push(row);
    }
  }

  // ── v2 positions block ──
  const T2: string[] = [];
  if (v2rows.length) {
    T2.push(`💧 UNISWAP v2 · ${v2rows.length} posisi · fee 0.30%`);
    T2.push("─".repeat(37));
    v2rows.forEach((r, i) => {
      totEth += r.valueEth || 0;
      if (r.depEth != null) totDep += r.depEth;
      if (r.pnlEth != null) totPnl += r.pnlEth;
      if (i) T2.push("");
      T2.push(`${tokenEmoji(r.sym)} ${r.sym}/WETH  ·  ${r.sharePct.toFixed(3)}% pool`);
      T2.push(`   ${padR("nilai", 7)} ${padL(r.valueEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.valueEth), 9)}`);
      T2.push(`   ${padR("isi", 7)} ${r.amountToken} ${r.sym} + ${r.amountWeth} WETH`);
      if (r.depEth != null) T2.push(`   ${padR("modal", 7)} ${padL(r.depEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(r.depEth), 9)}`);
      if (r.pnlEth != null)
        T2.push(`   ${padR("PnL", 7)} ${padL(sg(r.pnlEth, 6) + "Ξ", 11)}  ${padL((r.pnlEth >= 0 ? "+" : "-") + "$" + Math.abs(r.pnlEth * px).toFixed(2), 9)}  ${sg(r.pnlPct ?? 0, 1)}%`);
      if (r.ageMs != null) T2.push(`   ${padR("umur", 7)} ${fmtAge(r.ageMs)}`);
    });
    for (const r of v2rows) {
      const p = r.pnlEth != null ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"}${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)}` : "";
      btns.push([{ text: `Close ${r.sym}${p}`, callback_data: `v2c:${r.pair}` }]);
    }
  }

  // ── unified TOTAL (v3 + v4 + v2), always LAST ──
  const totalCount = rows.length + v4rows.length + v2rows.length;
  const S: string[] = [];
  if (totalCount > 1) {
    S.push(`TOTAL ${totalCount} posisi  ·  v3 ${rows.length} · v4 ${v4rows.length} · v2 ${v2rows.length}`);
    S.push("─".repeat(37));
    S.push(`${padR("modal", 7)} ${padL(totDep.toFixed(6) + "Ξ", 11)}  ${padL(usd(totDep), 9)}`);
    S.push(`${padR("nilai", 7)} ${padL(totEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(totEth), 9)}`);
    S.push(`${padR("fee", 7)} ${padL(totFee.toFixed(6) + "Ξ", 11)}  ${padL(usd(totFee), 9)}`);
    S.push(`${padR("PnL", 7)} ${padL(sg(totPnl, 6) + "Ξ", 11)}  ${padL((totPnl >= 0 ? "+" : "-") + "$" + Math.abs(totPnl * px).toFixed(2), 9)}`);
  }

  const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const head = `📋 <b>Posisi LP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${jam}</i>`;
  const body =
    (rows.length ? pre(T.join("\n")) : "") +
    (T4.length ? pre(T4.join("\n")) : "") +
    (T2.length ? pre(T2.join("\n")) : "") +
    (S.length ? pre(S.join("\n")) : "");
  listCache = { head, body, btns, at: Date.now() };
  await out(head + "\n" + body, { reply_markup: { inline_keyboard: btns } });
}

// ══════════ /ledger ══════════

const LEDGER_PER_PAGE = 5;
// cache the slow on-chain v4 "closed positions" scan so paginating (Next/Back) is instant
let ledgerHistCache: { v4hist: Awaited<ReturnType<typeof import("../chain/v4/list.js")["listClosedV4Positions"]>>; at: number } | null = null;
export async function onLedger(page = 0, mid: number | null = null): Promise<void> {
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listClosedV4Positions } = await import("../chain/v4/list.js");
  const allEntries = readLedger(); // unified: v3 + v4 + v2 (forward-tracked closes) — cheap (file)
  const entryIds = new Set(allEntries.map((e) => e.tokenId));
  // v4 historical scan (on-chain, per-NFT → slow) is CACHED so Next/Back doesn't refetch each page
  let v4hist: Awaited<ReturnType<typeof listClosedV4Positions>>;
  if (ledgerHistCache && Date.now() - ledgerHistCache.at < 45_000) {
    v4hist = ledgerHistCache.v4hist.filter((c) => !entryIds.has(c.tokenId));
  } else {
    const v4closedRaw = await listClosedV4Positions().catch(() => [] as Awaited<ReturnType<typeof listClosedV4Positions>>);
    ledgerHistCache = { v4hist: v4closedRaw, at: Date.now() };
    v4hist = v4closedRaw.filter((c) => !entryIds.has(c.tokenId));
  }
  const sum = ledgerSummary();

  if (!allEntries.length && !v4hist.length) {
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

  // unified closed list, RECENT FIRST (v3 + v4 + v2 entries interleaved by close time;
  // v4 positions closed before tracking shown last with PnL unavailable)
  type LedRow = { e?: (typeof allEntries)[number]; v4h?: (typeof v4hist)[number]; ts: number };
  const combined: LedRow[] = [
    ...allEntries.map((e) => ({ e, ts: e.closedAt ?? 0 })),
    ...v4hist.map((c) => ({ v4h: c, ts: c.closedAt ?? 0 })),
  ].sort((a, b) => b.ts - a.ts);
  const pages = Math.max(1, Math.ceil(combined.length / LEDGER_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = combined.slice(page * LEDGER_PER_PAGE, page * LEDGER_PER_PAGE + LEDGER_PER_PAGE);
  const px = await ethUsd().catch(() => 0);
  const when = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";
  const verTag = (v?: string) => (v === "v4" ? "v4 🦄" : v === "v2" ? "v2 💧" : "v3");

  const T: string[] = [];
  slice.forEach((row, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    if (row.e) {
      const e = row.e;
      const name = e.pair ?? `${e.sym}/WETH`; // v3 has no pair field → it's always token/WETH
      const win = e.pnlEth == null ? "⬜" : e.pnlEth >= 0 ? "🟩" : "🟥";
      T.push(`${win} ${tokenEmoji(e.sym)} ${name} · ${verTag(e.version)}${e.mode === "inrange" ? " 🎯" : ""}   ${n}/${combined.length}`);
      T.push(`   ${when(e.closedAt)} · hold ${fmtAge(e.heldMs)}`);
      if (e.quote === "usd") {
        // USDG-paired pools → show USD (natural unit); ETH shown as secondary
        const at = e.ethUsdAtClose || px || 0;
        const $ = (eth: number) => "$" + (eth * at).toFixed(2);
        T.push(`   modal ${$(e.depEth ?? 0)} → balik ${$(e.outEth ?? 0)}`);
        if (e.pnlEth != null) T.push(`   PnL ${e.pnlUsd != null ? money(e.pnlUsd) : $(e.pnlEth)}  (${sg(e.pnlEth, 5)}Ξ)  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      } else {
        T.push(`   modal ${(e.depEth ?? 0).toFixed(5)}Ξ → balik ${(e.outEth ?? 0).toFixed(5)}Ξ`);
        if (e.pnlEth != null) T.push(`   PnL ${sg(e.pnlEth, 5)}Ξ  ${e.pnlUsd != null ? money(e.pnlUsd) : "—"}  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      }
      if ((e.unsoldEth ?? 0) > 0) T.push(`   🪙 nyangkut ~${(e.unsoldEth ?? 0).toFixed(5)}Ξ (blm dijual)`);
    } else if (row.v4h) {
      const c = row.v4h;
      T.push(`⬜ ${tokenEmoji(c.pair)} ${c.pair} · v4 🦄   ${n}/${combined.length}`);
      T.push(`   ${when(c.closedAt)} · #${c.tokenId} · fee ${(c.fee / 10000).toFixed(2)}%`);
      T.push(`   PnL — (histori sblm tracking${c.depEth != null ? `, modal ${c.depEth.toFixed(5)}Ξ` : ""})`);
    }
  });

  const nV3 = allEntries.filter((e) => (e.version ?? "v3") === "v3").length;
  const nV4 = allEntries.filter((e) => e.version === "v4").length + v4hist.length;
  const nV2 = allEntries.filter((e) => e.version === "v2").length;
  const net = sum.pnlEth + sum.unsoldEth;
  const S: string[] = [];
  S.push(`${combined.length} DITUTUP · ${nV3} v3 · ${nV4} v4${nV2 ? ` · ${nV2} v2` : ""}`);
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
  const foot = v4hist.length
    ? `<i>Stats gabung v3+v4+v2. ${v4hist.length} posisi v4 LAMA blm direkonstruksi — tap 🔄 Rebuild.</i>`
    : "";
  // 📸 card button per closed position on this page (positions with recorded PnL)
  const cardBtns: object[] = [];
  slice.forEach((row) => {
    if (row.e && row.e.pnlEth != null) {
      const e = row.e;
      const p = e.pnlEth! >= 0 ? "🟩" : "🟥";
      cardBtns.push([{ text: `📸 ${tokenEmoji(e.sym)} ${e.pair ?? `${e.sym}/WETH`} ${p}`, callback_data: `cardp:${e.tokenId}` }]);
    }
  });
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")) + foot, {
    reply_markup: {
      inline_keyboard: [
        nav,
        ...cardBtns,
        [{ text: "📸 Kartu portfolio", callback_data: "card" }, { text: "🔄 Rebuild on-chain", callback_data: "lgrb" }],
      ],
    },
  });
}

export async function onLedgerRebuild(mid: number): Promise<void> {
  ledgerHistCache = null; // force a fresh on-chain scan
  try {
    const prog = (msg: string) => void edit(mid, `⏳ <b>Rebuild ledger dari on-chain</b>\n<i>${esc(msg)}</i>`).catch(() => {});
    const r = await backfillLedger(prog);
    // v4 positions closed before tracking → reconstruct realized PnL from archive (historical price)
    const { backfillLedgerV4 } = await import("../chain/v4/backfill.js");
    const r4 = await backfillLedgerV4(prog).catch(() => ({ rebuilt: 0 }));
    await edit(mid, `✅ Rebuild selesai — v3: ${r.rebuilt} · v4: ${r4.rebuilt} direkonstruksi dari on-chain.`);
    await onLedger(0);
  } catch (e) {
    await edit(mid, `❌ Rebuild gagal: ${short(e, 100)}`);
  }
}

// ══════════ /scan (manual) ══════════

// ══════════ /screen (GMGN 24h thesis screen) ══════════

export async function onScreen(arg?: string): Promise<void> {
  const useLlm = arg !== "fast" && !!env.openrouterKey;
  const m = await send(`🧪 <b>Screening GMGN 24h…</b> <i>(mcap&gt;$500k · vol&gt;$1M · no flap${useLlm ? " · +thesis LLM" : ""})</i>`);
  const mid = m?.result?.message_id;
  try {
    const { screenTokens } = await import("../radar/screen.js");
    const { results, scanned, excludedFlap, excludedUnsafe } = await screenTokens({ llm: useLlm });
    if (!scanned) {
      await edit(mid, "🧪 GMGN nggak balikin data trending (CLI belum aktif / rate-limit). Coba lagi.");
      return;
    }
    if (!results.length) {
      await edit(mid, `🧪 Nggak ada token lolos filter.\n<i>scan ${scanned} · buang ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`);
      return;
    }
    const kindTag = (k: string) => (k === "util" ? "🛠 util" : k === "meme" ? "🐸 meme" : "❓ unclear");
    const commTag = (c: string) => (c === "clear" ? "🟢 komun jelas" : c === "thin" ? "🟡 komun tipis" : "🔴 komun sus");
    const T: string[] = [];
    results.forEach((r, i) => {
      const t = r.token;
      if (i) T.push("");
      T.push(`${i + 1}. ${tokenEmoji(t.symbol)} ${t.symbol}  ·  ${kindTag(r.kind)}  ·  skor ${r.score}${r.verdict ? " · " + r.verdict.toUpperCase() : ""}`);
      T.push(`   ${commTag(r.community)} · FOMO ${r.fomo}`);
      T.push(`   mcap ${fmtMcap(t.marketCap)} · vol ${fmtMcap(t.volume)} · liq ${fmtMcap(t.liquidity)}`);
      const turn = t.liquidity > 0 ? (t.volume / t.liquidity).toFixed(0) + "×" : "?";
      T.push(`   turn ${turn} · 24h ${sg(t.change24hPct, 0)}% · smart ${t.smartWallets} · KOL ${t.kolWallets} · hold ${t.holders}`);
      if (r.thesis) T.push(`   💡 ${r.thesis}`);
      if (r.flags.length) T.push(`   🚩 ${r.flags.join(" · ")}`);
    });
    const head = `🧪 <b>Screen GMGN 24h</b> — ${results.length} kandidat\n<i>scan ${scanned} · buang ${excludedFlap} flap · ${excludedUnsafe} unsafe</i>`;
    // LP shortcut buttons for the top 6
    const btns = results.slice(0, 6).map((r) => [
      { text: `${tokenEmoji(r.token.symbol)} LP ${r.token.symbol} (${r.score})`, callback_data: `ca:${r.token.address}` },
    ]);
    btns.push([{ text: "🔄 Refresh", callback_data: "screen" }]);
    await edit(mid, head + "\n" + pre(T.join("\n")), { reply_markup: { inline_keyboard: btns } });
  } catch (e) {
    await edit(mid, `❌ Screen gagal: ${short(e, 120)}`);
  }
}

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
  invalidateListCache();
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
        `✅ <b>v4 #${tokenId} closed</b> · pool fee ${(r.fee / 10000).toFixed(2)}%`,
        `Balik: ${r.recv0 > 0 ? `${r.recv0.toFixed(6)} ${r.sym0}` : ""}${r.recv0 > 0 && r.recv1 > 0 ? " + " : ""}${r.recv1 > 0 ? `${r.recv1.toFixed(6)} ${r.sym1}` : ""}`,
        r.feeEth > 0 ? `🧲 fee earned: <b>${r.feeEth.toFixed(6)}Ξ</b>` : "",
        r.forfeited ? `⚠️ <b>${esc(r.forfeited)}</b> nggak bisa ditarik (honeypot/rug) — direlakan, ETH diselamatkan.` : "",
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const v4quote = /usdg|usd/i.test(r.pair) && !/\beth\b|weth/i.test(r.pair) ? ("usd" as const) : ("eth" as const);
    await sendCloseCard({ name: r.pair, version: "v4", quote: v4quote, depEth: r.depEth, outEth: r.outEth, feeEth: r.feeEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct });
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

export async function onV2Close(pair: string): Promise<void> {
  invalidateListCache();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
    await send("Format: <code>/v2close &lt;pairAddress&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v2 ${pair.slice(0, 10)}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV2Position } = await import("../chain/v2/close.js");
    const r = await closeV2Position(pair);
    await edit(
      mid,
      [
        `✅ <b>v2 ${esc(r.sym)}/WETH closed</b>`,
        `Balik: <b>${r.recvEth.toFixed(6)} ETH</b>${r.soldToken ? " (token dijual balik)" : r.recvToken > 0 ? ` + ${r.recvToken.toPrecision(6)} ${esc(r.sym)}` : ""}`,
        r.pnlEth != null ? `PnL: ${r.pnlEth >= 0 ? "🟩 +" : "🟥 "}${r.pnlEth.toFixed(6)}Ξ` : "",
        `burn: <a href="${explorerTx(r.txHash)}">tx</a>${r.swapHash ? ` · sell: <a href="${explorerTx(r.swapHash)}">tx</a>` : ""}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await sendCloseCard({ name: `${r.sym}/WETH`, version: "v2", depEth: r.depEth, outEth: r.recvEth, pnlEth: r.pnlEth });
  } catch (e) {
    await edit(mid, `❌ v2 close gagal: ${short(e, 160)}`);
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
  invalidateListCache();
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
    await sendCloseCard({ name: `${r.tokenSym}/WETH`, version: "v3", depEth: r.depEth, outEth: r.valEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct, heldMs: r.heldMs });
  } catch (e) {
    await send(`❌ Close gagal: ${short(e, 120)}`);
  }
}

export async function onCloseAll(): Promise<void> {
  invalidateListCache();
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
  if (ok > 0) await onCard(); // flex the portfolio result
}

// ══════════ 🔄 swap (KyberSwap aggregator) ══════════

let pendingSwap: { fromAddr: string; toAddr: string; amountIn: bigint; fromSym: string; toSym: string; toDec: number } | null = null;

export async function onSwap(text: string): Promise<void> {
  const { kyberEnabled, kyberRoute, routeBreakdown, KYBER_NATIVE } = await import("../chain/kyber.js");
  if (!kyberEnabled()) {
    await send("🔄 Swap butuh KyberSwap — <code>KYBERSWAP_ROUTER_ADDRESS</code> belum diset di .env.");
    return;
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) {
    await sendMenu(
      [
        "🔄 <b>Swap via KyberSwap</b> (rute terbaik otomatis)",
        "Format: <code>/swap &lt;jumlah&gt; &lt;dari&gt; &lt;ke&gt;</code>",
        "",
        "• <code>/swap 0.01 eth 0xCA</code> — ETH → token",
        "• <code>/swap 100 0xCA eth</code> — token → ETH",
        "• <code>/swap 50 0xTokenA 0xTokenB</code> — token → token",
        "",
        "<i>dari/ke: ketik <b>eth</b> atau alamat kontrak (0x… 40 hex)</i>",
      ].join("\n"),
    );
    return;
  }
  const [, amtStr, fromS, toS] = parts as [string, string, string, string];
  const resolve = (s: string) => (/^eth$/i.test(s) ? KYBER_NATIVE : /^0x[0-9a-fA-F]{40}$/.test(s) ? ethers.getAddress(s) : null);
  const fromAddr = resolve(fromS);
  const toAddr = resolve(toS);
  if (!fromAddr || !toAddr) {
    await send("Dari/ke harus <b>eth</b> atau alamat kontrak (0x… 40 hex).");
    return;
  }
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
    await send("Dari & ke sama — nggak ada yang di-swap.");
    return;
  }
  if (!(parseFloat(amtStr) > 0)) {
    await send("Jumlah nggak valid, contoh: <code>0.01</code>");
    return;
  }
  const nativeIn = fromAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const nativeOut = toAddr.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const fromMeta = nativeIn ? { decimals: 18, symbol: "ETH" } : await tokenMeta(fromAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  const toMeta = nativeOut ? { decimals: 18, symbol: "ETH" } : await tokenMeta(toAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  let amountIn: bigint;
  try {
    amountIn = ethers.parseUnits(amtStr, fromMeta.decimals);
  } catch {
    await send("Format jumlah salah.");
    return;
  }

  const m = await send("🔄 Cari rute Kyber…");
  const mid = m?.result?.message_id;
  const route = await kyberRoute(fromAddr, toAddr, amountIn).catch(() => null);
  if (!route) {
    await edit(mid, "❌ Kyber nggak nemu rute buat pair ini (likuiditas kering?).");
    return;
  }
  const outRaw = BigInt(route.routeSummary.amountOut);
  const outUi = Number(ethers.formatUnits(outRaw, toMeta.decimals));
  const usd = route.routeSummary.amountOutUsd ? ` <i>($${Number(route.routeSummary.amountOutUsd).toFixed(2)})</i>` : "";
  pendingSwap = { fromAddr, toAddr, amountIn, fromSym: fromMeta.symbol, toSym: toMeta.symbol, toDec: toMeta.decimals };
  await edit(
    mid,
    [
      `🔄 <b>Swap ${esc(amtStr)} ${esc(fromMeta.symbol)} → ~${outUi.toPrecision(6)} ${esc(toMeta.symbol)}</b>${usd}`,
      `rute: <i>${esc(routeBreakdown(route.routeSummary) || "kyber")}</i> · slippage ${cfg.lp.slippagePct}%`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

export async function onSwapDo(mid: number): Promise<void> {
  if (!pendingSwap) return;
  const s = pendingSwap;
  pendingSwap = null;
  await edit(mid, `⏳ Swap ${esc(s.fromSym)} → ${esc(s.toSym)}…`);
  try {
    const { kyberSwap } = await import("../chain/kyber.js");
    const r = await kyberSwap(s.fromAddr, s.toAddr, s.amountIn);
    if (!r || r.amountOut <= 0n) {
      await edit(mid, "❌ Swap gagal / output 0.");
      return;
    }
    await edit(
      mid,
      `✅ <b>Swap sukses</b> → +${Number(ethers.formatUnits(r.amountOut, s.toDec)).toPrecision(6)} ${esc(s.toSym)}\ntx: <a href="${explorerTx(r.tx)}">tx</a>`,
    );
  } catch (e) {
    await edit(mid, `❌ Swap gagal: ${short(e, 150)}`);
  }
}

// ══════════ 📸 profit card ══════════

/** Generate + send the whole-portfolio profit card (Meteora-style flex graphic). */
export async function onCard(): Promise<void> {
  const m = await send("📸 Bikin kartu profit…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "📊 <b>Profit Robinhood LP Bot</b> — share it 🚀");
    if (mid) await edit(mid, "📸 Kartu profit ↑");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(e, 100)}`);
  }
}

/** Save a photo the owner sent as the profit-card background (assets/card-bg.jpg). */
export async function onSetBg(fileId: string): Promise<void> {
  const m = await send("🖼 Nyimpen background kartu…");
  const mid = m?.result?.message_id;
  try {
    const buf = await downloadTgFile(fileId);
    if (!buf) {
      if (mid) await edit(mid, "❌ Gagal ambil gambar dari Telegram.");
      return;
    }
    mkdirSync("assets", { recursive: true });
    writeFileSync("assets/card-bg.jpg", buf);
    if (mid) await edit(mid, "✅ Background kartu di-set. Ini preview-nya 👇");
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "🎴 Background baru kepasang — <b>/card</b> kapan aja buat share.");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal set background: ${short(e, 100)}`);
  }
}

/** Print a profit card for an ALREADY-closed position (from a ledger entry, by tokenId). */
export async function onCardFor(tokenId: string): Promise<void> {
  const e = readLedger().find((x) => x.tokenId === tokenId);
  if (!e) {
    await send("❌ Posisi nggak ketemu di ledger.");
    return;
  }
  const m = await send("📸 Bikin kartu posisi…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(
      await closeCardData({
        name: e.pair ?? `${e.sym}/WETH`,
        version: (e.version ?? "v3") as "v2" | "v3" | "v4",
        quote: e.quote,
        depEth: e.depEth ?? null,
        outEth: e.outEth ?? 0,
        pnlEth: e.pnlEth,
        pnlPct: e.pnlPct,
        feeEth: e.feeEth,
        heldMs: e.heldMs,
        ethUsd: e.ethUsdAtClose ?? undefined,
      }),
    );
    await sendPhoto(png, `🎴 <b>${esc(e.pair ?? `${e.sym}/WETH`)}</b> — share it 🚀`);
    if (mid) await edit(mid, "📸 Kartu ↑");
  } catch (err) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(err, 100)}`);
  }
}

/** Fire-and-forget a per-close card (never blocks / breaks the close flow). */
async function sendCloseCard(p: {
  name: string;
  version: "v2" | "v3" | "v4";
  quote?: "eth" | "usd";
  depEth: number | null;
  outEth: number;
  pnlEth: number | null;
  pnlPct?: number | null;
  feeEth?: number;
  heldMs?: number | null;
}): Promise<void> {
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(await closeCardData(p));
    await sendPhoto(png);
  } catch {
    /* card is a nice-to-have — never let it break a close */
  }
}

export async function onPnl(): Promise<void> {
  await send("📊 Menghitung PnL seumur hidup… (scan history + rug, ±20 detik)");
  let r;
  try {
    r = await lifetimePnl();
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
    return;
  }
  const px = r.px;
  const $ = (e: number) => (px ? "$" + (e * px).toFixed(2) : "?");
  // ACCURATE LP number from the ledger (closed positions). The wallet capital-flow below is
  // wallet-level and — because this wallet is shared with the arb bot — mixes in non-LP flows.
  const sum = ledgerSummary();
  const row = (lbl: string, eth: string, usd = "") => `${padR(lbl, 8)}${padL(eth, 12)}${usd ? "  " + padL(usd, 9) : ""}`;

  const T: string[] = [];
  T.push(`LP REALIZED · ${sum.count} ditutup`);
  T.push("─".repeat(31));
  T.push(row("PnL", sg(sum.pnlEth, 5) + "Ξ", money(sum.pnlUsd)));
  T.push(row("menang", `${sum.winRate.toFixed(0)}% (${sum.wins}/${sum.losses})`));
  T.push(row("fee", sum.feeEth.toFixed(5) + "Ξ"));
  T.push("");
  T.push(`ARUS WALLET (+arb)`);
  T.push("─".repeat(31));
  T.push(row("setor", r.capIn.toFixed(5) + "Ξ", $(r.capIn)));
  T.push(row("tarik", r.capOut.toFixed(5) + "Ξ", $(r.capOut)));
  T.push(row("nilai", r.valueNowEth.toFixed(5) + "Ξ", $(r.valueNowEth)));
  T.push(`  native ${r.nativeEth.toFixed(4)}  WETH ${r.wethHeld.toFixed(4)}`);
  T.push(`  LP ${r.openLpEth.toFixed(4)}Ξ  token $${r.tokensUsd.toFixed(2)}`);
  T.push(row("net", sg(r.pnlEth, 5) + "Ξ", money(r.pnlUsd)));

  const grave = r.graveyardCount
    ? `\n🪦 <b>${r.graveyardCount} token nyangkut</b> <i>(rug/likuiditas kering)</i>\n${pre(r.graveyard.join(", ") + (r.graveyardCount > r.graveyard.length ? " …" : ""))}`
    : "";
  await sendMenu(
    `📊 <b>PnL SEUMUR HIDUP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}\n` +
      pre(T.join("\n")) +
      `<i>⚠️ Net wallet nyampur flow arb — angka LP akurat = "LP realized".</i>` +
      grave,
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
    `🤖 <b>Robinhood LP Bot</b>  <i>v2 · Uniswap v2+v3+v4</i>`,
    `Paste <b>CA token</b> (0x…) → pilih pool (v2/v3/v4) → jumlah ETH → LP.`,
    ``,
    `<b>━━━ 📊 POSISI ━━━</b>`,
    `📋 /list — posisi terbuka + PnL + close`,
    `📒 /ledger — riwayat ditutup (realized)`,
    `💰 /pnl — PnL seumur hidup`,
    `📸 /card — kartu profit shareable`,
    ``,
    `<b>━━━ 🎯 RADAR & AUTO ━━━</b>`,
    `🧪 /screen — screening GMGN 24h (mcap&gt;500k, vol&gt;1M, no flap, util&gt;meme)`,
    `📡 /feed — monitor sequencer real-time`,
    `👁 /watch — scanner volume nanjak`,
    `🔍 /scan — cek volume sekarang`,
    `🤖 /auto — auto-LP (radar → buka sendiri)`,
    `🦄 /v4 <code>&lt;ca&gt;</code> — cek pool v4 fee-tinggi`,
    ``,
    `<b>━━━ ⚡ AKSI ━━━</b>`,
    `🔄 /swap <code>&lt;jml&gt; &lt;dari&gt; &lt;ke&gt;</code> — swap via Kyber`,
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
  pendingSwap = null;
};

function short(e: unknown, n: number): string {
  return String((e as Error)?.message ?? e).slice(0, n);
}
