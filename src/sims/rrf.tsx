import { useState } from "react";
import { motion } from "motion/react";
import type { SimDef } from "./types";
import { Group, Readout, SimFrame, Slider } from "./ui";

/* ------------------------------------------------------------------ model
 * Reciprocal Rank Fusion (Cormack et al., 2009):  RRF(d) = sum over lists of 1 / (k + rank_list(d))
 * Ranks start at 1. A document missing from a list contributes nothing from that list.
 * Only ranks are used, so BM25 scores and cosine similarities never have to be put on the same scale.
 * Small k: the top of each list dominates. Large k (60 is the usual default): agreement across lists wins.
 */

export interface Fused {
  id: string;
  score: number;
  /** 1-based rank in each input list, or null if absent */
  ranks: (number | null)[];
}

export function rrf(lists: string[][], k = 60): Fused[] {
  const ids = new Set(lists.flat());
  const out: Fused[] = [...ids].map((id) => {
    const ranks = lists.map((l) => {
      const i = l.indexOf(id);
      return i < 0 ? null : i + 1;
    });
    const score = ranks.reduce<number>((a, r) => a + (r === null ? 0 : 1 / (k + r)), 0);
    return { id, score, ranks };
  });
  // ties: better best-rank first, then id for stability
  return out.sort((a, b) => b.score - a.score || Math.min(...a.ranks.map((r) => r ?? 1e9)) - Math.min(...b.ranks.map((r) => r ?? 1e9)) || a.id.localeCompare(b.id));
}

export const QUERY = "how do I rotate an API key without downtime?";

export const DOCS: Record<string, { title: string; good: boolean }> = {
  a: { title: "API key reference: create, list, revoke", good: false },
  b: { title: "Zero-downtime key rotation guide", good: true },
  c: { title: "Rotating secrets with two active keys", good: true },
  d: { title: "Changelog: API key prefix changed", good: false },
  e: { title: "Error 401: invalid API key", good: false },
  f: { title: "Credential hygiene and rotation schedules", good: true },
  g: { title: "Blue-green deploys for config changes", good: false },
  h: { title: "Rate limits per API key", good: false },
  i: { title: "Using a secrets manager with the SDK", good: true },
  j: { title: "Keeping services up during maintenance", good: false },
};

/** BM25 loves exact terms ("API key"); the vector index finds paraphrases ("secrets", "two active keys"). */
export const BM25 = ["a", "d", "e", "b", "h", "c", "f", "i"];
export const VECTOR = ["c", "g", "f", "j", "b", "i", "a", "e"];

/* ------------------------------------------------------------------ view */

const REAL = "Picking a restaurant from two friends' top-10 lists: a place that is #2 on one list and #3 on the other usually beats one that only a single friend ranked first.";

function RankList({ title, ids, hover, setHover, n }: { title: string; ids: string[]; hover: string | null; setHover: (s: string | null) => void; n: number }) {
  return (
    <div className="sim-rrf-col">
      <h4>{title}</h4>
      <ol>
        {ids.slice(0, n).map((id, i) => (
          <li key={id} className={`sim-rrf-item${hover === id ? " hover" : ""}${DOCS[id].good ? " good" : ""}`} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(id)} onBlur={() => setHover(null)} tabIndex={0}>
            <span className="sim-rrf-rank">{i + 1}</span>
            <span className="sim-rrf-title">{DOCS[id].title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RrfSim() {
  const [k, setK] = useState(60);
  const [depth, setDepth] = useState(8);
  const [hover, setHover] = useState<string | null>(null);
  const lists = [BM25.slice(0, depth), VECTOR.slice(0, depth)];
  const fused = rrf(lists, k);
  const top5 = fused.slice(0, 5);
  const goodInTop = (ids: string[]) => ids.slice(0, 5).filter((id) => DOCS[id].good).length;
  const max = fused[0]?.score ?? 1;
  const first = fused[0];
  const onlyOne = first && first.ranks.filter((r) => r !== null).length === 1;

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Fusion">
            <Slider label="k (smoothing constant)" value={k} onChange={setK} min={0} max={200} format={(v) => `${v}`} hint="60 is the common default from the original paper." />
            <Slider label="Results taken from each list" value={depth} onChange={setDepth} min={3} max={8} format={(v) => `top ${v}`} />
          </Group>
          <Group title="Query">
            <p className="sim-chunk-q">"{QUERY}"</p>
            <p className="sim-slider-hint">Documents that really answer it are marked with a green edge.</p>
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Relevant in BM25 top 5" value={`${goodInTop(BM25)}/5`} />
          <Readout label="Relevant in vector top 5" value={`${goodInTop(VECTOR)}/5`} />
          <Readout label="Relevant in fused top 5" value={`${goodInTop(top5.map((f) => f.id))}/5`} tone={goodInTop(top5.map((f) => f.id)) >= 4 ? "good" : "warm"} />
          <Readout label="#1 score" value={first ? first.score.toFixed(4) : "-"} hint={first ? first.ranks.map((r) => (r ? `1/(${k}+${r})` : "0")).join(" + ") : ""} />
        </>
      }
      explain={
        <>
          <p>
            Each document scores 1/(k + rank) from every list it appears in. With k = {k}, being #1 is worth {(1 / (k + 1)).toFixed(4)} and being #5 is worth {(1 / (k + 5)).toFixed(4)}: {k < 10 ? "a big gap, so the top of each list dominates." : "almost the same, so showing up in both lists matters more than topping one."}
          </p>
          <p>
            Right now "{DOCS[first.id].title}" wins {onlyOne ? "from a single list" : `by appearing in both lists (ranks ${first.ranks.join(" and ")})`}. BM25 alone ranks the keyword-heavy reference page first; vector search alone misses the exact "API key" pages. Fused, {goodInTop(top5.map((f) => f.id))} of the top 5 are documents that actually answer the question.
          </p>
        </>
      }
    >
      <div className="sim-rrf">
        <RankList title="BM25 (keywords)" ids={BM25} hover={hover} setHover={setHover} n={depth} />
        <RankList title="Vector (meaning)" ids={VECTOR} hover={hover} setHover={setHover} n={depth} />
        <div className="sim-rrf-col fused">
          <h4>Fused with RRF</h4>
          <ol>
            {fused.map((f, i) => (
              <motion.li
                key={f.id}
                layout
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                className={`sim-rrf-item${hover === f.id ? " hover" : ""}${DOCS[f.id].good ? " good" : ""}`}
                onMouseEnter={() => setHover(f.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(f.id)}
                onBlur={() => setHover(null)}
                tabIndex={0}
              >
                <span className="sim-rrf-rank">{i + 1}</span>
                <span className="sim-rrf-title">
                  {DOCS[f.id].title}
                  <span className="sim-rrf-parts">{f.ranks.map((r, li) => (r ? `${li === 0 ? "BM25" : "vec"} #${r}` : null)).filter(Boolean).join(" · ")}</span>
                </span>
                <span className="sim-rrf-score">
                  <motion.span className="sim-rrf-bar" initial={false} animate={{ width: `${(f.score / max) * 100}%` }} />
                  <span className="sim-mono">{f.score.toFixed(4)}</span>
                </span>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
      <p className="sim-note">Hover or focus a document to find it in every list. Try k = 0 and then k = 60: "Zero-downtime key rotation guide" (BM25 #4, vector #5) climbs past documents that only one list liked as k grows.</p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "rrf",
  title: "Reciprocal Rank Fusion",
  blurb: "Fuse a keyword (BM25) ranking and a vector ranking with RRF and watch the order change as you move k.",
  levels: [4, 9],
  realLife: REAL,
  Component: RrfSim,
};
