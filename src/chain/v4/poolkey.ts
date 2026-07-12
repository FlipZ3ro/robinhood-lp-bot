/**
 * Uniswap v4 PoolKey math for Robinhood Chain.
 *
 * On this chain, token pools pair with NATIVE ETH (currency 0x0), not WETH, and use
 * vanilla pools (hooks = 0x0) with the convention tickSpacing = fee / 50 (verified across
 * the live 0.3%/0.5%/3%/5%/10%/59% CASHCAT pools). poolId = keccak256(abi.encode(PoolKey))
 * — verified to match DexScreener's poolId.
 */
import { ethers } from "ethers";

export const NATIVE = "0x0000000000000000000000000000000000000000";
const coder = ethers.AbiCoder.defaultAbiCoder();

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Robinhood launchers use tickSpacing = fee/50 (fee in hundredths of a bip). */
export function tickSpacingForFee(fee: number): number {
  return Math.max(1, Math.floor(fee / 50));
}

export function computePoolId(k: PoolKey): string {
  return ethers.keccak256(
    coder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/** Sort two currencies (0x0 native ETH always sorts first). */
export function sortCurrencies(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/** Vanilla PoolKey for token paired with native ETH at a given fee. */
export function ethPoolKey(token: string, fee: number): PoolKey {
  const t = ethers.getAddress(token);
  const [currency0, currency1] = sortCurrencies(NATIVE, t); // native (0x0) is currency0
  return { currency0, currency1, fee, tickSpacing: tickSpacingForFee(fee), hooks: NATIVE };
}

/** Vanilla PoolKey for token paired with an ERC20 quote (e.g. WETH) at a given fee. */
export function erc20PoolKey(token: string, quote: string, fee: number): PoolKey {
  const [currency0, currency1] = sortCurrencies(ethers.getAddress(token), ethers.getAddress(quote));
  return { currency0, currency1, fee, tickSpacing: tickSpacingForFee(fee), hooks: NATIVE };
}

/** Fee tiers to probe. Ordered high→low so pickers can prefer high-fee (memecoin farming). */
export const V4_FEE_TIERS = [590000, 300000, 250000, 100000, 50000, 30000, 10000, 5000, 3000];
