/**
 * LCX Liberty DEX client: request shape, every build gate and the calldata check, against a mocked
 * fetch (no network).
 * Run: npm test
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LCX_API_KEY = "test-key";
process.env.LOG_LEVEL = "error";
const { lcxPlan, checkLcxCalldata, LCX_ROUTER_IFACE, LCX_NATIVE } = await import("../src/chain/lcx.js");
const { pickPlan } = await import("../src/chain/kyber.js");
const { env } = await import("../src/config.js");

const ROUTER = "0x0000000000654902B6Ed6cC240cc81CB4c4a3dff";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // Robinhood Chain USDG (as in pools.ts)
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const BEBOP = "0xbbbbbbb520d69a9775e85b458c58c648259fad5f";
const AMT = 1_000_000n;
const MIN = 475000000000000n;
const NOW = Math.floor(Date.now() / 1000);
const DEADLINE = BigInt(NOW + 120);

// ── calldata builders (encoded with the router ABI) ──
type Args = { tokenIn: string; tokenOut: string; totalIn: bigint; minAmountOut: bigint; recipient: string; deadline: bigint };
const base = (over: Partial<Args> = {}): Args => ({ tokenIn: USDG, tokenOut: LCX_NATIVE, totalIn: AMT, minAmountOut: MIN, recipient: ME, deadline: DEADLINE, ...over });
const legs = (a: Args) => [{ amountIn: a.totalIn, hops: [{ family: 1, pool: OTHER, tokenIn: a.tokenIn, tokenOut: a.tokenOut, aux: 0n }] }];
const feeArgs = (a: Args) => ({ ...a, integrator: LCX_NATIVE });

const swapSplit = (over: Partial<Args> = {}) => {
  const a = base(over);
  return LCX_ROUTER_IFACE.encodeFunctionData("swapSplit", [a.tokenIn, a.tokenOut, a.totalIn, a.minAmountOut, a.recipient, a.deadline, legs(a)]);
};
const propAmmSplit = (over: Partial<Args> = {}) => {
  const a = base(over);
  return LCX_ROUTER_IFACE.encodeFunctionData("swapSplitWithPropAMMSplit", [feeArgs(a), legs(a), legs(a), { venue: OTHER, venueIn: a.totalIn / 2n, venueMinOut: 1n }]);
};
const viaPropAmm = (over: Partial<Args> = {}) => {
  const a = base(over);
  return LCX_ROUTER_IFACE.encodeFunctionData("swapSplitViaPropAMM", [feeArgs(a), legs(a), OTHER, a.minAmountOut]);
};
const makerSwap = (target: string, over: Partial<Args> = {}) => {
  const a = base(over);
  const { totalIn, ...rest } = a;
  return LCX_ROUTER_IFACE.encodeFunctionData("makerSwap", [
    { ...rest, amountIn: totalIn },
    [],
    { target, spender: target, amountIn: totalIn, minOut: a.minAmountOut, data: "0x" },
    legs(a),
  ]);
};
const expect = { tokenIn: USDG, tokenOut: LCX_NATIVE, amountIn: AMT, minOut: MIN, recipient: ME };
const check = (data: string, value = 0n, now = NOW) => checkLcxCalldata(data, value, expect, now);

// ── fetch mock for lcxPlan ──
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
        output: { token: tokenOut, amount: "500000000000000", minimumAmount: MIN.toString(), decimals: 18 },
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
  const tokenIn = value === "0" ? USDG : LCX_NATIVE;
  const tokenOut = value === "0" ? LCX_NATIVE : USDG;
  return {
    success: true,
    data: {
      swap: { chainId: 4663, to: ROUTER, data: swapSplit({ tokenIn, tokenOut }), value, ...swapOver },
      minAmountOut: MIN.toString(),
      deadline: DEADLINE.toString(),
      routerDeployed: true,
      simulation: { status: "skipped", why: "awaiting_allowance" },
      ...over,
    },
  };
}

beforeEach(() => {
  env.lcxKey = "test-key";
});

// ── calldata check ──

test("router ABI selectors match the published ones", () => {
  const sel = (n: string) => LCX_ROUTER_IFACE.getFunction(n)!.selector;
  assert.equal(sel("swapSplit"), "0xfc54261d");
  assert.equal(sel("swapSplitWithFee"), "0x5e98574a");
  assert.equal(sel("swapSplitViaPropAMM"), "0x195e648e");
  assert.equal(sel("swapSplitWithPropAMMSplit"), "0x31ab353b");
  assert.equal(sel("makerSwap"), "0xa565fdcc");
});

test("calldata: swapSplit, swapSplitWithPropAMMSplit, swapSplitViaPropAMM and a Bebop makerSwap pass", () => {
  assert.equal(check(swapSplit()), "");
  assert.equal(check(propAmmSplit()), "");
  assert.equal(check(viaPropAmm()), "");
  assert.equal(check(makerSwap(BEBOP)), "");
  assert.equal(check(swapSplit({ minAmountOut: MIN + 1n })), ""); // a higher floor is fine
});

test("calldata: wrong recipient is refused", () => {
  assert.match(check(swapSplit({ recipient: OTHER })), /recipient/);
  assert.match(check(propAmmSplit({ recipient: OTHER })), /recipient/);
});

test("calldata: a floor below the quote's is refused", () => {
  assert.match(check(swapSplit({ minAmountOut: MIN - 1n })), /floor/);
  assert.match(check(propAmmSplit({ minAmountOut: MIN - 1n })), /floor/);
});

test("calldata: wrong totalIn is refused", () => {
  assert.match(check(swapSplit({ totalIn: AMT + 1n })), /totalIn/);
  assert.match(check(propAmmSplit({ totalIn: AMT - 1n })), /totalIn/);
});

test("calldata: swapped tokens are refused", () => {
  assert.match(check(swapSplit({ tokenIn: LCX_NATIVE, tokenOut: USDG })), /tokens/);
});

test("calldata: unknown selector or undecodable data is refused", () => {
  assert.match(check("0xdeadbeef" + "00".repeat(64)), /unknown selector/);
  assert.match(check(swapSplit().slice(0, 74)), /undecodable/);
});

test("calldata: value must be totalIn for ETH in, else 0", () => {
  assert.match(check(swapSplit(), 1n), /value/);
  const ethIn = { ...expect, tokenIn: LCX_NATIVE, tokenOut: USDG };
  const data = swapSplit({ tokenIn: LCX_NATIVE, tokenOut: USDG });
  assert.equal(checkLcxCalldata(data, AMT, ethIn, NOW), "");
  assert.match(checkLcxCalldata(data, 0n, ethIn, NOW), /value/);
});

test("calldata: an expired deadline is refused", () => {
  assert.match(check(swapSplit({ deadline: BigInt(NOW) })), /deadline/);
  assert.match(check(swapSplit({ deadline: BigInt(NOW - 1) })), /deadline/);
});

test("calldata: makerSwap with a non-Bebop target is refused", () => {
  assert.match(check(makerSwap(OTHER)), /makerSwap/);
});

// ── lcxPlan: HTTP + JSON gates ──

test("ERC-20 → ETH: quote then build, Bearer key, exact request echoed", async () => {
  const b = buildBody("0");
  mock(quoteBody(USDG, LCX_NATIVE), b);
  const p = await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500);
  assert.deepEqual(p, { to: ROUTER, data: b.data.swap.data, value: 0n, minOut: MIN });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://swap-api.lcx.com/v1/quote");
  assert.equal(calls[1]!.url, "https://swap-api.lcx.com/v1/build");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { chainId: 4663, tokenIn: USDG, tokenOut: LCX_NATIVE, amountIn: "1000000", slippageBps: 500 });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { quoteId: "q1", recipient: ME, slippageBps: 500 });
});

test("lcxPlan runs the calldata check: a build paying someone else is refused", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { data: swapSplit({ recipient: OTHER }) }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { data: makerSwap(OTHER) }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("ETH in: value must equal amountIn", async () => {
  mock(quoteBody(LCX_NATIVE, USDG), buildBody(AMT.toString()));
  assert.equal((await lcxPlan(LCX_NATIVE, USDG, AMT, ME, 500))?.value, AMT);
  mock(quoteBody(LCX_NATIVE, USDG), buildBody(AMT.toString(), {}, { value: "0" }));
  assert.equal(await lcxPlan(LCX_NATIVE, USDG, AMT, ME, 500), null);
});

test("ERC-20 in: non-zero value is rejected", async () => {
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { value: "1" }));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
});

test("router gates: quote.spender and swap.to must be the published router", async () => {
  mock(quoteBody(USDG, LCX_NATIVE, { spender: OTHER }), buildBody("0"));
  assert.equal(await lcxPlan(USDG, LCX_NATIVE, AMT, ME, 500), null);
  mock(quoteBody(USDG, LCX_NATIVE), buildBody("0", {}, { to: OTHER }));
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
