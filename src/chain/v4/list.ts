/**
 * List the wallet's v4 LP positions — ANY pair (token/ETH, token/USDG, token/token), not
 * just native-ETH. The v4 PositionManager isn't enumerable, so tokenIds come from Blockscout
 * NFT holdings (catches manual Uniswap positions too). Amounts are built from the REAL pool
 * currencies (earlier bug: forced native ETH → garbage $100M values). Unclaimed fees are
 * computed from feeGrowthInside deltas. Value is estimated in USD.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { ethUsd } from "../price.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { bsFetch, mapLimit } from "../blockscout.js";
import { dataPath, readJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token, CurrencyAmount } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const log = logger("v4list");

const WETH_L = C.weth.toLowerCase();
const STABLES = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]); // USDG
const MASK256 = (1n << 256n) - 1n;

export interface V4Row {
  tokenId: string;
  pair: string; // "WOLVES/USDG"
  sym: string; // primary (non-quote) symbol for the emoji/label
  fee: number;
  inRange: boolean;
  tick: number;
  tickLower: number;
  tickUpper: number;
  amount0: string;
  sym0: string;
  amount1: string;
  sym1: string;
  feeUsd: number;
  valueUsd: number;
  depEth: number | null;
  ethPaired: boolean; // true if one side is native ETH (bot-manageable close)
  ageMs: number | null;
}

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return addr.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/** USD per 1 unit of a currency, or null if unknown (then value via the pool's other side). */
function usdOfCurrency(addr: string, sym: string, px: number): number | null {
  const a = addr.toLowerCase();
  if (a === NATIVE || a === WETH_L) return px;
  if (STABLES.has(a) || /^usd|usd$/i.test(sym)) return 1;
  return null;
}

export async function listV4Positions(): Promise<V4Row[]> {
  if (!C.v4PositionManager || !C.v4StateView) return [];
  const w = wallet();
  const posmL = C.v4PositionManager.toLowerCase();
  const deps = readJson<Record<string, { depositWei: string; ts: number }>>(dataPath("v4-positions.json"), {});
  let ids: string[] = [];
  try {
    const nft = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/nft?type=ERC-721`);
    ids = (nft?.items ?? []).filter((i) => (i.token?.address_hash || "").toLowerCase() === posmL).map((i) => String(i.id));
  } catch {
    /* fall back to tracked ids */
  }
  ids = [...new Set([...ids, ...Object.keys(deps)])];
  if (!ids.length) return [];

  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const px = await ethUsd().catch(() => 0);

  const rows = await mapLimit(ids, 6, async (tokenId): Promise<V4Row | null> => {
    try {
      const [owner, liquidity] = await Promise.all([
        posm.ownerOf!(tokenId).catch(() => ethers.ZeroAddress) as Promise<string>,
        posm.getPositionLiquidity!(tokenId).catch(() => 0n) as Promise<bigint>,
      ]);
      if (owner.toLowerCase() !== w.address.toLowerCase() || liquidity === 0n) return null;

      const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
      const info = BigInt(infoRaw);
      const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
      const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
      const fee = Number(pk.fee);
      const tickSpacing = Number(pk.tickSpacing);
      const c0 = pk.currency0 as string;
      const c1 = pk.currency1 as string;

      const [m0, m1] = await Promise.all([
        c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
        c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
      ]);

      const poolId = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]));
      const positionId = ethers.solidityPackedKeccak256(
        ["address", "int24", "int24", "bytes32"],
        [C.v4PositionManager, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)],
      );
      const [s0, fgInside, posInfo] = await Promise.all([
        sv.getSlot0!(poolId),
        sv.getFeeGrowthInside!(poolId, tickLower, tickUpper).catch(() => [0n, 0n]),
        sv.getPositionInfo!(poolId, positionId).catch(() => [0n, 0n, 0n]),
      ]);
      const tick = Number(s0.tick);

      const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
      const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
      const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", tick);
      const pos = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });

      // unclaimed fees from feeGrowthInside delta (uint256 wrap-safe) × liquidity >> 128
      const fee0raw = (((BigInt(fgInside[0]) - BigInt(posInfo[1])) & MASK256) * liquidity) >> 128n;
      const fee1raw = (((BigInt(fgInside[1]) - BigInt(posInfo[2])) & MASK256) * liquidity) >> 128n;
      const fee0 = CurrencyAmount.fromRawAmount(cur0, fee0raw.toString());
      const fee1 = CurrencyAmount.fromRawAmount(cur1, fee1raw.toString());

      const u0 = usdOfCurrency(c0, m0.symbol, px);
      const u1 = usdOfCurrency(c1, m1.symbol, px);
      const sideUsd = (amt: any, thisUsd: number | null, otherUsd: number | null): number => {
        try {
          if (thisUsd != null) return Number(amt.toExact()) * thisUsd;
          if (otherUsd != null) return Number(pool.priceOf(amt.currency).quote(amt).toExact()) * otherUsd;
        } catch {
          /* price edge */
        }
        return 0;
      };
      const total0 = pos.amount0.add(fee0);
      const total1 = pos.amount1.add(fee1);
      const valueUsd = sideUsd(total0, u0, u1) + sideUsd(total1, u1, u0);
      const feeUsd = sideUsd(fee0, u0, u1) + sideUsd(fee1, u1, u0);

      const ethPaired = c0.toLowerCase() === NATIVE || c1.toLowerCase() === NATIVE;
      const dep = deps[tokenId];
      // primary token = the non-stable / non-eth side (for the emoji/label)
      const primary = u0 != null && u1 == null ? m1.symbol : u1 != null && u0 == null ? m0.symbol : m0.symbol;

      return {
        tokenId,
        pair: `${m0.symbol}/${m1.symbol}`,
        sym: primary,
        fee,
        inRange: tick >= tickLower && tick < tickUpper,
        tick,
        tickLower,
        tickUpper,
        amount0: pos.amount0.toSignificant(6),
        sym0: m0.symbol,
        amount1: pos.amount1.toSignificant(6),
        sym1: m1.symbol,
        feeUsd,
        valueUsd,
        depEth: dep ? Number(ethers.formatEther(dep.depositWei)) : null,
        ethPaired,
        ageMs: dep?.ts ? Date.now() - dep.ts : null,
      };
    } catch (e) {
      log.warn(`skip v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  return rows.filter((r): r is V4Row => r !== null);
}
