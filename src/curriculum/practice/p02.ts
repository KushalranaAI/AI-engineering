import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "2.1": {
    realLife: {
      title: "Calling a different call-centre agent each time",
      story:
        "You phone your bank about a failed UPI refund. Every time the call drops and you ring back, a new agent answers who has never heard of you, so you read out the complaint number and the story so far before asking your new question. The bank's system keeps the full complaint file, but the agent only sees what you read out on this call, and each call is billed by the minute.",
      mapping: [
        { everyday: "A fresh agent on every call", concept: "A stateless API: the model remembers nothing between requests" },
        { everyday: "Reading out the story so far each time", concept: "Sending the conversation history with every request" },
        { everyday: "The bank's full complaint file vs what you read out", concept: "App state vs model context" },
        { everyday: "Billed by the minute, including the recap", concept: "Input tokens grow as history grows" },
      ],
    },
    build: {
      title: "A chat CLI with saved sessions and a token ledger",
      goal: "A terminal chat that saves each conversation to disk, can resume it later, trims history to a token budget, and prints a per-turn ledger from the API's usage fields.",
      minutes: 60,
      stack: ["Python", "openai or anthropic SDK", "tiktoken"],
      steps: [
        "Load the API key from an environment variable and fail with a clear message if it is missing.",
        "Store app state as a JSON file per session (`sessions/<id>.json`) holding all messages plus metadata such as created time and total cost.",
        "Before each call, build the model context from app state: system prompt plus as many recent turns as fit in a 3,000-token history budget.",
        "After each call, print stop reason, input tokens, output tokens, response id and an estimated cost; append to the session file.",
        "Add `/resume <id>` and `/stats` commands; resume a session in a new process and ask a question that depends on an earlier turn.",
      ],
      starter:
        "import json, os, sys, uuid\nfrom pathlib import Path\nfrom openai import OpenAI\n\nif not os.getenv(\"OPENAI_API_KEY\"):\n    sys.exit(\"Set OPENAI_API_KEY first\")\nclient = OpenAI()\nSESSIONS = Path(\"sessions\"); SESSIONS.mkdir(exist_ok=True)\nSYSTEM = {\"role\": \"system\", \"content\": \"You are a concise assistant.\"}\n\ndef build_context(messages: list[dict], budget: int = 3000) -> list[dict]:\n    # TODO: walk messages newest-first, keep while estimated tokens <= budget\n    ...\n\ndef turn(state: dict, user_text: str) -> None:\n    state[\"messages\"].append({\"role\": \"user\", \"content\": user_text})\n    resp = client.chat.completions.create(model=\"gpt-4o-mini\", messages=[SYSTEM, *build_context(state[\"messages\"])])\n    # TODO: print finish_reason, usage.prompt_tokens, usage.completion_tokens, resp.id\n    # TODO: append assistant message, update cost, save to SESSIONS / f\"{state['id']}.json\"\n    ...",
      checks: [
        "After `/resume` in a new process, the model correctly answers a question about something said before the restart.",
        "Input tokens per turn stop growing once the history budget is reached, while the saved file still has every message.",
        "Your ledger's token counts match the usage fields in the raw response.",
      ],
      stretch: "Implement the same loop with the other provider's SDK and note every field name that differs.",
    },
  },
  "2.2": {
    realLife: {
      title: "Live cricket commentary vs the next morning's newspaper",
      story:
        "Following a match on radio, you hear each ball as it happens and never feel you are waiting, even though the innings takes hours. The newspaper gives you the full scorecard, but only after it's all over. If the radio signal drops in the 18th over, you need to know you missed the end rather than assume the last thing you heard was the final score.",
      mapping: [
        { everyday: "Hearing each ball as it's bowled", concept: "Streaming tokens as they are generated" },
        { everyday: "Waiting for the morning paper", concept: "A non-streaming call that returns the whole answer at once" },
        { everyday: "How soon the first ball is described", concept: "Time to first token, what users feel as speed" },
        { everyday: "The signal dropping in the 18th over", concept: "Dropped streams: detect incomplete output instead of saving it as final" },
      ],
    },
    build: {
      title: "A streaming endpoint that survives disconnects",
      goal: "A FastAPI server-sent-events endpoint that streams model output to a browser or curl, records the full message, and marks interrupted or truncated answers correctly.",
      minutes: 75,
      stack: ["Python", "fastapi", "openai or anthropic SDK (async)", "curl"],
      steps: [
        "Create `GET /ask?q=...` returning a `StreamingResponse` with `text/event-stream`, forwarding each text delta as an SSE `data:` line.",
        "Accumulate the deltas into a buffer and, when the stream ends, save `{text, finish_reason, usage, ttft_ms, total_ms}` to a JSONL log.",
        "Detect client disconnect with `request.is_disconnected()`, stop pulling from the model, and save the record with status `cancelled`.",
        "Set a low max tokens on one request and confirm the record shows a length stop reason and status `truncated`.",
        "Test with `curl -N` and kill curl halfway to trigger cancellation.",
      ],
      starter:
        "import json, time\nfrom fastapi import FastAPI, Request\nfrom fastapi.responses import StreamingResponse\nfrom openai import AsyncOpenAI\n\napp = FastAPI()\nclient = AsyncOpenAI()\n\n@app.get(\"/ask\")\nasync def ask(q: str, request: Request):\n    async def gen():\n        t0 = time.perf_counter(); buf = []; status = \"complete\"\n        stream = await client.chat.completions.create(\n            model=\"gpt-4o-mini\", stream=True, max_tokens=400,\n            messages=[{\"role\": \"user\", \"content\": q}])\n        async for chunk in stream:\n            if await request.is_disconnected():\n                status = \"cancelled\"; break\n            # TODO: get delta text, append to buf, yield f\"data: {json.dumps(text)}\\n\\n\"\n            # TODO: capture finish_reason; set status=\"truncated\" if it is \"length\"\n        # TODO: append a record with text, status, ttft_ms, total_ms to log.jsonl\n    return StreamingResponse(gen(), media_type=\"text/event-stream\")",
      checks: [
        "`curl -N` shows text arriving in pieces, with the first piece well under the total time.",
        "Killing curl mid-answer produces a log record with status `cancelled` and partial text.",
        "A tiny max tokens produces status `truncated`, never `complete`.",
      ],
      stretch: "Add a 'stop generating' button in a 20-line HTML page using EventSource.",
    },
  },
  "2.3": {
    realLife: {
      title: "A universal travel adapter",
      story:
        "A universal adapter lets you plug your laptop charger into sockets in Delhi, London and Singapore without thinking about pin shapes. It's convenient, but when the laptop stops charging in a hotel you need to know whether the adapter, the socket or the charger is at fault, so you keep in mind what is happening inside it.",
      mapping: [
        { everyday: "One adapter, many socket shapes", concept: "One chat model interface across providers" },
        { everyday: "Charger, adapter, socket chained together", concept: "prompt | model | parser composed as runnables" },
        { everyday: "Not knowing which part failed", concept: "Hidden behaviour: you still need to see the raw API call" },
        { everyday: "Where it breaks: an adapter doesn't change voltage, and LangChain doesn't make two providers behave identically", concept: "Provider differences leak through the abstraction" },
      ],
    },
    build: {
      title: "A provider-swappable ticket triager in LangChain, with the raw calls exposed",
      goal: "A LangChain chain that turns a support ticket into a category and a reply draft, runs on two providers by changing config, and logs the exact request each one sends.",
      minutes: 60,
      stack: ["Python", "langchain", "langchain-openai", "langchain-anthropic"],
      steps: [
        "Build a `ChatPromptTemplate` with a system message and a `{ticket}` variable, a chat model from `init_chat_model`, and a `StrOutputParser`; compose them with `|`.",
        "Add a second chain that drafts a reply and combine both with `RunnableParallel` so one call returns `{category, reply}`.",
        "Read the provider and model from an environment variable and run the same 5 tickets on two providers.",
        "Turn on `set_debug(True)` (or a callback handler) and copy the exact messages each provider received into a notes file.",
        "Use `.stream()` on the reply chain and print tokens as they arrive.",
      ],
      starter:
        "import os\nfrom langchain.chat_models import init_chat_model\nfrom langchain_core.prompts import ChatPromptTemplate\nfrom langchain_core.output_parsers import StrOutputParser\nfrom langchain_core.runnables import RunnableParallel\n\nmodel = init_chat_model(os.getenv(\"MODEL\", \"openai:gpt-4o-mini\"), temperature=0)\n\ncategorise = ChatPromptTemplate.from_messages([\n    (\"system\", \"Classify the ticket as billing, delivery, account or other. Reply with one word.\"),\n    (\"human\", \"{ticket}\"),\n]) | model | StrOutputParser()\n\n# TODO: reply chain with its own prompt\n# TODO: both = RunnableParallel(category=categorise, reply=reply)\n# TODO: both.batch([{\"ticket\": t} for t in TICKETS])",
      checks: [
        "Switching `MODEL` between two providers changes nothing else in the code and both runs succeed.",
        "Your notes show the actual messages sent, including the system prompt, for both providers.",
        "Streaming prints the reply incrementally rather than all at once.",
      ],
      stretch: "Find one behaviour that differs between providers on the same chain (format, length, refusal) and explain it.",
    },
  },
  "2.4": {
    realLife: {
      title: "A bank's account-opening form with boxes",
      story:
        "A bank doesn't ask you to write a letter about yourself; it hands you a form with one box per letter for your PAN, a tick box for account type and a date field in DD/MM/YYYY. A form filled neatly can still be wrong (a PAN that belongs to someone else), so the clerk checks it against records, sends it back for correction once, and rejects it if it's still wrong.",
      mapping: [
        { everyday: "Boxes, tick options and a fixed date format", concept: "A schema with types, enums and required fields" },
        { everyday: "A form that physically can't take letters in the PIN box", concept: "Constrained decoding: the output must match the schema" },
        { everyday: "Neat but wrong PAN", concept: "Valid is not correct: check values, not only shape" },
        { everyday: "Sent back once, then rejected", concept: "Validate, retry with the error, or reject" },
      ],
    },
    build: {
      title: "An invoice extractor with business-rule validation and repair",
      goal: "A script that extracts typed invoice data with schema-enforced output, checks it against business rules, retries once with the error message, and rejects what still fails.",
      minutes: 75,
      stack: ["Python", "pydantic", "openai or anthropic SDK", "langchain (for one comparison run)"],
      steps: [
        "Define `Invoice` and `LineItem` Pydantic models with an enum for currency, a GSTIN pattern, optional due date, and a list of line items.",
        "Add a model validator that checks the sum of line items equals the total within 1 unit, and that due date is after invoice date.",
        "Extract from 8 sample invoices (write them as text, two with deliberate inconsistencies) using native structured output (`client.beta.chat.completions.parse` or the provider's equivalent; check current docs).",
        "On validation failure, send one retry that includes the validation error text; if it fails again, write the case to `rejected.jsonl` with the reason.",
        "Run the same extraction through LangChain's `with_structured_output` and compare results.",
      ],
      starter:
        "from datetime import date\nfrom enum import Enum\nfrom pydantic import BaseModel, Field, model_validator\n\nclass Currency(str, Enum):\n    INR = \"INR\"; USD = \"USD\"; EUR = \"EUR\"\n\nclass LineItem(BaseModel):\n    description: str\n    quantity: float = Field(gt=0)\n    unit_price: float = Field(ge=0)\n\nclass Invoice(BaseModel):\n    vendor: str\n    gstin: str | None = Field(default=None, pattern=r\"^\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$\")\n    invoice_date: date\n    due_date: date | None = None\n    currency: Currency\n    items: list[LineItem]\n    total: float\n\n    @model_validator(mode=\"after\")\n    def check_totals(self):\n        # TODO: raise ValueError if sum(qty*price) differs from total by > 1\n        # TODO: raise ValueError if due_date <= invoice_date\n        return self",
      checks: [
        "Every output parses into `Invoice` without any manual JSON fixing.",
        "Both deliberately inconsistent invoices are caught by your validator, not by the schema.",
        "Your log shows at least one case fixed by the retry and at least one rejected with a reason.",
      ],
      stretch: "Measure how often the model invents a GSTIN when none is present, and change the schema or prompt to stop it.",
    },
  },
  "2.5": {
    realLife: {
      title: "A hotel concierge with a phone and a list of numbers",
      story:
        "You ask the concierge, 'Can you book a table for four tonight and check if the airport cab is confirmed?' He doesn't cook or drive; he picks the right numbers from his list, says exactly what to ask, and the restaurant and cab desk do the work. He reads both replies (sometimes 'fully booked') and then gives you one answer that covers both.",
      mapping: [
        { everyday: "Concierge choosing which number to call and what to say", concept: "The model choosing a tool and writing arguments" },
        { everyday: "Restaurant and cab desk doing the actual work", concept: "Your code executing the function" },
        { everyday: "Two calls made for one request", concept: "Parallel tool calls in one turn" },
        { everyday: "'Fully booked' passed back, not hidden", concept: "Returning tool errors to the model with the call id" },
      ],
    },
    build: {
      title: "A raw tool-calling loop over a small SQLite shop database",
      goal: "A hand-written tool loop where the model answers questions about orders and stock by calling three real functions over SQLite, handling parallel calls, chained calls and tool errors.",
      minutes: 90,
      stack: ["Python", "sqlite3", "openai or anthropic SDK", "langchain (for comparison)"],
      steps: [
        "Create a SQLite database with `orders` and `products` tables and 20 rows each.",
        "Define three tools with JSON schemas: `get_order(order_id)`, `check_stock(sku)` and `list_orders_for_email(email)`.",
        "Write the loop: send messages plus tools, run every tool call in the response, append each result with its call id, and repeat until the model returns text; cap at 6 iterations.",
        "Return errors as tool results (for example `{\"error\": \"order not found\"}`) instead of raising, and catch bad arguments.",
        "Test three questions: one needing two parallel calls, one needing a chained call (email to orders to stock), and one with a non-existent order id.",
        "Rebuild the tools with LangChain's `@tool` decorator and `bind_tools`, and print the tool schema it generates to compare with yours.",
      ],
      starter:
        "import json, sqlite3\nfrom openai import OpenAI\nclient = OpenAI()\ndb = sqlite3.connect(\"shop.db\")\n\ndef get_order(order_id: str) -> dict:\n    row = db.execute(\"SELECT id, sku, status FROM orders WHERE id = ?\", (order_id,)).fetchone()\n    return {\"id\": row[0], \"sku\": row[1], \"status\": row[2]} if row else {\"error\": \"order not found\"}\n\nTOOLS = [\n    {\"type\": \"function\", \"function\": {\"name\": \"get_order\", \"description\": \"Look up one order by its id, e.g. A-1192.\",\n     \"parameters\": {\"type\": \"object\", \"properties\": {\"order_id\": {\"type\": \"string\"}}, \"required\": [\"order_id\"]}}},\n    # TODO: check_stock, list_orders_for_email\n]\nFUNCS = {\"get_order\": get_order}\n\ndef run(question: str) -> str:\n    messages = [{\"role\": \"user\", \"content\": question}]\n    for _ in range(6):\n        resp = client.chat.completions.create(model=\"gpt-4o-mini\", messages=messages, tools=TOOLS)\n        msg = resp.choices[0].message\n        # TODO: if no tool_calls, return msg.content\n        # TODO: append msg, run each call (json.loads arguments, catch errors),\n        #       append {\"role\": \"tool\", \"tool_call_id\": call.id, \"content\": json.dumps(result)}\n    return \"Gave up after 6 steps\"",
      checks: [
        "The parallel question shows two tool calls in a single model response in your printed log.",
        "The chained question needs at least two model round trips and gets the right stock figure.",
        "The bad order id produces a polite answer, not a Python exception.",
      ],
      stretch: "Add a tool that sometimes raises after 2 seconds and make the loop survive it with a timeout.",
      studio: "react-agent",
    },
  },
  "2.6": {
    realLife: {
      title: "The buttons on a hospital lift panel",
      story:
        "A good hospital lift has clearly labelled floors (OPD 1, Radiology 3, ICU 5), one button per destination, and a key-locked switch for the operation-theatre floor. A bad one has buttons labelled 'Misc' and 'Other floors', two buttons that both say 'Ward', and an unlocked OT button any visitor can press after being told to by a stranger.",
      mapping: [
        { everyday: "Clear floor labels", concept: "Precise tool names and descriptions the model reads to choose" },
        { everyday: "Two buttons both labelled 'Ward'", concept: "Overlapping tools that confuse selection" },
        { everyday: "Key-locked OT floor", concept: "Permission and confirmation checks in code for destructive actions" },
        { everyday: "A visitor pressing whatever a stranger told them", concept: "Arguments are untrusted, even when the model wrote them" },
      ],
    },
    build: {
      title: "Redesign a messy tool set and measure selection accuracy",
      goal: "A tool-selection test harness that compares a vague tool set against your redesigned one on 20 requests, plus a guard layer that blocks unsafe arguments.",
      minutes: 75,
      stack: ["Python", "openai or anthropic SDK", "pydantic"],
      steps: [
        "Start from a deliberately bad set of 6 tools for a gym-membership bot (vague names like `handle_member`, overlapping `update` and `edit`, free-form `data: object`).",
        "Redesign into 4 tools with specific names, one-line descriptions saying when to use each, strongly typed parameters, and enums where values are fixed.",
        "Write 20 user requests with the expected tool name, and run both sets, recording which tool the model picks on the first call.",
        "Add a guard function that validates arguments with Pydantic, checks the member id belongs to the logged-in user, and requires `confirm=true` for `cancel_membership`.",
        "Return helpful error messages from the guard (for example 'membership_id must look like GYM-1234') and check that the model corrects itself on retry.",
      ],
      checks: [
        "Selection accuracy on your 20 requests is clearly higher for the redesigned set.",
        "A request to cancel another member's plan is blocked by code even if the model calls the tool.",
        "At least one malformed argument is fixed by the model after reading your error message.",
      ],
      stretch: "Add 15 near-duplicate tools to the redesigned set and measure how much selection accuracy drops.",
      studio: "guarded-agent",
    },
  },
  "2.7": {
    realLife: {
      title: "A municipal grievance desk routing complaints",
      story:
        "A city's complaint desk reads each complaint and sends it down a fixed path: potholes go to roads, water leaks to the water board, anything about a dog bite to health and roads both, at the same time. Each department writes its own response, and the desk stitches them into one reply letter. The desk follows the rulebook; it never decides to invent a new department.",
      mapping: [
        { everyday: "Reading the complaint and choosing a department", concept: "A router step (classification call)" },
        { everyday: "Sending one complaint to two departments at once", concept: "Fan-out to parallel calls, then fan-in" },
        { everyday: "Stitching responses into one letter", concept: "A final combining step in code or a model call" },
        { everyday: "Following the rulebook, never inventing departments", concept: "A workflow: code decides the path, unlike an agent" },
      ],
    },
    build: {
      title: "A route, fan-out and merge workflow for customer emails",
      goal: "A workflow that classifies an email, runs only the relevant specialist steps in parallel, validates their outputs and merges them into one reply, built first in plain Python and then with LangChain runnables.",
      minutes: 90,
      stack: ["Python", "asyncio", "openai or anthropic SDK", "langchain"],
      steps: [
        "Write a router call that labels an email with one or more of: refund, delivery, technical, and extracts the order id (structured output).",
        "Write one specialist function per label that takes the email and returns a short answer paragraph; for refund, also check eligibility with plain code (order date within 30 days).",
        "Run the selected specialists concurrently with `asyncio.gather`, then a final merge call that writes one polite reply.",
        "Log each step's input, output and duration so you can see exactly which step produced a bad sentence.",
        "Rebuild the same flow with `RunnableBranch` or `RunnableLambda` routing and `RunnableParallel`, and compare lines of code and how easy each is to debug.",
      ],
      checks: [
        "An email mentioning both a late delivery and a refund triggers exactly two specialists running in parallel (overlapping timestamps in your log).",
        "Refund eligibility is decided by code, and changing the order date flips the answer without any prompt change.",
        "Both implementations produce equivalent replies on the same 5 emails.",
      ],
      stretch: "Add a check step that rejects a merged reply over 150 words and retries once with feedback.",
    },
  },
  "2.8": {
    realLife: {
      title: "Toll plaza lanes on a highway",
      story:
        "One toll booth processing cars one at a time builds a queue a kilometre long. Opening ten lanes clears the traffic far faster, but the highway authority only lets so many cars through per minute, so opening fifty lanes just jams the exit. Trucks with a monthly pass can go through a separate slow lane at half the toll if they don't mind waiting.",
      mapping: [
        { everyday: "One booth, one car at a time", concept: "Sequential API calls" },
        { everyday: "Ten lanes open together", concept: "Concurrent async calls" },
        { everyday: "A cap on cars per minute at the exit", concept: "Rate limits; cap concurrency with a semaphore" },
        { everyday: "Discounted slow lane for monthly pass trucks", concept: "Provider batch APIs: cheaper, results later" },
      ],
    },
    build: {
      title: "A throughput tuner for 500 classification calls",
      goal: "A script that classifies 500 short texts with tunable concurrency and a token-rate limiter, finds the fastest safe setting, and compares cost against a batch API job.",
      minutes: 75,
      stack: ["Python", "asyncio", "openai or anthropic async SDK"],
      steps: [
        "Prepare 500 short texts (for example app-store reviews) in a JSONL file.",
        "Write an async worker that classifies one text, behind an `asyncio.Semaphore(n)`, recording latency and any 429 errors.",
        "Run with n = 1 (on 50 items only), 8, 32 and 64, and record wall time, error count and p95 latency.",
        "Add a simple tokens-per-minute limiter that sleeps when you're about to exceed a budget you set, and rerun n = 64.",
        "Submit the same 500 items as a provider batch job, note turnaround time and the cost difference.",
      ],
      starter:
        "import asyncio, json, time\nfrom openai import AsyncOpenAI\nclient = AsyncOpenAI()\n\nasync def classify(text: str, sem: asyncio.Semaphore, stats: dict) -> str:\n    async with sem:\n        t0 = time.perf_counter()\n        try:\n            r = await client.chat.completions.create(model=\"gpt-4o-mini\", max_tokens=3,\n                messages=[{\"role\": \"user\", \"content\": f\"positive, negative or neutral? {text}\"}])\n            return r.choices[0].message.content\n        except Exception as e:\n            # TODO: count 429s separately in stats\n            raise\n        finally:\n            stats[\"lat\"].append(time.perf_counter() - t0)\n\nasync def run(texts: list[str], n: int) -> None:\n    sem, stats = asyncio.Semaphore(n), {\"lat\": [], \"429\": 0}\n    t0 = time.perf_counter()\n    # TODO: gather with return_exceptions=True; print wall time, errors, p95 latency\n    ...",
      checks: [
        "Your results table shows wall time dropping sharply from n = 1 to n = 8.",
        "You can point to a concurrency level beyond which errors or p95 latency rise without real speed gains.",
        "The batch job's cost per item is lower than the live run's, and you recorded how long it took.",
      ],
      stretch: "Add retry with backoff for 429s so the n = 64 run finishes with zero lost items.",
      sim: "load-test",
    },
  },
  "2.9": {
    realLife: {
      title: "Paying with UPI at a busy shop",
      story:
        "At a crowded shop the UPI payment spins. If it says 'server busy', you wait a few seconds and try again, and so does everyone else, so you wait a slightly random time to avoid all hitting retry together. If it says 'incorrect PIN' three times, retrying won't help. If the bank's app stays down, you pay with a card instead, which works differently (and maybe has a fee), and if nothing works you leave the shopkeeper a clear IOU rather than walking off.",
      mapping: [
        { everyday: "'Server busy', wait and try again", concept: "Retry transient errors: 429, 5xx, timeouts" },
        { everyday: "Waiting a slightly random time", concept: "Exponential backoff with jitter" },
        { everyday: "Wrong PIN: retrying won't help", concept: "Fail fast on 400, 401, 403 and context overflow" },
        { everyday: "Paying by card instead", concept: "A fallback model or provider that may behave differently" },
      ],
    },
    build: {
      title: "A resilient LLM call wrapper tested against a fault injector",
      goal: "A `call_llm` wrapper with timeouts, classified retries, backoff with jitter and a fallback model, verified with a fake client that injects every failure type.",
      minutes: 90,
      stack: ["Python", "openai or anthropic SDK", "pytest", "tenacity (optional)"],
      steps: [
        "Write a fake client that, based on a scripted list, raises a timeout, a 429 with a retry-after header, a 503, a 401, a 400 'context too long', or returns JSON missing a field.",
        "Write `classify_error(e)` returning `retry`, `fail` or `shrink_and_retry`.",
        "Implement `call_llm` with a per-attempt timeout, at most 4 attempts, exponential backoff with full jitter capped at 20 s, and respect for retry-after when present.",
        "After primary attempts are exhausted on retryable errors, switch to a fallback model and tag the result with `served_by`.",
        "Write a pytest case for each failure type asserting the number of attempts, whether the fallback was used, and total time (patch `sleep` to keep tests fast).",
      ],
      starter:
        "import random\nfrom dataclasses import dataclass\n\nclass RateLimited(Exception):\n    def __init__(self, retry_after: float | None = None): self.retry_after = retry_after\nclass ServerError(Exception): ...\nclass AuthError(Exception): ...\nclass ContextTooLong(Exception): ...\n\n@dataclass\nclass Result:\n    text: str\n    served_by: str\n    attempts: int\n\ndef classify_error(e: Exception) -> str:\n    # TODO: RateLimited/ServerError/TimeoutError -> \"retry\"; AuthError -> \"fail\"; ContextTooLong -> \"shrink_and_retry\"\n    ...\n\ndef backoff(attempt: int, base: float = 0.5, cap: float = 20.0) -> float:\n    return random.uniform(0, min(cap, base * 2 ** attempt))\n\ndef call_llm(prompt: str, primary, fallback, sleep=__import__(\"time\").sleep) -> Result:\n    # TODO: loop attempts on primary, honour retry_after, then try fallback once\n    ...",
      checks: [
        "A 401 fails after exactly one attempt and never touches the fallback.",
        "A scripted sequence of 503, 503, success returns on attempt 3 from the primary.",
        "Four 429s in a row end with `served_by` equal to the fallback model.",
        "All tests run in under 2 seconds because sleep is patched.",
      ],
      stretch: "Add a circuit breaker that skips the primary for 60 s after 5 consecutive failures.",
      studio: "router-cascade",
    },
  },
  "2.10": {
    realLife: {
      title: "A food-delivery order tracker",
      story:
        "When your biryani is late, the delivery app shows every stage with a time: order accepted 8:02, restaurant started 8:05, ready 8:31, rider picked up 8:40, delivered 8:58. Support can see at a glance that the kitchen took 26 minutes, not the rider. Each order also carries a bill breakdown, so the company knows which restaurants cost it the most in refunds.",
      mapping: [
        { everyday: "One order id carrying all the stages", concept: "A trace id shared by every step" },
        { everyday: "Each stage with start and end times", concept: "Spans for each model call and tool call" },
        { everyday: "Seeing the kitchen was the slow part", concept: "Finding the slow or failing step from data, not guesses" },
        { everyday: "Bill breakdown per order", concept: "Per-call tokens and cost rolled up per request" },
      ],
    },
    build: {
      title: "Trace a multi-step workflow and answer three questions from logs alone",
      goal: "Structured JSON logs with trace and span ids around a multi-step LLM workflow, plus a small report script that computes cost, latency and failures per request.",
      minutes: 75,
      stack: ["Python", "structlog or logging with JSON", "openai or anthropic SDK", "langchain callbacks (optional)", "pandas"],
      steps: [
        "Write a `span(name, trace_id)` context manager that logs start time, duration, status, and any attributes you attach (model, tokens in/out, cost, retries, tool name) as one JSON line.",
        "Wrap every model call and tool call of your 2.7 workflow (or 2.5 loop) in a span under one trace id per user request.",
        "Run 20 requests, including two that you force to fail in a tool.",
        "Write `report.py` that reads the JSONL and prints per trace: total cost, total time, number of model calls, slowest span and any failed span.",
        "Add a LangChain callback handler (or a tracing tool such as Langfuse or LangSmith) to the LangChain version and compare its view with your own logs.",
      ],
      starter:
        "import json, time, uuid\nfrom contextlib import contextmanager\n\nLOG = open(\"trace.jsonl\", \"a\")\n\n@contextmanager\ndef span(name: str, trace_id: str, parent: str | None = None, **attrs):\n    span_id = uuid.uuid4().hex[:8]\n    t0 = time.perf_counter()\n    record = {\"trace\": trace_id, \"span\": span_id, \"parent\": parent, \"name\": name, **attrs}\n    try:\n        yield record  # caller adds tokens, cost, etc. to record\n        record[\"status\"] = \"ok\"\n    except Exception as e:\n        record[\"status\"] = \"error\"; record[\"error\"] = repr(e)\n        raise\n    finally:\n        record[\"ms\"] = round((time.perf_counter() - t0) * 1000, 1)\n        # TODO: write json line and flush\n\n# TODO: report.py groups by trace and prints cost, time, n_model_calls, slowest, failures",
      checks: [
        "For any request you can say its total cost and slowest step using only `report.py` output.",
        "The two forced failures show up with the failing span's name and error.",
        "Summed span costs match your provider dashboard for the run within a few percent.",
      ],
      stretch: "Export the spans with OpenTelemetry to a local Jaeger container and view one trace as a waterfall.",
    },
  },
  "2.11": {
    realLife: {
      title: "Choosing how to run a wedding: planner, family, or a checklist app",
      story:
        "One family hires a full-service wedding planner who handles venues and vendors their own way. Another runs it themselves with a big shared spreadsheet that tracks who is doing what and whether each step is done. A third uses a planner only for the guest list and does the rest by hand. None is right for everyone; it depends on how much control the family wants and how unusual the wedding is.",
      mapping: [
        { everyday: "Full-service planner with their own way of doing things", concept: "A framework such as LangChain or LlamaIndex with its abstractions" },
        { everyday: "The shared spreadsheet tracking each step's state", concept: "A graph or state machine such as LangGraph" },
        { everyday: "Planner only for the guest list", concept: "A specialised tool for one part, such as LlamaIndex for data loading" },
        { everyday: "Doing it all yourself", concept: "Raw SDK plus your own thin layer" },
      ],
    },
    build: {
      title: "A draft-review loop in LangGraph with a pause for approval",
      goal: "A LangGraph state machine that drafts a reply, scores it, revises up to twice, then pauses for human approval, compared with a plain-Python version on code size and control.",
      minutes: 90,
      stack: ["Python", "langgraph", "openai or anthropic SDK", "dspy (optional)"],
      steps: [
        "Define a typed state with `request`, `draft`, `score`, `feedback` and `revisions`.",
        "Add nodes `draft`, `review` (returns a 1-5 score and feedback via structured output) and `revise`, with a conditional edge looping back while score < 4 and revisions < 2.",
        "Compile with a checkpointer and an interrupt before a `send` node; run it, inspect the paused state, then resume with an approval.",
        "Write the same flow in plain Python with a while loop and an `input()` prompt for approval.",
        "Fill a comparison table: lines of code, how to inspect state mid-run, how to resume after a crash, and what you'd choose for this app.",
      ],
      checks: [
        "The graph stops at the approval step and resumes from the saved state, without re-running earlier nodes.",
        "A deliberately poor first draft triggers at least one revision loop, visible in the state history.",
        "Your table names a concrete reason to pick one approach for this app.",
      ],
      stretch: "Express the review step as a DSPy signature and compare its prompt with the one you wrote.",
    },
  },
  "2.12": {
    realLife: {
      title: "A good travel desk at a company office",
      story:
        "A company travel desk chats with you, remembers that you prefer aisle seats from earlier in the conversation, checks live flight prices and the hotel booking system, and tells you progress as it goes rather than going silent for ten minutes. When the airline site is down it retries or tries another channel, and at month end it can tell finance exactly what each trip cost to arrange.",
      mapping: [
        { everyday: "Talking with you and remembering your earlier preferences", concept: "Chat loop with explicit history" },
        { everyday: "Telling you progress instead of going silent", concept: "Streaming responses" },
        { everyday: "Checking flights and hotels in live systems", concept: "Real tools with validated arguments, in parallel when possible" },
        { everyday: "Retrying when the airline site is down; a cost report for finance", concept: "Retries, fallbacks and per-turn usage tracking" },
      ],
    },
    build: {
      title: "First milestone: a streaming chat loop with one real tool and a turn log",
      goal: "A terminal assistant that streams replies, keeps history, calls one real API as a tool with argument validation, and writes a per-turn log of tokens, latency and tool calls.",
      minutes: 120,
      stack: ["Python", "langchain", "openai or anthropic SDK", "httpx", "pydantic"],
      steps: [
        "Pick your tools for the whole project (for example weather via Open-Meteo, currency via Frankfurter, and your Level 0 service) and write their schemas in one file.",
        "Build the chat loop with a system prompt and explicit history, streaming replies token by token.",
        "Implement the first tool with Pydantic argument validation and a 5-second timeout; return errors to the model as tool results.",
        "Log one JSON line per turn: input and output tokens, latency, tool calls with arguments, and estimated cost.",
        "Save the raw API messages for one complete tool round trip to `docs/sample-trace.json`.",
        "List the remaining milestones (second and third tools, parallel calls, structured output, retries, fallback) in the README.",
      ],
      checks: [
        "A question needing the tool streams a final answer that uses the tool's real data.",
        "An invalid argument (for example an unknown city) produces a graceful answer, and the log shows the error.",
        "`docs/sample-trace.json` contains the tool call id in both the request and the tool result message.",
      ],
      stretch: "Add a second tool now and get the model to call both in parallel in one turn.",
      studio: "react-agent",
    },
  },
};
