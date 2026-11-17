/**
 * LCX Liberty DEX client: request shape + every build gate, against a mocked fetch (no network).
 * Run: npm test
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LCX_API_KEY = "test-key";
process.env.LOG_LEVEL = "error";
const { lcxPlan, LCX_NATIVE } = await import("../src/chain/lcx.js");
const { pickPlan } = await import("../src/chain/kyber.js");
const { env } = await import("../src/config.js");

const ROUTER = "0x0000000000654902B6Ed6cC240cc81CB4c4a3dff";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // Robinhood Chain USDG (as in pools.ts)
const ME = "0x1111111111111111111111111111111111111111";
const AMT = 1_000_000n;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

/** Mock fetch: answers /quote and /build from the given bodies (or a [status, body] pair). */
function mock(quote: unknown, build?: unknown): void {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = String(url).endsWith("/quote") ? quote : build;
    const [status, body] = Array.isArray(r) ? r : [200, r];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function quoteBody(tokenIn: string, tokenOut: string, over: Record<string, any> = {}) {
  return {
    success: true,
    data: {
      quote: {
        quoteId: "q1",
        chainId: 4663,
        input: { token: tokenIn, amount: AMT.toString(), decimals: 6 },
        output: { token: tokenOut, amount: "500000000000000", minimumAmount: "475000000000000", decimals: 18 },
        spender: ROUTER.toLowerCase(),
        nativeIn: tokenIn === LCX_NATIVE,
        nativeOut: tokenOut === LCX_NATIVE,
        expiresAt: 0,
        ...over,
      },
    },
  };
}

function buildBody(value: string, over: Record<string, any> = {}, swapOver: Record<string, any> = {}) {
  return {
    success: true,
    data: {
      swap: { chainId: 4663, to: ROUTER, data: "0xdeadbeef", value, ...swapOver },
      minAmountOut: "475000000000000",
      deadline: "0",
      routerDeployed: true,
      simulation: { status: "skipped", why: "awaiting_allowance" },
      ...over,
    },
  };
}

beforeEach(() => {
  env.lcxKey = "test-key";
});

test("ERC-20 → ETH: quote then build, Bearer key, exact request echoed", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0"));
  const p = await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500);
  assert.deepEqual(p, { to: ROUTER, data: "0xdeadbeef", value: 0n, minOut: 475000000000000n });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://swap-api.lcx.com/v1/quote");
  assert.equal(calls[1]!.url, "https://swap-api.lcx.com/v1/build");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { chainId: 4663, tokenIn: USDG, tokenOut: LCX_NATIVE, amountIn: "1000000", slippageBps: 500 });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { quoteId: "q1", recipient: ME, slippageBps: 500 });
});

test("ETH in: value must equal amountIn", async () => {
  mock(quoteBody(LCX_NATIVE, USDG), buildBody(AMT.toString()));
  assert.equal((await lcxPlan(LCX_NATIVE, USDG, AMT, ME, 500))?.value, AMT);
  mock(quoteBody(LCX_NATIVE, USDG), buildBody("0"));
  assert.equal(await lcxPlan(LCX_NATIVE, USDG, AMT, ME, 500), null);
});

test("ERC-20 in: non-zero value is rejected", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("1"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("router gates: quote.spender and swap.to must be the published router", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  mock(quoteBody(USDG, LCX_NATIVE, { spender: other }), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { to: other }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("chain gates: swap.chainId and routerDeployed", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { chainId: 1 }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", { routerDeployed: false }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("quote must echo the request: amount and both tokens", async () => {
  mock(quoteBody(USDG, LCX_NATIVE, { input: { token: USDG, amount: "999999" } }), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  mock(quoteBody(USDG, USDG), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("minAmountOut must equal quote.output.minimumAmount", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", { minAmountOut: "1" }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("stale quote → skipped before build", async () => {
  mock(quoteBody(USDG, LCX_NATIVE, { stale: true }), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  assert.equal(calls.length, 1);
});

test("API error (401) → null, build never called", async () => {
  mock([401, { success: false, code: "INVALID_API_KEY", error: "INVALID_API_KEY", message: "bad key" }]);
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  assert.equal(calls.length, 1);
});

test("no LCX_API_KEY → off, no HTTP at all", async () => {
  env.lcxKey = "";
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  assert.equal(calls.length, 0);
});

test("slippage above the API ceiling is clamped to 2000 bps on quote and build", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0"));
  await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 5000);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).slippageBps, 2000);
  assert.equal(JSON.parse(String(calls[1]!.init.body)).slippageBps, 2000);
});

test("pickPlan: larger guaranteed minimum wins, tie keeps Kyber, null falls through", () => {
  const k = { src: "kyber", minOut: 100n };
  const l = { src: "lcx", minOut: 101n };
  assert.equal(pickPlan(k, l), l);
  assert.equal(pickPlan(k, { src: "lcx", minOut: 100n }), k);
  assert.equal(pickPlan(k, null), k);
  assert.equal(pickPlan(null, l), l);
  assert.equal(pickPlan(null, null), null);
});
