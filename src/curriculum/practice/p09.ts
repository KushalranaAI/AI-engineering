import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "9.1": {
    realLife: {
      title: "Planning a family trip to Goa",
      story:
        "Before anyone books anything, the family agrees on the basics: eight people, five days in December, a budget of 80,000 rupees, grandma can't do long road journeys. Only then do they compare a flight, an overnight train and driving. The train is cheap and fine for most, so they book that and keep the option of a short flight for grandma. Nobody starts by booking a luxury villa because a cousin loved it once.",
      mapping: [
        { everyday: "People, dates, budget and grandma's limits", concept: "Requirements: use case, traffic, latency, quality, privacy and cost" },
        { everyday: "Flight vs train vs driving", concept: "Prompting vs RAG vs agents vs fine-tuning, chosen by the requirements" },
        { everyday: "Fast, cheap or comfortable: pick a balance", concept: "The quality-latency-cost triangle" },
        { everyday: "Booking the train first, upgrading only for grandma", concept: "Baseline first, then add machinery where measurement says it's needed" },
      ],
    },
    build: {
      title: "A requirements file and a measured baseline",
      goal: "A requirements file for a real brief and the simplest baseline that could meet it, measured on 20 questions so the next design step is argued with numbers.",
      minutes: 90,
      stack: ["Python", "openai or anthropic SDK", "PyYAML"],
      steps: [
        "Pick a brief: a Q&A assistant over your college's or company's 30-50 page handbook. Write requirements.yaml with users, daily volume, p95 latency target, quality target, privacy rules and a monthly budget.",
        "Build the simplest baseline: put the whole handbook in the prompt (long context), no retrieval, no tools.",
        "Write 20 test questions with expected answers and run the baseline, recording correctness, latency and tokens per call.",
        "Project monthly cost at your stated volume and compare quality, p95 latency and cost against requirements.yaml.",
        "Write a one-paragraph decision: keep the baseline, add RAG, or something else, citing the numbers that forced the choice.",
      ],
      starter:
        "# requirements.yaml\n# users: 300 staff\n# requests_per_day: 400\n# latency_p95_s: 6\n# min_correct: 0.85\n# privacy: handbook may go to the provider; no employee data\n# monthly_budget_usd: 50\nimport yaml, time\nREQ = yaml.safe_load(open('requirements.yaml'))\nHANDBOOK = open('handbook.txt').read()\n\ndef baseline(q: str):\n    t = time.time()\n    # TODO: one call with HANDBOOK + q; return answer, latency, usage\n    ...\n\n# TODO: run 20 questions, compute correct rate, p95 latency, monthly cost\n# TODO: print each metric next to its requirement with PASS/FAIL",
      checks: [
        "Every requirement in the YAML has a measured number next to it.",
        "Your decision paragraph names at least one option you rejected and why.",
        "If the baseline already meets every target, you say so and stop instead of adding RAG for its own sake.",
      ],
      stretch: "Double the handbook size and re-run: at what size does the baseline break one of the targets?",
      sim: "token-budget",
    },
  },
  "9.2": {
    realLife: {
      title: "A family doctor during a consultation",
      story:
        "A GP in Kolkata answers from what she knows by heart, the patient's file open on her desk, the reference books on her shelf, today's lab report she phones the lab for, and what she remembers from the patient's last visit. She doesn't memorise every drug interaction, and she doesn't read the whole shelf for every cough. Each kind of fact has a place it should come from, and the receptionist only hands her files of her own patients.",
      mapping: [
        { everyday: "What the doctor knows by heart", concept: "Knowledge in the model's weights" },
        { everyday: "The patient's file open on the desk", concept: "Context pinned in the prompt" },
        { everyday: "Reference books on the shelf", concept: "A retrieval index, searched on demand" },
        { everyday: "Phoning the lab for today's result", concept: "A live tool for fresh data, with memory for past visits and permissions on whose files she sees" },
      ],
    },
    build: {
      title: "One assistant, four homes for knowledge",
      goal: "An HR-style assistant that pins a small policy in the prompt, retrieves from an index, calls a live tool and reads per-user memory, with tests that each question type uses the right source.",
      minutes: 120,
      stack: ["Python", "chromadb", "openai (tool calling)", "pytest"],
      steps: [
        "Pin a short code of conduct (under 500 words) in the system prompt.",
        "Index 40 policy chunks with metadata country and source, and filter retrieval by the user's country.",
        "Add a tool get_holidays(country, month) backed by a small JSON file standing in for a live API, and a tool get_leave_balance() that reads only the logged-in user's record.",
        "Keep per-user memory (a dict of preferences such as language) and add it to the prompt for that user only.",
        "Log which sources each answer used, and write tests: a holiday question calls get_holidays, a policy question retrieves only the user's country, and every answer lists its sources.",
      ],
      checks: [
        "Each of your 10 test questions uses the source you predicted, as shown in the log.",
        "A user in India never receives a chunk tagged with another country's policy.",
        "Changing the holiday JSON changes the answer immediately, with no re-indexing.",
      ],
      stretch: "Add hybrid search (BM25 plus vectors) only for questions that mention policy codes, and measure whether it helps those questions.",
      studio: "rag-pipeline",
    },
  },
  "9.3": {
    realLife: {
      title: "A company's travel desk",
      story:
        "Employees at a Gurugram firm never book flights themselves. They tell the travel desk where and when, and the desk picks an airline by route, budget grade and urgency, using one corporate card with spending limits. When a flight is cancelled, the desk rebooks on another airline, which may mean a worse seat or a stopover, and it tells the traveller so.",
      mapping: [
        { everyday: "Employees never call airlines directly", concept: "A gateway: the app never talks to a vendor SDK directly" },
        { everyday: "Picking an airline by route, grade and urgency", concept: "Routing rules by task, context length, cost, latency or risk" },
        { everyday: "Rebooking on another airline after a cancellation", concept: "Fallback to another provider, with a change in quality you should log and test" },
        { everyday: "One corporate card with limits", concept: "Central keys, rate limits and spend tracking" },
      ],
    },
    build: {
      title: "A small model gateway with routing, a cascade and fallback",
      goal: "A gateway module with a single complete() function that routes by task from config, escalates low-confidence answers, fails over on errors and tracks spend per caller.",
      minutes: 90,
      stack: ["Python", "litellm", "PyYAML"],
      steps: [
        "Write routes.yaml mapping tasks (classify, faq, dispute) to a primary model, a fallback model and a per-call token limit.",
        "Implement complete(task, messages, caller) that reads the route, calls the primary, and on timeout or error calls the fallback, recording which model actually served.",
        "For the faq task, add a cascade: the small model answers with a confidence field (0-1) in JSON; below 0.7, escalate to the strong model.",
        "Track tokens and estimated cost per caller in a dict and refuse calls once a caller passes a daily budget.",
        "Run 50 mixed requests, force the primary to fail for 10 of them (for example with a bad model name), and print served-by counts, escalation rate and spend.",
      ],
      starter:
        "import yaml, litellm\nROUTES = yaml.safe_load(open('routes.yaml'))\nSPEND: dict[str, float] = {}\n\ndef call(model, messages, max_tokens):\n    return litellm.completion(model=model, messages=messages,\n                              max_tokens=max_tokens, timeout=20)\n\ndef complete(task: str, messages: list, caller: str) -> dict:\n    route = ROUTES[task]\n    # TODO: refuse if SPEND.get(caller, 0) > route['daily_budget_usd']\n    try:\n        r = call(route['primary'], messages, route['max_tokens']); served = route['primary']\n    except Exception:\n        r = call(route['fallback'], messages, route['max_tokens']); served = route['fallback']\n    # TODO: for task == 'faq', parse confidence and escalate below 0.7\n    # TODO: add litellm.completion_cost(r) to SPEND[caller]\n    return {'text': r.choices[0].message.content, 'served_by': served}",
      checks: [
        "Changing a model name in routes.yaml changes which model serves that task with no code edit.",
        "The forced-failure requests are all answered by the fallback and the log says so.",
        "You can report the cascade's escalation rate and what it saved compared with sending everything to the strong model.",
      ],
      stretch: "Run your 7.x eval set through primary and fallback separately to quantify how much quality changes when you fail over.",
      studio: "router-cascade",
      sim: "router-cost",
    },
  },
  "9.4": {
    realLife: {
      title: "Waiting for a food delivery order",
      story:
        "Your order takes 35 minutes: 2 to be accepted, 15 to cook, 5 for a rider to arrive, 13 on the road. The live tracker makes the wait feel shorter even though nothing is faster. Good restaurants assign the rider while the food is cooking instead of after, and a quick dessert from the counter doesn't wait for the head chef. Hiring more chefs doesn't help if the real delay is the rider.",
      mapping: [
        { everyday: "Accepted, cooking, pickup, travel", concept: "A latency budget split by stage: retrieval, TTFT, generation, tools, network" },
        { everyday: "The live tracker", concept: "Streaming: perceived latency drops even when total time doesn't" },
        { everyday: "Assigning the rider while food cooks", concept: "Running independent steps in parallel" },
        { everyday: "The counter dessert that skips the head chef", concept: "Using a smaller model for steps that don't need a big one" },
      ],
    },
    build: {
      title: "Profile and speed up a RAG endpoint",
      goal: "A RAG endpoint instrumented per stage, with a before/after latency table after you parallelise, downsize one step and stream.",
      minutes: 90,
      stack: ["Python", "asyncio", "openai (async client)", "your Level 4 RAG app"],
      steps: [
        "Wrap each stage of your RAG request (query rewrite, embed, search, rerank, generation) in a timer and record time to first token separately from total time.",
        "Run 30 requests and print p50 and p95 for each stage: this is your latency budget.",
        "Run independent work concurrently with asyncio.gather (for example keyword and vector search, or fetching user profile and retrieval together).",
        "Move the query-rewrite step to a smaller, faster model and check on 20 eval questions that answer quality doesn't drop.",
        "Turn on streaming and record TTFT; print a before/after table for TTFT, total p50 and p95.",
      ],
      starter:
        "import time, asyncio, statistics\nfrom contextlib import contextmanager\nTIMES: dict[str, list[float]] = {}\n\n@contextmanager\ndef stage(name):\n    t = time.perf_counter()\n    yield\n    TIMES.setdefault(name, []).append(time.perf_counter() - t)\n\nasync def handle(q):\n    with stage('rewrite'):\n        q2 = await rewrite(q)            # TODO: try a smaller model here\n    with stage('retrieve'):\n        docs = await retrieve(q2)        # TODO: gather keyword + vector in parallel\n    with stage('generate'):\n        return await generate(q2, docs)  # TODO: stream and record TTFT\n\ndef report():\n    for k, v in TIMES.items():\n        print(k, round(statistics.median(v), 3), round(sorted(v)[int(0.95*len(v))-1], 3))",
      checks: [
        "You can name the single slowest stage from data before changing anything.",
        "Your after table shows a lower p50 or TTFT, with eval quality within a point or two of before.",
        "At least one change you tried did not help, and you can say why from the stage timings.",
      ],
      stretch: "Fire 20 concurrent requests and watch p95 climb; note whether the limit is your code, the vector DB or the provider's rate limit.",
      sim: "load-test",
    },
  },
  "9.5": {
    realLife: {
      title: "The enquiry counter at a railway station",
      story:
        "The clerk at a busy station's enquiry window keeps a printed sheet of the most-asked departure times and reads from it instead of checking the computer each time. 'When does the Rajdhani leave?' and 'Rajdhani timing?' get the same answer. But 'Rajdhani to Delhi' and 'Rajdhani from Delhi' must not, and PNR status is never answered from the sheet because it is personal and changes by the hour. When the new timetable starts, the sheet is thrown away.",
      mapping: [
        { everyday: "The printed sheet of common timings", concept: "An exact-response cache for repeated questions" },
        { everyday: "'Rajdhani timing?' getting the same answer", concept: "Semantic caching for differently worded questions" },
        { everyday: "'To Delhi' vs 'from Delhi' looking almost identical", concept: "False semantic hits: why thresholds and key design matter" },
        { everyday: "Never answering PNR status from the sheet; new timetable", concept: "Per-user data that must not be shared, and expiry or invalidation" },
      ],
    },
    build: {
      title: "Exact and semantic caches with measured hit rate and false hits",
      goal: "A cache layer in front of your assistant with exact and semantic caching, per-user scoping and TTLs, replayed against 200 logged queries to report hit rate, false hits and savings.",
      minutes: 90,
      stack: ["Python", "numpy", "an embedding model", "sqlite3 or a dict"],
      steps: [
        "Build an exact cache keyed on a hash of normalised question + model + prompt version, with a TTL.",
        "Build a semantic cache: embed the question, find the nearest cached question, and reuse its answer only above a similarity threshold. Never cache questions flagged as personal (they mention 'my', an order id or an account).",
        "Write 200 test queries with paraphrases and tricky near-misses ('refund within 7 days' vs 'refund after 7 days', 'to Delhi' vs 'from Delhi'), labelling which pairs truly share an answer.",
        "Replay them through the cache at three thresholds and count hits, false hits (served an answer for a different question) and tokens saved.",
        "Change the prompt version and confirm that old entries stop matching.",
      ],
      starter:
        "import hashlib, time, numpy as np\nEXACT: dict[str, tuple[str, float]] = {}\nSEM: list[tuple[np.ndarray, str, str]] = []  # (vec, question, answer)\nTTL = 3600\n\ndef key(q, model, prompt_v):\n    norm = ' '.join(q.lower().split())\n    return hashlib.sha256(f'{model}|{prompt_v}|{norm}'.encode()).hexdigest()\n\ndef lookup(q, vec, model, prompt_v, threshold=0.92):\n    k = key(q, model, prompt_v)\n    if k in EXACT and time.time() - EXACT[k][1] < TTL:\n        return EXACT[k][0], 'exact'\n    # TODO: cosine similarity against SEM; return best answer if >= threshold\n    # TODO: SEM entries must also match prompt_v\n    return None, 'miss'",
      checks: [
        "You report hit rate and false-hit rate for each of the three thresholds.",
        "No personal question is ever served from the cache.",
        "A prompt-version change drops the hit rate to zero until the cache refills.",
      ],
      stretch: "Turn on your provider's prompt (prefix) caching for the long system prompt and compare its saving with the response cache's.",
    },
  },
  "9.6": {
    realLife: {
      title: "A UPI payment when the bank's server is slow",
      story:
        "You pay a shopkeeper by UPI and the bank's server is struggling. The app waits a fixed time, then shows 'pending' instead of retrying blindly and charging you twice. If your bank keeps failing, the app suggests another linked account. Small payments go through with a PIN, and large ones need extra confirmation. The shop still works: worst case, you pay cash.",
      mapping: [
        { everyday: "Waiting a fixed time, then 'pending'", concept: "Timeouts and honest status instead of hanging" },
        { everyday: "Not hammering a failing bank", concept: "Retries with backoff and a circuit breaker" },
        { everyday: "Switching to another linked account", concept: "Falling back to another model or provider" },
        { everyday: "Paying cash when UPI is down", concept: "Degrade, don't die: cached answers, fewer features, or a human" },
      ],
    },
    build: {
      title: "A resilient model call under injected failures",
      goal: "A wrapper with timeout, jittered retries, a circuit breaker, a fallback model, a cached answer and an honest message, tested against a fake provider that fails 30% of the time.",
      minutes: 90,
      stack: ["Python", "tenacity (or hand-rolled retries)", "pytest"],
      steps: [
        "Write a FakeProvider whose call() raises a timeout or 429 error 30% of the time and returns malformed JSON 5% of the time, with a seed so runs repeat.",
        "Wrap it with a per-call timeout and up to 2 retries with exponential backoff plus jitter, retrying only on errors that are worth retrying.",
        "Add a circuit breaker: after 5 failures in 30 seconds, skip the primary for 60 seconds and go straight to the fallback.",
        "Add the degradation ladder: fallback model, then a cached answer for that question if one exists, then a clear message that says what the user can do next.",
        "Run 500 requests and print how many were served by primary, fallback, cache or the honest message, and the p95 latency.",
      ],
      starter:
        "import random, time\nclass FakeProvider:\n    def __init__(self, fail=0.3, seed=1):\n        self.fail, self.rng = fail, random.Random(seed)\n    def call(self, q):\n        r = self.rng.random()\n        if r < self.fail: raise TimeoutError('provider slow')\n        if r < self.fail + 0.05: return '{bad json'\n        return '{\"answer\": \"ok\"}'\n\nclass Breaker:\n    def __init__(self, max_fail=5, window=30, cool=60):\n        self.fails: list[float] = []; self.open_until = 0.0\n        self.max_fail, self.window, self.cool = max_fail, window, cool\n    def allow(self) -> bool:\n        return time.time() >= self.open_until\n    def record_failure(self):\n        # TODO: keep failures within window; open for self.cool seconds if too many\n        ...\n\n# TODO: answer(q) -> (text, source) walking primary -> fallback -> cache -> message",
      checks: [
        "No request raises an exception to the caller; every one ends in one of the four outcomes.",
        "With the breaker on, total calls to the failing primary drop sharply compared with retries alone.",
        "Malformed JSON is caught and treated as a failure rather than shown to the user.",
      ],
      stretch: "Define an SLO (for example 99% answered within 8 s) and report whether your design meets it at 30% and at 60% provider failure.",
    },
  },
  "9.7": {
    realLife: {
      title: "Applying for a passport",
      story:
        "At a passport office, most steps are fixed rules: token, document check, photo and fingerprints, fee. Only an ambiguous case, like a name spelled differently on two documents, goes to an officer for judgment. Police verification takes days, so you go home and get an SMS when it's done instead of waiting in the hall. Each counter can be staffed, sped up or replaced without redesigning the whole office.",
      mapping: [
        { everyday: "Fixed counters in a fixed order", concept: "A deterministic pipeline where code decides the flow" },
        { everyday: "The officer for ambiguous cases only", concept: "Letting a model decide only where judgment is genuinely needed" },
        { everyday: "Going home and getting an SMS", concept: "Async and queued execution for long-running steps" },
        { everyday: "Counters that can be changed independently", concept: "Clean component boundaries you can swap, evaluate and scale" },
      ],
    },
    build: {
      title: "An invoice pipeline where the model does one job",
      goal: "A queued invoice-processing service where a model only extracts fields and code does validation, vendor checks and posting, with ambiguous cases routed to a review list.",
      minutes: 90,
      stack: ["Python", "FastAPI", "pydantic", "openai (structured output)", "sqlite3"],
      steps: [
        "Expose POST /invoices that stores the uploaded text or PDF text, returns a job id immediately, and processes it in a background task.",
        "Step 1 (model): extract vendor, invoice number, date, total and line items into a pydantic schema; on validation failure, re-ask once, then mark for review.",
        "Step 2 (code): check that line items sum to the total and that the vendor is in an approved-vendors table, with simple fuzzy matching for near-miss names.",
        "Step 3 (code): post to a fake accounting table if all checks pass; otherwise put the job in a review list with the reason.",
        "Expose GET /invoices/{id} for status, and run 15 sample invoices including a wrong total and an unknown vendor.",
      ],
      checks: [
        "Exactly one step calls a model; all routing decisions are plain if-statements you can unit test.",
        "The wrong-total and unknown-vendor invoices land in review with readable reasons.",
        "POST returns in well under a second even though processing takes longer.",
      ],
      stretch: "Build the same flow as a free-form tool-calling agent, run the same 15 invoices, and compare cost, latency and mistakes.",
    },
  },
  "9.8": {
    realLife: {
      title: "A cricket team's performance analyst",
      story:
        "A franchise's analyst records every ball: line, length, field placing, outcome. Coaches add their notes, players say what felt off, and the analyst notices a batter keeps getting out to short balls. That weakness becomes a specific drill in the nets, and the team sheet for each match is saved so a bad result can be traced to who played and what changed.",
      mapping: [
        { everyday: "Recording every ball", concept: "Traces and metrics built into the architecture" },
        { everyday: "Players saying what felt off vs how they actually got out", concept: "Explicit feedback vs implicit signals such as retries and edits" },
        { everyday: "The short-ball weakness becoming a nets drill", concept: "Production failures turned into eval cases" },
        { everyday: "Saved team sheets for every match", concept: "Versioning models, prompts and retrieval settings to trace regressions" },
      ],
    },
    build: {
      title: "Feedback and version metadata that explain a regression",
      goal: "An assistant that tags every trace with versions, collects thumbs and implicit signals, and produces a weekly report that pinpoints which version made things worse.",
      minutes: 90,
      stack: ["Python", "FastAPI", "sqlite3", "pandas", "Langfuse (optional)"],
      steps: [
        "Log every request with trace id, prompt_version, model, retrieval config hash, latency and tokens to SQLite (or Langfuse).",
        "Add a POST /feedback endpoint for thumbs up/down with an optional comment, and record implicit signals: the same user rephrasing within 60 seconds, or copying the answer.",
        "Simulate two weeks: 300 requests on prompt v1, then 300 on a v2 that drops a key instruction, with simulated feedback that is a bit worse on v2.",
        "Write weekly_report.py that groups thumbs-down rate, rephrase rate and latency by prompt_version and model.",
        "Export every thumbs-down trace from the worst version to eval_candidates.jsonl for human review.",
      ],
      checks: [
        "The report points to v2 as the cause without you telling it when the change happened.",
        "Implicit signals move in the same direction as thumbs, or you can explain why not.",
        "eval_candidates.jsonl contains real inputs ready to add to your offline suite.",
      ],
      stretch: "Add an online LLM judge on a 10% sample and see whether it detects the v2 drop sooner than user feedback does.",
    },
  },
  "9.9": {
    realLife: {
      title: "An architect who designs very different buildings",
      story:
        "An architect in Ahmedabad designs a family flat, a school and a small hospital in the same year. The buildings look nothing alike, but she walks every brief the same way: who uses it and how, budget, site limits, the simplest plan that works, what fails first (fire exits, water, power), and how it grows if the school doubles. At every client meeting she has to defend each choice out loud.",
      mapping: [
        { everyday: "Flat, school, hospital", concept: "Support copilot, coding assistant, deep research agent" },
        { everyday: "The same checklist for every brief", concept: "A repeatable method: requirements, baseline, architecture, bottlenecks, failures, scaling, trade-offs" },
        { everyday: "Fire exits and backup power", concept: "Failure modes and degradation designed in, not added later" },
        { everyday: "Defending choices at the client meeting", concept: "Arguing trade-offs out loud, as in a design interview" },
      ],
    },
    build: {
      title: "A back-of-envelope estimator, checked against a prototype",
      goal: "A reusable script that turns traffic and design choices into tokens, cost, latency and rate-limit needs for three case studies, with one estimate validated by a 20-request prototype.",
      minutes: 75,
      stack: ["Python", "openai or any chat API"],
      steps: [
        "Write estimate.py that takes requests per day, peak-to-average ratio, prompt tokens, retrieved tokens, output tokens, model prices and output speed, and prints daily and monthly cost, peak requests and tokens per minute, and expected generation time.",
        "Fill in inputs for a support copilot, a coding assistant and a deep research agent (where one request triggers many model calls), and save the three outputs.",
        "For the support copilot, build a 20-request prototype with the same prompt sizes and measure real tokens, cost and latency.",
        "Compare estimate and measurement, adjust the assumptions that were off, and write down which one you got most wrong.",
        "For each case, write five lines: the bottleneck, the main failure mode and the trade-off you'd defend.",
      ],
      checks: [
        "The estimator runs for all three cases from the command line with no code edits.",
        "Your prototype's measured cost per request is within a factor of two of the estimate, or you explain the gap.",
        "Each case's five lines name a concrete number, not just 'it might be slow'.",
      ],
      stretch: "Add a cache hit-rate input and show how monthly cost and peak tokens per minute change at 0%, 30% and 60%.",
      sim: "router-cost",
    },
  },
  "9.10": {
    realLife: {
      title: "Getting building plans approved",
      story:
        "Before a new building goes up, the architect submits drawings to the municipal authority with load calculations, fire-safety plans, drainage and parking. The review panel asks why a ramp is where it is and what happens if the lift fails. Plans that only show pretty elevations without numbers or alternatives get sent back.",
      mapping: [
        { everyday: "Drawings with load and fire calculations", concept: "An architecture diagram with latency and cost budgets" },
        { everyday: "'What happens if the lift fails?'", concept: "Failure, degradation and safety sections" },
        { everyday: "Explaining why the ramp isn't on the other side", concept: "The decisions-and-alternatives section" },
        { everyday: "The review panel", concept: "An architecture review or design interview" },
      ],
    },
    build: {
      title: "First milestone: requirements, baseline numbers and a skeleton doc",
      goal: "The first three sections of your design document backed by a measured baseline and a cost and latency sheet.",
      minutes: 120,
      stack: ["Markdown", "Mermaid", "Python", "your estimator from 9.9"],
      steps: [
        "Pick a substantial product (support copilot, contract reviewer, research agent) and write the requirements section: users, success metrics, traffic, latency and quality targets, privacy and budget.",
        "Create the document skeleton with every section heading from the project brief, each with one sentence of intent.",
        "Build a minimal baseline (one prompt, optionally simple retrieval) and run it on 15 realistic requests, recording quality, latency and tokens.",
        "Feed the measured numbers into your estimator to produce the first budget tables per stage and per month.",
        "Draw a first Mermaid architecture diagram and add at least two 'decision / alternative / why rejected' rows.",
      ],
      checks: [
        "Every number in your budget tables traces back to a measurement or a stated assumption.",
        "The requirements section has at least one hard constraint that rules out an obvious design.",
        "The skeleton has a heading for every section the final 6-12 page document needs.",
      ],
      stretch: "Ask a peer to read the requirements alone and predict your architecture; if their guess differs, tighten the requirements.",
      studio: "router-cascade",
    },
  },
};
