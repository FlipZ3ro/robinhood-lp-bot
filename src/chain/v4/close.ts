/**
 * v4 close + fee-collect. Works for ANY pair (token/ETH, token/USDG, token/token) by
 * reconstructing the Position from the REAL pool currencies — the earlier code forced
 * native ETH as currency0, which produced wrong calldata and reverted on non-ETH pools.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { loadV4Deposit, approveViaPermit2 } from "./mint.js";
import { listV4Positions } from "./list.js";
import { ethUsd } from "../price.js";
import { kyberSwap, KYBER_NATIVE } from "../kyber.js";
import { appendLedger } from "../ledger.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, CurrencyAmount, Percent } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4close");
const STABLES = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]); // USDG
const WETH_L = C.weth.toLowerCase();

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return addr.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/** Reconstruct the SDK Pool + Position for a tokenId from real on-chain currencies. */
async function loadPosition(tokenId: string) {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const liquidity: bigint = await posm.getPositionLiquidity!(tokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const [m0, m1] = await Promise.all([
    c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const poolId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]),
  );
  const s0 = await sv.getSlot0!(poolId);
  const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
  const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
  const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", Number(s0.tick));
  const position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
  return { pool, position, cur0, cur1, c0, c1, m0, m1, fee, tickLower, tickUpper };
}

async function simulateAndSend(calldata: string, value: string, label: string): Promise<string> {
  const w = wallet();
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi ${label} v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  await tx.wait();
  return tx.hash;
}

export interface V4CloseResult {
  txHash: string;
  fee: number;
  recv0: number;
  sym0: string;
  recv1: number;
  sym1: string;
  depEth: number | null;
  pair: string;
  outEth: number; // realized value at close (ETH)
  feeEth: number; // fees earned over the position's life (ETH)
  pnlEth: number | null;
  pnlPct: number | null;
  forfeited: string | null; // symbol of a honeypot token forfeited to salvage the ETH side
  sweepHash?: string | null; // Kyber tx if proceeds were auto-swapped → native ETH
  sweptEth?: number; // ETH gained from sweeping token/USDG proceeds back to native
}

export async function closeV4Position(tokenId: string, reason?: "TP" | "SL" | "OOR" | "VFADE" | "manual"): Promise<V4CloseResult> {
  const w = wallet();
  // Read the pool key + currencies directly (no SDK Pool). The SDK's removeCallParameters
  // throws "Invariant failed: PRICE_BOUNDS" on extreme-price pools (WOLVES/USDG) when it
  // applies slippage, and returns a null `value` for non-native pairs → "invalid BigNumberish".
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk] = await posm.getPoolAndPositionInfo!(tokenId);
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const [m0, m1] = await Promise.all([
    c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);

  // Snapshot the position's USD value + fees + pair BEFORE closing (needs the position live) so
  // we can write an accurate ledger entry. valueUsd at close = realized value; deposit is the
  // recorded ETH funding → PnL in ETH is exact (deposit was ETH-denominated, no historical price).
  let pre: { valueUsd: number; feeUsd: number; pair: string; sym: string } | null = null;
  try {
    const rows = await listV4Positions();
    const r = rows.find((x) => x.tokenId === String(tokenId));
    if (r) pre = { valueUsd: r.valueUsd, feeUsd: r.feeUsd, pair: r.pair, sym: r.sym };
  } catch {
    /* best-effort — ledger entry just won't have USD value */
  }

  // Manual full close: BURN_POSITION(0x03) removes ALL liquidity + accrued fees and burns the
  // NFT; TAKE_PAIR(0x11) sweeps both currencies to the wallet. amountMin=0 (we simulate first,
  // so a bad close never costs gas). Same action set the SDK emits for burnToken:true.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const iface = new ethers.Interface(["function modifyLiquidities(bytes,uint256) payable"]);
  const dl = Math.floor(Date.now() / 1000 + 600);
  const burnParams = coder.encode(["uint256", "uint128", "uint128", "bytes"], [tokenId, 0, 0, "0x"]);
  const takeParams = coder.encode(["address", "address", "address"], [c0, c1, w.address]);
  const unlockData = coder.encode(["bytes", "bytes[]"], ["0x0311", [burnParams, takeParams]]);
  const calldata = iface.encodeFunctionData("modifyLiquidities", [unlockData, dl]);

  const [bal0Before, bal1Before] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  let txHash: string;
  let forfeited: string | null = null;
  try {
    txHash = await simulateAndSend(calldata, "0", "close");
  } catch (e) {
    // A honeypot/rug token can revert its own transfer() (the pool can't send it out), so a
    // normal close fails on CurrencyNotSettled. Recover the GOOD side (ETH/WETH/stable) and
    // FORFEIT the un-transferable token via CLEAR_OR_TAKE(0x13) — better to salvage the ETH.
    const isGood = (a: string) => {
      const x = a.toLowerCase();
      return x === NATIVE || x === C.weth.toLowerCase() || STABLES.has(x);
    };
    if (isGood(c0) === isGood(c1)) throw e; // nothing clearly salvageable → surface the real error
    const ct0 = coder.encode(["address", "uint256"], [c0, isGood(c0) ? 0n : ethers.MaxUint256]); // 0→take, MAX→clear
    const ct1 = coder.encode(["address", "uint256"], [c1, isGood(c1) ? 0n : ethers.MaxUint256]);
    const fcUnlock = coder.encode(["bytes", "bytes[]"], ["0x031313", [burnParams, ct0, ct1]]); // BURN + CLEAR_OR_TAKE ×2
    const fcCalldata = iface.encodeFunctionData("modifyLiquidities", [fcUnlock, dl]);
    txHash = await simulateAndSend(fcCalldata, "0", "force-close");
    forfeited = isGood(c0) ? m1.symbol : m0.symbol;
    log.warn(`force-close #${tokenId}: forfeited ${forfeited} (token blokir transfer/honeypot), ETH diselamatkan`);
  }
  const [bal0After, bal1After] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);

  const dep = loadV4Deposit(String(tokenId));
  const depEth = dep?.depositWei ? Number(ethers.formatEther(dep.depositWei)) : null;
  const pair = pre?.pair ?? `${m0.symbol}/${m1.symbol}`;
  const px = await ethUsd().catch(() => 0);
  const outEth = pre && px ? pre.valueUsd / px : 0;
  const feeEth = pre && px ? pre.feeUsd / px : 0;

  // BASIS for PnL. For ETH pairs the deposit was ETH-funded → realized PnL vs that ETH is exact.
  // For USDG (non-ETH) pairs, funding the position swapped ETH→USDG+token, so the recorded ETH
  // deposit is contaminated by the token's own price move. We instead measure LP-vs-HODL: value
  // the DEPOSITED token amounts at the CLOSE price, so a token that merely dropped in price isn't
  // counted as an LP loss — only fees + impermanent loss are. Keeps forward-close consistent with
  // the historical reconstruction (backfill.ts), which is why WOLVES/USDG shows fee-driven profit.
  let basisEth = depEth;
  const isUsdgPair = STABLES.has(c0.toLowerCase()) || STABLES.has(c1.toLowerCase());
  if (isUsdgPair && dep?.dep0 && dep?.dep1 && px) {
    try {
      const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
      const poolId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24", "int24", "address"],
          [c0, c1, fee, Number(pk.tickSpacing), pk.hooks],
        ),
      );
      const s0 = await sv.getSlot0!(poolId);
      const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
      const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
      const pool = new Pool(cur0, cur1, fee, Number(pk.tickSpacing), pk.hooks, s0.sqrtPriceX96.toString(), "0", Number(s0.tick));
      const valUsd = (addr: string, dec: number, sym: string, raw: bigint, cur: any, otherAddr: string, otherSym: string): number => {
        if (raw <= 0n) return 0;
        const a = addr.toLowerCase();
        const ui = Number(ethers.formatUnits(raw, dec));
        if (a === NATIVE || a === WETH_L) return ui * px;
        if (STABLES.has(a) || /usd/i.test(sym)) return ui;
        try {
          const inOther = Number(pool.priceOf(cur).quote(CurrencyAmount.fromRawAmount(cur, raw.toString())).toExact());
          const oa = otherAddr.toLowerCase();
          if (oa === NATIVE || oa === WETH_L) return inOther * px;
          if (STABLES.has(oa) || /usd/i.test(otherSym)) return inOther;
        } catch {
          /* price out of range → skip */
        }
        return 0;
      };
      const hodlUsd =
        valUsd(c0, m0.decimals, m0.symbol, BigInt(dep.dep0), cur0, c1, m1.symbol) +
        valUsd(c1, m1.decimals, m1.symbol, BigInt(dep.dep1), cur1, c0, m0.symbol);
      if (hodlUsd > 0) basisEth = hodlUsd / px;
    } catch (e: any) {
      log.warn(`LP-vs-HODL basis failed #${tokenId}: ${e?.message ?? e} — falling back to ETH-funded basis`);
    }
  }
  const pnlEth = basisEth != null && basisEth > 0 && pre ? outEth - basisEth : null;
  const pnlPct = pnlEth != null && basisEth ? (pnlEth / basisEth) * 100 : null;

  // record to the unified ledger (so /ledger shows v4 modal/PnL + counts it in stats)
  try {
    appendLedger({
      tokenId: String(tokenId),
      sym: pre?.sym ?? m0.symbol,
      version: "v4",
      pair,
      quote: isUsdgPair ? "usd" : "eth",
      mode: dep?.mode === "inrange" ? "inrange" : "single",
      openedAt: dep?.ts ?? null,
      closedAt: Date.now(),
      heldMs: dep?.ts ? Date.now() - dep.ts : null,
      depEth: basisEth ?? 0,
      outEth,
      feeEth,
      pnlEth,
      pnlPct,
      pnlUsd: pnlEth != null && px ? pnlEth * px : null,
      ethUsdAtClose: px || null,
      tokenKept: 0,
      tokenRug: 0,
      unsoldEth: 0,
      source: "bot",
      reason: reason ?? "manual",
    });
  } catch (e) {
    log.warn(`gagal tulis ledger v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
  }

  dropDeposit(tokenId);

  // ── sweep proceeds → native ETH (like the v3 USDG close) so the wallet returns to CLEAN ETH:
  //    PnL realizes and native gas tops up, so auto-add never gets stuck holding USDG after a close.
  //    Swaps ALL non-native currency balances (the volatile token AND USDG) via Kyber. Gated by
  //    cfg.lp.autoSwapOnClose. Native ETH / WETH are already ETH-equivalent so they're skipped.
  let sweepHash: string | null = null;
  let sweptEth = 0;
  if (cfg.lp.autoSwapOnClose !== false) {
    for (const [addr, dec] of [[c0, m0.decimals], [c1, m1.decimals]] as const) {
      const a = addr.toLowerCase();
      if (a === NATIVE || a === WETH_L) continue; // already ETH-equivalent
      const raw = await rawBalOf(addr);
      if (raw <= 0n) continue;
      try {
        const k = await Promise.race([kyberSwap(addr, KYBER_NATIVE, raw), new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
        if (k?.tx) {
          sweepHash = k.tx;
          sweptEth += Number(ethers.formatEther(k.amountOut));
          log.info(`sweep v4 #${tokenId}: ${STABLES.has(a) ? "USDG" : "token"} ${ethers.formatUnits(raw, dec)} → ${Number(ethers.formatEther(k.amountOut)).toFixed(6)} ETH`);
        }
      } catch {
        /* leave the currency in the wallet if the swap fails (non-fatal) */
      }
    }
  }

  log.info(`close v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return {
    txHash,
    fee,
    recv0: Math.max(0, bal0After - bal0Before),
    sym0: m0.symbol,
    recv1: Math.max(0, bal1After - bal1Before),
    sym1: m1.symbol,
    depEth: basisEth,
    pair,
    outEth,
    feeEth,
    pnlEth,
    pnlPct,
    forfeited,
    sweepHash,
    sweptEth,
  };
}

export interface V4CollectResult {
  txHash: string;
  fee0: number;
  sym0: string;
  fee1: number;
  sym1: string;
}

/**
 * Collect accrued fees WITHOUT removing liquidity. The SDK's removeCallParameters rejects
 * 0% liquidity, so we manually encode the standard v4 collect: DECREASE_LIQUIDITY(0) which
 * settles fees into owed balances, then TAKE_PAIR to sweep them to the wallet.
 */
export async function collectV4Fees(tokenId: string): Promise<V4CollectResult> {
  const w = wallet();
  const { c0, c1, m0, m1 } = await loadPosition(tokenId);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const actions = "0x0111"; // DECREASE_LIQUIDITY(0x01), TAKE_PAIR(0x11)
  const decParams = coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [tokenId, 0, 0, 0, "0x"]);
  const takeParams = coder.encode(["address", "address", "address"], [c0, c1, w.address]);
  const unlockData = coder.encode(["bytes", "bytes[]"], [actions, [decParams, takeParams]]);
  const iface = new ethers.Interface(["function modifyLiquidities(bytes,uint256) payable"]);
  const calldata = iface.encodeFunctionData("modifyLiquidities", [unlockData, Math.floor(Date.now() / 1000 + 600)]);

  const [b0, b1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  const txHash = await simulateAndSend(calldata, "0", "collect");
  const [a0, a1] = await Promise.all([balOf(c0, m0.decimals), balOf(c1, m1.decimals)]);
  log.info(`collect v4 #${tokenId} ${m0.symbol}/${m1.symbol}`);
  return { txHash, fee0: Math.max(0, a0 - b0), sym0: m0.symbol, fee1: Math.max(0, a1 - b1), sym1: m1.symbol };
}

export interface V4CompoundResult {
  compounded: boolean;
  reason?: string;
  txHash?: string;
  add0?: number;
  sym0?: string;
  add1?: number;
  sym1?: string;
}

/**
 * #3 fee-compound: harvest an in-range position's accrued fees and add them straight back as
 * liquidity (no swap → no fee drag). Collects fees to the wallet, measures EXACTLY what was
 * collected (raw balance delta, so any pre-held USDG parked in the wallet is NEVER redeposited),
 * then increases the same tokenId with those amounts. The ratio-mismatch remainder stays as dust
 * (tiny; swept on the eventual close). USDG/ERC20 pairs only — a native-ETH leg needs a useNative
 * settle path, so ETH pairs are skipped (returns compounded:false with a reason).
 *
 * Deposit basis is intentionally UNCHANGED: the fees were already earned profit, so folding them
 * into liquidity doesn't raise the cost basis — they surface as PnL when the position finally closes.
 */
export async function compoundV4Position(tokenId: string): Promise<V4CompoundResult> {
  const { pool, c0, c1, m0, m1, tickLower, tickUpper } = await loadPosition(tokenId);
  if (c0.toLowerCase() === NATIVE || c1.toLowerCase() === NATIVE) {
    return { compounded: false, reason: "pair ETH (compound cuma pair USDG/ERC20)" };
  }

  // 1) harvest — RAW deltas so pre-held balances (e.g. parked USDG) are never folded in
  const [before0, before1] = await Promise.all([rawBalOf(c0), rawBalOf(c1)]);
  await collectV4Fees(tokenId);
  const [after0, after1] = await Promise.all([rawBalOf(c0), rawBalOf(c1)]);
  const fee0 = after0 > before0 ? after0 - before0 : 0n;
  const fee1 = after1 > before1 ? after1 - before1 : 0n;
  if (fee0 <= 0n && fee1 <= 0n) return { compounded: false, reason: "gak ada fee kekumpul" };

  // 2) build an INCREASE from EXACTLY the collected fees; scale to what we hold so the slippage-max
  //    settle can't overpull (same guard the open path uses). Binding side sets liquidity.
  const slip = new Percent(5, 100);
  const mk = (a0: bigint, a1: bigint) =>
    Position.fromAmounts({ pool, tickLower, tickUpper, amount0: a0.toString(), amount1: a1.toString(), useFullPrecision: true });
  let position = mk(fee0, fee1);
  try {
    const mx = position.mintAmountsWithSlippage(slip);
    const m0max = BigInt(mx.amount0.toString());
    const m1max = BigInt(mx.amount1.toString());
    let numer = 1_000_000n;
    if (m0max > fee0 && m0max > 0n) { const r = (fee0 * 1_000_000n) / m0max; if (r < numer) numer = r; }
    if (m1max > fee1 && m1max > 0n) { const r = (fee1 * 1_000_000n) / m1max; if (r < numer) numer = r; }
    if (numer < 1_000_000n) { const s = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; position = mk(s(fee0), s(fee1)); }
  } catch {
    /* SDK lacks mintAmountsWithSlippage */
  }
  if (position.liquidity.toString() === "0") return { compounded: false, reason: "fee kekecilan/gak seimbang buat nambah liq" };

  // 3) approve both ERC20 via Permit2, then INCREASE_LIQUIDITY on the existing tokenId
  await approveViaPermit2(c0);
  await approveViaPermit2(c1);
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    tokenId,
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
  });
  const txHash = await simulateAndSend(calldata, value ?? "0", "compound");
  const add0 = Number(ethers.formatUnits(BigInt(position.amount0.quotient.toString()), m0.decimals));
  const add1 = Number(ethers.formatUnits(BigInt(position.amount1.quotient.toString()), m1.decimals));
  log.info(`compound v4 #${tokenId} ${m0.symbol}/${m1.symbol}: +${add0} ${m0.symbol} +${add1} ${m1.symbol}`);
  return { compounded: true, txHash, add0, sym0: m0.symbol, add1, sym1: m1.symbol };
}

async function balOf(addr: string, dec: number): Promise<number> {
  const w = wallet();
  if (addr.toLowerCase() === NATIVE) return Number(ethers.formatEther(await provider.getBalance(w.address)));
  const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  return Number(ethers.formatUnits(await erc.balanceOf!(w.address).catch(() => 0n), dec));
}

/** Raw ERC-20 balance (for sweeping proceeds → ETH after close). */
async function rawBalOf(addr: string): Promise<bigint> {
  const w = wallet();
  const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  return erc.balanceOf!(w.address).catch(() => 0n);
}

function dropDeposit(tokenId: string): void {
  try {
    const d = readJson<Record<string, unknown>>(dataPath("v4-positions.json"), {});
    delete d[String(tokenId)];
    writeJson(dataPath("v4-positions.json"), d);
  } catch {
    /* */
  }
}
