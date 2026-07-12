/**
 * chain.js — jembatan EVM Robinhood Chain (Uniswap v3).
 *
 * Fungsi inti dipakai bot:
 *   findPools(token)   → semua pool token/WETH yang ada (per fee tier)
 *   openPosition(...)  → wrap ETH → approve → mint LP (NonfungiblePositionManager)
 *   listPositions()    → posisi LP wallet + status in/out range + unclaimed fee
 *   closePosition(id)  → decreaseLiquidity + collect + burn
 *
 * Konsentrasi: satu file, zero framework, ethers v6.
 */
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const C = cfg.contracts;

// ── ABI minimal (cukup buat LP flow) ──
const ERC20 = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const WETH_ABI = [...ERC20, "function deposit() payable", "function withdraw(uint256)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const NPM_ABI = [
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId) payable",
];

// RPC dari .env (Alchemy) diutamakan; fallback ke config.json (public RPC).
export const provider = new ethers.JsonRpcProvider(process.env.RH_RPC_URL?.trim() || cfg.rpcUrl, cfg.chainId);
export function wallet() {
  const pk = (process.env.RH_WALLET_KEY || "").trim();
  if (!pk) throw new Error("RH_WALLET_KEY belum diset di .env");
  return new ethers.Wallet(pk, provider);
}
// Gas: base fee chain naik-turun tiap block → kalau gasPrice terlalu pas, tx
// ditolak "max fee < base fee" & nyangkut (bikin close/mint HANG). Solusi: buffer 3x.
async function overrides() {
  if (Number(cfg.gasPriceGwei) > 0) return { gasPrice: ethers.parseUnits(String(cfg.gasPriceGwei), "gwei") };
  try { const gp = (await provider.getFeeData()).gasPrice; if (gp) return { gasPrice: gp * 3n }; } catch { /* */ }
  return {};
}

const _meta = new Map();
export async function tokenMeta(addr) {
  const a = ethers.getAddress(addr);
  if (_meta.has(a)) return _meta.get(a);
  const c = new ethers.Contract(a, ERC20, provider);
  const [symbol, decimals, supply] = await Promise.all([c.symbol().catch(() => "?"), c.decimals().catch(() => 18), c.totalSupply().catch(() => 0n)]);
  const dec = Number(decimals);
  const m = { addr: a, symbol, decimals: dec, supplyUi: Number(ethers.formatUnits(supply, dec)) };
  _meta.set(a, m);
  return m;
}

// Harga TOKEN (yang bukan WETH) dalam ETH pada sebuah tick.
// pHuman(tick) = token1 per token0. WETH=token0 → token=token1 → hargaEth = 1/pHuman.
//               WETH=token1 → token=token0 → hargaEth = pHuman.
function tokenPriceEthAtTick(tick, wethIsToken0, d0, d1) {
  const pHuman = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1); // token1 per token0
  return wethIsToken0 ? (pHuman > 0 ? 1 / pHuman : 0) : pHuman;
}
// Format MCAP ringkas: $1.2M / $340k
/** Durasi ms → "2h 14m" / "3d 5h" / "42m". */
export function fmtAge(ms) {
  if (ms == null || !(ms >= 0)) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24), hh = h % 24;
  return `${d}d ${hh}h`;
}

export function fmtMcap(v) {
  if (!v) return "?";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  return "$" + v.toFixed(0);
}

/** Semua pool token/WETH yang sudah ada, per fee tier. */
export async function findPools(tokenAddr) {
  const token = ethers.getAddress(tokenAddr);
  const weth = ethers.getAddress(C.weth);
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const out = [];
  for (const fee of cfg.lp.feeTiers) {
    const pool = await factory.getPool(token, weth, fee).catch(() => ethers.ZeroAddress);
    if (pool === ethers.ZeroAddress) continue;
    const pc = new ethers.Contract(pool, POOL_ABI, provider);
    const [liq, t0] = await Promise.all([pc.liquidity(), pc.token0()]);
    if (liq === 0n) continue;
    // TVL kasar: saldo WETH pool × 2 (proxy) — cukup buat ranking
    const wc = new ethers.Contract(weth, ERC20, provider);
    const wbal = await wc.balanceOf(pool).catch(() => 0n);
    out.push({ pool, fee, liquidity: liq, token0: ethers.getAddress(t0), wethInPool: Number(ethers.formatEther(wbal)) });
  }
  out.sort((a, b) => b.wethInPool - a.wethInPool);
  return out;
}

const nearestTick = (tick, spacing) => Math.round(Number(tick) / spacing) * spacing;

/** Detail pool + harga sekarang + range dihitung dari widthPct. */
export async function poolState(poolAddr, tokenAddr) {
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [slot0, tickSpacing, token0, token1, fee] = await Promise.all([
    pc.slot0(), pc.tickSpacing(), pc.token0(), pc.token1(), pc.fee(),
  ]);
  const tick = Number(slot0.tick);
  const spacing = Number(tickSpacing);
  const wPct = cfg.lp.widthPct / 100;
  // lebar dalam tick: ln(1±w)/ln(1.0001)
  const tickUp = Math.round(Math.log(1 + wPct) / Math.log(1.0001));
  const tickDown = Math.round(Math.log(1 - wPct) / Math.log(1.0001));
  let tickLower = nearestTick(tick + tickDown, spacing);
  let tickUpper = nearestTick(tick + tickUp, spacing);
  if (tickLower >= tickUpper) tickUpper = tickLower + spacing;
  return {
    pool: poolAddr, fee: Number(fee), tick, spacing,
    token0: ethers.getAddress(token0), token1: ethers.getAddress(token1),
    tickLower, tickUpper, sqrtPriceX96: slot0.sqrtPriceX96,
  };
}

/**
 * Buka posisi LP SINGLE-SIDED WETH (ETH-only) — WETH masuk 100%, tidak butuh token.
 *
 * Kunci: range harus SEPENUHNYA di satu sisi harga sekarang, tidak straddle.
 *   • WETH = token0 → range DI ATAS harga (tick < tickLower). Posisi 100% token0=WETH,
 *     tetap WETH sampai harga NAIK masuk range (ask). ← kasus umum di Robinhood.
 *   • WETH = token1 → range DI BAWAH harga (tick >= tickUpper). Posisi 100% token1=WETH,
 *     tetap WETH sampai harga TURUN masuk range (bid, ala Meridian catch-dip).
 * amountWethStr = jumlah ETH (string).
 */
export async function openPosition(tokenAddr, poolAddr, amountWethStr, opts = {}) {
  const inRange = opts.mode === "inrange";
  const w = wallet();
  const weth = ethers.getAddress(C.weth);
  const st = await poolState(poolAddr, tokenAddr);
  const amount = ethers.parseEther(amountWethStr);
  const wethIsToken0 = st.token0.toLowerCase() === weth.toLowerCase();
  if (!wethIsToken0 && st.token1.toLowerCase() !== weth.toLowerCase()) throw new Error("pool ini bukan pair WETH");
  const [m0, m1] = await Promise.all([tokenMeta(st.token0), tokenMeta(st.token1)]);

  // 1. wrap ETH → WETH
  const wc = new ethers.Contract(weth, WETH_ABI, w);
  const wbal = await wc.balanceOf(w.address);
  let wrapTx = null;
  if (wbal < amount && cfg.lp.autoWrap) {
    wrapTx = await wc.deposit({ value: amount - wbal, ...(await overrides()) });
    await wrapTx.wait();
  }
  // 2. approve WETH
  if ((await wc.allowance(w.address, C.positionManager)) < amount) {
    const atx = await wc.approve(C.positionManager, ethers.MaxUint256, await overrides());
    await atx.wait();
  }
  // Pakai SALDO WETH PERSIS (bukan angka bulat) — wrap bisa meleset 1 wei → STF.
  const realBal = await wc.balanceOf(w.address);
  const depositAmt = realBal < amount ? realBal : amount;
  const sp = st.spacing;
  const widthTicks = Math.max(sp, Math.round(Math.log(1 + cfg.lp.widthPct / 100) / Math.log(1.0001) / sp) * sp);
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);

  const tokenAddrReal = wethIsToken0 ? st.token1 : st.token0;
  const tokMeta0 = wethIsToken0 ? m1 : m0;
  const pxUsd = await ethUsd().catch(() => 0);
  const mcapOf = (t) => tokenPriceEthAtTick(t, wethIsToken0, m0.decimals, m1.decimals) * pxUsd * tokMeta0.supplyUi;

  // ══════════ MODE IN-RANGE: range MENYEBERANGI harga → wajib punya 2 sisi ══════════
  // Uniswap v3 tidak bisa mint straddle dengan 1 token (liquidity jadi 0). Jadi:
  //   swap sebagian WETH → token dulu, baru mint. Konsekuensi: langsung ~separuh jadi token.
  if (inRange) {
    const tickNow = Number((await pc.slot0()).tick);
    const half = Math.max(sp, Math.round(widthTicks / 2 / sp) * sp);
    const anchor = Math.floor(tickNow / sp) * sp;
    const tickLower = anchor - half;
    const tickUpper = anchor + half;

    // Swap 98% dari kebutuhan → token jadi sisi pembatas, sisa WETH balik ke dompet (bukan token nyangkut).
    const frac = swapFractionForRange(tickNow, tickLower, tickUpper, wethIsToken0) * 0.98;
    const wethToSwap = (depositAmt * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
    const sw = await swapWethToToken(tokenAddrReal, wethToSwap, st.fee);
    const tokenGot = sw.tokenOut;
    if (tokenGot <= 0n) throw new Error("swap WETH → token tidak menghasilkan token (pool kering?)");

    const erc = new ethers.Contract(tokenAddrReal, ERC20, w);
    if ((await erc.allowance(w.address, C.positionManager)) < tokenGot) {
      await (await erc.approve(C.positionManager, ethers.MaxUint256, await overrides())).wait();
    }
    const wethLeft = depositAmt - wethToSwap;
    const params = {
      token0: st.token0, token1: st.token1, fee: st.fee, tickLower, tickUpper,
      amount0Desired: wethIsToken0 ? wethLeft : tokenGot,
      amount1Desired: wethIsToken0 ? tokenGot : wethLeft,
      amount0Min: 0n, amount1Min: 0n, recipient: w.address, deadline: Math.floor(Date.now() / 1000) + 600,
    };
    const sim = await npm.mint.staticCall(params);
    if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil");
    const tx = await npm.mint(params, await overrides());
    const rc = await tx.wait();
    let tokenId = null;
    for (const lg of rc.logs) if (lg.address.toLowerCase() === C.positionManager.toLowerCase() && lg.topics.length === 4) tokenId = BigInt(lg.topics[3]).toString();

    // Cost basis = WETH sisi-WETH yang KEPAKAI + seluruh WETH yang dibelanjain buat token
    // (token hampir habis kepakai karena kita sengaja swap 98%). Ini termasuk fee swap → jujur.
    const wethUsed = wethIsToken0 ? sim.amount0 : sim.amount1;
    const costBasis = wethUsed + wethToSwap;
    if (tokenId) saveDeposit(tokenId, costBasis, { entryMcap: mcapOf(tickNow), mode: "inrange" });
    return {
      tokenId, txHash: tx.hash, wrapHash: wrapTx?.hash, swapHash: sw.tx, mode: "inrange",
      tickLower, tickUpper, tick: tickNow, entryMcap: mcapOf(tickNow),
      swappedPct: Math.round(frac * 100), depositEth: ethers.formatEther(costBasis),
      side: "IN RANGE — langsung makan fee (≈" + Math.round(frac * 100) + "% modal jadi token)",
      liquidity: sim.liquidity.toString(), attempt: 1,
    };
  }

  // ══════════ MODE SINGLE-SIDE (default) ══════════
  // Range single-sided dengan BUFFER (biar harga tidak keburu nembus sebelum tx landing).
  // Buffer dinaikkan tiap retry kalau tx revert (token volatil).
  let lastErr = null;
  for (let attempt = 0, buf = cfg.lp.rangeBufferSpacings || 2; attempt < 3; attempt++, buf += 2) {
    const tickNow = Number((await pc.slot0()).tick); // tick FRESH tiap percobaan
    let tickLower, tickUpper;
    if (wethIsToken0) { tickLower = (Math.floor(tickNow / sp) + buf) * sp; tickUpper = tickLower + widthTicks; }
    else { tickUpper = (Math.floor(tickNow / sp) - buf + 1) * sp; tickLower = tickUpper - widthTicks; }
    const params = {
      token0: st.token0, token1: st.token1, fee: st.fee, tickLower, tickUpper,
      amount0Desired: wethIsToken0 ? depositAmt : 0n, amount1Desired: wethIsToken0 ? 0n : depositAmt,
      amount0Min: 0n, amount1Min: 0n, recipient: w.address, deadline: Math.floor(Date.now() / 1000) + 600,
    };
    try {
      const sim = await npm.mint.staticCall(params); // simulasi murni — TANPA gasPrice (biar RPC nggak cek saldo gas)
      if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil");
      const tx = await npm.mint(params, await overrides());
      const rc = await tx.wait();
      let tokenId = null;
      for (const lg of rc.logs) if (lg.address.toLowerCase() === C.positionManager.toLowerCase() && lg.topics.length === 4) tokenId = BigInt(lg.topics[3]).toString();
      // entry MCAP (token yg bukan WETH, di tick saat mint)
      const tokMeta = wethIsToken0 ? m1 : m0;
      const px = await ethUsd().catch(() => 0);
      const entryMcap = tokenPriceEthAtTick(tickNow, wethIsToken0, m0.decimals, m1.decimals) * px * tokMeta.supplyUi;
      if (tokenId) saveDeposit(tokenId, depositAmt, { entryMcap });
      return { tokenId, txHash: tx.hash, wrapHash: wrapTx?.hash, tickLower, tickUpper, tick: tickNow, entryMcap, depositEth: ethers.formatEther(depositAmt), side: wethIsToken0 ? "ETH nunggu → beli token pas MCAP turun" : "ETH nunggu → beli token pas MCAP naik", liquidity: sim.liquidity.toString(), attempt: attempt + 1 };
    } catch (e) {
      lastErr = e;
      // harga nembus range saat tx landing → lebarin buffer, coba lagi
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    }
  }
  throw new Error(`mint gagal 3×: ${String(lastErr?.shortMessage || lastErr?.message || "").slice(0, 100)}`);
}

// ══ LEDGER: riwayat PERMANEN tiap posisi yang di-close ══
// positions.json cuma nyimpen posisi HIDUP (record dihapus pas close), jadi riwayat
// butuh file sendiri. Sekali ditulis, nggak pernah dihapus.
const LEDGER_FILE = path.join(DIR, "lp-ledger.json");
export function readLedger() {
  try { const d = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); return Array.isArray(d.entries) ? d.entries : []; }
  catch { return []; }
}
function appendLedger(entry) {
  const entries = readLedger();
  entries.push(entry);
  fs.writeFileSync(LEDGER_FILE, JSON.stringify({ entries }, null, 2));
}
/**
 * Ringkasan PnL posisi LP yang udah ditutup.
 * pnlEth   = REALIZED — ETH yang beneran balik ke tangan.
 * unsoldEth = token yang masih nyangkut, dinilai harga jual sekarang (BELUM realized).
 * Sengaja dipisah: kalau digabung, posisi yg tokennya nyangkut keliatan impas padahal belum.
 */
export function ledgerSummary() {
  const e = readLedger().filter((x) => x.pnlEth != null);
  const wins = e.filter((x) => x.pnlEth > 0).length;
  const sum = (k) => e.reduce((s, x) => s + (x[k] || 0), 0);
  return {
    count: e.length, wins, losses: e.length - wins,
    winRate: e.length ? (wins / e.length) * 100 : 0,
    pnlEth: sum("pnlEth"), pnlUsd: sum("pnlUsd"),
    depEth: sum("depEth"), feeEth: sum("feeEth"),
    unsoldEth: sum("unsoldEth"),
  };
}

/**
 * REKONSTRUKSI ledger dari on-chain (Blockscout + RPC). Dipakai buat posisi lama
 * yang ditutup sebelum bot punya ledger.
 *
 * Sumber kebenaran = event NPM (bukan tebakan):
 *   IncreaseLiquidity(tokenId, liq, amount0, amount1)  → MODAL yang masuk
 *   DecreaseLiquidity(tokenId, liq, amount0, amount1)  → principal yang ditarik
 *   Collect(tokenId, recipient, amount0, amount1)      → principal + fee yang beneran keluar
 *   fee = Collect − Decrease
 *
 * Token yang balik pas close: kalau di-swap ke WETH (tx ke SwapRouter) → itu realized.
 * Kalau nggak pernah dijual → dinilai pakai QUOTE SEKARANG, dan ditandai (belum realized).
 */
const NPM_EVENTS = new ethers.Interface([
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
]);
// lazy: ROUTER_ABI dideklarasi di bawah (TDZ kalau dipanggil di sini)
let _routerIface = null;
const routerIface = () => (_routerIface ??= new ethers.Interface(ROUTER_ABI));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export async function backfillLedger(onProgress = () => {}) {
  const w = wallet();
  const NPM_L = C.positionManager.toLowerCase();
  const RT_L = C.swapRouter02.toLowerCase();
  const WETH_L = C.weth.toLowerCase();

  const tl = await bsFetch(`/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`);
  const txs = (tl?.result || []).filter((t) => t.isError !== "1");
  const npmTxs = txs.filter((t) => t.to?.toLowerCase() === NPM_L);
  const rtTxs = txs.filter((t) => t.to?.toLowerCase() === RT_L);
  onProgress(`scan ${npmTxs.length} tx LP + ${rtTxs.length} tx swap…`);

  // ── 1. baca event NPM per tx ──
  const P = {}; // tokenId → agregat
  const touch = (id) => (P[id] = P[id] || { id, inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n, pool: null, openedAt: null, closedAt: null });

  let done = 0;
  await mapLimit(npmTxs, 6, async (t) => {
    const lg = await fetch(`${BLOCKSCOUT}/api/v2/transactions/${t.hash}/logs`, { signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => null);
    if (++done % 30 === 0) onProgress(`baca event… ${done}/${npmTxs.length}`);
    const ts = Number(t.timeStamp) * 1000;
    for (const l of (lg?.items || [])) {
      const addr = l.address?.hash?.toLowerCase();
      // Transfer WETH → tujuannya = alamat POOL. Dipakai buat tau pool tiap posisi.
      let ev = null;
      if (addr === NPM_L) { try { ev = NPM_EVENTS.parseLog({ topics: (l.topics || []).filter(Boolean), data: l.data }); } catch { /* event lain */ } }
      if (!ev) continue;
      const id = ev.args.tokenId.toString();
      const p = touch(id);
      if (ev.name === "IncreaseLiquidity") { p.inc0 += ev.args.amount0; p.inc1 += ev.args.amount1; p.openedAt ??= ts; }
      if (ev.name === "DecreaseLiquidity") { p.dec0 += ev.args.amount0; p.dec1 += ev.args.amount1; p.closedAt = ts; }
      if (ev.name === "Collect") { p.col0 += ev.args.amount0; p.col1 += ev.args.amount1; p.closedAt = ts; }
    }
    // pool: dari Transfer WETH ke pool di tx mint
    for (const l of (lg?.items || [])) {
      if (l.address?.hash?.toLowerCase() !== WETH_L) continue;
      const to = l.topics?.[2] ? "0x" + l.topics[2].slice(26) : null;
      if (to && to.toLowerCase() !== NPM_L && to.toLowerCase() !== w.address.toLowerCase()) {
        for (const id of Object.keys(P)) if (!P[id].pool && P[id].openedAt === ts) P[id].pool = ethers.getAddress(to);
      }
    }
  });

  // ── 2. swap token→WETH: realized value dari token yang balik ──
  const swaps = [];
  await mapLimit(rtTxs, 4, async (t) => {
    let dec = null;
    try { dec = routerIface().parseTransaction({ data: t.input }); } catch { return; }
    if (dec?.name !== "exactInputSingle") return;
    const a = dec.args[0];
    const lg = await fetch(`${BLOCKSCOUT}/api/v2/transactions/${t.hash}/logs`, { signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => null);
    let out = 0n;
    for (const l of (lg?.items || [])) { // WETH Transfer masuk ke wallet = hasil swap
      if (l.address?.hash?.toLowerCase() !== WETH_L) continue;
      const to = l.topics?.[2] ? "0x" + l.topics[2].slice(26) : null;
      if (to?.toLowerCase() === w.address.toLowerCase()) out += BigInt(l.data);
    }
    swaps.push({ ts: Number(t.timeStamp) * 1000, tokenIn: a.tokenIn.toLowerCase(), amountIn: a.amountIn, wethOut: out });
  });

  // ── 3. rakit entry per posisi ──
  const ids = Object.keys(P).filter((id) => P[id].closedAt && P[id].col0 + P[id].col1 > 0n);
  onProgress(`nilai ${ids.length} posisi tertutup…`);

  // 3a. data mentah dulu (token yang balik BELUM dinilai)
  const raws = [];
  for (const id of ids.sort((a, b) => P[a].closedAt - P[b].closedAt)) {
    const p = P[id];
    if (!p.pool) continue;
    let t0, t1;
    try { const pc = new ethers.Contract(p.pool, POOL_ABI, provider); [t0, t1] = await Promise.all([pc.token0(), pc.token1()]); } catch { continue; }
    const wethIs0 = t0.toLowerCase() === WETH_L;
    const tokAddr = ethers.getAddress(wethIs0 ? t1 : t0);
    const tm = await tokenMeta(tokAddr).catch(() => ({ symbol: "?", decimals: 18 }));
    const depWei = wethIs0 ? p.inc0 : p.inc1;             // modal WETH masuk
    const tokInRaw = wethIs0 ? p.inc1 : p.inc0;            // token ikut masuk (mode in-range)
    const outWei = wethIs0 ? p.col0 : p.col1;             // WETH keluar (principal + fee)
    const tokOutRaw = wethIs0 ? p.col1 : p.col0;           // token balik pas close
    const feeWei = wethIs0 ? p.col0 - p.dec0 : p.col1 - p.dec1; // Collect − Decrease = fee
    if (depWei === 0n && tokInRaw === 0n) continue;
    raws.push({ id, p, tokAddr, tm, depWei, tokInRaw, outWei, tokOutRaw, feeWei });
  }

  /**
   * 3b. Nilai token yang balik — PER TOKEN (kolam), bukan per posisi.
   *
   * Kenapa bukan per posisi: auto-swap pas close jual SELURUH saldo token di dompet,
   * termasuk sisa dari close sebelumnya. Jadi nggak ada pasangan 1:1 "swap ini punya
   * posisi itu". Nebak lewat kecocokan waktu bikin SALAH — kejadian di DATABEAR:
   * ditulis $5 nyangkut, padahal saldo asli cuma $0.43.
   *
   * Yang bener, kolam per token lalu bagi proporsional:
   *   T = Σ token yang balik dari semua close token ini
   *   W = Σ ETH hasil semua swap token ini          (realized)
   *   V = nilai jual SALDO DOMPET SEKARANG          (unrealized — fakta, bukan tebakan)
   *   posisi ke-i: realized = W·(tokOut_i/T)   nyangkut = V·(tokOut_i/T)
   */
  const byToken = {};
  for (const r of raws) {
    if (r.tokOutRaw <= 0n) continue;
    const k = r.tokAddr.toLowerCase();
    byToken[k] = byToken[k] || { addr: r.tokAddr, dec: r.tm.decimals, totalOut: 0n, wethFromSwaps: 0, leftRaw: 0n, leftEth: 0 };
    byToken[k].totalOut += r.tokOutRaw;
  }
  for (const k of Object.keys(byToken)) {
    const t = byToken[k];
    t.wethFromSwaps = swaps.filter((s) => s.tokenIn === k).reduce((a, s) => a + Number(ethers.formatEther(s.wethOut)), 0);
    t.leftRaw = await tokenBalanceRaw(t.addr).catch(() => 0n);   // ← saldo ASLI di dompet
    t.leftEth = t.leftRaw > 0n ? (await quoteTokenToWeth(t.addr, t.leftRaw).catch(() => ({ weth: 0 }))).weth : 0;
  }

  const entries = [];
  for (const r of raws) {
    const t = byToken[r.tokAddr.toLowerCase()];
    const share = t && t.totalOut > 0n ? Number(r.tokOutRaw) / Number(t.totalOut) : 0;
    const realizedTok = t ? t.wethFromSwaps * share : 0;   // token yang udah jadi ETH
    const leftEth = t ? t.leftEth * share : 0;             // token yang masih nyangkut

    // PnL = ETH yang BENERAN balik ke tangan. Token belum dijual TIDAK dihitung di sini
    // — itu unrealized, dilaporin terpisah biar nggak nyamar jadi "impas".
    const depEth = Number(ethers.formatEther(r.depWei));
    const outEth = Number(ethers.formatEther(r.outWei)) + realizedTok;
    const pnlEth = depEth > 0 ? outEth - depEth : null;

    entries.push({
      tokenId: r.id, sym: r.tm.symbol, mode: r.tokInRaw > 0n ? "inrange" : "single",
      openedAt: r.p.openedAt, closedAt: r.p.closedAt,
      heldMs: r.p.openedAt && r.p.closedAt ? r.p.closedAt - r.p.openedAt : null,
      depEth, outEth, feeEth: Number(ethers.formatEther(r.feeWei > 0n ? r.feeWei : 0n)),
      pnlEth, pnlPct: depEth > 0 ? (pnlEth / depEth) * 100 : null,
      pnlUsd: null, ethUsdAtClose: null,
      tokenKept: t && t.leftRaw > 0n ? Number(ethers.formatUnits(t.leftRaw, r.tm.decimals)) * share : 0,
      tokenRug: 0,
      unsoldEth: leftEth,
      source: "onchain",
    });
  }

  // harga ETH: chain ini baru, nggak ada harga historis di Blockscout (historic_exchange_rate = null).
  // Jadi PnL USD pakai harga SEKARANG — cukup akurat karena semua posisi < 2 hari.
  const px = await ethUsd().catch(() => 0);
  for (const e of entries) { if (e.pnlEth != null && px) { e.pnlUsd = e.pnlEth * px; e.ethUsdAtClose = px; } }

  // Merge: entry dari bot (source undefined) MENANG — dia punya data paling akurat.
  const existing = readLedger();
  const byId = new Map(entries.map((e) => [e.tokenId, e]));
  for (const e of existing) byId.set(e.tokenId, e);
  const merged = [...byId.values()].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  fs.writeFileSync(LEDGER_FILE, JSON.stringify({ entries: merged }, null, 2));
  return { rebuilt: entries.length, total: merged.length };
}

// ── Simpan nilai deposit per posisi (buat hitung PnL) ──
const POS_FILE = path.join(DIR, "positions.json");
export function saveDeposit(tokenId, depositWethWei, extra = {}) {
  let d = {}; try { d = JSON.parse(fs.readFileSync(POS_FILE, "utf8")); } catch { /* baru */ }
  d[String(tokenId)] = { depositWeth: depositWethWei.toString(), ts: Date.now(), ...extra };
  fs.writeFileSync(POS_FILE, JSON.stringify(d, null, 2));
}
function loadDeposit(tokenId) {
  try { return JSON.parse(fs.readFileSync(POS_FILE, "utf8"))[String(tokenId)]; } catch { return null; }
}

// Jumlah token0/token1 dalam posisi sekarang (float, cukup buat display).
function positionAmounts(liquidity, sqrtP96, tickLower, tickUpper) {
  const L = Number(liquidity);
  const sqrtP = Number(sqrtP96) / 2 ** 96;
  const sqrtA = Math.pow(1.0001, tickLower / 2);
  const sqrtB = Math.pow(1.0001, tickUpper / 2);
  const sc = Math.min(Math.max(sqrtP, sqrtA), sqrtB);
  const amount0 = L * (sqrtB - sc) / (sc * sqrtB);
  const amount1 = L * (sc - sqrtA);
  return { amount0, amount1, price01: sqrtP * sqrtP }; // price01 = token1_raw per token0_raw
}

// Preview MCAP range SEBELUM mint (buat layar konfirmasi).
export async function previewRange(tokenAddr, poolAddr, mode = "single") {
  const st = await poolState(poolAddr, tokenAddr);
  const weth = C.weth.toLowerCase();
  const wethIs0 = st.token0.toLowerCase() === weth;
  const [m0, m1] = await Promise.all([tokenMeta(st.token0), tokenMeta(st.token1)]);
  const sp = st.spacing;
  const widthTicks = Math.max(sp, Math.round(Math.log(1 + cfg.lp.widthPct / 100) / Math.log(1.0001) / sp) * sp);
  const buf = cfg.lp.rangeBufferSpacings || 2;
  let tl, tu, swapPct = 0;
  if (mode === "inrange") {
    const half = Math.max(sp, Math.round(widthTicks / 2 / sp) * sp);
    const anchor = Math.floor(st.tick / sp) * sp;
    tl = anchor - half; tu = anchor + half;
    swapPct = Math.round(swapFractionForRange(st.tick, tl, tu, wethIs0) * 0.98 * 100);
  } else if (wethIs0) { tl = (Math.floor(st.tick / sp) + buf) * sp; tu = tl + widthTicks; }
  else { tu = (Math.floor(st.tick / sp) - buf + 1) * sp; tl = tu - widthTicks; }
  const px = await ethUsd().catch(() => 0);
  const tokMeta = wethIs0 ? m1 : m0;
  const mcapAt = (t) => tokenPriceEthAtTick(t, wethIs0, m0.decimals, m1.decimals) * px * tokMeta.supplyUi;
  const mLo = mcapAt(tl), mHi = mcapAt(tu);
  return { mcapNow: mcapAt(st.tick), rangeMcapLow: Math.min(mLo, mHi), rangeMcapHigh: Math.max(mLo, mHi), tickLower: tl, tickUpper: tu, tick: st.tick, swapPct, mode };
}

/**
 * Waktu mint asli dari on-chain (Blockscout) — buat posisi yang dibuka MANUAL di web Uniswap,
 * jadi nggak ada catatannya di positions.json. Hasilnya di-cache ke positions.json (mintTs)
 * biar nggak nembak API tiap /list.
 */
const _mintTs = new Map();
export async function mintTimestamp(tokenId) {
  const key = String(tokenId);
  if (_mintTs.has(key)) return _mintTs.get(key);
  const cached = loadDeposit(tokenId)?.mintTs;
  if (cached) { _mintTs.set(key, cached); return cached; }
  try {
    const r = await fetch(`${BLOCKSCOUT}/api/v2/tokens/${C.positionManager}/instances/${key}/transfers`, { signal: AbortSignal.timeout(10_000) }).then((x) => x.json());
    // transfer paling awal yg from = 0x0 → itu mint-nya
    const mint = (r.items || []).filter((i) => /^0x0{40}$/i.test(i.from?.hash || "")).pop() || (r.items || []).pop();
    const ts = mint?.timestamp ? new Date(mint.timestamp).getTime() : null;
    if (ts) {
      _mintTs.set(key, ts);
      // simpen ke positions.json tanpa ngerusak record yg udah ada
      let d = {}; try { d = JSON.parse(fs.readFileSync(POS_FILE, "utf8")); } catch { /* */ }
      d[key] = { ...(d[key] || {}), mintTs: ts };
      fs.writeFileSync(POS_FILE, JSON.stringify(d, null, 2));
    }
    return ts;
  } catch { return null; }
}

export async function listPositions() {
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, provider);
  const npmW = new ethers.Contract(C.positionManager, NPM_ABI, w); // buat collect.staticCall (fee)
  const n = Number(await npm.balanceOf(w.address).catch(() => 0n));
  const rows = [];
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const MAX = (1n << 128n) - 1n;
  for (let i = 0; i < n; i++) {
    try {
      const id = await npm.tokenOfOwnerByIndex(w.address, i);
      const p = await npm.positions(id);
      if (p.liquidity === 0n) continue;
      const pool = await factory.getPool(p.token0, p.token1, p.fee);
      const pc = new ethers.Contract(pool, POOL_ABI, provider);
      const slot0 = await pc.slot0();
      const tick = Number(slot0.tick);
      const tl = Number(p.tickLower), tu = Number(p.tickUpper);
      const inRange = tick >= tl && tick < tu;
      const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);

      const wethIs0 = p.token0.toLowerCase() === wethL;
      // NILAI PERSIS SEPERTI CLOSE: principal via decreaseLiquidity.staticCall, fee via collect.staticCall
      let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
      try { const d = await npmW.decreaseLiquidity.staticCall({ tokenId: id, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: Math.floor(Date.now() / 1000) + 600 }); pr0 = d[0]; pr1 = d[1]; } catch { /* */ }
      try { const fr = await npmW.collect.staticCall({ tokenId: id, recipient: w.address, amount0Max: MAX, amount1Max: MAX }); fe0 = fr[0]; fe1 = fr[1]; } catch { /* */ }
      const wethRaw = wethIs0 ? (pr0 + fe0) : (pr1 + fe1);
      const tokRaw = wethIs0 ? (pr1 + fe1) : (pr0 + fe0);
      const feeTokRaw = wethIs0 ? fe1 : fe0;
      const wethEth = Number(ethers.formatEther(wethRaw));
      // TOKEN dinilai HARGA JUAL ASLI (quote), bukan mid-price
      let tokEth = 0;
      if (tokRaw > 0n) tokEth = (await quoteTokenToWeth(wethIs0 ? p.token1 : p.token0, tokRaw).catch(() => ({ weth: 0 }))).weth;
      const valEth = wethEth + tokEth; // TOTAL yg beneran ketarik kalau close sekarang
      const feeEth = Number(ethers.formatEther(wethIs0 ? fe0 : fe1)) + (tokRaw > 0n ? tokEth * (Number(feeTokRaw) / Number(tokRaw)) : 0);
      const dep = loadDeposit(id);
      const depEth = dep ? Number(ethers.formatEther(dep.depositWeth)) : null;
      const pnlEth = depEth != null ? (valEth - depEth) : null; // valEth udah termasuk fee
      const pnlPct = depEth ? (pnlEth / depEth) * 100 : null;
      const amt = { price01: (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2 }; // buat MCAP di bawah
      // ── MCAP: token yg bukan WETH ──
      const px = await ethUsd().catch(() => 0);
      const tokMeta = wethIs0 ? m1 : m0;
      const mcapAt = (t) => tokenPriceEthAtTick(t, wethIs0, m0.decimals, m1.decimals) * px * tokMeta.supplyUi;
      const mcapNow = mcapAt(tick);
      const mLo = mcapAt(tl), mHi = mcapAt(tu);
      const rangeMcapLow = Math.min(mLo, mHi), rangeMcapHigh = Math.max(mLo, mHi);
      const entryMcap = dep?.entryMcap ?? null;
      // umur: catatan bot dulu; kalau kosong (posisi dibuka manual) → tarik dari on-chain
      const openedAt = dep?.ts ?? (await mintTimestamp(id));
      rows.push({
        tokenId: id.toString(), token0: m0.symbol, token1: m1.symbol, tokenSym: tokMeta.symbol, fee: Number(p.fee), inRange, tick, tickLower: tl, tickUpper: tu,
        valEth, feeEth, depEth, pnlEth, pnlPct,
        mcapNow, rangeMcapLow, rangeMcapHigh, entryMcap,
        openedAt, ageMs: openedAt ? Date.now() - openedAt : null,
        ageSource: dep?.ts ? "bot" : (openedAt ? "onchain" : null),
        mode: dep?.mode || "single",
      });
    } catch { /* skip posisi bermasalah */ }
  }
  return rows;
}

export async function closePosition(tokenId, opts = {}) {
  const swapToken = opts.swapToken !== false && cfg.lp.autoSwapOnClose !== false;
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const p = await npm.positions(tokenId);
  const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const pool = await factory.getPool(p.token0, p.token1, p.fee);
  const slot0 = await new ethers.Contract(pool, POOL_ABI, provider).slot0();
  const MAX = (1n << 128n) - 1n;

  // ── nilai yang bakal ditarik (principal + fee) dalam ETH, SEBELUM close ──
  const amt = positionAmounts(p.liquidity, slot0.sqrtPriceX96, Number(p.tickLower), Number(p.tickUpper));
  let a0 = amt.amount0 / 10 ** m0.decimals, a1 = amt.amount1 / 10 ** m1.decimals;
  let fe0 = 0, fe1 = 0; // fee belum diklaim (buat ledger)
  try { const fr = await npm.collect.staticCall({ tokenId, recipient: w.address, amount0Max: MAX, amount1Max: MAX }); fe0 = Number(fr[0]) / 10 ** m0.decimals; fe1 = Number(fr[1]) / 10 ** m1.decimals; a0 += fe0; a1 += fe1; } catch { /* */ }
  const wethIs0 = p.token0.toLowerCase() === wethL;
  const pHuman = amt.price01 * 10 ** (m0.decimals - m1.decimals);
  const valEth = wethIs0 ? (a0 + (pHuman ? a1 / pHuman : 0)) : (a1 + a0 * pHuman);
  const dep = loadDeposit(tokenId);
  const depEth = dep ? Number(ethers.formatEther(dep.depositWeth)) : null;
  const pnlEth = depEth != null ? valEth - depEth : null;
  const pnlPct = depEth ? (pnlEth / depEth) * 100 : null;

  const deadline = Math.floor(Date.now() / 1000) + 600;
  let decreaseHash = null;
  if (p.liquidity > 0n) {
    const dtx = await npm.decreaseLiquidity({ tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline }, await overrides());
    await dtx.wait(); decreaseHash = dtx.hash;
  }
  const ctx = await npm.collect({ tokenId, recipient: w.address, amount0Max: MAX, amount1Max: MAX }, await overrides());
  await ctx.wait();
  let burnHash = null;
  try { const btx = await npm.burn(tokenId, await overrides()); await btx.wait(); burnHash = btx.hash; } catch { /* dust */ }

  // ── AUTO-SWAP token → ETH (timeout biar close nggak ngegantung) ──
  const tokenMint = wethIs0 ? p.token1 : p.token0;
  const tokDec = wethIs0 ? m1.decimals : m0.decimals;
  let swapHash = null, swappedWeth = 0, tokenStuck = 0, tokenSellEth = 0;
  const raw = await tokenBalanceRaw(tokenMint).catch(() => 0n);
  if (raw > 0n) {
    // nilai jual token SELALU dihitung (biar PnL bener walau swap gagal/timeout)
    tokenSellEth = (await quoteTokenToWeth(tokenMint, raw).catch(() => ({ weth: 0 }))).weth;
    if (swapToken) {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 60_000));
      try { const sw = await Promise.race([swapTokenToWeth(tokenMint, raw), timeout]); swapHash = sw.tx; swappedWeth = sw.wethOut; }
      catch { tokenStuck = Number(ethers.formatUnits(raw, tokDec)); }
    } else { tokenStuck = Number(ethers.formatUnits(raw, tokDec)); } // user pilih SIMPEN token
  }
  // PnL RIIL: WETH ketarik + (hasil swap ATAU nilai jual token yg masih dipegang)
  const realOutEth = (wethIs0 ? a0 : a1) + (swappedWeth > 0 ? swappedWeth : tokenSellEth);
  const pnlEthReal = depEth != null ? realOutEth - depEth : pnlEth;
  const pnlPctReal = depEth ? (pnlEthReal / depEth) * 100 : pnlPct;

  try { const d = JSON.parse(fs.readFileSync(POS_FILE, "utf8")); delete d[String(tokenId)]; fs.writeFileSync(POS_FILE, JSON.stringify(d, null, 2)); } catch { /* */ }

  // ── AUTO TOP-UP gas: jaga ETH native ke target (buat bot arbitrage / tx berikutnya) ──
  let topUp = null;
  try { topUp = await ensureNativeEth(cfg.lp.nativeTargetEth); } catch { /* non-blocking */ }

  const openedAt = dep?.ts ?? dep?.mintTs ?? null;
  const heldMs = openedAt ? Date.now() - openedAt : null;
  const tokSym = wethIs0 ? m1.symbol : m0.symbol;

  // ── Catat ke LEDGER (permanen). Harga ETH dikunci di harga SAAT CLOSE — kalau
  //    dihitung ulang pakai harga sekarang, PnL USD lama bakal berubah sendiri. ──
  const pxClose = await ethUsd().catch(() => 0);
  try {
    appendLedger({
      tokenId: String(tokenId), sym: tokSym, mode: dep?.mode || "single",
      openedAt, closedAt: Date.now(), heldMs,
      depEth, outEth: realOutEth, feeEth: wethIs0 ? fe0 + (pHuman ? fe1 / pHuman : 0) : fe1 + fe0 * pHuman,
      pnlEth: pnlEthReal, pnlPct: pnlPctReal,
      pnlUsd: pnlEthReal != null && pxClose ? pnlEthReal * pxClose : null,
      ethUsdAtClose: pxClose || null,
      entryMcap: dep?.entryMcap ?? null,
      tokenKept: !swapToken && tokenStuck > 0 ? tokenStuck : 0,
      tokenRug: swapToken && tokenStuck > 0 ? tokenStuck : 0, // swap diminta tapi gagal → rug/pool kering
    });
  } catch { /* ledger gagal ≠ close gagal */ }

  return {
    heldMs,
    decreaseHash, collectHash: ctx.hash, burnHash, swapHash, topUp,
    wethSym: wethIs0 ? m0.symbol : m1.symbol, tokenSym: tokSym,
    recvWeth: wethIs0 ? a0 : a1, recvToken: wethIs0 ? a1 : a0, swappedWeth, tokenStuck,
    valEth: realOutEth, depEth, pnlEth: pnlEthReal, pnlPct: pnlPctReal,
  };
}

// Harga ETH/USD (cache 60s) — multi-fallback biar tahan blokir jaringan.
let _ethUsd = { v: 0, at: 0 };
export async function ethUsd() {
  if (_ethUsd.v && Date.now() - _ethUsd.at < 60_000) return _ethUsd.v;
  const srcs = [
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j.ethereum?.usd],
    ["https://coins.llama.fi/prices/current/coingecko:ethereum", (j) => j.coins?.["coingecko:ethereum"]?.price],
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => Number(j.data?.amount)],
  ];
  for (const [url, pick] of srcs) {
    try {
      const j = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      const p = Number(pick(j));
      if (p > 0) { _ethUsd = { v: p, at: Date.now() }; return p; }
    } catch { /* coba sumber berikut */ }
  }
  return _ethUsd.v || 0; // fallback: harga lama / 0
}

// ── PnL SEUMUR HIDUP via Blockscout (Alchemy free tier blok getLogs > 10 blok) ──
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
async function bsFetch(pathq) {
  const r = await fetch(`${BLOCKSCOUT}${pathq}`, { signal: AbortSignal.timeout(20_000) });
  return r.json();
}

const _isContract = new Map();
async function isContract(addr) {
  const a = addr.toLowerCase();
  if (_isContract.has(a)) return _isContract.get(a);
  let r = false;
  try { r = (await provider.getCode(a)) !== "0x"; } catch { /* */ }
  _isContract.set(a, r);
  return r;
}

export async function lifetimePnl() {
  const w = wallet();
  const W = w.address.toLowerCase();
  const wethL = C.weth.toLowerCase();
  const px = await ethUsd().catch(() => 0);

  // ── MODAL ASLI: transfer dari/ke EOA luar (bukan kontrak LP/WETH/wrap) ──
  // native (txlist) + WETH (tokentx). Counterparty EOA = funding/withdrawal beneran.
  const [txl, tt] = await Promise.all([
    bsFetch(`/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`),
    bsFetch(`/api?module=account&action=tokentx&address=${w.address}&contractaddress=${C.weth}&startblock=0&endblock=99999999&sort=asc`),
  ]);
  let capIn = 0, capOut = 0;
  const consider = [];
  for (const t of (txl.result || [])) { const v = Number(t.value) / 1e18; if (v > 0) consider.push({ from: t.from, to: t.to, v }); }
  for (const t of (tt.result || [])) { const v = Number(t.value) / 1e18; if (v > 0) consider.push({ from: t.from, to: t.to, v }); }
  for (const c of consider) {
    const incoming = c.to.toLowerCase() === W;
    const other = incoming ? c.from : c.to;
    if (other.toLowerCase() === wethL) continue;          // wrap/unwrap internal
    if (await isContract(other)) continue;                 // NPM/pool/router internal
    if (incoming) capIn += c.v; else capOut += c.v;        // EOA = modal beneran
  }
  const netCapEth = capIn - capOut;                         // modal bersih yg lu masukin

  // ── NILAI SEKARANG: native + WETH + semua token DINILAI VIA QUOTE JUAL ASLI ──
  // (Blockscout rate sering 0 walau pool masih ada likuiditas — pakai Quoter yg riil)
  const tk = await bsFetch(`/api/v2/addresses/${w.address}/tokens`);
  let wethHeld = 0, tokensEth = 0, graveyardCount = 0;
  const graveyard = [];
  for (const it of (tk.items || [])) {
    const t = it.token; const dec = Number(t.decimals || 18);
    const bal = Number(it.value) / 10 ** dec;
    if (t.address_hash?.toLowerCase() === wethL) { wethHeld = bal; continue; }
    if (bal <= 0) continue;
    // nilai jual RIIL (quote token→WETH). Kalau 0 = beneran rug (pool kering).
    let sellEth = 0;
    try { sellEth = (await quoteTokenToWeth(t.address_hash, BigInt(it.value))).weth; } catch { /* rug */ }
    tokensEth += sellEth;
    if (sellEth * (px || 0) < 1) { graveyardCount++; if (graveyard.length < 12) graveyard.push(t.symbol || "?"); }
  }
  const tokensUsd = tokensEth * px;
  const nativeEth = Number(ethers.formatEther(await provider.getBalance(w.address)));
  let openLpEth = 0;
  try { for (const r of await listPositions()) openLpEth += (r.valEth || 0) + (r.feeEth || 0); } catch { /* */ }
  const valueNowEth = nativeEth + wethHeld + tokensEth + openLpEth;

  const pnlEth = valueNowEth - netCapEth;
  return {
    px, capIn, capOut, netCapEth,
    nativeEth, wethHeld, tokensUsd, graveyardCount, graveyard,
    openLpEth, valueNowEth, pnlEth, pnlUsd: pnlEth * px,
  };
}

// Quote JUAL beneran: token → WETH lewat pool. Coba semua fee tier, ambil terbaik.
// Return { weth (ETH float), fee } atau { weth:0 } kalau nggak ada likuiditas (rug asli).
const QUOTER_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"];
const ROUTER_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
/**
 * Jaga saldo ETH NATIVE minimal `target` — unwrap WETH secukupnya kalau kurang.
 * Dipanggil otomatis abis close (biar gas selalu ada, mis. buat bot arbitrage).
 * @returns {unwrapped (ETH), tx} atau null kalau nggak perlu / WETH nggak cukup.
 */
export const DEFAULT_NATIVE_TARGET = 0.015;
export async function ensureNativeEth(targetEth) {
  // Default keras: kalau config ke-timpa/kosong, fitur ini TETAP hidup (jangan diem-diem mati).
  const target = Number(targetEth ?? cfg.lp.nativeTargetEth ?? DEFAULT_NATIVE_TARGET);
  if (!(target > 0)) return null;
  const w = wallet();
  // SEMUA hitungan di BigInt (wei). Lewat float → toFixed bisa bulet NAIK beberapa wei
  // di atas saldo asli → withdraw revert "burn amount exceeds balance".
  const targetWei = ethers.parseEther(String(target));
  const nativeWei = await provider.getBalance(w.address);
  if (nativeWei >= targetWei) return null; // udah cukup
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbalWei = await wc.balanceOf(w.address);
  if (wbalWei <= 0n) return null;
  const needWei = targetWei - nativeWei;
  const amtWei = needWei < wbalWei ? needWei : wbalWei; // ambil sebisanya, jangan lebih dari saldo
  if (amtWei < 10_000_000_000_000n) return null; // < 0.00001 ETH → receh, nggak worth gas
  const tx = await wc.withdraw(amtWei, await overrides());
  await tx.wait();
  const f = (v) => Number(ethers.formatEther(v));
  return { unwrapped: f(amtWei), tx: tx.hash, nativeBefore: f(nativeWei), nativeAfter: f(nativeWei + amtWei) };
}

// Saldo mentah (BigInt) sebuah token di wallet.
export async function tokenBalanceRaw(tokenAddr) {
  try { return await new ethers.Contract(tokenAddr, ERC20, provider).balanceOf(wallet().address); }
  catch { return 0n; }
}
export async function quoteTokenToWeth(tokenAddr, amountRaw) {
  if (amountRaw <= 0n) return { weth: 0, fee: 0 };
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  let best = { weth: 0, fee: 0 };
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle.staticCall({ tokenIn: tokenAddr, tokenOut: C.weth, amountIn: amountRaw, fee, sqrtPriceLimitX96: 0n });
      const weth = Number(ethers.formatEther(r[0]));
      if (weth > best.weth) best = { weth, fee };
    } catch { /* pool fee ini tak ada */ }
  }
  return best;
}
// Swap token → WETH beneran (SwapRouter02), slippage dari config.
export async function swapTokenToWeth(tokenAddr, amountRaw, fee) {
  const w = wallet();
  const erc = new ethers.Contract(tokenAddr, ERC20, w);
  if ((await erc.allowance(w.address, C.swapRouter02)) < amountRaw) {
    await (await erc.approve(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const q = await quoteTokenToWeth(tokenAddr, amountRaw);
  const minOut = ethers.parseEther(String(q.weth * (1 - (cfg.lp.slippagePct || 5) / 100)).slice(0, 18) || "0");
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  const tx = await router.exactInputSingle({ tokenIn: tokenAddr, tokenOut: C.weth, fee: fee || q.fee || 10000, recipient: w.address, amountIn: amountRaw, amountOutMinimum: minOut > 0n ? minOut : 0n, sqrtPriceLimitX96: 0n }, await overrides());
  await tx.wait();
  return { tx: tx.hash, wethOut: q.weth };
}

// Swap WETH → token (arah sebalik swapTokenToWeth). Dipakai mode IN-RANGE.
export async function swapWethToToken(tokenAddr, wethRaw, fee) {
  const w = wallet();
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  if ((await wc.allowance(w.address, C.swapRouter02)) < wethRaw) {
    await (await wc.approve(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const erc = new ethers.Contract(tokenAddr, ERC20, provider);
  const before = await erc.balanceOf(w.address);
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  // amountOutMinimum 0: harga token pool ini emang liar, kita batasi risiko lewat ukuran swap
  const tx = await router.exactInputSingle({ tokenIn: C.weth, tokenOut: tokenAddr, fee, recipient: w.address, amountIn: wethRaw, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }, await overrides());
  await tx.wait();
  const after = await erc.balanceOf(w.address);
  return { tx: tx.hash, tokenOut: after - before };
}

/**
 * Rasio WETH:token yang dibutuhkan supaya range [tl,tu] yang MENYEBERANGI harga bisa terisi penuh.
 * Balikin fraksi WETH yang harus di-swap jadi token (0..1).
 *   amount0 = L·(√B−√P)/(√P·√B)   amount1 = L·(√P−√A)
 * Nilai semuanya didenominasi ke token0, lalu ambil porsi token lawan.
 */
function swapFractionForRange(tick, tickLower, tickUpper, wethIsToken0) {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return wethIsToken0 ? 0 : 1;   // harga di bawah range → butuh token0 doang
  if (sP >= sB) return wethIsToken0 ? 1 : 0;   // harga di atas range → butuh token1 doang
  const a0 = (sB - sP) / (sP * sB);            // unit token0 per L
  const a1in0 = (sP - sA) / (sP * sP);         // unit token1 per L, dinilai dalam token0
  const fracToken1 = a1in0 / (a0 + a1in0);
  const f = wethIsToken0 ? fracToken1 : 1 - fracToken1; // porsi WETH yang jadi token lawan
  return Math.min(0.95, Math.max(0.02, f));
}

// Jual SEMUA token nyangkut (selain WETH) → ETH. Skip yg rug (pool kering).
export async function sellAllTokens(onProgress) {
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const tk = await bsFetch(`/api/v2/addresses/${w.address}/tokens`);
  const px = await ethUsd().catch(() => 0);
  let soldEth = 0, sold = 0, skipped = 0;
  for (const it of (tk.items || [])) {
    const t = it.token;
    if (t.type !== "ERC-20" || t.address_hash.toLowerCase() === wethL) continue;
    const raw = BigInt(it.value);
    if (raw <= 0n) continue;
    const q = await quoteTokenToWeth(t.address_hash, raw).catch(() => ({ weth: 0, fee: 0 }));
    if (q.weth * px < 0.05) { skipped++; continue; } // < $0.05 = rug, skip (nggak worth gas)
    try {
      const sw = await Promise.race([swapTokenToWeth(t.address_hash, raw, q.fee), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 60_000))]);
      soldEth += sw.wethOut; sold++;
      onProgress?.(`✅ ${t.symbol} → +${sw.wethOut.toFixed(6)} WETH ($${(sw.wethOut * px).toFixed(2)})`);
    } catch { onProgress?.(`⚠️ ${t.symbol} gagal (${(q.weth * px).toFixed(2)}$) — skip`); skipped++; }
  }
  return { soldEth, soldUsd: soldEth * px, sold, skipped, px };
}

export async function balances() {
  const w = wallet();
  const eth = await provider.getBalance(w.address);
  const wc = new ethers.Contract(C.weth, ERC20, provider);
  const weth = await wc.balanceOf(w.address).catch(() => 0n);
  return { address: w.address, eth: ethers.formatEther(eth), weth: ethers.formatEther(weth) };
}
