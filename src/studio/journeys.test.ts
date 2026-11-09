import { describe, expect, it } from "vitest";
import { MODULES } from "../curriculum";
import { JOURNEYS, journeyById } from "./journeys";
import { poolOf, simulate } from "./simulate";
import { kvBytesPerToken, MODELS, replicasFor, sizeReplica } from "./sizing";

const sim = (j: string, i: number, rps?: number) => {
  const s = journeyById(j)!.stages[i];
  return simulate(s.graph, { runs: 1500, rps: rps ?? s.rps ?? 5, seed: 11 });
};

describe("sizing maths", () => {
  it("matches the textbook KV-cache size for an 8B GQA model", () => {
    expect(kvBytesPerToken(MODELS["8b"], 2)).toBe(131072); // 128 KiB per token in FP16
    expect(kvBytesPerToken(MODELS["70b"], 2)).toBe(327680); // 320 KiB
  });
  it("is memory-bound in decode and fits sensible batches", () => {
    const r = sizeReplica({ model: "8b", gpu: "h100", precision: "fp16", kvPrecision: "fp16", inTokens: 1500, outTokens: 300, maxBatch: 512 });
    expect(r.ok).toBe(true);
    expect(r.tp).toBe(1);
    expect(r.weightsGB).toBeGreaterThan(15);
    expect(r.fitSeqs).toBeGreaterThan(100);
    expect(r.bound).toBe("memory");
    const solo = sizeReplica({ model: "8b", gpu: "h100", precision: "fp16", kvPrecision: "fp16", inTokens: 100, outTokens: 100, maxBatch: 1 });
    expect(solo.tokPerSecPerUser).toBeGreaterThan(100); // ~3.35 TB/s × 0.7 / 16 GB ≈ 145 tok/s
    expect(solo.tokPerSecPerUser).toBeLessThan(220);
  });
  it("needs tensor parallelism for a 70B model in FP16", () => {
    expect(sizeReplica({ model: "70b", gpu: "h100", precision: "fp16", kvPrecision: "fp16", inTokens: 2000, outTokens: 300, maxBatch: 64 }).tp).toBeGreaterThanOrEqual(2);
  });
  it("frees memory with FP8 and grows the batch", () => {
    const a = sizeReplica({ model: "8b", gpu: "l4", precision: "fp16", kvPrecision: "fp16", inTokens: 2000, outTokens: 300, maxBatch: 512 });
    const b = sizeReplica({ model: "8b", gpu: "l4", precision: "fp8", kvPrecision: "fp8", inTokens: 2000, outTokens: 300, maxBatch: 512 });
    expect(b.fitSeqs).toBeGreaterThan(a.fitSeqs * 2);
  });
  it("says how many replicas a load needs", () => {
    const r = sizeReplica({ model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", inTokens: 1500, outTokens: 300, maxBatch: 64 });
    expect(replicasFor(r, r.reqPerSec * 0.7)).toBe(1);
    expect(replicasFor(r, r.reqPerSec * 2)).toBe(3);
  });
});

describe("journeys", () => {
  it("link only to real modules and simulate cleanly at every stage", () => {
    const ids = new Set(MODULES.map((m) => m.id));
    for (const j of JOURNEYS)
      j.stages.forEach((s, i) => {
        for (const m of s.modules) expect(ids.has(m), `${j.id}[${i}] → ${m}`).toBe(true);
        const r = simulate(s.graph, { runs: 300, rps: s.rps ?? 5 });
        expect(r.completed + r.blocked + r.failed, `${j.id}[${i}]`).toBe(300);
        expect(r.completed, `${j.id}[${i}] completes`).toBeGreaterThan(100);
      });
  });

  it("support: correctness climbs from plain LLM to RAG to better retrieval", () => {
    const [a, b, c] = [sim("support", 0), sim("support", 1), sim("support", 2)];
    const rate = (r: typeof a) => r.correct / r.completed;
    expect(rate(a)).toBeLessThan(0.4);
    expect(rate(b)).toBeGreaterThan(rate(a) + 0.2);
    expect(rate(c)).toBeGreaterThan(rate(b));
  });

  it("support: the cache-and-cascade stage is cheaper than the stage before it", () => {
    expect(sim("support", 4).costPerRequest).toBeLessThan(sim("support", 3).costPerRequest);
  });

  it("serving: the same design falls over when traffic grows, and scaling out fixes it", () => {
    const calm = sim("serving", 0);
    const hot = sim("serving", 1);
    const scaled = sim("serving", 2);
    expect(hot.latency.p99).toBeGreaterThan(calm.latency.p99 * 2);
    expect(scaled.latency.p99).toBeLessThan(hot.latency.p99);
  });

  it("scores answers from self-hosted model pools, and a bigger model answers better", () => {
    const small = sim("serving", 3, 4);
    expect(small.correct / small.completed).toBeGreaterThan(0.5);
    const g = structuredClone(journeyById("serving")!.stages[0].graph);
    const pool = g.nodes.find((n) => n.kind === "replicas")!;
    pool.params.model = "3b";
    const tiny = simulate(g, { runs: 2000, rps: 1, seed: 5 });
    pool.params.model = "70b";
    pool.params.tp = 2;
    pool.params.precision = "fp8"; // 70B in FP16 needs ~140 GB of weights, so it would not fit on 2 GPUs
    pool.params.kvPrecision = "fp8";
    const big = simulate(g, { runs: 2000, rps: 1, seed: 5 });
    expect(big.correct).toBeGreaterThan(tiny.correct);
  });

  it("gpu pools report GPUs and price", () => {
    const big = journeyById("serving")!.stages[4].graph.nodes.find((n) => n.id === "b")!;
    const p = poolOf(big);
    expect(p.sizing?.ok).toBe(true);
    expect(p.gpus).toBeGreaterThanOrEqual(2);
    expect(p.pricePerHour).toBeGreaterThan(0);
  });
});
