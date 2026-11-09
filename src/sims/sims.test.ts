import { describe, expect, it } from "vitest";
import { mulberry32, percentile, GiB } from "./lib";
import { kvBytesPerToken, kvCacheBytes, maxConcurrent, MODELS } from "./kv-cache";
import { attainable, decodeIntensity, decodeTokensPerSec, GPUS, prefillIntensity, ridgePoint } from "./roofline";
import { rrf, BM25, VECTOR } from "./rrf";
import { makeRequests, simulateContinuous, simulateStatic } from "./batching";
import { loadPoint, DEFAULT_LOAD, sweep } from "./load-test";
import { FORMATS, QGPUS, weightBytes, decodeSpeedup } from "./quantization";
import { simulateRouting, pCorrect, type RouteConfig } from "./router-cost";
import { fitBudget, callCost } from "./token-budget";
import { cosine, dot, euclidean, keywordScore, topK, DOCS as SIM_DOCS, QUERIES } from "./similarity";
import { answerCoverage, chunk, chunkFixed, parseDoc } from "./chunking";
import type { Vec } from "./similarity";

const m8b = MODELS.find((m) => m.id === "8b")!;
const m70b = MODELS.find((m) => m.id === "70b")!;
const gpu = (id: string) => GPUS.find((g) => g.id === id)!;

describe("lib", () => {
  it("percentile interpolates between ranks", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBeCloseTo(5.5);
    expect(percentile(xs, 95)).toBeCloseTo(9.55);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile([3, 1, 2], 50)).toBe(2); // unsorted input
    expect(percentile([], 50)).toBeNaN();
  });
  it("seeded RNG is reproducible and in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

describe("kv-cache", () => {
  it("8B GQA model: 128 KiB per token at FP16, 1 GiB for 8k tokens", () => {
    expect(kvBytesPerToken(m8b, 2)).toBe(2 * 32 * 8 * 128 * 2);
    expect(kvBytesPerToken(m8b, 2)).toBe(128 * 1024);
    expect(kvCacheBytes(m8b, 2, 8192, 1)).toBe(GiB);
    expect(kvCacheBytes(m8b, 1, 8192, 4)).toBe(2 * GiB); // FP8 halves, batch multiplies
  });
  it("70B GQA model: 320 KiB per token at FP16", () => {
    expect(kvBytesPerToken(m70b, 2)).toBe(320 * 1024);
  });
  it("counts how many requests fit after the weights", () => {
    // 80 GiB x 0.9 = 72 GiB, minus 16 GB weights, / 1 GiB per request
    expect(maxConcurrent(80 * GiB, 16e9, GiB)).toBe(Math.floor((72 * GiB - 16e9) / GiB));
    expect(maxConcurrent(24 * GiB, 140e9, GiB)).toBe(0);
  });
});

describe("roofline", () => {
  it("ridge point = peak / bandwidth", () => {
    expect(ridgePoint(312e12, 2e12)).toBe(156);
    expect(ridgePoint(gpu("h100").peak, gpu("h100").bw)).toBeCloseTo(295.5, 0);
  });
  it("attainable is the min of the two roofs", () => {
    expect(attainable(100, 10, 1)).toBe(10);
    expect(attainable(100, 10, 50)).toBe(100);
  });
  it("prefill intensity grows with tokens, decode stays tiny", () => {
    expect(decodeIntensity(1, 2)).toBe(1);
    expect(prefillIntensity(1, 1024, 2)).toBe(1024);
    expect(prefillIntensity(1, 2048, 2)).toBeGreaterThan(prefillIntensity(1, 1024, 2));
    const h = gpu("h100");
    expect(decodeIntensity(1, 2)).toBeLessThan(ridgePoint(h.peak, h.bw));
    expect(prefillIntensity(1, 1024, 2)).toBeGreaterThan(ridgePoint(h.peak, h.bw));
  });
  it("decode upper bound = bandwidth / weight bytes when memory-bound", () => {
    const h = gpu("h100");
    expect(decodeTokensPerSec(8e9, 2, 1, h).perSeq).toBeCloseTo(3.35e12 / 16e9, 3);
  });
});

describe("rrf", () => {
  it("scores are sums of 1/(k+rank)", () => {
    const f = rrf([["a", "b"], ["b", "c"]], 60);
    const b = f.find((x) => x.id === "b")!;
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(f[0].id).toBe("b");
    expect(f.find((x) => x.id === "c")!.ranks).toEqual([null, 2]);
  });
  it("small k favours single-list winners, large k favours agreement", () => {
    const pos = (k: number) => rrf([BM25, VECTOR], k).findIndex((x) => x.id === "b");
    expect(pos(60)).toBeLessThan(pos(0));
  });
});

describe("batching", () => {
  const reqs = makeRequests(7, 40, 3);
  it("request stream is reproducible", () => {
    expect(makeRequests(7, 40, 3)).toEqual(reqs);
    expect(makeRequests(8, 40, 3)).not.toEqual(reqs);
  });
  it("continuous batching beats static on throughput and TTFT", () => {
    const st = simulateStatic(reqs, 8);
    const ct = simulateContinuous(reqs, 8, true);
    expect(ct.throughput).toBeGreaterThan(st.throughput);
    expect(ct.p95Ttft).toBeLessThan(st.p95Ttft);
    expect(ct.utilization).toBeGreaterThan(st.utilization);
    expect(ct.spans).toHaveLength(40);
    expect(st.spans).toHaveLength(40);
  });
  it("chunked prefill smooths inter-token latency", () => {
    const plain = simulateContinuous(reqs, 8, false);
    const chunked = simulateContinuous(reqs, 8, true, 256);
    expect(chunked.p95Itl).toBeLessThanOrEqual(plain.p95Itl);
    expect(Math.max(...chunked.itl)).toBeLessThan(Math.max(...plain.itl));
  });
});

describe("load-test", () => {
  it("percentiles are ordered and the queue starts at saturation", () => {
    const sat = DEFAULT_LOAD.replicas * DEFAULT_LOAD.maxBatch;
    const below = loadPoint(sat / 2, DEFAULT_LOAD);
    const above = loadPoint(sat * 4, DEFAULT_LOAD);
    expect(below.queue).toBe(0);
    expect(above.queue).toBe(sat * 3);
    for (const p of [below, above]) {
      expect(p.p50).toBeLessThanOrEqual(p.p95);
      expect(p.p95).toBeLessThanOrEqual(p.p99);
    }
    expect(above.p99).toBeGreaterThan(above.mean); // the mean hides the tail
    expect(above.rps).toBeCloseTo(loadPoint(sat * 8, DEFAULT_LOAD).rps, 6); // throughput has flattened
  });
  it("autoscaling on queue depth cuts tail latency at high load", () => {
    const off = loadPoint(2000, DEFAULT_LOAD);
    const on = loadPoint(2000, { ...DEFAULT_LOAD, autoscale: true });
    expect(on.replicas).toBeGreaterThan(off.replicas);
    expect(on.p95).toBeLessThan(off.p95);
  });
  it("sweep covers 1..2000", () => {
    const s = sweep(DEFAULT_LOAD);
    expect(s[0].c).toBe(1);
    expect(s[s.length - 1].c).toBe(2000);
  });
});

describe("quantization", () => {
  it("weights memory follows bits", () => {
    expect(weightBytes(70e9, 16)).toBe(140e9);
    expect(weightBytes(70e9, 8)).toBe(70e9);
    expect(weightBytes(70e9, 4.25)).toBeCloseTo(37.1875e9);
  });
  it("memory-bound decode speedup ~ byte ratio; vanishes for weight-only INT4 when compute-bound", () => {
    const h = QGPUS.find((g) => g.id === "h100")!;
    const awq = FORMATS.find((f) => f.id === "awq")!;
    expect(decodeSpeedup(8e9, awq, h, 1)).toBeCloseTo(16 / 4.25, 3);
    expect(decodeSpeedup(8e9, awq, h, 4096)).toBeCloseTo(1, 3);
  });
});

describe("router-cost", () => {
  const cfg: RouteConfig = {
    tiers: [
      { name: "S", price: 0.6, latency: 0.6, skill: 45 },
      { name: "M", price: 4, latency: 1.4, skill: 65 },
      { name: "L", price: 30, latency: 3.5, skill: 88 },
    ],
    mix: [0.6, 0.3],
    threshold: 0.7,
    classifierAcc: 0.85,
  };
  it("logistic quality curve", () => {
    expect(pCorrect(50, 50)).toBeCloseTo(0.5);
    expect(pCorrect(90, 20)).toBeGreaterThan(0.99);
  });
  it("always-big is the most accurate and most expensive; routing lands in between", () => {
    const small = simulateRouting(cfg, "small");
    const big = simulateRouting(cfg, "big");
    const cascade = simulateRouting(cfg, "cascade");
    const cls = simulateRouting(cfg, "classifier");
    expect(big.accuracy).toBeGreaterThan(small.accuracy);
    expect(big.costPer1k).toBeCloseTo(30);
    expect(small.costPer1k).toBeCloseTo(0.6);
    for (const r of [cascade, cls]) {
      expect(r.costPer1k).toBeLessThan(big.costPer1k);
      expect(r.accuracy).toBeGreaterThan(small.accuracy);
    }
    expect(simulateRouting(cfg, "cascade")).toEqual(cascade); // seeded
  });
});

describe("token-budget", () => {
  const base = { window: 8192, system: 1000, tools: 1000, user: 200, turns: 10, perTurn: 300, chunks: 6, chunkSize: 500, output: 2000 };
  it("drops oldest history before chunks", () => {
    const r = fitBudget(base);
    expect(r.inputBudget).toBe(6192);
    // room for history+chunks = 6192 - 2200 = 3992; want 3000 + 3000
    expect(r.droppedTurns).toBe(7); // 3 turns (900) + 6 chunks (3000) = 3900 fits
    expect(r.droppedChunks).toBe(0);
    expect(r.inputUsed).toBeLessThanOrEqual(r.inputBudget);
  });
  it("fails when fixed parts alone overflow", () => {
    expect(fitBudget({ ...base, system: 7000 }).fails).toBe(true);
  });
  it("cost with cached prefix is lower", () => {
    expect(callCost(1e6, 0, 0, 3, 15)).toBeCloseTo(3);
    expect(callCost(1e6, 1e6, 0, 3, 15)).toBeCloseTo(0.3);
    expect(callCost(0, 0, 1e6, 3, 15)).toBeCloseTo(15);
  });
});

describe("similarity", () => {
  it("cosine ignores length, dot does not", () => {
    const a: Vec = [1, 1];
    const b: Vec = [3, 3];
    expect(cosine(a, b)).toBeCloseTo(1);
    expect(dot(a, b)).toBe(6);
    expect(euclidean([0, 0], [3, 4])).toBe(5);
  });
  it("the product-code query: keyword finds the fix, vector top-3 misses it", () => {
    const q = QUERIES.find((x) => x.id === "code")!;
    const fix = SIM_DOCS.findIndex((d) => d.text.includes("E-4012"));
    expect(keywordScore(q.text, SIM_DOCS[fix].text)).toBe(3);
    expect(topK("cosine", q.v, SIM_DOCS.map((d) => d.v), 3)).not.toContain(fix);
  });
  it("the paraphrase query: no keyword overlap, vector finds refunds", () => {
    const q = QUERIES.find((x) => x.id === "money")!;
    expect(SIM_DOCS.every((d) => keywordScore(q.text, d.text) === 0)).toBe(true);
    const top = topK("cosine", q.v, SIM_DOCS.map((d) => d.v), 3);
    expect(top.every((i) => SIM_DOCS[i].topic === "billing")).toBe(true);
  });
});

describe("chunking", () => {
  const words = parseDoc();
  it("parses a ~550 word document with one answer span", () => {
    expect(words.length).toBeGreaterThan(500);
    expect(words.length).toBeLessThan(700);
    const ans = words.map((w, i) => (w.answer ? i : -1)).filter((i) => i >= 0);
    expect(ans.length).toBeGreaterThan(20);
    expect(ans[ans.length - 1] - ans[0] + 1).toBe(ans.length); // contiguous
  });
  it("fixed chunks cover the document with the right stride", () => {
    const c = chunkFixed(100, 30, 10);
    expect(c[0]).toEqual([0, 30]);
    expect(c[1]).toEqual([20, 50]);
    expect(c[c.length - 1][1]).toBe(100);
  });
  it("every strategy covers every word and respects size", () => {
    for (const s of ["fixed", "recursive", "heading"] as const) {
      const c = chunk(words, s, 60, 0);
      const covered = new Set<number>();
      c.forEach(([a, b]) => {
        expect(b - a).toBeLessThanOrEqual(60);
        for (let i = a; i < b; i++) covered.add(i);
      });
      expect(covered.size).toBe(words.length);
    }
  });
  it("heading chunks never cross a section", () => {
    for (const [a, b] of chunk(words, "heading", 200, 20)) expect(words[a].section).toBe(words[b - 1].section);
  });
  it("answer coverage reports intact vs split", () => {
    expect(answerCoverage([[0, 10], [10, 20]], [8, 12])).toEqual({ intact: [], touching: [0, 1], bestShare: 0.5 });
    expect(answerCoverage([[0, 20]], [8, 12]).intact).toEqual([0]);
  });
});

import { softmaxWithTemperature, topPFilter, sampleSeeded, tokenize, nextCandidates, attentionWeights } from "./llm-anatomy";

describe("llm-anatomy", () => {
  it("softmax sums to 1, temperature sharpens or flattens", () => {
    const l = [2, 1, 0];
    const p1 = softmaxWithTemperature(l, 1);
    expect(p1.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(p1[0]).toBeCloseTo(Math.exp(2) / (Math.exp(2) + Math.exp(1) + 1));
    expect(softmaxWithTemperature(l, 0.25)[0]).toBeGreaterThan(p1[0]);
    expect(softmaxWithTemperature(l, 4)[0]).toBeLessThan(p1[0]);
    expect(softmaxWithTemperature(l, 0)).toEqual([1, 0, 0]);
    expect(softmaxWithTemperature([1000, 999], 1)[0]).toBeCloseTo(1 / (1 + Math.exp(-1))); // stable
  });
  it("top-p keeps the smallest nucleus and renormalises", () => {
    const r = topPFilter([0.1, 0.5, 0.3, 0.1], 0.75);
    expect(r.kept).toEqual([false, true, true, false]);
    expect(r.probs[1]).toBeCloseTo(0.625);
    expect(r.probs[0]).toBe(0);
    expect(topPFilter([0.2, 0.8], 1).kept).toEqual([true, true]);
    expect(topPFilter([0.2, 0.8], 0.1).kept).toEqual([false, true]);
  });
  it("seeded sampling is reproducible and never picks a zero-probability token", () => {
    const p = [0, 0.5, 0, 0.5];
    for (let s = 1; s < 200; s++) {
      const i = sampleSeeded(p, s);
      expect([1, 3]).toContain(i);
      expect(sampleSeeded(p, s)).toBe(i);
    }
    expect(sampleSeeded([0, 1, 0], 7)).toBe(1);
  });
  it("seeded sampling roughly follows the distribution", () => {
    const counts = [0, 0];
    for (let s = 0; s < 4000; s++) counts[sampleSeeded([0.25, 0.75], s)]++;
    expect(counts[1] / 4000).toBeGreaterThan(0.7);
    expect(counts[1] / 4000).toBeLessThan(0.8);
  });
  it("illustrative tokenizer and toy model", () => {
    expect(tokenize("The capital of France is")).toEqual(["The", " capital", " of", " France", " is"]);
    expect(tokenize("def add(a, b):")).toEqual(["def", " add", "(", "a", ",", " b", ")", ":"]);
    expect(tokenize(" interesting").join("")).toBe(" interesting");
    expect(nextCandidates(tokenize("The capital of France is"))[0][0]).toBe(" Paris");
    const w = attentionWeights(tokenize("Once upon a time"), 3, 0);
    expect(w).toHaveLength(4);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
