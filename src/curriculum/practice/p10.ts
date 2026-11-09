import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "10.1": {
    realLife: {
      title: "One biryani recipe across 200 outlets",
      story:
        "A biryani chain wants the same taste in Hyderabad, Pune and Dubai. The recipe isn't just the cooking steps: it's the rice variety, the spice supplier's batch, the masala ratio, the cooking time and the training card on the wall. If the spice supplier quietly changes the chilli, the biryani changes even though nobody touched the recipe card. So head office versions every ingredient, tastes samples from outlets every week, and can recall a spice batch in a day.",
      mapping: [
        { everyday: "Rice, spice batch, masala ratio, steps, training card", concept: "A release: code, prompts, model version, retrieval settings, index and tools versioned as one unit" },
        { everyday: "The supplier changing the chilli without notice", concept: "Silent provider model updates" },
        { everyday: "Weekly tasting of outlet samples", concept: "Monitoring and online evaluation" },
        { everyday: "Recalling a spice batch", concept: "Rolling back one component of a release" },
      ],
    },
    build: {
      title: "A release manifest that detects what changed",
      goal: "A script that fingerprints every behaviour-changing part of your RAG app into a manifest and diffs two releases to show exactly what changed.",
      minutes: 60,
      stack: ["Python", "hashlib", "PyYAML", "git"],
      steps: [
        "List every input that can change your RAG app's answers: code commit, each prompt file, model id, temperature, chunk size, top-k, embedding model, index contents and tool schemas.",
        "Write make_manifest.py that records the git SHA, a SHA-256 for each prompt and tool schema file, the config values, and a hash of the sorted (chunk_id, text hash) pairs in your index.",
        "Save it as releases/<date>.yaml, then change only the index (add two documents and re-index) and create a second manifest.",
        "Write diff_manifest.py that prints which components differ between two manifests.",
        "Log the manifest hash with every request so a strange answer can be traced to the release that produced it.",
      ],
      starter:
        "import hashlib, json, subprocess, yaml\n\ndef sha(path: str) -> str:\n    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:12]\n\ndef index_hash(chunks: list[dict]) -> str:\n    items = sorted((c['id'], hashlib.sha256(c['text'].encode()).hexdigest()) for c in chunks)\n    return hashlib.sha256(json.dumps(items).encode()).hexdigest()[:12]\n\nmanifest = {\n    'git_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip(),\n    'prompts': {p: sha(p) for p in ['prompts/answer.txt']},\n    'config': yaml.safe_load(open('config.yaml')),\n    # TODO: 'index': index_hash(load_chunks()), 'tools': {...}\n}\n# TODO: write releases/<date>.yaml; implement diff between two manifests",
      checks: [
        "The diff between your two manifests shows only the index as changed, even though git shows no code change.",
        "Every request log line includes a manifest hash.",
        "You can name one thing on your list that the manifest still cannot detect (for example a provider updating a model behind the same name).",
      ],
      stretch: "Add a nightly job that runs five fixed questions and alerts if answers change while the manifest hash hasn't.",
    },
  },
  "10.2": {
    realLife: {
      title: "A pharmaceutical batch record",
      story:
        "In a tablet factory, the operator doesn't keep the formula in their head. A master formula document lists every ingredient and machine setting, every batch gets a number, and the batch record notes which ingredient lots, which machine and which operator made it. A year later, if one batch causes complaints, the factory can trace exactly how it was made and compare it with good batches.",
      mapping: [
        { everyday: "The master formula document", concept: "Configuration holding model, prompts, retrieval settings and tools, not code" },
        { everyday: "Named ingredient lots, not 'some paracetamol'", concept: "Pinned model snapshots and locked dependencies" },
        { everyday: "The batch number on every strip", concept: "A request id, prompt version and model version on everything a request touches" },
        { everyday: "The reference sample kept from a good batch", concept: "The fixed eval set every change is measured against" },
      ],
    },
    build: {
      title: "Config-driven, pinned and traceable",
      goal: "Your RAG app and agent reading all behaviour from a validated config file, with pinned versions, request-id logging and a test that fails if anyone hard-codes a model name.",
      minutes: 75,
      stack: ["Python", "pydantic-settings", "uv or pip-tools", "FastAPI", "pytest"],
      steps: [
        "Create a pydantic Settings class loaded from app.yaml plus environment variables, holding model snapshot id, temperature, prompt file and version, chunk size, top-k and enabled tools.",
        "Replace every literal model name and prompt string in the code with settings fields.",
        "Pin dependencies with a lock file (uv lock or pip-compile) and use a dated model snapshot id rather than a 'latest' alias where your provider offers one.",
        "Add middleware that creates a request id and logs it with prompt_version and model on every log line for that request.",
        "Write a test that scans your source for known model-name patterns outside config and fails if it finds one.",
      ],
      starter:
        "from pydantic_settings import BaseSettings, SettingsConfigDict, YamlConfigSettingsSource\n\nclass Settings(BaseSettings):\n    model_config = SettingsConfigDict(yaml_file='app.yaml', env_prefix='APP_')\n    model_id: str\n    temperature: float = 0.0\n    prompt_file: str\n    prompt_version: str\n    chunk_size: int = 500\n    top_k: int = 5\n    tools: list[str] = []\n\n    @classmethod\n    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, *a, **kw):\n        return (init_settings, env_settings, YamlConfigSettingsSource(settings_cls))\n\nSETTINGS = Settings()\n# TODO: request-id middleware that logs SETTINGS.prompt_version and SETTINGS.model_id\n# TODO: tests/test_no_hardcoded_models.py that greps src/ for 'gpt-' / 'claude-'",
      checks: [
        "APP_MODEL_ID=<another model> switches the model with no file edits.",
        "Any log line can be grouped by request id and shows prompt and model versions.",
        "The hard-coded-model test fails when you add a model string to a Python file, and passes when you remove it.",
      ],
      stretch: "Rebuild your environment from the lock file in a fresh virtualenv or container and confirm the eval scores match.",
    },
  },
  "10.3": {
    realLife: {
      title: "A home baker perfecting a cake for her café menu",
      story:
        "A baker in Shillong tries her walnut cake twelve ways, noting oven temperature, sugar, bake time and what her tasting friends scored each trial. Version 7 goes on the café's menu card. When she tries version 9 she tests it on the same friends first, and if customers dislike it she moves the menu back to version 7 rather than trying to remember what she changed.",
      mapping: [
        { everyday: "The notebook of trials with settings and scores", concept: "Experiment runs with parameters, metrics and artifacts in MLflow" },
        { everyday: "Version 7 named on the menu card", concept: "A prompt registry with a production label" },
        { everyday: "Moving the menu back to version 7", concept: "Rollback by moving a label, never editing text in place" },
        { everyday: "Same tasting friends for every trial", concept: "Comparing runs against a baseline on a fixed eval set" },
      ],
    },
    build: {
      title: "A tracked grid search and a prompt fetch that survives an outage",
      goal: "Four MLflow runs over chunk size and top-k compared against a baseline, plus a prompt fetched from a self-hosted Langfuse by label with caching and a pinned fallback.",
      minutes: 120,
      stack: ["Python", "MLflow", "Langfuse (self-hosted with Docker)", "your RAG app and eval set"],
      steps: [
        "Start MLflow locally (mlflow ui) and log a baseline run of your current config: parameters, eval metrics (correctness, faithfulness), mean latency and tokens, and the prompt and config as artifacts.",
        "Run a 2x2 grid over chunk size and top-k as four more runs, and use the MLflow compare view to pick the best quality per cost.",
        "Start Langfuse with Docker Compose, create your answer prompt there and give one version the production label.",
        "Write get_prompt() that fetches by label with a cache TTL and, if Langfuse is down, falls back to a prompt file pinned in the repo; tag every trace with the version actually used.",
        "Stop the Langfuse container and confirm the app still answers using the fallback and logs that it did.",
      ],
      starter:
        "import mlflow\nfrom langfuse import Langfuse\nlf = Langfuse()  # reads LANGFUSE_* env vars\nFALLBACK = open('prompts/answer.v3.txt').read()\n\ndef get_prompt():\n    try:\n        p = lf.get_prompt('rag-answer', label='production', cache_ttl_seconds=300)\n        return p.prompt, f'langfuse:{p.version}'\n    except Exception:\n        return FALLBACK, 'fallback:v3'\n\nfor chunk in (300, 800):\n    for k in (3, 8):\n        with mlflow.start_run(run_name=f'c{chunk}-k{k}'):\n            mlflow.log_params({'chunk_size': chunk, 'top_k': k})\n            # TODO: rebuild index, run evals, mlflow.log_metrics({...})\n            # TODO: mlflow.log_artifact('config.yaml')",
      checks: [
        "MLflow shows five runs with identical metric names, and you can name the winner and why.",
        "With Langfuse stopped, requests still succeed and their traces or logs say 'fallback'.",
        "Moving the production label to an older version changes the app's prompt with no deploy.",
      ],
      stretch: "Log the Langfuse prompt version as an MLflow parameter so each run links to the exact prompt it used.",
    },
  },
  "10.4": {
    realLife: {
      title: "Testing milk at a dairy cooperative",
      story:
        "At a village collection centre in Gujarat, every can of milk gets a quick fat and freshness check before it is accepted. At the main dairy, every tanker gets a full lab test before the milk is packed, and a tanker below the fat or SNF threshold is turned back. Because a single reading can be off, the lab repeats borderline tests before rejecting a whole tanker.",
      mapping: [
        { everyday: "The quick check at the village centre", concept: "A fast smoke eval on every commit" },
        { everyday: "The full lab test before packing", concept: "The complete suite for release candidates" },
        { everyday: "Fat and SNF thresholds", concept: "Per-metric thresholds that fail the build" },
        { everyday: "Repeating borderline readings", concept: "Repeat runs and tolerance bands for noisy LLM scores" },
      ],
    },
    build: {
      title: "A noise-aware eval gate with smoke and full suites",
      goal: "A DeepEval (or plain pytest) gate whose thresholds come from measured run-to-run noise, with a smoke marker for every commit and a full marker for release candidates.",
      minutes: 90,
      stack: ["Python", "pytest", "deepeval (or a hand-rolled judge)", "GitHub Actions"],
      steps: [
        "Run your current suite 5 times on an unchanged system and compute the mean and standard deviation of each metric (for example faithfulness, answer relevance, task completion).",
        "Write thresholds.json with, per metric, baseline mean minus two standard deviations as the floor, and commit the noise data next to it.",
        "Mark 10 representative cases as smoke and the rest as full with pytest markers; each test averages 2 runs per case.",
        "Write the gate so the failure message names the metric, its score and its floor.",
        "Add a workflow that runs smoke on every push and full only when files under prompts/, config/ or the index manifest change.",
      ],
      starter:
        "import json, statistics, pytest\nFLOORS = json.load(open('evals/thresholds.json'))\nCASES = [json.loads(l) for l in open('evals/cases.jsonl')]\n\ndef mean_score(metric, cases, repeats=2):\n    scores = [score(metric, c) for c in cases for _ in range(repeats)]  # TODO: score()\n    return statistics.mean(scores)\n\n@pytest.mark.smoke\n@pytest.mark.parametrize('metric', list(FLOORS))\ndef test_smoke(metric):\n    s = mean_score(metric, [c for c in CASES if c.get('smoke')])\n    assert s >= FLOORS[metric], f'{metric}={s:.3f} below floor {FLOORS[metric]:.3f}'\n\n# TODO: @pytest.mark.full test over all CASES",
      checks: [
        "Your thresholds come from measured noise, and you can show the 5-run spread.",
        "Five unchanged re-runs of the gate all pass, so it isn't flaky.",
        "A weakened prompt fails the full suite and the message names the metric and floor.",
      ],
      stretch: "Generate 20 synthetic cases with an LLM, review each by hand, and record how many you threw away and why.",
    },
  },
  "10.5": {
    realLife: {
      title: "Cheque clearing at a bank",
      story:
        "When you deposit a cheque, the bank checks the signature, whether the amount in words matches the figures, the date and, for large cheques, whether the issuer pre-confirmed it. A cheque with a mismatch is returned so it can be corrected, not silently paid. The bank also tracks how many genuine cheques it wrongly bounced, because angry honest customers cost money too.",
      mapping: [
        { everyday: "Amount in words must match the figures", concept: "Schema validation of structured output" },
        { everyday: "Returning a cheque to be corrected", concept: "Re-asking the model after a validation failure" },
        { everyday: "Pre-confirmation for large cheques", concept: "Limits and checks on agent tool arguments and spend" },
        { everyday: "Counting genuine cheques wrongly bounced", concept: "Measuring each guard's false-positive rate and latency" },
      ],
    },
    build: {
      title: "Guardrails with metrics on every block",
      goal: "Input, output and agent guards around your app, each exporting block counts and latency to Prometheus, with a measured false-positive rate on legitimate traffic.",
      minutes: 120,
      stack: ["Python", "FastAPI", "pydantic", "prometheus-client", "Guardrails AI or NeMo Guardrails (optional)"],
      steps: [
        "Input guard: flag likely injection (a small classifier prompt or heuristics) and mask PII before the model sees the text.",
        "Output guard: validate structured answers against a pydantic schema and re-ask up to 2 times with the validation error; block replies that contain a canary secret or no citation.",
        "Agent guard: validate tool arguments and cap steps at 8 and spend at a per-request limit.",
        "Wrap each guard with a Prometheus Counter (by guard and outcome) and a Histogram for its latency, and log each block with the request id and reason.",
        "Send 30 legitimate but unusual requests and 20 hostile ones, then compute per-guard false-positive and miss rates from your metrics.",
      ],
      starter:
        "import time\nfrom prometheus_client import Counter, Histogram\nGUARD = Counter('guard_events_total', 'guard outcomes', ['guard', 'outcome'])\nGUARD_LAT = Histogram('guard_latency_seconds', 'guard latency', ['guard'])\n\ndef guarded(name):\n    def wrap(fn):\n        def inner(*a, **kw):\n            t = time.perf_counter()\n            ok, reason = fn(*a, **kw)\n            GUARD_LAT.labels(name).observe(time.perf_counter() - t)\n            GUARD.labels(name, 'pass' if ok else 'block').inc()\n            # TODO: log request id + reason on block\n            return ok, reason\n        return inner\n    return wrap\n\n@guarded('input_injection')\ndef check_injection(text: str) -> tuple[bool, str]:\n    ...  # TODO",
      checks: [
        "/metrics shows counts per guard and outcome, and latency histograms per guard.",
        "You report a false-positive rate on the 30 legitimate requests and fix at least one guard that was too strict.",
        "A schema failure triggers a re-ask, visible in the logs, before any block.",
      ],
      stretch: "Add NeMo Guardrails topic rails for one conversation flow and compare its latency with your plain validator.",
      studio: "guarded-agent",
    },
  },
  "10.6": {
    realLife: {
      title: "A touring band's flight cases",
      story:
        "A band touring ten cities doesn't rebuild its stage setup at every venue. The amps, mixer and pedals live in pre-wired flight cases, and a stage plot shows how the cases connect. At each venue they plug into the venue's power, run a soundcheck before the doors open, and if the singer walks off mid-song, the sound engineer cuts the mic rather than leave it humming.",
      mapping: [
        { everyday: "Pre-wired flight cases", concept: "Docker images that run the same on any machine" },
        { everyday: "The stage plot", concept: "Docker Compose wiring backend, frontend and vector DB" },
        { everyday: "Soundcheck before doors open", concept: "Health and readiness checks for the provider and vector DB" },
        { everyday: "Venue power, not batteries packed inside", concept: "Secrets passed in at runtime, never baked into images. (Cutting the mic matches stopping generation when a client disconnects.)" },
      ],
    },
    build: {
      title: "Streaming FastAPI backend in a Compose stack",
      goal: "A FastAPI backend that streams tokens over SSE, stops on client disconnect, exposes health and readiness, and runs with a vector DB and Streamlit UI via one docker compose command.",
      minutes: 120,
      stack: ["Python", "FastAPI", "Streamlit", "Docker", "Docker Compose", "Qdrant"],
      steps: [
        "Write POST /chat/stream that validates input with pydantic and returns a StreamingResponse of SSE events, checking request.is_disconnected() between chunks and closing the provider stream if the client leaves.",
        "Add /healthz (process alive) and /readyz (can reach Qdrant and the provider with a cheap call), returning 503 when not ready.",
        "Write a slim Dockerfile (python slim base, non-root user, dependencies installed before copying code for layer caching).",
        "Write compose.yaml with backend, a Streamlit frontend that only renders the stream and plain-language errors, and qdrant with a volume; pass the API key with env_file.",
        "Run docker compose up, stream an answer in the UI, then close the tab mid-answer and confirm in logs that generation stopped.",
      ],
      starter:
        "from fastapi import FastAPI, Request\nfrom fastapi.responses import StreamingResponse, JSONResponse\nfrom pydantic import BaseModel, Field\napp = FastAPI()\n\nclass ChatIn(BaseModel):\n    question: str = Field(min_length=1, max_length=4000)\n\n@app.post('/chat/stream')\nasync def chat(body: ChatIn, request: Request):\n    async def events():\n        async for token in generate(body.question):  # TODO: provider stream\n            if await request.is_disconnected():\n                # TODO: log 'client left', close provider stream\n                break\n            yield f'data: {token}\\n\\n'\n        yield 'event: done\\ndata: end\\n\\n'\n    return StreamingResponse(events(), media_type='text/event-stream')\n\n@app.get('/readyz')\nasync def readyz():\n    # TODO: ping qdrant + provider; 503 if either fails\n    return JSONResponse({'ready': True})",
      checks: [
        "A fresh clone plus a .env file plus docker compose up gives a working streaming UI.",
        "docker history (or inspecting the image) shows no API key baked into any layer.",
        "/readyz returns 503 when you stop the qdrant container, and 200 when you start it again.",
      ],
      stretch: "Add a per-request timeout that ends the stream with a clear message, and measure the image size before and after a multi-stage build.",
    },
  },
  "10.7": {
    realLife: {
      title: "A newspaper's night desk",
      story:
        "At a daily paper, a reporter files a story, the copy desk checks facts and spelling, and only then is the page made into a printing plate stamped with the edition number. The city edition goes out on its own, but the front page of the national edition needs the editor's sign-off. If a mistake slips through, they reprint from the previous edition's plate instead of re-typesetting everything at 3 am.",
      mapping: [
        { everyday: "Reporter, copy desk, then plate-making", concept: "Unit tests, eval gate, then image build, in that order" },
        { everyday: "The edition number on each plate", concept: "Images tagged with the commit SHA" },
        { everyday: "Editor's sign-off for the national front page", concept: "Required human approval for production deploys" },
        { everyday: "Reprinting from the previous plate", concept: "Rollback by redeploying the last good tag" },
      ],
    },
    build: {
      title: "A gated pipeline from commit to tagged image",
      goal: "A GitHub Actions workflow that runs tests, then the eval gate, then builds and pushes a SHA-tagged image to GHCR, deploys to staging automatically and waits for approval before production.",
      minutes: 90,
      stack: ["GitHub Actions", "Docker", "GitHub Container Registry", "pytest"],
      steps: [
        "Create jobs test, eval_gate and build_push, chaining them with needs: so a failure stops everything after it.",
        "In build_push, log in to ghcr.io with the built-in GITHUB_TOKEN, and tag the image with the commit SHA (plus 'main' on main).",
        "Run eval_gate only on push to main and on pull requests from the same repo, so fork PRs never receive the provider key.",
        "Add two environments in repo settings, staging and production, with a required reviewer on production, and deploy jobs that reference them.",
        "Add a separate rollback workflow with workflow_dispatch taking an image tag, which redeploys that tag without rebuilding.",
      ],
      starter:
        "name: ci\non:\n  push: { branches: [main] }\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pip install -r requirements.txt && pytest -m 'not eval'\n  eval_gate:\n    needs: test\n    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pip install -r requirements.txt && pytest -m smoke\n        env: { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}' }\n  build_push:\n    needs: eval_gate\n    # TODO: permissions: packages: write; docker login ghcr.io; build; push :${{ github.sha }}\n  # TODO: deploy_staging (environment: staging), deploy_prod (environment: production)",
      checks: [
        "A PR that weakens the prompt stops at eval_gate and no image is pushed.",
        "Every pushed image tag matches a commit SHA in your history.",
        "The production deploy waits for your approval, and the rollback workflow can redeploy an older tag in under a few minutes.",
      ],
      stretch: "Post the eval gate's metric table as a PR comment so reviewers see quality changes next to the diff.",
    },
  },
  "10.8": {
    realLife: {
      title: "A highway toll plaza on a holiday weekend",
      story:
        "On the Mumbai-Pune expressway before a long weekend, the plaza opens more booths when queues grow, not when the booth staff look busy. Staff carry ID badges that open only their booth, not keys to the cash vault. A new booth is tested with a few cars before traffic is sent to it, and if its scanner fails, cars are waved back to the old lanes. But no number of booths helps if the highway beyond is jammed.",
      mapping: [
        { everyday: "Opening booths when queues grow", concept: "Scaling on concurrency rather than CPU" },
        { everyday: "ID badges instead of vault keys", concept: "An IAM role on EC2 and Secrets Manager, not access keys on disk" },
        { everyday: "Testing a new booth, then switching traffic", concept: "CodeDeploy releases with health checks, in-place or blue/green" },
        { everyday: "The jammed highway beyond the plaza", concept: "Provider rate limits that cap you before your own instances do" },
      ],
    },
    build: {
      title: "One tagged image on EC2 behind an ALB, reading secrets at start",
      goal: "Your container running on EC2 with an IAM role, loading its API key from Secrets Manager at startup, behind an ALB whose idle timeout lets long streams finish.",
      minutes: 120,
      stack: ["AWS (EC2, IAM, Secrets Manager, ALB)", "Docker", "boto3", "AWS CLI"],
      steps: [
        "Store your provider key in Secrets Manager and create an IAM role whose policy allows secretsmanager:GetSecretValue on that one secret only; attach it to a small EC2 instance.",
        "Change your container's startup to fetch the secret with boto3 into memory (no file, no environment baked into the image), and fail fast with a clear log line if it can't.",
        "Pull your SHA-tagged image from your registry onto the instance and run it with a restart policy.",
        "Create an ALB with a target group pointing at /readyz as the health check, and raise the idle timeout above your longest expected stream (for example 300 s).",
        "Stream a long answer through the ALB to confirm it isn't cut at 60 s, then tear everything down or set a billing alarm.",
      ],
      starter:
        "import json, os, sys, boto3\n\ndef load_secret() -> str:\n    name = os.environ['SECRET_NAME']  # e.g. prod/rag/openai\n    region = os.environ.get('AWS_REGION', 'ap-south-1')\n    try:\n        sm = boto3.client('secretsmanager', region_name=region)\n        value = sm.get_secret_value(SecretId=name)['SecretString']\n        return json.loads(value)['OPENAI_API_KEY']\n    except Exception as e:\n        print(f'cannot load secret {name}: {type(e).__name__}', file=sys.stderr)\n        sys.exit(1)\n\nAPI_KEY = load_secret()  # keep in memory only; never log it\n# TODO: pass API_KEY to your client; start uvicorn",
      checks: [
        "No AWS access keys exist on the instance (aws configure list shows the role as the credential source).",
        "The ALB marks the target healthy only when /readyz passes, and unhealthy when you stop the container.",
        "A stream longer than 60 seconds completes through the ALB.",
      ],
      stretch: "Add an appspec.yml and release the next SHA tag with CodeDeploy, then break /readyz on purpose and watch the deployment roll back.",
      sim: "load-test",
    },
  },
  "10.9": {
    realLife: {
      title: "The monitors in a hospital ICU",
      story:
        "In an ICU, machines track every patient's heart rate, oxygen and blood pressure on one screen at the nurses' station. Alarms are tuned so they ring for real danger, because nurses who hear constant false alarms start ignoring them. On rounds, a doctor examines a few patients in depth, and anything surprising becomes a note in the ward's protocol.",
      mapping: [
        { everyday: "Heart rate, oxygen, blood pressure on one screen", concept: "Grafana dashboards of health, traffic, latency, errors and token spend" },
        { everyday: "Alarms tuned to real danger", concept: "Alerts worth waking for: error spikes, latency budgets, spend limits" },
        { everyday: "The detailed chart for one patient", concept: "Per-request tracing with step latency and cost in Langfuse" },
        { everyday: "Rounds that examine a few patients closely", concept: "Online evals on a sample of live traffic, fed back into the suite" },
      ],
    },
    build: {
      title: "Metrics, dashboard and one real alert",
      goal: "Your app exporting request, latency, token and guard metrics to Prometheus, a Grafana dashboard with four panels, and a firing alert for error rate or daily token spend.",
      minutes: 120,
      stack: ["Python", "prometheus-client", "Prometheus", "Grafana", "Node Exporter", "Docker Compose", "Langfuse (optional)"],
      steps: [
        "Add metrics to your FastAPI app: requests by route and status, a latency histogram, model calls by model, input and output tokens, and guardrail blocks; expose them on /metrics.",
        "Add prometheus, grafana and node-exporter to your Compose file, with a prometheus.yml that scrapes the app and node-exporter.",
        "Build a dashboard with four panels: request rate, p95 latency (histogram_quantile), error rate and tokens per hour converted to estimated cost.",
        "Write an alert rule for error rate above 5% for 5 minutes, and one for today's estimated spend above a limit; trigger the first by making the app fail on purpose.",
        "Optionally add Langfuse tracing and open the most expensive request of the day to see which step spent the tokens.",
      ],
      starter:
        "from prometheus_client import Counter, Histogram, make_asgi_app\nREQS = Counter('app_requests_total', 'requests', ['route', 'status'])\nLAT = Histogram('app_request_seconds', 'latency', ['route'],\n                buckets=(0.5, 1, 2, 4, 8, 16, 32))\nTOKENS = Counter('llm_tokens_total', 'tokens', ['model', 'kind'])  # kind=input|output\nCALLS = Counter('llm_calls_total', 'model calls', ['model', 'status'])\napp.mount('/metrics', make_asgi_app())\n\n# prometheus rules.yml\n# - alert: HighErrorRate\n#   expr: sum(rate(app_requests_total{status=~\"5..\"}[5m])) / sum(rate(app_requests_total[5m])) > 0.05\n#   for: 5m\n# TODO: alert DailySpendHigh using increase(llm_tokens_total[1d]) * price",
      checks: [
        "Grafana shows all four panels with live data while you send traffic.",
        "Your error-rate alert fires during the forced failure and resolves after it.",
        "You can point at one panel and say what normal looks like for your app.",
      ],
      stretch: "Score 10% of live requests with an LLM judge, chart the score in Grafana, and export low scores into your eval candidates file.",
    },
  },
  "10.10": {
    realLife: {
      title: "A city's monsoon flood drill",
      story:
        "Before every monsoon, Mumbai's civic body runs drills and keeps one-page plans: if a rain gauge passes a mark, which pumps start, which roads close, who decides on calling a holiday. Different problems get different responses: a blocked drain, a failed pump and a high tide are not fixed the same way. After each flood, a review looks at what happened without hunting for someone to blame, and the lessons go into next year's plan.",
      mapping: [
        { everyday: "Blocked drain, failed pump, high tide", concept: "LLM incidents: provider outage, silent model update, prompt regression, stale index, runaway agent, cost spike" },
        { everyday: "A different response for each", concept: "Matching the lever to the cause: fallback, prompt rollback, image rollback, re-index, spend cap" },
        { everyday: "The one-page plan per situation", concept: "Runbooks: signal, first move, who decides" },
        { everyday: "The review after each flood", concept: "Blameless reviews that add the case to the eval suite" },
      ],
    },
    build: {
      title: "Two incident drills with kill switches and runbooks",
      goal: "Kill switches for prompt rollback and spend capping, two rehearsed drills (a prompt regression and a cost spike) with timed detection and recovery, and a one-page runbook for each.",
      minutes: 90,
      stack: ["Python", "your deployed or local app", "Langfuse or config labels", "your metrics from 10.9"],
      steps: [
        "Add two kill switches you can flip without a deploy: PROMPT_LABEL (which prompt version is served) and MAX_TOKENS_PER_HOUR (a spend cap that returns a polite 'busy' when exceeded).",
        "Drill 1: promote a prompt that quietly drops citations. Note when your online check or dashboard first shows it, then roll back by moving the label, and record detect and recover times.",
        "Drill 2: make a loop that sends very long prompts to simulate a runaway agent. Note when the spend alert fires and when the cap stops it.",
        "Write RUNBOOK-prompt-regression.md and RUNBOOK-cost-spike.md, each one page: the signal, the first move, how to confirm recovery, who decides.",
        "Write a short blameless review of one drill and add its failing case to your eval suite.",
      ],
      checks: [
        "Both kill switches work by changing config or a label, not code.",
        "You have measured detect-to-recover times for both drills.",
        "The prompt-regression case now fails the eval gate if anyone promotes that prompt again.",
      ],
      stretch: "Pin your current model snapshot, run the full suite against the provider's newest snapshot, and write the go/no-go note you'd send before switching.",
    },
  },
  "10.11": {
    realLife: {
      title: "Taking a home pickle brand to supermarket shelves",
      story:
        "A family's mango pickle sells well at local fairs. To get onto supermarket shelves, they fix the recipe in writing, send batches for food-safety tests, label every jar with a batch number, set up a small production unit, track which shops are running low and what customers say, and keep a plan for recalling a bad batch. The pickle is the same; everything around it is what makes it a business.",
      mapping: [
        { everyday: "The written recipe and labelled batches", concept: "Versioned prompts and tracked experiments" },
        { everyday: "Food-safety tests before shipping", concept: "The eval gate in CI" },
        { everyday: "The production unit and distribution", concept: "Guarded, containerised serving deployed on AWS" },
        { everyday: "Stock tracking, reviews and a recall plan", concept: "Dashboards, alerts, traces and a rehearsed rollback" },
      ],
    },
    build: {
      title: "First milestone: versioned prompts and a gate that blocks a bad change",
      goal: "Your Level 4 RAG app or Level 5 agent with every prompt in a registry under a production label, experiments logged, and a GitHub Actions eval gate that visibly blocks a weakened prompt.",
      minutes: 120,
      stack: ["Python", "Langfuse", "MLflow", "pytest", "GitHub Actions"],
      steps: [
        "Move every prompt into Langfuse (or a prompt folder with a labels file) and fetch the production version at runtime with a pinned fallback.",
        "Log a baseline MLflow run with your config as parameters, eval scores as metrics and the prompt as an artifact.",
        "Turn your Level 7 eval set into a pytest gate with per-metric floors and add it to a GitHub Actions workflow on pull requests.",
        "Open a PR that removes the 'answer only from context' instruction and confirm the gate fails and names the metric; screenshot it for your README.",
        "Start the README with an architecture sketch and a checklist of the remaining lifecycle steps: guard, serve, deploy, observe, recover.",
      ],
      checks: [
        "The app reports the prompt version it served on every request.",
        "The weakened-prompt PR is red and a harmless PR is green.",
        "The README contains the gate-failure screenshot and the remaining checklist.",
      ],
      stretch: "Run a second experiment that beats the baseline, promote it through the label, and show the trace version change.",
    },
  },
};
