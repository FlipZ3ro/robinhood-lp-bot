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
import { STATEVIEW_ABI } from "./abis.js";
import { ethPoolKey, computePoolId, NATIVE, V4_FEE_TIERS, type PoolKey } from "./poolkey.js";

const INITIALIZE_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const DYNAMIC_FEE_FLAG = 0x800000; // fee with this bit = dynamic (hook-set) — not LP-able normally

export interface V4Pool {
  poolKey: PoolKey;
  poolId: string;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee: number;
}

function stateView(): ethers.Contract {
  if (!C.v4StateView) throw new Error("v4StateView belum diset di config.contracts");
  return new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
}

/** Verify PoolKeys are live (price > 0) and return them with liquidity. Bounded concurrency
 * so a token with 100+ pools doesn't flood the RPC. */
async function verify(sv: ethers.Contract, keys: Array<{ pk: PoolKey; poolId: string }>): Promise<V4Pool[]> {
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
  let items: any[] = [];
  try {
    const r: any = await fetch(url, { signal: AbortSignal.timeout(20_000) }).then((x) => x.json());
    items = Array.isArray(r?.result) ? r.result : [];
  } catch {
    /* fall through to probe */
  }

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
        if (hooks.toLowerCase() !== NATIVE) continue; // vanilla pools only (LP-able)
        if (fee >= DYNAMIC_FEE_FLAG) continue; // skip dynamic-fee pools
        const poolId: string = lg.topics[1];
        if (seen.has(poolId)) continue;
        seen.add(poolId);
        keys.push({ pk: { currency0: NATIVE, currency1, fee, tickSpacing, hooks: NATIVE }, poolId });
      } catch {
        /* skip malformed log */
      }
    }
    // cap at the 120 most-recent pools so a pathological token can't stall discovery
    const pools = await verify(sv, keys.slice(-120));
    if (pools.length) return pools;
  }

  // Fallback: probe the common fee tiers (if the event query failed / returned nothing)
  const probeKeys = V4_FEE_TIERS.map((fee) => {
    const pk = ethPoolKey(t, fee);
    return { pk, poolId: computePoolId(pk) };
  });
  return verify(sv, probeKeys);
}

/**
 * Pick the v4 pool to LP into: highest fee that still has liquidity above the floor
 * (memecoin farming wants high fee, but a pool with no liquidity has no volume to farm).
 */
export function pickV4Pool(pools: V4Pool[], minLiquidity = 1n): V4Pool | null {
  const eligible = pools.filter((p) => p.liquidity >= minLiquidity);
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.fee - a.fee); // highest fee first (farming)
  return eligible[0]!;
}
