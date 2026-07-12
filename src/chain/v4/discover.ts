/**
 * v4 pool discovery WITHOUT event scanning: probe StateView for token/native-ETH pools
 * across the known fee tiers (tickSpacing = fee/50, hooks = 0). Returns the live pools with
 * their liquidity so callers can pick by the fee-focus strategy (high fee = memecoin farming).
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { provider } from "../client.js";
import { STATEVIEW_ABI } from "./abis.js";
import { ethPoolKey, computePoolId, V4_FEE_TIERS, type PoolKey } from "./poolkey.js";

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

/** All live token/native-ETH v4 pools for a token, across fee tiers. */
export async function discoverV4Pools(token: string): Promise<V4Pool[]> {
  const sv = stateView();
  const results = await Promise.all(
    V4_FEE_TIERS.map(async (fee): Promise<V4Pool | null> => {
      const poolKey = ethPoolKey(token, fee);
      const poolId = computePoolId(poolKey);
      try {
        const s0 = await sv.getSlot0!(poolId);
        if (!(s0.sqrtPriceX96 > 0n)) return null;
        const liquidity: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
        return {
          poolKey,
          poolId,
          fee,
          tickSpacing: poolKey.tickSpacing,
          sqrtPriceX96: s0.sqrtPriceX96,
          tick: Number(s0.tick),
          liquidity,
          lpFee: Number(s0.lpFee),
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((p): p is V4Pool => p !== null);
}

/**
 * Pick the v4 pool to LP into: highest fee that still has liquidity above the floor
 * (memecoin farming wants high fee, but a pool with no liquidity has no volume to farm).
 * V4_FEE_TIERS is already high→low, so the first match wins.
 */
export function pickV4Pool(pools: V4Pool[], minLiquidity = 1n): V4Pool | null {
  const eligible = pools.filter((p) => p.liquidity >= minLiquidity);
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.fee - a.fee);
  return eligible[0]!;
}
