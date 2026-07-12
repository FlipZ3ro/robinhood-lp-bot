/**
 * v4 swaps via the UniversalRouter (native ETH ↔ token). Verified by staticCall on chain
 * 4663. Encodes V4_SWAP (0x10) → [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]. Used by the
 * in-range v4 open flow to acquire the token side before minting.
 */
import { ethers } from "ethers";
import { C, cfg } from "../../config.js";
import { wallet, provider, overrides } from "../client.js";
import { V4QUOTER_ABI } from "./abis.js";
import { NATIVE, type PoolKey } from "./poolkey.js";

const POOLKEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const coder = ethers.AbiCoder.defaultAbiCoder();

function poolKeyTuple(pk: PoolKey) {
  return [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks];
}

/** Quote ETH→token (or token→ETH) exact-in for a v4 pool. */
export async function quoteV4(pk: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const q = new ethers.Contract(C.v4Quoter!, V4QUOTER_ABI, provider);
  const r = await q.quoteExactInputSingle!.staticCall([poolKeyTuple(pk), zeroForOne, amountIn, "0x"]);
  return r[0] as bigint;
}

/** Build UniversalRouter execute() calldata for a single v4 exact-in swap. */
function buildSwapCalldata(pk: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): string {
  const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const inCur = zeroForOne ? pk.currency0 : pk.currency1;
  const outCur = zeroForOne ? pk.currency1 : pk.currency0;
  const swapParams = coder.encode(
    [`tuple(${POOLKEY_TYPE} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`],
    [[poolKeyTuple(pk), zeroForOne, amountIn, minOut, "0x"]],
  );
  const settleAll = coder.encode(["address", "uint256"], [inCur, amountIn]);
  const takeAll = coder.encode(["address", "uint256"], [outCur, minOut]);
  const v4Input = coder.encode(["bytes", "bytes[]"], [actions, [swapParams, settleAll, takeAll]]);
  const ur = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
  return ur.encodeFunctionData("execute", ["0x10", [v4Input], Math.floor(Date.now() / 1000 + 600)]);
}

export interface V4SwapResult {
  tx: string;
  amountOut: bigint;
}

/** Swap native ETH → token on a v4 pool (ETH is currency0). Returns token received. */
export async function swapEthToTokenV4(pk: PoolKey, amountInWei: bigint): Promise<V4SwapResult> {
  const w = wallet();
  const zeroForOne = pk.currency0.toLowerCase() === NATIVE; // ETH(c0) → token(c1)
  const quoted = await quoteV4(pk, zeroForOne, amountInWei).catch(() => 0n);
  const minOut = (quoted * BigInt(Math.round((100 - (cfg.lp.slippagePct || 5)) * 100))) / 10_000n;
  const data = buildSwapCalldata(pk, zeroForOne, amountInWei, minOut);

  const tokenAddr = zeroForOne ? pk.currency1 : pk.currency0;
  const erc = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], provider);
  const before: bigint = await erc.balanceOf!(w.address).catch(() => 0n);

  // simulate then send
  await provider.call({ to: C.universalRouter!, data, value: amountInWei, from: w.address });
  const tx = await w.sendTransaction({ to: C.universalRouter!, data, value: amountInWei, ...(await overrides()) });
  await tx.wait();

  const after: bigint = await erc.balanceOf!(w.address).catch(() => 0n);
  return { tx: tx.hash, amountOut: after - before };
}
