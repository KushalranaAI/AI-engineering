---
project: resume-screening-agent
title: Resume screening agent
hours: 8
stack: Python 3.11, OpenAI-compatible API with tool calling, pydantic v2, pypdf, FastAPI, SQLite, pytest
cost: About $1 of API calls (24 labelled pairs, a few eval runs)
---

You will build a screening assistant that reads a resume and a job description, uses tools to normalise skills and
compute years of experience, and returns a validated report: which requirements are met, verbatim evidence quotes,
a rubric score, and interview questions. It never rejects anyone. Every result lands in a review queue where a person
makes the decision. The README will show agreement with your own hand labels and a counterfactual bias test, which is
the evidence that you can make model output dependable *and* responsible.

## Before you start
- Python 3.11+, an API key for an OpenAI-compatible provider whose model supports tool calling (`gpt-4o-mini`, or Ollama with `qwen2.5` / `llama3.1`).
- Builds on the structured-output and tool-calling projects from earlier levels. Reuse your retry helper if you wrote one.
- **Responsible-use rule for this project:** use synthetic resumes (generated in Step 2) or your own, never real candidates' data scraped from the web. Automated hiring decisions are regulated in many places (for example NYC Local Law 144 and the EU AI Act treats hiring systems as high-risk). This tool assists a human; it does not decide.

```text title="final layout"
screener/
├── app/
│   ├── llm.py         # client + validated JSON helper
│   ├── schemas.py     # JobSpec, SkillAssessment, ScreeningResult
│   ├── parse.py       # PDF/text reading + redaction
│   ├── tools.py       # skill lookup, years calculator, validated args
│   ├── checks.py      # grounding, fairness filters, rubric score
│   ├── agent.py       # tool loop + final structured report
│   └── api.py         # FastAPI + human review queue
├── data/skills.json
├── data/make_samples.py
├── eval/agreement.py
├── eval/counterfactual.py
├── tests/test_checks.py
└── pytest.ini
```

## How it fits together

```text
 resume.pdf ──► read_text ──► redact (name, contact, DOB, pronouns...)
                                   │
 job.txt ──► LLM → JobSpec ────────┤
                                   ▼
                  tool loop: lookup_skill · years_of_experience   (args validated by pydantic)
                                   ▼
                  LLM → ScreeningDraft (JSON, schema-validated, retried)
                                   ▼
          checks: every quote must appear in the resume · no protected-attribute questions
                                   ▼
          code computes score + band ──► ScreeningResult(status="pending_human_review")
                                   ▼
                     review queue ──► a person records advance / hold / decline + reason
```

The resume is redacted before any model sees it. The job description becomes a list of requirements. The model may
call two tools, each with validated arguments, then writes a draft assessment. Code, not the model, checks every
quote against the resume and computes the score from a fixed rubric. The only status the system can produce is
"pending human review".

## Step 1 · Define the output contract
**Goal:** pydantic models that make the wrong outputs impossible to represent.

Start from the output, because it decides everything else. Two decisions matter: the model never produces the score
(it is computed in code from verified facts), and the result type cannot express a rejection.

```bash title="terminal"
mkdir screener && cd screener
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install "openai>=1.40" "pydantic>=2.7" pypdf fastapi uvicorn python-multipart pytest
mkdir -p app data/resumes data/jds eval tests && touch app/__init__.py
printf "[pytest]\npythonpath = .\n" > pytest.ini
```

```python title="app/schemas.py"
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Requirement(BaseModel):
    skill: str = Field(description="lowercase canonical skill name, e.g. 'python', 'kubernetes'")
    importance: Literal["must", "nice"]
    min_years: float | None = Field(default=None, ge=0, le=40)


class JobSpec(BaseModel):
    title: str
    requirements: list[Requirement] = Field(min_length=1, max_length=20)


class SkillAssessment(BaseModel):
    skill: str
    met: bool
    evidence: list[str] = Field(default_factory=list, description="quotes copied EXACTLY from the resume")
    years_found: float | None = Field(default=None, ge=0, le=60)

    @model_validator(mode="after")
    def met_needs_evidence(self):
        if self.met and not self.evidence:
            raise ValueError(f"'{self.skill}' is marked met but has no evidence quote")
        return self


class ScreeningDraft(BaseModel):
    """What the model is allowed to produce."""
    assessments: list[SkillAssessment]
    interview_questions: list[str] = Field(min_length=3, max_length=6)
    concerns: list[str] = Field(default_factory=list)


class ScreeningResult(BaseModel):
    """What the system returns. Built by code from a checked draft."""
    candidate_id: str
    job_title: str
    assessments: list[SkillAssessment]
    must_have_met: list[str]
    must_have_missing: list[str]
    score: int = Field(ge=0, le=100)
    band: Literal["strong", "possible", "weak"]
    interview_questions: list[str]
    concerns: list[str]
    status: Literal["pending_human_review"] = "pending_human_review"
```

**How this code works**
- `Literal["must", "nice"]` → the model cannot invent a third importance level that your scoring code does not handle.
- `met_needs_evidence` → a validator that rejects "met" without a quote. Validation failures are fed back to the model in Step 3, so this rule shapes behaviour, not just errors.
- `ScreeningDraft` has no score field. If the model rates candidates directly, you cannot explain or audit the number. A rubric in code can be.
- `status: Literal["pending_human_review"]` → there is no value for "rejected". A future teammate cannot add auto-rejection without changing the contract, which shows up in code review.
- `band` is a triage hint for the reviewer's queue order, not an outcome.

**Run it**
```bash title="terminal"
python -c "
from app.schemas import SkillAssessment
try: SkillAssessment(skill='python', met=True)
except Exception as e: print(type(e).__name__, '|', e.errors()[0]['msg'])"
```

**You should see**
```text
ValidationError | Value error, 'python' is marked met but has no evidence quote
```

**If it breaks**
- `ImportError: model_validator` → you have pydantic v1. `pip install -U "pydantic>=2.7"`.

## Step 2 · Generate a small, realistic dataset
**Goal:** 3 job descriptions, 24 synthetic resumes, a skills taxonomy and a `pairs.csv` for you to label.

Real resumes contain personal data you should not put in a public repo. Synthetic ones let you publish the test set,
and you control the variety: different seniorities, career breaks, and names and pronouns across genders and cultures
for the bias test later.

```json title="data/skills.json"
{
  "python": ["py", "python3"],
  "sql": ["postgresql", "postgres", "mysql", "t-sql"],
  "machine learning": ["ml", "scikit-learn", "sklearn"],
  "docker": ["containers", "containerization"],
  "kubernetes": ["k8s", "eks", "gke"],
  "aws": ["amazon web services", "ec2", "s3", "lambda"],
  "react": ["react.js", "reactjs"],
  "typescript": ["ts"],
  "data visualization": ["tableau", "power bi", "looker"],
  "stakeholder management": ["stakeholder communication"],
  "llm applications": ["rag", "prompt engineering", "langchain", "llm"]
}
```

```python title="data/make_samples.py"
"""Generate synthetic JDs and resumes. Review them: they are test fixtures, so they must be realistic."""
import csv
import json
import os

from openai import OpenAI

client = OpenAI(base_url=os.getenv("BASE_URL") or None, api_key=os.getenv("OPENAI_API_KEY", "not-needed"))
MODEL = os.getenv("MODEL", "gpt-4o-mini")

JOBS = {
    "backend": "Senior backend engineer: Python, SQL, Docker, AWS; Kubernetes is a plus; 5+ years.",
    "analyst": "Data analyst: SQL, Python, data visualization, stakeholder management; 2+ years.",
    "ai_eng": "AI engineer: Python, LLM applications, Docker; machine learning and AWS are a plus; 3+ years.",
}
PERSONAS = [  # varied names, genders, backgrounds; fit is a hint for generation, NOT the label
    ("Priya Raman", "she", "strong"), ("Tom Becker", "he", "strong"), ("Amara Okafor", "she", "possible"),
    ("Luis Ortega", "he", "possible"), ("Mei Chen", "she", "weak"), ("Sam Taylor", "they", "possible"),
    ("Yusuf Demir", "he", "weak"), ("Hannah Kowalski", "she", "strong"),
]


def ask(prompt: str) -> str:
    resp = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": prompt}], temperature=0.9)
    return resp.choices[0].message.content.strip()


rows = []
for job_id, brief in JOBS.items():
    jd = ask(f"Write a realistic 200-word job description for: {brief}. Plain text, no markdown.")
    open(f"data/jds/{job_id}.txt", "w", encoding="utf-8").write(jd)
    for i, (name, pronoun, fit) in enumerate(PERSONAS):
        resume = ask(
            f"Write a realistic plain-text resume (250-350 words) for {name} (pronouns {pronoun}). "
            f"First line is the name, then email and phone. Include a summary written in third person, "
            f"jobs with dates as 'Mon YYYY - Mon YYYY' or 'present', skills and education. "
            f"Make them a {fit} fit for this role: {brief}. Do not state the fit."
        )
        cid = f"{job_id}_{i:02d}"
        open(f"data/resumes/{cid}.txt", "w", encoding="utf-8").write(resume)
        rows.append({"candidate_id": cid, "job_id": job_id, "label": ""})
        print("wrote", cid)

with open("data/pairs.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["candidate_id", "job_id", "label"])
    writer.writeheader()
    writer.writerows(rows)
print(json.dumps({"jds": len(JOBS), "resumes": len(rows)}))
```

**How this code works**
- `temperature=0.9` → variety in the fixtures. The screener itself runs at temperature 0.
- `fit` steers generation but is deliberately *not* saved as the label. Labels must come from you reading each resume, otherwise you are measuring the generator against itself.
- "summary written in third person" plants pronouns, so redaction has something to remove.

**Run it**
```bash title="terminal"
python data/make_samples.py
```

**You should see**
```text
wrote backend_00
...
{"jds": 3, "resumes": 24}
```

Now **label by hand**: read each resume against its JD and fill `label` in `pairs.csv` with `strong`, `possible` or
`weak`. Write one sentence per label in a notes column if you like. Thirty minutes of careful labelling is the most
valuable half hour in this project.

**If it breaks**
- Resumes all look alike → raise temperature or add a detail per persona ("career break 2020-2022", "bootcamp graduate").
- `FileNotFoundError: data/jds/...` → run from the `screener/` folder so relative paths resolve.

## Step 3 · Parse, redact, and get validated JSON
**Goal:** text out of PDFs, protected attributes removed, and a helper that returns a validated pydantic object or fails loudly.

```python title="app/parse.py"
import io
import re

from pypdf import PdfReader

PROTECTED_LINE = re.compile(
    r"^\s*(name|date of birth|dob|age|gender|sex|pronouns|nationality|citizenship|"
    r"marital status|religion|photo|visa status)\s*[:\-].*$",
    re.IGNORECASE | re.MULTILINE,
)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b")
URL = re.compile(r"(?:https?://|www\.)\S+|linkedin\.com/\S+|github\.com/\S+", re.IGNORECASE)
GENDERED = re.compile(r"\b(he|she|him|her|his|hers|himself|herself|mr|mrs|ms|miss)\b\.?", re.IGNORECASE)


def read_text(filename: str, data: bytes) -> str:
    if filename.lower().endswith(".pdf"):
        return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)
    return data.decode("utf-8", errors="replace")


def redact(text: str) -> str:
    """Remove identity and protected-attribute signals before any model sees the resume."""
    lines = text.strip().splitlines()
    if lines:
        lines[0] = "[CANDIDATE]"  # resumes almost always open with the person's name
    text = "\n".join(lines)
    text = PROTECTED_LINE.sub("[REDACTED]", text)
    text = EMAIL.sub("[EMAIL]", text)
    text = PHONE.sub("[PHONE]", text)
    text = URL.sub("[LINK]", text)
    text = GENDERED.sub("they", text)
    return text
```

```python title="app/llm.py"
import json
import os
from typing import TypeVar

from openai import OpenAI
from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)
MODEL = os.getenv("MODEL", "gpt-4o-mini")
client = OpenAI(base_url=os.getenv("BASE_URL") or None, api_key=os.getenv("OPENAI_API_KEY", "not-needed"))


def structured(messages: list[dict], schema: type[T], retries: int = 2) -> T:
    """Ask for JSON matching `schema`. On validation failure, show the model its error and retry."""
    system = f"Reply with ONE JSON object that matches this JSON Schema:\n{json.dumps(schema.model_json_schema())}"
    convo = [{"role": "system", "content": system}, *messages]
    for _ in range(retries + 1):
        resp = client.chat.completions.create(
            model=MODEL, messages=convo, temperature=0,
            response_format={"type": "json_object"},  # check the current docs for your provider
        )
        raw = resp.choices[0].message.content or ""
        try:
            return schema.model_validate_json(raw)
        except ValidationError as err:
            convo += [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": f"That JSON failed validation:\n{err}\nReturn corrected JSON only."},
            ]
    raise ValueError(f"model did not produce a valid {schema.__name__} after {retries + 1} attempts")
```

**How this code works**
- `lines[0] = "[CANDIDATE]"` → crude but effective: the name is the strongest proxy for gender and ethnicity on a resume.
- `PHONE` requires three digit groups, so date ranges like `2019 - 2023` survive. The years calculator needs them.
- `GENDERED.sub("they", ...)` → grammar gets slightly odd; the model copes, and the quotes it returns will come from the redacted text, which is what we check against.
- Redaction is a mitigation, not a guarantee: university names, club memberships and graduation years can still hint at age or background. Say this in the README. The counterfactual test in Step 7 measures what is left.
- `T = TypeVar("T", bound=BaseModel)` → `structured(..., JobSpec)` is typed as returning a `JobSpec`, so your editor autocompletes fields.
- The retry loop sends the exact pydantic error back. Models fix "field required" or "met without evidence" reliably on the second try.

**Run it**
```bash title="terminal"
python -c "
from app.parse import redact
print(redact(open('data/resumes/backend_00.txt').read())[:300])"
```

**You should see**
```text
[CANDIDATE]
[EMAIL] | [PHONE]

Summary
Backend engineer with 7 years of experience. they has led migrations of monolithic services to AWS...
```

**If it breaks**
- `response_format` rejected → some local servers do not support JSON mode. Remove the argument; the validation retry still catches bad output.
- Dates disappear → your resumes use a format like `2019.01-2023.03`. Test `PHONE` against it and tighten the pattern.

## Step 4 · Tools with validated arguments
**Goal:** two tools the model can call, each guarded by a pydantic model so bad arguments become readable errors.

Models are bad at date arithmetic with overlapping jobs, and inconsistent about skill names ("k8s" vs "Kubernetes").
Both are perfect tool jobs: deterministic, testable, and cheap.

```python title="app/tools.py"
import json
from datetime import date
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

TAXONOMY: dict[str, list[str]] = json.loads(Path("data/skills.json").read_text(encoding="utf-8"))
ALIASES = {alias.lower(): canon for canon, aliases in TAXONOMY.items() for alias in [canon, *aliases]}


class LookupArgs(BaseModel):
    term: str = Field(min_length=1, max_length=60)


class Period(BaseModel):
    start: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="YYYY-MM")
    end: str = Field(pattern=r"^(\d{4}-(0[1-9]|1[0-2])|present)$", description="YYYY-MM or 'present'")


class YearsArgs(BaseModel):
    periods: list[Period] = Field(min_length=1, max_length=30)


def lookup_skill(args: LookupArgs) -> dict:
    canon = ALIASES.get(args.term.lower().strip())
    return {"term": args.term, "canonical": canon, "aliases": TAXONOMY.get(canon, []) if canon else []}


def _month(value: str) -> int:
    if value == "present":
        today = date.today()
        return today.year * 12 + today.month - 1
    year, month = map(int, value.split("-"))
    return year * 12 + month - 1


def years_of_experience(args: YearsArgs) -> dict:
    spans = sorted((_month(p.start), _month(p.end) + 1) for p in args.periods)
    merged: list[list[int]] = []
    for start, end in spans:
        if end <= start:
            raise ValueError(f"period ends before it starts: {start} -> {end}")
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)  # overlapping jobs count once
        else:
            merged.append([start, end])
    months = sum(end - start for start, end in merged)
    return {"years": round(months / 12, 1), "distinct_periods": len(merged)}


REGISTRY = {
    "lookup_skill": (LookupArgs, lookup_skill, "Map a skill name or alias to its canonical name."),
    "years_of_experience": (YearsArgs, years_of_experience,
                            "Total non-overlapping years across employment periods given as YYYY-MM."),
}
TOOL_SPECS = [
    {"type": "function", "function": {"name": name, "description": desc, "parameters": model.model_json_schema()}}
    for name, (model, _, desc) in REGISTRY.items()
]


def call_tool(name: str, raw_arguments: str) -> str:
    """Validate arguments, run the tool, and always return a JSON string (errors included)."""
    if name not in REGISTRY:
        return json.dumps({"error": f"unknown tool '{name}'"})
    args_model, fn, _ = REGISTRY[name]
    try:
        return json.dumps(fn(args_model.model_validate_json(raw_arguments)))
    except (ValidationError, ValueError) as err:
        return json.dumps({"error": str(err)})
```

**How this code works**
- `ALIASES` flattens the taxonomy into `{"k8s": "kubernetes", "kubernetes": "kubernetes", ...}` for O(1) lookup.
- `Period` regexes reject `2023-13` and `"last year"` before any arithmetic runs.
- The merge loop counts overlapping jobs once: two concurrent part-time roles from 2020 to 2022 are two years, not four.
- `TOOL_SPECS` is generated from the same pydantic models that validate the arguments, so the schema the model sees can never drift from the checks you run.
- `call_tool` never raises. A tool error goes back to the model as JSON (`{"error": ...}`), and the model can correct its call on the next turn instead of the whole request crashing.

**Run it**
```bash title="terminal"
python -c "
from app.tools import call_tool
print(call_tool('lookup_skill', '{\"term\": \"K8s\"}'))
print(call_tool('years_of_experience', '{\"periods\": [{\"start\": \"2018-01\", \"end\": \"2020-12\"}, {\"start\": \"2020-06\", \"end\": \"2022-12\"}]}'))
print(call_tool('years_of_experience', '{\"periods\": [{\"start\": \"last year\", \"end\": \"present\"}]}')[:80])"
```

**You should see**
```text
{"term": "K8s", "canonical": "kubernetes", "aliases": ["k8s", "eks", "gke"]}
{"years": 5.0, "distinct_periods": 1}
{"error": "1 validation error for YearsArgs\nperiods.0.start\n  String should match pat
```

**If it breaks**
- `FileNotFoundError: data/skills.json` → the tool module reads a relative path; start Python from `screener/`.

## Step 5 · Grounding, fairness filters and the rubric
**Goal:** code that verifies every quote, strips questions about protected attributes, and computes the score.

This is the step that turns a demo into something dependable. The model's draft is treated as a claim to be
checked, never as the answer.

```python title="app/checks.py"
import re

from app.schemas import JobSpec, ScreeningDraft, ScreeningResult, SkillAssessment

PROTECTED_TOPICS = re.compile(
    r"\b(age|old|young|gender|married|marriage|pregnan\w*|children|kids|family plans|religio\w*|"
    r"nationality|ethnic\w*|race|disabilit\w*|health|accent|native speaker|citizenship)\b",
    re.IGNORECASE,
)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def grounding_problems(draft: ScreeningDraft, resume: str, job: JobSpec) -> list[str]:
    problems: list[str] = []
    text = _norm(resume)
    assessed = {_norm(a.skill) for a in draft.assessments}
    for req in job.requirements:
        if _norm(req.skill) not in assessed:
            problems.append(f"no assessment for required skill '{req.skill}'")
    for a in draft.assessments:
        for quote in a.evidence:
            if _norm(quote) not in text:
                problems.append(f"evidence for '{a.skill}' is not a verbatim quote: {quote[:60]!r}")
    for item in draft.interview_questions + draft.concerns:
        if PROTECTED_TOPICS.search(item):
            problems.append(f"mentions a protected topic, remove it: {item[:60]!r}")
    return problems


def enforce(draft: ScreeningDraft, resume: str) -> ScreeningDraft:
    """Last line of defence: drop unverifiable quotes and protected-topic text, whatever the model said."""
    text = _norm(resume)
    fixed, concerns = [], [c for c in draft.concerns if not PROTECTED_TOPICS.search(c)]
    for a in draft.assessments:
        good = [q for q in a.evidence if _norm(q) in text]
        if a.met and not good:
            concerns.append(f"model claimed '{a.skill}' but gave no verifiable quote; marked not met")
        fixed.append(SkillAssessment(skill=a.skill, met=a.met and bool(good), evidence=good, years_found=a.years_found))
    questions = [q for q in draft.interview_questions if not PROTECTED_TOPICS.search(q)]
    return ScreeningDraft.model_construct(assessments=fixed, interview_questions=questions, concerns=concerns)


def score(candidate_id: str, job: JobSpec, draft: ScreeningDraft) -> ScreeningResult:
    by_skill = {_norm(a.skill): a for a in draft.assessments}

    def satisfied(req) -> bool:
        a = by_skill.get(_norm(req.skill))
        if a is None or not a.met:
            return False
        return req.min_years is None or (a.years_found or 0) >= req.min_years

    must = [r for r in job.requirements if r.importance == "must"]
    nice = [r for r in job.requirements if r.importance == "nice"]
    met_must = [r.skill for r in must if satisfied(r)]
    missing_must = [r.skill for r in must if not satisfied(r)]
    met_nice = [r.skill for r in nice if satisfied(r)]

    total = 2 * len(must) + len(nice)  # rubric: must-haves count double
    value = round(100 * (2 * len(met_must) + len(met_nice)) / total) if total else 0
    band = "strong" if value >= 75 and not missing_must else "possible" if value >= 45 else "weak"
    return ScreeningResult(
        candidate_id=candidate_id, job_title=job.title, assessments=draft.assessments,
        must_have_met=met_must, must_have_missing=missing_must, score=value, band=band,
        interview_questions=draft.interview_questions, concerns=draft.concerns,
    )
```

**How this code works**
- `_norm` lowercases and collapses whitespace before comparing, because PDF extraction often breaks lines mid-sentence. Without it, honest quotes fail.
- `grounding_problems` returns a list of human-readable problems. The agent sends them back to the model for one repair attempt.
- `enforce` runs no matter what: unverifiable quotes are removed and the skill is set to not met, with a visible concern for the reviewer. The model can be wrong; the output cannot be ungrounded.
- `PROTECTED_TOPICS` stops interview questions like "Do you plan to have children?" from ever reaching a recruiter. It errs on the side of over-filtering (e.g. "health" also blocks "health-tech experience"); review the filtered items and tune.
- `model_construct` skips re-validation, because a skill that the model said was met but that we just downgraded is intentionally different from the draft.
- `score` is a transparent rubric: must-haves count double, `min_years` is enforced, and "strong" requires every must-have. You can explain any score in one sentence, which is the point.

**Run it**
```bash title="terminal"
python -c "
from app.checks import grounding_problems
from app.schemas import *
job = JobSpec(title='x', requirements=[Requirement(skill='python', importance='must')])
d = ScreeningDraft(assessments=[SkillAssessment(skill='python', met=True, evidence=['10 years of Rust'])],
                   interview_questions=['Tell me about a hard bug.', 'How old are you?', 'Why this role?'])
print(grounding_problems(d, 'Built APIs in Python for 6 years.', job))"
```

**You should see**
```text
["evidence for 'python' is not a verbatim quote: '10 years of Rust'", "mentions a protected topic, remove it: 'How old are you?'"]
```

**If it breaks**
- Real quotes fail the check → the model "tidies" quotes (fixes typos, changes dashes). Add "copy characters exactly, including typos" to the prompt, and normalise `–` to `-` in `_norm` if your PDFs use en dashes.

## Step 6 · The agent loop
**Goal:** `screen()` turns a resume and a job description into a checked `ScreeningResult`.

```python title="app/agent.py"
import json
from functools import lru_cache

from app import llm
from app.checks import enforce, grounding_problems, score
from app.parse import redact
from app.schemas import JobSpec, ScreeningDraft, ScreeningResult
from app.tools import TOOL_SPECS, call_tool

MAX_TOOL_TURNS = 6
SYSTEM = """You are a careful recruiting assistant supporting a human reviewer.
Assess the resume ONLY against the listed requirements. Personal details are redacted and irrelevant;
never comment on age, gender, nationality, family, health or similar.
Use lookup_skill to normalise skill names and years_of_experience to compute years from date ranges.
Evidence quotes must be copied character for character from the resume."""


@lru_cache(maxsize=32)
def extract_job(jd_text: str) -> JobSpec:
    return llm.structured([{"role": "user", "content":
        "Extract the requirements from this job description. Use lowercase canonical skill names. "
        f"Mark each as 'must' or 'nice'.\n\n{jd_text}"}], JobSpec)


def gather_facts(resume: str, job: JobSpec) -> list[str]:
    """Let the model call tools; return the tool results as plain-text facts."""
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"Requirements:\n{job.model_dump_json()}\n\nResume:\n{resume}\n\n"
                                    "Call the tools you need. Reply DONE when finished."},
    ]
    facts: list[str] = []
    for _ in range(MAX_TOOL_TURNS):
        msg = llm.client.chat.completions.create(
            model=llm.MODEL, messages=messages, tools=TOOL_SPECS, temperature=0
        ).choices[0].message
        if not msg.tool_calls:
            break
        messages.append({"role": "assistant", "content": msg.content or "", "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
            for c in msg.tool_calls]})
        for call in msg.tool_calls:
            output = call_tool(call.function.name, call.function.arguments)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
            facts.append(f"{call.function.name}({call.function.arguments}) -> {output}")
    return facts


def screen(candidate_id: str, resume_text: str, jd_text: str, redact_input: bool = True) -> ScreeningResult:
    resume = redact(resume_text) if redact_input else resume_text
    job = extract_job(jd_text)
    facts = gather_facts(resume, job)
    feedback = ""
    for _ in range(2):  # one draft + one repair attempt
        draft = llm.structured([
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Requirements:\n{job.model_dump_json()}\n\nTool results:\n"
                                        + "\n".join(facts) + f"\n\nResume:\n{resume}\n\n"
                                        "Assess EVERY requirement and write 3-6 job-related interview questions."
                                        + feedback},
        ], ScreeningDraft)
        problems = grounding_problems(draft, resume, job)
        if not problems:
            break
        feedback = "\n\nYour previous answer had these problems. Fix all of them:\n- " + "\n- ".join(problems)
    return score(candidate_id, job, enforce(draft, resume))


if __name__ == "__main__":
    result = screen("backend_00", open("data/resumes/backend_00.txt", encoding="utf-8").read(),
                    open("data/jds/backend.txt", encoding="utf-8").read())
    print(json.dumps(result.model_dump(), indent=2)[:1200])
```

**How this code works**
- `extract_job` is cached with `lru_cache`: 8 resumes against one JD extract the requirements once, saving cost and making scores comparable across candidates.
- `gather_facts` is a standard tool loop, capped at `MAX_TOOL_TURNS` so a confused model cannot loop forever and bill you for it.
- The assistant message is rebuilt by hand (`id`, `type`, `function`) instead of passing the SDK object back, which works across OpenAI-compatible providers that reject unknown fields.
- Tool results are passed to the final call as plain text, so the drafting step does not depend on any provider's tool-history quirks.
- The repair loop sends the specific problems back once; after that, `enforce` cleans whatever is left. Two LLM calls maximum for drafting keeps cost predictable.
- `redact_input` exists only so the bias test can compare with and without redaction. The API always redacts.

**Run it**
```bash title="terminal"
python -m app.agent
```

**You should see**
```text
{
  "candidate_id": "backend_00",
  "job_title": "Senior Backend Engineer",
  "assessments": [
    {"skill": "python", "met": true, "evidence": ["Built and maintained Python services handling 2M requests/day"], "years_found": 7.0},
    ...
  "must_have_missing": [],
  "score": 89,
  "band": "strong",
  "interview_questions": ["Walk me through the AWS migration you led...", ...],
  "status": "pending_human_review"
```

**If it breaks**
- `tools is not supported` / no tool calls ever → your local model lacks tool calling. Try `qwen2.5:7b` in Ollama, or skip `gather_facts` (results get worse on `min_years`, which is a finding worth reporting).
- `ValueError: model did not produce a valid ScreeningDraft` → small models struggle with nested schemas. Raise `retries` to 3 or use a larger model for the draft step only.
- Score is low despite a good resume → print `job.requirements`. The JD extractor may have marked nice-to-haves as `must`; tighten its prompt.

## Step 7 · Measure agreement and bias
**Goal:** two scripts that produce the numbers for your README: agreement with your labels, and a counterfactual name/pronoun test.

```python title="eval/agreement.py"
import csv
import time
from collections import Counter

from app.agent import screen

LABELS = ["strong", "possible", "weak"]


def cohen_kappa(a: list[str], b: list[str]) -> float:
    n = len(a)
    observed = sum(x == y for x, y in zip(a, b)) / n
    expected = sum((a.count(lab) / n) * (b.count(lab) / n) for lab in LABELS)
    return (observed - expected) / (1 - expected) if expected < 1 else 1.0


rows = [r for r in csv.DictReader(open("data/pairs.csv", encoding="utf-8")) if r["label"]]
human, model, start = [], [], time.perf_counter()
for r in rows:
    resume = open(f"data/resumes/{r['candidate_id']}.txt", encoding="utf-8").read()
    jd = open(f"data/jds/{r['job_id']}.txt", encoding="utf-8").read()
    result = screen(r["candidate_id"], resume, jd)
    human.append(r["label"])
    model.append(result.band)
    flag = "" if r["label"] == result.band else "  <-- disagree"
    print(f"{r['candidate_id']}: human={r['label']:8} model={result.band:8} score={result.score}{flag}")

print(f"\npairs={len(rows)}  exact agreement={sum(h == m for h, m in zip(human, model)) / len(rows):.0%}  "
      f"kappa={cohen_kappa(human, model):.2f}  seconds/pair={(time.perf_counter() - start) / len(rows):.1f}")
print("confusion (human -> model):", dict(Counter(zip(human, model))))
```

```python title="eval/counterfactual.py"
"""Swap name and pronouns; a fair screener should give (nearly) the same score."""
import re
import statistics

from app.agent import screen

SWAPS = {"he": "she", "she": "he", "him": "her", "his": "her", "her": "his", "himself": "herself", "herself": "himself"}
NEW_NAMES = ["Lakisha Washington", "Greg Baker", "Nguyen Thi Lan", "Mohammed Al-Sayed", "Emily Walsh", "Jamal Jones"]


def counterfactual(text: str, new_name: str) -> str:
    lines = text.splitlines()
    lines[0] = new_name
    body = "\n".join(lines)
    return re.sub(r"\b(he|she|him|his|her|himself|herself)\b",
                  lambda m: SWAPS[m.group(0).lower()].capitalize() if m.group(0)[0].isupper() else SWAPS[m.group(0)],
                  body, flags=re.IGNORECASE)


jd = open("data/jds/backend.txt", encoding="utf-8").read()
for redact_input in (False, True):
    deltas, flips = [], 0
    for i in range(6):
        original = open(f"data/resumes/backend_{i:02d}.txt", encoding="utf-8").read()
        a = screen(f"orig_{i}", original, jd, redact_input=redact_input)
        b = screen(f"cf_{i}", counterfactual(original, NEW_NAMES[i]), jd, redact_input=redact_input)
        deltas.append(abs(a.score - b.score))
        flips += a.band != b.band
    print(f"redaction={'on ' if redact_input else 'off'}  mean |score change|={statistics.mean(deltas):.1f}  "
          f"max={max(deltas)}  band flips={flips}/6")
```

**How this code works**
- **Exact agreement** is easy to read; **Cohen's kappa** corrects for chance (0 = chance, 1 = perfect, 0.6+ is good for a 3-class subjective task). Report both.
- The confusion counter shows *how* it disagrees. "Model says possible where I said strong" is a calibration issue; "model says strong where I said weak" is a correctness issue.
- `counterfactual` replaces the name and swaps pronouns while keeping capitalisation, so the only thing that changes is identity signals. (Swapping "her" is ambiguous between "his" and "him"; good enough for this test.)
- Running with redaction off and on shows two things: how sensitive the raw model is, and how much redaction removes. With redaction on, the model sees identical text, so any remaining difference is run-to-run noise, which is itself worth reporting.
- Six pairs is a smoke test, not an audit. Say so, and say what a real audit would need (hundreds of pairs, adverse-impact ratios across groups, legal review).

**Run it**
```bash title="terminal"
python -m eval.agreement | tee eval/agreement.txt
python -m eval.counterfactual | tee eval/counterfactual.txt
```

**You should see**
```text
backend_00: human=strong   model=strong   score=89
backend_02: human=possible model=strong   score=78  <-- disagree
...
pairs=24  exact agreement=79%  kappa=0.68  seconds/pair=6.2
confusion (human -> model): {('strong', 'strong'): 7, ('possible', 'strong'): 2, ...}

redaction=off  mean |score change|=3.7  max=11  band flips=1/6
redaction=on   mean |score change|=0.0  max=0  band flips=0/6
```

**If it breaks**
- `ZeroDivisionError` → no rows have labels yet. Fill the `label` column in `pairs.csv`.
- Redaction-on deltas are not zero → temperature 0 is not fully deterministic on most providers. Run each pair twice and report the noise floor separately.

## Step 8 · An API with a human review queue
**Goal:** a FastAPI service where screening creates a review item and only a person can record a decision.

```python title="app/api.py"
import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, model_validator

from app.agent import screen
from app.parse import read_text

app = FastAPI(title="Resume screening assistant")
db = sqlite3.connect("data/reviews.db", check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY, candidate_id TEXT, result_json TEXT, status TEXT DEFAULT 'pending_human_review',
    reviewer TEXT, decision TEXT, reason TEXT, decided_at TEXT)""")


class Decision(BaseModel):
    reviewer: str = Field(min_length=2)
    decision: Literal["advance", "hold", "decline"]
    reason: str = ""

    @model_validator(mode="after")
    def decline_needs_reason(self):
        if self.decision == "decline" and len(self.reason.strip()) < 15:
            raise ValueError("a decline needs a written, job-related reason (15+ characters)")
        return self


@app.post("/screen")
async def screen_resume(candidate_id: str = Form(...), job_description: str = Form(...),
                        resume: UploadFile = File(...)):
    text = read_text(resume.filename or "resume.txt", await resume.read())
    if len(text.strip()) < 100:
        raise HTTPException(400, "could not read enough text from the resume (scanned PDF?)")
    result = screen(candidate_id, text, job_description)
    cur = db.execute("INSERT INTO reviews (candidate_id, result_json) VALUES (?, ?)",
                     (candidate_id, result.model_dump_json()))
    db.commit()
    return {"review_id": cur.lastrowid, "result": result}


@app.get("/reviews")
def list_reviews(status: str = "pending_human_review"):
    rows = db.execute("SELECT id, candidate_id, json_extract(result_json, '$.band'), "
                      "json_extract(result_json, '$.score') FROM reviews WHERE status = ? ORDER BY id", (status,))
    return [{"review_id": r[0], "candidate_id": r[1], "band": r[2], "score": r[3]} for r in rows]


@app.post("/reviews/{review_id}/decision")
def decide(review_id: int, body: Decision):
    cur = db.execute(
        "UPDATE reviews SET status = 'decided', reviewer = ?, decision = ?, reason = ?, decided_at = ? "
        "WHERE id = ? AND status = 'pending_human_review'",
        (body.reviewer, body.decision, body.reason, datetime.now(timezone.utc).isoformat(), review_id),
    )
    db.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "no pending review with that id")
    return {"review_id": review_id, "decision": body.decision, "by": body.reviewer}
```

**How this code works**
- `/screen` only ever inserts a row with status `pending_human_review`. There is no code path from model output to a decision.
- `Decision.decline_needs_reason` forces a written, job-related reason for a decline: an audit trail and a nudge to think.
- `WHERE id = ? AND status = 'pending_human_review'` makes decisions write-once; a second POST gets a 404 instead of silently overwriting.
- `json_extract` lets the queue sort and show band and score without a second table.
- The 100-character check catches scanned PDFs that extract as empty text, instead of screening a blank resume as "weak".

**Run it**
```bash title="terminal"
uvicorn app.api:app --reload
curl -s -F candidate_id=demo1 -F "job_description=<data/jds/ai_eng.txt" -F resume=@data/resumes/ai_eng_00.txt localhost:8000/screen | head -c 300
curl -s localhost:8000/reviews
curl -s -X POST localhost:8000/reviews/1/decision -H "Content-Type: application/json" -d '{"reviewer":"me","decision":"decline"}'
```

**You should see**
```text
{"review_id":1,"result":{"candidate_id":"demo1","job_title":"AI Engineer","assessments":[...
[{"review_id":1,"candidate_id":"demo1","band":"strong","score":86}]
{"detail":[{"type":"value_error","msg":"Value error, a decline needs a written, job-related reason (15+ characters)",...}]}
```

**If it breaks**
- `no such function: json_extract` → very old SQLite builds lack JSON1. Use Python 3.11+'s bundled SQLite, or store band and score as columns.
- `422` on `/screen` → `python-multipart` is missing or a form field name is wrong.

## Step 9 · Tests that lock in the guarantees
**Goal:** offline tests for the tools, redaction, grounding and the no-auto-rejection contract.

```python title="tests/test_checks.py"
import pytest
from pydantic import ValidationError

from app.checks import enforce, score
from app.parse import redact
from app.schemas import JobSpec, Requirement, ScreeningDraft, ScreeningResult, SkillAssessment
from app.tools import Period, YearsArgs, years_of_experience

JOB = JobSpec(title="Backend", requirements=[
    Requirement(skill="python", importance="must"),
    Requirement(skill="aws", importance="must", min_years=3),
    Requirement(skill="kubernetes", importance="nice"),
])
RESUME = "Python developer since 2017. Ran production workloads on AWS for 4 years."


def draft(**overrides) -> ScreeningDraft:
    base = dict(assessments=[
        SkillAssessment(skill="python", met=True, evidence=["Python developer since 2017"]),
        SkillAssessment(skill="aws", met=True, evidence=["workloads on AWS for 4 years"], years_found=4),
        SkillAssessment(skill="kubernetes", met=False),
    ], interview_questions=["q1?", "q2?", "q3?"])
    return ScreeningDraft(**{**base, **overrides})


def test_overlapping_periods_count_once():
    args = YearsArgs(periods=[Period(start="2018-01", end="2020-12"), Period(start="2020-06", end="2022-12")])
    assert years_of_experience(args)["years"] == 5.0


def test_redaction_removes_identity():
    text = redact("Jane Doe\njane@x.com | +1 415 555 0101\nShe led the team. Worked 2019 - 2023.")
    assert "Jane" not in text and "jane@x.com" not in text and "She" not in text
    assert "2019 - 2023" in text


def test_fabricated_quote_is_downgraded():
    bad = draft(assessments=[SkillAssessment(skill="python", met=True, evidence=["10 years of Python at Google"])])
    cleaned = enforce(bad, RESUME)
    assert cleaned.assessments[0].met is False
    assert any("no verifiable quote" in c for c in cleaned.concerns)


def test_protected_questions_are_removed():
    cleaned = enforce(draft(interview_questions=["How old are you?", "q2?", "q3?"]), RESUME)
    assert "How old are you?" not in cleaned.interview_questions


def test_rubric_and_band():
    result = score("c1", JOB, enforce(draft(), RESUME))
    assert result.score == 80 and result.band == "strong" and result.must_have_missing == []


def test_no_automated_rejection_possible():
    result = score("c1", JOB, enforce(draft(), RESUME))
    with pytest.raises(ValidationError):
        ScreeningResult(**{**result.model_dump(), "status": "rejected"})
```

**How this code works**
- Every test runs without a model call: the guarantees live in code, so they can be tested in milliseconds.
- `test_rubric_and_band`: two must-haves met (2 × 2 = 4 points) plus no nice-to-have, out of 5 → 80, and no must-have missing → strong.
- `test_no_automated_rejection_possible` documents the contract as a test. If someone adds a "rejected" status, this fails and starts a conversation.

**Run it**
```bash title="terminal"
pytest -q
```

**You should see**
```text
......                                                                   [100%]
6 passed in 0.18s
```

**If it breaks**
- `test_redaction_removes_identity` fails on the phone → your `PHONE` pattern changed. The test is there to catch exactly that.

## Ship it
1. **Deploy:** add a two-line Dockerfile (`FROM python:3.11-slim`, install requirements, `CMD uvicorn app.api:app --host 0.0.0.0 --port 8080`) and deploy to Render, Railway or Fly.io. Protect `/screen` with an API key (reuse the dependency from the Document Q&A project) and set a spend cap with your provider. FastAPI's `/docs` page is an acceptable demo UI for this project.
2. **README, results first:**
   - Agreement table: pairs, exact agreement, kappa, confusion, seconds and cost per pair (cost from your provider dashboard divided by calls).
   - Bias safeguards: what is redacted, the protected-topic filter, quote grounding, the counterfactual result with redaction off and on, and the honest limits (proxies like schools and graduation years remain; six pairs is not an audit).
   - Human in the loop: "The system cannot reject. Every result is a pending review; declines require a written reason." Link the test that proves it.
3. **Demo video (2 min):** upload a resume, show evidence quotes highlighted in the resume, show a fabricated quote being caught (feed it a resume missing a skill), record a human decision.
4. **Publish the test set** (synthetic, so this is safe) so others can reproduce your numbers.

## Going further
- Rank a batch of resumes for one role and have the model explain the ordering using only verified evidence.
- Compare a small and a large model on kappa, cost per pair and latency; publish the table.
- Add adverse-impact reporting: selection rates by synthetic demographic group across 100+ generated pairs (the four-fifths rule).
- Highlight evidence quotes inside the original resume in a small web UI for reviewers.
- Let reviewers flag a wrong assessment and turn those flags into new test cases.
