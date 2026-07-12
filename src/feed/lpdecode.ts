/**
 * Detect NEW WETH pool creation / first liquidity from a feed transaction.
 *
 * Fully decodable with contracts we own the ABI for:
 *   NPM.mint(...)                              → first (or any) liquidity add
 *   NPM.createAndInitializePoolIfNecessary(..) → brand-new pool init
 *   Factory.createPool(a,b,fee)                → pool created directly
 *   NPM.multicall([...])                       → the usual "create+init+mint" bundle
 *
 * Returns the non-WETH token + fee + WETH seed size (if a mint). Whether it's genuinely
 * "new" is decided by the caller against its seen-set — here we just extract intent.
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import type { FeedTx } from "./decode.js";

const NPM_L = C.positionManager.toLowerCase();
const FACTORY_L = C.factory.toLowerCase();
const WETH_L = C.weth.toLowerCase();

const IFACE = new ethers.Interface([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline))",
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96)",
  "function createPool(address tokenA,address tokenB,uint24 fee)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function multicall(bytes32 previousBlockhash, bytes[] data)",
]);

export interface PoolEvent {
  hash: string;
  from: string | null;
  token: string; // non-WETH token
  fee: number;
  wethSeed: bigint; // WETH added in a mint (0 for bare create/init)
  kind: "mint" | "create";
}

/** Extract WETH-pool creation/mint events from a feed tx. */
export function extractPoolEvents(ftx: FeedTx): PoolEvent[] {
  const to = ftx.tx.to?.toLowerCase();
  if ((to !== NPM_L && to !== FACTORY_L) || !ftx.tx.data || ftx.tx.data === "0x") return [];
  const out: PoolEvent[] = [];
  decode(ftx.tx.data, ftx.tx.hash ?? "", ftx.tx.from, out);
  return out;
}

function decode(data: string, hash: string, from: string | null, out: PoolEvent[]): void {
  let parsed;
  try {
    parsed = IFACE.parseTransaction({ data });
  } catch {
    return;
  }
  if (!parsed) return;

  if (parsed.name === "multicall") {
    for (const c of parsed.args[parsed.args.length - 1] as string[]) decode(c, hash, from, out);
    return;
  }

  if (parsed.name === "mint") {
    const p = parsed.args[0];
    const t0 = String(p.token0).toLowerCase();
    const t1 = String(p.token1).toLowerCase();
    const info = wethPair(t0, t1);
    if (!info) return;
    const wethSeed = info.wethIsToken0 ? (p.amount0Desired as bigint) : (p.amount1Desired as bigint);
    out.push({ hash, from, token: info.token, fee: Number(p.fee), wethSeed, kind: "mint" });
    return;
  }

  if (parsed.name === "createAndInitializePoolIfNecessary" || parsed.name === "createPool") {
    const t0 = String(parsed.args[0]).toLowerCase();
    const t1 = String(parsed.args[1]).toLowerCase();
    const info = wethPair(t0, t1);
    if (info) out.push({ hash, from, token: info.token, fee: Number(parsed.args[2]), wethSeed: 0n, kind: "create" });
  }
}

function wethPair(t0: string, t1: string): { token: string; wethIsToken0: boolean } | null {
  if (t0 === WETH_L) return { token: t1, wethIsToken0: true };
  if (t1 === WETH_L) return { token: t0, wethIsToken0: false };
  return null;
}
