/**
 * List the wallet's v2 LP positions. The pair token is a plain ERC20, so we enumerate the
 * wallet's ERC20 holdings from Blockscout and keep the ones whose `factory()` is our v2
 * factory (catches manual Uniswap adds too). Value = our pool share × reserves; v2 fees
 * compound INTO the reserves (no separate claim), so "fee/pnl" = value growth vs deposit.
 */
import { ethers } from "ethers";
import { C } from "../../config.js";
import { wallet } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { ethUsd } from "../price.js";
import { pairContract } from "./pair.js";
import { bsFetch, mapLimit } from "../blockscout.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { logger } from "../../util/log.js";

const log = logger("v2list");
const WETH_L = C.weth.toLowerCase();
const SKIP_FILE = "v2-skip.json"; // ERC20s confirmed NOT our v2 pairs — never re-check (shared arb wallet holds many junk tokens)

export interface V2Row {
  pair: string;
  sym: string; // token symbol (non-WETH side)
  token: string; // token address
  lpBalance: string;
  sharePct: number;
  amountToken: string;
  amountWeth: string;
  valueEth: number;
  valueUsd: number;
  depEth: number | null;
  pnlEth: number | null;
  pnlPct: number | null;
  ageMs: number | null;
}

/** Candidate ERC20 balances that might be v2 LP tokens (from Blockscout + tracked deposits). */
async function candidatePairs(owner: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const deps = readJson<Record<string, { pair: string }>>(dataPath("v2-positions.json"), {});
  for (const k of Object.keys(deps)) out.set(k.toLowerCase(), 0n);
  const res = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${owner}/tokens?type=ERC-20`);
  for (const it of res?.items ?? []) {
    const addr = (it.token?.address_hash || it.token?.address || "").toLowerCase();
    const val = BigInt(it.value ?? "0");
    if (addr && val > 0n) out.set(addr, val);
  }
  // never re-check ERC20s already confirmed NOT to be our pairs (skip the factory() RPC per junk token)
  const skip = new Set(readJson<string[]>(dataPath(SKIP_FILE), []));
  for (const s of skip) out.delete(s.toLowerCase());
  // but always keep tracked deps (they ARE our pairs)
  for (const k of Object.keys(deps)) out.set(k.toLowerCase(), out.get(k.toLowerCase()) ?? 0n);
  return out;
}

export async function listV2Positions(): Promise<V2Row[]> {
  if (!C.v2Factory) return [];
  const w = wallet();
  const factoryL = C.v2Factory.toLowerCase();
  const deps = readJson<Record<string, { depositWei: string; ts: number }>>(dataPath("v2-positions.json"), {});
  const cands = await candidatePairs(w.address);
  if (!cands.size) return [];
  const px = await ethUsd().catch(() => 0);

  const notOurs: string[] = [];
  const rows = await mapLimit([...cands.keys()], 10, async (addr): Promise<V2Row | null> => {
    try {
      const c = pairContract(addr);
      // confirm it's OUR v2 pair (cheap gate: factory() must match)
      const fac: string = await c.factory!().catch(() => "");
      if (fac.toLowerCase() !== factoryL) {
        // not our pair (junk ERC20 → factory() reverts to ""; or a foreign pair). Skip next time.
        // Safe: our own tracked pairs live in v2-positions.json and are ALWAYS re-added in
        // candidatePairs(), so a pair can never be permanently lost to this skip list.
        notOurs.push(addr.toLowerCase());
        return null;
      }
      const [bal, ts, reserves, t0, t1] = await Promise.all([
        c.balanceOf!(w.address) as Promise<bigint>,
        c.totalSupply!() as Promise<bigint>,
        c.getReserves!(),
        c.token0!() as Promise<string>,
        c.token1!() as Promise<string>,
      ]);
      if (bal === 0n || ts === 0n) return null;
      const wethIsT0 = t0.toLowerCase() === WETH_L;
      const tokenAddr = wethIsT0 ? t1 : t0;
      const wethReserve: bigint = wethIsT0 ? reserves[0] : reserves[1];
      const tokenReserve: bigint = wethIsT0 ? reserves[1] : reserves[0];
      if (wethReserve === 0n) return null; // not a WETH pair we manage
      const meta = await tokenMeta(tokenAddr).catch(() => ({ symbol: "?", decimals: 18 }));

      const shareWeth = (wethReserve * bal) / ts;
      const shareToken = (tokenReserve * bal) / ts;
      const wethF = Number(ethers.formatEther(shareWeth));
      const valueEth = wethF * 2; // both sides equal value at pool mid
      const dep = deps[addr];
      const depEth = dep ? Number(ethers.formatEther(dep.depositWei)) : null;
      return {
        pair: ethers.getAddress(addr),
        sym: String(meta.symbol),
        token: ethers.getAddress(tokenAddr),
        lpBalance: bal.toString(),
        sharePct: Number((bal * 1_000_000n) / ts) / 10_000,
        amountToken: Number(ethers.formatUnits(shareToken, meta.decimals)).toPrecision(6),
        amountWeth: wethF.toPrecision(6),
        valueEth,
        valueUsd: valueEth * px,
        depEth,
        pnlEth: depEth != null ? valueEth - depEth : null,
        pnlPct: depEth != null && depEth > 0 ? ((valueEth - depEth) / depEth) * 100 : null,
        ageMs: dep?.ts ? Date.now() - dep.ts : null,
      };
    } catch (e) {
      log.warn(`skip v2 ${addr.slice(0, 10)}: ${(e as Error).message.slice(0, 60)}`);
      return null;
    }
  });
  // grow the skip list so junk ERC20s aren't re-checked on every /list
  if (notOurs.length) {
    const prev = new Set(readJson<string[]>(dataPath(SKIP_FILE), []));
    for (const a of notOurs) prev.add(a);
    writeJson(dataPath(SKIP_FILE), [...prev]);
  }
  return rows.filter((r): r is V2Row => r !== null);
}
