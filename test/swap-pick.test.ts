/**
 * kyberSwap with LCX Liberty DEX next to Kyber: which router gets the tx, fallbacks, and the
 * Kyber-only path when LCX_API_KEY is unset. fetch, provider and wallet are stubbed (no network).
 * Run: npm test
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

const KYBER_ROUTER = "0x3333333333333333333333333333333333333333"; // test whitelist, not Kyber's real router
process.env.KYBERSWAP_ROUTER_ADDRESS = KYBER_ROUTER;
process.env.LCX_API_KEY = "test-key";
process.env.RH_WALLET_KEY = "0x" + "11".repeat(32); // throwaway test key, never funded
process.env.LOG_LEVEL = "error";
const { kyberSwap, KYBER_NATIVE } = await import("../src/chain/kyber.js");
const { LCX_ROUTER_IFACE } = await import("../src/chain/lcx.js");
const { wallet, provider } = await import("../src/chain/client.js");
const { env } = await import("../src/config.js");

const LCX_ROUTER = "0x0000000000654902B6Ed6cC240cc81CB4c4a3dff";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const AMT = 10n ** 15n; // 0.001 ETH
const SLIP = 500n; // config.json lp.slippagePct = 5
const floor = (x: bigint) => (x * (10_000n - SLIP)) / 10_000n;
const enc = (n: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);

let kyberOut = 0n;
let lcxMin = 0n;
let kyberRouterReply = KYBER_ROUTER;
let revertOn = ""; // router whose simulation reverts
let sent: string[] = [];
let lastQuote: any = null;

/** Router calldata for the last quote, paying `recipient`, as /v1/build would return it. */
const lcxCalldata = (recipient: string) =>
  LCX_ROUTER_IFACE.encodeFunctionData("swapSplit", [
    lastQuote.tokenIn,
    lastQuote.tokenOut,
    BigInt(lastQuote.amountIn),
    lcxMin,
    recipient,
    BigInt(Math.floor(Date.now() / 1000) + 120),
    [{ amountIn: BigInt(lastQuote.amountIn), hops: [{ family: 1, pool: KYBER_ROUTER, tokenIn: lastQuote.tokenIn, tokenOut: lastQuote.tokenOut, aux: 0n }] }],
  ]);

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.includes("/routes")) return json({ code: 0, data: { routerAddress: kyberRouterReply, routeSummary: { amountIn: AMT.toString(), amountOut: kyberOut.toString() } } });
  if (u.includes("/route/build"))
    return json({ code: 0, data: { routerAddress: kyberRouterReply, amountIn: AMT.toString(), amountOut: kyberOut.toString(), transactionValue: AMT.toString(), data: "0xaaaa" } });
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (u.endsWith("/v1/quote")) lastQuote = body;
  if (u.endsWith("/v1/quote"))
    return json({
      success: true,
      data: {
        quote: {
          quoteId: "q1",
          chainId: 4663,
          input: { token: body.tokenIn, amount: body.amountIn },
          output: { token: body.tokenOut, amount: (lcxMin * 10_000n / (10_000n - SLIP)).toString(), minimumAmount: lcxMin.toString() },
          spender: LCX_ROUTER,
        },
      },
    });
  if (u.endsWith("/v1/build"))
    return json({ success: true, data: { swap: { chainId: 4663, to: LCX_ROUTER, data: lcxCalldata(body.recipient), value: AMT.toString() }, minAmountOut: lcxMin.toString(), routerDeployed: true } });
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

// chain stubs: simulation (eth_call to a router), balanceOf (USDG), gas, and the send itself
let usdgBal = 0n;
const p = provider as any;
p.call = async (tx: { to: string; data: string }) => {
  if (tx.to.toLowerCase() === USDG.toLowerCase()) return enc(usdgBal);
  if (revertOn && tx.to.toLowerCase() === revertOn.toLowerCase()) throw new Error("execution reverted");
  return "0x";
};
p.estimateGas = async () => 100_000n;
p.getFeeData = async () => ({ gasPrice: 1n });
(wallet() as any).sendTransaction = async (tx: { to: string }) => {
  sent.push(tx.to);
  usdgBal += 1n;
  return { hash: "0x" + "ab".repeat(32), wait: async () => null };
};

beforeEach(() => {
  env.lcxKey = "test-key";
  kyberRouterReply = KYBER_ROUTER;
  revertOn = "";
  sent = [];
});

test("LCX executes when its guaranteed minimum is higher", async () => {
  kyberOut = 1000n;
  lcxMin = floor(1000n) + 1n;
  const r = await kyberSwap(KYBER_NATIVE, USDG, AMT);
  assert.deepEqual(sent, [LCX_ROUTER]);
  assert.equal(r?.amountOut, 1n);
});

test("Kyber executes when its guaranteed minimum is higher or equal", async () => {
  kyberOut = 1000n;
  lcxMin = floor(1000n);
  await kyberSwap(KYBER_NATIVE, USDG, AMT);
  assert.deepEqual(sent, [KYBER_ROUTER]);
});

test("winner's simulation reverts → runner-up is used, nothing broadcast twice", async () => {
  kyberOut = 1000n;
  lcxMin = 2000n;
  revertOn = LCX_ROUTER;
  await kyberSwap(KYBER_NATIVE, USDG, AMT);
  assert.deepEqual(sent, [KYBER_ROUTER]);
});

test("Kyber gate failure (router mismatch) → LCX's validated build is used", async () => {
  kyberOut = 5000n;
  lcxMin = 100n;
  kyberRouterReply = "0x4444444444444444444444444444444444444444";
  await kyberSwap(KYBER_NATIVE, USDG, AMT);
  assert.deepEqual(sent, [LCX_ROUTER]);
});

test("no LCX_API_KEY → Kyber only, and a Kyber gate failure still throws as before", async () => {
  env.lcxKey = "";
  kyberOut = 1000n;
  lcxMin = 10n ** 18n;
  await kyberSwap(KYBER_NATIVE, USDG, AMT);
  assert.deepEqual(sent, [KYBER_ROUTER]);
  kyberRouterReply = "0x4444444444444444444444444444444444444444";
  await assert.rejects(kyberSwap(KYBER_NATIVE, USDG, AMT), /kyber router mismatch/);
});
