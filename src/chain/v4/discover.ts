/**
 * v4 pool discovery via PoolManager `Initialize` events (authoritative). Robinhood v4 pools
 * use ARBITRARY fees (0%, 4%, 4.8%, 40%, 89%, dynamic…) and non-uniform tickSpacing, so the
 * old fixed fee-tier + tickSpacing=fee/50 probe missed most pools. Reading Initialize events
 * gives the EXACT PoolKey (fee, tickSpacing, hooks, poolId) for every pool of a token; we
 * then verify each is live + liquid via StateView. Falls back to the probe if events fail.
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { provider } from "../client.js";
import { blockscout, mapLimit } from "../blockscout.js";
import { tokenMeta } from "../tokens.js";
import { STATEVIEW_ABI } from "./abis.js";
import { ethPoolKey, computePoolId, NATIVE, V4_FEE_TIERS, type PoolKey } from "./poolkey.js";

const INITIALIZE_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const DYNAMIC_FEE_FLAG = 0x800000; // fee with this bit = dynamic (hook-set) — not LP-able normally
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // Robinhood Chain stable

export interface V4Pool {
  poolKey: PoolKey;
  poolId: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee: number;
  quote: "eth" | "usd"; // what the token is paired against (native ETH vs USDG stable)
}

function stateView(): ethers.Contract {
  if (!C.v4StateView) throw new Error("v4StateView belum diset di config.contracts");
  return new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
}

// Last-good discovery cache. Blockscout getLogs is flaky and intermittently returns empty, which
// makes live pools VANISH from the picker mid-session ("kadang ke-load, kadang enggak"). Once a
// token's pools are discovered we keep serving them until a later successful scan refreshes the set
// — v4 pools persist on-chain, so a frozen set is never wrong, only slightly stale on `liquidity`.
const v4EthCache = new Map<string, V4Pool[]>();
const v4UsdCache = new Map<string, V4Pool[]>();

/** Blockscout getLogs with retry — transient empties/timeouts otherwise wipe the pool list. Fail
 *  FAST (6s, not 20s) so a slow Blockscout doesn't hang "Cari pool" for up to a minute; 2 tries cap
 *  the worst case at ~12s. Empty is still retried (Blockscout returns flaky empties) but only once. */
async function getLogsItems(url: string, tries = 2): Promise<any[]> {
  for (let i = 0; i < tries; i++) {
    try {
      const r: any = await fetch(url, { signal: AbortSignal.timeout(6_000) }).then((x) => x.json());
      const items = Array.isArray(r?.result) ? r.result : [];
      if (items.length) return items;
    } catch {
      /* retry on error/timeout */
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 300));
  }
  return [];
}

/** Verify PoolKeys are live (price > 0) and return them with liquidity. Bounded concurrency
 * so a token with 100+ pools doesn't flood the RPC. */
async function verify(sv: ethers.Contract, keys: Array<{ pk: PoolKey; poolId: string }>, quote: "eth" | "usd" = "eth"): Promise<V4Pool[]> {
  const out = await mapLimit(keys, 10, async ({ pk, poolId }): Promise<V4Pool | null> => {
    try {
      const s0 = await sv.getSlot0!(poolId);
      if (!(s0.sqrtPriceX96 > 0n)) return null;
      const liquidity: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
      return {
        poolKey: pk,
        poolId,
        fee: pk.fee,
        tickSpacing: pk.tickSpacing,
        sqrtPriceX96: s0.sqrtPriceX96,
        tick: Number(s0.tick),
        liquidity,
        lpFee: Number(s0.lpFee),
        quote,
      };
    } catch {
      return null;
    }
  });
  return out.filter((p): p is V4Pool => p !== null);
}

/** All live token/native-ETH v4 pools for a token (via Initialize events). */
export async function discoverV4Pools(token: string): Promise<V4Pool[]> {
  const sv = stateView();
  const t = ethers.getAddress(token);
  const tokTopic = "0x" + t.slice(2).toLowerCase().padStart(64, "0");
  const pm = C.v4PoolManager;
  if (!pm) return [];

  // Initialize events where currency1 = token. Native-ETH pools sort native (0x0) to
  // currency0, so the token is always currency1 for the pools we LP into.
  const url = `${blockscout}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${pm}&topic0=${INITIALIZE_TOPIC}&topic3=${tokTopic}&topic0_3_opr=and`;
  const items = await getLogsItems(url);

  if (items.length) {
    const seen = new Set<string>();
    const keys: Array<{ pk: PoolKey; poolId: string }> = [];
    for (const lg of items) {
      try {
        const currency0 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        if (currency0 !== NATIVE) continue; // only native-ETH pools (LP with ETH)
        const currency1 = ethers.getAddress("0x" + lg.topics[3].slice(26));
        const d: string = lg.data.slice(2);
        const fee = parseInt(d.slice(0, 64), 16);
        const tickSpacing = parseInt(d.slice(64, 128), 16); // int24, always positive here
        const hooks = ethers.getAddress("0x" + d.slice(152, 192));
        // KEEP hooked pools: on Robinhood the DEEPEST pools (lowest price impact) use a standard
        // hook — skipping them missed the best pool to buy/LP into. Only dynamic-fee pools are
        // skipped (their fee isn't known upfront). The real hooks addr rides in the PoolKey.
        if (fee >= DYNAMIC_FEE_FLAG) continue;
        const poolId: string = lg.topics[1];
        if (seen.has(poolId)) continue;
        seen.add(poolId);
        keys.push({ pk: { currency0: NATIVE, currency1, fee, tickSpacing, hooks }, poolId });
      } catch {
        /* skip malformed log */
      }
    }
    // cap at the 120 most-recent pools so a pathological token can't stall discovery
    const pools = await verify(sv, keys.slice(-120));
    if (pools.length) {
      v4EthCache.set(t.toLowerCase(), pools);
      return pools;
    }
  }

  // Blockscout event query failed / empty → serve the last-good cache before falling back to a thin
  // fixed-tier probe (which would drop most real pools).
  const cached = v4EthCache.get(t.toLowerCase());
  if (cached?.length) return cached;
  const probeKeys = V4_FEE_TIERS.map((fee) => {
    const pk = ethPoolKey(t, fee);
    return { pk, poolId: computePoolId(pk) };
  });
  return verify(sv, probeKeys);
}

/** All live token/USDG v4 pools (token can be currency0 OR currency1, USDG is the other side). */
export async function discoverV4UsdgPools(token: string): Promise<V4Pool[]> {
  const pm = C.v4PoolManager;
  if (!pm) return [];
  const sv = stateView();
  const t = ethers.getAddress(token);
  const tL = t.toLowerCase();
  const tk = "0x" + t.slice(2).toLowerCase().padStart(64, "0");
  const usdgL = USDG.toLowerCase();
  const seen = new Set<string>();
  const keys: Array<{ pk: PoolKey; poolId: string }> = [];
  for (const [pos, opr] of [["topic2", "topic0_2_opr"], ["topic3", "topic0_3_opr"]] as const) {
    const url = `${blockscout}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${pm}&topic0=${INITIALIZE_TOPIC}&${pos}=${tk}&${opr}=and`;
    const items = await getLogsItems(url);
    for (const lg of items) {
      try {
        const c0 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        const c1 = ("0x" + lg.topics[3].slice(26)).toLowerCase();
        const other = c0 === tL ? c1 : c0;
        if (other !== usdgL) continue; // token/USDG pools only
        const d: string = lg.data.slice(2);
        const fee = parseInt(d.slice(0, 64), 16);
        const tickSpacing = parseInt(d.slice(64, 128), 16);
        const hooks = ethers.getAddress("0x" + d.slice(152, 192));
        if (fee >= DYNAMIC_FEE_FLAG) continue;
        const poolId: string = lg.topics[1];
        if (seen.has(poolId)) continue;
        seen.add(poolId);
        keys.push({ pk: { currency0: ethers.getAddress(c0), currency1: ethers.getAddress(c1), fee, tickSpacing, hooks }, poolId });
      } catch {
        /* skip */
      }
    }
  }
  const pools = await verify(sv, keys.slice(-120), "usd");
  if (pools.length) {
    v4UsdCache.set(tL, pools);
    return pools;
  }
  return v4UsdCache.get(tL) ?? pools; // Blockscout hiccup → last-good discovery (don't vanish)
}

/**
 * Pick the v4 pool to LP into: highest fee that still has liquidity above the floor
 * (memecoin farming wants high fee, but a pool with no liquidity has no volume to farm).
 */
/**
 * When no ETH-paired pool has liquidity, describe the token's OTHER v4 pools (e.g. token/USDG)
 * so the user understands why it can't be LP'd with ETH. Returns a short summary or null.
 */
export async function nonEthV4Summary(token: string): Promise<string | null> {
  const pm = C.v4PoolManager;
  if (!pm) return null;
  const t = ethers.getAddress(token);
  const tk = "0x" + t.slice(2).toLowerCase().padStart(64, "0");
  const sv = stateView();
  const seen = new Set<string>();
  const found: { quote: string; fee: number }[] = [];
  for (const pos of ["topic2", "topic3"]) {
    const opr = pos === "topic2" ? "topic0_2_opr" : "topic0_3_opr";
    const url = `${blockscout}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${pm}&topic0=${INITIALIZE_TOPIC}&${pos}=${tk}&${opr}=and`;
    let items: any[] = [];
    try {
      const r: any = await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json());
      items = Array.isArray(r?.result) ? r.result : [];
    } catch {
      continue;
    }
    const cand = items
      .map((lg) => {
        const c0 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        const c1 = ("0x" + lg.topics[3].slice(26)).toLowerCase();
        const quote = c0 === t.toLowerCase() ? c1 : c0;
        if (quote === NATIVE) return null; // ETH pools handled elsewhere
        return { poolId: lg.topics[1] as string, quote, fee: parseInt(lg.data.slice(2, 66), 16) };
      })
      .filter(Boolean) as { poolId: string; quote: string; fee: number }[];
    await mapLimit(cand.slice(-60), 8, async (c) => {
      if (seen.has(c.poolId)) return;
      seen.add(c.poolId);
      const liq: bigint = await sv.getLiquidity!(c.poolId).catch(() => 0n);
      if (liq > 0n) found.push({ quote: c.quote, fee: c.fee });
    });
  }
  if (!found.length) return null;
  const quotes = [...new Set(found.map((f) => f.quote))];
  const qsyms = await Promise.all(quotes.slice(0, 3).map((q) => tokenMeta(q).then((m) => m.symbol).catch(() => q.slice(0, 8))));
  const fees = found.map((f) => f.fee).sort((a, b) => a - b);
  const feeRange = `${(fees[0]! / 10000).toFixed(2)}-${(fees[fees.length - 1]! / 10000).toFixed(2)}%`;
  return `${found.length} pool v4 pair ${qsyms.join("/")} (fee ${feeRange}) — bukan ETH`;
}

export function pickV4Pool(pools: V4Pool[], minLiquidity = 1n): V4Pool | null {
  const eligible = pools.filter((p) => p.liquidity >= minLiquidity);
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.fee - a.fee); // highest fee first (farming)
  return eligible[0]!;
}
