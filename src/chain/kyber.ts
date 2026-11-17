/**
 * KyberSwap aggregator client — best-route swaps across ALL of the chain's liquidity (every
 * DEX, fee tier, hooked pool, and multi-hop), so acquiring a token never bleeds fee + price
 * impact from buying on a single thin pool. Adapted from labrinyang/lp-terminal (kyber.ts +
 * kyberExec.ts) for a server-side ethers wallet.
 *
 * SECURITY: kyber calldata is opaque, so every swap passes 4 gates before broadcast:
 *   1. build.routerAddress must equal the whitelisted router (tx.to is ALWAYS the whitelist)
 *   2. tx value == amountIn for native ETH, else 0
 *   3. built amountIn == requested amountIn (spend integrity)
 *   4. built amountOut >= fresh quote − slippage (no execution drift)
 *
 * When LCX_API_KEY is set, LCX Liberty DEX (lcx.ts, its own gates) is quoted in parallel and the
 * build guaranteeing the LARGER minimum output executes; the other is the fallback when one can't route
 * or its pre-broadcast simulation reverts.
 */
import { ethers } from "ethers";
import { env, cfg } from "../config.js";
import { wallet, provider, overrides, waitTx } from "./client.js";
import { lcxPlan, LCX_NATIVE } from "./lcx.js";
import { logger } from "../util/log.js";

const log = logger("kyber");
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // kyber sentinel for native ETH
const HEADERS = { "x-client-id": "robinhood-lp-bot" };

const api = () => `${env.kyberBase}/${env.kyberChain}/api/v1`;
export const kyberEnabled = (): boolean => !!env.kyberBase && !!env.kyberRouter;

interface RouteData {
  routeSummary: any;
  routerAddress: string;
}

/** GET /routes — the optimal route + quote. Returns null on any failure. */
export async function kyberRoute(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<RouteData | null> {
  try {
    const u = new URL(`${api()}/routes`);
    u.searchParams.set("tokenIn", tokenIn);
    u.searchParams.set("tokenOut", tokenOut);
    u.searchParams.set("amountIn", amountIn.toString());
    u.searchParams.set("gasInclude", "true");
    const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.code !== 0 || !j?.data?.routeSummary) {
      log.warn(`routes gagal: ${j?.message ?? r.status}`);
      return null;
    }
    return j.data as RouteData;
  } catch (e) {
    log.warn(`route error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** POST /route/build — encode the route into calldata. Returns null on failure. */
async function kyberBuild(routeSummary: any, sender: string, recipient: string, slippageBps: number): Promise<any | null> {
  try {
    const r = await fetch(`${api()}/route/build`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary, sender, recipient, slippageTolerance: slippageBps, source: "robinhood-lp-bot", enableGasEstimation: false }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.code !== 0 || !j?.data?.data) {
      log.warn(`build gagal: ${j?.message ?? r.status}`);
      return null;
    }
    return j.data;
  } catch (e) {
    log.warn(`build error: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

export interface KyberSwapResult {
  tx: string;
  amountOut: bigint; // actual tokenOut received (balance delta)
}

/** One executable swap: calldata for a whitelisted router + the tokenOut floor it guarantees. */
interface SwapPlan {
  src: "kyber" | "lcx";
  to: string;
  data: string;
  value: bigint;
  minOut: bigint;
}

/** Larger guaranteed minimum output wins; a tie keeps Kyber (`a`). */
export function pickPlan<T extends { minOut: bigint }>(a: T | null, b: T | null): T | null {
  if (!a || !b) return a ?? b;
  return b.minOut > a.minOut ? b : a;
}

/** Kyber route + build + gates 1-4. null = can't route; throws on a gate failure. */
async function kyberPlan(tokenIn: string, tokenOut: string, amountIn: bigint, sender: string, slippageBps: number): Promise<SwapPlan | null> {
  const nativeIn = tokenIn.toLowerCase() === KYBER_NATIVE.toLowerCase();

  // route + build hit the KyberSwap aggregator over HTTP and TRANSIENTLY return "route not found"
  // (indexing lag / momentary thin routing) even for a pair that routes fine seconds later — that was
  // hard-failing LP opens with "gagal beli USDG via Kyber". Retry a few times (fast when it's a quick
  // route-not-found response) before giving up so a flaky quote doesn't kill the open.
  let route: RouteData | null = null;
  let built: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    route = await kyberRoute(tokenIn, tokenOut, amountIn);
    if (route) {
      built = await kyberBuild(route.routeSummary, sender, sender, slippageBps);
      if (built) {
        if (attempt > 0) log.info(`kyber route ok setelah retry #${attempt}`);
        break;
      }
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // 400ms · 800ms
  }
  if (!route || !built) return null;

  // ── security gates ──
  if (ethers.getAddress(built.routerAddress) !== ethers.getAddress(env.kyberRouter)) {
    throw new Error(`kyber router mismatch: ${built.routerAddress} ≠ whitelist`);
  }
  const value = BigInt(built.transactionValue ?? "0");
  if (value !== (nativeIn ? amountIn : 0n)) throw new Error(`kyber value sanity: got ${value}, want ${nativeIn ? amountIn : 0n}`);
  const quotedOut = BigInt(route.routeSummary.amountOut);
  const minOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (BigInt(built.amountIn) !== amountIn || BigInt(built.amountOut) < minOut) {
    throw new Error(`kyber build deviates (in ${built.amountIn}, out ${built.amountOut} < ${minOut})`);
  }
  // floor the calldata enforces = built amountOut − slippage
  const floor = (BigInt(built.amountOut) * BigInt(10_000 - slippageBps)) / 10_000n;
  return { src: "kyber", to: env.kyberRouter, data: built.data, value, minOut: floor };
}

/**
 * Best-route swap. tokenIn = KYBER_NATIVE for ETH. Returns null if no aggregator can route
 * (caller can fall back). Throws only on a SECURITY gate failure (never silently unsafe).
 */
export async function kyberSwap(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<KyberSwapResult | null> {
  if (!kyberEnabled() || amountIn <= 0n) return null;
  const w = wallet();
  const nativeIn = tokenIn.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const nativeOut = tokenOut.toLowerCase() === KYBER_NATIVE.toLowerCase();
  const slippageBps = Math.round((cfg.lp.slippagePct || 5) * 100);

  // Kyber + LCX Liberty DEX in parallel (LCX resolves null at once when LCX_API_KEY is unset, and
  // never throws). A Kyber gate failure still throws unless LCX produced a build that passed its own.
  const [k, l] = await Promise.allSettled([
    kyberPlan(tokenIn, tokenOut, amountIn, w.address, slippageBps),
    lcxPlan(nativeIn ? LCX_NATIVE : tokenIn, nativeOut ? LCX_NATIVE : tokenOut, amountIn, w.address, slippageBps),
  ]);
  const lcx: SwapPlan | null = l.status === "fulfilled" && l.value ? { src: "lcx", ...l.value } : null;
  if (k.status === "rejected") {
    if (!lcx) throw k.reason;
    log.warn(`kyber ditolak (${(k.reason as Error).message.slice(0, 80)}) → pakai LCX`);
  }
  const kyber = k.status === "fulfilled" ? k.value : null;
  const best = pickPlan(kyber, lcx);
  if (!best) return null;
  if (lcx) log.info(`swap via ${best.src} · min out kyber ${kyber?.minOut ?? "-"} · lcx ${lcx.minOut}`);

  // approve + simulate the winner. If that fails BEFORE anything is broadcast, the runner-up (when
  // there is one) gets the same treatment; with a single source this is exactly the old path.
  const order = [best, best === kyber ? lcx : kyber].filter((p): p is SwapPlan => !!p);
  const erc = nativeIn ? null : new ethers.Contract(tokenIn, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], w);
  let plan = best;
  for (let i = 0; i < order.length; i++) {
    plan = order[i]!;
    try {
      // ERC20 input → exact-amount approve to the router (native in carries value, no approve)
      if (erc && (await erc.allowance!(w.address, plan.to)) < amountIn) {
        await waitTx(await erc.approve!(plan.to, amountIn, await overrides()), `${plan.src}-approve`);
      }
      await provider.call({ to: plan.to, data: plan.data, value: plan.value, from: w.address }); // simulate (unbounded gas)
      break;
    } catch (e) {
      if (i === order.length - 1) throw e;
      log.warn(`${plan.src} simulasi gagal (${(e as Error).message.slice(0, 80)}) → coba ${order[i + 1]!.src}`);
    }
  }

  // measure output by balance delta (native ETH out → getBalance; ERC20 → balanceOf)
  const outErc = nativeOut ? null : new ethers.Contract(tokenOut, ["function balanceOf(address) view returns (uint256)"], provider);
  const outBal = async (): Promise<bigint> => (nativeOut ? provider.getBalance(w.address) : outErc!.balanceOf!(w.address).catch(() => 0n));
  const before = await outBal();
  // GAS: give the swap an explicit gasLimit = estimate × 2. The Kyber router runs the underlying pool
  // swap via a low-level call and eth_estimateGas structurally UNDER-estimates that pattern (esp. v4 /
  // hooked pools) — a bare estimate ran the inner call out of gas and the router reverted "Call failed"
  // with gasUsed == gasLimit (233382). The 2× buffer absorbs the under-estimate + any state drift before
  // inclusion; only gasUsed is actually paid, so over-provisioning the limit costs nothing.
  const est = await provider.estimateGas({ to: plan.to, data: plan.data, value: plan.value, from: w.address }).catch(() => 300_000n);
  const tx = await w.sendTransaction({ to: plan.to, data: plan.data, value: plan.value, gasLimit: est * 2n, ...(await overrides()) });
  await waitTx(tx, `${plan.src}-swap`);
  const after = await outBal();
  return { tx: tx.hash, amountOut: after > before ? after - before : 0n };
}

/** Human route breakdown: "60% uniswapv3 · 40% up-v3". */
export function routeBreakdown(rs: any): string {
  const amountIn = BigInt(rs?.amountIn || "0");
  if (amountIn === 0n || !Array.isArray(rs?.route)) return "";
  const parts: string[] = [];
  for (const path of rs.route) {
    if (!path?.length) continue;
    const pct = Number((BigInt(path[0].swapAmount || "0") * 1000n) / amountIn) / 10;
    const names = [...new Set(path.map((h: any) => h.exchange))].join("→");
    parts.push(`${pct}% ${names}`);
  }
  return parts.join(" · ");
}
