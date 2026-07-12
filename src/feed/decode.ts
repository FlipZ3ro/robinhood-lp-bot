/**
 * Arbitrum Nitro broadcast-feed decoder.
 *
 * Frame (JSON):
 *   { version, messages: [ { sequenceNumber, message: { message: {
 *       header: { kind }, l2Msg: <base64> } } } ] }
 *
 * header.kind == 3  → L2Message. Decode l2Msg bytes:
 *   bytes[0] == 3   → Batch:    repeated [8-byte BE length][entry], each entry a nested L2 msg
 *   bytes[0] == 4   → SignedTx: bytes[1:] is a binary signed tx (legacy RLP or EIP-2718 typed)
 *
 * We only care about SignedTx leaves (real user transactions). Everything else is skipped.
 */
import { ethers } from "ethers";

const L1_KIND_L2MESSAGE = 3;
const L2_KIND_BATCH = 3;
const L2_KIND_SIGNED_TX = 4;
const MAX_DEPTH = 16;

export interface FeedTx {
  sequenceNumber: number;
  tx: ethers.Transaction;
}

/** Decode one raw feed frame into the signed transactions it carries. */
export function parseFrame(raw: string | Buffer): FeedTx[] {
  let frame: any;
  try {
    frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return [];
  }
  const out: FeedTx[] = [];
  for (const m of frame?.messages ?? []) {
    const seq = Number(m?.sequenceNumber ?? 0);
    const inner = m?.message?.message; // BroadcastFeedMessage.Message.Message (L1IncomingMessage)
    const kind = inner?.header?.kind;
    const l2b64 = inner?.l2Msg;
    if (kind !== L1_KIND_L2MESSAGE || typeof l2b64 !== "string") continue;
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(l2b64, "base64");
    } catch {
      continue;
    }
    decodeL2Message(bytes, seq, out, 0);
  }
  return out;
}

function decodeL2Message(bytes: Uint8Array, seq: number, out: FeedTx[], depth: number): void {
  if (depth > MAX_DEPTH || bytes.length < 1) return;
  const kind = bytes[0]!;
  const body = bytes.subarray(1);

  if (kind === L2_KIND_SIGNED_TX) {
    try {
      const tx = ethers.Transaction.from(ethers.hexlify(body));
      out.push({ sequenceNumber: seq, tx });
    } catch {
      /* unknown/arbitrum-native tx type — skip */
    }
    return;
  }

  if (kind === L2_KIND_BATCH) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 1; // past the kind byte
    while (off + 8 <= bytes.length) {
      const len = Number(view.getBigUint64(off, false)); // 8-byte big-endian length
      off += 8;
      if (len <= 0 || off + len > bytes.length) break;
      decodeL2Message(bytes.subarray(off, off + len), seq, out, depth + 1);
      off += len;
    }
    return;
  }
  // other L2 kinds (unsigned/contract/compressed) — not needed for read-only monitoring
}
