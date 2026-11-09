---
project: mock-interview-loop
title: Mock interview loop
hours: 8
stack: A rubric and question bank in YAML, a recording setup (OBS or any call recorder), a whiteboard tool (Excalidraw or tldraw), optional Python 3.11 + openai SDK interviewer script
cost: Free with a human partner; about $0.20-1 of API calls per loop if a model plays the interviewer (estimate)
---

You will build a small practice kit and use it to run yourself through a realistic three-round AI engineering
interview: rapid production scenarios, an open-ended system design, and a deep defense of one of your own projects.
Every session is timed and recorded, and every answer is scored against a written rubric, either by a partner watching
the recording or by a model playing the interviewer that asks follow-ups and scores with evidence. You run the whole
loop twice, a week apart, and finish with numbers that show what improved. When the real interview comes, it will feel
like the third time.

## Before you start
- Two or three free hours for each loop, booked in your calendar a week apart. Treat them like real interviews.
- A partner if you can find one (a peer, a mentor, someone from a study group). If not, the optional interviewer script plays the role.
- A way to record screen and audio: OBS Studio (free), or the local recording in Zoom, Meet or Teams. A whiteboard: excalidraw.com or tldraw.com.
- For the script: Python 3.11+ and an OpenAI-compatible endpoint (any provider, or Ollama at `http://localhost:11434/v1`).
- At least one finished portfolio project from earlier levels to defend in Round 3.
- Builds on Level 16 lessons: production RAG and agent scenarios, LLMOps debugging, AI system design, defending projects, communicating in interviews.

```text title="final folder structure"
mock-interview/
├── kit/
│   ├── CHECKLIST.md           # before / during / after, timer and recording
│   ├── rubric.yaml            # rounds, timings, dimensions, 1-4 anchors, pass bar
│   ├── scenarios.yaml         # Round 1: six core scenarios + loop-2 alternates
│   ├── design_briefs.yaml     # Round 2: vague briefs
│   └── defense_ladder.yaml    # Round 3: progressively deeper question themes
├── interviewer.py             # optional LLM interviewer: asks, follows up, times, scores
├── score.py                   # aggregates scores, finds weakest moments, compares loops
├── scoresheets/               # human scores from recordings (YAML)
├── sessions/                  # LLM interviewer sessions (JSON)
├── answers/                   # optional: transcribed answers to replay into the script
├── tests/test_kit.py
└── recordings/                # your videos (do not commit)
```

## How it fits together

```text
 kit/*.yaml ──> interviewer (partner, or interviewer.py) ──> you answer aloud, on a whiteboard, timer running
                         │                                              │
                         │ follow-ups targeted at weak spots            └─> recording ──> scoresheets/loopN.yaml
                         ▼                                                                   │
                 sessions/loopN-roundR.json (LLM scores + evidence) ─────────────> score.py ─┴─> weakest 3 moments
                                                                                              └─> loop 1 vs loop 2 table
```

The rubric and question bank are plain files, so a human partner and the script use exactly the same material. In each
round the interviewer reads a prompt, you answer within a time budget, and the interviewer pushes on the vaguest part of
your answer. The recording is scored afterwards against the rubric's anchors. `score.py` merges human and model scores,
shows where you lost points, and compares the two loops.

## Step 1 · Set up the kit and book the loop
**Goal:** the project folder, a checklist you will follow every session, and two dated loops in your calendar.

Most mock interviews fail on logistics: no timer, no recording, no rubric, so the feedback is "felt OK". Fix the
logistics once in a checklist.

```bash title="terminal"
mkdir -p mock-interview/{kit,scoresheets,sessions,answers,tests,recordings} && cd mock-interview
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install "openai>=1.40" pyyaml pytest
printf "recordings/\n.venv/\n" > .gitignore
```

```markdown title="kit/CHECKLIST.md"
# Mock loop checklist

## A week before
- [ ] Loop 1 booked (2.5-3 h block), loop 2 booked 7 days later, same time of day
- [ ] Partner confirmed, or script tested with `python interviewer.py --round 1 --answers-file answers/sample.txt`
- [ ] Partner has kit/rubric.yaml and the round prompts; candidate has NOT read loop's scenarios
- [ ] Project for Round 3 chosen; numbers (latency, cost, eval scores) written on one card

## 15 minutes before
- [ ] OBS: screen + mic + camera, test 30 s recording, check audio is audible
- [ ] Both people agree to recording; recordings stay private
- [ ] Whiteboard open (Excalidraw/tldraw), blank board per round
- [ ] Timer visible to both (phone or `interviewer.py` prints elapsed)
- [ ] Notifications off, water, paper for the partner's timestamps

## During
- [ ] Partner notes timestamps of strong and weak moments (mm:ss + one word)
- [ ] Candidate thinks aloud, states assumptions with numbers, checks in ("does that sound right?")
- [ ] Hard stop at each round's time budget; 10-minute break between rounds
- [ ] No hints from the partner; only follow-up questions

## Within 24 hours
- [ ] Watch the recording at 1.5x, fill scoresheets/loopN.yaml with scores AND evidence
- [ ] Run `python score.py`, write the three weakest moments and a practice plan
```

**How this code works**
- Same time of day for both loops → energy level is a confounder; holding it fixed makes the comparison fairer.
- "Candidate has NOT read the scenarios" → rehearsed answers measure memory, not judgement. Loop 2 uses different scenarios on purpose.
- Partner timestamps → scoring a three-hour recording without them takes forever; with them you jump straight to the moments that matter.
- Consent and private recordings → recordings contain your partner's face and voice. Keep them out of git (`.gitignore`).

**Run it**
```bash title="terminal"
grep -c "\- \[ \]" kit/CHECKLIST.md
```

**You should see**
```text
16
```

**If it breaks**
- No partner available → that is fine; Step 4 builds the model interviewer. Try to get a human for at least one of the two loops, because a person interrupts and reacts in ways a script does not.

## Step 2 · Write the rubric
**Goal:** a rubric with timings, dimensions and concrete 1-4 anchors for each round, plus a pass bar.

A rubric turns "I think it went fine" into a number with evidence. Anchors must describe observable behaviour, not
adjectives, so two scorers watching the same answer give the same score.

```yaml title="kit/rubric.yaml"
scale:
  1: Missing or wrong. A real interviewer would note it as a concern.
  2: Partial. Right idea, but vague, unordered or without numbers.
  3: Solid. Correct, structured, specific. Meets the bar.
  4: Strong. Specific numbers, explicit trade-offs, anticipates the follow-up. Hire signal.
pass_bar:
  round_average: 3.0
  no_dimension_below: 2

rounds:
  1:
    name: Rapid production scenarios
    total_minutes: 45
    minutes_per_item: 7
    followups: 2
    dimensions:
      triage:
        what: Stabilises and scopes first (impact, blast radius, rollback) before deep debugging
        anchors: {1: jumps to a fix, 2: mentions impact late, 3: scopes then debugs, 4: scopes, mitigates, then debugs with a clear order}
      hypotheses:
        what: Lists likely causes and ranks them
        anchors: {1: one guess, 2: several unranked guesses, 3: ranked causes with reasons, 4: ranked causes tied to what changed recently}
      measurement:
        what: Names the data, metric, log or trace that confirms or kills each hypothesis
        anchors: {1: no data named, 2: generic "check logs", 3: specific metrics and slices, 4: specific metrics plus a quick experiment or bisect}
      fix_and_prevention:
        what: Fixes the cause and adds a guard so it cannot silently recur
        anchors: {1: no fix, 2: fix only, 3: fix plus an eval or alert, 4: fix, regression eval, alert and a process change}
      communication:
        what: Concise, structured, within time, checks in with the interviewer
        anchors: {1: rambling or over time, 2: understandable but unstructured, 3: signposted structure, 4: crisp summary first, then detail on request}
  2:
    name: System design
    total_minutes: 55
    followups: 1
    phases:
      - {name: Requirements, minutes: 8, prompt: "Clarify users, use cases, scale, latency, quality bar, cost, privacy. State assumptions with numbers."}
      - {name: Baseline, minutes: 7, prompt: "Describe the simplest system that could work and how you would measure it."}
      - {name: Architecture, minutes: 15, prompt: "Components, data flow, model choices, and the data and context layer."}
      - {name: Scale and failure, minutes: 10, prompt: "Bottlenecks, fallbacks, security, cost at the stated scale."}
      - {name: Evals and monitoring, minutes: 10, prompt: "Offline evals, online signals, rollout plan."}
      - {name: Trade-offs, minutes: 5, prompt: "What would you change with more time, less budget, or stricter latency?"}
    dimensions:
      requirements:
        what: Turns a vague brief into numbered assumptions and confirms them
        anchors: {1: starts drawing immediately, 2: asks questions but sets no numbers, 3: states numeric assumptions, 4: numeric assumptions that drive later choices}
      baseline_first:
        what: Starts simple and adds components only for a stated requirement
        anchors: {1: giant architecture first, 2: baseline mentioned then ignored, 3: baseline plus justified additions, 4: each addition tied to a requirement and a metric}
      architecture_and_models:
        what: Sound components and model choices with reasons
        anchors: {1: hand-wavy boxes, 2: plausible but unjustified, 3: justified choices, 4: justified with alternatives and cost/latency numbers}
      data_and_context:
        what: Retrieval, memory, tools, freshness, permissions
        anchors: {1: ignored, 2: "use RAG", 3: chunking, retrieval, freshness and access control covered, 4: plus failure modes and how to measure retrieval}
      scale_reliability_security:
        what: Throughput, fallbacks, timeouts, prompt injection, data protection
        anchors: {1: ignored, 2: one aspect, 3: capacity math plus fallbacks plus one security control, 4: all, with cost at scale}
      evals_and_monitoring:
        what: How quality is measured before and after launch
        anchors: {1: none, 2: "add evals", 3: concrete offline set and online metrics, 4: plus rollout gates and drift alerts}
      tradeoffs:
        what: Names what was given up and when the choice would flip
        anchors: {1: none, 2: generic pros and cons, 3: specific trade-offs, 4: specific trade-offs with the condition that flips each one}
  3:
    name: Project defense
    total_minutes: 40
    presentation_minutes: 10
    followups: 5
    dimensions:
      story:
        what: Problem, constraints, what you built, result, in that order
        anchors: {1: feature tour, 2: unclear problem, 3: clear problem-to-result arc, 4: arc plus why it mattered to a user}
      numbers:
        what: Knows the measured latency, cost, eval scores and data sizes
        anchors: {1: no numbers, 2: rough guesses, 3: measured numbers, 4: measured numbers with how they were measured}
      alternatives:
        what: Explains what else was considered and why it lost
        anchors: {1: none, 2: "it was popular", 3: one real alternative with a reason, 4: alternatives with evidence or an experiment}
      failure_ownership:
        what: Describes a real failure, how it was noticed and fixed
        anchors: {1: "nothing went wrong", 2: vague failure, 3: specific failure and fix, 4: failure, detection, fix and the guard added}
      depth_under_pressure:
        what: Handles progressively deeper questions without bluffing
        anchors: {1: bluffs, 2: stalls at the second level, 3: answers or says "I don't know, here's how I'd find out", 4: reaches the deepest level with specifics}
```

**How this code works**
- `scale` with four points → no middle score to hide in. You either met the bar (3) or did not (2).
- Anchors describe behaviour ("states numeric assumptions") → a scorer can point at the moment in the recording that earns the score. "Good communication" cannot be pointed at.
- `minutes_per_item: 7` for Round 1 → six scenarios in 45 minutes leaves 3 minutes of slack. About 4 minutes of answer and 3 of follow-ups each.
- Round 2 `phases` follow the time split from lesson 16.6 → the most common design-round failure is spending 40 minutes on architecture and never reaching evals.
- `pass_bar` → "ready" means average 3.0 per round and nothing at 1. Write it before you score, like the decision bar in a fine-tuning project.

**Run it**
```bash title="terminal"
python -c "import yaml; r=yaml.safe_load(open('kit/rubric.yaml')); print({k: list(v['dimensions']) for k, v in r['rounds'].items()})"
```

**You should see**
```text
{1: ['triage', 'hypotheses', 'measurement', 'fix_and_prevention', 'communication'], 2: ['requirements', 'baseline_first', 'architecture_and_models', 'data_and_context', 'scale_reliability_security', 'evals_and_monitoring', 'tradeoffs'], 3: ['story', 'numbers', 'alternatives', 'failure_ownership', 'depth_under_pressure']}
```

**If it breaks**
- `yaml.scanner.ScannerError` → a colon inside an unquoted value. Quote any anchor text that contains `:` (the Round 2 prompts already are).

## Step 3 · Build the question bank
**Goal:** six core Round 1 scenarios, alternates for loop 2, design briefs for both loops, and a Round 3 depth ladder.

Each item has `signals`: what a strong answer usually covers. The candidate never reads them; the partner and the
scorer use them to judge completeness.

```yaml title="kit/scenarios.yaml"
scenarios:
  - id: rag-accuracy-drop
    loop: 1
    prompt: "Our support RAG assistant's answer accuracy dropped from 82% to 64% on the weekly eval overnight. Nobody says they changed anything. Walk me through it."
    signals: [check what changed (index rebuild, embedding model, chunking, prompt, model version), retrieval vs generation split using recall@k, slice by doc source, rollback option, pin versions, add retrieval eval to CI]
  - id: agent-loops
    loop: 1
    prompt: "An agent in production is looping: some sessions make 60+ tool calls and cost $4 each. What do you do this week?"
    signals: [hard step and budget caps now, find the looping tool from traces, tool error messages the model cannot act on, stop conditions, per-session cost alert, eval cases for the loop]
  - id: latency-doubled
    loop: 1
    prompt: "Our provider's p95 latency doubled since Monday, from 2.1 s to 4.3 s. Users are complaining."
    signals: [separate TTFT from generation time, check token counts and prompt growth, provider status and region, streaming, timeout and fallback model via gateway, SLO and alert]
  - id: tuned-model-regressed
    loop: 1
    prompt: "We deployed a fine-tuned model that beat the old one offline, but complaints went up after deploy."
    signals: [template or tokenizer mismatch between training and serving, offline set unrepresentative, compare live slices, canary and rollback, off-task regressions, reproduce offline numbers through the server]
  - id: prompt-doubled-cost
    loop: 1
    prompt: "A prompt change shipped last week and our LLM bill doubled. Quality looks the same."
    signals: [input vs output tokens, longer outputs or more retries, cache hit rate dropped because prefix changed, per-feature cost attribution, budget alert, cost check in prompt review]
  - id: retriever-offline-online
    loop: 1
    prompt: "A new retriever passed our offline eval with better recall, but on live queries answers got worse."
    signals: [offline queries not like live ones, sample and label live queries, distribution shift (short or typo-heavy queries), latency or timeouts truncating results, shadow or A/B test, refresh eval set from logs]
  - id: hallucinated-citations
    loop: 2
    prompt: "Legal says our assistant cited a policy section that does not exist. How do you investigate and prevent it?"
    signals: [trace the request, was the section retrieved, citation must reference retrieved chunk ids, verifier step, groundedness eval, user-facing fallback]
  - id: gpu-oom-peak
    loop: 2
    prompt: "Our self-hosted vLLM service starts returning errors and very slow responses at peak traffic every afternoon."
    signals: [queue depth and KV cache usage metrics, preemptions, max-num-seqs and max-model-len, autoscale on waiting requests, load shedding, capacity math]
  - id: injection-in-email
    loop: 2
    prompt: "An email-summarising agent forwarded a customer's data to an outside address after reading a malicious email."
    signals: [contain (disable tool), treat retrieved content as untrusted, tool allowlists and human approval for external actions, least privilege, red-team evals, incident review]
  - id: eval-disagrees-users
    loop: 2
    prompt: "Our LLM-judge eval says v2 is better, but user thumbs-down rate went up."
    signals: [judge calibration against human labels, judge bias (length, position), what users complain about, slice analysis, update eval with real failures, online metric as gate]
  - id: multilingual-drop
    loop: 2
    prompt: "We expanded to Spanish and Hindi users; satisfaction for those users is 30% lower."
    signals: [per-language evals, embedding model language coverage, tokenizer cost per language, translation vs native retrieval, locale-specific content, native-speaker review]
  - id: cache-stale
    loop: 2
    prompt: "After adding a semantic cache, users report outdated answers about pricing."
    signals: [similarity threshold too loose, TTL and invalidation on content change, exclude time-sensitive intents, cache key includes version, measure hit rate vs error rate]
```

```yaml title="kit/design_briefs.yaml"
briefs:
  - id: support-assistant
    loop: 1
    prompt: "Design an assistant that drafts replies for a company's customer support agents."
    signals: [numeric scale and latency assumptions, retrieval over help center with citations, ticket and account tools, human in the loop, acceptance-rate metric, cost per ticket, PII handling]
  - id: contract-review
    loop: 2
    prompt: "Design a system that helps an insurer's team review incoming contracts for risky clauses."
    signals: [document parsing and layout, clause extraction schema, grounding and citations to page, reviewer workflow, precision vs recall trade-off, data residency, eval set from past reviews]
```

```yaml title="kit/defense_ladder.yaml"
# Each follow-up goes one level deeper. A partner reads them in order and adapts to the project.
ladder:
  - level: 1
    theme: Clarify
    examples: ["Who used it, and what did it replace?", "What exactly did you build yourself?"]
  - level: 2
    theme: Alternatives
    examples: ["Why this model or database and not the obvious alternative?", "What did you try first that did not work?"]
  - level: 3
    theme: Numbers and cost
    examples: ["What were p95 latency and cost per request, and how did you measure them?", "What happens to cost at 100x traffic?"]
  - level: 4
    theme: Failures and evals
    examples: ["Tell me about a failure in production or testing. How did you notice?", "How do you know your eval set reflects real use?"]
  - level: 5
    theme: Scale and redesign
    examples: ["If you rebuilt it for a regulated enterprise, what changes?", "What would break first at 1,000 concurrent users?"]
```

**How this code works**
- `loop: 1` / `loop: 2` → loop 2 gets new scenarios of the same kind, so improvement measures skill, not memory of last week's answers.
- The six loop-1 scenarios are exactly the Round 1 set: RAG accuracy drop, looping agent, doubled latency, regressed tune, doubled cost, offline/online retriever gap.
- `signals` are lists of themes, not model answers → they guide scoring of completeness without turning the rubric into a checklist the candidate memorises.
- The defense ladder → interviewers go deeper until you run out of knowledge. Practising the deepest level is the point.

**Run it**
```bash title="terminal"
python -c "import yaml; s=yaml.safe_load(open('kit/scenarios.yaml'))['scenarios']; print(sum(x['loop']==1 for x in s), 'loop-1 /', sum(x['loop']==2 for x in s), 'loop-2')"
```

**You should see**
```text
6 loop-1 / 6 loop-2
```

**If it breaks**
- YAML errors on a prompt line → keep every `prompt` in double quotes; `$4` and `:` are safe inside quotes.

## Step 4 · Build the LLM interviewer (optional partner)
**Goal:** a script that asks the round's questions, times you, asks targeted follow-ups, scores against the rubric with quoted evidence, and saves the session.

If you have a human partner, they use the YAML files directly and you can skip to Step 5. The script is still useful
for solo practice between loops and for a second opinion on scores.

```python title="interviewer.py"
"""Mock interviewer: asks rubric-driven questions, follows up, times answers, scores with evidence.

Usage:
  python interviewer.py --round 1 --loop 1
  python interviewer.py --round 3 --loop 1 --project "Hybrid search engine"
  python interviewer.py --round 1 --loop 1 --answers-file answers/loop1-round1.txt   # replay a transcript
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml
from openai import OpenAI

KIT = Path(__file__).resolve().parent / "kit"
MODEL = os.getenv("MODEL", "gpt-4o-mini")          # example id; any capable chat model works
client = OpenAI(base_url=os.getenv("BASE_URL") or None,
                api_key=os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY", "not-needed"))

INTERVIEWER = (
    "You are a senior AI engineering interviewer running the round '{round_name}'. "
    "The rubric dimensions are: {dims}. Ask exactly ONE follow-up question, at most two sentences. "
    "Target the vaguest or weakest part of the candidate's last answer: ask for a number, a specific metric, "
    "a trade-off, or what they would do first. Never give hints, answers or praise. {extra}"
)
SCORER = (
    "You score one mock interview item strictly against the rubric below. For every dimension give an integer "
    "score 1-4 using the anchors, and quote the candidate's own words as evidence (or 'none' if absent). "
    "A 4 requires specifics: numbers, named metrics, explicit trade-offs. Do not reward length.\n"
    "A strong answer usually covers: {signals}\n"
    'Return JSON: {{"scores": {{"<dimension>": {{"score": 1, "evidence": "..."}}}}, '
    '"strongest": "...", "weakest": "...", "missed_points": ["..."]}}\n\nRubric:\n{rubric}'
)


def load(name: str) -> dict:
    return yaml.safe_load((KIT / name).read_text(encoding="utf-8"))


class Answers:
    """Answers from the keyboard (end with a line '/done') or from a file split by lines '---'."""

    def __init__(self, path: str | None):
        self.queue = None
        if path:
            self.queue = [a.strip() for a in Path(path).read_text(encoding="utf-8").split("\n---\n")]

    def get(self) -> str:
        if self.queue is not None:
            answer = self.queue.pop(0) if self.queue else ""
            print(f"> {answer[:200]}{'...' if len(answer) > 200 else ''}")
            return answer
        print("(answer, then a line with only /done)")
        lines = []
        for line in sys.stdin:
            if line.strip() == "/done":
                break
            lines.append(line.rstrip("\n"))
        return "\n".join(lines).strip()


def chat(messages: list[dict], json_mode: bool = False, max_tokens: int = 200) -> str:
    extra = {"response_format": {"type": "json_object"}} if json_mode else {}
    r = client.chat.completions.create(model=MODEL, messages=messages, max_tokens=max_tokens,
                                       temperature=0 if json_mode else 0.4, **extra)
    return (r.choices[0].message.content or "").strip()


def follow_up(round_cfg: dict, transcript: list[dict], extra: str = "") -> str:
    system = INTERVIEWER.format(round_name=round_cfg["name"], dims=", ".join(round_cfg["dimensions"]), extra=extra)
    return chat([{"role": "system", "content": system}] + transcript, max_tokens=120)


def score_item(round_cfg: dict, question: str, signals: list[str], transcript: list[dict]) -> dict:
    dims = round_cfg["dimensions"]
    text = "\n".join(f"{'INTERVIEWER' if m['role'] == 'assistant' else 'CANDIDATE'}: {m['content']}"
                     for m in transcript)
    raw = chat([{"role": "system", "content": SCORER.format(signals="; ".join(signals) or "n/a",
                                                             rubric=yaml.safe_dump(dims, sort_keys=False))},
                {"role": "user", "content": f"Question: {question}\n\nTranscript:\n{text}"}],
               json_mode=True, max_tokens=900)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {"scores": {}, "strongest": "", "weakest": "scorer returned invalid JSON", "missed_points": []}
    scores, evidence = {}, {}
    for d in dims:
        entry = (data.get("scores") or {}).get(d) or {}
        try:
            scores[d] = min(4, max(1, int(entry.get("score", 1))))
        except (TypeError, ValueError):
            scores[d] = 1
        evidence[d] = entry.get("evidence", "none")
    return {"scores": scores, "evidence": evidence, "strongest": data.get("strongest", ""),
            "weakest": data.get("weakest", ""), "missed_points": data.get("missed_points", [])}


def run_turns(round_cfg: dict, opening: str, answers: Answers, n_followups: int, budget_s: float,
              extras: list[str] | None = None) -> tuple[list[dict], float]:
    """Ask the opening question, then n follow-ups, inside one time budget."""
    print(f"\nINTERVIEWER: {opening}")
    start = time.monotonic()
    transcript = [{"role": "assistant", "content": opening}, {"role": "user", "content": answers.get()}]
    for i in range(n_followups):
        elapsed = time.monotonic() - start
        if elapsed > budget_s and answers.queue is None:
            print(f"[time: {elapsed / 60:.1f} min of {budget_s / 60:.0f} - moving on]")
            break
        question = follow_up(round_cfg, transcript, (extras or [""] * n_followups)[i] if extras else "")
        print(f"\nINTERVIEWER: {question}   [{elapsed / 60:.1f}/{budget_s / 60:.0f} min]")
        transcript += [{"role": "assistant", "content": question}, {"role": "user", "content": answers.get()}]
    return transcript, time.monotonic() - start


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--round", type=int, choices=[1, 2, 3], required=True)
    p.add_argument("--loop", type=int, default=1)
    p.add_argument("--project", default="my portfolio project", help="Round 3 project name")
    p.add_argument("--answers-file", default=None)
    p.add_argument("--only", default=None, help="comma-separated item ids to run")
    a = p.parse_args()

    rubric = load("rubric.yaml")
    cfg = rubric["rounds"][a.round]
    answers = Answers(a.answers_file)
    items_out = []
    print(f"=== Loop {a.loop} · Round {a.round}: {cfg['name']} ({cfg['total_minutes']} min) · interviewer {MODEL}")

    if a.round == 1:
        items = [s for s in load("scenarios.yaml")["scenarios"] if s["loop"] == a.loop]
        if a.only:
            items = [s for s in items if s["id"] in a.only.split(",")]
        for s in items:
            transcript, elapsed = run_turns(cfg, s["prompt"], answers, cfg["followups"], cfg["minutes_per_item"] * 60)
            items_out.append({"id": s["id"], "question": s["prompt"], "transcript": transcript, "elapsed_s": round(elapsed),
                              **score_item(cfg, s["prompt"], s["signals"], transcript)})
    elif a.round == 2:
        brief = next(b for b in load("design_briefs.yaml")["briefs"] if b["loop"] == a.loop)
        transcript, start = [], time.monotonic()
        print(f"\nBRIEF: {brief['prompt']}")
        for phase in cfg["phases"]:
            opening = f"[{phase['name']}, {phase['minutes']} min] {phase['prompt']}"
            turns, _ = run_turns(cfg, opening, answers, cfg["followups"], phase["minutes"] * 60)
            transcript += turns
        items_out.append({"id": brief["id"], "question": brief["prompt"], "transcript": transcript,
                          "elapsed_s": round(time.monotonic() - start),
                          **score_item(cfg, brief["prompt"], brief["signals"], transcript)})
    else:
        ladder = load("defense_ladder.yaml")["ladder"]
        extras = [f"This is depth level {l['level']} ({l['theme']}); in the spirit of: {l['examples'][0]}" for l in ladder]
        opening = (f"You have {cfg['presentation_minutes']} minutes. Present '{a.project}': the problem, constraints, "
                   "what you built, and the results with numbers.")
        transcript, elapsed = run_turns(cfg, opening, answers, cfg["followups"], cfg["total_minutes"] * 60, extras)
        items_out.append({"id": "project-defense", "question": opening, "transcript": transcript,
                          "elapsed_s": round(elapsed), **score_item(cfg, opening, [], transcript)})

    session = {"loop": a.loop, "round": a.round, "scorer": f"llm:{MODEL}",
               "date": datetime.now().isoformat(timespec="minutes"), "items": items_out}
    Path("sessions").mkdir(exist_ok=True)
    out = Path("sessions") / f"loop{a.loop}-round{a.round}-{datetime.now():%Y%m%d-%H%M}.json"
    out.write_text(json.dumps(session, indent=2), encoding="utf-8")
    print("\n=== Scores")
    for item in items_out:
        print(f"{item['id']}: {item['scores']}  weakest: {item['weakest']}")
    print(f"saved {out}")


if __name__ == "__main__":
    main()
```

```text title="answers/sample.txt"
I'd first check impact: is the drop on all question types or a slice? Then what changed overnight - index rebuild, embedding model, prompt or provider model version.
---
I'd split retrieval from generation: measure recall at 5 on the eval questions. If recall dropped, it's the index or embeddings.
---
I'd roll back the index to yesterday's snapshot, then add a retrieval recall check to the nightly pipeline so it fails before deploy.
```

**How this code works**
- Interviewer turns are `assistant` messages and your answers are `user` messages → the model sees the conversation naturally and can follow up on what you actually said.
- `INTERVIEWER` prompt: one question, target the vaguest part, ask for numbers, never hint → that is what good human interviewers do, and why the follow-ups feel uncomfortable.
- Round 3 `extras` → each follow-up is pushed one level down the defense ladder, so questions get progressively deeper rather than circling.
- `SCORER` with anchors, signals and "quote the candidate's own words" → evidence makes scores checkable; you can disagree with a score by pointing at the quote. "Do not reward length" counters the model's habit of scoring long answers higher.
- Scores are clamped to 1-4 and missing dimensions become 1 → a malformed scorer response cannot crash the session or inflate a score.
- Time budget → keyboard sessions stop asking follow-ups once the budget is spent, like a real interviewer moving on. Replayed answer files skip the clock.
- `--answers-file` → paste a transcript of your recorded spoken answers (from your recorder's captions or a speech-to-text tool), separated by `---`, and get the same scoring without typing during the interview.

**Run it**
```bash title="terminal"
export OPENAI_API_KEY=sk-...          # or BASE_URL=http://localhost:11434/v1 MODEL=llama3.1
python interviewer.py --round 1 --loop 1 --only rag-accuracy-drop --answers-file answers/sample.txt
```

**You should see**
```text
=== Loop 1 · Round 1: Rapid production scenarios (45 min) · interviewer gpt-4o-mini

INTERVIEWER: Our support RAG assistant's answer accuracy dropped from 82% to 64% ...
> I'd first check impact: is the drop on all question types or a slice? Then what changed overnight ...

INTERVIEWER: Which specific signal would tell you within ten minutes whether the index rebuild is the cause?   [0.0/7 min]
> I'd split retrieval from generation: measure recall at 5 on the eval questions...
...
=== Scores
rag-accuracy-drop: {'triage': 3, 'hypotheses': 3, 'measurement': 3, 'fix_and_prevention': 3, 'communication': 3}  weakest: No mention of slicing the eval by document source or of a quick bisect.
saved sessions/loop1-round1-20261107-1012.json
```

**If it breaks**
- `json.decoder.JSONDecodeError` warnings or all scores 1 with a local model → small local models struggle with long JSON. Use a stronger model for scoring, or remove `response_format` if your server rejects it.
- Follow-ups give away answers ("Have you considered the embedding model?") → strengthen the "Never give hints" line or switch models; a leading interviewer inflates scores.
- Script waits forever → you are in keyboard mode; type `/done` on its own line to end an answer.

## Step 5 · Run Round 1: six rapid scenarios
**Goal:** a recorded 45-minute round with all six scenarios answered aloud and timestamps noted.

Start the recording, start the timer, and take the six loop-1 scenarios in order. With a partner, they read each prompt
from `kit/scenarios.yaml` and ask two follow-ups from the rubric's spirit. Solo, run the script and speak your answer
aloud before typing a short version (speaking is the skill; the typed version is for scoring).

Use one structure for every scenario so you never freeze:

```text title="whiteboard template (Round 1)"
1. Impact & scope   - who is affected, since when, how bad; can we mitigate or roll back now?
2. What changed     - deploys, data, index, model version, prompt, traffic
3. Hypotheses       - ranked, with the reason for each rank
4. Evidence         - the metric, slice, trace or quick experiment that confirms or kills each
5. Fix & guard      - fix, then the eval, alert or process that stops a silent repeat
```

**How this code works**
- Mitigate before debugging → interviewers grade whether you stop the bleeding first. "Roll back the index to last night's snapshot while we investigate" is often the strongest first sentence.
- "What changed" before hypotheses → most production incidents follow a change. Asking for the change log is a senior signal.
- About 4 minutes of answer, 3 of follow-ups → if you are still talking at minute 5, summarise in one sentence and stop.

**Run it**
```bash title="terminal"
python interviewer.py --round 1 --loop 1
```

**You should see**
```text
=== Loop 1 · Round 1: Rapid production scenarios (45 min) · interviewer gpt-4o-mini
INTERVIEWER: Our support RAG assistant's answer accuracy dropped from 82% to 64% ...
...
saved sessions/loop1-round1-20261107-1102.json
```
And a recording of about 45 minutes, with your partner's timestamps such as `07:40 strong rollback`, `23:10 no metric named`.

**If it breaks**
- You run out of time by scenario four → you are over-explaining step 4. Name one decisive metric per hypothesis, not three.
- You blank on a scenario → say the structure aloud ("first I'd scope the impact...") and fill it in; structure under pressure is itself a scored behaviour.

## Step 6 · Run Round 2: system design
**Goal:** a recorded 55-minute design session on the loop's brief, moving through all six phases on the whiteboard.

```text title="whiteboard layout (Round 2)"
┌──────────────────────┬────────────────────────────────────────────┐
│ ASSUMPTIONS (numbers) │ DIAGRAM                                    │
│ users, QPS, p95,      │  baseline first (3 boxes), then additions  │
│ quality bar, $/req,   │  each labelled with the requirement it     │
│ privacy, freshness    │  serves                                    │
├──────────────────────┼────────────────────────────────────────────┤
│ EVALS & MONITORING    │ RISKS / TRADE-OFFS                         │
│ offline set, online   │ what we gave up, and what would flip it    │
│ metrics, rollout gate │                                            │
└──────────────────────┴────────────────────────────────────────────┘
```

**How this code works**
- Four fixed quadrants → you cannot forget evals or trade-offs because an empty quadrant stares at you. The rubric's last two dimensions are where most candidates lose points.
- Assumptions with numbers in the top left → every later choice should point back to one ("hybrid retrieval because tickets contain product codes"; "small model for routing because 50k tickets a day").
- With the script, each phase is a turn with one follow-up; with a partner, the partner calls the phase changes by the clock.

**Run it**
```bash title="terminal"
python interviewer.py --round 2 --loop 1
```

**You should see**
```text
BRIEF: Design an assistant that drafts replies for a company's customer support agents.

INTERVIEWER: [Requirements, 8 min] Clarify users, use cases, scale, latency, quality bar, cost, privacy. State assumptions with numbers.
...
INTERVIEWER: [Trade-offs, 5 min] What would you change with more time, less budget, or stricter latency?
...
support-assistant: {'requirements': 3, 'baseline_first': 2, 'architecture_and_models': 3, 'data_and_context': 3, 'scale_reliability_security': 2, 'evals_and_monitoring': 3, 'tradeoffs': 2}
```
Export the whiteboard as PNG into `recordings/` next to the video.

**If it breaks**
- You reach "Evals" with 2 minutes left → the next loop, set a phone alarm for each phase boundary and obey it.
- The diagram became a giant architecture in minute 10 → erase back to the baseline and add components one at a time, saying the requirement each one serves.

## Step 7 · Run Round 3: project defense
**Goal:** a recorded 10-minute presentation of one portfolio project, followed by five progressively deeper questions.

Prepare one card of numbers before the round: data sizes, eval scores, p50/p95 latency, cost per request, and one
failure. Present for 10 minutes, then take the ladder's questions. With the script, speak the presentation aloud and
type a 5-8 line summary as the first answer.

**How this code works**
- Problem → constraints → what you built → result → why it mattered: the order from lesson 16.8. Feature tours score 1 on `story`.
- The ladder goes Clarify → Alternatives → Numbers → Failures → Redesign. The aim is to see where you stop knowing. "I don't know; here is how I would find out" scores 3 on `depth_under_pressure`; bluffing scores 1.

**Run it**
```bash title="terminal"
python interviewer.py --round 3 --loop 1 --project "Benchmarked inference service"
```

**You should see**
```text
INTERVIEWER: You have 10 minutes. Present 'Benchmarked inference service': the problem, constraints, what you built, and the results with numbers.
...
INTERVIEWER: You said AWQ gave the best cost per token. How did you check that the quantized model's answers were still good enough?   [14.2/40 min]
...
project-defense: {'story': 3, 'numbers': 4, 'alternatives': 2, 'failure_ownership': 3, 'depth_under_pressure': 2}
```

**If it breaks**
- You cannot answer level-3 cost questions about your own project → that is the most valuable finding of the loop. Go back to the project, measure it, and add the number to your README.

## Step 8 · Score from the recording and find the three weakest moments
**Goal:** human scoresheets with evidence, merged with any model scores, and a ranked list of your weakest moments.

Watch the recording within 24 hours. Use the partner's timestamps. Score each item with the rubric anchors and write
the timestamp and your words as evidence.

```yaml title="scoresheets/loop1.yaml"
loop: 1
scorer: partner          # or "self"
date: 2026-11-07
rounds:
  1:
    - id: rag-accuracy-drop
      scores: {triage: 3, hypotheses: 3, measurement: 2, fix_and_prevention: 3, communication: 3}
      evidence: {measurement: "07:55 'I'd check the logs' - no metric or slice named"}
    - id: agent-loops
      scores: {triage: 2, hypotheses: 3, measurement: 3, fix_and_prevention: 2, communication: 2}
      evidence: {triage: "12:30 debugged traces for 3 min before capping steps"}
  2:
    - id: support-assistant
      scores: {requirements: 3, baseline_first: 2, architecture_and_models: 3, data_and_context: 3, scale_reliability_security: 2, evals_and_monitoring: 2, tradeoffs: 1}
      evidence: {tradeoffs: "54:40 ran out of time, no trade-offs stated"}
  3:
    - id: project-defense
      scores: {story: 3, numbers: 3, alternatives: 2, failure_ownership: 3, depth_under_pressure: 2}
      evidence: {depth_under_pressure: "31:15 guessed the KV cache size instead of saying how to compute it"}
```

```python title="score.py"
"""Merge human scoresheets and LLM sessions, check the pass bar, list weakest moments, compare loops."""
import json
from collections import defaultdict
from pathlib import Path
from statistics import mean

import yaml

RUBRIC = yaml.safe_load(Path("kit/rubric.yaml").read_text(encoding="utf-8"))


def load_records() -> list[dict]:
    """Flatten every scored item into {loop, round, scorer, id, dim, score, evidence}."""
    records = []
    for path in sorted(Path("scoresheets").glob("*.yaml")):
        sheet = yaml.safe_load(path.read_text(encoding="utf-8"))
        for rnd, items in (sheet.get("rounds") or {}).items():
            for item in items:
                for dim, score in item["scores"].items():
                    records.append({"loop": sheet["loop"], "round": int(rnd), "scorer": sheet["scorer"],
                                    "id": item["id"], "dim": dim, "score": score,
                                    "evidence": (item.get("evidence") or {}).get(dim, "")})
    for path in sorted(Path("sessions").glob("*.json")):
        s = json.loads(path.read_text(encoding="utf-8"))
        for item in s["items"]:
            for dim, score in item["scores"].items():
                records.append({"loop": s["loop"], "round": s["round"], "scorer": s["scorer"], "id": item["id"],
                                "dim": dim, "score": score, "evidence": item.get("evidence", {}).get(dim, "")})
    return records


def aggregate(records: list[dict]) -> dict:
    """(loop, round) -> {dim: mean score} across all scorers and items."""
    buckets = defaultdict(lambda: defaultdict(list))
    for r in records:
        buckets[(r["loop"], r["round"])][r["dim"]].append(r["score"])
    return {key: {dim: round(mean(v), 2) for dim, v in dims.items()} for key, dims in buckets.items()}


def passes(dim_means: dict) -> bool:
    bar = RUBRIC["pass_bar"]
    return mean(dim_means.values()) >= bar["round_average"] and min(dim_means.values()) >= bar["no_dimension_below"]


def main() -> None:
    records = load_records()
    if not records:
        print("no scoresheets or sessions yet")
        return
    agg = aggregate(records)
    loops = sorted({k[0] for k in agg})
    for rnd in (1, 2, 3):
        dims = list(RUBRIC["rounds"][rnd]["dimensions"])
        print(f"\nRound {rnd}: {RUBRIC['rounds'][rnd]['name']}")
        print("| dimension | " + " | ".join(f"loop {l}" for l in loops) + " |")
        print("|---|" + "---|" * len(loops))
        for dim in dims:
            print(f"| {dim} | " + " | ".join(str(agg.get((l, rnd), {}).get(dim, "-")) for l in loops) + " |")
        verdicts = []
        for l in loops:
            if (l, rnd) in agg:
                m = agg[(l, rnd)]
                verdicts.append(f"loop {l}: avg {mean(m.values()):.2f} {'PASS' if passes(m) else 'not yet'}")
        print("  " + " · ".join(verdicts))

    latest = max(loops)
    weakest = sorted((r for r in records if r["loop"] == latest), key=lambda r: (r["score"], r["round"]))[:3]
    print(f"\nThree weakest moments in loop {latest}:")
    for r in weakest:
        print(f"- round {r['round']} {r['id']} · {r['dim']} = {r['score']} ({r['scorer']}): {r['evidence'] or 'no evidence noted'}")


if __name__ == "__main__":
    main()
```

```python title="tests/test_kit.py"
import yaml

from score import aggregate, passes


def test_rubric_has_anchors_for_every_dimension():
    rubric = yaml.safe_load(open("kit/rubric.yaml", encoding="utf-8"))
    for rnd in rubric["rounds"].values():
        for dim, spec in rnd["dimensions"].items():
            assert set(spec["anchors"]) == {1, 2, 3, 4}, dim


def test_six_core_scenarios_and_alternates():
    scenarios = yaml.safe_load(open("kit/scenarios.yaml", encoding="utf-8"))["scenarios"]
    assert sum(s["loop"] == 1 for s in scenarios) == 6
    assert sum(s["loop"] == 2 for s in scenarios) >= 6
    assert len({s["id"] for s in scenarios}) == len(scenarios)


def test_aggregate_and_pass_bar():
    recs = [{"loop": 1, "round": 1, "dim": "triage", "score": 3}, {"loop": 1, "round": 1, "dim": "triage", "score": 4},
            {"loop": 1, "round": 1, "dim": "measurement", "score": 2}]
    agg = aggregate(recs)
    assert agg[(1, 1)] == {"triage": 3.5, "measurement": 2}
    assert not passes(agg[(1, 1)])          # average 2.75 is below 3.0
    assert passes({"triage": 3, "measurement": 3})
```

**How this code works**
- One flat record per (item, dimension) → human and model scores land in the same shape, so you can compare scorers and merge them.
- `aggregate` averages across scorers → if your partner and the model disagree by 2 points on the same item, look at both pieces of evidence; the disagreement itself tells you the answer was ambiguous.
- `passes` applies the bar written in Step 2 → no moving the goalposts after you see the scores.
- Weakest moments = lowest scores in the latest loop, with evidence → these become the practice plan. Three, not ten: you can actually fix three in a week.

**Run it**
```bash title="terminal"
pytest -q
python score.py
```

**You should see**
```text
3 passed in 0.12s

Round 1: Rapid production scenarios
| dimension | loop 1 |
|---|---|
| triage | 2.67 |
| hypotheses | 3.0 |
| measurement | 2.5 |
...
  loop 1: avg 2.76 not yet

Three weakest moments in loop 1:
- round 2 support-assistant · tradeoffs = 1 (partner): 54:40 ran out of time, no trade-offs stated
- round 1 rag-accuracy-drop · measurement = 2 (partner): 07:55 'I'd check the logs' - no metric or slice named
- round 1 agent-loops · triage = 2 (partner): 12:30 debugged traces for 3 min before capping steps
```

**If it breaks**
- `KeyError: 'loop'` → a scoresheet is missing the top-level `loop` or `scorer` field.
- Dimension names in a scoresheet do not match the rubric → typos create new rows; copy names from `kit/rubric.yaml`.

## Step 9 · Practise the weak spots and run loop 2
**Goal:** a week of targeted practice, a second full loop on new material, and a short note on what improved.

Turn each weak moment into a drill you can do in 15 minutes a day:

```markdown title="practice-plan.md"
# Practice plan: loop 1 -> loop 2 (7 days)

| Weak moment | Drill | Done |
|---|---|---|
| No trade-offs in design (round 2) | Set phase alarms; for 3 old briefs, write 3 trade-offs each with "this flips if..." | [ ] |
| "Check the logs" with no metric (round 1) | For each loop-1 scenario, write the one decisive metric per hypothesis; say it aloud in 60 s | [ ] |
| Debugged before mitigating (round 1) | Start every scenario answer with a mitigation sentence; drill with `interviewer.py --round 1 --loop 1` | [ ] |

## What improved (fill after loop 2)
- Round averages: R1 2.76 -> ?, R2 2.29 -> ?, R3 2.6 -> ?
- Biggest change:
- Still weak:
```

**How this code works**
- Drills on loop-1 material are fine → you practise the behaviour on known questions, then prove it on loop-2's new ones.
- Loop 2 changes the material (`--loop 2` picks the alternates and the second brief) but keeps the rubric and timings, so the score change reflects you.

**Run it** (one week later, same checklist, same time of day)
```bash title="terminal"
python interviewer.py --round 1 --loop 2
python interviewer.py --round 2 --loop 2
python interviewer.py --round 3 --loop 2 --project "LoRA vs prompted baseline"
# add scoresheets/loop2.yaml from the recording, then:
python score.py
```

**You should see**
```text
Round 1: Rapid production scenarios
| dimension | loop 1 | loop 2 |
|---|---|---|
| triage | 2.67 | 3.33 |
| measurement | 2.5 | 3.17 |
...
  loop 1: avg 2.76 not yet · loop 2: avg 3.14 PASS
```

**If it breaks**
- Scores did not move → check the drills actually happened; if they did, the weak spot may be knowledge, not delivery. Go back to the relevant Level 16 lesson, then drill again.
- Scores jumped suspiciously on the model scorer only → the model may be lenient on longer answers. Trust the human scoresheet and note the gap.

## Ship it
- Commit `kit/`, `interviewer.py`, `score.py`, `tests/`, `scoresheets/`, `sessions/` and `practice-plan.md`. Keep `recordings/` private and out of git.
- README: how to run a loop (checklist, three commands, scoring), the rubric's pass bar, and a short how-to for a partner.
- Deliverable note (half a page): dates of both loops, the round-by-round table from `score.py`, the three weakest moments from loop 1 and whether each improved, and what you will practise next.
- Portfolio angle: the kit itself is shareable. Offer it to a study group; teaching the rubric is good practice too.

## Going further
- Swap roles: interview someone else with the same rubric and score their recording; compare your scores with theirs.
- Write a one-page answer bank for the scenarios you struggled with: structure, decisive metric, mitigation, guard.
- Add a voice mode: transcribe your spoken answers with a speech-to-text model and feed them through `--answers-file`.
- Measure scorer agreement: have a partner and the model score the same loop and report how often they differ by 2+ points.
- Add a behavioural round (conflict, ownership, ambiguity) with its own rubric section.
