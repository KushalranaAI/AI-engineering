---
project: streaming-tool-assistant
title: Streaming assistant with real tools
hours: 8
stack: Python 3.11+, LangChain (langchain-openai), openai SDK, httpx, pydantic v2, pytest
cost: About $0.10 of API calls with a small hosted model (free with Ollama)
---

You will build a terminal chat assistant that streams its replies token by token, keeps an explicit conversation history, and calls three real tools: a weather forecast (Open-Meteo), currency conversion (Frankfurter) and your own expense API from Level 0. It runs several tool calls in one turn, in parallel when they are independent, hands tool errors back to the model instead of crashing, produces a structured summary card your code can consume, retries transient failures, and writes a per-turn trace of tokens, latency, retries, tool calls and cost. LangChain drives the main loop; a second script shows the exact raw API messages for one full tool round trip, so the framework never hides the mechanics from you.

## Before you start

- **Python 3.11+** and an **OpenAI-compatible endpoint**: an OpenAI key, another provider with an OpenAI-compatible API, or a local **Ollama** with a tool-capable model (`ollama pull qwen2.5:7b`; then `BASE_URL=http://localhost:11434/v1`).
- Your **Level 0 expense API** running on port 8000 (`plain-rest-service`). If you skipped it, Step 3 gives you a 30-line stand-in.
- No keys are needed for weather or exchange rates.

Final folder structure:

```text
streaming-assistant/
├── assistant/
│   ├── __init__.py
│   ├── __main__.py        terminal UI: python -m assistant
│   ├── config.py          MODEL, BASE_URL, prices from env
│   ├── llm.py             chat model + streaming with retries
│   ├── tools.py           3 tools, argument schemas, run_tool
│   ├── tracking.py        TurnStats, cost, JSONL traces
│   ├── chat.py            Assistant: history + tool loop
│   └── card.py            structured summary card
├── scripts/
│   ├── __init__.py
│   └── fake_expense_api.py
├── tests/
│   ├── __init__.py
│   └── test_assistant.py
├── traces/turns.jsonl     written at runtime
├── hello.py
├── raw_roundtrip.py
├── run_demo.py
├── trace_summary.py
├── requirements.txt
├── .env.example
└── README.md
```

## How it fits together

```text
 you> question
    │
    ▼
 Assistant.ask ── history: [system, user, ai, tool, tool, ai, user ...]
    │
    ▼
 stream_reply ──► ChatOpenAI.bind_tools(...).stream(history) ──► model API
    │   tokens ──► printed live            (retry if it fails before 1st token)
    │
    ├─ reply has tool_calls? ──► ThreadPoolExecutor ──► run_tool (validate → call → text)
    │                                  ├─ get_weather      → Open-Meteo
    │                                  ├─ convert_currency → Frankfurter
    │                                  └─ expense_summary  → your Level 0 API
    │      ToolMessages appended, loop again (max 5 rounds)
    │
    └─ no tool_calls ──► final answer; TurnStats → traces/turns.jsonl
```

Your question is appended to an explicit history list that your code owns. `stream_reply` sends the whole history to the model and prints text as it arrives. If the reply asks for tools, every call is validated against a Pydantic schema and run (in parallel when there are several), and each result, success or error, goes back as a `ToolMessage` tied to its call id. The loop repeats until the model answers in plain text, and the turn's numbers land in a JSONL trace.

## Step 1 · Set up the project and stream a first reply

**Goal:** a project that reads its model settings from `.env` and prints a streamed reply.

```bash title="terminal"
mkdir streaming-assistant && cd streaming-assistant
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir assistant scripts tests traces
touch assistant/__init__.py scripts/__init__.py tests/__init__.py   # Windows: type nul > assistant\__init__.py (etc.)
```

```text title="requirements.txt"
langchain-core>=0.3
langchain-openai>=0.3
openai>=1.50
httpx>=0.27
pydantic>=2.7
python-dotenv>=1.0
fastapi>=0.115
uvicorn>=0.30
pytest>=8.0
```

```text title=".env.example"
# Any OpenAI-compatible endpoint. Leave BASE_URL empty for OpenAI itself.
MODEL=gpt-4o-mini
BASE_URL=
API_KEY=sk-...
# Example prices in USD per million tokens; look up your model's current prices.
PRICE_IN_PER_M=0.15
PRICE_OUT_PER_M=0.60
REQUEST_TIMEOUT_S=30
MAX_RETRIES=3
EXPENSE_API_URL=http://127.0.0.1:8000
```

```python title="assistant/config.py"
import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    model: str = os.getenv("MODEL", "gpt-4o-mini")
    base_url: str | None = os.getenv("BASE_URL") or None  # None = the provider's default
    api_key: str = os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY") or "not-needed"
    # Example prices in USD per million tokens; look up current numbers for your model.
    price_in_per_m: float = float(os.getenv("PRICE_IN_PER_M", "0.15"))
    price_out_per_m: float = float(os.getenv("PRICE_OUT_PER_M", "0.60"))
    request_timeout_s: float = float(os.getenv("REQUEST_TIMEOUT_S", "30"))
    max_retries: int = int(os.getenv("MAX_RETRIES", "3"))
    expense_api_url: str = os.getenv("EXPENSE_API_URL", "http://127.0.0.1:8000")


settings = Settings()
```

```python title="assistant/llm.py"
from langchain_openai import ChatOpenAI

from assistant.config import settings


def make_chat_model(temperature: float = 0.3) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model,
        base_url=settings.base_url,
        api_key=settings.api_key,
        temperature=temperature,
        timeout=settings.request_timeout_s,
        max_retries=0,       # we retry ourselves (Step 6), so we can count and log every retry
        stream_usage=True,   # ask for token counts in the last stream chunk
    )
```

```python title="hello.py"
from assistant.llm import make_chat_model

llm = make_chat_model()
for chunk in llm.stream("In two sentences: why do chat apps stream their replies?"):
    print(chunk.content, end="", flush=True)
print()
```

**How this code works**
- `load_dotenv()` then `os.getenv(...)` → config lives in `.env` (never committed) and every value has a default, so swapping OpenAI for Ollama is a two-line edit, not a code change.
- `base_url=None` → the OpenAI SDK uses its default endpoint. Any provider that speaks the OpenAI Chat Completions format works by setting `BASE_URL`.
- `max_retries=0` → the SDK would otherwise retry silently. We want to see and count retries, so we own that logic.
- `timeout` → an upper bound for a single request. Without it, a stalled connection hangs your terminal.
- `stream_usage=True` → asks the server to append a usage chunk at the end of the stream; that is where token counts come from when streaming.
- `flush=True` → without it Python buffers the output and the "streaming" appears all at once.

**Run it**
```bash
cp .env.example .env      # then fill in API_KEY (and BASE_URL/MODEL if not OpenAI)
pip install -r requirements.txt
python hello.py
```

**You should see**

Words appear a few at a time, not in one block:

```text
Streaming lets users see the first words within a fraction of a second instead of waiting for the whole answer, which makes the app feel much faster. It also lets them stop or redirect a reply early if it is heading the wrong way.
```

**If it breaks**
- `openai.AuthenticationError: 401` → wrong or missing `API_KEY` → check `.env` has no quotes or trailing spaces.
- `openai.NotFoundError: model ... does not exist` → `MODEL` is not a valid id for your provider → copy the id from their model list.
- `APIConnectionError` with Ollama → Ollama not running, or `BASE_URL` missing `/v1` → `ollama serve` and use `http://localhost:11434/v1`.

## Step 2 · A chat loop with a system prompt and explicit history

**Goal:** a terminal chat that remembers earlier turns because your code resends them.

The API remembers nothing between calls. "Memory" is a list of messages you keep and send every time. Making that list an explicit attribute (`self.history`) means you can inspect it, trim it, save it, and test it.

```python title="assistant/chat.py"
from collections.abc import Callable
from datetime import date

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from assistant.llm import make_chat_model

SYSTEM_PROMPT = """You are a practical assistant for travel and money questions.
Keep answers short: a few sentences or a compact list. Today's date is {today}."""


class Assistant:
    def __init__(self, llm=None) -> None:
        self.llm = llm if llm is not None else make_chat_model()
        self.history: list[BaseMessage] = [SystemMessage(SYSTEM_PROMPT.format(today=date.today().isoformat()))]

    def ask(self, user_text: str, on_token: Callable[[str], None] = lambda t: None) -> str:
        self.history.append(HumanMessage(user_text))
        parts: list[str] = []
        for chunk in self.llm.stream(self.history):
            if isinstance(chunk.content, str) and chunk.content:
                parts.append(chunk.content)
                on_token(chunk.content)
        reply = AIMessage("".join(parts))
        self.history.append(reply)
        return reply.content
```

```python title="assistant/__main__.py"
from assistant.chat import Assistant
from assistant.config import settings


def main() -> None:
    bot = Assistant()
    print(f"Assistant ready · model={settings.model} · /quit to exit")
    while True:
        try:
            text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text == "/quit":
            break
        if not text:
            continue
        print("bot> ", end="", flush=True)
        bot.ask(text, on_token=lambda t: print(t, end="", flush=True))
        print()


if __name__ == "__main__":
    main()
```

**How this code works**
- `SystemMessage(...)` as `history[0]` → the stable rules for every turn. The date is injected because models do not know today's date, and "this weekend" questions need it.
- `HumanMessage` / `AIMessage` → LangChain's message types; they map one-to-one onto the API's `user` / `assistant` roles.
- `parts.append(...)` then `AIMessage("".join(parts))` → you print each chunk as it arrives **and** keep the complete text, because the next turn must send the full reply back.
- `on_token` callback → `Assistant` does not know about terminals. The UI decides what to do with tokens, so the same class works in a web app or a test.
- `assistant/__main__.py` → lets you run the package with `python -m assistant`.

**Run it**
```bash
python -m assistant
```

**You should see**
```text
Assistant ready · model=gpt-4o-mini · /quit to exit

you> My name is Ana and I'm flying to Lisbon on Friday.
bot> Nice, Ana! Lisbon in autumn is lovely. Want help with weather, money or packing?

you> What's my name and where am I going?
bot> You're Ana, and you're heading to Lisbon on Friday.
```

**If it breaks**
- The second answer does not remember the first → you are creating a new `Assistant` per question, or not appending the reply → check both `append` calls.
- Output appears all at once → a terminal or IDE console that buffers; run in a normal terminal.

## Step 3 · Three real tools with validated arguments

**Goal:** three working tools, each with a Pydantic argument schema, wrapped by `run_tool`, which never raises and always returns text for the model.

Tool arguments are written by a model, so treat them as untrusted input: validate types and ranges before running anything. Every failure (bad arguments, unknown tool, a service that is down) becomes a short message the model can act on. The HTTP helper sets timeouts and retries rate limits, timeouts and 5xx responses with backoff.

```python title="assistant/tools.py"
import json
import logging
import random
import time
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, ValidationError, field_validator

from assistant.config import settings

log = logging.getLogger(__name__)


class ToolError(Exception):
    """A failure the model should hear about, in words it can act on."""


HTTP = httpx.Client(
    timeout=httpx.Timeout(8.0, connect=4.0),
    headers={"User-Agent": "streaming-assistant/0.1"},
    follow_redirects=True,
)


def get_json(url: str, params: dict | None = None, retries: int = 2) -> Any:
    """GET with a timeout and retries for transient failures (network, 429, 5xx)."""
    host = httpx.URL(url).host
    for attempt in range(retries + 1):
        try:
            resp = HTTP.get(url, params=params)
        except httpx.ConnectError as exc:  # refused or DNS failure: retrying rarely helps
            raise ToolError(f"could not connect to {host}; the service may be down") from exc
        except httpx.TransportError as exc:  # timeouts, dropped connections
            if attempt == retries:
                raise ToolError(f"could not reach {host} ({type(exc).__name__})") from exc
        else:
            if resp.status_code < 400:
                return resp.json()
            if resp.status_code != 429 and resp.status_code < 500:
                raise ToolError(f"{host} rejected the request ({resp.status_code}): {resp.text[:200]}")
            if attempt == retries:
                raise ToolError(f"{host} is failing ({resp.status_code}); try again later")
        time.sleep(0.4 * 2**attempt + random.uniform(0, 0.2))
    raise AssertionError("unreachable")


# ---------- tool 1: weather (Open-Meteo, no key) ----------

class WeatherArgs(BaseModel):
    city: str = Field(min_length=2, max_length=80, description="City name only, e.g. 'Lisbon' or 'Osaka'")
    days: int = Field(default=3, ge=1, le=7, description="Number of forecast days, 1-7")


def get_weather(city: str, days: int = 3) -> dict:
    geo = get_json("https://geocoding-api.open-meteo.com/v1/search",
                   {"name": city, "count": 1, "language": "en", "format": "json"})
    if not geo.get("results") and "," in city:  # "Paris, France" -> retry with "Paris"
        geo = get_json("https://geocoding-api.open-meteo.com/v1/search",
                       {"name": city.split(",")[0].strip(), "count": 1, "language": "en", "format": "json"})
    if not geo.get("results"):
        raise ToolError(f"no place called '{city}' was found; ask the user to check the spelling")
    place = geo["results"][0]
    forecast = get_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": place["latitude"],
        "longitude": place["longitude"],
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "timezone": "auto",
        "forecast_days": days,
    })
    daily = forecast["daily"]
    return {
        "place": f"{place['name']}, {place.get('country', '?')}",
        "days": [
            {
                "date": daily["time"][i],
                "max_c": daily["temperature_2m_max"][i],
                "min_c": daily["temperature_2m_min"][i],
                "rain_chance_pct": daily["precipitation_probability_max"][i],
            }
            for i in range(len(daily["time"]))
        ],
    }


# ---------- tool 2: currency conversion (Frankfurter, no key) ----------

class ConvertArgs(BaseModel):
    amount: float = Field(gt=0, le=1_000_000_000, description="Amount to convert")
    from_currency: str = Field(pattern=r"^[A-Za-z]{3}$", description="ISO code, e.g. USD")
    to_currency: str = Field(pattern=r"^[A-Za-z]{3}$", description="ISO code, e.g. EUR")

    @field_validator("from_currency", "to_currency")
    @classmethod
    def upper(cls, value: str) -> str:
        return value.upper()


def convert_currency(amount: float, from_currency: str, to_currency: str) -> dict:
    if from_currency == to_currency:
        return {"amount": amount, "from": from_currency, "to": to_currency, "rate": 1.0, "converted": amount}
    data = get_json("https://api.frankfurter.dev/v1/latest",  # check the current docs
                    {"base": from_currency, "symbols": to_currency})
    rate = data["rates"][to_currency]
    return {"amount": amount, "from": from_currency, "to": to_currency, "rate": rate,
            "converted": round(amount * rate, 2), "rate_date": data["date"]}


# ---------- tool 3: your Level 0 expense API ----------

class ExpenseSummaryArgs(BaseModel):
    since: date | None = Field(default=None, description="Only count expenses on or after this date (YYYY-MM-DD)")


def expense_summary(since: date | None = None) -> dict:
    params = {"since": since.isoformat()} if since else None
    rows = get_json(f"{settings.expense_api_url}/summary", params)
    return {"rows": rows, "note": "Totals are per currency. Never add different currencies together."}


# ---------- registry ----------

TOOLS: dict[str, tuple[type[BaseModel], Any, str]] = {
    "get_weather": (WeatherArgs, get_weather,
                    "Daily forecast for a city: max/min temperature in °C and rain chance, up to 7 days ahead."),
    "convert_currency": (ConvertArgs, convert_currency,
                         "Convert an amount between currencies at today's reference rate."),
    "expense_summary": (ExpenseSummaryArgs, expense_summary,
                        "The user's own spending: count and total per category and currency, optionally since a date."),
}

LC_TOOLS = [
    StructuredTool.from_function(func=fn, name=name, description=desc, args_schema=args)
    for name, (args, fn, desc) in TOOLS.items()
]


@dataclass
class ToolResult:
    content: str
    ok: bool
    ms: float


def run_tool(name: str, raw_args: dict) -> ToolResult:
    """Validate arguments, run the tool, and always return text for the model. Never raises."""
    start = time.perf_counter()

    def done(content: str, ok: bool) -> ToolResult:
        return ToolResult(content, ok, round((time.perf_counter() - start) * 1000, 1))

    if name not in TOOLS:
        return done(f"Error: unknown tool '{name}'. Available tools: {', '.join(TOOLS)}.", False)
    args_model, fn, _ = TOOLS[name]
    try:
        args = args_model.model_validate(raw_args)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(map(str, e['loc'])) or 'args'}: {e['msg']}" for e in exc.errors())
        return done(f"Error: invalid arguments for {name}: {problems}. Fix them and call again.", False)
    try:
        result = fn(**args.model_dump())
    except ToolError as exc:
        return done(f"Error from {name}: {exc}", False)
    except Exception as exc:  # a bug in our tool: log it, tell the model something short
        log.exception("tool %s crashed", name)
        return done(f"Error: {name} failed unexpectedly ({type(exc).__name__}).", False)
    return done(json.dumps(result, ensure_ascii=False), True)
```

If you do not have the Level 0 API, this stand-in serves the same `/summary` shape from three months of generated expenses:

```python title="scripts/fake_expense_api.py"
"""Stand-in for the Level 0 expense API: serves GET /summary from generated data.

Run: uvicorn scripts.fake_expense_api:app --port 8000
"""
import random
from datetime import date, timedelta

from fastapi import FastAPI

app = FastAPI(title="Fake expense API")

rng = random.Random(7)
CATEGORIES = {"Groceries": (20, 110), "Transport": (3, 60), "Eating out": (4, 80), "Software": (5, 25)}
EXPENSES = [
    {"category": cat, "currency": rng.choice(["EUR", "EUR", "EUR", "USD", "GBP"]),
     "amount": round(rng.uniform(*CATEGORIES[cat]), 2),
     "spent_on": date(2026, 1, 1) + timedelta(days=rng.randrange(90))}
    for cat in rng.choices(list(CATEGORIES), k=80)
] + [{"category": "Rent", "currency": "EUR", "amount": 950.0, "spent_on": date(2026, m, 1)} for m in (1, 2, 3)]


@app.get("/summary")
def summary(since: date | None = None) -> list[dict]:
    totals: dict[tuple[str, str], list[float]] = {}
    for e in EXPENSES:
        if since and e["spent_on"] < since:
            continue
        totals.setdefault((e["category"], e["currency"]), []).append(e["amount"])
    return [{"category": c, "currency": cur, "count": len(v), "total": f"{sum(v):.2f}"}
            for (c, cur), v in sorted(totals.items())]
```

**How this code works**
- `WeatherArgs`, `ConvertArgs`, `ExpenseSummaryArgs` → one Pydantic model per tool. They do double duty: LangChain turns them into the JSON schema the model sees, and `run_tool` uses them to validate what the model sent.
- `description=` on every field → descriptions are part of the prompt. "City name only" stops the model sending "Lisbon, Portugal, Europe".
- `ge=1, le=7` on `days` → Open-Meteo forecasts 16 days, but we promise 7. Limits like this keep tool behaviour predictable and cheap.
- `field_validator(...).upper` → accept `usd` but normalise it. Be lenient where it is harmless, strict where it is not.
- `get_json` → timeouts on every call (4 s to connect, 8 s total), retries with exponential backoff and jitter for timeouts, 429 and 5xx, and no retry for refused connections or 4xx (retrying a bad request just repeats it).
- `ToolError` → our own exception type for "expected failure, explain it to the model". Anything else is a bug: logged with a stack trace, and the model gets a short, safe message.
- `run_tool` never raises → the tool loop in Step 4 can rely on getting a `ToolResult` every time, so one broken tool cannot crash a turn.
- `expense_summary`'s `note` → a hint in the tool result itself, so the model does not add EUR and USD totals.
- `StructuredTool.from_function(..., args_schema=args)` → LangChain wrappers used only to advertise the tools; execution goes through our `run_tool`, so validation is explicit and visible.

**Run it**
```bash
uvicorn scripts.fake_expense_api:app --port 8000      # skip if your Level 0 API is running; use a 2nd terminal
python -c "from assistant.tools import run_tool; print(run_tool('get_weather', {'city': 'Lisbon', 'days': 2}))"
python -c "from assistant.tools import run_tool; print(run_tool('convert_currency', {'amount': 120, 'from_currency': 'usd', 'to_currency': 'EUR'}))"
python -c "from assistant.tools import run_tool; print(run_tool('get_weather', {'city': '', 'days': 30}))"
```

**You should see**
```text
ToolResult(content='{"place": "Lisbon, Portugal", "days": [{"date": "2026-11-06", "max_c": 16.3, "min_c": 12.3, "rain_chance_pct": 30}, ...]}', ok=True, ms=812.4)
ToolResult(content='{"amount": 120.0, "from": "USD", "to": "EUR", "rate": 0.89566, "converted": 107.48, "rate_date": "2026-11-06"}', ok=True, ms=402.9)
ToolResult(content='Error: invalid arguments for get_weather: city: String should have at least 2 characters; days: Input should be less than or equal to 7. Fix them and call again.', ok=False, ms=0.3)
```

**If it breaks**
- `could not connect to 127.0.0.1` for `expense_summary` → nothing is listening on port 8000 → start one of the two expense APIs.
- `geocoding-api.open-meteo.com rejected the request (400)` → you passed an empty or odd city; that is the validation path working, or the API changed → open the URL in a browser to compare.
- All calls time out → a corporate proxy → set `HTTPS_PROXY`; httpx respects it.

## Step 4 · The tool loop: sequential and parallel calls, with per-turn tracking

**Goal:** the assistant answers questions that need several tools in one turn, runs independent calls in parallel, feeds errors back to the model, and records each turn in `traces/turns.jsonl`.

The loop: send history → if the reply contains tool calls, run them and append one `ToolMessage` per call id → send again → stop when the model answers in text. Each turn can now involve several model calls, so we start measuring turns, not calls.

```python title="assistant/tracking.py"
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from assistant.config import settings

TRACE_FILE = Path("traces/turns.jsonl")


@dataclass
class TurnStats:
    conversation: str
    turn: int
    user: str
    model: str = settings.model
    model_calls: int = 0
    retries: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    first_token_ms: float | None = None
    latency_ms: float = 0.0
    tool_calls: list[dict] = field(default_factory=list)
    cost_usd: float = 0.0
    error: str | None = None
    started_at: float = field(default_factory=time.perf_counter)

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self.started_at) * 1000, 1)

    def add_usage(self, usage: dict | None) -> None:
        if usage:  # some local servers do not report usage when streaming
            self.input_tokens += usage.get("input_tokens", 0)
            self.output_tokens += usage.get("output_tokens", 0)


def estimate_cost(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * settings.price_in_per_m + output_tokens * settings.price_out_per_m) / 1_000_000


def record_turn(stats: TurnStats, path: Path = TRACE_FILE) -> None:
    stats.latency_ms = stats.elapsed_ms()
    stats.cost_usd = round(estimate_cost(stats.input_tokens, stats.output_tokens), 6)
    row = asdict(stats)
    row.pop("started_at")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
```

Replace `assistant/llm.py` with this version, which adds `stream_reply`:

```python title="assistant/llm.py"
from collections.abc import Callable

from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_openai import ChatOpenAI

from assistant.config import settings
from assistant.tracking import TurnStats


def make_chat_model(temperature: float = 0.3) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model,
        base_url=settings.base_url,
        api_key=settings.api_key,
        temperature=temperature,
        timeout=settings.request_timeout_s,
        max_retries=0,
        stream_usage=True,
    )


def stream_reply(llm, messages: list[BaseMessage], on_token: Callable[[str], None],
                 stats: TurnStats | None = None) -> AIMessage:
    """Stream one model reply; text goes to on_token, tool calls are assembled from chunks."""
    full: AIMessageChunk | None = None
    if stats:
        stats.model_calls += 1
    for chunk in llm.stream(messages):
        if isinstance(chunk.content, str) and chunk.content:
            if stats and stats.first_token_ms is None:
                stats.first_token_ms = stats.elapsed_ms()
            on_token(chunk.content)
        full = chunk if full is None else full + chunk
    if full is None:
        return AIMessage(content="")
    if stats:
        stats.add_usage(full.usage_metadata)
    return AIMessage(content=full.content, tool_calls=full.tool_calls,
                     invalid_tool_calls=full.invalid_tool_calls)
```

Replace `assistant/chat.py` with the full tool-loop version:

```python title="assistant/chat.py"
import json
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from assistant.llm import make_chat_model, stream_reply
from assistant.tools import LC_TOOLS, run_tool
from assistant.tracking import TRACE_FILE, TurnStats, record_turn

SYSTEM_PROMPT = """You are a practical assistant for travel and money questions.
Use the tools for weather, exchange rates and the user's own expenses; never invent numbers a tool can give you.
When several lookups are independent, request them together in one turn.
If a tool returns an error, say what failed in one short sentence and continue with what you have.
Keep answers short: a few sentences or a compact list. Today's date is {today}."""

MAX_TOOL_ROUNDS = 5


def _noop(_: str) -> None:
    pass


class Assistant:
    def __init__(self, llm=None, trace_path: Path = TRACE_FILE) -> None:
        self.llm = llm if llm is not None else make_chat_model().bind_tools(LC_TOOLS)
        self.trace_path = trace_path
        self.conversation_id = uuid.uuid4().hex[:8]
        self.turn_no = 0
        self.history: list[BaseMessage] = [SystemMessage(SYSTEM_PROMPT.format(today=date.today().isoformat()))]

    def ask(self, user_text: str, on_token: Callable[[str], None] = _noop,
            on_tool: Callable[[str], None] = _noop) -> str:
        self.turn_no += 1
        stats = TurnStats(conversation=self.conversation_id, turn=self.turn_no, user=user_text)
        checkpoint = len(self.history)
        self.history.append(HumanMessage(user_text))
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                reply = stream_reply(self.llm, self.history, on_token, stats)
                self.history.append(reply)
                if not reply.tool_calls and not reply.invalid_tool_calls:
                    break
                self.history.extend(self._run_tools(reply, stats, on_tool))
            else:
                stop = AIMessage("I stopped after too many tool calls. Could you narrow the question?")
                on_token(stop.content)
                self.history.append(stop)
        except Exception as exc:
            del self.history[checkpoint:]  # leave history valid for the next turn
            stats.error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            record_turn(stats, self.trace_path)
        return self.history[-1].content

    def _run_tools(self, reply: AIMessage, stats: TurnStats, on_tool: Callable[[str], None]) -> list[ToolMessage]:
        calls = reply.tool_calls
        # Independent calls from one reply run in parallel; results keep the original order.
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda c: run_tool(c["name"], c["args"]), calls))

        messages: list[ToolMessage] = []
        for call, result in zip(calls, results):
            on_tool(f"{call['name']}({json.dumps(call['args'], default=str)}) -> "
                    f"{'ok' if result.ok else 'ERROR'} {result.ms:.0f}ms")
            stats.tool_calls.append({"name": call["name"], "args": call["args"], "ok": result.ok,
                                     "ms": result.ms, "result": result.content[:300]})
            messages.append(ToolMessage(content=result.content, tool_call_id=call["id"]))

        for bad in reply.invalid_tool_calls:  # arguments that were not even valid JSON
            on_tool(f"{bad.get('name')}: unparseable arguments")
            stats.tool_calls.append({"name": bad.get("name"), "args": bad.get("args"), "ok": False, "ms": 0})
            messages.append(ToolMessage(
                content=f"Error: arguments for {bad.get('name')} were not valid JSON. Send them again as a JSON object.",
                tool_call_id=bad["id"] or "missing-id",
            ))
        return messages
```

In `assistant/__main__.py`, replace the `bot.ask(...)` line so tool activity is visible:

```python title="assistant/__main__.py (replace the bot.ask line)"
        bot.ask(text,
                on_token=lambda t: print(t, end="", flush=True),
                on_tool=lambda line: print(f"\n  [tool] {line}", flush=True))
```

**How this code works**
- `make_chat_model().bind_tools(LC_TOOLS)` → attaches the three tool schemas to every request. The model now can answer in text or return `tool_calls`.
- `full = chunk if full is None else full + chunk` → when streaming, a tool call arrives in fragments (name in one chunk, `{"city": "Lis` in the next, `bon"}` after). Adding `AIMessageChunk`s merges fragments by index; `full.tool_calls` is the parsed result.
- `for _ in range(MAX_TOOL_ROUNDS)` → sequential calls happen naturally: the model can call `expense_summary`, see a USD total, then call `convert_currency` in the next round. The cap stops a confused model from looping forever (and billing you for it). The `for ... else` runs only if the loop never hit `break`.
- `ThreadPoolExecutor` + `pool.map` → parallel calls from one reply run at the same time; a weather lookup (800 ms) and a conversion (400 ms) take ~800 ms instead of 1.2 s. `map` keeps results in call order.
- `ToolMessage(content=..., tool_call_id=call["id"])` → the API requires exactly one tool result per call id, errors included. A missing one makes the next request fail with a 400.
- `invalid_tool_calls` → arguments so broken they did not parse as JSON. They still get a reply, so the model can try again.
- `checkpoint` + `del self.history[checkpoint:]` → if a turn fails halfway (say, after an assistant message with tool calls but before the results), the history would be invalid for every later request. Rolling back keeps the conversation usable.
- `finally: record_turn(...)` → failed turns are logged too, with `error` set. Those are the ones you most need to see.
- `TurnStats.first_token_ms` → time to first visible token, the latency the user actually feels; `latency_ms` is the whole turn including tools.

**Run it**
```bash
python -m assistant
```

**You should see**
```text
you> Weather in Lisbon for the next 2 days, and what's 120 USD in EUR?
bot>
  [tool] get_weather({"city": "Lisbon", "days": 2}) -> ok 812ms
  [tool] convert_currency({"amount": 120, "from_currency": "USD", "to_currency": "EUR"}) -> ok 403ms
Lisbon: 16°C/12°C today with a 30% chance of rain, 22°C/15°C tomorrow (25%). 120 USD is about 107.48 EUR.

you> How much did I spend on eating out since March 1st, and what is the USD part in EUR?
bot>
  [tool] expense_summary({"since": "2026-03-01"}) -> ok 9ms
  [tool] convert_currency({"amount": 78.97, "from_currency": "USD", "to_currency": "EUR"}) -> ok 380ms
Since 1 March: 205.42 EUR (6 items), 31.49 GBP (1) and 78.97 USD (1). The USD part is about 70.73 EUR.
```

The first question shows parallel calls (both in one reply); the second shows sequential calls (the conversion needed the summary's result). Stop the expense API and ask again to see an error handed back: the model says the expense service is unavailable instead of crashing.

**If it breaks**
- The model never calls tools and invents numbers → your model lacks tool support or is too small → try another model; for Ollama use a tool-capable one such as `qwen2.5:7b` or `llama3.1:8b`.
- `400 ... tool_call_id ... did not have response messages` → a tool call got no `ToolMessage` → make sure `_run_tools` returns one message per call (do not filter failures out).
- Tool calls arrive but `args` is `{}` → the server streams tool arguments in a format LangChain cannot merge → set `streaming` aside and test with `llm.invoke`; upgrade your server (older Ollama versions did not stream tool calls).

## Step 5 · Structured output: a summary card your code consumes

**Goal:** a `/card` command that turns the conversation into a validated `SummaryCard` object.

Free text is for people; code needs a schema. A summary card (title, key facts, action items, open questions) is something a UI could render or a task list could import. We define it in Pydantic, ask for it through tool calling (the most widely supported method on OpenAI-compatible servers), validate, retry once with the error, and still check what validation cannot.

```python title="assistant/card.py"
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel, Field

from assistant.llm import make_chat_model


class ActionItem(BaseModel):
    task: str = Field(description="A concrete thing to do, starting with a verb")
    when: str | None = Field(default=None, description="Date or timeframe, only if one was mentioned")


class SummaryCard(BaseModel):
    """A compact card summarising the conversation so far."""

    title: str = Field(description="5-8 word title")
    key_facts: list[str] = Field(description="Up to 5 facts with numbers, taken from tool results")
    action_items: list[ActionItem] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list, description="Things still unknown or unresolved")


CARD_PROMPT = (
    "Summarise the conversation below as a card. Use only facts that appear in it; "
    "copy numbers exactly. If there are no action items, return an empty list."
)


def transcript(history: list[BaseMessage]) -> str:
    lines = []
    for m in history:
        if isinstance(m, HumanMessage):
            lines.append(f"USER: {m.content}")
        elif isinstance(m, ToolMessage):
            lines.append(f"TOOL RESULT: {m.content[:500]}")
        elif isinstance(m, AIMessage) and m.content:
            lines.append(f"ASSISTANT: {m.content}")
    return "\n".join(lines)


def make_card(history: list[BaseMessage]) -> SummaryCard | None:
    # function_calling has the widest support across OpenAI-compatible servers; check the current docs
    llm = make_chat_model(temperature=0).with_structured_output(
        SummaryCard, method="function_calling", include_raw=True)
    messages = [SystemMessage(CARD_PROMPT), HumanMessage(transcript(history))]
    for _attempt in range(2):
        out = llm.invoke(messages)
        if out["parsed"] is not None:
            card: SummaryCard = out["parsed"]
            card.key_facts = card.key_facts[:5]  # valid is not the same as within spec
            return card
        # Show the model its own validation error once, then give up.
        messages.append(HumanMessage(f"That did not match the schema: {out['parsing_error']}. Try again."))
    return None
```

Add the `/card` command to `assistant/__main__.py`. Add the import at the top and the branch right after the `/quit` check:

```python title="assistant/__main__.py (add to the imports)"
from assistant.card import make_card
```

```python title="assistant/__main__.py (add after the /quit check)"
        if text == "/card":
            card = make_card(bot.history)
            print(card.model_dump_json(indent=2) if card else "Could not build a valid card.")
            continue
```

**How this code works**
- `SummaryCard` docstring and `Field(description=...)` → become the schema the model sees. Write them like instructions.
- `transcript(history)` → a plain-text rendering of the conversation for a separate, temperature-0 call. Tool results are included because that is where the real numbers are.
- `method="function_calling"` → the schema is sent as a forced tool call. `json_schema` (strict mode) is stricter but not every server supports it.
- `include_raw=True` → returns `{"raw", "parsed", "parsing_error"}` instead of raising, so we decide what happens on failure: one retry with the error message, then `None`.
- `card.key_facts[:5]` → "up to 5" lives only in a description, so the model may send 7. Validation passing does not mean the output is right; enforce what matters in code.

**Run it**
```bash
python -m assistant
# ask the Lisbon question from Step 4, then:
/card
```

**You should see**
```text
{
  "title": "Lisbon weekend weather and currency check",
  "key_facts": [
    "Lisbon today: max 16.3°C, min 12.3°C, 30% rain chance",
    "Lisbon tomorrow: max 22.3°C, min 14.8°C, 25% rain chance",
    "120 USD = 107.48 EUR at rate 0.89566"
  ],
  "action_items": [{"task": "Pack a light rain jacket", "when": "before Friday"}],
  "open_questions": []
}
```

**If it breaks**
- `Could not build a valid card.` every time → the model ignores forced tool calls → try a bigger model, or `method="json_mode"` if your server supports JSON mode.
- `NotImplementedError` or `400 tool_choice` with a local server → it does not support `tool_choice` → upgrade it or use `method="json_mode"`.

## Step 6 · Reliability: timeouts, retries with backoff, honest failure

**Goal:** transient model failures are retried with exponential backoff and jitter, retries are counted in the trace, and a failure after text has been shown is surfaced instead of duplicated.

Tool calls already have timeouts and retries (`get_json` in Step 3). Now the model call. The subtle part is streaming: if the connection drops after 40 tokens were printed, a retry would print the answer again from the start. So we retry only failures that happen before the first token.

Replace `stream_reply` in `assistant/llm.py` (and update its imports) so the file reads:

```python title="assistant/llm.py"
import logging
import random
import time
from collections.abc import Callable

import openai
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_openai import ChatOpenAI

from assistant.config import settings
from assistant.tracking import TurnStats

log = logging.getLogger(__name__)


def make_chat_model(temperature: float = 0.3) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.model,
        base_url=settings.base_url,
        api_key=settings.api_key,
        temperature=temperature,
        timeout=settings.request_timeout_s,
        max_retries=0,       # we retry ourselves, so we can count and log every retry
        stream_usage=True,   # ask for token counts in the last stream chunk
    )


# Errors worth retrying: the request may succeed if we simply try again.
TRANSIENT = (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)


def stream_reply(
    llm,
    messages: list[BaseMessage],
    on_token: Callable[[str], None],
    stats: TurnStats | None = None,
) -> AIMessage:
    """Stream one model reply, retrying transient failures that happen before any output."""
    attempt = 0
    while True:
        full: AIMessageChunk | None = None
        printed = False
        if stats:
            stats.model_calls += 1
        try:
            for chunk in llm.stream(messages):
                if isinstance(chunk.content, str) and chunk.content:
                    if stats and stats.first_token_ms is None:
                        stats.first_token_ms = stats.elapsed_ms()
                    on_token(chunk.content)
                    printed = True
                full = chunk if full is None else full + chunk
            break
        except TRANSIENT as exc:
            # Once text reached the user, a retry would print it twice: give up instead.
            if printed or attempt >= settings.max_retries:
                raise
            attempt += 1
            if stats:
                stats.retries += 1
            delay = min(8.0, 0.5 * 2**attempt) * random.uniform(0.5, 1.0)
            log.warning("model call failed (%s); retry %d in %.1fs", type(exc).__name__, attempt, delay)
            time.sleep(delay)

    if full is None:
        return AIMessage(content="")
    if stats:
        stats.add_usage(full.usage_metadata)
    return AIMessage(
        content=full.content,
        tool_calls=full.tool_calls,
        invalid_tool_calls=full.invalid_tool_calls,
    )
```

Finally, catch errors per turn in `assistant/__main__.py` so one failure does not end the session. Wrap the `bot.ask(...)` call and add logging setup at the start of `main()`:

```python title="assistant/__main__.py (replace the bot.ask call)"
        try:
            bot.ask(text,
                    on_token=lambda t: print(t, end="", flush=True),
                    on_tool=lambda line: print(f"\n  [tool] {line}", flush=True))
        except Exception as exc:
            print(f"\n[error] {type(exc).__name__}: {exc}")
```

```python title="assistant/__main__.py (first lines of main)"
    import logging
    logging.basicConfig(level=logging.WARNING, format="  [%(levelname)s] %(message)s")
```

**How this code works**
- `TRANSIENT` → connection errors and timeouts (`APITimeoutError` is a subclass of `APIConnectionError`), 429 rate limits and 5xx. A 400 or 401 is not transient: retrying a bad request or a bad key just wastes time.
- `0.5 * 2**attempt` capped at 8 s, times `random.uniform(0.5, 1.0)` → exponential backoff with jitter. Jitter stops many clients that failed together from retrying in lockstep.
- `if printed ... raise` → the honest choice mid-stream: the user saw a partial answer, then an error, and can ask again. The rollback in `Assistant.ask` keeps history clean.
- `stats.retries` and `stats.model_calls` → each attempt counts as a model call, so the trace shows the true number of requests you were billed for.
- `try/except` in the UI → the session survives; the trace row for that turn has `error` set.

**Run it**

Point the assistant at a port where nothing listens to force connection errors:

```bash
BASE_URL=http://127.0.0.1:9 python -m assistant      # PowerShell: $env:BASE_URL="http://127.0.0.1:9"; python -m assistant
you> hello
```

Then check the last trace line and restore your real `BASE_URL`.

```bash
tail -n 1 traces/turns.jsonl       # PowerShell: Get-Content traces\turns.jsonl -Tail 1
```

**You should see**
```text
bot>   [WARNING] model call failed (APIConnectionError); retry 1 in 0.6s
  [WARNING] model call failed (APIConnectionError); retry 2 in 1.4s
  [WARNING] model call failed (APIConnectionError); retry 3 in 2.9s

[error] APIConnectionError: Connection error.
{"conversation": "1f0c9a2e", "turn": 1, "user": "hello", "model": "gpt-4o-mini", "model_calls": 4, "retries": 3, ..., "error": "APIConnectionError: Connection error."}
```

**If it breaks**
- No retries happen → the SDK raised something outside `TRANSIENT` (for example `AuthenticationError`) → correct; fix the config instead.
- Each retry waits 30 s → the connection hangs instead of refusing → that is `REQUEST_TIMEOUT_S` at work; lower it for testing.

## Step 7 · Tests that run without a model or the internet

**Goal:** a pytest suite that checks validation, parallel tool calls, errors returned to the model, retries and history rollback, using a scripted fake model.

The `Assistant` takes any object with a `.stream(messages)` method, so a fake that replays scripted chunks is enough. Tool functions are swapped with `monkeypatch`, so nothing touches the network.

```python title="tests/test_assistant.py"
import json

import httpx
import openai
from langchain_core.messages import AIMessageChunk, ToolMessage

from assistant import llm as llm_module
from assistant import tools
from assistant.chat import Assistant


class FakeModel:
    """Replays scripted replies as streams, like a chat model with tools bound."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def stream(self, messages):
        self.calls.append(list(messages))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        yield from reply


def text(*parts):
    return [AIMessageChunk(content=p) for p in parts]


def tool_calls(*calls):
    return [AIMessageChunk(content="", tool_call_chunks=[
        {"name": name, "args": json.dumps(args), "id": f"call_{i}", "index": i}])
        for i, (name, args) in enumerate(calls)]


def fake_tools(monkeypatch):
    monkeypatch.setitem(tools.TOOLS, "get_weather", (
        tools.WeatherArgs, lambda city, days: {"place": city, "days": [{"max_c": 21}]}, "weather"))
    monkeypatch.setitem(tools.TOOLS, "convert_currency", (
        tools.ConvertArgs, lambda amount, from_currency, to_currency: {"converted": amount * 0.9}, "fx"))


# ---------- tools on their own ----------

def test_invalid_args_become_a_message_not_an_exception():
    result = tools.run_tool("get_weather", {"city": "", "days": 30})
    assert not result.ok
    assert "invalid arguments" in result.content and "days" in result.content


def test_unknown_tool_lists_the_real_ones():
    result = tools.run_tool("get_stock_price", {})
    assert not result.ok and "get_weather" in result.content


def test_tool_error_is_reported(monkeypatch):
    def boom(city, days):
        raise tools.ToolError("service down")
    monkeypatch.setitem(tools.TOOLS, "get_weather", (tools.WeatherArgs, boom, "weather"))
    result = tools.run_tool("get_weather", {"city": "Lisbon"})
    assert result.content == "Error from get_weather: service down"


# ---------- the loop ----------

def test_parallel_tool_calls_then_answer(monkeypatch, tmp_path):
    fake_tools(monkeypatch)
    model = FakeModel([
        tool_calls(("get_weather", {"city": "Lisbon", "days": 2}),
                   ("convert_currency", {"amount": 100, "from_currency": "usd", "to_currency": "EUR"})),
        text("Mild in Lisbon, ", "and 100 USD is 90 EUR."),
    ])
    bot = Assistant(llm=model, trace_path=tmp_path / "t.jsonl")
    tokens = []
    answer = bot.ask("Weather in Lisbon and 100 USD in EUR?", on_token=tokens.append)

    assert answer == "Mild in Lisbon, and 100 USD is 90 EUR."
    assert "".join(tokens) == answer                      # it streamed
    second_call = model.calls[1]
    tool_msgs = [m for m in second_call if isinstance(m, ToolMessage)]
    assert [m.tool_call_id for m in tool_msgs] == ["call_0", "call_1"]   # one answer per call, in order
    row = json.loads((tmp_path / "t.jsonl").read_text().splitlines()[0])
    assert row["model_calls"] == 2 and len(row["tool_calls"]) == 2


def test_bad_arguments_go_back_to_the_model(monkeypatch, tmp_path):
    fake_tools(monkeypatch)
    model = FakeModel([
        tool_calls(("get_weather", {"city": "Lisbon", "days": 99})),
        text("Sorry, I can only forecast 7 days."),
    ])
    bot = Assistant(llm=model, trace_path=tmp_path / "t.jsonl")
    bot.ask("Weather in Lisbon for 99 days?")
    tool_msg = [m for m in model.calls[1] if isinstance(m, ToolMessage)][0]
    assert "invalid arguments" in tool_msg.content


def test_transient_error_before_first_token_is_retried(monkeypatch, tmp_path):
    monkeypatch.setattr(llm_module.time, "sleep", lambda s: None)
    error = openai.APIConnectionError(request=httpx.Request("POST", "http://test"))
    model = FakeModel([error, text("Hello!")])
    bot = Assistant(llm=model, trace_path=tmp_path / "t.jsonl")
    assert bot.ask("hi") == "Hello!"
    row = json.loads((tmp_path / "t.jsonl").read_text())
    assert row["retries"] == 1 and row["model_calls"] == 2


def test_failed_turn_leaves_history_clean(monkeypatch, tmp_path):
    monkeypatch.setattr(llm_module.time, "sleep", lambda s: None)
    error = openai.APIConnectionError(request=httpx.Request("POST", "http://test"))
    bot = Assistant(llm=FakeModel([error] * 10), trace_path=tmp_path / "t.jsonl")
    before = len(bot.history)
    try:
        bot.ask("hi")
    except openai.APIConnectionError:
        pass
    assert len(bot.history) == before
```

**How this code works**
- `FakeModel.stream` → yields the same `AIMessageChunk` objects a real model produces, so `stream_reply`'s chunk merging is tested for real. It also records every message list it received.
- `tool_call_chunks=[{... "index": i}]` → how providers stream tool calls; two indexes in one reply is a parallel call.
- `monkeypatch.setitem(tools.TOOLS, ...)` → replaces a tool for one test only; `run_tool` looks tools up at call time, so the fake is used.
- `model.calls[1]` → the second request the model received. Asserting on it proves the tool results really went back, with matching ids and in order.
- `monkeypatch.setattr(llm_module.time, "sleep", ...)` → retries without real waiting, so the suite stays fast.

**Run it**
```bash
pytest -q
```

**You should see**
```text
.......                                                                  [100%]
7 passed in 1.2s
```

**If it breaks**
- `ModuleNotFoundError: assistant` → run pytest from the project root with `tests/__init__.py` present.
- `test_parallel...` fails with no `ToolMessage` → `_run_tools` is not appending results, or `bind_tools` got called on the fake → the fake is passed as `llm=` and used as-is, check `__init__`.

## Step 8 · Under the framework: one raw tool round trip

**Goal:** a script that performs the same tool round trip with only the OpenAI SDK and prints every message sent and received, plus a `/raw` command that shows what LangChain sent for your last turn.

LangChain is a convenience, not magic. You should be able to explain the exact JSON: the tool definitions, the assistant message carrying `tool_calls`, and the `tool` messages answering each `tool_call_id`.

```python title="raw_roundtrip.py"
"""One full tool round trip with the raw OpenAI-compatible SDK: every message printed."""
import json

from langchain_core.utils.function_calling import convert_to_openai_tool
from openai import OpenAI

from assistant.config import settings
from assistant.tools import LC_TOOLS, run_tool

client = OpenAI(base_url=settings.base_url, api_key=settings.api_key, timeout=settings.request_timeout_s)
TOOLS = [convert_to_openai_tool(t) for t in LC_TOOLS]  # the exact JSON schemas LangChain sends


def show(title: str, obj) -> None:
    print(f"\n===== {title} =====")
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


messages = [
    {"role": "system", "content": "Use tools for facts. Request independent lookups together."},
    {"role": "user", "content": "Will it rain in Lisbon tomorrow, and what is 120 USD in EUR?"},
]
show("REQUEST 1 · one of the tool definitions", TOOLS[0])
show("REQUEST 1 · messages", messages)

first = client.chat.completions.create(model=settings.model, messages=messages, tools=TOOLS)
msg = first.choices[0].message
show("RESPONSE 1 · assistant message", msg.model_dump(exclude_none=True))

if not msg.tool_calls:
    raise SystemExit("The model answered without tools; try a model with tool support.")

# Echo the assistant turn back exactly, then answer every tool_call_id.
messages.append({
    "role": "assistant",
    "content": msg.content,
    "tool_calls": [{"id": c.id, "type": "function",
                    "function": {"name": c.function.name, "arguments": c.function.arguments}}
                   for c in msg.tool_calls],
})
for call in msg.tool_calls:
    try:
        args = json.loads(call.function.arguments)
    except json.JSONDecodeError:
        content = "Error: arguments were not valid JSON."
    else:
        content = run_tool(call.function.name, args).content
    messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
show("REQUEST 2 · what we append (assistant turn + tool results)", messages[2:])

second = client.chat.completions.create(model=settings.model, messages=messages, tools=TOOLS)
show("RESPONSE 2 · final answer", second.choices[0].message.model_dump(exclude_none=True))
show("USAGE", {"call_1": first.usage.model_dump() if first.usage else None,
               "call_2": second.usage.model_dump() if second.usage else None})
```

And the `/raw` command, which converts LangChain's messages back into wire format. This is the final `assistant/__main__.py`, with every addition from Steps 4-8 in place; replace the file with it:

```python title="assistant/__main__.py"
import json
import logging

from langchain_core.messages import convert_to_openai_messages

from assistant.card import make_card
from assistant.chat import Assistant
from assistant.config import settings

HELP = "Commands: /card (summary card)  /raw (last turn as API messages)  /quit"


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="  [%(levelname)s] %(message)s")
    bot = Assistant()
    print(f"Assistant ready · model={settings.model}\n{HELP}")
    last_turn_start = 1
    while True:
        try:
            text = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text == "/quit":
            break
        if text == "/card":
            card = make_card(bot.history)
            print(card.model_dump_json(indent=2) if card else "Could not build a valid card.")
            continue
        if text == "/raw":
            wire = convert_to_openai_messages(bot.history[last_turn_start:])
            print(json.dumps(wire, indent=2, ensure_ascii=False))
            continue

        last_turn_start = len(bot.history)
        print("bot> ", end="", flush=True)
        try:
            bot.ask(text,
                    on_token=lambda t: print(t, end="", flush=True),
                    on_tool=lambda line: print(f"\n  [tool] {line}", flush=True))
        except Exception as exc:
            print(f"\n[error] {type(exc).__name__}: {exc}")
        print()


if __name__ == "__main__":
    main()
```

**How this code works**
- `convert_to_openai_tool(t)` → the exact `{"type": "function", "function": {"name", "description", "parameters"}}` objects `bind_tools` sends. The `parameters` are your Pydantic schema, including `minimum`/`maximum`.
- Response 1 has `tool_calls` with `arguments` as a **JSON string**, not an object. Models can produce invalid JSON there, which is why we `json.loads` inside `try`.
- The assistant message is echoed back unchanged before the tool messages; the API checks that each `tool` message's `tool_call_id` matches a call in the preceding assistant message.
- `convert_to_openai_messages(...)` → LangChain's own translation, so `/raw` shows what the framework sent on your behalf.
- Count it: the raw version is about 50 lines for one round trip with no streaming, retries or history. That comparison is your stretch goal.

**Run it**
```bash
python raw_roundtrip.py
```

**You should see**
```text
===== RESPONSE 1 · assistant message =====
{
  "role": "assistant",
  "tool_calls": [
    {"id": "call_8Hq...", "function": {"arguments": "{\"city\":\"Lisbon\",\"days\":2}", "name": "get_weather"}, "type": "function"},
    {"id": "call_Zp1...", "function": {"arguments": "{\"amount\":120,\"from_currency\":\"USD\",\"to_currency\":\"EUR\"}", "name": "convert_currency"}, "type": "function"}
  ]
}
===== REQUEST 2 · what we append (assistant turn + tool results) =====
[ {"role": "assistant", "content": null, "tool_calls": [...]},
  {"role": "tool", "tool_call_id": "call_8Hq...", "content": "{\"place\": \"Lisbon, Portugal\", ...}"},
  {"role": "tool", "tool_call_id": "call_Zp1...", "content": "{\"amount\": 120.0, ... \"converted\": 107.48}"} ]
===== RESPONSE 2 · final answer =====
{"content": "Tomorrow in Lisbon there's a 25% chance of rain ... 120 USD is about 107.48 EUR.", "role": "assistant"}
```

**If it breaks**
- `400 ... messages with role 'tool' must be a response to a preceding message with 'tool_calls'` → you appended tool messages without echoing the assistant message first.
- `The model answered without tools` → the model chose not to; rerun, or ask more explicitly ("use your tools").

## Step 9 · A sample trace and a cost-per-conversation estimate

**Goal:** one scripted multi-tool conversation recorded in the trace, and a summary with tokens, latency, retries, tool calls and projected cost.

```python title="run_demo.py"
"""Run one scripted multi-tool conversation and save its trace (for your README)."""
from assistant.chat import Assistant

QUESTIONS = [
    "I'm going to Lisbon this weekend. What's the weather for the next 3 days, and what is 250 USD in EUR?",
    "How much have I spent on eating out since 2026-03-01? Keep each currency separate.",
    "Convert my eating-out total in USD to EUR as well.",
]

bot = Assistant()
print(f"conversation {bot.conversation_id}")
for q in QUESTIONS:
    print(f"\nyou> {q}\nbot> ", end="", flush=True)
    bot.ask(q, on_token=lambda t: print(t, end="", flush=True),
            on_tool=lambda line: print(f"\n  [tool] {line}", flush=True))
    print()
```

```python title="trace_summary.py"
"""Summarise traces/turns.jsonl: per-turn stats and cost per conversation."""
import json
import sys
from collections import defaultdict
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "traces/turns.jsonl")
rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

print(f"{'conv':8} {'turn':>4} {'calls':>5} {'tools':>5} {'retry':>5} {'in_tok':>7} {'out_tok':>7} "
      f"{'ttft_ms':>8} {'total_ms':>8} {'cost_$':>9}")
by_conv: dict[str, list[dict]] = defaultdict(list)
for r in rows:
    by_conv[r["conversation"]].append(r)
    ttft = f"{r['first_token_ms']:.0f}" if r["first_token_ms"] is not None else "-"
    print(f"{r['conversation']:8} {r['turn']:>4} {r['model_calls']:>5} {len(r['tool_calls']):>5} "
          f"{r['retries']:>5} {r['input_tokens']:>7} {r['output_tokens']:>7} {ttft:>8} "
          f"{r['latency_ms']:>8.0f} {r['cost_usd']:>9.5f}")

costs = [sum(r["cost_usd"] for r in turns) for turns in by_conv.values()]
failed_tools = sum(1 for r in rows for t in r["tool_calls"] if not t["ok"])
print(f"\nconversations: {len(costs)}   turns: {len(rows)}   failed tool calls: {failed_tools}")
print(f"average cost per conversation: ${sum(costs) / len(costs):.5f}")
print(f"projected cost per 1,000 conversations: ${1000 * sum(costs) / len(costs):.2f}")
```

**How this code works**
- Fixed questions → the same conversation every run, so you can compare models or prompt changes on equal terms.
- Grouping by `conversation` → cost per conversation is what a product owner budgets with, not cost per call.
- Notice in the output that turns with tools cost roughly double: each tool round resends the whole history plus tool results as input tokens. Long tool outputs are often the biggest line item.
- The prices come from `PRICE_IN_PER_M` / `PRICE_OUT_PER_M`; if they are wrong, every number here is wrong. Check them against your provider's price page.

**Run it**
```bash
rm -f traces/turns.jsonl        # PowerShell: Remove-Item traces\turns.jsonl
python run_demo.py
python trace_summary.py
```

**You should see**
```text
conv     turn calls tools retry  in_tok out_tok  ttft_ms total_ms    cost_$
5d2e81b0    1     2     2     0    1412     118     2104     2690   0.00028
5d2e81b0    2     2     1     0    1890      96     1350     1822   0.00034
5d2e81b0    3     2     1     0    2306      61     1510     1874   0.00038

conversations: 1   turns: 3   failed tool calls: 0
average cost per conversation: $0.00100
projected cost per 1,000 conversations: $1.00
```

**If it breaks**
- Token columns are all 0 → your server does not return usage when streaming → check it supports `stream_options.include_usage`; otherwise note "usage unavailable" in the README rather than reporting $0.
- `ttft_ms` is `-` → that turn's text came only after tools, or the model returned no text → normal for some turns.

## Ship it

Your README should include:

- **What it does** in three lines, and a GIF or asciinema recording of the Lisbon conversation streaming.
- **Setup**: `pip install -r requirements.txt`, `cp .env.example .env`, how to point it at OpenAI, another provider, or Ollama.
- **Tools**: a table of the three tools, their arguments and limits, and what happens when each service is down.
- **Sample trace**: paste one `turns.jsonl` row from `run_demo.py` (pretty-printed) and the `trace_summary.py` table.
- **Cost**: the cost-per-conversation estimate, the prices you assumed, and the date you checked them.
- **Raw mechanics**: the output of `raw_roundtrip.py` for one round trip, annotated.
- **Tests**: `pytest -q` and what the seven tests prove.

Demo checklist: a parallel turn, a sequential turn, a tool failure handled in words, `/card`, `/raw`, and a forced retry. For the portfolio write-up, report time to first token vs total turn latency, the share of input tokens that came from tool results, and cost per 1,000 conversations.

## Going further

- Add a fallback model (`FALLBACK_MODEL`) used when the primary fails after retries, and compare their tool-calling accuracy on `run_demo.py`.
- Rebuild `Assistant` with only the raw SDK (streaming included) and compare line count and how easy each is to debug.
- Trim history to a token budget, keeping the system prompt and the latest tool results.
- Serve the assistant over HTTP with FastAPI and Server-Sent Events, so a web page can stream it.
- Add a write tool (`add_expense`) that asks the user to confirm before running.
