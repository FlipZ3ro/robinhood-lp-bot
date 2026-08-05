/**
 * Config = config.json (validated with zod) + secrets from .env.
 *
 * config.json holds tunables (safe to commit). .env holds the private key, RPC URLs,
 * Telegram token, and the OWNER chat id (the auth boundary). Anything money- or
 * identity-sensitive lives in .env only.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROOT, writeJson } from "./util/files.js";
import { logger } from "./util/log.js";

const log = logger("config");
const CONFIG_FILE = path.join(ROOT, "config.json");

const ContractsSchema = z.object({
  factory: z.string(), // v3 factory
  positionManager: z.string(), // v3 NonfungiblePositionManager
  swapRouter02: z.string(),
  quoter: z.string(),
  weth: z.string(),
  // Other Uniswap versions on Robinhood Chain (detection now; v2/v4 LP execution = later)
  v2Factory: z.string().optional(),
  v4PoolManager: z.string().optional(),
  v4PositionManager: z.string().optional(),
  v4StateView: z.string().optional(),
  v4Quoter: z.string().optional(),
  universalRouter: z.string().optional(), // dominant swap venue (routes v2/v3/v4)
});

const LpSchema = z.object({
  widthPct: z.number().positive().default(50),
  depositUsd: z.number().default(20),
  // feeTiers = ALL tiers, used for quoting/sell-routing (keep complete). On Robinhood v3
  // only 100/500/3000/10000 are enabled; 3-25% tiers live on v4 (not yet supported).
  feeTiers: z.array(z.number().int()).nonempty().default([10000, 3000, 500, 100]),
  // minFeePpm = LP fee floor (hundredths of a bip). Memecoin fees are thin at low tiers,
  // so LP (manual pick prefers, auto-LP requires) targets fee >= this. 3000 = 0.3%.
  minFeePpm: z.number().int().default(3000),
  preferHighestFee: z.boolean().default(true), // pick the highest eligible fee pool
  slippagePct: z.number().min(0).max(50).default(5),
  autoWrap: z.boolean().default(true),
  rangeBufferSpacings: z.number().int().default(2),
  nativeTargetEth: z.number().min(0).default(0.015),
  autoSwapOnClose: z.boolean().default(true),
  minPoolTvlUsd: z.number().min(0).default(2000), // hide pools below this total liquidity ($) in the LP picker
});

const WatchSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSec: z.number().int().positive().default(120),
  minVol5m: z.number().default(150000),
  riseFactor: z.number().default(1.4),
  minVol1h: z.number().default(300000),
  minLiqUsd: z.number().default(50000),
  maxTaxPct: z.number().default(6),
  cooldownMin: z.number().default(60),
  maxTokens: z.number().int().default(300),
});

// Real-time sequencer-feed monitor (see src/feed/). Opt-in (advanced).
const FeedSchema = z.object({
  enabled: z.boolean().default(false),
  newToken: z.boolean().default(true), // alert on fresh WETH pools / first mints
  positionMonitor: z.boolean().default(true), // watch swaps hitting YOUR pools + range
  autoCloseOutOfRange: z.boolean().default(false), // DANGER: auto-close when price leaves range
  newTokenMinWethSeed: z.number().min(0).default(0.02), // ignore micro launches
  activityThreshold: z.number().int().positive().default(3), // swaps before a tick re-check
  cooldownMin: z.number().default(30),
});

// LLM radar (OpenRouter) + GMGN enrichment for candidate scoring/confirmation.
const RadarSchema = z.object({
  enabled: z.boolean().default(false), // needs RH_OPENROUTER_KEY too
  useGmgn: z.boolean().default(true), // enrich with GMGN (needs configured gmgn-cli)
  attachToNewToken: z.boolean().default(true),
  attachToWatch: z.boolean().default(true),
});

// Autonomous LP: candidate → radar confirm → auto-open. DANGEROUS (spends funds
// unattended). Default OFF with conservative caps; every gate must pass.
const AutoLpSchema = z.object({
  enabled: z.boolean().default(false),
  sizeEth: z.number().positive().default(0.001), // ETH per auto position
  mode: z.enum(["single", "inrange"]).default("single"), // single = rug-safe
  minScore: z.number().min(0).max(100).default(75), // radar LLM score floor
  requireAction: z.enum(["ape", "watch", "skip"]).default("ape"),
  requireLlm: z.boolean().default(true), // need an LLM verdict, not just GMGN
  requireGmgn: z.boolean().default(false),
  minLiqUsd: z.number().default(20000), // hard liquidity floor
  maxTaxPct: z.number().default(5), // hard tax ceiling (GMGN)
  maxOpen: z.number().int().default(3), // max concurrent LP positions total
  maxPerHour: z.number().int().default(2), // rate limit
  dailyCapEth: z.number().default(0.01), // max ETH auto-deployed per 24h
  sources: z.array(z.enum(["feed-new", "watch-spike", "hunt"])).default(["watch-spike", "hunt"]),
  // ── auto-CLOSE (manage loop, opt-in per trigger; 0/false = off) ──
  tpPct: z.number().default(0), // take-profit: close when PnL% ≥ this
  slPct: z.number().default(0), // stop-loss: close when PnL% ≤ -this
  closeOor: z.boolean().default(false), // close positions that drift OUT OF RANGE
  oorGraceMin: z.number().default(30), // wait this long OOR before closing (single-side parks are OOR by design)
  oorCooldownCount: z.number().int().default(3), // #2 OOR cooldown: after this many OOR-closes, blacklist the token
  oorCooldownHours: z.number().default(12), // #2 OOR cooldown: ...for this long (stop re-entering a token that never fills)
  // #1 rebalance-on-OOR: "close" = just close an OOR position (default). "rebalance" = close it THEN
  // re-open the same token recentered on the current price (volatility-adaptive width) so the capital
  // keeps earning instead of sitting idle in ETH. The OOR cooldown (above) caps the rebalance churn.
  oorAction: z.enum(["close", "rebalance"]).default("close"),
  // #3 fee-compound: harvest an in-range position's accrued fees and add them BACK as liquidity
  // (compounding, no swap → no drag) once they clear compoundMinUsd. OFF by default.
  compound: z.boolean().default(false),
  compoundMinUsd: z.number().default(0.5), // only compound when uncollected fees ≥ this ($)
  // #3 volume-FADE exit (Meteora "exit when volume fades"): close a position once its pool's current
  // hour drops below this × the 24h-average hour (spikeX < volFadeX = the spike is over → rotate out).
  // 0 = off. e.g. 0.35 = close when the current hour is under 35% of the pool's average hour.
  volFadeX: z.number().default(0),
  // #3 volume-fade age guard: don't let VFADE close a position younger than this (minutes). Stops the
  // "enter → instantly fade-exit" trap when the entry spike (minSpikeX) sits near volFadeX — the fresh
  // position needs time to actually earn fees before a momentary volume dip is allowed to close it.
  vfadeMinAgeMin: z.number().default(20),
  // fee-velocity exit: close an IN-RANGE position whose RECENT fee-earning rate ($/h, measured over a
  // rolling window) drops below this floor → the pool stopped being productive, so evict it and free the
  // slot for a live candidate. 0 = off. The direct "is this LP actually earning?" signal, complementing
  // the volume-proxy volFadeX. feeGraceMin protects a slow-starter from being cut too early.
  minFeePerHourUsd: z.number().default(0),
  feeGraceMin: z.number().default(30), // min position age (min) before fee-velocity can fire
  manageSec: z.number().int().positive().default(90), // manage-loop interval (seconds)
});

// Quality-candidate hunter: poll GMGN trending → screen (thesis + LLM) → keep only tokens that
// have a v4 pool in the target fee band (3-5%) with real 24h volume → alert with 1-tap LP.
// Replaces the noisy "every new token/pool" feed spam with focused, farmable candidates.
const ScanSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMin: z.number().int().positive().default(3),
  feeMinPpm: z.number().int().default(30000), // 3.00%
  feeMaxPpm: z.number().int().default(50000), // 5.00%
  minVolUsd: z.number().default(10000), // pool 24h volume floor ("tx rame")
  minPoolFeesUsd: z.number().default(250), // #1 fee-yield: min 24h fees the pool generated (vol × fee%) — weights busy + HIGH-fee over raw volume
  minFeeYieldPct: z.number().default(0), // #1 fee-yield: min daily fee/TVL yield % — only enforced when TVL is readable (v4 singleton often reads $0 → skipped)
  // ANTI-WASH: reject pools with huge volume on near-zero REAL liquidity (e.g. $130k vol on $0.5k liq
  // = fake/wash volume + trap: your LP becomes ~all the liquidity). Only applied when liq is READABLE
  // (>0) — v4 singleton liq frequently reads $0 which we can't assess, so those aren't blocked here.
  minPoolLiqUsd: z.number().default(1000), // pool liquidity floor ($) — 0 = off
  maxVolLiqRatio: z.number().default(0), // reject when vol/liq exceeds this (wash indicator) — 0 = off
  // #1 volume-SPIKE (Meteora "volume is king"): require the pool's recent hour to be ≥ this × its
  // 24h-average hour (spikeX = volH1/(vol24h/24)). >1 = heating up NOW. 0 = off (don't gate on spike).
  minSpikeX: z.number().default(0),
  minScore: z.number().default(55), // screening score floor (0-100)
  cooldownMin: z.number().default(120), // don't re-alert the same token within this window
  // GMGN trending gates for the hunt — LOOSER than /screen (which targets big tokens), because
  // the 3-5% high-fee pools live on SMALLER tokens (a JACKET, not a VIRTUAL). These decide which
  // tokens get to the per-token 3-5%-pool check.
  screenMinMcap: z.number().default(20000),
  screenMaxMcap: z.number().default(0), // 0 = no ceiling. Set to farm SMALL-cap pools: for a fixed small position, a smaller pool = bigger fee share = faster fees.
  screenMinVol: z.number().default(50000),
  screenMinLiq: z.number().default(3000),
});

const ConfigSchema = z.object({
  rpcUrl: z.string(),
  chainId: z.number().int(),
  explorer: z.string(),
  contracts: ContractsSchema,
  lp: LpSchema,
  gasPriceGwei: z.number().default(0),
  watch: WatchSchema,
  feed: FeedSchema.default({}),
  radar: RadarSchema.default({}),
  autoLp: AutoLpSchema.default({}),
  scan: ScanSchema.default({}),
  telegramChatId: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LpConfig = z.infer<typeof LpSchema>;
export type WatchConfig = z.infer<typeof WatchSchema>;
export type FeedConfig = z.infer<typeof FeedSchema>;
export type RadarConfig = z.infer<typeof RadarSchema>;
export type AutoLpConfig = z.infer<typeof AutoLpSchema>;
export type ScanConfig = z.infer<typeof ScanSchema>;

function load(): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    throw new Error(`config.json tidak terbaca: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    log.error("config.json invalid", parsed.error.flatten().fieldErrors);
    throw new Error("config.json gagal validasi — cek field di atas.");
  }
  return parsed.data;
}

/** Mutable in-memory config. /set mutates this and calls persist(). */
export const cfg: Config = load();
export const C = cfg.contracts;

/**
 * Persist current config back to disk. MERGE with what's on disk so a concurrent edit
 * of an unrelated key isn't clobbered by our in-memory snapshot.
 */
export function persist(): void {
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* first run */
  }
  const merged = {
    ...disk,
    ...cfg,
    lp: { ...((disk.lp as object) ?? {}), ...cfg.lp },
    watch: { ...((disk.watch as object) ?? {}), ...cfg.watch },
    feed: { ...((disk.feed as object) ?? {}), ...cfg.feed },
    radar: { ...((disk.radar as object) ?? {}), ...cfg.radar },
    autoLp: { ...((disk.autoLp as object) ?? {}), ...cfg.autoLp },
    scan: { ...((disk.scan as object) ?? {}), ...cfg.scan },
    contracts: { ...((disk.contracts as object) ?? {}), ...cfg.contracts },
  };
  writeJson(CONFIG_FILE, merged);
}

// ── Secrets & identity (env only) ──
const DEFAULT_SEQUENCER = "https://sequencer.mainnet.chain.robinhood.com/";
export const env = {
  rpcUrl: process.env.RH_RPC_URL?.trim() || cfg.rpcUrl,
  watchRpcUrl: process.env.RH_WATCH_RPC_URL?.trim() || "",
  // dedicated RPC for the heavy v4 discovery getLogs (fromBlock=0 full-range) so a hunt-scan burst
  // can't rate-limit / slow the main RPC that LP ops (mint/close) need. Falls back to `provider`.
  logsRpcUrl: process.env.RH_LOGS_RPC_URL?.trim() || "",
  walletKey: (process.env.RH_WALLET_KEY || "").trim(),
  tgToken: (process.env.RH_TG_TOKEN || "").trim(),
  /** OWNER chat id — the auth boundary. Only this chat may command the bot. */
  ownerChat: (process.env.RH_TG_CHAT || cfg.telegramChatId || "").trim(),
  // fast-submit: broadcast raw txs straight to the sequencer (skip Alchemy relay hop)
  fastSubmit: /^(1|true|yes|on)$/i.test(process.env.RH_FAST_SUBMIT?.trim() || ""),
  sequencerUrl: process.env.RH_SEQUENCER_URL?.trim() || DEFAULT_SEQUENCER,
  sequencerIp: process.env.RH_SEQUENCER_IP?.trim() || "",
  // LLM radar — any OpenAI-compatible endpoint (OpenRouter default; override RH_OPENROUTER_URL
  // for a custom gateway, e.g. agentcash). + GMGN enrichment.
  openrouterKey: (process.env.RH_OPENROUTER_KEY || "").trim(),
  openrouterUrl: process.env.RH_OPENROUTER_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
  openrouterModel: process.env.RH_OPENROUTER_MODEL?.trim() || "nvidia/nemotron-3-super-120b-a12b:free",
  // Daily-briefing LLM (a smarter model for the once-a-day analysis). Falls back to the same gateway
  // + key the screener already uses (RH_OPENROUTER_*, both SECRET / private-gateway URL → .env only)
  // so neither the key nor the gateway host is ever committed; only the MODEL differs
  // (cc/claude-sonnet-5). Override per-var via RH_BRIEF_* to point the briefing at a different gateway.
  briefUrl: process.env.RH_BRIEF_URL?.trim() || process.env.RH_OPENROUTER_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions",
  briefKey: (process.env.RH_BRIEF_KEY || process.env.RH_OPENROUTER_KEY || "").trim(),
  briefModel: process.env.RH_BRIEF_MODEL?.trim() || "cc/claude-sonnet-5",
  gmgnKey: (process.env.RH_GMGN_KEY || "").trim(),
  // KyberSwap aggregator — best-route swaps (auto multi-hop across all pools/fee-tiers/hooks).
  // Used to acquire the token side before an in-range LP (far better execution than swapping on
  // the fee-tier pool you're farming). Router is a hard whitelist: calldata is only ever sent here.
  kyberBase: (process.env.KYBERSWAP_AGGREGATOR_API_BASE_URL || "https://aggregator-api.kyberswap.com").trim().replace(/\/$/, ""),
  kyberChain: (process.env.KYBERSWAP_CHAIN || "robinhood").trim(),
  kyberRouter: (process.env.KYBERSWAP_ROUTER_ADDRESS || "").trim(),
};

/** Fail fast at startup if a required secret is missing or malformed. */
export function assertSecrets(): void {
  if (!env.tgToken) throw new Error("RH_TG_TOKEN belum diset di .env");
  if (!env.walletKey) throw new Error("RH_WALLET_KEY belum diset di .env");
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.walletKey)) {
    throw new Error("RH_WALLET_KEY format salah — harus 0x + 64 hex.");
  }
  if (!env.ownerChat) {
    log.warn(
      "RH_TG_CHAT belum diset — bot akan mengunci ke chat PERTAMA yang kirim /start, " +
        "lalu menolak yang lain. Set RH_TG_CHAT di .env untuk mengunci permanen.",
    );
  }
}
