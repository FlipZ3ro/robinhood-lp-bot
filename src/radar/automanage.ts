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
import { recordOor } from "./oorcool.js";
import { logger } from "../util/log.js";

const log = logger("automanage");

export type CloseReason = "TP" | "SL" | "OOR";
export interface AutoCloseInfo {
  tokenId: string;
  sym: string;
  version: "v3" | "v4";
  reason: CloseReason;
  pnlPct: number | null;
  pnlEth: number | null;
}
export interface ManageHooks {
  onAutoClose: (info: AutoCloseInfo) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let hooks: ManageHooks | null = null;
const closing = new Set<string>(); // tokenIds mid-close (dedupe across ticks)
const oorSince = new Map<string, number>(); // tokenId → first-seen-OOR ts (grace timer)
const stats = { runs: 0, closed: 0, lastAt: 0 };

/** Any auto-close trigger armed? (loop is a no-op otherwise, even when /auto is ON.) */
function armed(): boolean {
  const a = cfg.autoLp;
  return a.tpPct > 0 || a.slPct > 0 || a.closeOor;
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
  if (!cfg.autoLp.enabled || !armed()) return;
  try {
    await runManage();
  } catch (e) {
    log.warn(`manage gagal: ${(e as Error).message.slice(0, 90)}`);
  }
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
      items.push({ tokenId: r.tokenId, sym: r.sym, version: "v4", pnlPct, pnlEth, inRange: r.inRange, tokenAddr: r.tokenAddr, ageMs: r.ageMs });
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
    }
    if (!reason) continue;
    closing.add(it.tokenId);
    void doClose(it, reason);
  }
}

async function doClose(it: Item, reason: CloseReason): Promise<void> {
  // Serialize on the shared wallet: if an open (or another close) is mid-flight, skip and retry next
  // tick — concurrent multi-tx sequences collide on nonce.
  if (!acquireWallet()) {
    closing.delete(it.tokenId);
    return;
  }
  try {
    log.info(`AUTO-CLOSE ${it.version} #${it.tokenId} ${it.sym} — ${reason} (pnl ${it.pnlPct?.toFixed(1) ?? "?"}%)`);
    if (it.version === "v3") {
      await closePosition(it.tokenId);
    } else {
      const { closeV4Position } = await import("../chain/v4/close.js");
      await closeV4Position(it.tokenId);
    }
    stats.closed++;
    if (reason === "OOR") recordOor(it.tokenAddr); // #2: streak toward blacklisting a token that never fills
    hooks?.onAutoClose({ tokenId: it.tokenId, sym: it.sym, version: it.version, reason, pnlPct: it.pnlPct, pnlEth: it.pnlEth });
    // keep it in `closing` a while so a stale /list (before Blockscout updates) can't re-fire it
    setTimeout(() => closing.delete(it.tokenId), 300_000);
  } catch (e) {
    log.warn(`auto-close #${it.tokenId} gagal: ${(e as Error).message.slice(0, 90)}`);
    closing.delete(it.tokenId); // let the next tick retry
  } finally {
    releaseWallet();
  }
}

