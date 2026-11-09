---
project: hybrid-search-engine
title: Hybrid search engine
hours: 8
stack: Python 3.11+, FastAPI, Qdrant (Docker or embedded), rank-bm25, sentence-transformers, pytest
cost: Free (runs locally; free hosting on Hugging Face Spaces)
---

You will index a real document collection, the 423 accepted and final Python Enhancement Proposals (PEPs), about a million words, and serve three kinds of search behind one API: dense (embeddings in Qdrant), keyword (BM25) and hybrid (both, fused with Reciprocal Rank Fusion), with metadata filters on status, type and year. You will write 30 test questions, each with the passage that should come back, and report hit rate at k=5 for every retriever, plus what the misses teach you. This is the retrieval half of every RAG app; the next project (`advanced-rag-app`) adds generation on top of exactly this code.

## Before you start

- **Python 3.11+**, about **3 GB free disk** (PyTorch + models) and 4 GB RAM.
- **Docker** for Qdrant (`docker --version`). No Docker? Every step also works with Qdrant's embedded mode: set `QDRANT_URL=./qdrant_local` in `.env`.
- No API keys: embeddings run locally with `BAAI/bge-small-en-v1.5` (downloaded on first use, ~130 MB).

Final folder structure:

```text
hybrid-search/
├── app/
│   ├── __init__.py
│   ├── config.py        paths, Qdrant URL, model names
│   ├── ingest.py        raw .rst -> clean docs with metadata
│   ├── chunking.py      section-aware chunks
│   ├── embeddings.py    sentence-transformers wrapper
│   ├── store.py         Qdrant client (server or embedded)
│   ├── index.py         embed + upsert into Qdrant
│   ├── retrievers.py    dense, BM25, hybrid (RRF), filters
│   └── api.py           FastAPI /search + small HTML page
├── scripts/
│   ├── __init__.py
│   └── download_peps.py
├── eval/
│   ├── __init__.py
│   ├── questions.jsonl  30 questions with expected passages
│   └── evaluate.py      hit@k, MRR, misses
├── tests/
│   ├── __init__.py
│   └── test_retrieval.py
├── data/                raw/, docs.jsonl, chunks.jsonl (generated)
├── Dockerfile
├── pytest.ini
├── requirements.txt
├── .env.example
└── README.md
```

## How it fits together

```text
 OFFLINE (once)                                   ONLINE (per query)
 PEPs tarball ──► ingest ──► docs.jsonl           GET /search?q=...&mode=hybrid&status=Final
                              │                          │
                          chunking                       ├──► dense: embed query ──► Qdrant top 30 (+ filter)
                              │                          │
                        chunks.jsonl ──┬──► embed ──► Qdrant (vectors + payload)
                                       │                 ├──► BM25 over chunks.jsonl top 30 (+ filter)
                                       └──► BM25 index (built at startup)
                                                         │
                                                         └──► RRF fuse ranks ──► top k with scores + ranks
```

Offline, the PEP files are downloaded, cleaned into documents with metadata (title, status, type, year), split into chunks along section boundaries, embedded, and stored in Qdrant with their metadata as payload. Online, a query goes to one retriever or both: the dense retriever embeds the query and asks Qdrant for the nearest chunks that match the filters; BM25 scores every chunk on exact word overlap. Hybrid takes the top 30 from each and fuses them by rank, so a chunk that both methods like rises to the top. The API returns the chunks with their scores and their rank in each list, so you can see why something came back.

## Step 1 · Set up the project and start Qdrant

**Goal:** dependencies installed and a Qdrant server answering on port 6333.

```bash title="terminal"
mkdir hybrid-search && cd hybrid-search
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir app scripts eval tests data
touch app/__init__.py scripts/__init__.py eval/__init__.py tests/__init__.py   # Windows: type nul > app\__init__.py (etc.)
```

```text title="requirements.txt"
fastapi>=0.115
uvicorn>=0.30
httpx>=0.27
python-dotenv>=1.0
numpy>=1.26
qdrant-client>=1.12
rank-bm25>=0.2.2
sentence-transformers>=3.0
pytest>=8.0
```

```text title=".env.example"
QDRANT_URL=http://localhost:6333
# QDRANT_URL=./qdrant_local        # embedded mode, no Docker needed
COLLECTION=peps
EMBED_MODEL=BAAI/bge-small-en-v1.5
CHUNK_WORDS=220
```

```ini title="pytest.ini"
[pytest]
pythonpath = .
```

```bash title="terminal"
pip install -r requirements.txt          # pulls PyTorch; takes a few minutes the first time
cp .env.example .env
docker run -d --name qdrant -p 6333:6333 -v qdrant_data:/qdrant/storage qdrant/qdrant:v1.12.4
```

**How this code works**
- `qdrant/qdrant:v1.12.4` → pinned so the server and client versions stay compatible; any recent 1.x works. The named volume `qdrant_data` keeps your index when the container restarts.
- `QDRANT_URL=./qdrant_local` → the client can run Qdrant **inside your Python process**, storing data in a folder. Same API, no server; only one process can open the folder at a time.
- `sentence-transformers` installs PyTorch. On a machine without a GPU, `pip install torch --index-url https://download.pytorch.org/whl/cpu` first gives you a much smaller CPU-only build.

**Run it**
```bash
curl -s localhost:6333/collections
```

**You should see**
```text
{"result":{"collections":[]},"status":"ok","time":2.1e-05}
```

**If it breaks**
- `curl: (7) Failed to connect` → the container is not running → `docker ps`, `docker logs qdrant`.
- `pip` fails building something on Windows → use Python 3.11 or 3.12; very new Python versions sometimes lack wheels for PyTorch.

## Step 2 · Ingest a real corpus with metadata

**Goal:** `data/docs.jsonl` holds every Final, Active and Accepted PEP as clean text split into sections, with title, status, type and creation year.

PEPs are a good corpus: real, public, a few hundred documents, consistent structure, and rich metadata in each file's header. We download the official repository as one tarball and read only the `peps/pep-NNNN.rst` files.

```python title="scripts/download_peps.py"
"""Download the Python Enhancement Proposals (PEPs) as raw reStructuredText into data/raw/."""
import io
import re
import tarfile
from pathlib import Path

import httpx

URL = "https://codeload.github.com/python/peps/tar.gz/refs/heads/main"
OUT = Path("data/raw")
NAME = re.compile(r"/peps/(pep-\d{4})\.rst$")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {URL} ...")
    resp = httpx.get(URL, follow_redirects=True, timeout=120)
    resp.raise_for_status()
    count = 0
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
        for member in tar.getmembers():
            match = NAME.search(member.name)
            if not match or not member.isfile():
                continue
            data = tar.extractfile(member).read()  # read bytes only; never extract paths from an archive blindly
            (OUT / f"{match.group(1)}.rst").write_bytes(data)
            count += 1
    print(f"Saved {count} PEP files to {OUT}/ ({len(resp.content) / 1e6:.1f} MB download)")


if __name__ == "__main__":
    main()
```

```python title="app/config.py"
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

DATA_DIR = Path(os.getenv("DATA_DIR", "data"))
DOCS_FILE = DATA_DIR / "docs.jsonl"
CHUNKS_FILE = DATA_DIR / "chunks.jsonl"

# "http://..." = a Qdrant server; anything else = a local folder (no Docker needed).
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.getenv("COLLECTION", "peps")

EMBED_MODEL = os.getenv("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
# bge models expect this prefix on queries (not on documents); check the model card for yours.
QUERY_PREFIX = os.getenv("QUERY_PREFIX", "Represent this sentence for searching relevant passages: ")

CHUNK_WORDS = int(os.getenv("CHUNK_WORDS", "220"))
```

```python title="app/ingest.py"
"""Parse raw PEP files into clean documents with metadata: data/raw/*.rst -> data/docs.jsonl."""
import json
import re
from pathlib import Path

from app.config import DATA_DIR, DOCS_FILE

KEEP_STATUS = {"Final", "Active", "Accepted"}   # PEPs that describe Python as it is
DROP_SECTIONS = {"copyright", "references", "footnotes", "acknowledgements", "acknowledgments"}
UNDERLINE = re.compile(r"^([=\-~^\"'`#*+])\1{2,}\s*$")


def parse_header(text: str) -> tuple[dict, str]:
    """PEP files start with 'Key: value' lines (continuations indented), then a blank line."""
    header: dict[str, str] = {}
    lines = text.splitlines()
    key = None
    i = 0
    for i, line in enumerate(lines):
        if not line.strip():
            break
        if line[0].isspace() and key:
            header[key] += " " + line.strip()
        elif ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            header[key] = value.strip()
    return header, "\n".join(lines[i + 1:])


def clean_rst(body: str) -> str:
    """Strip reStructuredText markup but keep headings, paragraphs and code."""
    text = re.sub(r":[\w:]+:`([^`<]*?)\s*(?:<[^>]*>)?`", r"\1", body)       # :pep:`8`, :ref:`x <y>` -> text
    text = re.sub(r"`([^`<]+?)\s*<[^>]+>`_+", r"\1", text)                 # `text <url>`_ -> text
    text = re.sub(r"``([^`]+)``", r"\1", text)                             # ``code`` -> code
    text = re.sub(r"`([^`]+)`_+", r"\1", text)                             # `ref`_ -> ref
    text = re.sub(r"^\.\. (?:code-block|code|sourcecode)::.*$", "", text, flags=re.M)
    text = re.sub(r"^\.\. (?:_[^:]+:|\[[^\]]+\]|\|[^|]+\|).*$", "", text, flags=re.M)   # link targets, footnotes
    text = re.sub(r"^\.\. [\w-]+::.*$", "", text, flags=re.M)              # other directives (note, image...)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sections(text: str) -> list[tuple[str, str]]:
    """Split on rst headings (a line followed by an underline). Returns (heading, body) pairs."""
    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = [("Introduction", [])]
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if line.strip() and UNDERLINE.match(nxt) and len(nxt.strip()) >= len(line.strip()) - 2:
            sections.append((line.strip(), []))
            i += 2
            continue
        if not UNDERLINE.match(line):
            sections[-1][1].append(line)
        i += 1
    return [(h, "\n".join(b).strip()) for h, b in sections if "\n".join(b).strip()]


def parse_pep(path: Path) -> dict | None:
    raw = path.read_text(encoding="utf-8", errors="replace")
    header, body = parse_header(raw)
    if header.get("Status") not in KEEP_STATUS or "PEP" not in header:
        return None
    year = re.search(r"(19|20)\d{2}", header.get("Created", ""))
    sections = [(h, b) for h, b in split_sections(clean_rst(body)) if h.lower() not in DROP_SECTIONS]
    return {
        "doc_id": f"pep-{int(header['PEP']):04d}",
        "pep": int(header["PEP"]),
        "title": header.get("Title", ""),
        "status": header["Status"],
        "type": header.get("Type", ""),
        "created_year": int(year.group(0)) if year else None,
        "python_version": header.get("Python-Version"),
        "url": f"https://peps.python.org/pep-{int(header['PEP']):04d}/",
        "sections": [{"heading": h, "text": b} for h, b in sections],
    }


def main() -> None:
    docs = [d for p in sorted((DATA_DIR / "raw").glob("pep-*.rst")) if (d := parse_pep(p))]
    with DOCS_FILE.open("w", encoding="utf-8") as f:
        for d in docs:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    words = sum(len(s["text"].split()) for d in docs for s in d["sections"])
    by_status = {s: sum(d["status"] == s for d in docs) for s in sorted(KEEP_STATUS)}
    print(f"Kept {len(docs)} PEPs {by_status} · {words:,} words -> {DOCS_FILE}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `tar.extractfile(member).read()` and writing to a name we build ourselves → we never call `extractall`; a malicious archive could otherwise write outside the target folder. Only files matching `peps/pep-NNNN.rst` are kept.
- `parse_header` → each PEP starts with `PEP:`, `Title:`, `Status:`, `Type:`, `Created:` lines; indented lines continue the previous field (long author lists). The first blank line ends the header.
- `KEEP_STATUS` → rejected, withdrawn and draft PEPs describe Python as it is **not**. Indexing them would make search return confidently wrong answers. Deciding what not to index is part of ingestion.
- `clean_rst` → removes markup that would pollute both embeddings and BM25 (`:pep:` roles, link syntax, directives) while keeping the words and code. Each regex handles one construct; when you see junk in a chunk later, this is where you fix it.
- `split_sections` → rst headings are a line followed by an underline of `=`, `-`, `~` and so on. Sections are the natural unit of meaning in a PEP, and the heading becomes metadata used in chunking and shown in results.
- `DROP_SECTIONS` → copyright notices and reference lists are noise: they match many keyword queries and answer none.
- `created_year` → stored as an integer so it can be range-filtered (`year_from=2020`).

**Run it**
```bash
python -m scripts.download_peps
python -m app.ingest
```

**You should see**
```text
Downloading https://codeload.github.com/python/peps/tar.gz/refs/heads/main ...
Saved 750 PEP files to data/raw/ (7.1 MB download)
Kept 423 PEPs {'Accepted': 11, 'Active': 37, 'Final': 375} · 1,030,128 words -> data/docs.jsonl
```

Counts drift slightly as new PEPs are accepted.

**If it breaks**
- `httpx.ConnectTimeout` → GitHub blocked or slow on your network → download the tarball in a browser, then adapt the script to open the local file.
- `Saved 0 PEP files` → the repository layout changed → `tar -tzf` the tarball and update the `NAME` regex.

## Step 3 · Chunk with a strategy you can justify

**Goal:** `data/chunks.jsonl` holds about 9,000 section-aware chunks of up to ~220 words, each carrying its document's metadata.

The strategy: never cross a section boundary, pack whole paragraphs up to about 220 words, carry a short last paragraph over as overlap, and prefix each chunk with `PEP N: Title > Section` when embedding. Why: sections are self-contained topics; 220 words (~300 tokens) fits comfortably inside the 512-token window of small embedding models, so nothing is truncated; and the header gives a chunk like "Limit all lines to 79 characters" the context that it is about PEP 8's style guide.

```python title="app/chunking.py"
"""Split documents into section-aware chunks: data/docs.jsonl -> data/chunks.jsonl."""
import json

from app.config import CHUNK_WORDS, CHUNKS_FILE, DOCS_FILE


def pack_paragraphs(text: str, max_words: int) -> list[str]:
    """Greedily pack whole paragraphs up to max_words; split a paragraph only if it alone is too long."""
    chunks: list[str] = []
    current: list[str] = []
    count = 0
    for para in [p.strip() for p in text.split("\n\n") if p.strip()]:
        words = para.split()
        if len(words) > max_words:  # one huge paragraph: hard-split it
            if current:
                chunks.append("\n\n".join(current))
                current, count = [], 0
            for i in range(0, len(words), max_words):
                chunks.append(" ".join(words[i:i + max_words]))
            continue
        if count + len(words) > max_words and current:
            chunks.append("\n\n".join(current))
            # carry the last paragraph over as overlap if it is short, so context is not cut mid-thought
            current = [current[-1]] if len(current[-1].split()) < max_words // 4 else []
            count = sum(len(p.split()) for p in current)
        current.append(para)
        count += len(words)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def chunk_doc(doc: dict, max_words: int = CHUNK_WORDS) -> list[dict]:
    out = []
    for section in doc["sections"]:
        for text in pack_paragraphs(section["text"], max_words):
            if len(text.split()) < 12:  # skip fragments like a lone code line
                continue
            n = len(out)
            out.append({
                "chunk_id": f"{doc['doc_id']}#{n}",
                "doc_id": doc["doc_id"],
                "pep": doc["pep"],
                "title": doc["title"],
                "section": section["heading"],
                "status": doc["status"],
                "type": doc["type"],
                "created_year": doc["created_year"],
                "url": doc["url"],
                "text": text,
            })
    return out


def embed_text(chunk: dict) -> str:
    """What we embed and keyword-index: a short header for context, then the chunk itself."""
    return f"PEP {chunk['pep']}: {chunk['title']} > {chunk['section']}\n{chunk['text']}"


def main() -> None:
    docs = [json.loads(line) for line in DOCS_FILE.read_text(encoding="utf-8").splitlines()]
    chunks = [c for d in docs for c in chunk_doc(d)]
    with CHUNKS_FILE.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    sizes = sorted(len(c["text"].split()) for c in chunks)
    print(f"{len(docs)} docs -> {len(chunks)} chunks · words per chunk: "
          f"median {sizes[len(sizes) // 2]}, p95 {sizes[int(len(sizes) * 0.95)]}, max {sizes[-1]} -> {CHUNKS_FILE}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `text.split("\n\n")` → paragraphs (and code blocks, which are blank-line separated in rst) stay whole. Fixed-size character windows would cut sentences and code in half.
- The hard-split branch → rare giant paragraphs (tables, long code listings) still produce chunks under the limit.
- Overlap of one short paragraph → a lead-in sentence like "The following rules apply:" stays with what follows it. Overlap is only carried when it is short, so chunks do not balloon.
- `len(text.split()) < 12` → tiny fragments embed poorly and match everything weakly.
- Every chunk copies `status`, `type`, `created_year` → metadata must live **on the chunk** to filter at query time.
- `chunk_id` like `pep-0008#14` → stable, readable ids; you will see them in eval output.
- `embed_text` → both the embedding and BM25 see the header, so a query "PEP 8 line length" matches on "PEP 8" too.

**Run it**
```bash
python -m app.chunking
python -c "import json; c=[json.loads(l) for l in open('data/chunks.jsonl', encoding='utf-8')]; x=[x for x in c if x['pep']==8 and 'Line Length' in x['section']][0]; print(x['chunk_id'], x['section']); print(x['text'][:200])"
```

**You should see**
```text
423 docs -> 8897 chunks · words per chunk: median 117, p95 215, max 257 -> data/chunks.jsonl
pep-0008#12 Maximum Line Length
Limit all lines to a maximum of 79 characters.

For flowing long blocks of text with fewer structural restrictions
(docstrings or comments), the line length should be limited to 72
```

**If it breaks**
- Chunks contain `.. code-block::` or `:pep:` → a markup form `clean_rst` misses → add a regex and re-run ingest and chunking.
- Median chunk size is tiny (under 40) → headings were not detected and every line became a section → print `split_sections` for one file and check the underline regex.

## Step 4 · Embed and index into Qdrant

**Goal:** every chunk's vector and metadata stored in a Qdrant collection, with payload indexes on the fields you filter by.

```python title="app/embeddings.py"
from functools import lru_cache

import numpy as np
from sentence_transformers import SentenceTransformer

from app.config import EMBED_MODEL, QUERY_PREFIX


@lru_cache
def get_model() -> SentenceTransformer:
    return SentenceTransformer(EMBED_MODEL)


def embed_documents(texts: list[str], batch_size: int = 64) -> np.ndarray:
    return get_model().encode(texts, batch_size=batch_size, normalize_embeddings=True,
                              show_progress_bar=True, convert_to_numpy=True)


def embed_query(text: str) -> list[float]:
    vec = get_model().encode(QUERY_PREFIX + text, normalize_embeddings=True, convert_to_numpy=True)
    return vec.tolist()
```

```python title="app/store.py"
from qdrant_client import QdrantClient

from app.config import QDRANT_URL


def get_client() -> QdrantClient:
    if QDRANT_URL.startswith("http"):
        return QdrantClient(url=QDRANT_URL, timeout=30)
    return QdrantClient(path=QDRANT_URL)  # embedded mode: data in a local folder, one process at a time
```

```python title="app/index.py"
"""Embed every chunk and load it into Qdrant: data/chunks.jsonl -> collection 'peps'."""
import json
import time

from qdrant_client.models import Distance, PayloadSchemaType, PointStruct, VectorParams

from app.chunking import embed_text
from app.config import CHUNKS_FILE, COLLECTION, EMBED_MODEL
from app.embeddings import embed_documents, get_model
from app.store import get_client


def main() -> None:
    chunks = [json.loads(line) for line in CHUNKS_FILE.read_text(encoding="utf-8").splitlines()]
    dim = len(get_model().encode("dimension probe"))  # works across sentence-transformers versions
    client = get_client()

    if client.collection_exists(COLLECTION):
        client.delete_collection(COLLECTION)  # full rebuild: simple and always consistent
    client.create_collection(COLLECTION, vectors_config=VectorParams(size=dim, distance=Distance.COSINE))
    for field, schema in [("status", PayloadSchemaType.KEYWORD), ("type", PayloadSchemaType.KEYWORD),
                          ("created_year", PayloadSchemaType.INTEGER), ("pep", PayloadSchemaType.INTEGER)]:
        client.create_payload_index(COLLECTION, field_name=field, field_schema=schema)

    start = time.perf_counter()
    vectors = embed_documents([embed_text(c) for c in chunks])
    print(f"Embedded {len(chunks)} chunks with {EMBED_MODEL} (dim {dim}) in {time.perf_counter() - start:.0f}s")

    batch = 256
    for i in range(0, len(chunks), batch):
        points = [PointStruct(id=i + j, vector=vectors[i + j].tolist(), payload=c)
                  for j, c in enumerate(chunks[i:i + batch])]
        client.upsert(COLLECTION, points=points, wait=True)
    print(f"Indexed {client.count(COLLECTION).count} points into '{COLLECTION}'")


if __name__ == "__main__":
    main()
```

**How this code works**
- `normalize_embeddings=True` with `Distance.COSINE` → unit-length vectors, so cosine similarity is a dot product and scores sit in a predictable range (roughly 0.3-0.9 for this model). You will rely on that range for abstention in the next project.
- `QUERY_PREFIX` only in `embed_query` → bge models were trained with an instruction prefix on queries but not on passages. Getting this asymmetric detail wrong silently costs several points of hit rate. Other models (e5, nomic) have their own prefixes: read the model card.
- One model for indexing and querying → vectors from different models live in different spaces; mixing them returns nonsense with no error. Changing `EMBED_MODEL` means re-running `index.py`.
- `create_payload_index` → lets Qdrant filter by `status` or `created_year` efficiently while searching, instead of scanning.
- `payload=c` → the whole chunk (text and metadata) is stored with the vector, so a search returns everything needed to display a result.
- `delete_collection` then rebuild → the simplest correct re-index. Incremental updates (upsert changed chunks, delete removed ones by `doc_id`) are a stretch goal.
- Batches of 256 → keeps each request small; `wait=True` makes sure the data is searchable before the script exits.

**Run it**
```bash
python -m app.index
curl -s localhost:6333/collections/peps | python -m json.tool | grep -E "points_count|status"
```

**You should see**
```text
Batches: 100%|██████████████████████████| 140/140 [09:35<00:00,  4.11s/it]
Embedded 8897 chunks with BAAI/bge-small-en-v1.5 (dim 384) in 575s
Indexed 8897 points into 'peps'
        "status": "green",
        "points_count": 8897,
```

Embedding time depends on your CPU (that run was about 10 minutes on a laptop CPU); a GPU makes it seconds. In embedded mode Qdrant also warns that payload indexes have no effect there: harmless at this size.

**If it breaks**
- `Unexpected Response: 400 ... Vector dimension error` → the collection was created with a different model's size → the script deletes and recreates it; make sure you did not create it elsewhere by hand.
- Out of memory → lower `batch_size` in `embed_documents` to 16.
- `RuntimeError: Storage folder ... is already accessed by another instance` (embedded mode) → another Python process (often a running API) has the folder open → stop it first.

## Step 5 · Three retrievers with metadata filters

**Goal:** dense, BM25 and hybrid retrievers with one interface, `search(query, k, filters)`, returning ranked hits with scores.

Dense search finds meaning ("assign inside a while condition" → walrus operator). BM25 finds exact words (`removeprefix`, `EXTERNALLY-MANAGED`, `pyvenv.cfg`) that embeddings blur. Hybrid fuses both rankings with RRF, which uses ranks only, because a cosine of 0.8 and a BM25 score of 12 are not comparable numbers.

```python title="app/retrievers.py"
"""Three retrievers over the same chunks: dense (Qdrant), BM25 (rank-bm25) and hybrid (RRF)."""
import json
import re
from dataclasses import dataclass, field

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import FieldCondition, Filter, MatchValue, Range
from rank_bm25 import BM25Okapi

from app.chunking import embed_text
from app.config import CHUNKS_FILE, COLLECTION
from app.embeddings import embed_query

STOPWORDS = set("a an and are as at be by for from how i in is it of on or that the this to was what when "
                "which who why with does do can should my you your".split())


def tokenize(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9_]+", text.lower()) if t not in STOPWORDS]


@dataclass
class Filters:
    status: str | None = None
    type: str | None = None
    year_from: int | None = None
    year_to: int | None = None

    def matches(self, chunk: dict) -> bool:
        year = chunk.get("created_year") or 0
        return ((self.status is None or chunk["status"] == self.status)
                and (self.type is None or chunk["type"] == self.type)
                and (self.year_from is None or year >= self.year_from)
                and (self.year_to is None or year <= self.year_to))

    def to_qdrant(self) -> Filter | None:
        must = []
        if self.status:
            must.append(FieldCondition(key="status", match=MatchValue(value=self.status)))
        if self.type:
            must.append(FieldCondition(key="type", match=MatchValue(value=self.type)))
        if self.year_from is not None or self.year_to is not None:
            must.append(FieldCondition(key="created_year", range=Range(gte=self.year_from, lte=self.year_to)))
        return Filter(must=must) if must else None


@dataclass
class Hit:
    chunk: dict
    score: float
    ranks: dict[str, int] = field(default_factory=dict)  # rank in each underlying retriever


class DenseRetriever:
    name = "dense"

    def __init__(self, client: QdrantClient) -> None:
        self.client = client

    def search(self, query: str, k: int = 5, filters: Filters | None = None) -> list[Hit]:
        result = self.client.query_points(
            COLLECTION, query=embed_query(query), limit=k,
            query_filter=filters.to_qdrant() if filters else None, with_payload=True,
        )
        return [Hit(p.payload, p.score, {"dense": i}) for i, p in enumerate(result.points, start=1)]


class BM25Retriever:
    name = "bm25"

    def __init__(self, chunks: list[dict]) -> None:
        self.chunks = chunks
        tokenized = [tokenize(embed_text(c)) for c in chunks]
        self.token_sets = [set(t) for t in tokenized]
        self.bm25 = BM25Okapi(tokenized)

    def search(self, query: str, k: int = 5, filters: Filters | None = None) -> list[Hit]:
        terms = tokenize(query)
        scores = self.bm25.get_scores(terms)
        # A chunk qualifies only if it shares a query term and passes the filters.
        allowed = np.array([bool(self.token_sets[i].intersection(terms)) and (filters is None or filters.matches(c))
                            for i, c in enumerate(self.chunks)])
        scores = np.where(allowed, scores, -np.inf)
        top = [i for i in np.argsort(-scores)[:k] if np.isfinite(scores[i])]
        return [Hit(self.chunks[i], float(scores[i]), {"bm25": r}) for r, i in enumerate(top, start=1)]


def rrf(result_lists: list[list[Hit]], k: int = 60) -> list[Hit]:
    """Reciprocal Rank Fusion: score = sum of 1 / (k + rank) over the lists a chunk appears in."""
    fused: dict[str, Hit] = {}
    for hits in result_lists:
        for rank, hit in enumerate(hits, start=1):
            cid = hit.chunk["chunk_id"]
            if cid not in fused:
                fused[cid] = Hit(hit.chunk, 0.0, {})
            fused[cid].score += 1.0 / (k + rank)
            fused[cid].ranks.update(hit.ranks)
    return sorted(fused.values(), key=lambda h: -h.score)


class HybridRetriever:
    name = "hybrid"

    def __init__(self, dense: DenseRetriever, bm25: BM25Retriever, candidates: int = 30) -> None:
        self.dense, self.bm25, self.candidates = dense, bm25, candidates

    def search(self, query: str, k: int = 5, filters: Filters | None = None) -> list[Hit]:
        lists = [self.dense.search(query, self.candidates, filters),
                 self.bm25.search(query, self.candidates, filters)]
        return rrf(lists)[:k]


def load_chunks() -> list[dict]:
    return [json.loads(line) for line in CHUNKS_FILE.read_text(encoding="utf-8").splitlines()]


def build_retrievers(client: QdrantClient) -> dict[str, DenseRetriever | BM25Retriever | HybridRetriever]:
    dense = DenseRetriever(client)
    bm25 = BM25Retriever(load_chunks())
    return {"dense": dense, "bm25": bm25, "hybrid": HybridRetriever(dense, bm25)}
```

```python title="tests/test_retrieval.py"
from app.chunking import pack_paragraphs
from app.ingest import clean_rst, parse_header, split_sections
from app.retrievers import BM25Retriever, Filters, Hit, rrf, tokenize


def chunk(cid: str, text: str, status: str = "Final", year: int = 2020) -> dict:
    return {"chunk_id": cid, "pep": 1, "title": "T", "section": "S", "text": text,
            "status": status, "type": "Standards Track", "created_year": year}


def test_header_and_sections_parse():
    raw = "PEP: 8\nTitle: Style Guide\nAuthor: A,\n        B\nStatus: Active\n\nIntro\n=====\n\nHello ``code``.\n"
    header, body = parse_header(raw)
    assert header["PEP"] == "8" and header["Author"] == "A, B"
    assert split_sections(clean_rst(body)) == [("Intro", "Hello code.")]


def test_pack_paragraphs_respects_size():
    text = "\n\n".join(" ".join(["word"] * 40) for _ in range(10))  # 10 paragraphs of 40 words
    chunks = pack_paragraphs(text, max_words=100)
    assert all(len(c.split()) <= 100 for c in chunks) and len(chunks) >= 4


def test_tokenize_drops_stopwords_keeps_symbols_words():
    assert tokenize("What is the __init__ method?") == ["__init__", "method"]


def test_rrf_rewards_agreement():
    a = [Hit(chunk("c7", ""), 0.9), Hit(chunk("c2", ""), 0.8), Hit(chunk("c9", ""), 0.7)]
    b = [Hit(chunk("c2", ""), 12.0), Hit(chunk("c5", ""), 9.0), Hit(chunk("c7", ""), 8.0)]
    fused = [h.chunk["chunk_id"] for h in rrf([a, b])]
    assert fused[:2] == ["c2", "c7"]  # in both lists beats first place in one


def test_bm25_finds_exact_term_and_respects_filters():
    chunks = [chunk("a", "the walrus operator assigns inside expressions", year=2018),
              chunk("b", "decorators wrap functions", year=2003),
              chunk("c", "walrus facts for zoologists", status="Active", year=2023)]
    bm25 = BM25Retriever(chunks)
    assert bm25.search("walrus operator", k=1)[0].chunk["chunk_id"] == "a"
    only_active = bm25.search("walrus", k=5, filters=Filters(status="Active"))
    assert [h.chunk["chunk_id"] for h in only_active] == ["c"]
    assert Filters(year_from=2010).matches(chunks[0]) and not Filters(year_from=2010).matches(chunks[1])
```

**How this code works**
- `tokenize` → lowercase, split on anything that is not a letter, digit or underscore, drop a small stopword list. `__init__` and `removeprefix` survive as tokens; that is what lets BM25 win on identifiers.
- `Filters.to_qdrant()` → filters run **inside** Qdrant's search, so you get the top k among matching chunks. Filtering after a top-k search ("search 5, then drop non-Final") can return zero results.
- `Filters.matches()` → the same filter logic for BM25, which lives in memory. One `Filters` object, two implementations, one test.
- `query_points(...)` → the current qdrant-client search call (older tutorials use `search`, now deprecated; check the current docs).
- BM25's `allowed` mask → chunks that share no query term are excluded instead of returned with a meaningless score of zero or less (BM25's IDF can go negative for very common terms in small collections; the test with three chunks hits exactly that).
- `rrf(..., k=60)` → each list contributes `1/(60 + rank)`. A chunk ranked 2nd in both lists (2 × 1/62) beats one ranked 1st in only one (1/61). The constant 60 is the usual default and needs no tuning.
- `candidates=30` → hybrid fuses the top 30 of each list, not the top 5: a chunk ranked 8th by both methods should be able to rise to the top.
- `ranks` on each hit → the API will show "dense #3, bm25 #1", which makes every result explainable.
- `BM25Okapi` keeps the whole index in memory (fine for ~10k chunks, ~1 s to build at startup). At millions of chunks you would use a search engine with native BM25 or Qdrant's sparse vectors.

**Run it**
```bash
pytest -q
python -c "
from app.retrievers import build_retrievers, Filters
from app.store import get_client
r = build_retrievers(get_client())
for mode in ('dense', 'bm25', 'hybrid'):
    hits = r[mode].search('How do I strip a known prefix from a string?', k=3)
    print(mode, [(h.chunk['chunk_id'], round(h.score, 3)) for h in hits])
print('filtered', [h.chunk['pep'] for h in r['hybrid'].search('type hints', k=5, filters=Filters(year_from=2020))])
"
```

**You should see**
```text
.....                                                                    [100%]
5 passed in 14.2s
dense [('pep-0616#5', 0.811), ('pep-0616#1', 0.78), ('pep-0616#12', 0.778)]
bm25 [('pep-0616#11', 17.759), ('pep-0616#12', 15.676), ('pep-0292#0', 14.272)]
hybrid [('pep-0616#12', 0.032), ('pep-0616#11', 0.032), ('pep-0616#8', 0.031)]
filtered [649, 649, 705, 747, 655]
```

The test run takes seconds because importing the retrievers loads PyTorch. Your exact chunk ids will differ as the PEP repository changes. In embedded mode you may see an "Exception ignored ... QdrantClient.__del__" traceback when the script exits: it is the client closing during interpreter shutdown, and harmless.

**If it breaks**
- `AttributeError: 'QdrantClient' object has no attribute 'query_points'` → qdrant-client is older than 1.10 → `pip install -U qdrant-client`.
- Filtered dense search returns nothing → payload values do not match (for example `"final"` vs `"Final"`) → filters are exact matches; check a payload with `curl localhost:6333/collections/peps/points/0`.

## Step 6 · Measure: 30 questions, hit rate at k=5

**Goal:** a hit-rate@5 and MRR table for all three retrievers on 30 questions, split by keyword-style and paraphrase-style questions, plus the list of misses.

Each question names the PEP(s) that should answer it and a phrase that the right passage contains. A hit means one of the top 5 chunks is from that PEP **and** contains the phrase. That is stricter than "right document" and does not break when you change the chunking, as fixed chunk ids would.

```text title="eval/questions.jsonl"
{"q": "What is the maximum line length recommended for Python code?", "peps": [8], "contains": "79 characters", "kind": "keyword"}
{"q": "How long should lines in docstrings and comments be?", "peps": [8], "contains": "72", "kind": "keyword"}
{"q": "Should I break a long line before or after a binary operator?", "peps": [8], "contains": "binary operator", "kind": "keyword"}
{"q": "What is the walrus operator?", "peps": [572], "contains": "walrus", "kind": "keyword"}
{"q": "How can I assign a value to a variable in the middle of a while loop condition?", "peps": [572], "contains": ":=", "kind": "paraphrase"}
{"q": "Which proposal specifies the match and case statements for structural pattern matching?", "peps": [634, 635, 636], "contains": "match", "kind": "keyword"}
{"q": "How do I write a type hint meaning either an int or a str using the pipe symbol?", "peps": [604], "contains": "int | str", "kind": "paraphrase"}
{"q": "What does the Zen of Python say about errors?", "peps": [20], "contains": "Errors should never pass silently", "kind": "keyword"}
{"q": "What should the first line of a docstring look like?", "peps": [257], "contains": "summary", "kind": "paraphrase"}
{"q": "Where do I declare the packages needed to build my project?", "peps": [518], "contains": "build-system", "kind": "paraphrase"}
{"q": "Where do I put my project's name, version and dependencies in pyproject.toml?", "peps": [621], "contains": "[project]", "kind": "keyword"}
{"q": "Why does pip refuse to install packages into the system Python on some Linux distributions?", "peps": [668], "contains": "EXTERNALLY-MANAGED", "kind": "paraphrase"}
{"q": "What do version suffixes like .post1 or rc1 mean?", "peps": [440], "contains": "post-release", "kind": "keyword"}
{"q": "How can I make zip raise an error if the iterables have different lengths?", "peps": [618], "contains": "strict", "kind": "paraphrase"}
{"q": "Is there an operator to merge two dictionaries?", "peps": [584], "contains": "merge", "kind": "paraphrase"}
{"q": "Which string methods strip a known prefix or suffix?", "peps": [616], "contains": "removeprefix", "kind": "paraphrase"}
{"q": "How do I get IANA time zone support from the standard library?", "peps": [615], "contains": "zoneinfo", "kind": "keyword"}
{"q": "Why was a dedicated operator for matrix multiplication added?", "peps": [465], "contains": "matrix multiplication", "kind": "keyword"}
{"q": "How do I annotate a method that returns an instance of its own class?", "peps": [673], "contains": "Self", "kind": "paraphrase"}
{"q": "What is the syntax for declaring generic classes with type parameters in square brackets?", "peps": [695], "contains": "type parameter", "kind": "keyword"}
{"q": "How do I mark some keys of a TypedDict as optional?", "peps": [655], "contains": "NotRequired", "kind": "paraphrase"}
{"q": "Which proposal makes the global interpreter lock optional?", "peps": [703], "contains": "global interpreter lock", "kind": "keyword"}
{"q": "What interface lets Python web servers talk to web applications?", "peps": [3333], "contains": "WSGI", "kind": "paraphrase"}
{"q": "How do I declare the character encoding of a Python source file?", "peps": [263], "contains": "coding", "kind": "paraphrase"}
{"q": "What methods does an object need so it can be used in a with statement?", "peps": [343], "contains": "__exit__", "kind": "paraphrase"}
{"q": "How does a generator delegate part of its work to a subgenerator?", "peps": [380], "contains": "subgenerator", "kind": "keyword"}
{"q": "When were the async and await keywords introduced for coroutines?", "peps": [492], "contains": "await", "kind": "keyword"}
{"q": "Can I write list[int] instead of importing List from typing?", "peps": [585], "contains": "list[int]", "kind": "keyword"}
{"q": "How can a class decorator generate __init__ and __repr__ from annotated fields?", "peps": [557], "contains": "__init__", "kind": "paraphrase"}
{"q": "How do I create an isolated environment with its own site-packages directory?", "peps": [405], "contains": "pyvenv.cfg", "kind": "paraphrase"}
```

```python title="eval/evaluate.py"
"""Hit rate@k and MRR for each retriever on eval/questions.jsonl."""
import argparse
import json
import time
from pathlib import Path

from app.retrievers import build_retrievers
from app.store import get_client

QUESTIONS = Path("eval/questions.jsonl")


def is_relevant(chunk: dict, q: dict) -> bool:
    """Right document AND the chunk actually contains the answer phrase."""
    return chunk["pep"] in q["peps"] and q["contains"].lower() in chunk["text"].lower()


def evaluate(retriever, questions: list[dict], k: int) -> dict:
    hits, rr, latencies, misses = 0, 0.0, [], []
    by_kind: dict[str, list[int]] = {}
    for q in questions:
        start = time.perf_counter()
        results = retriever.search(q["q"], k=k)
        latencies.append((time.perf_counter() - start) * 1000)
        rank = next((i for i, h in enumerate(results, start=1) if is_relevant(h.chunk, q)), None)
        hit = rank is not None
        hits += hit
        rr += 1 / rank if rank else 0.0
        by_kind.setdefault(q["kind"], []).append(int(hit))
        if not hit:
            misses.append({"q": q["q"], "want": q["peps"],
                           "got": [f"PEP {h.chunk['pep']} · {h.chunk['section'][:40]}" for h in results[:3]]})
    n = len(questions)
    return {"hit_rate": hits / n, "mrr": rr / n, "by_kind": {kd: sum(v) / len(v) for kd, v in by_kind.items()},
            "p50_ms": sorted(latencies)[n // 2], "misses": misses}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("-k", type=int, default=5)
    parser.add_argument("--show-misses", action="store_true")
    args = parser.parse_args()

    questions = [json.loads(line) for line in QUESTIONS.read_text(encoding="utf-8").splitlines() if line.strip()]
    retrievers = build_retrievers(get_client())
    retrievers["dense"].search("warm-up", k=1)  # load the embedding model before timing

    results = {name: evaluate(r, questions, args.k) for name, r in retrievers.items()}
    print(f"\n{len(questions)} questions · k={args.k}\n")
    print(f"| retriever | hit@{args.k} | MRR | keyword q's | paraphrase q's | p50 ms |")
    print("|---|---|---|---|---|---|")
    for name, m in results.items():
        print(f"| {name} | {m['hit_rate']:.0%} | {m['mrr']:.2f} | {m['by_kind'].get('keyword', 0):.0%} "
              f"| {m['by_kind'].get('paraphrase', 0):.0%} | {m['p50_ms']:.0f} |")
    if args.show_misses:
        for name, m in results.items():
            print(f"\n## {name} misses ({len(m['misses'])})")
            for miss in m["misses"]:
                print(f"- {miss['q']}  (want PEP {miss['want']})\n    got: {miss['got']}")
    Path("eval/results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
```

**How this code works**
- Questions are written the way a user asks, not copied from the text. "Paraphrase" questions avoid the passage's key term on purpose ("strip a known prefix" for `removeprefix`); "keyword" questions contain it. The split shows where each retriever is strong.
- `is_relevant` → PEP **and** phrase. "Right PEP, wrong section" is a miss, because a RAG answer built from the wrong section of the right PEP is still wrong.
- `hit_rate` → did the right passage appear in the top k at all; `MRR` (mean reciprocal rank) → how high: 1.0 means always first, 0.5 means typically second. Report both: hit@5 matters for RAG (the model sees all 5), MRR matters for a search UI (people read the top result).
- Warm-up call → the first query loads the model; leaving it in would distort latency.
- `--show-misses` → the most useful output of the whole project. Read every miss.

**Run it**
```bash
python -m eval.evaluate --show-misses
```

**You should see** (your numbers will differ a little)
```text
30 questions · k=5

| retriever | hit@5 | MRR | keyword q's | paraphrase q's | p50 ms |
|---|---|---|---|---|---|
| dense | 90% | 0.72 | 93% | 87% | 29 |
| bm25 | 87% | 0.68 | 87% | 87% | 15 |
| hybrid | 90% | 0.79 | 100% | 80% | 48 |

## dense misses (3)
- Where do I declare the packages needed to build my project?  (want PEP [518])
    got: ['PEP 517 · prepare_metadata_for_build_wheel', 'PEP 517 · build_wheel', 'PEP 517 · get_requires_for_build_wheel']
- Why does pip refuse to install packages into the system Python on some Linux distributions?  (want PEP [668])
    got: ['PEP 453 · Enabling the evolution of the broader Py', 'PEP 466 · Rejected alternative: distribute the sec', ...]
- Can I write list[int] instead of importing List from typing?  (want PEP [585])
    got: ['PEP 810 · What about type annotations and TYPE_CHE', 'PEP 810 · Alternative syntax ...', 'PEP 604 · Simplified Syntax']

## bm25 misses (4)
- How do I annotate a method that returns an instance of its own class?  (want PEP [673])
    got: ['PEP 307 · The __getinitargs__ method', 'PEP 257 · Multi-line Docstrings', 'PEP 3119 · One Trick Ponies']
...
## hybrid misses (3)
- How do I annotate a method that returns an instance of its own class?  (want PEP [673])
    got: ['PEP 749 · Specification', 'PEP 673 · Abstract', 'PEP 526 · Class and instance variable annotations']
...
```

That is a real run. Read it carefully, because it is more interesting than "hybrid wins":

- **Hit@5 ties** (dense 90%, hybrid 90%), but hybrid's **MRR is clearly higher** (0.79 vs 0.72): the right passage is found by both, and hybrid puts it nearer the top. For a search UI that matters; for RAG with 5 chunks in context it matters less.
- **Keyword questions**: hybrid 100%. BM25's exact matches on `zoneinfo`, `[project]`, `list[int]` rescue dense misses.
- **Paraphrase questions**: hybrid 80%, below dense's 87%. On "returns an instance of its own class", BM25 contributes confident noise (`__getinitargs__`, "One Trick Ponies") that pushes the right chunk down to rank 2-3 and the exact passage out of the top 5.
- **Shared misses** (PEP 518 vs 517, PEP 668 vs 453) are corpus problems: several PEPs discuss the same topic, and the question's answer lives in the one with less distinctive wording. More retrieval tricks will not fix those; a reranker or a better question set might.

With 30 questions, one question is 3.3 points, so treat differences under ~7 points as noise. Your numbers will move slightly as the PEP repository changes.

**If it breaks**
- Hit rate is 0% everywhere → `is_relevant` never matches → print one result's `chunk["text"]` and the question's `contains`; check you indexed the chunk files from Step 3.
- Dense is far worse than BM25 on paraphrases → the query prefix is missing or the index was built with a different model → re-run `python -m app.index`.

## Step 7 · Serve it: a /search API and a small UI

**Goal:** `GET /search` returns ranked chunks with scores and per-retriever ranks, with mode and filters as query parameters, and `/` shows a search page.

```python title="app/api.py"
"""Search API: GET /search?q=...&mode=hybrid&k=5 plus a tiny HTML page at /."""
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.retrievers import Filters, build_retrievers
from app.store import get_client


class Result(BaseModel):
    rank: int
    score: float
    ranks: dict[str, int]
    chunk_id: str
    pep: int
    title: str
    section: str
    status: str
    created_year: int | None
    url: str
    text: str


class SearchResponse(BaseModel):
    query: str
    mode: str
    took_ms: float
    results: list[Result]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.retrievers = build_retrievers(get_client())
    app.state.retrievers["dense"].search("warm-up", k=1)  # load the model now, not on the first request
    yield


app = FastAPI(title="PEP hybrid search", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict:
    return {"status": "ok", "chunks": len(request.app.state.retrievers["bm25"].chunks)}


@app.get("/search", response_model=SearchResponse)
def search(
    request: Request,
    q: str = Query(min_length=2, max_length=300),
    mode: Literal["dense", "bm25", "hybrid"] = "hybrid",
    k: int = Query(5, ge=1, le=20),
    status: Literal["Final", "Active", "Accepted"] | None = None,
    type: str | None = Query(None, description="e.g. 'Standards Track', 'Informational', 'Process'"),
    year_from: int | None = Query(None, ge=1990, le=2100),
    year_to: int | None = Query(None, ge=1990, le=2100),
):
    if year_from and year_to and year_from > year_to:
        raise HTTPException(422, "year_from must be <= year_to")
    filters = Filters(status=status, type=type, year_from=year_from, year_to=year_to)
    start = time.perf_counter()
    hits = request.app.state.retrievers[mode].search(q, k=k, filters=filters)
    took = (time.perf_counter() - start) * 1000
    return SearchResponse(query=q, mode=mode, took_ms=round(took, 1), results=[
        Result(rank=i, score=round(h.score, 4), ranks=h.ranks, text=h.chunk["text"][:600],
               **{f: h.chunk[f] for f in ("chunk_id", "pep", "title", "section", "status", "created_year", "url")})
        for i, h in enumerate(hits, start=1)
    ])


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>PEP search</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px system-ui;max-width:860px;margin:2rem auto;padding:0 1rem}
.r{border-top:1px solid #ddd;padding:.6rem 0}.m{color:#666;font-size:13px}pre{white-space:pre-wrap;margin:.3rem 0}</style>
</head><body><h1>PEP search</h1>
<form id="f"><input name="q" size="50" placeholder="How do I merge two dicts?" required>
<select name="mode"><option>hybrid</option><option>dense</option><option>bm25</option></select>
<button>Search</button></form><div id="out"></div>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const params = new URLSearchParams(new FormData(e.target));
  const data = await (await fetch('/search?' + params)).json();
  const out = document.getElementById('out');
  out.innerHTML = '';
  (data.results || []).forEach(r => {
    const div = document.createElement('div'); div.className = 'r';
    const a = document.createElement('a'); a.href = r.url; a.textContent = `PEP ${r.pep}: ${r.title} > ${r.section}`;
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = `#${r.rank} · score ${r.score} · ranks ${JSON.stringify(r.ranks)} · ${r.status} · ${r.created_year}`;
    const p = document.createElement('pre'); p.textContent = r.text;
    div.append(a, m, p); out.append(div);
  });
  if (!data.results) out.textContent = JSON.stringify(data);
};
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def page() -> str:
    return PAGE
```

**How this code works**
- `lifespan` builds the retrievers once → loading the embedding model and building BM25 take seconds; doing it per request would make every search slow. The warm-up search moves the first-query delay to startup.
- `mode: Literal[...]`, `status: Literal[...]`, `k: Query(ge=1, le=20)` → FastAPI validates and documents the parameters; `mode=fuzzy` is a 422 with a clear message, not a `KeyError`.
- The route is a plain `def` → embedding a query and scoring BM25 are CPU-bound and blocking, so FastAPI runs them in its thread pool and the event loop stays free.
- `ranks` in each result → shows "dense 3, bm25 1": the explanation of a hybrid score.
- `text[:600]` → result snippets, not whole chunks, keep responses small.
- The page builds results with `textContent`, never `innerHTML` with data → chunk text cannot inject HTML or scripts into your page.

**Run it**
```bash
uvicorn app.api:app --port 8001
curl -s "localhost:8001/search?q=make%20zip%20strict&mode=hybrid&k=2" | python -m json.tool | head -20
curl -s "localhost:8001/search?q=type%20hints&status=Final&year_from=2021&k=3" | python -c "import sys, json; print([(r['pep'], r['created_year']) for r in json.load(sys.stdin)['results']])"
```

Then open `http://localhost:8001/` and try the same query in each mode.

**You should see**
```text
{
    "query": "make zip strict",
    "mode": "hybrid",
    "took_ms": 64.3,
    "results": [
        {
            "rank": 1,
            "score": 0.0328,
            "ranks": {"dense": 1, "bm25": 1},
            "chunk_id": "pep-0618#5",
            "pep": 618,
            "title": "Add Optional Length-Checking To zip",
            "section": "Backward Compatibility",
            ...
[(655, 2021), (673, 2021), (646, 2021)]
```

**If it breaks**
- Startup hangs for a minute → the model is downloading on first run; later starts are fast.
- `Storage folder ... already accessed` → in embedded mode, `eval.evaluate` or another process has the folder open → run one process at a time, or use the Docker server.
- `422` for `status=final` → status values are case-sensitive: `Final`, `Active`, `Accepted`.

## Step 8 · Deploy it

**Goal:** the search API runs at a public URL.

The simplest free host that has enough RAM for PyTorch is a **Hugging Face Space** with the Docker SDK (free CPU tier; check current limits). The image builds the index during the build using Qdrant's embedded mode, so there is no database to host and nothing large to upload: only `data/chunks.jsonl` (~10 MB).

```dockerfile title="Dockerfile"
FROM python:3.12-slim

RUN useradd -m -u 1000 user
ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/home/user/.cache \
    QDRANT_URL=/home/user/app/qdrant_local

# CPU-only PyTorch first: much smaller than the default CUDA build.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

USER user
WORKDIR /home/user/app
COPY --chown=user app ./app
COPY --chown=user data/chunks.jsonl ./data/chunks.jsonl
# Build the vector index inside the image (downloads the model once, embeds all chunks).
RUN python -m app.index

EXPOSE 7860
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "7860"]
```

```text title=".dockerignore"
.venv
.env
data/raw
data/docs.jsonl
qdrant_local
__pycache__
```

For the Space, the README needs a small header so Hugging Face knows how to run it. Put this at the very top of `README.md`:

```text title="README.md (top)"
---
title: PEP Hybrid Search
sdk: docker
app_port: 7860
---
```

**How this code works**
- `RUN python -m app.index` in the image → the index is built once at build time with embedded Qdrant (`QDRANT_URL` is a path), so the running container needs no Qdrant server.
- User `1000` and `--chown=user` → Spaces run containers as a non-root user; the embedded Qdrant folder and the model cache must be writable by it.
- Port `7860` → the port Spaces expect (`app_port`).
- `.dockerignore` excludes the 7 MB raw files and your local index; the image builds its own.
- Elsewhere (Fly.io, a VM, Render with 2 GB RAM) the same image works; set `PORT` handling or keep 7860.

**Run it**

Test the image locally first, then push to a new Space (create it on huggingface.co with SDK "Docker"):

```bash
docker build -t pep-search .
docker run --rm -p 7860:7860 pep-search
curl -s "localhost:7860/health"
git remote add space https://huggingface.co/spaces/<your-user>/pep-hybrid-search
git push space main
```

**You should see**
```text
{"status":"ok","chunks":8897}
```

and, after the Space finishes building (10-15 minutes, mostly embedding), the same search page at `https://<your-user>-pep-hybrid-search.hf.space/`.

**If it breaks**
- Build killed during `app.index` → out of memory on the builder → reduce `batch_size` in `embed_documents` to 16.
- Space shows "Application startup failed" with a permission error → a file was copied without `--chown=user` → fix the `COPY` line.
- `git push` rejects `data/chunks.jsonl` as too large → files over 10 MB need Git LFS: `git lfs track "data/chunks.jsonl"`.

## Ship it

The README should contain: what the corpus is and why you filtered it (only Final/Active/Accepted), your chunking strategy and its justification (section-aware, ~220 words, header prefix, short overlap), how to run each stage (`download_peps`, `ingest`, `chunking`, `index`, `api`), the API parameters with two example calls, and the **hit-rate table** from `eval/evaluate.py`.

Then write a short "What the misses taught me" section. Typical findings: dense retrieval finds the right PEP but the wrong section; BM25 misses paraphrases with no shared words; some "misses" are really ambiguous questions or passages split across two chunks. For each, say what you would change (smaller chunks for that kind of passage, a reranker, a better question).

Demo checklist: one query where BM25 wins (an identifier like `removeprefix`), one where dense wins (a paraphrase), one where hybrid wins, and one filtered query. Portfolio numbers: corpus size (docs, chunks, words), index time, hit@5 and MRR per retriever, p50 latency per mode.

## Going further

- Add a cross-encoder reranker over the hybrid top 30 and report the change in hit@5 and latency (the next project does this).
- Incremental re-indexing: hash each chunk, upsert only new or changed ones, delete chunks whose `doc_id` disappeared.
- Replace in-memory BM25 with Qdrant sparse vectors so both retrievers live in one store.
- Tune `CHUNK_WORDS` (120 vs 220 vs 400) and plot hit@5 for each.
- Try weighted score fusion (normalised scores, tuned weight) against RRF on your 30 questions.
