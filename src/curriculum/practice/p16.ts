import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "16.1": {
    realLife: {
      title: "Revising from one exam board's past papers",
      story:
        "Two students sit the same chemistry exam. One reads every textbook in the library. The other gets five years of past papers from that exam board, notices that organic synthesis and titration calculations come up every year, and spends most of her time there, plus a little on her own weakest chapter. She scores higher in half the time.",
      mapping: [
        { everyday: "This exam board's past papers", concept: "Decoding a specific job description and the interview format it implies" },
        { everyday: "Topics that come up every year", concept: "System design, debugging and production scenarios, which dominate current loops" },
        { everyday: "Her own weakest chapter", concept: "An honest skills gap list feeding a personal prep plan" },
        { everyday: "Not reading every textbook", concept: "Not studying every tool listed. Unlike an exam board, companies change formats without notice, so check with the recruiter" },
      ],
    },
    build: {
      title: "Drill: decode three job posts into a two-week plan",
      goal: "A one-page prep plan built from three real job descriptions and a self-scored skills grid.",
      minutes: 60,
      stack: ["Three real job postings", "a spreadsheet or markdown table", "a timer"],
      steps: [
        "Collect three current postings for the exact role you want and paste them into one document.",
        "Highlight every requirement and tag it with an area: RAG, agents, evals, inference, LLMOps, cloud and deployment, fine-tuning, multimodal, SWE basics.",
        "Count tags across the three posts and keep the top five areas; note each post's role flavour (AI engineer, GenAI data scientist, platform).",
        "Score yourself 1-5 on each top area, and for each, name one project or story that proves your score.",
        "Write a 14-day plan: daily one-hour blocks, weighted to high-frequency areas where you scored 3 or less, with a mock interview on days 7 and 14.",
        "Write a 3-sentence pitch that connects your past work to the top three areas.",
      ],
      checks: [
        "Your top five areas each appear in at least two of the three postings.",
        "Every score of 4 or 5 is backed by a named project or story, not a feeling.",
        "You can say your pitch out loud in under 45 seconds without reading it.",
      ],
      stretch: "Ask someone working in the role to rank your top five areas and compare with your counts.",
    },
  },

  "16.2": {
    realLife: {
      title: "A plumber chasing low water pressure in a tower block",
      story:
        "Residents on the 14th floor complain that pressure has been weak since last week. A good plumber doesn't start replacing taps. She checks whether the mains supply changed, then the roof tank, then the pump, then the pipes on that floor, and only then the taps, comparing each against how it was before the complaint started.",
      mapping: [
        { everyday: "The mains supply into the building", concept: "Ingestion: did the source data, parsing or chunking change?" },
        { everyday: "Roof tank and pump", concept: "Index and retrieval: embedding model version, index rebuilds, filters, recall" },
        { everyday: "Pipes and taps on one floor", concept: "Generation: prompt, model version, context assembly for a subset of queries" },
        { everyday: "Comparing each part against last week", concept: "Isolating changes with logs, versioned configs and a fixed eval set. Water doesn't lie about pressure; an LLM can sound confident while retrieval is broken" },
      ],
    },
    build: {
      title: "Drill: debug a RAG app you broke on purpose",
      goal: "A written diagnosis of three hidden faults in your own small RAG app, found with evidence in under 45 minutes.",
      minutes: 120,
      stack: ["Python", "your 15.1 project or any small RAG app", "a friend or a script to inject faults", "a timer"],
      steps: [
        "Take a small working RAG app with a 20-question eval and record its baseline hit rate and answer accuracy.",
        "Have a friend (or a script with a random seed you don't look at) inject three faults from this list: chunk size cut to 100 characters, a different embedding model used for queries than for documents, a metadata filter that drops half the documents, top-k reduced to 1, a prompt line that tells the model to always answer, a stale index missing new files.",
        "Start a 45-minute timer. Re-run the eval and write down which layer each failing question points to before you open any code.",
        "Narrow down layer by layer: check the raw chunks, then retrieval results for failing questions, then the final prompt sent to the model.",
        "For each fault write: symptom, evidence, root cause, fix, and the monitoring signal that would have caught it in production.",
      ],
      checks: [
        "You found at least two of the three faults inside 45 minutes.",
        "Each diagnosis cites evidence (a log line, a retrieved chunk, a metric) rather than a guess.",
        "After your fixes the eval returns to within a couple of points of the baseline.",
      ],
      stretch: "Whiteboard the same app for 2M documents and 5k concurrent users in 20 minutes, and mark where each of your three faults would surface.",
      studio: "rag-pipeline",
    },
  },

  "16.3": {
    realLife: {
      title: "A new hire with a company card",
      story:
        "A new office manager gets a company card to handle supplies. It has a monthly limit, anything over a set amount needs her boss's approval, and every purchase leaves a receipt. When the stationery budget mysteriously doubles, finance doesn't ask her to try harder; they read the receipts and find she reordered the same toner five times because the delivery confirmation never arrived.",
      mapping: [
        { everyday: "The card and what it can buy", concept: "The agent's tools and permissions" },
        { everyday: "Monthly limit and approval above a set amount", concept: "Step and spend caps, and human approval for consequential actions" },
        { everyday: "Reordering toner because no confirmation came", concept: "A runaway loop caused by an ambiguous tool result" },
        { everyday: "Reading the receipts", concept: "Debugging from the trajectory. A person learns after one mistake; an agent repeats it until you change its tools or prompt" },
      ],
    },
    build: {
      title: "Drill: design and break an agent in 45 minutes",
      goal: "A written agent design for a business task, and three failure scenarios answered against a checklist, recorded as audio or video.",
      minutes: 75,
      stack: ["A whiteboard tool", "a phone or screen recorder", "a timer"],
      steps: [
        "Pick a brief: 'an agent that handles refund requests for an online shop, can read orders and issue refunds up to $200'.",
        "In 20 minutes, write: workflow or agent and why, tools with input schemas, memory, step and cost caps, where a human approves, and what gets logged.",
        "Record yourself answering three failure prompts, 3 minutes each: the agent loops calling get_order 40 times; it refunds the wrong order after a customer message says 'ignore previous instructions'; it passes tests but fails 15% of real tickets.",
        "Replay the recording and score each answer against the checklist: names a specific cause, reads the trace first, proposes a guardrail, reduces autonomy where it should, mentions a test to prevent regression.",
        "Rewrite your weakest answer in 5 bullets and record it again.",
      ],
      checks: [
        "Your design states a deterministic workflow for the parts that don't need judgment.",
        "Each failure answer hits at least 4 of the 5 checklist items.",
        "The prompt-injection answer separates instructions from tool and user data and limits refund permission, not only 'improve the prompt'.",
      ],
      stretch: "Build the refund agent with fake tools and actually reproduce the loop, then fix it.",
      studio: "guarded-agent",
    },
  },

  "16.4": {
    realLife: {
      title: "A restaurant chain opening a branch in a new city",
      story:
        "To serve its signature dish in a new city, the chain can send a recipe card, keep a binder of recipes on the counter, or send the cook on a two-week training course. The course is worth it only for techniques a card can't teach. When the dish tastes off at the new branch, the head chef checks the local ingredients, the different oven and whether the recipe was copied correctly before blaming the cook.",
      mapping: [
        { everyday: "Recipe card, binder on the counter, training course", concept: "Prompting, RAG, fine-tuning" },
        { everyday: "A course only for techniques a card can't teach", concept: "Tune for behaviour, format or style, not for facts that change" },
        { everyday: "Local ingredients are different", concept: "Distribution shift between training data and live traffic" },
        { everyday: "A different oven, a miscopied recipe", concept: "Serving changes: chat template, sampling settings, quantisation. Unlike a cook, a model doesn't adapt by itself to the new kitchen" },
      ],
    },
    build: {
      title: "Drill: three timed fine-tuning answers and one regression hunt",
      goal: "Recorded answers to three fine-tuning prompts scored against a rubric, plus a reproduced quality drop from a wrong chat template.",
      minutes: 90,
      stack: ["A recorder", "Python", "transformers", "a small open instruct model (0.5-1.5B parameters)"],
      steps: [
        "Record a 4-minute answer to each: 'A legal startup wants answers in their house style citing their own precedents: prompt, RAG or tune?'; 'Your QLoRA model needs to run at p95 under 800 ms for 50 concurrent users: what do you serve it on and how?'; 'Accuracy dropped 9 points after deploy: walk me through it'.",
        "Score each against: states the decision rule, gives memory or cost numbers, names at least two alternatives, says how to measure.",
        "Load a small instruct model and run 20 short questions with tokenizer.apply_chat_template, saving answers.",
        "Run the same 20 questions as raw text with no chat template, and with temperature raised to 1.2, and compare answers side by side.",
        "Add what you saw as evidence to your recorded answer for the regression question.",
      ],
      checks: [
        "Each recording names concrete trade-offs (for example 7B in 4-bit needs roughly 4-5 GB for weights versus about 14 GB in FP16).",
        "Your side-by-side shows visibly worse answers without the chat template.",
        "Your regression answer lists at least five places to check in a sensible order.",
      ],
      stretch: "Quantise the model to 4-bit and add a fourth column to the comparison.",
      sim: "quantization",
    },
  },

  "16.5": {
    realLife: {
      title: "The control room of a metro line",
      story:
        "Screens in the metro control room show every train's position, the gap between trains and platform crowding. A two-minute delay on one train gets watched; a signal failure that stacks trains up triggers an alarm and a switch to a backup timetable. Controllers know which problems mean stopping the line, which mean running a reduced service, and which just need a technician on the next shift.",
      mapping: [
        { everyday: "Train positions, gaps, platform crowding", concept: "Latency percentiles, throughput, queue depth, error rates and cost" },
        { everyday: "Switching to a backup timetable", concept: "Fallback models and graceful degradation" },
        { everyday: "Stop the line, reduced service, or next-shift technician", concept: "Page and roll back, degrade, or just investigate" },
        { everyday: "Trains stacking up behind a failed signal", concept: "Queue build-up when a dependency slows down. Unlike trains, LLM answers can quietly get worse with every metric still green, so you also need quality signals" },
      ],
    },
    build: {
      title: "Drill: incident triage from a dashboard you generate",
      goal: "Five incident write-ups, each produced in 8 minutes from synthetic metrics, scored against a triage checklist.",
      minutes: 75,
      stack: ["Python", "pandas", "matplotlib", "a timer"],
      steps: [
        "Write a script that generates a day of per-minute metrics (requests, p50 and p95 latency, error rate, tokens per request, cost, cache hit rate, eval score) with a normal baseline.",
        "Add five injectable incidents: provider latency doubling, a burst of 429s, a prompt change that doubles tokens per request, cache hit rate collapsing after a deploy, eval score sliding 1% a day with everything else flat.",
        "Have the script pick one at random, plot the dashboard, and hide which it chose.",
        "For each, set an 8-minute timer and write: what you see, first three checks, page or not, roll back or not, mitigation, and the alert you would add.",
        "Reveal the answer and score yourself against the checklist: right diagnosis, correct page/rollback call, a mitigation that protects users first, a durable fix.",
      ],
      starter: `import numpy as np, pandas as pd, random

minutes = pd.date_range("2026-01-01", periods=1440, freq="min")
base = pd.DataFrame({
    "requests": np.random.poisson(120, 1440),
    "p95_ms": np.random.normal(2200, 150, 1440),
    "error_rate": np.random.beta(1, 300, 1440),
    "tokens_per_req": np.random.normal(1800, 80, 1440),
    "cache_hit": np.random.normal(0.35, 0.02, 1440),
}, index=minutes)

def inject(df: pd.DataFrame, kind: str, start: int = 600) -> pd.DataFrame:
    # TODO: one branch per incident kind, changing the right columns from start
    ...

kind = random.choice(["latency", "rate_limit", "token_blowup", "cache_drop", "quality_drift"])
# TODO: inject, plot each column, save dashboard.png, write kind to answer.txt`,
      checks: [
        "You diagnosed at least 4 of 5 incidents correctly.",
        "For the quality-drift case you said what evaluates quality when latency and errors look normal.",
        "Each write-up says explicitly whether to page someone and why.",
      ],
      stretch: "Add a self-hosted inference variant with GPU KV-cache saturation and queue depth, and triage it.",
      sim: "load-test",
    },
  },

  "16.6": {
    realLife: {
      title: "A wedding planner's first meeting",
      story:
        "A couple says 'we want something elegant, not too expensive'. A good planner doesn't start sketching table arrangements. She asks the guest count, budget, date, city and must-haves, writes those down and reads them back. She proposes a simple plan first, a venue and a caterer, then adds a band or fireworks only when the couple's priorities justify the cost, and she knows what happens if it rains.",
      mapping: [
        { everyday: "Guest count, budget, date, must-haves read back", concept: "Turning a vague brief into stated assumptions with numbers" },
        { everyday: "Venue and caterer first", concept: "A simple baseline: retrieval plus one model call" },
        { everyday: "A band only if the couple wants dancing", concept: "Adding routing, caching, agents or tuning only when a requirement demands it" },
        { everyday: "The rain plan", concept: "Failure modes, fallbacks and monitoring. An interviewer, unlike a couple, will change the requirements mid-meeting to test you" },
      ],
    },
    build: {
      title: "Drill: a timed 45-minute design round written against a rubric",
      goal: "A complete written design for one practice system produced in 45 minutes, scored against a 10-point rubric, then redone.",
      minutes: 120,
      stack: ["Excalidraw or paper", "a timer", "optionally a model playing the interviewer with a written brief"],
      steps: [
        "Pick one brief: 'Design a support assistant over 2M internal documents for 5,000 agents with p95 under 3 seconds' (or a coding assistant, research agent, or insurance document processor).",
        "Start a 45-minute timer and follow the hour plan: 6 min requirements with numbers, 6 min baseline, 18 min architecture, 8 min scale and failures, 5 min evals and monitoring, 2 min trade-offs.",
        "Do a back-of-envelope sum on paper: requests per second at peak, tokens per request, monthly model cost, index size.",
        "Stop at 45 minutes, even if unfinished, and score with this rubric (1 point each): numbers in requirements; baseline before extras; every component tied to a requirement; data and permissions on retrieval; model and routing choice justified; latency budget split by stage; cost estimate; two failure modes with fallbacks; offline eval plus online monitoring; one trade-off you'd revisit.",
        "Pick the two lowest items, study them for 20 minutes, and redo the same brief with a twist (data can't leave the EU, or traffic grows 10x).",
      ],
      checks: [
        "You have a latency budget that adds up to under 3 seconds with stage-by-stage numbers.",
        "Your cost estimate is written down with its arithmetic, not 'it depends'.",
        "Your second attempt scores at least 2 points higher than the first.",
      ],
      stretch: "Have a model play interviewer and inject a mid-round change, then score how you adapted.",
      sim: "token-budget",
    },
  },

  "16.7": {
    realLife: {
      title: "A cricket selector watching a new batter",
      story:
        "A young batter scores a hundred in a domestic match and social media wants him in the national team tomorrow. The selector checks the conditions he scored in, watches him face the pace bowlers in the nets, plays him in a warm-up game and only then picks him for one match, with the experienced player on the bench.",
      mapping: [
        { everyday: "A hundred in a domestic match", concept: "A public benchmark score or launch announcement" },
        { everyday: "Facing your own bowlers in the nets", concept: "Running your own eval set on the new model" },
        { everyday: "Warm-up game, then one match with a backup on the bench", concept: "Shadow traffic or canary rollout with a fallback to the current model" },
        { everyday: "Ignoring the social media buzz", concept: "Separating real capability shifts from noise. A new model costs far less to try than a new player, so you can test more of them, as long as the eval is cheap" },
      ],
    },
    build: {
      title: "Drill: evaluate a newly released model in 90 minutes",
      goal: "A one-page swap decision for a model released in the last three months, based on your own eval, cost and latency, plus a recorded 60-second 'how do you stay current' answer.",
      minutes: 90,
      stack: ["Python", "two model APIs", "a 30-item eval set from one of your projects"],
      steps: [
        "Pick a recently released model and your current model for one of your projects.",
        "Write down in two lines what the announcement claims and which benchmark it cites, and whether that benchmark resembles your task.",
        "Run your 30-item eval on both models, capturing score, mean and p95 latency, and cost per item.",
        "Write the decision: switch, don't switch, or route a subset; plus the rollout plan (shadow, canary percentage, rollback trigger).",
        "Record a 60-second answer to 'how do you stay current?' that names your sources, your filter and this exact experiment.",
      ],
      checks: [
        "Your decision quotes your own numbers, not the announcement's.",
        "The rollout plan has a numeric rollback trigger.",
        "The recorded answer mentions a concrete recent evaluation you did and lasts under 75 seconds.",
      ],
      stretch: "Turn the script into a reusable harness that evaluates any new model with one command.",
      sim: "router-cost",
    },
  },

  "16.8": {
    realLife: {
      title: "A PhD viva",
      story:
        "In a viva, two examiners have read the thesis and spend two hours asking why: why this method, why not the obvious alternative, what the results really show, what you would do differently. Candidates who pass know their numbers, admit the weak chapter before being asked, and explain what they tried that failed.",
      mapping: [
        { everyday: "Examiners who have read the thesis", concept: "Interviewers who have opened your repo and README" },
        { everyday: "'Why this method and not the obvious one?'", concept: "'Why not RAG? Why not fine-tune? Why an agent?'" },
        { everyday: "Knowing your numbers", concept: "Quality scores, latency, cost per query and gain over baseline" },
        { everyday: "Admitting the weak chapter first", concept: "Owning failures and what you changed. A viva has days of notice; an interview may pick any project on your CV" },
      ],
    },
    build: {
      title: "Drill: a recorded 10-minute project defense with 12 hostile follow-ups",
      goal: "A recorded project presentation plus answers to 12 follow-up questions, reviewed with a checklist, for your two strongest projects.",
      minutes: 120,
      stack: ["A recorder", "your portfolio projects", "optionally a model prompted to act as a skeptical interviewer"],
      steps: [
        "For one project, fill a one-page story sheet: problem, requirements, baseline, architecture, three decisions with the alternative you rejected, two failures, evals and results with numbers.",
        "Record a 10-minute presentation using only the sheet and your architecture diagram.",
        "Have a partner or a model ask 12 follow-ups, including: why not RAG, why not fine-tune, why an agent, what about 100x traffic, how would you halve the cost, what breaks first. Answer each in under 2 minutes on camera.",
        "Review with a checklist per answer: gives a number, names the rejected alternative, states the trade-off, admits limits without hedging, stays under 2 minutes.",
        "Re-record your three weakest answers, then repeat the whole drill for your second project.",
      ],
      checks: [
        "Your presentation includes at least four numbers (quality, latency, cost, data size or traffic).",
        "At least 10 of 12 answers meet the checklist on the second attempt.",
        "You can explain one failure and what you changed without being asked.",
      ],
      stretch: "Swap with a peer and question their project using the same list.",
    },
  },

  "16.9": {
    realLife: {
      title: "A good GP consultation",
      story:
        "A good family doctor asks about your symptoms before suggesting anything, says what she thinks is most likely and what else it could be, and explains the options: rest, a prescription, or a scan, with what each costs you. When she isn't sure, she orders a blood test instead of guessing, and she explains it in words you understand.",
      mapping: [
        { everyday: "Asking about symptoms first", concept: "Stating assumptions before solving an ambiguous question" },
        { everyday: "Rest, prescription or scan with their costs", concept: "Trade-offs before tools" },
        { everyday: "Ordering a blood test instead of guessing", concept: "Measure, don't bluff: say how you would find out" },
        { everyday: "Plain words, at your level", concept: "Explaining at the right altitude for the question. Unlike a patient, an interviewer also wants to see you change course when they push back" },
      ],
    },
    build: {
      title: "Drill: record five answers and review them with a communication checklist",
      goal: "Five recorded answers (two technical, two scenario, one experience story) scored against a communication checklist, with measurable improvement on a second take.",
      minutes: 60,
      stack: ["A phone or screen recorder", "a speech-to-text tool for transcripts", "a timer"],
      steps: [
        "Write five prompts: 'Why is decode memory-bound?', 'Explain RAG to a product manager in 90 seconds', 'Our chatbot's costs tripled overnight: what do you do?', 'Design a meeting summariser' (first 5 minutes only), 'Tell me about a time an AI feature failed'.",
        "Record each with a strict time limit (90 seconds, 90 seconds, 3 minutes, 5 minutes, 3 minutes).",
        "Transcribe them and mark: assumptions stated, options named before a tool, numbers used, 'I would measure X' when unsure, filler words, and for the story whether it follows situation, decision, implementation, result, lesson.",
        "Count filler words per minute and the number of checklist items hit.",
        "Re-record the two weakest and recount.",
      ],
      checks: [
        "The design answer states at least three assumptions with numbers in the first 90 seconds.",
        "The experience story has a quantified result and a lesson.",
        "Second takes hit more checklist items and have fewer filler words per minute than first takes.",
      ],
      stretch: "Do a 20-minute whiteboard session on video and check you revealed the diagram in stages instead of drawing everything at once.",
    },
  },

  "16.10": {
    realLife: {
      title: "A driving test after mock tests with an instructor",
      story:
        "Before the real driving test, your instructor runs mock tests on the actual test routes using the examiner's marking sheet: a few surprise manoeuvres, a stretch of independent driving, then a debrief on every minor fault. You redo the mock a week later and count the faults again. On the day, nothing feels new.",
      mapping: [
        { everyday: "Surprise manoeuvres", concept: "Round 1: six rapid production scenarios" },
        { everyday: "Independent driving to a destination", concept: "Round 2: a system design from a vague brief" },
        { everyday: "The theory and the 'show me, tell me' questions", concept: "Round 3: defending a portfolio project" },
        { everyday: "The examiner's sheet, and a second mock a week later", concept: "A written rubric, recorded rounds and a rerun to measure improvement. A driving test has a fixed sheet; interviewers each weigh things differently, so make your rubric cover several styles" },
      ],
    },
    build: {
      title: "First milestone: write the rubric and run Round 1",
      goal: "A written three-round rubric and a recorded, scored Round 1 of six rapid scenarios.",
      minutes: 90,
      stack: ["A recorder", "a whiteboard tool", "a partner, or a model prompted as interviewer with the rubric"],
      steps: [
        "Write the rubric: for each round, 5-6 criteria scored 1-4 with a one-line description of what a 4 looks like (for example 'names the first metric to check and why').",
        "Write the six Round 1 scenarios on cards: RAG accuracy suddenly drops, an agent loops expensively, provider latency doubles, a tuned model regresses after deploy, a prompt change doubles cost, an offline-passing retriever fails on live queries.",
        "Book a 45-minute slot, have your partner shuffle and read the cards, and answer each in about 7 minutes on camera.",
        "Score from the recording, not from memory, and list your three weakest moments with timestamps.",
        "Schedule Rounds 2 and 3 within the week, and the full rerun a week after that.",
      ],
      checks: [
        "Each rubric criterion describes observable behaviour, not 'good communication'.",
        "You have a scored Round 1 with a timestamp for each of your three weakest moments.",
        "The rerun date and new scenario cards are written down.",
      ],
      stretch: "Run the same rubric on a peer and compare how you scored the same scenario.",
    },
  },
};
