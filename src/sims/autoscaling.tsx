import { useMemo, useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Note, Readout, Segmented, SimFrame, Slider } from "./ui";
import { fmtNum } from "./lib";

/* ------------------------------------------------------------------ model
 * A Kubernetes HorizontalPodAutoscaler reacting to traffic, one step per minute.
 *   desired = ceil( current x metric / target )                       (the HPA formula)
 * Newly created pods take `startup` minutes to become ready. Scale-up applies at once (limited to doubling per minute);
 * scale-down uses the highest recommendation of the last `window` minutes and removes at most one pod per minute.
 * Each ready pod serves `capacity` concurrent users well. Latency grows as utilisation approaches 100%.
 * CPU is modelled as low for an app that mostly waits on a model API: 20% of pod utilisation.
 */

export type Metric = "inflight" | "cpu";
export type Shape = "ramp" | "spike" | "daily";

export interface Params {
  shape: Shape;
  peak: number; // peak concurrent users
  capacity: number; // users one ready pod handles comfortably
  metric: Metric;
  target: number; // in-flight per pod, or CPU fraction (0-1)
  min: number;
  max: number;
  startup: number; // minutes until a new pod is ready
  window: number; // scale-down stabilisation, minutes
  slo: number; // latency budget, in multiples of the unloaded latency
  minutes: number;
}

export const DEFAULTS: Params = { shape: "spike", peak: 240, capacity: 15, metric: "inflight", target: 12, min: 3, max: 25, startup: 2, window: 5, slo: 6, minutes: 60 };

export function users(shape: Shape, t: number, peak: number, minutes: number): number {
  const base = peak * 0.1;
  if (shape === "ramp") return base + (peak - base) * Math.min(1, t / (minutes * 0.6));
  if (shape === "spike") return t >= minutes * 0.25 && t < minutes * 0.6 ? peak : base;
  // daily: a smooth hump
  return base + (peak - base) * Math.max(0, Math.sin((Math.PI * t) / minutes)) ** 2;
}

export interface Step {
  t: number;
  users: number;
  replicas: number;
  ready: number;
  desired: number;
  util: number;
  /** p95-style latency as a multiple of the unloaded latency */
  latency: number;
}

const latencyFactor = (util: number) => (util >= 0.97 ? 30 : 1 / (1 - util));

export function simulate(p: Params): Step[] {
  const out: Step[] = [];
  const created: number[] = []; // creation minute of every pod
  for (let i = 0; i < p.min; i++) created.push(-p.startup); // the minimum starts ready
  const recs: number[] = [];
  for (let t = 0; t <= p.minutes; t++) {
    const u = users(p.shape, t, p.peak, p.minutes);
    const ready = created.filter((c) => t - c >= p.startup).length;
    const current = Math.max(1, ready);
    const util = u / (current * p.capacity);
    const metric = p.metric === "inflight" ? u / current : 0.2 * Math.min(1.5, util);
    const desired = Math.min(p.max, Math.max(p.min, Math.ceil((current * metric) / p.target)));
    recs.push(desired);
    const total = created.length;
    if (desired > total) {
      const add = Math.min(desired - total, Math.max(1, total)); // at most doubling per minute
      for (let i = 0; i < add; i++) created.push(t);
    } else {
      const stable = Math.max(...recs.slice(-Math.max(1, p.window)));
      if (stable < total) created.splice(0, 1); // remove the oldest pod, one per minute
    }
    out.push({ t, users: u, replicas: created.length, ready, desired, util, latency: latencyFactor(util) });
  }
  return out;
}

export const minutesOverSlo = (steps: Step[], slo: number) => steps.filter((s) => s.latency > slo).length;
export const podMinutes = (steps: Step[]) => steps.reduce((n, s) => n + s.replicas, 0);

/* ------------------------------------------------------------------ view */

const REAL = "Extra snack counters before a cinema interval: open more as the queue grows, close them slowly, and remember new staff take a few minutes to start.";

function AutoscalingSim() {
  const [p, setP] = useState<Params>(DEFAULTS);
  const set = <K extends keyof Params>(k: K, v: Params[K]) => setP((x) => ({ ...x, [k]: v }));
  const steps = useMemo(() => simulate(p), [p]);
  const over = minutesOverSlo(steps, p.slo);
  const peakPods = Math.max(...steps.map((s) => s.replicas));
  const worst = Math.max(...steps.map((s) => s.latency));
  const pm = podMinutes(steps);
  const cpuMode = p.metric === "cpu";

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Traffic">
            <Segmented label="Shape" value={p.shape} onChange={(v) => set("shape", v)} options={[{ value: "ramp", label: "Ramp" }, { value: "spike", label: "Spike" }, { value: "daily", label: "Daily" }]} />
            <Slider label="Peak concurrent users" value={p.peak} onChange={(v) => set("peak", v)} min={50} max={600} step={10} />
            <Slider label="One pod handles" value={p.capacity} onChange={(v) => set("capacity", v)} min={5} max={40} format={(v) => `${v} users`} hint="From your load test (10.10)." />
          </Group>
          <Group title="HPA">
            <Segmented label="Scale on" value={p.metric} onChange={(v) => { set("metric", v); set("target", v === "cpu" ? 0.6 : 12); }} options={[{ value: "inflight", label: "In-flight / pod" }, { value: "cpu", label: "CPU" }]} />
            {cpuMode ? (
              <Slider label="CPU target" value={p.target} onChange={(v) => set("target", v)} min={0.2} max={0.9} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
            ) : (
              <Slider label="In-flight target per pod" value={p.target} onChange={(v) => set("target", v)} min={4} max={20} />
            )}
            <Slider label="Min replicas" value={p.min} onChange={(v) => set("min", Math.min(v, p.max))} min={1} max={10} />
            <Slider label="Max replicas" value={p.max} onChange={(v) => set("max", Math.max(v, p.min))} min={3} max={40} />
            <Slider label="Pod start-up time" value={p.startup} onChange={(v) => set("startup", v)} min={0} max={8} format={(v) => `${v} min`} hint="Node, image pull and app load." />
            <Slider label="Scale-down window" value={p.window} onChange={(v) => set("window", v)} min={1} max={15} format={(v) => `${v} min`} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Peak replicas" value={peakPods} tone={peakPods >= p.max ? "warm" : "neutral"} hint={peakPods >= p.max ? "hit the maximum" : `max is ${p.max}`} />
          <Readout label="Worst latency" value={worst >= 30 ? "overloaded" : `${worst.toFixed(1)}x`} tone={worst > p.slo ? "bad" : "good"} hint="vs. unloaded" />
          <Readout label={`Minutes over ${p.slo}x budget`} value={over} unit="min" tone={over === 0 ? "good" : over > 5 ? "bad" : "warm"} />
          <Readout label="Cost (pod-minutes)" value={fmtNum(pm)} hint="replicas summed over the hour" />
        </>
      }
      explain={
        <>
          <p>
            The HPA sets replicas to ceil(current x metric / target). {cpuMode ? "Here the service mostly waits on a model API, so CPU stays low even when pods are saturated: the controller sees little reason to scale, and latency suffers." : `With a target of ${p.target} in-flight requests per pod it tracks the real limit, and replicas rise as soon as concurrency does.`}
          </p>
          <p>
            New pods need {p.startup} minute{p.startup === 1 ? "" : "s"} to become ready, so latency bumps before capacity arrives ({over} minute{over === 1 ? "" : "s"} over budget). Scale-down is deliberately slower (one pod per minute after a {p.window}-minute window) so the line does not reform.
          </p>
        </>
      }
    >
      <Chart
        ariaLabel="Concurrent users and replica counts over time"
        height={220}
        xLabel="Minutes"
        yLabel="Users / pods"
        xDomain={[0, p.minutes]}
        series={[
          { name: "Concurrent users (÷10)", color: "var(--text-2)", dashed: true, points: steps.map((s) => [s.t, s.users / 10] as [number, number]) },
          { name: "Replicas", color: "var(--accent)", points: steps.map((s) => [s.t, s.replicas] as [number, number]) },
          { name: "Ready pods", color: "var(--good)", points: steps.map((s) => [s.t, s.ready] as [number, number]) },
        ]}
      />
      <Chart
        ariaLabel="Latency as a multiple of unloaded latency over time"
        height={200}
        xLabel="Minutes"
        yLabel="Latency (x unloaded)"
        xDomain={[0, p.minutes]}
        yDomain={[1, 12]}
        yFormat={(v) => `${v.toFixed(0)}x`}
        series={[{ name: "latency", color: "var(--warm)", points: steps.map((s) => [s.t, Math.min(12, s.latency)] as [number, number]), area: true }]}
        refs={[{ y: p.slo, label: "budget", color: "var(--bad)" }]}
        legend={false}
      />
      <Note>Switch "Scale on" to CPU and replay the spike: replicas hardly move while latency is capped at 12x on the chart. Then raise start-up time to 6 minutes and see why headroom matters.</Note>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "autoscaling",
  title: "Horizontal Pod Autoscaling",
  blurb: "Replay a traffic ramp, spike or daily curve against an HPA, and see how the metric, start-up time and scale-down window change latency and cost.",
  levels: [10],
  realLife: REAL,
  Component: AutoscalingSim,
};
