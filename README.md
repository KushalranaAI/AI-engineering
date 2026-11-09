# AI Engineer Path

**Learn AI engineering by building it.** A self-paced path from writing software to shipping AI systems in production:
17 levels, a four-step loop for every module, step-by-step project guides with complete code, an agent sandbox where you
design and simulate real systems, and an optional AI tutor that sees the page you're on.

Built by **[Kushal Rana](https://kushalranaai.github.io/)**, as a companion to [System Learn](https://github.com/KushalranaAI/system_learn).

## How you learn

Every module is the same four steps, so you always know what to do next:

1. **Read**: a short lesson with worked examples, then tick the topics you could explain.
2. **Relate**: the same mechanism in an everyday situation (a library, a UPI payment, a hospital triage desk), with a line-by-line mapping.
3. **Build**: implement it yourself, with starter code, acceptance checks, and a simulator or Studio design to explore first.
4. **Check**: questions you answer before revealing; the ones you miss come back in Review.

## What's inside

| | |
|---|---|
| **Learn** | 17 levels in 7 phases: Foundations (0-3), Retrieval (4, with scheduled Airflow ingestion, pgvector and OpenSearch), Agents (5-6, with eight layers of agent memory), Evaluation & Security (7-8, with golden datasets, LLM judges, RAGAS and guardrail frameworks), Production (9-12, including Redis caching, Kubernetes on EKS, Locust load tests, autoscaling and inference engineering: roofline, vLLM/SGLang, KV cache, batching, quantization), Frontier & Portfolio (13-15), Interview (16). A course outline on the left always shows where you are. |
| **Build** | 22 projects, each a guided build: one step per screen, complete code with a copy button, an explanation of every important line, the output to expect, and what to do when it breaks. |
| **Studio** | A React Flow sandbox. Drag LLMs, agents, retrievers, routers, guardrails, queues, load balancers and GPU pools onto a canvas; **simulate** thousands of requests (p50/p95/p99, cost, correctness, failures), **play** one request through the graph, **size GPUs** from model, precision and traffic, **run it live** with your own key, or **export it as Python**. Three *journeys* evolve one real product step by step (support assistant, agent team, self-hosted serving), and presets include an assistant with layered memory. |
| **Practice** | Spaced-repetition flashcards (340+), an interview bank (140+ questions with what a strong answer covers, red flags and follow-ups), and 15 interactive simulators (LLM anatomy, similarity, chunking, RRF, token budget, short-term memory, forgetting curve, RAG metrics, router cost, roofline, KV cache, quantization, batching, load test, autoscaling). |
| **Progress** | Streak, activity heatmap, per-level progress, a review list, all your notes, and export/import. |
| **AI tutor (optional)** | Paste an OpenAI, Anthropic or Azure OpenAI key (or keep keys in `.env` when running locally). The tutor knows which lesson, step, project step or Studio design you have open, quizzes you one question at a time, and gives hints before answers. |

Everything runs in the browser. No account, no backend. Progress lives in `localStorage`.

## Run it

```bash
npm start        # installs if needed, then opens http://localhost:5174
npm test         # curriculum, content, progress and simulation maths
npm run build    # static build in dist/ (any static host works)
```

Port 5174 is used so it can run next to System Learn (5173).

## How the content is organised

```
src/curriculum/levels/lNN.ts        modules, topics, outcomes, weights, projects (one file per level)
content/LNN/<id>-<slug>.md          one lesson per module (Read + Check)
src/curriculum/practice/pNN.ts      real-life story + build task per module (Relate + Build)
content/projects/<project-id>.md    step-by-step project guide with code
src/curriculum/practice/interview-*.ts, flashcards-*.ts
src/studio/                         the sandbox: simulate.ts (engine), sizing.ts (GPU maths), journeys.ts, live.ts, codegen.ts
src/sims/                           the interactive simulators
```

Formats and rules are in [docs/content-guide.md](docs/content-guide.md) and [docs/project-guides.md](docs/project-guides.md).
`npm test` checks that every module has a lesson, a real-life story and a build task, that every project guide parses
into steps, and that the simulation and sizing maths behave.

## Honest limits

- Studio simulations use example prices, speeds and GPU specs. They are for comparing designs and building intuition, not for quoting costs. Measure the real thing.
- Project guides were checked for structure and syntax, and many were run against mock providers; model outputs shown in them are illustrative unless a guide says it measured them.
- Model names, library versions and cloud flags change quickly. Where a call is likely to drift, the guide says `check the current docs`.

## Credits

The idea of a level-by-level roadmap was inspired by the public
[AI Engineering Roadmap](https://ai-engineer-roadmap-2026.vercel.app/) by CampusX. All descriptions, lessons, projects,
simulators and code here are original. This project is not affiliated with CampusX.

MIT licensed.
