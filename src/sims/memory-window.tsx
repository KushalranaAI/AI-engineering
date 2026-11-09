import { useMemo, useState } from "react";
import type { SimDef } from "./types";
import { Chart, Group, Note, Readout, Segmented, SimFrame, Slider, Toggle } from "./ui";
import { fmtNum } from "./lib";

/* ------------------------------------------------------------------ model
 * Short-term memory strategies. Every turn adds `tpt` tokens (the user's message plus the reply) to the history.
 * What the model receives on turn t is the system prompt, the chosen slice of history, and the new user message.
 *   buffer         all earlier turns
 *   window         the last k turns
 *   token buffer   as many of the newest turns as fit a token budget
 *   summary buffer a fixed-size summary of older turns + the newest turns that fit the budget
 * A pinned block (goal, constraints) is always included when `pinned` is on.
 */

export type Strategy = "buffer" | "window" | "tokens" | "summary";

export interface Params {
  turns: number;
  /** tokens added to the history by one exchange */
  tpt: number;
  system: number;
  /** tokens of the new user message on each turn */
  user: number;
  k: number;
  budget: number;
  summaryTokens: number;
  pinnedTokens: number;
  pinned: boolean;
}

export const DEFAULTS: Params = { turns: 40, tpt: 350, system: 700, user: 120, k: 6, budget: 3000, summaryTokens: 250, pinnedTokens: 80, pinned: false };

export const STRATEGIES: { id: Strategy; label: string; color: string }[] = [
  { id: "buffer", label: "Conversation buffer", color: "var(--bad)" },
  { id: "window", label: "Sliding window", color: "var(--warm)" },
  { id: "tokens", label: "Token buffer", color: "var(--accent)" },
  { id: "summary", label: "Summary buffer", color: "var(--good)" },
];

/** tokens of history included on turn t (1-based); the history before turn t holds (t - 1) exchanges */
export function historyTokens(s: Strategy, t: number, p: Params): number {
  const all = (t - 1) * p.tpt;
  switch (s) {
    case "buffer":
      return all;
    case "window":
      return Math.min(t - 1, p.k) * p.tpt;
    case "tokens": {
      const turnsThatFit = Math.floor(p.budget / p.tpt);
      return Math.min(t - 1, turnsThatFit) * p.tpt;
    }
    case "summary": {
      const turnsThatFit = Math.floor(p.budget / p.tpt);
      const recent = Math.min(t - 1, turnsThatFit) * p.tpt;
      return t - 1 > turnsThatFit ? recent + p.summaryTokens : recent;
    }
  }
}

/** tokens sent to the model on turn t */
export function turnTokens(s: Strategy, t: number, p: Params): number {
  return p.system + (p.pinned ? p.pinnedTokens : 0) + historyTokens(s, t, p) + p.user;
}

export function cumulativeTokens(s: Strategy, p: Params): number {
  let sum = 0;
  for (let t = 1; t <= p.turns; t++) sum += turnTokens(s, t, p);
  return sum;
}

export type Recall = "exact" | "summary" | "lost";

/** does a fact stated on turn `factTurn` still reach the model on turn t? */
export function factRecall(s: Strategy, factTurn: number, t: number, p: Params): Recall {
  if (p.pinned) return "exact";
  const age = t - factTurn; // exchanges between the fact and now (age 1 = the very last exchange)
  if (age <= 0) return "exact";
  switch (s) {
    case "buffer":
      return "exact";
    case "window":
      return age <= p.k ? "exact" : "lost";
    case "tokens":
      return age <= Math.floor(p.budget / p.tpt) ? "exact" : "lost";
    case "summary":
      return age <= Math.floor(p.budget / p.tpt) ? "exact" : "summary";
  }
}

/* ------------------------------------------------------------------ view */

const REAL = "A whiteboard in a meeting room: write everything and it overflows, erase all but the last five lines and the budget disappears, so a boxed header in the corner keeps the goal.";

function MemoryWindowSim() {
  const [p, setP] = useState<Params>(DEFAULTS);
  const [factTurn, setFactTurn] = useState(2);
  const [focus, setFocus] = useState<Strategy>("window");
  const set = <K extends keyof Params>(k: K, v: Params[K]) => setP((x) => ({ ...x, [k]: v }));

  const series = useMemo(
    () =>
      STRATEGIES.map((s) => ({
        name: s.label,
        color: s.color,
        points: Array.from({ length: p.turns }, (_, i) => [i + 1, turnTokens(s.id, i + 1, p)] as [number, number]),
      })),
    [p],
  );
  const cum = (s: Strategy) => cumulativeTokens(s, p);
  const last = (s: Strategy) => turnTokens(s, p.turns, p);
  const recall = factRecall(focus, factTurn, p.turns, p);
  const focusLabel = STRATEGIES.find((s) => s.id === focus)!.label.toLowerCase();

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Conversation">
            <Slider label="Turns" value={p.turns} onChange={(v) => set("turns", v)} min={5} max={100} />
            <Slider label="Tokens per exchange" value={p.tpt} onChange={(v) => set("tpt", v)} min={100} max={1000} step={50} hint="User message plus the reply." />
            <Slider label="System prompt" value={p.system} onChange={(v) => set("system", v)} min={100} max={3000} step={100} unit="tokens" />
          </Group>
          <Group title="Strategies">
            <Slider label="Window size k" value={p.k} onChange={(v) => set("k", v)} min={1} max={20} format={(v) => `last ${v} turns`} />
            <Slider label="History token budget" value={p.budget} onChange={(v) => set("budget", v)} min={500} max={8000} step={250} unit="tokens" />
            <Slider label="Summary size" value={p.summaryTokens} onChange={(v) => set("summaryTokens", v)} min={50} max={800} step={50} unit="tokens" />
            <Toggle label="Pin goal and constraints" checked={p.pinned} onChange={(v) => set("pinned", v)} hint="A small block that is never trimmed." />
          </Group>
          <Group title="A fact to remember">
            <Slider label="Stated on turn" value={factTurn} onChange={setFactTurn} min={1} max={Math.max(1, p.turns - 1)} hint="For example: 'my budget is 40,000'." />
            <Segmented label="Check strategy" value={focus} onChange={setFocus} options={STRATEGIES.map((s) => ({ value: s.id, label: s.label.split(" ")[0] }))} />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label={`Turn ${p.turns} input · buffer`} value={fmtNum(last("buffer"))} unit="tokens" tone="bad" />
          <Readout label={`Turn ${p.turns} input · token buffer`} value={fmtNum(last("tokens"))} unit="tokens" tone="accent" />
          <Readout label="Whole conversation · buffer" value={fmtNum(cum("buffer"))} unit="tokens" hint={`${(cum("buffer") / Math.max(1, cum("tokens"))).toFixed(1)}x the token buffer`} />
          <Readout label={`Fact from turn ${factTurn}`} value={recall === "exact" ? "remembered" : recall === "summary" ? "in summary" : "forgotten"} tone={recall === "exact" ? "good" : recall === "summary" ? "warm" : "bad"} hint={focusLabel} />
        </>
      }
      explain={
        <>
          <p>
            The full buffer sends {fmtNum(last("buffer"))} tokens on turn {p.turns} and {fmtNum(cum("buffer"))} in total, because each turn resends everything before it, so the total grows with the square of the conversation length. The window and token buffer stay flat at about {fmtNum(last("window"))} and {fmtNum(last("tokens"))} tokens.
          </p>
          <p>
            The price of flat cost is forgetting: with the {focusLabel}, the fact stated on turn {factTurn} is <b>{recall === "exact" ? "still sent verbatim" : recall === "summary" ? "only in the summary, so details may be lost" : "gone"}</b> on turn {p.turns}. {p.pinned ? "It survives because the pinned block is never trimmed." : "Turn on pinning to see durable constraints survive any strategy."}
          </p>
        </>
      }
    >
      <Chart
        ariaLabel="Input tokens per turn for four short-term memory strategies"
        xLabel="Turn"
        yLabel="Input tokens"
        xDomain={[1, p.turns]}
        xFormat={(v) => fmtNum(v)}
        yFormat={(v) => fmtNum(v)}
        series={series}
        refs={[{ x: factTurn, label: "fact stated", color: "var(--text-2)" }]}
      />
      <Note>Try a long conversation (80 turns) with a 3,000-token budget, then move the fact to turn 2 and compare the window with the summary buffer.</Note>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "memory-window",
  title: "Short-term memory strategies",
  blurb: "Compare conversation buffer, sliding window, token buffer and summary buffer on tokens per turn and on whether an early fact survives.",
  levels: [6],
  realLife: REAL,
  Component: MemoryWindowSim,
};
