import { useState } from "react";
import type { SimDef } from "./types";
import { Group, Note, Readout, SimFrame, type Tone } from "./ui";

/* ------------------------------------------------------------------ model
 * The RAG metrics, computed from the labels you set below.
 *   faithfulness       supported answer claims / all answer claims
 *   context precision  mean of precision@k over the ranks where a relevant chunk appears (order matters)
 *   context recall     reference claims found in the retrieved context / all reference claims
 *   answer relevancy   is judged by a model in real tools; here you set it with a toggle
 */

export const faithfulness = (supported: boolean[]): number => (supported.length ? supported.filter(Boolean).length / supported.length : 0);

export function contextPrecision(relevant: boolean[]): number {
  let hits = 0;
  let total = 0;
  relevant.forEach((rel, i) => {
    if (rel) {
      hits += 1;
      total += hits / (i + 1);
    }
  });
  return hits ? total / hits : 0;
}

export const contextRecall = (found: boolean[]): number => (found.length ? found.filter(Boolean).length / found.length : 0);

export interface Diagnosis {
  tone: Tone;
  text: string;
}

/** read the three computed metrics (plus the relevancy toggle) the way the lesson's table does */
export function diagnose(f: number, p: number, r: number, relevant: boolean): Diagnosis {
  const lo = 0.7;
  if (!relevant) return { tone: "bad", text: "The answer does not address the question: fix the prompt or the query understanding, whatever the other scores say." };
  if (r < lo && f >= lo) return { tone: "warm", text: "The evidence was not retrieved, and the model stayed faithful to what it had. Improve chunking, hybrid search or query rewriting." };
  if (r < lo) return { tone: "bad", text: "Evidence is missing and the answer also goes beyond its context. Fix retrieval first, then tighten the grounding prompt." };
  if (f < lo && p >= lo) return { tone: "warm", text: "The context was good but the model added claims it could not support. Tighten the grounding prompt or lower the temperature." };
  if (f < lo) return { tone: "bad", text: "Unsupported claims and noisy context together: add a reranker and a stricter grounding prompt." };
  if (p < lo) return { tone: "warm", text: "The right chunk was retrieved but buried. Add reranking or lower top-k so noise does not crowd it out." };
  return { tone: "good", text: "All three signals are healthy for this question." };
}

interface Chunk {
  id: string;
  title: string;
  relevant: boolean;
}

const CLAIMS0 = [
  { text: "Laptops can be returned within 15 days.", supported: true },
  { text: "A 10% fee applies if the box was opened.", supported: true },
  { text: "Returns are free of shipping charges.", supported: false },
];
const CHUNKS0: Chunk[] = [
  { id: "a", title: "Shipping times by city", relevant: false },
  { id: "b", title: "Returns policy for electronics (15 days; opened items 10% fee)", relevant: true },
  { id: "c", title: "Warranty terms", relevant: false },
];
const REF0 = [
  { text: "Laptops can be returned within 15 days.", found: true },
  { text: "Opened items incur a 10% restocking fee.", found: true },
];

const REAL = "Marking an open-book exam: are the statements on the pages the student brought, were the useful pages on top of the pile, and did they bring every page needed?";
const pct = (v: number) => v.toFixed(2);
const toneOf = (v: number): Tone => (v >= 0.8 ? "good" : v >= 0.6 ? "warm" : "bad");

function RagMetricsSim() {
  const [claims, setClaims] = useState(CLAIMS0);
  const [chunks, setChunks] = useState(CHUNKS0);
  const [ref, setRef] = useState(REF0);
  const [relevantAnswer, setRelevantAnswer] = useState(true);

  const f = faithfulness(claims.map((c) => c.supported));
  const p = contextPrecision(chunks.map((c) => c.relevant));
  const r = contextRecall(ref.map((c) => c.found));
  const d = diagnose(f, p, r, relevantAnswer);

  const up = (i: number) => i > 0 && setChunks((cs) => cs.map((c, j) => (j === i - 1 ? cs[i] : j === i ? cs[i - 1] : c)));
  const flip = <T extends object>(set: (fn: (x: T[]) => T[]) => void, i: number, key: keyof T) => set((xs) => xs.map((x, j) => (j === i ? { ...x, [key]: !x[key] } : x)));

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="The question">
            <p className="sim-chunk-q">"What is the refund window for laptops, and is a fee charged?"</p>
            <label className="sim-toggle">
              <input type="checkbox" className="switch" checked={relevantAnswer} onChange={(e) => setRelevantAnswer(e.target.checked)} />
              <span>The answer addresses the question (answer relevancy)</span>
            </label>
          </Group>
          <Group title="Answer claims">
            {claims.map((c, i) => (
              <label key={c.text} className="sim-toggle">
                <input type="checkbox" checked={c.supported} onChange={() => flip(setClaims, i, "supported")} />
                <span>{c.text}</span>
              </label>
            ))}
            <p className="sim-slider-hint">Tick a claim when the retrieved context supports it.</p>
          </Group>
          <Group title="Reference answer">
            {ref.map((c, i) => (
              <label key={c.text} className="sim-toggle">
                <input type="checkbox" checked={c.found} onChange={() => flip(setRef, i, "found")} />
                <span>{c.text}</span>
              </label>
            ))}
            <p className="sim-slider-hint">Tick a claim when it can be found in the retrieved chunks.</p>
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Faithfulness" value={pct(f)} tone={toneOf(f)} hint={`${claims.filter((c) => c.supported).length} of ${claims.length} claims supported`} />
          <Readout label="Context precision" value={pct(p)} tone={toneOf(p)} hint="Depends on the order of chunks" />
          <Readout label="Context recall" value={pct(r)} tone={toneOf(r)} hint={`${ref.filter((c) => c.found).length} of ${ref.length} reference claims found`} />
          <Readout label="Answer relevancy" value={relevantAnswer ? "high" : "low"} tone={relevantAnswer ? "good" : "bad"} />
        </>
      }
      explain={
        <>
          <p>{d.text}</p>
          <p>
            Faithfulness only looks at the answer and the context. Context precision looks at the order of the retrieved chunks, and context recall at the reference answer, so a faithful answer can still score badly if the evidence was never retrieved.
          </p>
        </>
      }
    >
      <div>
        <h4 className="sim-row-between">
          <span>Retrieved chunks, in rank order</span>
          <span className="sim-mono">tick = relevant · use ↑ to reorder</span>
        </h4>
        <ol className="sim-rrf-col" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {chunks.map((c, i) => (
            <li key={c.id} className={`sim-rrf-item${c.relevant ? " good" : ""}`}>
              <span className="sim-rrf-rank">{i + 1}</span>
              <label className="sim-rrf-title" style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center", cursor: "pointer", textAlign: "left" }}>
                <input type="checkbox" checked={c.relevant} onChange={() => flip(setChunks, i, "relevant")} />
                {c.title}
              </label>
              <button type="button" className="btn small ghost" onClick={() => up(i)} disabled={i === 0} aria-label={`Move chunk ${i + 1} up`}>
                ↑
              </button>
            </li>
          ))}
        </ol>
      </div>
      <Note>Move the returns policy to rank 1 and context precision rises from 0.50 to 1.00 without changing anything else. Untick the fee claim in the reference list to see recall fall.</Note>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "rag-metrics",
  title: "RAG metrics: faithfulness, precision, recall",
  blurb: "Tick which claims are supported, which chunks are relevant and which reference claims were retrieved, and read the scores and the likely fault.",
  levels: [7],
  realLife: REAL,
  Component: RagMetricsSim,
};
