/* Shared pure helpers for the simulators: a seeded RNG, statistics and number formatting. No React here. */

/** Mulberry32: a tiny, fast, seeded PRNG. Same seed -> same sequence, so every run is reproducible. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile with linear interpolation between closest ranks (the "type 7" method numpy uses by default). p in [0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Exponential sample with the given mean (inverse-CDF). */
export function expSample(rng: () => number, m: number): number {
  return -Math.log(1 - rng()) * m;
}

/** Standard normal sample (Box-Muller). */
export function normalSample(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-normal sample with the given median and log-space sigma: a long right tail, like real prompt/output lengths. */
export function lognormalSample(rng: () => number, median: number, sigma: number): number {
  return median * Math.exp(sigma * normalSample(rng));
}

/* ---------- formatting ---------- */

const GIB = 1024 ** 3;
export const GiB = GIB;

/** bytes -> "12.3 GiB" / "512 MiB" / "64 KiB" */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  const abs = Math.abs(bytes);
  if (abs >= GIB) return `${trim(bytes / GIB, abs >= 100 * GIB ? 0 : 1)} GiB`;
  if (abs >= 1024 ** 2) return `${trim(bytes / 1024 ** 2, 0)} MiB`;
  if (abs >= 1024) return `${trim(bytes / 1024, 0)} KiB`;
  return `${Math.round(bytes)} B`;
}

function trim(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.0+$/, "");
}

/** 1234 -> "1,234"; small numbers keep a few significant digits */
export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** SI suffixes: 3.2e12 -> "3.2 T" */
export function fmtSI(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "-";
  const abs = Math.abs(v);
  const units: [number, string][] = [
    [1e15, "P"],
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [n, u] of units) if (abs >= n) return `${trim(v / n, digits)} ${u}`;
  return trim(v, abs < 1 ? 2 : digits);
}

/** seconds -> "850 ms" / "2.4 s" / "3.1 min" */
export function fmtSec(s: number): string {
  if (!Number.isFinite(s)) return "-";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 120) return `${trim(s, s < 10 ? 2 : 1)} s`;
  return `${trim(s / 60, 1)} min`;
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (v === 0) return "$0";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function fmtPct(frac: number, digits = 0): string {
  if (!Number.isFinite(frac)) return "-";
  return `${(frac * 100).toFixed(digits)}%`;
}

/** 131072 -> "128k" (tokens) */
export function fmtTokens(t: number): string {
  if (t >= 1_000_000) return `${trim(t / 1_000_000, 2)}M`;
  if (t >= 1000) return `${trim(t / 1024 === Math.round(t / 1024) ? t / 1024 : t / 1000, 1)}k`;
  return `${Math.round(t)}`;
}
