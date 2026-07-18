/**
 * Reconstruct realized PnL for v4 positions closed BEFORE the bot tracked them.
 *
 * v4 hides LP amounts (flash accounting + atomic multicall mints), so wallet transfers can't
 * be summed like v3. Instead we use the ARCHIVE node: read the position's minted liquidity and
 * the pool's sqrtPrice at the mint block and the close block, then value the deposit at the
 * mint-time price and the withdrawal (principal + fees) at the close-time price — both from the
 * pool's OWN price, so no external historical oracle is needed. This yields true realized PnL
 * (impermanent loss + fees), denominated in ETH via the current ETH/USD for stablecoin sides.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { ethUsd } from "../price.js";
import { blockscout, mapLimit } from "../blockscout.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { readLedger, writeLedger } from "../ledger.js";
import { logger } from "../../util/log.js";
import type { LedgerEntry } from "../../types.js";

const { Ether, Token, CurrencyAmount } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const log = logger("v4backfill");
const STABLES = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]); // USDG
const MASK = (1n << 256n) - 1n;
const WETH_L = C.weth.toLowerCase();
const sg24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);
const j = (u: string): Promise<any> => fetch(u, { signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => null);

async function txMeta(hash: string): Promise<{ block: number; ts: number } | null> {
  const t = await j(`${blockscout}/api/v2/transactions/${hash}`);
  const block = t?.block_number ?? t?.block ?? null;
  const ts = t?.timestamp ? new Date(t.timestamp).getTime() : 0;
  return block ? { block, ts } : null;
}

/** Reconstruct one closed v4 position into a LedgerEntry (or null if not resolvable). */
export async function reconstructV4Pnl(tokenId: string, posmTxs: any[]): Promise<LedgerEntry | null> {
  const posm = new ethers.Contract(C.v4PositionManager!, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView!, STATEVIEW_ABI, provider);

  // mint tx (NFT Transfer from 0x0) + close tx (last POSM tx whose calldata mentions the id)
  const tr = await j(`${blockscout}/api/v2/tokens/${C.v4PositionManager}/instances/${tokenId}/transfers`);
  const mintHash: string | undefined = (tr?.items ?? []).filter((i: any) => /^0x0{40}$/i.test(i.from?.hash || "")).pop()?.transaction_hash;
  const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const touch = posmTxs.filter((t) => (t.input || "").toLowerCase().includes(idHex));
  const closeHash: string | undefined = touch[touch.length - 1]?.hash;
  if (!mintHash || !closeHash) return null;
  const [mintMeta, closeMeta] = await Promise.all([txMeta(mintHash), txMeta(closeHash)]);
  if (!mintMeta || !closeMeta) return null;
  const closeReadBlk = Math.max(mintMeta.block + 1, closeMeta.block - 1);

  // read the pool key at a HISTORICAL block (before close/burn) so BURNED positions still resolve
  let pk: any, infoRaw: any;
  try {
    [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId, { blockTag: closeReadBlk });
  } catch {
    try {
      [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId, { blockTag: mintMeta.block + 1 });
    } catch {
      return null;
    }
  }
  const info = BigInt(infoRaw);
  const tickLower = sg24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = sg24(Number((info >> 32n) & 0xffffffn));
  const c0 = pk.currency0 as string;
  const c1 = pk.currency1 as string;
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]));

  const [m0, m1] = await Promise.all([
    c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
    c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
  ]);

  const L: bigint = await posm.getPositionLiquidity!(tokenId, { blockTag: mintMeta.block + 1 }).catch(() => 0n);
  if (L === 0n) return null;

  const [s0m, s0c] = await Promise.all([
    sv.getSlot0!(poolId, { blockTag: mintMeta.block + 1 }),
    sv.getSlot0!(poolId, { blockTag: closeReadBlk }),
  ]);
  const cur0 = c0.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(c0), m0.decimals, m0.symbol);
  const cur1 = c1.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(c1), m1.decimals, m1.symbol);
  const poolM = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0m.sqrtPriceX96.toString(), "0", Number(s0m.tick));
  const poolC = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0c.sqrtPriceX96.toString(), "0", Number(s0c.tick));
  const posM = new Position({ pool: poolM, liquidity: L.toString(), tickLower, tickUpper });
  const posC = new Position({ pool: poolC, liquidity: L.toString(), tickLower, tickUpper });

  // fees over the position's life: feeGrowthInside@close − position's feeGrowthLast@mint, × L
  const pid = ethers.solidityPackedKeccak256(["address", "int24", "int24", "bytes32"], [C.v4PositionManager, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)]);
  const [piM, fgC] = await Promise.all([
    sv.getPositionInfo!(poolId, pid, { blockTag: mintMeta.block + 1 }).catch(() => [0n, 0n, 0n]),
    sv.getFeeGrowthInside!(poolId, tickLower, tickUpper, { blockTag: closeReadBlk }).catch(() => [0n, 0n]),
  ]);
  const fee0 = (((BigInt(fgC[0]) - BigInt(piM[1])) & MASK) * L) >> 128n;
  const fee1 = (((BigInt(fgC[1]) - BigInt(piM[2])) & MASK) * L) >> 128n;

  const px = await ethUsd().catch(() => 0);
  // USD value of a raw amount of a currency, using the pool's price at that snapshot
  const usd = (addr: string, sym: string, dec: number, raw: bigint, pool: any, cur: any, otherAddr: string, otherSym: string): number => {
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
      /* price edge */
    }
    return 0;
  };
  // Is this a stable (USDG) pair with NO ETH leg? Then PnL is naturally USD-denominated, and
  // we measure LP-vs-HODL: value the DEPOSIT at the CLOSE price too, so a single-sided position
  // that hands back the same tokens reads as break-even (fees), not a "loss" from the token's
  // own price drop (that drop is the operator's token bet, not the LP's performance).
  const ethLeg = [c0, c1].some((a) => a.toLowerCase() === NATIVE || a.toLowerCase() === WETH_L);
  const isUsdPair = !ethLeg;
  const depPool = isUsdPair ? poolC : poolM; // HODL baseline @ close for USD pairs; realized @ mint for ETH pairs
  const depUsd =
    usd(c0, m0.symbol, m0.decimals, BigInt(posM.amount0.quotient.toString()), depPool, cur0, c1, m1.symbol) +
    usd(c1, m1.symbol, m1.decimals, BigInt(posM.amount1.quotient.toString()), depPool, cur1, c0, m0.symbol);
  const princUsd =
    usd(c0, m0.symbol, m0.decimals, BigInt(posC.amount0.quotient.toString()), poolC, cur0, c1, m1.symbol) +
    usd(c1, m1.symbol, m1.decimals, BigInt(posC.amount1.quotient.toString()), poolC, cur1, c0, m0.symbol);
  const feeUsd = usd(c0, m0.symbol, m0.decimals, fee0, poolC, cur0, c1, m1.symbol) + usd(c1, m1.symbol, m1.decimals, fee1, poolC, cur1, c0, m0.symbol);
  const outUsd = princUsd + feeUsd;
  if (!(px > 0) || depUsd <= 0) return null;

  const depEth = depUsd / px;
  const outEth = outUsd / px;
  const pnlEth = outEth - depEth;
  const primary = STABLES.has(c0.toLowerCase()) || /usd/i.test(m0.symbol) ? m1.symbol : m0.symbol;
  return {
    tokenId: String(tokenId),
    sym: primary,
    version: "v4",
    pair: `${m0.symbol}/${m1.symbol}`,
    quote: isUsdPair ? "usd" : "eth",
    mode: "inrange",
    openedAt: mintMeta.ts || null,
    closedAt: closeMeta.ts || null,
    heldMs: mintMeta.ts && closeMeta.ts ? closeMeta.ts - mintMeta.ts : null,
    depEth,
    outEth,
    feeEth: feeUsd / px,
    pnlEth,
    pnlPct: depEth > 0 ? (pnlEth / depEth) * 100 : null,
    pnlUsd: pnlEth * px,
    ethUsdAtClose: px,
    tokenKept: 0,
    tokenRug: 0,
    unsoldEth: 0,
    source: "onchain",
  };
}

const TRANSFER = ethers.id("Transfer(address,address,uint256)");

/**
 * Reconstruct realized PnL for EVERY v4 position the wallet ever minted and has since closed —
 * including BURNED NFTs (enumerated from the mint logs, resolved at a historical block). Missing
 * these was the bug where a WOLVES/USDG position that earned ~$13 fees didn't show up (it was
 * burned, so the holdings-only scan skipped it).
 */
export async function backfillLedgerV4(onProgress: (msg: string) => void = () => {}): Promise<{ rebuilt: number; total: number }> {
  if (!C.v4PositionManager || !C.v4StateView) return { rebuilt: 0, total: readLedger().length };
  const w = wallet();
  const posmL = C.v4PositionManager.toLowerCase();
  const existing = readLedger();
  // Skip re-reconstructing bot-closed ETH pairs — their recorded realized PnL already matches what
  // reconstruction would produce (deposit was ETH-funded, valued @ mint = archive realized).
  // But USDG (no-ETH-leg) bot pairs closed BEFORE the LP-vs-HODL fix carry a stale realized basis
  // (contaminated by the token's directional price move), so let reconstruction overwrite those.
  const hasEthLeg = (e: LedgerEntry): boolean => /(^|\/)(ETH|WETH)(\/|$)/i.test(e.pair || "");
  const botClosed = new Set(
    existing.filter((e) => e.version === "v4" && e.source === "bot" && hasEthLeg(e)).map((e) => e.tokenId),
  );

  onProgress(`ambil riwayat tx…`);
  const tl = await j(`${blockscout}/api?module=account&action=txlist&address=${w.address}&startblock=0&endblock=99999999&sort=asc`);
  const posmTxs = (tl?.result ?? []).filter((t: any) => t.to?.toLowerCase() === posmL && t.isError !== "1");

  // enumerate ALL v4 tokenIds ever minted to the wallet (from NFT Transfer 0x0 → wallet in POSM txs)
  const zero = "0x" + "0".repeat(64);
  const wTopic = "0x" + w.address.slice(2).toLowerCase().padStart(64, "0");
  const minted = new Set<string>();
  await mapLimit(posmTxs, 8, async (t: any) => {
    const logs = await j(`${blockscout}/api/v2/transactions/${t.hash}/logs`);
    for (const l of logs?.items ?? []) {
      const tp = l.topics || [];
      if ((l.address?.hash || "").toLowerCase() === posmL && tp[0] === TRANSFER && tp.length === 4 && tp[1] === zero && (tp[2] || "").toLowerCase() === wTopic) {
        minted.add(BigInt(tp[3]).toString());
      }
    }
  });

  // keep only CLOSED ones (0 liquidity now, or burned) that we haven't already recorded from the bot
  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const todo: string[] = [];
  for (const id of minted) {
    if (botClosed.has(id)) continue;
    const liqNow: bigint = await posm.getPositionLiquidity!(id).catch(() => 0n);
    if (liqNow > 0n) continue; // still open → shown in /list
    todo.push(id);
  }
  if (!todo.length) return { rebuilt: 0, total: existing.length };

  const out = [...existing];
  let rebuilt = 0;
  for (const id of todo) {
    onProgress(`rekonstruksi v4 #${id}… (${rebuilt + 1}/${todo.length})`);
    try {
      const e = await reconstructV4Pnl(id, posmTxs);
      if (e) {
        out.push(e);
        rebuilt++;
      }
    } catch (err) {
      log.warn(`v4 #${id} gagal: ${(err as Error).message.slice(0, 70)}`);
    }
  }
  // de-dup by (version,tokenId), keep the last (freshly reconstructed wins over stale)
  const seen = new Map<string, LedgerEntry>();
  for (const e of out) seen.set(`${e.version ?? "v3"}:${e.tokenId}`, e);
  writeLedger([...seen.values()]);
  log.info(`v4 backfill: ${rebuilt}/${todo.length} posisi`);
  return { rebuilt, total: seen.size };
}
