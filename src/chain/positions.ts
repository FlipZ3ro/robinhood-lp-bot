/**
 * Open / list / close LP positions.
 *
 * Tick & price math is delegated to the Uniswap SDK (see pools.ts). Principal and fee
 * amounts are read via decreaseLiquidity/collect `staticCall` — i.e. the node simulates
 * the exact withdrawal, so /list shows what you'd actually receive, with zero local
 * liquidity→amount float math (the v1 precision bug).
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { NPM_ABI, FACTORY_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import { tokenMeta } from "./tokens.js";
import { getPoolState, computeRange, mcapAtTick, type PoolState } from "./pools.js";
import {
  quoteTokenToWeth,
  swapWethToToken,
  swapTokenToWeth,
  tokenBalanceRaw,
  ensureNativeEth,
} from "./swaps.js";
import { ethUsd } from "./price.js";
import { appendLedger } from "./ledger.js";
import { bsFetch } from "./blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { MintMode, OpenResult, PositionRow, CloseResult, RangePreview } from "../types.js";

const log = logger("position");
const MAX_U128 = (1n << 128n) - 1n;

// ── deposit basis persistence (data/positions.json) ──
const POS_FILE = dataPath("positions.json");
type DepositRecord = { depositWeth: string; ts: number; entryMcap?: number; mode?: MintMode; mintTs?: number };

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

  // swap 98% of the requirement so leftover WETH stays WETH (not stuck token)
  const frac = swapFraction * 0.98;
  const wethToSwap = (depositAmt * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
  const sw = await swapWethToToken(tokenReal, wethToSwap, st.fee);
  const tokenGot = sw.amountOut;
  if (tokenGot <= 0n) throw new Error("swap WETH → token tidak menghasilkan token (pool kering?)");

  const erc = new ethers.Contract(tokenReal, ERC20_ABI, w);
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

  // cost basis = WETH side actually used + all WETH spent buying token (incl. swap fee = honest)
  const wethUsed = st.wethIsToken0 ? sim.amount0 : sim.amount1;
  const costBasis = (wethUsed as bigint) + wethToSwap;
  const entryMcap = mcapAtTick(fresh, tickNow, px, tokMeta.supplyUi);
  if (tokenId) saveDeposit(tokenId, costBasis, { entryMcap, mode: "inrange" });
  log.info(`open inrange #${tokenId} ${tokMeta.symbol} swapped=${Math.round(frac * 100)}%`);
  return {
    tokenId,
    txHash: tx.hash,
    wrapHash,
    swapHash: sw.tx,
    mode: "inrange",
    tickLower,
    tickUpper,
    tick: tickNow,
    entryMcap,
    swappedPct: Math.round(frac * 100),
    depositEth: ethers.formatEther(costBasis),
    side: `IN RANGE — langsung makan fee (≈${Math.round(frac * 100)}% modal jadi token)`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function errShort(e: unknown): string {
  const m = (e as any)?.shortMessage || (e as Error)?.message || String(e);
  return String(m).slice(0, 120);
}
