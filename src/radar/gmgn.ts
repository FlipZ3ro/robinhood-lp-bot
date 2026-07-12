/**
 * GMGN enrichment via the `gmgn-cli` (chain `robinhood`). Best-effort: if the CLI is
 * missing or not configured (keypair + GMGN_API_KEY must match, set up on the machine
 * that generated the key), every call returns null and the radar degrades gracefully.
 *
 * Setup on the host that runs the bot:
 *   npm install -g gmgn-cli
 *   gmgn-cli config              # generates keypair, prints a URL
 *   # open the URL, create the API key bound to the shown public key, then:
 *   gmgn-cli config --apply <API_KEY>
 */
import { execFile } from "node:child_process";
import { logger } from "../util/log.js";

const log = logger("gmgn");
const CHAIN = "robinhood";
const TIMEOUT = 12_000;

let available: boolean | null = null;

/** Run a gmgn-cli sub-command with --raw and parse JSON. Returns null on any failure. */
function run(args: string[]): Promise<any | null> {
  return new Promise((resolve) => {
    execFile("gmgn-cli", args, { timeout: TIMEOUT, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

/** One-time availability probe (CLI present + configured). */
export async function gmgnAvailable(): Promise<boolean> {
  if (available !== null) return available;
  const r = await new Promise<boolean>((resolve) => {
    execFile("gmgn-cli", ["config", "--check"], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
  available = r;
  if (!r) log.info("gmgn-cli tidak tersedia / belum dikonfigurasi — enrichment GMGN dilewati");
  return r;
}

export interface GmgnData {
  symbol?: string;
  priceUsd?: number;
  marketCap?: number;
  liquidityUsd?: number;
  holders?: number;
  smartWallets?: number; // smart money holders
  kolWallets?: number;
  // security
  isHoneypot?: string; // "yes"/"no"/""
  buyTax?: number;
  sellTax?: number;
  rugRatio?: number;
  top10Rate?: number;
  ownerRenounced?: string;
  sniperCount?: number;
  devHolding?: string;
}

/** Fetch + flatten the GMGN token info + security for a Robinhood-chain token. */
export async function gmgnToken(address: string): Promise<GmgnData | null> {
  if (!(await gmgnAvailable())) return null;
  const [info, sec] = await Promise.all([
    run(["token", "info", "--chain", CHAIN, "--address", address, "--raw"]),
    run(["token", "security", "--chain", CHAIN, "--address", address, "--raw"]),
  ]);
  if (!info && !sec) return null;
  const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
  const price = num(info?.price?.price);
  const supply = num(info?.circulating_supply ?? info?.total_supply);
  return {
    symbol: info?.symbol,
    priceUsd: price,
    marketCap: price != null && supply != null ? price * supply : undefined,
    liquidityUsd: num(info?.liquidity),
    holders: num(info?.holder_count),
    smartWallets: num(info?.wallet_tags_stat?.smart_wallets),
    kolWallets: num(info?.wallet_tags_stat?.renowned_wallets),
    isHoneypot: sec?.is_honeypot,
    buyTax: num(sec?.buy_tax),
    sellTax: num(sec?.sell_tax),
    rugRatio: num(sec?.rug_ratio),
    top10Rate: num(sec?.top_10_holder_rate),
    ownerRenounced: sec?.owner_renounced,
    sniperCount: num(sec?.sniper_count),
    devHolding: sec?.creator_token_status,
  };
}
