import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "6.1": {
    realLife: {
      title: "Packing a 7 kg cabin bag",
      story:
        "On a budget flight you get one 7 kg cabin bag. You split it roughly: clothes, laptop and charger, toiletries, a book. Stuff in 'just in case' items and you go over weight, pay extra, and at security you can't find your boarding pass buried in the middle. Before you zip it, you tip everything onto the bed and look at what you actually packed.",
      mapping: [
        { everyday: "The 7 kg limit", concept: "The context window as a fixed budget" },
        { everyday: "Shares for clothes, electronics, toiletries", concept: "Allocating tokens to instructions, history, retrieval, tools and output" },
        { everyday: "Boarding pass lost in the middle; paying for excess", concept: "Lost-in-the-middle, distraction and rising token cost" },
        { everyday: "Tipping the bag out on the bed", concept: "Dumping the exact request the model receives" },
      ],
    },
    build: {
      title: "A context inspector and a context-rot test",
      goal: "A reusable wrapper that reports tokens per prompt section on every call, and an experiment showing accuracy falling as filler grows and as a key fact moves to the middle.",
      minutes: 75,
      stack: ["Python", "tiktoken (or your provider's token counter)", "an LLM API"],
      steps: [
        "Write build_request(sections) that takes an ordered dict of named sections (system, memory, retrieved, history, tools, user) and returns both the messages and a token count per section.",
        "Print a one-line report per call (system 900 | history 6,200 | retrieved 4,100 ...) and append it to a CSV.",
        "Create a test: hide 10 facts ('Locker 7 code is 4418') in filler text of 2k, 16k and 64k tokens, at the start, middle and end.",
        "Ask for each fact and record accuracy for each size and position, plus cost per call.",
        "Plot or tabulate accuracy against size and position.",
      ],
      starter:
        "import tiktoken\n" +
        "enc = tiktoken.get_encoding(\"o200k_base\")\n" +
        "\n" +
        "def build_request(sections: dict[str, str]):\n" +
        "    report = {name: len(enc.encode(text)) for name, text in sections.items()}\n" +
        "    system = sections.get(\"system\", \"\")\n" +
        "    body = \"\\n\\n\".join(f\"<{n}>\\n{t}\\n</{n}>\" for n, t in sections.items()\n" +
        "                       if n not in (\"system\", \"user\"))\n" +
        "    # TODO: return messages for your provider plus the report\n" +
        "    ...\n" +
        "\n" +
        "def needle_test(fact, question, filler_tokens, position):\n" +
        "    # TODO: build filler, insert fact at start/middle/end, ask, check answer\n" +
        "    ...\n",
      checks: [
        "Every call prints a per-section token report whose total matches the provider's reported input tokens within a few percent.",
        "Your table covers 3 sizes x 3 positions with accuracy and cost.",
        "You can point to the size or position where accuracy starts to slip for the model you used, or show it didn't within this range.",
      ],
      sim: "token-budget",
    },
  },

  "6.2": {
    realLife: {
      title: "A cricket team's pre-match briefing sheet",
      story:
        "The analysts have fifty pages on the opposition, but the sheet pinned in the dressing room before a T20 is one page. The field plan is always on it; pitch notes only if the surface is unusual. Last week's form ranks above last season's, an old injury report that has since been cleared is removed, and two analysts' near-identical notes on the same bowler become one. Bowling plans, batting plans and conditions sit under separate headings.",
      mapping: [
        { everyday: "Field plan always; pitch notes sometimes", concept: "Always present, fetched on demand, or left out" },
        { everyday: "Last week's form above last season's", concept: "Ranking by relevance, importance and recency" },
        { everyday: "Removing the cleared injury and the duplicate note", concept: "Dropping stale, contradictory and duplicate material" },
        { everyday: "Separate headings on the sheet", concept: "Labelled, ordered sections in the context" },
      ],
    },
    build: {
      title: "A context assembler with a budget",
      goal: "A function that takes candidate context items, scores them, removes duplicates and stale items, and packs the best into labelled sections under a token budget.",
      minutes: 90,
      stack: ["Python", "tiktoken", "sentence-transformers", "an LLM API"],
      steps: [
        "Define a ContextItem with kind (rule, memory, retrieved, history, tool_result), text, timestamp, source_trust (0-1), pinned (bool) and supersedes (optional id).",
        "Score each non-pinned item: similarity to the current request, times trust, times a recency factor; drop any item that a newer item supersedes.",
        "Remove near-duplicates (cosine above 0.92) by keeping the higher-scored one.",
        "Pack pinned items first, then by score until the budget is used, and render each kind in its own tagged section in a fixed order.",
        "Test on a support scenario with 40 candidate items, including a corrected address and two copies of one help article, and compare answers with the assembler against 'include everything'.",
      ],
      starter:
        "from dataclasses import dataclass\n" +
        "\n" +
        "@dataclass\n" +
        "class ContextItem:\n" +
        "    id: str; kind: str; text: str; ts: float\n" +
        "    trust: float = 1.0; pinned: bool = False; supersedes: str | None = None\n" +
        "\n" +
        "ORDER = [\"rule\", \"memory\", \"retrieved\", \"tool_result\", \"history\"]\n" +
        "\n" +
        "def assemble(items, request, budget=8000):\n" +
        "    superseded = {i.supersedes for i in items if i.supersedes}\n" +
        "    live = [i for i in items if i.id not in superseded]\n" +
        "    # TODO: score, dedupe, pack pinned first then by score within budget\n" +
        "    # TODO: render sections in ORDER as <kind>...</kind>\n" +
        "    ...\n",
      checks: [
        "The assembled context never exceeds the budget and always contains every pinned item.",
        "Only the corrected address appears, and only one copy of the duplicated article.",
        "Answers using the assembler are at least as good as 'include everything' while using far fewer tokens.",
      ],
      sim: "token-budget",
    },
  },

  "6.3": {
    realLife: {
      title: "Minutes of a housing society meeting",
      story:
        "A two-hour society meeting full of arguments becomes one page of minutes: decisions taken, rules agreed ('no parking in the visitor bay after 10 pm'), and action items with names. The secretary copies figures exactly, such as maintenance raised to ₹3,450 per month and flat B-1204's dues, into a table instead of paraphrasing them. At year end, twelve sets of minutes become a one-page annual summary. Who shouted at whom is lost, which is usually fine.",
      mapping: [
        { everyday: "Minutes with decisions, rules and action items", concept: "A structured summary that keeps goals, constraints, decisions and open work" },
        { everyday: "Figures copied into a table", concept: "Keeping ids, numbers and dates exact, outside the prose summary" },
        { everyday: "Annual summary of monthly minutes", concept: "Rolling and layered summaries" },
        { everyday: "Losing who shouted at whom", concept: "The detail compaction throws away" },
      ],
    },
    build: {
      title: "Rolling compaction with a pinned facts table",
      goal: "A compaction module that summarises history into a fixed schema, keeps exact facts in a separate store, and survives several compactions in a row without drift.",
      minutes: 90,
      stack: ["Python", "an LLM API with JSON output", "tiktoken"],
      steps: [
        "Define a compact state schema: goal, constraints, decisions, open_tasks, and a facts dict for ids, amounts and dates.",
        "Write compact(state, new_turns) that asks the model to update the schema, then copies any value matching an id, date or currency regex in new_turns straight into facts.",
        "Trigger compaction whenever history beyond the last 6 turns exceeds 3,000 tokens.",
        "Generate a 200-turn synthetic conversation with 10 planted constraints, ids and changed values, so compaction runs at least four times.",
        "After each compaction, check every planted item programmatically and record tokens before and after.",
      ],
      starter:
        "import json, re\n" +
        "\n" +
        "EXACT = re.compile(r\"\\b[A-Z]-\\d{4,6}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|₹[\\d,]+\")\n" +
        "\n" +
        "def compact(state: dict, new_turns: list[str]) -> dict:\n" +
        "    prompt = (\"Update this JSON state with the new turns. Keep every constraint \"\n" +
        "              \"and the latest value of anything that changed. Return JSON only.\\n\"\n" +
        "              + json.dumps(state) + \"\\n\\nNew turns:\\n\" + \"\\n\".join(new_turns))\n" +
        "    new_state = json.loads(llm(prompt))\n" +
        "    for t in new_turns:\n" +
        "        for m in EXACT.findall(t):\n" +
        "            # TODO: record m in new_state[\"facts\"] with the turn it came from\n" +
        "            ...\n" +
        "    return new_state\n",
      checks: [
        "After four or more compactions, all 10 planted items are present and changed values show the latest version.",
        "Ids and amounts in the facts store match the originals character for character.",
        "You report the token saving and can name at least one detail the summary lost.",
      ],
      sim: "token-budget",
    },
  },

  "6.4": {
    realLife: {
      title: "A home-loan officer with thirty open files",
      story:
        "A bank loan officer is handling thirty applications at once. She does not keep them all in her head: each has a folder with documents and notes, and her desk holds only a checklist of what is pending today. When a customer calls, she pulls that folder, updates the notes, and puts it back. If she is off sick, a colleague picks up the checklist and folders and carries on.",
      mapping: [
        { everyday: "Folders in the cabinet", concept: "Files, databases and memory stores outside the window" },
        { everyday: "Today's checklist on the desk", concept: "The small active state kept in context" },
        { everyday: "Updating the notes after each call", concept: "A note-taking agent writing progress as it goes" },
        { everyday: "A colleague carrying on", concept: "Persisted plans and progress that survive a restart" },
      ],
    },
    build: {
      title: "A note-taking agent that resumes from its own files",
      goal: "An agent that works through a 25-item task while keeping only a plan and a note index in context, and that resumes correctly after being killed.",
      minutes: 90,
      stack: ["Python", "an LLM API with tool calling", "plain files"],
      steps: [
        "Create a task: 25 customer review files in reviews/; the agent must tag each with themes and write a final report on the top 5 themes with counts.",
        "Give it tools: write_note(name, text), read_note(name), list_notes(), update_plan(markdown); notes live in work/notes/ and the plan in work/plan.md.",
        "Each turn, build the context from the system prompt, plan.md, the list of note names and only the last 3 messages; never the full history.",
        "Kill the process after about 12 reviews, restart, and let it continue from plan.md and the notes.",
        "Compare peak and average context tokens with a naive version that keeps the full history.",
      ],
      starter:
        "import pathlib\n" +
        "WORK = pathlib.Path(\"work\")\n" +
        "\n" +
        "def write_note(name: str, text: str) -> str:\n" +
        "    (WORK / \"notes\" / f\"{name}.md\").write_text(text)\n" +
        "    return f\"saved {name}\"\n" +
        "\n" +
        "def build_context(recent_messages):\n" +
        "    plan = (WORK / \"plan.md\").read_text() if (WORK / \"plan.md\").exists() else \"(no plan yet)\"\n" +
        "    notes = sorted(p.stem for p in (WORK / \"notes\").glob(\"*.md\"))\n" +
        "    # TODO: system prompt + <plan> + <notes_index> + last 3 messages\n" +
        "    ...\n",
      checks: [
        "After the restart, the agent does not re-tag reviews it already finished.",
        "Peak context for the managed version stays roughly flat while the naive version grows with every review.",
        "The final theme counts match a count you make from the notes.",
      ],
      sim: "token-budget",
    },
  },

  "6.5": {
    realLife: {
      title: "A new manager inheriting a three-year email thread",
      story:
        "You take over a project with four thousand emails behind it. Reading everything before Monday is impossible and you would forget most of it anyway. You search for the vendor contract when it comes up, ask for a one-page summary per quarter, and put the five decisions that still bind the team at the top of your handover notes. For one question, 'how did the budget change over the whole project?', you really do need to skim every quarter.",
      mapping: [
        { everyday: "Reading all four thousand emails", concept: "Stuffing the whole source into a huge window" },
        { everyday: "Searching for the contract when needed", concept: "Selective retrieval over long material" },
        { everyday: "A summary per quarter", concept: "Hierarchical summaries" },
        { everyday: "Key decisions at the top of the notes", concept: "Placing critical facts where the model attends" },
      ],
    },
    build: {
      title: "Stuff, retrieve or summarise: a measured comparison",
      goal: "Three strategies for one long document compared on three question types, with accuracy, tokens and cost for each.",
      minutes: 120,
      stack: ["Python", "an LLM API with a long context window", "sentence-transformers", "numpy"],
      steps: [
        "Pick a document of 80k-150k tokens (a public annual report, a long manual, a book) and split it into sections.",
        "Write 15 questions: 5 single-fact lookups, 5 that need two distant sections, and 5 whole-document questions ('how did X change across the report?').",
        "Strategy A: put the whole document in the prompt. Strategy B: retrieve the top 8 chunks. Strategy C: summarise each section, then answer from the summaries, fetching a full section when the model asks for it.",
        "Run all 45 combinations and record correctness, input tokens, cost and latency.",
        "Repeat strategy A with the question placed before the document instead of after, and note any difference.",
      ],
      checks: [
        "Your table has accuracy, tokens and cost for each strategy and question type.",
        "You can show which strategy wins for lookups and which for whole-document questions on your data.",
        "You have written the daily cost of each strategy at 5,000 questions per day using current prices.",
      ],
      sim: "token-budget",
    },
  },

  "6.6": {
    realLife: {
      title: "An electrician's bag for today's job",
      story:
        "An electrician has a van full of equipment but carries only what today's job needs into the flat: tester, screwdrivers, tape, a spare MCB. While testing, he jots readings in a notebook and tells the owner 'fault is on the kitchen circuit', not every number. The full readings stay in the notebook if anyone asks, and yesterday's readings from another flat are not in his pocket.",
      mapping: [
        { everyday: "Leaving most equipment in the van", concept: "Exposing only the tools relevant to this task or step" },
        { everyday: "'Fault on the kitchen circuit'", concept: "Summarising or filtering large tool results" },
        { everyday: "The notebook with every reading", concept: "Full results stored outside the window, fetchable by handle" },
        { everyday: "Not carrying yesterday's readings", concept: "Clearing stale tool observations from long loops" },
      ],
    },
    build: {
      title: "A tool router and result store",
      goal: "An agent wrapper that shows a handful of relevant tools per step, stores large results behind handles, and clears old observations, with tokens measured at step 30.",
      minutes: 90,
      stack: ["Python", "sentence-transformers", "tiktoken", "an LLM API with tool calling"],
      steps: [
        "Create 40 tool definitions across three fake services (orders, inventory, CRM); make most return large JSON.",
        "Embed each tool's name and description; per step, expose 4 always-on tools plus the 6 most similar to the current subtask.",
        "Wrap every tool: results over 800 tokens are saved in a dict under a handle and replaced with a short summary, the handle and the available fields; add fetch_result(handle, fields, page).",
        "After each step, replace tool results older than 5 steps with a one-line stub naming the handle.",
        "Run a 30-step task with and without these changes and log tokens per step and whether the right tool was picked.",
      ],
      starter:
        "import uuid, json\n" +
        "STORE: dict[str, object] = {}\n" +
        "\n" +
        "def wrap_result(tool_name, result, max_tokens=800):\n" +
        "    text = json.dumps(result)\n" +
        "    if count_tokens(text) <= max_tokens:\n" +
        "        return text\n" +
        "    handle = f\"{tool_name}-{uuid.uuid4().hex[:6]}\"\n" +
        "    STORE[handle] = result\n" +
        "    # TODO: return a short summary, the handle and the top-level fields\n" +
        "\n" +
        "def select_tools(subtask, k=6):\n" +
        "    # TODO: cosine between subtask and tool embeddings, plus ALWAYS_ON\n" +
        "    ...\n",
      checks: [
        "Context at step 30 is below 15k tokens in the managed run and several times larger in the naive one.",
        "The agent uses fetch_result at least once to get a detail it needed from a stored result.",
        "Correct tool picks are no lower than in the naive run.",
      ],
      sim: "token-budget",
    },
  },

  "6.7": {
    realLife: {
      title: "A wedding-card printing press",
      story:
        "A printer in Chandni Chowk prepares one printing plate for a wedding card's body text, which is slow and costly, then runs off hundreds of cards, printing each guest's name in a space at the bottom. If the family insisted the guest name appear in the very first line, every card would need a new plate. The press keeps the plate set up for a few hours; come back next week and it is remade.",
      mapping: [
        { everyday: "Preparing the plate once", concept: "Processing a long, stable prompt prefix once and caching it" },
        { everyday: "Guest name at the bottom", concept: "Putting changing content after the stable part" },
        { everyday: "Name in the first line means a new plate each time", concept: "A timestamp or user id at the start breaks every cache hit" },
        { everyday: "Plate kept only a few hours", concept: "Cache lifetime: hits need steady traffic" },
      ],
    },
    build: {
      title: "Measure prompt caching on your own prompt",
      goal: "A script that sends the same large prompt in two layouts and reports cache hit rate, latency and cost from the provider's usage fields.",
      minutes: 60,
      stack: ["Python", "the OpenAI or Anthropic SDK"],
      steps: [
        "Build a 5k+ token stable prefix: system instructions, tool definitions and a reference document.",
        "Layout A puts a timestamp and the user's name at the top; layout B puts them after the stable prefix. Enable caching as your provider requires (automatic for some, explicit cache markers for others; check the current docs).",
        "Send 20 different questions with each layout, one every few seconds, and read cached input tokens from the usage object.",
        "Record time to first token, cached and uncached input tokens, and compute cost with current prices.",
        "Trim the prefix (remove duplicated instructions and unused tools) and run layout B again.",
      ],
      starter:
        "import time\n" +
        "\n" +
        "def run(layout, questions):\n" +
        "    rows = []\n" +
        "    for q in questions:\n" +
        "        dynamic = f\"Now: {time.time()}. User: Asha.\"\n" +
        "        system = dynamic + STABLE if layout == \"A\" else STABLE + dynamic\n" +
        "        t0 = time.perf_counter()\n" +
        "        resp = call_model(system, q, stream=True)   # TODO: measure first token\n" +
        "        usage = resp.usage\n" +
        "        # TODO: read cached tokens (field name differs by provider)\n" +
        "        rows.append({\"layout\": layout, \"ttft\": ..., \"cached\": ..., \"input\": ...})\n" +
        "        time.sleep(3)\n" +
        "    return rows\n",
      checks: [
        "Layout A shows near-zero cached tokens; layout B shows most of the prefix cached after the first call.",
        "You report cost per 1,000 requests for both layouts.",
        "The trimmed prefix keeps answer quality on your 20 questions while cutting input tokens.",
      ],
    },
  },

  "6.8": {
    realLife: {
      title: "A building site with rotating daily crews",
      story:
        "On a housing site, different contract workers turn up each day. Nobody remembers yesterday, so the site register lists tasks, the progress board shows what's done, and the drawings are pinned on the wall. Each crew picks one task, does it, and the engineer inspects before it is marked complete; a slab is not 'done' until it passes the check. A specialist plumber comes for one job, leaves a one-line note in the register, and goes.",
      mapping: [
        { everyday: "A new crew each day", concept: "Each agent run starts with a fresh context window" },
        { everyday: "Register, progress board, drawings on the wall", concept: "tasks.json, a progress file and AGENTS.md as durable artifacts" },
        { everyday: "Inspection before 'done'", concept: "The harness runs tests and enforces checks, not the model" },
        { everyday: "The specialist plumber's one-line note", concept: "A sub-agent with a fresh context returning a condensed result" },
      ],
    },
    build: {
      title: "A one-task-per-run coding harness",
      goal: "A harness that, each run, reads the task list and progress file, lets an agent do one task in a small repo, runs the tests, and records the result only if they pass.",
      minutes: 120,
      stack: ["Python", "pytest", "git", "an LLM API with tool calling"],
      steps: [
        "Use the AGENTS.md and tasks.json from this lesson's Try it in a small Python repo with a passing test suite, and add an empty progress.md.",
        "Give the agent four tools: read_file, write_file (refuses paths outside the repo), run_tests and list_files; no shell.",
        "Each run: pick the first pending task, build the context from AGENTS.md, the task and the last 20 lines of progress.md, then loop with a 25-step limit.",
        "When the agent says it is done, the harness runs pytest itself; on pass, mark the task done, append a dated line to progress.md and git commit; on fail, record the failure and leave the task pending.",
        "Run it five times in a row and read the progress file and git log.",
      ],
      starter:
        "import json, subprocess, pathlib, datetime\n" +
        "REPO = pathlib.Path(\"repo\").resolve()\n" +
        "\n" +
        "def write_file(path, content):\n" +
        "    p = (REPO / path).resolve()\n" +
        "    if not p.is_relative_to(REPO):\n" +
        "        return \"error: path outside repo\"\n" +
        "    p.write_text(content); return \"ok\"\n" +
        "\n" +
        "def one_run():\n" +
        "    tasks = json.loads((REPO / \"tasks.json\").read_text())\n" +
        "    task = next((t for t in tasks if t[\"status\"] == \"pending\"), None)\n" +
        "    if task is None: return \"all done\"\n" +
        "    # TODO: run the agent loop with the four tools and a 25-step limit\n" +
        "    ok = subprocess.run([\"pytest\", \"-q\"], cwd=REPO).returncode == 0\n" +
        "    # TODO: if ok, mark done, append to progress.md, git commit; else log failure\n",
      checks: [
        "A task is never marked done when pytest fails, even if the agent claims success.",
        "Each run starts with no memory of the last one, yet does not redo finished tasks.",
        "The git log shows one commit per completed task with a matching line in progress.md.",
      ],
    },
  },

  "6.9": {
    realLife: {
      title: "Continuity on a month-long film shoot",
      story:
        "A film is shot over thirty days and out of order. Without care, an actor's wound switches hands between scenes, or a shirt changes colour mid-conversation. The script supervisor keeps continuity notes and photos, the call sheet each morning lists only what that day needs, and the director's intent for the film never changes. The producer compares the dailies and budget against plan and can show the difference the notes made.",
      mapping: [
        { everyday: "The wound switching hands", concept: "A long-running agent drifting, repeating or forgetting" },
        { everyday: "Continuity notes and photos", concept: "Offloaded task state, exact facts and a progress file" },
        { everyday: "A call sheet with only today's needs", concept: "A per-turn context budget and selection" },
        { everyday: "Comparing dailies and budget against plan", concept: "Measuring naive vs managed runs on quality, tokens and cost" },
      ],
    },
    build: {
      title: "Milestone 1: make it fail and measure it",
      goal: "Your Level 5 agent running a long task with naive context, fully instrumented, with a written list of where it drifts, repeats or forgets.",
      minutes: 120,
      stack: ["Python", "tiktoken", "an LLM API", "your Level 5 agent"],
      steps: [
        "Design a long task that needs 40+ tool calls and has a goal, three explicit constraints and at least one fact that changes partway through.",
        "Add the per-section token report from 6.1 to every model call and log each step as JSON: step, tool, args, section tokens, cost.",
        "Run the naive keep-everything agent on the task three times.",
        "Write a checker that tests the final output and the trace for each constraint, the latest value of the changed fact, and repeated tool calls.",
        "Summarise the failures in a table: run, step where it first went wrong, kind of failure (forgot, repeated, drifted, ran out of budget), tokens at that step.",
      ],
      checks: [
        "You have three complete JSONL traces with tokens per section on every step.",
        "The checker flags at least one real failure without you reading the trace by hand.",
        "Your failure table names the context section that was largest when each failure happened.",
      ],
      sim: "token-budget",
    },
  },
};
