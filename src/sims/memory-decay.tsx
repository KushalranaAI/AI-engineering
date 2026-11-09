import { useMemo, useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Note, Readout, SimFrame, Slider, Toggle } from "./ui";
import { fmtNum } from "./lib";

/* ------------------------------------------------------------------ model
 * Forgetting curve in half-life form:  retention = 0.5 ^ (age / halfLife)
 * (the same shape as Ebbinghaus's R = e^(-t/S) with S = halfLife / ln 2).
 * Reinforcement: each time the memory is recalled and used, its age resets to 0 and its half-life is multiplied
 * (capped). The keep-score is retention x importance; below the threshold the memory is archived.
 */

export interface Params {
  halfLife: number; // days
  importance: number; // 0-1
  threshold: number; // keep-score below which the memory is archived
  days: number;
  reinforce: boolean;
  /** days between recalls when reinforcement is on */
  every: number;
  growth: number;
  cap: number;
}

export const DEFAULTS: Params = { halfLife: 30, importance: 0.6, threshold: 0.05, days: 180, reinforce: false, every: 20, growth: 1.5, cap: 365 };

export const retention = (ageDays: number, halfLifeDays: number): number => Math.pow(0.5, ageDays / halfLifeDays);

export interface Point {
  day: number;
  retention: number;
  score: number;
  halfLife: number;
}

/** day-by-day trajectory of one memory */
export function trajectory(p: Params): Point[] {
  const out: Point[] = [];
  let h = p.halfLife;
  let lastUsed = 0;
  for (let d = 0; d <= p.days; d++) {
    if (p.reinforce && d > 0 && d % p.every === 0) {
      const alive = retention(d - lastUsed, h) * p.importance >= p.threshold; // an archived memory cannot be recalled
      if (alive) {
        lastUsed = d;
        h = Math.min(h * p.growth, p.cap);
      }
    }
    const r = retention(d - lastUsed, h);
    out.push({ day: d, retention: r, score: r * p.importance, halfLife: h });
  }
  return out;
}

/** first day the keep-score drops below the threshold, or null if it never does within the window */
export function firstArchiveDay(points: Point[], threshold: number): number | null {
  const hit = points.find((x) => x.score < threshold);
  return hit ? hit.day : null;
}

/** with no reinforcement: days until retention x importance < threshold */
export function daysToThreshold(halfLife: number, importance: number, threshold: number): number {
  if (importance <= threshold) return 0;
  return halfLife * Math.log2(importance / threshold);
}

/* ------------------------------------------------------------------ view */

const REAL = "A fridge with expiry dates: milk lasts days, pickle lasts a year, what you keep using gets restocked, and the clear-out bins what has faded.";

function MemoryDecaySim() {
  const [p, setP] = useState<Params>(DEFAULTS);
  const set = <K extends keyof Params>(k: K, v: Params[K]) => setP((x) => ({ ...x, [k]: v }));
  const pts = useMemo(() => trajectory(p), [p]);
  const plain = useMemo(() => trajectory({ ...p, reinforce: false }), [p]);
  const archive = firstArchiveDay(pts, p.threshold);
  const plainArchive = firstArchiveDay(plain, p.threshold);
  const end = pts[pts.length - 1];
  const sample = (d: number) => retention(d, p.halfLife);

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="The memory">
            <Slider label="Half-life" value={p.halfLife} onChange={(v) => set("halfLife", v)} min={1} max={365} log format={(v) => `${v} days`} hint="Days for the score to halve." />
            <Slider label="Importance" value={p.importance} onChange={(v) => set("importance", v)} min={0.05} max={1} step={0.05} format={(v) => v.toFixed(2)} />
          </Group>
          <Group title="Reinforcement">
            <Toggle label="Recalled and used from time to time" checked={p.reinforce} onChange={(v) => set("reinforce", v)} hint="Each use resets the age and lengthens the half-life." />
            <Slider label="Recalled every" value={p.every} onChange={(v) => set("every", v)} min={3} max={90} format={(v) => `${v} days`} disabled={!p.reinforce} />
          </Group>
          <Group title="Pruning">
            <Slider label="Archive below" value={p.threshold} onChange={(v) => set("threshold", v)} min={0.01} max={0.3} step={0.01} format={(v) => v.toFixed(2)} hint="Keep-score = retention x importance." />
            <Slider label="Days shown" value={p.days} onChange={(v) => set("days", v)} min={30} max={365} step={5} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Retention after 1 half-life" value={sample(p.halfLife).toFixed(2)} hint="Always 0.5" />
          <Readout label="After 3 half-lives" value={sample(3 * p.halfLife).toFixed(3)} hint="0.5 x 0.5 x 0.5" />
          <Readout label="Archived on day" value={archive === null ? "never" : `${archive}`} tone={archive === null ? "good" : "warm"} hint={p.reinforce ? `without reinforcement: ${plainArchive === null ? "never" : "day " + plainArchive}` : "within the days shown"} />
          <Readout label={`Keep-score on day ${p.days}`} value={end.score.toFixed(3)} tone={end.score >= p.threshold ? "good" : "bad"} hint={`half-life now ${fmtNum(end.halfLife)} days`} />
        </>
      }
      explain={
        <>
          <p>
            A memory with half-life {p.halfLife} days and importance {p.importance.toFixed(2)} scores {(p.importance * 0.5).toFixed(2)} after {p.halfLife} days, {(p.importance * 0.25).toFixed(2)} after {2 * p.halfLife}, and falls below the {p.threshold.toFixed(2)} threshold after about {fmtNum(daysToThreshold(p.halfLife, p.importance, p.threshold))} days if it is never used.
          </p>
          <p>
            {p.reinforce
              ? `With a recall every ${p.every} days the half-life grows each time, so the score ${archive === null ? "stays above the threshold for the whole period" : "still eventually falls below the threshold on day " + archive + " (the recall interval is too long to keep it alive)"}.`
              : "Turn on reinforcement to see a memory that keeps being useful survive while an identical unused one fades."}
          </p>
        </>
      }
    >
      <Chart
        ariaLabel="Memory keep-score over time with and without reinforcement"
        xLabel="Days since written"
        yLabel="Keep-score"
        yDomain={[0, 1]}
        xDomain={[0, p.days]}
        xFormat={(v) => fmtNum(v)}
        yFormat={(v) => v.toFixed(2)}
        series={[
          { name: "Never used", color: "var(--bad)", dashed: p.reinforce, points: plain.map((x) => [x.day, x.score] as [number, number]) },
          ...(p.reinforce ? [{ name: "Reinforced", color: "var(--good)", points: pts.map((x) => [x.day, x.score] as [number, number]), area: true }] : []),
        ]}
        refs={[{ y: p.threshold, label: "archive below", color: "var(--warm)" }]}
      />
      <Note>The curve shape comes from human memory experiments. It is a tunable shape for deciding what to keep, not a law of nature for language models.</Note>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "memory-decay",
  title: "Forgetting curve and memory decay",
  blurb: "Move the half-life and importance, switch reinforcement on, and see when a memory crosses the pruning threshold.",
  levels: [6],
  realLife: REAL,
  Component: MemoryDecaySim,
};
