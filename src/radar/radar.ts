/**
 * Candidate radar — the "confirmation layer" (pattern borrowed from the meridian Solana
 * agent). Gathers our on-chain signals + GMGN intelligence, then asks an LLM for a
 * skeptical LP verdict. Entirely best-effort: disabled unless cfg.radar.enabled AND an
 * OpenRouter key is set; GMGN is optional on top.
 */
import { cfg } from "../config.js";
import { logger } from "../util/log.js";
import { gmgnToken, type GmgnData } from "./gmgn.js";
import { llmScore, type LlmVerdict } from "./openrouter.js";

const log = logger("radar");

export interface Candidate {
  token: string;
  symbol: string;
  source: "feed-new" | "watch-spike" | "hunt";
  fee?: number;
  wethSeed?: number;
  onchainBackPct?: number; // our buy→sell round-trip sim (100 = clean)
  onchainTaxPct?: number;
  vol5m?: number;
  vol1h?: number;
  liq?: number;
  fdv?: number;
}

export interface Verdict {
  llm: LlmVerdict | null;
  gmgn: GmgnData | null;
}

export function radarEnabled(): boolean {
  // enabled runs the layer; LLM needs a key but GMGN enrichment works standalone
  return cfg.radar.enabled;
}

const SYSTEM = [
  "You are a skeptical liquidity-provider (LP) screener for Uniswap memecoin pools on Robinhood Chain.",
  "Providing LP on a memecoin makes the bot an AUTOMATIC BUYER as the price falls, so downside risk matters more than upside.",
  "METRIC MEANINGS (read every number EXACTLY as given, do not invent values):",
  "• onchain_roundtrip_pct = % of value returned on a 0.01 ETH buy→sell sim. ~98-100 = CLEAN (only pool fee lost); <90 = hidden sell tax; 0/revert = honeypot. HIGHER IS BETTER — it is NOT a tax.",
  "• onchain_hidden_tax_pct = extra loss beyond the normal fee. 0 = none; higher = worse.",
  "• liquidity_usd / liq = pool depth in USD (bigger = safer to enter/exit).",
  "• smart_money_wallets ≥3 = bullish; 0 = no smart interest (bearish, not a hard stop).",
  "• rug_ratio 0-1 (>0.3 risky). top10_holder_rate 0-1 (>0.5 too concentrated). sell_tax/buy_tax are decimals (0.05 = 5%).",
  "Missing/unavailable data = uncertainty, not safety. Be conservative on thin or very-new tokens.",
  'Respond ONLY as compact JSON: {"score": <0-100 conviction>, "action": "ape"|"watch"|"skip", "summary": "<one sentence, <180 chars, state the KEY reason>"}.',
].join(" ");

export async function scoreCandidate(c: Candidate): Promise<Verdict | null> {
  if (!radarEnabled()) return null;
  const gmgn = cfg.radar.useGmgn ? await gmgnToken(c.token).catch(() => null) : null;
  const user = buildPrompt(c, gmgn);
  const llm = await llmScore(SYSTEM, user);
  if (!llm && !gmgn) return null;
  if (llm) log.info(`${c.symbol}: ${llm.action} (${llm.score}) — ${llm.summary.slice(0, 60)}`);
  return { llm, gmgn };
}

function buildPrompt(c: Candidate, gmgn: GmgnData | null): string {
  const payload = {
    token: c.token,
    symbol: c.symbol,
    source: c.source,
    fee_tier: c.fee,
    weth_seed: c.wethSeed,
    onchain_roundtrip_pct: c.onchainBackPct,
    onchain_hidden_tax_pct: c.onchainTaxPct,
    volume_5m_usd: c.vol5m,
    volume_1h_usd: c.vol1h,
    liquidity_usd: c.liq,
    fdv_usd: c.fdv,
    gmgn: gmgn
      ? {
          market_cap: gmgn.marketCap,
          liquidity_usd: gmgn.liquidityUsd,
          holders: gmgn.holders,
          smart_money_wallets: gmgn.smartWallets,
          kol_wallets: gmgn.kolWallets,
          is_honeypot: gmgn.isHoneypot,
          buy_tax: gmgn.buyTax,
          sell_tax: gmgn.sellTax,
          rug_ratio: gmgn.rugRatio,
          top10_holder_rate: gmgn.top10Rate,
          owner_renounced: gmgn.ownerRenounced,
          sniper_count: gmgn.sniperCount,
          dev_holding: gmgn.devHolding,
        }
      : "unavailable",
  };
  return "Screen this LP candidate:\n" + JSON.stringify(payload, null, 0);
}
