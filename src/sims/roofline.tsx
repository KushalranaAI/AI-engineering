import { useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Readout, Segmented, Select, SimFrame, Slider } from "./ui";
import { fmtNum, fmtSec, fmtSI } from "./lib";

/* ------------------------------------------------------------------ model
 * Roofline: attainable FLOP/s = min(peak FLOP/s, memory bandwidth x arithmetic intensity).
 * Arithmetic intensity (AI) = FLOPs done / bytes moved from memory.
 * For a dense transformer forward pass, FLOPs ~= 2 x params per token. Each forward step has to stream
 * every weight from HBM once, so bytes ~= params x bytes-per-param (we ignore KV-cache and activation
 * traffic, which only push decode further into the memory-bound region).
 *  - prefill: B sequences x T prompt tokens in one pass -> AI ~= 2 x B x T / bytesPerParam
 *  - decode:  B sequences x 1 new token per pass          -> AI ~= 2 x B / bytesPerParam
 */

export interface Gpu {
  id: string;
  label: string;
  /** dense BF16 tensor FLOP/s */
  peak: number;
  /** HBM bandwidth, bytes/s */
  bw: number;
}

export const GPUS: Gpu[] = [
  { id: "l4", label: "L4 (approx. 121 TFLOPS, 0.3 TB/s)", peak: 121e12, bw: 0.3e12 },
  { id: "a100", label: "A100 80GB (approx. 312 TFLOPS, 2.0 TB/s)", peak: 312e12, bw: 2.0e12 },
  { id: "h100", label: "H100 SXM (approx. 990 TFLOPS, 3.35 TB/s)", peak: 990e12, bw: 3.35e12 },
  { id: "mi300x", label: "MI300X (approx. 1300 TFLOPS, 5.3 TB/s)", peak: 1300e12, bw: 5.3e12 },
];

/** FLOP/byte where the roof turns flat: below it you are memory-bound, above it compute-bound. */
export function ridgePoint(peak: number, bw: number): number {
  return peak / bw;
}

export function attainable(peak: number, bw: number, intensity: number): number {
  return Math.min(peak, bw * intensity);
}

export function prefillIntensity(batch: number, tokens: number, bytesPerParam: number): number {
  return (2 * batch * tokens) / bytesPerParam;
}

export function decodeIntensity(batch: number, bytesPerParam: number): number {
  return (2 * batch) / bytesPerParam;
}

/** Lower bound on one forward step: whichever of "move the weights" or "do the math" takes longer. */
export function stepTime(params: number, bytesPerParam: number, tokensInStep: number, gpu: Pick<Gpu, "peak" | "bw">): number {
  const memT = (params * bytesPerParam) / gpu.bw;
  const compT = (2 * params * tokensInStep) / gpu.peak;
  return Math.max(memT, compT);
}

/** Upper bound on decode speed: tokens/s per sequence and for the whole batch. */
export function decodeTokensPerSec(params: number, bytesPerParam: number, batch: number, gpu: Pick<Gpu, "peak" | "bw">) {
  const t = stepTime(params, bytesPerParam, batch, gpu);
  return { perSeq: 1 / t, total: batch / t };
}

/* ------------------------------------------------------------------ view */

const REAL = "A delivery van: driving one parcel or forty across town takes the same trip, so if you only carry one (decode at batch 1) the road, not the van's capacity, sets your speed.";

function RooflineSim() {
  const [gpuId, setGpuId] = useState("h100");
  const [paramsB, setParamsB] = useState(8);
  const [bpp, setBpp] = useState(2);
  const [batch, setBatch] = useState(1);
  const [tokens, setTokens] = useState(1024);
  const gpu = GPUS.find((g) => g.id === gpuId)!;
  const P = paramsB * 1e9;

  const ridge = ridgePoint(gpu.peak, gpu.bw);
  const aiPre = prefillIntensity(batch, tokens, bpp);
  const aiDec = decodeIntensity(batch, bpp);
  const perfPre = attainable(gpu.peak, gpu.bw, aiPre);
  const perfDec = attainable(gpu.peak, gpu.bw, aiDec);
  const dec = decodeTokensPerSec(P, bpp, batch, gpu);
  const prefillT = stepTime(P, bpp, batch * tokens, gpu);
  const decUtil = perfDec / gpu.peak;
  const batchToRidge = Math.ceil((ridge * bpp) / 2);

  const xs = [0.1, 1e5];
  const roof: [number, number][] = [];
  for (let e = -1; e <= 5; e += 0.05) {
    const x = Math.pow(10, e);
    roof.push([x, attainable(gpu.peak, gpu.bw, x)]);
  }

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Hardware">
            <Select label="GPU (approx. specs)" value={gpuId} onChange={setGpuId} options={GPUS.map((g) => ({ value: g.id, label: g.label }))} />
          </Group>
          <Group title="Model">
            <Slider label="Parameters" value={paramsB} onChange={setParamsB} min={1} max={405} step={1} log format={(v) => `${v}B`} />
            <Segmented
              label="Weight precision"
              value={bpp}
              onChange={setBpp}
              options={[
                { value: 2, label: "BF16" },
                { value: 1, label: "FP8" },
                { value: 0.5, label: "INT4" },
              ]}
            />
          </Group>
          <Group title="Workload">
            <Slider label="Batch size" value={batch} onChange={setBatch} min={1} max={512} log format={(v) => `${v} seq`} />
            <Slider label="Prompt length (prefill)" value={tokens} onChange={setTokens} min={16} max={32768} step={16} log format={(v) => `${fmtNum(v)} tok`} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Ridge point" value={fmtNum(ridge)} unit="FLOP/byte" hint="intensity needed to use all the compute" />
          <Readout label="Decode tok/s (upper bound)" value={fmtNum(dec.perSeq)} unit="per seq" tone={decUtil < 0.2 ? "warm" : "good"} hint={`${fmtNum(dec.total)} tok/s across the batch`} />
          <Readout label="Decode uses" value={`${(decUtil * 100).toFixed(decUtil < 0.1 ? 1 : 0)}%`} unit="of peak" tone={decUtil < 0.2 ? "bad" : decUtil < 0.7 ? "warm" : "good"} />
          <Readout label="Prefill time (lower bound)" value={fmtSec(prefillT)} tone={aiPre >= ridge ? "good" : "warm"} hint={aiPre >= ridge ? "compute-bound" : "memory-bound"} />
        </>
      }
      explain={
        <>
          <p>
            The {gpu.label.split(" (")[0]} turns compute-bound at <b>{fmtNum(ridge)} FLOP/byte</b>. Prefilling {fmtNum(tokens)} tokens × {batch} sequence{batch > 1 ? "s" : ""} does about <b>{fmtSI(aiPre, 0)} FLOP per byte</b> of weights read, so it is {aiPre >= ridge ? "compute-bound: the tensor cores are the limit" : "still memory-bound"}.
          </p>
          <p>
            Decode makes one token per sequence per step, so it only reaches <b>{fmtNum(aiDec, 1)} FLOP/byte</b> and uses {(decUtil * 100).toFixed(1)}% of the chip's math. The ceiling is bandwidth ÷ weight bytes ≈ <b>{fmtNum(dec.perSeq)} tok/s</b> per sequence for a {paramsB}B model.
            {aiDec < ridge ? ` You would need a batch of about ${fmtNum(batchToRidge)} to reach the ridge, which is why servers batch decode and why smaller weights (FP8, INT4) speed it up.` : " At this batch decode is compute-bound too, so adding more sequences no longer comes for free."}
          </p>
        </>
      }
    >
      <Chart
        ariaLabel={`Roofline chart for ${gpu.label}`}
        xLog
        yLog
        xDomain={[xs[0], xs[1]]}
        yDomain={[1e10, 1e16]}
        xLabel="Arithmetic intensity (FLOP / byte, log)"
        yLabel="Attainable FLOP/s (log)"
        series={[{ name: "Roofline: min(peak, bandwidth × intensity)", color: "var(--accent)", points: roof, width: 2.6, area: true }]}
        refs={[{ x: ridge, label: `ridge ${fmtNum(ridge)}`, color: "var(--muted)" }]}
        dots={[
          { x: Math.min(aiPre, 1e5), y: perfPre, color: "var(--good)", label: "prefill", anchor: aiPre > 1e4 ? "left" : "right" },
          { x: Math.max(aiDec, 0.1), y: perfDec, color: "var(--warm)", label: "decode", anchor: "right" },
        ]}
        legend={false}
      />
      <p className="sim-note">
        Left of the ridge the slope is the memory bandwidth ({(gpu.bw / 1e12).toFixed(2)} TB/s); right of it the flat roof is peak compute ({fmtSI(gpu.peak, 0)}FLOP/s dense). Specs are approximate. KV-cache reads are ignored, which makes real decode even more memory-bound.
      </p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "roofline",
  title: "Roofline: prefill vs decode",
  blurb: "See why prefill saturates the GPU's math while decode waits on memory bandwidth, and how batching moves the dot.",
  levels: [12],
  realLife: REAL,
  Component: RooflineSim,
};
