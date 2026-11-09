import { useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Legend, Readout, Segmented, Select, SimFrame, Slider, StackBar } from "./ui";
import { fmtBytes, fmtNum, fmtTokens, GiB } from "./lib";

/* ------------------------------------------------------------------ model
 * Every layer stores a Key and a Value vector per KV head per token:
 *   KV bytes = 2 (K and V) x layers x kv_heads x head_dim x bytes_per_value x tokens x batch
 * With grouped-query attention (GQA) several query heads share one KV head, which divides the cache.
 */

export interface ModelPreset {
  id: string;
  label: string;
  params: number;
  layers: number;
  kvHeads: number;
  headDim: number;
}

export const MODELS: ModelPreset[] = [
  { id: "8b", label: "8B, GQA (Llama-3-8B-like, approx.)", params: 8e9, layers: 32, kvHeads: 8, headDim: 128 },
  { id: "7b-mha", label: "7B, no GQA (Llama-2-7B-like, approx.)", params: 7e9, layers: 32, kvHeads: 32, headDim: 128 },
  { id: "70b", label: "70B, GQA (Llama-3-70B-like, approx.)", params: 70e9, layers: 80, kvHeads: 8, headDim: 128 },
];

export const GPU_MEM = [
  { id: "24", label: "1 x 24 GB (L4)", gib: 24 },
  { id: "48", label: "1 x 48 GB (L40S)", gib: 48 },
  { id: "80", label: "1 x 80 GB (A100 / H100)", gib: 80 },
  { id: "141", label: "1 x 141 GB (H200)", gib: 141 },
  { id: "160", label: "2 x 80 GB", gib: 160 },
  { id: "640", label: "8 x 80 GB", gib: 640 },
];

export function kvBytesPerToken(m: Pick<ModelPreset, "layers" | "kvHeads" | "headDim">, bytesPerValue: number): number {
  return 2 * m.layers * m.kvHeads * m.headDim * bytesPerValue;
}

export function kvCacheBytes(m: Pick<ModelPreset, "layers" | "kvHeads" | "headDim">, bytesPerValue: number, tokens: number, batch: number): number {
  return kvBytesPerToken(m, bytesPerValue) * tokens * batch;
}

/** How many requests of `tokens` context fit in what is left after the weights. `usable` mirrors vLLM's gpu_memory_utilization. */
export function maxConcurrent(gpuBytes: number, weightBytes: number, perRequestKv: number, usable = 0.9): number {
  const free = gpuBytes * usable - weightBytes;
  if (free <= 0 || perRequestKv <= 0) return 0;
  return Math.floor(free / perRequestKv);
}

/* ------------------------------------------------------------------ view */

const REAL = "A coat check: the building (GPU) is fixed, the staff (weights) take a fixed corner, and every guest's coat (KV cache) grows with how long they stay, so long visits mean fewer guests at once.";

function KvCacheSim() {
  const [modelId, setModelId] = useState("8b");
  const [ctx, setCtx] = useState(8192);
  const [batch, setBatch] = useState(16);
  const [kvB, setKvB] = useState(2);
  const [wB, setWB] = useState(2);
  const [gpuId, setGpuId] = useState("80");
  const m = MODELS.find((x) => x.id === modelId)!;
  const gpu = GPU_MEM.find((g) => g.id === gpuId)!;

  const gpuBytes = gpu.gib * GiB;
  const usable = 0.9;
  const weights = m.params * wB;
  const perTok = kvBytesPerToken(m, kvB);
  const perReq = perTok * ctx;
  const kv = perReq * batch;
  const runtime = gpuBytes * (1 - usable);
  const free = gpuBytes - runtime - weights - kv;
  const fits = maxConcurrent(gpuBytes, weights, perReq, usable);
  const over = free < 0;
  const weightsDontFit = weights > gpuBytes * usable;

  const curve: [number, number][] = [];
  for (let e = 9; e <= 17.01; e += 0.25) {
    const t = Math.pow(2, e);
    curve.push([t, Math.max(0.5, maxConcurrent(gpuBytes, weights, perTok * t, usable))]);
  }
  const curveFp8: [number, number][] = curve.map(([t]) => [t, Math.max(0.5, maxConcurrent(gpuBytes, weights, kvBytesPerToken(m, kvB === 2 ? 1 : 2) * t, usable))]);

  const avail = gpuBytes - runtime;
  const wIn = Math.min(weights, avail);
  const kvIn = Math.min(kv, Math.max(0, avail - wIn));
  const overflow = weights - wIn + (kv - kvIn);
  const total = gpuBytes + overflow;
  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Model">
            <Select label="Architecture" value={modelId} onChange={setModelId} options={MODELS.map((x) => ({ value: x.id, label: x.label }))} hint={`${m.layers} layers · ${m.kvHeads} KV heads · head dim ${m.headDim}`} />
            <Segmented
              label="Weights dtype"
              value={wB}
              onChange={setWB}
              options={[
                { value: 2, label: "FP16" },
                { value: 1, label: "FP8" },
                { value: 0.5, label: "INT4" },
              ]}
            />
            <Segmented
              label="KV-cache dtype"
              value={kvB}
              onChange={setKvB}
              options={[
                { value: 2, label: "FP16" },
                { value: 1, label: "FP8" },
              ]}
            />
          </Group>
          <Group title="Traffic">
            <Slider label="Context per request" value={ctx} onChange={setCtx} min={512} max={131072} step={512} log format={(v) => `${fmtTokens(v)} tokens`} />
            <Slider label="Concurrent requests" value={batch} onChange={setBatch} min={1} max={256} log format={(v) => `${v}`} />
          </Group>
          <Group title="Hardware">
            <Select label="GPU memory" value={gpuId} onChange={setGpuId} options={GPU_MEM.map((g) => ({ value: g.id, label: g.label }))} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="KV per token" value={fmtBytes(perTok)} hint={`2 × ${m.layers} × ${m.kvHeads} × ${m.headDim} × ${kvB} B`} />
          <Readout label="KV per request" value={fmtBytes(perReq)} hint={`at ${fmtTokens(ctx)} tokens`} />
          <Readout label="KV for the batch" value={fmtBytes(kv)} tone={over ? "bad" : "neutral"} />
          <Readout label="Requests that fit" value={weightsDontFit ? "0" : fmtNum(fits)} tone={weightsDontFit || fits < batch ? "bad" : fits < batch * 1.5 ? "warm" : "good"} hint={weightsDontFit ? "weights alone don't fit" : `at ${fmtTokens(ctx)} each`} />
        </>
      }
      explain={
        <>
          <p>
            Each token of context costs <b>{fmtBytes(perTok)}</b> of KV cache for this model, so one {fmtTokens(ctx)}-token request holds <b>{fmtBytes(perReq)}</b>. {batch} of them need {fmtBytes(kv)} on top of {fmtBytes(weights)} of weights.
          </p>
          <p>
            {weightsDontFit
              ? `The weights alone exceed the ${fmtNum(gpu.gib)} GB budget: shard across more GPUs or quantize them.`
              : over
                ? `That is ${fmtBytes(-free)} more than the GPU has, so a server would queue or preempt requests. At this context only ${fits} fit at once.`
                : `It fits with ${fmtBytes(free)} spare; up to ${fmtNum(fits)} requests of this length could run concurrently.`}{" "}
            {m.kvHeads < 32 ? `GQA already shrinks the cache ${32 / m.kvHeads}× versus one KV head per query head.` : "This model has no GQA, so its cache is 4× larger than a GQA model of similar size."} {kvB === 2 ? "An FP8 KV cache would halve it again." : "FP8 KV has halved it versus FP16."}
          </p>
        </>
      }
    >
      <div className="sim-kv-bar">
        <div className="sim-row-between">
          <span className="sim-field-label">GPU memory ({fmtNum(gpu.gib)} GB)</span>
          <span className={`sim-mono ${over ? "bad" : "muted"}`}>{over ? `over by ${fmtBytes(-free)}` : `${fmtBytes(free)} free`}</span>
        </div>
        <StackBar
          ariaLabel="GPU memory split"
          total={total}
          height={36}
          segments={[
            { label: "Weights", value: wIn, color: "var(--accent)" },
            { label: "KV cache", value: kvIn, color: "var(--warm)" },
            { label: "Free", value: Math.max(0, free), color: "var(--panel-3)" },
            { label: "Runtime / activations reserve", value: runtime, color: "var(--faint)", striped: true },
            { label: "Overflow", value: overflow, color: "var(--bad)", striped: true },
          ]}
        />
        <Legend
          items={[
            { label: `Weights ${fmtBytes(weights)}`, color: "var(--accent)" },
            { label: `KV ${fmtBytes(kv)}`, color: "var(--warm)" },
            { label: `Reserve ${Math.round((1 - usable) * 100)}%`, color: "var(--faint)", striped: true },
            { label: "Free", color: "var(--panel-3)" },
            ...(over ? [{ label: "Over budget", color: "var(--bad)", striped: true }] : []),
          ]}
        />
      </div>
      <Chart
        ariaLabel="Maximum concurrent requests versus context length"
        xLog
        yLog
        xDomain={[512, 131072]}
        yDomain={[0.5, 10000]}
        xLabel="Context per request (tokens, log)"
        yLabel="Requests that fit (log)"
        xFormat={(v) => fmtTokens(v)}
        yFormat={(v) => (v < 1 ? "0" : fmtNum(v))}
        series={[
          { name: `KV ${kvB === 2 ? "FP16" : "FP8"} (current)`, color: "var(--accent)", points: curve, width: 2.6 },
          { name: `KV ${kvB === 2 ? "FP8" : "FP16"}`, color: "var(--muted)", points: curveFp8, dashed: true },
        ]}
        refs={[{ y: batch, label: `your ${batch} requests`, color: "var(--warm)" }]}
        dots={[{ x: ctx, y: Math.max(0.5, fits), color: fits >= batch ? "var(--good)" : "var(--bad)", label: `${fits}`, anchor: "above" }]}
      />
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "kv-cache",
  title: "KV-cache memory",
  blurb: "Work out how much GPU memory each request's KV cache takes and how many long-context requests actually fit.",
  levels: [12],
  realLife: REAL,
  Component: KvCacheSim,
};
