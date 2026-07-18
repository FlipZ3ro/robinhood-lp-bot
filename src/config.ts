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
  sources: z.array(z.enum(["feed-new", "watch-spike"])).default(["watch-spike"]),
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
  telegramChatId: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LpConfig = z.infer<typeof LpSchema>;
export type WatchConfig = z.infer<typeof WatchSchema>;
export type FeedConfig = z.infer<typeof FeedSchema>;
export type RadarConfig = z.infer<typeof RadarSchema>;
export type AutoLpConfig = z.infer<typeof AutoLpSchema>;

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
    contracts: { ...((disk.contracts as object) ?? {}), ...cfg.contracts },
  };
  writeJson(CONFIG_FILE, merged);
}

// ── Secrets & identity (env only) ──
const DEFAULT_SEQUENCER = "https://sequencer.mainnet.chain.robinhood.com/";
export const env = {
  rpcUrl: process.env.RH_RPC_URL?.trim() || cfg.rpcUrl,
  watchRpcUrl: process.env.RH_WATCH_RPC_URL?.trim() || "",
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
