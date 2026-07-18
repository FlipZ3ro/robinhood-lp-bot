/**
 * Permanent closed-position ledger (data/lp-ledger.json) + on-chain reconstruction.
 *
 * positions.json only holds LIVE positions (deleted on close), so history needs its own
 * file. Once written, an entry is never deleted. backfillLedger() rebuilds history for
 * positions closed before the bot had a ledger, straight from NPM events — the source of
 * truth, not a guess.
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { POOL_ABI, NPM_EVENTS_ABI, ROUTER_ABI } from "./abis.js";
import { tokenMeta } from "./tokens.js";
import { quoteTokenToWeth, tokenBalanceRaw } from "./swaps.js";
import { ethUsd } from "./price.js";
import { bsFetch, blockscout, mapLimit } from "./blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import type { LedgerEntry } from "../types.js";

const LEDGER_FILE = dataPath("lp-ledger.json");

export function readLedger(): LedgerEntry[] {
  const d = readJson<{ entries?: LedgerEntry[] }>(LEDGER_FILE, {});
  return Array.isArray(d.entries) ? d.entries : [];
}
export function appendLedger(entry: LedgerEntry): void {
  const entries = readLedger();
  entries.push(entry);
  writeJson(LEDGER_FILE, { entries });
}
export function writeLedger(entries: LedgerEntry[]): void {
  writeJson(LEDGER_FILE, { entries });
}

export interface LedgerSummary {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlEth: number;
  pnlUsd: number;
  depEth: number;
  feeEth: number;
  unsoldEth: number;
}

export function ledgerSummary(): LedgerSummary {
  const e = readLedger().filter((x) => x.pnlEth != null);
  const wins = e.filter((x) => (x.pnlEth ?? 0) > 0).length;
  const sum = (k: keyof LedgerEntry) => e.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  return {
    count: e.length,
    wins,
    losses: e.length - wins,
    winRate: e.length ? (wins / e.length) * 100 : 0,
    pnlEth: sum("pnlEth"),
    pnlUsd: sum("pnlUsd"),
    depEth: sum("depEth"),
    feeEth: sum("feeEth"),
    unsoldEth: sum("unsoldEth"),
  };
}

const NPM_EVENTS = new ethers.Interface(NPM_EVENTS_ABI);
const ROUTER_IFACE = new ethers.Interface(ROUTER_ABI);

interface Agg {
  id: string;
  inc0: bigint; inc1: bigint;
  dec0: bigint; dec1: bigint;
  col0: bigint; col1: bigint;
  pool: string | null;
  openedAt: number | null;
  closedAt: number | null;
}

/** Rebuild the ledger from on-chain events. See module header for the accounting model. */
export async function backfillLedger(onProgress: (msg: string) => void = () => {}): Promise<{ rebuilt: number; total: number }> {
  const w = wallet();
  const NPM_L = C.positionManager.toLowerCase();
  const RT_L = C.swapRouter02.toLowerCase();
  const WETH_L = C.weth.toLowerCase();

  const tl = await bsFetch<{ result?: any[] }>(
    `/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`,
  );
  const txs = (tl?.result ?? []).filter((t) => t.isError !== "1");
  const npmTxs = txs.filter((t) => t.to?.toLowerCase() === NPM_L);
  const rtTxs = txs.filter((t) => t.to?.toLowerCase() === RT_L);
  onProgress(`scan ${npmTxs.length} tx LP + ${rtTxs.length} tx swap…`);

  const P: Record<string, Agg> = {};
  const touch = (id: string): Agg =>
    (P[id] ??= { id, inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n, pool: null, openedAt: null, closedAt: null });

  let done = 0;
  await mapLimit(npmTxs, 6, async (t) => {
    const lg: any = await fetch(`${blockscout}/api/v2/transactions/${t.hash}/logs`, {
      signal: AbortSignal.timeout(20_000),
    }).then((x) => x.json()).catch(() => null);
    if (++done % 30 === 0) onProgress(`baca event… ${done}/${npmTxs.length}`);
    const ts = Number(t.timeStamp) * 1000;
    for (const l of lg?.items ?? []) {
      if (l.address?.hash?.toLowerCase() !== NPM_L) continue;
      let ev: ethers.LogDescription | null = null;
      try {
        ev = NPM_EVENTS.parseLog({ topics: (l.topics || []).filter(Boolean), data: l.data });
      } catch {
        continue;
      }
      if (!ev) continue;
      const id = ev.args.tokenId.toString();
      const p = touch(id);
      if (ev.name === "IncreaseLiquidity") { p.inc0 += ev.args.amount0; p.inc1 += ev.args.amount1; p.openedAt ??= ts; }
      if (ev.name === "DecreaseLiquidity") { p.dec0 += ev.args.amount0; p.dec1 += ev.args.amount1; p.closedAt = ts; }
      if (ev.name === "Collect") { p.col0 += ev.args.amount0; p.col1 += ev.args.amount1; p.closedAt = ts; }
    }
    // pool = WETH Transfer destination in the mint tx
    for (const l of lg?.items ?? []) {
      if (l.address?.hash?.toLowerCase() !== WETH_L) continue;
      const to = l.topics?.[2] ? "0x" + l.topics[2].slice(26) : null;
      if (to && to.toLowerCase() !== NPM_L && to.toLowerCase() !== w.address.toLowerCase()) {
        for (const id of Object.keys(P)) if (!P[id]!.pool && P[id]!.openedAt === ts) P[id]!.pool = ethers.getAddress(to);
      }
    }
  });

  // Early exit: no CLOSED LP positions → skip the (potentially huge) swap scan.
  // A wallet reused from an arb bot has thousands of swaps but no LP closes; without this
  // the swap loop below would fetch logs for every one of them and effectively hang.
  const hasClosed = Object.keys(P).some((id) => P[id]!.closedAt && P[id]!.col0 + P[id]!.col1 > 0n);
  if (!hasClosed) {
    const existing = readLedger();
    return { rebuilt: 0, total: existing.length };
  }

  // swaps token→WETH (realized value of returned token). Cap to recent txs — only swaps of
  // the closed positions' tokens matter, and those are near the closes (recent).
  const rtRecent = rtTxs.slice(-500);
  const swaps: Array<{ ts: number; tokenIn: string; wethOut: bigint }> = [];
  await mapLimit(rtRecent, 4, async (t) => {
    let dec: ethers.TransactionDescription | null = null;
    try {
      dec = ROUTER_IFACE.parseTransaction({ data: t.input });
    } catch {
      return;
    }
    if (dec?.name !== "exactInputSingle") return;
    const a = dec.args[0];
    const lg: any = await fetch(`${blockscout}/api/v2/transactions/${t.hash}/logs`, {
      signal: AbortSignal.timeout(20_000),
    }).then((x) => x.json()).catch(() => null);
    let out = 0n;
    for (const l of lg?.items ?? []) {
      if (l.address?.hash?.toLowerCase() !== WETH_L) continue;
      const to = l.topics?.[2] ? "0x" + l.topics[2].slice(26) : null;
      if (to?.toLowerCase() === w.address.toLowerCase()) out += BigInt(l.data);
    }
    swaps.push({ ts: Number(t.timeStamp) * 1000, tokenIn: a.tokenIn.toLowerCase(), wethOut: out });
  });

  const ids = Object.keys(P).filter((id) => P[id]!.closedAt && P[id]!.col0 + P[id]!.col1 > 0n);
  onProgress(`nilai ${ids.length} posisi tertutup…`);

  interface Raw {
    id: string; p: Agg; tokAddr: string; tm: { symbol: string; decimals: number };
    depWei: bigint; tokInRaw: bigint; outWei: bigint; tokOutRaw: bigint; feeWei: bigint;
  }
  const raws: Raw[] = [];
  for (const id of ids.sort((a, b) => (P[a]!.closedAt! - P[b]!.closedAt!))) {
    const p = P[id]!;
    if (!p.pool) continue;
    let t0: string, t1: string;
    try {
      const pc = new ethers.Contract(p.pool, POOL_ABI, provider);
      [t0, t1] = await Promise.all([pc.token0!(), pc.token1!()]);
    } catch {
      continue;
    }
    const wethIs0 = t0.toLowerCase() === WETH_L;
    const tokAddr = ethers.getAddress(wethIs0 ? t1 : t0);
    const tm = await tokenMeta(tokAddr).catch(() => ({ symbol: "?", decimals: 18 }));
    const depWei = wethIs0 ? p.inc0 : p.inc1;
    const tokInRaw = wethIs0 ? p.inc1 : p.inc0;
    const outWei = wethIs0 ? p.col0 : p.col1;
    const tokOutRaw = wethIs0 ? p.col1 : p.col0;
    const feeWei = wethIs0 ? p.col0 - p.dec0 : p.col1 - p.dec1;
    if (depWei === 0n && tokInRaw === 0n) continue;
    raws.push({ id, p, tokAddr, tm, depWei, tokInRaw, outWei, tokOutRaw, feeWei });
  }

  // value returned token PER TOKEN (pooled), not per position — auto-swap on close sells
  // the whole wallet balance, so there's no 1:1 pairing. Split proportionally.
  const byToken: Record<string, { addr: string; totalOut: bigint; wethFromSwaps: number; leftEth: number; leftRaw: bigint; dec: number }> = {};
  for (const r of raws) {
    if (r.tokOutRaw <= 0n) continue;
    const k = r.tokAddr.toLowerCase();
    byToken[k] ??= { addr: r.tokAddr, totalOut: 0n, wethFromSwaps: 0, leftEth: 0, leftRaw: 0n, dec: r.tm.decimals };
    byToken[k]!.totalOut += r.tokOutRaw;
  }
  for (const k of Object.keys(byToken)) {
    const t = byToken[k]!;
    t.wethFromSwaps = swaps
      .filter((s) => s.tokenIn === k)
      .reduce((a, s) => a + Number(ethers.formatEther(s.wethOut)), 0);
    t.leftRaw = await tokenBalanceRaw(t.addr).catch(() => 0n);
    t.leftEth = t.leftRaw > 0n ? (await quoteTokenToWeth(t.addr, t.leftRaw).catch(() => ({ weth: 0 }))).weth : 0;
  }

  const entries: LedgerEntry[] = [];
  for (const r of raws) {
    const t = byToken[r.tokAddr.toLowerCase()];
    const share = t && t.totalOut > 0n ? Number(r.tokOutRaw) / Number(t.totalOut) : 0;
    const realizedTok = t ? t.wethFromSwaps * share : 0;
    const leftEth = t ? t.leftEth * share : 0;
    const depEth = Number(ethers.formatEther(r.depWei));
    const outEth = Number(ethers.formatEther(r.outWei)) + realizedTok;
    const pnlEth = depEth > 0 ? outEth - depEth : null;
    entries.push({
      tokenId: r.id,
      sym: r.tm.symbol,
      mode: r.tokInRaw > 0n ? "inrange" : "single",
      openedAt: r.p.openedAt,
      closedAt: r.p.closedAt,
      heldMs: r.p.openedAt && r.p.closedAt ? r.p.closedAt - r.p.openedAt : null,
      depEth,
      outEth,
      feeEth: Number(ethers.formatEther(r.feeWei > 0n ? r.feeWei : 0n)),
      pnlEth,
      pnlPct: depEth > 0 ? (pnlEth! / depEth) * 100 : null,
      pnlUsd: null,
      ethUsdAtClose: null,
      tokenKept: t && t.leftRaw > 0n ? Number(ethers.formatUnits(t.leftRaw, r.tm.decimals)) * share : 0,
      tokenRug: 0,
      unsoldEth: leftEth,
      source: "onchain",
    });
  }

  const px = await ethUsd().catch(() => 0);
  for (const e of entries) {
    if (e.pnlEth != null && px) {
      e.pnlUsd = e.pnlEth * px;
      e.ethUsdAtClose = px;
    }
  }

  // merge: bot-written entries (source undefined) win — they have the most accurate data
  const existing = readLedger();
  const byId = new Map(entries.map((e) => [e.tokenId, e]));
  for (const e of existing) byId.set(e.tokenId, e);
  const merged = [...byId.values()].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  writeJson(LEDGER_FILE, { entries: merged });
  return { rebuilt: entries.length, total: merged.length };
}
