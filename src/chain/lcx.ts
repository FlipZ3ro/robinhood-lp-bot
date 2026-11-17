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
 */
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
  } catch {
    why = "malformed response";
  }
  if (why) {
    log.error(`build ditolak: ${why}`);
    return null;
  }
  return { to: router, data: sw.data, value: BigInt(sw.value ?? "0"), minOut: BigInt(b.minAmountOut) };
}
