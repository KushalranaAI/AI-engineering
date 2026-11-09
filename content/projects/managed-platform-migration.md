---
project: managed-platform-migration
title: Move an app onto a managed platform
hours: 8
stack: Python 3.11, openai SDK, boto3, AWS CLI v2, LiteLLM proxy (Docker), AWS Bedrock (Vertex AI / Azure AI Foundry notes)
cost: About $1-5 of Bedrock calls; a VPC endpoint adds roughly $0.01 per hour per availability zone while it exists (estimates)
---

You will take a small working LLM app that calls a public API with a key, and move it onto AWS Bedrock inside your own
cloud account without changing how it behaves. The key disappears, a least-privilege role allowed to call exactly one
model takes its place, traffic can stay on a private network path, a LiteLLM gateway sits in front with a tested
fallback, and a budget alert watches the bill. You finish with an eval table comparing before and after, and a
one-page decision record of the kind a platform team or an auditor would ask for. The same steps map onto Vertex AI and
Azure AI Foundry; notes for both appear where they differ.

## Before you start
- Python 3.11+, Docker Desktop (or Docker Engine with compose), and the AWS CLI v2 (`aws --version` should print `aws-cli/2.x`).
- An AWS account where you can create IAM roles and policies. Use a sandbox account, not production.
- An API key for the provider your app uses today (OpenAI in the examples; any OpenAI-compatible endpoint, including Ollama at `http://localhost:11434/v1`, works the same way).
- If you already built a RAG or chat app in an earlier level, you can migrate that instead. This guide ships a tiny "policy answerer" app so everyone has the same starting point.

```text title="final folder structure"
platform-migration/
├── app/
│   ├── __init__.py
│   ├── llm.py               # OpenAI-compatible client, configured from env
│   ├── answer.py            # the app: answer HR questions from a handbook
│   ├── bedrock_direct.py    # the same call through boto3 Converse
│   └── guard.py             # bought component: Bedrock Guardrails PII screen
├── data/handbook.md
├── evals/
│   ├── cases.jsonl
│   ├── run_evals.py
│   └── compare.py
├── gateway/
│   ├── litellm.yaml
│   └── docker-compose.yml
├── infra/
│   ├── bedrock-invoke-policy.json
│   ├── trust-policy.json
│   ├── create_guardrail.py
│   ├── budget.json
│   └── budget-notifications.json
├── tools/breakeven.py
├── tests/test_retrieval.py
├── docs/
│   ├── data-handling.md
│   └── decision-record.md
└── results/
```

## How it fits together

```text
 before:  app ──(API key, public internet)──> provider API

 after:   app ──OpenAI format──> LiteLLM gateway ──IAM role──> VPC endpoint ──> Bedrock (model in your region)
                                   │                                           │
                                   └──fallback on error──> original provider   └─> CloudTrail / invocation logs
          app ──boto3──> Bedrock Guardrails (PII mask)           AWS Budgets alert on Bedrock spend
```

A question enters the app, which retrieves two handbook sections with its own hand-built keyword retriever (we keep
that). The question first passes through a managed Bedrock Guardrail that masks emails and blocks card numbers (we buy
that). The app then sends an ordinary OpenAI-style chat request to the LiteLLM gateway. The gateway signs a Bedrock
request with temporary credentials from a role that may invoke one model only, and if Bedrock fails it retries on the
original provider. Every step is measured by the same eval script you ran before the move.

## Step 1 · Build the app and record a baseline
**Goal:** a working app on your current provider and a saved baseline of quality, latency and cost.

A migration without a baseline is a guess. Before touching the cloud, build (or point at) the app and run an eval suite
that records pass rate, latency and token cost. These numbers are what "keep its behaviour" means later.

```bash title="terminal"
mkdir platform-migration && cd platform-migration
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install "openai>=1.40" "boto3>=1.35" pytest
mkdir -p app data evals gateway infra tools tests docs results
touch app/__init__.py
export MODEL=gpt-4o-mini OPENAI_API_KEY=sk-...       # Windows PowerShell: $env:MODEL="gpt-4o-mini"
```

```markdown title="data/handbook.md"
## Annual leave
Full-time employees get 24 days of paid annual leave per calendar year. Up to 5 unused days carry over to the next year and expire on 31 March. Leave requests go through the HR portal at least 10 working days in advance.

## Sick leave
Employees get 12 days of paid sick leave per year. A doctor's note is required for absences longer than 3 consecutive days. Sick leave does not carry over.

## Remote work
Employees may work remotely up to 3 days per week with manager approval. Working from another country for more than 14 days in a year needs written approval from HR and Legal because of tax rules.

## Expenses
Submit expense claims within 30 days with a receipt. Meals during business travel are reimbursed up to 60 EUR per day. Claims above 500 EUR need director approval.

## Equipment
New starters receive a laptop and up to 300 EUR for home office equipment. Lost or stolen laptops must be reported to IT within 24 hours.

## Parental leave
Birth parents get 26 weeks of paid parental leave. Non-birth parents get 12 weeks of paid leave, which can be taken any time in the first year.

## Learning budget
Each employee has a learning budget of 1,000 EUR per year for courses, books and conferences. Unused budget does not carry over.

## Notice period
The notice period is 1 month during probation and 3 months after probation for both sides.
```

```python title="app/llm.py"
"""One place that knows how to talk to a model. Everything else imports chat()."""
import os
import time
from dataclasses import dataclass

from openai import OpenAI

MODEL = os.getenv("MODEL", "gpt-4o-mini")          # example id; swap freely
BASE_URL = os.getenv("BASE_URL") or None            # None means the provider's default URL
API_KEY = os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY", "not-needed")

_client = OpenAI(base_url=BASE_URL, api_key=API_KEY, timeout=60, max_retries=2)


@dataclass
class Completion:
    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    model: str


def chat(system: str, user: str, max_tokens: int = 300) -> Completion:
    start = time.perf_counter()
    resp = _client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=max_tokens,
        temperature=0,
    )
    latency_ms = (time.perf_counter() - start) * 1000
    usage = resp.usage
    return Completion(
        text=resp.choices[0].message.content or "",
        input_tokens=usage.prompt_tokens if usage else 0,
        output_tokens=usage.completion_tokens if usage else 0,
        latency_ms=latency_ms,
        model=resp.model,
    )
```

```python title="app/answer.py"
"""The policy answerer: hand-built keyword retrieval plus one model call."""
import re
from pathlib import Path

from app.llm import Completion, chat

HANDBOOK = Path(__file__).resolve().parent.parent / "data" / "handbook.md"
SYSTEM = (
    "You answer employee questions using ONLY the handbook sections provided. "
    "Quote exact numbers. If the sections do not contain the answer, reply exactly: "
    "\"I don't know - please ask HR.\""
)
STOPWORDS = {"the", "a", "an", "i", "my", "do", "how", "what", "is", "are", "can", "to", "of", "for", "in", "get", "much", "many"}


def load_sections() -> dict[str, str]:
    text = HANDBOOK.read_text(encoding="utf-8")
    sections = {}
    for block in text.split("## ")[1:]:
        title, _, body = block.partition("\n")
        sections[title.strip()] = body.strip()
    return sections


def tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOPWORDS}


def retrieve(question: str, k: int = 2) -> list[tuple[str, str]]:
    q = tokens(question)
    scored = [
        (len(q & tokens(title)) * 3 + len(q & tokens(body)), title, body)
        for title, body in load_sections().items()
    ]
    scored.sort(reverse=True)
    return [(title, body) for score, title, body in scored[:k] if score > 0]


def answer(question: str) -> Completion:
    hits = retrieve(question)
    context = "\n\n".join(f"## {t}\n{b}" for t, b in hits) or "(no matching sections)"
    return chat(SYSTEM, f"Handbook sections:\n{context}\n\nQuestion: {question}")


if __name__ == "__main__":
    import sys
    result = answer(" ".join(sys.argv[1:]) or "How many days of annual leave do I get?")
    print(result.text)
    print(f"[{result.model} · {result.input_tokens} in / {result.output_tokens} out · {result.latency_ms:.0f} ms]")
```

```json title="evals/cases.jsonl"
{"id": "leave-days", "question": "How many days of annual leave do I get?", "must_contain": ["24"]}
{"id": "carry-over", "question": "Can I carry unused holiday into next year?", "must_contain": ["5", "31 March"]}
{"id": "sick-note", "question": "When do I need a doctor's note for sick leave?", "must_contain": ["3"]}
{"id": "remote-days", "question": "How many days a week can I work remotely?", "must_contain": ["3"]}
{"id": "abroad", "question": "Can I work from another country for a month?", "must_contain": ["14"]}
{"id": "meals", "question": "What is the daily meal limit on business travel expenses?", "must_contain": ["60"]}
{"id": "director", "question": "Which expense claims need director approval?", "must_contain": ["500"]}
{"id": "laptop-lost", "question": "My laptop was stolen, what do I do?", "must_contain": ["24 hours"]}
{"id": "parental", "question": "How much parental leave does a non-birth parent get?", "must_contain": ["12 weeks"]}
{"id": "learning", "question": "What is my learning budget for courses?", "must_contain": ["1,000"]}
{"id": "notice", "question": "What is the notice period after probation?", "must_contain": ["3 months"]}
{"id": "unknown-pension", "question": "What is the company pension contribution rate?", "must_contain": ["don't know"]}
```

```python title="evals/run_evals.py"
"""Run every eval case, score it, and save raw results plus a summary under results/<label>.json."""
import argparse
import json
import os
import statistics
from pathlib import Path

from app.answer import answer

CASES = Path(__file__).with_name("cases.jsonl")
PRICE_IN = float(os.getenv("PRICE_IN_PER_M", "0.15"))     # USD per 1M input tokens - example, check your provider
PRICE_OUT = float(os.getenv("PRICE_OUT_PER_M", "0.60"))   # USD per 1M output tokens - example


def score(text: str, must_contain: list[str]) -> bool:
    low = text.lower().replace("’", "'")
    return all(m.lower() in low for m in must_contain)


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(p / 100 * len(ordered)) - 1))
    return ordered[idx]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True, help="name for this run, e.g. baseline-openai")
    args = parser.parse_args()

    rows = []
    for line in CASES.read_text(encoding="utf-8").splitlines():
        case = json.loads(line)
        try:
            result = answer(case["question"])
            ok = score(result.text, case["must_contain"])
            rows.append({**case, "answer": result.text, "passed": ok, "latency_ms": result.latency_ms,
                         "input_tokens": result.input_tokens, "output_tokens": result.output_tokens,
                         "model": result.model, "error": None})
        except Exception as exc:  # a failed call is a failed case, not a crashed run
            rows.append({**case, "answer": "", "passed": False, "latency_ms": 0, "input_tokens": 0,
                         "output_tokens": 0, "model": "", "error": f"{type(exc).__name__}: {exc}"})
        print(f"{'PASS' if rows[-1]['passed'] else 'FAIL'}  {case['id']}  {rows[-1]['error'] or ''}")

    lat = [r["latency_ms"] for r in rows if not r["error"]] or [0.0]
    tok_in = sum(r["input_tokens"] for r in rows)
    tok_out = sum(r["output_tokens"] for r in rows)
    cost = tok_in / 1e6 * PRICE_IN + tok_out / 1e6 * PRICE_OUT
    summary = {
        "label": args.label,
        "models": sorted({r["model"] for r in rows if r["model"]}),
        "pass_rate": sum(r["passed"] for r in rows) / len(rows),
        "errors": sum(1 for r in rows if r["error"]),
        "p50_ms": statistics.median(lat),
        "p95_ms": percentile(lat, 95),
        "cost_per_1k_requests_usd": cost / len(rows) * 1000,
    }
    Path("results").mkdir(exist_ok=True)
    Path(f"results/{args.label}.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
```

**How this code works**
- `app/llm.py` reads `MODEL`, `BASE_URL` and `API_KEY` from the environment → the migration later becomes a change of three variables, not a code change. This is the "keep an abstraction" lesson in practice.
- `Completion` carries tokens, latency and the model that actually answered → you need `model` later to prove which backend served a request after fallback.
- `retrieve()` weights title matches three times more than body matches → a crude but transparent retriever; it is the hand-built piece you will deliberately keep.
- The system prompt forces an exact refusal string → the `unknown-pension` case checks the app still says "I don't know" after migration, which is where model swaps often regress.
- `run_evals.py` catches every exception per case → a throttled or denied call shows up as a failed case with its error, rather than killing the run. Beginners often let one `AccessDeniedException` hide eleven good results.
- `PRICE_IN_PER_M` / `PRICE_OUT_PER_M` are environment variables → prices change and differ per model; never hard-code them.

**Run it**
```bash title="terminal"
python -m app.answer "How many days of sick leave do I get?"
python -m evals.run_evals --label baseline-openai
```

**You should see**
```text
Employees get 12 days of paid sick leave per year.
[gpt-4o-mini-2024-07-18 · 241 in / 14 out · 812 ms]
PASS  leave-days
...
PASS  unknown-pension
{
  "label": "baseline-openai",
  "pass_rate": 1.0,
  "errors": 0,
  "p50_ms": 790.4,
  "p95_ms": 1420.7,
  "cost_per_1k_requests_usd": 0.046
}
```

**If it breaks**
- `ModuleNotFoundError: app` → you ran the file directly. Run from the project root with `python -m evals.run_evals`.
- `AuthenticationError` → `OPENAI_API_KEY` is not exported in this shell. For Ollama, set `BASE_URL=http://localhost:11434/v1` and `MODEL=llama3.2`.
- Pass rate below 1.0 on the baseline → read the failing answers in `results/baseline-openai.json`. Fix the prompt or the case now; a flaky baseline makes the migration comparison meaningless.

## Step 2 · Create a least-privilege role instead of a key
**Goal:** an IAM role that can invoke exactly one Bedrock model in one region, and nothing else.

On a managed platform the app should never hold a long-lived secret. It runs as a role (ECS task role, Lambda
execution role, EC2 instance profile) and gets short-lived credentials automatically. Locally you assume the same role
from your SSO login, so you test with the exact permissions production will have.

Pick a model first. This guide uses Amazon Nova Lite through the US cross-region inference profile because it is cheap
and needs no extra access form; any Converse-capable model works.

```bash title="terminal"
aws configure sso                                   # creates a profile, e.g. "admin-sso"; follow the browser prompts
export AWS_PROFILE=admin-sso AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId" --output text | tr '\t' '\n' | grep nova
```

```json title="infra/bedrock-invoke-policy.json"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeOneModelOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:us-east-1:ACCOUNT_ID:inference-profile/us.amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0"
      ]
    }
  ]
}
```

```json title="infra/trust-policy.json"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    },
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT_ID:root" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

```bash title="terminal"
sed -i.bak "s/ACCOUNT_ID/$ACCOUNT_ID/g" infra/bedrock-invoke-policy.json infra/trust-policy.json
aws iam create-policy --policy-name answerer-bedrock-invoke --policy-document file://infra/bedrock-invoke-policy.json
aws iam create-role --role-name policy-answerer-app --assume-role-policy-document file://infra/trust-policy.json
aws iam attach-role-policy --role-name policy-answerer-app \
  --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/answerer-bedrock-invoke
```

Add a profile that assumes the role, in `~/.aws/config`:

```ini title="~/.aws/config (append)"
[profile answerer-app]
role_arn = arn:aws:iam::123456789012:role/policy-answerer-app
source_profile = admin-sso
region = us-east-1
```

**How this code works**
- `"Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]` → the Converse and ConverseStream APIs are authorised by these two actions. No `bedrock:*`, no list or admin actions.
- Two resources → a cross-region inference profile routes to the model in several US regions, so the role needs the profile ARN in your region and the foundation-model ARN in any region (`*`) the profile may use. Missing the second is the most common "AccessDenied even though I allowed it" cause. `# check the current docs` for your model's profile id.
- Trust policy → `ecs-tasks.amazonaws.com` lets a container task use the role in production; the account-root principal lets people in this account who already have `sts:AssumeRole` permission assume it for testing. In a real account, narrow that to one admin role ARN.
- `source_profile = admin-sso` → your human login assumes the app role, so local tests run with production's permissions, not your admin rights.

**Run it**
```bash title="terminal"
aws sts get-caller-identity --profile answerer-app
aws bedrock-runtime converse --profile answerer-app --model-id us.amazon.nova-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Say hello in five words."}]}]' --query "output.message.content[0].text"
aws bedrock-runtime converse --profile answerer-app --model-id us.amazon.nova-pro-v1:0 \
  --messages '[{"role":"user","content":[{"text":"hi"}]}]'
```

**You should see**
```text
{ "Arn": "arn:aws:sts::123456789012:assumed-role/policy-answerer-app/botocore-session-1730..." ... }
"Hello there, nice to meet!"
An error occurred (AccessDeniedException) when calling the Converse operation: User: arn:aws:sts::...:assumed-role/policy-answerer-app/... is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1:...:inference-profile/us.amazon.nova-pro-v1:0
```
The third call failing is the point: least privilege is proven by a denial, not by a success.

**If it breaks**
- `AccessDeniedException ... You don't have access to the model` on the allowed model → model access is not enabled in this account/region. Open Bedrock console → Model access and enable it (`# check the current docs`; many models are now enabled by default, some need a use-case form).
- `ValidationException: Invocation of model ID ... with on-demand throughput isn't supported` → you used the bare model id. Use the inference profile id (`us.amazon.nova-lite-v1:0`).
- `Error when retrieving token from sso: Token has expired` → run `aws sso login --profile admin-sso`.

> **Vertex AI:** create a service account, grant `roles/aiplatform.user` (or a custom role with `aiplatform.endpoints.predict`) on the project, and use Workload Identity instead of key files. **Azure AI Foundry:** use a managed identity with the `Cognitive Services OpenAI User` role scoped to one resource, and `DefaultAzureCredential` in code.

## Step 3 · Call Bedrock directly with boto3
**Goal:** the same app question answered by Bedrock through the native Converse API.

Before adding a gateway, call the platform directly once so you know what the gateway hides: a different request
shape, a different usage format, and credentials that come from the role, not a key.

```python title="app/bedrock_direct.py"
"""Answer one question through Bedrock's Converse API using the role's temporary credentials."""
import os
import time

import boto3
from botocore.config import Config

from app.answer import SYSTEM, retrieve
from app.llm import Completion

MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "us.amazon.nova-lite-v1:0")   # check the current docs
REGION = os.getenv("AWS_REGION", "us-east-1")

session = boto3.Session(profile_name=os.getenv("AWS_PROFILE", "answerer-app"), region_name=REGION)
runtime = session.client("bedrock-runtime", config=Config(retries={"max_attempts": 3, "mode": "adaptive"}))


def answer_bedrock(question: str) -> Completion:
    context = "\n\n".join(f"## {t}\n{b}" for t, b in retrieve(question)) or "(no matching sections)"
    start = time.perf_counter()
    resp = runtime.converse(
        modelId=MODEL_ID,
        system=[{"text": SYSTEM}],
        messages=[{"role": "user", "content": [{"text": f"Handbook sections:\n{context}\n\nQuestion: {question}"}]}],
        inferenceConfig={"maxTokens": 300, "temperature": 0},
    )
    return Completion(
        text=resp["output"]["message"]["content"][0]["text"],
        input_tokens=resp["usage"]["inputTokens"],
        output_tokens=resp["usage"]["outputTokens"],
        latency_ms=(time.perf_counter() - start) * 1000,
        model=MODEL_ID,
    )


if __name__ == "__main__":
    r = answer_bedrock("Which expense claims need director approval?")
    print(r.text)
    print(f"[{r.model} · {r.input_tokens} in / {r.output_tokens} out · {r.latency_ms:.0f} ms]")
```

**How this code works**
- `boto3.Session(profile_name=...)` → locally this assumes the app role; in ECS or Lambda you would drop `profile_name` and boto3 picks up the task role automatically. There is no API key anywhere.
- `Config(retries={"mode": "adaptive"})` → adaptive retry backs off on `ThrottlingException`, which you will meet once you hit the per-minute token quota.
- `system=[{"text": ...}]` and `content=[{"text": ...}]` → Converse wants lists of content blocks, not plain strings. This is exactly the translation a gateway will do for you.
- `resp["usage"]["inputTokens"]` → Bedrock's usage field names differ from OpenAI's `prompt_tokens`. Code that parses usage is one of the non-portable bits to list in your decision record.

**Run it**
```bash title="terminal"
python -m app.bedrock_direct
```

**You should see**
```text
Expense claims above 500 EUR need director approval.
[us.amazon.nova-lite-v1:0 · 198 in / 12 out · 640 ms]
```

**If it breaks**
- `botocore.exceptions.ProfileNotFound` → the `answerer-app` profile is missing from `~/.aws/config` (Step 2).
- `NoRegionError` → set `AWS_REGION=us-east-1`.
- Answer is wordier than OpenAI's → normal; different models follow "quote exact numbers" differently. The eval run in Step 8 decides whether it matters.

## Step 4 · Put the traffic on a private path
**Goal:** a VPC interface endpoint for Bedrock and a policy condition that refuses calls arriving any other way.

Regulated teams usually want model traffic to stay off the public internet. On AWS that means an interface endpoint
(PrivateLink) for `bedrock-runtime` in the VPC where the app runs. If you do not run anything in a VPC yet, still create
the files and record the design: you can apply it the day the app moves into ECS.

```bash title="terminal"
export VPC_ID=vpc-0abc...   SUBNETS="subnet-0aaa subnet-0bbb"   SG_ID=sg-0ccc...
aws ec2 create-vpc-endpoint --vpc-id $VPC_ID --vpc-endpoint-type Interface \
  --service-name com.amazonaws.$AWS_REGION.bedrock-runtime \
  --subnet-ids $SUBNETS --security-group-ids $SG_ID --private-dns-enabled \
  --query "VpcEndpoint.VpcEndpointId" --output text
```

Then add this second statement to `infra/bedrock-invoke-policy.json` (inside the `Statement` array) for the
production role only, replacing the endpoint id:

```json title="infra/bedrock-invoke-policy.json (second statement)"
{
  "Sid": "DenyUnlessViaVpcEndpoint",
  "Effect": "Deny",
  "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  "Resource": "*",
  "Condition": { "StringNotEquals": { "aws:SourceVpce": "vpce-0123456789abcdef0" } }
}
```

```bash title="terminal"
aws iam create-policy-version --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/answerer-bedrock-invoke \
  --policy-document file://infra/bedrock-invoke-policy.json --set-as-default
```

**How this code works**
- `--private-dns-enabled` → inside the VPC, `bedrock-runtime.us-east-1.amazonaws.com` now resolves to private IPs, so boto3 and LiteLLM need no code change to use the private path.
- The security group must allow inbound 443 from the app's subnets → a missing rule shows up as connection timeouts, not access errors.
- `Deny` with `aws:SourceVpce` → an explicit deny beats any allow, so even a leaked set of role credentials cannot be used from a laptop. Apply it only after you finish local testing, because your local calls will now be denied (that is the proof it works). `# check the current docs` for the condition keys Bedrock supports.
- Cost → interface endpoints bill per hour per AZ plus per GB processed; roughly $15 a month for two AZs (estimate). Delete it when the sandbox is done.

**Run it** (from an EC2 instance or CloudShell VPC environment inside that VPC)
```bash title="terminal"
nslookup bedrock-runtime.us-east-1.amazonaws.com
```

**You should see**
```text
Name:    bedrock-runtime.us-east-1.amazonaws.com
Address: 10.0.1.57
Address: 10.0.2.143
```
Private `10.x` addresses mean the endpoint is in use. From your laptop, the Converse call with the `answerer-app` profile now fails with an explicit-deny `AccessDeniedException`.

**If it breaks**
- Calls time out from inside the VPC → the endpoint's security group does not allow 443 from the caller.
- Public IPs still resolve → private DNS is off, or the VPC lacks `enableDnsHostnames` / `enableDnsSupport`.
- You locked yourself out of local testing → remove the deny statement (create a new policy version without it) while developing; re-add it before production.

## Step 5 · Write the data-handling record
**Goal:** a one-page record of where data is processed, what is logged, for how long and under which terms.

Compliance questions arrive before quality questions. Write the answers down now, with evidence from your account,
not from memory. Two commands give you the facts.

```bash title="terminal"
aws bedrock get-model-invocation-logging-configuration --profile admin-sso
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=bedrock.amazonaws.com \
  --max-results 5 --query "Events[].[EventTime,EventName,Username]" --output table
```

```markdown title="docs/data-handling.md"
# Data handling: policy answerer on Amazon Bedrock

| Question | Answer | Evidence |
|---|---|---|
| Where is inference processed? | US regions via the `us.` cross-region inference profile (us-east-1, us-east-2, us-west-2) | inference profile description |
| Does the data leave our AWS account boundary? | Requests go to the Bedrock service in-region; AWS states prompts are not shared with model providers | Bedrock data protection docs (link + date read) |
| Is our data used to train models? | No, per Bedrock service terms | service terms section, date read |
| What do WE log? | Model invocation logging: OFF (prompts not stored). CloudTrail: API metadata only (who, when, which model) | output of `get-model-invocation-logging-configuration` |
| Retention | CloudTrail event history 90 days; app logs 30 days, no prompt bodies | log group retention setting |
| Network path | VPC interface endpoint `vpce-...`, deny outside it | Step 4 policy |
| Encryption | TLS in transit; guardrail and logs encrypted with AWS-managed keys (customer-managed KMS key: not yet) | |
| Personal data | Employee questions may contain names/emails; masked by guardrail before the model | Step 7 |
| Fallback provider | OpenAI, used only on Bedrock failure; different terms (link) - see decision record | Step 6 |
| Open questions | Is a cross-region profile acceptable for EU employees? If not, use an EU profile or an in-region model | |
```

**How this code works**
- `get-model-invocation-logging-configuration` → an empty result means prompts and completions are not being stored by Bedrock logging. If you turn it on for debugging, the retention row changes and so does your risk.
- CloudTrail lookup → shows who invoked what. `# check the current docs`: depending on the API, Bedrock runtime calls may be recorded as data events that need a trail with data events enabled before they appear.
- The "Fallback provider" row → a fallback to a public API sends the same data to a second processor. Beginners forget this; auditors do not.

**Run it**
```bash title="terminal"
grep -c "|" docs/data-handling.md
```

**You should see**
```text
12
```
Every row filled, with a source and the date you read it.

**If it breaks**
- `lookup-events` returns nothing → invocations are not management events for your API, or happened more than a few minutes ago in another region. Check the trail configuration.
- You cannot answer a row → that is a finding. Put it in "Open questions"; do not guess.

## Step 6 · Put a gateway in front with a tested fallback
**Goal:** the unchanged app talks to a LiteLLM proxy that routes to Bedrock and falls back to the original provider.

The gateway turns the migration into configuration. The app keeps speaking OpenAI's format; LiteLLM translates to
Converse, signs with the role's credentials, and retries elsewhere on failure.

```yaml title="gateway/litellm.yaml"
model_list:
  - model_name: answerer                      # the name the app sends as MODEL
    litellm_params:
      model: bedrock/converse/us.amazon.nova-lite-v1:0   # check the current docs for the model string
      aws_region_name: us-east-1
      aws_profile_name: answerer-app
  - model_name: answerer-fallback
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

router_settings:
  num_retries: 1
  timeout: 30

litellm_settings:
  fallbacks: [{"answerer": ["answerer-fallback"]}]
  drop_params: true                           # silently drop OpenAI params Bedrock does not support

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

```yaml title="gateway/docker-compose.yml"
services:
  litellm:
    image: ghcr.io/berriai/litellm:main-stable   # pin an exact release tag for production; check the current docs
    ports:
      - "4000:4000"
    volumes:
      - ./litellm.yaml:/app/config.yaml:ro
      - ${HOME}/.aws:/root/.aws:ro               # Windows: ${USERPROFILE}/.aws
    environment:
      - OPENAI_API_KEY
      - LITELLM_MASTER_KEY
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    restart: unless-stopped
```

**How this code works**
- `model_name: answerer` → a logical name. The app asks for `answerer`; which provider serves it is the gateway's business.
- `bedrock/converse/...` → tells LiteLLM to use the Converse API, which normalises tool calls and system prompts across Bedrock models.
- `aws_profile_name` plus the read-only `~/.aws` mount → the container uses the same assumed role as Step 2. In ECS you remove both and the task role supplies credentials.
- `fallbacks` → on an error after retries, the same request is replayed against `answerer-fallback`. A fallback you never tested is not a fallback, so we test it next.
- `master_key` → the app now holds a gateway key, not a provider key. Issue per-app virtual keys from it later.

**Run it**
```bash title="terminal"
export LITELLM_MASTER_KEY=sk-local-$(openssl rand -hex 8)
docker compose -f gateway/docker-compose.yml up -d
export BASE_URL=http://localhost:4000 MODEL=answerer API_KEY=$LITELLM_MASTER_KEY
python -m app.answer "What is the notice period after probation?"
```
Now break the primary on purpose: change the first model to `bedrock/converse/us.amazon.nova-pro-v1:0` (the role is
not allowed to call it), restart, and ask again.
```bash title="terminal"
docker compose -f gateway/docker-compose.yml restart && python -m app.answer "What is the notice period after probation?"
```

**You should see**
```text
The notice period after probation is 3 months for both sides.
[us.amazon.nova-lite-v1:0 · 205 in / 13 out · 702 ms]
...after breaking the primary:
The notice period after probation is 3 months for both sides.
[gpt-4o-mini-2024-07-18 · 230 in / 12 out · 1510 ms]
```
The `model` field changed and latency rose: the fallback works. Restore the Nova Lite line and restart.

**If it breaks**
- `Unable to locate credentials` in `docker compose logs litellm` → the `.aws` mount path is wrong, or your SSO token expired (`aws sso login`).
- 401 from the gateway → `API_KEY` in your shell does not match `LITELLM_MASTER_KEY`.
- Fallback never fires → check the error is not swallowed by `num_retries`; LiteLLM logs `Fallback attempt` lines when it switches.

## Step 7 · Buy one component, keep one
**Goal:** a managed Bedrock Guardrail masks PII in questions, and the hand-built retriever stays, each with a reason.

"Managed" is not all-or-nothing. Buy where the platform is clearly better (PII detection is tedious and specialised);
keep what is small, tested and cheaper to own (an eight-section retriever does not need a vector database with a
monthly floor).

```python title="infra/create_guardrail.py"
"""Create a PII guardrail once, with your admin profile. Prints the env vars the app needs."""
import os

import boto3

bedrock = boto3.Session(profile_name=os.getenv("ADMIN_PROFILE", "admin-sso"),
                        region_name=os.getenv("AWS_REGION", "us-east-1")).client("bedrock")

resp = bedrock.create_guardrail(  # check the current docs for supported PII types
    name="answerer-pii",
    description="Mask contact details and block card numbers in employee questions",
    sensitiveInformationPolicyConfig={
        "piiEntitiesConfig": [
            {"type": "EMAIL", "action": "ANONYMIZE"},
            {"type": "PHONE", "action": "ANONYMIZE"},
            {"type": "CREDIT_DEBIT_CARD_NUMBER", "action": "BLOCK"},
        ]
    },
    blockedInputMessaging="Please remove card numbers from your question and ask again.",
    blockedOutputsMessaging="Sorry, I can't share that.",
)
guardrail_id = resp["guardrailId"]
version = bedrock.create_guardrail_version(guardrailIdentifier=guardrail_id, description="v1")["version"]
print(f"export GUARDRAIL_ID={guardrail_id} GUARDRAIL_VERSION={version}")
```

```python title="app/guard.py"
"""Screen user input with a Bedrock Guardrail. No-op when GUARDRAIL_ID is unset."""
import os

import boto3

GUARDRAIL_ID = os.getenv("GUARDRAIL_ID")
GUARDRAIL_VERSION = os.getenv("GUARDRAIL_VERSION", "1")
_runtime = None


def _client():
    global _runtime
    if _runtime is None:
        session = boto3.Session(profile_name=os.getenv("AWS_PROFILE", "answerer-app"),
                                region_name=os.getenv("AWS_REGION", "us-east-1"))
        _runtime = session.client("bedrock-runtime")
    return _runtime


def screen_input(text: str) -> tuple[str, bool]:
    """Return (text to send on, blocked?)."""
    if not GUARDRAIL_ID:
        return text, False
    resp = _client().apply_guardrail(
        guardrailIdentifier=GUARDRAIL_ID,
        guardrailVersion=GUARDRAIL_VERSION,
        source="INPUT",
        content=[{"text": {"text": text}}],
    )
    if resp["action"] != "GUARDRAIL_INTERVENED":
        return text, False
    entities = []
    for assessment in resp.get("assessments", []):
        entities += assessment.get("sensitiveInformationPolicy", {}).get("piiEntities", [])
    blocked = any(e.get("action") == "BLOCKED" for e in entities)
    outputs = resp.get("outputs", [])
    return (outputs[0]["text"] if outputs else text), blocked
```

Add the guardrail permission to the app role's policy as a third statement, then edit `app/answer.py`:

```json title="infra/bedrock-invoke-policy.json (third statement)"
{
  "Sid": "ApplyOurGuardrail",
  "Effect": "Allow",
  "Action": "bedrock:ApplyGuardrail",
  "Resource": "arn:aws:bedrock:us-east-1:ACCOUNT_ID:guardrail/GUARDRAIL_ID"
}
```

```python title="app/answer.py (replace the answer function)"
def answer(question: str) -> Completion:
    from app.guard import screen_input

    question, blocked = screen_input(question)
    if blocked:
        return Completion(text=question, input_tokens=0, output_tokens=0, latency_ms=0.0, model="guardrail")
    hits = retrieve(question)
    context = "\n\n".join(f"## {t}\n{b}" for t, b in hits) or "(no matching sections)"
    return chat(SYSTEM, f"Handbook sections:\n{context}\n\nQuestion: {question}")
```

**How this code works**
- `ANONYMIZE` vs `BLOCK` → emails become `{EMAIL}` and the question still goes through; a card number stops the request. Choose per entity, and write the choice down.
- `apply_guardrail(source="INPUT")` → screens text independently of any model call, so the guardrail works no matter which backend the gateway picks, including the fallback.
- `blocked` from the per-entity `action` → `GUARDRAIL_INTERVENED` alone does not tell masking from blocking. Beginners treat every intervention as a block and refuse harmless questions.
- The import inside `answer()` → evals and tests still run without AWS when `GUARDRAIL_ID` is unset.

**Run it**
```bash title="terminal"
python infra/create_guardrail.py           # then paste the printed export line
aws iam create-policy-version --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/answerer-bedrock-invoke \
  --policy-document file://infra/bedrock-invoke-policy.json --set-as-default
python -m app.answer "I'm jane.doe@corp.com, how much sick leave do I get?"
python -m app.answer "Refund to card 4111 1111 1111 1111 for my expense claim?"
```

**You should see**
```text
Employees get 12 days of paid sick leave per year.
[us.amazon.nova-lite-v1:0 · 203 in / 13 out · 980 ms]
Please remove card numbers from your question and ask again.
[guardrail · 0 in / 0 out · 0 ms]
```

**If it breaks**
- `AccessDeniedException ... bedrock:ApplyGuardrail` → you did not add the third statement or forgot to substitute the ids.
- `ValidationException: guardrailVersion` → use the number printed by the script, not `DRAFT`, in production.
- Write the "keep" reason in the decision record now: "Retriever kept: 8 sections, 100% retrieval hit rate on evals, a managed knowledge base adds a vector store with a standing monthly cost."

## Step 8 · Re-run the evals and compare
**Goal:** a before/after table for quality, latency and cost on the same cases.

Migration is an eval exercise. Run the identical suite through the gateway with Bedrock prices, then compare. Add a
small offline test too, so retrieval changes are caught without any cloud call.

```python title="evals/compare.py"
"""Print a markdown table comparing every saved run in results/."""
import json
from pathlib import Path

rows = []
for path in sorted(Path("results").glob("*.json")):
    s = json.loads(path.read_text())["summary"]
    rows.append(
        f"| {s['label']} | {', '.join(s['models'])} | {s['pass_rate']:.0%} | {s['errors']} | "
        f"{s['p50_ms']:.0f} | {s['p95_ms']:.0f} | ${s['cost_per_1k_requests_usd']:.3f} |"
    )
print("| run | model(s) | pass | errors | p50 ms | p95 ms | $/1k req |")
print("|---|---|---|---|---|---|---|")
print("\n".join(rows))
```

```python title="tests/test_retrieval.py"
from app.answer import retrieve


def test_expense_question_hits_expenses_section():
    titles = [t for t, _ in retrieve("What is the meal limit for expenses?")]
    assert titles[0] == "Expenses"


def test_unrelated_question_returns_nothing_relevant():
    titles = [t for t, _ in retrieve("pension contribution rate")]
    assert "Annual leave" not in titles
```

**How this code works**
- Same `cases.jsonl`, different env → the only variable is the backend, which is what makes the comparison fair.
- `compare.py` reads every run → keep adding runs (second platform, open-weight model) and the table grows.
- The tests import only `retrieve` → they run in CI without credentials and protect the component you chose to keep.

**Run it**
```bash title="terminal"
pytest -q
PRICE_IN_PER_M=0.06 PRICE_OUT_PER_M=0.24 python -m evals.run_evals --label bedrock-nova-lite   # example prices, check current pricing
python -m evals.compare
```

**You should see**
```text
2 passed in 0.05s
| run | model(s) | pass | errors | p50 ms | p95 ms | $/1k req |
|---|---|---|---|---|---|---|
| baseline-openai | gpt-4o-mini-2024-07-18 | 100% | 0 | 790 | 1421 | $0.046 |
| bedrock-nova-lite | us.amazon.nova-lite-v1:0 | 92% | 0 | 655 | 1180 | $0.016 |
```
A drop like 92% is a real finding. Open the failing rows: often the model paraphrased "1,000 EUR" as "€1000". Decide
whether to adjust the prompt, the scorer, or the model, and record which.

**If it breaks**
- Every case errors with `RateLimitError` → you hit the on-demand tokens-per-minute quota; add `time.sleep(1)` between cases or request a quota increase.
- Pass rate swings between runs → set `temperature: 0` (already done) and run twice; report the lower number.

## Step 9 · Size capacity, set a budget, find the break-even
**Goal:** known quotas, a budget alert on Bedrock spend, and the monthly volume where another pricing model wins.

```bash title="terminal"
aws service-quotas list-service-quotas --service-code bedrock \
  --query "Quotas[?contains(QuotaName, 'Nova Lite')].[QuotaName,Value]" --output table
```

```json title="infra/budget.json"
{
  "BudgetName": "bedrock-monthly",
  "BudgetLimit": { "Amount": "20", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": { "Service": ["Amazon Bedrock"] }
}
```

```json title="infra/budget-notifications.json"
[
  {
    "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN", "Threshold": 80, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "you@example.com" }]
  },
  {
    "Notification": { "NotificationType": "FORECASTED", "ComparisonOperator": "GREATER_THAN", "Threshold": 100, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [{ "SubscriptionType": "EMAIL", "Address": "you@example.com" }]
  }
]
```

```python title="tools/breakeven.py"
"""Monthly cost of per-token pricing vs a self-hosted GPU, and where they cross."""
import argparse

p = argparse.ArgumentParser()
p.add_argument("--in-tokens", type=float, default=210, help="avg input tokens per request (from results/)")
p.add_argument("--out-tokens", type=float, default=25, help="avg output tokens per request")
p.add_argument("--price-in", type=float, default=0.06, help="USD per 1M input tokens (example)")
p.add_argument("--price-out", type=float, default=0.24, help="USD per 1M output tokens (example)")
p.add_argument("--gpu-hourly", type=float, default=1.0, help="USD per GPU-hour incl. overhead (estimate)")
p.add_argument("--gpus", type=int, default=2, help="GPUs kept running for availability")
args = p.parse_args()

per_request = args.in_tokens / 1e6 * args.price_in + args.out_tokens / 1e6 * args.price_out
self_hosted_month = args.gpu_hourly * args.gpus * 730
print(f"per-token cost per request: ${per_request:.6f}")
print(f"self-hosted fixed cost per month: ${self_hosted_month:,.0f}")
print("| requests/month | per-token $ | self-hosted $ | cheaper |")
print("|---|---|---|---|")
for volume in [10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]:
    token_cost = per_request * volume
    winner = "per-token" if token_cost < self_hosted_month else "self-hosted"
    print(f"| {volume:,} | {token_cost:,.2f} | {self_hosted_month:,.0f} | {winner} |")
print(f"break-even: {self_hosted_month / per_request:,.0f} requests/month")
```

**How this code works**
- `service-quotas` → requests-per-minute and tokens-per-minute per model and region. Divide tokens-per-minute by your average tokens per request to get the real ceiling, then compare with peak traffic.
- `CostFilters: Service` → limits the budget to Bedrock spend. Third-party models sold through AWS Marketplace can bill under different service names; `# check the current docs` and widen the filter if needed.
- Two notifications → the `FORECASTED` alert catches a runaway agent loop days before the actual spend crosses the line.
- `breakeven.py` → uses your measured tokens per request. `gpus=2` because one self-hosted GPU has no redundancy; that is the honest comparison against a managed service.

**Run it**
```bash title="terminal"
aws budgets create-budget --account-id $ACCOUNT_ID --budget file://infra/budget.json \
  --notifications-with-subscribers file://infra/budget-notifications.json
python tools/breakeven.py
```

**You should see**
```text
per-token cost per request: $0.000019
self-hosted fixed cost per month: $1,460
| requests/month | per-token $ | self-hosted $ | cheaper |
| 10,000,000 | 186.00 | 1,460 | per-token |
| 100,000,000 | 1,860.00 | 1,460 | self-hosted |
break-even: 78,494,624 requests/month
```

**If it breaks**
- `AccessDeniedException` on `create-budget` → run it with the admin profile, not the app role.
- No quota rows → quota names change; drop the `contains` filter and search the full list.

## Step 10 · Write the decision record
**Goal:** a one-page record someone can read in five minutes and act on.

```markdown title="docs/decision-record.md"
# ADR-001: Run the policy answerer on Amazon Bedrock behind LiteLLM

**Status:** accepted · **Date:** 2026-11-06 · **Owner:** you

## Workload
Employee HR questions, ~2,000/day, peak 5 rps, p95 target 2 s, answers must quote handbook numbers.

## Constraints
No long-lived provider keys; traffic stays in our AWS network; personal data masked before inference; spend alert at $20/month.

## Decision
Bedrock (Nova Lite via `us.` inference profile) behind a self-hosted LiteLLM gateway, OpenAI as tested fallback.

## Results (same 12 eval cases)
| run | pass | p50 ms | p95 ms | $/1k req |
|---|---|---|---|---|
| before (OpenAI) | 100% | 790 | 1421 | 0.046 |
| after (Bedrock) | 100% after prompt fix | 655 | 1180 | 0.016 |

## Bought vs built
- Bought: Bedrock Guardrails for PII (better coverage than our regexes; works for every backend).
- Built and kept: keyword retriever (8 sections, passes evals, a managed knowledge base adds a standing monthly cost).

## Capacity and cost
Quota: X tokens/min = ~Y req/min at 235 tokens/request, 10x our peak. Self-hosting wins above ~78M requests/month.

## Risks
Fallback sends data to a second processor (see data-handling.md). Gateway is now on the critical path: two replicas, health check, documented bypass (set BASE_URL to Bedrock-compatible endpoint).

## Exit plan
Portable: prompts, evals, retriever, app code (OpenAI format). Not portable: IAM policy, guardrail config, VPC endpoint. Moving to Vertex AI or Foundry = new gateway entry + identity + guardrail equivalent; estimated 2 days plus an eval run.
```

**How this code works**
- Results table → copy from `python -m evals.compare`; numbers, not adjectives.
- Exit plan → lists exactly what does not travel. That list is the real cost of lock-in.

**Run it**
```bash title="terminal"
wc -w docs/decision-record.md
```

**You should see**
```text
310 docs/decision-record.md
```
Keep it under about 500 words.

**If it breaks**
- You cannot fill a section → you skipped a step; go back rather than writing "TBD".

## Ship it
- Run the gateway and app in your cloud account (ECS Fargate with the task role from Step 2 is the shortest path); remove `aws_profile_name` and the `.aws` mount, then re-run the evals against the deployed URL and add that row to the table.
- README: what the app does, the before/after table, the architecture diagram, how to run locally (`docker compose up`, env vars), and links to `docs/data-handling.md` and `docs/decision-record.md`.
- Demo checklist: an answer served by Bedrock, the denied call to a non-allowed model, the fallback switch, a masked email, the budget in the Billing console.
- Portfolio write-up: pass rate before/after, p50/p95, cost per 1,000 requests, the break-even volume, and one surprise (for example the paraphrased "1,000 EUR").
- Clean up: delete the VPC endpoint, the guardrail and the budget when you are done if this is a sandbox.

## Going further
- Add Vertex AI (`vertex_ai/gemini-2.0-flash`) or Azure AI Foundry (`azure_ai/...`) as a second backend in `litellm.yaml`, run the evals, and add a row (`# check the current docs` for model strings).
- Serve one open-weight model (for example Llama on Bedrock or your own vLLM) behind the same gateway name and compare its cost at your volume.
- Issue per-feature virtual keys with budgets from LiteLLM (requires its Postgres database).
- Replace the account-root trust principal with an exact admin role ARN and add an SCP restricting Bedrock to approved regions.
- Turn on model invocation logging to an encrypted S3 bucket with a 30-day lifecycle, and update the data-handling record.
