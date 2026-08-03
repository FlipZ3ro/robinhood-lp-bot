/**
 * Wallet-level lifetime PnL: net capital deposited vs. total current value.
 *
 * Capital in/out is derived from EOA/bridge transfers. v1 excluded EVERY contract
 * counterparty as "internal" — which wrongly dropped bridge/CEX funding (the way you
 * actually get ETH onto a fresh chain), inflating NET PnL. Here:
 *   • native transfers: only KNOWN LP-machinery contracts are excluded → bridge deposits
 *     (a contract counterparty) correctly count as capital in.
 *   • WETH transfers: any contract counterparty is excluded (those are pools/router).
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { quoteTokenToWeth } from "./swaps.js";
import { ethUsd } from "./price.js";
import { listPositions } from "./positions.js";
import { bsFetch, mapLimit } from "./blockscout.js";

const INTERNAL = new Set(
  [C.positionManager, C.swapRouter02, C.factory, C.quoter, C.weth].map((a) => a.toLowerCase()),
);

const codeCache = new Map<string, boolean>();
async function isContract(addr: string): Promise<boolean> {
  const a = addr.toLowerCase();
  if (codeCache.has(a)) return codeCache.get(a)!;
  let r = false;
  try {
    r = (await provider.getCode(a)) !== "0x";
  } catch {
    /* assume EOA */
  }
  codeCache.set(a, r);
  return r;
}

export interface LifetimePnl {
  px: number;
  capIn: number;
  capOut: number;
  netCapEth: number;
  nativeEth: number;
  wethHeld: number;
  tokensUsd: number;
  graveyardCount: number;
  graveyard: string[];
  openLpEth: number;
  valueNowEth: number;
  pnlEth: number;
  pnlUsd: number;
}

// Cache: /pnl scans thousands of txs on a reused wallet — don't re-run on every tap.
let cache: { v: LifetimePnl; at: number } | null = null;
const CACHE_MS = 120_000;

export async function lifetimePnl(force = false): Promise<LifetimePnl> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.v;
  const w = wallet();
  const W = w.address.toLowerCase();
  const wethL = C.weth.toLowerCase();
  const px = await ethUsd().catch(() => 0);

  const [txl, tt] = await Promise.all([
    bsFetch<{ result?: any[] }>(`/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`),
    bsFetch<{ result?: any[] }>(`/api?module=account&action=tokentx&address=${w.address}&contractaddress=${C.weth}&startblock=0&endblock=99999999&sort=asc`),
  ]);

  let capIn = 0;
  let capOut = 0;
  // native transfers: bridge/CEX (contract) funding counts as capital
  for (const t of txl?.result ?? []) {
    const v = Number(t.value) / 1e18;
    if (v <= 0) continue;
    const incoming = t.to.toLowerCase() === W;
    const other = (incoming ? t.from : t.to).toLowerCase();
    if (INTERNAL.has(other)) continue;
    if (incoming) capIn += v;
    else capOut += v;
  }
  // WETH transfers: only EOA counterparties (pools/router are LP machinery).
  // Warm the isContract cache for all unique counterparties in PARALLEL first, so the
  // loop below hits cache instead of doing sequential getCode round-trips.
  const wethRows = (tt?.result ?? []).filter((t) => Number(t.value) > 0);
  const uniqOthers = [
    ...new Set(
      wethRows
        .map((t) => (t.to.toLowerCase() === W ? t.from : t.to).toLowerCase())
        .filter((o) => !INTERNAL.has(o)),
    ),
  ];
  await Promise.all(uniqOthers.map((a) => isContract(a)));
  for (const t of wethRows) {
    const v = Number(t.value) / 1e18;
    const incoming = t.to.toLowerCase() === W;
    const other = (incoming ? t.from : t.to).toLowerCase();
    if (INTERNAL.has(other)) continue;
    if (await isContract(other)) continue; // cached now
    if (incoming) capIn += v;
    else capOut += v;
  }
  const netCapEth = capIn - capOut;

  // current value: native + WETH + every token valued via real sell quote + open LP
  const tk = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/tokens`);
  let wethHeld = 0;
  let tokensEth = 0;
  let graveyardCount = 0;
  const graveyard: string[] = [];
  // Value held tokens with BOUNDED concurrency. The wallet accumulates dozens of dust tokens from
  // churned positions (50+ here); quoting them ALL at once — each hits 4 fee tiers — fired ~200
  // parallel RPC calls that saturated the RPC AND jammed the event loop, so even the per-quote
  // timeout couldn't fire → /pnl hung ~indefinitely. mapLimit(8) keeps the burst small; the 5s
  // per-quote timeout bounds each rug/honeypot (→ treated as unsellable).
  const valued = await mapLimit(tk?.items ?? [], 8, async (it: any) => {
    const t = it.token;
    const dec = Number(t.decimals || 18);
    const bal = Number(it.value) / 10 ** dec;
    if (t.address_hash?.toLowerCase() === wethL) return { weth: bal, sellEth: 0, sym: "WETH", isWeth: true };
    if (bal <= 0) return null;
    let sellEth = 0;
    try {
      const q = await Promise.race([
        quoteTokenToWeth(t.address_hash, BigInt(it.value)),
        new Promise<{ weth: number }>((_, rej) => setTimeout(() => rej(new Error("quote timeout")), 5000)),
      ]);
      sellEth = q.weth;
    } catch {
      /* rug / honeypot / timeout → unsellable */
    }
    return { weth: 0, sellEth, sym: t.symbol || "?", isWeth: false };
  });
  const graveSeen = new Set<string>();
  for (const r of valued) {
    if (!r) continue;
    if (r.isWeth) {
      wethHeld = r.weth;
      continue;
    }
    tokensEth += r.sellEth;
    // "stuck" = can't be sold for even $1 (rug / no liquidity / honeypot). Dedupe by symbol
    // so two contracts sharing a ticker (e.g. HASH/HASH) count once.
    if (r.sellEth * (px || 0) < 1 && !graveSeen.has(r.sym)) {
      graveSeen.add(r.sym);
      graveyardCount++;
      if (graveyard.length < 12) graveyard.push(r.sym);
    }
  }
  const tokensUsd = tokensEth * px;
  const nativeEth = Number(ethers.formatEther(await provider.getBalance(w.address)));

  let openLpEth = 0;
  try {
    for (const r of await listPositions()) openLpEth += (r.valEth || 0) + (r.feeEth || 0);
  } catch {
    /* leave 0 */
  }
  const valueNowEth = nativeEth + wethHeld + tokensEth + openLpEth;
  const pnlEth = valueNowEth - netCapEth;

  const result: LifetimePnl = {
    px,
    capIn,
    capOut,
    netCapEth,
    nativeEth,
    wethHeld,
    tokensUsd,
    graveyardCount,
    graveyard,
    openLpEth,
    valueNowEth,
    pnlEth,
    pnlUsd: pnlEth * px,
  };
  cache = { v: result, at: Date.now() };
  return result;
}
