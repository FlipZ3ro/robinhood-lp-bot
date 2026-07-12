/**
 * Blockscout REST helpers. Used for anything getLogs can't do on the free RPC tier:
 * lifetime PnL, wallet token holdings, ledger backfill, mint timestamps.
 */
const BASE = "https://robinhoodchain.blockscout.com";

export async function bsFetch<T = any>(pathq: string, timeoutMs = 20_000): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${pathq}`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const blockscout = BASE;

/** Bounded-concurrency map — keeps us from hammering the API with N parallel requests. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!, k);
      }
    }),
  );
  return out;
}
