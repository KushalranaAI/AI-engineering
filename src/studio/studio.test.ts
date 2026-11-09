import { describe, expect, it } from "vitest";
import { PRESETS, presetById } from "./presets";
import { erlangC, percentile, queueWaitMs, simulate } from "./simulate";
import type { StudioGraph } from "./types";

const clone = (g: StudioGraph): StudioGraph => structuredClone(g);
const param = (g: StudioGraph, id: string, patch: object) => {
  const n = g.nodes.find((x) => x.id === id)!;
  n.params = { ...n.params, ...patch };
  return g;
};

describe("queueing maths", () => {
  it("matches known Erlang C values", () => {
    // 1 server at 50% load waits half the time; M/M/1 Wq = rho/(mu - lambda)
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 6);
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 6);
    const q = queueWaitMs(1, 1000, 0.5); // mu = 1/s, lambda = 0.5/s → Wq = 0.5/(1-0.5) = 1 s
    expect(q.meanWait).toBeCloseTo(1000, 3);
    expect(queueWaitMs(2, 1000, 3).rho).toBeGreaterThan(1);
  });
  it("takes nearest-rank percentiles", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 99)).toBe(99);
  });
});

describe("simulate", () => {
  it("runs every preset to completion with sensible numbers", () => {
    for (const p of PRESETS) {
      const r = simulate(p.graph, { runs: 300, rps: p.rps ?? 5 });
      expect(r.completed + r.blocked + r.failed, p.id).toBe(300);
      expect(r.completed, p.id).toBeGreaterThan(150);
      expect(r.latency.p50, p.id).toBeGreaterThan(0);
      expect(r.latency.p99, p.id).toBeGreaterThanOrEqual(r.latency.p95);
      expect(r.latency.p95, p.id).toBeGreaterThanOrEqual(r.latency.p50);
      expect(r.trace.length, p.id).toBeGreaterThan(1);
    }
  });

  it("is deterministic for a seed", () => {
    const g = presetById("rag-pipeline")!.graph;
    expect(simulate(g, { seed: 3 }).latency).toEqual(simulate(g, { seed: 3 }).latency);
  });

  it("gets more answers right when retrieval recall improves", () => {
    const g = presetById("rag-pipeline")!.graph;
    const low = simulate(param(clone(g), "ret", { recall: 0.4 }), { runs: 800 });
    const high = simulate(param(clone(g), "ret", { recall: 0.95 }), { runs: 800 });
    expect(high.correct).toBeGreaterThan(low.correct);
  });

  it("makes a cascade cost more the more it escalates", () => {
    const g = presetById("router-cascade")!.graph;
    const never = simulate(param(clone(g), "cas", { escalateRate: 0 }), { runs: 600 });
    const always = simulate(param(clone(g), "cas", { escalateRate: 1 }), { runs: 600 });
    expect(always.costPerRequest).toBeGreaterThan(never.costPerRequest * 2);
  });

  it("waits for the slowest branch of a fan-out and joins once", () => {
    const g = presetById("supervisor-workers")!.graph;
    const r = simulate(g, { runs: 200 });
    expect(r.perNode.w.visits).toBe(r.perNode.sup.visits); // the writer runs once per request, not once per branch
    const slow = simulate(param(clone(g), "a3", { steps: 8 }), { runs: 200 });
    expect(slow.latency.p50).toBeGreaterThan(r.latency.p50);
  });

  it("joins research branches at the writer, not at their shared search tool", () => {
    const g = presetById("research-team")!.graph;
    const r = simulate(g, { runs: 200 });
    expect(r.perNode.wr.visits).toBe(r.perNode.fan.visits);
  });

  it("blows up the tail when a GPU pool is pushed past capacity", () => {
    const g = presetById("inference-serving")!.graph;
    const calm = simulate(g, { runs: 600, rps: 2 });
    const hot = simulate(g, { runs: 600, rps: 26 });
    expect(hot.latency.p99).toBeGreaterThan(calm.latency.p99 * 1.5);
    expect(hot.failed + hot.latency.p99).toBeGreaterThan(calm.failed + calm.latency.p99);
  });

  it("explains a graph with no start node", () => {
    expect(simulate({ nodes: [], edges: [] }).insights[0]).toMatch(/User request/);
  });
});
