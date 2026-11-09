import { useMemo, useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Readout, Segmented, SimFrame, Slider } from "./ui";
import { clamp, fmtPct, fmtSec, fmtUsd, mulberry32, percentile } from "./lib";

/* ------------------------------------------------------------------ model
 * Three model tiers, each with a price per 1k requests, a median latency and a "skill" (0-100).
 * P(correct) on a query of difficulty d follows a logistic curve: 1 / (1 + exp(-(skill - d) / 10)),
 * with difficulty 20 (easy), 50 (medium), 80 (hard).
 * Monte Carlo over a seeded stream of 4,000 queries:
 *  - always-small / always-big: one call.
 *  - cascade: call small -> medium -> large, escalating while the model's self-reported confidence < threshold.
 *    Confidence is noisy but correlated with being right (right answers centre at 0.8, wrong ones at 0.45).
 *  - classifier router: a cheap classifier guesses the difficulty (with the given accuracy) and picks one tier.
 * Latency per call is log-normal around the tier median; a cascade pays the latency of every tier it tried.
 */

export interface Tier {
  name: string;
  /** $ per 1,000 requests */
  price: number;
  /** median seconds */
  latency: number;
  skill: number;
}

export type Policy = "small" | "big" | "cascade" | "classifier";
export const DIFF = [20, 50, 80] as const;
const DLABEL = ["easy", "medium", "hard"];

export function pCorrect(skill: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-(skill - difficulty) / 10));
}

export interface RouteConfig {
  tiers: [Tier, Tier, Tier];
  /** share of easy, medium (hard = rest) */
  mix: [number, number];
  threshold: number;
  classifierAcc: number;
}

export interface RouteResult {
  costPer1k: number;
  p95: number;
  p50: number;
  accuracy: number;
  /** share answered by each tier */
  answeredBy: [number, number, number];
}

const N = 4000;
const CLASSIFIER = { price: 0.05, latency: 0.03 };

export function simulateRouting(cfg: RouteConfig, policy: Policy, seed = 11): RouteResult {
  const rng = mulberry32(seed);
  const [pe, pm] = cfg.mix;
  let cost = 0;
  let correct = 0;
  const lat: number[] = [];
  const by: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const u = rng();
    const d = u < pe ? 0 : u < pe + pm ? 1 : 2;
    // pre-draw randomness so every policy sees the same query stream
    const draws = Array.from({ length: 3 }, () => ({ ok: rng(), conf: rng(), conf2: rng(), lat: rng(), lat2: rng() }));
    const cls = { hit: rng(), pick: rng() };
    const call = (t: number) => {
      const tier = cfg.tiers[t];
      const r = draws[t];
      cost += tier.price / 1000;
      const ok = r.ok < pCorrect(tier.skill, DIFF[d]);
      const n = Math.sqrt(-2 * Math.log(Math.max(r.conf, 1e-9))) * Math.cos(2 * Math.PI * r.conf2);
      const conf = clamp((ok ? 0.8 : 0.45) + 0.15 * n, 0, 1);
      const l = tier.latency * Math.exp(0.35 * Math.sqrt(-2 * Math.log(Math.max(r.lat, 1e-9))) * Math.cos(2 * Math.PI * r.lat2));
      return { ok, conf, l };
    };
    let total = 0;
    let ok = false;
    let used = 0;
    if (policy === "small" || policy === "big") {
      used = policy === "small" ? 0 : 2;
      const r = call(used);
      total = r.l;
      ok = r.ok;
    } else if (policy === "cascade") {
      for (let t = 0; t < 3; t++) {
        const r = call(t);
        total += r.l;
        ok = r.ok;
        used = t;
        if (r.conf >= cfg.threshold) break;
      }
    } else {
      cost += CLASSIFIER.price / 1000;
      total += CLASSIFIER.latency;
      let guess = d;
      if (cls.hit > cfg.classifierAcc) {
        const others = [0, 1, 2].filter((x) => x !== d);
        guess = others[cls.pick < 0.5 ? 0 : 1];
      }
      used = guess;
      const r = call(guess);
      total += r.l;
      ok = r.ok;
    }
    by[used]++;
    lat.push(total);
    if (ok) correct++;
  }
  return { costPer1k: (cost / N) * 1000, p95: percentile(lat, 95), p50: percentile(lat, 50), accuracy: correct / N, answeredBy: by.map((v) => v / N) as [number, number, number] };
}

/* ------------------------------------------------------------------ view */

const REAL = "A hospital triage desk: a nurse handles the sprained ankles, sends harder cases to a GP and only the hardest to the specialist, so the expensive expert's time goes where it changes the outcome.";

const POLICIES: { value: Policy; label: string }[] = [
  { value: "small", label: "Always small" },
  { value: "big", label: "Always big" },
  { value: "cascade", label: "Cascade" },
  { value: "classifier", label: "Classifier" },
];
const TIER_COLORS = ["var(--good)", "var(--ph-retrieval)", "var(--ai)"];

function TierControls({ t, set }: { t: Tier; set: (t: Tier) => void }) {
  return (
    <Group title={`${t.name} model`}>
      <Slider label="Price" value={t.price} onChange={(v) => set({ ...t, price: v })} min={0.1} max={100} step={0.1} log format={(v) => `$${v < 1 ? v.toFixed(2) : v.toFixed(1)} / 1k req`} />
      <Slider label="Median latency" value={t.latency} onChange={(v) => set({ ...t, latency: v })} min={0.1} max={12} step={0.1} log format={(v) => `${v.toFixed(1)} s`} />
      <Slider label="Skill" value={t.skill} onChange={(v) => set({ ...t, skill: v })} min={10} max={100} hint={`right on easy ${fmtPct(pCorrect(t.skill, DIFF[0]))}, medium ${fmtPct(pCorrect(t.skill, DIFF[1]))}, hard ${fmtPct(pCorrect(t.skill, DIFF[2]))}`} />
    </Group>
  );
}

function RouterSim() {
  const [tiers, setTiers] = useState<[Tier, Tier, Tier]>([
    { name: "Small", price: 0.6, latency: 0.6, skill: 45 },
    { name: "Medium", price: 4, latency: 1.4, skill: 65 },
    { name: "Large", price: 30, latency: 3.5, skill: 88 },
  ]);
  const [easy, setEasy] = useState(60);
  const [medium, setMedium] = useState(30);
  const [policy, setPolicy] = useState<Policy>("cascade");
  const [threshold, setThreshold] = useState(0.7);
  const [clsAcc, setClsAcc] = useState(0.85);
  const hard = Math.max(0, 100 - easy - medium);
  const med = Math.min(medium, 100 - easy);

  const all = useMemo(() => {
    const c: RouteConfig = { tiers, mix: [easy / 100, med / 100], threshold, classifierAcc: clsAcc };
    return Object.fromEntries(POLICIES.map((p) => [p.value, simulateRouting(c, p.value)])) as Record<Policy, RouteResult>;
  }, [tiers, easy, med, threshold, clsAcc]);
  const r = all[policy];
  const big = all.big;
  const setTier = (i: number) => (t: Tier) => setTiers((ts) => ts.map((x, k) => (k === i ? t : x)) as [Tier, Tier, Tier]);

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Routing policy">
            <Segmented label="Policy" value={policy} onChange={setPolicy} options={POLICIES} />
            {policy === "cascade" && <Slider label="Escalate if confidence below" value={threshold} onChange={setThreshold} min={0.3} max={0.95} step={0.01} format={(v) => v.toFixed(2)} />}
            {policy === "classifier" && <Slider label="Classifier accuracy" value={clsAcc} onChange={setClsAcc} min={0.34} max={1} step={0.01} format={(v) => fmtPct(v)} hint="Costs $0.05 / 1k and 30 ms per request." />}
          </Group>
          <Group title="Traffic mix">
            <Slider label="Easy" value={easy} onChange={setEasy} min={0} max={100} format={(v) => `${v}%`} />
            <Slider label="Medium" value={med} onChange={setMedium} min={0} max={100 - easy} format={(v) => `${v}%`} hint={`Hard: ${hard}%`} />
          </Group>
          {tiers.map((t, i) => (
            <TierControls key={t.name} t={t} set={setTier(i)} />
          ))}
        </>
      }
      readouts={
        <>
          <Readout label="Cost" value={fmtUsd(r.costPer1k)} unit="/ 1k req" tone={r.costPer1k < big.costPer1k * 0.5 ? "good" : "neutral"} hint={`always-big: ${fmtUsd(big.costPer1k)}`} />
          <Readout label="p95 latency" value={fmtSec(r.p95)} tone={r.p95 > big.p95 ? "warm" : "neutral"} hint={`p50 ${fmtSec(r.p50)}`} />
          <Readout label="Answered correctly" value={fmtPct(r.accuracy, 1)} tone={r.accuracy >= big.accuracy - 0.02 ? "good" : r.accuracy >= big.accuracy - 0.08 ? "warm" : "bad"} hint={`always-big: ${fmtPct(big.accuracy, 1)} (simulated)`} />
          <Readout label="Answered by" value={r.answeredBy.map((v) => fmtPct(v)).join(" / ")} hint="small / medium / large" />
        </>
      }
      explain={
        <>
          <p>
            With {easy}% easy, {med}% medium and {hard}% hard traffic, always using the large model costs {fmtUsd(big.costPer1k)} per 1k requests for {fmtPct(big.accuracy, 1)} correct. The{" "}
            {POLICIES.find((p) => p.value === policy)!.label.toLowerCase()} policy costs <b>{fmtUsd(r.costPer1k)}</b> ({fmtPct(r.costPer1k / big.costPer1k)} of that) and gets <b>{fmtPct(r.accuracy, 1)}</b>.
          </p>
          <p>
            {policy === "cascade"
              ? `A cascade pays twice for escalated queries and adds their latency, which is why p95 is ${fmtSec(r.p95)}. Raise the threshold to escalate more (more accurate, pricier); lower it to trust the small model more.`
              : policy === "classifier"
                ? `The classifier sends each query straight to one tier, so latency stays low (p95 ${fmtSec(r.p95)}); its mistakes cost quality when hard queries go small, and money when easy ones go large.`
                : policy === "small"
                  ? "The small model is cheap and fast but fails most hard queries. Routing exists to keep its price on easy traffic without paying in quality."
                  : "Paying for the strongest model on every query buys the best accuracy, mostly spent on easy queries a smaller model would have got right."}{" "}
            The chart shows all four policies so you can see the cost-quality frontier move as you change the mix.
          </p>
        </>
      }
    >
      <Chart
        ariaLabel="Cost versus accuracy for each routing policy"
        xLog
        yDomain={[Math.max(0, Math.min(...Object.values(all).map((x) => x.accuracy)) - 0.1), 1]}
        xDomain={[Math.min(...Object.values(all).map((x) => x.costPer1k)) * 0.6, Math.max(...Object.values(all).map((x) => x.costPer1k)) * 1.8]}
        xLabel="Cost ($ per 1k requests, log)"
        yLabel="Answered correctly"
        xFormat={(v) => `$${v < 1 ? v.toFixed(1) : Math.round(v)}`}
        yFormat={(v) => fmtPct(v)}
        dots={POLICIES.map((p) => ({
          x: all[p.value].costPer1k,
          y: all[p.value].accuracy,
          color: p.value === policy ? "var(--accent)" : "var(--faint)",
          r: p.value === policy ? 8 : 5.5,
          label: p.label,
          anchor: p.value === "big" ? "left" : "right",
        }))}
      />
      <div className="sim-router-mix" aria-label="Which tier answered each difficulty">
        {r.answeredBy.map((v, i) => (
          <div key={i} className="sim-router-cell" style={{ ["--c" as string]: TIER_COLORS[i] }}>
            <span className="sim-router-bar" style={{ width: `${v * 100}%` }} />
            <span>
              {tiers[i].name}: {fmtPct(v)}
            </span>
          </div>
        ))}
      </div>
      <p className="sim-note">Correctness is simulated from each tier's skill against {DLABEL.join(" / ")} difficulty. Real routers need an eval set to tune the threshold.</p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "router-cost",
  title: "Model routing: cost vs quality",
  blurb: "Route a mix of easy, medium and hard queries between small, medium and large models and compare cost, p95 latency and accuracy.",
  levels: [9, 10],
  realLife: REAL,
  Component: RouterSim,
};
