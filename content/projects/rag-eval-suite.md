---
project: rag-eval-suite
title: Eval suite for a production RAG app
hours: 10
stack: Python 3.11, sentence-transformers, OpenAI-compatible LLM API, Ragas, pandas, scikit-learn, pytest, Streamlit
cost: About $2-4 of API calls (embeddings run locally for free)
---

You will build the measurement layer that every production RAG app needs: a reviewed golden dataset, retrieval metrics, the five Ragas metrics, an LLM judge you have checked against your own labels, a pytest gate that fails CI when quality drops, and a dashboard. Then you will use it to answer a real question ("does a smaller chunk size help?") with evidence instead of a feeling. Anyone shipping a RAG assistant, or interviewing to build one, can use this as their proof that they know how to measure it.

The project ships with a small RAG app over a few Python Enhancement Proposals (PEPs) so it stands alone. If you built the RAG app from Level 4, you can point the suite at it instead by replacing `app/rag.py`.

## Before you start

- Python 3.11+, about 1.5 GB of disk for the embedding model, and an API key for an OpenAI-compatible provider (or Ollama with a chat model). Lessons 7.7, 7.8, 7.10, 7.11 and 7.13 explain the ideas this project applies.
- Never commit your key. Put it in a `.env` file as `OPENAI_API_KEY=...` and export it in your shell, or use your provider's equivalent.

Final folder structure:

```text
rag-eval/
├── app/
│   ├── __init__.py
│   ├── config.py          # settings from environment variables
│   ├── corpus.py          # download PEPs, clean, chunk
│   └── rag.py             # the RAG app under test
├── eval/
│   ├── __init__.py
│   ├── generate.py        # draft candidate questions with an LLM
│   ├── review.py          # human review into golden-v1.jsonl
│   ├── retrieval.py       # hit rate, MRR, recall
│   ├── run_ragas.py       # run the app on the golden set and score it
│   ├── judge.py           # LLM judge + agreement with human labels
│   ├── compare.py         # paired comparison of two runs
│   └── dashboard.py       # Streamlit dashboard
├── tests/test_eval_gate.py
├── data/                  # raw PEPs, chunks, golden set
├── runs/                  # one file per eval run
├── baseline.json
└── .github/workflows/eval.yml
```

## How it fits together

```text
 PEP files ─► chunks ─► RAG app ─┐
                                  ├─► run_ragas ─► runs/<name>.jsonl ─► gate (pytest) ─► CI
 golden-v1.jsonl (reviewed) ──────┘        │                                 
        ▲                                  ├─► retrieval metrics
 generate.py ► review.py (you)             ├─► judge.py ◄─ your labels (agreement)
                                           └─► dashboard.py + compare.py
```

The golden set is drafted by a model from random chunks, then reviewed by you, which is the only step that makes it "golden". `run_ragas.py` sends each golden question through the app, records the answer and the retrieved chunks, and scores them. Everything after that reads files in `runs/`, so any past run can be compared with any other.

## Step 1 · Set up the project and the app under test

**Goal:** a working RAG app over 16 PEPs that answers a question with retrieved context.

First the environment and the corpus. PEPs are public, well-written and have enough detail to make good questions. We download them, strip RST markup lines, and pack paragraphs into chunks of about 200 words.

```bash title="terminal"
mkdir rag-eval && cd rag-eval
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install sentence-transformers numpy pandas scikit-learn openai httpx pytest streamlit ragas langchain-openai
mkdir -p app eval tests data/raw runs .github/workflows
touch app/__init__.py eval/__init__.py
```

```python title="app/config.py"
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RUNS = ROOT / "runs"

MODEL = os.getenv("MODEL", "gpt-4o-mini")            # the app's model; check the current docs for names
JUDGE_MODEL = os.getenv("JUDGE_MODEL", MODEL)         # pin this: changing it moves your scores
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_WORDS = int(os.getenv("CHUNK_WORDS", "200"))
TOP_K = int(os.getenv("TOP_K", "4"))
GOLDEN = DATA / "golden-v1.jsonl"
```

```python title="app/corpus.py"
import json
import re
import httpx
from .config import DATA, CHUNK_WORDS

PEPS = [8, 20, 257, 484, 498, 518, 557, 563, 572, 585, 589, 604, 621, 634, 636, 695]
URL = "https://raw.githubusercontent.com/python/peps/main/peps/pep-{n:04d}.rst"


def download() -> None:
    for n in PEPS:
        path = DATA / "raw" / f"pep-{n:04d}.rst"
        if path.exists():
            continue
        r = httpx.get(URL.format(n=n), timeout=30, follow_redirects=True)
        r.raise_for_status()
        path.write_text(r.text, encoding="utf-8")
    print(f"Saved {len(PEPS)} PEP files to data/raw/")


def clean(text: str) -> str:
    lines = [l for l in text.splitlines() if not l.startswith("..")]   # drop RST directives and comments
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def chunk_words(text: str, size: int) -> list[str]:
    """Pack whole paragraphs into chunks of at least `size` words."""
    chunks, cur, count = [], [], 0
    for para in re.split(r"\n\s*\n", text):
        words = len(para.split())
        if not words:
            continue
        cur.append(para.strip())
        count += words
        if count >= size:
            chunks.append("\n\n".join(cur))
            cur, count = [], 0
    if cur:
        chunks.append("\n\n".join(cur))
    return chunks


def build_chunks(size: int = CHUNK_WORDS) -> list[dict]:
    out = []
    for n in PEPS:
        text = clean((DATA / "raw" / f"pep-{n:04d}.rst").read_text(encoding="utf-8"))
        for i, c in enumerate(chunk_words(text, size)):
            out.append({"id": f"pep{n}-{size}-{i}", "pep": n, "text": c})
    return out


if __name__ == "__main__":
    download()
    chunks = build_chunks()
    (DATA / "chunks.jsonl").write_text("\n".join(json.dumps(c) for c in chunks), encoding="utf-8")
    print(f"{len(chunks)} chunks of ~{CHUNK_WORDS} words")
```

```python title="app/rag.py"
import numpy as np
from openai import OpenAI
from sentence_transformers import SentenceTransformer
from .config import CHUNK_WORDS, DATA, EMBED_MODEL, MODEL, TOP_K
from .corpus import build_chunks

client = OpenAI()   # reads OPENAI_API_KEY (and OPENAI_BASE_URL for other providers)

SYSTEM = (
    "Answer the question using only the context. Be concise. "
    "If the context does not contain the answer, say: The documents do not say."
)


class Rag:
    def __init__(self, chunk_words: int = CHUNK_WORDS, top_k: int = TOP_K):
        self.top_k = top_k
        self.chunks = build_chunks(chunk_words)
        self.embedder = SentenceTransformer(EMBED_MODEL)
        cache = DATA / f"vecs-{chunk_words}.npy"
        if cache.exists():
            self.vecs = np.load(cache)
        else:
            self.vecs = self.embedder.encode([c["text"] for c in self.chunks], normalize_embeddings=True, show_progress_bar=True)
            np.save(cache, self.vecs)

    def retrieve(self, question: str) -> list[dict]:
        q = self.embedder.encode([question], normalize_embeddings=True)[0]
        top = np.argsort(-(self.vecs @ q))[: self.top_k]
        return [self.chunks[i] for i in top]

    def answer(self, question: str) -> dict:
        chunks = self.retrieve(question)
        context = "\n\n---\n\n".join(c["text"] for c in chunks)
        resp = client.chat.completions.create(
            model=MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"},
            ],
        )
        return {"answer": resp.choices[0].message.content.strip(), "chunks": chunks}


if __name__ == "__main__":
    rag = Rag()
    out = rag.answer("What does PEP 8 say about the maximum line length?")
    print(out["answer"])
```

**How this code works**
- `config.py` → every knob (model, judge, chunk size, top-k) comes from the environment, so an experiment is one environment variable and the settings can be recorded with each run.
- `chunk_words` → packs whole paragraphs, never cutting mid-sentence, until a chunk reaches the target size.
- Chunk ids contain the chunk size (`pep8-200-3`) because the ids change when you re-chunk. This matters in Step 3, where we avoid relying on ids.
- `Rag.__init__` → embeds every chunk once and caches the vectors per chunk size in a `.npy` file, so later runs start in seconds.
- `normalize_embeddings=True` → with unit vectors, a dot product is cosine similarity, so `self.vecs @ q` scores every chunk in one line.
- `temperature=0` → removes sampling noise from the answers, so a score change comes from your change and not from luck.

**Run it**
```bash
python -m app.corpus && python -m app.rag
```

**You should see**
```text
Saved 16 PEP files to data/raw/
1840 chunks of ~200 words
PEP 8 says lines should be limited to a maximum of 79 characters ...
```

**If it breaks**
- `ModuleNotFoundError: app` → run from the `rag-eval` folder with `python -m ...`, not `python app/rag.py`.
- `AuthenticationError` → the key is not exported in this shell (`echo $OPENAI_API_KEY`).
- Download fails → open the URL in a browser; if GitHub moved the files, change `URL` in `corpus.py`.

## Step 2 · Draft candidate questions, then review them into a golden set

**Goal:** `data/golden-v1.jsonl` with at least 60 reviewed cases, each tagged and carrying an evidence quote.

A golden dataset starts with a model's draft and becomes golden when you read it (lesson 7.7). We ask the model to write a question that only a given chunk can answer, plus a reference answer and a verbatim **evidence quote** from the chunk. We reject any draft whose quote is not really in the chunk. We also add a few questions the corpus cannot answer, because a good app must say "I don't know".

```python title="eval/generate.py"
import json
import random
from openai import OpenAI
from app.config import DATA, JUDGE_MODEL
from app.corpus import build_chunks

client = OpenAI()

PROMPT = """You write exam questions from a passage.
Passage:
{passage}

Write ONE question that can be answered only from this passage (no 'according to the passage'),
a short reference answer, and an exact verbatim quote from the passage that supports the answer.
Return JSON: {{"question": "...", "reference": "...", "evidence": "..."}}"""

UNANSWERABLE = [
    "Which PEP introduced the walrus operator in Python 3.14?",
    "What is the recommended maximum number of functions per Python module?",
    "How does PEP 8 say to name a Rust crate?",
    "What GPU does the Python steering council recommend for training models?",
    "Which PEP defines the syntax for JavaScript imports in Python?",
    "What is Guido van Rossum's favourite lunch according to PEP 20?",
]


def norm(s: str) -> str:
    return " ".join(s.lower().split())


def main(n: int = 70, seed: int = 7) -> None:
    random.seed(seed)
    chunks = [c for c in build_chunks(200) if len(c["text"].split()) > 80]
    out = []
    for c in random.sample(chunks, n):
        resp = client.chat.completions.create(
            model=JUDGE_MODEL,
            temperature=0.3,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": PROMPT.format(passage=c["text"][:3000])}],
        )
        try:
            d = json.loads(resp.choices[0].message.content)
        except json.JSONDecodeError:
            continue
        if norm(d.get("evidence", "")) not in norm(c["text"]):
            continue    # the model invented its quote; drop it
        out.append({"id": f"q{len(out):03d}", "input": d["question"], "reference": d["reference"],
                    "evidence": d["evidence"], "answerable": True, "tags": {"pep": c["pep"]}, "source": "synthetic"})
    for q in UNANSWERABLE:
        out.append({"id": f"q{len(out):03d}", "input": q, "reference": "The documents do not say.",
                    "evidence": "", "answerable": False, "tags": {"pep": None}, "source": "hand-written"})
    (DATA / "candidates.jsonl").write_text("\n".join(json.dumps(x) for x in out), encoding="utf-8")
    print(f"{len(out)} candidates written")


if __name__ == "__main__":
    main()
```

```python title="eval/review.py"
import json
from app.config import DATA, GOLDEN


def load(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()] if path.exists() else []


def main() -> None:
    cands = load(DATA / "candidates.jsonl")
    done = {c["id"] for c in load(GOLDEN)} | {c["id"] for c in load(DATA / "rejected.jsonl")}
    for c in cands:
        if c["id"] in done:
            continue
        print("\n" + "=" * 70)
        print(f"[{c['id']}] {c['input']}")
        print(f"reference: {c['reference']}")
        if c["evidence"]:
            print(f"evidence : {c['evidence'][:300]}")
        act = input("keep (y) / reject (n) / edit (e) / quit (q)? ").strip().lower()
        if act == "q":
            break
        target = DATA / "rejected.jsonl"
        if act in ("y", "e"):
            if act == "e":
                c["input"] = input("question  > ") or c["input"]
                c["reference"] = input("reference > ") or c["reference"]
            c["tags"]["difficulty"] = input("difficulty e/m/h > ").strip().lower() or "m"
            c["reviewed_by"] = "me"
            target = GOLDEN
        with target.open("a", encoding="utf-8") as f:
            f.write(json.dumps(c) + "\n")
    print(f"golden set now has {len(load(GOLDEN))} cases")


if __name__ == "__main__":
    main()
```

**How this code works**
- The generation prompt asks for a *verbatim* quote, and `norm(...) not in norm(...)` rejects any draft whose quote is not in the source. This is a cheap, automatic hallucination filter on your test data.
- `UNANSWERABLE` cases have an empty `evidence`, so retrieval metrics skip them in Step 3, but the answer metrics still check that the app declines.
- `review.py` appends to files as you go and skips ids it has already seen, so you can quit with `q` and resume later. Rejected cases are kept, not deleted, so you can see what the generator got wrong.
- The `difficulty` tag and `pep` tag are what make per-slice analysis possible in Step 7.

**Run it**
```bash
python -m eval.generate && python -m eval.review
```
Aim to keep at least 55 of the answerable drafts plus the unanswerable ones. Edit any question that is vague ("What does it say about this?") or answerable without the document.

**You should see**
```text
76 candidates written
...
golden set now has 62 cases
```

**If it breaks**
- Most candidates are dropped at the quote check → lower `temperature` in the prompt or shorten passages (`[:3000]`); small local models copy quotes badly.
- `JSONDecodeError` repeated → the provider may not support `response_format`; remove that argument and ask for JSON in the prompt.

## Step 3 · Measure retrieval on its own

**Goal:** hit rate, MRR and recall@k for the retriever, independent of the language model.

If retrieval misses the evidence, no prompt can save the answer, so measure it first (lesson 7.10). A retrieved chunk counts as **relevant** if it contains the case's evidence quote. Using the quote instead of chunk ids means the metric still works after you change the chunk size.

```python title="eval/retrieval.py"
import json
from app.config import GOLDEN
from app.rag import Rag


def norm(s: str) -> str:
    return " ".join(s.lower().split())


def is_relevant(chunk: dict, case: dict) -> bool:
    return bool(case["evidence"]) and norm(case["evidence"]) in norm(chunk["text"])


def retrieval_metrics(chunks: list[dict], case: dict) -> dict:
    rel = [is_relevant(c, case) for c in chunks]
    first = next((i + 1 for i, r in enumerate(rel) if r), None)
    return {"hit": float(any(rel)), "mrr": (1 / first) if first else 0.0, "precision_at_k": sum(rel) / max(1, len(rel))}


if __name__ == "__main__":
    cases = [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    rag = Rag()
    rows = [retrieval_metrics(rag.retrieve(c["input"]), c) for c in cases if c["answerable"]]
    for k in rows[0]:
        print(f"{k:16s} {sum(r[k] for r in rows) / len(rows):.3f}")
```

**How this code works**
- `hit` is 1 if any retrieved chunk is relevant; `mrr` (mean reciprocal rank) is 1 divided by the rank of the first relevant chunk, so it rewards putting the answer first; `precision_at_k` is the share of the retrieved chunks that are relevant.
- Unanswerable cases are excluded, since there is nothing to retrieve.
- This runs in seconds and costs nothing, because it needs no model call, so run it after every retrieval change.

**Run it**
```bash
python -m eval.retrieval
```

**You should see**
```text
hit              0.871
mrr              0.702
precision_at_k   0.268
```

**If it breaks**
- `hit` near 0 → your `evidence` quotes span a chunk boundary or use different whitespace; check `norm()` and that you did not edit the quote text in review.
- `KeyError: 'evidence'` → a hand-edited case lost the field; every case needs `evidence` (empty string for unanswerable).

## Step 4 · Run the app on the golden set and score it with Ragas

**Goal:** a run file with per-question answers, retrieved contexts, retrieval metrics and the five Ragas metrics, plus a summary.

Now the end-to-end evaluation. For each case we run the app, then hand question, contexts, answer and reference to Ragas (lesson 7.11). The Ragas API has changed between releases, so check its documentation if an import fails.

```python title="eval/run_ragas.py"
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from ragas import EvaluationDataset, evaluate
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.llms import LangchainLLMWrapper
from ragas.metrics import Faithfulness, FactualCorrectness, LLMContextPrecisionWithReference, LLMContextRecall, ResponseRelevancy
from app.config import CHUNK_WORDS, GOLDEN, JUDGE_MODEL, MODEL, RUNS, TOP_K
from app.rag import Rag
from eval.retrieval import retrieval_metrics

INPUT_COLS = {"user_input", "retrieved_contexts", "response", "reference"}


def load_cases(limit: int | None):
    cases = [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    return cases[:limit] if limit else cases


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    cases = load_cases(args.limit)
    rag = Rag()
    with ThreadPoolExecutor(max_workers=6) as pool:
        outs = list(pool.map(lambda c: rag.answer(c["input"]), cases))

    rows = []
    for c, o in zip(cases, outs):
        rows.append({"user_input": c["input"], "retrieved_contexts": [x["text"] for x in o["chunks"]],
                     "response": o["answer"], "reference": c["reference"]})

    result = evaluate(
        dataset=EvaluationDataset.from_list(rows),
        metrics=[Faithfulness(), ResponseRelevancy(), LLMContextPrecisionWithReference(), LLMContextRecall(), FactualCorrectness()],
        llm=LangchainLLMWrapper(ChatOpenAI(model=JUDGE_MODEL, temperature=0)),
        embeddings=LangchainEmbeddingsWrapper(OpenAIEmbeddings()),
    )
    df = result.to_pandas()
    metric_cols = [c for c in df.columns if c not in INPUT_COLS and pd.api.types.is_numeric_dtype(df[c])]

    RUNS.mkdir(exist_ok=True)
    with (RUNS / f"{args.name}.jsonl").open("w", encoding="utf-8") as f:
        for i, (c, o) in enumerate(zip(cases, outs)):
            row = {"id": c["id"], "tags": c["tags"], "answerable": c["answerable"], "input": c["input"],
                   "reference": c["reference"], "answer": o["answer"], "contexts": [x["text"] for x in o["chunks"]]}
            if c["answerable"]:
                row.update(retrieval_metrics(o["chunks"], c))
            row.update({m: (None if pd.isna(df.loc[i, m]) else float(df.loc[i, m])) for m in metric_cols})
            f.write(json.dumps(row) + "\n")

    summary = {"name": args.name, "time": time.time(), "n": len(cases), "metrics": {m: float(df[m].mean()) for m in metric_cols},
               "config": {"model": MODEL, "judge": JUDGE_MODEL, "chunk_words": CHUNK_WORDS, "top_k": TOP_K, "golden": GOLDEN.name}}
    (RUNS / f"{args.name}.summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (RUNS / "latest.summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary["metrics"], indent=2))


if __name__ == "__main__":
    main()
```

**How this code works**
- Answers are generated in a thread pool (the app is I/O-bound), then scored together in one `evaluate` call, which keeps the judge's work in one place.
- `INPUT_COLS` is excluded when picking metric columns, because Ragas metric column names differ by version (`faithfulness`, `answer_relevancy`, `context_recall`, and so on). Choosing numeric non-input columns keeps the script working across versions.
- Each run records its **configuration** (models, chunk size, top-k, golden version) next to its scores. A number without its settings cannot be compared.
- `latest.summary.json` is what the CI gate reads in Step 6.

**Run it**
```bash
python -m eval.run_ragas --name baseline
```

**You should see**
```text
{
  "faithfulness": 0.84,
  "answer_relevancy": 0.79,
  "llm_context_precision_with_reference": 0.62,
  "context_recall": 0.81,
  "factual_correctness(mode=f1)": 0.58
}
```
Your numbers will differ; they depend on the golden set, the judge and the models.

**If it breaks**
- `ImportError` on a Ragas class → names and modules change between releases; check the Ragas docs for your installed version.
- Many `NaN` rows → the judge failed to parse; lower concurrency (`RunConfig(max_workers=4)` in Ragas) or use a stronger `JUDGE_MODEL`.
- Rate limit errors → reduce `max_workers` in the thread pool.

Read the ten lowest rows now (sort the JSONL by each metric). Write down which metric explains each failure; Step 7 uses this.

## Step 5 · Build an LLM judge and check it against your own labels

**Goal:** a faithfulness judge with a measured agreement rate and Cohen's kappa against 30 labels you wrote.

A judge is only useful once you know how closely it agrees with you (lesson 7.8). This script has two commands: `label` shows you 30 answers with their contexts and records your verdict, and `agree` runs the judge on the same rows and compares.

```python title="eval/judge.py"
import json
import random
import sys
from openai import OpenAI
from sklearn.metrics import cohen_kappa_score, confusion_matrix
from app.config import DATA, JUDGE_MODEL, RUNS

client = OpenAI()
LABELS = DATA / "human-labels.jsonl"

JUDGE = """Grade whether the ANSWER is supported by the CONTEXT.
List each factual claim in the answer and whether the context supports it.
PASS: every claim is supported, or the answer says the documents do not say.
FAIL: at least one claim is not supported by the context.
Return JSON: {{"claims": [{{"claim": "...", "supported": true}}], "verdict": "PASS" or "FAIL"}}

CONTEXT:
{context}

ANSWER:
{answer}"""


def judge(context: str, answer: str) -> str:
    resp = client.chat.completions.create(
        model=JUDGE_MODEL, temperature=0, response_format={"type": "json_object"},
        messages=[{"role": "user", "content": JUDGE.format(context=context[:6000], answer=answer)}])
    return json.loads(resp.choices[0].message.content)["verdict"]


def rows(run: str) -> list[dict]:
    return [json.loads(l) for l in (RUNS / f"{run}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]


def label(run: str, n: int = 30) -> None:
    sample = random.Random(3).sample(rows(run), n)
    with LABELS.open("w", encoding="utf-8") as f:
        for r in sample:
            print("\n" + "=" * 70 + f"\nQ: {r['input']}\nCONTEXT:\n" + "\n---\n".join(r["contexts"])[:2500] + f"\n\nANSWER: {r['answer']}")
            v = input("Is every claim in the answer supported by the context? (p/f) ").strip().lower()
            f.write(json.dumps({"id": r["id"], "human": "PASS" if v == "p" else "FAIL"}) + "\n")


def agree(run: str) -> None:
    by_id = {r["id"]: r for r in rows(run)}
    labels = [json.loads(l) for l in LABELS.read_text(encoding="utf-8").splitlines() if l.strip()]
    human, model = [], []
    for lab in labels:
        r = by_id[lab["id"]]
        human.append(lab["human"])
        model.append(judge("\n---\n".join(r["contexts"]), r["answer"]))
    raw = sum(h == m for h, m in zip(human, model)) / len(human)
    print(f"agreement {raw:.2f}  kappa {cohen_kappa_score(human, model):.2f}")
    print("confusion (rows = human, cols = judge; PASS, FAIL):\n", confusion_matrix(human, model, labels=["PASS", "FAIL"]))
    for lab, m in zip(labels, model):
        if lab["human"] != m:
            print("DISAGREE", lab["id"], "human", lab["human"], "judge", m)


if __name__ == "__main__":
    {"label": label, "agree": agree}[sys.argv[1]](sys.argv[2])
```

**How this code works**
- The judge prompt asks for claims *before* the verdict, so the verdict follows from listed evidence, and uses `temperature=0` for repeatability.
- The same `random.Random(3)` seed always picks the same 30 rows, so you can label across several sittings of the same sample.
- `agree` prints raw agreement, Cohen's kappa (agreement corrected for chance) and a confusion matrix. A **false pass** (human FAIL, judge PASS) is the costly error, because it lets a hallucination through.

**Run it**
```bash
python -m eval.judge label baseline
python -m eval.judge agree baseline
```

**You should see**
```text
agreement 0.83  kappa 0.62
confusion (rows = human, cols = judge; PASS, FAIL):
 [[19  2]
  [ 3  6]]
DISAGREE q014 human FAIL judge PASS
```

**If it breaks**
- Kappa is low (below 0.4) → read each `DISAGREE`; usually your own standard is unclear ("is a paraphrase a new claim?"). Write the rule into the `JUDGE` prompt, re-run `agree`, and record the final numbers in your README.
- All your labels are PASS → kappa is undefined or meaningless when one class dominates; label more of the suspicious rows (low faithfulness) as well as random ones.

## Step 6 · Gate your build on the results

**Goal:** a pytest that fails when any metric falls below the baseline by more than an agreed margin, run in GitHub Actions.

Agree the rule before you see the numbers (lesson 7.13). Freeze the baseline and a tolerance per metric, then make CI enforce it.

```json title="baseline.json"
{
  "tolerance": 0.05,
  "metrics": {
    "faithfulness": 0.84,
    "context_recall": 0.81
  }
}
```

Edit the numbers to match your `baseline` run, using the exact metric names printed in Step 4, and keep only the metrics you want to protect. A tolerance of 0.05 is about the noise level for a set of 60 cases; with more cases you can tighten it.

```python title="tests/test_eval_gate.py"
import json
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parent.parent
baseline = json.loads((ROOT / "baseline.json").read_text())
latest = json.loads((ROOT / "runs" / "latest.summary.json").read_text())


def test_same_golden_version():
    assert latest["config"]["golden"] == "golden-v1.jsonl", "scores are only comparable on the same golden set"


@pytest.mark.parametrize("metric", sorted(baseline["metrics"]))
def test_metric_does_not_regress(metric):
    assert metric in latest["metrics"], f"{metric} missing from the run"
    floor = baseline["metrics"][metric] - baseline["tolerance"]
    assert latest["metrics"][metric] >= floor, f"{metric} {latest['metrics'][metric]:.3f} < floor {floor:.3f}"
```

```yaml title=".github/workflows/eval.yml"
name: eval
on: [pull_request]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: {python-version: "3.11"}
      - run: pip install sentence-transformers numpy pandas scikit-learn openai httpx pytest ragas langchain-openai
      - run: python -m app.corpus
      - run: python -m eval.run_ragas --name ci --limit 40
        env: {OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}"}
      - run: pytest tests/test_eval_gate.py -q
```

**How this code works**
- Each metric becomes its own parametrised test, so a failure names the metric that regressed.
- `test_same_golden_version` stops someone "improving" a score by quietly editing the dataset.
- CI uses `--limit 40` to control cost; keep the full-set run for nightly or pre-release checks. Add the key as a repository secret, never in the file.

**Run it**
```bash
python -m eval.run_ragas --name check && pytest tests/test_eval_gate.py -q
```
Then prove the gate works: set `TOP_K=1` (`TOP_K=1 python -m eval.run_ragas --name weak`) and run the tests again.

**You should see**
```text
2 passed
...
FAILED tests/test_eval_gate.py::test_metric_does_not_regress[context_recall] - context_recall 0.52 < floor 0.76
```

**If it breaks**
- `KeyError` for a metric → the name in `baseline.json` does not match the summary; copy it from `runs/latest.summary.json`.
- The gate flaps between runs → your tolerance is below the noise level; raise it or add cases.

## Step 7 · Build a dashboard, then prove a change helps

**Goal:** a Streamlit dashboard with trends and a regression table, and a before/after report for a chunk-size change.

First a paired comparison script (lesson 7.13). Because both runs answered the same questions, comparing per question removes difficulty from the noise.

```python title="eval/compare.py"
import json
import sys
import numpy as np
from app.config import RUNS


def load(name: str) -> dict:
    return {json.loads(l)["id"]: json.loads(l) for l in (RUNS / f"{name}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}


def main(a: str, b: str) -> None:
    ra, rb = load(a), load(b)
    ids = sorted(set(ra) & set(rb))
    skip = {"id", "tags", "answerable", "input", "reference", "answer", "contexts"}
    metrics = [k for k, v in ra[ids[0]].items() if k not in skip and isinstance(v, (int, float))]
    print(f"{len(ids)} shared questions: {a} -> {b}\n")
    for m in metrics:
        d = np.array([rb[i][m] - ra[i][m] for i in ids if ra[i].get(m) is not None and rb[i].get(m) is not None])
        if not len(d):
            continue
        margin = 1.96 * d.std(ddof=1) / np.sqrt(len(d)) if len(d) > 1 else float("nan")
        verdict = "real" if abs(d.mean()) > margin else "within noise"
        print(f"{m:40s} {d.mean():+.3f} ± {margin:.3f}   gained {int((d > 0.2).sum()):2d}  lost {int((d < -0.2).sum()):2d}   {verdict}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

```python title="eval/dashboard.py"
import json
import pandas as pd
import streamlit as st
from app.config import RUNS

st.set_page_config(page_title="RAG eval", layout="wide")
st.title("RAG eval dashboard")

summaries = sorted((json.loads(p.read_text()) for p in RUNS.glob("*.summary.json") if p.name != "latest.summary.json"), key=lambda s: s["time"])
if not summaries:
    st.stop()
df = pd.DataFrame([{"run": s["name"], **s["metrics"]} for s in summaries]).set_index("run")

st.subheader("Trend per metric")
st.line_chart(df)

st.subheader("Regression table vs the first run")
base = df.iloc[0]
table = pd.DataFrame({"baseline": base, "latest": df.iloc[-1], "change": df.iloc[-1] - base})
st.dataframe(table.style.background_gradient(subset=["change"], cmap="RdYlGn", vmin=-0.1, vmax=0.1), use_container_width=True)

st.subheader("Worst rows in a run")
run = st.selectbox("Run", list(df.index)[::-1])
metric = st.selectbox("Metric", list(df.columns))
rows = pd.read_json(RUNS / f"{run}.jsonl", lines=True)
st.dataframe(rows.sort_values(metric).head(15)[["id", "input", "answer", metric]], use_container_width=True)
```

Now the experiment. The hypothesis: smaller chunks put the evidence more precisely in the prompt, so context precision and faithfulness rise. Run the same golden set with 120-word chunks and compare it with the baseline:

```bash
CHUNK_WORDS=120 python -m eval.run_ragas --name chunk120
python -m eval.compare baseline chunk120
streamlit run eval/dashboard.py
```

**How this code works**
- `compare.py` computes the per-question difference for each metric, the mean difference, and a 95% margin of ±1.96 standard errors. If the mean is smaller than the margin, the result is reported as noise.
- "Gained" and "lost" count questions that moved by more than 0.2 either way. A change that gains 8 and loses 7 is risky even when the average looks slightly positive.
- The dashboard only reads files in `runs/`, so it needs no database and works for every past run.

**You should see**
```text
60 shared questions: baseline -> chunk120

faithfulness                                +0.012 ± 0.041   gained  5  lost  4   within noise
context_recall                              -0.063 ± 0.048   gained  3  lost  9   real
llm_context_precision_with_reference        +0.071 ± 0.052   gained 12  lost  5   real
```
This invented example shows the typical outcome: precision improves, but recall drops because smaller chunks split evidence apart. Yours may differ; that is the point of measuring.

**If it breaks**
- `compare.py` prints nothing → the two runs share no ids; both must come from the same golden set.
- Streamlit shows an empty page → `runs/` has no `*.summary.json`; run Step 4 first.

## Ship it

- **README.** Include the question you asked ("does 120-word chunking help?"), a table of baseline vs candidate scores with the margins from `compare.py`, the judge-agreement numbers from Step 5, and a sentence of conclusion with its caveat ("on 62 questions about 16 PEPs").
- **Failure analysis.** Add a short list of failure groups from your ten worst rows, how many each had, and which component they point at (retrieval, prompt, reference wrong).
- **Repo hygiene.** Commit `golden-v1.jsonl`, `baseline.json`, the workflow and the runs you cite. Leave `.env` and `data/raw` out.
- **Demo checklist.** Show the golden-set review step, the failing gate from the `TOP_K=1` run, and the dashboard with a regression row highlighted.
- **Portfolio line.** "Built an eval suite for a RAG app: 62-case reviewed golden set, Ragas metrics, LLM judge validated at kappa 0.6 against human labels, CI gate on faithfulness and recall, and used it to show chunk size 120 raised context precision by 7 points at a 6-point cost in recall." (Use your own numbers.)

## Going further

- Add **online sampling**: log 2% of live requests, judge them nightly, and chart drift on the dashboard.
- Use a **second judge** from a different model family and report where the two disagree.
- Add **slice metrics** by `difficulty` and by `pep` tag to the dashboard and gate on the weakest slice.
- Turn real thumbs-down feedback into new golden cases with a `source: production` tag (see lesson 7.7).
- Add cost and latency per question to each run and put them beside quality in the regression table.
