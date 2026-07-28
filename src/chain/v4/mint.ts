/**
 * v4 LP open — single-sided native ETH (rug-safe, no Permit2, no token needed).
 *
 * Verified by staticCall simulation on chain 4663: single-sided ETH means a range ABOVE
 * the current tick (ETH = currency0, not yet converted to token). The @uniswap/v4-sdk
 * generates the modifyLiquidities calldata + native value; we simulate every mint with
 * eth_call BEFORE broadcasting, so a mint that would revert never costs gas.
 *
 * In-range (both-sided) v4 needs the token via Permit2 + a pre-swap — deferred.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { discoverV4Pools, pickV4Pool, USDG, type V4Pool } from "./discover.js";
import { swapEthToTokenV4, quoteV4 } from "./swap.js";
import { kyberSwap, kyberEnabled, KYBER_NATIVE } from "../kyber.js";
import { NATIVE, computePoolId, type PoolKey } from "./poolkey.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { mapLimit } from "../blockscout.js";
import { WETH_ABI } from "../abis.js";
import { ethUsd } from "../price.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, Percent, CurrencyAmount } = sdkCore as any;
const { Pool, Position, V4PositionManager } = v4sdk as any;
const log = logger("v4mint");
const POS_FILE = dataPath("v4-positions.json");
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // canonical, all chains

export interface V4OpenResult {
  tokenId: string | null;
  txHash: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  depositEth: string;
  poolId: string;
}

type V4Dep = { depositWei: string; ts: number; poolId: string; fee: number; tickLower: number; tickUpper: number; mode: string; dep0?: string; dep1?: string };

export function saveV4Deposit(tokenId: string, rec: V4Dep): void {
  const d = readJson<Record<string, V4Dep>>(POS_FILE, {});
  d[tokenId] = rec;
  writeJson(POS_FILE, d);
}
export function loadV4Deposit(tokenId: string): V4Dep | null {
  return readJson<Record<string, V4Dep>>(POS_FILE, {})[tokenId] ?? null;
}

const NATIVE_GAS_BUFFER = ethers.parseEther("0.0003"); // keep some native for tx gas

/**
 * v4 native-ETH mints settle the ETH side as NATIVE ETH (not WETH). If the wallet is mostly
 * WETH (common — v3 wraps, closes unwrap-partially), the mint's native `value` exceeds the
 * native balance and the sim reverts with empty data ("missing revert data"). Unwrap the
 * shortfall WETH → ETH first so native covers the deposit + gas.
 */
async function ensureNativeEth(needWei: bigint): Promise<void> {
  const w = wallet();
  const bal = await provider.getBalance(w.address);
  if (bal >= needWei) return;
  const short = needWei - bal;
  const weth = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbal: bigint = await weth.balanceOf!(w.address).catch(() => 0n);
  if (wbal < short) {
    throw new Error(
      `ETH native kurang buat v4 mint: butuh ${ethers.formatEther(needWei)}Ξ, ada ${ethers.formatEther(bal)}Ξ native + ${ethers.formatEther(wbal)} WETH`,
    );
  }
  log.info(`unwrap ${ethers.formatEther(short)} WETH → ETH native (v4 butuh native)`);
  await (await weth.withdraw!(short, await overrides())).wait();
}

function buildSdkPool(token: string, decimals: number, symbol: string, pool: V4Pool) {
  const eth = Ether.onChain(cfg.chainId);
  const tok = new Token(cfg.chainId, ethers.getAddress(token), decimals, symbol);
  return new Pool(
    eth,
    tok,
    pool.fee,
    pool.tickSpacing,
    pool.poolKey.hooks,
    pool.sqrtPriceX96.toString(),
    pool.liquidity.toString(),
    pool.tick,
  );
}

/**
 * Open a single-sided native-ETH v4 position at the highest-fee pool with liquidity
 * (or a specific fee tier). Simulates before broadcasting.
 */
export async function openV4SingleSide(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult> {
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error("tidak ada pool v4/ETH dengan likuiditas");

  const meta = await tokenMeta(token);
  const sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, pool);

  // single-sided ETH → range ABOVE current tick (ETH not yet sold into token)
  const sp = pool.tickSpacing;
  const width = Math.max(1, opts.widthSpacings ?? Math.round((cfg.lp.widthPct / 100) / (Math.pow(1.0001, sp) - 1)));
  const tickLower = Math.ceil(pool.tick / sp) * sp + sp;
  const tickUpper = tickLower + width * sp;
  const amountWei = ethers.parseEther(amountEthStr);
  // single-side parks NATIVE ETH — unwrap WETH if native is short
  await ensureNativeEth(amountWei + NATIVE_GAS_BUFFER);

  const position = Position.fromAmount0({
    pool: sdkPool,
    tickLower,
    tickUpper,
    amount0: amountWei.toString(),
    useFullPrecision: true,
  });
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil buat range ini");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(Math.round((cfg.lp.slippagePct || 5)), 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  // SIMULATE before spending gas
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi mint v4 revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }

  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, {
      depositWei: amountWei.toString(),
      ts: Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "single",
    });
  }
  log.info(`open v4 #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% ${amountEthStr}Ξ`);
  return { tokenId, txHash: tx.hash, fee: pool.fee, tickLower, tickUpper, depositEth: amountEthStr, poolId: pool.poolId };
}

/**
 * Open an IN-RANGE native-ETH v4 position (farming: earns fees immediately). Swaps part of
 * the ETH → token via the UniversalRouter, approves the token through Permit2, then mints a
 * range straddling the current price. Simulates before broadcasting.
 */
/**
 * After a two-sided v4 mint, sell any UN-DEPOSITED leftover back to native ETH. v4 (unlike the v3 NPM)
 * does NOT refund the excess side, so a both-sided add always leaves a bit of one currency in the
 * wallet ("selalu ada sisa"). Sweep it → ETH so nothing accumulates + token exposure drops. Best-effort;
 * skips native ETH / WETH and sub-$0.30 USDG dust (gas > value).
 */
async function sweepLeftoverToEth(sides: Array<{ addr: string; dec: number }>): Promise<string | undefined> {
  if (!kyberEnabled()) return undefined;
  const w = wallet();
  let hash: string | undefined;
  for (const { addr, dec } of sides) {
    const a = addr.toLowerCase();
    if (a === NATIVE.toLowerCase() || a === C.weth.toLowerCase()) continue; // already ETH-equivalent
    const erc = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
    const raw: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
    if (raw <= 0n) continue;
    if (a === USDG.toLowerCase() && raw < 300_000n) continue; // skip <$0.30 USDG dust
    try {
      const k = await kyberSwap(addr, KYBER_NATIVE, raw);
      if (k?.tx) {
        hash = k.tx;
        log.info(`sweep sisa ${ethers.formatUnits(raw, dec)} ${a === USDG.toLowerCase() ? "USDG" : "token"} → ${ethers.formatEther(k.amountOut)} ETH`);
      }
    } catch {
      /* best-effort — leave it in the wallet if the swap fails */
    }
  }
  return hash;
}

export async function openV4InRange(
  token: string,
  amountEthStr: string,
  opts: { fee?: number; widthSpacings?: number } = {},
): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const w = wallet();
  const pools = await discoverV4Pools(token);
  const pool = opts.fee ? pools.find((p) => p.fee === opts.fee) ?? null : pickV4Pool(pools);
  if (!pool) throw new Error("tidak ada pool v4/ETH dengan likuiditas");
  const meta = await tokenMeta(token);
  const sp = pool.tickSpacing;

  // symmetric range straddling current tick
  const halfSpacings = Math.max(1, Math.round((opts.widthSpacings ?? 8) / 2));
  const anchor = Math.floor(pool.tick / sp) * sp;
  let tickLower = anchor - halfSpacings * sp;
  let tickUpper = anchor + halfSpacings * sp;

  const total = ethers.parseEther(amountEthStr);
  // v4 needs NATIVE ETH for both the swap and the mint value — unwrap WETH if native is short
  await ensureNativeEth(total + NATIVE_GAS_BUFFER);
  let sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, { ...pool });
  const isC0Native = pool.poolKey.currency0.toLowerCase().startsWith("0x000000000000000000");
  const tokCur = isC0Native ? sdkPool.currency1 : sdkPool.currency0;
  const priceTokenInEth = (raw: bigint): bigint => {
    if (raw <= 0n) return 0n;
    try {
      return BigInt(sdkPool.priceOf(tokCur).quote(CurrencyAmount.fromRawAmount(tokCur, raw.toString())).quotient.toString());
    } catch {
      return 0n;
    }
  };

  const erc = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    w,
  );

  // REUSE token we already hold (e.g. bought on a prior failed attempt) — don't re-buy.
  const tokenHave: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  const haveEthValue = priceTokenInEth(tokenHave);

  // token value (in ETH) this range wants; swap ONLY the shortfall (0 if we already hold enough)
  const frac = Math.min(0.9, Math.max(0.05, swapFractionV4(pool.tick, tickLower, tickUpper) * 0.98));
  const targetTokenEth = (total * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
  let ethToSwap = targetTokenEth > haveEthValue ? targetTokenEth - haveEthValue : 0n;
  const maxSwap = (total * 9n) / 10n;
  if (ethToSwap > maxSwap) ethToSwap = maxSwap;

  // 1) buy the token shortfall with the BEST execution. Route via the KyberSwap aggregator
  //    (auto multi-hop across every DEX/fee-tier/hook → lowest fee + price impact). Buying on
  //    the high-fee pool you're farming would bleed fee + slippage = instant loss. Falls back
  //    to a direct v4 swap on the deepest single pool if the aggregator can't route.
  let swapHash: string | undefined;
  let swappedPct = 0;
  if (ethToSwap >= ethers.parseEther("0.00002")) {
    let out = 0n;
    if (kyberEnabled()) {
      const k = await kyberSwap(KYBER_NATIVE, ethers.getAddress(token), ethToSwap).catch((e) => {
        log.warn(`kyber gagal (${(e as Error).message.slice(0, 80)}) → fallback v4 direct`);
        return null;
      });
      if (k && k.amountOut > 0n) {
        swapHash = k.tx;
        out = k.amountOut;
        log.info(`beli ${meta.symbol} via KyberSwap (best route) → ${out}`);
      }
    }
    if (out <= 0n) {
      const via = (await bestSwapPool(pools, ethToSwap)) ?? pool;
      const sw = await swapEthToTokenV4(via.poolKey, ethToSwap);
      if (sw.amountOut <= 0n) throw new Error("swap ETH→token gagal (pool kering?)");
      swapHash = sw.tx;
    }
    swappedPct = Math.round((Number(ethToSwap) / Number(total)) * 100);
  } else {
    ethToSwap = 0n; // enough token on hand — LP straight from balance
  }

  // 2) actual token balance now (existing + any swapped)
  const tokenBal: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  if (tokenBal <= 0n) throw new Error("token balance 0 — nggak ada yang bisa di-LP");

  // 3) approve token via Permit2 (ERC20 → Permit2, Permit2 → PositionManager)
  if ((await erc.allowance!(w.address, PERMIT2)) < tokenBal) {
    await (await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides())).wait();
  }
  const permit2 = new ethers.Contract(PERMIT2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)"], w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await (await permit2.approve!(token, C.v4PositionManager!, (1n << 160n) - 1n, exp, await overrides())).wait();

  // RE-READ fresh pool state after the swap (it moved the price) and re-anchor the range on the live
  // tick. Building against the stale pre-swap price forced a big slippage buffer that left ~15% of
  // both sides unspent ("selalu ada sisa"). Fresh state → amounts match → a tiny 1% buffer suffices.
  try {
    const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
    const s0 = await sv.getSlot0!(pool.poolId);
    const liveLiq: bigint = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
    sdkPool = buildSdkPool(token, meta.decimals, meta.symbol, { ...pool, sqrtPriceX96: BigInt(s0.sqrtPriceX96), tick: Number(s0.tick), liquidity: BigInt(liveLiq) });
    const liveAnchor = Math.floor(Number(s0.tick) / sp) * sp;
    tickLower = liveAnchor - halfSpacings * sp;
    tickUpper = liveAnchor + halfSpacings * sp;
  } catch {
    /* keep discovery-time state on read failure */
  }

  // 4) build both-sided position from ACTUAL balances, scaled so the slippage-max settle stays
  //    WITHIN what we hold. The old bug: position built from the swap's exact output, then
  //    addCallParameters' slippage tried to pull MORE token than balance → Permit2 reverted
  //    with empty data ("missing revert data").
  const ethLeft = total - ethToSwap;
  const slip = new Percent(1, 100); // tight — fresh pool state above makes a big buffer unnecessary
  const mkPosition = (e: bigint, t: bigint) =>
    Position.fromAmounts({
      pool: sdkPool,
      tickLower,
      tickUpper,
      amount0: (isC0Native ? e : t).toString(),
      amount1: (isC0Native ? t : e).toString(),
      useFullPrecision: true,
    });
  let position = mkPosition(ethLeft, tokenBal);
  try {
    const maxAmts = position.mintAmountsWithSlippage(slip);
    const have0 = isC0Native ? ethLeft : tokenBal;
    const have1 = isC0Native ? tokenBal : ethLeft;
    const m0 = BigInt(maxAmts.amount0.toString());
    const m1 = BigInt(maxAmts.amount1.toString());
    let numer = 1_000_000n;
    if (m0 > have0 && m0 > 0n) { const r = (have0 * 1_000_000n) / m0; if (r < numer) numer = r; }
    if (m1 > have1 && m1 > 0n) { const r = (have1 * 1_000_000n) / m1; if (r < numer) numer = r; }
    if (numer < 1_000_000n) {
      const scale = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; // +0.1% safety
      position = mkPosition(scale(ethLeft), scale(tokenBal));
    }
  } catch {
    /* SDK without mintAmountsWithSlippage — fall through with the raw position */
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil");

  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    useNative: Ether.onChain(cfg.chainId),
  });

  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi mint v4 in-range revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc!);
  // deposit basis = the position's actual value at mint (native side + token side valued in ETH),
  // so reused inventory is counted honestly in PnL
  const a0 = BigInt(position.amount0.quotient.toString());
  const a1 = BigInt(position.amount1.quotient.toString());
  const depWei = (isC0Native ? a0 : a1) + priceTokenInEth(isC0Native ? a1 : a0);
  if (tokenId) {
    saveV4Deposit(tokenId, { depositWei: (depWei > 0n ? depWei : total).toString(), ts: Date.now(), poolId: pool.poolId, fee: pool.fee, tickLower, tickUpper, mode: "inrange" });
  }
  // sweep leftover token → ETH (native side excess is already ETH; v4 doesn't refund the excess side)
  await sweepLeftoverToEth([{ addr: token, dec: meta.decimals }]).catch(() => undefined);
  log.info(`open v4 IN-RANGE #${tokenId} ${meta.symbol} fee ${pool.fee / 10000}% swap ${swappedPct}%${ethToSwap === 0n ? " (reuse balance)" : ""}`);
  return {
    tokenId,
    txHash: tx.hash,
    swapHash,
    swappedPct,
    fee: pool.fee,
    tickLower,
    tickUpper,
    depositEth: amountEthStr,
    poolId: pool.poolId,
  };
}

/**
 * For a DUAL-SIDE (in-range) v4 position, the ETH amount that exactly balances the token the
 * wallet already holds — so both sides fill with no swap and minimal leftover. Returns 0 if it
 * can't be computed (pool degenerate / no token). Used to suggest the "type ETH" amount.
 */
export function balancedEthForHeldToken(token: string, meta: { decimals: number; symbol: string }, pool: V4Pool, tokenRaw: bigint): number {
  if (tokenRaw <= 0n) return 0;
  if (pool.quote === "usd") return 0; // only ETH-paired pools have an ETH-balancing amount
  try {
    const eth = Ether.onChain(cfg.chainId);
    const tok = new Token(cfg.chainId, ethers.getAddress(token), meta.decimals, meta.symbol);
    const sdkPool = new Pool(eth, tok, pool.fee, pool.tickSpacing, pool.poolKey.hooks, pool.sqrtPriceX96.toString(), pool.liquidity.toString(), pool.tick);
    const sp = pool.tickSpacing;
    const half = Math.max(1, Math.round(8 / 2));
    const anchor = Math.floor(pool.tick / sp) * sp;
    const tickLower = anchor - half * sp;
    const tickUpper = anchor + half * sp;
    const frac = Math.min(0.9, Math.max(0.05, swapFractionV4(pool.tick, tickLower, tickUpper) * 0.98));
    if (frac <= 0 || frac >= 1) return 0;
    const tokEthWei = BigInt(sdkPool.priceOf(sdkPool.currency1).quote(CurrencyAmount.fromRawAmount(sdkPool.currency1, tokenRaw.toString())).quotient.toString());
    const tokEth = Number(ethers.formatEther(tokEthWei));
    return tokEth * ((1 - frac) / frac); // the ETH side that pairs with the held token
  } catch {
    return 0;
  }
}

/** Approve an ERC20 for the v4 PositionManager via Permit2 (ERC20→Permit2, Permit2→POSM). */
async function approveViaPermit2(tokenAddr: string): Promise<void> {
  const w = wallet();
  const erc = new ethers.Contract(tokenAddr, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], w);
  if ((await erc.allowance!(w.address, PERMIT2)) < (1n << 200n)) {
    await (await erc.approve!(PERMIT2, ethers.MaxUint256, await overrides())).wait();
  }
  const permit2 = new ethers.Contract(PERMIT2, ["function approve(address token,address spender,uint160 amount,uint48 expiration)"], w);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  await (await permit2.approve!(tokenAddr, C.v4PositionManager!, (1n << 160n) - 1n, exp, await overrides())).wait();
}

/**
 * Open an in-range v4 position on a token/USDG pool (no native ETH leg). Funds BOTH sides from
 * ETH via the KyberSwap aggregator (ETH→USDG and ETH→token, auto multi-hop), approves both via
 * Permit2, then mints both-sided. amountEthStr = ETH budget deployed.
 */
export async function openV4UsdgInRange(
  pool: V4Pool,
  amountEthStr: string,
  opts?: { increaseTokenId?: string; range?: { tickLower: number; tickUpper: number } },
): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const w = wallet();
  const total = ethers.parseEther(amountEthStr);
  await ensureNativeEth(total + NATIVE_GAS_BUFFER);

  const c0 = pool.poolKey.currency0;
  const c1 = pool.poolKey.currency1;
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const cur0 = new Token(cfg.chainId, ethers.getAddress(c0), m0.decimals, m0.symbol);
  const cur1 = new Token(cfg.chainId, ethers.getAddress(c1), m1.decimals, m1.symbol);

  // Split the ETH budget by the value fraction at the DISCOVERY tick — just to decide how much of
  // each side to buy. The position itself is built from FRESH state below.
  const sp = pool.tickSpacing;
  const half = Math.max(1, Math.round(8 / 2));
  const anchor0 = Math.floor(pool.tick / sp) * sp;
  const fracC1 = Math.min(0.95, Math.max(0.05, swapFractionV4(pool.tick, anchor0 - half * sp, anchor0 + half * sp)));
  const ethForC1 = (total * BigInt(Math.round(fracC1 * 1e6))) / 1_000_000n;
  const ethForC0 = total - ethForC1;

  const bal = async (a: string): Promise<bigint> =>
    new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(w.address).catch(() => 0n);

  // acquire each side from ETH via Kyber (best route across every DEX/tier/hook).
  let swapHash: string | undefined;
  const acquire = async (addr: string, ethAmt: bigint) => {
    if (ethAmt < ethers.parseEther("0.00002")) return;
    const k = await kyberSwap(KYBER_NATIVE, ethers.getAddress(addr), ethAmt);
    if (!k || k.amountOut <= 0n) throw new Error(`gagal beli ${addr.toLowerCase() === USDG.toLowerCase() ? "USDG" : "token"} via Kyber`);
    swapHash = k.tx;
  };
  // REUSE USDG already in the wallet: buy only the SHORTFALL on the USDG side (the stable values
  // trivially at usdgUi/ethUsd). Swapping ETH→USDG when you already hold USDG just burns fees. The
  // shortfall (not "skip entirely") keeps the position full-size — the old skip-if-held bug starved it.
  const px = await ethUsd().catch(() => 0);
  const usdgIsC0 = c0.toLowerCase() === USDG.toLowerCase();
  const usdgAddr = usdgIsC0 ? c0 : c1;
  const tokAddr = usdgIsC0 ? c1 : c0;
  const ethForUsdg = usdgIsC0 ? ethForC0 : ethForC1;
  const ethForTok = usdgIsC0 ? ethForC1 : ethForC0;
  const heldUsdgEthWei =
    px > 0 ? ethers.parseEther((Number(ethers.formatUnits(await bal(usdgAddr), 6)) / px).toFixed(9)) : 0n;
  const buyUsdgWei = ethForUsdg > heldUsdgEthWei ? ethForUsdg - heldUsdgEthWei : 0n;
  await acquire(tokAddr, ethForTok);
  await acquire(usdgAddr, buyUsdgWei); // 0 if we already hold enough USDG → no swap

  const [bal0, bal1] = await Promise.all([bal(c0), bal(c1)]);
  if (bal0 <= 0n || bal1 <= 0n) throw new Error(`balance ${m0.symbol}/${m1.symbol} 0 setelah swap`);

  await approveViaPermit2(c0);
  await approveViaPermit2(c1);

  // RE-READ the pool AFTER the buys (they move the price, especially the thin token side) and
  // re-anchor the range on the FRESH tick. Building against the stale discovery price forced a big
  // slippage buffer → ~15% of BOTH sides left unspent ("selalu ada sisa"). Fresh state centres the
  // range on the current price, so the amounts match and a tiny 1% buffer suffices.
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  let liveSqrt = pool.sqrtPriceX96;
  let liveTick = pool.tick;
  let liveLiq = pool.liquidity;
  try {
    const s0 = await sv.getSlot0!(pool.poolId);
    liveSqrt = BigInt(s0.sqrtPriceX96);
    liveTick = Number(s0.tick);
    liveLiq = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
  } catch {
    /* keep discovery-time state on a read failure */
  }
  const livePool = new Pool(cur0, cur1, pool.fee, pool.tickSpacing, pool.poolKey.hooks, liveSqrt.toString(), liveLiq.toString(), liveTick);
  // INCREASE mode: reuse the EXISTING position's range (must match the NFT exactly). Open mode: fresh anchor.
  const anchor = Math.floor(liveTick / sp) * sp;
  const tickLower = opts?.range ? opts.range.tickLower : anchor - half * sp;
  const tickUpper = opts?.range ? opts.range.tickUpper : anchor + half * sp;

  // Tight 1% buffer — safe now that state is fresh (re-read → mint is milliseconds); staticCall guards.
  const slip = new Percent(1, 100);
  const mk = (a0: bigint, a1: bigint) => Position.fromAmounts({ pool: livePool, tickLower, tickUpper, amount0: a0.toString(), amount1: a1.toString(), useFullPrecision: true });
  let position = mk(bal0, bal1);
  try {
    const mx = position.mintAmountsWithSlippage(slip);
    const m0max = BigInt(mx.amount0.toString());
    const m1max = BigInt(mx.amount1.toString());
    let numer = 1_000_000n;
    if (m0max > bal0 && m0max > 0n) { const r = (bal0 * 1_000_000n) / m0max; if (r < numer) numer = r; }
    if (m1max > bal1 && m1max > 0n) { const r = (bal1 * 1_000_000n) / m1max; if (r < numer) numer = r; }
    if (numer < 1_000_000n) { const s = (x: bigint) => (((x * numer) / 1_000_000n) * 999n) / 1000n; position = mk(s(bal0), s(bal1)); }
  } catch {
    /* SDK lacks mintAmountsWithSlippage */
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil");

  // INCREASE mode → target the existing NFT (SDK emits INCREASE_LIQUIDITY). Open mode → mint to recipient.
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    ...(opts?.increaseTokenId ? { tokenId: opts.increaseTokenId } : { recipient: w.address }),
    slippageTolerance: slip,
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
    // NO useNative — both sides are ERC20 (token + USDG), settled via Permit2
  });
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi ${opts?.increaseTokenId ? "increase" : "mint"} v4 USDG revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = opts?.increaseTokenId ?? tokenIdFromReceipt(rc!);
  if (tokenId) {
    // record DEPOSITED amounts (LP-vs-HODL basis). On INCREASE, ADD to the existing record so the
    // basis grows by exactly what we topped up (PnL stays honest across top-ups).
    const add0 = BigInt(position.amount0.quotient.toString());
    const add1 = BigInt(position.amount1.quotient.toString());
    const prev = opts?.increaseTokenId ? loadV4Deposit(tokenId) : null;
    saveV4Deposit(tokenId, {
      depositWei: ((prev?.depositWei ? BigInt(prev.depositWei) : 0n) + total).toString(),
      ts: prev?.ts ?? Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "inrange",
      dep0: ((prev?.dep0 ? BigInt(prev.dep0) : 0n) + add0).toString(),
      dep1: ((prev?.dep1 ? BigInt(prev.dep1) : 0n) + add1).toString(),
    });
  }
  // sweep the un-deposited leftover (token AND/OR USDG) → ETH so there's no "sisa" (v4 doesn't refund)
  await sweepLeftoverToEth([{ addr: c0, dec: m0.decimals }, { addr: c1, dec: m1.decimals }]).catch(() => undefined);
  log.info(`${opts?.increaseTokenId ? "increase" : "open"} v4 USDG in-range #${tokenId} ${m0.symbol}/${m1.symbol} fee ${pool.fee / 10000}% ${opts?.increaseTokenId ? "+" : ""}${amountEthStr}Ξ`);
  return { tokenId, txHash: tx.hash, swapHash, swappedPct: 100, fee: pool.fee, tickLower, tickUpper, depositEth: amountEthStr, poolId: pool.poolId };
}

/**
 * Add liquidity to an EXISTING v4 position (INCREASE, not a new NFT). Reconstructs the pool + range
 * from the tokenId, then reuses the in-range open path (fund both sides by the range split, reuse
 * held USDG, sweep leftover → ETH) but targets the existing tokenId → the SDK emits INCREASE_LIQUIDITY.
 * USDG pairs only for now (all the bot's positions are USDG); ETH pairs throw a clear message.
 */
export async function increaseV4Position(tokenId: string, amountEthStr: string): Promise<V4OpenResult & { swapHash?: string; swappedPct: number }> {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
  const info = BigInt(infoRaw);
  const s24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);
  const tickLower = s24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = s24(Number((info >> 32n) & 0xffffffn));
  const poolKey: PoolKey = {
    currency0: String(pk.currency0),
    currency1: String(pk.currency1),
    fee: Number(pk.fee),
    tickSpacing: Number(pk.tickSpacing),
    hooks: String(pk.hooks),
  };
  const usdgIs = poolKey.currency0.toLowerCase() === USDG.toLowerCase() || poolKey.currency1.toLowerCase() === USDG.toLowerCase();
  if (!usdgIs) throw new Error("increase pair ETH belum didukung — sekarang cuma pair USDG (close & buka lagi buat ETH-pair).");
  const poolId = computePoolId(poolKey);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  const s0 = await sv.getSlot0!(poolId);
  if (!(s0.sqrtPriceX96 > 0n)) throw new Error("state pool posisi ini gak kebaca");
  const liquidity: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
  const pool: V4Pool = {
    poolKey,
    poolId,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    sqrtPriceX96: BigInt(s0.sqrtPriceX96),
    tick: Number(s0.tick),
    liquidity,
    lpFee: poolKey.fee,
    quote: "usd",
  };
  return openV4UsdgInRange(pool, amountEthStr, { increaseTokenId: tokenId, range: { tickLower, tickUpper } });
}

/**
 * SINGLE-SIDE USDG on a token/USDG v4 pool: park ONLY USDG (no token), range on the side that keeps
 * the position 100% USDG until the token PUMPS into range (rug-safe — if the token dumps you keep
 * your USDG). USDG=currency0 → range ABOVE tick (fromAmount0); USDG=currency1 → range BELOW tick
 * (fromAmount1). Funds the USDG side entirely from the ETH budget via Kyber.
 */
export async function openV4UsdgSingleSide(pool: V4Pool, amountEthStr: string): Promise<V4OpenResult & { swapHash?: string }> {
  if (!kyberEnabled()) throw new Error("KyberSwap belum dikonfigurasi — beli USDG butuh aggregator.");
  const w = wallet();
  const c0 = pool.poolKey.currency0;
  const c1 = pool.poolKey.currency1;
  const usdgIs0 = c0.toLowerCase() === USDG.toLowerCase();
  const usdgIs1 = c1.toLowerCase() === USDG.toLowerCase();
  if (!usdgIs0 && !usdgIs1) throw new Error("pool ini bukan pair USDG");
  const usdgAddr = usdgIs0 ? c0 : c1;
  const [m0, m1] = await Promise.all([tokenMeta(c0), tokenMeta(c1)]);
  const total = ethers.parseEther(amountEthStr);
  const usdgC = new ethers.Contract(usdgAddr, ["function balanceOf(address) view returns (uint256)"], provider);

  // 1) fund the USDG side — REUSE USDG already in the wallet, buy only the shortfall to reach `total`
  //    worth, and cap the position to that target so a big held balance can't over-deploy.
  const px = await ethUsd().catch(() => 0);
  const targetUsdgRaw = px > 0 ? BigInt(Math.floor(Number(ethers.formatEther(total)) * px * 1e6)) : 0n;
  const held0: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  const buyWei =
    targetUsdgRaw > 0n
      ? targetUsdgRaw > held0
        ? ethers.parseEther((Number(ethers.formatUnits(targetUsdgRaw - held0, 6)) / px).toFixed(9))
        : 0n
      : total; // no ETH price → fall back to buying the full budget
  let swapHash: string | undefined;
  if (buyWei >= ethers.parseEther("0.00002")) {
    await ensureNativeEth(buyWei + NATIVE_GAS_BUFFER);
    const k = await kyberSwap(KYBER_NATIVE, ethers.getAddress(usdgAddr), buyWei);
    if (!k || k.amountOut <= 0n) throw new Error("gagal beli USDG via Kyber");
    swapHash = k.tx;
  }
  const heldNow: bigint = await usdgC.balanceOf!(w.address).catch(() => 0n);
  // Size the position: price KNOWN → cap to target (reuse held USDG). Price UNKNOWN (px=0, e.g. the
  // ETH/USD API was down) → deposit ONLY what this open just bought (heldNow - held0), NEVER the whole
  // held balance — that's the bug that dumped ~$4 of pre-held USDG into a $2 position.
  const bought = heldNow > held0 ? heldNow - held0 : 0n;
  const usdgBal = targetUsdgRaw > 0n ? (heldNow > targetUsdgRaw ? targetUsdgRaw : heldNow) : bought;
  if (usdgBal <= 0n) throw new Error("USDG balance 0 (gak ada USDG di wallet & gagal beli)");

  // 2) fresh pool state + a single-side range on the all-USDG side
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);
  let liveSqrt = pool.sqrtPriceX96;
  let liveTick = pool.tick;
  let liveLiq = pool.liquidity;
  try {
    const s0 = await sv.getSlot0!(pool.poolId);
    liveSqrt = BigInt(s0.sqrtPriceX96);
    liveTick = Number(s0.tick);
    liveLiq = await sv.getLiquidity!(pool.poolId).catch(() => pool.liquidity);
  } catch {
    /* keep discovery-time state */
  }
  const cur0 = new Token(cfg.chainId, ethers.getAddress(c0), m0.decimals, m0.symbol);
  const cur1 = new Token(cfg.chainId, ethers.getAddress(c1), m1.decimals, m1.symbol);
  const livePool = new Pool(cur0, cur1, pool.fee, pool.tickSpacing, pool.poolKey.hooks, liveSqrt.toString(), liveLiq.toString(), liveTick);
  const sp = pool.tickSpacing;
  const width = Math.max(1, Math.round(cfg.lp.widthPct / 100 / (Math.pow(1.0001, sp) - 1)));

  let tickLower: number;
  let tickUpper: number;
  let position: any;
  if (usdgIs0) {
    // all currency0 (USDG) → range strictly ABOVE current tick
    tickLower = Math.ceil(liveTick / sp) * sp + sp;
    tickUpper = tickLower + width * sp;
    position = Position.fromAmount0({ pool: livePool, tickLower, tickUpper, amount0: usdgBal.toString(), useFullPrecision: true });
  } else {
    // all currency1 (USDG) → range strictly BELOW current tick
    tickUpper = Math.floor(liveTick / sp) * sp - sp;
    tickLower = tickUpper - width * sp;
    position = Position.fromAmount1({ pool: livePool, tickLower, tickUpper, amount1: usdgBal.toString(), useFullPrecision: true });
  }
  if (position.liquidity.toString() === "0") throw new Error("liquidity 0 — deposit terlalu kecil buat range ini");

  // 3) approve USDG via Permit2 + mint (both settle as ERC20, no useNative)
  await approveViaPermit2(usdgAddr);
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    recipient: w.address,
    slippageTolerance: new Percent(1, 100),
    deadline: Math.floor(Date.now() / 1000 + 600).toString(),
  });
  try {
    await provider.call({ to: C.v4PositionManager!, data: calldata, value, from: w.address });
  } catch (e) {
    throw new Error(`simulasi single-side USDG revert: ${((e as any).shortMessage || (e as Error).message || "").slice(0, 140)}`);
  }
  const tx = await w.sendTransaction({ to: C.v4PositionManager!, data: calldata, value: BigInt(value), ...(await overrides()) });
  const rc = await tx.wait();
  const tokenId = tokenIdFromReceipt(rc!);
  if (tokenId) {
    saveV4Deposit(tokenId, {
      depositWei: total.toString(),
      ts: Date.now(),
      poolId: pool.poolId,
      fee: pool.fee,
      tickLower,
      tickUpper,
      mode: "single",
      dep0: position.amount0.quotient.toString(),
      dep1: position.amount1.quotient.toString(),
    });
  }
  log.info(`open v4 USDG single-side #${tokenId} ${m0.symbol}/${m1.symbol} fee ${pool.fee / 10000}% ${amountEthStr}Ξ`);
  return { tokenId, txHash: tx.hash, swapHash, fee: pool.fee, tickLower, tickUpper, depositEth: amountEthStr, poolId: pool.poolId };
}

/**
 * Pick the pool that BUYS the token cheapest for `ethIn` — quote the ETH→token swap across all
 * of the token's native-ETH pools and take the one returning the most token (this captures BOTH
 * the fee tier AND the pool depth / price impact). Avoids buying on the thin high-fee pool the
 * user chose to farm, which would bleed fee + slippage before the position even opens.
 */
async function bestSwapPool(pools: V4Pool[], ethIn: bigint): Promise<V4Pool | null> {
  const cands = pools.filter((p) => p.quote === "eth" && p.liquidity > 0n && p.poolKey.currency0.toLowerCase() === NATIVE);
  if (!cands.length) return null;
  const quotes = await mapLimit(cands, 6, async (p) => {
    const out = await quoteV4(p.poolKey, true, ethIn).catch(() => 0n); // ETH(c0)→token(c1)
    return { p, out };
  });
  const best = quotes.filter((q) => q.out > 0n).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
  return best?.p ?? null;
}

/** Fraction of ETH (currency0) to swap into token so a straddling range fills. */
function swapFractionV4(tick: number, tickLower: number, tickUpper: number): number {
  const sP = Math.pow(1.0001, tick / 2);
  const sA = Math.pow(1.0001, tickLower / 2);
  const sB = Math.pow(1.0001, tickUpper / 2);
  if (sP <= sA) return 0;
  if (sP >= sB) return 1;
  const a0 = (sB - sP) / (sP * sB); // currency0 (ETH) per L
  const a1in0 = (sP - sA) / (sP * sP); // currency1 (token) per L, valued in currency0
  return a1in0 / (a0 + a1in0);
}

/** ERC721 Transfer(0x0 → recipient) → minted tokenId. */
function tokenIdFromReceipt(rc: ethers.TransactionReceipt): string | null {
  const posm = C.v4PositionManager!.toLowerCase();
  const ZERO = "0x" + "0".repeat(64);
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === posm && lg.topics.length === 4 && lg.topics[1] === ZERO) {
      return BigInt(lg.topics[3]!).toString();
    }
  }
  return null;
}
