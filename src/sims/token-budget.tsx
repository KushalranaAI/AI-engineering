import { useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { SimDef } from "./types";
import { Group, Legend, Readout, Segmented, SimFrame, Slider, StackBar, Toggle } from "./ui";
import { fmtNum, fmtPct, fmtTokens, fmtUsd } from "./lib";

/* ------------------------------------------------------------------ model
 * Input budget = context window - tokens reserved for the output.
 * Fixed parts (system prompt, tool definitions, the user's message) are never cut. When the rest does not fit,
 * the policy here (a common one) drops the OLDEST history turns first, then the LOWEST-ranked retrieved chunks.
 * Cost per call = uncached input x input price + cached input x input price x cacheRate + output x output price.
 */

export interface BudgetInput {
  window: number;
  system: number;
  tools: number;
  user: number;
  turns: number;
  perTurn: number;
  chunks: number;
  chunkSize: number;
  output: number;
}

export interface BudgetResult {
  inputBudget: number;
  fixed: number;
  keptTurns: number;
  droppedTurns: number;
  keptChunks: number;
  droppedChunks: number;
  inputUsed: number;
  /** tokens that were requested but did not fit */
  dropped: number;
  /** fixed parts alone exceed the input budget: the call fails */
  fails: boolean;
}

export function fitBudget(b: BudgetInput): BudgetResult {
  const inputBudget = Math.max(0, b.window - b.output);
  const fixed = b.system + b.tools + b.user;
  if (fixed > inputBudget) {
    return { inputBudget, fixed, keptTurns: 0, droppedTurns: b.turns, keptChunks: 0, droppedChunks: b.chunks, inputUsed: fixed, dropped: b.turns * b.perTurn + b.chunks * b.chunkSize, fails: true };
  }
  let room = inputBudget - fixed;
  // chunks are kept in rank order; history is kept newest-first. Drop oldest history before any chunk.
  let keptTurns = b.turns;
  let keptChunks = b.chunks;
  let need = keptTurns * b.perTurn + keptChunks * b.chunkSize;
  while (need > room && keptTurns > 0) {
    keptTurns--;
    need -= b.perTurn;
  }
  while (need > room && keptChunks > 0) {
    keptChunks--;
    need -= b.chunkSize;
  }
  room -= need;
  return {
    inputBudget,
    fixed,
    keptTurns,
    droppedTurns: b.turns - keptTurns,
    keptChunks,
    droppedChunks: b.chunks - keptChunks,
    inputUsed: fixed + need,
    dropped: (b.turns - keptTurns) * b.perTurn + (b.chunks - keptChunks) * b.chunkSize,
    fails: false,
  };
}

export function callCost(inputTokens: number, cachedTokens: number, outputTokens: number, inPerM: number, outPerM: number, cacheRate = 0.1): number {
  const cached = Math.min(cachedTokens, inputTokens);
  return ((inputTokens - cached) * inPerM + cached * inPerM * cacheRate + outputTokens * outPerM) / 1e6;
}

/* ------------------------------------------------------------------ view */

const REAL = "Packing a carry-on with a strict size limit: passport and toiletries always go in, you leave room for souvenirs on the way home, and the old jumpers you packed first are the first to come out.";

const WINDOWS = [8192, 32768, 131072, 200000, 1000000];
const C = { system: "var(--ai)", tools: "var(--ph-production)", user: "var(--text-2)", history: "var(--ph-retrieval)", chunks: "var(--ph-agentic)", output: "var(--warm)" };

function TokenBudgetSim() {
  const [win, setWin] = useState(32768);
  const [system, setSystem] = useState(1500);
  const [tools, setTools] = useState(12);
  const [user, setUser] = useState(200);
  const [turns, setTurns] = useState(20);
  const [perTurn, setPerTurn] = useState(350);
  const [chunks, setChunks] = useState(10);
  const [chunkSize, setChunkSize] = useState(512);
  const [output, setOutput] = useState(4096);
  const [inPrice, setInPrice] = useState(3);
  const [outPrice, setOutPrice] = useState(15);
  const [cache, setCache] = useState(true);
  const toolTok = tools * 300;

  const b: BudgetInput = { window: win, system, tools: toolTok, user, turns, perTurn, chunks, chunkSize, output };
  const r = fitBudget(b);
  const cost = callCost(r.inputUsed, cache ? system + toolTok : 0, output, inPrice, outPrice);
  const costNoCache = callCost(r.inputUsed, 0, output, inPrice, outPrice);
  const histKept = r.keptTurns * perTurn;
  const chunkKept = r.keptChunks * chunkSize;
  const free = Math.max(0, win - output - r.inputUsed);
  const fillPct = (r.inputUsed + output) / win;

  const warnings: { tone: "bad" | "warm"; text: string }[] = [];
  if (r.fails) warnings.push({ tone: "bad", text: `The system prompt, tools and user message (${fmtNum(r.fixed)} tokens) alone exceed the ${fmtNum(r.inputBudget)}-token input budget. The API would reject this call.` });
  if (r.droppedTurns && !r.fails) warnings.push({ tone: "warm", text: `${r.droppedTurns} oldest history turn${r.droppedTurns > 1 ? "s" : ""} dropped (${fmtNum(r.droppedTurns * perTurn)} tokens). Summarise old turns instead of losing them.` });
  if (r.droppedChunks && !r.fails) warnings.push({ tone: "bad", text: `${r.droppedChunks} lowest-ranked retrieved chunk${r.droppedChunks > 1 ? "s" : ""} dropped. If the answer was in one, the model never sees it.` });
  if (output < 1024) warnings.push({ tone: "warm", text: "Under 1k tokens reserved for output: long answers will be cut off mid-sentence (finish_reason = length)." });
  if (tools > 20) warnings.push({ tone: "warm", text: `${tools} tool definitions: models pick the wrong tool more often with long tool lists. Route or load tools on demand.` });
  if (r.inputUsed > 100_000) warnings.push({ tone: "warm", text: "Over ~100k input tokens: quality on facts buried in the middle often drops, and latency and cost grow with every call." });

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Window">
            <Segmented label="Context window" value={win} onChange={setWin} options={WINDOWS.map((w) => ({ value: w, label: fmtTokens(w) }))} />
            <Slider label="Reserved for output" value={output} onChange={setOutput} min={256} max={32768} step={256} log format={(v) => `${fmtNum(v)} tok`} />
          </Group>
          <Group title="Always sent">
            <Slider label="System prompt" value={system} onChange={setSystem} min={0} max={20000} step={100} format={(v) => `${fmtNum(v)} tok`} />
            <Slider label="Tools (≈300 tok each)" value={tools} onChange={setTools} min={0} max={40} format={(v) => `${v} tools · ${fmtNum(v * 300)} tok`} />
            <Slider label="User message" value={user} onChange={setUser} min={10} max={8000} step={10} log format={(v) => `${fmtNum(v)} tok`} />
          </Group>
          <Group title="Can be trimmed">
            <Slider label="History turns" value={turns} onChange={setTurns} min={0} max={100} format={(v) => `${v} turns`} />
            <Slider label="Tokens per turn" value={perTurn} onChange={setPerTurn} min={50} max={2000} step={50} format={(v) => `${fmtNum(v)} tok`} />
            <Slider label="Retrieved chunks" value={chunks} onChange={setChunks} min={0} max={50} format={(v) => `${v} chunks`} />
            <Slider label="Chunk size" value={chunkSize} onChange={setChunkSize} min={128} max={2048} step={64} format={(v) => `${fmtNum(v)} tok`} />
          </Group>
          <Group title="Pricing (per 1M tokens)">
            <Slider label="Input" value={inPrice} onChange={setInPrice} min={0.05} max={20} step={0.05} log format={(v) => `$${v.toFixed(2)}`} />
            <Slider label="Output" value={outPrice} onChange={setOutPrice} min={0.2} max={80} step={0.1} log format={(v) => `$${v.toFixed(2)}`} />
            <Toggle label="Cache system + tools prefix" checked={cache} onChange={setCache} hint=" (cached reads ≈10% of input price; typical, check your provider)" />
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Window used" value={fmtPct(Math.min(fillPct, 9.99))} tone={r.fails ? "bad" : r.dropped ? "warm" : "good"} hint={`${fmtNum(r.inputUsed)} in + ${fmtNum(output)} out of ${fmtNum(win)}`} />
          <Readout label="Truncated" value={r.dropped ? fmtNum(r.dropped) : "0"} unit="tok" tone={r.droppedChunks ? "bad" : r.droppedTurns ? "warm" : "good"} hint={`${r.droppedTurns} turns, ${r.droppedChunks} chunks`} />
          <Readout label="Max cost per call" value={fmtUsd(cost)} hint={cache ? `without caching ${fmtUsd(costNoCache)}` : "if the full output reserve is used"} />
          <Readout label="Per 1k calls" value={fmtUsd(cost * 1000)} />
        </>
      }
      explain={
        <>
          <p>
            Of the {fmtNum(win)}-token window, {fmtNum(output)} are held back for the answer, leaving <b>{fmtNum(r.inputBudget)}</b> for input. The fixed parts (system, {tools} tools, user message) take {fmtNum(r.fixed)}; history wants {fmtNum(turns * perTurn)} and retrieval wants {fmtNum(chunks * chunkSize)}.
          </p>
          <p>
            {r.fails
              ? "Nothing can be trimmed far enough: shorten the system prompt or tool list, or reserve less output."
              : r.dropped
                ? `To fit, ${r.droppedTurns} old turn${r.droppedTurns === 1 ? "" : "s"} and ${r.droppedChunks} chunk${r.droppedChunks === 1 ? "" : "s"} are cut. Silent truncation like this is a common cause of "it forgot" and "it ignored the docs" bugs.`
                : `Everything fits with ${fmtNum(free)} tokens to spare.`}{" "}
            Each call costs up to {fmtUsd(cost)}; input is {fmtPct(((r.inputUsed - (cache ? system + toolTok : 0)) * inPrice + (cache ? (system + toolTok) * inPrice * 0.1 : 0)) / 1e6 / cost)} of it{cache ? ", with the cached prefix billed at the discounted rate" : ""}.
          </p>
        </>
      }
    >
      <div className="sim-tb">
        <div className="sim-row-between">
          <span className="sim-field-label">Context window · {fmtNum(win)} tokens</span>
          <span className={`sim-mono ${r.fails ? "bad" : "muted"}`}>{r.fails ? "rejected" : `${fmtNum(free)} free`}</span>
        </div>
        <StackBar
          ariaLabel="Context window split"
          total={Math.max(win, r.inputUsed + output)}
          height={40}
          segments={[
            { label: "System", value: system, color: C.system },
            { label: "Tools", value: toolTok, color: C.tools },
            { label: "User", value: user, color: C.user },
            { label: "History", value: r.fails ? 0 : histKept, color: C.history },
            { label: "Chunks", value: r.fails ? 0 : chunkKept, color: C.chunks },
            { label: "Free", value: free, color: "var(--panel-3)" },
            { label: "Output", value: output, color: C.output, striped: true },
          ]}
        />
        <Legend
          items={[
            { label: `System ${fmtTokens(system)}`, color: C.system },
            { label: `Tools ${fmtTokens(toolTok)}`, color: C.tools },
            { label: `User ${fmtTokens(user)}`, color: C.user },
            { label: `History ${fmtTokens(histKept)}`, color: C.history },
            { label: `Chunks ${fmtTokens(chunkKept)}`, color: C.chunks },
            { label: `Output reserve ${fmtTokens(output)}`, color: C.output, striped: true },
          ]}
        />
        <div className="sim-tb-groups">
          <div>
            <span className="sim-field-label">History, oldest → newest</span>
            <div className="sim-tb-cells">
              {Array.from({ length: turns }, (_, i) => {
                const dropped = i < r.droppedTurns;
                return <motion.span key={i} layout className={`sim-tb-cell${dropped ? " dropped" : ""}`} style={{ ["--c" as string]: C.history }} title={`turn ${i + 1}${dropped ? " (dropped)" : ""}`} />;
              })}
              {turns === 0 && <span className="muted small">none</span>}
            </div>
          </div>
          <div>
            <span className="sim-field-label">Retrieved chunks, by rank</span>
            <div className="sim-tb-cells">
              {Array.from({ length: chunks }, (_, i) => {
                const dropped = i >= r.keptChunks;
                return (
                  <motion.span key={i} layout className={`sim-tb-cell chunk${dropped ? " dropped" : ""}`} style={{ ["--c" as string]: C.chunks }} title={`chunk #${i + 1}${dropped ? " (dropped)" : ""}`}>
                    {i + 1}
                  </motion.span>
                );
              })}
              {chunks === 0 && <span className="muted small">none</span>}
            </div>
          </div>
        </div>
        <ul className="sim-warnings">
          {warnings.length === 0 && (
            <li className="good">
              <CheckCircle2 size={15} aria-hidden /> Everything fits, nothing is silently cut.
            </li>
          )}
          {warnings.map((w, i) => (
            <li key={i} className={w.tone}>
              {w.tone === "bad" ? <XCircle size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />} {w.text}
            </li>
          ))}
        </ul>
      </div>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "token-budget",
  title: "Context window budget",
  blurb: "Split a context window between system prompt, tools, history, retrieved chunks and output, and see what gets cut and what each call costs.",
  levels: [6, 2],
  realLife: REAL,
  Component: TokenBudgetSim,
};
