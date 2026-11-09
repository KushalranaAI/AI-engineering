---
project: document-qa-platform
title: Document Q&A platform
hours: 12
stack: Python 3.11, FastAPI, SQLite, NumPy, rank-bm25, pypdf, python-docx, OpenAI-compatible API, Docker, Fly.io
cost: About $1 of API calls for building and evaluating; hosting free to $5 a month
---

By the end you will have a public web service where a signed-in user uploads PDFs, Word files or web pages and asks
questions about them. Answers cite the passage they came from, and the service declines when the documents do not
contain the answer. Behind it sits a retrieval eval of at least 40 questions, a per-question cost log, and a README a
hiring manager can scan in two minutes. This is the project to lead with if you want "AI engineer at a product company" roles.

## Before you start
- Python 3.11+, Docker Desktop, and a free [Fly.io](https://fly.io) account (Render, Railway or Hugging Face Spaces work too).
- An API key for any OpenAI-compatible provider. For a fully local build, run Ollama and set `BASE_URL=http://localhost:11434/v1`, `MODEL=llama3.1`, `EMBED_MODEL=nomic-embed-text`.
- **Reuse from Level 4.** If you built `hybrid-search-engine` or `advanced-rag-app`, you already have chunking, BM25 + dense fusion and a reranker. Copy what you trust. This guide includes a compact version of each so it stands alone, and spends its steps on what is new: incremental ingestion, tenants, auth, a published eval and deployment.

```text title="final layout"
docqa/
├── app/
│   ├── config.py      # settings from env
│   ├── llm.py         # chat + embeddings client
│   ├── extract.py     # PDF / HTML / DOCX → text
│   ├── chunk.py       # text → overlapping chunks
│   ├── store.py       # SQLite schema + loading
│   ├── ingest.py      # hash, chunk, embed, upsert
│   ├── retrieve.py    # dense, BM25, hybrid, rerank
│   ├── answer.py      # cited answer or decline
│   ├── main.py        # FastAPI: auth, rate limit, logging
│   └── static/index.html
├── scripts/load_samples.py
├── eval/make_questions.py
├── eval/run_eval.py
├── tests/test_platform.py
├── requirements.txt
└── Dockerfile
```

## How it fits together

```text
 browser / curl ──X-API-Key──► FastAPI ──► auth → tenant ──► rate limiter
                                   │
        POST /documents            │            POST /ask
             ▼                     │                ▼
  extract → chunk → embed          │     embed query → dense + BM25 (tenant rows only)
             ▼                     │                ▼
   SQLite: documents, chunks ◄─────┘          RRF fuse → (rerank) → top 5
   (sha256 per file)                                ▼
                                       evidence ok? ── no ──► "I couldn't find that"
                                            │ yes
                                            ▼
                                   LLM answer with [n] citations → JSON log (tokens, ms, $)
```

An upload arrives with an API key, which maps to a tenant. The file is hashed; if the same tenant already has the
same bytes under that name, nothing happens. Otherwise its text is extracted, chunked, embedded and stored with the
tenant on every row. A question loads only that tenant's chunks, runs dense and keyword retrieval, fuses them, and
checks whether the best match is close enough to be worth answering. Every answer is logged with tokens, latency and cost.

## Step 1 · Set up the project and configuration
**Goal:** a virtual environment, dependencies, and one settings object every module reads.

All tunable values (model names, prices, thresholds, API keys) live in environment variables. That is what lets you
swap providers, and what lets the deployed version use different secrets from your laptop.

```bash title="terminal"
mkdir docqa && cd docqa
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir -p app/static scripts eval tests data
cat > requirements.txt <<'EOF'
fastapi>=0.115
uvicorn[standard]>=0.30
python-multipart>=0.0.9
openai>=1.40
numpy>=1.26
rank-bm25>=0.2.2
pypdf>=4.0
python-docx>=1.1
beautifulsoup4>=4.12
httpx>=0.27
pytest>=8.0
EOF
pip install -r requirements.txt
touch app/__init__.py
export OPENAI_API_KEY=sk-...        # Windows PowerShell: $env:OPENAI_API_KEY="sk-..."
```

```python title="app/config.py"
import os
from dataclasses import dataclass, field


def _parse_keys() -> dict[str, str]:
    """API_KEYS="key1:alice,key2:bob" -> {"key1": "alice", "key2": "bob"}"""
    raw = os.getenv("API_KEYS", "dev-key:demo")
    return dict(pair.split(":", 1) for pair in raw.split(",") if ":" in pair)


@dataclass(frozen=True)
class Settings:
    model: str = os.getenv("MODEL", "gpt-4o-mini")
    embed_model: str = os.getenv("EMBED_MODEL", "text-embedding-3-small")
    base_url: str | None = os.getenv("BASE_URL") or None
    api_key: str = os.getenv("OPENAI_API_KEY", "not-needed")
    db_path: str = os.getenv("DB_PATH", "data/docqa.db")
    price_in_per_m: float = float(os.getenv("PRICE_IN_PER_M", "0.15"))    # USD per 1M input tokens
    price_out_per_m: float = float(os.getenv("PRICE_OUT_PER_M", "0.60"))
    min_score: float = float(os.getenv("MIN_SCORE", "0.30"))
    rate_per_min: int = int(os.getenv("RATE_PER_MIN", "20"))
    api_keys: dict[str, str] = field(default_factory=_parse_keys)


settings = Settings()
```

```python title="app/llm.py"
import numpy as np
from openai import OpenAI

from app.config import settings

client = OpenAI(base_url=settings.base_url, api_key=settings.api_key)


def embed(texts: list[str]) -> np.ndarray:
    """Return an (n, dim) float32 matrix of unit-length vectors."""
    vectors: list[list[float]] = []
    for i in range(0, len(texts), 64):  # batch to stay under request limits
        resp = client.embeddings.create(model=settings.embed_model, input=texts[i:i + 64])
        vectors.extend(item.embedding for item in resp.data)
    matrix = np.array(vectors, dtype=np.float32)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def chat(messages: list[dict]):
    return client.chat.completions.create(model=settings.model, messages=messages, temperature=0)
```

**How this code works**
- `_parse_keys` → maps API keys to tenant names. It is deliberately simple: a real product would use a user table and hashed keys, but env-var keys are enough to prove isolation and are easy to rotate on Fly.io.
- `os.getenv(...)` as dataclass defaults → read once at import. Set env vars *before* starting the server.
- `price_*_per_m` → prices change and differ by provider, so they are config, not code. Look up your model's current price.
- `embed` normalises vectors to unit length, so a plain dot product later equals cosine similarity.
- Batches of 64 → most providers cap inputs per embeddings request; 64 is safe everywhere.

**Run it**
```bash title="terminal"
python -c "from app.llm import embed; v = embed(['hello', 'world']); print(v.shape, round(float(v[0] @ v[1]), 3))"
```

**You should see**
```text
(2, 1536) 0.402
```

**If it breaks**
- `AuthenticationError` → the key is not exported in this shell. Export it again, or put it in a `.env` and load it with your shell.
- `model not found` with Ollama → run `ollama pull nomic-embed-text` and set `EMBED_MODEL=nomic-embed-text`. The dimension will be 768, which is fine.
- `ModuleNotFoundError: app` → run commands from the `docqa/` folder, not inside `app/`.

## Step 2 · Extract and chunk PDF, HTML and Word files
**Goal:** any supported upload becomes a list of chunks that remember their page number.

Extraction is where most document Q&A bugs start: navigation menus indexed as content, scanned PDFs that return
empty strings, giant paragraphs. We keep page numbers because "see page 14" is a far more useful citation than a file name.

```python title="app/extract.py"
import io
from pathlib import Path

from bs4 import BeautifulSoup
from docx import Document
from pypdf import PdfReader

SUPPORTED = {".pdf", ".html", ".htm", ".docx", ".txt", ".md"}


def extract_text(filename: str, data: bytes) -> list[tuple[int, str]]:
    """Return (page_number, text) pairs. Formats without pages count as page 1."""
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED:
        raise ValueError(f"unsupported file type '{ext}'; use one of {sorted(SUPPORTED)}")
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return [(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
    if ext in {".html", ".htm"}:
        soup = BeautifulSoup(data, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
            tag.decompose()
        main = soup.find("main") or soup.find("article") or soup.body or soup
        return [(1, main.get_text("\n"))]
    if ext == ".docx":
        doc = Document(io.BytesIO(data))
        return [(1, "\n\n".join(p.text for p in doc.paragraphs if p.text.strip()))]
    return [(1, data.decode("utf-8", errors="replace"))]
```

```python title="app/chunk.py"
import re


def chunk_pages(pages: list[tuple[int, str]], max_chars: int = 1200, overlap: int = 200) -> list[dict]:
    """Pack paragraphs into chunks of at most max_chars, carrying `overlap` chars between chunks."""
    chunks: list[dict] = []
    for page, text in pages:
        text = re.sub(r"[ \t]+", " ", text)
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        buf = ""
        for para in paragraphs:
            if buf and len(buf) + len(para) + 1 > max_chars:
                chunks.append({"page": page, "text": buf})
                buf = buf[-overlap:]
            buf = f"{buf}\n{para}".strip()
            while len(buf) > max_chars:  # one paragraph longer than a chunk
                chunks.append({"page": page, "text": buf[:max_chars]})
                buf = buf[max_chars - overlap:]
        if buf.strip():
            chunks.append({"page": page, "text": buf})
    return chunks
```

**How this code works**
- `SUPPORTED` check first → reject unknown types with a clear 400 instead of a stack trace later.
- `page.extract_text() or ""` → pypdf returns `None` for image-only pages. Scanned PDFs therefore produce no chunks, and ingestion (next step) rejects them with a helpful message instead of indexing nothing.
- `soup(["script", ...]).decompose()` and `find("main")` → drop boilerplate so menus and cookie banners do not crowd out real answers.
- `chunk_pages` packs whole paragraphs until the next one would overflow, so chunks rarely cut a sentence. The `while` loop is the safety net for a 5,000-character paragraph.
- `overlap` → the tail of one chunk starts the next, so an answer that straddles a boundary still lands in one chunk.

**Run it**
```bash title="terminal"
python -c "from app.chunk import chunk_pages; c = chunk_pages([(1, ('word ' * 100 + chr(10)*2) * 30)]); print(len(c), max(len(x['text']) for x in c))"
```

**You should see**
```text
15 1199
```

**If it breaks**
- `PdfReadError` on a particular file → the PDF is encrypted or damaged. Open and re-save it, or catch the error and return 400.
- HTML chunks full of menu text → the site does not use `<main>`. Add its container class, e.g. `soup.find("div", class_="content")`.

## Step 3 · Store chunks per tenant and re-index only changed files
**Goal:** uploading a file stores its chunks and vectors in SQLite; uploading the same bytes again is free.

SQLite is enough for thousands of documents and keeps deployment to one container with one volume. Every chunk row
carries the tenant, so isolation is a `WHERE` clause we can test rather than a convention we hope people follow.

```python title="app/store.py"
import sqlite3
import threading
from pathlib import Path

import numpy as np

from app.config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    tenant TEXT NOT NULL,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant, filename)
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tenant TEXT NOT NULL,
    ord INTEGER NOT NULL,
    page INTEGER,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON chunks (tenant);
"""

db_lock = threading.Lock()  # SQLite allows one writer; FastAPI runs sync routes in threads


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or settings.db_path
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def load_chunks(conn: sqlite3.Connection, tenant: str) -> tuple[list[dict], np.ndarray]:
    """All chunks for ONE tenant plus their vectors as a matrix (row i = chunk i)."""
    rows = conn.execute(
        """SELECT c.ord, c.page, c.text, c.embedding, d.filename
           FROM chunks c JOIN documents d ON d.id = c.doc_id
           WHERE c.tenant = ? ORDER BY c.id""",
        (tenant,),
    ).fetchall()
    if not rows:
        return [], np.zeros((0, 0), dtype=np.float32)
    matrix = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    meta = [{"ord": r["ord"], "page": r["page"], "text": r["text"], "filename": r["filename"]} for r in rows]
    return meta, matrix
```

```python title="app/ingest.py"
import hashlib
import sqlite3

from app import llm
from app.chunk import chunk_pages
from app.extract import extract_text
from app.store import db_lock


def ingest(conn: sqlite3.Connection, tenant: str, filename: str, data: bytes) -> dict:
    digest = hashlib.sha256(data).hexdigest()
    existing = conn.execute(
        "SELECT id, sha256 FROM documents WHERE tenant = ? AND filename = ?", (tenant, filename)
    ).fetchone()
    if existing and existing["sha256"] == digest:
        return {"filename": filename, "status": "unchanged", "chunks": 0}

    chunks = chunk_pages(extract_text(filename, data))
    if not chunks:
        raise ValueError("no extractable text (is this a scanned PDF? see 'Going further' for OCR)")
    vectors = llm.embed([c["text"] for c in chunks])  # embed BEFORE touching the DB

    with db_lock, conn:  # one transaction: old version out, new version in
        if existing:
            conn.execute("DELETE FROM documents WHERE id = ?", (existing["id"],))
        cur = conn.execute(
            "INSERT INTO documents (tenant, filename, sha256) VALUES (?, ?, ?)", (tenant, filename, digest)
        )
        conn.executemany(
            "INSERT INTO chunks (doc_id, tenant, ord, page, text, embedding) VALUES (?, ?, ?, ?, ?, ?)",
            [(cur.lastrowid, tenant, i, c["page"], c["text"], v.tobytes())
             for i, (c, v) in enumerate(zip(chunks, vectors))],
        )
    return {"filename": filename, "status": "updated" if existing else "new", "chunks": len(chunks)}
```

```python title="scripts/load_samples.py"
"""Download a few public documentation pages and ingest them for the 'demo' tenant."""
import httpx

from app.ingest import ingest
from app.store import connect

PAGES = ["controlflow", "datastructures", "modules", "inputoutput", "errors", "classes", "stdlib", "venv"]

conn = connect()
for name in PAGES:
    url = f"https://docs.python.org/3/tutorial/{name}.html"
    html = httpx.get(url, timeout=30, follow_redirects=True).content
    print(ingest(conn, "demo", f"{name}.html", html))
```

**How this code works**
- `UNIQUE (tenant, filename)` → two tenants can both upload `handbook.pdf` without colliding.
- `ON DELETE CASCADE` + `PRAGMA foreign_keys = ON` → deleting a document deletes its chunks. SQLite ignores foreign keys unless you turn them on per connection, a classic gotcha.
- `sha256` comparison → "re-index only changed files". Same bytes, same name: skip, zero embedding cost.
- Embedding happens *before* the transaction, so a provider error leaves the old version intact instead of a half-deleted document.
- `with db_lock, conn:` → the lock serialises writers across threads, and `conn` as a context manager commits on success or rolls back on error.
- `v.tobytes()` / `np.frombuffer` → vectors stored as raw float32 bytes: compact and fast to load.

**Run it**
```bash title="terminal"
python -m scripts.load_samples
python -m scripts.load_samples     # second run
```

**You should see**
```text
{'filename': 'controlflow.html', 'status': 'new', 'chunks': 31}
...
{'filename': 'controlflow.html', 'status': 'unchanged', 'chunks': 0}
```

**If it breaks**
- `ModuleNotFoundError: scripts` → run it from the `docqa/` folder with `python -m`, not `python scripts/load_samples.py`.
- `database is locked` → another process (an open DB browser) holds a write lock. Close it.
- Second run says `updated` instead of `unchanged` → the page changed between downloads (some sites embed timestamps). That is correct behaviour.

## Step 4 · Hybrid retrieval and a cited, declining answer
**Goal:** a function that answers a question with `[n]` citations, or declines when the evidence is weak.

Dense search finds paraphrases; BM25 finds exact tokens like `__init__` or error codes. Reciprocal rank fusion (RRF)
merges the two rankings without needing their scores to be comparable. For the decline decision we use the best
cosine similarity, because RRF scores have no absolute meaning.

```python title="app/retrieve.py"
import re

import numpy as np
from rank_bm25 import BM25Okapi

from app import llm

_reranker = None


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9_]+", text.lower())


def _top(scores: np.ndarray, k: int) -> list[tuple[int, float]]:
    order = np.argsort(-scores)[:k]
    return [(int(i), float(scores[i])) for i in order]


def rrf(*rankings: list[tuple[int, float]], k: int = 60) -> list[tuple[int, float]]:
    fused: dict[int, float] = {}
    for ranking in rankings:
        for rank, (idx, _) in enumerate(ranking):
            fused[idx] = fused.get(idx, 0.0) + 1.0 / (k + rank + 1)
    return sorted(fused.items(), key=lambda item: -item[1])


def rerank(query: str, meta: list[dict], candidates: list[tuple[int, float]], k: int):
    global _reranker
    from sentence_transformers import CrossEncoder  # optional: pip install sentence-transformers

    if _reranker is None:
        _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")  # check the current docs
    scores = _reranker.predict([(query, meta[i]["text"]) for i, _ in candidates])
    order = np.argsort(-scores)[:k]
    return [(candidates[j][0], float(scores[j])) for j in order]


def search(query: str, meta: list[dict], matrix: np.ndarray, mode: str = "hybrid", k: int = 5):
    """Return (hits, best_cosine). hits are (chunk_index, score) pairs, best first."""
    if not meta:
        return [], 0.0
    cosine = matrix @ llm.embed([query])[0]
    best = float(cosine.max())
    dense_hits = _top(cosine, 20)
    if mode == "dense":
        return dense_hits[:k], best
    bm25_hits = _top(BM25Okapi([_tokens(m["text"]) for m in meta]).get_scores(_tokens(query)), 20)
    if mode == "bm25":
        return bm25_hits[:k], best
    fused = rrf(dense_hits, bm25_hits)
    if mode == "hybrid":
        return fused[:k], best
    if mode == "rerank":
        return rerank(query, meta, fused[:20], k), best
    raise ValueError(f"unknown mode '{mode}'")
```

```python title="app/answer.py"
import time

from app import llm
from app.config import settings
from app.retrieve import search

SYSTEM = """You answer questions using ONLY the numbered sources provided.
Put a citation like [1] or [2][3] after every sentence.
If the sources do not contain the answer, reply with exactly: NOT_FOUND"""

DECLINE = "I couldn't find that in your documents."


def answer(question: str, meta: list[dict], matrix, mode: str = "hybrid", k: int = 5) -> dict:
    start = time.perf_counter()
    hits, best = search(question, meta, matrix, mode, k)
    result = {"answer": DECLINE, "declined": True, "sources": [], "best_score": round(best, 3),
              "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}

    if hits and best >= settings.min_score:
        sources = [meta[i] for i, _ in hits]
        context = "\n\n".join(
            f"[{n}] ({s['filename']}, page {s['page']})\n{s['text']}" for n, s in enumerate(sources, 1)
        )
        resp = llm.chat([
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Sources:\n{context}\n\nQuestion: {question}"},
        ])
        text = (resp.choices[0].message.content or "").strip()
        if resp.usage:
            tin, tout = resp.usage.prompt_tokens, resp.usage.completion_tokens
            result.update(tokens_in=tin, tokens_out=tout,
                          cost_usd=(tin * settings.price_in_per_m + tout * settings.price_out_per_m) / 1e6)
        if "NOT_FOUND" not in text:
            result.update(answer=text, declined=False, sources=[
                {"n": n, "filename": s["filename"], "page": s["page"], "snippet": s["text"][:240]}
                for n, s in enumerate(sources, 1)
            ])

    result["latency_ms"] = round((time.perf_counter() - start) * 1000)
    return result
```

**How this code works**
- `matrix @ query_vector` → one matrix multiply scores every chunk. For a few thousand chunks this is under a millisecond; you do not need a vector database yet. Say so in your README: it is a decision, not an omission.
- `BM25Okapi(...)` is rebuilt per query. Fine at portfolio scale; cache it per tenant if you grow past ~20k chunks.
- `rrf(..., k=60)` → each list contributes `1/(60 + rank)`. A chunk ranked well by both wins.
- `rerank` imports `sentence-transformers` lazily so the deployed image stays small; the eval tells you whether it earns its ~200 ms.
- Two decline gates: `best >= MIN_SCORE` skips the LLM call entirely (free), and `NOT_FOUND` catches cases where retrieval looked close but did not contain the answer.
- `cost_usd` is computed from the usage the provider returns, not estimated, so the README numbers are real.

**Run it**
```bash title="terminal"
python -c "
from app.store import connect, load_chunks; from app.answer import answer
meta, m = load_chunks(connect(), 'demo')
for q in ['How do I catch several exceptions in one except clause?', 'What is the capital of Peru?']:
    r = answer(q, meta, m); print(r['declined'], r['best_score'], r['answer'][:120])"
```

**You should see**
```text
False 0.612 You can name several exceptions in a parenthesised tuple, for example `except (RuntimeError, TypeError, NameError):` [1].
True 0.21 I couldn't find that in your documents.
```

**If it breaks**
- Everything declines → your embedding model scores lower overall (common with local models). Print `best_score` for 10 answerable and 10 unanswerable questions and set `MIN_SCORE` between the two groups.
- `shapes (n,1536) and (768,) not aligned` → you changed `EMBED_MODEL` after ingesting. Delete `data/docqa.db` and re-ingest; vectors from different models never mix.
- Answer without citations → small local models ignore the instruction sometimes. Add a one-shot example to `SYSTEM`.

## Step 5 · The API: auth, tenants, rate limits and cost logging
**Goal:** a FastAPI service where each API key only sees its own documents, with a request log you can sum.

```python title="app/main.py"
import json
import logging
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.answer import answer
from app.config import settings
from app.ingest import ingest
from app.store import connect, load_chunks

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("docqa")
app = FastAPI(title="DocQA")
conn = connect()
_recent_calls: dict[str, deque] = defaultdict(deque)
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def current_tenant(x_api_key: str = Header(...)) -> str:
    tenant = settings.api_keys.get(x_api_key)
    if tenant is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    return tenant


def rate_limited_tenant(tenant: str = Depends(current_tenant)) -> str:
    now, window = time.monotonic(), _recent_calls[tenant]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.rate_per_min:
        raise HTTPException(status_code=429, detail="rate limit reached, try again in a minute")
    window.append(now)
    return tenant


class AskBody(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    mode: str = Field(default="hybrid", pattern="^(dense|bm25|hybrid|rerank)$")


@app.post("/documents")
async def upload(file: UploadFile = File(...), tenant: str = Depends(current_tenant)):
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large (10 MB max)")
    try:
        result = ingest(conn, tenant, file.filename or "upload.txt", data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    log.info(json.dumps({"event": "ingest", "tenant": tenant, **result}))
    return result


@app.get("/documents")
def list_documents(tenant: str = Depends(current_tenant)):
    rows = conn.execute(
        """SELECT filename, created_at,
                  (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks
           FROM documents d WHERE tenant = ? ORDER BY created_at DESC""",
        (tenant,),
    ).fetchall()
    return [dict(r) for r in rows]


@app.post("/ask")
def ask(body: AskBody, tenant: str = Depends(rate_limited_tenant)):
    meta, matrix = load_chunks(conn, tenant)
    result = answer(body.question, meta, matrix, body.mode)
    log.info(json.dumps({
        "event": "ask", "tenant": tenant, "mode": body.mode, "declined": result["declined"],
        "tokens_in": result["tokens_in"], "tokens_out": result["tokens_out"],
        "cost_usd": round(result["cost_usd"], 6), "latency_ms": result["latency_ms"],
    }))
    return result


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def home():
    return Path(__file__).parent.joinpath("static/index.html").read_text(encoding="utf-8")
```

```html title="app/static/index.html"
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DocQA</title>
<style>body{font:16px system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}input,button,textarea{font:inherit;margin:.25rem 0;width:100%}
.src{font-size:.85rem;color:#555;border-left:3px solid #ccc;padding-left:.5rem;margin:.5rem 0}</style></head>
<body>
<h1>DocQA</h1>
<p>Try the demo key <code>demo-public</code> (Python tutorial docs are preloaded) or your own.</p>
<input id="key" placeholder="API key" value="demo-public">
<input id="file" type="file" accept=".pdf,.docx,.html,.htm,.txt,.md"><button onclick="upload()">Upload</button>
<textarea id="q" rows="2" placeholder="Ask a question"></textarea><button onclick="ask()">Ask</button>
<div id="out"></div>
<script>
const out = document.getElementById("out"), key = () => document.getElementById("key").value;
async function upload() {
  const fd = new FormData(); fd.append("file", document.getElementById("file").files[0]);
  const r = await fetch("/documents", {method: "POST", headers: {"X-API-Key": key()}, body: fd});
  out.textContent = JSON.stringify(await r.json());
}
async function ask() {
  out.textContent = "Thinking...";
  const r = await fetch("/ask", {method: "POST", headers: {"X-API-Key": key(), "Content-Type": "application/json"},
    body: JSON.stringify({question: document.getElementById("q").value})});
  const d = await r.json();
  if (!r.ok) { out.textContent = d.detail; return; }
  out.innerHTML = "<p></p>"; out.firstChild.textContent = d.answer;
  for (const s of d.sources) { const p = document.createElement("div"); p.className = "src";
    p.textContent = `[${s.n}] ${s.filename} p.${s.page}: ${s.snippet}…`; out.appendChild(p); }
  const m = document.createElement("small"); m.textContent = `${d.latency_ms} ms · $${d.cost_usd.toFixed(5)}`; out.appendChild(m);
}
</script></body></html>
```

**How this code works**
- `current_tenant` is a FastAPI dependency: every route that declares it gets a tenant or a 401, and the route never sees the raw key. Tenant isolation then follows from `load_chunks(conn, tenant)`.
- `rate_limited_tenant` keeps a sliding 60-second window of timestamps per tenant. It lives in memory, so it resets on restart and is per-machine; that is acceptable for one instance and worth a sentence in your README.
- Only `/ask` is rate limited because it is the endpoint that costs money on every call.
- `MAX_UPLOAD_BYTES` → stops someone from sending a 2 GB file to your free-tier machine.
- The JSON log line per request is your cost ledger: `grep '"event": "ask"'` and sum `cost_usd`.
- The UI sets `textContent`, never `innerHTML`, with model output, so a document cannot inject script into the page.

**Run it**
```bash title="terminal"
export API_KEYS="dev-key:demo,demo-public:demo,other-key:acme"
uvicorn app.main:app --reload
# in a second terminal
curl -s -X POST localhost:8000/ask -H "X-API-Key: dev-key" -H "Content-Type: application/json" -d '{"question":"What does the else clause on a for loop do?"}'
curl -s -X POST localhost:8000/ask -H "X-API-Key: other-key" -H "Content-Type: application/json" -d '{"question":"What does the else clause on a for loop do?"}'
```

**You should see**
```text
{"answer":"The else clause runs when the loop finishes without hitting break [1].","declined":false,...}
{"answer":"I couldn't find that in your documents.","declined":true,...}
```
The second tenant has no documents, so it gets the decline. Open http://localhost:8000 for the UI.

**If it breaks**
- `422 Unprocessable Entity` on upload → `python-multipart` is missing, or the form field is not named `file`.
- `401` with the right key → `API_KEYS` was exported in a different terminal from the one running uvicorn.
- `{"detail":"rate limit reached"}` during testing → raise `RATE_PER_MIN` locally.

## Step 6 · Tests that prove isolation and incremental ingestion
**Goal:** a pytest suite that runs offline in under two seconds.

We replace the embedding call with a deterministic fake, so tests do not need a key and never flake. A two-line
`pytest.ini` puts the project root on the import path.

```ini title="pytest.ini"
[pytest]
pythonpath = .
```

```python title="tests/test_platform.py"
import hashlib

import numpy as np
import pytest

from app import llm
from app.chunk import chunk_pages
from app.ingest import ingest
from app.store import connect, load_chunks


def fake_embed(texts: list[str]) -> np.ndarray:
    out = np.zeros((len(texts), 64), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in text.lower().split():
            out[row, int(hashlib.md5(word.encode()).hexdigest(), 16) % 64] += 1
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(llm, "embed", fake_embed)
    return connect(str(tmp_path / "test.db"))


def test_chunks_never_exceed_limit():
    chunks = chunk_pages([(1, "x" * 5000)], max_chars=1000, overlap=100)
    assert all(len(c["text"]) <= 1000 for c in chunks)


def test_unchanged_file_is_skipped(conn):
    assert ingest(conn, "alice", "a.txt", b"Refunds take 5 days.")["status"] == "new"
    assert ingest(conn, "alice", "a.txt", b"Refunds take 5 days.")["status"] == "unchanged"
    assert ingest(conn, "alice", "a.txt", b"Refunds take 7 days.")["status"] == "updated"
    meta, _ = load_chunks(conn, "alice")
    assert [m["text"] for m in meta] == ["Refunds take 7 days."]  # old version gone


def test_tenants_are_isolated(conn):
    ingest(conn, "alice", "secret.txt", b"Alice's salary is 90k.")
    ingest(conn, "bob", "notes.txt", b"Bob likes tea.")
    alice_meta, _ = load_chunks(conn, "alice")
    bob_meta, _ = load_chunks(conn, "bob")
    assert all("salary" not in m["text"] for m in bob_meta)
    assert {m["filename"] for m in alice_meta} == {"secret.txt"}


def test_scanned_pdf_style_empty_file_is_rejected(conn):
    with pytest.raises(ValueError):
        ingest(conn, "alice", "empty.txt", b"   ")
```

**How this code works**
- `monkeypatch.setattr(llm, "embed", fake_embed)` works because `ingest` and `retrieve` call `llm.embed` through the module, not via `from app.llm import embed`. That import style is a deliberate testability choice.
- `fake_embed` hashes words into 64 buckets: crude, but deterministic, and similar texts get similar vectors.
- `test_unchanged_file_is_skipped` checks all three outcomes *and* that the old chunks were deleted, which is the bug you would actually ship.
- `test_tenants_are_isolated` is the test to mention in an interview when someone asks about multi-tenancy.

**Run it**
```bash title="terminal"
pytest -q
```

**You should see**
```text
....                                                                     [100%]
4 passed in 0.41s
```

**If it breaks**
- `ModuleNotFoundError: app` → `pytest.ini` is missing or not in the folder you run `pytest` from.
- Tests call the real API → you imported `embed` directly somewhere (`from app.llm import embed`). Switch to `from app import llm`.

## Step 7 · Build a 40-question retrieval eval
**Goal:** `eval/questions.jsonl` with at least 40 reviewed questions, each tied to the chunk that answers it.

An eval set is the single most convincing thing in this repo. We let the model draft questions from random chunks,
then you review every one by hand. Drafting is cheap; the review is what makes it trustworthy.

```python title="eval/make_questions.py"
"""Draft one question per sampled chunk. YOU must review the output before using it."""
import json
import random

from app import llm
from app.store import connect, load_chunks

PROMPT = """Write ONE question a real user might ask that is answered by the passage below.
Do not copy phrases verbatim; paraphrase like a person would. Reply with the question only.

Passage:
{text}"""

random.seed(7)
meta, _ = load_chunks(connect(), "demo")
picked = random.sample(range(len(meta)), k=min(55, len(meta)))  # draft extra, discard weak ones
with open("eval/questions.draft.jsonl", "w", encoding="utf-8") as f:
    for i in picked:
        chunk = meta[i]
        if len(chunk["text"]) < 200:  # skip headings and fragments
            continue
        resp = llm.chat([{"role": "user", "content": PROMPT.format(text=chunk["text"])}])
        question = resp.choices[0].message.content.strip()
        row = {"question": question, "filename": chunk["filename"], "ord": chunk["ord"]}
        f.write(json.dumps(row) + "\n")
        print(row)
```

**How this code works**
- Each row stores `filename` + `ord` (chunk position), which stays stable as long as you keep the same chunk settings. If you change `max_chars`, regenerate.
- "Do not copy phrases verbatim" matters: copied wording makes BM25 look unrealistically good.
- `random.seed(7)` → the draft is reproducible, so a reviewer can regenerate it.

Now review: open `questions.draft.jsonl`, delete questions that are vague, answered by several chunks, or unanswerable,
fix awkward wording, and add 5 to 10 questions of your own with exact terms (`__name__`, `f-string`). Save the result as
`eval/questions.jsonl` with at least 40 lines. Also write 10 questions the documents cannot answer into
`eval/unanswerable.txt`, one per line; you will use them to check the decline rate.

**Run it**
```bash title="terminal"
python -m eval.make_questions
wc -l eval/questions.jsonl
```

**You should see**
```text
{'question': 'How can I make a module run code only when executed as a script?', 'filename': 'modules.html', 'ord': 4}
...
42 eval/questions.jsonl
```

**If it breaks**
- Questions are trivially easy → the passage was a heading. Raise the 200-character floor.
- `ModuleNotFoundError: eval` → add `eval/__init__.py` (it is a package name here, not the built-in function).

## Step 8 · Run the eval and publish the table
**Goal:** one command prints a Markdown table of hit rate, MRR, latency and decline accuracy for each retriever.

```python title="eval/run_eval.py"
import importlib.util
import json
import statistics
import time

from app.config import settings
from app.retrieve import search
from app.store import connect, load_chunks

K = 5
questions = [json.loads(line) for line in open("eval/questions.jsonl", encoding="utf-8")]
unanswerable = [q.strip() for q in open("eval/unanswerable.txt", encoding="utf-8") if q.strip()]
meta, matrix = load_chunks(connect(), "demo")

modes = ["dense", "bm25", "hybrid"]
if importlib.util.find_spec("sentence_transformers"):
    modes.append("rerank")

print(f"{len(questions)} questions, {len(meta)} chunks, k={K}\n")
print("| Retriever | Hit rate @5 | MRR | Median search ms | Correct declines |")
print("|---|---|---|---|---|")
for mode in modes:
    hits, reciprocal_ranks, timings = 0, [], []
    for q in questions:
        t0 = time.perf_counter()
        results, _ = search(q["question"], meta, matrix, mode, K)
        timings.append((time.perf_counter() - t0) * 1000)
        ranked = [(meta[i]["filename"], meta[i]["ord"]) for i, _ in results]
        target = (q["filename"], q["ord"])
        if target in ranked:
            hits += 1
            reciprocal_ranks.append(1 / (ranked.index(target) + 1))
        else:
            reciprocal_ranks.append(0.0)
    declined = sum(search(q, meta, matrix, "dense", 1)[1] < settings.min_score for q in unanswerable)
    print(f"| {mode} | {hits / len(questions):.2f} | {statistics.mean(reciprocal_ranks):.2f} "
          f"| {statistics.median(timings):.0f} | {declined}/{len(unanswerable)} |")
```

**How this code works**
- **Hit rate @5** → share of questions whose labelled chunk is in the top 5. **MRR** rewards putting it first: rank 1 scores 1, rank 2 scores 0.5, missing scores 0.
- Timings include the query embedding call, so dense and hybrid look similar; the reranker's extra cost shows up clearly.
- "Correct declines" checks the cheap gate only (no LLM call). Report it next to hit rate: a system that never declines will happily answer the capital of Peru from Python docs.
- The strict `(filename, ord)` match under-counts when the neighbouring chunk (thanks to overlap) also holds the answer. Note this in the README; it makes every variant look slightly worse, equally.

**Run it**
```bash title="terminal"
python -m eval.run_eval | tee eval/results.md
```

**You should see** (your numbers will differ; that is the point)
```text
42 questions, 241 chunks, k=5

| Retriever | Hit rate @5 | MRR | Median search ms | Correct declines |
|---|---|---|---|---|
| dense | 0.79 | 0.62 | 210 | 9/10 |
| bm25 | 0.64 | 0.49 | 205 | 9/10 |
| hybrid | 0.86 | 0.68 | 214 | 9/10 |
| rerank | 0.90 | 0.77 | 395 | 9/10 |
```

Pick the default `mode` from this table and write down why. "Rerank adds ~180 ms for +4 points of hit rate; I kept
hybrid as the default on the free tier and expose rerank as an option" is exactly the sentence reviewers look for.
Then look at the misses: open three failed questions and write in `eval/misses.md` what went wrong (bad chunk boundary,
vocabulary mismatch, ambiguous question).

**If it breaks**
- Hit rate near 0 for every mode → you re-chunked after drafting questions, so `ord` values moved. Regenerate the questions.
- BM25 beats dense by a lot → your questions copy the passage wording. Rewrite the worst offenders.

## Step 9 · Containerise and deploy to a public URL
**Goal:** the service runs on Fly.io with a persistent volume, secrets, and the demo documents preloaded.

```dockerfile title="Dockerfile"
FROM python:3.11-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 DB_PATH=/data/docqa.db
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts ./scripts
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

**How this code works**
- `python:3.11-slim` without `sentence-transformers` keeps the image around 250 MB instead of 2 GB+ with PyTorch, so the free machine starts fast.
- `DB_PATH=/data/docqa.db` → the database lives on a mounted volume, so uploads survive deploys. Without a volume, every deploy wipes your users' documents.
- `PYTHONUNBUFFERED=1` → logs appear immediately in `fly logs`, which is where your cost lines go.

**Run it**
```bash title="terminal"
docker build -t docqa . && docker run --rm -p 8080:8080 -e OPENAI_API_KEY -e API_KEYS="dev-key:demo" -v "$PWD/data:/data" docqa
# then deploy
fly launch --no-deploy            # accept the generated fly.toml, choose a region near you
fly volumes create docqa_data --size 1
```
Edit the generated `fly.toml` so it contains these sections (change the existing `[http_service]` block rather than adding a second one), then set secrets and deploy:
```toml title="fly.toml (add)"
[mounts]
  source = "docqa_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  auto_stop_machines = "stop"
  min_machines_running = 0
```
```bash title="terminal"
MYKEY=$(openssl rand -hex 16); echo "your private key: $MYKEY"
fly secrets set OPENAI_API_KEY=sk-... API_KEYS="demo-public:demo,$MYKEY:you" RATE_PER_MIN=10
fly deploy
fly ssh console -C "python -m scripts.load_samples"
```

**You should see**
```text
Visit your newly deployed app at https://docqa-yourname.fly.dev/
{'filename': 'controlflow.html', 'status': 'new', 'chunks': 31}
```

**If it breaks**
- App crashes with `unable to open database file` → the volume is not mounted; check `[mounts]` and that the volume is in the same region as the machine.
- First request takes 5-10 s → `auto_stop_machines` stopped the idle machine; that is the price of free. Mention it on the demo page, or set `min_machines_running = 1` (a few dollars a month).
- Render instead of Fly → use a "Web Service" from the Dockerfile and attach a disk at `/data` (paid plans only; on the free plan, reload samples at startup). Hugging Face Spaces → Docker Space, port 7860.

**Protect your wallet:** the public demo key shares the `demo` tenant and is rate limited, but also set a monthly
spending limit in your provider's dashboard. A public link plus an uncapped key is how people get surprise bills.

## Ship it
Write the README in this order (see lesson 15.7):

1. **One line and links:** "Upload documents and ask questions; answers cite their sources and decline when evidence is thin." Live demo URL, demo key `demo-public`, a 2-minute video.
2. **Architecture diagram:** the text diagram above, or a cleaner image of it.
3. **Results:** the table from `eval/results.md`, plus cost per question. Compute it from logs: `fly logs | grep '"event": "ask"'`, then average `cost_usd`. A typical line reads "$0.0004 per question, p50 1.4 s end to end".
4. **Key decisions:** SQLite + NumPy instead of a vector DB (and the scale where you would switch), hybrid by default and why, the `MIN_SCORE` value and how you chose it.
5. **What didn't work:** something real from `eval/misses.md`.
6. **Run it locally:** the commands from Steps 1, 3 and 5.

Demo checklist: upload a PDF on camera, ask a question it answers (show the citation), ask one it cannot (show the
decline), switch API keys to show isolation, show the eval table.

## Going further
- Add an answer-quality eval: an LLM judge scores faithfulness of each answer against its cited chunks, run in GitHub Actions on every push.
- Handle scanned PDFs: when a page has no text, render it with `pypdfium2` and send it to a vision model; report hit rate with and without OCR.
- Stream answers token by token with `StreamingResponse` so the UI feels faster than the p50 suggests.
- Replace env-var keys with real accounts (magic-link email or OAuth) and store keys hashed.
- Move vectors to Qdrant or pgvector and re-run the eval to show nothing regressed.
