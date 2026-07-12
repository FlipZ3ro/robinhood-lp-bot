/**
 * watch.js — pemantau lonjakan volume di Robinhood Chain.
 *
 * Alur tiap scan:
 *   1. daftar token   ← Blockscout (di-cache 30 menit)
 *   2. volume 5m/1h   ← DexScreener (batch 30 CA per request)
 *   3. deteksi spike  ← volume 5m nanjak vs scan sebelumnya
 *   4. UJI KEAMANAN   ← beli 0.01Ξ → jual balik lewat Quoter (on-chain, bukan reputasi)
 *   5. notif Telegram ← CA + link DexScreener
 *
 * Kenapa uji jual-balik, bukan API honeypot: nggak ada layanan honeypot yang
 * support chain 4663. Quoter mensimulasikan swap ASLI lewat pool — kalau token
 * nggak bisa dijual (blacklist/tax gede), simulasinya revert atau hasilnya jeblok.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { cfg, provider as lpProvider } from "./chain.js";

/**
 * RPC TERPISAH buat scan.
 * Scan nembak Quoter tiap 2 menit × banyak token — kalau numpang RPC yang dipakai
 * LP (mint/close), kuotanya kesedot dan tx penting bisa kena rate-limit pas lagi butuh.
 * Pakai RH_WATCH_RPC_URL; kalau nggak diset, jatuh balik ke RPC utama.
 */
const WATCH_RPC = (process.env.RH_WATCH_RPC_URL || "").trim();
export const watchProvider = WATCH_RPC
  ? new ethers.JsonRpcProvider(WATCH_RPC, cfg.chainId)
  : lpProvider;
export const usingOwnRpc = !!WATCH_RPC;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HIST_FILE = path.join(DIR, "watch-history.json");
const BS = "https://robinhoodchain.blockscout.com";
const DS = "https://api.dexscreener.com/latest/dex/tokens";
const QUOTER_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"];

export const wcfg = () => ({
  enabled: true,
  intervalSec: 120,
  minVol5m: 100_000,      // volume 5 menit minimal (USD)
  riseFactor: 1.4,        // volume 5m harus >= 1.4× scan sebelumnya (NANJAK, bukan cuma tinggi)
  minVol1h: 200_000,      // konfirmasi bukan 1 candle nyasar
  minLiqUsd: 50_000,      // pool terlalu tipis = gampang di-dump
  maxTaxPct: 6,           // rugi jual-balik di ATAS ekspektasi fee → tax/honeypot
  cooldownMin: 60,        // jangan spam token yang sama
  maxTokens: 300,
  ...(cfg.watch || {}),
});

// ── state (persist biar restart nggak ilang memori) ──
function loadHist() { try { return JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch { return { vol: {}, alerted: {} }; } }
function saveHist(h) { try { fs.writeFileSync(HIST_FILE, JSON.stringify(h, null, 2)); } catch { /* */ } }

// ── 1. daftar token dari Blockscout (cache 30 menit) ──
let _tokens = { list: [], at: 0 };
async function tokenList(max) {
  if (Date.now() - _tokens.at < 30 * 60_000 && _tokens.list.length) return _tokens.list;
  const out = [];
  let next = null;
  for (let page = 0; page < 10 && out.length < max; page++) {
    const q = next ? "?" + new URLSearchParams(next).toString() : "?type=ERC-20";
    const r = await fetch(`${BS}/api/v2/tokens${q}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => null);
    for (const t of (r?.items || [])) {
      const addr = t.address_hash || t.address;
      if (addr) out.push({ addr, symbol: t.symbol || "?" });
    }
    next = r?.next_page_params;
    if (!next) break;
  }
  _tokens = { list: out.slice(0, max), at: Date.now() };
  return _tokens.list;
}

// ── 2. volume dari DexScreener, batch 30 CA ──
async function marketData(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const r = await fetch(`${DS}/${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => null);
    for (const p of (r?.pairs || [])) {
      if (p.chainId !== "robinhood") continue;
      const a = p.baseToken?.address;
      if (!a) continue;
      const liq = Number(p.liquidity?.usd || 0);
      // satu token bisa punya beberapa pool — ambil yang likuiditasnya paling tebal
      if (out[a] && out[a].liq >= liq) continue;
      out[a] = {
        addr: a, symbol: p.baseToken?.symbol || "?", pair: p.pairAddress,
        vol5m: Number(p.volume?.m5 || 0), vol1h: Number(p.volume?.h1 || 0), vol24h: Number(p.volume?.h24 || 0),
        liq, fdv: Number(p.fdv || 0), priceUsd: Number(p.priceUsd || 0),
        chg5m: Number(p.priceChange?.m5 || 0), chg1h: Number(p.priceChange?.h1 || 0),
        fee: Math.round(Number(p.labels?.[0]?.replace?.("%", "") || 0) * 10000) || null,
        createdAt: p.pairCreatedAt || null,
        url: p.url || `https://dexscreener.com/robinhood/${p.pairAddress}`,
      };
    }
    await new Promise((r2) => setTimeout(r2, 250)); // sopan ke API
  }
  return out;
}

/**
 * ── 4. UJI KEAMANAN on-chain: beli 0.01Ξ lalu jual balik. ──
 * Rugi WAJAR = 2× fee pool (beli + jual). Contoh pool 1% → balik ~98%.
 * Kalau balik jauh di bawah itu → ada tax tersembunyi. Kalau revert → nggak bisa dijual.
 * @returns {{ok, backPct, taxPct, reason}}
 */
export async function safetyCheck(tokenAddr, maxTaxPct = 6) {
  // read-only: quoteExactInputSingle cukup eth_call, nggak perlu private key sama sekali.
  const q = new ethers.Contract(cfg.contracts.quoter, QUOTER_ABI, watchProvider);
  const WETH = cfg.contracts.weth;
  const IN = ethers.parseEther("0.01");
  let best = null;
  for (const fee of cfg.lp.feeTiers) {
    try {
      const buy = await q.quoteExactInputSingle.staticCall({ tokenIn: WETH, tokenOut: tokenAddr, amountIn: IN, fee, sqrtPriceLimitX96: 0n });
      if (buy[0] === 0n) continue;
      const sell = await q.quoteExactInputSingle.staticCall({ tokenIn: tokenAddr, tokenOut: WETH, amountIn: buy[0], fee, sqrtPriceLimitX96: 0n });
      const backPct = Number(ethers.formatEther(sell[0])) / 0.01 * 100;
      const expected = Math.pow(1 - fee / 1e6, 2) * 100;   // rugi wajar = 2× fee
      const taxPct = expected - backPct;                    // selisih = tax tersembunyi
      if (!best || backPct > best.backPct) best = { fee, backPct, expected, taxPct };
    } catch { /* pool fee ini nggak ada / nggak bisa dijual */ }
  }
  if (!best) return { ok: false, backPct: 0, taxPct: 100, reason: "TIDAK BISA DIJUAL (simulasi revert) — honeypot" };
  if (best.taxPct > maxTaxPct) return { ok: false, ...best, reason: `tax tersembunyi ~${best.taxPct.toFixed(1)}%` };
  return { ok: true, ...best, reason: `sehat (balik ${best.backPct.toFixed(1)}%)` };
}

/**
 * Stablecoin & wrapped: volume-nya emang selalu gede, tapi nggak ada momentum harga.
 * Dua lapis: pola nama, DAN perilaku (harga nempel $1 + nyaris nggak gerak).
 * Lapis kedua nangkep stable yang namanya nggak ketebak.
 */
const STABLE_RE = /^(w?eth|usd[a-z]?|.*usd[a-z]?|dai|frax|tusd|susd|.*syrup.*)$/i;
function isStable(m) {
  if (STABLE_RE.test(m.symbol)) return true;
  const flat = m.priceUsd > 0.95 && m.priceUsd < 1.05 && Math.abs(m.chg1h) < 1;
  return flat;
}

/**
 * Volume 5m tertinggi saat ini (non-stable). Dipakai di /watch biar kelihatan
 * seberapa jauh pasar dari ambang — jadi "nggak ada notif" bisa dibedain antara
 * "bot mati" vs "emang lagi sepi".
 */
export async function topVolumeNow(n = 3) {
  const w = wcfg();
  const toks = await tokenList(w.maxTokens);
  const md = await marketData(toks.map((t) => t.addr));
  return Object.values(md)
    .filter((m) => !isStable(m))
    .sort((a, b) => b.vol5m - a.vol5m)
    .slice(0, n);
}

/**
 * Satu putaran scan. Balikin daftar token yang LOLOS semua filter.
 * Deteksi = volume 5m TINGGI **dan** NANJAK vs scan sebelumnya.
 * (Cuma "tinggi" doang nggak cukup — nanti token yang rame terus di-spam tiap scan.)
 */
export async function scanOnce(onLog = () => {}) {
  const w = wcfg();
  const hist = loadHist();
  const toks = await tokenList(w.maxTokens);
  onLog(`cek ${toks.length} token…`);
  const md = await marketData(toks.map((t) => t.addr));
  const now = Date.now();
  const hits = [];

  for (const m of Object.values(md)) {
    const prev = hist.vol[m.addr];
    const prevVol = prev?.vol5m ?? 0;
    hist.vol[m.addr] = { vol5m: m.vol5m, at: now };

    if (isStable(m)) continue;                                // stablecoin: volume gede tapi bukan momentum
    if (m.vol5m < w.minVol5m) continue;                       // belum kenceng
    if (m.vol1h < w.minVol1h) continue;                       // cuma 1 candle nyasar
    if (m.liq < w.minLiqUsd) continue;                        // pool tipis
    // Butuh BASELINE dulu: "nanjak" cuma bisa dibuktikan kalau ada scan sebelumnya.
    // Tanpa ini, scan pertama bakal nge-fire semua token rame sekaligus.
    if (!prev) continue;
    if (m.vol5m < prevVol * w.riseFactor) continue;           // tinggi tapi nggak NANJAK
    const last = hist.alerted[m.addr] || 0;
    if (now - last < w.cooldownMin * 60_000) continue;        // baru dinotif

    onLog(`spike: ${m.symbol} $${(m.vol5m / 1000).toFixed(0)}k/5m — uji keamanan…`);
    const safe = await safetyCheck(m.addr, w.maxTaxPct);
    if (!safe.ok) { onLog(`  ✗ ${m.symbol} ditolak: ${safe.reason}`); continue; }

    hist.alerted[m.addr] = now;
    hits.push({ ...m, prevVol5m: prevVol, safe });
  }
  saveHist(hist);
  return hits;
}
