/**
 * List the wallet's v4 LP positions. The v4 PositionManager isn't enumerable, so we track
 * the tokenIds we minted (data/v4-positions.json) and read each one's live state. Value is
 * computed from the SDK Position amounts + current pool price.
 */
import { ethers } from "ethers";
import sdkCore from "@uniswap/sdk-core";
import v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { bsFetch, mapLimit } from "../blockscout.js";
import { dataPath, readJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const { Ether, Token } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const log = logger("v4list");

export interface V4Row {
  tokenId: string;
  sym: string;
  fee: number;
  inRange: boolean;
  tick: number;
  tickLower: number;
  tickUpper: number;
  valEth: number;
  depEth: number | null;
  pnlEth: number | null;
  ageMs: number | null;
}

function signed24(v: number): number {
  return v >= 0x800000 ? v - 0x1000000 : v;
}

export async function listV4Positions(): Promise<V4Row[]> {
  if (!C.v4PositionManager || !C.v4StateView) return [];
  const w = wallet();
  // The v4 PositionManager is NOT ERC721Enumerable (tokenOfOwnerByIndex reverts), so we
  // enumerate owned tokenIds via Blockscout's NFT holdings — this catches positions added
  // MANUALLY on Uniswap too, not just bot-minted ones. Deposit basis (for PnL) still comes
  // from v4-positions.json where available.
  const deps = readJson<Record<string, { depositWei: string; ts: number }>>(dataPath("v4-positions.json"), {});
  const posmL = C.v4PositionManager.toLowerCase();
  let ids: string[] = [];
  try {
    const nft = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/nft?type=ERC-721`);
    ids = (nft?.items ?? [])
      .filter((i) => (i.token?.address_hash || "").toLowerCase() === posmL)
      .map((i) => String(i.id));
  } catch {
    /* fall back to tracked ids */
  }
  // union with tracked ids (in case Blockscout lags a fresh mint)
  ids = [...new Set([...ids, ...Object.keys(deps)])];
  if (!ids.length) return [];

  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // Process all tokenIds in parallel (bounded) — was sequential over ~13 NFTs = slow /list.
  const rows = await mapLimit(ids, 8, async (tokenId): Promise<V4Row | null> => {
    try {
      // cheap gate first: ownership + liquidity in parallel; skip closed/transferred fast
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
      const tokenAddr = pk.currency0.toLowerCase() === NATIVE ? pk.currency1 : pk.currency0;
      const poolId = ethers.keccak256(
        coder.encode(["address", "address", "uint24", "int24", "address"], [pk.currency0, pk.currency1, fee, tickSpacing, pk.hooks]),
      );
      const [meta, s0, poolLiq] = await Promise.all([
        tokenMeta(tokenAddr).catch(() => ({ symbol: "?", decimals: 18 })),
        sv.getSlot0!(poolId),
        sv.getLiquidity!(poolId).catch(() => 0n) as Promise<bigint>,
      ]);
      const tick = Number(s0.tick);

      const eth = Ether.onChain(cfg.chainId);
      const tok = new Token(cfg.chainId, ethers.getAddress(tokenAddr), meta.decimals, meta.symbol);
      const pool = new Pool(eth, tok, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), poolLiq.toString(), tick);
      const pos = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });

      const amt0Eth = Number(pos.amount0.toExact()); // ETH (currency0)
      let amt1Eth = 0;
      try {
        amt1Eth = Number(pool.priceOf(tok).quote(pos.amount1).toExact()); // token side priced in ETH
      } catch {
        /* price edge */
      }
      const valEth = amt0Eth + amt1Eth;
      const dep = deps[tokenId];
      const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;

      return {
        tokenId,
        sym: meta.symbol,
        fee,
        inRange: tick >= tickLower && tick < tickUpper,
        tick,
        tickLower,
        tickUpper,
        valEth,
        depEth,
        pnlEth: depEth != null ? valEth - depEth : null,
        ageMs: dep?.ts ? Date.now() - dep.ts : null,
      };
    } catch (e) {
      log.warn(`skip v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  return rows.filter((r): r is V4Row => r !== null);
}
