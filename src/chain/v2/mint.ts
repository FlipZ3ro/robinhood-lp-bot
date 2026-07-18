/**
 * v2 LP open — "zap" a single ETH deposit into a full-range token/WETH position.
 * v2 has no ranges and no single-side: liquidity is always both-sided 50/50 by value,
 * so we wrap ETH → WETH, swap the optimal fraction WETH → token (zap formula, 0.3% fee),
 * then add both sides to the pair (mint LP). Every step is simulated before broadcast.
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { wallet, overrides } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { WETH_ABI, ERC20_ABI } from "../abis.js";
import { readV2Pool, pairContract, getAmountOut, zapSwapAmount, type V2Pool } from "./pair.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const log = logger("v2mint");
const POS_FILE = dataPath("v2-positions.json");

type V2Dep = { depositWei: string; ts: number; token: string; pair: string };

export function saveV2Deposit(pair: string, rec: V2Dep): void {
  const d = readJson<Record<string, V2Dep>>(POS_FILE, {});
  d[pair.toLowerCase()] = rec;
  writeJson(POS_FILE, d);
}
export function loadV2Deposit(pair: string): V2Dep | null {
  return readJson<Record<string, V2Dep>>(POS_FILE, {})[pair.toLowerCase()] ?? null;
}
export function dropV2Deposit(pair: string): void {
  const d = readJson<Record<string, V2Dep>>(POS_FILE, {});
  delete d[pair.toLowerCase()];
  writeJson(POS_FILE, d);
}

export interface V2OpenResult {
  txHash: string; // the mint (add-liquidity) tx
  wrapHash?: string;
  swapHash?: string;
  pair: string;
  lpMinted: string;
  depositEth: string;
  symbol: string;
}

/**
 * Open (zap into) a full-range v2 token/WETH position from `amountEthStr` of ETH.
 * Sequence: wrap → swap zap fraction → transfer both sides → pair.mint.
 */
export async function openV2(token: string, amountEthStr: string): Promise<V2OpenResult> {
  const w = wallet();
  const pool = await readV2Pool(token);
  if (!pool) throw new Error("tidak ada pool v2/WETH dengan likuiditas");
  const meta = await tokenMeta(token);
  const deposit = ethers.parseEther(amountEthStr);

  const weth = new ethers.Contract(C.weth, WETH_ABI, w);
  const erc = new ethers.Contract(ethers.getAddress(token), ERC20_ABI, w);
  const gas = await overrides();

  // 1) ensure WETH balance ≥ deposit (wrap native ETH if needed)
  let wrapHash: string | undefined;
  const wethBal: bigint = await weth.balanceOf!(w.address);
  if (wethBal < deposit) {
    const need = deposit - wethBal;
    const tx = await weth.deposit!({ value: need, ...gas });
    await tx.wait();
    wrapHash = tx.hash;
  }

  // 2) swap the optimal WETH fraction → token (via the pair directly)
  const swapIn = zapSwapAmount(pool.wethReserve, deposit);
  if (swapIn <= 0n) throw new Error("zap amount 0 — deposit terlalu kecil / pool aneh");
  const tokenOut = getAmountOut(swapIn, pool.wethReserve, pool.tokenReserve);
  if (tokenOut <= 0n) throw new Error("swap zap: output 0 (pool kering?)");

  const pair = pairContract(pool.pair, w);
  // transfer WETH into the pair, then swap out the token to our wallet
  await (await weth.transfer!(pool.pair, swapIn, gas)).wait();
  const amount0Out = pool.wethIsToken0 ? 0n : tokenOut;
  const amount1Out = pool.wethIsToken0 ? tokenOut : 0n;
  try {
    await pair.swap!.staticCall(amount0Out, amount1Out, w.address, "0x");
  } catch (e) {
    throw new Error(`simulasi swap v2 revert: ${short(e)}`);
  }
  const swapTx = await pair.swap!(amount0Out, amount1Out, w.address, "0x", gas);
  await swapTx.wait();

  // 3) add liquidity: transfer both sides in the CURRENT reserve ratio, then mint
  const fresh = await readV2Pool(token);
  if (!fresh) throw new Error("pool hilang setelah swap");
  const wethLeft = deposit - swapIn;
  const tokBal: bigint = await erc.balanceOf!(w.address);
  const tokUse = tokBal < tokenOut ? tokBal : tokenOut; // use what we actually received
  const { addWeth, addTok } = ratioAmounts(wethLeft, tokUse, fresh);
  if (addWeth <= 0n || addTok <= 0n) throw new Error("jumlah add-liquidity 0");

  await (await weth.transfer!(pool.pair, addWeth, gas)).wait();
  await (await erc.transfer!(pool.pair, addTok, gas)).wait();
  try {
    await pair.mint!.staticCall(w.address);
  } catch (e) {
    throw new Error(`simulasi mint v2 revert: ${short(e)}`);
  }
  const mintTx = await pair.mint!(w.address, gas);
  const rc = await mintTx.wait();
  const lpMinted = lpFromReceipt(rc!, pool.pair, w.address);

  saveV2Deposit(pool.pair, { depositWei: deposit.toString(), ts: Date.now(), token: ethers.getAddress(token), pair: pool.pair });
  log.info(`open v2 ${meta.symbol} ${amountEthStr}Ξ pair ${pool.pair.slice(0, 10)} LP ${lpMinted}`);
  return {
    txHash: mintTx.hash,
    wrapHash,
    swapHash: swapTx.hash,
    pair: pool.pair,
    lpMinted,
    depositEth: amountEthStr,
    symbol: meta.symbol,
  };
}

/** Given held WETH+token and current reserves, the max both-sided amounts in ratio. */
function ratioAmounts(wethHave: bigint, tokHave: bigint, p: V2Pool): { addWeth: bigint; addTok: bigint } {
  // token needed to pair with all our WETH: tokForWeth = wethHave · tokenReserve / wethReserve
  const tokForWeth = (wethHave * p.tokenReserve) / p.wethReserve;
  if (tokForWeth <= tokHave) return { addWeth: wethHave, addTok: tokForWeth };
  const wethForTok = (tokHave * p.wethReserve) / p.tokenReserve;
  return { addWeth: wethForTok, addTok: tokHave };
}

/** Pull the minted LP amount from the pair's Transfer(0x0 → recipient) event. */
function lpFromReceipt(rc: ethers.TransactionReceipt, pair: string, to: string): string {
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const ZERO = "0x" + "0".repeat(64);
  const toTopic = "0x" + to.slice(2).toLowerCase().padStart(64, "0");
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() === pair.toLowerCase() && lg.topics[0] === TRANSFER && lg.topics[1] === ZERO && lg.topics[2] === toTopic) {
      return BigInt(lg.data).toString();
    }
  }
  return "0";
}

function short(e: unknown): string {
  return ((e as any)?.shortMessage || (e as Error)?.message || "").slice(0, 140);
}
