import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import type { SimDef } from "./types";
import { Group, Readout, SimFrame, Slider } from "./ui";
import { mulberry32 } from "./lib";

/* ------------------------------------------------------------------ model
 * The real pipeline, in miniature:
 *   text -> tokens (ids) -> embedding vectors -> N transformer layers (attention + MLP, added to a residual stream)
 *   -> logits over the vocabulary -> softmax(logits / temperature) -> top-p filter -> sample -> append -> repeat.
 * What is illustrative: the tokenizer (a few BPE-like rules, not a trained vocabulary), the embedding values and
 * attention weights (deterministic hashes, not learned), and the next-token logits (a small hand-written table keyed by
 * the last one or two tokens). What is exact: the softmax, temperature, top-p and sampling maths.
 */

/** softmax(logits / T). T <= 0 means greedy: all mass on the argmax. */
export function softmaxWithTemperature(logits: readonly number[], temperature: number): number[] {
  if (logits.length === 0) return [];
  if (temperature <= 0) {
    const best = logits.indexOf(Math.max(...logits));
    return logits.map((_, i) => (i === best ? 1 : 0));
  }
  const scaled = logits.map((l) => l / temperature);
  const m = Math.max(...scaled);
  const ex = scaled.map((s) => Math.exp(s - m)); // subtract the max for numerical stability
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

/** Nucleus (top-p) filtering: keep the smallest set of most-likely tokens whose total probability reaches p, renormalise. */
export function topPFilter(probs: readonly number[], p: number): { probs: number[]; kept: boolean[] } {
  const order = probs.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
  const kept = probs.map(() => false);
  let cum = 0;
  for (const i of order) {
    kept[i] = true;
    cum += probs[i];
    if (cum >= p - 1e-12) break;
  }
  const total = probs.reduce((a, v, i) => a + (kept[i] ? v : 0), 0);
  return { probs: probs.map((v, i) => (kept[i] ? v / total : 0)), kept };
}

/** Draw an index from a probability vector with a seeded RNG (inverse CDF). Same seed, same token. */
export function sampleSeeded(probs: readonly number[], seed: number): number {
  const r = mulberry32(seed)();
  let cum = 0;
  let last = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] <= 0) continue;
    last = i;
    cum += probs[i];
    if (r < cum) return i;
  }
  return last;
}

/** FNV-1a 32-bit hash, used for illustrative ids and vectors */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SUFFIXES = ["ing", "tion", "ness", "ed", "er", "ly", "est"];

/** Illustrative BPE-ish tokenizer: words keep their leading space, long words split into stem + common suffix, digits and punctuation stand alone. */
export function tokenize(text: string): string[] {
  const parts = text.match(/ ?[A-Za-z']+| ?\d|\n| {2,}|[^\sA-Za-z\d]/g) ?? [];
  const out: string[] = [];
  for (const p of parts) {
    const word = p.trim();
    if (/^[A-Za-z']+$/.test(word) && word.length > 7) {
      const lead = p.startsWith(" ") ? " " : "";
      const suf = SUFFIXES.find((s) => word.toLowerCase().endsWith(s) && word.length - s.length >= 3);
      let stem = suf ? word.slice(0, -suf.length) : word;
      const pieces: string[] = [];
      while (stem.length > 7) {
        pieces.push(stem.slice(0, 4));
        stem = stem.slice(4);
      }
      pieces.push(stem);
      if (suf) pieces.push(word.slice(-suf.length));
      pieces[0] = lead + pieces[0];
      out.push(...pieces);
    } else out.push(p);
  }
  return out;
}

export const tokenId = (t: string) => 100 + (fnv(t) % 50000);

export function embedding(t: string, dims = 16): number[] {
  const rng = mulberry32(fnv(t));
  return Array.from({ length: dims }, () => rng() * 2 - 1);
}

/** Causal attention weights of token q over tokens 0..q in layer l (illustrative: hashed affinities + recency + first-token "sink"). */
export function attentionWeights(tokens: string[], q: number, layer: number): number[] {
  const scores = tokens.slice(0, q + 1).map((t, j) => {
    const aff = (fnv(`${t}|${tokens[q]}|${layer}`) % 1000) / 1000;
    return 1.6 * aff + (j === q ? 0.6 : 0) + (q - j === 1 ? 0.9 : 0) + (j === 0 ? 0.7 : 0);
  });
  return softmaxWithTemperature(scores, 0.5);
}

const norm = (t: string) => (t.includes("\n") && !t.trim() ? "\\n" : t.trim().toLowerCase());

/** toy next-token table: keyed by "prev last" first, then "last" */
const NEXT: Record<string, [string, number][]> = {
  "france is": [[" Paris", 9], [" a", 5.4], [" the", 5], [" known", 4.6], [" located", 4.3], [" beautiful", 3.6], [" Lyon", 2.8], [" not", 2.4]],
  paris: [[".", 6.2], [",", 5.6], [" and", 4.2], [" which", 3.6], ["!", 2.8], [" (", 2.2]],
  ".": [[" It", 5.2], [" The", 4.9], ["\n", 4.4], [" This", 3.8], [" Paris", 3.4]],
  ",": [[" which", 5], [" and", 4.6], [" the", 4.1], [" a", 3.9], [" home", 3.2]],
  it: [[" is", 6], [" has", 5], [" was", 4.6], [" also", 4], ["'s", 3.8]],
  is: [[" a", 5.2], [" the", 5], [" known", 4.4], [" famous", 4], [" home", 3.6], [" also", 3.4]],
  a: [[" city", 5], [" beautiful", 4.6], [" place", 4.2], [" major", 3.8], [" popular", 3.5], [" small", 3]],
  the: [[" city", 4.8], [" capital", 4.6], [" largest", 4], [" home", 3.9], [" most", 3.6], [" world", 3.3]],
  city: [[" of", 5.4], [".", 5], [",", 4.4], [" that", 4.3], [" with", 4.1]],
  capital: [[" of", 6.5], [" city", 4.2], [".", 4], [",", 3.6]],
  of: [[" France", 5.2], [" the", 5], [" light", 4.2], [" love", 4], [" art", 3.8]],
  known: [[" for", 7], [" as", 6], [" to", 3.5], [" worldwide", 3]],
  for: [[" its", 6], [" the", 5.2], [" being", 4], [" art", 3.6], [" food", 3.4]],
  its: [[" art", 5], [" food", 4.8], [" history", 4.6], [" museums", 4.4], [" beauty", 4]],
  "upon a": [[" time", 9], [" midnight", 4], [" hill", 3.6], [" star", 3.2]],
  once: [[" upon", 9], [" more", 4.5], [" again", 3.8], [",", 3]],
  upon: [[" a", 9], [" the", 4], [" his", 2.5]],
  time: [[",", 6.4], [" there", 5.6], [" in", 4.4], [" a", 3.6], [".", 3]],
  "time ,": [[" there", 6.2], [" a", 5], [" in", 4.6], [" the", 4.4], [" long", 3]],
  there: [[" was", 6.8], [" lived", 6], [" were", 4.5], [" is", 3.5]],
  was: [[" a", 6.4], [" an", 4.8], [" the", 4], [" once", 3.2], [" no", 3]],
  lived: [[" a", 6], [" an", 5], [" two", 3.8], [" the", 3.5], [" in", 3.4]],
  food: [[" is", 7], [" was", 4.8], ["?", 3.5], [",", 3.2]],
  "food is": [[" pizza", 6], [" sushi", 5.6], [" pasta", 5.4], [" tacos", 5], [" chocolate", 4.8], [" probably", 4.2], [" anything", 3]],
  pizza: [[".", 5.5], [",", 5], [" because", 4.8], [" and", 4.6], ["!", 3.9]],
  sushi: [[".", 5.5], [",", 5], [" because", 4.8], [" and", 4.6], ["!", 3.9]],
  pasta: [[".", 5.5], [",", 5], [" because", 4.8], [" and", 4.6], ["!", 3.9]],
  tacos: [[".", 5.5], [",", 5], [" because", 4.8], [" and", 4.6], ["!", 3.9]],
  because: [[" it", 6], [" I", 5.4], [" they", 4], [" the", 3.8]],
  and: [[" I", 4.8], [" the", 4.6], [" it", 4.4], [" a", 4], [" pasta", 3]],
  i: [[" love", 5.5], [" think", 4.8], [" have", 4], [" can", 4.2], [" grew", 3.8]],
  love: [[" it", 5], [" the", 4.6], [" how", 4.2], [" eating", 4], [" cheese", 3.2]],
  ") :": [["\n", 7], [" return", 5], [" #", 3.6], [" pass", 3.4]],
  ": \\n": [["    return", 6.8], ["    result", 4.4], ["    #", 3.8], ["    pass", 3]],
  return: [[" a", 7], [" b", 4.2], [" sum", 4], [" (", 3.6], [" int", 2.8]],
  "return a": [[" +", 8], [" *", 3.2], [",", 3], ["\n", 2]],
  "+": [[" b", 8.5], [" 1", 4], [" a", 3], [" c", 2.4]],
  "+ b": [["\n", 6.5], [")", 4], [";", 3], [" #", 3]],
};
const FALLBACK: [string, number][] = [[" the", 3.5], [".", 3.4], [" and", 3.3], [",", 3], [" a", 3.1], [" it", 2.9]];

export function nextCandidates(tokens: string[]): [string, number][] {
  const n = tokens.length;
  const k2 = n >= 2 ? `${norm(tokens[n - 2])} ${norm(tokens[n - 1])}` : "";
  return NEXT[k2] ?? NEXT[norm(tokens[n - 1] ?? "")] ?? FALLBACK;
}

/* ------------------------------------------------------------------ view */

const REAL = "Predictive text on your phone, run in a loop: it suggests the likeliest next word, you accept one, and it suggests again using everything typed so far.";

const PROMPTS = ["The capital of France is", "Once upon a time", "My favourite food is", "def add(a, b):"];
const LAYERS = 4;
const MAX_NEW = 12;
const STAGES = ["Prompt", "Tokenize", "Embed", "Layers", "Logits", "Sample"];
const CHIP_C = ["var(--ph-retrieval)", "var(--ph-agentic)", "var(--ph-trust)", "var(--ai)", "var(--ph-production)", "var(--ph-frontier)"];

interface Phase {
  stage: number;
  layer: number;
  gen: string[];
  chosen: number | null;
}
const START: Phase = { stage: 0, layer: 0, gen: [], chosen: null };

const show = (t: string) => t.replace(/\n/g, "↵").replace(/^ /, "·").replace(/ {4}/g, "····");

function LlmAnatomySim() {
  const [prompt, setPrompt] = useState(PROMPTS[0]);
  const [ph, setPh] = useState<Phase>(START);
  const [temp, setTemp] = useState(0.8);
  const [topP, setTopP] = useState(0.9);
  const [seed, setSeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<number | null>(null);

  const promptToks = tokenize(prompt);
  const toks = [...promptToks, ...ph.gen];
  const n = toks.length;
  const q = sel !== null && sel < n ? sel : n - 1;
  const newTokenOnly = ph.gen.length > 0;
  const cands = nextCandidates(toks);
  const logits = cands.map((c) => c[1]);
  const raw = softmaxWithTemperature(logits, temp);
  const base = softmaxWithTemperature(logits, 1);
  const filt = topPFilter(raw, topP);
  const done = ph.gen.length >= MAX_NEW;
  const att = attentionWeights(toks, q, ph.stage === 3 ? ph.layer : LAYERS - 1);
  // the KV cache holds keys/values for every token that has been through the layers
  const kvTokens = ph.stage >= 3 ? n : newTokenOnly ? n - 1 : 0;

  const reset = (p = prompt) => {
    setPrompt(p);
    setPh(START);
    setSel(null);
    setPlaying(false);
  };

  const next = () => {
    setPh((s) => {
      if (s.stage === 0) return { ...s, stage: 1 };
      if (s.stage === 1) return { ...s, stage: 2 };
      if (s.stage === 2) return { ...s, stage: 3, layer: 0 };
      if (s.stage === 3) return s.layer < LAYERS - 1 ? { ...s, layer: s.layer + 1 } : { ...s, stage: 4 };
      if (s.stage === 4) return { ...s, stage: 5, chosen: sampleSeeded(filt.probs, seed * 1000 + s.gen.length) };
      // stage 5: append the sampled token and run the loop again for it
      if (s.gen.length >= MAX_NEW) return s;
      return { stage: 2, layer: 0, gen: [...s.gen, cands[s.chosen ?? 0][0]], chosen: null };
    });
    setSel(null);
  };

  useEffect(() => {
    if (!playing) return;
    if (done && ph.stage === 5) {
      setPlaying(false);
      return;
    }
    const ms = ph.stage === 3 ? 450 : ph.stage === 5 ? 1100 : 900;
    const id = setTimeout(next, ms);
    return () => clearTimeout(id);
  });

  const chosenTok = ph.chosen !== null ? cands[ph.chosen][0] : null;
  const keptCount = filt.kept.filter(Boolean).length;
  const top = raw.indexOf(Math.max(...raw));

  const narrate = [
    <>Pick or type a prompt. The model never sees letters; everything that follows works on numbers. Press Play or Step to send it through.</>,
    <>
      The illustrative tokenizer splits "{prompt}" into <b>{promptToks.length} tokens</b>. Each has an integer id from a fixed vocabulary (real tokenizers have 50k-200k entries). Common words are one token; rarer ones split into pieces; spaces usually ride along at the start of a word.
    </>,
    <>
      Each token id looks up a row in the embedding table: a vector (16 numbers here, 4,096+ in real models). {newTokenOnly ? `Only the new token "${show(toks[n - 1])}" needs looking up; the rest were done on earlier passes.` : `That gives ${n} vectors, one per token.`}
    </>,
    <>
      Layer {ph.layer + 1} of {LAYERS}: in attention, "{show(toks[q])}" looks back at earlier tokens (never forward) and mixes in what it finds, weighted by the line strength; its strongest link is "{show(toks[att.indexOf(Math.max(...att))])}" at {(Math.max(...att) * 100).toFixed(0)}%. The MLP then transforms each vector, and both add their result into the residual stream. {newTokenOnly ? `Earlier tokens' keys and values come from the KV cache (${n - 1} tokens reused), so only the new token is computed.` : ""}
    </>,
    <>
      The last token's final vector is projected onto the whole vocabulary to give one logit per token. The top {cands.length} are shown: "{show(cands[top][0])}" leads with {(raw[top] * 100).toFixed(0)}% at temperature {temp.toFixed(2)}. {temp < 0.5 ? "Low temperature sharpens the distribution towards the favourite." : temp > 1.2 ? "High temperature flattens it, giving unlikely tokens a real chance." : ""} Top-p {topP.toFixed(2)} keeps {keptCount} candidate{keptCount > 1 ? "s" : ""} and greys out the rest.
    </>,
    <>
      The seeded sampler drew <b>"{chosenTok ? show(chosenTok) : ""}"</b> (probability {ph.chosen !== null ? (filt.probs[ph.chosen] * 100).toFixed(0) : 0}% after filtering). It is appended and the whole loop runs again for the next token; that is autoregression. {done ? "That's the token limit for this demo; reset or pick another prompt." : "Change the seed to see a different but equally valid continuation."}
    </>,
  ][ph.stage];

  const dim = (stage: number) => (ph.stage < stage ? " dim" : ph.stage === stage ? " active" : "");

  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Prompt">
            <div className="sim-field">
              <label className="sim-field-label" htmlFor="llm-prompt">
                Type a prompt
              </label>
              <input id="llm-prompt" type="text" maxLength={48} value={prompt} onChange={(e) => reset(e.target.value)} />
            </div>
            <div className="sim-llm-prompts" role="group" aria-label="Example prompts">
              {PROMPTS.map((p) => (
                <button key={p} type="button" className={`btn small${p === prompt ? " primary" : ""}`} onClick={() => reset(p)}>
                  {p}
                </button>
              ))}
            </div>
          </Group>
          <Group title="Sampling">
            <Slider label="Temperature" value={temp} onChange={setTemp} min={0} max={2} step={0.05} format={(v) => (v === 0 ? "0 (greedy)" : v.toFixed(2))} />
            <Slider label="Top-p" value={topP} onChange={setTopP} min={0.1} max={1} step={0.01} format={(v) => v.toFixed(2)} />
            <Slider label="Random seed" value={seed} onChange={setSeed} min={1} max={50} />
          </Group>
        </>
      }
      toolbar={
        <>
          <button type="button" className="btn small primary" onClick={() => setPlaying(!playing)} disabled={done && ph.stage === 5}>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className="btn small" onClick={next} disabled={playing || (done && ph.stage === 5)}>
            <StepForward size={14} aria-hidden /> Step
          </button>
          <button type="button" className="btn small ghost" onClick={() => reset()}>
            <RotateCcw size={14} aria-hidden /> Reset
          </button>
          <ol className="sim-llm-stages" aria-label="Pipeline stage">
            {STAGES.map((s, i) => (
              <li key={s} className={i === ph.stage ? "on" : i < ph.stage ? "past" : ""} aria-current={i === ph.stage ? "step" : undefined}>
                {i + 1}. {s}
              </li>
            ))}
          </ol>
        </>
      }
      readouts={
        <>
          <Readout label="Tokens in context" value={ph.stage >= 1 ? n : "-"} hint={`${promptToks.length} prompt + ${ph.gen.length} generated`} />
          <Readout label="KV cache" value={kvTokens} unit="tokens" tone="accent" hint={`${kvTokens} × ${LAYERS} layers × 2 (K, V) = ${kvTokens * LAYERS * 2} vectors`} />
          <Readout label="Candidates kept" value={`${keptCount} / ${cands.length}`} hint={`top-p ${topP.toFixed(2)}, T ${temp.toFixed(2)}`} />
          <Readout label="Stage" value={STAGES[ph.stage]} hint={ph.stage === 3 ? `layer ${ph.layer + 1} of ${LAYERS}` : undefined} />
        </>
      }
      explain={<p>{narrate}</p>}
    >
      {/* text so far */}
      <div className="sim-llm-text" aria-live="polite">
        <span>{prompt}</span>
        <AnimatePresence>
          {ph.gen.map((g, i) => (
            <motion.span key={i} className="gen" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
              {g}
            </motion.span>
          ))}
        </AnimatePresence>
        {chosenTok && ph.stage === 5 && (
          <motion.span className="gen pending" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {chosenTok}
          </motion.span>
        )}
        <span className="sim-llm-caret" aria-hidden />
      </div>

      {/* 2-3: tokens + embeddings */}
      <section className={`sim-llm-sec${dim(1)}`}>
        <h4>Tokens · illustrative tokenizer {ph.stage >= 2 && "· embeddings"}</h4>
        <div className="sim-llm-chips">
          {(ph.stage >= 1 ? toks : []).map((t, i) => {
            const gen = i >= promptToks.length;
            return (
              <motion.button
                type="button"
                key={`${i}-${t}`}
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: ph.stage === 1 ? i * 0.04 : 0 }}
                className={`sim-llm-chip${gen ? " gen" : ""}${i === q ? " sel" : ""}`}
                style={{ ["--c" as string]: CHIP_C[i % CHIP_C.length] }}
                onClick={() => setSel(i)}
                aria-label={`token ${i + 1}: "${t}", id ${tokenId(t)}`}
                aria-pressed={i === q}
              >
                <span className="sim-llm-tok">{show(t)}</span>
                <span className="sim-llm-id">{tokenId(t)}</span>
                {ph.stage >= 2 && (
                  <span className="sim-llm-emb" aria-hidden>
                    {embedding(t).map((v, k) => (
                      <i key={k} style={{ background: `color-mix(in srgb, ${v >= 0 ? "var(--accent)" : "var(--warm)"} ${Math.round(Math.abs(v) * 100)}%, transparent)` }} />
                    ))}
                  </span>
                )}
              </motion.button>
            );
          })}
          {ph.stage < 1 && <span className="muted small">Tokens appear here.</span>}
        </div>
      </section>

      {/* 4: layers + attention */}
      <section className={`sim-llm-sec${dim(3)}`}>
        <h4>
          Transformer layers · attention from "{show(toks[q] ?? "")}" {ph.stage === 3 ? `(layer ${ph.layer + 1})` : ""} · click a token to change
        </h4>
        <div className="sim-llm-layers" aria-hidden>
          <span className="sim-llm-block emb">Embed</span>
          {Array.from({ length: LAYERS }, (_, l) => (
            <span key={l} className={`sim-llm-block${ph.stage === 3 && ph.layer === l ? " on" : ph.stage > 3 || (ph.stage === 3 && l < ph.layer) ? " done" : ""}`}>
              <b>L{l + 1}</b>
              <span>Attn</span>
              <span>MLP</span>
            </span>
          ))}
          <span className="sim-llm-block emb">Logits</span>
          <span className="sim-llm-residual">residual stream →</span>
        </div>
        {ph.stage >= 3 && <AttentionArcs toks={toks} q={q} weights={att} cached={newTokenOnly ? n - 1 : 0} onPick={setSel} />}
      </section>

      {/* 5-6: logits + sampling */}
      <section className={`sim-llm-sec${dim(4)}`}>
        <h4>Next-token distribution (toy logits table) · softmax(logit / T), top-p</h4>
        <ul className="sim-llm-bars">
          {cands.map(([t, l], i) => {
            const cut = !filt.kept[i];
            const chosen = ph.stage === 5 && ph.chosen === i;
            return (
              <li key={t} className={`${cut ? "cut" : ""}${chosen ? " chosen" : ""}`}>
                <span className="sim-llm-cand">{show(t)}</span>
                <span className="sim-llm-track">
                  <motion.span className="sim-llm-fill" initial={false} animate={{ width: `${(ph.stage >= 4 ? raw[i] : 0) * 100}%` }} transition={{ duration: 0.3 }} />
                  <span className="sim-llm-t1" style={{ left: `${base[i] * 100}%` }} title="probability at T = 1" />
                </span>
                <span className="sim-mono">{ph.stage >= 4 ? `${(raw[i] * 100).toFixed(1)}%` : "-"}</span>
                <span className="sim-mono muted">{l.toFixed(1)}</span>
              </li>
            );
          })}
        </ul>
        <p className="sim-note">Bars: probability at the current temperature. Tick: probability at T = 1. Right column: raw logit. Greyed rows fall outside top-p and can't be sampled.</p>
      </section>
    </SimFrame>
  );
}

function AttentionArcs({ toks, q, weights, cached, onPick }: { toks: string[]; q: number; weights: number[]; cached: number; onPick: (i: number) => void }) {
  const step = 62;
  const W = Math.max(600, toks.length * step + 20);
  const H = 120;
  const x = (i: number) => 30 + i * step;
  const base = 92;
  return (
    <div className="sim-llm-arcs">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.min(W, toks.length * 52 + 20) }} role="img" aria-label={`Attention weights from token ${q + 1}`}>
        {weights.map((w, j) => {
          if (j === q) return null;
          const h = Math.min(80, 18 + (q - j) * 12);
          return <motion.path key={`${q}-${j}`} d={`M${x(q)},${base - 12} C${x(q)},${base - 12 - h} ${x(j)},${base - 12 - h} ${x(j)},${base - 12}`} fill="none" stroke="var(--accent)" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4 }} strokeWidth={1 + w * 9} strokeOpacity={0.15 + w * 0.85} strokeLinecap="round" />;
        })}
        {toks.map((t, i) => (
          <g key={i} onClick={() => onPick(i)} style={{ cursor: "pointer" }}>
            <rect x={x(i) - 27} y={base - 10} width={54} height={22} rx={6} className={`sim-llm-arc-tok${i === q ? " sel" : ""}${i < cached ? " cached" : ""}${i > q ? " future" : ""}`} />
            <text x={x(i)} y={base + 1} dy="0.32em" textAnchor="middle" className="sim-llm-arc-label">
              {show(t).slice(0, 7)}
            </text>
            {i <= q && i !== q && (
              <text x={x(i)} y={base + 24} textAnchor="middle" className="sim-chart-tick">
                {(weights[i] * 100).toFixed(0)}%
              </text>
            )}
          </g>
        ))}
      </svg>
      {cached > 0 && <p className="sim-note">Dashed tokens: keys and values read from the KV cache, not recomputed.</p>}
    </div>
  );
}

export const def: SimDef = {
  id: "llm-anatomy",
  title: "How an LLM produces text",
  blurb: "Step a prompt through tokenizer, embeddings, transformer layers, logits and sampling, and watch the loop add one token at a time.",
  levels: [1],
  realLife: REAL,
  Component: LlmAnatomySim,
};
