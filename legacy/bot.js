/**
 * bot.js — Robinhood LP Bot: paste CA di Telegram → auto open posisi LP.
 *
 * Alur (persis screenshot referensi):
 *   paste 0x… → cari pool → tombol pilih pool → konfirmasi → mint → laporan tx.
 *   /list → posisi terbuka + tombol close · /wallet · /settings · /help
 *
 * Long-poll getUpdates (zero framework). Token & key dari .env.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import * as CH from "./chain.js";
import * as W from "./watch.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.join(DIR, "config.json");
const cfg = CH.cfg;
const TOKEN = process.env.RH_TG_TOKEN || "";
let chatId = process.env.RH_TG_CHAT || cfg.telegramChatId || "";
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const api = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(35_000),
}).then((r) => r.json()).catch(() => null);
const send = (t, extra = {}) => api("sendMessage", { chat_id: chatId, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const edit = (mid, t, extra = {}) => api("editMessageText", { chat_id: chatId, message_id: mid, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
// Nulis config: MERGE sama isi disk, jangan timpa mentah-mentah.
// (Dulu bug: cfg di memori itu snapshot saat start; kalau file diedit pas bot jalan,
//  saveCfg bakal ngehapus key baru itu diam-diam.)
const saveCfg = () => {
  cfg.telegramChatId = chatId;
  let disk = {}; try { disk = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { /* baru */ }
  const merged = { ...disk, ...cfg, lp: { ...(disk.lp || {}), ...(cfg.lp || {}) }, contracts: { ...(disk.contracts || {}), ...(cfg.contracts || {}) } };
  fs.writeFileSync(CFG, JSON.stringify(merged, null, 2));
};

const pending = new Map(); // chat → { token, pools }
const exp = (n) => cfg.explorer + "/tx/" + n;

async function onCA(addr) {
  await send(`🔎 <b>Cari pool</b> di Robinhood Chain\n<code>${addr}</code>`);
  let meta, pools;
  try { meta = await CH.tokenMeta(addr); pools = await CH.findPools(addr); }
  catch (e) { return send(`❌ Gagal baca token/pool: ${String(e.message).slice(0, 80)}`); }
  if (!pools.length) return send(`⚠️ Tidak ada pool ${meta.symbol}/WETH yang punya likuiditas. Belum bisa LP.`);
  pending.set(chatId, { token: addr, meta, pools });
  const rows = pools.map((p, i) => [{ text: `${i + 1}. fee ${(p.fee / 10000).toFixed(2)}% · WETH ${p.wethInPool.toFixed(3)}`, callback_data: `pool:${i}` }]);
  await send(`Ketemu <b>${pools.length}</b> pool ${meta.symbol}/WETH. Pilih:`, { reply_markup: { inline_keyboard: rows } });
}

const GAS_RESERVE = 0.0004; // ETH native disisain buat gas (~4-5 tx; gas Robinhood ~0.0001/tx)

// Usable = WETH (udah wrap) + ETH native yang bisa di-wrap (dikurang cadangan gas)
function usableEth(b) {
  return Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);
}

// Pilih pool → TANYA jumlah ETH (user ketik sendiri)
async function onPick(idx, mid) {
  const st = pending.get(chatId);
  if (!st) return;
  const p = st.pools[idx];
  st.chosen = p;
  st.awaitingAmount = true;
  const b = await CH.balances().catch(() => null);
  await edit(mid, [
    `<b>${st.meta.symbol}</b> · fee ${(p.fee / 10000).toFixed(2)}% dipilih.`,
    b ? `Saldo bisa di-LP: <b>${usableEth(b).toFixed(5)} ETH</b>  <i>(WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)})</i>` : "",
    ``,
    `💬 <b>Ketik jumlah ETH</b> yang mau di-LP (contoh: <code>0.005</code>)`,
  ].filter(Boolean).join("\n"));
}

// User ngetik angka → tampilkan konfirmasi
async function onAmount(text) {
  const st = pending.get(chatId);
  if (!st?.awaitingAmount || !st.chosen) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) return send("Masukin angka ETH yang bener, contoh: 0.005");
  const b = await CH.balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) return send(`⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH (WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)}, sisain gas). Ketik lebih kecil.`);
  if (b && Number(b.eth) < GAS_RESERVE) return send(`⚠️ ETH native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (butuh min ${GAS_RESERVE}). Isi sedikit ETH native, ATAU unwrap dikit WETH → ETH.`);
  st.ethAmt = String(eth);
  st.awaitingAmount = false;
  const [pS, pI] = await Promise.all([
    CH.previewRange(st.token, st.chosen.pool, "single").catch(() => null),
    CH.previewRange(st.token, st.chosen.pool, "inrange").catch(() => null),
  ]);
  const rng = (p) => p ? `${CH.fmtMcap(p.rangeMcapLow)} → ${CH.fmtMcap(p.rangeMcapHigh)}` : "?";
  await send([
    `<b>Konfirmasi mint · Robinhood v3</b>`,
    `${st.meta.symbol} · fee ${(st.chosen.fee / 10000).toFixed(2)}% · deposit <b>${eth} ETH</b> · width ${cfg.lp.widthPct}%`,
    pS ? `📊 MCAP now: <b>${CH.fmtMcap(pS.mcapNow)}</b>` : "",
    ``,
    `🛡 <b>Single-side ETH</b> — range ${rng(pS)}`,
    `   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.`,
    ``,
    `🎯 <b>In-range</b> — range ${rng(pI)}`,
    `   swap ~<b>${pI?.swapPct ?? "?"}%</b> modal → ${st.meta.symbol} duluan. Fee LANGSUNG jalan,`,
    `   tapi lu langsung pegang token (rug = rugi ${pI?.swapPct ?? "?"}% instan).`,
  ].filter(Boolean).join("\n"), { reply_markup: { inline_keyboard: [
    [{ text: `🎯 In-range (swap ~${pI?.swapPct ?? "?"}%)`, callback_data: "mint:inrange" }],
    [{ text: "🛡 Single-side ETH", callback_data: "mint:single" }],
    [{ text: "❌ Cancel", callback_data: "cancel" }],
  ] } });
}

async function onMint(mid, mode = "single") {
  const st = pending.get(chatId);
  if (!st?.chosen || !st.ethAmt) return;
  const inR = mode === "inrange";
  await edit(mid, `⏳ <b>Minting ${st.ethAmt} ETH…</b> ${inR ? "(wrap → swap → approve → mint)" : "(wrap → approve → mint)"}`);
  try {
    const r = await CH.openPosition(st.token, st.chosen.pool, st.ethAmt, { mode });
    pending.delete(chatId);
    await send([
      `✅ <b>${st.meta.symbol} #${r.tokenId ?? "?"}</b> [v3] ${inR ? "🎯 IN-RANGE" : "🛡 single-side"}`,
      r.wrapHash ? `wrap: <a href="${exp(r.wrapHash)}">tx</a>` : "",
      r.swapHash ? `swap ${r.swappedPct}% → ${st.meta.symbol}: <a href="${exp(r.swapHash)}">tx</a>` : "",
      `range tick ${r.tickLower}..${r.tickUpper}`,
      `📊 entry MCAP ${CH.fmtMcap(r.entryMcap)} · ${r.side}`,
      `deposit ~${Number(r.depositEth).toFixed(5)}Ξ`,
      `mint: <a href="${exp(r.txHash)}">tx</a>`,
    ].filter(Boolean).join("\n"));
  } catch (e) {
    await send(`❌ Mint gagal: ${String(e.message).slice(0, 160)}`);
  }
}

/**
 * Emoji per token. Telegram cuma bolehin teks+emoji di tombol (nggak bisa logo asli),
 * jadi kita bikin emoji yang STABIL per simbol: hash simbol → indeks palet.
 * Token yang sama selalu dapet emoji yang sama, tiap sesi.
 */
const EMOJI = ["🐻", "🐸", "🐶", "🐱", "🦊", "🐵", "🦁", "🐯", "🐼", "🐨", "🐷", "🐮", "🐔", "🦄", "🐉", "🦋",
  "🍕", "🍔", "🌮", "🍩", "🍪", "🍧", "🍺", "☕", "🍄", "🌶", "🥑", "🍌", "🍉", "🥕",
  "🚀", "🛸", "⚡", "🔥", "💎", "🌙", "⭐", "🎩", "🎲", "🎯", "🧊", "🪙", "👾", "🤖", "👽", "🦴"];
const tokenEmoji = (sym) => {
  let h = 0;
  for (const ch of String(sym || "?")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return EMOJI[h % EMOJI.length];
};

// Telegram <pre> = kotak monospace bg gelap. Isinya HARUS di-escape (simbol token bisa ada < > &).
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pre = (s) => `<pre>${esc(s)}</pre>`;
// Pad SAJA — jangan pernah motong. (Bug awal: padL(9) bikin "$49.21/jam" → "$49.21/ja".)
const padR = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };

/**
 * /list — kalau `mid` dikasih, hasilnya di-EDIT di pesan itu (tombol 🔄 Refresh),
 * jadi nggak numpuk pesan baru tiap kali cek.
 */
async function onList(mid = null) {
  if (!mid) {
    const m = await send("⏳ Memuat posisi…");
    mid = m?.result?.message_id ?? null;
  }
  const out = (txt, extra) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  let rows;
  try { rows = await CH.listPositions(); } catch (e) { return out(`❌ ${String(e.message).slice(0, 80)}`); }
  const refreshBtn = [{ text: "🔄 Refresh", callback_data: "refresh" }];
  if (!rows.length) return out("Tidak ada posisi LP terbuka.", { reply_markup: { inline_keyboard: [refreshBtn] } });
  const px = await CH.ethUsd().catch(() => 0);
  const sg = (n, d) => (n >= 0 ? "+" : "") + n.toFixed(d);
  const usd = (e) => px ? `$${(e * px).toFixed(2)}` : "?";
  let totEth = 0, totPnl = 0, totFee = 0, totDep = 0;

  const T = [];
  rows.forEach((r, i) => {
    totEth += r.valEth || 0; totFee += r.feeEth || 0; totDep += r.depEth || 0; if (r.pnlEth != null) totPnl += r.pnlEth;
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
    T.push(`   ${padR("umur", 7)} ${padL(CH.fmtAge(r.ageMs) + (r.ageSource === "onchain" ? " ⛓" : ""), 11)}  ${rate}`);
    T.push(`   ${padR("MCAP", 7)} ${padL(CH.fmtMcap(r.mcapNow), 11)}  ${r.entryMcap ? "entry " + CH.fmtMcap(r.entryMcap) : "—"}`);
    T.push(`   ${padR("range", 7)} ${CH.fmtMcap(r.rangeMcapLow)} → ${CH.fmtMcap(r.rangeMcapHigh)}`);
    if (r.pnlEth != null) {
      T.push(`   ${padR("PnL", 7)} ${padL(sg(r.pnlEth, 6) + "Ξ", 11)}  ${padL((r.pnlEth >= 0 ? "+" : "-") + "$" + Math.abs(r.pnlEth * px).toFixed(2), 9)}  ${sg(r.pnlPct, 1)}%`);
    } else {
      T.push(`   ${padR("PnL", 7)} — (deposit tak tercatat)`);
    }
  });

  const S = [];
  S.push(`TOTAL ${rows.length} posisi`);
  S.push("─".repeat(37));
  S.push(`${padR("modal", 7)} ${padL(totDep.toFixed(6) + "Ξ", 11)}  ${padL(usd(totDep), 9)}`);
  S.push(`${padR("nilai", 7)} ${padL(totEth.toFixed(6) + "Ξ", 11)}  ${padL(usd(totEth), 9)}`);
  S.push(`${padR("fee", 7)} ${padL(totFee.toFixed(6) + "Ξ", 11)}  ${padL(usd(totFee), 9)}`);
  S.push(`${padR("PnL", 7)} ${padL(sg(totPnl, 6) + "Ξ", 11)}  ${padL((totPnl >= 0 ? "+" : "-") + "$" + Math.abs(totPnl * px).toFixed(2), 9)}`);

  // Label tombol: emoji + nama + PnL. tokenId cuma dipakai di callback_data (nggak keliatan).
  // Kalau ada 2 posisi di token yang SAMA, baru #id ditempel — biar nggak ketuker.
  const dupe = {};
  rows.forEach((r) => { dupe[r.tokenSym] = (dupe[r.tokenSym] || 0) + 1; });
  const btns = [refreshBtn];
  rows.forEach((r) => {
    const p = r.pnlEth != null
      ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)} · ${sg(r.pnlPct, 1)}%`
      : "";
    const id = dupe[r.tokenSym] > 1 ? ` #${r.tokenId}` : "";
    btns.push([{ text: `${tokenEmoji(r.tokenSym)} Close ${r.tokenSym}${id}${p}`, callback_data: `close:${r.tokenId}` }]);
  });
  if (rows.length > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${rows.length} posisi)`, callback_data: "closeall" }]);

  // jam update: bikin isi pesan selalu beda → Telegram nggak nolak edit dgn "message is not modified"
  const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const head = `📋 <b>Posisi LP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${jam}</i>`;
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")), { reply_markup: { inline_keyboard: btns } });
}

/**
 * /ledger — riwayat SEMUA posisi LP yang udah ditutup (realized PnL), paginated.
 * Beda sama /pnl: /pnl = PnL dompet keseluruhan (termasuk token rug di luar LP).
 * Ini KHUSUS hasil ngeLP: modal masuk vs yang balik.
 */
const LEDGER_PER_PAGE = 5;
async function onLedger(page = 0, mid = null) {
  const all = CH.readLedger().slice().sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)); // terbaru dulu
  const sum = CH.ledgerSummary();
  const out = (txt, extra) => (mid ? edit(mid, txt, extra) : send(txt, extra));

  // Kosong → rekonstruksi otomatis dari on-chain (event NPM), bukan nyerah.
  if (!all.length) {
    await out("⏳ <b>Ledger kosong — rebuild dari on-chain…</b>");
    try { await CH.backfillLedger(); } catch (e) { return out(`❌ Rebuild gagal: ${String(e.message).slice(0, 90)}`); }
    return onLedger(page, mid);
  }

  const pages = Math.max(1, Math.ceil(all.length / LEDGER_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(page * LEDGER_PER_PAGE, page * LEDGER_PER_PAGE + LEDGER_PER_PAGE);
  const sg = (n, d) => (n >= 0 ? "+" : "") + n.toFixed(d);
  const money = (v) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
  const when = (ts) => ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";

  const T = [];
  slice.forEach((e, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    const win = e.pnlEth == null ? "⬜" : (e.pnlEth >= 0 ? "🟩" : "🟥");
    T.push(`${win} ${tokenEmoji(e.sym)} ${e.sym}${e.mode === "inrange" ? "  🎯" : ""}   ${n}/${all.length}`);
    T.push(`   ${when(e.closedAt)} · hold ${CH.fmtAge(e.heldMs)}`);
    T.push(`   ${padR("modal", 6)} ${padL((e.depEth ?? 0).toFixed(6) + "Ξ", 11)}`);
    T.push(`   ${padR("balik", 6)} ${padL((e.outEth ?? 0).toFixed(6) + "Ξ", 11)}`);
    if (e.pnlEth != null) {
      T.push(`   ${padR("PnL", 6)} ${padL(sg(e.pnlEth, 6) + "Ξ", 11)}  ${padL(e.pnlUsd != null ? money(e.pnlUsd) : "—", 9)}  ${sg(e.pnlPct ?? 0, 1)}%`);
    } else T.push(`   ${padR("PnL", 6)} — (modal tak tercatat)`);
    // token yang belum dijual = BELUM jadi duit. Jangan dicampur ke PnL.
    if (e.unsoldEth > 0) T.push(`   🪙 nyangkut ${e.tokenKept ? e.tokenKept.toFixed(0) + " " + e.sym : ""} ~${e.unsoldEth.toFixed(6)}Ξ (blm dijual)`);
    else if (e.tokenRug > 0) T.push(`   ⚠️ ${e.tokenRug.toFixed(0)} ${e.sym} gagal dijual (rug)`);
  });

  const px = await CH.ethUsd().catch(() => 0);
  const net = sum.pnlEth + sum.unsoldEth;
  const S = [];
  S.push(`${sum.count} POSISI DITUTUP`);
  S.push("─".repeat(37));
  S.push(`${padR("menang", 8)} ${padL(`${sum.wins}W / ${sum.losses}L`, 10)}  ${padL(sum.winRate.toFixed(0) + "%", 9)}`);
  S.push(`${padR("modal", 8)} ${padL(sum.depEth.toFixed(5) + "Ξ", 10)}`);
  S.push(`${padR("fee LP", 8)} ${padL(sum.feeEth.toFixed(5) + "Ξ", 10)}`);
  S.push("");
  S.push(`${padR("REALIZED", 8)} ${padL(sg(sum.pnlEth, 5) + "Ξ", 10)}  ${padL(money(sum.pnlUsd), 9)}`);
  S.push(`  ETH yang beneran balik ke tangan`);
  S.push("");
  S.push(`${padR("nyangkut", 8)} ${padL("+" + sum.unsoldEth.toFixed(5) + "Ξ", 10)}  ${padL("+$" + (sum.unsoldEth * px).toFixed(2), 9)}`);
  S.push(`  token blm dijual — pakai /sell buat cairin`);
  S.push("");
  S.push(`${padR("NET", 8)} ${padL(sg(net, 5) + "Ξ", 10)}  ${padL(money(net * px), 9)}`);
  S.push(`  kalau semua token nyangkut laku dijual`);

  const nav = [];
  if (page > 0) nav.push({ text: "◀️ Back", callback_data: `lg:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `lg:${page}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `lg:${page + 1}` });

  const head = `📒 <b>Ledger LP</b> · ${all.length} posisi ditutup`;
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")), {
    reply_markup: { inline_keyboard: [nav, [{ text: "🔄 Rebuild dari on-chain", callback_data: "lgrb" }]] },
  });
}

// Rebuild ledger dari on-chain (buat posisi lama / kalau ada yang kelewat)
async function onLedgerRebuild(mid) {
  const m = mid ? { result: { message_id: mid } } : await send("⏳ Rebuild…");
  const id = mid || m?.result?.message_id;
  try {
    const r = await CH.backfillLedger((msg) => edit(id, `⏳ <b>Rebuild ledger dari on-chain</b>\n<i>${msg}</i>`).catch(() => {}));
    await edit(id, `✅ Rebuild selesai — ${r.rebuilt} posisi dari on-chain, total ${r.total}.`);
    await onLedger(0);
  } catch (e) { await edit(id, `❌ Rebuild gagal: ${String(e.message).slice(0, 100)}`); }
}

/** Notif spike volume. CA + link DexScreener + tombol langsung LP. */
async function notifySpike(h) {
  const arrow = h.prevVol5m > 0 ? `$${(h.prevVol5m / 1000).toFixed(0)}k → $${(h.vol5m / 1000).toFixed(0)}k` : `$${(h.vol5m / 1000).toFixed(0)}k`;
  const T = [];
  T.push(`${padR("vol 5m", 8)} ${arrow}  (${(h.vol5m / Math.max(h.prevVol5m, 1)).toFixed(1)}×)`);
  T.push(`${padR("vol 1h", 8)} $${(h.vol1h / 1000).toFixed(0)}k`);
  T.push(`${padR("likuid", 8)} $${(h.liq / 1000).toFixed(0)}k`);
  if (h.fdv) T.push(`${padR("MCAP", 8)} ${CH.fmtMcap(h.fdv)}`);
  T.push(`${padR("harga", 8)} ${h.chg5m >= 0 ? "+" : ""}${h.chg5m.toFixed(1)}% (5m) · ${h.chg1h >= 0 ? "+" : ""}${h.chg1h.toFixed(1)}% (1h)`);
  T.push("");
  T.push(`✅ AMAN — ${h.safe.reason}`);
  T.push(`   tes beli 0.01Ξ → jual balik: ${h.safe.backPct.toFixed(1)}%`);
  await send([
    `🚨 <b>VOLUME NANJAK</b> · ${tokenEmoji(h.symbol)} <b>${esc(h.symbol)}</b>`,
    pre(T.join("\n")),
    `<code>${h.addr}</code>`,
    `<a href="${h.url}">📈 DexScreener</a>`,
  ].join("\n"), {
    reply_markup: { inline_keyboard: [[{ text: `🎯 LP ${h.symbol}`, callback_data: `ca:${h.addr}` }, { text: "📈 Chart", url: h.url }]] },
  });
}

let _watchTimer = null, _watchBusy = false;
async function watchTick() {
  if (_watchBusy) return;
  _watchBusy = true;
  try {
    const hits = await W.scanOnce();
    for (const h of hits) await notifySpike(h);
    if (hits.length) log(`watch: ${hits.length} spike → notif`);
  } catch (e) { log(`watch error: ${e.message}`); }
  finally { _watchBusy = false; }
}
function startWatch() {
  const w = W.wcfg();
  if (!w.enabled || _watchTimer) return;
  _watchTimer = setInterval(watchTick, w.intervalSec * 1000);
  log(`watch ON — scan tiap ${w.intervalSec}s (vol5m ≥ $${(w.minVol5m / 1000).toFixed(0)}k, naik ${w.riseFactor}×)`);
  watchTick(); // scan pertama = bikin baseline
}
function stopWatch() { if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; log("watch OFF"); } }

async function onWatch(arg) {
  const w = W.wcfg();
  if (arg === "on") { cfg.watch = { ...(cfg.watch || {}), enabled: true }; saveCfg(); startWatch(); return send("👁 Watch <b>ON</b>."); }
  if (arg === "off") { cfg.watch = { ...(cfg.watch || {}), enabled: false }; saveCfg(); stopWatch(); return send("👁 Watch <b>OFF</b>."); }
  const T = [
    `${padR("status", 12)} ${_watchTimer ? "ON" : "OFF"}`,
    `${padR("scan tiap", 12)} ${w.intervalSec}s`,
    `${padR("vol 5m min", 12)} $${(w.minVol5m / 1000).toFixed(0)}k`,
    `${padR("naik min", 12)} ${w.riseFactor}× vs scan sebelumnya`,
    `${padR("vol 1h min", 12)} $${(w.minVol1h / 1000).toFixed(0)}k`,
    `${padR("likuid min", 12)} $${(w.minLiqUsd / 1000).toFixed(0)}k`,
    `${padR("tax maks", 12)} ${w.maxTaxPct}%`,
    `${padR("cooldown", 12)} ${w.cooldownMin} menit/token`,
    `${padR("RPC", 12)} ${W.usingOwnRpc ? "terpisah (khusus scan)" : "numpang RPC LP"}`,
  ];
  // Pasar sekarang seberapa rame? Biar "nggak ada notif" kebedain: bot mati vs emang sepi.
  const top = await W.topVolumeNow(3).catch(() => []);
  if (top.length) {
    T.push("");
    T.push("VOL 5m TERTINGGI SEKARANG");
    for (const t of top) {
      const pass = t.vol5m >= w.minVol5m;
      T.push(`  ${pass ? "✓" : " "} ${padR(t.symbol.slice(0, 10), 11)} $${(t.vol5m / 1000).toFixed(0)}k`);
    }
    const gap = w.minVol5m / Math.max(top[0].vol5m, 1);
    T.push(gap > 1 ? `  → ambang ${gap.toFixed(1)}× di atas puncak: SEPI` : `  → ada yang lewat ambang`);
  }
  await send(`👁 <b>Volume Watch</b>${pre(T.join("\n"))}<code>/watch on</code> · <code>/watch off</code> · <code>/scan</code> (cek sekarang)\nUbah: <code>/set vol5m 200000</code> · <code>/set rise 2</code> · <code>/set liq 100000</code>`);
}

async function onScan() {
  const m = await send("🔍 Scan volume…");
  const mid = m?.result?.message_id;
  try {
    const hits = await W.scanOnce((msg) => mid && edit(mid, `🔍 <i>${esc(msg)}</i>`).catch(() => {}));
    if (!hits.length) return edit(mid, "🔍 Nggak ada token yang lolos filter barusan.\n<i>(butuh 2 scan buat ngukur kenaikan — coba lagi bentar)</i>");
    await edit(mid, `🔍 <b>${hits.length} token</b> lolos:`);
    for (const h of hits) await notifySpike(h);
  } catch (e) { await edit(mid, `❌ Scan gagal: ${String(e.message).slice(0, 90)}`); }
}

// Tombol Close → tanya dulu: swap token→ETH atau simpen token?
async function onCloseAsk(tokenId, mid) {
  await edit(mid, `Close #${tokenId} — fee/token-nya mau diapain?\n<i>(LP principal tetap balik jadi ETH)</i>`, {
    reply_markup: { inline_keyboard: [
      [{ text: "🔄 Swap token → ETH (full ETH)", callback_data: `cs:${tokenId}` }],
      [{ text: "🪙 Simpen token (WETH + token)", callback_data: `ck:${tokenId}` }],
    ] },
  });
}

async function onClose(tokenId, mid, swapToken = true) {
  await edit(mid, `⏳ Closing #${tokenId}… ${swapToken ? "(swap token→ETH)" : "(simpen token)"}`);
  try {
    const r = await CH.closePosition(tokenId, { swapToken });
    const px = await CH.ethUsd().catch(() => 0);
    const pnl = r.pnlEth != null
      ? `\n💰 <b>PnL ETH: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ</b> (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%)\n💵 <b>PnL USD: ${r.pnlEth >= 0 ? "+" : ""}$${px ? (r.pnlEth * px).toFixed(2) : "?"}</b>`
      : `\nPnL: — (deposit tak tercatat)`;
    await send([
      `✅ <b>Closed #${tokenId}</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}`,
      r.heldMs != null ? `⏱ di-hold <b>${CH.fmtAge(r.heldMs)}</b>` : "",
      `Tarik: ${r.recvWeth.toFixed(6)} ${r.wethSym}${r.recvToken > 0 ? ` + ${r.recvToken.toFixed(2)} ${r.tokenSym}` : ""}`,
      r.swappedWeth > 0 ? `🔄 Swap ${r.tokenSym} → +${r.swappedWeth.toFixed(6)} WETH`
        : (r.tokenStuck > 0 ? (swapToken ? `⚠️ ${r.tokenStuck.toFixed(2)} ${r.tokenSym} gagal dijual (rug) — nyangkut` : `🪙 ${r.tokenStuck.toFixed(2)} ${r.tokenSym} disimpen (senilai ~$${px ? ((r.valEth - r.recvWeth) * px).toFixed(2) : "?"})`) : ""),
      `Total balik: <b>${r.valEth.toFixed(6)}Ξ / $${px ? (r.valEth * px).toFixed(2) : "?"}</b>${r.depEth != null ? ` (deposit ${r.depEth.toFixed(6)}Ξ)` : ""}${pnl}`,
      r.topUp ? `⛽ Top-up gas: unwrap ${r.topUp.unwrapped.toFixed(5)} WETH → ETH native (${r.topUp.nativeAfter.toFixed(4)}Ξ)` : "",
      r.collectHash ? `tx: <a href="${exp(r.collectHash)}">collect</a>${r.swapHash ? ` · <a href="${exp(r.swapHash)}">swap</a>` : ""}` : "",
    ].filter(Boolean).join("\n"));
  } catch (e) { await send(`❌ Close gagal: ${String(e.message).slice(0, 120)}`); }
}

async function onCloseAll() {
  let rows;
  try { rows = await CH.listPositions(); } catch (e) { return send(`❌ ${String(e.message).slice(0, 80)}`); }
  if (!rows.length) return send("Tidak ada posisi buat ditutup.");
  const px = await CH.ethUsd().catch(() => 0);
  await send(`🗑🗑 <b>Menutup ${rows.length} posisi…</b> (satu per satu)`);
  let totPnl = 0, ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const r = await CH.closePosition(row.tokenId);
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(`✅ #${row.tokenId} ${row.tokenSym} closed · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`);
    } catch (e) { fail++; await send(`❌ #${row.tokenId} gagal: ${String(e.message).slice(0, 70)}`); }
  }
  await send([
    `🏁 <b>Close ALL selesai</b> — ${ok} sukses${fail ? `, ${fail} gagal` : ""}`,
    `💰 Total PnL ETH: <b>${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(6)}Ξ</b>`,
    px ? `💵 Total PnL USD: <b>${totPnl >= 0 ? "+" : ""}$${(totPnl * px).toFixed(2)}</b>` : "",
  ].filter(Boolean).join("\n"));
}

async function onPnl() {
  await send("📊 Menghitung PnL seumur hidup… (scan history + rug, ±20 detik)");
  let r;
  try { r = await CH.lifetimePnl(); } catch (e) { return send(`❌ ${String(e.message).slice(0, 90)}`); }
  const u = (e) => r.px ? `$${(e * r.px).toFixed(2)}` : "?";
  const emo = r.pnlEth > 0 ? "🟢" : r.pnlEth < 0 ? "🔴" : "⚪";
  await send([
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
  ].filter(Boolean).join("\n"));
}

async function onSell() {
  await send("🔄 <b>Menjual semua token nyangkut → ETH…</b>\n(skip yang rug/pool kering)");
  try {
    const r = await CH.sellAllTokens((msg) => send(msg).catch(() => {}));
    await send([
      `🏁 <b>Selesai jual</b> — ${r.sold} token → ETH${r.skipped ? `, ${r.skipped} di-skip (rug)` : ""}`,
      `💰 Total dapet: <b>+${r.soldEth.toFixed(6)} WETH ($${r.soldUsd.toFixed(2)})</b>`,
    ].join("\n"));
  } catch (e) { await send(`❌ ${String(e.message).slice(0, 90)}`); }
}

async function onWallet() {
  try { const b = await CH.balances(); await send(`👛 <code>${b.address}</code>\nETH: ${Number(b.eth).toFixed(5)} · WETH: ${Number(b.weth).toFixed(5)}`); }
  catch (e) { await send(`❌ ${String(e.message).slice(0, 80)}`); }
}
async function onSettings() {
  await send(`⚙️ <b>Setting</b>\nwidth: ${cfg.lp.widthPct}%\ndeposit: $${cfg.lp.depositUsd}\nslippage: ${cfg.lp.slippagePct}%\nauto-wrap: ${cfg.lp.autoWrap}\n\nUbah: <code>/set width 40</code> · <code>/set deposit 30</code>`);
}
async function onSet(text) {
  const [, k, v] = text.split(/\s+/);
  const lpMap = { width: "widthPct", deposit: "depositUsd", slippage: "slippagePct", gastarget: "nativeTargetEth" };
  const wMap = { vol5m: "minVol5m", vol1h: "minVol1h", rise: "riseFactor", liq: "minLiqUsd", tax: "maxTaxPct", cooldown: "cooldownMin", interval: "intervalSec" };
  if (isNaN(Number(v))) return send("Format: <code>/set &lt;key&gt; &lt;angka&gt;</code>\nLP: width, deposit, slippage, gastarget\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval");
  if (lpMap[k]) { cfg.lp[lpMap[k]] = Number(v); saveCfg(); return send(`✓ ${k} → ${v}`); }
  if (wMap[k]) {
    cfg.watch = { ...(cfg.watch || {}), [wMap[k]]: Number(v) };
    saveCfg();
    if (k === "interval") { stopWatch(); startWatch(); }   // interval berubah → timer harus dibikin ulang
    return send(`✓ watch.${k} → ${v}`);
  }
  return send("Key nggak dikenal.\nLP: width, deposit, slippage, gastarget\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval");
}

async function handle(u) {
  const cq = u.callback_query;
  if (cq) {
    chatId = String(cq.message.chat.id); saveCfg();
    const d = cq.data, mid = cq.message.message_id;
    // toast: refresh butuh bbrp detik (banyak RPC call) — kasih tau biar nggak dikira ngehang
    await api("answerCallbackQuery", { callback_query_id: cq.id, ...(d === "refresh" ? { text: "🔄 Ambil data on-chain…" } : {}) });
    if (d.startsWith("ca:")) return onCA(d.slice(3)); // dari notif spike → langsung LP
    if (d === "refresh") return onList(mid); // re-render di pesan yg sama
    if (d === "lgrb") return onLedgerRebuild(mid);
    if (d.startsWith("lg:")) return onLedger(Number(d.split(":")[1]), mid); // ledger next/back
    if (d.startsWith("pool:")) return onPick(Number(d.split(":")[1]), mid);
    if (d.startsWith("mint:")) return onMint(mid, d.split(":")[1]);
    if (d === "mint") return onMint(mid, "single"); // kompat pesan lama
    if (d === "cancel") { pending.delete(chatId); return edit(mid, "❌ Dibatalkan."); }
    if (d.startsWith("close:")) return onCloseAsk(d.split(":")[1], mid);
    if (d.startsWith("cs:")) return onClose(d.split(":")[1], mid, true);   // close + swap
    if (d.startsWith("ck:")) return onClose(d.split(":")[1], mid, false);  // close + keep token
    if (d === "closeall") { await edit(mid, "🗑🗑 memproses Close ALL…"); return onCloseAll(); }
    return;
  }
  const m = u.message; if (!m?.text) return;
  chatId = String(m.chat.id); saveCfg();
  const t = m.text.trim();
  if (t === "/start" || t === "/help") return send("🤖 <b>Robinhood LP Bot</b>\nPaste CA token (0x…) → pilih pool → ketik jumlah ETH → confirm → auto open LP.\n\n/list — posisi terbuka + PnL + close\n/ledger — <b>riwayat LP ditutup</b> (realized)\n/watch — <b>pemantau volume nanjak</b>\n/scan — cek volume sekarang\n/pnl — <b>PnL seumur hidup</b> (termasuk rug)\n/closeall — tutup SEMUA posisi\n/sell — jual token nyangkut → ETH\n/wallet — saldo\n/settings — width/dll\n/set <k> <v> — ubah setting");
  if (t === "/list") return onList();
  if (t === "/ledger") return onLedger(0);
  if (t === "/scan") return onScan();
  if (t.startsWith("/watch")) return onWatch(t.split(/\s+/)[1]);
  if (t === "/pnl") return onPnl();
  if (t === "/sell") return onSell();
  if (t === "/closeall") return onCloseAll();
  if (t === "/wallet") return onWallet();
  if (t === "/settings") return onSettings();
  if (t.startsWith("/set ")) return onSet(t);
  if (/^0x[a-fA-F0-9]{40}$/.test(t)) return onCA(t);
  // lagi nunggu input jumlah ETH? (setelah pilih pool)
  const st = pending.get(chatId);
  if (st?.awaitingAmount && /^[0-9]*\.?[0-9]+$/.test(t)) return onAmount(t);
  if (t.startsWith("/")) return; // command tak dikenal
  return send("Paste alamat kontrak token (0x… 40 hex) buat buka LP.");
}

async function loop() {
  // register command menu
  await api("setMyCommands", { commands: [
    { command: "list", description: "Posisi LP terbuka + close" },
    { command: "watch", description: "Pemantau lonjakan volume (on/off/status)" },
    { command: "scan", description: "Cek lonjakan volume sekarang" },
    { command: "ledger", description: "Riwayat posisi LP ditutup (realized PnL)" },
    { command: "pnl", description: "PnL seumur hidup (termasuk rug)" },
    { command: "closeall", description: "Tutup SEMUA posisi" },
    { command: "sell", description: "Jual token nyangkut → ETH" },
    { command: "wallet", description: "Saldo hot wallet" },
    { command: "settings", description: "Width, deposit, slippage" },
    { command: "help", description: "Bantuan" },
  ] });
  log(`Robinhood LP Bot jalan — chain ${cfg.chainId}, wallet ${CH.wallet().address}`);
  startWatch();
  let offset = 0;
  for (;;) {
    try {
      const r = await api("getUpdates", { offset, timeout: 25 });
      for (const u of (r?.result || [])) { offset = u.update_id + 1; await handle(u).catch((e) => log("handle err: " + e.message)); }
    } catch (e) { log("loop: " + String(e.message).slice(0, 50)); await new Promise((s) => setTimeout(s, 2000)); }
  }
}

if (!TOKEN) { console.error("RH_TG_TOKEN belum diset di .env"); process.exit(1); }
loop();
