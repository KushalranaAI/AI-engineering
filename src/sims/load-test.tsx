import { useMemo, useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Readout, SimFrame, Slider, Toggle } from "./ui";
import { expSample, fmtNum, fmtSec, lognormalSample, mean, mulberry32, percentile } from "./lib";

/* ------------------------------------------------------------------ model
 * Closed-loop load test: C virtual users, each sends a request and sends the next as soon as it returns.
 * Each replica runs up to `maxBatch` requests at once (continuous batching). A decode step gets slightly slower as the
 * batch grows: itl(b) = 12 ms + 0.25 ms x b. Requests beyond replicas x maxBatch wait in a FIFO queue.
 *   in service per replica b = min(C / R, maxBatch),  queue Q = max(0, C - R x maxBatch)
 *   service time S = prefill(b) + outputTokens x itl(b)
 *   throughput X = R x b / mean(S)          (requests per second)
 *   mean queue wait W = Q / X               (Little's law)
 * Per-request latency = wait + S, with output lengths drawn from a log-normal and waits from an exponential around W,
 * which is an approximation, but it shows the shape every real load test shows: flat, then a knee, then a wall.
 * Autoscaling on queue depth: add replicas until queue per replica <= threshold (steady state; real scale-ups lag minutes).
 */

export interface LoadParams {
  maxBatch: number;
  replicas: number;
  maxReplicas: number;
  outMedian: number;
  prompt: number;
  autoscale: boolean;
  /** target queued requests per replica */
  threshold: number;
}

export const DEFAULT_LOAD: LoadParams = { maxBatch: 64, replicas: 2, maxReplicas: 12, outMedian: 200, prompt: 1000, autoscale: false, threshold: 16 };

const SIGMA = 0.7;
const SAMPLES = 1500;

export const itl = (b: number) => 0.012 + 0.00025 * b;
export const prefillTime = (prompt: number, b: number, maxBatch: number) => prompt * 0.00004 * (1 + b / maxBatch);

export function replicasFor(c: number, p: LoadParams): number {
  if (!p.autoscale) return p.replicas;
  return Math.min(p.maxReplicas, Math.max(p.replicas, Math.ceil(c / (p.maxBatch + p.threshold))));
}

export interface LoadPoint {
  c: number;
  replicas: number;
  inService: number;
  queue: number;
  rps: number;
  tokensPerSec: number;
  wait: number;
  itl: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  ttftP95: number;
}

export function loadPoint(c: number, p: LoadParams, seed = 42): LoadPoint {
  const R = replicasFor(c, p);
  const b = Math.min(c / R, p.maxBatch);
  const Q = Math.max(0, c - R * p.maxBatch);
  const meanOut = p.outMedian * Math.exp((SIGMA * SIGMA) / 2);
  const pre = prefillTime(p.prompt, b, p.maxBatch);
  const step = itl(b);
  const meanS = pre + meanOut * step;
  const X = (R * b) / meanS;
  const W = Q > 0 ? Q / X : 0;
  const rng = mulberry32(seed);
  const lat: number[] = [];
  const ttft: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const out = lognormalSample(rng, p.outMedian, SIGMA);
    const w = W > 0 ? expSample(rng, W) : 0;
    lat.push(w + pre + out * step);
    ttft.push(w + pre);
  }
  return {
    c,
    replicas: R,
    inService: b * R,
    queue: Q,
    rps: X,
    tokensPerSec: X * meanOut,
    wait: W,
    itl: step,
    mean: mean(lat),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    ttftP95: percentile(ttft, 95),
  };
}

export function sweep(p: LoadParams, maxC = 2000, n = 48): LoadPoint[] {
  const out: LoadPoint[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.round(Math.pow(maxC, i / (n - 1)));
    if (out.length && out[out.length - 1].c === c) continue;
    out.push(loadPoint(c, p));
  }
  return out;
}

/* ------------------------------------------------------------------ view */

const REAL = "A coffee shop at rush hour: up to the number of baristas every order is quick, past it the line out the door sets your wait, and the average hides the one customer who waited twenty minutes.";

function LoadTestSim() {
  const [c, setC] = useState(200);
  const [maxBatch, setMaxBatch] = useState(64);
  const [replicas, setReplicas] = useState(2);
  const [outMedian, setOut] = useState(200);
  const [autoscale, setAutoscale] = useState(false);
  const [threshold, setThreshold] = useState(16);
  const [slo, setSlo] = useState(20);

  const p: LoadParams = { ...DEFAULT_LOAD, maxBatch, replicas, outMedian, autoscale, threshold };
  const pts = useMemo(() => sweep({ ...DEFAULT_LOAD, maxBatch, replicas, outMedian, autoscale, threshold }), [maxBatch, replicas, outMedian, autoscale, threshold]);
  const cur = loadPoint(c, p);
  const sat = replicas * maxBatch;
  const okPts = pts.filter((x) => x.p95 <= slo);
  const maxOk = okPts.length ? okPts[okPts.length - 1].c : 0;
  const tailRatio = cur.p99 / cur.mean;

  const line = (k: keyof LoadPoint) => pts.map((x) => [x.c, x[k] as number] as [number, number]);

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Load">
            <Slider label="Concurrent users (inspect)" value={c} onChange={setC} min={1} max={2000} log format={(v) => fmtNum(v)} />
            <Slider label="p95 latency SLO" value={slo} onChange={setSlo} min={2} max={120} format={(v) => `${v} s`} />
          </Group>
          <Group title="Service">
            <Slider label="Replicas" value={replicas} onChange={setReplicas} min={1} max={8} />
            <Slider label="Max batch per replica" value={maxBatch} onChange={setMaxBatch} min={8} max={256} step={8} log />
            <Slider label="Output length (median)" value={outMedian} onChange={setOut} min={20} max={1000} step={10} log format={(v) => `${v} tok`} />
          </Group>
          <Group title="Autoscaling">
            <Toggle label="Autoscale on queue depth" checked={autoscale} onChange={setAutoscale} />
            <Slider label="Target queue per replica" value={threshold} onChange={setThreshold} min={0} max={128} disabled={!autoscale} format={(v) => `${v} req`} hint={`Adds replicas (up to ${DEFAULT_LOAD.maxReplicas}) while the queue exceeds this.`} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="p50 / p95 / p99" value={`${fmtSec(cur.p50)} / ${fmtSec(cur.p95)} / ${fmtSec(cur.p99)}`} tone={cur.p95 > slo ? "bad" : cur.queue > 0 ? "warm" : "good"} hint={`mean ${fmtSec(cur.mean)}, p99 is ${tailRatio.toFixed(1)}× the mean`} />
          <Readout label="Throughput" value={fmtNum(cur.tokensPerSec)} unit="tok/s" hint={`${cur.rps.toFixed(1)} req/s · ${fmtSec(cur.itl)} per token`} />
          <Readout label="Queue depth" value={fmtNum(cur.queue)} tone={cur.queue > 0 ? "warm" : "good"} hint={`p95 TTFT ${fmtSec(cur.ttftP95)}`} />
          <Readout label="Max users within SLO" value={maxOk ? `~${fmtNum(maxOk)}` : "none"} tone={maxOk >= c ? "good" : "bad"} hint={`${cur.replicas} replica${cur.replicas > 1 ? "s" : ""} at ${fmtNum(c)} users`} />
        </>
      }
      explain={
        <>
          <p>
            {replicas} replica{replicas > 1 ? "s" : ""} × {maxBatch} slots can serve {fmtNum(sat)} requests at once. At {fmtNum(c)} users{" "}
            {cur.queue > 0
              ? `${fmtNum(cur.queue)} are waiting in the queue, so latency is mostly waiting: the median request takes ${fmtSec(cur.p50)} and throughput has flattened at ${fmtNum(cur.tokensPerSec)} tok/s.`
              : `nobody queues; latency only creeps up because bigger batches make each decode step a little slower (${fmtSec(cur.itl)} per token).`}
          </p>
          <p>
            The mean ({fmtSec(cur.mean)}) hides the tail: 1 request in 100 takes over {fmtSec(cur.p99)}. {autoscale ? `Autoscaling on queue depth is running ${cur.replicas} replicas here, which pushes the knee to the right (in reality new replicas take minutes to load the model, so you scale early).` : `Past the knee, adding users only adds waiting. Turn on autoscaling or add replicas to move the knee.`}
          </p>
        </>
      }
    >
      <Chart
        ariaLabel="Latency percentiles versus concurrent users"
        xLog
        yLog
        xDomain={[1, 2000]}
        xLabel="Concurrent users (log)"
        yLabel="End-to-end latency (s, log)"
        xFormat={(v) => fmtNum(v)}
        yFormat={(v) => (v >= 1 ? `${fmtNum(v)}s` : `${fmtNum(v * 1000)}ms`)}
        series={[
          { name: "p50", color: "var(--good)", points: line("p50") },
          { name: "p95", color: "var(--warm)", points: line("p95") },
          { name: "p99", color: "var(--bad)", points: line("p99") },
          { name: "mean", color: "var(--muted)", points: line("mean"), dashed: true },
        ]}
        refs={[
          { y: slo, label: `SLO p95 ≤ ${slo}s`, color: "var(--accent)" },
          { x: c, label: `${fmtNum(c)} users`, color: "var(--text-2)" },
        ]}
        band={{ x0: autoscale ? 2000 : sat, x1: 2000, color: "var(--bad)", label: autoscale ? undefined : "queueing" }}
        dots={[{ x: c, y: cur.p95, color: "var(--warm)" }]}
      />
      <div className="sim-two">
        <Chart
          ariaLabel="Throughput versus concurrent users"
          height={220}
          xLog
          xDomain={[1, 2000]}
          xLabel="Concurrent users (log)"
          yLabel="Throughput (tok/s)"
          xFormat={(v) => fmtNum(v)}
          series={[{ name: "throughput", color: "var(--accent)", points: line("tokensPerSec"), area: true }]}
          refs={[{ x: c, color: "var(--text-2)" }]}
          legend={false}
        />
        <Chart
          ariaLabel="Queue depth and replicas versus concurrent users"
          height={220}
          xLog
          xDomain={[1, 2000]}
          xLabel="Concurrent users (log)"
          yLabel="Queued requests"
          xFormat={(v) => fmtNum(v)}
          series={[{ name: "queue depth", color: "var(--warm)", points: line("queue"), area: true }]}
          refs={[{ x: c, color: "var(--text-2)" }]}
          legend={false}
        />
      </div>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "load-test",
  title: "Load test: finding the knee",
  blurb: "Ramp concurrent users from 1 to 2,000 and watch p50, p95 and p99 latency, throughput and queue depth, with and without autoscaling.",
  levels: [10, 12],
  realLife: REAL,
  Component: LoadTestSim,
};
