import { describe, expect, it } from "vitest";
import { DEFAULTS as W, cumulativeTokens, factRecall, historyTokens, turnTokens } from "./memory-window";
import { DEFAULTS as D, daysToThreshold, firstArchiveDay, retention, trajectory } from "./memory-decay";
import { contextPrecision, contextRecall, diagnose, faithfulness } from "./rag-metrics";
import { DEFAULTS as A, minutesOverSlo, podMinutes, simulate, users } from "./autoscaling";
import { SIMS } from "./sims-list";

describe("memory-window", () => {
  it("buffer grows every turn, window and token buffer stay flat once full", () => {
    expect(turnTokens("buffer", 20, W)).toBeGreaterThan(turnTokens("buffer", 10, W));
    expect(turnTokens("window", 30, W)).toBe(turnTokens("window", 31, W));
    expect(turnTokens("tokens", 30, W)).toBe(turnTokens("tokens", 31, W));
    expect(historyTokens("window", 30, W)).toBe(W.k * W.tpt);
  });
  it("total tokens of a full buffer grow roughly with the square of the length", () => {
    const a = cumulativeTokens("buffer", { ...W, turns: 20, system: 0, user: 0 });
    const b = cumulativeTokens("buffer", { ...W, turns: 40, system: 0, user: 0 });
    expect(b / a).toBeGreaterThan(3.5); // ~4x for 2x the turns
  });
  it("summary buffer adds a fixed summary once history exceeds the budget", () => {
    const fits = Math.floor(W.budget / W.tpt);
    expect(historyTokens("summary", fits + 5, W)).toBe(fits * W.tpt + W.summaryTokens);
    expect(historyTokens("summary", 2, W)).toBe(W.tpt);
  });
  it("decides whether an early fact survives", () => {
    expect(factRecall("buffer", 2, 40, W)).toBe("exact");
    expect(factRecall("window", 2, 40, W)).toBe("lost");
    expect(factRecall("window", 38, 40, W)).toBe("exact");
    expect(factRecall("summary", 2, 40, W)).toBe("summary");
    expect(factRecall("window", 2, 40, { ...W, pinned: true })).toBe("exact");
  });
});

describe("memory-decay", () => {
  it("halves every half-life", () => {
    expect(retention(30, 30)).toBeCloseTo(0.5);
    expect(retention(90, 30)).toBeCloseTo(0.125);
    expect(retention(0, 30)).toBe(1);
  });
  it("finds the day a memory crosses the threshold", () => {
    const pts = trajectory({ ...D, reinforce: false, days: 365 });
    const day = firstArchiveDay(pts, D.threshold)!;
    expect(Math.abs(day - daysToThreshold(D.halfLife, D.importance, D.threshold))).toBeLessThan(1.5);
  });
  it("reinforcement keeps a memory alive that would otherwise fade", () => {
    const alone = firstArchiveDay(trajectory({ ...D, reinforce: false, days: 365 }), D.threshold);
    const used = firstArchiveDay(trajectory({ ...D, reinforce: true, every: 15, days: 365 }), D.threshold);
    expect(alone).not.toBeNull();
    expect(used).toBeNull();
  });
  it("an archived memory cannot be reinforced later", () => {
    const pts = trajectory({ ...D, halfLife: 3, reinforce: true, every: 60, days: 200 });
    expect(firstArchiveDay(pts, D.threshold)).not.toBeNull();
    expect(pts[pts.length - 1].score).toBeLessThan(D.threshold);
  });
});

describe("rag-metrics", () => {
  it("matches the worked example in lesson 7.11", () => {
    expect(faithfulness([true, true, false])).toBeCloseTo(2 / 3);
    expect(contextPrecision([false, true, false])).toBeCloseTo(0.5);
    expect(contextPrecision([true, false, false])).toBe(1);
    expect(contextRecall([true, true])).toBe(1);
    expect(contextRecall([true, false])).toBe(0.5);
  });
  it("precision rewards putting the relevant chunk first", () => {
    expect(contextPrecision([true, false, true])).toBeCloseTo((1 + 2 / 3) / 2);
    expect(contextPrecision([false, false, false])).toBe(0);
  });
  it("diagnoses the fault the way the lesson's table does", () => {
    expect(diagnose(0.9, 0.9, 0.3, true).text).toMatch(/not retrieved/);
    expect(diagnose(0.4, 0.9, 0.9, true).text).toMatch(/grounding prompt/);
    expect(diagnose(0.9, 0.4, 0.9, true).text).toMatch(/reranking/);
    expect(diagnose(0.9, 0.9, 0.9, true).tone).toBe("good");
    expect(diagnose(0.9, 0.9, 0.9, false).tone).toBe("bad");
  });
});

describe("autoscaling", () => {
  it("applies the HPA formula: 3 pods at 75% of target 50% -> 5", () => {
    expect(Math.ceil((3 * 0.75) / 0.5)).toBe(5);
  });
  it("shapes traffic", () => {
    expect(users("spike", 0, 240, 60)).toBeLessThan(users("spike", 30, 240, 60));
    expect(users("ramp", 60, 240, 60)).toBe(240);
  });
  it("scales up on in-flight requests and stays inside min and max", () => {
    const steps = simulate(A);
    const peak = Math.max(...steps.map((s) => s.replicas));
    expect(peak).toBeGreaterThan(A.min);
    expect(peak).toBeLessThanOrEqual(A.max);
    expect(Math.min(...steps.map((s) => s.replicas))).toBeGreaterThanOrEqual(A.min);
  });
  it("CPU is the wrong signal for an app that waits on a model API", () => {
    const inflight = simulate(A);
    const cpu = simulate({ ...A, metric: "cpu", target: 0.6 });
    expect(minutesOverSlo(cpu, A.slo)).toBeGreaterThan(minutesOverSlo(inflight, A.slo));
    expect(Math.max(...cpu.map((s) => s.replicas))).toBeLessThan(Math.max(...inflight.map((s) => s.replicas)));
  });
  it("longer start-up time means more minutes over budget, and more headroom costs more", () => {
    const quick = minutesOverSlo(simulate({ ...A, startup: 0 }), A.slo);
    const slow = minutesOverSlo(simulate({ ...A, startup: 6 }), A.slo);
    expect(slow).toBeGreaterThanOrEqual(quick);
    expect(podMinutes(simulate({ ...A, min: 10 }))).toBeGreaterThan(podMinutes(simulate({ ...A, min: 2 })));
  });
});

describe("simulator registry", () => {
  it("registers the new simulators once each", () => {
    const ids = SIMS.map((s) => s.id);
    for (const id of ["memory-window", "memory-decay", "rag-metrics", "autoscaling"]) expect(ids.filter((x) => x === id)).toHaveLength(1);
  });
});
