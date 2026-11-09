import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "15.1": {
    realLife: {
      title: "The reference desk at a public library",
      story:
        "You ask the librarian a question. She doesn't answer from memory: she checks the catalogue, pulls two or three books from the shelves, reads the relevant pages and answers while pointing at the exact page. When the library has nothing on your topic she says so instead of guessing. New books are catalogued as they arrive, and staff are judged on how often they find the right book first time.",
      mapping: [
        { everyday: "Cataloguing new books as they arrive, and only the new ones", concept: "Ingestion service that extracts, chunks, embeds and re-indexes only changed files" },
        { everyday: "Checking the catalogue, then pulling the best few books", concept: "Hybrid retrieval followed by a reranker" },
        { everyday: "Answering while pointing at the page, or saying 'we have nothing on that'", concept: "Answers with citations, and declining when the evidence is thin" },
        { everyday: "How often the right book is found first time", concept: "Retrieval eval: hit rate and MRR on a labelled question set. Unlike a librarian, the system cannot ask you a follow-up unless you build that in" },
      ],
    },
    build: {
      title: "First milestone: an ingest-and-ask API with a 20-question eval",
      goal: "A FastAPI service that ingests a folder of PDFs, answers questions with citations, and prints hit rate and MRR on 20 labelled questions.",
      minutes: 120,
      stack: ["Python", "FastAPI", "pypdf", "an embedding API or sentence-transformers", "numpy or Chroma", "openai or anthropic SDK"],
      steps: [
        "Pick 10-20 public PDFs you know well (a product manual, a city's council policies) and put them in a docs/ folder.",
        "Write an ingest script that extracts text per page, chunks it at about 500 tokens with 50 overlap, embeds each chunk and stores it with source file and page number; skip files whose content hash hasn't changed.",
        "Add a POST /ask endpoint that retrieves the top 5 chunks, asks the model to answer only from them with [file:page] citations, and returns 'not found in the documents' when nothing relevant comes back.",
        "Write 20 questions by hand, each with the file and page that answers it, in eval.jsonl.",
        "Write eval.py that calls your retriever for each question and prints hit rate at 5 and MRR.",
        "Commit the repo with a README stub that already has an empty 'Results' table for these numbers.",
      ],
      starter: `# ingest.py
import hashlib, json
from pathlib import Path
from pypdf import PdfReader

def chunk(text: str, size: int = 2000, overlap: int = 200) -> list[str]:
    # TODO: split by characters (or tokens) with overlap
    ...

def ingest(folder: str, index_path: str = "index.json"):
    seen = {}  # TODO: load previous content hashes from disk
    for pdf in Path(folder).glob("*.pdf"):
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if seen.get(pdf.name) == digest:
            continue  # unchanged file, skip
        for page_no, page in enumerate(PdfReader(pdf).pages, start=1):
            for piece in chunk(page.extract_text() or ""):
                # TODO: embed piece, store {file, page, text, vector}
                ...
    # TODO: save index and hashes`,
      checks: [
        "Running ingest twice in a row embeds nothing the second time.",
        "Every answer from /ask contains at least one [file:page] citation that you can open and confirm.",
        "A question about something not in your documents gets the 'not found' reply, not an invented answer.",
        "eval.py prints a hit rate at 5 and an MRR, and you have written both into the README table.",
      ],
      stretch: "Add BM25 alongside the vector search, fuse with Reciprocal Rank Fusion and report whether hit rate moves.",
      sim: "chunking",
    },
  },

  "15.2": {
    realLife: {
      title: "The document check at a visa application centre",
      story:
        "At the visa centre the clerk has a printed checklist for your visa type. She goes down it line by line, ticking what your documents show and circling what is missing, and she must point to the actual page for each tick. She is not allowed to consider your religion or marital status, and if the form isn't complete she won't pass it on to the officer.",
      mapping: [
        { everyday: "The printed checklist for one visa type", concept: "Requirements extracted from the job description as structured data" },
        { everyday: "Ticks and circles, each pointing to a page in your file", concept: "A Pydantic schema of skills met and missing, each with an evidence quote from the resume" },
        { everyday: "Rules on what the clerk may not consider", concept: "Stripping or ignoring protected attributes" },
        { everyday: "An incomplete form isn't passed on", concept: "Rejecting model output that fails validation. The clerk can phone you to clarify; your agent should say 'unclear' instead of guessing" },
      ],
    },
    build: {
      title: "First milestone: schema-validated screening for one resume",
      goal: "A script that takes one resume PDF and one job description and returns a validated JSON assessment with quotes, or a clear validation error.",
      minutes: 90,
      stack: ["Python", "pydantic", "pypdf", "openai or anthropic SDK (structured output or tool calling)"],
      steps: [
        "Write the Pydantic models: Requirement, Match (requirement, met: bool, evidence_quote), and Assessment (matches, score 0-100, rubric_notes, interview_questions).",
        "Extract text from the resume PDF and ask the model to list the job description's requirements as a list of Requirement objects.",
        "Call the model with structured output (or a single tool whose input schema is Assessment) to fill the assessment.",
        "After validation, check every evidence_quote is a substring of the resume text (after whitespace normalisation); mark any match with a fake quote as failed.",
        "Run it on three resume and JD pairs you created, including one deliberately weak match, and save the outputs.",
      ],
      starter: `from pydantic import BaseModel, Field

class Match(BaseModel):
    requirement: str
    met: bool
    evidence_quote: str | None = None

class Assessment(BaseModel):
    matches: list[Match]
    score: int = Field(ge=0, le=100)
    interview_questions: list[str]

def grounded(a: Assessment, resume_text: str) -> list[str]:
    """Return requirements whose quote is not really in the resume."""
    # TODO: normalise whitespace, check each evidence_quote is a substring
    ...

def screen(resume_text: str, jd_text: str) -> Assessment:
    # TODO: call the model with Assessment as the output schema
    # TODO: validate, then run grounded() and reject or repair failures
    ...`,
      checks: [
        "Every output parses as an Assessment, or the script prints a validation error instead of crashing.",
        "Every evidence_quote in a passing output can be found word for word in the resume.",
        "The deliberately weak resume scores clearly lower than the strong one.",
      ],
      stretch: "Label 20 pairs yourself and report how often the model's met/not-met agrees with your labels.",
    },
  },

  "15.3": {
    realLife: {
      title: "A newspaper's weekend feature desk",
      story:
        "The features editor splits a big story into angles and sends three reporters out at once. Each comes back with notes and the source for every quote. A writer turns the notes into a draft, and a fact-checker sends it back if a claim has no source. Before anyone starts, the editor-in-chief signs off the plan, and the desk has a fixed budget for travel and calls.",
      mapping: [
        { everyday: "Editor splitting the story into angles", concept: "Planner node that writes sub-questions into shared state" },
        { everyday: "Reporters working at the same time", concept: "Parallel researcher nodes with search and fetch tools" },
        { everyday: "Fact-checker sending the draft back", concept: "Reviewer node with a conditional edge back to research" },
        { everyday: "Editor-in-chief signing off and the travel budget", concept: "Human approval checkpoint and a hard cap on steps and spend. Real reporters notice when a story is a dead end; your graph only stops where you tell it to" },
      ],
    },
    build: {
      title: "First milestone: planner, researchers and writer in a LangGraph graph",
      goal: "A LangGraph graph with typed state that turns a topic into a short report where every claim links to a fetched URL, with a step cap.",
      minutes: 120,
      stack: ["Python", "langgraph", "a web search API (Tavily, Brave or similar)", "httpx", "openai or anthropic SDK"],
      steps: [
        "Draw the graph on paper first: planner, a researcher node fanned out per sub-question, writer, and the state each node reads and writes.",
        "Define the state as a TypedDict with topic, sub_questions, notes (each note has claim and url), draft and steps.",
        "Implement the planner to produce 3 sub-questions and use LangGraph's fan-out (Send) to run one researcher per sub-question.",
        "Implement the writer to produce a report that cites only URLs present in notes.",
        "Add a guard that ends the run once steps exceeds 15, and log tokens used per node.",
      ],
      starter: `from typing import TypedDict, Annotated
import operator
from langgraph.graph import StateGraph, START, END

class Note(TypedDict):
    claim: str
    url: str

class State(TypedDict):
    topic: str
    sub_questions: list[str]
    notes: Annotated[list[Note], operator.add]  # researchers append in parallel
    draft: str
    steps: int

def planner(state: State) -> dict: ...      # TODO: 3 sub-questions
def researcher(state: dict) -> dict: ...    # TODO: search, fetch, return notes
def writer(state: State) -> dict: ...       # TODO: cite only urls in notes

g = StateGraph(State)
# TODO: add nodes, fan out with Send, connect writer to END
# check the current LangGraph docs for the exact Send import path`,
      checks: [
        "A run on a topic you know produces a report where every citation URL appears in the notes list.",
        "The trace or logs show the researcher nodes running for each sub-question.",
        "Setting the step cap to 3 stops the run cleanly with a partial result instead of an error.",
      ],
      stretch: "Add the reviewer node with a conditional edge back to research and count how often it triggers on 5 topics.",
      studio: "research-team",
    },
  },

  "15.4": {
    realLife: {
      title: "Handing a valet the valet key",
      story:
        "At a hotel you give the valet a special key. Any valet at any hotel knows how to use it, but it only starts the car and opens the driver's door: the glovebox and boot stay locked. The car's app logs every trip, and if the valet wants to take it somewhere other than the car park, they have to call you first.",
      mapping: [
        { everyday: "A key any valet knows how to use", concept: "MCP: one standard protocol any compatible client can connect to" },
        { everyday: "Starts the car but can't open the boot", concept: "Scoped tokens that expose only safe read and write operations" },
        { everyday: "Calling you before going anywhere unusual", concept: "Confirmation required for write actions" },
        { everyday: "The trip log in the car's app", concept: "Logging every tool call. The valet is one trusted person; an MCP client can be steered by text inside tool output, which a car key never is" },
      ],
    },
    build: {
      title: "First milestone: a read-only MCP server for your task manager",
      goal: "A local stdio MCP server that exposes two read-only tools over a real task or calendar API and works from one desktop or IDE assistant.",
      minutes: 90,
      stack: ["Python", "the official MCP Python SDK (mcp)", "httpx", "a task manager or calendar API with a personal token"],
      steps: [
        "Pick a system you actually use (Todoist, Google Calendar, a GitHub project) and create a read-only or narrowly scoped token.",
        "Write down the five operations a model should eventually get, marking which are reads and which are writes; build only the reads today.",
        "Implement two tools such as list_tasks(project, due_before) and get_task(task_id), with docstrings that say when to use each.",
        "Log every call (tool name, arguments, duration, result size) to a local file.",
        "Register the server in a desktop or IDE assistant's MCP config and run five realistic requests against it.",
      ],
      starter: `import os, time, json, httpx
from mcp.server.fastmcp import FastMCP  # check the current SDK docs for the import path

mcp = FastMCP("tasks")
TOKEN = os.environ["TASKS_TOKEN"]

def log_call(name: str, args: dict, started: float, size: int):
    # TODO: append a JSON line to calls.log
    ...

@mcp.tool()
def list_tasks(project: str, due_before: str | None = None) -> list[dict]:
    """List open tasks in a project, optionally due before an ISO date."""
    # TODO: call the real API, trim each task to id, title, due, status
    ...

@mcp.tool()
def get_task(task_id: str) -> dict:
    """Get one task's full details by id."""
    ...

if __name__ == "__main__":
    mcp.run()`,
      checks: [
        "The assistant lists your two tools and calls the right one for 'what's due this week in project X?'.",
        "calls.log has one line per tool call with arguments and duration.",
        "The token you used cannot create or delete anything (try it with curl and confirm it fails).",
      ],
      stretch: "Add one write tool (create_task) that returns a preview and only acts after an explicit confirm=true argument.",
      studio: "guarded-agent",
    },
  },

  "15.5": {
    realLife: {
      title: "The dispatch room behind a food delivery app",
      story:
        "When you order dinner, dispatch decides which restaurant branch and which rider get the order based on distance and cost. If a rider doesn't accept within a minute, the order goes to the next one. The company caps daily spend on surge bonuses, and a live map shows every order's time and cost, with an alarm when average delivery time creeps up.",
      mapping: [
        { everyday: "Choosing the branch and rider by distance and cost", concept: "A gateway routing requests across model providers by difficulty or price" },
        { everyday: "Reassigning when a rider doesn't accept in time", concept: "Timeouts, retries with backoff and a fallback model" },
        { everyday: "A daily cap on surge bonuses", concept: "Per-user and daily spending caps" },
        { everyday: "The live map and the delivery-time alarm", concept: "Tracing with tokens, latency and cost per request, plus dashboards and alerts" },
      ],
    },
    build: {
      title: "First milestone: a gateway with fallback and per-request cost logging",
      goal: "A FastAPI endpoint that calls a primary model, falls back to a second provider on timeout or error, and logs model, tokens, latency and cost for every request.",
      minutes: 100,
      stack: ["Python", "FastAPI", "two provider SDKs or LiteLLM", "SQLite", "locust or hey for a quick load test"],
      steps: [
        "Write a price table (input and output price per million tokens) for the two models you will use, as config, not hard-coded in logic.",
        "Implement POST /chat that calls the primary model with a 10-second timeout and up to 2 retries with exponential backoff and jitter.",
        "On final failure, call the fallback model and mark the response with fallback=true.",
        "Write one row per request to SQLite: request id, user id, model, input and output tokens, latency ms, cost, fallback flag.",
        "Simulate an outage by pointing the primary at a bad API key or URL, and send 20 requests.",
        "Run a 2-minute load test at 5 concurrent users and compute p50 and p95 latency from your SQLite table.",
      ],
      checks: [
        "During the simulated outage all 20 requests succeed and every row has fallback=true.",
        "The total cost you compute from SQLite is within a few percent of what the provider dashboard shows for the same period.",
        "You can print p50, p95 and error rate with one SQL query.",
      ],
      stretch: "Add a per-user daily cap that returns HTTP 429 with a clear message once a user's spend passes a threshold.",
      studio: "router-cascade",
    },
  },

  "15.6": {
    realLife: {
      title: "The drive-through order window",
      story:
        "At a drive-through, the person on the headset has to respond within a second or drivers start repeating themselves. Customers change their minds mid-sentence, a truck roars past, and the worker reads the order back before charging the card. Inside, another worker reads handwritten slips from the call-in line and types them into the till, and a manager checks a sample of those slips each shift.",
      mapping: [
        { everyday: "Replying within a second or the driver repeats", concept: "Time to first audio and turn latency in a voice agent" },
        { everyday: "Customers changing their minds mid-sentence", concept: "Barge-in and interruption handling" },
        { everyday: "Reading the order back before charging", concept: "Confirming before a tool call with real consequences" },
        { everyday: "Typing handwritten slips into the till, checked by a manager", concept: "Vision track: image to schema-validated fields, measured by field-level accuracy on labelled samples" },
      ],
    },
    build: {
      title: "First milestone: one working loop with a number attached",
      goal: "Either a voice loop that reports time to first audio per turn, or a vision extractor that reports field accuracy on 10 labelled images.",
      minutes: 120,
      stack: ["Python", "a speech-to-text and text-to-speech API, or a realtime speech model", "a vision-capable model API", "pydantic", "Pillow"],
      steps: [
        "Choose the track and write one sentence describing the user and the task (for example 'clinic receptionist that books appointments' or 'reads restaurant receipts into line items').",
        "Voice: wire microphone audio to speech-to-text, the model and text-to-speech with streaming at each stage. Vision: write a Pydantic schema and call a vision model with the image and schema.",
        "Voice: timestamp end of user speech and first audio byte out for every turn. Vision: hand-label 10 images with the correct field values.",
        "Voice: run 10 turns and print median and worst time to first audio. Vision: run all 10 images and print accuracy per field.",
        "Write the numbers and the three worst cases in a RESULTS.md you will grow into the README.",
      ],
      checks: [
        "You have a table of 10 measured turns or 10 scored images, not an impression.",
        "Voice: interrupting the agent mid-sentence stops its audio within about half a second. Vision: invalid model output is caught by the schema rather than saved.",
        "You can name the slowest stage (voice) or the least accurate field (vision) and one idea to improve it.",
      ],
      stretch: "Add one hard case on purpose (background noise, or a rotated and blurry photo) and measure the drop.",
    },
  },

  "15.7": {
    realLife: {
      title: "An architect's show homes",
      story:
        "A developer doesn't walk buyers through every house they ever built. They keep three show homes open, furnished for the kind of buyer they want, with a one-page sheet at the door: floor plan, size, price, energy rating. A buyer decides in five minutes whether to look closer, and the agent can explain why the kitchen faces north.",
      mapping: [
        { everyday: "Three show homes, not every house ever built", concept: "Choosing three to five projects that match the target role" },
        { everyday: "The sheet at the door: plan, size, price, rating", concept: "A README that leads with problem, live link, architecture diagram and results table" },
        { everyday: "Rooms that are ready to walk into", concept: "A fast live demo and a short recorded walkthrough" },
        { everyday: "The agent explaining why the kitchen faces north", concept: "Writing up decisions, trade-offs and failures. Unlike a show home, a project write-up should also show what went wrong" },
      ],
    },
    build: {
      title: "Rewrite one project page for a five-minute reviewer",
      goal: "One portfolio project with a rewritten README, a two-minute video and a one-line CV entry, tested on someone who has never seen it.",
      minutes: 90,
      stack: ["GitHub", "a diagram tool (Excalidraw or Mermaid)", "a screen recorder"],
      steps: [
        "List all your builds and pick the 3-5 that fit one target job description; archive or unpin the rest.",
        "For the strongest one, rewrite the top of the README: one-sentence problem, live link, architecture diagram, results table (quality, latency, cost per request), then setup.",
        "Add a 'Decisions and what didn't work' section with at least two trade-offs and one failure.",
        "Record a walkthrough of at most two minutes that shows the live system on a real input, and link it at the top.",
        "Write the CV line: what it is, the stack in a few words and one number.",
        "Give the repo link to a friend or a model playing a recruiter with a 5-minute timer, and ask them to explain back what it does and how well it works.",
      ],
      checks: [
        "The first screen of the README, without scrolling, shows the problem, a link and at least one number.",
        "The live demo loads in under 5 seconds on a phone.",
        "Your tester's explanation matches yours on what it does, how well, and one trade-off.",
      ],
      stretch: "Repeat for the other two projects and write a short post linking all three.",
    },
  },
};
