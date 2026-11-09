import { useState } from "react";
import { motion } from "motion/react";
import type { SimDef } from "./types";
import { Group, Readout, Select, SimFrame, Slider } from "./ui";
import { fmtBytes, fmtNum, GiB } from "./lib";

/* ------------------------------------------------------------------ model
 * Weights memory = params x bits / 8 (+ per-group scales for 4-bit: group 128 with an FP16 scale and zero point
 * adds ~0.25 bit per weight, so "4-bit" is really ~4.25 bits).
 * Decode at small batch is memory-bound: step time ~= weight bytes / bandwidth, so the ideal speedup is the byte ratio.
 * At large batch the step becomes compute-bound: step time ~= 2 x params x batch / peak for the math format used.
 * Weight-only INT4 (AWQ, GPTQ) still does its math in FP16 after dequantizing, so it gains nothing once compute-bound.
 */

export type QuantId = "fp16" | "fp8" | "int8" | "awq" | "gptq";

export interface QuantFormat {
  id: QuantId;
  label: string;
  bits: number;
  /** which tensor-core rate the matmuls run at */
  math: "bf16" | "fp8" | "int8";
  quality: string;
  qualityTone: "good" | "warm" | "bad";
  note: string;
}

export const FORMATS: QuantFormat[] = [
  { id: "fp16", label: "FP16 / BF16", bits: 16, math: "bf16", quality: "baseline", qualityTone: "good", note: "The reference. Everything else is compared to this." },
  { id: "fp8", label: "FP8 (W8A8)", bits: 8, math: "fp8", quality: "≈ no loss (< 0.5 pt)", qualityTone: "good", note: "Weights and activations in FP8; needs FP8 tensor cores (Hopper, Ada, MI300) for the compute gain." },
  { id: "int8", label: "INT8 (W8A8, SmoothQuant)", bits: 8, math: "int8", quality: "small (≈ 0.5-1 pt)", qualityTone: "good", note: "Activation outliers are smoothed into the weights so both fit in 8-bit integers." },
  { id: "awq", label: "INT4 AWQ (weight-only)", bits: 4.25, math: "bf16", quality: "small-moderate (≈ 1-2 pt)", qualityTone: "warm", note: "Protects the ~1% of weights that see large activations; compute stays FP16 after dequantizing." },
  { id: "gptq", label: "INT4 GPTQ (weight-only)", bits: 4.25, math: "bf16", quality: "moderate (≈ 1-3 pt)", qualityTone: "warm", note: "Rounds weights layer by layer to minimise output error on a calibration set; quality depends on that set." },
];

export interface QGpu {
  id: string;
  label: string;
  memGiB: number;
  bw: number;
  bf16: number;
  /** 0 = no native support */
  fp8: number;
  int8: number;
}

export const QGPUS: QGpu[] = [
  { id: "l4", label: "L4 24 GB (approx.)", memGiB: 24, bw: 0.3e12, bf16: 121e12, fp8: 242e12, int8: 242e12 },
  { id: "a100", label: "A100 80 GB (approx.)", memGiB: 80, bw: 2.0e12, bf16: 312e12, fp8: 0, int8: 624e12 },
  { id: "h100", label: "H100 80 GB (approx.)", memGiB: 80, bw: 3.35e12, bf16: 990e12, fp8: 1979e12, int8: 1979e12 },
  { id: "h200", label: "H200 141 GB (approx.)", memGiB: 141, bw: 4.8e12, bf16: 990e12, fp8: 1979e12, int8: 1979e12 },
];

export function weightBytes(params: number, bits: number): number {
  return (params * bits) / 8;
}

export function mathPeak(gpu: QGpu, f: QuantFormat): number {
  if (f.math === "fp8") return gpu.fp8 || gpu.bf16; // no FP8 cores: falls back to 16-bit math
  if (f.math === "int8") return gpu.int8 || gpu.bf16;
  return gpu.bf16;
}

/** Decode step time lower bound (seconds) for `batch` sequences, weights spread over `nGpu` GPUs (ideal tensor parallel). */
export function decodeStep(params: number, f: QuantFormat, gpu: QGpu, batch: number, nGpu = 1): number {
  const mem = weightBytes(params, f.bits) / (gpu.bw * nGpu);
  const comp = (2 * params * batch) / (mathPeak(gpu, f) * nGpu);
  return Math.max(mem, comp);
}

/** Speedup of a format over FP16 for decode at a given batch. Ideal (roofline) numbers; real kernels land below. */
export function decodeSpeedup(params: number, f: QuantFormat, gpu: QGpu, batch: number): number {
  return decodeStep(params, FORMATS[0], gpu, batch) / decodeStep(params, f, gpu, batch);
}

/* ------------------------------------------------------------------ view */

const REAL = "Photo compression: a JPEG at 90% quality looks the same and loads in a fraction of the time, but squeeze too hard and fine detail (maths, code, rare facts) starts to smear.";

function QuantSim() {
  const [paramsB, setParamsB] = useState(70);
  const [gpuId, setGpuId] = useState("h100");
  const [nGpu, setNGpu] = useState(1);
  const [batch, setBatch] = useState(1);
  const [sel, setSel] = useState<QuantId>("awq");
  const gpu = QGPUS.find((g) => g.id === gpuId)!;
  const P = paramsB * 1e9;
  const mem = gpu.memGiB * GiB * nGpu;
  const usable = mem * 0.9;
  const f = FORMATS.find((x) => x.id === sel)!;

  const rows = FORMATS.map((x) => {
    const w = weightBytes(P, x.bits);
    const step = decodeStep(P, x, gpu, batch, nGpu);
    return { f: x, w, fits: w <= usable, kvRoom: usable - w, tps: 1 / step, speed: decodeStep(P, FORMATS[0], gpu, batch, nGpu) / step };
  });
  const cur = rows.find((r) => r.f.id === sel)!;
  const maxW = Math.max(...rows.map((r) => r.w), mem);
  const fp8Fallback = f.math === "fp8" && !gpu.fp8;
  const fp16MemBound = weightBytes(P, 16) / gpu.bw >= (2 * P * batch) / gpu.bf16;
  const kvTight = cur.fits && cur.kvRoom < mem * 0.15;

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Model">
            <Slider label="Parameters" value={paramsB} onChange={setParamsB} min={1} max={405} log format={(v) => `${v}B`} />
          </Group>
          <Group title="Hardware">
            <Select label="GPU" value={gpuId} onChange={setGpuId} options={QGPUS.map((g) => ({ value: g.id, label: g.label }))} />
            <Slider label="GPUs (tensor parallel)" value={nGpu} onChange={setNGpu} min={1} max={8} format={(v) => `${v} × ${gpu.memGiB} GB`} />
          </Group>
          <Group title="Workload">
            <Slider label="Decode batch size" value={batch} onChange={setBatch} min={1} max={512} log format={(v) => `${v}`} hint="Bigger batches push decode toward compute-bound, where weight-only INT4 stops helping." />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label={`${f.label.split(" (")[0]} weights`} value={fmtBytes(cur.w)} tone={cur.fits ? "good" : "bad"} hint={cur.fits ? `${fmtBytes(cur.kvRoom)} left for KV cache` : "does not fit"} />
          <Readout label="Decode speed (ideal)" value={fmtNum(cur.tps)} unit="tok/s/seq" hint="bandwidth- or compute-bound ceiling" />
          <Readout label="vs FP16" value={`${cur.speed.toFixed(2)}×`} tone={cur.speed > 1.3 ? "good" : "neutral"} hint="real kernels: often 60-85% of this" />
          <Readout label="Typical quality impact" value={f.quality} tone={f.qualityTone} hint="typical, measure on your evals" />
        </>
      }
      explain={
        <>
          <p>
            A {paramsB}B model needs <b>{fmtBytes(rows[0].w)}</b> in FP16 but <b>{fmtBytes(cur.w)}</b> as {f.label}. Your {nGpu > 1 ? `${nGpu} GPUs give` : "GPU gives"} about {fmtBytes(usable)} usable, so it {cur.fits ? (kvTight ? "fits, but leaves little room for KV cache (fewer concurrent users)" : "fits with room for KV cache") : "does not fit: add GPUs or pick a smaller format"}.
          </p>
          <p>
            At batch {batch}, FP16 decode is <b>{fp16MemBound ? "memory-bound" : "compute-bound"}</b>
            {f.id === "fp16" ? ". Pick a smaller format to see what fewer bytes buy." : fp16MemBound ? `, so reading fewer bytes gives ${f.label} an ideal ${cur.speed.toFixed(2)}× speedup` : `, so fewer bytes only help as far as the math gets faster: ${cur.speed.toFixed(2)}×`}
            {f.math === "bf16" && f.bits < 16 && !fp16MemBound ? " (weight-only INT4 still multiplies in FP16)" : ""}
            {f.id === "fp16" ? "" : "."}
            {fp8Fallback ? " The A100 has no FP8 tensor cores, so FP8 only saves memory and bandwidth there." : ""} Quality numbers are typical published deltas; smaller models and maths, code and long reasoning suffer more, so measure on your own evals.
          </p>
        </>
      }
    >
      <div className="sim-q-list" role="radiogroup" aria-label="Quantization format">
        {rows.map((r) => {
          const on = r.f.id === sel;
          return (
            <button key={r.f.id} type="button" role="radio" aria-checked={on} className={`sim-q-row${on ? " on" : ""}`} onClick={() => setSel(r.f.id)}>
              <span className="sim-q-name">
                {r.f.label}
                <span className="sim-q-bits">{r.f.bits === 4.25 ? "~4.25 bits" : `${r.f.bits} bits`}</span>
              </span>
              <span className="sim-q-track">
                <motion.span className={`sim-q-fill ${r.fits ? "fits" : "nofit"}`} initial={false} animate={{ width: `${(r.w / maxW) * 100}%` }} transition={{ duration: 0.35 }} />
                <span className="sim-q-limit" style={{ left: `${(usable / maxW) * 100}%` }} aria-hidden />
              </span>
              <span className="sim-q-meta">
                <b>{fmtBytes(r.w)}</b>
                <span>{r.speed.toFixed(2)}× · {fmtNum(r.tps)} tok/s</span>
              </span>
            </button>
          );
        })}
        <div className="sim-q-axis">
          <span>dashed line = usable GPU memory ({fmtBytes(usable)}, 90% of {fmtNum(gpu.memGiB * nGpu)} GB)</span>
        </div>
      </div>
      <p className="sim-note">{f.note}</p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "quantization",
  title: "Quantization trade-offs",
  blurb: "Compare FP16, FP8, INT8 and INT4 (AWQ, GPTQ): memory, decode speed, typical quality cost, and whether it fits your GPU.",
  levels: [12, 14],
  realLife: REAL,
  Component: QuantSim,
};
