/** Wallet-level helpers: balances and "sell every stuck token → ETH". */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { ERC20_ABI } from "./abis.js";
import { quoteTokenToWeth, swapTokenToWeth } from "./swaps.js";
import { ethUsd } from "./price.js";
import { bsFetch } from "./blockscout.js";

export interface Balances {
  address: string;
  eth: string;
  weth: string;
}

export async function balances(): Promise<Balances> {
  const w = wallet();
  const eth = await provider.getBalance(w.address);
  const wc = new ethers.Contract(C.weth, ERC20_ABI, provider);
  const weth: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
  return {
    address: w.address,
    eth: ethers.formatEther(eth),
    weth: ethers.formatEther(weth),
  };
}

export interface SellAllResult {
  soldEth: number;
  soldUsd: number;
  sold: number;
  skipped: number;
  px: number;
}

/** Sell all non-WETH ERC-20 holdings → ETH. Skips rug (pool dry) and dust. */
export async function sellAllTokens(
  onProgress?: (msg: string) => void,
): Promise<SellAllResult> {
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const tk = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/tokens`);
  const px = await ethUsd().catch(() => 0);
  let soldEth = 0;
  let sold = 0;
  let skipped = 0;

  for (const it of tk?.items ?? []) {
    const t = it.token;
    if (t.type !== "ERC-20" || t.address_hash.toLowerCase() === wethL) continue;
    const raw = BigInt(it.value);
    if (raw <= 0n) continue;
    const q = await quoteTokenToWeth(t.address_hash, raw).catch(() => ({ weth: 0, fee: 0, amountOut: 0n }));
    if (q.weth * px < 0.05) {
      skipped++;
      continue; // < $0.05 = rug/dust, not worth gas
    }
    try {
      const sw = await Promise.race([
        swapTokenToWeth(t.address_hash, raw, q.fee),
        timeout(60_000),
      ]);
      const outEth = Number(ethers.formatEther(sw.amountOut));
      soldEth += outEth;
      sold++;
      onProgress?.(`✅ ${t.symbol} → +${outEth.toFixed(6)} WETH ($${(outEth * px).toFixed(2)})`);
    } catch {
      onProgress?.(`⚠️ ${t.symbol} gagal ($${(q.weth * px).toFixed(2)}) — skip`);
      skipped++;
    }
  }
  return { soldEth, soldUsd: soldEth * px, sold, skipped, px };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
}
