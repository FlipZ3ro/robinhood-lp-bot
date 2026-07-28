/** Wallet-level helpers: balances and "sell every stuck token → ETH". */
import { ethers } from "ethers";
import { C } from "../config.js";
import { wallet, provider } from "./client.js";
import { ERC20_ABI } from "./abis.js";
import { quoteTokenToWeth, swapTokenToWeth } from "./swaps.js";
import { kyberRoute, kyberEnabled, KYBER_NATIVE } from "./kyber.js";
import { ethUsd } from "./price.js";
import { bsFetch, mapLimit } from "./blockscout.js";

export interface Balances {
  address: string;
  eth: string;
  weth: string;
}

/** One sellable ERC-20 holding, valued by its actual Kyber sell-route → ETH. */
export interface WalletToken {
  addr: string;
  symbol: string;
  decimals: number;
  raw: bigint;
  ui: number;
  ethOut: number; // ETH you'd get selling ALL of it (Kyber quote)
  usd: number;
}

/**
 * Non-WETH ERC-20 holdings the wallet can ACTUALLY sell → ETH, richest first, dust dropped.
 * Valued via the KyberSwap aggregator (not v3-only quoting) so USDG-paired tokens like JACKET are
 * caught too, and un-sellable junk (no route) is filtered out. `cap` bounds the Kyber calls.
 */
export async function walletTokens(minUsd = 0.1, cap = 25): Promise<WalletToken[]> {
  if (!kyberEnabled()) return [];
  const w = wallet();
  const wethL = C.weth.toLowerCase();
  const px = await ethUsd().catch(() => 0);
  const tk = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/tokens`).catch(() => null);
  const items = (tk?.items ?? [])
    .filter((it) => it.token?.type === "ERC-20" && it.token.address_hash && it.token.address_hash.toLowerCase() !== wethL && BigInt(it.value ?? "0") > 0n)
    .slice(0, cap);
  if (!items.length) return [];
  const rows = await mapLimit(items, 8, async (it: any): Promise<WalletToken | null> => {
    try {
      const addr = ethers.getAddress(it.token.address_hash);
      const dec = Number(it.token.decimals ?? 18);
      const raw = BigInt(it.value);
      const route = await Promise.race([
        kyberRoute(addr, KYBER_NATIVE, raw),
        new Promise<null>((res) => setTimeout(() => res(null), 6000)),
      ]);
      if (!route) return null; // no sell route → hide (can't swap it anyway)
      const ethOut = Number(ethers.formatEther(BigInt(route.routeSummary.amountOut)));
      const usd = ethOut * px;
      if (usd < minUsd) return null;
      return { addr, symbol: it.token.symbol ?? "?", decimals: dec, raw, ui: Number(ethers.formatUnits(raw, dec)), ethOut, usd };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is WalletToken => r !== null).sort((a, b) => b.usd - a.usd);
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
