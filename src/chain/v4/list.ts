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
  const deps = readJson<Record<string, { depositWei: string; ts: number }>>(dataPath("v4-positions.json"), {});
  const ids = Object.keys(deps);
  if (!ids.length) return [];

  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const rows: V4Row[] = [];

  for (const tokenId of ids) {
    try {
      const owner: string = await posm.ownerOf!(tokenId).catch(() => ethers.ZeroAddress);
      if (owner.toLowerCase() !== w.address.toLowerCase()) continue; // burned/transferred
      const liquidity: bigint = await posm.getPositionLiquidity!(tokenId).catch(() => 0n);
      if (liquidity === 0n) continue;

      const [pk, infoRaw] = await posm.getPoolAndPositionInfo!(tokenId);
      const info = BigInt(infoRaw);
      const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
      const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
      const fee = Number(pk.fee);
      const tickSpacing = Number(pk.tickSpacing);
      const tokenAddr = pk.currency0.toLowerCase() === NATIVE ? pk.currency1 : pk.currency0;
      const meta = await tokenMeta(tokenAddr).catch(() => ({ symbol: "?", decimals: 18 }));

      const poolId = ethers.keccak256(
        coder.encode(
          ["address", "address", "uint24", "int24", "address"],
          [pk.currency0, pk.currency1, fee, tickSpacing, pk.hooks],
        ),
      );
      const s0 = await sv.getSlot0!(poolId);
      const poolLiq: bigint = await sv.getLiquidity!(poolId).catch(() => 0n);
      const tick = Number(s0.tick);

      const eth = Ether.onChain(cfg.chainId);
      const tok = new Token(cfg.chainId, ethers.getAddress(tokenAddr), meta.decimals, meta.symbol);
      const pool = new Pool(eth, tok, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), poolLiq.toString(), tick);
      const pos = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });

      // value in ETH: native side + token side priced at current pool price
      const amt0Eth = Number(pos.amount0.toExact()); // ETH (currency0)
      let amt1Eth = 0;
      try {
        const price = pool.priceOf(tok); // token price in ETH
        amt1Eth = Number(price.quote(pos.amount1).toExact());
      } catch {
        /* price edge */
      }
      const valEth = amt0Eth + amt1Eth;
      const dep = deps[tokenId];
      const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;

      rows.push({
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
      });
    } catch (e) {
      log.warn(`skip v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return rows;
}
