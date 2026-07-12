/**
 * Chain clients: providers, the (single) wallet, and gas overrides.
 *
 * Two providers on purpose:
 *   provider      → LP ops (mint/close/quote). RH_RPC_URL, fallback config.rpcUrl.
 *   watchProvider → volume scanner. RH_WATCH_RPC_URL so scan traffic can't rate-limit
 *                   the RPC you need when closing a position. Falls back to `provider`.
 */
import { ethers, type JsonRpcPayload, type JsonRpcResult } from "ethers";
import { cfg, env } from "../config.js";
import { seqCall } from "./sequencer.js";
import { logger } from "../util/log.js";

const log = logger("client");

/**
 * A JsonRpcProvider that reads from Alchemy but diverts `eth_sendRawTransaction` to the
 * sequencer (fastest fire). On transport failure it falls back to Alchemy so a tx is
 * never lost. Everything else (nonce, gas, staticCall, logs) stays on Alchemy.
 */
class SequencerRoutingProvider extends ethers.JsonRpcProvider {
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const items = Array.isArray(payload) ? payload : [payload];
    if (!items.some((p) => p.method === "eth_sendRawTransaction")) {
      return super._send(payload);
    }
    return Promise.all(
      items.map(async (p) => {
        if (p.method !== "eth_sendRawTransaction") {
          return (await super._send([p]))[0]!;
        }
        try {
          const resp = await seqCall({ id: p.id, method: p.method, params: p.params as unknown[] });
          // ethers accepts an error-shaped result object here at runtime
          return (resp.error ? { id: p.id, error: resp.error } : { id: p.id, result: resp.result! }) as JsonRpcResult;
        } catch (e) {
          log.warn(`sequencer submit gagal (${(e as Error).message}) → fallback RPC utama`);
          return (await super._send([p]))[0]!;
        }
      }),
    );
  }
}

export const provider: ethers.JsonRpcProvider = env.fastSubmit
  ? new SequencerRoutingProvider(env.rpcUrl, cfg.chainId)
  : new ethers.JsonRpcProvider(env.rpcUrl, cfg.chainId);

if (env.fastSubmit) log.info(`fast-submit ON → ${env.sequencerUrl}${env.sequencerIp ? ` @${env.sequencerIp}` : ""}`);

export const usingOwnWatchRpc = !!env.watchRpcUrl;
export const watchProvider = env.watchRpcUrl
  ? new ethers.JsonRpcProvider(env.watchRpcUrl, cfg.chainId)
  : provider;

let _wallet: ethers.Wallet | null = null;
export function wallet(): ethers.Wallet {
  if (!_wallet) {
    if (!env.walletKey) throw new Error("RH_WALLET_KEY belum diset di .env");
    _wallet = new ethers.Wallet(env.walletKey, provider);
  }
  return _wallet;
}

/**
 * Gas overrides. Robinhood base fee moves per block; if maxFee is too tight the tx is
 * rejected ("max fee < base fee") and hangs → close/mint never lands. Buffer 3×.
 */
export async function overrides(): Promise<ethers.Overrides> {
  if (Number(cfg.gasPriceGwei) > 0) {
    return { gasPrice: ethers.parseUnits(String(cfg.gasPriceGwei), "gwei") };
  }
  try {
    const gp = (await provider.getFeeData()).gasPrice;
    if (gp) return { gasPrice: gp * 3n };
  } catch {
    /* fall through to node default */
  }
  return {};
}
