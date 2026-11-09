import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SimDef } from "./types";
import { Group, Legend, Readout, Segmented, Select, SimFrame, Slider } from "./ui";

/* ------------------------------------------------------------------ model
 * Real embeddings have hundreds of dimensions; here each sentence gets a hand-placed 2-D vector so you can see it.
 * Direction = meaning (topics sit at different angles). Length = how "strong" the vector is, which in real models
 * often tracks things like text length or frequency rather than relevance.
 *   cosine(a, b)    = a.b / (|a| |b|)       direction only
 *   dot(a, b)       = a.b                   direction x length: long vectors win
 *   euclidean(a, b) = |a - b|               smaller is closer; length differences count against you
 * Keyword match counts exact shared tokens (no stemming), like the core of BM25 without the weighting.
 */

export type Vec = [number, number];
export type Metric = "cosine" | "dot" | "euclidean";

export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
export const norm = (a: Vec) => Math.hypot(a[0], a[1]);
export const cosine = (a: Vec, b: Vec) => dot(a, b) / (norm(a) * norm(b) || 1);
export const euclidean = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function score(metric: Metric, q: Vec, d: Vec): number {
  return metric === "cosine" ? cosine(q, d) : metric === "dot" ? dot(q, d) : euclidean(q, d);
}

/** Indices of the k best documents (highest similarity, or lowest distance for euclidean). */
export function topK(metric: Metric, q: Vec, docs: Vec[], k: number): number[] {
  const idx = docs.map((_, i) => i);
  idx.sort((a, b) => (metric === "euclidean" ? score(metric, q, docs[a]) - score(metric, q, docs[b]) : score(metric, q, docs[b]) - score(metric, q, docs[a])));
  return idx.slice(0, k);
}

const STOP = new Set("a an the to of in on for and or is are was be my your you i we our it its with from by at can do does will when what how why if this that any after will want get into".split(" "));
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** number of distinct query tokens that appear verbatim in the text */
export function keywordScore(query: string, text: string): number {
  const doc = new Set(tokens(text));
  return new Set(tokens(query).filter((t) => doc.has(t))).size;
}

const polar = (deg: number, r: number): Vec => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];

type Topic = "billing" | "account" | "shipping" | "router" | "other";
export const DOCS: { text: string; topic: Topic; v: Vec }[] = [
  { text: "Refunds are paid to the original payment method within 5 business days.", topic: "billing", v: polar(25, 1.0) },
  { text: "You can return any item within 30 days for a full refund.", topic: "billing", v: polar(35, 1.1) },
  { text: "Opened electronics carry a 15% restocking fee.", topic: "billing", v: polar(48, 0.8) },
  { text: "Invoices can be downloaded from the Billing page.", topic: "billing", v: polar(62, 0.9) },
  { text: "Charged twice? Contact support and we will reverse the duplicate payment.", topic: "billing", v: polar(18, 1.35) },
  { text: "Reset your password from the sign-in page with 'Forgot password'.", topic: "account", v: polar(104, 1.0) },
  { text: "Two-factor codes expire after 30 seconds.", topic: "account", v: polar(122, 0.85) },
  { text: "Accounts lock after five failed login attempts.", topic: "account", v: polar(98, 1.2) },
  { text: "Change the email address on your profile settings page.", topic: "account", v: polar(136, 0.8) },
  { text: "Standard shipping takes 3-5 business days.", topic: "shipping", v: polar(196, 1.0) },
  { text: "Track your parcel with the link in your confirmation email.", topic: "shipping", v: polar(212, 1.1) },
  { text: "We ship to 40 countries; the recipient pays customs fees.", topic: "shipping", v: polar(184, 0.9) },
  { text: "Express delivery arrives the next business day if ordered before 2pm.", topic: "shipping", v: polar(204, 1.4) },
  { text: "If your router won't connect, restart it and check the cables.", topic: "router", v: polar(286, 1.1) },
  { text: "The XR-200 status light blinks orange during a firmware update.", topic: "router", v: polar(300, 0.9) },
  { text: "Firmware 3.1 for the XR-200 fixes error E-4012 on boot.", topic: "router", v: polar(320, 0.6) },
  { text: "Factory reset: hold the reset button for 10 seconds.", topic: "router", v: polar(274, 1.0) },
  { text: "Wi-Fi keeps dropping? Move the router away from the microwave.", topic: "router", v: polar(262, 1.2) },
  { text: "Our office is closed on public holidays.", topic: "other", v: polar(160, 0.5) },
  { text: "We are hiring support engineers in Berlin.", topic: "other", v: polar(238, 0.45) },
];

export const QUERIES: { id: string; text: string; v: Vec; note: string }[] = [
  { id: "money", text: "I want my money back", v: polar(30, 1.0), note: "No words in common with the refund docs, yet the meaning is the same: vectors find them, keywords cannot." },
  { id: "login", text: "can't get into my account", v: polar(108, 1.0), note: "'account' does not match 'Accounts' exactly; keyword search without stemming misses it." },
  { id: "arrive", text: "when will my order arrive?", v: polar(200, 1.0), note: "'arrive' vs 'arrives': close in meaning, different strings." },
  { id: "code", text: "error E-4012 on XR-200", v: polar(290, 1.0), note: "The keyword failure case in reverse: exact product codes are rare tokens embeddings blur together, so the one doc with the fix ranks low by vector but first by keyword." },
  { id: "wifi", text: "router keeps disconnecting", v: polar(272, 0.95), note: "Generic troubleshooting: vectors and keywords agree on the router cluster." },
];

/* ------------------------------------------------------------------ view */

const REAL = "Finding a book in a library by topic shelf versus searching the catalogue for an exact title: the shelf finds books on the same subject with different titles, the catalogue finds the exact code you typed.";

const TOPIC_C: Record<Topic, string> = { billing: "var(--ph-trust)", account: "var(--ai)", shipping: "var(--ph-retrieval)", router: "var(--ph-agentic)", other: "var(--faint)" };

function SimilaritySim() {
  const [qid, setQid] = useState("money");
  const [metric, setMetric] = useState<Metric>("cosine");
  const [k, setK] = useState(3);
  const q = QUERIES.find((x) => x.id === qid)!;
  const vecs = DOCS.map((d) => d.v);
  const top = topK(metric, q.v, vecs, k);
  const kw = DOCS.map((d, i) => ({ i, s: keywordScore(q.text, d.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const qTok = tokens(q.text);
  const overlap = top.filter((i) => kw.some((x) => x.i === i)).length;
  const cosTop = topK("cosine", q.v, vecs, k);
  const metricChanged = top.some((i) => !cosTop.includes(i));

  const S = 300;
  const R = 1.55;
  const px = (v: Vec): [number, number] => [S / 2 + (v[0] / R) * (S / 2 - 10), S / 2 - (v[1] / R) * (S / 2 - 10)];
  const [qx, qy] = px(q.v);
  const fmtScore = (i: number) => {
    const s = score(metric, q.v, vecs[i]);
    return metric === "euclidean" ? `dist ${s.toFixed(2)}` : s.toFixed(2);
  };

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Query">
            <Select label="Search for" value={qid} onChange={setQid} options={QUERIES.map((x) => ({ value: x.id, label: `"${x.text}"` }))} />
          </Group>
          <Group title="Vector search">
            <Segmented
              label="Similarity metric"
              value={metric}
              onChange={setMetric}
              options={[
                { value: "cosine", label: "Cosine" },
                { value: "dot", label: "Dot" },
                { value: "euclidean", label: "Euclidean" },
              ]}
            />
            <Slider label="Top-k" value={k} onChange={setK} min={1} max={6} />
          </Group>
          <Legend items={(Object.keys(TOPIC_C) as Topic[]).map((t) => ({ label: t, color: TOPIC_C[t] }))} />
        </>
      }
      readouts={
        <>
          <Readout label={`Vector top-${k} (${metric})`} value={`${top.filter((i) => DOCS[i].topic === DOCS[top[0]].topic).length}/${k}`} unit="same topic" />
          <Readout label="Keyword hits" value={kw.length} unit={`of ${k}`} tone={kw.length === 0 ? "bad" : "neutral"} hint={`query tokens: ${qTok.join(", ")}`} />
          <Readout label="Both agree on" value={overlap} unit="docs" tone={overlap === 0 ? "warm" : "good"} hint="the case for hybrid search" />
        </>
      }
      explain={
        <>
          <p>
            The query "{q.text}" points at {Math.round((Math.atan2(q.v[1], q.v[0]) * 180) / Math.PI + 360) % 360}°. With <b>{metric}</b>, the closest {k} are highlighted with lines.{" "}
            {metric === "cosine"
              ? "Cosine only looks at direction, so short and long documents compete fairly."
              : metric === "dot"
                ? `Dot product multiplies by length, so long vectors get a boost${metricChanged ? ": notice it pulled in a different document than cosine would" : ""}. Most embedding models normalise vectors, which makes dot and cosine identical.`
                : `Euclidean distance also punishes length differences${metricChanged ? ", so it disagrees with cosine here" : ""}; on normalised vectors it ranks exactly like cosine.`}
          </p>
          <p>{q.note}</p>
        </>
      }
    >
      <div className="sim-sim">
        <svg viewBox={`0 0 ${S} ${S}`} className="sim-sim-plot" role="img" aria-label={`2-D embedding map with the query "${q.text}" and its top ${k} neighbours`}>
          <circle cx={S / 2} cy={S / 2} r={(1 / R) * (S / 2 - 10)} className="sim-sim-unit" />
          <line x1={10} x2={S - 10} y1={S / 2} y2={S / 2} className="sim-chart-grid" />
          <line y1={10} y2={S - 10} x1={S / 2} x2={S / 2} className="sim-chart-grid" />
          {top.map((i, rank) => {
            const [x, y] = px(vecs[i]);
            return <motion.line key={`l${i}`} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 0.35, delay: rank * 0.05 }} x1={metric === "euclidean" ? qx : S / 2} y1={metric === "euclidean" ? qy : S / 2} x2={x} y2={y} className="sim-sim-link" />;
          })}
          <motion.line initial={false} animate={{ x2: qx, y2: qy }} x1={S / 2} y1={S / 2} className="sim-sim-qline" />
          {DOCS.map((d, i) => {
            const [x, y] = px(d.v);
            const hit = top.includes(i);
            const kwHit = kw.some((z) => z.i === i);
            return (
              <g key={i}>
                {kwHit && <rect x={x - 8} y={y - 8} width={16} height={16} rx={3} className="sim-sim-kw" />}
                <motion.circle cx={x} cy={y} initial={false} animate={{ r: hit ? 7 : 4.5 }} fill={TOPIC_C[d.topic]} stroke={hit ? "var(--text)" : "var(--panel)"} strokeWidth={hit ? 2 : 1.5}>
                  <title>{d.text}</title>
                </motion.circle>
                {hit && (
                  <text x={x + 9} y={y - 7} className="sim-sim-rank">
                    {top.indexOf(i) + 1}
                  </text>
                )}
              </g>
            );
          })}
          <motion.g initial={false} animate={{ x: qx, y: qy }}>
            <path d="M0,-9 L2.6,-2.6 L9,0 L2.6,2.6 L0,9 L-2.6,2.6 L-9,0 L-2.6,-2.6 Z" className="sim-sim-query" />
          </motion.g>
        </svg>
        <div className="sim-sim-lists">
          <div>
            <h4>Vector top-{k}</h4>
            <ol className="sim-sim-list">
              <AnimatePresence initial={false}>
                {top.map((i) => (
                  <motion.li key={i} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} style={{ ["--c" as string]: TOPIC_C[DOCS[i].topic] }}>
                    <span className="sim-sim-text">{DOCS[i].text}</span>
                    <span className="sim-mono">{fmtScore(i)}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>
          <div>
            <h4>Keyword match (exact tokens)</h4>
            {kw.length === 0 ? (
              <p className="sim-note bad">No document shares a word with the query. Pure keyword search returns nothing useful.</p>
            ) : (
              <ol className="sim-sim-list">
                {kw.map(({ i, s }) => (
                  <li key={i} style={{ ["--c" as string]: TOPIC_C[DOCS[i].topic] }}>
                    <span className="sim-sim-text">{DOCS[i].text}</span>
                    <span className="sim-mono">
                      {s} word{s > 1 ? "s" : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
      <p className="sim-note">Points are hand-placed in 2-D to illustrate; real embeddings have hundreds of dimensions. The dashed circle is length 1 (a normalised vector). Squares mark keyword hits.</p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "similarity",
  title: "Embedding similarity",
  blurb: "Pick a query and compare cosine, dot product and Euclidean search on a 2-D map of sentences, next to plain keyword matching.",
  levels: [4],
  realLife: REAL,
  Component: SimilaritySim,
};
