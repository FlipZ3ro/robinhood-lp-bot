/**
 * Direct sequencer submission (fastest fire).
 *
 * The Robinhood sequencer (`https://sequencer.mainnet.chain.robinhood.com/`, AWS us-east-2
 * / Ohio) accepts ONLY `eth_sendRawTransaction` — read methods 404. Broadcasting straight
 * to it skips the Alchemy → sequencer relay hop (~8ms from an Ohio VPS). Reads still go
 * through Alchemy; see SequencerRoutingProvider in client.ts.
 *
 * IP pinning (RH_SEQUENCER_IP) is supported for the same DNS-hijack reason as the feed:
 * connect to the raw IP while keeping the real hostname for SNI + Host.
 */
import https from "node:https";
import { env } from "../config.js";

export interface RpcPayload {
  id: number | string;
  jsonrpc?: string;
  method: string;
  params: unknown[];
}
export interface RpcResponse {
  id: number | string;
  result?: string;
  error?: { code: number; message: string };
}

/** POST one JSON-RPC payload to the sequencer. Rejects only on transport failure. */
export function seqCall(payload: RpcPayload): Promise<RpcResponse> {
  const url = new URL(env.sequencerUrl);
  const body = JSON.stringify({ jsonrpc: "2.0", ...payload });
  const options: https.RequestOptions = {
    method: "POST",
    host: env.sequencerIp || url.hostname,
    servername: url.hostname, // SNI stays the hostname even when host is a pinned IP
    port: url.port || 443,
    path: url.pathname || "/",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: url.hostname,
    },
    timeout: 10_000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`sequencer bad response: ${(e as Error).message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("sequencer timeout")));
    req.write(body);
    req.end();
  });
}
