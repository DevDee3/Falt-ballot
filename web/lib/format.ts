import { formatUnits, type Address } from "viem";

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmtToken(v: bigint, decimals: number, maxFrac = 2): string {
  const s = formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function fmtDate(unix: number): string {
  // Use the same locale/timezone during SSR and in the browser. Without this,
  // server UTC and the user's local timezone can produce different HTML.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(unix * 1000));
}

export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const explorerAddr = (base: string, a: Address) => `${base}/address/${a}`;
export const explorerTx = (base: string, h: string) => `${base}/tx/${h}`;

/** "1 vote" / "3 votes" */
export const plural = (n: number | bigint, one: string, many = `${one}s`) => `${n} ${BigInt(n) === 1n ? one : many}`;
