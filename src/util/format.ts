/** Pure display formatters shared across chain + telegram layers. */

/** Compact market cap: $1.2M / $340k / $12. */
export function fmtMcap(v: number | null | undefined): string {
  if (!v) return "?";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  return "$" + v.toFixed(0);
}

/** Duration ms → "2h 14m" / "3d 5h" / "42m". */
export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !(ms >= 0)) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}d ${hh}h`;
}
