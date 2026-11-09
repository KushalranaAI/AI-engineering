---
project: ai-system-design-doc
title: AI system design document
hours: 10
stack: Markdown, Python 3.11 (back-of-envelope calculators), pytest, optional pandoc for PDF
cost: Free
---

You will write a complete, reviewable design document for a substantial AI product, the kind a staff engineer would
circulate before anyone writes production code. Every number in it (traffic, tokens per minute, latency per stage,
cost per request and per month, the 10x scenario) comes from small Python calculators you can rerun when an
assumption changes, and every major decision names the alternative it beat. This guide works one example end to end:
**Clausewise, a contract-review assistant for in-house legal teams.** Follow it with your own product, or with this one.

## Before you start
- Lessons 9.1-9.9. You need no API key: this project is design, numbers and argument.
- Pick a product you could defend in an interview. Good candidates: a support copilot, a contract reviewer, a research
  agent, a sales-call summariser. It must have real traffic, a privacy constraint and a budget.
- Optional: `pandoc` to export a PDF (`winget install pandoc`, `brew install pandoc` or `apt install pandoc`).

```text
clausewise-design/
├── DESIGN.md              # the document (6-12 pages when exported)
├── pytest.ini
├── calc/
│   ├── __init__.py
│   ├── assumptions.py     # every number in one place
│   ├── capacity.py        # peak load, tokens/minute, Little's law
│   ├── latency.py         # per-stage budgets
│   └── cost.py            # per contract, per month, launch vs 10x
└── tests/test_calc.py
```

## How it fits together

```text
assumptions.py ──► capacity.py ──► "Traffic and capacity" table ─┐
      │        ──► latency.py  ──► "Latency budget" table ────────┼──► DESIGN.md ──► review ──► revise
      │        ──► cost.py     ──► "Cost model" tables ───────────┘        ▲
      └── tests/test_calc.py fails if a change breaks a stated limit ─────┘
```

You write requirements first, turn them into assumptions, and let the calculators produce the tables you paste into
the document. When a reviewer says "what if contracts are twice as long?", you change one number, rerun, and the
tests tell you which promise in the doc just broke.

## Step 1 · Set up the repo and the document skeleton
**Goal:** a `DESIGN.md` with every section a reviewer expects, in the order they read it.

The skeleton is the checklist. If a section stays empty, the design has a hole.

```bash title="terminal"
mkdir clausewise-design && cd clausewise-design
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install pytest
mkdir calc tests && touch calc/__init__.py
```

```ini title="pytest.ini"
[pytest]
pythonpath = .
testpaths = tests
```

```markdown title="DESIGN.md"
# Clausewise: design document
Status: draft v0.1 · Author: <you> · Reviewers: <names> · Last updated: <date>

## 1. Summary
## 2. Requirements
### 2.1 Users and use cases
### 2.2 Functional requirements
### 2.3 Non-functional requirements and hard constraints
### 2.4 Success metrics
## 3. Traffic and capacity
## 4. Architecture
### 4.1 Diagram
### 4.2 Models and routing
### 4.3 Knowledge layer
### 4.4 Tools and agents
## 5. Latency budget
## 6. Cost model and caching
## 7. Failure modes, degradation and safety
## 8. Evaluation, monitoring and improvement
## 9. Scaling to 10x
## 10. Decisions and alternatives rejected
## 11. Open questions and risks
## Appendix: assumptions (generated from calc/assumptions.py)
```

**How this code works**
- The order mirrors lesson 9.1: requirements before boxes, numbers before components, alternatives at the end.
- Section 1 is written **last**: three sentences a director could read in 30 seconds.
- "Open questions" is not weakness. Reviewers trust a doc that names its unknowns.

**Run it**
```bash
grep -c "^## " DESIGN.md        # PowerShell: (Select-String "^## " DESIGN.md).Count
```

**You should see**
```text
12
```

**If it breaks**
- You want to add "Tech stack" as section 2 → resist. Tools are consequences of requirements, so they live in 4.

## Step 2 · Pick the product and write requirements
**Goal:** sections 2.1-2.4 filled with concrete users, traffic, constraints and measurable success.

```markdown title="DESIGN.md (section 2)"
## 2. Requirements
### 2.1 Users and use cases
In-house lawyers and contract managers at mid-size companies (150 teams at launch). A user uploads a
vendor contract (PDF or DOCX, 10-80 pages, ~20% scanned). Clausewise extracts clauses, compares each to the team's
playbook (their accepted positions, e.g. "liability cap ≥ 12 months of fees"), flags deviations with a suggested
redline, and writes a one-page risk summary. The user then asks follow-up questions ("Is there an auto-renewal?").

### 2.2 Functional requirements
- F1 Ingest PDF/DOCX, OCR scanned pages, split into clauses with page anchors.
- F2 Classify every clause into one of 40 types (indemnity, liability, termination, ...).
- F3 For clauses with a playbook rule, judge compliant / deviation / missing, with a cited reason and redline.
- F4 Risk summary report, every claim linked to a clause.
- F5 Q&A over the contract with citations; abstain when the answer is not in the document.
- F6 Lawyer accepts, edits or rejects each flag; decisions feed the eval set.

### 2.3 Non-functional requirements and hard constraints
| Requirement | Target |
|---|---|
| Review turnaround | p95 < 10 minutes per contract (async, user is notified) |
| Q&A time to first token | p95 < 2.5 s |
| Availability | 99.5% for Q&A; reviews may queue during an outage but must never be lost |
| Privacy | Contracts are confidential. No training on customer data; zero-retention model endpoints only; EU customers' data stays in the EU region |
| Security | Tenant isolation: one team can never retrieve another team's clauses |
| Budget | Inference + infra under $2,000/month at launch volume |

### 2.4 Success metrics
- Clause classification accuracy ≥ 95% on the labelled set; deviation recall ≥ 90% (a missed risky clause is the costly error), precision ≥ 75%.
- Q&A: citation precision ≥ 95%, correct abstention on unanswerable questions ≥ 90%.
- Product: median lawyer time per contract down from 90 to 30 minutes; ≥ 60% of flags accepted unedited.
```

**How this code works**
- Each functional requirement is numbered so later sections can say "serves F3".
- Deviation **recall** outranks precision on purpose: a false flag costs a lawyer 30 seconds, a missed liability
  clause can cost the company millions. Stating this asymmetry drives the model and eval choices later.
- Privacy is written as testable constraints (zero retention, EU region), not "we care about privacy".

**Run it**
```bash
grep -cE "^\| |^- F[0-9]" DESIGN.md
```

**You should see** a count above 10 and no section 2 heading left empty.

**If it breaks**
- A target has no number ("fast", "accurate") → a reviewer cannot check it and neither can your evals. Add one.

## Step 3 · Put every assumption in one file and size the traffic
**Goal:** `calc/assumptions.py` and `calc/capacity.py`, producing the section 3 table.

Keeping assumptions in one frozen dataclass means the doc, the calculators and the tests share one source of truth.
`SCENARIOS` holds launch and 10x side by side.

```python title="calc/assumptions.py"
"""Every number the design depends on, in one place. Change a number here, rerun, update the doc."""
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class Assumptions:
    # traffic
    contracts_per_month: int = 3_000
    business_days: int = 22
    business_hours: int = 9
    share_in_business_hours: float = 0.8
    month_end_spike: float = 3.0            # last 3 days of a quarter see 3x the average hour
    questions_per_contract: int = 6         # interactive Q&A after a review
    # document shape
    pages_per_contract: int = 30
    tokens_per_page: int = 650
    scanned_share: float = 0.2              # needs OCR
    clauses_per_contract: int = 60
    clauses_per_classify_call: int = 12
    flagged_share: float = 0.2              # clauses sent to the strong model for risk review
    # tokens per call (input, output)
    classify_io: tuple[int, int] = (3_500, 600)
    risk_io: tuple[int, int] = (2_500, 400)
    report_io: tuple[int, int] = (8_000, 1_200)
    qa_io: tuple[int, int] = (4_000, 300)
    qa_strong_share: float = 0.3            # router sends 30% of questions to the strong model
    # prices, $ per 1M tokens (examples: check your provider's current price sheet)
    small_in: float = 0.15
    small_out: float = 0.60
    strong_in: float = 2.50
    strong_out: float = 10.00
    embed_per_m: float = 0.02
    ocr_per_1000_pages: float = 1.50
    cached_input_share: float = 0.4         # share of input tokens that hit the provider's prompt cache
    cached_discount: float = 0.5            # cached input billed at 50%
    # infrastructure, $ per month
    fixed_infra: float = 1_150.0            # app servers, vector DB, queue, observability
    # provider limits (tokens per minute, per model tier) - from your account's limits page
    tpm_limit_small: int = 2_000_000
    tpm_limit_strong: int = 800_000


SCENARIOS = {
    "launch": Assumptions(),
    "10x": replace(Assumptions(), contracts_per_month=30_000, fixed_infra=3_400.0),
}
```

```python title="calc/capacity.py"
"""Back-of-envelope traffic: peak load, tokens per minute against provider limits, in-flight Q&A."""
import math

from calc.assumptions import SCENARIOS, Assumptions


def calls_per_contract(a: Assumptions) -> dict[str, int]:
    return {
        "classify": math.ceil(a.clauses_per_contract / a.clauses_per_classify_call),
        "risk": round(a.clauses_per_contract * a.flagged_share),
        "report": 1,
    }


def tokens_per_contract(a: Assumptions) -> dict[str, int]:
    """Review-pipeline tokens per contract, split by model tier."""
    c = calls_per_contract(a)
    small = c["classify"] * sum(a.classify_io)
    strong = c["risk"] * sum(a.risk_io) + c["report"] * sum(a.report_io)
    return {"small": small, "strong": strong}


def peak_contracts_per_hour(a: Assumptions) -> float:
    avg_hour = a.contracts_per_month * a.share_in_business_hours / (a.business_days * a.business_hours)
    return avg_hour * a.month_end_spike


def peak_tpm(a: Assumptions) -> dict[str, float]:
    """Tokens per minute at peak if every contract is processed in the hour it arrives."""
    per_min = peak_contracts_per_hour(a) / 60
    t = tokens_per_contract(a)
    qa_per_min = per_min * a.questions_per_contract
    qa_tokens = sum(a.qa_io)
    return {"small": per_min * t["small"] + qa_per_min * qa_tokens * (1 - a.qa_strong_share),
            "strong": per_min * t["strong"] + qa_per_min * qa_tokens * a.qa_strong_share}


def qa_in_flight(a: Assumptions, seconds_per_answer: float = 5.0) -> float:
    """Little's law: concurrent requests = arrival rate x time in system."""
    qa_per_sec = peak_contracts_per_hour(a) * a.questions_per_contract / 3600
    return qa_per_sec * seconds_per_answer


def main() -> None:
    print("| scenario | peak contracts/h | small TPM (limit) | strong TPM (limit) | Q&A in flight |")
    print("|---|---|---|---|---|")
    for name, a in SCENARIOS.items():
        tpm = peak_tpm(a)
        print(f"| {name} | {peak_contracts_per_hour(a):.0f} | {tpm['small']:,.0f} ({a.tpm_limit_small:,}) | "
              f"{tpm['strong']:,.0f} ({a.tpm_limit_strong:,}) | {qa_in_flight(a):.1f} |")
    print("\ncalls per contract:", calls_per_contract(SCENARIOS["launch"]),
          " tokens per contract:", tokens_per_contract(SCENARIOS["launch"]))


if __name__ == "__main__":
    main()
```

**How this code works**
- `calls_per_contract` → 60 clauses in batches of 12 is 5 classify calls; 20% flagged gives 12 strong-model calls.
- `peak_contracts_per_hour` → monthly volume, squeezed into business hours, times a quarter-end spike. Designing for
  the average hour is the classic mistake; queues explode at the peak.
- `peak_tpm` → converts the peak into tokens per minute per model tier, the number provider rate limits are written in.
- `qa_in_flight` → Little's law (arrivals per second × seconds per request) gives concurrency for sizing workers.
- Prices and limits are **examples**. Read your provider's current price sheet and your account's limits page.

**Run it**
```bash
python -m calc.capacity
```

**You should see**
```text
| scenario | peak contracts/h | small TPM (limit) | strong TPM (limit) | Q&A in flight |
|---|---|---|---|---|
| launch | 36 | 23,370 (2,000,000) | 31,358 (800,000) | 0.3 |
| 10x | 364 | 233,697 (2,000,000) | 313,576 (800,000) | 3.0 |

calls per contract: {'classify': 5, 'risk': 12, 'report': 1}  tokens per contract: {'small': 20500, 'strong': 44000}
```

Paste the table into section 3 with two sentences of interpretation: even at 10x the strong tier uses about 40% of its
limit at peak, so rate limits are not the first bottleneck; the review queue's worker count is.

**If it breaks**
- `ModuleNotFoundError: calc` → run with `python -m calc.capacity` from the project root, not `python calc/capacity.py`.

## Step 4 · Architecture and diagram
**Goal:** section 4: a diagram plus the model, knowledge and tool decisions, each tied to a requirement.

```markdown title="DESIGN.md (section 4)"
## 4. Architecture
### 4.1 Diagram
    Upload ──► API (auth, tenant id) ──► object store (EU/US bucket, encrypted)
                     │
                     ▼ enqueue job (durable queue)
            ┌─────────────────── review worker ───────────────────┐
            │ parse/OCR ─► clause splitter ─► embed + index        │
            │      │                           (tenant-filtered)   │
            │      ▼                                               │
            │ classify (small model, 12 clauses/call)              │
            │      ▼                                               │
            │ playbook lookup ─► risk review (strong model)        │
            │      ▼                  per flagged clause           │
            │ report (strong model) ─► verifier: every claim cites │
            └──────────────┬──────────────────────────────────────┘
                           ▼ results + trace ─► Postgres ─► notify user
    Q&A: user ─► gateway ─► guard ─► rewrite ─► hybrid search (this contract only) ─► rerank ─► router ─► model ─► stream

### 4.2 Models and routing
| Task | Model tier | Why |
|---|---|---|
| Clause classification | small, fine-tune later | high volume, narrow label set, 95% reachable with few-shot |
| Risk review | strong | serves the recall target; 63% of cost, so it is the first optimisation target |
| Report | strong | long-context synthesis, once per contract |
| Q&A | router: 70% small / 30% strong | small model handles lookups; strong for "compare" and "is this risky" questions |
All calls go through one model gateway: retries, fallback to a second provider in the same region, per-tenant spend caps.

### 4.3 Knowledge layer
Two indexes. **Contract index**: clause chunks with page anchors, metadata `tenant_id`, `contract_id`, `clause_type`;
every query is filtered by both ids in the database, not in the prompt. **Playbook index**: each team's rules, small
(≈200 rules), retrieved by `clause_type` exactly, not by similarity. Hybrid search (BM25 + embeddings) because legal
text is full of exact terms ("indemnify", "consequential") that pure embeddings blur.

### 4.4 Tools and agents
No open-ended agent. The review is a fixed pipeline (a workflow), because the steps are known in advance and
auditable. The only tool-like step is the playbook lookup, which is deterministic code.
```

**How this code works**
- The diagram shows trust and data boundaries (tenant id from auth, region-specific bucket), not just boxes.
- Each model choice names the requirement it serves and its share of cost, which sets up sections 6 and 10.
- "No agent" is a decision with a reason; reviewers reward restraint they can follow (lesson 9.1, "baseline first").

**Run it**
```bash
grep -n "tenant" DESIGN.md
```

**You should see** `tenant` in the diagram, the knowledge layer and the requirements: the isolation story is
consistent across sections.

**If it breaks**
- A box has no requirement behind it → delete it or add the requirement. Unjustified boxes are what reviewers attack first.

## Step 5 · Latency budget per stage
**Goal:** `calc/latency.py` and section 5: a per-stage p50/p95 table for Q&A and a critical-path estimate for reviews.

```python title="calc/latency.py"
"""Latency budgets: interactive Q&A (per stage) and the async review pipeline (critical path)."""
import math

from calc.assumptions import SCENARIOS
from calc.capacity import calls_per_contract

# (stage, p50 ms, p95 ms) - measured on the baseline where possible, otherwise estimated and marked
QA_STAGES = [
    ("auth + gateway", 15, 40),
    ("input guard", 30, 80),
    ("query rewrite (small model)", 250, 600),
    ("hybrid retrieval", 60, 150),
    ("rerank top 30", 80, 200),
    ("prompt assembly", 5, 15),
    ("first token (model)", 450, 1_100),
]
QA_TTFT_TARGET_MS = 2_500
STREAM_TOKENS_PER_SEC = 60


def qa_budget() -> tuple[int, int]:
    return sum(s[1] for s in QA_STAGES), sum(s[2] for s in QA_STAGES)


def review_minutes(concurrency: int = 8, p95_call_s: dict | None = None) -> float:
    """Critical path of one contract review: classify in parallel, then risk in parallel, then the report."""
    p95 = p95_call_s or {"classify": 9, "risk": 12, "report": 35, "parse_ocr": 40}
    c = calls_per_contract(SCENARIOS["launch"])
    waves = {k: math.ceil(c[k] / concurrency) for k in ("classify", "risk")}
    seconds = p95["parse_ocr"] + waves["classify"] * p95["classify"] + waves["risk"] * p95["risk"] + p95["report"]
    return seconds / 60


def main() -> None:
    print("| Q&A stage | p50 ms | p95 ms |")
    print("|---|---|---|")
    for name, p50, p95 in QA_STAGES:
        print(f"| {name} | {p50} | {p95} |")
    p50, p95 = qa_budget()
    status = "OK" if p95 <= QA_TTFT_TARGET_MS else "OVER"
    print(f"| **time to first token** | **{p50}** | **{p95}** (target {QA_TTFT_TARGET_MS}, {status}) |")
    print(f"\nFull 300-token answer adds ~{300 / STREAM_TOKENS_PER_SEC:.0f} s of streaming.")
    print(f"Review pipeline p95, 8 parallel calls: {review_minutes(8):.1f} min (target 10 min)")
    print(f"Review pipeline p95, 2 parallel calls: {review_minutes(2):.1f} min")


if __name__ == "__main__":
    main()
```

**How this code works**
- `QA_STAGES` → every hop before the first token gets a budget. Summing p95s overstates the true p95 (stages are
  rarely all slow at once), so this is a safe upper bound. Say so in the doc.
- The model's first token takes half the budget; that is where streaming, a smaller model and a shorter prompt help.
- `review_minutes` → the review runs classify calls in parallel waves, then risk calls, then the report. With 8
  parallel calls one contract finishes in about 2 minutes; the 10-minute target leaves room for queueing at peak.

**Run it**
```bash
python -m calc.latency
```

**You should see**
```text
| Q&A stage | p50 ms | p95 ms |
|---|---|---|
| auth + gateway | 15 | 40 |
...
| first token (model) | 450 | 1100 |
| **time to first token** | **890** | **2185** (target 2500, OK) |

Full 300-token answer adds ~5 s of streaming.
Review pipeline p95, 8 parallel calls: 1.8 min (target 10 min)
Review pipeline p95, 2 parallel calls: 2.9 min
```

Add one line to section 5: "Query rewrite costs 600 ms at p95; if we miss the target, it is the first stage cut
(serve with the raw query and accept a small recall loss)." Naming what you would cut is what turns a table into a design.

**If it breaks**
- You have no measured numbers → mark estimates with "(est.)" and add "measure on the baseline" to section 11.

## Step 6 · Cost model and caching
**Goal:** `calc/cost.py` and section 6: cost per contract by stage, per month at launch and 10x, and the caching plan.

```python title="calc/cost.py"
"""Cost model: per contract, per question, per month, with prompt caching. Prints markdown tables."""
from calc.assumptions import SCENARIOS, Assumptions
from calc.capacity import calls_per_contract


def call_cost(a: Assumptions, io: tuple[int, int], tier: str) -> float:
    price_in, price_out = (a.small_in, a.small_out) if tier == "small" else (a.strong_in, a.strong_out)
    tokens_in, tokens_out = io
    effective_in = tokens_in * (1 - a.cached_input_share * a.cached_discount)   # caching lowers input cost
    return (effective_in * price_in + tokens_out * price_out) / 1e6


def cost_per_contract(a: Assumptions) -> dict[str, float]:
    c = calls_per_contract(a)
    pages = a.pages_per_contract
    return {
        "ocr": a.scanned_share * pages * a.ocr_per_1000_pages / 1000,
        "embed": pages * a.tokens_per_page * a.embed_per_m / 1e6,
        "classify (small)": c["classify"] * call_cost(a, a.classify_io, "small"),
        "risk review (strong)": c["risk"] * call_cost(a, a.risk_io, "strong"),
        "report (strong)": call_cost(a, a.report_io, "strong"),
        "Q&A": a.questions_per_contract * ((1 - a.qa_strong_share) * call_cost(a, a.qa_io, "small")
                                           + a.qa_strong_share * call_cost(a, a.qa_io, "strong")),
    }


def monthly(a: Assumptions) -> dict[str, float]:
    per = sum(cost_per_contract(a).values())
    variable = per * a.contracts_per_month
    return {"per_contract": per, "variable": variable, "fixed": a.fixed_infra, "total": variable + a.fixed_infra}


def main() -> None:
    launch = SCENARIOS["launch"]
    print("| stage | $ per contract | share |")
    print("|---|---|---|")
    stages = cost_per_contract(launch)
    total = sum(stages.values())
    for stage, usd in stages.items():
        print(f"| {stage} | {usd:.4f} | {usd / total:.0%} |")
    print(f"| **total** | **{total:.4f}** | 100% |\n")

    print("| scenario | contracts/month | variable $ | fixed $ | total $/month | $ per contract all-in |")
    print("|---|---|---|---|---|---|")
    for name, a in SCENARIOS.items():
        m = monthly(a)
        print(f"| {name} | {a.contracts_per_month:,} | {m['variable']:,.0f} | {m['fixed']:,.0f} | "
              f"{m['total']:,.0f} | {m['total'] / a.contracts_per_month:.3f} |")


if __name__ == "__main__":
    main()
```

**How this code works**
- `call_cost` → applies prompt caching to input tokens: the instructions and playbook prefix repeat on every call, so
  40% of input is billed at half price. Put stable text first in every prompt so the provider can cache it.
- `cost_per_contract` → one line per stage, so the table shows where the money goes.
- `monthly` → variable cost scales with volume; fixed infra does not, so cost per contract falls at 10x.

**Run it**
```bash
python -m calc.cost
```

**You should see**
```text
| stage | $ per contract | share |
|---|---|---|
| ocr | 0.0090 | 5% |
| embed | 0.0004 | 0% |
| classify (small) | 0.0039 | 2% |
| risk review (strong) | 0.1080 | 63% |
| report (strong) | 0.0280 | 16% |
| Q&A | 0.0226 | 13% |
| **total** | **0.1719** | 100% |

| scenario | contracts/month | variable $ | fixed $ | total $/month | $ per contract all-in |
|---|---|---|---|---|---|
| launch | 3,000 | 516 | 1,150 | 1,666 | 0.555 |
| 10x | 30,000 | 5,156 | 3,400 | 8,556 | 0.285 |
```

Paste both tables into section 6 and write the caching strategy in three bullets: provider prompt caching for the
instruction + playbook prefix; a result cache keyed by `(clause_hash, playbook_version)` so identical boilerplate
clauses across contracts reuse the verdict (invalidated when the playbook changes); **no** semantic cache for Q&A,
because near-identical questions about different contracts have different answers.

**If it breaks**
- Your total is 10x off → check units: prices are per **million** tokens. Divide by `1e6` once, not twice.

## Step 7 · Failure modes, degradation and safety
**Goal:** section 7: what fails, what the user sees, and which controls stop harm.

```markdown title="DESIGN.md (section 7)"
## 7. Failure modes, degradation and safety
| Failure | Detection | Degraded behaviour |
|---|---|---|
| Strong-model provider down | gateway error rate > 5% for 2 min | fail over to second provider (same region); if both down, reviews queue (durable) and users see "delayed", Q&A falls back to small model with a banner |
| Rate limited (429) at quarter end | gateway metrics | per-tenant fair queueing; reviews slow, Q&A keeps priority |
| OCR garbage on bad scans | text quality score < threshold | mark pages "needs manual review"; never silently skip pages |
| Model misses a risky clause | eval recall drop; lawyer adds a flag | every clause gets a type and verdict, listed in the UI, so nothing is invisible |
| Hallucinated citation | verifier checks quoted text exists on the cited page | drop the claim, log, count in metrics |

Safety and security controls
- Tenant isolation enforced in the database query (row-level filter on `tenant_id`), tested in CI with two fake tenants.
- Contract text is untrusted input: it is spotlighted as data, and the pipeline has no tools that send or delete, so an
  injected instruction has nothing to trigger.
- Human approval: Clausewise never edits or sends a contract. Every redline is a suggestion a lawyer accepts.
- PII and secrets: logs store clause ids and hashes, not text; provider keys in a secrets manager; zero-retention endpoints.
```

**How this code works**
- Every row has detection **and** behaviour. "We'll add retries" without detection is not a plan.
- The injection control is architectural (no dangerous tools exist), which is stronger than any prompt-level filter
  (Level 8).

**Run it**
```bash
grep -c "^| " DESIGN.md
```

**You should see** the count grow by at least six rows since Step 4.

**If it breaks**
- You cannot say what the user sees during an outage → that is the gap. Decide it now; it is a product decision too.

## Step 8 · Evaluate, monitor, improve, scale to 10x
**Goal:** sections 8 and 9: offline evals, production monitoring, the feedback loop and the 10x plan.

```markdown title="DESIGN.md (sections 8 and 9)"
## 8. Evaluation, monitoring and improvement
Offline (gates every prompt, model or chunking change in CI)
- 300 labelled clauses across 40 types (classification accuracy), 120 clause-playbook pairs with lawyer verdicts
  (deviation recall/precision), 80 Q&A pairs incl. 20 unanswerable (citation precision, abstention).
- Release gate: deviation recall must not drop more than 1 point vs the production baseline.

Production
- Metrics: review p95 duration, queue depth, Q&A TTFT, error and fallback rates, cost per contract per tenant.
- Quality signals: flag accept / edit / reject rates per clause type; "missed clause" reports from lawyers.
- Tracing: one trace per contract with spans per stage, tokens and cost.
Improvement loop: weekly, sample rejected flags and missed clauses, label them, add to the eval set, then change the
prompt or model and pass the gate. After ~2,000 accepted labels, fine-tune the classifier on a small model.

## 9. Scaling to 10x
Calculators show 10x is $8.6k/month and 364 contracts per hour at peak, inside provider limits. What changes:
review workers autoscale on queue depth (not CPU); the vector index moves from one node to a sharded or managed
tier at about 50M chunks; the risk-review cost (63%) is cut by batching 4 flagged clauses per call and routing
simple clause types to a mid-tier model, if the eval gate allows; reserved or committed capacity is negotiated
with the provider before the quarter end.
```

**How this code works**
- Eval sets are sized and tied to the success metrics from 2.4, so "is it good?" has a number.
- The gate protects the metric you said matters most (recall), not an average.
- The 10x plan uses the calculator's numbers and names the first thing that breaks.

**Run it**
```bash
python -m calc.capacity && python -m calc.cost
```

**You should see** the same 10x numbers you quoted in section 9. If they differ, the doc is wrong.

**If it breaks**
- You have no labelled data → say how you will get it (two lawyers label 300 clauses in week 1) and put it in the plan.

## Step 9 · Decisions and alternatives rejected, with tests on the numbers
**Goal:** section 10 as a decision table, and tests that fail if an assumption change breaks a promise in the doc.

```markdown title="DESIGN.md (section 10)"
## 10. Decisions and alternatives rejected
| Decision | Chosen | Rejected alternative | Why rejected |
|---|---|---|---|
| Orchestration | fixed workflow | autonomous agent | steps are known; agent adds cost, latency and audit pain for no recall gain |
| Risk model | strong model per flagged clause | small model for all | baseline test (est.): small model recall 78% vs 93%, below the 90% target |
| Retrieval | hybrid BM25 + embeddings | embeddings only | exact legal terms; hybrid +9 points recall@5 on our 80 Q&A set (est.) |
| Playbook lookup | exact match on clause type | vector search | rules are few and typed; similarity search returned wrong-type rules |
| Long contracts | clause-level pipeline | whole contract in a long-context call | cost ~4x higher per contract and worse recall on clauses in the middle |
| Hosting | zero-retention API, two regions | self-hosted open model | 2 engineers, no GPU ops; revisit at 10x when GPU cost per contract may win |
| Caching | prompt cache + clause-verdict cache | semantic cache for Q&A | different contracts, same question → different answers |
```

```python title="tests/test_calc.py"
"""The doc's numbers are only as good as the calculators. These tests pin the arithmetic and the design limits."""
from dataclasses import replace

from calc.assumptions import SCENARIOS
from calc.capacity import peak_tpm, tokens_per_contract
from calc.cost import cost_per_contract, monthly
from calc.latency import QA_TTFT_TARGET_MS, qa_budget, review_minutes

A = SCENARIOS["launch"]


def test_tokens_match_hand_calculation():
    # 5 classify calls x 4,100 = 20,500 small; 12 risk x 2,900 + 1 report x 9,200 = 44,000 strong
    assert tokens_per_contract(A) == {"small": 20_500, "strong": 44_000}


def test_caching_lowers_cost():
    no_cache = replace(A, cached_input_share=0.0)
    assert sum(cost_per_contract(A).values()) < sum(cost_per_contract(no_cache).values())


def test_fixed_costs_amortise_at_10x():
    assert monthly(SCENARIOS["10x"])["total"] < 10 * monthly(A)["total"]


def test_design_limits_hold():
    for a in SCENARIOS.values():                     # both launch and 10x must fit provider limits
        tpm = peak_tpm(a)
        assert tpm["small"] < a.tpm_limit_small and tpm["strong"] < a.tpm_limit_strong
    assert qa_budget()[1] <= QA_TTFT_TARGET_MS
    assert review_minutes(8) < 10
    assert monthly(A)["total"] < 2_000                  # the budget in the requirements section
```

**How this code works**
- Each decision row names a specific rejected option and a reason a reviewer can check. "(est.)" marks numbers you
  still have to measure.
- `test_tokens_match_hand_calculation` → the comment shows the arithmetic, so a reviewer can verify it by hand.
- `test_design_limits_hold` → encodes the promises from the doc (TPM under limits at 10x, TTFT target, 10-minute
  reviews, the $2,000 budget). Change an assumption, and a red test tells you which section to rewrite.

**Run it**
```bash
pytest -q
```

**You should see**
```text
....                                                                     [100%]
4 passed in 0.03s
```

Now try a reviewer's question: set `pages_per_contract = 80` and `clauses_per_contract = 160` in `assumptions.py`
and rerun the calculators and tests. Note which numbers move, then restore the values and add the result as a
sensitivity line in section 6.

**If it breaks**
- `FrozenInstanceError` → you assigned to a field in code; use `dataclasses.replace(...)` as `SCENARIOS` does.

## Step 10 · Review and finish
**Goal:** a 6-12 page document, reviewed once by someone else, revised, and exported.

Write section 1 (summary) and 11 (open questions) now, then export and check the length.

```markdown title="DESIGN.md (sections 1 and 11)"
## 1. Summary
Clausewise reviews vendor contracts against each team's playbook in under 10 minutes and answers follow-up
questions with citations. It is a fixed pipeline (small model to classify, strong model to judge flagged clauses)
over a tenant-isolated hybrid index, costing about $0.17 of inference per contract and $1.7k/month at launch.
The main risk is deviation recall on unusual clause wording; a lawyer-labelled eval set gates every change.

## 11. Open questions and risks
- Measured p95 for the strong model in the EU region (est. 1.1 s TTFT) — measure on the baseline in week 1.
- Will customers accept a US-hosted fallback provider for EU data? If not, EU Q&A degrades to small-model only.
- Labelling capacity: who labels the first 300 clauses, and how fast?
```

**Run it**
```bash
pandoc DESIGN.md -o DESIGN.pdf && echo exported
```

**You should see** `exported` and a PDF of 6-12 pages. Under 6 usually means missing trade-offs; over 12 usually
means implementation detail that belongs in a later doc.

**If it breaks**
- `pandoc: pdflatex not found` → install a LaTeX engine, or export HTML (`pandoc DESIGN.md -s -o DESIGN.html`) and
  print it to PDF from a browser.

## Ship it
- **Repo:** `DESIGN.md`, the PDF, `calc/`, and the tests. A README with a two-line pitch, a link to the PDF, and
  `python -m calc.cost` as the "reproduce my numbers" command.
- **Review:** ask an engineer to review it as a real architecture review: send the PDF, ask for comments on the
  decisions table first. Keep their comments and your changes in a short "Review log" appendix.
- **Portfolio write-up:** the product in one sentence, the three hardest trade-offs, and the numbers: cost per
  contract, monthly cost at launch and 10x, the latency budget and the eval gate.

## Going further
- Build the baseline (classify + risk review on 20 public sample contracts) and compare measured latency and cost with
  your estimates; add a "predicted vs measured" table.
- Add a third scenario (enterprise tier with 100-page contracts) to `SCENARIOS` and extend the tests.
- Write a one-page "rollout plan": shadow mode, 5 pilot teams, success criteria to expand.
- Redo the design for a different constraint (fully on-premise, no external API) and compare the decision tables.
