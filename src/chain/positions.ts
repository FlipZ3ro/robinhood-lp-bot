/**
 * Open / list / close LP positions.
 *
 * Tick & price math is delegated to the Uniswap SDK (see pools.ts). Principal and fee
 * amounts are read via decreaseLiquidity/collect `staticCall` — i.e. the node simulates
 * the exact withdrawal, so /list shows what you'd actually receive, with zero local
 * liquidity→amount float math (the v1 precision bug).
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { NPM_ABI, FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import { tokenMeta } from "./tokens.js";
import { getPoolState, computeRange, mcapAtTick, widthInTicks, USDG, type PoolState } from "./pools.js";
import {
  quoteTokenToWeth,
  swapWethToTokenBest,
  swapTokenToWeth,
  tokenBalanceRaw,
  ensureNativeEth,
} from "./swaps.js";
import { kyberSwap, kyberEnabled, KYBER_NATIVE } from "./kyber.js";
import { ethUsd } from "./price.js";
import { appendLedger } from "./ledger.js";
import { bsFetch } from "./blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { MintMode, OpenResult, PositionRow, CloseResult, RangePreview, PoolInfo, TokenMeta } from "../types.js";

const { CurrencyAmount } = sdkCore as any;
const log = logger("position");
const MAX_U128 = (1n << 128n) - 1n;
const USDG_L = USDG.toLowerCase();

// ── deposit basis persistence (data/positions.json) ──
const POS_FILE = dataPath("positions.json");
type DepositRecord = {
  depositWeth: string;
  ts: number;
  entryMcap?: number;
  mode?: MintMode;
  mintTs?: number;
  quote?: "eth" | "usd"; // "usd" = token/USDG pair (LP-vs-HODL basis via dep0/dep1)
  dep0?: string; // deposited amount of pool token0 (raw) — USDG pairs only
  dep1?: string; // deposited amount of pool token1 (raw) — USDG pairs only
};

export function saveDeposit(tokenId: string, depositWethWei: bigint, extra: Partial<DepositRecord> = {}): void {
  const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
  d[String(tokenId)] = { depositWeth: depositWethWei.toString(), ts: Date.now(), ...extra };
  writeJson(POS_FILE, d);
}
function loadDeposit(tokenId: string): DepositRecord | null {
  return readJson<Record<string, DepositRecord>>(POS_FILE, {})[String(tokenId)] ?? null;
}
function deleteDeposit(tokenId: string): void {
  const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
  delete d[String(tokenId)];
  writeJson(POS_FILE, d);
}

// ── mint deadline (10 min) ──
const deadline = () => Math.floor(Date.now() / 1000) + 600;

/** Non-WETH token address + its meta for a pool state. */
async function tokenSide(st: PoolState) {
  const addr = st.wethIsToken0 ? st.token1 : st.token0;
  const meta = await tokenMeta(addr);
  return { addr, meta };
}

/** Extract minted tokenId from an NPM mint receipt (Transfer with 4 topics). */
function tokenIdFromReceipt(rc: ethers.TransactionReceipt): string | null {
  const npmL = C.positionManager.toLowerCase();
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === npmL && lg.topics.length === 4) {
      return BigInt(lg.topics[3]!).toString();
    }
  }
  return null;
}

/**
 * Open an LP position.
 *   single  → single-sided WETH, range entirely on one side of price (rug-safe brake).
 *   inrange → straddle price; swaps ~half of WETH into token first (fees from second 1).
 */
export async function openPosition(
  _tokenAddr: string,
  poolAddr: string,
  amountEthStr: string,
  opts: { mode?: MintMode } = {},
): Promise<OpenResult> {
  const mode: MintMode = opts.mode === "inrange" ? "inrange" : "single";
  const w = wallet();
  const st = await getPoolState(poolAddr);
  if (!st.wethIsToken0 && st.token1.toLowerCase() !== C.weth.toLowerCase()) {
    throw new Error("pool ini bukan pair WETH");
  }
  const amount = ethers.parseEther(amountEthStr);
  const { addr: tokenReal, meta: tokMeta } = await tokenSide(st);
  const px = await ethUsd().catch(() => 0);
  const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);

  // 1. wrap ETH → WETH if needed
  let wrapHash: string | undefined;
  const wbal: bigint = await wc.balanceOf!(w.address);
  if (wbal < amount && cfg.lp.autoWrap) {
    const wrapTx = await wc.deposit!({ value: amount - wbal, ...(await overrides()) });
    await wrapTx.wait();
    wrapHash = wrapTx.hash;
  }
  // 2. approve WETH to NPM
  if ((await wc.allowance!(w.address, C.positionManager)) < amount) {
    await (await wc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }
  // use exact WETH balance (wrap can miss by 1 wei → STF)
  const realBal: bigint = await wc.balanceOf!(w.address);
  const depositAmt = realBal < amount ? realBal : amount;

  if (mode === "inrange") {
    return openInRange(st, poolAddr, tokenReal, tokMeta, depositAmt, px, wrapHash);
  }
  return openSingleSide(st, poolAddr, tokMeta, depositAmt, px, wrapHash);
}

async function openSingleSide(
  st: PoolState,
  poolAddr: string,
  tokMeta: { symbol: string; supplyUi: number },
  depositAmt: bigint,
  px: number,
  wrapHash: string | undefined,
): Promise<OpenResult> {
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);

  let lastErr: unknown = null;
  // Buffer widens each retry: a volatile price can cross a single-sided range before the
  // tx lands, reverting the mint. Re-read the tick fresh each attempt.
  for (let attempt = 0, buf = cfg.lp.rangeBufferSpacings || 2; attempt < 3; attempt++, buf += 2) {
    const tickNow = Number((await pc.slot0!()).tick);
    const fresh = { ...st, tick: tickNow };
    const { tickLower, tickUpper } = computeRange(fresh, "single", buf);
    const params = {
      token0: st.token0,
      token1: st.token1,
      fee: st.fee,
      tickLower,
      tickUpper,
      amount0Desired: st.wethIsToken0 ? depositAmt : 0n,
      amount1Desired: st.wethIsToken0 ? 0n : depositAmt,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: w.address,
      deadline: deadline(),
    };
    try {
      const sim = await npm.mint!.staticCall(params);
      if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil");
      const tx = await npm.mint!(params, await overrides());
      const rc = await tx.wait();
      const tokenId = tokenIdFromReceipt(rc);
      const entryMcap = mcapAtTick(fresh, tickNow, px, tokMeta.supplyUi);
      if (tokenId) saveDeposit(tokenId, depositAmt, { entryMcap, mode: "single" });
      log.info(`open single #${tokenId} ${tokMeta.symbol} deposit=${ethers.formatEther(depositAmt)}`);
      return {
        tokenId,
        txHash: tx.hash,
        wrapHash,
        mode: "single",
        tickLower,
        tickUpper,
        tick: tickNow,
        entryMcap,
        depositEth: ethers.formatEther(depositAmt),
        side: st.wethIsToken0
          ? "ETH nunggu → beli token pas MCAP turun"
          : "ETH nunggu → beli token pas MCAP naik",
        liquidity: sim.liquidity.toString(),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw new Error(`mint gagal 3×: ${errShort(lastErr)}`);
}

async function openInRange(
  st: PoolState,
  poolAddr: string,
  tokenReal: string,
  tokMeta: { symbol: string; supplyUi: number },
  depositAmt: bigint,
  px: number,
  wrapHash: string | undefined,
): Promise<OpenResult> {
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const pc = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const tickNow = Number((await pc.slot0!()).tick);
  const fresh = { ...st, tick: tickNow };
  const { tickLower, tickUpper, swapFraction } = computeRange(fresh, "inrange");
  const erc = new ethers.Contract(tokenReal, ERC20_ABI, w);

  // REUSE token already in the wallet (bought on a prior failed attempt / leftover inventory)
  // so we never double-buy — value it in WETH and buy only the shortfall below.
  const tokenHave: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  const haveWethValue: bigint =
    tokenHave > 0n
      ? (await quoteTokenToWeth(tokenReal, tokenHave).catch(() => ({ amountOut: 0n }))).amountOut
      : 0n;

  // WETH-value of token this straddling range wants (98% of the split so leftover stays WETH,
  // not stuck token). Buy ONLY the shortfall, and via the KyberSwap aggregator (best route across
  // every DEX/fee-tier/hook) — NOT the farmed fee tier, which would bleed price impact and land
  // the position lopsided ("input 0.01 → liq cuma setengah"). Cap at 90% so the WETH side pairs.
  const frac = swapFraction * 0.98;
  const targetTokenWeth = (depositAmt * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
  let wethToSwap = targetTokenWeth > haveWethValue ? targetTokenWeth - haveWethValue : 0n;
  const maxSwap = (depositAmt * 9n) / 10n;
  if (wethToSwap > maxSwap) wethToSwap = maxSwap;

  let swapHash: string | undefined;
  if (wethToSwap >= ethers.parseEther("0.00002")) {
    const sw = await swapWethToTokenBest(tokenReal, wethToSwap, st.fee);
    if (sw.amountOut <= 0n) throw new Error("swap WETH → token tidak menghasilkan token (pool kering?)");
    swapHash = sw.tx;
  } else {
    wethToSwap = 0n; // enough token already on hand — LP straight from balance
  }

  // actual token balance now (reused inventory + anything just swapped)
  const tokenGot: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  if (tokenGot <= 0n) throw new Error("token balance 0 — nggak ada yang bisa di-LP");

  if ((await erc.allowance!(w.address, C.positionManager)) < tokenGot) {
    await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }
  const wethLeft = depositAmt - wethToSwap;
  const params = {
    token0: st.token0,
    token1: st.token1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: st.wethIsToken0 ? wethLeft : tokenGot,
    amount1Desired: st.wethIsToken0 ? tokenGot : wethLeft,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  // honest cost basis = the position's ACTUAL value at mint: WETH side used + WETH-value of the
  // token side used (same Quoter). Counts reused inventory; ignores refunded excess.
  const wethUsed = (st.wethIsToken0 ? sim.amount0 : sim.amount1) as bigint;
  const tokenUsed = (st.wethIsToken0 ? sim.amount1 : sim.amount0) as bigint;
  const tokenUsedWeth: bigint =
    tokenUsed > 0n
      ? (await quoteTokenToWeth(tokenReal, tokenUsed).catch(() => ({ amountOut: 0n }))).amountOut
      : 0n;
  const costBasis = wethUsed + (tokenUsedWeth > 0n ? tokenUsedWeth : wethToSwap);
  const swappedPct = depositAmt > 0n ? Math.round((Number(wethToSwap) / Number(depositAmt)) * 100) : 0;
  const entryMcap = mcapAtTick(fresh, tickNow, px, tokMeta.supplyUi);
  if (tokenId) saveDeposit(tokenId, costBasis, { entryMcap, mode: "inrange" });
  log.info(`open inrange #${tokenId} ${tokMeta.symbol} swapped=${swappedPct}%${wethToSwap === 0n ? " (reuse balance)" : ""}`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "inrange",
    tickLower,
    tickUpper,
    tick: tickNow,
    entryMcap,
    swappedPct,
    depositEth: ethers.formatEther(costBasis),
    side: `IN RANGE — langsung makan fee (≈${swappedPct}% modal jadi token)`,
    liquidity: sim.liquidity.toString(),
  };
}

// ══════════ v3 token/USDG (no WETH leg) ══════════

/** Value fraction that belongs on the currency1 side of a straddling range [tl,tu] at `tick`. */
function valueFracC1(tick: number, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return 1; // price ≤ lower → all value in token1
  if (sP >= sB) return 0; // price ≥ upper → all value in token0
  const a0 = (sB - sP) / (sP * sB); // token0 per unit L
  const a1in0 = (sP - sA) / (sP * sP); // token1 per unit L, expressed in token0 units
  const f = a1in0 / (a0 + a1in0);
  return Math.min(0.95, Math.max(0.05, f));
}

/** USD value of `raw` units of one pool side, using the pool itself as the price oracle. */
function currencyUsd(st: PoolState, isSide0: boolean, raw: bigint, px: number): number {
  if (raw <= 0n) return 0;
  const addr = (isSide0 ? st.token0 : st.token1).toLowerCase();
  const dec = isSide0 ? st.token0Sdk.decimals : st.token1Sdk.decimals;
  if (addr === USDG_L) return Number(ethers.formatUnits(raw, dec)); // stable ≈ $1
  if (addr === C.weth.toLowerCase()) return Number(ethers.formatUnits(raw, dec)) * px;
  try {
    const cur = isSide0 ? st.token0Sdk : st.token1Sdk;
    const other = (isSide0 ? st.token1 : st.token0).toLowerCase();
    const inOther = Number(st.sdkPool.priceOf(cur).quote(CurrencyAmount.fromRawAmount(cur, raw.toString())).toExact());
    if (other === USDG_L) return inOther;
    if (other === C.weth.toLowerCase()) return inOther * px;
  } catch {
    /* price out of range → 0 */
  }
  return 0;
}

/**
 * Open an in-range v3 position on a token/USDG pool (no WETH leg). Funds BOTH sides from the
 * deposit ETH via the KyberSwap aggregator (WETH→USDG and WETH→token, best route), then mints
 * both-sided through the v3 NPM. The NPM only pulls up to `amountDesired` and refunds the rest,
 * so passing the actual balances with amountMin=0 (staticCall-guarded) can never over-pull.
 */
export async function openV3UsdgInRange(pool: PoolInfo, amountEthStr: string): Promise<OpenResult> {
  if (!kyberEnabled()) throw new Error("KyberSwap belum dikonfigurasi — LP USDG butuh aggregator (set KYBERSWAP_ROUTER_ADDRESS).");
  const w = wallet();
  const st = await getPoolState(pool.pool);
  const c0 = st.token0;
  const c1 = st.token1;
  if (c0.toLowerCase() !== USDG_L && c1.toLowerCase() !== USDG_L) throw new Error("pool ini bukan pair USDG");
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const total = ethers.parseEther(amountEthStr);

  // 1) fund WETH (wrap native shortfall) — both Kyber buys spend WETH; native stays for gas
  const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);
  let wrapHash: string | undefined;
  const wbal: bigint = await wc.balanceOf!(w.address);
  if (wbal < total && cfg.lp.autoWrap) {
    const wtx = await wc.deposit!({ value: total - wbal, ...(await overrides()) });
    await wtx.wait();
    wrapHash = wtx.hash;
  }

  const { tickLower, tickUpper } = computeRange(st, "inrange");
  const fracC1 = valueFracC1(st.tick, tickLower, tickUpper);
  const wethForC1 = (total * BigInt(Math.round(fracC1 * 1e6))) / 1_000_000n;
  const wethForC0 = total - wethForC1;

  const bal = async (a: string): Promise<bigint> =>
    new ethers.Contract(a, ERC20_ABI, provider).balanceOf!(w.address).catch(() => 0n);

  // 2) buy each side from WETH via Kyber. REUSE USDG already in the wallet — buy only the SHORTFALL
  //    on the USDG side (swapping when you already hold USDG just burns fees). The token side is
  //    always bought; the NPM refunds any excess so the position still lands ≈ the deposit.
  let swapHash: string | undefined;
  const acquire = async (addr: string, wethAmt: bigint): Promise<void> => {
    if (wethAmt < ethers.parseEther("0.00002")) return;
    const k = await kyberSwap(C.weth, ethers.getAddress(addr), wethAmt);
    if (!k || k.amountOut <= 0n) throw new Error(`gagal beli ${addr.toLowerCase() === USDG_L ? "USDG" : "token"} via Kyber`);
    swapHash = k.tx;
  };
  const px = await ethUsd().catch(() => 0);
  const usdgIsC0 = c0.toLowerCase() === USDG_L;
  const usdgAddr = usdgIsC0 ? c0 : c1;
  const tokAddr = usdgIsC0 ? c1 : c0;
  const wethForUsdg = usdgIsC0 ? wethForC0 : wethForC1;
  const wethForTok = usdgIsC0 ? wethForC1 : wethForC0;
  const heldUsdgWethWei = px > 0 ? ethers.parseEther((Number(ethers.formatUnits(await bal(usdgAddr), 6)) / px).toFixed(9)) : 0n;
  const buyUsdgWei = wethForUsdg > heldUsdgWethWei ? wethForUsdg - heldUsdgWethWei : 0n;
  await acquire(tokAddr, wethForTok);
  await acquire(usdgAddr, buyUsdgWei); // 0 if we already hold enough USDG

  const [bal0, bal1] = await Promise.all([bal(c0), bal(c1)]);
  if (bal0 <= 0n || bal1 <= 0n) throw new Error("salah satu sisi balance 0 setelah swap (pool kering?)");

  // 3) approve both sides to the NPM
  for (const [a, need] of [[c0, bal0], [c1, bal1]] as const) {
    const erc = new ethers.Contract(a, ERC20_ABI, w);
    if ((await erc.allowance!(w.address, C.positionManager)) < need) {
      await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
    }
  }

  const params = {
    token0: c0,
    token1: c1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: bal0,
    amount1Desired: bal1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  const usdgIs0 = c0.toLowerCase() === USDG_L;
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const tokSym = usdgIs0 ? m1.symbol : m0.symbol;
  if (tokenId) {
    // basis: ETH budget for display; dep0/dep1 (amounts actually used) for LP-vs-HODL at close
    saveDeposit(tokenId, total, {
      mode: "inrange",
      quote: "usd",
      dep0: (sim.amount0 as bigint).toString(),
      dep1: (sim.amount1 as bigint).toString(),
    });
  }
  log.info(`open v3 USDG in-range #${tokenId} ${m0.symbol}/${m1.symbol} fee ${st.fee / 10000}% ${amountEthStr}Ξ`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "inrange",
    tickLower,
    tickUpper,
    tick: st.tick,
    entryMcap: 0,
    swappedPct: 100,
    depositEth: amountEthStr,
    side: `IN RANGE ${tokSym}/USDG — fee ${(st.fee / 10000).toFixed(2)}% jalan langsung`,
    liquidity: sim.liquidity.toString(),
  };
}

/**
 * SINGLE-SIDE USDG on a token/USDG v3 pool: park ONLY USDG (no token), range on the all-USDG side so
 * the position stays 100% USDG until the token PUMPS into range (rug-safe). USDG=token0 → range ABOVE
 * tick; USDG=token1 → range BELOW. Funds the USDG entirely from the ETH budget via Kyber.
 */
export async function openV3UsdgSingleSide(pool: PoolInfo, amountEthStr: string): Promise<OpenResult> {
  if (!kyberEnabled()) throw new Error("KyberSwap belum dikonfigurasi — LP USDG butuh aggregator.");
  const w = wallet();
  const st = await getPoolState(pool.pool);
  const c0 = st.token0;
  const c1 = st.token1;
  const usdgIs0 = c0.toLowerCase() === USDG_L;
  const usdgIs1 = c1.toLowerCase() === USDG_L;
  if (!usdgIs0 && !usdgIs1) throw new Error("pool ini bukan pair USDG");
  const usdgAddr = usdgIs0 ? c0 : c1;
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const total = ethers.parseEther(amountEthStr);

  // REUSE USDG already in the wallet — buy only the SHORTFALL to reach `total` worth (swapping when
  // you already hold enough USDG just burns fees), then cap to the target so a big pre-held balance
  // doesn't oversize the position. Only wrap the WETH actually needed for the buy.
  const usdgC = new ethers.Contract(usdgAddr, ERC20_ABI, provider);
  const px = await ethUsd().catch(() => 0);
  const targetUsdgRaw = px > 0 ? BigInt(Math.floor(Number(ethers.formatEther(total)) * px * 1e6)) : 0n;
  const held0: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  const buyWethWei =
    targetUsdgRaw > 0n
      ? targetUsdgRaw > held0
        ? ethers.parseEther((Number(ethers.formatUnits(targetUsdgRaw - held0, 6)) / px).toFixed(9))
        : 0n
      : total; // no price → fall back to buying the full budget
  let wrapHash: string | undefined;
  let swapHash: string | undefined;
  if (buyWethWei >= ethers.parseEther("0.00002")) {
    const wc = new ethers.Contract(C.weth, [...ERC20_ABI, "function deposit() payable"], w);
    const wbal: bigint = await wc.balanceOf!(w.address);
    if (wbal < buyWethWei && cfg.lp.autoWrap) {
      const wtx = await wc.deposit!({ value: buyWethWei - wbal, ...(await overrides()) });
      await wtx.wait();
      wrapHash = wtx.hash;
    }
    const k = await kyberSwap(C.weth, ethers.getAddress(usdgAddr), buyWethWei);
    if (!k || k.amountOut <= 0n) throw new Error("gagal beli USDG via Kyber");
    swapHash = k.tx;
  }
  const heldNow: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  // Price KNOWN → cap to target (reuse held USDG). Price UNKNOWN (px=0) → deposit ONLY what this open
  // just bought (heldNow - held0), NEVER the whole held balance (that dumped pre-held USDG before).
  const bought = heldNow > held0 ? heldNow - held0 : 0n;
  const usdgBal = targetUsdgRaw > 0n ? (heldNow > targetUsdgRaw ? targetUsdgRaw : heldNow) : bought;
  if (usdgBal <= 0n) throw new Error("USDG balance 0 (gak ada USDG di wallet & gagal beli)");

  // fresh tick + single-side range on the all-USDG side (buffer so a moving price doesn't cross it)
  const pc = new ethers.Contract(pool.pool, POOL_ABI, provider);
  const tickNow = Number((await pc.slot0!()).tick);
  const sp = st.spacing;
  const width = widthInTicks(sp);
  const buf = cfg.lp.rangeBufferSpacings || 2;
  let tickLower: number;
  let tickUpper: number;
  if (usdgIs0) {
    tickLower = (Math.floor(tickNow / sp) + buf) * sp; // range ABOVE → all token0 (USDG)
    tickUpper = tickLower + width;
  } else {
    tickUpper = (Math.floor(tickNow / sp) - buf + 1) * sp; // range BELOW → all token1 (USDG)
    tickLower = tickUpper - width;
  }

  const erc = new ethers.Contract(usdgAddr, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.positionManager)) < usdgBal) {
    await (await erc.approve!(C.positionManager, ethers.MaxUint256, await overrides())).wait();
  }

  const params = {
    token0: c0,
    token1: c1,
    fee: st.fee,
    tickLower,
    tickUpper,
    amount0Desired: usdgIs0 ? usdgBal : 0n,
    amount1Desired: usdgIs0 ? 0n : usdgBal,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: w.address,
    deadline: deadline(),
  };
  const sim = await npm.mint!.staticCall(params);
  if (sim.liquidity === 0n) throw new Error("liquidity 0 — deposit terlalu kecil buat range ini");
  const tx = await npm.mint!(params, await overrides());
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc);

  const [mm0, mm1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const tokSym = usdgIs0 ? mm1.symbol : mm0.symbol;
  if (tokenId) {
    saveDeposit(tokenId, total, { mode: "single", quote: "usd", dep0: (sim.amount0 as bigint).toString(), dep1: (sim.amount1 as bigint).toString() });
  }
  log.info(`open v3 USDG single-side #${tokenId} ${tokSym}/USDG fee ${st.fee / 10000}% ${amountEthStr}Ξ`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash,
    mode: "single",
    tickLower,
    tickUpper,
    tick: tickNow,
    entryMcap: 0,
    swappedPct: 0,
    depositEth: amountEthStr,
    side: `SINGLE-SIDE USDG — parkir USDG, beli ${tokSym} cuma kalo masuk range (rug-safe)`,
    liquidity: sim.liquidity.toString(),
  };
}

/** MCAP range preview for the confirm screen, before minting. */
export async function previewRange(
  _tokenAddr: string,
  poolAddr: string,
  mode: MintMode = "single",
): Promise<RangePreview> {
  const st = await getPoolState(poolAddr);
  const { addr: _addr, meta } = await tokenSide(st);
  const { tickLower, tickUpper, swapFraction } = computeRange(st, mode);
  const px = await ethUsd().catch(() => 0);
  const mLo = mcapAtTick(st, tickLower, px, meta.supplyUi);
  const mHi = mcapAtTick(st, tickUpper, px, meta.supplyUi);
  return {
    mode,
    mcapNow: mcapAtTick(st, st.tick, px, meta.supplyUi),
    rangeMcapLow: Math.min(mLo, mHi),
    rangeMcapHigh: Math.max(mLo, mHi),
    tickLower,
    tickUpper,
    tick: st.tick,
    swapPct: mode === "inrange" ? Math.round(swapFraction * 0.98 * 100) : 0,
  };
}

/**
 * Original mint timestamp from Blockscout — for positions opened manually on the web UI
 * (no positions.json record). Cached back into positions.json (mintTs).
 */
const mintTsCache = new Map<string, number | null>();
export async function mintTimestamp(tokenId: string): Promise<number | null> {
  const key = String(tokenId);
  if (mintTsCache.has(key)) return mintTsCache.get(key)!;
  const cached = loadDeposit(key)?.mintTs;
  if (cached) {
    mintTsCache.set(key, cached);
    return cached;
  }
  const r = await bsFetch<{ items?: any[] }>(
    `/api/v2/tokens/${C.positionManager}/instances/${key}/transfers`,
    10_000,
  );
  const items = r?.items ?? [];
  const mint = items.filter((i) => /^0x0{40}$/i.test(i.from?.hash || "")).pop() ?? items.pop();
  const ts = mint?.timestamp ? new Date(mint.timestamp).getTime() : null;
  mintTsCache.set(key, ts);
  if (ts) {
    const d = readJson<Record<string, DepositRecord>>(POS_FILE, {});
    d[key] = { ...(d[key] ?? ({} as DepositRecord)), mintTs: ts };
    writeJson(POS_FILE, d);
  }
  return ts;
}

/** All open positions with live PnL, valued exactly as a close would settle. */
export async function listPositions(): Promise<PositionRow[]> {
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, provider);
  const npmW = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const n = Number(await npm.balanceOf!(w.address).catch(() => 0n));
  const px = await ethUsd().catch(() => 0);
  const { mapLimit } = await import("./blockscout.js");

  // Process every NFT index in PARALLEL (was a sequential for-loop → ~8 RPC round-trips per
  // position, one at a time; with many closed NFTs it dominated /list latency). ethers batches
  // the concurrent JSON-RPC calls, so this collapses to a handful of HTTP requests.
  const idxs = Array.from({ length: n }, (_, i) => i);
  const rows = (
    await mapLimit(idxs, 8, async (i): Promise<PositionRow | null> => {
      try {
        const id: bigint = await npm.tokenOfOwnerByIndex!(w.address, i);
        const p = await npm.positions!(id);
        if (p.liquidity === 0n) return null;
      const pool: string = await factory.getPool!(p.token0, p.token1, p.fee);
      const st = await getPoolState(pool);
      const tl = Number(p.tickLower);
      const tu = Number(p.tickUpper);
      const inRange = st.tick >= tl && st.tick < tu;
      const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
      const wethIs0 = p.token0.toLowerCase() === wethL;
      const wethIs1 = p.token1.toLowerCase() === wethL;
      // non-WETH pair (e.g. token/USDG): value via the pool oracle in a self-contained branch, so
      // the battle-tested WETH path below stays byte-for-byte unchanged.
      if (!wethIs0 && !wethIs1) return await usdgPositionRow(id, p, st, tl, tu, inRange, m0, m1, px, npmW);
      const tokMeta = wethIs0 ? m1 : m0;

      // exact principal (decreaseLiquidity.staticCall) + fees (collect.staticCall)
      let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
      try {
        const d = await npmW.decreaseLiquidity!.staticCall({
          tokenId: id,
          liquidity: p.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: deadline(),
        });
        pr0 = d[0];
        pr1 = d[1];
      } catch {
        /* position may not simulate; leave 0 */
      }
      try {
        const fr = await npmW.collect!.staticCall({
          tokenId: id,
          recipient: w.address,
          amount0Max: MAX_U128,
          amount1Max: MAX_U128,
        });
        fe0 = fr[0];
        fe1 = fr[1];
      } catch {
        /* leave 0 */
      }

      const wethRaw = wethIs0 ? pr0 + fe0 : pr1 + fe1;
      const tokRaw = wethIs0 ? pr1 + fe1 : pr0 + fe0;
      const feeTokRaw = wethIs0 ? fe1 : fe0;
      const wethEth = Number(ethers.formatEther(wethRaw));
      let tokEth = 0;
      if (tokRaw > 0n) {
        tokEth = (await quoteTokenToWeth(wethIs0 ? p.token1 : p.token0, tokRaw).catch(() => ({ weth: 0 }))).weth;
      }
      const valEth = wethEth + tokEth;
      const feeEth =
        Number(ethers.formatEther(wethIs0 ? fe0 : fe1)) +
        (tokRaw > 0n ? tokEth * (Number(feeTokRaw) / Number(tokRaw)) : 0);

      const dep = loadDeposit(id.toString());
      const depEth = dep ? Number(ethers.formatEther(dep.depositWeth)) : null;
      const pnlEth = depEth != null ? valEth - depEth : null;
      const pnlPct = depEth ? (pnlEth! / depEth) * 100 : null;

      const mcapNow = mcapAtTick(st, st.tick, px, tokMeta.supplyUi);
      const mLo = mcapAtTick(st, tl, px, tokMeta.supplyUi);
      const mHi = mcapAtTick(st, tu, px, tokMeta.supplyUi);
      const openedAt = dep?.ts ?? (await mintTimestamp(id.toString()));

      return {
        tokenId: id.toString(),
        pool,
        tokenAddr: wethIs0 ? ethers.getAddress(p.token1) : ethers.getAddress(p.token0),
        token0: m0.symbol,
        token1: m1.symbol,
        tokenSym: tokMeta.symbol,
        fee: Number(p.fee),
        inRange,
        tick: st.tick,
        tickLower: tl,
        tickUpper: tu,
        valEth,
        feeEth,
        depEth,
        pnlEth,
        pnlPct,
        mcapNow,
        rangeMcapLow: Math.min(mLo, mHi),
        rangeMcapHigh: Math.max(mLo, mHi),
        entryMcap: dep?.entryMcap ?? null,
        openedAt,
        ageMs: openedAt ? Date.now() - openedAt : null,
        ageSource: dep?.ts ? "bot" : openedAt ? "onchain" : null,
        mode: dep?.mode ?? "single",
      };
    } catch (e) {
      log.warn(`skip posisi index ${i}: ${errShort(e)}`); // no longer a silent skip
      return null;
    }
    })
  ).filter((r): r is PositionRow => r !== null);
  return rows;
}

/**
 * Value a token/USDG v3 position (no WETH leg) for /list. Principal + fees come from the same
 * decreaseLiquidity/collect staticCalls as the WETH path; each side is priced via the pool oracle
 * (USDG ≈ $1, token priced in USDG by the pool). PnL is LP-vs-HODL: the deposited amounts valued
 * at the CURRENT price, so a token merely dropping in price isn't counted as an LP loss.
 */
async function usdgPositionRow(
  id: bigint,
  p: any,
  st: PoolState,
  tl: number,
  tu: number,
  inRange: boolean,
  m0: TokenMeta,
  m1: TokenMeta,
  px: number,
  npmW: ethers.Contract,
): Promise<PositionRow | null> {
  const usdgIs0 = st.token0.toLowerCase() === USDG_L;
  const usdgIs1 = st.token1.toLowerCase() === USDG_L;
  if (!usdgIs0 && !usdgIs1) return null; // neither side is USDG → unknown quote, skip safely

  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  try {
    const d = await npmW.decreaseLiquidity!.staticCall({ tokenId: id, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() });
    pr0 = d[0];
    pr1 = d[1];
  } catch {
    /* leave 0 */
  }
  try {
    const fr = await npmW.collect!.staticCall({ tokenId: id, recipient: wallet().address, amount0Max: MAX_U128, amount1Max: MAX_U128 });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }

  const valUsd = currencyUsd(st, true, pr0 + fe0, px) + currencyUsd(st, false, pr1 + fe1, px);
  const feeUsd = currencyUsd(st, true, fe0, px) + currencyUsd(st, false, fe1, px);
  const valEth = px ? valUsd / px : 0;
  const feeEth = px ? feeUsd / px : 0;

  const tokMeta = usdgIs0 ? m1 : m0;
  const tokenAddr = usdgIs0 ? st.token1 : st.token0;
  const tokIsSide0 = !usdgIs0;
  const oneTok = ethers.parseUnits("1", tokMeta.decimals);
  const mcapNow = currencyUsd(st, tokIsSide0, oneTok, px) * tokMeta.supplyUi;

  const dep = loadDeposit(id.toString());
  // LP-vs-HODL basis: deposited amounts valued at CURRENT price (isolates fees + IL)
  const basisUsd = dep?.dep0 && dep?.dep1 ? currencyUsd(st, true, BigInt(dep.dep0), px) + currencyUsd(st, false, BigInt(dep.dep1), px) : null;
  const depEth = basisUsd != null && px ? basisUsd / px : dep ? Number(ethers.formatEther(dep.depositWeth)) : null;
  const pnlEth = depEth != null ? valEth - depEth : null;
  const pnlPct = depEth ? (pnlEth! / depEth) * 100 : null;
  const openedAt = dep?.ts ?? (await mintTimestamp(id.toString()));

  return {
    tokenId: id.toString(),
    pool: st.pool,
    tokenAddr: ethers.getAddress(tokenAddr),
    token0: m0.symbol,
    token1: m1.symbol,
    tokenSym: tokMeta.symbol,
    pair: `${tokMeta.symbol}/USDG`,
    quote: "usd",
    fee: st.fee,
    inRange,
    tick: st.tick,
    tickLower: tl,
    tickUpper: tu,
    valEth,
    feeEth,
    depEth,
    pnlEth,
    pnlPct,
    mcapNow,
    rangeMcapLow: 0,
    rangeMcapHigh: 0,
    entryMcap: dep?.entryMcap ?? null,
    openedAt,
    ageMs: openedAt ? Date.now() - openedAt : null,
    ageSource: dep?.ts ? "bot" : openedAt ? "onchain" : null,
    mode: dep?.mode ?? "inrange",
  };
}

/**
 * Close: decreaseLiquidity → collect → burn → (optionally) swap token → ETH → top up gas.
 * Records a permanent ledger entry with ETH/USD locked at close time.
 */
export async function closePosition(
  tokenId: string,
  opts: { swapToken?: boolean } = {},
): Promise<CloseResult> {
  const swapToken = opts.swapToken !== false && cfg.lp.autoSwapOnClose !== false;
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const p = await npm.positions!(tokenId);
  const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
  const wethIs0 = p.token0.toLowerCase() === wethL;
  const wethIs1 = p.token1.toLowerCase() === wethL;
  // non-WETH pair (token/USDG): dedicated close path (LP-vs-HODL PnL, USD-denominated)
  if (!wethIs0 && !wethIs1) return closeV3UsdgPosition(tokenId, opts);

  // exact principal + fee via staticCall (no float liquidity math)
  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  if (p.liquidity > 0n) {
    try {
      const d = await npm.decreaseLiquidity!.staticCall({
        tokenId,
        liquidity: p.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: deadline(),
      });
      pr0 = d[0];
      pr1 = d[1];
    } catch {
      /* leave 0 */
    }
  }
  try {
    const fr = await npm.collect!.staticCall({
      tokenId,
      recipient: w.address,
      amount0Max: MAX_U128,
      amount1Max: MAX_U128,
    });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }
  const wethOutRaw = wethIs0 ? pr0 + fe0 : pr1 + fe1;
  const feeWethRaw = wethIs0 ? fe0 : fe1;
  const recvWethEth = Number(ethers.formatEther(wethOutRaw));
  const feeEthOnly = Number(ethers.formatEther(feeWethRaw));

  const dep = loadDeposit(String(tokenId));
  const depEth = dep ? Number(ethers.formatEther(dep.depositWeth)) : null;

  // ── execute ──
  let decreaseHash: string | null = null;
  if (p.liquidity > 0n) {
    const dtx = await npm.decreaseLiquidity!(
      { tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() },
      await overrides(),
    );
    await dtx.wait();
    decreaseHash = dtx.hash;
  }
  const ctx = await npm.collect!(
    { tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 },
    await overrides(),
  );
  await ctx.wait();
  let burnHash: string | null = null;
  try {
    const btx = await npm.burn!(tokenId, await overrides());
    await btx.wait();
    burnHash = btx.hash;
  } catch {
    /* dust position may block burn — non-fatal */
  }

  // ── auto-swap token → ETH (timeout so close can't hang) ──
  const tokenMint = wethIs0 ? p.token1 : p.token0;
  const tokDec = wethIs0 ? m1.decimals : m0.decimals;
  let swapHash: string | null = null;
  let swappedWeth = 0;
  let tokenStuck = 0;
  let tokenSellEth = 0;
  const raw = await tokenBalanceRaw(tokenMint).catch(() => 0n);
  if (raw > 0n) {
    tokenSellEth = (await quoteTokenToWeth(tokenMint, raw).catch(() => ({ weth: 0 }))).weth;
    if (swapToken) {
      try {
        const sw = await Promise.race([
          swapTokenToWeth(tokenMint, raw),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 60_000)),
        ]);
        swapHash = sw.tx;
        swappedWeth = Number(ethers.formatEther(sw.amountOut));
      } catch {
        tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      }
    } else {
      tokenStuck = Number(ethers.formatUnits(raw, tokDec));
    }
  }

  const realOutEth = recvWethEth + (swappedWeth > 0 ? swappedWeth : tokenSellEth);
  const pnlEthReal = depEth != null ? realOutEth - depEth : null;
  const pnlPctReal = depEth ? (pnlEthReal! / depEth) * 100 : null;

  deleteDeposit(String(tokenId));

  let topUp = null;
  try {
    topUp = await ensureNativeEth(cfg.lp.nativeTargetEth);
  } catch {
    /* non-blocking */
  }

  const openedAt = dep?.ts ?? dep?.mintTs ?? null;
  const heldMs = openedAt ? Date.now() - openedAt : null;
  const tokSym = wethIs0 ? m1.symbol : m0.symbol;
  const pxClose = await ethUsd().catch(() => 0);

  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: tokSym,
      mode: dep?.mode ?? "single",
      openedAt,
      closedAt: Date.now(),
      heldMs,
      depEth: depEth ?? 0,
      outEth: realOutEth,
      feeEth: feeEthOnly,
      pnlEth: pnlEthReal,
      pnlPct: pnlPctReal,
      pnlUsd: pnlEthReal != null && pxClose ? pnlEthReal * pxClose : null,
      ethUsdAtClose: pxClose || null,
      entryMcap: dep?.entryMcap ?? null,
      tokenKept: !swapToken && tokenStuck > 0 ? tokenStuck : 0,
      tokenRug: swapToken && tokenStuck > 0 ? tokenStuck : 0,
    });
  } catch (e) {
    log.warn(`ledger append gagal (close tetap sukses): ${errShort(e)}`);
  }

  log.info(`close #${tokenId} ${tokSym} pnl=${pnlEthReal?.toFixed(6) ?? "?"}Ξ`);
  return {
    heldMs,
    decreaseHash,
    collectHash: ctx.hash,
    burnHash,
    swapHash,
    topUp,
    wethSym: wethIs0 ? m0.symbol : m1.symbol,
    tokenSym: tokSym,
    recvWeth: recvWethEth,
    recvToken: raw > 0n ? Number(ethers.formatUnits(raw, tokDec)) : 0,
    swappedWeth,
    tokenStuck,
    valEth: realOutEth,
    depEth,
    pnlEth: pnlEthReal,
    pnlPct: pnlPctReal,
  };
}

/**
 * Close a token/USDG v3 position (no WETH leg). decreaseLiquidity → collect → burn (generic),
 * value both sides via the pool oracle (USDG ≈ $1), then sell BOTH sides → ETH via Kyber to
 * realize + top up gas. PnL is LP-vs-HODL (deposited amounts valued at the CLOSE price), so a
 * token that only dropped in price isn't counted as an LP loss — matches the v4 USDG path.
 */
async function closeV3UsdgPosition(tokenId: string, opts: { swapToken?: boolean } = {}): Promise<CloseResult> {
  const swapToken = opts.swapToken !== false && cfg.lp.autoSwapOnClose !== false;
  const w = wallet();
  const npm = new ethers.Contract(C.positionManager, NPM_ABI, w);
  const p = await npm.positions!(tokenId);
  const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
  const pool: string = await factory.getPool!(p.token0, p.token1, p.fee);
  const st = await getPoolState(pool);
  const [m0, m1] = await Promise.all([tokenMeta(p.token0), tokenMeta(p.token1)]);
  const usdgIs0 = st.token0.toLowerCase() === USDG_L;
  const px = await ethUsd().catch(() => 0);

  // principal + fees via staticCall (current price, before touching the pool)
  let pr0 = 0n, pr1 = 0n, fe0 = 0n, fe1 = 0n;
  if (p.liquidity > 0n) {
    try {
      const d = await npm.decreaseLiquidity!.staticCall({ tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() });
      pr0 = d[0];
      pr1 = d[1];
    } catch {
      /* leave 0 */
    }
  }
  try {
    const fr = await npm.collect!.staticCall({ tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 });
    fe0 = fr[0];
    fe1 = fr[1];
  } catch {
    /* leave 0 */
  }
  const outUsd = currencyUsd(st, true, pr0 + fe0, px) + currencyUsd(st, false, pr1 + fe1, px);
  const feeUsd = currencyUsd(st, true, fe0, px) + currencyUsd(st, false, fe1, px);
  const outEth = px ? outUsd / px : 0;
  const feeEthOnly = px ? feeUsd / px : 0;

  const dep = loadDeposit(String(tokenId));
  const basisUsd = dep?.dep0 && dep?.dep1 ? currencyUsd(st, true, BigInt(dep.dep0), px) + currencyUsd(st, false, BigInt(dep.dep1), px) : null;
  const basisEth = basisUsd != null && px ? basisUsd / px : dep ? Number(ethers.formatEther(dep.depositWeth)) : null;

  // ── execute close ──
  let decreaseHash: string | null = null;
  if (p.liquidity > 0n) {
    const dtx = await npm.decreaseLiquidity!({ tokenId, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: deadline() }, await overrides());
    await dtx.wait();
    decreaseHash = dtx.hash;
  }
  const ctx = await npm.collect!({ tokenId, recipient: w.address, amount0Max: MAX_U128, amount1Max: MAX_U128 }, await overrides());
  await ctx.wait();
  let burnHash: string | null = null;
  try {
    const btx = await npm.burn!(tokenId, await overrides());
    await btx.wait();
    burnHash = btx.hash;
  } catch {
    /* dust position may block burn — non-fatal */
  }

  // ── sell BOTH sides → native ETH via Kyber (best route) so PnL realizes + gas tops up ──
  const usdg = usdgIs0 ? st.token0 : st.token1;
  const tokenMint = usdgIs0 ? st.token1 : st.token0;
  const tokDec = usdgIs0 ? m1.decimals : m0.decimals;
  const tokSym = usdgIs0 ? m1.symbol : m0.symbol;
  let swapHash: string | null = null;
  let tokenStuck = 0;
  if (swapToken) {
    for (const a of [tokenMint, usdg]) {
      const raw = await tokenBalanceRaw(a).catch(() => 0n);
      if (raw <= 0n) continue;
      try {
        const k = await Promise.race([
          kyberSwap(a, KYBER_NATIVE, raw),
          new Promise<null>((res) => setTimeout(() => res(null), 60_000)),
        ]);
        if (k?.tx) swapHash = k.tx;
        else if (a === tokenMint) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      } catch {
        if (a === tokenMint) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
      }
    }
  } else {
    const raw = await tokenBalanceRaw(tokenMint).catch(() => 0n);
    if (raw > 0n) tokenStuck = Number(ethers.formatUnits(raw, tokDec));
  }

  const pnlEth = basisEth != null && basisEth > 0 ? outEth - basisEth : null;
  const pnlPct = pnlEth != null && basisEth ? (pnlEth / basisEth) * 100 : null;

  deleteDeposit(String(tokenId));
  let topUp = null;
  try {
    topUp = await ensureNativeEth(cfg.lp.nativeTargetEth);
  } catch {
    /* non-blocking */
  }

  const openedAt = dep?.ts ?? dep?.mintTs ?? null;
  const heldMs = openedAt ? Date.now() - openedAt : null;
  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: tokSym,
      version: "v3",
      pair: `${tokSym}/USDG`,
      quote: "usd",
      mode: dep?.mode ?? "inrange",
      openedAt,
      closedAt: Date.now(),
      heldMs,
      depEth: basisEth ?? 0,
      outEth,
      feeEth: feeEthOnly,
      pnlEth,
      pnlPct,
      pnlUsd: pnlEth != null && px ? pnlEth * px : null,
      ethUsdAtClose: px || null,
      entryMcap: dep?.entryMcap ?? null,
      tokenKept: !swapToken && tokenStuck > 0 ? tokenStuck : 0,
      tokenRug: swapToken && tokenStuck > 0 ? tokenStuck : 0,
    });
  } catch (e) {
    log.warn(`ledger append gagal (USDG close tetap sukses): ${errShort(e)}`);
  }

  log.info(`close v3 USDG #${tokenId} ${tokSym}/USDG pnl=${pnlEth?.toFixed(6) ?? "?"}Ξ`);
  return {
    heldMs,
    decreaseHash,
    collectHash: ctx.hash,
    burnHash,
    swapHash,
    topUp,
    wethSym: "USDG",
    tokenSym: tokSym,
    recvWeth: 0,
    recvToken: 0,
    swappedWeth: outEth,
    tokenStuck,
    valEth: outEth,
    depEth: basisEth,
    pnlEth,
    pnlPct,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function errShort(e: unknown): string {
  const m = (e as any)?.shortMessage || (e as Error)?.message || String(e);
  return String(m).slice(0, 120);
}
