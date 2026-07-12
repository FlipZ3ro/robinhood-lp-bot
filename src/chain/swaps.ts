/**
 * Quotes + swaps. Every swap carries slippage protection derived from the Quoter —
 * including WETH→token (the old build sent amountOutMinimum: 0, i.e. a free sandwich on
 * a thin chain). We don't use smart-order-router: Robinhood Chain has no subgraph, so
 * we route single-hop through each fee tier and take the best quote.
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { ERC20_ABI, WETH_ABI, QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { logger } from "../util/log.js";
import type { TopUp } from "../types.js";

const log = logger("swap");

/** Raw token balance (BigInt) of the bot wallet. */
export async function tokenBalanceRaw(tokenAddr: string): Promise<bigint> {
  try {
    return await new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf!(wallet().address);
  } catch {
    return 0n;
  }
}

export interface Quote {
  weth: number;
  fee: number;
  amountOut: bigint;
}

/** Best token→WETH quote across all fee tiers. { weth: 0 } means no liquidity (rug). */
export async function quoteTokenToWeth(tokenAddr: string, amountRaw: bigint): Promise<Quote> {
  if (amountRaw <= 0n) return { weth: 0, fee: 0, amountOut: 0n };
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  let best: Quote = { weth: 0, fee: 0, amountOut: 0n };
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: tokenAddr,
        tokenOut: C.weth,
        amountIn: amountRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      const weth = Number(ethers.formatEther(out));
      if (weth > best.weth) best = { weth, fee, amountOut: out };
    } catch {
      /* pool for this fee tier doesn't exist */
    }
  }
  return best;
}

/** Best WETH→token quote across all fee tiers. */
export async function quoteWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  feeHint?: number,
): Promise<{ amountOut: bigint; fee: number }> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  const tiers = feeHint ? [feeHint] : cfg.lp.feeTiers;
  let best = { amountOut: 0n, fee: feeHint ?? 0 };
  for (const fee of tiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: C.weth,
        tokenOut: tokenAddr,
        amountIn: wethRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      if (out > best.amountOut) best = { amountOut: out, fee };
    } catch {
      /* no pool this tier */
    }
  }
  return best;
}

function minOutWithSlippage(amountOut: bigint): bigint {
  const bps = BigInt(Math.round((cfg.lp.slippagePct || 5) * 100)); // e.g. 5% → 500 bps
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export interface SwapResult {
  tx: string;
  amountOut: bigint;
}

/** Swap token → WETH with slippage protection. */
export async function swapTokenToWeth(
  tokenAddr: string,
  amountRaw: bigint,
  feeHint?: number,
): Promise<SwapResult> {
  const w = wallet();
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.swapRouter02)) < amountRaw) {
    await (await erc.approve!(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const quote = await quoteTokenToWeth(tokenAddr, amountRaw);
  const fee = feeHint || quote.fee || 10000;
  const minOut = minOutWithSlippage(quote.amountOut);
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  const tx = await router.exactInputSingle!(
    {
      tokenIn: tokenAddr,
      tokenOut: C.weth,
      fee,
      recipient: w.address,
      amountIn: amountRaw,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    },
    await overrides(),
  );
  const rc = await tx.wait();
  return { tx: tx.hash, amountOut: extractWethOut(rc, w.address) ?? quote.amountOut };
}

/** Swap WETH → token with slippage protection (was unprotected in v1). */
export async function swapWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  fee: number,
): Promise<SwapResult> {
  const w = wallet();
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  if ((await wc.allowance!(w.address, C.swapRouter02)) < wethRaw) {
    await (await wc.approve!(C.swapRouter02, ethers.MaxUint256, await overrides())).wait();
  }
  const quote = await quoteWethToToken(tokenAddr, wethRaw, fee);
  const minOut = minOutWithSlippage(quote.amountOut);
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const before: bigint = await erc.balanceOf!(w.address);
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  const tx = await router.exactInputSingle!(
    {
      tokenIn: C.weth,
      tokenOut: tokenAddr,
      fee,
      recipient: w.address,
      amountIn: wethRaw,
      amountOutMinimum: minOut, // ← slippage floor, no longer 0
      sqrtPriceLimitX96: 0n,
    },
    await overrides(),
  );
  await tx.wait();
  const after: bigint = await erc.balanceOf!(w.address);
  return { tx: tx.hash, amountOut: after - before };
}

/** Sum of WETH Transfer events into `to` in a receipt (real swap output). */
function extractWethOut(rc: ethers.TransactionReceipt | null, to: string): bigint | null {
  if (!rc) return null;
  const wethL = C.weth.toLowerCase();
  const toTopic = "0x" + to.toLowerCase().slice(2).padStart(64, "0");
  let sum = 0n;
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() !== wethL) continue;
    if (lg.topics.length === 3 && lg.topics[2]?.toLowerCase() === toTopic) sum += BigInt(lg.data);
  }
  return sum > 0n ? sum : null;
}

/**
 * Keep native ETH at >= target by unwrapping WETH. Called after close so gas is always
 * available for the next tx. All math in wei (BigInt) — going through float can round a
 * few wei above the real balance → withdraw reverts "burn amount exceeds balance".
 */
export const DEFAULT_NATIVE_TARGET = 0.015;
export async function ensureNativeEth(targetEth?: number): Promise<TopUp | null> {
  const target = Number(targetEth ?? cfg.lp.nativeTargetEth ?? DEFAULT_NATIVE_TARGET);
  if (!(target > 0)) return null;
  const w = wallet();
  const targetWei = ethers.parseEther(String(target));
  const nativeWei = await provider.getBalance(w.address);
  if (nativeWei >= targetWei) return null;
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbalWei: bigint = await wc.balanceOf!(w.address);
  if (wbalWei <= 0n) return null;
  const needWei = targetWei - nativeWei;
  const amtWei = needWei < wbalWei ? needWei : wbalWei;
  if (amtWei < 10_000_000_000_000n) return null; // < 0.00001 ETH: not worth the gas
  const tx = await wc.withdraw!(amtWei, await overrides());
  await tx.wait();
  const f = (v: bigint) => Number(ethers.formatEther(v));
  log.info(`top-up gas: unwrap ${f(amtWei)} WETH → native`);
  return {
    unwrapped: f(amtWei),
    tx: tx.hash,
    nativeBefore: f(nativeWei),
    nativeAfter: f(nativeWei + amtWei),
  };
}
