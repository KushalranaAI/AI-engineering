---
project: production-style-agent
title: Production-style agent
hours: 8
stack: Python 3.11, LangGraph, openai SDK (any OpenAI-compatible provider), SQLite checkpoints, pytest
cost: Under $0.50 of API calls with a small hosted model, or free with Ollama
---

You will build a research agent that reads a folder of notes, plans its work, uses tools to look things up and do exact
arithmetic, and writes a report to disk only after a person approves it. It has hard budgets (steps, tokens, time),
retries with backoff, loop detection, a trace of every step, and it survives being killed mid-run. The same skeleton carries over to
an MCP agent or a coding agent.

## Before you start
- Python 3.11 or newer, and an API key for any OpenAI-compatible provider. For a free local run, install Ollama, run
  `ollama pull qwen2.5:7b`, and set `BASE_URL=http://localhost:11434/v1` (pick a model that supports tool calling).
- You should have finished lessons 5.1-5.9. The plain agent loop from 5.2 is the thing we are making robust.
- **Pick one track.** This guide builds the **research agent** track because it needs no extra services. State,
  budgets, approval and tracing are identical for the MCP and coding tracks ("Going further" covers MCP).

Final folder structure:

```text
research-agent/
├── .env
├── requirements.txt
├── pytest.ini
├── make_corpus.py
├── run.py                  # CLI: progress, approval, resume
├── trace_summary.py
├── NOTES.md
├── agent/
│   ├── __init__.py
│   ├── config.py
│   ├── llm.py
│   ├── tools.py
│   ├── state.py
│   ├── trace.py
│   └── graph.py
├── tests/
│   ├── test_tools.py
│   └── test_graph.py
├── data/notes/  reports/  traces/
└── checkpoints.db
```

## How it fits together

```text
task ─► planner ─► agent ──safe tool calls──► tools ──────┐
                   ▲  │                                  │
                   │  ├──save_report──► approval ────────┤  interrupt(): human answers y or a reason
                   │  │                                  │
                   └──┼──────────── results ◄────────────┘
                      │
                      └──no tool calls / budget hit / loop──► finish ─► END

every node ─► traces/trace.jsonl        every step ─► checkpoints.db (resume by thread_id)
```

A task enters the **planner**, which writes a short plan into state. The **agent** node sends the plan, the remaining
budget and the conversation to the model. If the model asks for safe tools, the **tools** node runs them and loops back.
If it asks to save the report, the **approval** node pauses the whole graph with `interrupt()` until a person answers.
When the model stops calling tools, or a budget or loop check trips, **finish** records why the run ended. Every step is
checkpointed to SQLite, so a killed process resumes from where it stopped.

## Step 1 · Set up the project and the sample notes
**Goal:** a virtual environment, settings read from `.env`, and five realistic research notes on disk.

We generate a small corpus about choosing an LLM hosting option, with prices, traffic and constraints scattered
across files, so the agent must search, read several notes and compute.

```bash title="terminal"
mkdir research-agent && cd research-agent
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir agent tests && touch agent/__init__.py        # Windows: type nul > agent\__init__.py
```

```text title="requirements.txt"
langgraph>=0.4
langgraph-checkpoint-sqlite>=2.0
openai>=1.40
python-dotenv>=1.0
pytest>=8.0
```

```bash title="terminal"
pip install -r requirements.txt
```

```bash title=".env"
OPENAI_API_KEY=sk-...your key...
MODEL=gpt-4o-mini
# BASE_URL=http://localhost:11434/v1   # uncomment for Ollama
MAX_STEPS=12
MAX_TOKENS=60000
MAX_SECONDS=180
```

```ini title="pytest.ini"
[pytest]
pythonpath = .
testpaths = tests
```

```python title="agent/config.py"
import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    model: str = os.getenv("MODEL", "gpt-4o-mini")          # example id; any tool-calling model works
    base_url: str | None = os.getenv("BASE_URL") or None    # e.g. http://localhost:11434/v1 for Ollama
    api_key: str = os.getenv("OPENAI_API_KEY", "not-needed-for-local")
    max_steps: int = int(os.getenv("MAX_STEPS", "12"))      # model calls per run
    max_tokens: int = int(os.getenv("MAX_TOKENS", "60000"))  # total tokens per run
    max_seconds: int = int(os.getenv("MAX_SECONDS", "180"))  # wall-clock per run


SETTINGS = Settings()
```

```python title="make_corpus.py"
"""Write a small, realistic research corpus to data/notes/."""
from pathlib import Path

NOTES = {
    "hosting-option-a-managed-api.md": """# Option A: managed API (pay per token)
Price: $0.15 per 1M input tokens and $0.60 per 1M output tokens.
Typical request: 1,200 input tokens and 300 output tokens.
Median latency: 0.9 s to first token. No servers to run. Rate limit: 2M tokens per minute.
""",
    "hosting-option-b-dedicated-gpu.md": """# Option B: one dedicated GPU server
Price: $1.10 per hour for one 24 GB GPU, billed 24 hours a day.
Serves an 8B open-weights model at about 40 requests per second with vLLM.
Median latency: 0.4 s to first token. One machine is a single point of failure that someone must patch.
""",
    "hosting-option-c-serverless-gpu.md": """# Option C: serverless GPU
Price: $0.0004 per GPU-second, billed only while a request runs. A typical request uses 1.5 GPU-seconds.
Cold starts add 8 to 20 seconds after 10 idle minutes.
""",
    "traffic-forecast.md": """# Traffic forecast for the support assistant
Expected volume: 2,000,000 requests per month at launch. Growth plan: 3x within a year.
""",
    "team-constraints.md": """# Team constraints
Two engineers, no dedicated ops person. Budget ceiling: $1,500 per month for inference.
Product wants first token under 1.5 s for 95% of requests.
Customer data may leave our cloud only under a signed data agreement (we have one with the Option A vendor).
""",
}


def main() -> None:
    out = Path("data/notes")
    out.mkdir(parents=True, exist_ok=True)
    for name, text in NOTES.items():
        (out / name).write_text(text, encoding="utf-8")
    print(f"wrote {len(NOTES)} notes to {out}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `load_dotenv()` runs before the dataclass is defined, so the defaults read your `.env` values.
- `base_url ... or None` → an empty string would break the client; `None` means "use OpenAI's default".
- `max_steps`, `max_tokens`, `max_seconds` → three independent budgets. Any one of them can end a run. They live in
  config, not the prompt, because the model cannot be trusted to count.
- The notes split one answer across files (prices, traffic, budget), so a one-shot LLM call cannot answer well.

**Run it**
```bash
python make_corpus.py
python -c "from agent.config import SETTINGS; print(SETTINGS)"
```

**You should see**
```text
wrote 5 notes to data/notes
Settings(model='gpt-4o-mini', base_url=None, api_key='sk-...', max_steps=12, max_tokens=60000, max_seconds=180)
```

**If it breaks**
- `ModuleNotFoundError: agent` → you ran from the wrong folder or forgot `agent/__init__.py`. Run from `research-agent/`.
- `max_steps='12'` printed as a string → you edited the dataclass and dropped the `int(...)`.

## Step 2 · A model call that survives failures
**Goal:** one function, `call_model`, that returns the assistant message as a plain dict and retries transient errors.

Providers return 429s and 500s under load. Retry those with exponential backoff and jitter; fail fast on everything
else (a 401 will not fix itself).

```python title="agent/llm.py"
import random
import time

from openai import APIConnectionError, APITimeoutError, InternalServerError, OpenAI, RateLimitError

from agent.config import SETTINGS

client = OpenAI(base_url=SETTINGS.base_url, api_key=SETTINGS.api_key, timeout=60)

RETRYABLE = (RateLimitError, APIConnectionError, APITimeoutError, InternalServerError)


def call_model(messages: list[dict], tools: list[dict] | None = None, attempts: int = 4) -> tuple[dict, int]:
    """One chat completion with retries. Returns (assistant message as a dict, tokens used)."""
    for attempt in range(1, attempts + 1):
        try:
            resp = client.chat.completions.create(  # check the current docs
                model=SETTINGS.model,
                messages=messages,
                **({"tools": tools} if tools else {}),
                temperature=0,
            )
            break
        except RETRYABLE as exc:
            if attempt == attempts:
                raise
            delay = min(2 ** attempt, 20) + random.uniform(0, 1)  # exponential backoff + jitter
            print(f"  [retry] {type(exc).__name__}, waiting {delay:.1f}s (attempt {attempt}/{attempts})")
            time.sleep(delay)

    msg = resp.choices[0].message
    as_dict: dict = {"role": "assistant", "content": msg.content or ""}
    if msg.tool_calls:
        as_dict["tool_calls"] = [
            {"id": tc.id, "type": "function",
             "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in msg.tool_calls
        ]
    used = resp.usage.total_tokens if resp.usage else 0
    return as_dict, used
```

**How this code works**
- `OpenAI(base_url=..., api_key=...)` → the same client talks to OpenAI, Ollama, vLLM, Groq and most gateways.
- `RETRYABLE` → only rate limits, network errors, timeouts and 5xx are retried. Bad requests and auth errors raise at once.
- `min(2 ** attempt, 20) + random.uniform(0, 1)` → waits 2, 4, 8 s plus jitter so many clients do not retry in lockstep.
- `**({"tools": tools} if tools else {})` → some providers reject an empty `tools` list, so we omit the key.
- `as_dict` → plain dicts in OpenAI chat format. Storing the SDK object in state is a common mistake: the checkpointer
  cannot serialise it cleanly and resume breaks.
- `resp.usage.total_tokens` → we return token usage so the graph can enforce the token budget.

**Run it**
```bash
python -c "from agent.llm import call_model; print(call_model([{'role':'user','content':'Say OK'}]))"
```

**You should see**
```text
({'role': 'assistant', 'content': 'OK'}, 19)
```

**If it breaks**
- `AuthenticationError` → wrong or missing `OPENAI_API_KEY`. Local Ollama ignores the key, but the variable can be anything.
- `NotFoundError: model ...` → `MODEL` does not exist on your provider. List models in its dashboard (or `ollama list`).
- `[retry] APIConnectionError` four times → `BASE_URL` points at nothing. Check the server is running and the URL ends in `/v1`.

## Step 3 · Three useful tools and one risky one
**Goal:** `search_notes`, `read_note` and `calculator` run freely; `save_report` is flagged as needing approval.

Tools are where agents fail in practice: bad arguments, missing files, path tricks, huge outputs. The executor turns
every failure into text the model can act on, instead of crashing the run.

```python title="agent/tools.py"
import ast
import json
import operator
import re
from pathlib import Path

NOTES_DIR = Path("data/notes")
REPORTS_DIR = Path("reports")
MAX_RESULT_CHARS = 2000  # keep tool output small so it doesn't flood the context


# ---------- tool 1: search ----------
def search_notes(query: str, k: int = 3) -> str:
    words = {w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2}
    scored = []
    for path in sorted(NOTES_DIR.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        score = sum(raw.lower().count(w) for w in words)
        if score:
            scored.append((score, path.name, raw.splitlines()[0]))
    scored.sort(reverse=True)
    if not scored:
        return "No notes matched. Try different keywords."
    return "\n".join(f"{name} (score {s}): {title}" for s, name, title in scored[:k])


# ---------- tool 2: read ----------
def read_note(name: str) -> str:
    path = (NOTES_DIR / name).resolve()
    if NOTES_DIR.resolve() not in path.parents:
        raise ValueError("name must be a file inside data/notes")
    if not path.exists():
        options = ", ".join(p.name for p in NOTES_DIR.glob("*.md"))
        raise FileNotFoundError(f"No note called {name!r}. Available: {options}")
    return path.read_text(encoding="utf-8")[:MAX_RESULT_CHARS]


# ---------- tool 3: calculator ----------
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg}


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ValueError("only numbers and + - * / ** ( ) are allowed")


def calculator(expression: str) -> str:
    try:
        tree = ast.parse(expression.replace(",", ""), mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"not a valid expression: {exc.msg}") from exc
    return f"{expression} = {round(_eval(tree.body), 4)}"


# ---------- tool 4: save report (has real consequences -> needs approval) ----------
def save_report(filename: str, content: str) -> str:
    if not re.fullmatch(r"[a-z0-9-]{1,40}\.md", filename):
        raise ValueError("filename must look like 'hosting-recommendation.md'")
    REPORTS_DIR.mkdir(exist_ok=True)
    path = REPORTS_DIR / filename
    path.write_text(content, encoding="utf-8")  # same name -> same file: safe to repeat (idempotent)
    return f"Saved {len(content)} characters to {path}"


REGISTRY = {
    "search_notes": search_notes,
    "read_note": read_note,
    "calculator": calculator,
    "save_report": save_report,
}
NEEDS_APPROVAL = {"save_report"}

TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "search_notes",
        "description": "Keyword search over the research notes. Returns note names with their titles.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "k": {"type": "integer", "default": 3}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "read_note",
        "description": "Read one note in full by its file name, e.g. 'traffic-forecast.md'.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                       "required": ["name"]}}},
    {"type": "function", "function": {
        "name": "calculator",
        "description": "Evaluate arithmetic exactly, e.g. '2000000 * 1200 / 1e6 * 0.15'. Use it for every number you report.",
        "parameters": {"type": "object", "properties": {"expression": {"type": "string"}},
                       "required": ["expression"]}}},
    {"type": "function", "function": {
        "name": "save_report",
        "description": "Save the final markdown report to disk. A human must approve this.",
        "parameters": {"type": "object", "properties": {
            "filename": {"type": "string"}, "content": {"type": "string"}},
            "required": ["filename", "content"]}}},
]


def run_tool(name: str, raw_args: str) -> str:
    """Run one tool call and ALWAYS return text: errors become messages the model can act on."""
    if name not in REGISTRY:
        return f"Error: unknown tool {name!r}. Available: {', '.join(REGISTRY)}"
    try:
        args = json.loads(raw_args or "{}")
    except json.JSONDecodeError as exc:
        return f"Error: arguments were not valid JSON ({exc}). Send a JSON object."
    try:
        return str(REGISTRY[name](**args))[:MAX_RESULT_CHARS]
    except Exception as exc:  # the model reads this and tries again differently
        return f"Error from {name}: {type(exc).__name__}: {exc}"
```

**How this code works**
- `search_notes` → a keyword scorer. Good enough for five notes; swap in your Level 4 retriever for a real corpus.
- `read_note` resolves the path and checks `NOTES_DIR in path.parents` → blocks `../../.env`. The error lists valid
  names, which is the hint the model needs to recover on its next step.
- `calculator` walks the syntax tree and allows only numbers and arithmetic operators. Never use `eval()` on model
  output: it would run `__import__('os').system(...)`.
- `save_report` → a strict filename regex, a fixed folder, and overwrite-by-name. Running it twice with the same input
  has the same effect as running it once (idempotent), which matters when a resumed run repeats a step.
- `NEEDS_APPROVAL` → the list of consequential tools lives in code. The graph routes on it; the prompt cannot bypass it.
- `TOOL_SCHEMAS` → what the model sees. "Use it for every number" is how you get exact arithmetic, not guessed totals.
- `run_tool` → unknown tool, bad JSON and exceptions each become an `Error...` string. `MAX_RESULT_CHARS` keeps one
  large result from eating the context window.

**Run it**
```bash
python -c "from agent.tools import run_tool as r; print(r('search_notes','{\"query\":\"price per hour gpu\"}')); print(r('calculator','{\"expression\":\"1.10*24*30\"}')); print(r('read_note','{\"name\":\"../.env\"}'))"
```

**You should see**
```text
hosting-option-b-dedicated-gpu.md (score 7): # Option B: one dedicated GPU server
hosting-option-c-serverless-gpu.md (score 5): # Option C: serverless GPU
hosting-option-a-managed-api.md (score 5): # Option A: managed API (pay per token)
1.10*24*30 = 792.0
Error from read_note: ValueError: name must be a file inside data/notes
```

**If it breaks**
- `No notes matched` for everything → you ran from a different folder, so `data/notes` is empty. Paths are relative to
  the project root; always run from there.

## Step 4 · Typed state and tracing
**Goal:** an explicit state object that records plan, steps, tokens, time and every tool call, plus a JSONL tracer.

The state is the run's memory and the thing that gets checkpointed. Reducers say how updates merge.

```python title="agent/state.py"
import operator
from typing import Annotated, TypedDict


class AgentState(TypedDict, total=False):
    task: str                                     # the user's request, never edited
    plan: list[str]                               # written once by the planner
    messages: Annotated[list[dict], operator.add]  # OpenAI-format chat history; nodes append
    steps: int                                    # model calls so far
    tokens: int                                   # tokens used so far
    active_seconds: Annotated[float, operator.add]  # time spent working (not waiting for a human)
    tool_log: Annotated[list[dict], operator.add]  # every tool call: name, args, ok, ms
    final: str                                    # the answer, once there is one
    stop_reason: str                              # done | max_steps | max_tokens | timeout | loop
```

```python title="agent/trace.py"
import json
import time
from functools import wraps
from pathlib import Path

from langgraph.errors import GraphInterrupt

TRACE_FILE = Path("traces/trace.jsonl")


def log_event(run_id: str, event: str, **fields) -> None:
    TRACE_FILE.parent.mkdir(exist_ok=True)
    row = {"ts": round(time.time(), 3), "run_id": run_id, "event": event, **fields}
    with TRACE_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, default=str) + "\n")


def traced(node_name: str):
    """Decorator: record start, duration and the keys each node updated."""
    def wrap(fn):
        @wraps(fn)
        def inner(state, config):
            run_id = config["configurable"]["thread_id"]
            t0 = time.perf_counter()
            try:
                update = fn(state, config)
            except GraphInterrupt:
                log_event(run_id, "paused", node=node_name)   # waiting for a human, not an error
                raise
            except Exception as exc:
                log_event(run_id, "node_error", node=node_name, error=repr(exc))
                raise
            ms = round((time.perf_counter() - t0) * 1000)
            log_event(run_id, "node", node=node_name, ms=ms,
                      updated=sorted(update or {}), steps=state.get("steps", 0))
            return update
        return inner
    return wrap
```

**How this code works**
- `Annotated[list[dict], operator.add]` → when a node returns `{"messages": [msg]}`, LangGraph appends `msg` instead of
  replacing the list. Plain fields (`steps`, `tokens`) are overwritten, so nodes return the new total.
- `active_seconds` is summed per node. We budget **working** time, not wall-clock time, so an approval that waits
  overnight does not trip the timeout.
- `tool_log` → name, argument key, success and latency for every call. Loop detection and the trace both read it.
- `traced("agent")` wraps a node: it logs duration and which state keys changed, and logs errors before re-raising.
- `except GraphInterrupt` → `interrupt()` works by raising this exception. Logging it as an error would make every
  approval look like a crash, so we record it as `paused`.

**Run it**
```bash
python -c "from agent.state import AgentState; print(list(AgentState.__annotations__))"
```

**You should see**
```text
['task', 'plan', 'messages', 'steps', 'tokens', 'active_seconds', 'tool_log', 'final', 'stop_reason']
```

**If it breaks**
- `ImportError: cannot import name 'GraphInterrupt'` → the module moved in your LangGraph version. Search the installed
  package with `python -c "import langgraph.errors as e; print(dir(e))"` and check the current docs.

## Step 5 · The graph: planner, agent, tools, approval, finish
**Goal:** a compiled LangGraph app with budgets, loop detection and a human checkpoint enforced in code.

The core of the project. Budget and loop checks are plain functions, nodes return partial state updates, and one
routing function decides where to go after every model call.

```python title="agent/graph.py"
import time

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from agent import llm
from agent.config import SETTINGS
from agent.state import AgentState
from agent.tools import NEEDS_APPROVAL, TOOL_SCHEMAS, run_tool
from agent.trace import log_event, traced

SYSTEM = """You are a careful research analyst. Work only from the notes, using the tools.
Rules:
- Use calculator for every number you report; never do arithmetic in your head.
- Cite the note file name after each fact, like (traffic-forecast.md).
- When the report is ready, call save_report once, then reply with a 3-line summary.
Plan:
{plan}
Budget left: {steps_left} model calls, {tokens_left} tokens."""


# ---------- budget and loop checks (plain functions: easy to unit-test) ----------
def budget_problem(state: AgentState) -> str | None:
    if state.get("steps", 0) >= SETTINGS.max_steps:
        return "max_steps"
    if state.get("tokens", 0) >= SETTINGS.max_tokens:
        return "max_tokens"
    if state.get("active_seconds", 0.0) >= SETTINGS.max_seconds:
        return "timeout"
    return None


def call_key(call: dict) -> str:
    return call["function"]["name"] + ":" + call["function"]["arguments"]


def repeat_count(state: AgentState, call: dict) -> int:
    return sum(1 for row in state.get("tool_log", []) if row["key"] == call_key(call))


# ---------- nodes ----------
@traced("planner")
def planner(state: AgentState, config) -> dict:
    t0 = time.perf_counter()
    msg, used = llm.call_model([
        {"role": "system", "content": "Write a short numbered plan (3-6 steps) for this research task. "
                                      "Plan only; do not answer it."},
        {"role": "user", "content": state["task"]},
    ])
    plan = [line.strip() for line in msg["content"].splitlines() if line.strip()][:6]
    return {"plan": plan, "steps": state.get("steps", 0) + 1, "tokens": state.get("tokens", 0) + used,
            "messages": [{"role": "user", "content": state["task"]}],
            "active_seconds": time.perf_counter() - t0}


@traced("agent")
def agent(state: AgentState, config) -> dict:
    t0 = time.perf_counter()
    system = SYSTEM.format(plan="\n".join(state["plan"]),
                           steps_left=SETTINGS.max_steps - state["steps"],
                           tokens_left=SETTINGS.max_tokens - state["tokens"])
    msg, used = llm.call_model([{"role": "system", "content": system}, *state["messages"]], TOOL_SCHEMAS)
    return {"messages": [msg], "steps": state["steps"] + 1, "tokens": state["tokens"] + used,
            "active_seconds": time.perf_counter() - t0}


def execute_calls(state: AgentState, config, reviewer_note: str | None) -> dict:
    """Run every pending tool call. reviewer_note is 'approve', a rejection reason, or None."""
    t_start = time.perf_counter()
    run_id = config["configurable"]["thread_id"]
    messages, log = [], []
    for call in state["messages"][-1]["tool_calls"]:
        name = call["function"]["name"]
        t0 = time.perf_counter()
        if repeat_count(state, call) >= 2:
            result = (f"You already called {name} with these exact arguments twice. "
                      "Use the earlier result or try something different.")
        elif name in NEEDS_APPROVAL and reviewer_note != "approve":
            result = f"Denied by reviewer: {reviewer_note or 'no approval given'}. Revise the report, then ask again."
        else:
            result = run_tool(name, call["function"]["arguments"])
        ms = round((time.perf_counter() - t0) * 1000)
        ok = not result.startswith(("Error", "Denied", "You already"))
        log.append({"key": call_key(call), "name": name, "ok": ok, "ms": ms})
        log_event(run_id, "tool", name=name, ok=ok, ms=ms, preview=result[:120])
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    return {"messages": messages, "tool_log": log, "active_seconds": time.perf_counter() - t_start}


@traced("tools")
def tools(state: AgentState, config) -> dict:
    return execute_calls(state, config, reviewer_note=None)


@traced("approval")
def approval(state: AgentState, config) -> dict:
    # interrupt() FIRST: when the run resumes, this node restarts from the top,
    # so nothing with side effects may happen before this line.
    pending = [{"tool": c["function"]["name"], "arguments": c["function"]["arguments"]}
               for c in state["messages"][-1]["tool_calls"] if c["function"]["name"] in NEEDS_APPROVAL]
    decision = interrupt({"needs_approval": pending})
    return execute_calls(state, config, reviewer_note=str(decision))


@traced("finish")
def finish(state: AgentState, config) -> dict:
    last = state["messages"][-1]
    problem = budget_problem(state)
    if problem:
        return {"stop_reason": problem, "final": f"Stopped early ({problem}). Last message: {last.get('content', '')[:500]}"}
    if any(repeat_count(state, c) >= 3 for c in last.get("tool_calls") or []):
        return {"stop_reason": "loop", "final": "Stopped: the agent kept repeating the same tool call."}
    return {"stop_reason": "done", "final": last.get("content", "")}


# ---------- edges ----------
def route_after_agent(state: AgentState) -> str:
    last = state["messages"][-1]
    calls = last.get("tool_calls") or []
    if not calls or budget_problem(state):
        return "finish"
    if any(repeat_count(state, c) >= 3 for c in calls):
        return "finish"
    if any(c["function"]["name"] in NEEDS_APPROVAL for c in calls):
        return "approval"
    return "tools"


def build_graph(checkpointer=None):
    g = StateGraph(AgentState)
    g.add_node("planner", planner)
    g.add_node("agent", agent)
    g.add_node("tools", tools)
    g.add_node("approval", approval)
    g.add_node("finish", finish)
    g.add_edge(START, "planner")
    g.add_edge("planner", "agent")
    g.add_conditional_edges("agent", route_after_agent, ["tools", "approval", "finish"])
    g.add_edge("tools", "agent")
    g.add_edge("approval", "agent")
    g.add_edge("finish", END)
    return g.compile(checkpointer=checkpointer)
```

**How this code works**
- `SYSTEM` is rebuilt every turn with the plan and the **remaining** budget. The model sees "3 model calls left" and
  tends to wrap up, but the hard stop is still in code.
- `budget_problem` → checks all three budgets and names the one that tripped, so `stop_reason` tells you why a run ended.
- `call_key` + `repeat_count` → loop detection. A third identical call gets a nudge instead of running; a fourth ends
  the run with `stop_reason="loop"`. Agents genuinely get stuck re-reading the same file; this costs nothing to add.
- `planner` → one tool-free model call that writes the plan and adds the task as the first user message.
- `execute_calls` → runs every pending call and **always** answers each `tool_call_id`. The chat API rejects the next
  request if any tool call is left without a matching `tool` message.
- `approval` calls `interrupt()` **before** doing anything. On resume LangGraph re-runs the node from the top and
  `interrupt()` returns the human's answer. Any side effect above that line would happen twice.
- A rejection is not an error: the reviewer's reason goes back to the model as the tool result, so it can revise.
- `route_after_agent` → the only place control flow is decided: finish, approval or tools. The prompt cannot reach the
  file system without passing through `approval`.
- `compile(checkpointer=...)` → saves every step under a `thread_id`; `interrupt()` needs it.

**Run it**
```bash
python -c "from agent.graph import build_graph; print(build_graph().get_graph().draw_mermaid())"
```

**You should see**
```text
graph TD;
	__start__([<p>__start__</p>]):::first
	planner(planner)
	...
	__start__ --> planner;
	agent -.-> approval;
	agent -.-> finish;
	agent -.-> tools;
	approval --> agent;
	planner --> agent;
	tools --> agent;
	finish --> __end__;
```

Dotted arrows are conditional edges. Paste the output into mermaid.live to see the picture, and put it in your README.

**If it breaks**
- `ValueError: ... unknown node` or `Found edge ending at unknown node` → a name in `add_conditional_edges` does not
  match `add_node`. They are plain strings, so typos only show up here.
- `TypeError` about the node signature → LangGraph passes `config` only to parameters literally named `config`; keep
  the `(state, config)` signature on every node.

## Step 6 · Stream progress, ask for approval, resume after a crash
**Goal:** a CLI that shows each step live, pauses for a yes/no before writing, and can resume any run by id.

`app.stream(..., stream_mode="updates")` yields one dict per finished node, which is exactly what a user wants to see.
When the graph hits `interrupt()`, the stream yields an `__interrupt__` item and stops; we ask the human and resume with
`Command(resume=answer)`.

```python title="run.py"
import argparse
import json
import sqlite3
import textwrap
import uuid

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from agent.graph import build_graph


def pretty(raw: str) -> str:
    try:
        return json.dumps(json.loads(raw or "{}"), indent=2)
    except json.JSONDecodeError:
        return raw  # show malformed arguments as-is rather than crash


def show(node: str, data: dict) -> None:
    """Turn each node's state update into one or two human-readable progress lines."""
    if node == "planner":
        print("[plan]")
        for line in data["plan"]:
            print("   ", line)
    elif node == "agent":
        msg = data["messages"][-1]
        for call in msg.get("tool_calls", []):
            print(f"[step {data['steps']}] calling {call['function']['name']} {call['function']['arguments'][:80]}")
        if not msg.get("tool_calls"):
            print(f"[step {data['steps']}] writing the answer")
    elif node in ("tools", "approval"):
        for m in data["messages"]:
            print(f"    -> {m['content'][:100].replace(chr(10), ' ')}")
    elif node == "finish":
        print(f"[done] stop_reason={data['stop_reason']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task", nargs="?", help="omit to resume an existing --thread")
    parser.add_argument("--thread", help="run id; reuse it to resume after a crash")
    args = parser.parse_args()

    conn = sqlite3.connect("checkpoints.db", check_same_thread=False)
    app = build_graph(checkpointer=SqliteSaver(conn))
    thread = args.thread or f"run-{uuid.uuid4().hex[:6]}"
    config = {"configurable": {"thread_id": thread}, "recursion_limit": 100}
    print(f"thread: {thread}")

    if args.task:
        inputs = {"task": args.task, "steps": 0, "tokens": 0, "active_seconds": 0.0,
                  "messages": [], "tool_log": []}
    else:
        inputs = None  # None = continue from the last checkpoint of this thread

    while True:
        paused = None
        for update in app.stream(inputs, config, stream_mode="updates"):  # check the current docs
            for node, data in update.items():
                if node == "__interrupt__":
                    paused = data[0].value
                elif data:
                    show(node, data)
        if paused is None:
            break
        print("\n[approval needed]")
        for item in paused["needs_approval"]:
            print(f"  tool: {item['tool']}")
            print(textwrap.indent(pretty(item["arguments"])[:1500], "    "))
        answer = input("Approve? y = yes, anything else = reason for rejecting: ").strip()
        inputs = Command(resume="approve" if answer.lower() in ("y", "yes") else (answer or "rejected"))

    final = app.get_state(config).values
    print("\n" + final.get("final", ""))
    print(f"\nsteps={final['steps']} tokens={final['tokens']} active_s={final['active_seconds']:.1f}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `SqliteSaver(sqlite3.connect("checkpoints.db", ...))` → a durable checkpointer. Swap for Postgres in production.
- `thread_id` → the run's identity. Reusing it with no task (`inputs = None`) continues from the last checkpoint.
- `recursion_limit: 100` → LangGraph's own super-step cap (default 25). Our budget is the real limit; this is a backstop
  set high enough not to fire first.
- The `while True` loop → stream until either the graph ends or it pauses. On pause, show exactly what will be written,
  then resume with `"approve"` or the reviewer's reason.
- `show()` prints the tool in use and a preview of each result: the progress view.

**Run it**
```bash
python run.py "Which hosting option should we choose for the support assistant? Compare monthly cost at the forecast traffic, check it against our budget and latency target, and save a short report."
```

**You should see**
```text
thread: run-3f9a1c
[plan]
    1. Search the notes for hosting options, prices and constraints.
    2. Read each option, the traffic forecast, team constraints and latency notes.
    ...
[step 2] calling search_notes {"query": "hosting option price"}
    -> hosting-option-a-managed-api.md (score 6): # Option A: managed API (pay per token) ...
...
[step 7] calling calculator {"expression": "2000000 * (1200 * 0.15 + 300 * 0.60) / 1e6"}
    -> 2000000 * (1200 * 0.15 + 300 * 0.60) / 1e6 = 720.0
[step 9] calling save_report {"filename": "hosting-recommendation.md", "content": "# Hosting recommendation ...

[approval needed]
  tool: save_report
    {
      "filename": "hosting-recommendation.md",
      "content": "# Hosting recommendation\n\nRecommend Option A ..."
    }
Approve? y = yes, anything else = reason for rejecting: y
    -> Saved 1432 characters to reports/hosting-recommendation.md
[step 10] writing the answer
[done] stop_reason=done

Recommended Option A (managed API): about $720/month vs $792 for a dedicated GPU ...

steps=10 tokens=21480 active_s=14.2
```

Your numbers and wording will differ; check that every cost came from a `calculator` call. Now **test the crash path**:
start a new run, and when the approval prompt appears press Ctrl+C. Then resume it:

```bash
python run.py --thread run-3f9a1c
```

The approval prompt reappears with the same report, without re-running the earlier steps.

**If it breaks**
- `BadRequestError: ... tool_call_id ... did not have response messages` → a tool call went unanswered. Check that
  `execute_calls` appends a `tool` message for every call, including denied and repeated ones.
- The run ends at `stop_reason=max_steps` before saving → your model is chatty. Raise `MAX_STEPS` to 16, or use a
  stronger model. Note how the budget stopped it cleanly instead of looping forever.
- Small local models answer in prose instead of calling tools → use a model tagged for tool calling (e.g. `qwen2.5:7b`
  or larger) and keep `temperature=0`.

## Step 7 · Prove it works with tests and a fake model
**Goal:** a pytest suite that runs the entire graph offline, including the approval pause, in about a second.

Test the **harness** with a scripted fake model that returns a fixed sequence of messages, then assert on routing,
budgets and side effects.

```python title="tests/test_tools.py"
import pytest

from agent.graph import budget_problem, route_after_agent
from agent.tools import calculator, save_report


def test_calculator_is_exact():
    assert calculator("2,000,000 * 1200 / 1e6 * 0.15") == "2,000,000 * 1200 / 1e6 * 0.15 = 360.0"


def test_calculator_refuses_code():
    with pytest.raises(ValueError):
        calculator("__import__('os').system('echo hi')")


def test_save_report_blocks_path_traversal(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError):
        save_report("../../evil.md", "x")


def test_budget_stops_the_run():
    state = {"steps": 99, "tokens": 0, "active_seconds": 0.0}
    assert budget_problem(state) == "max_steps"
    state["messages"] = [{"role": "assistant", "content": "", "tool_calls": [
        {"id": "1", "type": "function", "function": {"name": "calculator", "arguments": "{}"}}]}]
    state["tool_log"] = []
    assert route_after_agent(state) == "finish"


def test_risky_tool_routes_to_approval():
    call = {"id": "1", "type": "function",
            "function": {"name": "save_report", "arguments": '{"filename": "a.md", "content": "x"}'}}
    state = {"steps": 1, "tokens": 10, "active_seconds": 1.0, "tool_log": [],
             "messages": [{"role": "assistant", "content": "", "tool_calls": [call]}]}
    assert route_after_agent(state) == "approval"
```

```python title="tests/test_graph.py"
"""Run the whole graph offline with a scripted fake model."""
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from agent import llm
from agent.graph import build_graph


def tool_call(i: int, name: str, args: str) -> dict:
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": args}}]}


SCRIPT = [
    {"role": "assistant", "content": "1. Read notes\n2. Compute cost\n3. Save report"},   # planner
    tool_call(1, "calculator", '{"expression": "2000000 * 1200 / 1e6 * 0.15"}'),
    tool_call(2, "save_report", '{"filename": "test-report.md", "content": "# Report"}'),
    {"role": "assistant", "content": "Saved the report. Option A costs about $720/month."},
]


def test_full_run_with_approval(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    replies = iter(SCRIPT)
    monkeypatch.setattr(llm, "call_model", lambda messages, tools=None: (next(replies), 100))

    app = build_graph(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t1"}, "recursion_limit": 100}
    start = {"task": "cost?", "steps": 0, "tokens": 0, "active_seconds": 0.0, "messages": [], "tool_log": []}

    app.invoke(start, config)
    paused = app.get_state(config)
    assert paused.next == ("approval",)                 # stopped before writing anything
    assert not (tmp_path / "reports" / "test-report.md").exists()

    result = app.invoke(Command(resume="approve"), config)
    assert result["stop_reason"] == "done"
    assert (tmp_path / "reports" / "test-report.md").read_text() == "# Report"
    assert result["steps"] == 4 and result["tokens"] == 400
```

**How this code works**
- `monkeypatch.setattr(llm, "call_model", ...)` → `graph.py` calls `llm.call_model` through the module, so replacing
  the attribute swaps the model everywhere. Importing the function directly (`from agent.llm import call_model`) would
  make this patch silently miss.
- `paused.next == ("approval",)` plus "file does not exist" → proves the risky tool cannot run without a human.
- `Command(resume="approve")` → the same call your CLI makes.
- `steps == 4 and tokens == 400` → the budget counters add up correctly across nodes.

**Run it**
```bash
pytest -q
```

**You should see**
```text
......                                                                   [100%]
6 passed in 1.12s
```

**If it breaks**
- `StopIteration` inside the fake → the graph made more model calls than the script has replies. Usually a routing bug:
  print `app.get_state(config).values["messages"]` to see where it went.
- `KeyError: 'thread_id'` → a test invoked the graph without the `configurable.thread_id` config.

## Step 8 · Break it on purpose: three recoveries
**Goal:** evidence, from your own traces, of three failure cases the agent recovers from.

Produce the three failure cases deliberately so the README cites real logs, not claims.

1. **Bad tool input.** Ask: `python run.py "Read the note called pricing.md and summarise it."` There is no such note.
   You should see `Error from read_note: FileNotFoundError ... Available: ...`, then a `read_note` call with a real
   name on the next step.
2. **Provider outage.** Set `BASE_URL=http://localhost:9/v1` in `.env` and run any task. You should see four
   `[retry] APIConnectionError` lines with growing waits, then a clean error. Restore `.env` and resume with
   `--thread`: it continues from the last checkpoint.
3. **Runaway run.** Set `MAX_STEPS=3` and run the hosting task. It ends with `[done] stop_reason=max_steps` and a
   partial answer instead of spinning.

Then summarise any run from its trace:

```python title="trace_summary.py"
"""Summarise one run from traces/trace.jsonl: time per node, tool success, pauses, errors."""
import json
import sys
from collections import Counter
from pathlib import Path

rows = [json.loads(line) for line in Path("traces/trace.jsonl").read_text(encoding="utf-8").splitlines()]
run_id = sys.argv[1] if len(sys.argv) > 1 else rows[-1]["run_id"]   # default: the latest run
rows = [r for r in rows if r["run_id"] == run_id]

ms, calls = Counter(), Counter()
for r in rows:
    if r["event"] == "node":
        ms[r["node"]] += r["ms"]
        calls[r["node"]] += 1
tools = [r for r in rows if r["event"] == "tool"]

print(f"run {run_id}: {len(rows)} events")
for node in ms:
    print(f"  {node:<9} x{calls[node]:<3} {ms[node]:>7} ms")
print(f"  tools ok: {sum(r['ok'] for r in tools)}/{len(tools)}")
print(f"  pauses for approval: {sum(r['event'] == 'paused' for r in rows)}")
print(f"  errors: {sum(r['event'] == 'node_error' for r in rows)}")
```

**How this code works**
- Reads the JSONL written by `trace.py`, filters to one `run_id` (the latest by default) and totals time per node.
- `tools ok: 9/10` is your tool error rate; `pauses for approval` counts how often a human was asked.

**Run it**
```bash
python trace_summary.py
```

**You should see**
```text
run run-3f9a1c: 27 events
  planner   x1       812 ms
  agent     x10    13050 ms
  tools     x8        21 ms
  approval  x1         4 ms
  finish    x1         0 ms
  tools ok: 9/10
  pauses for approval: 1
  errors: 0
```

**If it breaks**
- `FileNotFoundError: traces/trace.jsonl` → no run has completed a node yet in this folder.
- Agent time dwarfs everything else → normal; the model is the slow part.

## Step 9 · Explain the loop
**Goal:** a `NOTES.md` that maps each LangGraph feature back to the plain agent loop it replaces.

Write this in your own words; the table is the skeleton.

```markdown title="NOTES.md"
# What LangGraph does here, in plain-loop terms

| LangGraph feature | Plain loop equivalent | Where in this repo |
|---|---|---|
| `StateGraph(AgentState)` + reducers | a dict you mutate inside `while True` | agent/state.py |
| node `agent` | `resp = call_model(messages, tools)` | graph.py `agent` |
| conditional edge `route_after_agent` | `if not resp.tool_calls: break` | graph.py |
| node `tools` + edge back to `agent` | `for call in resp.tool_calls: messages.append(run_tool(call))` | graph.py `execute_calls` |
| checkpointer + `thread_id` | `json.dump(state)` after every iteration, reload on start | run.py |
| `interrupt()` / `Command(resume=)` | `input("approve?")`, but it survives a restart | graph.py `approval` |
| `recursion_limit` | `for step in range(N)` | run.py |
| `stream_mode="updates"` | `print()` inside the loop | run.py `show` |

What the framework did NOT do for me: budgets, loop detection, retries, tool safety, the approval list.
Those are mine, in plain Python, and would be identical in a hand-written loop.
```

**Run it**
```bash
pytest -q && python trace_summary.py
```

**You should see** the tests pass and a summary of your last run. If you can explain each row of the table to someone
without looking at the code, this step is done.

**If it breaks**
- You cannot fill a row → open `app.get_state_history(config)` for a finished thread and look at each checkpoint's
  `next` field; it shows exactly which node ran after which.

## Ship it
- **Repo:** push everything except `.env`, `checkpoints.db`, `traces/` and `reports/` (add them to `.gitignore`).
- **README:** pitch, the mermaid diagram, a table of tools (which needs approval and why), the budgets, the three
  recoveries from Step 8 with log excerpts, `trace_summary.py` numbers for a typical run, and how to run with Ollama.
- **Demo:** a 60-90 second terminal recording: plan, tool calls, a rejection with a reason, the revised report,
  approval, and a Ctrl+C plus resume.
- **Portfolio line:** "LangGraph research agent with hard budgets, loop detection, human approval and crash-resume;
  N steps / M tokens / S seconds per task, recovers from bad tool input, provider outages and runaway loops."

## Going further
- Move the four tools into an MCP server (lesson 5.4) and have the agent load them through an MCP client; keep
  `NEEDS_APPROVAL` on the client side.
- Run ten tasks through the agent and through a fixed workflow (search, read all, compute, write) and compare success,
  tokens and latency.
- Replace `SqliteSaver` with the Postgres checkpointer and run two workers against the same database.
- Add a `verify` node that checks every number in the report appears in a calculator result before allowing `save_report`.
