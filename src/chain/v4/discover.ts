/**
 * v4 pool discovery via PoolManager `Initialize` events (authoritative). Robinhood v4 pools
 * use ARBITRARY fees (0%, 4%, 4.8%, 40%, 89%, dynamic…) and non-uniform tickSpacing, so the
 * old fixed fee-tier + tickSpacing=fee/50 probe missed most pools. Reading Initialize events
 * gives the EXACT PoolKey (fee, tickSpacing, hooks, poolId) for every pool of a token; we
 * then verify each is live + liquid via StateView. Falls back to the probe if events fail.
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { provider, logsProvider } from "../client.js";
import { mapLimit } from "../blockscout.js";
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

// PoolKey caches. The EXPENSIVE part of discovery is the full-range getLogs (fromBlock=0 over a 26M
// block chain); the PoolKeys it returns are PERMANENT on-chain (only liquidity/price move). So cache
// the discovered keys per token and run getLogs at most once per TTL window — subsequent calls just
// re-verify via the cheap StateView (getSlot0/getLiquidity). This slashes the hunt scanner's sustained
// getLogs load (8 tokens × 3 queries every 3m) that spiked RPC latency and made a concurrent "Cari
// pool" getLogs time out → false "no pool" (ROBIN). Keyed by token addr (lowercased).
type KeyRec = { keys: Array<{ pk: PoolKey; poolId: string }>; at: number };
const ethKeyCache = new Map<string, KeyRec>();
const usdKeyCache = new Map<string, KeyRec>();
const KEY_TTL_MS = 30 * 60_000; // re-scan getLogs for NEW pools every 30 min

/**
 * Initialize logs via the RPC provider (eth_getLogs) instead of the Blockscout REST API.
 * WHY: the bot's background scans (hunt every 3m + /list + manage) saturate Blockscout's public
 * rate limit, so its getLogs started returning `{status:"0","Too many requests"}` — which the old
 * code read as an empty result = a FALSE "no pool" (e.g. ROBIN, which has a live ROBIN/USDG 8% pool).
 * The RPC is the paid endpoint the bot already uses for everything else (separate quota) and answers
 * a token-topic-filtered full-range query in ~0.3s. `topics` is the ethers filter array:
 *   [INITIALIZE_TOPIC, null, null, tokenTopic]  → token = currency1
 *   [INITIALIZE_TOPIC, null, tokenTopic]        → token = currency0
 * Falls back to chunked windows if an RPC caps the block range/result set for a huge history.
 */
async function rpcInitLogs(topics: (string | null)[]): Promise<readonly ethers.Log[]> {
  const pm = C.v4PoolManager;
  if (!pm) return [];
  // dedicated logs RPC first, then the main provider (covers a down/throttled logs key)
  const provs = logsProvider === provider ? [provider] : [logsProvider, provider];
  for (const prov of provs) {
    try {
      return await prov.getLogs({ address: pm, topics, fromBlock: 0, toBlock: "latest" });
    } catch {
      /* try the next provider */
    }
  }
  {
    // every full-range attempt failed (RPC range/result cap?) → scan latest→0 in windows on the main RPC
    try {
      const latest = await provider.getBlockNumber();
      const SPAN = 5_000_000;
      const out: ethers.Log[] = [];
      for (let hi = latest; hi >= 0; hi -= SPAN) {
        const lo = Math.max(0, hi - SPAN + 1);
        const part = await provider.getLogs({ address: pm, topics, fromBlock: lo, toBlock: hi }).catch(() => [] as ethers.Log[]);
        out.push(...part);
      }
      return out;
    } catch {
      return [];
    }
  }
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // canonical, deployed on Robinhood
const MC3_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];

/**
 * Verify PoolKeys are live (price > 0) and return them with liquidity. BATCHES getSlot0 + getLiquidity
 * through Multicall3 — 1 eth_call per ~40 pools instead of 2 RPC round-trips PER pool. A token with
 * 40-120 micro-pools used to fire 80-240 individual reads that stalled under RPC contention (the "scan
 * pool lama / RPC lambat" the operator hit). Falls back to per-pool reads if a Multicall3 batch reverts.
 */
async function verify(sv: ethers.Contract, keys: Array<{ pk: PoolKey; poolId: string }>, quote: "eth" | "usd" = "eth"): Promise<V4Pool[]> {
  if (!keys.length) return [];
  const svAddr = C.v4StateView!;
  const iface = sv.interface;
  const mc = new ethers.Contract(MULTICALL3, MC3_ABI, provider);
  const out: V4Pool[] = [];
  const CHUNK = 40; // 40 pools = 80 sub-calls per multicall (safe eth_call size)
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const calls = slice.flatMap(({ poolId }) => [
      { target: svAddr, allowFailure: true, callData: iface.encodeFunctionData("getSlot0", [poolId]) },
      { target: svAddr, allowFailure: true, callData: iface.encodeFunctionData("getLiquidity", [poolId]) },
    ]);
    let res: Array<{ success: boolean; returnData: string }>;
    try {
      res = await mc.aggregate3!(calls);
    } catch {
      out.push(...(await verifyIndividual(sv, slice, quote))); // batch reverted → per-pool
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const { pk, poolId } = slice[j]!;
      const s0r = res[j * 2];
      if (!s0r?.success) continue;
      try {
        const d = iface.decodeFunctionResult("getSlot0", s0r.returnData);
        const sqrtPriceX96 = BigInt(d[0]);
        if (!(sqrtPriceX96 > 0n)) continue;
        const lqr = res[j * 2 + 1];
        const liquidity = lqr?.success ? BigInt(iface.decodeFunctionResult("getLiquidity", lqr.returnData)[0]) : 0n;
        out.push({ poolKey: pk, poolId, fee: pk.fee, tickSpacing: pk.tickSpacing, sqrtPriceX96, tick: Number(d[1]), liquidity, lpFee: Number(d[3]), quote });
      } catch {
        /* skip a pool whose result won't decode */
      }
    }
  }
  return out;
}

/** Per-pool fallback for verify() when a Multicall3 batch reverts. */
async function verifyIndividual(sv: ethers.Contract, keys: Array<{ pk: PoolKey; poolId: string }>, quote: "eth" | "usd"): Promise<V4Pool[]> {
  const out = await mapLimit(keys, 10, async ({ pk, poolId }): Promise<V4Pool | null> => {
    try {
      const s0 = await sv.getSlot0!(poolId);
      if (!(s0.sqrtPriceX96 > 0n)) return null;
      const liquidity: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
      return { poolKey: pk, poolId, fee: pk.fee, tickSpacing: pk.tickSpacing, sqrtPriceX96: s0.sqrtPriceX96, tick: Number(s0.tick), liquidity, lpFee: Number(s0.lpFee), quote };
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
  const tL = t.toLowerCase();
  const tokTopic = "0x" + t.slice(2).toLowerCase().padStart(64, "0");
  const pm = C.v4PoolManager;
  if (!pm) return [];

  // cache-first: reuse discovered PoolKeys (permanent) and re-verify liquidity via the cheap StateView,
  // skipping the costly full-range getLogs. Only re-getLogs after the TTL (to pick up new pools).
  const ck = ethKeyCache.get(tL);
  if (ck && Date.now() - ck.at < KEY_TTL_MS) {
    const pools = await verify(sv, ck.keys);
    if (pools.length) {
      v4EthCache.set(tL, pools);
      return pools;
    }
  }

  // Initialize events where currency1 = token. Native-ETH pools sort native (0x0) to
  // currency0, so the token is always currency1 for the pools we LP into.
  const items = await rpcInitLogs([INITIALIZE_TOPIC, null, null, tokTopic]);

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
    const capped = keys.slice(-120);
    if (capped.length) ethKeyCache.set(tL, { keys: capped, at: Date.now() }); // cache keys for reuse
    const pools = await verify(sv, capped);
    if (pools.length) {
      v4EthCache.set(tL, pools);
      return pools;
    }
  }

  // getLogs failed / empty → serve the last-good cache before falling back to a thin fixed-tier probe
  // (which would drop most real pools).
  const cached = v4EthCache.get(tL);
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
  // cache-first (see discoverV4Pools): re-verify cached keys via StateView, skip the costly getLogs
  const ck = usdKeyCache.get(tL);
  if (ck && Date.now() - ck.at < KEY_TTL_MS) {
    const pools = await verify(sv, ck.keys, "usd");
    if (pools.length) {
      v4UsdCache.set(tL, pools);
      return pools;
    }
  }
  const seen = new Set<string>();
  const keys: Array<{ pk: PoolKey; poolId: string }> = [];
  // token can be currency0 (topics[2]) OR currency1 (topics[3]); keep only the pools whose OTHER side
  // is USDG. Both queries via the RPC (Blockscout's rate limit made this return empty = false "no pool").
  const logSets = await Promise.all([
    rpcInitLogs([INITIALIZE_TOPIC, null, tk]),
    rpcInitLogs([INITIALIZE_TOPIC, null, null, tk]),
  ]);
  for (const items of logSets) {
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
  const capped = keys.slice(-120);
  if (capped.length) usdKeyCache.set(tL, { keys: capped, at: Date.now() }); // cache keys for reuse
  const pools = await verify(sv, capped, "usd");
  if (pools.length) {
    v4UsdCache.set(tL, pools);
    return pools;
  }
  return v4UsdCache.get(tL) ?? pools; // getLogs hiccup → last-good discovery (don't vanish)
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
  const logSets = await Promise.all([
    rpcInitLogs([INITIALIZE_TOPIC, null, tk]),
    rpcInitLogs([INITIALIZE_TOPIC, null, null, tk]),
  ]);
  for (const items of logSets) {
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
