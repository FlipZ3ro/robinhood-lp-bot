/**
 * Robinhood Chain sequencer feed listener (Arbitrum Nitro broadcast).
 *
 * wss://feed.mainnet.chain.robinhood.com/feed — anonymous, header
 * `Arbitrum-Feed-Client-Version: 2`, HTTP/1.1 upgrade. Streams sequenced L2 txs in
 * real time (sub-second), i.e. before they're queryable via RPC or indexed by DexScreener.
 *
 * NOTE ON DNS: some ISPs (e.g. Telkomsel "Internet Baik") hijack DNS for this domain and
 * return a filter page instead of Cloudflare. Set RH_FEED_IP to a real edge IP
 * (customer-origin.offchainlabs.com → 172.66.147.70 / 104.20.46.209) to pin past the
 * hijack while keeping correct SNI. On a US VPS you won't need it.
 */
import WebSocket from "ws";
import { parseFrame, type FeedTx } from "./decode.js";
import { logger } from "../util/log.js";

const log = logger("feed");

const DEFAULT_URL = "wss://feed.mainnet.chain.robinhood.com/feed";
const STALL_MS = 30_000; // no message this long → assume dead, reconnect
const MAX_BACKOFF = 30_000;

export interface FeedListenerOpts {
  /** Called with the decoded signed txs of every frame. */
  onTx: (txs: FeedTx[]) => void;
  url?: string;
  /** Pin the TLS connection to this IP (SNI stays the hostname). Bypasses DNS hijack. */
  ip?: string;
}

export class FeedListener {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastMsg = 0;
  private stopped = false;
  private readonly url: string;
  private readonly host: string;
  private readonly ip?: string;

  constructor(private readonly opts: FeedListenerOpts) {
    this.url = opts.url ?? process.env.RH_FEED_URL?.trim() ?? DEFAULT_URL;
    this.ip = opts.ip ?? process.env.RH_FEED_IP?.trim() ?? undefined;
    this.host = new URL(this.url).host;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    if (!this.stallTimer) {
      this.stallTimer = setInterval(() => {
        if (this.lastMsg && Date.now() - this.lastMsg > STALL_MS) {
          log.warn("stall — reconnect");
          this.ws?.terminate();
        }
      }, 10_000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const headers: Record<string, string> = { "Arbitrum-Feed-Client-Version": "2" };
    let target = this.url;
    // servername is a TLS option ws forwards but @types/ws doesn't list — widen the type
    const wsOpts: WebSocket.ClientOptions & { servername?: string } = {
      headers,
      handshakeTimeout: 15_000,
    };
    if (this.ip) {
      // connect to the raw IP but present the real hostname for SNI + Host
      target = this.url.replace(this.host, this.ip);
      headers.Host = this.host;
      wsOpts.servername = this.host.split(":")[0];
    }
    log.info(`connect ${this.host}${this.ip ? ` @${this.ip}` : ""}`);
    const ws = new WebSocket(target, wsOpts);
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 1000;
      this.lastMsg = Date.now();
      log.info("connected (101)");
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.lastMsg = Date.now();
      try {
        const txs = parseFrame(data as Buffer);
        if (txs.length) this.opts.onTx(txs);
      } catch (e) {
        log.debug(`decode err: ${(e as Error).message}`);
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      log.error(`handshake ditolak: HTTP ${res.statusCode} (DNS hijack? set RH_FEED_IP)`);
      ws.terminate();
    });
    ws.on("error", (e) => log.warn(`ws error: ${e.message}`));
    ws.on("close", () => {
      this.ws = null;
      if (this.stopped) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
      log.warn(`disconnected — reconnect in ${wait}ms`);
      setTimeout(() => this.connect(), wait);
    });
  }
}
