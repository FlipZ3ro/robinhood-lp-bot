/**
 * Extract Uniswap v3 swap intent from a feed transaction.
 *
 * Only decodes swaps routed through OUR SwapRouter02 (the venue we LP on) — that's where
 * a swap earns fees for our positions. NOTE: on Robinhood Chain most volume flows through
 * other routers/aggregators we can't decode without their ABIs, so feed-derived volume is
 * a LOWER BOUND, best used as a real-time TRIGGER (something is happening on token X now),
 * then confirmed/sized with an on-chain quote.
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import type { FeedTx } from "./decode.js";

const ROUTER_L = C.swapRouter02.toLowerCase();
const WETH_L = C.weth.toLowerCase();

const IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum))",
  "function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum))",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function multicall(bytes32 previousBlockhash, bytes[] data)",
]);

export interface SwapIntent {
  hash: string;
  from: string | null;
  token: string; // the non-WETH token touched
  wethIn: bigint | null; // exact WETH input if the swap is WETH→token; null otherwise
  fee: number | null;
  direction: "buy" | "sell" | "unknown"; // buy = WETH→token, sell = token→WETH
}

/** Returns every WETH-paired Uniswap swap in a feed tx (a multicall may hold several). */
export function extractSwaps(ftx: FeedTx): SwapIntent[] {
  const tx = ftx.tx;
  if (tx.to?.toLowerCase() !== ROUTER_L || !tx.data || tx.data === "0x") return [];
  const out: SwapIntent[] = [];
  decodeCall(tx.data, tx.hash ?? "", tx.from, out);
  return out;
}

function decodeCall(data: string, hash: string, from: string | null, out: SwapIntent[]): void {
  let parsed;
  try {
    parsed = IFACE.parseTransaction({ data });
  } catch {
    return;
  }
  if (!parsed) return;

  if (parsed.name === "multicall") {
    const calls: string[] = parsed.args[parsed.args.length - 1]; // bytes[] is always last
    for (const c of calls) decodeCall(c, hash, from, out);
    return;
  }

  if (parsed.name === "exactInputSingle" || parsed.name === "exactOutputSingle") {
    const p = parsed.args[0];
    const tokenIn = String(p.tokenIn).toLowerCase();
    const tokenOut = String(p.tokenOut).toLowerCase();
    const fee = Number(p.fee);
    pushPair(out, hash, from, tokenIn, tokenOut, fee, parsed.name === "exactInputSingle" ? (p.amountIn as bigint) : null);
    return;
  }

  if (parsed.name === "exactInput" || parsed.name === "exactOutput") {
    const path: string = parsed.args[0].path;
    const { first, last, fee } = firstLastFromPath(path);
    if (first && last) pushPair(out, hash, from, first, last, fee, null);
  }
}

function pushPair(
  out: SwapIntent[],
  hash: string,
  from: string | null,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint | null,
): void {
  const inIsWeth = tokenIn === WETH_L;
  const outIsWeth = tokenOut === WETH_L;
  if (!inIsWeth && !outIsWeth) return; // not a WETH pair — ignore
  out.push({
    hash,
    from,
    token: inIsWeth ? tokenOut : tokenIn,
    wethIn: inIsWeth ? amountIn : null,
    fee,
    direction: inIsWeth ? "buy" : "sell",
  });
}

/** First/last token + first hop fee from a v3 encoded path (20b addr,3b fee,20b addr,…). */
function firstLastFromPath(path: string): { first: string | null; last: string | null; fee: number } {
  const hex = path.startsWith("0x") ? path.slice(2) : path;
  if (hex.length < 2 * (20 + 3 + 20)) return { first: null, last: null, fee: 0 };
  const first = "0x" + hex.slice(0, 40);
  const fee = parseInt(hex.slice(40, 46), 16);
  const last = "0x" + hex.slice(hex.length - 40);
  return { first: first.toLowerCase(), last: last.toLowerCase(), fee };
}
