# Project guide format

Every project has a full build guide at `content/projects/<project-id>.md`. The app renders it as a guided, step-by-step
build: one step on screen at a time, a checkbox per step, copy buttons on every code block, and a progress bar.
Someone who has never built the thing should be able to follow it start to finish and end with working, deployable code.

## File shape

```markdown
---
project: hybrid-search-engine        # must match the project id in src/curriculum/levels/lNN.ts
title: Hybrid search engine
hours: 6                            # honest total for a first-timer
stack: Python 3.11, FastAPI, Qdrant (Docker), rank-bm25, sentence-transformers
cost: Free (runs locally)           # or e.g. "About $2 of API calls" / "About $3 of GPU time"
---

<one short paragraph: what you will have at the end, and who would use it>

## Before you start
- what to install (exact commands), accounts or keys needed, which earlier project this builds on
- the final folder structure as a tree in a code block

## How it fits together
A small text diagram in a ```text block (boxes and arrows), then 3-5 sentences walking a request through it.

## Step 1 · Set up the project
**Goal:** one sentence: what exists when this step is done.

Short explanation of what we are about to do and why (2-5 sentences, plain words).

```bash title="terminal"
mkdir hybrid-search && cd hybrid-search
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install fastapi uvicorn qdrant-client rank-bm25 sentence-transformers
```

```python title="app/config.py"
...complete, runnable file or the exact lines to add...
```

**How this code works**
- `line or name` → what it does and why it is written that way (one bullet per important line or block)
- call out the decision a beginner would get wrong

**Run it**
```bash
python -m app.check_setup
```

**You should see**
```text
Qdrant OK · 0 collections
```

**If it breaks**
- symptom → cause → fix (2-4 of the most likely failures)

## Step 2 · ...
(6-12 steps in total. Each step adds one working piece and ends with something you can run and see.)

## Ship it
How to deploy or publish it (README contents to write, a short demo checklist, where to host, what to put in the
portfolio write-up: the numbers you measured).

## Going further
3-5 concrete extensions, each one line.
```

## Rules

- **Code is complete and runnable.** Every file shown in full the first time, or with exact "add this below X"
  instructions. No `...` placeholders in code the learner is meant to run. Python 3.11+, pinned-enough package names.
  Where an API is likely to drift (SDK method names, model ids), add a one-line comment `# check the current docs`.
- **Code blocks** use a `title="path/to/file.py"` or `title="terminal"` after the language so the app can label them.
- **Explain every important line** in "How this code works". The learner should understand the code, not just paste it.
- Every step ends with **Run it / You should see**. Expected output may be abbreviated but must be realistic.
- **Model ids and prices are examples**, read from environment variables (`MODEL = os.getenv("MODEL", "gpt-4o-mini")`)
  so learners can swap providers. Prefer the OpenAI-compatible client so Ollama, vLLM and most providers work.
- Small, real data: generate or download a realistic sample in an early step (with the exact command or script).
- Tests: at least one step adds a pytest test or an eval script that proves the thing works.
- Security projects stay defensive: attack only your own local toy app, use canary strings, no payloads aimed at real services.
- Original writing. 2,500-5,000 words per guide including code.
