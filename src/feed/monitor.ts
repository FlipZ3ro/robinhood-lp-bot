/**
 * FeedMonitor — turns the raw sequencer feed into two real-time signals:
 *
 *   #1 New-token detector: a fresh WETH pool / first mint on a token we've never seen →
 *      honeypot-check on-chain → alert with 1-tap LP. Beats DexScreener (can't alert on a
 *      token it hasn't indexed). Seen-set is warm-seeded from Blockscout so first run
 *      doesn't spam every existing token.
 *
 *   #2 Position monitor: swaps hitting a pool you're LPing bump a per-token counter; once
 *      it crosses `activityThreshold` we do ONE cheap slot0() read to confirm the tick —
 *      if your position just left its range, alert (and optionally auto-close). The feed is
 *      the cheap trigger; RPC is only touched when something actually moved.
 */
import { ethers } from "ethers";
import { cfg } from "../config.js";
import { provider } from "../chain/client.js";
import { POOL_ABI } from "../chain/abis.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools } from "../chain/pools.js";
import { listPositions } from "../chain/positions.js";
import { closePosition } from "../chain/positions.js";
import { safetyCheck } from "../watch/scanner.js";
import { bsFetch } from "../chain/blockscout.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import { nudge as nudgeManage } from "../radar/automanage.js";
import { FeedListener } from "./listener.js";
import { extractPoolEvents } from "./lpdecode.js";
import { extractSwaps } from "./swapdecode.js";
import type { PoolEvent } from "./lpdecode.js";
import type { PositionRow } from "../types.js";

const log = logger("feedmon");
const SEEN_FILE = dataPath("feed-seen.json");
const POS_REFRESH_MS = 60_000;
const RANGE_RECHECK_MS = 20_000; // don't re-read tick for the same token faster than this

export interface MonitorHooks {
  onNewToken: (ev: NewTokenAlert) => void;
  onOutOfRange: (ev: OutOfRangeAlert) => void;
}

export interface NewTokenAlert {
  token: string;
  symbol: string;
  fee: number;
  wethSeed: number;
  kind: "mint" | "create";
  safeReason: string;
  backPct: number;
  poolExists: boolean;
}

export interface OutOfRangeAlert {
  tokenId: string;
  symbol: string;
  side: "atas" | "bawah";
  tick: number;
  tickLower: number;
  tickUpper: number;
  autoClosed: boolean;
  closeError?: string;
}

export class FeedMonitor {
  private listener: FeedListener;
  private seen: Set<string>;
  private cooldown = new Map<string, number>(); // token → last new-token alert ts
  private positions = new Map<string, PositionRow>(); // tokenLower → position (v3, for the cheap slot0 OOR alert)
  private posTokens = new Set<string>(); // ALL position token addrs (v3+v4), hex sans "0x" — feed→automanage nudge
  private inRangeState = new Map<string, boolean>(); // tokenId → was in range last check
  private activity = new Map<string, number>(); // tokenLower → swaps since last recheck
  private lastRangeCheck = new Map<string, number>(); // tokenLower → ts
  private inflight = new Set<string>(); // tokens being checked (dedupe async)
  private posTimer: ReturnType<typeof setInterval> | null = null;
  private stats = { newTokens: 0, rangeAlerts: 0, framesTx: 0 };

  constructor(private readonly hooks: MonitorHooks) {
    this.seen = new Set(readJson<string[]>(SEEN_FILE, []).map((s) => s.toLowerCase()));
    this.listener = new FeedListener({ onTx: (txs) => this.onTx(txs) });
  }

  async start(): Promise<void> {
    if (!this.seen.size) await this.warmSeed();
    await this.refreshPositions();
    this.posTimer = setInterval(() => void this.refreshPositions(), POS_REFRESH_MS);
    this.listener.start();
    log.info(
      `ON — newToken=${cfg.feed.newToken} positionMonitor=${cfg.feed.positionMonitor} autoClose=${cfg.feed.autoCloseOutOfRange} · manage-nudge=${cfg.feed.positionMonitor ? "wired→automanage" : "off"}`,
    );
  }

  stop(): void {
    this.listener.stop();
    if (this.posTimer) clearInterval(this.posTimer);
    this.persistSeen();
  }

  status(): { seen: number; positions: number } & typeof this.stats {
    return { seen: this.seen.size, positions: this.positions.size, ...this.stats };
  }

  // ── feed consumer (hot path — keep it cheap, defer RPC) ──
  private onTx(txs: { tx: ethers.Transaction; sequenceNumber: number }[]): void {
    for (const ftx of txs) {
      if (cfg.feed.newToken) {
        for (const ev of extractPoolEvents(ftx)) this.maybeNewToken(ev);
      }
      if (cfg.feed.positionMonitor && this.positions.size) {
        for (const s of extractSwaps(ftx)) {
          const k = s.token.toLowerCase();
          if (this.positions.has(k)) {
            this.stats.framesTx++;
            this.activity.set(k, (this.activity.get(k) ?? 0) + 1);
            if ((this.activity.get(k) ?? 0) >= cfg.feed.activityThreshold) void this.checkRange(k);
          }
        }
      }
      // feed → auto-manage nudge: ANY tx whose calldata references one of our position tokens (a swap
      // on that pool via any router/version — broader than the v3-only extractSwaps above) triggers an
      // immediate TP/SL/OOR check. Sub-second reaction vs the up-to-90s poll. nudge() self-debounces.
      if (cfg.feed.positionMonitor && cfg.autoLp.enabled && this.posTokens.size) {
        const data = (ftx.tx.data || "").toLowerCase();
        if (data.length > 10) {
          for (const tok of this.posTokens) {
            if (data.includes(tok)) {
              nudgeManage("feed-swap");
              break;
            }
          }
        }
      }
    }
  }

  private maybeNewToken(ev: PoolEvent): void {
    const k = ev.token.toLowerCase();
    if (this.seen.has(k)) return;
    if (ev.kind === "mint" && Number(ethers.formatEther(ev.wethSeed)) < cfg.feed.newTokenMinWethSeed) return;
    const now = Date.now();
    if (now - (this.cooldown.get(k) ?? 0) < cfg.feed.cooldownMin * 60_000) return;
    if (this.inflight.has(k)) return;
    this.inflight.add(k);
    this.seen.add(k); // mark immediately so we don't double-fire; persisted on next flush
    this.cooldown.set(k, now);
    void this.vetNewToken(ev, k).finally(() => this.inflight.delete(k));
  }

  private async vetNewToken(ev: PoolEvent, k: string): Promise<void> {
    try {
      const meta = await tokenMeta(ev.token).catch(() => null);
      const safe = await safetyCheck(ev.token, cfg.watch.maxTaxPct).catch(() => null);
      if (!safe || !safe.ok) {
        log.info(`new token ${meta?.symbol ?? k.slice(0, 8)} ditolak: ${safe?.reason ?? "cek gagal"}`);
        return;
      }
      let poolExists = false;
      try {
        poolExists = (await findPools(ev.token)).length > 0;
      } catch {
        /* ignore */
      }
      this.stats.newTokens++;
      this.persistSeen();
      this.hooks.onNewToken({
        token: ev.token,
        symbol: meta?.symbol ?? "?",
        fee: ev.fee,
        wethSeed: Number(ethers.formatEther(ev.wethSeed)),
        kind: ev.kind,
        safeReason: safe.reason,
        backPct: safe.backPct,
        poolExists,
      });
    } catch (e) {
      log.warn(`vet new token gagal: ${(e as Error).message}`);
    }
  }

  private async checkRange(k: string): Promise<void> {
    this.activity.set(k, 0);
    const now = Date.now();
    if (now - (this.lastRangeCheck.get(k) ?? 0) < RANGE_RECHECK_MS) return;
    if (this.inflight.has("range:" + k)) return;
    this.inflight.add("range:" + k);
    this.lastRangeCheck.set(k, now);
    try {
      const pos = this.positions.get(k);
      if (!pos) return;
      const pc = new ethers.Contract(pos.pool, POOL_ABI, provider);
      const tick = Number((await pc.slot0!()).tick);
      const inRange = tick >= pos.tickLower && tick < pos.tickUpper;
      const was = this.inRangeState.get(pos.tokenId);
      this.inRangeState.set(pos.tokenId, inRange);
      if (inRange || was === false) return; // still in range, or already alerted while out
      // transition in→out (or first observation while out)
      this.stats.rangeAlerts++;
      const side: "atas" | "bawah" = tick >= pos.tickUpper ? "atas" : "bawah";
      let autoClosed = false;
      let closeError: string | undefined;
      if (cfg.feed.autoCloseOutOfRange) {
        try {
          await closePosition(pos.tokenId);
          autoClosed = true;
        } catch (e) {
          closeError = (e as Error).message.slice(0, 100);
        }
      }
      this.hooks.onOutOfRange({
        tokenId: pos.tokenId,
        symbol: pos.tokenSym,
        side,
        tick,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        autoClosed,
        ...(closeError ? { closeError } : {}),
      });
    } catch (e) {
      log.debug(`range check ${k.slice(0, 8)} gagal: ${(e as Error).message}`);
    } finally {
      this.inflight.delete("range:" + k);
    }
  }

  private async refreshPositions(): Promise<void> {
    try {
      const rows = await listPositions();
      const next = new Map<string, PositionRow>();
      const toks = new Set<string>();
      for (const r of rows) {
        next.set(r.tokenAddr.toLowerCase(), r);
        if (!this.inRangeState.has(r.tokenId)) this.inRangeState.set(r.tokenId, r.inRange);
        toks.add(r.tokenAddr.toLowerCase().replace(/^0x/, ""));
      }
      this.positions = next;
      // v4 positions can't be cheaply slot0-checked here (no simple pool addr), but a swap touching
      // their token should still nudge automanage for the full TP/SL/OOR check — add their token addrs.
      try {
        const { listV4Positions } = await import("../chain/v4/list.js");
        for (const r of await listV4Positions()) toks.add(r.tokenAddr.toLowerCase().replace(/^0x/, ""));
      } catch {
        /* v4 list optional */
      }
      this.posTokens = toks;
    } catch (e) {
      log.warn(`refresh positions gagal: ${(e as Error).message}`);
    }
  }

  private persistSeen(): void {
    try {
      writeJson(SEEN_FILE, [...this.seen]);
    } catch {
      /* best effort */
    }
  }

  private async warmSeed(): Promise<void> {
    log.info("warm-seed seen-set dari Blockscout…");
    let next: Record<string, string> | null = null;
    for (let page = 0; page < 8 && this.seen.size < 800; page++) {
      const q = next ? "?" + new URLSearchParams(next).toString() : "?type=ERC-20";
      const r: any = await bsFetch<any>(`/api/v2/tokens${q}`, 15_000);
      for (const t of r?.items ?? []) {
        const a = (t.address_hash || t.address || "").toLowerCase();
        if (a) this.seen.add(a);
      }
      next = r?.next_page_params ?? null;
      if (!next) break;
    }
    this.persistSeen();
    log.info(`seen-set: ${this.seen.size} token`);
  }
}
