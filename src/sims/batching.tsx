import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Shuffle } from "lucide-react";
import type { SimDef } from "./types";
import { Group, Legend, Readout, SimFrame, Slider, Toggle } from "./ui";
import { clamp, expSample, fmtNum, fmtSec, lognormalSample, mean, mulberry32, percentile } from "./lib";

/* ------------------------------------------------------------------ model
 * One GPU runs "iterations" (forward passes). An iteration's time follows a tiny roofline:
 *   duration = overhead + max(weightReadTime, tokensInIteration x computePerToken)
 * so a step with a handful of decode tokens costs the same as one with ~250 tokens (memory-bound),
 * while a big prefill makes the step long (compute-bound).
 * Static batching: take up to `slots` queued requests, prefill them together (padded to the longest prompt),
 *   then decode until the LONGEST output finishes; finished slots sit idle; new arrivals wait for the whole batch.
 * Continuous batching: every iteration, finished requests leave and queued ones join a free slot.
 *   Without chunked prefill a joining request's whole prompt runs in one iteration and stalls everyone's next token.
 *   With chunked prefill each iteration has a token budget: decode tokens first, then prompt chunks fill the rest.
 */

export interface Req {
  id: number;
  arrival: number;
  prompt: number;
  output: number;
}

export interface CostModel {
  overhead: number; // s per iteration
  weightRead: number; // s to stream the weights once
  perToken: number; // s of compute per token in the iteration
}

export const COST: CostModel = { overhead: 0.002, weightRead: 0.01, perToken: 0.000039 };

export function iterationTime(tokens: number, c: CostModel = COST): number {
  return c.overhead + Math.max(c.weightRead, tokens * c.perToken);
}

/** Seeded request stream: Poisson arrivals, log-normal prompt and output lengths. */
export function makeRequests(seed: number, n: number, ratePerSec: number): Req[] {
  const rng = mulberry32(seed);
  const out: Req[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += expSample(rng, 1 / ratePerSec);
    out.push({
      id: i,
      arrival: t,
      prompt: Math.round(clamp(lognormalSample(rng, 350, 0.9), 24, 3000)),
      output: Math.round(clamp(lognormalSample(rng, 110, 0.8), 6, 600)),
    });
  }
  return out;
}

export interface Span {
  req: number;
  slot: number;
  /** joined a slot */
  start: number;
  /** first token emitted (prefill done) */
  prefillEnd: number;
  end: number;
}

export interface BatchResult {
  spans: Span[];
  ttft: number[];
  /** gaps between consecutive output tokens, per token */
  itl: number[];
  makespan: number;
  tokens: number;
  throughput: number;
  utilization: number;
  meanTtft: number;
  p95Ttft: number;
  p95Itl: number;
  /** worst stall between two tokens of one stream */
  maxItl: number;
}

function finish(reqs: Req[], spans: Span[], ttft: number[], itl: number[], slots: number): BatchResult {
  const t0 = Math.min(...reqs.map((r) => r.arrival));
  const end = Math.max(...spans.map((s) => s.end));
  const makespan = end - t0;
  const tokens = reqs.reduce((a, r) => a + r.output, 0);
  const busy = spans.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    spans,
    ttft,
    itl,
    makespan,
    tokens,
    throughput: tokens / makespan,
    utilization: busy / (slots * makespan),
    meanTtft: mean(ttft),
    p95Ttft: percentile(ttft, 95),
    p95Itl: percentile(itl, 95),
    maxItl: itl.reduce((a, b) => Math.max(a, b), 0),
  };
}

export function simulateStatic(reqs: Req[], slots: number, c: CostModel = COST): BatchResult {
  const spans: Span[] = [];
  const ttft: number[] = [];
  const itl: number[] = [];
  const queue: Req[] = [];
  let i = 0;
  let t = 0;
  let done = 0;
  while (done < reqs.length) {
    while (i < reqs.length && reqs[i].arrival <= t) queue.push(reqs[i++]);
    if (queue.length === 0) {
      t = reqs[i].arrival;
      continue;
    }
    const batch = queue.splice(0, slots);
    const start = t;
    const maxPrompt = Math.max(...batch.map((r) => r.prompt));
    t += iterationTime(maxPrompt * batch.length, c); // padded prefill
    const prefillEnd = t;
    const step = iterationTime(batch.length, c); // padded decode: every slot computes until the longest is done
    const maxOut = Math.max(...batch.map((r) => r.output));
    batch.forEach((r, k) => {
      ttft.push(prefillEnd - r.arrival);
      for (let j = 1; j < r.output; j++) itl.push(step);
      spans.push({ req: r.id, slot: k, start, prefillEnd, end: prefillEnd + (r.output - 1) * step });
    });
    t = prefillEnd + (maxOut - 1) * step;
    done += batch.length;
  }
  return finish(reqs, spans, ttft, itl, slots);
}

interface Active {
  r: Req;
  start: number;
  prefillLeft: number;
  outLeft: number;
  prefillEnd: number;
}

export function simulateContinuous(reqs: Req[], slots: number, chunked: boolean, chunkBudget = 256, c: CostModel = COST): BatchResult {
  const spans: Span[] = [];
  const ttft: number[] = [];
  const itl: number[] = [];
  const queue: Req[] = [];
  const slot: (Active | null)[] = Array(slots).fill(null);
  let i = 0;
  let t = 0;
  let done = 0;
  let guard = 0;
  while (done < reqs.length && guard++ < 1_000_000) {
    while (i < reqs.length && reqs[i].arrival <= t) queue.push(reqs[i++]);
    for (let s = 0; s < slots; s++) if (!slot[s] && queue.length) {
      const r = queue.shift()!;
      slot[s] = { r, start: t, prefillLeft: r.prompt, outLeft: r.output, prefillEnd: NaN };
    }
    const active = slot.map((a, s) => [a, s] as const).filter((x): x is readonly [Active, number] => x[0] !== null);
    if (active.length === 0) {
      t = reqs[i].arrival;
      continue;
    }
    const decoders = active.filter(([a]) => a.prefillLeft === 0);
    const prefilling = active.filter(([a]) => a.prefillLeft > 0).sort((a, b) => a[0].start - b[0].start);
    let tokens = decoders.length;
    const take = new Map<Active, number>();
    let budget = chunked ? Math.max(0, chunkBudget - tokens) : Infinity;
    for (const [a] of prefilling) {
      const n = Math.min(a.prefillLeft, budget);
      take.set(a, n);
      budget -= n;
      tokens += n;
    }
    const dur = iterationTime(tokens, c);
    t += dur;
    for (const [a, s] of decoders) {
      a.outLeft--;
      itl.push(dur);
      if (a.outLeft === 0) {
        spans.push({ req: a.r.id, slot: s, start: a.start, prefillEnd: a.prefillEnd, end: t });
        slot[s] = null;
        done++;
      }
    }
    for (const [a, s] of prefilling) {
      a.prefillLeft -= take.get(a) ?? 0;
      if (a.prefillLeft === 0) {
        a.prefillEnd = t;
        ttft.push(t - a.r.arrival);
        a.outLeft--; // the prefill pass emits the first token
        if (a.outLeft === 0) {
          spans.push({ req: a.r.id, slot: s, start: a.start, prefillEnd: t, end: t });
          slot[s] = null;
          done++;
        }
      }
    }
  }
  return finish(reqs, spans, ttft, itl, slots);
}

/* ------------------------------------------------------------------ view */

const REAL = "An airport shuttle: the static one waits for a full load and only returns when the last passenger is dropped off, the continuous one picks people up and drops them off at every stop along the loop.";

const COLORS = ["var(--ph-retrieval)", "var(--ph-agentic)", "var(--ph-trust)", "var(--ph-production)", "var(--ph-frontier)", "var(--ai)"];
const PLAY_MS = 7000;

function Timeline({ title, res, reqs, slots, horizon, progress }: { title: string; res: BatchResult; reqs: Req[]; slots: number; horizon: number; progress: number }) {
  const W = 600;
  const L = 42;
  const R = 8;
  const rowH = Math.max(9, Math.min(16, 150 / slots));
  const top = 18;
  const H = top + slots * rowH + 22;
  const x = (t: number) => L + (t / horizon) * (W - L - R);
  const clipW = Math.max(0, x(progress * horizon) - L);
  const id = title.replace(/\W/g, "");
  const ticks: number[] = [];
  const stepT = horizon > 40 ? 10 : horizon > 16 ? 5 : 2;
  for (let s = 0; s <= horizon; s += stepT) ticks.push(s);
  const now = progress * horizon;
  const busyNow = res.spans.filter((s) => s.start <= now && s.end > now).length;
  return (
    <figure className="sim-tl">
      <figcaption>
        <b>{title}</b>
        <span className="sim-mono muted">
          {progress < 1 ? `t = ${now.toFixed(1)} s · ${busyNow}/${slots} slots busy` : `${fmtNum(res.throughput)} tok/s · ${Math.round(res.utilization * 100)}% slot use`}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} timeline: ${slots} GPU slots over ${horizon.toFixed(0)} seconds`}>
        <defs>
          <clipPath id={`clip-${id}`}>
            <rect x={L} y={0} width={clipW} height={H} />
          </clipPath>
        </defs>
        {Array.from({ length: slots }, (_, s) => (
          <g key={s}>
            <rect x={L} y={top + s * rowH + 1} width={W - L - R} height={rowH - 2} rx={2} className="sim-tl-lane" />
            {(slots <= 8 || s % 2 === 0) && (
              <text x={L - 6} y={top + s * rowH + rowH / 2} dy="0.32em" textAnchor="end" className="sim-chart-tick">
                slot {s + 1}
              </text>
            )}
          </g>
        ))}
        <g clipPath={`url(#clip-${id})`}>
          {reqs.map((r) => (
            <path key={`a${r.id}`} d={`M${x(r.arrival)},${top - 3} l-3,-6 h6 z`} className="sim-tl-arrival" />
          ))}
          {res.spans.map((s) => {
            const c = COLORS[s.req % COLORS.length];
            const y = top + s.slot * rowH + 1;
            const h = rowH - 2;
            return (
              <g key={s.req}>
                <rect x={x(s.start)} y={y} width={Math.max(0.8, x(s.prefillEnd) - x(s.start))} height={h} fill={c} rx={1.5}>
                  <title>{`request ${s.req + 1}: prefill ${fmtSec(s.prefillEnd - s.start)}`}</title>
                </rect>
                <rect x={x(s.prefillEnd)} y={y + h * 0.18} width={Math.max(0.8, x(s.end) - x(s.prefillEnd))} height={h * 0.64} fill={c} opacity={0.5} rx={1.5}>
                  <title>{`request ${s.req + 1}: decode ${fmtSec(s.end - s.prefillEnd)}`}</title>
                </rect>
              </g>
            );
          })}
        </g>
        {progress < 1 && <line x1={x(now)} x2={x(now)} y1={top - 10} y2={top + slots * rowH} className="sim-tl-playhead" />}
        {ticks.map((s) => (
          <text key={s} x={x(s)} y={H - 6} textAnchor="middle" className="sim-chart-tick">
            {s}s
          </text>
        ))}
      </svg>
    </figure>
  );
}

function BatchingSim() {
  const [seed, setSeed] = useState(7);
  const [rate, setRate] = useState(3);
  const [slots, setSlots] = useState(8);
  const [chunked, setChunked] = useState(true);
  const [chunk, setChunk] = useState(256);
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  const progressRef = useRef(1);

  const reqs = useMemo(() => makeRequests(seed, 40, rate), [seed, rate]);
  const st = useMemo(() => simulateStatic(reqs, slots), [reqs, slots]);
  const ct = useMemo(() => simulateContinuous(reqs, slots, chunked, chunk), [reqs, slots, chunked, chunk]);
  const horizon = Math.max(...st.spans.map((s) => s.end), ...ct.spans.map((s) => s.end));

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let p = progressRef.current >= 1 ? 0 : progressRef.current;
    const tick = (now: number) => {
      p = Math.min(1, p + (now - last) / PLAY_MS);
      last = now;
      progressRef.current = p;
      setProgress(p);
      if (p >= 1) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const play = () => {
    if (!playing && progress >= 1) {
      progressRef.current = 0;
      setProgress(0);
    }
    setPlaying(!playing);
  };
  const gain = ct.throughput / st.throughput;

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Traffic (seeded)">
            <Slider label="Arrival rate" value={rate} onChange={setRate} min={0.5} max={10} step={0.5} format={(v) => `${v} req/s`} />
            <button type="button" className="btn small" onClick={() => setSeed((s) => s + 1)}>
              <Shuffle size={14} aria-hidden /> New request stream (seed {seed})
            </button>
          </Group>
          <Group title="Server">
            <Slider label="GPU slots (max batch)" value={slots} onChange={setSlots} min={2} max={16} format={(v) => `${v}`} />
            <Toggle label="Chunked prefill (continuous)" checked={chunked} onChange={setChunked} />
            <Slider label="Token budget per step" value={chunk} onChange={setChunk} min={64} max={2048} step={64} log disabled={!chunked} format={(v) => `${v} tok`} hint="Prefill chunks fill what decode tokens leave of this budget." />
          </Group>
        </>
      }
      toolbar={
        <>
          <button type="button" className="btn small primary" onClick={play} aria-label={playing ? "Pause animation" : "Play animation"}>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} {playing ? "Pause" : progress >= 1 ? "Replay" : "Play"}
          </button>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              setPlaying(false);
              progressRef.current = 1;
              setProgress(1);
            }}
          >
            <RotateCcw size={14} aria-hidden /> Show all
          </button>
          <Legend
            items={[
              { label: "prefill (first token)", color: "var(--ph-retrieval)" },
              { label: "decode", color: "color-mix(in srgb, var(--ph-retrieval) 50%, transparent)" },
              { label: "arrival ▾", color: "var(--muted)" },
            ]}
          />
        </>
      }
      readouts={
        <>
          <Readout label="Throughput" value={`${fmtNum(st.throughput)} → ${fmtNum(ct.throughput)}`} unit="tok/s" tone={gain > 1.2 ? "good" : "neutral"} hint={`static → continuous (${gain.toFixed(1)}×)`} />
          <Readout label="Mean TTFT" value={`${fmtSec(st.meanTtft)} → ${fmtSec(ct.meanTtft)}`} tone={ct.meanTtft < st.meanTtft ? "good" : "warm"} />
          <Readout label="p95 TTFT" value={`${fmtSec(st.p95Ttft)} → ${fmtSec(ct.p95Ttft)}`} tone={ct.p95Ttft < st.p95Ttft ? "good" : "warm"} />
          <Readout label="Slot utilization" value={`${Math.round(st.utilization * 100)}% → ${Math.round(ct.utilization * 100)}%`} hint={`worst gap between tokens (continuous): ${fmtSec(ct.maxItl)}`} />
        </>
      }
      explain={
        <>
          <p>
            Static batching finishes the 40 requests in {fmtSec(st.makespan)}; continuous batching in {fmtSec(ct.makespan)}, a <b>{gain.toFixed(1)}×</b> throughput difference. In the top lane, slots go pale-then-empty as short answers finish while the batch waits for its longest one, and new arrivals queue
            behind it, which is why p95 time-to-first-token is {fmtSec(st.p95Ttft)}.
          </p>
          <p>
            In the bottom lane a slot is refilled the moment it frees up, so p95 TTFT drops to {fmtSec(ct.p95Ttft)}.{" "}
            {chunked
              ? `Chunked prefill splits long prompts into pieces of the ${chunk}-token step budget, so other users' tokens keep flowing (worst gap between tokens ${fmtSec(ct.maxItl)}).`
              : `Without chunked prefill a long prompt runs in one big step and stalls everyone else's next token (worst gap between tokens ${fmtSec(ct.maxItl)}). Turn it on to compare.`}
          </p>
        </>
      }
    >
      <Timeline title="Static batching" res={st} reqs={reqs} slots={slots} horizon={horizon} progress={progress} />
      <Timeline title={`Continuous batching${chunked ? " + chunked prefill" : ""}`} res={ct} reqs={reqs} slots={slots} horizon={horizon} progress={progress} />
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "batching",
  title: "Static vs continuous batching",
  blurb: "Watch the same request stream on a GPU with static batching, continuous batching and chunked prefill, and compare throughput and time-to-first-token.",
  levels: [12],
  realLife: REAL,
  Component: BatchingSim,
};
