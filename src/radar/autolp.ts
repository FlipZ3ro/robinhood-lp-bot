/**
 * Autonomous LP: candidate → radar verdict → (many gates) → auto-open a position.
 *
 * ⚠️ This SPENDS REAL FUNDS with no human tap. Every gate below must pass, and it's OFF
 * by default with conservative caps. Defense in depth: the LLM verdict is necessary but
 * NOT sufficient — hard on-chain/GMGN filters + rate/size/count caps sit in front of it.
 * Single-side mode by default = rug-safe (parks ETH, buys token only if price enters range).
 */
import { cfg } from "../config.js";
import { findPools, pickLpPool } from "../chain/pools.js";
import { openPosition, listPositions } from "../chain/positions.js";
import { balances } from "../chain/holdings.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { Candidate, Verdict } from "./radar.js";
import type { OpenResult } from "../types.js";

const log = logger("autolp");
const STATE_FILE = dataPath("autolp-state.json");
const GAS_RESERVE = 0.0004;

interface OpenRecord {
  ts: number;
  token: string;
  sizeEth: number;
  tokenId: string | null;
}
interface State {
  opens: OpenRecord[];
}

const load = (): State => readJson<State>(STATE_FILE, { opens: [] });
const save = (s: State): void => writeJson(STATE_FILE, s);

export interface AutoLpResult {
  opened: boolean;
  reason: string; // why skipped, or "opened"
  token: string;
  symbol: string;
  sizeEth?: number;
  result?: OpenResult;
}

/** Run the full gate chain; open a position only if ALL pass. Returns null if disabled. */
export async function maybeAutoLp(candidate: Candidate, verdict: Verdict | null): Promise<AutoLpResult | null> {
  const a = cfg.autoLp;
  if (!a.enabled) return null;

  const skip = (reason: string): AutoLpResult => {
    log.info(`skip ${candidate.symbol}: ${reason}`);
    return { opened: false, reason, token: candidate.token, symbol: candidate.symbol };
  };

  // 1. source allowed
  if (!a.sources.includes(candidate.source)) return skip(`source ${candidate.source} tidak diizinkan`);

  // 2. LLM verdict gate
  if (a.requireLlm) {
    if (!verdict?.llm) return skip("tidak ada verdict LLM");
    if (verdict.llm.action !== a.requireAction) return skip(`action ${verdict.llm.action} ≠ ${a.requireAction}`);
    if (verdict.llm.score < a.minScore) return skip(`skor ${verdict.llm.score} < ${a.minScore}`);
  }

  // 3. GMGN hard filters (defense beyond the LLM)
  const g = verdict?.gmgn ?? null;
  if (a.requireGmgn && !g) return skip("GMGN wajib tapi tidak tersedia");
  if (g) {
    if (g.isHoneypot === "yes" || (g.isHoneypot as unknown) === true) return skip("GMGN honeypot");
    const tax = Math.max((g.buyTax ?? 0) * 100, (g.sellTax ?? 0) * 100);
    if (tax > a.maxTaxPct) return skip(`tax ${tax.toFixed(1)}% > ${a.maxTaxPct}%`);
  }

  // 4. liquidity floor
  const liq = g?.liquidityUsd ?? candidate.liq ?? 0;
  if (liq < a.minLiqUsd) return skip(`likuiditas $${liq.toFixed(0)} < $${a.minLiqUsd}`);

  // 5. caps: concurrent, per-hour, daily
  const now = Date.now();
  const st = load();
  st.opens = st.opens.filter((o) => now - o.ts < 24 * 3600_000); // prune >24h
  const openPositions = await listPositions().then((r) => r.length).catch(() => 0);
  if (openPositions >= a.maxOpen) return skip(`posisi terbuka ${openPositions} ≥ maxOpen ${a.maxOpen}`);
  const lastHour = st.opens.filter((o) => now - o.ts < 3600_000).length;
  if (lastHour >= a.maxPerHour) return skip(`${lastHour} open/jam ≥ maxPerHour ${a.maxPerHour}`);
  const spentToday = st.opens.reduce((s, o) => s + o.sizeEth, 0);
  if (spentToday + a.sizeEth > a.dailyCapEth) return skip(`cap harian: ${spentToday.toFixed(4)}+${a.sizeEth} > ${a.dailyCapEth}Ξ`);

  // 6. wallet has funds
  const b = await balances().catch(() => null);
  if (b) {
    const usable = Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);
    if (usable < a.sizeEth) return skip(`saldo ${usable.toFixed(5)} < size ${a.sizeEth}`);
    if (Number(b.eth) < GAS_RESERVE) return skip(`ETH native < gas reserve`);
  }

  // 7. pick pool honoring the fee focus (>= minFeePpm, prefer highest)
  const pools = await findPools(candidate.token).catch(() => []);
  const pool = pickLpPool(pools);
  if (!pool) return skip(`tidak ada pool v3 fee ≥ ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`);

  // 8. OPEN
  try {
    log.info(`AUTO-OPEN ${candidate.symbol} ${a.sizeEth}Ξ ${a.mode} pool fee ${pool.fee}`);
    const result = await openPosition(candidate.token, pool.pool, String(a.sizeEth), { mode: a.mode });
    st.opens.push({ ts: now, token: candidate.token, sizeEth: a.sizeEth, tokenId: result.tokenId });
    save(st);
    return { opened: true, reason: "opened", token: candidate.token, symbol: candidate.symbol, sizeEth: a.sizeEth, result };
  } catch (e) {
    return skip(`open gagal: ${(e as Error).message.slice(0, 100)}`);
  }
}

/** Snapshot for /auto status. */
export function autoLpStatus(): { spentToday: number; opensToday: number; lastHour: number } {
  const now = Date.now();
  const st = load();
  const today = st.opens.filter((o) => now - o.ts < 24 * 3600_000);
  return {
    spentToday: today.reduce((s, o) => s + o.sizeEth, 0),
    opensToday: today.length,
    lastHour: today.filter((o) => now - o.ts < 3600_000).length,
  };
}
