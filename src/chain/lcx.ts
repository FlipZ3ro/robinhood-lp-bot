/**
 * LCX Liberty DEX client — an OPTIONAL second aggregator, quoted next to KyberSwap on every
 * aggregator swap (see kyberSwap). Off unless LCX_API_KEY is set (free key at
 * https://dex.lcx.com/dashboard · docs https://dex.lcx.com/docs).
 *
 * Flow: POST /quote → POST /build. The calldata is opaque, so a build is only handed back when it
 * passes every gate below; any mismatch = LCX sits this swap out (null) and KyberSwap carries on:
 *   1. tx.to and the approve spender are the PUBLISHED router for this chain (hard-coded, not from env)
 *   2. build is for this chain and the router is deployed there
 *   3. the quote echoes the request: same tokenIn / tokenOut, input amount == amountIn
 *   4. build.minAmountOut == quote.output.minimumAmount (the floor we compare on is the one enforced)
 *   5. tx value == amountIn for native ETH, else 0
 *   6. the CALLDATA itself (checkLcxCalldata): decodes as one of the router's 5 entrypoints and pays
 *      exactly what was asked — recipient = wallet, totalIn = amountIn, same tokens, floor >= quote
 *      floor, matching value, live deadline, and a makerSwap leg only ever targets Bebop
 */
import { ethers } from "ethers";
import { env, cfg } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("lcx");
export const LCX_NATIVE = "0x0000000000000000000000000000000000000000"; // LCX sentinel for native ETH
const API = "https://swap-api.lcx.com/v1";
const MAX_SLIPPAGE_BPS = 2000; // API ceiling

/** Published LCX Liberty DEX router per chain id. Calldata is only ever sent here. */
const ROUTERS: Record<number, string> = {
  4663: "0x0000000000654902B6Ed6cC240cc81CB4c4a3dff", // Robinhood Chain
};

export const lcxRouter = (): string | undefined => ROUTERS[cfg.chainId];
export const lcxEnabled = (): boolean => !!env.lcxKey && !!lcxRouter();

// Router entrypoints (https://dex.lcx.com/docs). On Robinhood Chain the prop-AMM variants are common:
// tokenized-stock routes go through market-maker pools.
const LEGS = "tuple(uint256 amountIn, tuple(uint8 family, address pool, address tokenIn, address tokenOut, uint256 aux)[] hops)[]";
const FEE_ARGS = "tuple(address tokenIn, address tokenOut, uint256 totalIn, uint256 minAmountOut, address recipient, uint256 deadline, address integrator)";
export const LCX_ROUTER_IFACE = new ethers.Interface([
  `function swapSplit(address tokenIn, address tokenOut, uint256 totalIn, uint256 minAmountOut, address recipient, uint256 deadline, ${LEGS} legs) payable returns (uint256)`, // 0xfc54261d
  `function swapSplitWithFee(${FEE_ARGS} a, ${LEGS} legs) payable returns (uint256)`, // 0x5e98574a
  `function swapSplitViaPropAMM(${FEE_ARGS} a, ${LEGS} legs, address venue, uint256 coreNetOut) payable returns (uint256)`, // 0x195e648e
  `function swapSplitWithPropAMMSplit(${FEE_ARGS} a, ${LEGS} splitLegs, ${LEGS} fullLegs, tuple(address venue, uint256 venueIn, uint256 venueMinOut) s) payable returns (uint256)`, // 0x31ab353b
  `function makerSwap(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline) a, ${LEGS} poolLegs, tuple(address target, address spender, uint256 amountIn, uint256 minOut, bytes data) m, ${LEGS} fallbackLegs) payable returns (uint256)`, // 0xa565fdcc
]);
// the only contracts a makerSwap leg may call / approve (Bebop settlement)
const BEBOP = new Set(["0xbeb0009aca35087ce7ccf11637e24dd1aad3bf2a", "0xbbbbbbb520d69a9775e85b458c58c648259fad5f"]);

export interface LcxExpect {
  tokenIn: string; // LCX_NATIVE for ETH
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint; // quote.output.minimumAmount
  recipient: string;
}

/** Decode router calldata and check it pays exactly what was asked. "" = OK, else the refusal reason. */
export function checkLcxCalldata(data: string, value: bigint, x: LcxExpect, nowSec = Math.floor(Date.now() / 1000)): string {
  let tx: ethers.TransactionDescription | null;
  try {
    tx = LCX_ROUTER_IFACE.parseTransaction({ data, value });
  } catch {
    return "calldata undecodable";
  }
  if (!tx) return `unknown selector ${data.slice(0, 10)}`;
  const a: any = tx.name === "swapSplit" ? tx.args : tx.args[0]; // wrappers + makerSwap carry the args in `a`
  const totalIn: bigint = tx.name === "makerSwap" ? a.amountIn : a.totalIn;
  const same = (u: string, v: string): boolean => u.toLowerCase() === v.toLowerCase();
  if (!same(a.recipient, x.recipient)) return `recipient ${a.recipient} ≠ wallet`;
  if (totalIn !== x.amountIn) return `totalIn ${totalIn} ≠ amountIn`;
  if (!same(a.tokenIn, x.tokenIn) || !same(a.tokenOut, x.tokenOut)) return "calldata tokens ≠ request";
  if (a.minAmountOut < x.minOut) return `calldata floor ${a.minAmountOut} < quote floor ${x.minOut}`;
  if (value !== (same(x.tokenIn, LCX_NATIVE) ? totalIn : 0n)) return `value ${value} ≠ ${same(x.tokenIn, LCX_NATIVE) ? totalIn : 0n}`;
  if (a.deadline <= BigInt(nowSec)) return "deadline passed";
  if (tx.name === "makerSwap") {
    const m: any = tx.args[2];
    if (m.amountIn > 0n && (!BEBOP.has(m.target.toLowerCase()) || !BEBOP.has(m.spender.toLowerCase()) || m.amountIn > totalIn)) {
      return `makerSwap leg not allowed (target ${m.target})`;
    }
  }
  return "";
}

export interface LcxPlan {
  to: string;
  data: string;
  value: bigint;
  minOut: bigint; // tokenOut floor the router enforces (reverts below it)
}

async function post(path: string, body: unknown): Promise<any | null> {
  try {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.lcxKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.success !== true || !j?.data) {
      log.warn(`${path.slice(1)} gagal: ${j?.code ?? r.status}${j?.message ? ` — ${String(j.message).slice(0, 80)}` : ""}`);
      return null;
    }
    return j.data;
  } catch (e) {
    log.warn(`${path.slice(1)} error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/**
 * Quote + build a same-chain swap of exactly `amountIn`, paid to `recipient`. tokenIn / tokenOut use
 * LCX_NATIVE for ETH. Returns null when LCX is off, can't route, or the build fails a gate — never throws.
 */
export async function lcxPlan(tokenIn: string, tokenOut: string, amountIn: bigint, recipient: string, slippageBps: number): Promise<LcxPlan | null> {
  const router = lcxRouter();
  if (!lcxEnabled() || !router || amountIn <= 0n) return null;
  const chainId = cfg.chainId;
  const bps = Math.min(Math.max(Math.round(slippageBps), 0), MAX_SLIPPAGE_BPS);

  const quoted = await post("/quote", { chainId, tokenIn, tokenOut, amountIn: amountIn.toString(), slippageBps: bps });
  const q = quoted?.quote;
  if (!q?.quoteId) return null;
  if (q.stale === true) {
    log.warn("quote stale → skip");
    return null;
  }
  const b = await post("/build", { quoteId: q.quoteId, recipient, slippageBps: bps });
  if (!b) return null;

  // ── gates ──
  const same = (a: unknown, c: string): boolean => typeof a === "string" && a.toLowerCase() === c.toLowerCase();
  const sw = b.swap;
  let why = "";
  try {
    const nativeIn = same(tokenIn, LCX_NATIVE);
    if (!same(q.spender, router) || !same(sw?.to, router)) why = `router mismatch (${sw?.to} / ${q.spender})`;
    else if (Number(sw.chainId) !== chainId || Number(q.chainId) !== chainId || b.routerDeployed !== true) why = "chain mismatch";
    else if (!same(q.input?.token, tokenIn) || !same(q.output?.token, tokenOut) || BigInt(q.input.amount) !== amountIn) why = "quote ≠ request";
    else if (BigInt(b.minAmountOut) !== BigInt(q.output.minimumAmount) || BigInt(b.minAmountOut) <= 0n) why = "minAmountOut ≠ quote";
    else if (BigInt(sw.value ?? "0") !== (nativeIn ? amountIn : 0n)) why = `value sanity: got ${sw.value}`;
    else if (typeof sw.data !== "string" || !sw.data.startsWith("0x")) why = "no calldata";
    else why = checkLcxCalldata(sw.data, BigInt(sw.value ?? "0"), { tokenIn, tokenOut, amountIn, minOut: BigInt(q.output.minimumAmount), recipient });
  } catch {
    why = "malformed response";
  }
  if (why) {
    log.error(`build ditolak: ${why}`);
    return null;
  }
  return { to: router, data: sw.data, value: BigInt(sw.value ?? "0"), minOut: BigInt(b.minAmountOut) };
}
