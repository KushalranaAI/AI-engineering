import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "5.1": {
    realLife: {
      title: "A dabbawala route versus a helper sent to fix the fridge",
      story:
        "A Mumbai dabbawala follows the same pickup, train and drop route every day, and that fixed route is why it almost never fails. Now picture telling a household helper 'get the fridge repaired'. They check the warranty card, call the service centre, get no answer, try a local mechanic, compare quotes and stop once it works or the budget is spent. No one could have written that path down in advance.",
      mapping: [
        { everyday: "The dabbawala's fixed route", concept: "A workflow: your code decides every next step" },
        { everyday: "The helper choosing who to call next", concept: "An agent: the model decides the next action from what it just learned" },
        { everyday: "Phone, warranty card, cash for the repair", concept: "Tools, state and instructions" },
        { everyday: "'Stop when it works or at ₹3,000'", concept: "Stop conditions and budgets" },
      ],
    },
    build: {
      title: "The same support task as a workflow and as an agent",
      goal: "Two implementations of one support task, a fixed workflow and a minimal agent loop, compared on success, steps and tokens.",
      minutes: 75,
      stack: ["Python", "an LLM API with tool calling"],
      steps: [
        "Create three fake tools backed by dicts: get_order(order_id), get_policy(topic), draft_reply(text).",
        "Write workflow(email): extract the order id, call get_order, call get_policy('refunds'), then draft a reply: always the same three steps.",
        "Write agent(email): a loop that sends the model the tool schemas, runs whatever tool it picks, appends the result, and stops on a final answer or after 8 steps.",
        "Run both on 10 emails: 7 ordinary refund requests and 3 odd ones (no order id, a question about shipping, two orders in one email).",
        "Tabulate success, number of model calls and total tokens per email for each version.",
      ],
      starter:
        "def agent(email, max_steps=8):\n" +
        "    messages = [{\"role\": \"user\", \"content\": email}]\n" +
        "    for step in range(max_steps):\n" +
        "        reply = call_model(messages, tools=TOOL_SCHEMAS)\n" +
        "        if not reply.tool_calls:\n" +
        "            return reply.text, step + 1\n" +
        "        for call in reply.tool_calls:\n" +
        "            result = TOOLS[call.name](**call.args)\n" +
        "            # TODO: append the assistant turn and a tool-result message\n" +
        "    return \"Stopped: step limit\", max_steps\n",
      checks: [
        "On the 7 ordinary emails, the workflow is at least as accurate and uses fewer tokens.",
        "On at least one of the 3 odd emails, the agent handles a case the workflow gets wrong.",
        "You can write a one-sentence rule for when you would ship each version.",
      ],
      studio: "react-agent",
    },
  },

  "5.2": {
    realLife: {
      title: "A traveller who missed a connecting flight",
      story:
        "Your flight lands late and the connection to Kochi has gone. You check the departures board, queue at the airline counter, learn the next flight is full, ask about a nearby airport, and change plan to an overnight train. A careful traveller sketches options before acting; another takes it one step at a time. Either way, after two failed trips to the same counter you stop going back there, and before leaving you check the new ticket actually says the right date.",
      mapping: [
        { everyday: "Check board, go to counter, hear 'full'", concept: "ReAct: decide, act, read the observation, decide again" },
        { everyday: "Sketching options first vs step by step", concept: "Plan-first vs one-step-at-a-time agents" },
        { everyday: "Switching to the train", concept: "Revising the plan when new facts arrive" },
        { everyday: "Not returning to the same counter; checking the ticket", concept: "Loop guards and reflection before finishing" },
      ],
    },
    build: {
      title: "Reflection and loop guards, priced",
      goal: "Your ReAct loop extended with a repeated-action guard and a reflection step, with the extra quality and cost of each measured.",
      minutes: 90,
      stack: ["Python", "an LLM API with tool calling"],
      steps: [
        "Start from the loop and tools you built in this lesson's Try it (search_docs, calculator, planner).",
        "Add a guard: hash (tool name, sorted arguments); if the same call repeats twice, inject a message telling the model it already has that result and must try something else.",
        "Add reflect(question, draft): a separate call that checks the draft answers every part of the question and returns OK or a specific problem; on a problem, continue the loop once more.",
        "Write 8 multi-step tasks, two of which contain a planted trap (a missing doc, an ambiguous unit).",
        "Run four variants (plain ReAct, plan-first, ReAct + reflect, plan-first + reflect) and record correctness, steps, tokens and seconds for each.",
      ],
      starter:
        "import json\n" +
        "\n" +
        "def call_key(name, args):\n" +
        "    return name + json.dumps(args, sort_keys=True)\n" +
        "\n" +
        "def run(task, plan_first=False, reflect=False, max_steps=10):\n" +
        "    seen, messages, tokens = {}, [{\"role\": \"user\", \"content\": task}], 0\n" +
        "    if plan_first:\n" +
        "        pass  # TODO: ask for a numbered plan and add it to messages\n" +
        "    for step in range(max_steps):\n" +
        "        # TODO: call model, run tool calls, count repeats in `seen`\n" +
        "        # TODO: when the model answers, optionally reflect() once\n" +
        "        ...\n",
      checks: [
        "A planted repeat (a tool that always returns 'try again') triggers the guard instead of burning all steps.",
        "Reflection catches at least one incomplete answer on the trap tasks.",
        "Your table shows the token and latency cost of plan-first and reflection, and you can say which you would keep.",
      ],
      studio: "react-agent",
    },
  },

  "5.3": {
    realLife: {
      title: "A new live-in cook in a busy household",
      story:
        "A family hires a cook. The spice jars are labelled clearly, so they never grab chilli for haldi. When something runs out they say 'no jeera left, shall I use ajwain?' instead of just 'can't cook'. They can buy vegetables up to ₹500 on their own, but ordering a new mixer needs the family's okay. And they report 'dinner ready, dal and two sabzis', not every step of the cooking.",
      mapping: [
        { everyday: "Clearly labelled jars", concept: "Precise tool names, descriptions and typed arguments" },
        { everyday: "'No jeera, shall I use ajwain?'", concept: "Errors the model can act on" },
        { everyday: "Vegetables freely, mixer needs approval", concept: "Read-only tools vs gated side-effect tools" },
        { everyday: "'Dal and two sabzis', not every step", concept: "Keeping tool results short" },
      ],
    },
    build: {
      title: "A tool layer for an inventory agent",
      goal: "Four well-designed tools for a small shop inventory with schemas, paging, actionable errors and an approval gate, plus a measured tool-choice accuracy.",
      minutes: 90,
      stack: ["Python", "pydantic", "an LLM API with tool calling", "sqlite3"],
      steps: [
        "Seed SQLite with 300 products (sku, name, category, price, stock).",
        "Write get_product(sku), search_products(query, category=None, page=1) returning at most 10 compact rows plus a total count, restock(sku, qty) and set_price(sku, price).",
        "Make errors useful: an unknown SKU returns the three closest SKUs; a negative price returns the valid range.",
        "Gate set_price and restock: the tool returns 'PENDING_APPROVAL' and your loop asks for y/n on the console before executing.",
        "Write 15 user requests with the expected tool and arguments; measure the rate of correct first tool calls with vague descriptions, then with your improved ones.",
      ],
      starter:
        "from pydantic import BaseModel, Field\n" +
        "\n" +
        "class SearchArgs(BaseModel):\n" +
        "    query: str = Field(description=\"Words from the product name, e.g. 'basmati rice 5kg'\")\n" +
        "    category: str | None = Field(None, description=\"One of: grocery, dairy, cleaning\")\n" +
        "    page: int = Field(1, ge=1)\n" +
        "\n" +
        "def search_products(query, category=None, page=1):\n" +
        "    # TODO: LIKE query, 10 rows per page, return {rows, total, page}\n" +
        "    ...\n" +
        "\n" +
        "SIDE_EFFECTS = {\"set_price\", \"restock\"}\n" +
        "\n" +
        "def run_tool(name, args):\n" +
        "    if name in SIDE_EFFECTS and input(f\"Allow {name}{args}? [y/n] \") != \"y\":\n" +
        "        return {\"error\": \"Denied by user. Ask what they want instead.\"}\n" +
        "    # TODO: dispatch, catching exceptions into actionable error dicts\n",
      checks: [
        "No tool result ever exceeds 10 product rows, and the model can fetch page 2 when asked.",
        "Asking for a misspelled SKU leads the agent to recover using the suggestions, without your help.",
        "No price or stock change happens without a 'y' on the console.",
        "Correct first tool calls rise after you rewrite the descriptions, and you have both numbers.",
      ],
      studio: "guarded-agent",
    },
  },

  "5.4": {
    realLife: {
      title: "UPI and the shop QR code",
      story:
        "A tea stall puts up one UPI QR code and gets paid from GPay, PhonePe, Paytm or any bank app; it never builds an integration with each app. When you scan it, your app shows the merchant's name before anything happens, and nothing moves until you enter your PIN. If the name looks wrong, you don't pay.",
      mapping: [
        { everyday: "The payment app on your phone", concept: "The MCP host (the AI app the user runs)" },
        { everyday: "The connection your app opens to that merchant", concept: "An MCP client, one per server" },
        { everyday: "The stall's QR and its bank", concept: "An MCP server exposing tools and resources" },
        { everyday: "Checking the name, entering the PIN", concept: "Trust and permission before running a tool; unlike UPI, a server can do far more than take payments" },
      ],
    },
    build: {
      title: "An MCP server for a library database, plus your own client",
      goal: "A stdio MCP server exposing a SQLite library catalogue as tools and a resource, used by your own Python client and by an off-the-shelf MCP host.",
      minutes: 120,
      stack: ["Python", "mcp (official Python SDK)", "sqlite3", "an LLM API with tool calling"],
      steps: [
        "Create library.db with books (id, title, author, year, available) and loans (book_id, member, due_date), and seed 200 rows.",
        "Write server.py with FastMCP: tools search_books(query, limit) and books_due(before_date), and a resource library://stats returning counts as text.",
        "Validate input: limit between 1 and 20, dates in YYYY-MM-DD; return clear error text otherwise.",
        "Test it with the MCP Inspector (npx @modelcontextprotocol/inspector python server.py).",
        "Write client.py that starts the server over stdio, lists its tools, converts them to your LLM's tool format, and routes the model's tool calls back through session.call_tool.",
      ],
      starter:
        "from mcp.server.fastmcp import FastMCP\n" +
        "import sqlite3\n" +
        "\n" +
        "mcp = FastMCP(\"library\")\n" +
        "db = sqlite3.connect(\"library.db\", check_same_thread=False)\n" +
        "\n" +
        "@mcp.tool()\n" +
        "def search_books(query: str, limit: int = 5) -> list[dict]:\n" +
        "    \"\"\"Find books whose title or author contains the query.\"\"\"\n" +
        "    # TODO: validate limit, run a LIKE query, return compact dicts\n" +
        "    ...\n" +
        "\n" +
        "@mcp.resource(\"library://stats\")\n" +
        "def stats() -> str:\n" +
        "    # TODO: total books, on loan, overdue\n" +
        "    ...\n" +
        "\n" +
        "if __name__ == \"__main__\":\n" +
        "    mcp.run()\n",
      checks: [
        "The Inspector lists both tools with their argument schemas and reads the stats resource.",
        "Your client answers 'Which Premchand books are available?' by calling search_books through MCP.",
        "Calling search_books with limit=500 returns a readable error, not a crash or 500 rows.",
        "The same server works unchanged when added to an MCP-capable desktop host.",
      ],
      stretch: "Add a renew_loan tool and make your client ask for confirmation before calling any tool not on a read-only allowlist.",
    },
  },

  "5.5": {
    realLife: {
      title: "A neighbourhood tailor's measurement book",
      story:
        "Your tailor keeps a card with your measurements and preferences ('likes a loose collar'), not a record of every chat you've had. During a fitting he remembers what you said ten minutes ago about the sleeves. When you mention you've lost weight he updates the card instead of adding a second one, and if you ask him to stop keeping your phone number, he crosses it out.",
      mapping: [
        { everyday: "Remembering the sleeve comment during the fitting", concept: "Short-term memory for the current session" },
        { everyday: "The measurement card", concept: "Long-term memory of facts and preferences across sessions" },
        { everyday: "Updating the waist size, not adding a new card", concept: "Update on contradiction instead of appending" },
        { everyday: "Crossing out the phone number", concept: "Forget: user-requested deletion" },
      ],
    },
    build: {
      title: "A memory layer for a fitness coach bot",
      goal: "A chat assistant with SQLite-backed long-term memory that writes, recalls, updates and forgets facts, and a trimmed short-term history.",
      minutes: 90,
      stack: ["Python", "sqlite3", "sentence-transformers", "an LLM API"],
      steps: [
        "Create a memories table: id, user_id, text, kind (fact, preference, goal), embedding, updated_at.",
        "After each session, ask the model to extract up to 5 durable facts as JSON; for each, find the most similar existing memory and ask the model whether it is the same, an update, or new; then insert or replace.",
        "Before each reply, recall the top 3 memories by similarity to the user's message, weighted slightly by recency, and put them in a labelled section of the prompt.",
        "Support 'forget X': find matching memories, show them, delete on confirmation.",
        "Keep only the last 8 turns verbatim plus a running summary of older turns.",
      ],
      checks: [
        "Session 1 'I live in Bengaluru and run 5k three times a week', session 2 'I moved to Pune': only Pune remains stored.",
        "A question about running plans in session 3 recalls the running habit without being told again.",
        "'Forget where I live' removes the location memory, and a later question shows the bot no longer knows it.",
        "The prompt size stays flat (within a few hundred tokens) over a 40-turn conversation.",
      ],
    },
  },

  "5.6": {
    realLife: {
      title: "A wedding planner and the vendors",
      story:
        "A wedding planner splits the work: the caterer gets the guest count and dietary needs, the decorator gets the colour theme and venue size, the photographer gets the schedule. None of them needs the others' details. When the decorator cancels a week out, the planner finds a replacement rather than calling off the wedding. For a small birthday dinner, nobody hires a planner.",
      mapping: [
        { everyday: "The planner", concept: "An orchestrator that breaks down work and merges results" },
        { everyday: "Caterer, decorator, photographer", concept: "Specialist workers with their own tools and instructions" },
        { everyday: "Each vendor gets only their brief", concept: "Passing minimal context to each worker" },
        { everyday: "Replacing the decorator; no planner for a birthday", concept: "Handling worker failure; one agent is often enough" },
      ],
    },
    build: {
      title: "An orchestrator with parallel workers versus one agent",
      goal: "A laptop-buying advisor built as orchestrator plus three workers running in parallel, compared with a single agent holding all three tools.",
      minutes: 120,
      stack: ["Python", "asyncio", "an LLM API (async client)"],
      steps: [
        "Create local data: specs.json for 15 laptops, reviews/ with a text file per model, prices.csv with prices from three shops.",
        "Write three worker agents, each with one tool and a short brief: specs (filter by requirements), reviews (summarise pros and cons), prices (find the best offer).",
        "Write the orchestrator: turn the user's request into a brief per worker, run them with asyncio.gather, then merge into a top-3 recommendation that notes any conflicts.",
        "Make the reviews worker fail on 1 in 3 calls; retry once, then continue with a note that reviews are missing.",
        "Build a single agent with all three tools and run both designs on the same 6 requests, recording quality (your judgement, 1-5), latency and total tokens.",
      ],
      starter:
        "import asyncio\n" +
        "\n" +
        "async def run_worker(name, brief, tool):\n" +
        "    # TODO: a small agent loop with only `tool`, returning a short text result\n" +
        "    ...\n" +
        "\n" +
        "async def orchestrate(request):\n" +
        "    briefs = await plan_briefs(request)   # {\"specs\": ..., \"reviews\": ..., \"prices\": ...}\n" +
        "    tasks = [run_worker(n, b, TOOLS[n]) for n, b in briefs.items()]\n" +
        "    results = await asyncio.gather(*tasks, return_exceptions=True)\n" +
        "    # TODO: retry failed workers once, then merge with a final model call\n" +
        "    ...\n",
      checks: [
        "Workers run concurrently: total time is close to the slowest worker, not the sum.",
        "A forced reviews failure still yields a recommendation that says reviews were unavailable.",
        "Your comparison table shows tokens, latency and quality for both designs, with a recommendation for which to ship.",
      ],
      studio: "supervisor-workers",
    },
  },

  "5.7": {
    realLife: {
      title: "A passport office",
      story:
        "At a passport seva kendra your file moves from token desk to document check to biometrics to the officer. Each counter stamps the file. If a document is missing you are sent back to the document counter. If the office closes mid-way, you come back the next day and continue from the counter you reached. Nothing is issued until the officer signs.",
      mapping: [
        { everyday: "The file carried between counters", concept: "The typed state object passed between nodes" },
        { everyday: "Each counter", concept: "A node: a model call, a tool call or plain logic" },
        { everyday: "'Missing document, back to counter B'", concept: "Conditional edges and loops" },
        { everyday: "Stamps; resuming tomorrow; the officer's signature", concept: "Checkpoints, resuming by thread id, and an interrupt for human approval" },
      ],
    },
    build: {
      title: "An expense-approval graph that survives a restart",
      goal: "A LangGraph agent that checks an expense claim against policy, pauses for human approval above a limit, and resumes from a SQLite checkpoint after the process is killed.",
      minutes: 120,
      stack: ["Python", "langgraph", "langgraph-checkpoint-sqlite", "an LLM API"],
      steps: [
        "Define a TypedDict state: claim, policy_notes, decision, reason, approved_by.",
        "Add nodes: extract (model reads a free-text claim into amount, category, date), check_policy (plain Python rules), decide (model writes a decision and reason).",
        "Add a conditional edge: amounts over ₹10,000 go to a human_review node that calls interrupt(), others go straight to record.",
        "Compile with a SQLite checkpointer, start a run with thread_id 'claim-42', and stop the script while it waits for approval.",
        "Restart the script, resume the same thread with Command(resume=...), and print get_state_history to see every step taken.",
      ],
      starter:
        "from typing import TypedDict\n" +
        "from langgraph.graph import StateGraph, START, END\n" +
        "from langgraph.types import interrupt, Command\n" +
        "from langgraph.checkpoint.sqlite import SqliteSaver\n" +
        "\n" +
        "class Claim(TypedDict, total=False):\n" +
        "    text: str; amount: float; category: str; decision: str; reason: str; approved_by: str\n" +
        "\n" +
        "def human_review(state: Claim):\n" +
        "    answer = interrupt({\"amount\": state[\"amount\"], \"reason\": state[\"reason\"]})\n" +
        "    return {\"approved_by\": answer}\n" +
        "\n" +
        "def route(state: Claim):\n" +
        "    return \"human_review\" if state[\"amount\"] > 10000 else \"record\"\n" +
        "\n" +
        "g = StateGraph(Claim)\n" +
        "# TODO: add extract, check_policy, decide, human_review, record; wire edges\n" +
        "# with SqliteSaver.from_conn_string(\"claims.db\") as cp: app = g.compile(checkpointer=cp)\n",
      checks: [
        "A ₹2,500 claim finishes without stopping; a ₹25,000 claim stops at human_review.",
        "After killing and restarting the script, the run resumes at human_review without re-running extract.",
        "get_state_history shows each node in order, so you can explain why a claim took its path.",
      ],
      stretch: "Add a retry loop: if decide gives no reason, route back to decide at most twice.",
      studio: "guarded-agent",
    },
  },

  "5.8": {
    realLife: {
      title: "A school chemistry practical",
      story:
        "In a school lab, students run experiments inside a fume hood, using only the chemicals issued for that practical, with the teacher watching the clock. Nothing leaves the hood except the observation sheet they hand in. If someone mixes the wrong things, the damage stays inside the hood and the next class gets a clean one.",
      mapping: [
        { everyday: "The fume hood", concept: "An isolated sandbox (container, microVM) outside your app process" },
        { everyday: "Only the chemicals issued", concept: "No network, no credentials, read-only files except a work folder" },
        { everyday: "The clock", concept: "Time, memory, CPU and process limits" },
        { everyday: "Only the observation sheet leaves; a clean hood next time", concept: "Return trimmed stdout, stderr and files; throw the sandbox away" },
      ],
    },
    build: {
      title: "A run_python tool in a locked-down container",
      goal: "A tool that runs model-written Python in a throwaway Docker container with no network and tight limits, survives a set of hostile scripts, and powers a CSV-analysis agent.",
      minutes: 90,
      stack: ["Python", "Docker", "subprocess", "an LLM API with tool calling"],
      steps: [
        "Write run_python(code, input_files) that copies files into a fresh temp dir and runs python:3.12-slim with --network none, --memory 256m, --cpus 0.5, --pids-limit 64, --read-only, a tmpfs for /tmp, and an outer 15 s timeout.",
        "Return {exit_code, stdout, stderr, files} with stdout and stderr cut to 2,000 characters each and only files written to /out.",
        "Run six hostile scripts through it: an infinite loop, a fork bomb, a 2 GB allocation, an HTTP request, reading os.environ for keys, writing outside /out.",
        "Give the tool to an agent and ask it to answer three questions about a sales CSV, letting it fix its own errors from stderr.",
      ],
      starter:
        "import subprocess, tempfile, pathlib, shutil\n" +
        "\n" +
        "def run_python(code: str, input_files: list[str] = []) -> dict:\n" +
        "    work = pathlib.Path(tempfile.mkdtemp())\n" +
        "    (work / \"out\").mkdir()\n" +
        "    (work / \"main.py\").write_text(code)\n" +
        "    for f in input_files:\n" +
        "        shutil.copy(f, work)\n" +
        "    cmd = [\"docker\", \"run\", \"--rm\", \"--network\", \"none\",\n" +
        "           # TODO: memory, cpus, pids-limit, read-only, tmpfs, mounts\n" +
        "           \"python:3.12-slim\", \"python\", \"/work/main.py\"]\n" +
        "    try:\n" +
        "        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15)\n" +
        "    except subprocess.TimeoutExpired:\n" +
        "        return {\"exit_code\": -1, \"stderr\": \"Timed out after 15 s\"}\n" +
        "    # TODO: trim output, collect files from work/out, delete work dir\n",
      checks: [
        "All six hostile scripts end with a clean error or timeout, and your laptop stays responsive.",
        "The HTTP request fails and os.environ shows none of your host's API keys.",
        "The agent answers the CSV questions, recovering from at least one error it caused itself.",
      ],
      stretch: "Swap Docker for a hosted sandbox (E2B or Modal) behind the same function signature.",
    },
  },

  "5.9": {
    realLife: {
      title: "A food delivery order in progress",
      story:
        "After you order biryani, the app shows 'restaurant preparing', then 'rider picked up', then a live map. If the rider cancels, a new rider is assigned without you reordering. If your payment page timed out and you tap pay again, you are charged once. You can cancel before pickup, and after 60 minutes a support person steps in. You never see the dispatch team's internal chatter.",
      mapping: [
        { everyday: "'Preparing', 'picked up', live map", concept: "Progress events showing the current step and tool" },
        { everyday: "Charged once after tapping pay twice", concept: "Idempotency keys on side-effect actions" },
        { everyday: "New rider assigned; support after 60 minutes", concept: "Saved state to resume, fallbacks and escalation within a budget" },
        { everyday: "Cancel button, no dispatch chatter", concept: "User control, clear status without dumping internal reasoning" },
      ],
    },
    build: {
      title: "A crash-safe agent run with budgets and an idempotent side effect",
      goal: "An agent runner that enforces step, time, token and money budgets, persists state after every step, resumes after a crash, and never sends the same email twice.",
      minutes: 120,
      stack: ["Python", "sqlite3", "an LLM API with tool calling"],
      steps: [
        "Write a Budget class with max steps, seconds, tokens and rupees; check it before every model call and stop with a clear status when any is exceeded.",
        "Save the run state (messages, step, spent budget, status) to SQLite after every step, and add resume(run_id) that loads it and continues.",
        "Write send_email(to, subject, body, idempotency_key) that inserts into an outbox table with a UNIQUE key; a repeat call returns the stored result instead of sending again.",
        "Inject a crash: raise an exception right after send_email succeeds but before state is saved, then resume.",
        "Print one progress line per step ('step 3: searching orders...') and stop cleanly if a cancel.flag file appears.",
      ],
      starter:
        "import sqlite3, json, hashlib\n" +
        "db = sqlite3.connect(\"runs.db\")\n" +
        "db.execute(\"CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, payload TEXT)\")\n" +
        "\n" +
        "def send_email(to, subject, body, run_id, step):\n" +
        "    key = hashlib.sha256(f\"{run_id}:{step}:{to}:{subject}\".encode()).hexdigest()\n" +
        "    row = db.execute(\"SELECT payload FROM outbox WHERE key=?\", (key,)).fetchone()\n" +
        "    if row:\n" +
        "        return {\"status\": \"already_sent\", \"key\": key}\n" +
        "    # TODO: insert into outbox and commit, then return sent\n" +
        "\n" +
        "class Budget:\n" +
        "    def __init__(self, steps=15, seconds=120, tokens=50_000, rupees=5.0): ...\n" +
        "    def check(self):\n" +
        "        # TODO: raise BudgetExceeded naming the limit that was hit\n" +
        "        ...\n",
      checks: [
        "After the injected crash and resume, the outbox table holds exactly one email.",
        "A task designed to loop stops on a budget with a status naming which limit was hit.",
        "Creating cancel.flag mid-run stops the agent within one step, and resume() can continue it afterwards.",
      ],
      studio: "guarded-agent",
    },
  },

  "5.10": {
    realLife: {
      title: "Three ways to make the same daily commute",
      story:
        "Getting from Andheri to BKC every morning can be done by your own scooter, the metro, or a ride-hailing app. The route is the same; what differs is control, predictability and how much is done for you. The metro runs on fixed tracks with set stations and a clear record of where you are; the cab is fastest to start but you see less; the scooter gives full control and all the work. Regular commuters pick by their needs that week, not by what's popular.",
      mapping: [
        { everyday: "The same route every day", concept: "The same agent and tasks built in each framework" },
        { everyday: "Metro: fixed tracks and stations", concept: "LangGraph: explicit graph, persistence, human-in-the-loop" },
        { everyday: "Ride-hailing: quick to start, less visibility", concept: "Lightweight SDKs that hide the loop" },
        { everyday: "Your own scooter", concept: "A plain Python loop: full control, all the plumbing yours" },
      ],
    },
    build: {
      title: "A framework scorecard with an MCP tool and a planted failure",
      goal: "A scorecard comparing a plain loop with two frameworks on the same tasks, each wired to the same MCP server, with step limits, approval and failure handling.",
      minutes: 120,
      stack: ["Python", "langgraph", "one of: OpenAI Agents SDK, Google ADK, CrewAI, Agno", "your MCP server from 5.4"],
      steps: [
        "Fix one reference agent: three tools (two from your 5.4 MCP server, one local), a step limit of 8, and approval before any write tool.",
        "Build it as a plain Python loop, in LangGraph, and in one other framework, connecting to the MCP server through each framework's MCP support where it exists.",
        "Write 6 tasks, including one where the MCP server is stopped mid-run and one that needs the write tool.",
        "Run all three versions and fill a table automatically: success, steps, tokens, seconds, lines of code, and whether a trace of each step was available.",
        "Add three rows by hand: how the step limit was set, how approval worked, and what the user saw when the MCP server died.",
      ],
      checks: [
        "All three versions call the same MCP server and pass at least 4 of 6 tasks.",
        "Every version stops at 8 steps and asks before the write tool.",
        "You end with a one-paragraph recommendation for a named kind of project, backed by the table.",
      ],
      studio: "react-agent",
    },
  },

  "5.11": {
    realLife: {
      title: "A travel agent fixing a family's Goa holiday",
      story:
        "A small travel agency takes on a family trip to Goa: flights, a hotel, airport pickup and a boat tour. The agent plans the bookings, uses airline and hotel portals, keeps a trip file of what is confirmed, recovers when the hotel cancels a week before, asks the family before paying any deposit, and sends WhatsApp updates at each step. If they spend three days chasing one booking, they stop and call the family.",
      mapping: [
        { everyday: "The trip plan and booking portals", concept: "Planning and at least three real tools" },
        { everyday: "The trip file", concept: "An explicit, typed state object" },
        { everyday: "Hotel cancels; three-day limit", concept: "Recovery, retries and budgets" },
        { everyday: "Asking before deposits; WhatsApp updates", concept: "A human checkpoint and visible progress" },
      ],
    },
    build: {
      title: "Milestone 1: a typed state, three tools and a guarded loop",
      goal: "A first working version of your chosen agent track with typed state, three real tools, budgets, logging and five test tasks.",
      minutes: 120,
      stack: ["Python", "pydantic", "an LLM API with tool calling", "your 5.4 MCP server or 5.8 sandbox, depending on track"],
      steps: [
        "Pick a track (research, MCP-backed service, or coding/data with a sandbox) and write its goal and its single riskiest action in the README.",
        "Define a pydantic RunState: goal, plan (list of steps with status), actions taken, results, budget spent, status.",
        "Implement three tools that touch something real (web search API, your MCP server, the sandbox, a real database) with schemas and actionable errors.",
        "Write the loop with step, time and token budgets and a repeated-call guard, logging one JSON line per step to runs/<run_id>.jsonl.",
        "Write 5 test tasks, run them, and note in the README which ones fail and why.",
      ],
      checks: [
        "RunState is saved to disk after every step and can be loaded back into the same model.",
        "Each run's JSONL log shows tool name, arguments, a trimmed result and tokens for every step.",
        "At least 3 of the 5 tasks succeed, and every failure has a written cause you plan to fix.",
      ],
      studio: "guarded-agent",
    },
  },
};
