/**
 * Auto-manage open positions: take-profit / stop-loss / out-of-range → auto-close. Covers BOTH v3
 * and v4. Opt-in and OFF by default (tpPct=slPct=0, closeOor=false) — nothing closes until the
 * operator sets a trigger, and the whole loop only runs while /auto is ON.
 *
 * ⚠️ Closes SPEND REAL FUNDS on the shared wallet — every close is guarded by the same staticCall
 * the manual close uses, and a `closing` set prevents double-firing before /list catches up.
 */
import { cfg } from "../config.js";
import { listPositions, closePosition } from "../chain/positions.js";
import { ethUsd } from "../chain/price.js";
import { acquireWallet, releaseWallet } from "../chain/txlock.js";
import { recordOor, inOorCooldown } from "./oorcool.js";
import { dexPairs } from "../chain/dexscreener.js";
import { logger } from "../util/log.js";

const log = logger("automanage");

export type CloseReason = "TP" | "SL" | "OOR" | "VFADE";
export interface AutoCloseInfo {
  tokenId: string;
  sym: string;
  version: "v3" | "v4";
  reason: CloseReason;
  pnlPct: number | null;
  pnlEth: number | null;
}
export interface RebalanceInfo {
  oldTokenId: string;
  newTokenId: string | null;
  sym: string;
}
export interface CompoundInfo {
  tokenId: string;
  sym: string;
  feeUsd: number;
}
export interface ManageHooks {
  onAutoClose: (info: AutoCloseInfo) => void;
  onRebalance?: (info: RebalanceInfo) => void; // #1 OOR → recentered re-open
  onCompound?: (info: CompoundInfo) => void; // #3 fees folded back into a position
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ManageHooks | null = null;
const closing = new Set<string>(); // tokenIds mid-close (dedupe across ticks)
const compounding = new Set<string>(); // tokenIds mid-compound (dedupe across ticks)
const oorSince = new Map<string, number>(); // tokenId → first-seen-OOR ts (grace timer)
const stats = { runs: 0, closed: 0, rebalanced: 0, compounded: 0, nudges: 0, lastAt: 0 };
let tickRunning = false; // a manage tick is in-flight (timer + feed nudge must not overlap)
let lastTickAt = 0; // ts of the last tick START (debounce feed nudges)
// A busy-pool position gets HAMMERED with swaps (SESTRI/GME $60k vol) → the feed nudged the manage
// loop every ~4s, running listV4Positions non-stop → RPC + Blockscout got rate-limited and /list hung.
// 30s still reacts ~3× faster than the 90s poll but stops the hammering. Tune via RH_NUDGE_MS.
const NUDGE_MIN_MS = Number(process.env.RH_NUDGE_MS) || 30_000;

/** Any manage action armed? (loop is a no-op otherwise, even when /auto is ON.) */
function armed(): boolean {
  const a = cfg.autoLp;
  return a.tpPct > 0 || a.slPct > 0 || a.closeOor || a.compound || a.volFadeX > 0;
}

export function startManage(h?: ManageHooks): void {
  if (h) hooks = h;
  if (timer || !hooks) return;
  void tick();
  timer = setInterval(() => void tick(), (cfg.autoLp.manageSec || 90) * 1000);
  log.info(`manage ON — tiap ${cfg.autoLp.manageSec}s`);
}
export function stopManage(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
export function isManageOn(): boolean {
  return timer !== null;
}
export function manageStatus(): { on: boolean } & typeof stats {
  return { on: isManageOn(), ...stats };
}

async function tick(): Promise<void> {
  if (!cfg.autoLp.enabled || !armed() || tickRunning) return;
  tickRunning = true;
  lastTickAt = Date.now();
  try {
    await runManage();
  } catch (e) {
    log.warn(`manage gagal: ${(e as Error).message.slice(0, 90)}`);
  } finally {
    tickRunning = false;
  }
}

/**
 * External trigger to run the TP/SL/OOR check NOW instead of waiting for the next `manageSec` poll —
 * called by the sequencer feed when a swap touches one of our position tokens (sub-second reaction vs
 * up to 90s). Debounced (≤ once / NUDGE_MIN_MS) and skips if a tick is already running, so a burst of
 * feed events can't hammer the RPC. The interval timer stays as the reliable backstop for anything the
 * feed's partial decode misses. No-op unless /auto is ON and a trigger is armed.
 */
export function nudge(reason = "feed"): void {
  if (!cfg.autoLp.enabled || !armed() || tickRunning) return;
  if (Date.now() - lastTickAt < NUDGE_MIN_MS) return;
  stats.nudges++;
  log.info(`manage nudge (${reason}) → cek TP/SL/OOR`);
  void tick();
}

interface Item {
  tokenId: string;
  sym: string;
  version: "v3" | "v4";
  pnlPct: number | null;
  pnlEth: number | null;
  inRange: boolean;
  tokenAddr: string; // volatile side — for OOR-cooldown blacklisting
  ageMs: number | null; // on-chain position age — restart-proof OOR grace basis
  feeUsd?: number | null; // uncollected fees ($) — compound threshold (v4 only)
  poolId?: string; // v4 poolId — for the #3 volume-fade DexScreener match
}

/** #3 volume-fade: a v4 pool's current-hour vs 24h-average-hour volume (spikeX). 1 = neutral/no data. */
async function poolSpikeX(tokenAddr: string, poolId: string): Promise<number> {
  const m = await dexPairs(tokenAddr, Date.now()).catch(() => null);
  const d = m?.get(poolId.toLowerCase());
  if (!d || d.vol24h <= 0) return 1; // no data → never trigger a fade close
  return d.volH1 / (d.vol24h / 24);
}

async function runManage(): Promise<void> {
  const a = cfg.autoLp;
  const now = Date.now();
  stats.runs++;
  stats.lastAt = now;
  const px = await ethUsd().catch(() => 0);

  const items: Item[] = [];
  const v3 = await listPositions().catch(() => []);
  for (const p of v3) items.push({ tokenId: p.tokenId, sym: p.tokenSym, version: "v3", pnlPct: p.pnlPct, pnlEth: p.pnlEth, inRange: p.inRange, tokenAddr: p.tokenAddr, ageMs: (p as { ageMs?: number | null }).ageMs ?? null });
  try {
    const { listV4Positions } = await import("../chain/v4/list.js");
    const v4 = await listV4Positions().catch(() => []);
    for (const r of v4) {
      const valEth = px > 0 ? r.valueUsd / px : null;
      const pnlEth = r.depEth != null && valEth != null ? valEth - r.depEth : null;
      const pnlPct = r.depEth && pnlEth != null ? (pnlEth / r.depEth) * 100 : null;
      items.push({ tokenId: r.tokenId, sym: r.sym, version: "v4", pnlPct, pnlEth, inRange: r.inRange, tokenAddr: r.tokenAddr, ageMs: r.ageMs, feeUsd: r.feeUsd, poolId: r.poolId });
    }
  } catch {
    /* v4 list optional */
  }

  const graceMs = (a.oorGraceMin || 0) * 60_000;
  for (const it of items) {
    if (it.inRange) oorSince.delete(it.tokenId); // back in range → reset the OOR grace timer
    if (closing.has(it.tokenId)) continue;
    let reason: CloseReason | null = null;
    if (a.tpPct > 0 && it.pnlPct != null && it.pnlPct >= a.tpPct) reason = "TP";
    else if (a.slPct > 0 && it.pnlPct != null && it.pnlPct <= -a.slPct) reason = "SL";
    else if (a.closeOor && !it.inRange) {
      // Close after `oorGraceMin` OUT of range. The grace timer is in-memory, so on the FIRST sighting
      // BACKDATE it by the position's on-chain age: a single-side park is OOR from birth (age == time
      // OOR), so this makes the grace survive a bot RESTART (which would otherwise reset the clock to 0
      // every redeploy → 30-min-old parks never closing). inRange resets it (top of loop).
      if (!oorSince.has(it.tokenId)) oorSince.set(it.tokenId, it.ageMs != null ? now - it.ageMs : now);
      if (now - (oorSince.get(it.tokenId) ?? now) >= graceMs) reason = "OOR";
    } else if (a.volFadeX > 0 && it.version === "v4" && it.inRange && it.poolId && it.ageMs != null && it.ageMs > (a.vfadeMinAgeMin || 20) * 60_000) {
      // #3 volume-fade: the spike is over (current hour < volFadeX × the 24h-avg hour) → rotate out.
      // Age-guarded (>vfadeMinAgeMin) so a fresh open gets time to earn fees before a momentary volume
      // dip can close it — otherwise, when the entry spike sits near volFadeX, it fade-exits instantly.
      if ((await poolSpikeX(it.tokenAddr, it.poolId)) < a.volFadeX) reason = "VFADE";
    }
    if (!reason) continue;
    closing.add(it.tokenId);
    void doClose(it, reason);
  }

  // #3 fee-compound: fold accrued fees back into IN-RANGE v4 positions once they clear the threshold.
  // Separate pass so it never competes with a close decision — a position being TP/SL/OOR-closed this
  // tick is already in `closing` and skipped here. The threshold self-rate-limits: after a compound the
  // uncollected fees reset ~0, so it won't re-fire until they rebuild past compoundMinUsd again.
  if (a.compound) {
    for (const it of items) {
      if (it.version !== "v4" || !it.inRange) continue;
      if (closing.has(it.tokenId) || compounding.has(it.tokenId)) continue;
      if ((it.feeUsd ?? 0) < a.compoundMinUsd) continue;
      compounding.add(it.tokenId);
      void doCompound(it);
    }
  }
}

async function doClose(it: Item, reason: CloseReason): Promise<void> {
  // Serialize on the shared wallet: if an open (or another close) is mid-flight, skip and retry next
  // tick — concurrent multi-tx sequences collide on nonce.
  if (!acquireWallet()) {
    closing.delete(it.tokenId);
    return;
  }
  const a = cfg.autoLp;
  try {
    log.info(`AUTO-CLOSE ${it.version} #${it.tokenId} ${it.sym} — ${reason} (pnl ${it.pnlPct?.toFixed(1) ?? "?"}%)`);
    if (it.version === "v3") {
      await closePosition(it.tokenId);
    } else {
      const { closeV4Position } = await import("../chain/v4/close.js");
      await closeV4Position(it.tokenId, reason);
    }
    stats.closed++;
    if (reason === "OOR") recordOor(it.tokenAddr); // #2: streak toward blacklisting a token that never fills
    hooks?.onAutoClose({ tokenId: it.tokenId, sym: it.sym, version: it.version, reason, pnlPct: it.pnlPct, pnlEth: it.pnlEth });
    // keep it in `closing` a while so a stale /list (before Blockscout updates) can't re-fire it
    setTimeout(() => closing.delete(it.tokenId), 300_000);

    // #1 rebalance-on-OOR: instead of leaving the freed capital idle in ETH, re-center the SAME token
    // on the current price (close → re-open recentered). Only v4, only when NOT already in OOR-cooldown
    // (that #2 counter — bumped by recordOor above — caps the rebalance churn on a token that keeps
    // drifting). reopenRecentered no-ops (returns null) if the token no longer qualifies or funds fall
    // short. Runs while the wallet lock is STILL held → the close+reopen is atomic (no nonce race).
    if (reason === "OOR" && a.oorAction === "rebalance" && it.version === "v4" && !inOorCooldown(it.tokenAddr)) {
      try {
        const { reopenRecentered } = await import("./autolp.js");
        const r = await reopenRecentered(it.tokenAddr, it.sym);
        if (r) {
          stats.rebalanced++;
          hooks?.onRebalance?.({ oldTokenId: it.tokenId, newTokenId: r.tokenId, sym: it.sym });
        }
      } catch (e) {
        log.warn(`rebalance #${it.tokenId} gagal: ${(e as Error).message.slice(0, 90)}`);
      }
    }
  } catch (e) {
    log.warn(`auto-close #${it.tokenId} gagal: ${(e as Error).message.slice(0, 90)}`);
    closing.delete(it.tokenId); // let the next tick retry
  } finally {
    releaseWallet();
  }
}

async function doCompound(it: Item): Promise<void> {
  // Serialize on the shared wallet (collect + approve + increase is a multi-tx sequence).
  if (!acquireWallet()) {
    compounding.delete(it.tokenId);
    return;
  }
  try {
    const { compoundV4Position } = await import("../chain/v4/close.js");
    const r = await compoundV4Position(it.tokenId);
    if (r.compounded) {
      stats.compounded++;
      log.info(`AUTO-COMPOUND v4 #${it.tokenId} ${it.sym} — fee $${(it.feeUsd ?? 0).toFixed(2)} → liq`);
      hooks?.onCompound?.({ tokenId: it.tokenId, sym: it.sym, feeUsd: it.feeUsd ?? 0 });
    } else {
      log.info(`compound v4 #${it.tokenId} skip: ${r.reason ?? "?"}`);
    }
  } catch (e) {
    log.warn(`compound #${it.tokenId} gagal: ${(e as Error).message.slice(0, 90)}`);
  } finally {
    // brief hold so a still-high feeUsd (list lag before fees reset) can't double-fire the compound
    setTimeout(() => compounding.delete(it.tokenId), 120_000);
    releaseWallet();
  }
}

