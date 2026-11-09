import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "4.1": {
    realLife: {
      title: "A CA's office in tax-filing season",
      story:
        "In July, clients flood a chartered accountant's office with Form 16 PDFs, phone photos of bank statements, Excel sheets and forwarded emails. The junior staff turn each one into a clean client record: the photographed statement has to be typed in (OCR), the bank letterhead is dropped but the transaction table keeps its columns. When a client sends the same Form 16 twice it is filed once, and when the employer issues a revised Form 16, only that client's figures are redone, not the whole office's work.",
      mapping: [
        { everyday: "Typing in a photographed bank statement", concept: "OCR for scanned pages with no text layer" },
        { everyday: "Dropping the letterhead but keeping the table columns", concept: "Removing boilerplate while preserving structure" },
        { everyday: "Filing a duplicate Form 16 once", concept: "Content-hash de-duplication" },
        { everyday: "Redoing only the client whose Form 16 was revised", concept: "Incremental re-indexing of changed documents" },
      ],
    },
    build: {
      title: "An incremental ingestion script",
      goal: "A script that turns a messy folder of PDF, HTML and DOCX files into clean JSONL records and, on re-run, processes only what changed.",
      minutes: 90,
      stack: ["Python", "pymupdf", "beautifulsoup4", "python-docx", "hashlib", "sqlite3"],
      steps: [
        "Collect 20-30 real files into ./inbox: PDFs (one scanned), saved web pages, Word documents, plus two exact duplicates and one file you will later edit.",
        "Write one extractor per type that returns {text, title, headings, source, modified}; for HTML strip nav, footer and script tags but keep h1-h3 and list items; flag PDF pages whose extracted text is under 50 characters as 'needs OCR'.",
        "Normalise text: fix hyphenated line breaks, collapse whitespace, keep headings as '# ' lines so later chunking can use them.",
        "Hash the normalised text (sha256) and keep a SQLite table of path -> hash; skip a file whose hash is unchanged and skip a new path whose hash already exists (duplicate).",
        "Write records to records.jsonl and print a run summary: new, changed, unchanged, duplicates, needs-OCR.",
      ],
      starter:
        "import hashlib, json, sqlite3, pathlib\n" +
        "\n" +
        "db = sqlite3.connect(\"ingest.db\")\n" +
        "db.execute(\"CREATE TABLE IF NOT EXISTS seen (path TEXT PRIMARY KEY, hash TEXT)\")\n" +
        "\n" +
        "def extract(path: pathlib.Path) -> dict:\n" +
        "    # TODO: dispatch on suffix to extract_pdf / extract_html / extract_docx\n" +
        "    ...\n" +
        "\n" +
        "def normalise(text: str) -> str:\n" +
        "    # TODO: join hyphenated line breaks, collapse whitespace, keep '# ' headings\n" +
        "    ...\n" +
        "\n" +
        "def run(inbox=\"inbox\"):\n" +
        "    stats = {\"new\": 0, \"changed\": 0, \"unchanged\": 0, \"duplicate\": 0}\n" +
        "    for path in pathlib.Path(inbox).iterdir():\n" +
        "        rec = extract(path)\n" +
        "        rec[\"text\"] = normalise(rec[\"text\"])\n" +
        "        h = hashlib.sha256(rec[\"text\"].encode()).hexdigest()\n" +
        "        # TODO: compare with the seen table, update stats, append to records.jsonl\n" +
        "    print(stats)\n",
      checks: [
        "Running the script twice in a row reports 0 new and 0 changed on the second run.",
        "Editing one sentence in one file makes the next run report exactly 1 changed.",
        "The two duplicate files produce one record, and the scanned PDF is listed as needs-OCR.",
        "Headings from an HTML page survive as '# ' lines while menu and footer text is gone.",
      ],
      stretch: "Run Tesseract (pytesseract) on the needs-OCR pages and compare the output with the original by eye.",
    },
  },

  "4.2": {
    realLife: {
      title: "A coaching teacher turning a textbook into revision cards",
      story:
        "A physics tutor turns a 400-page textbook into revision cards for students. Cutting every 300 words would split a derivation across two cards, so she cuts at subsection breaks and repeats the key formula at the top of the next card. Each card carries 'Ch 7, Rotational motion' in the corner. Students flip through the small cards to find the right topic, then open the textbook page it points to when they need the full explanation.",
      mapping: [
        { everyday: "Cutting at subsection breaks, not word counts", concept: "Structural (heading-based) chunking" },
        { everyday: "Repeating the formula on the next card", concept: "Chunk overlap" },
        { everyday: "'Ch 7, Rotational motion' in the corner", concept: "Metadata and a heading path attached to each chunk" },
        { everyday: "Find the card, then read the full textbook page", concept: "Small-to-big retrieval: match a small chunk, return its parent section" },
      ],
    },
    build: {
      title: "Three chunkers and small-to-big retrieval",
      goal: "Your own fixed, recursive and heading-aware chunkers plus a small-to-big retriever, compared on questions you wrote.",
      minutes: 90,
      stack: ["Python", "tiktoken", "sentence-transformers", "numpy"],
      steps: [
        "Pick one long Markdown document with headings (an API guide or a policy, 8k+ tokens) and write 12 questions, noting the exact sentence that answers each.",
        "Implement fixed(size, overlap) by tokens, recursive() that splits on paragraphs, then lines, then sentences until pieces fit, and by_heading() that keeps each section whole and prefixes its heading path ('Billing > Refunds').",
        "For each strategy, embed the chunks with all-MiniLM-L6-v2 and record, per question, whether the top-3 chunks contain the full answer sentence.",
        "Add small-to-big: index 120-token child chunks that each store a parent_id, retrieve children, then return the deduplicated parent sections.",
        "Print a table: strategy, number of chunks, average tokens per chunk, answers fully found in top 3.",
      ],
      starter:
        "import tiktoken\n" +
        "enc = tiktoken.get_encoding(\"cl100k_base\")\n" +
        "\n" +
        "def fixed(text, size=300, overlap=50):\n" +
        "    ids = enc.encode(text)\n" +
        "    # TODO: step through ids by size - overlap and decode each window\n" +
        "\n" +
        "def recursive(text, max_tokens=300, seps=(\"\\n\\n\", \"\\n\", \". \")):\n" +
        "    # TODO: if it fits, return [text]; else split on the first separator\n" +
        "    # and recurse on any piece still too long, merging small neighbours\n" +
        "    ...\n" +
        "\n" +
        "def by_heading(markdown):\n" +
        "    # TODO: split on lines starting with '#', track the heading path,\n" +
        "    # return [{\"text\": ..., \"path\": \"Billing > Refunds\"}]\n" +
        "    ...\n",
      checks: [
        "No fixed chunk exceeds the size you set, and consecutive fixed chunks share exactly the overlap tokens.",
        "Every heading-based chunk starts with its heading path.",
        "Your table shows at least one question that fixed chunking misses and heading-based or small-to-big finds.",
      ],
      stretch: "Add a semantic splitter that cuts where the embedding similarity between adjacent sentences drops, and add it to the table.",
      sim: "chunking",
    },
  },

  "4.3": {
    realLife: {
      title: "A library that shelves by subject",
      story:
        "In a public library, a book on monsoon farming and one on Indian rainfall patterns sit on neighbouring shelves even though their titles share no words, because the classification number captures the subject. A visitor asking 'why did the crops fail this year?' is walked to that shelf. If the library switched to a different classification scheme, the new numbers would mean nothing next to the old ones, so the whole collection has to be relabelled before reopening.",
      mapping: [
        { everyday: "The classification number on the spine", concept: "The embedding vector for a text" },
        { everyday: "Books on related subjects shelved together", concept: "Similar meanings land close together in vector space" },
        { everyday: "Walking the visitor's question to a shelf", concept: "Embedding the query into the same space as the documents" },
        { everyday: "Relabelling everything after switching schemes", concept: "One index, one model: re-embed the whole corpus to migrate" },
      ],
    },
    build: {
      title: "A bake-off between two embedding models",
      goal: "A script that scores two embedding models on your own query-document pairs and shows why their vectors can't be mixed.",
      minutes: 75,
      stack: ["Python", "sentence-transformers", "numpy"],
      steps: [
        "Write 40 (query, correct document) pairs from a domain you know, including 8 queries in Hindi, Hinglish or another language you use, and add 60 distractor documents.",
        "Embed everything with all-MiniLM-L6-v2 and with intfloat/multilingual-e5-small, using the 'query: ' and 'passage: ' prefixes the e5 model expects.",
        "For each model compute hit@1 and hit@5, embedding dimensions, and milliseconds per 100 documents on your laptop.",
        "Rerun e5 without the prefixes and record the change.",
        "Score queries embedded by one model against documents embedded by the other (truncate to equal dimensions if needed) and record the hit rate.",
      ],
      starter:
        "import time, numpy as np\n" +
        "from sentence_transformers import SentenceTransformer\n" +
        "\n" +
        "def evaluate(model_name, queries, docs, gold, q_prefix=\"\", d_prefix=\"\"):\n" +
        "    m = SentenceTransformer(model_name)\n" +
        "    t = time.perf_counter()\n" +
        "    D = m.encode([d_prefix + d for d in docs], normalize_embeddings=True)\n" +
        "    ms = (time.perf_counter() - t) * 1000 / len(docs) * 100\n" +
        "    Q = m.encode([q_prefix + q for q in queries], normalize_embeddings=True)\n" +
        "    scores = Q @ D.T\n" +
        "    # TODO: hit@1 and hit@5 using gold[i] = index of the right doc\n" +
        "    return {\"model\": model_name, \"dims\": D.shape[1], \"ms_per_100\": round(ms)}\n",
      checks: [
        "You have a table with hit@1, hit@5, dimensions and speed for both models.",
        "The multilingual model does visibly better on your non-English queries (or you can explain why not).",
        "The cross-model run scores near random, which shows why one index needs one model.",
      ],
      stretch: "Add a hosted embedding API to the bake-off and include cost per million tokens in the table.",
      sim: "similarity",
    },
  },

  "4.4": {
    realLife: {
      title: "A pharmacist reading a vague request",
      story:
        "A customer at a chemist says 'something for burning in the chest after dinner'. The pharmacist has never heard those exact words but knows which medicines treat acidity and picks the three closest. The next customer asks for 'Pan-D 40'; meaning alone would happily hand over Pan 40, a different drug that sounds almost the same. For brand codes and strengths, the pharmacist has to match the label exactly.",
      mapping: [
        { everyday: "'Burning in the chest after dinner'", concept: "A paraphrased query embedded as a vector" },
        { everyday: "Knowing which medicines treat which symptoms", concept: "Documents placed by meaning in the embedding space" },
        { everyday: "Picking the three closest medicines", concept: "Scoring every chunk and returning the top k" },
        { everyday: "Confusing Pan 40 with Pan-D 40", concept: "Semantic search failing on codes, numbers and names" },
      ],
    },
    build: {
      title: "A NumPy search engine with a failure report",
      goal: "A NumPy-only semantic search with three distance metrics, measured speed, and a written list of the queries it gets wrong.",
      minutes: 75,
      stack: ["Python", "numpy", "sentence-transformers"],
      steps: [
        "Embed 1,000 chunks from a docs site or product catalogue and save the matrix with np.save.",
        "Implement cosine, dot and negative Euclidean scoring as single matrix operations, then show that all three give the same top-10 once vectors are L2-normalised and different top-10 when they are not.",
        "Use np.argpartition to get the top k without sorting all scores, and time a query at 1k, 100k and 1M random vectors.",
        "Write 10 queries that contain an exact identifier (SKU, error code, version, person's name) and 10 paraphrased ones; record hit@5 for each group.",
        "For each miss, write one line explaining why meaning-based matching failed.",
      ],
      starter:
        "import numpy as np\n" +
        "\n" +
        "def cosine(q, M):\n" +
        "    # TODO: q / |q| dotted with each row of M / |row|\n" +
        "    ...\n" +
        "\n" +
        "def dot(q, M):\n" +
        "    return M @ q\n" +
        "\n" +
        "def neg_euclidean(q, M):\n" +
        "    # TODO: -||M - q|| per row, without a Python loop\n" +
        "    ...\n" +
        "\n" +
        "def top_k(scores, k=5):\n" +
        "    idx = np.argpartition(-scores, k)[:k]\n" +
        "    # TODO: sort just these k by score, highest first\n" +
        "    ...\n",
      checks: [
        "On normalised vectors, all three metrics return identical top-10 ids for 20 test queries.",
        "Query latency at 1M vectors is printed, and you can say at roughly what size brute force stops feeling instant.",
        "The identifier queries score noticeably lower hit@5 than the paraphrased ones, with a reason written for each miss.",
      ],
      sim: "similarity",
    },
  },

  "4.5": {
    realLife: {
      title: "A ride-hailing app finding your driver",
      story:
        "When you book an auto, the app doesn't measure the distance to every driver in the city. It looks in your zone and the zones next to it, and only at drivers matching your filters (auto, not cab; currently free). Usually it finds the nearest driver; once in a while a closer one sits just across a zone border and is missed. Drivers log in, move and log off every few seconds, so the map is updated constantly.",
      mapping: [
        { everyday: "Searching only nearby zones", concept: "Approximate nearest-neighbour search (IVF lists, HNSW neighbour hops)" },
        { everyday: "Auto, not cab; only free drivers", concept: "Metadata filters applied to the top-k query" },
        { everyday: "Missing a closer driver across the border", concept: "Recall below 100%: the price of ANN speed" },
        { everyday: "Drivers logging on and off", concept: "Upserts and deletes on a live index" },
      ],
    },
    build: {
      title: "A filtered, multi-tenant vector store",
      goal: "A local Qdrant collection holding chunks for several tenants, with filtered queries, document updates and deletes, checked against brute force.",
      minutes: 90,
      stack: ["Python", "qdrant-client", "sentence-transformers", "numpy"],
      steps: [
        "Embed about 5,000 chunks and give each a payload: tenant (3 fake companies), doc_id, doc_type (policy, faq, release_note) and a published date.",
        "Create a local Qdrant collection (QdrantClient(path=...) or the Docker image) with cosine distance and upsert all points in batches of 256.",
        "Write search(query, tenant, doc_type=None, after=None, k=5) using a Filter with must conditions, including a date range.",
        "Compute the exact filtered answer with NumPy for 50 queries and report recall@5 of Qdrant against it.",
        "Implement replace_document(doc_id, new_chunks) that deletes all points with that doc_id by filter, then upserts the new ones.",
      ],
      starter:
        "from qdrant_client import QdrantClient\n" +
        "from qdrant_client.models import (Distance, VectorParams, PointStruct,\n" +
        "    Filter, FieldCondition, MatchValue, DatetimeRange, FilterSelector)\n" +
        "\n" +
        "client = QdrantClient(path=\"./qdrant_data\")\n" +
        "if not client.collection_exists(\"chunks\"):\n" +
        "    client.create_collection(\"chunks\", vectors_config=VectorParams(size=384, distance=Distance.COSINE))\n" +
        "\n" +
        "def search(qvec, tenant, doc_type=None, k=5):\n" +
        "    must = [FieldCondition(key=\"tenant\", match=MatchValue(value=tenant))]\n" +
        "    # TODO: add doc_type and date conditions when given\n" +
        "    res = client.query_points(\"chunks\", query=qvec, query_filter=Filter(must=must), limit=k)\n" +
        "    return [(p.id, p.score, p.payload[\"doc_id\"]) for p in res.points]\n" +
        "\n" +
        "def replace_document(doc_id, points):\n" +
        "    # TODO: delete by FilterSelector on doc_id, then upsert points\n" +
        "    ...\n",
      checks: [
        "A query for tenant A never returns a chunk from tenant B (assert it over 50 queries).",
        "Recall@5 against the NumPy exact answer is reported, and is close to 1.0 at this size.",
        "After replace_document, searching for a phrase that existed only in the old version no longer returns that doc.",
      ],
      stretch: "Switch to pgvector in Docker with an HNSW index and compare query latency and recall with the same 50 queries. Check the current docs for index parameters.",
    },
  },

  "4.6": {
    realLife: {
      title: "Two archivists in a newsroom",
      story:
        "A reporter asks the newspaper's archive for past coverage. One archivist remembers stories by what they were about ('the piece on the flooded metro station'); the other searches the card index by exact words and case numbers ('FIR 1123/2024'). Each hands back a ranked list. The head archivist merges them, favouring stories that both colleagues put near the top, without trying to compare their very different ways of scoring.",
      mapping: [
        { everyday: "The archivist who remembers topics", concept: "Dense (embedding) retrieval" },
        { everyday: "The card index of exact words and numbers", concept: "Sparse keyword retrieval with BM25" },
        { everyday: "Merging by position, not by each archivist's confidence", concept: "Reciprocal Rank Fusion uses ranks, not raw scores" },
        { everyday: "Stories both put near the top win", concept: "Agreement between retrievers lifts a document in the fused list" },
      ],
    },
    build: {
      title: "Hybrid search with your own RRF and a query router",
      goal: "BM25 and dense retrieval fused with a hand-written RRF, tuned tokenisation for identifiers, and a simple router, all scored on a labelled set.",
      minutes: 90,
      stack: ["Python", "rank_bm25", "sentence-transformers", "numpy"],
      steps: [
        "Reuse a corpus of a few hundred chunks and a labelled set of at least 30 questions, half containing identifiers like ERR-504 or v2.3.1.",
        "Build BM25Okapi with a tokenizer that lowercases and keeps identifiers whole, then a second tokenizer that also splits on '-' and '.'; compare hit@5 on the identifier questions.",
        "Write rrf(list_of_rankings, k=60) yourself and test it on two tiny hand-made lists before using it.",
        "Try weighted RRF (dense weight 1.0, BM25 weight 0.5 to 2.0) and k values 10, 60 and 100; record hit@5 per question group.",
        "Add a router: if the query matches an identifier regex, use BM25-weighted fusion, else equal weights; report whether it beats plain RRF.",
      ],
      starter:
        "from collections import defaultdict\n" +
        "from rank_bm25 import BM25Okapi\n" +
        "\n" +
        "def rrf(rankings, k=60, weights=None):\n" +
        "    # rankings: list of lists of doc ids, best first\n" +
        "    weights = weights or [1.0] * len(rankings)\n" +
        "    scores = defaultdict(float)\n" +
        "    # TODO: add weight / (k + rank) for each doc in each list (rank starts at 1)\n" +
        "    return sorted(scores, key=scores.get, reverse=True)\n" +
        "\n" +
        "assert rrf([[\"a\", \"b\", \"c\"], [\"c\", \"a\", \"d\"]])[0] == \"a\"\n" +
        "\n" +
        "def tokenize(text):\n" +
        "    # TODO: lowercase, keep tokens like err-504 intact\n" +
        "    ...\n",
      checks: [
        "Your rrf passes the small assertion and handles a doc that appears in only one list.",
        "You have a table of hit@5 for dense, BM25, RRF and routed RRF, split by natural-language and identifier questions.",
        "Hybrid beats dense on identifier questions and does not lose more than a question or two on natural-language ones.",
      ],
      sim: "rrf",
    },
  },

  "4.7": {
    realLife: {
      title: "A railway enquiry counter",
      story:
        "At a busy station enquiry counter, one passenger asks for 'the evening train to Pune that has a pantry car', the next just says '12127'. The clerk checks both the timetable index for exact train numbers and their own sense of which trains fit a description, and gives a short list of options with platforms. The station manager keeps a tally of how often the right train was in the first five answers.",
      mapping: [
        { everyday: "Corpus of timetables, routes and notices", concept: "The ingested, chunked document collection with metadata" },
        { everyday: "Train number vs description", concept: "BM25 for exact ids, dense search for meaning, fused with RRF" },
        { everyday: "'Only trains leaving after 6 pm'", concept: "Metadata filters on the search endpoint" },
        { everyday: "The manager's tally", concept: "Hit rate at k=5 on a labelled question set" },
      ],
    },
    build: {
      title: "Milestone 1: corpus, index and a measured dense baseline",
      goal: "A real corpus chunked, embedded and loaded into a vector store, with a 30-question test set and a hit@5 number for dense search.",
      minutes: 120,
      stack: ["Python", "sentence-transformers", "qdrant-client or pgvector", "rank_bm25"],
      steps: [
        "Choose a corpus of a few hundred real documents (a docs site, your city's public notices, papers) and ingest it with the 4.1 script, keeping title, section and date.",
        "Chunk with a strategy you can justify in two sentences, embed, and load into Qdrant or pgvector with the metadata as payload.",
        "Write 30 test questions in a JSONL file, each with the id of the chunk that should come back; make at least 10 contain exact identifiers or names.",
        "Write eval.py that runs any retriever function over the set and prints hit@5 and MRR; run it on dense search.",
        "Add a BM25 retriever behind the same function signature so the next milestone is only fusion and serving.",
      ],
      checks: [
        "eval.py prints hit@5 and MRR for dense and for BM25 from the same test file.",
        "Every chunk in the store has title, section and date in its payload.",
        "You have written down three misses and a guess at why each one failed.",
      ],
      stretch: "Expose a first /search endpoint with FastAPI that returns ranked chunks with scores.",
    },
  },

  "4.8": {
    realLife: {
      title: "A bank call-centre agent with a rate binder",
      story:
        "A customer calls the bank asking today's FD rate for senior citizens. The agent opens the current rate sheet, finds the line and reads it out, mentioning the sheet's date. If the customer asks the agent to explain an FD in simple Hindi, there is nothing to look up. When a customer is quoted a wrong rate, the supervisor asks one question first: did the agent open the wrong sheet, or read the right sheet wrongly?",
      mapping: [
        { everyday: "Opening today's rate sheet", concept: "Retrieval over private, fast-changing data" },
        { everyday: "Reading out the line and its date", concept: "Generation grounded in retrieved context, with a citation" },
        { everyday: "Explaining an FD in simple Hindi", concept: "A transformation task that needs no RAG" },
        { everyday: "Wrong sheet or misread sheet?", concept: "Retrieval failure vs generation failure" },
      ],
    },
    build: {
      title: "A traced RAG pipeline with a failure classifier",
      goal: "A minimal four-step RAG pipeline that logs every stage, plus a tool that labels each bad answer as a retrieval or generation failure.",
      minutes: 60,
      stack: ["Python", "an LLM API (OpenAI or Anthropic)", "sentence-transformers", "numpy"],
      steps: [
        "Take 40 short documents with facts that change (prices, schedules, rules) and index them with your NumPy search from 4.4.",
        "Write answer(question) as four functions (rewrite_query, retrieve, build_prompt, generate) and save a trace dict with the output of each step.",
        "Write 15 questions with the id of the document holding the answer and the expected answer.",
        "Write diagnose(trace, gold_id, expected): if gold_id is not in the retrieved ids, label it retrieval_failure; if it is but the answer is wrong, label it generation_failure.",
        "Also answer the same 15 questions with the whole corpus pasted into the prompt, and compare accuracy and tokens with the RAG version.",
      ],
      checks: [
        "Each answer has a saved trace showing query, retrieved ids, the full prompt and the output.",
        "Every wrong answer carries exactly one of the two failure labels.",
        "You can state, with numbers, whether this small corpus actually needed RAG or fit in the prompt.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.9": {
    realLife: {
      title: "A junior lawyer preparing a brief",
      story:
        "A senior advocate asks a junior to prepare notes on a property dispute from the case file. The junior pulls the relevant pages, is told to argue only from what the file says, and to write 'not in the file' rather than guess. Too few pages and a key sale deed is missed; too many and the senior skims past the one that matters. The junior also learns to put the strongest document on top.",
      mapping: [
        { everyday: "Pulling relevant pages from the file", concept: "Retrieving the top-k chunks" },
        { everyday: "'Argue only from the file'", concept: "A grounding instruction in the prompt" },
        { everyday: "'Not in the file'", concept: "Handling weak or empty retrieval instead of guessing" },
        { everyday: "How many pages, strongest on top", concept: "Tuning k, chunk order and context size" },
      ],
    },
    build: {
      title: "Baseline RAG with a retrieval threshold and a k sweep",
      goal: "A framework-free RAG app with a grounding prompt, a similarity threshold for weak retrieval, and a measured choice of k and ordering.",
      minutes: 90,
      stack: ["Python", "an LLM API", "your hybrid or dense retriever from this level"],
      steps: [
        "Wire retrieve -> prompt -> generate on your own search engine, numbering each chunk [1], [2], ... in the prompt.",
        "Write a system prompt that says to answer only from the numbered sources, cite them, and reply exactly NOT_FOUND when they don't contain the answer.",
        "Pick a similarity threshold from your scores: if the best chunk falls below it, skip the model call and return NOT_FOUND.",
        "Sweep k in {1, 3, 5, 10} and two orders (best first, best last) over 25 questions (20 answerable, 5 not), recording correctness and prompt tokens.",
        "Pick a default k and order and justify it from the table.",
      ],
      starter:
        "SYSTEM = (\"Answer only from the numbered sources. Cite like [2]. \"\n" +
        "          \"If they do not contain the answer, reply exactly NOT_FOUND.\")\n" +
        "\n" +
        "def answer(question, k=5, threshold=0.35, best_last=False):\n" +
        "    hits = retrieve(question, k)            # [(chunk_text, score), ...]\n" +
        "    if not hits or hits[0][1] < threshold:\n" +
        "        return \"NOT_FOUND\", 0\n" +
        "    if best_last:\n" +
        "        hits = hits[::-1]\n" +
        "    context = \"\\n\\n\".join(f\"[{i+1}] {t}\" for i, (t, _) in enumerate(hits))\n" +
        "    # TODO: call the model with SYSTEM and context + question\n" +
        "    # TODO: return (answer_text, prompt_tokens)\n",
      checks: [
        "All 5 unanswerable questions return NOT_FOUND, with the threshold catching at least some of them before the model call.",
        "Every answer to an answerable question contains at least one [n] citation.",
        "Your table shows accuracy and prompt tokens for each k and order, and your chosen default is the cheapest one within a question of the best.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.10": {
    realLife: {
      title: "A hiring pipeline with two rounds of screening",
      story:
        "A company gets 600 applications for one backend role. A recruiter spends ten seconds per CV matching keywords and shortlists 40. The hiring manager then reads each of those 40 in full against the job description and picks the best 5 to interview. Reading all 600 that carefully would take weeks, and for a role with only 6 applicants, the second round adds little.",
      mapping: [
        { everyday: "Recruiter's quick keyword shortlist", concept: "Cheap first-stage retrieval over the whole corpus" },
        { everyday: "Manager reading CV and job together", concept: "A cross-encoder scoring query and chunk jointly" },
        { everyday: "Interviewing 5, not 40", concept: "Keep only the top few after reranking" },
        { everyday: "Skipping round two with 6 applicants", concept: "Reranking adds little when first-stage retrieval is already good" },
      ],
    },
    build: {
      title: "A reranking stage with a cutoff and a cost comparison",
      goal: "A reusable rerank step with a relevance cutoff, compared against simply raising k on accuracy, tokens and latency.",
      minutes: 75,
      stack: ["Python", "sentence-transformers (CrossEncoder)", "an LLM API"],
      steps: [
        "Wrap cross-encoder/ms-marco-MiniLM-L-6-v2 in rerank(query, candidates, keep=5, min_score=None) and return chunks with their new scores.",
        "Choose min_score by looking at scores for relevant and irrelevant pairs from your test set, so clear junk is dropped even if fewer than 5 remain.",
        "Run three setups through your full RAG answer step on 25 questions: k=5 no rerank, k=15 no rerank, retrieve 50 then rerank to 5.",
        "Record answer accuracy, prompt tokens and end-to-end latency for each setup.",
        "List the questions where reranking changed nothing and look for what they share.",
      ],
      starter:
        "from sentence_transformers import CrossEncoder\n" +
        "ce = CrossEncoder(\"cross-encoder/ms-marco-MiniLM-L-6-v2\")\n" +
        "\n" +
        "def rerank(query, candidates, keep=5, min_score=None):\n" +
        "    scores = ce.predict([(query, c[\"text\"]) for c in candidates])\n" +
        "    ranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)\n" +
        "    # TODO: drop items below min_score, keep the top `keep`\n" +
        "    ...\n",
      checks: [
        "Retrieve-50-rerank-5 matches or beats k=15 on accuracy while sending about a third of the tokens.",
        "Your table shows the rerank latency cost in milliseconds per query.",
        "At least one off-topic query ends up with fewer than 5 chunks because of the cutoff.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.11": {
    realLife: {
      title: "A hardware shop counter",
      story:
        "A customer at a hardware shop says 'the thing for the tap that's dripping, like last time but bigger'. The shopkeeper turns that into a real query: half-inch washer. When unsure, he checks under a few names (washer, gasket, seal) and puts together what comes up most often. Sometimes he pictures the part the customer needs and goes looking for something that looks like it.",
      mapping: [
        { everyday: "'Like last time but bigger'", concept: "A conversational question that retrieves badly as written" },
        { everyday: "Turning it into 'half-inch washer'", concept: "Rewriting into a standalone search query" },
        { everyday: "Checking washer, gasket and seal", concept: "Multi-query retrieval fused with RRF (RAG-Fusion)" },
        { everyday: "Picturing the part, then searching for it", concept: "HyDE: embed a hypothetical answer instead of the question" },
      ],
    },
    build: {
      title: "Decomposition, HyDE and a skip gate",
      goal: "A query-rewriting layer that splits multi-part questions, tries HyDE, and only spends extra LLM calls when baseline retrieval looks weak.",
      minutes: 90,
      stack: ["Python", "an LLM API", "your retriever", "your rrf()"],
      steps: [
        "Write 15 hard questions for your corpus: 5 vague, 5 multi-part ('compare the refund rules for X and Y'), 5 using different words from the docs.",
        "Implement decompose(q) that returns 1-3 sub-questions as JSON, retrieves for each, and fuses with rrf().",
        "Implement hyde(q) that drafts a short hypothetical answer and retrieves with its embedding.",
        "Add a gate: run baseline retrieval first and only rewrite if the top score is below a threshold you choose.",
        "Record hit@5, extra LLM calls and added latency for baseline, decompose, HyDE and gated per question group.",
      ],
      starter:
        "import json\n" +
        "\n" +
        "def decompose(q):\n" +
        "    prompt = (\"Split this question into 1-3 standalone search queries. \"\n" +
        "              \"Return a JSON list of strings only.\\n\\nQuestion: \" + q)\n" +
        "    subs = json.loads(llm(prompt))\n" +
        "    # TODO: retrieve top 20 for each sub-query, fuse with rrf, return top 5\n" +
        "\n" +
        "def gated(q, threshold=0.45):\n" +
        "    hits = retrieve(q, 5)\n" +
        "    # TODO: return hits if hits[0].score >= threshold, else decompose(q)\n",
      checks: [
        "Decomposition improves hit@5 on the multi-part group.",
        "The gate skips rewriting for most easy questions, so its average added latency is well below always-rewrite.",
        "You can name one question group where HyDE helped and one where it hurt.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.12": {
    realLife: {
      title: "An insurance claims assessor",
      story:
        "An assessor approving a hospital claim must tie each decision to a clause: 'room rent capped at 1% of sum insured, clause 4.2'. An internal auditor later opens clause 4.2 to check it really says that, because a clause number on its own proves nothing. When the discharge summary is missing, the assessor marks the claim 'pending, documents insufficient' rather than guessing.",
      mapping: [
        { everyday: "Each decision tied to a clause", concept: "Each claim in the answer cites a supporting chunk" },
        { everyday: "Auditor opening the clause", concept: "Verifying the cited text actually supports the claim" },
        { everyday: "A clause number proves nothing alone", concept: "A citation is not proof" },
        { everyday: "'Pending, documents insufficient'", concept: "Abstaining when evidence is thin" },
      ],
    },
    build: {
      title: "An automatic citation checker",
      goal: "RAG answers returned as structured claims with quotes, checked automatically for quote match and support, with abstention when support is thin.",
      minutes: 90,
      stack: ["Python", "an LLM API with JSON or structured output", "pydantic"],
      steps: [
        "Change your RAG prompt to return JSON: {claims: [{text, source_id, quote}], abstain: bool}, where quote must be copied word for word from the source.",
        "Check 1 (exists): source_id is one of the retrieved chunks. Check 2 (quoted): the quote appears in that chunk after whitespace normalisation.",
        "Check 3 (supports): ask a separate model call 'Does this quote support this claim? Answer SUPPORTED or NOT_SUPPORTED.'",
        "Drop unsupported claims; if fewer than one supported claim remains, return the abstain message.",
        "Run on 20 questions, including 5 where you deleted the key chunk from the index, and count each failure type.",
      ],
      starter:
        "from pydantic import BaseModel\n" +
        "\n" +
        "class Claim(BaseModel):\n" +
        "    text: str\n" +
        "    source_id: str\n" +
        "    quote: str\n" +
        "\n" +
        "class Answer(BaseModel):\n" +
        "    claims: list[Claim]\n" +
        "    abstain: bool\n" +
        "\n" +
        "def verify(ans: Answer, chunks: dict[str, str]) -> list[Claim]:\n" +
        "    ok = []\n" +
        "    for c in ans.claims:\n" +
        "        # TODO: check source exists, quote is in chunk, LLM says SUPPORTED\n" +
        "        ...\n" +
        "    return ok\n",
      checks: [
        "Each of the three checks catches at least one bad claim across your 20 questions (plant one if needed).",
        "All 5 questions with the key chunk deleted end in abstention, not a guessed answer.",
        "The final answers shown to the user contain only claims that passed all three checks.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.13": {
    realLife: {
      title: "A hospital triage desk",
      story:
        "At an emergency triage desk, the nurse decides how much work each patient needs: a sprained finger gets advice, chest pain gets an ECG, an unclear case gets tests, and if the results are inconclusive the doctor orders more before deciding. Some questions need a chain of lookups: which ward has the patient whose scan was flagged this morning? For linked questions across many patients (which wards share the same infection?), staff look at a map of who was where.",
      mapping: [
        { everyday: "Deciding how much work a patient needs", concept: "Adaptive RAG: route by question type, sometimes skip retrieval" },
        { everyday: "Inconclusive results, so more tests", concept: "Corrective RAG: grade the evidence, retry when weak" },
        { everyday: "Scan flagged, then patient, then ward", concept: "Multi-hop retrieval" },
        { everyday: "A map of who was where", concept: "Graph RAG over entities and relationships" },
      ],
    },
    build: {
      title: "A corrective RAG loop with a router",
      goal: "A pipeline that routes each question, grades retrieved chunks, rewrites and retries when evidence is weak, and gives up honestly after two tries.",
      minutes: 120,
      stack: ["Python", "an LLM API", "your retriever", "optional: langgraph"],
      steps: [
        "Take the largest failure group from your 4.13 Try-it classification and the questions in it, plus 10 baseline questions that already work.",
        "Write route(q) returning one of: no_retrieval, single, multi_hop.",
        "Write grade(q, chunk) returning relevant or irrelevant with a cheap model; keep only relevant chunks.",
        "If fewer than 2 chunks are relevant, rewrite the query and retrieve again, at most 2 times, then abstain; for multi_hop, answer the first sub-question and use its answer to form the second query.",
        "Compare against baseline: accuracy on the failing group, accuracy on the working group, and average LLM calls per question.",
      ],
      starter:
        "def corrective_answer(q, max_tries=2):\n" +
        "    route = route_question(q)\n" +
        "    if route == \"no_retrieval\":\n" +
        "        return llm(q), {\"calls\": 2}\n" +
        "    query, calls = q, 1\n" +
        "    for attempt in range(max_tries + 1):\n" +
        "        chunks = retrieve(query, 8)\n" +
        "        good = [c for c in chunks if grade(q, c) == \"relevant\"]\n" +
        "        calls += len(chunks)\n" +
        "        if len(good) >= 2:\n" +
        "            # TODO: generate from good chunks and return\n" +
        "            ...\n" +
        "        # TODO: rewrite query using what was missing; calls += 1\n" +
        "    return \"Not enough information.\", {\"calls\": calls}\n",
      checks: [
        "Accuracy on the failing group rises, and the working group loses no more than one question.",
        "No question ever triggers more than 2 rewrites.",
        "You report average LLM calls per question for baseline and corrective and can say whether the gain is worth it.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.14": {
    realLife: {
      title: "Ready-made masala versus grinding your own",
      story:
        "You have been grinding your own garam masala for months and know every proportion. A packet from the shop makes dinner faster and tastes fine most days, but when a dish comes out wrong you have to read the ingredients label to work out why. Many cooks keep the packet and add their own roasted cumin on top.",
      mapping: [
        { everyday: "Your own ground masala", concept: "The hand-built RAG pipeline" },
        { everyday: "The shop packet", concept: "A framework's loaders, indexes and query engines" },
        { everyday: "Reading the label when the dish tastes off", concept: "Inspecting the exact prompt and retrieved nodes the framework uses" },
        { everyday: "Adding your own cumin on top", concept: "Plugging a custom retriever or reranker into the framework" },
      ],
    },
    build: {
      title: "Your hybrid retriever inside a framework",
      goal: "A LlamaIndex (or LangChain) RAG pipeline that uses your own hybrid retriever and a reranker, with every step's inputs and outputs visible.",
      minutes: 75,
      stack: ["Python", "llama-index (or langchain)", "your hybrid retriever from 4.6"],
      steps: [
        "Wrap your hybrid search as a custom retriever class (BaseRetriever in LlamaIndex) that returns nodes with scores.",
        "Build a query engine from it with a reranking postprocessor and your grounding prompt as a custom template.",
        "Turn on the framework's debug or instrumentation output and log the retrieved nodes and the final prompt for each question.",
        "Run your existing eval questions through the hand-built and framework versions and compare accuracy, latency and lines of code.",
        "Break something on purpose (an empty index, a wrong embedding model) and note how long it takes to find the cause in each version.",
      ],
      checks: [
        "The framework version calls your retriever (prove it with a print or log inside your class).",
        "Accuracy on your eval set is within a question or two of the hand-built version.",
        "You have a short written comparison: lines of code, time to debug the planted fault, and what the framework hid.",
      ],
      studio: "rag-pipeline",
    },
  },

  "4.15": {
    realLife: {
      title: "A university admissions help desk in admission season",
      story:
        "During admissions, a help desk answers thousands of questions about eligibility, fees and deadlines from a stack of circulars. Good staff quote the circular and its date, say 'please check with the department' when the circulars don't cover a case, and the desk head tracks how many answers turn out right and how long each query takes. When a new process is tried, such as a FAQ sheet for the top 20 questions, she compares the numbers before and after.",
      mapping: [
        { everyday: "Answering from circulars, quoting date and number", concept: "RAG with citations on every answer" },
        { everyday: "'Please check with the department'", concept: "Abstaining on weak evidence" },
        { everyday: "Trying a FAQ sheet and comparing numbers", concept: "One improvement measured against the baseline" },
        { everyday: "Time per query", concept: "Latency, tokens and cost logged per request and stage" },
      ],
    },
    build: {
      title: "Milestone 1: a baseline with citations, abstention and an eval set",
      goal: "A baseline RAG app over your corpus that cites and abstains, plus an eval script and per-request cost log that every later improvement will be measured against.",
      minutes: 120,
      stack: ["Python", "an LLM API", "your hybrid search engine from 4.7", "FastAPI (optional)"],
      steps: [
        "Write 40 eval questions: 30 answerable with the gold chunk id and a reference answer, 10 not answerable from the corpus.",
        "Build answer() on your hybrid search with numbered-source citations and the NOT_FOUND rule from 4.9.",
        "Log per request: retrieval ms, generation ms, input and output tokens, and cost using your provider's current prices.",
        "Write eval.py that reports retrieval hit@5, answer correctness (by an LLM judge or by hand), citation rate and abstention accuracy.",
        "Commit the baseline numbers to a RESULTS.md table and pick, from the failures, which one improvement you will add next.",
      ],
      checks: [
        "eval.py runs end to end with one command and prints all four metrics.",
        "At least 8 of the 10 unanswerable questions abstain.",
        "Every logged request has latency, tokens and cost, and you know your average cost per answer.",
      ],
      studio: "rag-pipeline",
    },
  },
};
