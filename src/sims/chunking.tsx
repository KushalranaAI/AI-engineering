import { Fragment, useMemo, useState } from "react";
import { CheckCircle2, Scissors } from "lucide-react";
import type { SimDef } from "./types";
import { Group, Readout, Segmented, SimFrame, Slider } from "./ui";
import { fmtNum } from "./lib";

/* ------------------------------------------------------------------ model
 * Sizes are counted in words to keep it readable (1 word ~ 1.3 tokens for English).
 *  - fixed:     cut every `size` words; the next chunk starts `size - overlap` words later.
 *  - recursive: try the biggest natural boundary first (paragraph), fall back to sentences, then words,
 *               and greedily merge neighbouring pieces while they fit (the LangChain RecursiveCharacterTextSplitter idea).
 *  - heading:   one chunk per section; a section bigger than `size` is split recursively inside the section.
 * Overlap: each chunk after the first also takes the previous `overlap` words (never across a heading for "heading").
 */

const DOC = `# Returns and refunds policy

## Overview
This policy explains how returns, exchanges and refunds work for orders placed on the Acme online store or in one of our retail shops. It applies to every product we sell unless a product page says otherwise. Marketplace items sold by third-party sellers follow the seller's own policy, which is linked from the order confirmation. If anything here conflicts with your local consumer law, the law wins and we will follow it.

## Return window
You can return most items within 30 days of delivery for a full refund. The 30 days start on the day the carrier marks the parcel as delivered, not the day you placed the order. Items bought during the holiday season, from 1 November to 24 December, can be returned until 31 January of the following year. Gift recipients can return an item for store credit using the gift receipt.

## Opened and used items
Unopened items in their original packaging are always eligible for a full refund. [[Opened electronics, including laptops, tablets and headphones, can be returned within 14 days instead of 30. A restocking fee of 15% of the purchase price is deducted from the refund unless the item is faulty.]] Software, gift cards and personal care products cannot be returned once the seal is broken. Clothing must be unworn, with the tags still attached.

## Faulty or damaged items
If an item arrives damaged or stops working within the first year, it is covered by our warranty. Contact support with your order number and a photo or short video of the problem. We will send a prepaid return label, and you can choose a replacement, a repair or a full refund. Faulty items are never charged a restocking fee, and the 14-day limit for opened electronics does not apply to them.

## How to start a return
Sign in to your account, open Orders, and choose Return next to the item. Pick a reason, select drop-off or courier collection, and print the label or show the QR code at a drop-off point. Pack the item securely, ideally in its original box, and include all accessories and manuals. Returns without a label can take several weeks to identify, so please always use the one we provide.

## Refund timing
Once the warehouse receives your return, we inspect it within three business days. Approved refunds go back to the original payment method. Card refunds usually appear within five business days, but some banks take up to ten. Store credit is available immediately after approval. You will receive an email at each step, and the status is always visible on the order page.

## Exchanges
If you want a different size or colour, the quickest option is to return the original item for a refund and place a new order. This guarantees the new item is reserved for you while the return is in transit. Price differences are handled automatically through the separate refund and order.

## Contact
Our support team is available every day from 8am to 8pm by chat and email. Response times are usually under two hours. For questions about a specific return, have your order number ready so we can help you faster.`;

export const QUESTION = "Can I return a laptop I've opened, and will I be charged for it?";

export interface Word {
  w: string;
  block: number;
  heading: 0 | 1 | 2;
  section: number;
  sentence: number;
  answer: boolean;
}

export type Range = [number, number];

export function parseDoc(src: string = DOC): Word[] {
  const words: Word[] = [];
  let section = -1;
  let sentence = 0;
  let inAnswer = false;
  src.split(/\n/).forEach((line, block) => {
    const t = line.trim();
    if (!t) return;
    const h = t.startsWith("## ") ? 2 : t.startsWith("# ") ? 1 : 0;
    if (h) section++;
    if (section < 0) section = 0;
    const body = h ? t.replace(/^#+\s*/, "") : t;
    sentence++;
    for (let raw of body.split(/\s+/)) {
      if (raw.startsWith("[[")) {
        inAnswer = true;
        raw = raw.slice(2);
      }
      let closes = false;
      if (raw.endsWith("]]")) {
        closes = true;
        raw = raw.slice(0, -2);
      }
      words.push({ w: raw, block, heading: h, section, sentence, answer: inAnswer });
      if (closes) inAnswer = false;
      if (!h && /[.!?]$/.test(raw)) sentence++;
    }
  });
  return words;
}

/** group consecutive word indices in [lo, hi) by a key */
function groupBy(words: Word[], [lo, hi]: Range, key: (w: Word) => number): Range[] {
  const out: Range[] = [];
  let s = lo;
  for (let i = lo + 1; i <= hi; i++) {
    if (i === hi || key(words[i]) !== key(words[i - 1])) {
      out.push([s, i]);
      s = i;
    }
  }
  return out;
}

export function chunkFixed(n: number, size: number, overlap: number): Range[] {
  const out: Range[] = [];
  const stride = Math.max(1, size - overlap);
  for (let s = 0; s < n; s += stride) {
    const e = Math.min(n, s + size);
    out.push([s, e]);
    if (e === n) break;
  }
  return out;
}

const LEVELS: ((w: Word) => number)[] = [(w) => w.block, (w) => w.sentence];

function recursiveSplit(words: Word[], range: Range, size: number, level: number): Range[] {
  if (range[1] - range[0] <= size) return [range];
  if (level >= LEVELS.length) return chunkFixed(range[1] - range[0], size, 0).map(([a, b]) => [a + range[0], b + range[0]] as Range);
  const pieces = groupBy(words, range, LEVELS[level]);
  const out: Range[] = [];
  let cur: Range | null = null;
  for (const p of pieces) {
    if (p[1] - p[0] > size) {
      if (cur) out.push(cur);
      cur = null;
      out.push(...recursiveSplit(words, p, size, level + 1));
    } else if (cur && p[1] - cur[0] <= size) {
      cur = [cur[0], p[1]];
    } else {
      if (cur) out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function addOverlap(chunks: Range[], overlap: number, floor?: (start: number) => number): Range[] {
  if (overlap <= 0) return chunks;
  return chunks.map(([s, e], i) => {
    if (i === 0) return [s, e];
    const min = Math.max(chunks[i - 1][0] + 1, floor ? floor(s) : 0);
    return [Math.max(min, s - overlap), e];
  });
}

export function chunkRecursive(words: Word[], size: number, overlap: number): Range[] {
  return addOverlap(recursiveSplit(words, [0, words.length], size, 0), overlap);
}

export function chunkByHeading(words: Word[], size: number, overlap: number): Range[] {
  const sections = groupBy(words, [0, words.length], (w) => w.section);
  const base = sections.flatMap((r) => recursiveSplit(words, r, size, 0));
  const sectionStart = (i: number) => sections.find(([a, b]) => i >= a && i < b)![0];
  return addOverlap(base, overlap, sectionStart);
}

export type Strategy = "fixed" | "recursive" | "heading";

export function chunk(words: Word[], strategy: Strategy, size: number, overlap: number): Range[] {
  if (strategy === "fixed") return chunkFixed(words.length, size, overlap);
  if (strategy === "recursive") return chunkRecursive(words, size, overlap);
  return chunkByHeading(words, size, overlap);
}

/** Where does an answer span land? intact = some chunk fully contains it. */
export function answerCoverage(chunks: Range[], span: Range): { intact: number[]; touching: number[]; bestShare: number } {
  const len = span[1] - span[0];
  const intact: number[] = [];
  const touching: number[] = [];
  let best = 0;
  chunks.forEach(([s, e], i) => {
    const inter = Math.max(0, Math.min(e, span[1]) - Math.max(s, span[0]));
    if (inter > 0) touching.push(i);
    if (s <= span[0] && e >= span[1]) intact.push(i);
    best = Math.max(best, inter / len);
  });
  return { intact, touching, bestShare: best };
}

/* ------------------------------------------------------------------ view */

const REAL = "Cutting a recipe book into index cards: cut every 10 lines and an ingredient list ends up split from its method; cut at each recipe title and every card makes sense on its own.";

const CC = ["var(--ph-retrieval)", "var(--ph-agentic)", "var(--ph-trust)", "var(--ai)", "var(--ph-production)", "var(--ph-frontier)"];

function ChunkingSim() {
  const words = useMemo(() => parseDoc(), []);
  const [strategy, setStrategy] = useState<Strategy>("fixed");
  const [size, setSize] = useState(60);
  const [overlap, setOverlap] = useState(0);
  const ov = Math.min(overlap, size - 10);
  const chunks = useMemo(() => chunk(words, strategy, size, ov), [words, strategy, size, ov]);
  const span: Range = [words.findIndex((w) => w.answer), words.length - [...words].reverse().findIndex((w) => w.answer)];
  const cov = answerCoverage(chunks, span);

  const owner = new Array<number>(words.length).fill(-1);
  const count = new Array<number>(words.length).fill(0);
  chunks.forEach(([s, e], c) => {
    for (let i = s; i < e; i++) {
      if (owner[i] < 0) owner[i] = c;
      count[i]++;
    }
  });
  const starts = new Map<number, number[]>();
  chunks.forEach(([s], c) => starts.set(s, [...(starts.get(s) ?? []), c]));
  const avg = chunks.reduce((a, [s, e]) => a + e - s, 0) / chunks.length;
  const stored = chunks.reduce((a, [s, e]) => a + e - s, 0);

  const blocks: number[][] = [];
  words.forEach((w, i) => {
    const last = blocks[blocks.length - 1];
    if (last && words[last[0]].block === w.block) last.push(i);
    else blocks.push([i]);
  });

  const intact = cov.intact.length > 0;
  return (
    <SimFrame
      realLife={REAL}
      controls={
        <>
          <Group title="Strategy">
            <Segmented
              label="Split by"
              value={strategy}
              onChange={setStrategy}
              options={[
                { value: "fixed", label: "Fixed" },
                { value: "recursive", label: "Recursive" },
                { value: "heading", label: "Heading" },
              ]}
            />
            <Slider label="Chunk size" value={size} onChange={setSize} min={20} max={200} step={5} format={(v) => `${v} words`} hint={`≈ ${Math.round(size * 1.3)} tokens`} />
            <Slider label="Overlap" value={ov} onChange={setOverlap} min={0} max={Math.min(80, size - 10)} step={5} format={(v) => `${v} words`} />
          </Group>
          <Group title="Question">
            <p className="sim-chunk-q">"{QUESTION}"</p>
            <p className="sim-slider-hint">The answer is the two sentences outlined in the document.</p>
          </Group>
        </>
      }
      readouts={
        <>
          <Readout label="Chunks" value={chunks.length} hint={`avg ${Math.round(avg)} words`} />
          <Readout label="Answer" value={intact ? "intact" : "split"} tone={intact ? "good" : "bad"} hint={intact ? `whole in chunk #${cov.intact[0] + 1}` : `across chunks ${cov.touching.map((c) => `#${c + 1}`).join(", ")}`} />
          <Readout label="Best single chunk has" value={`${Math.round(cov.bestShare * 100)}%`} unit="of the answer" tone={cov.bestShare === 1 ? "good" : cov.bestShare > 0.6 ? "warm" : "bad"} />
          <Readout label="Index size" value={fmtNum(stored)} unit="words" hint={`${Math.round((stored / words.length - 1) * 100)}% duplication from overlap`} />
        </>
      }
      explain={
        <>
          <p>
            {strategy === "fixed"
              ? `Fixed-size chunking cuts every ${size - ov} words regardless of meaning, so chunks start mid-sentence and headings get separated from their text.`
              : strategy === "recursive"
                ? `Recursive splitting keeps paragraphs whole when they fit in ${size} words and only falls back to sentences when they do not, so most cuts land on natural boundaries.`
                : `Splitting by heading gives one chunk per section (${chunks.length} chunks), and each carries its heading, which helps retrieval match the question to the right section.`}
          </p>
          <p>
            {intact
              ? `The answer about opened laptops sits whole inside chunk #${cov.intact[0] + 1}, so one retrieved chunk is enough to answer correctly.`
              : `The answer is split across chunks ${cov.touching.map((c) => `#${c + 1}`).join(" and ")}: the best one holds only ${Math.round(cov.bestShare * 100)}% of it. Retrieve just one and the model may say laptops can be returned within 30 days with no fee.`}{" "}
            {ov > 0 ? `Overlap of ${ov} words repeats text across neighbours (underlined), which rescues some split answers at the cost of a ${Math.round((stored / words.length - 1) * 100)}% bigger index.` : "Try adding overlap, or switch strategy, and watch the outline."}
          </p>
        </>
      }
    >
      <div className={`sim-chunk-doc${intact ? "" : " split"}`} aria-label="Chunked document">
        {blocks.map((b, bi) => {
          const h = words[b[0]].heading;
          const Tag = h === 1 ? "h3" : h === 2 ? "h5" : "p";
          return (
            <Tag key={bi} className={`sim-chunk-block${h ? " head" : ""}`}>
              {b.map((i) => {
                const c = owner[i];
                const isStart = starts.get(i);
                const w = words[i];
                return (
                  <Fragment key={i}>
                    {isStart &&
                      isStart.map((ci) => (
                        <span key={ci} className="sim-chunk-badge" style={{ ["--c" as string]: CC[ci % CC.length] }} aria-label={`chunk ${ci + 1} starts`}>
                          {ci > 0 && <Scissors size={10} aria-hidden />}#{ci + 1}
                        </span>
                      ))}
                    <span className={`sim-chunk-w${count[i] > 1 ? " ov" : ""}${w.answer ? " ans" : ""}`} style={{ ["--c" as string]: CC[c % CC.length] }}>
                      {w.w}
                    </span>{" "}
                  </Fragment>
                );
              })}
            </Tag>
          );
        })}
      </div>
      <p className="sim-note">
        {intact ? <CheckCircle2 size={13} aria-hidden className="good" /> : <Scissors size={13} aria-hidden className="bad" />} Each colour is one chunk; the scissors mark where a new chunk begins; underlined words are stored twice (overlap); the outlined sentences answer the question.
      </p>
    </SimFrame>
  );
}

export const def: SimDef = {
  id: "chunking",
  title: "Chunking a document",
  blurb: "Chunk a real policy document by fixed size, recursively or by heading, tune size and overlap, and see when the answer gets cut in half.",
  levels: [4],
  realLife: REAL,
  Component: ChunkingSim,
};
