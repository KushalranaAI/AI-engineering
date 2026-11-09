---
project: context-managed-agent
title: Long-running agent with managed context
hours: 7
stack: Python 3.11, openai SDK (any OpenAI-compatible provider), tiktoken, pytest
cost: About $0.30 of API calls per full comparison with a small hosted model
---

You will run the same tool-using agent twice on a task that takes dozens of tool calls: once with the naive
"append everything" context from Level 5, once with managed context (section budgets, tool-output compression,
offloading to disk, rolling compaction, and a harness with a task list, progress file and a verification check). You
finish with a README table that shows, in measured numbers, what context management bought you in correctness, tokens,
latency and cost. This is the work that separates an agent demo from one that can run for an hour.

## Before you start
- Python 3.11+, an API key for an OpenAI-compatible provider (or Ollama with a tool-calling model), lessons 6.1-6.8.
- This builds on your Level 5 agent. To keep the comparison clean, both versions here share one compact plain loop,
  one tool set and one model; only context handling differs. Port the ideas back into your LangGraph agent afterwards.

```text
context-agent/
├── .env
├── requirements.txt
├── pytest.ini
├── make_tickets.py      # 40 long tickets + ground truth
├── common.py            # model call, token counting, run log, the task
├── tools.py             # list_tickets, get_ticket, record_finding
├── naive_agent.py       # baseline: keep everything
├── context.py           # budgets, compression, compaction, assembly
├── harness.py           # tasks.json, findings.json, PROGRESS.md, verify
├── managed_agent.py     # the fixed agent
├── score.py             # comparison table
├── tests/test_context.py
├── data/  runs/  workspace/
```

## How it fits together

```text
naive:    [system][task][a1][t1 800 tok][a2][t2 800 tok] ... [a40][t40]     ← grows every turn, 30k+ tokens

managed:  ┌ system: rules + GOAL verbatim ─────────── ≤ 600 tok ┐
          │ STATE: rendered from workspace/*.json ─── ≤ 1200 tok │ ◄── harness (tasks, findings, PROGRESS.md)
          │ SUMMARY of compacted turns ───────────── ≤ 500 tok  │ ◄── compact() when recent > 5000
          └ recent turns, tool results compressed ── ≤ 5000 tok ┘ ◄── full tickets offloaded to workspace/raw/
                         │
                    model call ──► tool calls ──► results compressed, findings saved to disk
                         │
                 no tool calls ──► verify() ──► fail: feedback, keep going   pass: done
```

Each managed turn, the harness rebuilds the prompt from four budgeted sections instead of replaying history. The goal
is pinned verbatim, the exact numbers come from files on disk, older turns are folded into a short summary, and each
long ticket becomes one compact line with a pointer to the full copy on disk. When the model says it is finished, the
harness checks its answer against its own recorded findings before accepting it.

## Step 1 · Set up and generate a long task
**Goal:** 40 noisy support tickets on disk and a ground-truth answer the agent never sees.

A good degradation test needs many tool calls, long tool outputs, and constraints that are easy to forget. Each ticket
here is about 800 tokens of transcript, and some carry notes that contradict the structured fields.

```bash title="terminal"
mkdir context-agent && cd context-agent
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir tests
pip install -r requirements.txt
```

```text title="requirements.txt"
openai>=1.40
python-dotenv>=1.0
tiktoken>=0.7
pytest>=8.0
```

```bash title=".env"
OPENAI_API_KEY=sk-...
MODEL=gpt-4o-mini
# BASE_URL=http://localhost:11434/v1
PRICE_IN_PER_M=0.15
PRICE_OUT_PER_M=0.60
```

```ini title="pytest.ini"
[pytest]
pythonpath = .
testpaths = tests
```

```python title="make_tickets.py"
"""Generate 40 long, noisy support tickets plus the ground-truth answer."""
import json
import random
from pathlib import Path

N = 40
random.seed(7)
FILLER = [
    "Customer asked whether the mobile app supports dark mode.",
    "Agent apologised for the delay and confirmed the order number.",
    "Customer pasted a long error log from the checkout page.",
    "Agent suggested clearing the browser cache and trying again.",
    "Customer mentioned they have been with us for several years.",
    "Agent escalated to billing and promised an update within 48 hours.",
    "Customer asked about the difference between the annual and monthly plans.",
    "Agent shared a link to the refund policy page.",
]
TRAPS = [  # distractors that contradict the structured fields
    "Note: customer says they will be upgraded to gold next month.",
    "Note: refund was first quoted as $250 but the final requested amount is in the refund field.",
    "Note: customer thinks this ticket is closed, but the status field is authoritative.",
]


def make_ticket(i: int) -> dict:
    transcript = [random.choice(FILLER) for _ in range(random.randint(45, 65))]
    return {
        "id": f"T-{i:03d}",
        "customer": {"name": f"Customer {i}", "tier": random.choice(["gold", "silver", "bronze", "gold"])},
        "refund_requested": round(random.uniform(15, 400), 2),
        "status": random.choice(["open", "pending", "closed"]),
        "transcript": transcript,
        "internal_notes": random.sample(TRAPS, k=random.randint(0, 2)),
    }


def main() -> None:
    tickets = [make_ticket(i) for i in range(1, N + 1)]
    qualifying = [t["id"] for t in tickets
                  if t["customer"]["tier"] == "gold" and t["refund_requested"] > 100 and t["status"] != "closed"]
    total = round(sum(t["refund_requested"] for t in tickets if t["id"] in qualifying), 2)
    Path("data").mkdir(exist_ok=True)
    Path("data/tickets.json").write_text(json.dumps(tickets, indent=1), encoding="utf-8")
    Path("data/answer.json").write_text(json.dumps({"qualifying": qualifying, "total": total}, indent=1))
    print(f"{N} tickets, {len(qualifying)} qualify, total ${total}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `random.seed(7)` → everyone gets the same 40 tickets, so runs are comparable across days and people.
- `TRAPS` → notes like "will be upgraded to gold next month" tempt a drifting model to break the rule "use the
  structured fields". These are what make constraint drift measurable.
- `answer.json` is ground truth for `score.py` only. Neither agent reads it.

**Run it**
```bash
python make_tickets.py
```

**You should see**
```text
40 tickets, 9 qualify, total $2371.33
```

**If it breaks**
- Different counts → you changed the seed or the generator. That is fine as long as both agents use the same files.

## Step 2 · Shared pieces: model call, token counting, tools
**Goal:** both agents use identical model calls, tools and logging, so any difference comes from context handling.

```python title="common.py"
"""Shared by both agents: model client, token counting, cost, run log, the task text."""
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
MODEL = os.getenv("MODEL", "gpt-4o-mini")                        # example id
PRICE_IN = float(os.getenv("PRICE_IN_PER_M", "0.15"))            # $ per 1M input tokens (example)
PRICE_OUT = float(os.getenv("PRICE_OUT_PER_M", "0.60"))          # $ per 1M output tokens (example)
client = OpenAI(base_url=os.getenv("BASE_URL") or None, api_key=os.getenv("OPENAI_API_KEY", "local"))

TASK = """Review every support ticket (use list_tickets, then get_ticket for each id).
A ticket QUALIFIES for refund review only if ALL hold, using the structured fields, never the notes:
  1. customer.tier == "gold"
  2. refund_requested > 100
  3. status != "closed"
Call record_finding once for every ticket. When all tickets are recorded, reply with ONLY this JSON:
{"qualifying": ["T-..."], "total": <sum of refund_requested of qualifying tickets>}"""

try:
    import tiktoken
    _enc = tiktoken.get_encoding("o200k_base")

    def count_tokens(text: str) -> int:
        return len(_enc.encode(text))
except ImportError:  # rough fallback: ~4 characters per token
    def count_tokens(text: str) -> int:
        return len(text) // 4


def call(messages: list[dict], tools: list[dict] | None = None) -> tuple[dict, dict]:
    """One model call. Returns (assistant message dict, usage dict with tokens and seconds)."""
    t0 = time.perf_counter()
    resp = client.chat.completions.create(  # check the current docs
        model=MODEL, messages=messages, temperature=0, **({"tools": tools} if tools else {}))
    msg = resp.choices[0].message
    out = {"role": "assistant", "content": msg.content or ""}
    if msg.tool_calls:
        out["tool_calls"] = [{"id": c.id, "type": "function",
                              "function": {"name": c.function.name, "arguments": c.function.arguments}}
                             for c in msg.tool_calls]
    usage = {"prompt": resp.usage.prompt_tokens, "completion": resp.usage.completion_tokens,
             "seconds": round(time.perf_counter() - t0, 2)}
    return out, usage


class RunLog:
    """Collects per-turn numbers and writes runs/<name>.json for score.py."""

    def __init__(self, name: str):
        self.name, self.turns, self.t0 = name, [], time.perf_counter()

    def turn(self, usage: dict, n_tool_calls: int, **extra) -> None:
        self.turns.append({**usage, "tool_calls": n_tool_calls, **extra})
        print(f"[{self.name}] turn {len(self.turns):>3}  prompt={usage['prompt']:>6}  "
              f"tools={n_tool_calls}  {usage['seconds']}s", flush=True)

    def save(self, final: str, findings: dict, stop_reason: str) -> Path:
        p_in = sum(t["prompt"] for t in self.turns)
        p_out = sum(t["completion"] for t in self.turns)
        summary = {
            "name": self.name, "stop_reason": stop_reason, "final": final, "findings": findings,
            "turns": self.turns, "tokens_in": p_in, "tokens_out": p_out,
            "peak_prompt": max((t["prompt"] for t in self.turns), default=0),
            "seconds": round(time.perf_counter() - self.t0, 1),
            "cost_usd": round(p_in / 1e6 * PRICE_IN + p_out / 1e6 * PRICE_OUT, 4),
        }
        Path("runs").mkdir(exist_ok=True)
        path = Path("runs") / f"{self.name}.json"
        path.write_text(json.dumps(summary, indent=1), encoding="utf-8")
        return path
```

```python title="tools.py"
"""The ticket tools. Both agents use exactly these; only context handling differs."""
import json
from pathlib import Path

TICKETS = {t["id"]: t for t in json.loads(Path("data/tickets.json").read_text(encoding="utf-8"))}
PAGE = 10

SCHEMAS = [
    {"type": "function", "function": {
        "name": "list_tickets", "description": f"List ticket ids, {PAGE} per page. Pages start at 1.",
        "parameters": {"type": "object", "properties": {"page": {"type": "integer"}}, "required": ["page"]}}},
    {"type": "function", "function": {
        "name": "get_ticket", "description": "Get one ticket in full by id, e.g. T-007.",
        "parameters": {"type": "object", "properties": {"ticket_id": {"type": "string"}},
                       "required": ["ticket_id"]}}},
    {"type": "function", "function": {
        "name": "record_finding", "description": "Record your decision for one ticket.",
        "parameters": {"type": "object", "properties": {
            "ticket_id": {"type": "string"}, "qualifies": {"type": "boolean"},
            "refund_requested": {"type": "number"}},
            "required": ["ticket_id", "qualifies", "refund_requested"]}}},
]


def list_tickets(page: int) -> str:
    ids = sorted(TICKETS)
    chunk = ids[(page - 1) * PAGE: page * PAGE]
    more = page * PAGE < len(ids)
    return json.dumps({"page": page, "ids": chunk, "more_pages": more})


def get_ticket(ticket_id: str) -> str:
    if ticket_id not in TICKETS:
        return f"Error: no ticket {ticket_id}"
    return json.dumps(TICKETS[ticket_id], indent=1)   # long on purpose: ~600-900 tokens


def dispatch(name: str, raw_args: str, findings: dict) -> str:
    """Run a tool. record_finding writes into `findings`, which the caller owns."""
    try:
        args = json.loads(raw_args or "{}")
        if name == "list_tickets":
            return list_tickets(int(args["page"]))
        if name == "get_ticket":
            return get_ticket(args["ticket_id"])
        if name == "record_finding":
            findings[args["ticket_id"]] = {"qualifies": bool(args["qualifies"]),
                                           "refund": float(args["refund_requested"])}
            return f"Recorded {args['ticket_id']}. {len(findings)}/{len(TICKETS)} tickets recorded."
        return f"Error: unknown tool {name}"
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
        return f"Error: bad arguments for {name}: {exc}"
```

**How this code works**
- `TASK` → the goal, with three numbered constraints. This exact text must still be steering the model at turn 40.
- `count_tokens` → `tiktoken`'s `o200k_base` is close for OpenAI models and good enough for budgeting others. The
  fallback (4 characters per token) keeps things running if tiktoken is missing.
- `RunLog.turn` records prompt tokens per turn. Watching that number grow is the whole story of the naive agent.
- `save` → tokens in and out, peak prompt size, wall-clock seconds and cost from your env prices. Prices are examples.
- `get_ticket` returns the full ticket on purpose: that is what a real API does. Shrinking it is the managed agent's job.
- `dispatch` takes `findings` as an argument so each agent owns its own results.

**Run it**
```bash
python -c "import tools; print(tools.list_tickets(4)); print(len(tools.get_ticket('T-001')), 'chars')"
```

**You should see**
```text
{"page": 4, "ids": ["T-031", ..., "T-040"], "more_pages": false}
3898 chars
```

**If it breaks**
- `FileNotFoundError: data/tickets.json` → run `make_tickets.py` first, from the project root.
- tiktoken downloads its encoding on first use; offline machines fall back to the 4-chars rule after an error. Run
  once with internet, or accept the approximation.

## Step 3 · Make it fail first
**Goal:** a recorded naive run whose log shows the prompt growing every turn, and notes on where it drifts.

This is your Level 5 loop with nothing removed: every assistant message and every full tool result stays in the
message list forever.

```python title="naive_agent.py"
"""Baseline: the Level 5 loop with keep-everything context. Every tool result stays forever."""
import os

from openai import BadRequestError

from common import TASK, RunLog, call
from tools import SCHEMAS, dispatch

MAX_TURNS = int(os.getenv("MAX_TURNS", "80"))


def main() -> None:
    log, findings = RunLog(os.getenv("RUN_NAME", "naive")), {}
    messages = [{"role": "system", "content": "You are a meticulous support operations analyst."},
                {"role": "user", "content": TASK}]
    final, reason = "", "max_turns"
    for _ in range(MAX_TURNS):
        try:
            msg, usage = call(messages, SCHEMAS)
        except BadRequestError as exc:          # usually: context length exceeded
            final, reason = str(exc)[:300], "context_overflow"
            break
        calls = msg.get("tool_calls", [])
        log.turn(usage, len(calls))
        messages.append(msg)                     # keep everything...
        if not calls:
            final, reason = msg["content"], "done"
            break
        for c in calls:                          # ...including every full tool result
            result = dispatch(c["function"]["name"], c["function"]["arguments"], findings)
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
    path = log.save(final, findings, reason)
    print(f"saved {path}  stop_reason={reason}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `messages.append(...)` for every result → turn N resends everything from turns 1..N-1. Total input tokens grow
  roughly with the square of the number of turns.
- `BadRequestError` → if the prompt passes the model's context window, the provider rejects it. We record
  `context_overflow` as an outcome rather than crashing.
- `MAX_TURNS` → a backstop so a confused run cannot spend forever.

**Run it**
```bash
python naive_agent.py
```

**You should see**
```text
[naive] turn   1  prompt=   420  tools=1  0.9s
[naive] turn   2  prompt=   610  tools=10  1.8s
[naive] turn   3  prompt=  8930  tools=10  3.1s
...
[naive] turn  14  prompt= 36120  tools=4  4.7s
[naive] turn  15  prompt= 36900  tools=0  6.2s
saved runs/naive.json  stop_reason=done
```

Open `runs/naive.json` and read `final` and `findings`, then write down what went wrong. Typical failures: a few
tickets never recorded, a silver customer included because a note said "upgraded to gold", a total that does not match
its own list, or the same ticket fetched twice. With a small local model, failures arrive sooner and are worse.

**If it breaks**
- Ollama answers but ignores early instructions → Ollama silently truncates prompts beyond `num_ctx` (often 2-8k)
  instead of erroring. That *is* the degradation; note it. Raise `num_ctx` in a Modelfile to see the difference.
- `RateLimitError` → the naive run sends a lot of tokens per minute. Wait and rerun, or set `MODEL` to one with a
  higher limit.

## Step 4 · Score runs against ground truth
**Goal:** one command that turns `runs/*.json` into a comparison table.

```python title="score.py"
"""Score every runs/*.json against data/answer.json and print a markdown table."""
import json
import re
from pathlib import Path

TRUTH = json.loads(Path("data/answer.json").read_text())
TICKETS = {t["id"]: t for t in json.loads(Path("data/tickets.json").read_text(encoding="utf-8"))}


def parse_final(text: str) -> dict:
    match = re.search(r"\{.*\}", text or "", re.S)
    try:
        data = json.loads(match.group(0)) if match else {}
        return {"qualifying": set(data.get("qualifying", [])), "total": float(data.get("total", -1))}
    except (json.JSONDecodeError, TypeError, ValueError):
        return {"qualifying": set(), "total": -1.0}


def violates(tid: str) -> bool:
    t = TICKETS.get(tid)
    return t is None or not (t["customer"]["tier"] == "gold" and t["refund_requested"] > 100
                             and t["status"] != "closed")


def score(run: dict) -> dict:
    got, truth = parse_final(run["final"]), set(TRUTH["qualifying"])
    tp = len(got["qualifying"] & truth)
    precision = tp / len(got["qualifying"]) if got["qualifying"] else 0.0
    recall = tp / len(truth) if truth else 1.0
    own = {tid for tid, f in run["findings"].items() if f["qualifies"]}
    return {
        "success": got["qualifying"] == truth and abs(got["total"] - TRUTH["total"]) < 0.01,
        "id_f1": round(2 * precision * recall / (precision + recall), 2) if tp else 0.0,
        "total_err": round(abs(got["total"] - TRUTH["total"]), 2),
        "coverage": f"{len(run['findings'])}/{len(TICKETS)}",
        "violations": sum(violates(t) for t in got["qualifying"]),     # constraint drift
        "consistent": got["qualifying"] == own,                        # answer matches its own notes
    }


def main() -> None:
    cols = ["run", "stop", "success", "id_f1", "total_err", "coverage", "violations", "consistent",
            "tokens_in", "peak_prompt", "seconds", "cost_usd"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for path in sorted(Path("runs").glob("*.json")):
        run = json.loads(path.read_text(encoding="utf-8"))
        row = {"run": run["name"], "stop": run["stop_reason"], **score(run),
               **{k: run[k] for k in ("tokens_in", "peak_prompt", "seconds", "cost_usd")}}
        print("| " + " | ".join(str(row[c]) for c in cols) + " |")


if __name__ == "__main__":
    main()
```

**How this code works**
- `parse_final` → pulls the JSON object out of the final message, tolerating text around it.
- `success` → exact set match and total within one cent. Strict on purpose: a support lead cannot use "mostly right".
- `violations` → qualifying ids that break a constraint. This is the **goal drift** number.
- `consistent` → does the answer agree with the agent's own `record_finding` calls? Disagreement means it forgot its
  own earlier work: the **coherence** number.
- `coverage` → tickets recorded out of 40. Skipped tickets show up here.

**Run it**
```bash
python score.py
```

**You should see**
```text
| run | stop | success | id_f1 | total_err | coverage | violations | consistent | tokens_in | peak_prompt | seconds | cost_usd |
|---|---|---|---|---|---|---|---|---|---|---|---|
| naive | done | False | 0.82 | 312.4 | 38/40 | 1 | False | 297410 | 36900 | 61.3 | 0.0457 |
```

**If it breaks**
- `success` is True for naive with a strong model → good for the model! Make the task harder: set `N = 80` in
  `make_tickets.py` (regenerate), or use a smaller model. You need a baseline that fails to prove a fix.

## Step 5 · Set a budget and assemble context on purpose
**Goal:** `context.py`, which builds each prompt from four capped sections and shrinks tool output before it enters history.

This file is the code that "decides each turn what to keep, fetch, compress, offload or drop":

| Decision | Where |
|---|---|
| keep (always) | rules + goal, verbatim, at the top of every prompt |
| fetch | `STATE`, re-read from disk each turn by the harness |
| compress | `compress_tool_output`: an 800-token ticket becomes about 60 tokens |
| offload | the full ticket is written to `workspace/raw/` with a pointer |
| drop / summarise | `compact` folds the oldest turns into a short summary |

```python title="context.py"
"""Context management: section budgets, tool-output compression, compaction, assembly."""
import json
from pathlib import Path

from common import call, count_tokens

# Token budget per section of the prompt. Total stays near 8k no matter how long the run is.
BUDGET = {"rules_and_goal": 600, "state": 1200, "summary": 500, "recent": 5000}

RULES = """You are a meticulous support operations analyst working through a long task in many steps.
The STATE block is rebuilt from disk every turn and is the source of truth for what is done.
Do not re-fetch tickets that STATE lists as recorded. Use note_progress to leave short notes for yourself."""


def msg_tokens(m: dict) -> int:
    return count_tokens(m.get("content") or "") + count_tokens(json.dumps(m.get("tool_calls", "")))


def clip(text: str, budget: int) -> str:
    """Hard cap a section. Cuts by characters, roughly 4 per token."""
    return text if count_tokens(text) <= budget else text[: budget * 4] + "\n[...clipped to budget]"


# ---------- compress + offload ----------
def compress_tool_output(name: str, raw: str, workspace: Path) -> str:
    """Keep the fields the task needs; save the full ticket to disk and leave a pointer."""
    if name != "get_ticket" or raw.startswith("Error"):
        return raw[:1500]
    t = json.loads(raw)
    path = workspace / "raw" / f"{t['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(raw, encoding="utf-8")
    return json.dumps({"id": t["id"], "tier": t["customer"]["tier"], "refund_requested": t["refund_requested"],
                       "status": t["status"], "transcript_lines": len(t["transcript"]),
                       "full_ticket_saved_to": str(path)})


# ---------- compaction ----------
def group_turns(history: list[dict]) -> list[list[dict]]:
    """Group messages so an assistant tool call is never separated from its tool results."""
    turns, cur = [], []
    for m in history:
        if m["role"] == "assistant" and cur:
            turns.append(cur)
            cur = []
        cur.append(m)
    if cur:
        turns.append(cur)
    return turns


def compact(history: list[dict], summary: str, log=None) -> tuple[list[dict], str, int]:
    """If recent history is over budget, fold the oldest turns into the rolling summary."""
    if sum(msg_tokens(m) for m in history) <= BUDGET["recent"]:
        return history, summary, 0
    turns, keep, used = group_turns(history), [], 0
    for turn in reversed(turns):                       # newest first
        size = sum(msg_tokens(m) for m in turn)
        if keep and used + size > BUDGET["recent"] // 2:  # compact down to half: fewer summary calls
            break
        keep.insert(0, turn)
        used += size
    old = [m for turn in turns[: len(turns) - len(keep)] for m in turn]
    transcript = "\n".join(f"{m['role']}: {(m.get('content') or json.dumps(m.get('tool_calls')))[:300]}"
                           for m in old)
    msg, usage = call([{"role": "user", "content":
        "Update this running summary of an agent's work with the older steps below. Keep decisions, problems hit "
        "and lessons learned. Do NOT list ticket ids or amounts: those are stored exactly elsewhere. "
        f"Max 120 words.\n\nCURRENT SUMMARY:\n{summary or '(none)'}\n\nOLDER STEPS:\n{transcript}"}])
    if log:
        log.turn(usage, 0, kind="compaction")
    return [m for turn in keep for m in turn], msg["content"], len(old)


# ---------- assembly ----------
def assemble(goal: str, state_text: str, summary: str, history: list[dict]) -> tuple[list[dict], dict]:
    """Build this turn's prompt from separate, budgeted sections. Returns (messages, what we decided)."""
    head = clip(RULES + "\n\nGOAL (verbatim, never changes):\n" + goal, BUDGET["rules_and_goal"])
    state = clip(state_text, BUDGET["state"])
    summ = clip(summary, BUDGET["summary"]) if summary else "(nothing compacted yet)"
    messages = [{"role": "system", "content": head},
                {"role": "user", "content": f"STATE (from disk):\n{state}\n\nSUMMARY OF EARLIER STEPS:\n{summ}"},
                *history]
    decisions = {"sections": {"head": count_tokens(head), "state": count_tokens(state),
                              "summary": count_tokens(summ), "recent": sum(msg_tokens(m) for m in history)}}
    return messages, decisions
```

**How this code works**
- `BUDGET` → explicit token caps per section. Total prompt stays around 7-8k tokens at turn 5 or turn 50.
- `compress_tool_output` → keeps exactly the four fields the task depends on and drops the transcript and notes.
  Dropping the trap notes is a feature: the model never sees the distraction. The pointer keeps the full text recoverable.
- `group_turns` → an assistant message with `tool_calls` and its `tool` results move together. Cutting between them
  makes the API reject the request, which is the most common bug in hand-written compaction.
- `compact` → when recent history passes 5,000 tokens, keep the newest turns that fit in **half** the budget and
  summarise the rest. Compacting to half means you summarise every few turns, not every turn.
- The summary prompt says "do NOT list ticket ids or amounts". Summaries paraphrase and round; exact data lives in
  files and is rendered by code (lesson 6.3).
- `assemble` → system message (rules + pinned goal), one user message (state + summary), then recent turns. It returns
  the token size of each section so the log shows what was decided.

**Run it**
```bash
python -c "from context import assemble; from common import TASK; m, d = assemble(TASK, 'Recorded 0/40', '', []); print(d)"
```

**You should see**
```text
{'sections': {'head': 177, 'state': 5, 'summary': 6, 'recent': 0}}
```

**If it breaks**
- `BadRequestError: messages with role 'tool' must be a response to a preceding message with 'tool_calls'` → history
  was cut mid-turn. Make sure every trim goes through `group_turns`.

## Step 6 · Wrap it in a harness
**Goal:** task state, progress notes and the done-check live on disk and in code, not in the conversation.

```python title="harness.py"
"""Durable task state: tasks.json, findings.json and PROGRESS.md, plus the done-check."""
import json
import re
from datetime import datetime
from pathlib import Path

NOTE_SCHEMA = {"type": "function", "function": {
    "name": "note_progress", "description": "Append a one-line note to PROGRESS.md (decisions, problems, next step).",
    "parameters": {"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]}}}


class Workspace:
    def __init__(self, root: Path, all_ids: list[str]):
        self.root = root
        root.mkdir(exist_ok=True)
        self.findings_path, self.tasks_path, self.progress_path = (
            root / "findings.json", root / "tasks.json", root / "PROGRESS.md")
        # Resume: if files exist from a killed run, pick up where it stopped.
        self.findings = json.loads(self.findings_path.read_text()) if self.findings_path.exists() else {}
        self.all_ids = all_ids
        if not self.progress_path.exists():
            self.progress_path.write_text("# Progress\n", encoding="utf-8")
        self.save()

    def save(self) -> None:
        self.findings_path.write_text(json.dumps(self.findings, indent=1))
        tasks = {tid: ("done" if tid in self.findings else "pending") for tid in self.all_ids}
        self.tasks_path.write_text(json.dumps(tasks, indent=1))

    def note(self, text: str) -> str:
        with self.progress_path.open("a", encoding="utf-8") as f:
            f.write(f"- {datetime.now():%H:%M:%S} {text.strip()[:200]}\n")
        return "Noted."

    def pending(self) -> list[str]:
        return [tid for tid in self.all_ids if tid not in self.findings]

    def render_state(self) -> str:
        """Exact data stays exact: computed by code from disk, never summarised by the model."""
        qualifying = sorted(t for t, f in self.findings.items() if f["qualifies"])
        total = round(sum(self.findings[t]["refund"] for t in qualifying), 2)
        notes = self.progress_path.read_text(encoding="utf-8").splitlines()[-5:]
        pending = self.pending()
        return (f"Recorded {len(self.findings)}/{len(self.all_ids)} tickets.\n"
                f"Next pending (fetch these): {', '.join(pending[:8]) or 'none - all recorded'}\n"
                f"Qualifying so far: {', '.join(qualifying) or 'none'} (running total ${total})\n"
                "Recent progress notes:\n" + "\n".join(notes))

    def verify(self, final_text: str) -> tuple[bool, str]:
        """The harness, not the model, decides when the task is done."""
        if self.pending():
            return False, f"Not done: {len(self.pending())} tickets not recorded yet, e.g. {self.pending()[:5]}."
        match = re.search(r"\{.*\}", final_text, re.S)
        try:
            data = json.loads(match.group(0)) if match else None
        except json.JSONDecodeError:
            data = None
        if not data:
            return False, 'Reply with ONLY the JSON object {"qualifying": [...], "total": ...}.'
        own = sorted(t for t, f in self.findings.items() if f["qualifies"])
        total = round(sum(self.findings[t]["refund"] for t in own), 2)
        if sorted(data.get("qualifying", [])) != own:
            return False, f"Your list does not match your recorded findings. Recorded qualifying: {own}."
        if abs(float(data.get("total", -1)) - total) > 0.01:
            return False, f"Total does not match recorded findings; the sum is {total}."
        return True, "ok"
```

**How this code works**
- `tasks.json` is regenerated from `findings.json` on every `save()`, so the task list cannot drift from the work done.
- `render_state` → the next 8 pending ids, the qualifying list and the running total, all computed in Python. The model
  reads exact numbers instead of re-adding 40 amounts from memory.
- `note` / `NOTE_SCHEMA` → the agent maintains `PROGRESS.md` itself; the last five notes appear in state.
- `verify` → refuses "done" while tickets are pending, and refuses an answer that disagrees with recorded findings. The
  model cannot declare victory early. Note what it does **not** check: ground truth. A harness can enforce consistency
  and completeness, not correctness.
- Loading `findings.json` in `__init__` → a killed run resumes from the last saved turn.

**Run it**
```bash
python -c "from pathlib import Path; from harness import Workspace; w = Workspace(Path('workspace'), ['T-001','T-002']); print(w.render_state()); print(w.verify('{}'))"
```

**You should see**
```text
Recorded 0/2 tickets.
Next pending (fetch these): T-001, T-002
Qualifying so far: none (running total $0)
Recent progress notes:
# Progress
(False, "Not done: 2 tickets not recorded yet, e.g. ['T-001', 'T-002'].")
```

Delete the test workspace afterwards: `rm -rf workspace` (Windows: `rmdir /s /q workspace`).

**If it breaks**
- `JSONDecodeError` loading `findings.json` → a run was killed mid-write. Delete `workspace/` or write to a temp file
  and rename it (an atomic save) as an improvement.

## Step 7 · Run the managed agent
**Goal:** the same task, same model, same tools, finishing with a flat prompt size and a verified answer.

```python title="managed_agent.py"
"""Same tools, same model, managed context: budgets, compaction, offloading and a harness."""
import json
import os
import shutil
import sys
from pathlib import Path

from common import TASK, RunLog, call
from context import assemble, compact, compress_tool_output
from harness import NOTE_SCHEMA, Workspace
from tools import SCHEMAS, TICKETS, dispatch

MAX_TURNS = int(os.getenv("MAX_TURNS", "80"))
MAX_TOKENS = int(os.getenv("MAX_RUN_TOKENS", "600000"))
MAX_VERIFY_FAILS = 3


def main() -> None:
    if "--fresh" in sys.argv:                           # without it, a killed run resumes from workspace/
        shutil.rmtree("workspace", ignore_errors=True)
    log = RunLog(os.getenv("RUN_NAME", "managed"))
    ws = Workspace(Path("workspace"), sorted(TICKETS))
    history, summary, used, fails = [], "", 0, 0
    final, reason = "", "max_turns"
    for _ in range(MAX_TURNS):
        if used > MAX_TOKENS:
            reason = "token_budget"
            break
        history, summary, folded = compact(history, summary, log)
        messages, decisions = assemble(TASK, ws.render_state(), summary, history)
        msg, usage = call(messages, SCHEMAS + [NOTE_SCHEMA])
        used += usage["prompt"] + usage["completion"]
        calls = msg.get("tool_calls", [])
        log.turn(usage, len(calls), folded=folded, **decisions)
        history.append(msg)

        if not calls:                                   # the model thinks it is finished
            ok, feedback = ws.verify(msg["content"])
            if ok:
                final, reason = msg["content"], "done"
                break
            fails += 1
            if fails >= MAX_VERIFY_FAILS:
                final, reason = msg["content"], "verify_failed"
                break
            history.append({"role": "user", "content": f"Verification failed: {feedback}"})
            continue

        for c in calls:
            name, args = c["function"]["name"], c["function"]["arguments"]
            if name == "note_progress":
                result = ws.note(json.loads(args or "{}").get("note", ""))
            else:
                result = compress_tool_output(name, dispatch(name, args, ws.findings), ws.root)
            history.append({"role": "tool", "tool_call_id": c["id"], "content": result})
        ws.save()                                       # task state is on disk after every turn

    path = log.save(final, ws.findings, reason)
    print(f"saved {path}  stop_reason={reason}")


if __name__ == "__main__":
    main()
```

**How this code works**
- Each turn: `compact` (maybe), `assemble` from disk state, one model call, then tools. History never holds a full ticket.
- `used > MAX_TOKENS` → a run-level token budget, separate from the per-prompt section budgets.
- No tool calls → `verify`. Failure feedback goes back as a user message, up to three times, then the run stops with
  `verify_failed` instead of looping.
- `ws.save()` after every turn → the progress file and task list are always current. Kill the process and rerun
  without `--fresh` to resume.

**Run it**
```bash
python managed_agent.py --fresh
```

**You should see**
```text
[managed] turn   1  prompt=   980  tools=1  0.8s
[managed] turn   2  prompt=  1310  tools=8  1.6s
...
[managed] turn   9  prompt=  6020  tools=8  1.9s
[managed] turn  10  prompt=   410  tools=0  2.2s
[managed] turn  11  prompt=  3470  tools=8  1.7s
...
[managed] turn  24  prompt=  4310  tools=0  1.4s
saved runs/managed.json  stop_reason=done
```

The short line with `tools=0` mid-run is a compaction call. Prompt size rises and falls in a sawtooth instead of
climbing. Now kill a run halfway (Ctrl+C) and start it again without `--fresh`: the first state line reads
`Recorded 18/40` or similar, and it carries on.

**If it breaks**
- Ends with `verify_failed` → read the feedback lines in `runs/managed.json`. Usually the model skipped a ticket; the
  state block lists pending ids, so check that `render_state` is in the prompt.
- The model re-fetches tickets it already recorded → strengthen the rule in `RULES` and confirm the state shows
  "Next pending" ids only.

## Step 8 · Prove the goal holds, with tests
**Goal:** tests that pin down the guarantees: pairs never split, budgets respected, goal and state always present.

```python title="tests/test_context.py"
import json

import context
from common import TASK
from context import BUDGET, assemble, compact, compress_tool_output, group_turns, msg_tokens
from harness import Workspace


def fake_turn(i: int, size: int = 400) -> list[dict]:
    call = {"id": f"c{i}", "type": "function", "function": {"name": "get_ticket", "arguments": "{}"}}
    return [{"role": "assistant", "content": "", "tool_calls": [call]},
            {"role": "tool", "tool_call_id": f"c{i}", "content": "word " * size}]


def test_turns_keep_tool_results_with_their_call():
    history = fake_turn(1) + fake_turn(2)
    assert [len(t) for t in group_turns(history)] == [2, 2]


def test_compaction_stays_in_budget_and_never_orphans_a_tool_message(monkeypatch):
    monkeypatch.setattr(context, "call", lambda msgs, tools=None: (
        {"role": "assistant", "content": "Fetched tickets in batches."}, {"prompt": 1, "completion": 1, "seconds": 0}))
    history = [m for i in range(40) for m in fake_turn(i)]
    kept, summary, folded = compact(history, "", None)
    assert folded > 0 and summary == "Fetched tickets in batches."
    assert kept[0]["role"] == "assistant"                       # first kept message is not an orphan tool result
    assert sum(msg_tokens(m) for m in kept) <= BUDGET["recent"]


def test_compression_offloads_the_full_ticket(tmp_path):
    ticket = {"id": "T-001", "customer": {"tier": "gold"}, "refund_requested": 120.0, "status": "open",
              "transcript": ["blah"] * 300, "internal_notes": []}
    raw = json.dumps(ticket)
    small = compress_tool_output("get_ticket", raw, tmp_path)
    assert len(small) < len(raw) / 5
    assert (tmp_path / "raw" / "T-001.json").read_text() == raw


def test_verify_rejects_early_and_wrong_answers(tmp_path):
    ws = Workspace(tmp_path, ["T-001", "T-002"])
    assert ws.verify('{"qualifying": [], "total": 0}')[0] is False      # tickets still pending
    ws.findings = {"T-001": {"qualifies": True, "refund": 120.0}, "T-002": {"qualifies": False, "refund": 50.0}}
    assert ws.verify('{"qualifying": ["T-001"], "total": 999}')[0] is False
    assert ws.verify('{"qualifying": ["T-001"], "total": 120.0}') == (True, "ok")


def test_goal_and_state_survive_any_amount_of_history(monkeypatch):
    monkeypatch.setattr(context, "call", lambda msgs, tools=None: (
        {"role": "assistant", "content": "summary"}, {"prompt": 1, "completion": 1, "seconds": 0}))
    history = [m for i in range(200) for m in fake_turn(i)]
    kept, summary, _ = compact(history, "", None)
    messages, _ = assemble(TASK, "Recorded 31/40 tickets.", summary, kept)
    assert 'customer.tier == "gold"' in messages[0]["content"]      # constraints pinned, verbatim
    assert "Recorded 31/40" in messages[1]["content"]                # task state rendered every turn
```

**How this code works**
- `monkeypatch.setattr(context, "call", ...)` → compaction runs without an API call, so tests are free and instant.
- The compaction test builds 40 turns (about 16k tokens) and checks the kept history fits the budget and starts with an
  assistant message.
- `test_goal_and_state_survive...` → after 200 turns of history, the constraints are still verbatim in the system
  message and the task state is in the prompt. This is "hold the goal" as an executable check.
- `test_verify...` → early "done" and a wrong total are both refused.

**Run it**
```bash
pytest -q
```

**You should see**
```text
.....                                                                    [100%]
5 passed in 0.9s
```

**If it breaks**
- The first run is slow (10-20 s) → tiktoken is downloading its encoding. Later runs are instant.

## Step 9 · Compare and write it up
**Goal:** a README table comparing naive and managed context over three runs each.

One run per version is an anecdote. Run each three times with different names, then score them all.

**Run it**
```bash title="terminal"
for i in 1 2 3; do RUN_NAME=naive-$i python naive_agent.py; RUN_NAME=managed-$i python managed_agent.py --fresh; done
python score.py
# PowerShell: foreach ($i in 1..3) { $env:RUN_NAME="naive-$i"; python naive_agent.py; $env:RUN_NAME="managed-$i"; python managed_agent.py --fresh }
```

**You should see** (your numbers will differ; the shape should not)
```text
| run | stop | success | id_f1 | total_err | coverage | violations | consistent | tokens_in | peak_prompt | seconds | cost_usd |
|---|---|---|---|---|---|---|---|---|---|---|---|
| managed-1 | done | True | 1.0 | 0.0 | 40/40 | 0 | True | 118230 | 7480 | 48.9 | 0.0189 |
| managed-2 | done | True | 1.0 | 0.0 | 40/40 | 0 | True | 121905 | 7390 | 51.2 | 0.0195 |
| managed-3 | done | False | 0.94 | 104.12 | 40/40 | 0 | True | 124880 | 7610 | 50.4 | 0.0199 |
| naive-1 | done | False | 0.82 | 312.4 | 38/40 | 1 | False | 297410 | 36900 | 61.3 | 0.0457 |
| naive-2 | done | False | 0.88 | 151.0 | 40/40 | 1 | False | 305112 | 37480 | 64.0 | 0.0469 |
| naive-3 | done | True | 1.0 | 0.0 | 40/40 | 0 | True | 288950 | 36210 | 58.7 | 0.0445 |
```

Summarise in the README as success rate (2/3 vs 1/3), mean tokens, peak prompt, seconds and cost. Then explain each
remaining managed failure from its log: a misjudged ticket is a model reasoning error, not a context error, and the
harness cannot catch it. That distinction is exactly what a reviewer wants to see you make.

**If it breaks**
- Managed is not cheaper → check the compaction calls are rare (look for `"kind": "compaction"` in the run file). If it
  compacts every turn, the half-budget rule is missing.
- Results swing wildly between runs → normal at this sample size. Add runs, or report the range rather than the mean.

## Ship it
- **Repo:** both agents, `score.py`, the tests, and the `runs/` folder (the logs are evidence; commit them).
- **README:** the problem in two sentences; the context diagram; the budget table; the comparison table with
  success rate, coherence (`consistent`), drift (`violations`), tokens, peak prompt, latency and cost; one
  paragraph per naive failure mode you saw; and the limits (the harness enforces consistency, not truth).
- **Chart:** plot prompt tokens per turn for one naive and one managed run from `runs/*.json`: a ramp versus a
  sawtooth makes the point in one picture.
- **Portfolio line:** "Cut tokens per task by X% and peak prompt by Y× while raising task success from A/3 to B/3 on a
  40-ticket, 80-tool-call task."

## Going further
- Turn on prompt caching: move the stable rules + goal into an unchanging prefix and report the cache hit rate and cost.
- Add a `read_raw(ticket_id)` tool so the agent can recover offloaded detail when compressed fields are not enough.
- Replace the fixed 8-id pending list with relevance ranking, so state shows the tickets most related to recent notes.
- Port `context.py` and `harness.py` into your Level 5 LangGraph agent as a `build_context` step before the agent node.
- Swap the task for 200 tickets and find the point where even the managed version breaks.
