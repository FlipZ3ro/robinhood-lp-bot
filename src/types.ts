/** Shared domain types. Kept framework-free so both chain/ and telegram/ can import them. */

export type MintMode = "single" | "inrange";

/** A pool discovered for a token (WETH-paired by default; USDG-paired when quote==="usd"). */
export interface PoolInfo {
  pool: string;
  fee: number;
  liquidity: bigint;
  token0: string;
  wethInPool: number; // proxy TVL for ranking (ETH units; 0 for USDG pools)
  quote?: "eth" | "usd"; // "usd" = token/USDG pair (no WETH leg); default "eth"
  usdgInPool?: number; // USDG-side balance for quote==="usd" (display + ranking)
}

/** Token metadata (cached). */
export interface TokenMeta {
  addr: string;
  symbol: string;
  decimals: number;
  supplyUi: number;
}

/** MCAP range preview shown on the confirm screen, before minting. */
export interface RangePreview {
  mode: MintMode;
  mcapNow: number;
  rangeMcapLow: number;
  rangeMcapHigh: number;
  tickLower: number;
  tickUpper: number;
  tick: number;
  swapPct: number;
}

/** Result of opening a position. */
export interface OpenResult {
  tokenId: string | null;
  txHash: string;
  wrapHash?: string;
  swapHash?: string;
  mode: MintMode;
  tickLower: number;
  tickUpper: number;
  tick: number;
  entryMcap: number;
  swappedPct?: number;
  depositEth: string;
  side: string;
  liquidity: string;
}

/** A live open position row for /list. */
export interface PositionRow {
  tokenId: string;
  pool: string;
  tokenAddr: string; // the non-WETH token address
  token0: string;
  token1: string;
  tokenSym: string;
  pair?: string; // display pair for non-WETH positions, e.g. "JACKET/USDG"
  quote?: "eth" | "usd"; // "usd" = valued against USDG (stable); default eth
  fee: number;
  inRange: boolean;
  tick: number;
  tickLower: number;
  tickUpper: number;
  valEth: number;
  feeEth: number;
  depEth: number | null;
  pnlEth: number | null;
  pnlPct: number | null;
  mcapNow: number;
  rangeMcapLow: number;
  rangeMcapHigh: number;
  entryMcap: number | null;
  openedAt: number | null;
  ageMs: number | null;
  ageSource: "bot" | "onchain" | null;
  mode: MintMode;
}

/** Result of closing a position. */
export interface CloseResult {
  heldMs: number | null;
  decreaseHash: string | null;
  collectHash: string;
  burnHash: string | null;
  swapHash: string | null;
  topUp: TopUp | null;
  wethSym: string;
  tokenSym: string;
  recvWeth: number;
  recvToken: number;
  swappedWeth: number;
  tokenStuck: number;
  valEth: number;
  depEth: number | null;
  pnlEth: number | null;
  pnlPct: number | null;
}

export interface TopUp {
  unwrapped: number;
  tx: string;
  nativeBefore: number;
  nativeAfter: number;
}

/** One closed-position record in the permanent ledger. */
export interface LedgerEntry {
  tokenId: string;
  sym: string;
  version?: "v2" | "v3" | "v4"; // absent = v3 (legacy entries)
  pair?: string; // v4/v2 non-ETH display, e.g. "WOLVES/USDG"
  quote?: "eth" | "usd"; // display denomination: "usd" for stable-paired pools (USDG); default eth
  mode: MintMode;
  openedAt: number | null;
  closedAt: number | null;
  heldMs: number | null;
  depEth: number;
  outEth: number;
  feeEth: number;
  pnlEth: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  ethUsdAtClose: number | null;
  entryMcap?: number | null;
  tokenKept: number;
  tokenRug: number;
  unsoldEth?: number;
  source?: "onchain" | "bot";
}

/** A token that passed every watch filter + safety check. */
export interface SpikeHit {
  addr: string;
  symbol: string;
  vol5m: number;
  vol1h: number;
  vol24h: number;
  liq: number;
  fdv: number;
  priceUsd: number;
  chg5m: number;
  chg1h: number;
  url: string;
  prevVol5m: number;
  safe: SafetyResult;
}

export interface SafetyResult {
  ok: boolean;
  backPct: number;
  taxPct: number;
  fee?: number;
  reason: string;
}
