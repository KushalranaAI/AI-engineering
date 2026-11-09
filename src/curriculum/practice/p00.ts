import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "0.1": {
    realLife: {
      title: "A pharmacist filling a morning's prescriptions",
      story:
        "At 9 a.m. a neighbourhood chemist has twenty prescriptions on the counter. She does not phone the wholesaler about one missing medicine, wait for the answer, then phone about the next; she places all the stock queries at once and fills what she can while replies come back. Every slip goes into a fixed tray layout (name, drug, dose, quantity) so a wrong dose is caught before it reaches the customer, and the shop's opening checklist is the same every day so a relief pharmacist can run it without her.",
      mapping: [
        { everyday: "Placing all wholesaler queries at once and working while replies arrive", concept: "asyncio.gather over many network calls instead of awaiting each in turn" },
        { everyday: "The fixed slip format that rejects a dose written as 'a lot'", concept: "A Pydantic model that validates data at the boundary" },
        { everyday: "The written opening checklist a relief pharmacist can follow", concept: "pyproject.toml plus a lock file so another machine installs the same thing" },
        { everyday: "Where it breaks: the wholesaler can only take so many calls at once; real APIs have the same limit, so you cap concurrency", concept: "Rate limits and semaphores" },
      ],
    },
    build: {
      title: "A typed, tested exchange-rate checker package",
      goal: "A uv-managed package that fetches rates for ten currency pairs concurrently, validates them with Pydantic, caches them to a JSON file, and passes pytest.",
      minutes: 90,
      stack: ["Python", "uv", "httpx", "pydantic", "pytest"],
      steps: [
        "Run `uv init fxcheck` and `uv add httpx pydantic` and `uv add --dev pytest`; create a package folder `fxcheck/` with `models.py`, `client.py` and `cli.py`.",
        "In `models.py` define a `Rate` Pydantic model (base, quote, value: float > 0, fetched_at: datetime) and reject non-positive values with a field constraint.",
        "In `client.py` write `async def fetch_rate(client, base, quote)` against a free rates API (for example frankfurter.app) and `async def fetch_all(pairs)` that runs them with `asyncio.gather` behind a `Semaphore(4)`; read the base URL from an environment variable with a default.",
        "Write results to `cache/rates.json` with `pathlib`, and on the next run reuse any entry younger than 10 minutes instead of calling the API.",
        "Write tests: one for model validation (a negative rate raises), one for cache freshness using a fake timestamp, and one that monkeypatches `fetch_rate` so tests never hit the network.",
        "Time sequential vs concurrent fetching with `time.perf_counter()` and print both numbers.",
      ],
      starter:
        "import asyncio, os\nfrom datetime import datetime\nimport httpx\nfrom pydantic import BaseModel, Field\n\nBASE_URL = os.getenv(\"FX_BASE_URL\", \"https://api.frankfurter.app\")\n\nclass Rate(BaseModel):\n    base: str\n    quote: str\n    value: float = Field(gt=0)\n    fetched_at: datetime\n\nasync def fetch_rate(client: httpx.AsyncClient, base: str, quote: str) -> Rate:\n    # TODO: GET /latest?from=base&to=quote, raise_for_status, build a Rate\n    ...\n\nasync def fetch_all(pairs: list[tuple[str, str]]) -> list[Rate]:\n    sem = asyncio.Semaphore(4)\n    async with httpx.AsyncClient(timeout=10) as client:\n        async def one(b: str, q: str) -> Rate:\n            async with sem:\n                return await fetch_rate(client, b, q)\n        # TODO: gather one() for every pair\n        ...\n\n# TODO: load/save cache/rates.json with pathlib and a 10-minute freshness rule",
      checks: [
        "`uv run pytest` passes with the network disabled (Wi-Fi off).",
        "The concurrent run of ten pairs is clearly faster than the sequential run (often 3x or more).",
        "A second run within 10 minutes makes zero HTTP calls (log or count them to prove it).",
        "Deleting `.venv` and running `uv sync` on a fresh clone reproduces a working install.",
      ],
      stretch: "Add `mypy --strict` to the project and fix every error it reports.",
    },
  },
  "0.2": {
    realLife: {
      title: "Ordering at a food-court token counter",
      story:
        "At a mall food court you walk to counter 7 (the address), say 'one masala dosa, no onion' (method plus body), and show your loyalty card (a header). You get a token slip back: 'Order placed, #214' means it worked; 'Sold out' or 'Card not valid here' are different kinds of no. Asking 'is #214 ready?' ten times changes nothing, but saying 'one more dosa' ten times gets you ten dosas.",
      mapping: [
        { everyday: "Counter number and menu item", concept: "URL and path of a resource" },
        { everyday: "Loyalty card shown with the order", concept: "Authorization header carrying a key or bearer token" },
        { everyday: "'Order placed', 'Sold out', 'Card not valid', 'Kitchen fire'", concept: "201, 409/404, 401/403 and 500 status families" },
        { everyday: "'Is it ready?' is safe to repeat; 'one more dosa' is not", concept: "GET is safe and idempotent; POST is not" },
      ],
    },
    build: {
      title: "A status-code explorer for a real public API",
      goal: "An httpx script that makes deliberate good and bad requests to a public API and prints a table of method, status, key headers and what each response means.",
      minutes: 45,
      stack: ["Python", "httpx", "curl"],
      steps: [
        "Pick a public API with good errors (for example the GitHub REST API or httpbin.org) and read its docs for auth and rate-limit headers.",
        "Write a list of at least eight request specs that should produce 200, 201 (httpbin POST), 304 or 400, 401, 404, 405 and 429-or-rate-limit-headers.",
        "Send each with httpx, and for each print method, URL, status, Content-Type, any rate-limit header, and the first 80 characters of the JSON body.",
        "Repeat two of the calls with curl -i and confirm the headers match what httpx saw.",
        "Load a token from an environment variable and show the rate-limit header changing between anonymous and authenticated calls; confirm the token never appears in printed URLs.",
      ],
      starter:
        "import os, httpx\n\nTOKEN = os.getenv(\"GITHUB_TOKEN\")\nCASES = [\n    (\"GET\", \"https://api.github.com/repos/python/cpython\", None),\n    (\"GET\", \"https://api.github.com/repos/python/no-such-repo-xyz\", None),\n    (\"POST\", \"https://httpbin.org/status/201\", {\"name\": \"test\"}),\n    # TODO: add cases that return 400, 401, 405 and show rate-limit headers\n]\n\ndef run(method: str, url: str, body: dict | None, auth: bool = False) -> None:\n    headers = {\"Accept\": \"application/json\"}\n    if auth and TOKEN:\n        headers[\"Authorization\"] = f\"Bearer {TOKEN}\"\n    r = httpx.request(method, url, json=body, headers=headers, timeout=10)\n    # TODO: print status, content-type, x-ratelimit-remaining, body preview\n\nfor m, u, b in CASES:\n    run(m, u, b)",
      checks: [
        "Your table shows at least six different status codes, each with a one-line meaning you wrote yourself.",
        "x-ratelimit-remaining is visibly higher for authenticated calls than anonymous ones.",
        "Searching your terminal output for the token string finds nothing.",
      ],
      stretch: "Sketch the REST endpoints (method, path, status codes) for a small library-lending app and justify which ones are idempotent.",
    },
  },
  "0.3": {
    realLife: {
      title: "A passport seva kendra front desk",
      story:
        "At a passport office the front desk checks every form before anything else happens: wrong date format or a missing photo and you are sent back with a clear reason, not a shrug. Behind the desk, every counter shares the same document scanner and the same ID check rather than each owning one. A printed board by the entrance lists every service, which documents it needs and what you get back.",
      mapping: [
        { everyday: "Form checked at the desk, rejected with a specific reason", concept: "Pydantic request models returning 422 with field-level errors" },
        { everyday: "Shared scanner and ID check used by every counter", concept: "Dependencies injected with Depends (settings, DB session, auth)" },
        { everyday: "The printed board of services and required documents", concept: "Auto-generated OpenAPI docs at /docs" },
        { everyday: "Where it breaks: a desk clerk can't serve two people at once, but an async endpoint can wait on many outside calls at the same time", concept: "async def endpoints and non-blocking I/O" },
      ],
    },
    build: {
      title: "A book-lookup API that wraps Open Library",
      goal: "A FastAPI service with validated routes, a shared settings dependency, consistent errors, an async call to an outside API, and passing tests.",
      minutes: 90,
      stack: ["Python", "fastapi", "uvicorn", "httpx", "pydantic-settings", "pytest"],
      steps: [
        "Create `GET /books/{isbn}` that validates the ISBN (10 or 13 digits) with a path constraint and returns a `BookOut` response model with title, authors and year.",
        "Fetch the data asynchronously from Open Library (`https://openlibrary.org/isbn/{isbn}.json`) with a shared `httpx.AsyncClient` created in the app's lifespan.",
        "Add a `Settings` class (pydantic-settings) for the upstream URL and timeout, exposed through a `get_settings` dependency.",
        "Return 404 with body `{\"error\": \"not_found\", \"detail\": ...}` for unknown books and 502 with `{\"error\": \"upstream_failed\"}` when the outside API times out; add an exception handler so no stack trace ever leaks.",
        "Add a middleware that logs method, path, status and duration in milliseconds.",
        "Write tests with TestClient that override the HTTP dependency with a fake, covering found, not found, invalid ISBN and upstream timeout.",
      ],
      starter:
        "from contextlib import asynccontextmanager\nimport httpx\nfrom fastapi import FastAPI, HTTPException, Path, Request\nfrom pydantic import BaseModel\n\nclass BookOut(BaseModel):\n    isbn: str\n    title: str\n    authors: list[str] = []\n    year: int | None = None\n\n@asynccontextmanager\nasync def lifespan(app: FastAPI):\n    app.state.http = httpx.AsyncClient(timeout=5)\n    yield\n    await app.state.http.aclose()\n\napp = FastAPI(lifespan=lifespan)\n\n@app.get(\"/books/{isbn}\", response_model=BookOut)\nasync def get_book(request: Request, isbn: str = Path(pattern=r\"^\\d{10}(\\d{3})?$\")):\n    # TODO: call Open Library, map 404 -> HTTPException(404), timeout -> 502\n    ...\n\n# TODO: settings dependency, error handler, timing middleware",
      checks: [
        "/docs shows the endpoint, the ISBN pattern and the BookOut schema without you writing any docs.",
        "`/books/abc` returns 422, an unknown ISBN returns 404 with your error body, and a forced timeout returns 502.",
        "`pytest` passes without network access because the HTTP client is overridden.",
      ],
      stretch: "Add a `POST /reading-list` that accepts a list of ISBNs and fetches them concurrently.",
    },
  },
  "0.4": {
    realLife: {
      title: "A school library's issue register",
      story:
        "A school librarian keeps three registers: students, books, and an issue log where each line points to one student roll number and one book accession number. She never copies the student's address into the issue log; she looks it up. Finding all overdue books is quick because the log is kept sorted by due date, while 'who borrowed anything blue?' means reading every page.",
      mapping: [
        { everyday: "Roll number and accession number", concept: "Primary keys" },
        { everyday: "Issue log lines pointing at a student and a book", concept: "Foreign keys and a join table" },
        { everyday: "Not copying addresses into the issue log", concept: "Normalisation: store each fact once" },
        { everyday: "Log sorted by due date makes 'overdue' fast; 'blue covers' still needs a full read", concept: "An index helps only queries that match its column" },
      ],
    },
    build: {
      title: "Persist a library-lending API in PostgreSQL",
      goal: "A FastAPI app backed by PostgreSQL with members, books and loans tables, full CRUD for loans, and a measured index speed-up.",
      minutes: 100,
      stack: ["Python", "PostgreSQL (Docker)", "fastapi", "psycopg or SQLAlchemy", "pytest"],
      steps: [
        "Start PostgreSQL with `docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16` and put the connection URL in a `DATABASE_URL` environment variable, never in code.",
        "Create tables `members`, `books` and `loans(member_id, book_id, loaned_at, due_at, returned_at)` with primary keys, foreign keys and a constraint that a book has at most one open loan.",
        "Expose create, list, update (mark returned) and delete for loans through FastAPI, with a DB session supplied by a dependency.",
        "Write a query endpoint `GET /members/{id}/summary` that joins and aggregates: books currently out, overdue count, total loans ever.",
        "Insert 200,000 fake loans with `generate_series`, run `EXPLAIN ANALYZE` on the overdue query, add an index on `due_at` (or a partial index on open loans), and compare.",
        "Restart the app and the container and confirm the data is still there.",
      ],
      starter:
        "-- schema.sql\nCREATE TABLE members (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL);\nCREATE TABLE books (id SERIAL PRIMARY KEY, title TEXT NOT NULL);\nCREATE TABLE loans (\n  id SERIAL PRIMARY KEY,\n  member_id INT NOT NULL REFERENCES members(id),\n  book_id INT NOT NULL REFERENCES books(id),\n  loaned_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  due_at TIMESTAMPTZ NOT NULL,\n  returned_at TIMESTAMPTZ\n);\n-- TODO: unique partial index so one book has at most one open loan\n-- TODO: index that speeds up: WHERE returned_at IS NULL AND due_at < now()",
      checks: [
        "Loaning a book that is already out returns 409, driven by the database constraint, not only by Python code.",
        "EXPLAIN ANALYZE shows a sequential scan before the index and an index scan after, with a lower execution time.",
        "`grep -r password` over your source finds no credentials.",
        "Data survives `docker restart` of the Postgres container.",
      ],
      stretch: "Add Alembic migrations so the schema can be recreated from an empty database with one command.",
    },
  },
  "0.5": {
    realLife: {
      title: "A college fest organising committee editing one schedule",
      story:
        "Five volunteers each draft their part of the fest schedule on their own copy: sports, cultural, food stalls. The convener only merges a section into the master schedule after someone else has read it. When the sports head and the cultural head both book the auditorium at 4 p.m., someone has to sit down and decide, and the master copy is locked so nobody pastes over it directly.",
      mapping: [
        { everyday: "Each volunteer's own copy of the schedule", concept: "A feature branch" },
        { everyday: "Section read by someone else before it goes in the master", concept: "A pull request and code review" },
        { everyday: "Two bookings for the auditorium at 4 p.m.", concept: "A merge conflict you resolve by deciding, not by deleting one side blindly" },
        { everyday: "The locked master schedule", concept: "A protected main branch" },
      ],
    },
    build: {
      title: "Ship a repo someone else can run without asking you",
      goal: "A GitHub repo for your 0.3 or 0.4 service with a clean history, a .gitignore that blocks secrets, a protected main branch, one reviewed PR and a README a stranger can follow.",
      minutes: 60,
      stack: ["git", "GitHub", "gh CLI"],
      steps: [
        "Add a `.gitignore` covering `.venv/`, `__pycache__/`, `.env` and build output, and an `.env.example` with placeholder values; run `git status` to confirm `.env` is untracked.",
        "Turn on branch protection for `main` (require a pull request and one passing check, even if the check is just `pytest`).",
        "Make a feature branch, add one small endpoint in two commits with messages that say why, and open a PR with `gh pr create`.",
        "Use `git log -S` or `git bisect` to find the commit that introduced a bug you plant on purpose (for example a changed status code).",
        "Write the README with sections: what it does, setup, configuration, run, test, and two example curl calls.",
        "Ask a friend (or clone into a fresh folder yourself) to follow only the README and note every place they get stuck; fix those spots.",
      ],
      checks: [
        "A direct `git push origin main` is rejected by GitHub.",
        "`git log --oneline` reads like a changelog, with no 'fix', 'wip' or 'asdf' commits on main.",
        "A fresh clone reaches a passing `pytest` using only README steps.",
        "Running `git log -p | grep -i 'sk-'` (or your key prefix) returns nothing.",
      ],
      stretch: "Add a GitHub Actions workflow that runs pytest and a type checker on every PR.",
    },
  },
  "0.6": {
    realLife: {
      title: "Directing a contractor renovating your kitchen",
      story:
        "You hire a capable contractor for a kitchen redo. If you say 'make it nice' and leave for a week, you come back to a surprise. If you hand over a written spec, ask for the plan first, keep a notebook by the door with house rules (water main is here, don't touch the gas line), and inspect each cabinet before the next goes up, you get the kitchen you wanted. The electrician he brings in works only on wiring and reports back.",
      mapping: [
        { everyday: "Written spec and 'show me the plan before you start'", concept: "Spec first, review the agent's plan, then let it edit" },
        { everyday: "House-rules notebook by the door", concept: "Project memory file such as CLAUDE.md" },
        { everyday: "Inspecting each cabinet before the next", concept: "The verification loop: read the diff, run tests, then accept" },
        { everyday: "The electrician who only does wiring", concept: "A subagent with its own focused context" },
      ],
    },
    build: {
      title: "Add a feature to your service with an agent, and catch its mistake",
      goal: "One feature added to your Level 0 service by a coding agent under a spec, a plan review, an automatic test hook, and a short log of what you corrected.",
      minutes: 90,
      stack: ["Claude Code or another coding agent", "your 0.3/0.4 repo", "pytest", "ruff"],
      steps: [
        "Write a `CLAUDE.md` (or equivalent) under 40 lines: how to run, how to test, code style, and two rules the agent must not break (for example 'never edit migrations by hand').",
        "Write a five-line spec for a new feature, such as pagination with `limit` and `cursor` on your list endpoint, including the error cases.",
        "Ask the agent for a plan only; reject or edit at least one step before allowing edits.",
        "Configure a hook (or a slash command) that runs `ruff format` and `pytest -q` after every edit.",
        "Review every diff before accepting it, and write tests for at least one edge case the agent did not think of.",
        "Save a reusable slash command or skill for 'add an endpoint with tests' based on what worked.",
      ],
      checks: [
        "The plan you approved differs from the agent's first plan in at least one concrete way.",
        "The hook visibly ran tests after an edit (you can see it in the session output).",
        "You have a written note of one wrong or risky thing the agent did, how you spotted it, and the fix.",
        "All tests pass, including the edge-case test you added yourself.",
      ],
      stretch: "Delegate a code review of the finished diff to a subagent and compare its findings with your own.",
    },
  },
  "0.7": {
    realLife: {
      title: "A dabbawala tiffin packed the same way every day",
      story:
        "A Mumbai dabbawala does not care what is cooked inside a tiffin; every tin has the same shape, the same lid and the same painted code, so it travels by train and handcart and arrives intact anywhere on the route. The home kitchen packs it, the system moves it, and a note taped inside (no sugar for Dad) changes what happens at lunch without repacking the tin.",
      mapping: [
        { everyday: "The standard tin holding whatever was cooked", concept: "A container image bundling app plus its runtime environment" },
        { everyday: "Same tin works on any train or handcart", concept: "Runs the same on your laptop and on the host" },
        { everyday: "The painted code saying where it goes", concept: "Published port and the service's public URL" },
        { everyday: "The note inside that changes lunch without repacking", concept: "Environment variables and secrets injected at run time, not baked into the image" },
      ],
    },
    build: {
      title: "Containerise and deploy your API with its database",
      goal: "Your FastAPI + PostgreSQL service running from Docker Compose locally and live on a public URL with secrets supplied by the platform.",
      minutes: 90,
      stack: ["Docker", "docker compose", "a host such as Render, Fly.io or Railway"],
      steps: [
        "Write a Dockerfile with a slim Python base, copy the lock file and install dependencies before copying source (so code edits reuse the cached layer), and add a `.dockerignore` that excludes `.venv`, `.git` and `.env`.",
        "Write a `compose.yaml` with `api` and `db` services, a named volume for Postgres data, and `DATABASE_URL` passed from an `.env` file.",
        "Change one line of source, rebuild, and confirm in the build output that the dependency layer was cached.",
        "Break startup on purpose (wrong DATABASE_URL), read the cause with `docker compose logs api`, and fix it.",
        "Deploy to a host using its managed Postgres, set secrets in the host's dashboard, and hit `/docs` on the public URL.",
      ],
      starter:
        "FROM python:3.12-slim\nWORKDIR /app\n# TODO: install uv, copy pyproject.toml + uv.lock, install deps (cached layer)\n# TODO: copy source after deps\nENV PORT=8000\n# Bind to 0.0.0.0 or the container will be unreachable from outside\nCMD [\"sh\", \"-c\", \"uvicorn app.main:app --host 0.0.0.0 --port $PORT\"]",
      checks: [
        "`docker compose down && docker compose up` keeps your data (named volume).",
        "A source-only change rebuilds in seconds because the dependency layer shows CACHED.",
        "`docker history` or `docker run --rm <image> env` shows no secret values baked into the image.",
        "The public URL serves /docs and a real request returns data from the hosted database.",
      ],
      stretch: "Add a `/healthz` endpoint that checks the database and wire it into the host's health check.",
    },
  },
  "0.8": {
    realLife: {
      title: "Opening a small neighbourhood kirana shop",
      story:
        "Before you sell a single packet you need a stock register, a till that refuses wrong change, a supplier you can call when stock runs low, a plan for when that supplier doesn't pick up, and a shopfront people can actually walk into. A relative should be able to mind the shop for a day using only the notes you leave. None of that needs a clever salesman; it is what lets a clever salesman work later.",
      mapping: [
        { everyday: "Stock register that survives closing time", concept: "PostgreSQL persistence behind CRUD endpoints" },
        { everyday: "Till that refuses wrong change; plan for a silent supplier", concept: "Validation and clean error paths, including an outside API failing" },
        { everyday: "Notes a relative can run the shop from", concept: "README, tests and a reproducible setup" },
        { everyday: "The open shopfront", concept: "A containerised service on a public URL" },
      ],
    },
    build: {
      title: "First milestone: schema, two endpoints and a test, end to end",
      goal: "A repo for your chosen domain with the table design, two working endpoints on PostgreSQL, one passing test and a running container, ready to grow into the full capstone.",
      minutes: 120,
      stack: ["Python", "fastapi", "PostgreSQL", "Docker", "pytest", "git"],
      steps: [
        "Choose the domain (expenses, support tickets, inventory) and write down 3-4 entities, their keys, and 6-8 endpoints with methods and status codes before writing code.",
        "Create the repo with `.gitignore`, `.env.example` and a README skeleton; protect `main`.",
        "Implement the schema and two endpoints (create and get by id) with Pydantic models, backed by PostgreSQL through a dependency-injected session.",
        "Write one happy-path test and one error-path test (404 or 422) and make them pass.",
        "Add the Dockerfile and compose file and run the stack with one command.",
        "Open a task list in the README for the remaining endpoints, the outside API call, deployment and the coding-agent write-up.",
      ],
      checks: [
        "`docker compose up` then `curl -X POST` creates a record you can fetch back after a restart.",
        "`pytest` passes and includes at least one error-path test.",
        "Someone else can clone the repo and reach the same state from the README alone.",
      ],
      stretch: "Pick the outside API you will integrate now and write a failing test for its timeout behaviour.",
    },
  },
};
