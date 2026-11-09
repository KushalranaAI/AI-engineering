---
project: monitored-llm-api
title: Monitored LLM API
hours: 10
stack: Python 3.11, FastAPI, OpenAI-compatible SDK (two providers), Prometheus, Grafana, OpenTelemetry + Jaeger (or Langfuse), Docker Compose, httpx load tester
cost: Free with the included mock provider; about $1 for a real-provider load test of a few hundred requests
---

You will run an LLM endpoint the way a production team would. A FastAPI gateway routes each request to a cheap or a
strong model, retries with backoff, falls back to a second provider during an outage, enforces per-user and global daily
spend caps, caches repeats, streams tokens, and records tokens, latency, cost and model for every request in Prometheus
metrics and OpenTelemetry traces. You will prove the fallback works by simulating an outage, load-test it for p50/p95,
error rate and cost per 1,000 requests, and ship dashboard screenshots and alert rules. It is the operations story you
tell in an interview.

## Before you start
- Python 3.11+, Docker Desktop (for Prometheus, Grafana and Jaeger), and optionally keys for two providers (for example OpenAI for the primary and Groq or Together for the fallback; any OpenAI-compatible pair works, including two local Ollama/vLLM servers).
- A **mock provider** is built in Step 1, so everything up to deployment costs nothing. Use real providers for the final numbers.
- Reuses the API skills from the Level 7/8 deployment projects. If you built the Document Q&A platform, this gateway can sit in front of it later.

```text title="final layout"
llm-gateway/
├── gateway/
│   ├── config.py      # providers, caps, keys from env
│   ├── router.py      # cheap vs strong
│   ├── providers.py   # retries, backoff, fallback, chaos switch
│   ├── budget.py      # rate limit, daily caps, cache
│   ├── telemetry.py   # Prometheus metrics + OpenTelemetry tracer
│   └── main.py        # FastAPI: /v1/chat (JSON or SSE), /metrics, /admin/chaos
├── mock/mock_llm.py   # fake OpenAI-compatible provider
├── loadtest/run.py
├── tests/test_gateway.py
├── ops/prometheus.yml · ops/alerts.yml · ops/grafana/datasource.yml
├── docker-compose.yml · Dockerfile · requirements.txt · .env
```

## How it fits together

```text
client ─X-API-Key─► FastAPI /v1/chat
                      │ auth → rate limit → daily caps (user, global)
                      │ cache hit? ── yes ──► return ($0)
                      ▼
                  router: cheap | strong
                      ▼
          primary provider ── retry ×2 with jittered backoff ──► fail? ──► fallback provider
                      │                                                    (different vendor)
                      ▼
         usage → cost → ledger ── metrics (/metrics) ──► Prometheus ──► Grafana + alert rules
                                └─ spans (OTLP) ───────► Jaeger / Langfuse
```

A request is authenticated, rate limited and checked against today's spend before any model is called. A cheap
heuristic picks the model tier; identical recent requests are served from cache. The provider call is retried on
timeouts, connection errors, 429s and 5xx, then handed to a fallback provider from a different vendor. Whatever
answered, the gateway turns the returned token usage into dollars, adds it to the user's ledger, and records metrics and
a trace span with the model, tokens, cost and whether a fallback happened.

## Step 1 · Configuration and a mock provider
**Goal:** settings for three providers and a fake OpenAI-compatible server you can break on purpose.

A mock provider gives you free load tests and repeatable outage drills. It speaks the same wire format as real
providers, including streaming with a final usage chunk, so the gateway code never knows the difference.

```bash title="terminal"
mkdir llm-gateway && cd llm-gateway
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir -p gateway mock loadtest tests ops/grafana && touch gateway/__init__.py mock/__init__.py
```

```text title="requirements.txt"
fastapi>=0.115
uvicorn[standard]>=0.30
openai>=1.40
httpx>=0.27
pydantic>=2.7
prometheus-client>=0.20
opentelemetry-sdk>=1.27
opentelemetry-exporter-otlp-proto-http>=1.27
pytest>=8
```

```python title="gateway/config.py"
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str | None
    api_key: str
    model: str
    price_in: float   # USD per 1M input tokens
    price_out: float  # USD per 1M output tokens


def _provider(prefix: str, model: str, price_in: str, price_out: str) -> Provider:
    return Provider(
        name=prefix.lower(),
        base_url=os.getenv(f"{prefix}_BASE_URL") or None,
        api_key=os.getenv(f"{prefix}_API_KEY", "not-needed"),
        model=os.getenv(f"{prefix}_MODEL", model),
        price_in=float(os.getenv(f"{prefix}_PRICE_IN", price_in)),
        price_out=float(os.getenv(f"{prefix}_PRICE_OUT", price_out)),
    )


# Example models and prices only: set real ones for your providers.
CHEAP = _provider("CHEAP", "gpt-4o-mini", "0.15", "0.60")
STRONG = _provider("STRONG", "gpt-4o", "2.50", "10.00")
FALLBACK = _provider("FALLBACK", "llama-3.1-8b-instant", "0.05", "0.08")  # a DIFFERENT provider

TIMEOUT_S = float(os.getenv("TIMEOUT_S", "20"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))
MAX_TOKENS_CAP = 1024
USER_DAILY_USD = float(os.getenv("USER_DAILY_USD", "0.50"))
GLOBAL_DAILY_USD = float(os.getenv("GLOBAL_DAILY_USD", "5.00"))
RATE_PER_MIN = int(os.getenv("RATE_PER_MIN", "60"))
CACHE_TTL_S = int(os.getenv("CACHE_TTL_S", "600"))
CHAOS_FAIL_RATE = float(os.getenv("CHAOS_FAIL_RATE", "0"))  # simulated outage of the primary providers
API_KEYS = dict(p.split(":", 1) for p in os.getenv("API_KEYS", "dev-key:dev").split(",") if ":" in p)
ADMIN_KEY = os.getenv("ADMIN_KEY", "")
```

```python title="mock/mock_llm.py"
"""A fake OpenAI-compatible server with tunable latency and failures. Free load tests and outage drills."""
import asyncio
import json
import os
import random
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="mock-llm")
LATENCY_MS = float(os.getenv("MOCK_LATENCY_MS", "400"))
FAIL_RATE = float(os.getenv("MOCK_FAIL_RATE", "0"))
WORDS = "the gateway routed this request retried on failure and recorded tokens latency and cost".split()


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    if random.random() < FAIL_RATE:
        return JSONResponse({"error": {"message": "mock outage", "type": "server_error"}}, status_code=503)
    prompt_tokens = sum(len(str(m.get("content", "")).split()) for m in body["messages"]) + 8
    n_out = min(body.get("max_tokens") or 60, 60)
    words = [random.choice(WORDS) for _ in range(n_out)]
    usage = {"prompt_tokens": prompt_tokens, "completion_tokens": n_out, "total_tokens": prompt_tokens + n_out}
    base = {"id": "mock-1", "created": int(time.time()), "model": body["model"]}

    if not body.get("stream"):
        await asyncio.sleep(random.gauss(LATENCY_MS, LATENCY_MS / 4) / 1000 if LATENCY_MS else 0)
        return {**base, "object": "chat.completion", "usage": usage, "choices": [
            {"index": 0, "message": {"role": "assistant", "content": " ".join(words)}, "finish_reason": "stop"}]}

    async def events():
        await asyncio.sleep(LATENCY_MS / 2000)  # time to first token = half the latency
        for w in words:
            chunk = {**base, "object": "chat.completion.chunk",
                     "choices": [{"index": 0, "delta": {"content": w + " "}, "finish_reason": None}]}
            yield f"data: {json.dumps(chunk)}\n\n"
            await asyncio.sleep(LATENCY_MS / 2000 / n_out)
        yield f"data: {json.dumps({**base, 'object': 'chat.completion.chunk', 'choices': [], 'usage': usage})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")
```

**How this code works**
- `Provider` bundles everything needed to call and price one model. Prices are per million tokens and come from env, because they change and differ by vendor.
- `FALLBACK` should be a **different vendor** from the primary. Falling back to another model at the same provider does not help when that provider is down.
- `CHAOS_FAIL_RATE` is a built-in outage switch for the primary providers (Step 7).
- The mock returns 503s at `MOCK_FAIL_RATE`, sleeps around `MOCK_LATENCY_MS`, and streams `chat.completion.chunk` events ending in a usage-only chunk and `[DONE]`, exactly like the OpenAI API with `stream_options.include_usage`.

**Run it**
```bash title="terminal"
pip install -r requirements.txt
uvicorn mock.mock_llm:app --port 9001 &
MOCK_LATENCY_MS=250 uvicorn mock.mock_llm:app --port 9002 &
curl -s localhost:9001/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

**You should see**
```text
{"id":"mock-1","created":1762500000,"model":"m","object":"chat.completion","usage":{"prompt_tokens":9,"completion_tokens":5,"total_tokens":14},"choices":[{"index":0,"message":{"role":"assistant","content":"latency the routed cost request"},"finish_reason":"stop"}]}
```

**If it breaks**
- `&` does not work on Windows PowerShell → open a separate terminal per server instead.
- `Address already in use` → something else is on 9001; pick another port and update `.env` later.

## Step 2 · Routing, retries and fallback
**Goal:** a router that picks a tier and a provider layer that retries, backs off and falls back.

```python title="gateway/router.py"
import re

from gateway.config import CHEAP, STRONG, Provider

HARD = re.compile(r"\b(prove|derive|analy[sz]e|step[- ]by[- ]step|debug|refactor|architecture|trade-?offs?|"
                  r"compare|legal|contract|diagnos\w*)\b", re.IGNORECASE)
CODE_FENCE = "`" * 3  # spelled this way so the guide's Markdown code fences stay intact


def choose_tier(messages: list[dict], requested: str = "auto") -> str:
    if requested in ("cheap", "strong"):
        return requested
    text = " ".join(str(m.get("content", "")) for m in messages)
    if len(text) > 2000 or CODE_FENCE in text or HARD.search(text):
        return "strong"
    return "cheap"


def provider_for(tier: str) -> Provider:
    return STRONG if tier == "strong" else CHEAP
```

```python title="gateway/telemetry.py"
import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_client import Counter, Histogram

REQUESTS = Counter("llm_requests_total", "Gateway requests", ["tier", "model", "status"])
LATENCY = Histogram("llm_request_seconds", "End-to-end latency", ["tier"],
                    buckets=(0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32))
TTFT = Histogram("llm_time_to_first_token_seconds", "Streaming time to first token", ["model"],
                 buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 4))
TOKENS = Counter("llm_tokens_total", "Tokens", ["model", "kind"])
COST = Counter("llm_cost_usd_total", "Spend in USD", ["model"])
PROVIDER_ERRORS = Counter("llm_provider_errors_total", "Failed provider attempts", ["provider", "error"])
FALLBACKS = Counter("llm_fallbacks_total", "Requests served by the fallback provider", ["from_provider"])
CACHE_HITS = Counter("llm_cache_hits_total", "Responses served from cache")
REJECTED = Counter("llm_rejected_total", "Requests refused before calling a model", ["reason"])


def setup_tracing() -> trace.Tracer:
    """Export spans over OTLP/HTTP if OTEL_EXPORTER_OTLP_ENDPOINT is set (Jaeger, Langfuse, Grafana Tempo...)."""
    provider = TracerProvider(resource=Resource.create({"service.name": "llm-gateway"}))
    if os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # reads endpoint + headers from env
    trace.set_tracer_provider(provider)
    return trace.get_tracer("llm-gateway")


tracer = setup_tracing()
```

```python title="gateway/providers.py"
import asyncio
import random

import httpx
import openai
from openai import AsyncOpenAI

from gateway import config
from gateway.config import Provider
from gateway.telemetry import PROVIDER_ERRORS, tracer

RETRYABLE = (openai.APITimeoutError, openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)
chaos = {"rate": config.CHAOS_FAIL_RATE}  # mutable so /admin/chaos can change it at runtime
_clients: dict[str, AsyncOpenAI] = {}


class AllProvidersFailed(Exception):
    pass


def make_client(p: Provider) -> AsyncOpenAI:
    # max_retries=0: WE own retries, so they are visible in metrics and traces
    return AsyncOpenAI(base_url=p.base_url, api_key=p.api_key, timeout=config.TIMEOUT_S, max_retries=0)


def client_for(p: Provider) -> AsyncOpenAI:
    if p.name not in _clients:
        _clients[p.name] = make_client(p)
    return _clients[p.name]


def _maybe_chaos(p: Provider) -> None:
    if p.name != "fallback" and random.random() < chaos["rate"]:
        raise openai.APIConnectionError(request=httpx.Request("POST", f"chaos://{p.name}"))


def backoff(attempt: int) -> float:
    return min(0.25 * 2 ** attempt, 4.0) * random.uniform(0.5, 1.5)  # exponential with jitter


async def _attempts(chain: list[Provider], call):
    """Try each provider in order, retrying retryable errors with backoff. Returns (result, provider, attempts)."""
    attempts = 0
    for p in chain:
        for attempt in range(config.MAX_RETRIES + 1):
            attempts += 1
            with tracer.start_as_current_span("provider.attempt") as span:
                span.set_attributes({"gen_ai.system": p.name, "gen_ai.request.model": p.model, "attempt": attempt})
                try:
                    _maybe_chaos(p)
                    return await call(p), p, attempts
                except RETRYABLE as err:
                    span.record_exception(err)
                    PROVIDER_ERRORS.labels(p.name, type(err).__name__).inc()
            if attempt < config.MAX_RETRIES:
                await asyncio.sleep(backoff(attempt))
    raise AllProvidersFailed(f"all providers failed after {attempts} attempts")


async def complete(messages: list[dict], chain: list[Provider], max_tokens: int):
    async def call(p: Provider):
        return await client_for(p).chat.completions.create(
            model=p.model, messages=messages, max_tokens=max_tokens, temperature=0)
    return await _attempts(chain, call)


async def open_stream(messages: list[dict], chain: list[Provider], max_tokens: int):
    """Fallback is only possible BEFORE the first token, so we read the first chunk inside the retry loop."""
    async def call(p: Provider):
        stream = await client_for(p).chat.completions.create(
            model=p.model, messages=messages, max_tokens=max_tokens, temperature=0,
            stream=True, stream_options={"include_usage": True})
        iterator = stream.__aiter__()
        return iterator, await iterator.__anext__()
    return await _attempts(chain, call)
```

**How this code works**
- `choose_tier` is a deliberately simple heuristic: long prompts, code fences (`CODE_FENCE`) and words like "debug" or "compare" go to the strong model. It is cheap, explainable and easy to evaluate; the load test reports the strong-tier share so you can see what it costs.
- `max_retries=0` on the SDK client → the OpenAI SDK retries silently by default. Owning retries ourselves means every failed attempt is counted in `llm_provider_errors_total` and appears as a span.
- `RETRYABLE` → only transient errors are retried. A 400 (bad request) or 401 would fail the same way again, so it propagates immediately.
- `backoff` → 0.25 s, 0.5 s, 1 s... capped at 4 s, multiplied by random jitter so a thousand clients do not retry in lockstep and knock the provider over again.
- `_attempts` walks the chain `[primary, fallback]`, giving each provider `MAX_RETRIES + 1` tries, and returns how many attempts it took (visible to the client and in logs).
- `open_stream` reads the **first chunk inside the retry loop**. Once a token has been sent to the client you cannot switch providers without the user seeing a restarted answer, so fallback is only possible before that point.
- `telemetry.py` defines every metric up front with low-cardinality labels (tier, model, status). Never label by user or prompt: each unique label value creates a new time series and can take Prometheus down.
- `setup_tracing` exports spans only if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local runs and tests need no collector. The OTLP exporter reads the endpoint and auth headers from standard env vars, which is how you point it at Jaeger, Grafana Tempo or Langfuse without code changes.

**Run it**
```bash title="terminal"
export CHEAP_BASE_URL=http://localhost:9001/v1 STRONG_BASE_URL=http://localhost:9001/v1 FALLBACK_BASE_URL=http://localhost:9002/v1
python -c "
import asyncio
from gateway import config, providers
from gateway.router import choose_tier
print(choose_tier([{'content': 'Compare Kafka and RabbitMQ'}]))
resp, p, n = asyncio.run(providers.complete([{'role': 'user', 'content': 'hi'}], [config.CHEAP, config.FALLBACK], 10))
print(p.name, n, resp.usage.total_tokens)
providers.chaos['rate'] = 1.0
resp, p, n = asyncio.run(providers.complete([{'role': 'user', 'content': 'hi'}], [config.CHEAP, config.FALLBACK], 10))
print(p.name, n)"
```

**You should see**
```text
strong
cheap 1 19
fallback 4
```
Four attempts: three failed tries on the primary (one plus two retries), then the fallback.

**If it breaks**
- `APIConnectionError` with chaos off → the mock is not running on that port, or `BASE_URL` lacks the `/v1` suffix.
- It takes many seconds to fall back → that is the backoff plus `TIMEOUT_S` for real timeouts. For a hanging provider, lower `TIMEOUT_S`; 20 s is generous for short completions.

## Step 3 · Cost controls: rate limits, daily caps and a cache
**Goal:** a budget module that refuses requests over the limits and serves repeats for free.

```python title="gateway/budget.py"
import hashlib
import json
import time
from collections import defaultdict, deque
from datetime import date

from gateway import config

_spend: dict[tuple[str, str], float] = defaultdict(float)  # (user, day) -> USD
_calls: dict[str, deque] = defaultdict(deque)
_cache: dict[str, tuple[float, dict]] = {}


def today() -> str:
    return date.today().isoformat()


def refusal(user: str) -> tuple[int, str] | None:
    """Return (status, reason) if this request must be refused, else None."""
    now, window = time.monotonic(), _calls[user]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= config.RATE_PER_MIN:
        return 429, "rate_limit"
    if _spend[(user, today())] >= config.USER_DAILY_USD:
        return 402, "user_daily_cap"
    if _spend[("*", today())] >= config.GLOBAL_DAILY_USD:
        return 503, "global_daily_cap"
    window.append(now)
    return None


def record(user: str, cost: float) -> None:
    _spend[(user, today())] += cost
    _spend[("*", today())] += cost


def spent(user: str) -> float:
    return _spend[(user, today())]


def cache_key(model_tier: str, messages: list[dict], max_tokens: int) -> str:
    raw = json.dumps([model_tier, messages, max_tokens], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def cache_get(key: str) -> dict | None:
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    _cache.pop(key, None)
    return None


def cache_put(key: str, value: dict) -> None:
    if len(_cache) > 5000:  # crude bound on memory
        _cache.clear()
    _cache[key] = (time.monotonic() + config.CACHE_TTL_S, value)
```

**How this code works**
- `refusal` checks in order of cheapness: rate limit, user cap, global cap. It returns an HTTP status so the API layer stays thin: 429 (slow down), 402 (your budget is spent), 503 (the service's budget is spent).
- The cap checks spend *so far*, so a user can overshoot by at most one request. Bounding `max_tokens` (Step 5) bounds that overshoot. Say this in the README; it shows you thought about it.
- `("*", today())` is the global ledger: one line of code that protects you from a viral demo link.
- `cache_key` hashes tier, messages and `max_tokens`. Only non-streaming, temperature-0 responses are cached, and only for `CACHE_TTL_S`.
- Everything lives in process memory: correct for one instance, wrong for several. The production version is Redis (`INCRBYFLOAT` per user-day key with a TTL). Mention that as the next step rather than pretending.

**Run it**
```bash title="terminal"
python -c "
from gateway import budget, config
config.USER_DAILY_USD = 0.01
print(budget.refusal('ana')); budget.record('ana', 0.02); print(budget.refusal('ana'))"
```

**You should see**
```text
None
(402, 'user_daily_cap')
```

**If it breaks**
- Caps never trigger in the API → `config.USER_DAILY_USD` is read at call time from the module, so set the env var before starting uvicorn, not after.

## Step 4 · The API: JSON and streaming responses
**Goal:** `/v1/chat` that ties everything together, with SSE streaming, `/metrics`, and an admin chaos switch.

```python title="gateway/main.py"
import json
import logging
import time
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from prometheus_client import make_asgi_app
from pydantic import BaseModel, Field

from gateway import budget, config, providers
from gateway.router import choose_tier, provider_for
from gateway.telemetry import (CACHE_HITS, COST, FALLBACKS, LATENCY, REJECTED, REQUESTS, TOKENS, TTFT, tracer)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("gateway")
app = FastAPI(title="Monitored LLM gateway")
app.mount("/metrics", make_asgi_app())


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(max_length=20_000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=50)
    tier: Literal["auto", "cheap", "strong"] = "auto"
    max_tokens: int = Field(default=300, ge=1, le=config.MAX_TOKENS_CAP)
    stream: bool = False


def current_user(x_api_key: str = Header(...)) -> str:
    user = config.API_KEYS.get(x_api_key)
    if user is None:
        raise HTTPException(401, "invalid API key")
    return user


def cost_of(p: config.Provider, usage) -> float:
    if usage is None:
        return 0.0
    return (usage.prompt_tokens * p.price_in + usage.completion_tokens * p.price_out) / 1e6


def account(user: str, p: config.Provider, primary: config.Provider, usage, span) -> float:
    cost = cost_of(p, usage)
    budget.record(user, cost)
    COST.labels(p.model).inc(cost)
    if usage:
        TOKENS.labels(p.model, "input").inc(usage.prompt_tokens)
        TOKENS.labels(p.model, "output").inc(usage.completion_tokens)
        span.set_attributes({"gen_ai.usage.input_tokens": usage.prompt_tokens,
                             "gen_ai.usage.output_tokens": usage.completion_tokens})
    if p is not primary:
        FALLBACKS.labels(primary.name).inc()
    span.set_attributes({"gen_ai.response.model": p.model, "llm.cost_usd": cost, "llm.fallback": p is not primary})
    return cost


@app.post("/v1/chat")
async def chat(req: ChatRequest, user: str = Depends(current_user)):
    start = time.perf_counter()
    messages = [m.model_dump() for m in req.messages]
    tier = choose_tier(messages, req.tier)
    primary = provider_for(tier)
    chain = [primary, config.FALLBACK]

    refused = budget.refusal(user)
    if refused:
        REJECTED.labels(refused[1]).inc()
        raise HTTPException(refused[0], refused[1])

    if req.stream:
        return StreamingResponse(_stream(user, tier, primary, chain, messages, req.max_tokens, start),
                                 media_type="text/event-stream")

    key = budget.cache_key(tier, messages, req.max_tokens)
    if (hit := budget.cache_get(key)) is not None:
        CACHE_HITS.inc()
        REQUESTS.labels(tier, hit["model"], "cache").inc()
        return {**hit, "cached": True, "cost_usd": 0.0, "latency_ms": round((time.perf_counter() - start) * 1000)}

    with tracer.start_as_current_span("chat") as span:
        span.set_attributes({"user": user, "tier": tier, "gen_ai.request.model": primary.model})
        try:
            resp, p, attempts = await providers.complete(messages, chain, req.max_tokens)
        except providers.AllProvidersFailed as err:
            REQUESTS.labels(tier, primary.model, "error").inc()
            raise HTTPException(503, str(err))
        cost = account(user, p, primary, resp.usage, span)

    elapsed = time.perf_counter() - start
    LATENCY.labels(tier).observe(elapsed)
    REQUESTS.labels(tier, p.model, "ok").inc()
    body = {"content": resp.choices[0].message.content, "model": p.model, "provider": p.name, "tier": tier,
            "fallback": p is not primary, "attempts": attempts, "cached": False}
    budget.cache_put(key, body)
    log.info(json.dumps({"event": "chat", "user": user, **{k: body[k] for k in ("model", "tier", "fallback", "attempts")},
                         "cost_usd": round(cost, 6), "ms": round(elapsed * 1000)}))
    return {**body, "cost_usd": round(cost, 6), "latency_ms": round(elapsed * 1000),
            "spent_today_usd": round(budget.spent(user), 4)}


async def _stream(user, tier, primary, chain, messages, max_tokens, start):
    with tracer.start_as_current_span("chat.stream") as span:
        span.set_attributes({"user": user, "tier": tier})
        try:
            (iterator, first), p, attempts = await providers.open_stream(messages, chain, max_tokens)
        except providers.AllProvidersFailed as err:
            REQUESTS.labels(tier, primary.model, "error").inc()
            yield f"data: {json.dumps({'error': str(err)})}\n\n"
            return
        TTFT.labels(p.model).observe(time.perf_counter() - start)
        usage, chunk = None, first
        try:
            while True:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield f"data: {json.dumps({'delta': chunk.choices[0].delta.content})}\n\n"
                usage = chunk.usage or usage
                chunk = await iterator.__anext__()
        except StopAsyncIteration:
            pass
        except providers.RETRYABLE as err:  # mid-stream failure: too late to switch provider
            REQUESTS.labels(tier, p.model, "error").inc()
            yield f"data: {json.dumps({'error': f'stream interrupted: {type(err).__name__}'})}\n\n"
            return
        cost = account(user, p, primary, usage, span)
    LATENCY.labels(tier).observe(time.perf_counter() - start)
    REQUESTS.labels(tier, p.model, "ok").inc()
    yield f"data: {json.dumps({'done': True, 'model': p.model, 'fallback': p is not primary, 'cost_usd': round(cost, 6)})}\n\n"


@app.post("/admin/chaos")
def set_chaos(rate: float, x_admin_key: str = Header("")):
    if not config.ADMIN_KEY or x_admin_key != config.ADMIN_KEY:
        raise HTTPException(403, "admin key required")
    providers.chaos["rate"] = max(0.0, min(rate, 1.0))
    return {"chaos_fail_rate": providers.chaos["rate"]}


@app.get("/health")
def health():
    return {"ok": True}
```

**How this code works**
- `ChatRequest` bounds everything that costs money: up to 50 messages, 20,000 characters each, `max_tokens` capped at 1,024.
- The order in `chat` is the cost-control story: authenticate → refuse if over limits → serve from cache → only then call a model.
- `account` is the single place where usage becomes dollars, and it updates the ledger, the cost and token counters, the fallback counter and the span attributes together. One function means the dashboard, the cap and the trace can never disagree.
- Span attributes follow the OpenTelemetry GenAI conventions (`gen_ai.request.model`, `gen_ai.usage.input_tokens`...), so tools like Langfuse and Grafana recognise them. # check the current docs
- `_stream` sends server-sent events: `{"delta": ...}` per token, then `{"done": true, ...}` with cost. Time to first token goes into its own histogram, because for chat UIs it matters more than total latency.
- A mid-stream provider failure yields an `error` event instead of a silent truncation.
- `/admin/chaos` requires `ADMIN_KEY` and is disabled when it is unset, so the deployed version cannot be broken by strangers.
- `app.mount("/metrics", make_asgi_app())` exposes Prometheus metrics at `/metrics/`.

**Run it**
```bash title="terminal"
ADMIN_KEY=admin uvicorn gateway.main:app --port 8000 &
curl -s localhost:8000/v1/chat -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Name three rivers"}],"max_tokens":20}'
curl -sN localhost:8000/v1/chat -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello"}],"max_tokens":5,"stream":true}'
curl -s localhost:8000/metrics/ | grep ^llm_requests_total
```

**You should see**
```text
{"content":"tokens the gateway ...","model":"gpt-4o-mini","provider":"cheap","tier":"cheap","fallback":false,"attempts":1,"cached":false,"cost_usd":1.6e-05,"latency_ms":431,"spent_today_usd":0.0}
data: {"delta": "request "}
data: {"delta": "gateway "}
...
data: {"done": true, "model": "gpt-4o-mini", "fallback": false, "cost_usd": 5e-06}
llm_requests_total{model="gpt-4o-mini",status="ok",tier="cheap"} 2.0
```

**If it breaks**
- `/metrics` returns 307 → use `/metrics/` with the trailing slash (a mounted sub-app), or follow redirects with `curl -L`.
- Streaming arrives all at once → a proxy is buffering. Locally use `curl -N`; behind nginx set `proxy_buffering off`.

## Step 5 · Tests that run the whole gateway offline
**Goal:** pytest proving routing, caching, fallback, caps, streaming and metrics, with no network.

```python title="tests/test_gateway.py"
import httpx
import pytest
from fastapi.testclient import TestClient
from openai import AsyncOpenAI

from gateway import budget, config, providers
from gateway.main import app
from gateway.router import choose_tier
from mock import mock_llm


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Route every provider to the in-process mock server; reset state between tests."""
    def make_client(p):
        transport = httpx.ASGITransport(app=mock_llm.app)
        return AsyncOpenAI(base_url="http://mock/v1", api_key="x", max_retries=0,
                           http_client=httpx.AsyncClient(transport=transport, base_url="http://mock/v1"))
    monkeypatch.setattr(providers, "make_client", make_client)
    monkeypatch.setattr(providers, "_clients", {})
    monkeypatch.setattr(providers, "backoff", lambda attempt: 0)
    monkeypatch.setattr(mock_llm, "LATENCY_MS", 0)
    monkeypatch.setattr(budget, "_spend", budget.defaultdict(float))
    monkeypatch.setattr(budget, "_cache", {})
    providers.chaos["rate"] = 0.0


client = TestClient(app)
HEADERS = {"X-API-Key": "dev-key"}
BODY = {"messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 20}


def test_router():
    assert choose_tier([{"content": "What is 2+2?"}]) == "cheap"
    assert choose_tier([{"content": "Compare these two architectures"}]) == "strong"


def test_happy_path_then_cache():
    first = client.post("/v1/chat", json=BODY, headers=HEADERS).json()
    assert first["provider"] == "cheap" and not first["fallback"] and first["cost_usd"] > 0
    second = client.post("/v1/chat", json=BODY, headers=HEADERS).json()
    assert second["cached"] and second["cost_usd"] == 0.0


def test_outage_falls_back():
    providers.chaos["rate"] = 1.0  # primary always fails
    body = client.post("/v1/chat", json=BODY, headers=HEADERS).json()
    assert body["provider"] == "fallback" and body["fallback"]
    assert body["attempts"] == config.MAX_RETRIES + 2  # all primary attempts + 1 fallback


def test_daily_cap(monkeypatch):
    monkeypatch.setattr(config, "USER_DAILY_USD", 0.0)
    assert client.post("/v1/chat", json=BODY, headers=HEADERS).status_code == 402


def test_streaming_delivers_tokens_and_cost():
    with client.stream("POST", "/v1/chat", json={**BODY, "stream": True}, headers=HEADERS) as resp:
        lines = [line for line in resp.iter_lines() if line.startswith("data: ")]
    assert any('"delta"' in line for line in lines)
    assert '"done": true' in lines[-1]


def test_metrics_exposed():
    client.post("/v1/chat", json=BODY, headers=HEADERS)
    text = client.get("/metrics/").text
    assert "llm_requests_total" in text and "llm_cost_usd_total" in text
```

```ini title="pytest.ini"
[pytest]
pythonpath = .
```

**How this code works**
- `make_client` is patched to give the OpenAI SDK an `httpx.ASGITransport` pointing at the mock app in-process. Real SDK, real HTTP semantics, no sockets.
- `backoff` is patched to zero so the outage test runs in milliseconds instead of seconds.
- `test_outage_falls_back` asserts the exact attempt count: three on the primary, one on the fallback. If someone changes the retry policy, this test tells them what they changed.
- State (`_spend`, `_cache`, `_clients`) is reset per test, so test order never matters.

**Run it**
```bash title="terminal"
pytest -q
```

**You should see**
```text
......                                                                   [100%]
6 passed in 1.4s
```

**If it breaks**
- `test_happy_path_then_cache` fails on the second call → the cache key includes something that changes per request. Print both keys.

## Step 6 · Dashboards, traces and alerts
**Goal:** Prometheus scraping the gateway, Grafana panels for traffic, latency, cost and fallbacks, Jaeger traces, and four alert rules.

```yaml title="docker-compose.yml"
services:
  mock-primary:
    build: .
    command: uvicorn mock.mock_llm:app --host 0.0.0.0 --port 9001
    environment: {MOCK_LATENCY_MS: "400"}
  mock-fallback:
    build: .
    command: uvicorn mock.mock_llm:app --host 0.0.0.0 --port 9002
    environment: {MOCK_LATENCY_MS: "250"}
  gateway:
    build: .
    ports: ["8000:8000"]
    env_file: [.env]
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
      OTEL_SERVICE_NAME: llm-gateway
    depends_on: [mock-primary, mock-fallback, jaeger]
  prometheus:
    image: prom/prometheus:v3.5.0
    ports: ["9090:9090"]
    volumes:
      - ./ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./ops/alerts.yml:/etc/prometheus/alerts.yml:ro
  grafana:
    image: grafana/grafana:12.1.0
    ports: ["3000:3000"]
    environment: {GF_AUTH_ANONYMOUS_ENABLED: "true", GF_AUTH_ANONYMOUS_ORG_ROLE: Admin}
    volumes:
      - ./ops/grafana/datasource.yml:/etc/grafana/provisioning/datasources/datasource.yml:ro
  jaeger:
    image: jaegertracing/jaeger:2.9.0
    ports: ["16686:16686", "4318:4318"]
```

```yaml title="ops/prometheus.yml"
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files: [/etc/prometheus/alerts.yml]
scrape_configs:
  - job_name: gateway
    metrics_path: /metrics/
    static_configs:
      - targets: ["gateway:8000"]
```

```yaml title="ops/alerts.yml"
groups:
  - name: llm-gateway
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(llm_requests_total{status="error"}[5m]))
            / clamp_min(sum(rate(llm_requests_total[5m])), 1e-9) > 0.05
        for: 5m
        labels: {severity: page}
        annotations:
          summary: "More than 5% of LLM requests are failing"
      - alert: FallbackStorm
        expr: sum(rate(llm_fallbacks_total[5m])) / clamp_min(sum(rate(llm_requests_total{status="ok"}[5m])), 1e-9) > 0.2
        for: 10m
        labels: {severity: ticket}
        annotations:
          summary: "Over 20% of traffic is on the fallback provider; primary may be degraded"
      - alert: SpendRateTooHigh
        expr: sum(increase(llm_cost_usd_total[1h])) > 1
        labels: {severity: ticket}
        annotations:
          summary: "Spent more than $1 in the last hour"
      - alert: SlowP95
        expr: histogram_quantile(0.95, sum by (le) (rate(llm_request_seconds_bucket[5m]))) > 8
        for: 10m
        labels: {severity: ticket}
        annotations:
          summary: "p95 latency above 8 s"
```

```yaml title="ops/grafana/datasource.yml"
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

```dockerfile title="Dockerfile"
FROM python:3.11-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY gateway ./gateway
COPY mock ./mock
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash title=".env"
CHEAP_BASE_URL=http://mock-primary:9001/v1
STRONG_BASE_URL=http://mock-primary:9001/v1
FALLBACK_BASE_URL=http://mock-fallback:9002/v1
API_KEYS=dev-key:dev,load-key:loadtest
ADMIN_KEY=change-me
RATE_PER_MIN=100000
USER_DAILY_USD=50
```

**How this code works**
- Compose runs the gateway, two mock providers, Prometheus, Grafana (anonymous admin, local only) and Jaeger, which accepts OTLP on port 4318 and shows traces on 16686. Pin image tags to current versions when you build this.
- `metrics_path: /metrics/` matches the mounted app.
- Alerts encode what "broken" means for an LLM API: error rate above 5%, more than 20% of traffic on the fallback (the primary is degraded even if users see no errors), spend above $1 per hour, and p95 latency above 8 s. `for:` stops a single bad scrape from paging anyone.
- For real providers, replace the three `*_BASE_URL` lines with real endpoints and add `CHEAP_API_KEY`, `FALLBACK_API_KEY` and so on. For Langfuse instead of Jaeger, set `OTEL_EXPORTER_OTLP_ENDPOINT` to its OTLP endpoint and `OTEL_EXPORTER_OTLP_HEADERS` to its auth header. # check the current docs

Build a Grafana dashboard (http://localhost:3000 → Dashboards → New → Add visualization) with these queries:

| Panel | PromQL |
|---|---|
| Requests/s by status | `sum by (status) (rate(llm_requests_total[1m]))` |
| p50 / p95 latency | `histogram_quantile(0.95, sum by (le) (rate(llm_request_seconds_bucket[5m])))` (and 0.5) |
| Time to first token p95 | `histogram_quantile(0.95, sum by (le) (rate(llm_time_to_first_token_seconds_bucket[5m])))` |
| Spend per hour by model | `sum by (model) (increase(llm_cost_usd_total[1h]))` |
| Tokens/s in vs out | `sum by (kind) (rate(llm_tokens_total[1m]))` |
| Fallback share | `sum(rate(llm_fallbacks_total[5m])) / sum(rate(llm_requests_total{status="ok"}[5m]))` |
| Provider errors | `sum by (provider, error) (rate(llm_provider_errors_total[5m]))` |
| Cache hit rate | `rate(llm_cache_hits_total[5m]) / sum(rate(llm_requests_total[5m]))` |

Save it, then export it as JSON (Share → Export) into `ops/grafana/dashboard.json` so the repo reproduces it.

**Run it**
```bash title="terminal"
docker compose up --build -d
python loadtest/run.py -n 200 -c 10        # generate some traffic
```
Open Grafana (:3000), Prometheus alerts (:9090/alerts) and Jaeger (:16686, service `llm-gateway`).

**You should see**
```text
Prometheus → Status → Targets: gateway UP
Jaeger → llm-gateway → a "chat" span with child "provider.attempt" spans, attributes gen_ai.request.model, gen_ai.usage.input_tokens, llm.cost_usd
Grafana → requests/s around 30, p95 around 1.5 s, spend climbing in small steps
```

**If it breaks**
- Target `gateway` DOWN → the gateway container crashed; `docker compose logs gateway`. Usually a missing `.env`.
- No traces in Jaeger → `OTEL_EXPORTER_OTLP_ENDPOINT` must be the base URL (`http://jaeger:4318`); the exporter appends `/v1/traces` itself.

## Step 7 · Simulate an outage and write it up
**Goal:** evidence that users kept getting answers while the primary provider was down.

**Run it**
```bash title="terminal"
python loadtest/run.py -n 1200 -c 10 &                    # steady traffic for about a minute
sleep 15 && curl -s -X POST "localhost:8000/admin/chaos?rate=1.0" -H "X-Admin-Key: change-me"
sleep 30 && curl -s -X POST "localhost:8000/admin/chaos?rate=0" -H "X-Admin-Key: change-me"
wait
```

**You should see**
```text
{"chaos_fail_rate":1.0}
{"chaos_fail_rate":0.0}
requests=1200 concurrency=10 wall=61.4s throughput=19.5 req/s
p50=520 ms  p95=1690 ms  errors=0.0%  fallback=41.3%
```
In Grafana: provider errors spike, fallback share jumps to ~100% for 30 seconds, error rate stays at 0, p95 rises by roughly the backoff time, and the `FallbackStorm` alert goes to *pending* (it would fire after 10 minutes).

Write `docs/outage-drill.md` with: what you broke and how, a screenshot of the four panels across the window, the user-visible impact (errors, latency added by retries), and what you would change. A good finding: "Each request paid ~0.75 s of backoff before falling back. A circuit breaker that skips the primary for 30 s after 5 consecutive failures would remove that." That sentence is what makes this project memorable.

**If it breaks**
- Errors appear during the outage → the fallback is pointed at the same server as the primary, or `MAX_RETRIES` × `TIMEOUT_S` exceeds the load tester's 60 s timeout.

## Step 8 · Load test with a real provider
**Goal:** p50, p95, error rate and cost per 1,000 requests from real models, for the README.

```python title="loadtest/run.py"
"""Fire N requests at C concurrency and report p50/p95 latency, error rate, fallback share and cost per 1k."""
import argparse
import asyncio
import random
import statistics
import time

import httpx

PROMPTS = [
    "Summarise the benefits of unit tests in two sentences.",
    "Write a haiku about latency.",
    "Compare REST and gRPC for internal services and explain the trade-offs.",
    "What is the capital of Australia?",
    "Debug this: my Python loop never ends when I modify the list inside it.",
    "Give me three names for a coffee shop.",
]


async def one(client: httpx.AsyncClient, args, results: list) -> None:
    prompt = random.choice(PROMPTS) + f" (variant {random.randint(1, 10_000)})"  # defeat the cache on purpose
    start = time.perf_counter()
    try:
        resp = await client.post("/v1/chat", json={"messages": [{"role": "user", "content": prompt}],
                                                   "max_tokens": args.max_tokens})
        data = resp.json() if resp.status_code == 200 else {}
        results.append({"ms": (time.perf_counter() - start) * 1000, "status": resp.status_code,
                        "cost": data.get("cost_usd", 0.0), "fallback": data.get("fallback", False),
                        "tier": data.get("tier")})
    except httpx.HTTPError:
        results.append({"ms": (time.perf_counter() - start) * 1000, "status": 0, "cost": 0.0, "fallback": False})


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--key", default="dev-key")
    parser.add_argument("-n", type=int, default=300)
    parser.add_argument("-c", type=int, default=20)
    parser.add_argument("--max-tokens", type=int, default=80)
    args = parser.parse_args()

    results: list[dict] = []
    sem = asyncio.Semaphore(args.c)
    async with httpx.AsyncClient(base_url=args.url, headers={"X-API-Key": args.key}, timeout=60) as client:
        async def bounded():
            async with sem:
                await one(client, args, results)
        start = time.perf_counter()
        await asyncio.gather(*(bounded() for _ in range(args.n)))
        wall = time.perf_counter() - start

    ok = [r for r in results if r["status"] == 200]
    lat = sorted(r["ms"] for r in ok) or [0.0]
    p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
    print(f"requests={len(results)} concurrency={args.c} wall={wall:.1f}s throughput={len(results) / wall:.1f} req/s")
    print(f"p50={statistics.median(lat):.0f} ms  p95={p95:.0f} ms  "
          f"errors={1 - len(ok) / len(results):.1%}  fallback={sum(r['fallback'] for r in ok) / max(len(ok), 1):.1%}")
    print(f"strong-tier share={sum(r.get('tier') == 'strong' for r in ok) / max(len(ok), 1):.0%}  "
          f"cost per 1k requests=${1000 * sum(r['cost'] for r in ok) / max(len(ok), 1):.3f}")
    print("status codes:", {s: sum(r['status'] == s for r in results) for s in sorted({r['status'] for r in results})})


if __name__ == "__main__":
    asyncio.run(main())
```

**How this code works**
- A semaphore holds concurrency at `-c`, so you measure the gateway under a steady load rather than one huge burst.
- Each prompt gets a random suffix to **defeat the cache** on purpose. Run once more without the suffix to measure the cache's effect separately.
- p95 is computed from successful requests; errors are reported separately so a fast failure cannot make latency look better.
- Cost per 1,000 requests uses the gateway's own `cost_usd`, which comes from the providers' reported usage, not an estimate.

**Run it**
```bash title="terminal"
# point .env at real providers, set a low USER_DAILY_USD and a provider-side spend limit, then:
docker compose up -d --build gateway
python loadtest/run.py -n 300 -c 10 --max-tokens 120 | tee docs/loadtest.txt
```

**You should see** (mock numbers shown; real ones will be slower and cost more)
```text
requests=300 concurrency=20 wall=7.9s throughput=38.0 req/s
p50=433 ms  p95=1528 ms  errors=0.0%  fallback=0.0%
strong-tier share=37%  cost per 1k requests=$0.267
status codes: {200: 300}
```

**If it breaks**
- Lots of 429s → that is your own `RATE_PER_MIN` or the provider's limit. The status code breakdown tells you which: 429 with zero provider errors means the gateway refused.
- Cost per 1k is 0 → the provider does not return usage on that endpoint. Check `resp.usage`; some local servers need a flag to include it.

## Ship it
- **Deploy** the gateway container to Fly.io or Render with real provider keys as secrets, a modest `USER_DAILY_USD` and `GLOBAL_DAILY_USD`, and `ADMIN_KEY` set. For hosted dashboards, Grafana Cloud's free tier can scrape a public `/metrics` endpoint (protect it with basic auth), and Langfuse Cloud can receive the OTLP traces.
- **README, results first:** the architecture diagram; a table with p50, p95, TTFT p95, error rate, strong-tier share and cost per 1,000 requests from the real-provider load test; three dashboard screenshots (normal, outage, recovered); the alert rules and why each threshold; a link to `docs/outage-drill.md`.
- **Key decisions:** own retries instead of the SDK's, fallback only before the first token, low-cardinality metrics, in-memory budgets (and the Redis plan), the heuristic router and its cost.
- **Demo video (2 min):** a streaming request; the dashboard; flipping chaos on and watching fallbacks rise while errors stay flat; a user hitting the daily cap.

## Going further
- Add a circuit breaker: after N consecutive failures, skip the primary for a cool-down period, and measure the latency saved during the drill.
- Add an online eval: sample 5% of live traffic, score it with an LLM judge in a background task, and graph the score next to latency.
- Canary a prompt or model change: send 10% of traffic to the new version via a header or hash on user id, and compare cost and score by version label.
- Move budgets and cache to Redis and run two gateway replicas behind a load balancer to show the caps still hold.
- Replace the keyword router with a small classifier trained on logged prompts labelled by which tier answered well.
