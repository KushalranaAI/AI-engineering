---
project: plain-rest-service
title: A deployed REST service, no AI inside
hours: 10
stack: Python 3.11+, FastAPI, SQLAlchemy 2, PostgreSQL (Docker), httpx, pytest, Docker
cost: Free (runs locally; free hosting tiers for the deploy)
---

You will build and ship an **expense tracker API**: categories, expenses with amounts in different currencies, filters, and a conversion endpoint that calls a real exchange-rate service. It runs on PostgreSQL, logs every request with an id, returns clean JSON errors for every failure path, has a pytest suite that covers those failure paths, and lives at a public URL. There is no model anywhere in it. That is the point: every AI app you build later is this kind of service with a model call added, and the weak spots in a model-backed app are almost always ordinary engineering weak spots.

## Before you start

- **Python 3.11 or newer**: `python --version`.
- **Docker Desktop** (or Docker Engine on Linux): `docker --version`. We use it for PostgreSQL locally and for the final image.
- **Git** and a GitHub account (the deploy pulls from a repo).
- An account on a host that runs Docker images and offers PostgreSQL. This guide uses **Render** (free web service and free Postgres instance; check their current limits). Fly.io or Railway work the same way.
- A coding agent (Claude Code, Cursor, Copilot agent mode or similar) for Step 10.
- No API keys. The exchange-rate service (Frankfurter) is free and keyless.

On Windows, use `curl.exe` instead of `curl` in PowerShell, or just use the interactive `/docs` page for the calls in this guide.

Final folder structure:

```text
expense-api/
├── app/
│   ├── __init__.py
│   ├── config.py          settings from environment variables
│   ├── db.py              engine, session, Base
│   ├── models.py          SQLAlchemy tables
│   ├── schemas.py         Pydantic request/response models
│   ├── errors.py          AppError + JSON error handlers
│   ├── rates.py           async client for the exchange-rate API
│   ├── logging_setup.py
│   └── main.py            routes, lifespan, middleware
├── scripts/
│   ├── check_db.py
│   └── seed.py            loads 3 months of realistic sample data
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── test_expenses.py
│   └── test_summary.py
├── .env.example
├── .dockerignore
├── .gitignore
├── compose.yaml
├── Dockerfile
├── pytest.ini
├── requirements.txt
├── AGENT_NOTES.md
└── README.md
```

## How it fits together

```text
  client (curl, /docs, tests)
          │  HTTP + JSON
          ▼
 ┌──────────────────────── FastAPI app ────────────────────────┐
 │ middleware: request id + timing log                          │
 │      │                                                       │
 │      ▼                                                       │
 │ route ──► Pydantic validates body ──► 422 if bad             │
 │      │                                                       │
 │      ├──► SQLAlchemy Session ──────► PostgreSQL              │
 │      │                                                       │
 │      └──► rates.get_rate (httpx, async, 5 s timeout) ──► Frankfurter API
 │                                                              │
 │ error handlers: AppError → 4xx/5xx JSON, anything else → 500 │
 └──────────────────────────────────────────────────────────────┘
```

A request first passes the logging middleware, which tags it with a request id. FastAPI matches the route and Pydantic validates the body and query parameters, rejecting bad input with a 422 before your code runs. The route opens a database session through a dependency, reads or writes rows, and for conversions awaits the exchange-rate API. Anything that goes wrong is raised as an `AppError` (a failure we expected, with a status code and machine-readable code) or falls through to a catch-all that logs the stack trace and returns a bland 500 with the request id.

## Step 1 · Set up the project and PostgreSQL

**Goal:** a virtual environment with dependencies installed and a PostgreSQL container you can connect to.

We pick the domain first: expenses. It is small but has the shapes real backends have: two related tables, money (which must never be a float), dates, filtering, and a reason to call an outside service (currency conversion). Sketch it before coding: `categories(id, name unique)` and `expenses(id, description, amount, currency, spent_on, category_id → categories, created_at)`. Endpoints: create/list categories, full CRUD on expenses, `GET /expenses/{id}/converted?to=USD`, and later `GET /summary`.

```bash title="terminal"
mkdir expense-api && cd expense-api
git init
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
mkdir app scripts tests
touch app/__init__.py tests/__init__.py              # Windows: type nul > app\__init__.py (and tests)
```

```text title="requirements.txt"
fastapi>=0.115
uvicorn[standard]>=0.30
sqlalchemy>=2.0
psycopg[binary]>=3.2
pydantic-settings>=2.4
httpx>=0.27
pytest>=8.0
```

```bash title="terminal"
pip install -r requirements.txt
docker run -d --name expense-db \
  -e POSTGRES_USER=expenses -e POSTGRES_PASSWORD=expenses -e POSTGRES_DB=expenses \
  -p 5432:5432 postgres:16
```

```python title="scripts/check_db.py"
import os

import psycopg

url = os.getenv("CHECK_URL", "postgresql://expenses:expenses@localhost:5432/expenses")

with psycopg.connect(url, connect_timeout=5) as conn:
    version = conn.execute("select version()").fetchone()[0]
    print("Connected:", version.split(",")[0])
```

```text title=".gitignore"
.venv/
__pycache__/
.env
*.db
.pytest_cache/
```

**How this code works**
- `psycopg[binary]` → the PostgreSQL driver with a prebuilt C library, so there is nothing to compile on Windows or macOS.
- `docker run ... -p 5432:5432 postgres:16` → a throwaway Postgres server. The three `POSTGRES_*` variables create a user, password and database on first start. Pin the major version (`16`) so a future `latest` does not change under you.
- `psycopg.connect(url, connect_timeout=5)` → fails fast instead of hanging if the container is not up. The `with` block closes the connection for you.
- `.gitignore` lists `.env` from day one. Secrets that reach a commit are very hard to fully remove.

**Run it**
```bash
python scripts/check_db.py
```

**You should see**
```text
Connected: PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu
```

**If it breaks**
- `connection refused` → the container is still starting or not running → `docker ps`, wait five seconds, retry; `docker logs expense-db` shows startup errors.
- `port is already allocated` → you already run Postgres locally → use `-p 5433:5432` and put `5433` in the URL (and in `.env` in Step 2).
- `password authentication failed` → an older container with different credentials → `docker rm -f expense-db` and run the command again.

## Step 2 · Config, database engine and tables

**Goal:** settings come from environment variables, and the two tables exist in PostgreSQL.

Nothing environment-specific belongs in code: the database URL is different on your laptop, in tests and in production. `pydantic-settings` reads environment variables (and a local `.env` file) into a typed object. SQLAlchemy 2 then gives us an engine (the connection pool) and declarative models (the tables).

```python title="app/config.py"
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://expenses:expenses@localhost:5432/expenses"
    rates_url: str = "https://api.frankfurter.dev/v1/latest"  # check the current docs
    rates_timeout_s: float = 5.0
    log_level: str = "INFO"

    @field_validator("database_url")
    @classmethod
    def use_psycopg_driver(cls, value: str) -> str:
        # Hosting platforms hand out "postgres://..." URLs; SQLAlchemy needs the driver name.
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix):]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

```python title="app/db.py"
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
```

```python title="app/models.py"
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)

    expenses: Mapped[list["Expense"]] = relationship(back_populates="category")


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    description: Mapped[str] = mapped_column(String(200))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3))
    spent_on: Mapped[date] = mapped_column(index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    category: Mapped[Category] = relationship(back_populates="expenses")
```

```text title=".env.example"
DATABASE_URL=postgresql+psycopg://expenses:expenses@localhost:5432/expenses
RATES_URL=https://api.frankfurter.dev/v1/latest
RATES_TIMEOUT_S=5
LOG_LEVEL=INFO
```

**How this code works**
- `class Settings(BaseSettings)` → each field maps to an environment variable of the same name, case-insensitive (`DATABASE_URL` → `database_url`), and is type-checked: `RATES_TIMEOUT_S=abc` fails at startup, not in the middle of a request.
- `use_psycopg_driver` → Render, Heroku and others give you `postgres://...`. SQLAlchemy would pick the wrong (or no) driver; rewriting the prefix saves you a confusing deploy failure in Step 9.
- `@lru_cache` on `get_settings` → settings are read once per process, not on every call.
- `pool_pre_ping=True` → before reusing a pooled connection, SQLAlchemy checks it is still alive. Hosted databases close idle connections; without this, the first request after a quiet hour fails.
- `expire_on_commit=False` → after `commit()`, objects keep their loaded values so we can return them in the response without another query.
- `get_session` is a generator → FastAPI runs the code before `yield` per request and closes the session afterwards, even if the route raised. This is the dependency every route will use.
- `Numeric(12, 2)` for money → never `Float`. `0.1 + 0.2` is `0.30000000000000004` in floating point; `Decimal` is exact.
- `ForeignKey("categories.id")` and `index=True` → Postgres enforces the relation, and the index makes "expenses in category X" and "since date Y" filters cheap.
- `.env.example` is committed; `.env` (your real values) is not. Copy one to the other: `cp .env.example .env`.

**Run it**
```bash
cp .env.example .env
python -c "import app.models; from app.db import Base, engine; Base.metadata.create_all(engine); print(sorted(Base.metadata.tables))"
docker exec -it expense-db psql -U expenses -c "\dt"
```

**You should see**
```text
['categories', 'expenses']
            List of relations
 Schema |    Name    | Type  |  Owner
--------+------------+-------+----------
 public | categories | table | expenses
 public | expenses   | table | expenses
```

**If it breaks**
- `ModuleNotFoundError: No module named 'app'` → you are not in the project root → `cd expense-api` and run again.
- `NoSuchModuleError: sqlalchemy.dialects:postgres` → the URL starts with `postgres://` and the validator is missing → check `config.py`.
- Tables are not created → `create_all` only knows models that were imported; that is why the command imports `app.models` first.

## Step 3 · Schemas, clean errors and CRUD endpoints

**Goal:** a running API with category and expense CRUD that returns a consistent JSON error shape for missing records, duplicates and invalid input.

Database models describe storage; Pydantic schemas describe the public contract. Keeping them separate means you can rename a column without breaking clients, and never accidentally return a field you did not mean to expose. We also define one error type, `AppError`, so every expected failure produces the same JSON shape: `{"error": {"code", "message", "request_id"}}`. Clients can branch on `code`; humans read `message`.

```python title="app/schemas.py"
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class ExpenseIn(BaseModel):
    description: str = Field(min_length=1, max_length=200)
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    currency: str = Field(pattern=r"^[A-Z]{3}$", examples=["EUR"])
    spent_on: date
    category_id: int


class ExpenseUpdate(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=200)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    spent_on: date | None = None
    category_id: int | None = None


class ExpenseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    description: str
    amount: Decimal
    currency: str
    spent_on: date
    category_id: int
    created_at: datetime


class ConvertedOut(BaseModel):
    expense_id: int
    original_amount: Decimal
    original_currency: str
    converted_amount: Decimal
    target_currency: str
    rate: Decimal
    rate_date: date
```

```python title="app/errors.py"
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("app.errors")


class AppError(Exception):
    """An error we expected and can describe to the client."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def error_body(request: Request, code: str, message: str) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "request_id": getattr(request.state, "request_id", None),
        }
    }


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=error_body(request, exc.code, exc.message))

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=error_body(request, "internal_error", "Something went wrong on our side."),
        )
```

```python title="app/main.py"
from contextlib import asynccontextmanager
from datetime import date

from fastapi import Depends, FastAPI, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import Base, engine, get_session
from app.errors import AppError, register_error_handlers
from app.models import Category, Expense
from app.schemas import CategoryIn, CategoryOut, ExpenseIn, ExpenseOut, ExpenseUpdate


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)  # creates missing tables; never alters existing ones
    yield


app = FastAPI(title="Expense API", version="0.1.0", lifespan=lifespan)
register_error_handlers(app)


# ---------- helpers ----------

def _get_expense(session: Session, expense_id: int) -> Expense:
    expense = session.get(Expense, expense_id)
    if expense is None:
        raise AppError(404, "expense_not_found", f"No expense with id {expense_id}.")
    return expense


def _check_category(session: Session, category_id: int) -> None:
    if session.get(Category, category_id) is None:
        raise AppError(422, "unknown_category", f"No category with id {category_id}.")


# ---------- routes ----------

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(body: CategoryIn, session: Session = Depends(get_session)):
    category = Category(name=body.name.strip())
    session.add(category)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise AppError(409, "category_exists", f"Category '{body.name}' already exists.")
    return category


@app.get("/categories", response_model=list[CategoryOut])
def list_categories(session: Session = Depends(get_session)):
    return session.scalars(select(Category).order_by(Category.name)).all()


@app.post("/expenses", response_model=ExpenseOut, status_code=201)
def create_expense(body: ExpenseIn, session: Session = Depends(get_session)):
    _check_category(session, body.category_id)
    expense = Expense(**body.model_dump())
    session.add(expense)
    session.commit()
    session.refresh(expense)
    return expense


@app.get("/expenses", response_model=list[ExpenseOut])
def list_expenses(
    category_id: int | None = None,
    since: date | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    stmt = select(Expense).order_by(Expense.spent_on.desc(), Expense.id.desc())
    if category_id is not None:
        stmt = stmt.where(Expense.category_id == category_id)
    if since is not None:
        stmt = stmt.where(Expense.spent_on >= since)
    return session.scalars(stmt.limit(limit).offset(offset)).all()


@app.get("/expenses/{expense_id}", response_model=ExpenseOut)
def get_expense(expense_id: int, session: Session = Depends(get_session)):
    return _get_expense(session, expense_id)


@app.patch("/expenses/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: int, body: ExpenseUpdate, session: Session = Depends(get_session)):
    expense = _get_expense(session, expense_id)
    # Only fields the client actually sent; an explicit null means "leave it alone".
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "category_id" in changes:
        _check_category(session, changes["category_id"])
    for field, value in changes.items():
        setattr(expense, field, value)
    session.commit()
    session.refresh(expense)
    return expense


@app.delete("/expenses/{expense_id}", status_code=204)
def delete_expense(expense_id: int, session: Session = Depends(get_session)):
    expense = _get_expense(session, expense_id)
    session.delete(expense)
    session.commit()
    return Response(status_code=204)
```

**How this code works**
- `model_config = ConfigDict(from_attributes=True)` on the `*Out` schemas → lets FastAPI build the response from a SQLAlchemy object (reading attributes) instead of requiring a dict.
- `Field(gt=0, max_digits=12, decimal_places=2)` → the validation rules live in the schema, so `"amount": "-5"` or `"12.345"` is a 422 before your function runs. `pattern=r"^[A-Z]{3}$"` does the same for currency codes.
- `ExpenseUpdate` has every field optional → that is what PATCH means: send only what changes. `model_dump(exclude_unset=True)` returns only the fields present in the JSON, so a missing field is not confused with "set to null".
- `if v is not None` → a client sending `"amount": null` would otherwise try to write NULL into a NOT NULL column and get a 500. We treat null as "no change"; the alternative (rejecting it with 422) is also fine, as long as you pick one on purpose.
- `_check_category` → we check the foreign key ourselves so the client gets a precise `unknown_category` 422 instead of a database error. Postgres still enforces it as a backstop.
- `except IntegrityError: session.rollback()` → the unique constraint on `name` is the source of truth for duplicates. Checking "does it exist?" first and then inserting has a race window between two requests; letting the database decide does not. Always roll back after a failed commit or the session stays unusable.
- `@app.exception_handler(Exception)` → the catch-all. It logs the full stack trace server-side with `log.exception` and returns a generic message: never leak stack traces or SQL to clients.
- `limit: int = Query(50, ge=1, le=200)` → list endpoints always paginate. An unbounded `SELECT *` is fine with 80 rows and an outage with 8 million.
- `return Response(status_code=204)` → 204 means "no body"; returning `None` from a route would send `null`.

**Run it**
```bash
uvicorn app.main:app --reload
# in a second terminal:
curl -s -X POST localhost:8000/categories -H "content-type: application/json" -d '{"name": "Groceries"}'
curl -s -X POST localhost:8000/expenses -H "content-type: application/json" \
  -d '{"description": "Supermarket run", "amount": "42.80", "currency": "EUR", "spent_on": "2026-01-03", "category_id": 1}'
curl -s localhost:8000/expenses/999
curl -s -X POST localhost:8000/categories -H "content-type: application/json" -d '{"name": "Groceries"}'
```

Then open `http://localhost:8000/docs` and try the endpoints from the browser.

**You should see**
```text
{"id":1,"name":"Groceries"}
{"id":1,"description":"Supermarket run","amount":"42.80","currency":"EUR","spent_on":"2026-01-03","category_id":1,"created_at":"2026-01-03T10:12:44.512Z"}
{"error":{"code":"expense_not_found","message":"No expense with id 999.","request_id":null}}
{"error":{"code":"category_exists","message":"Category 'Groceries' already exists.","request_id":null}}
```

Note that `amount` comes back as the string `"42.80"`: Pydantic serialises `Decimal` as a string so no precision is lost in JSON. `request_id` is `null` for now; Step 5 fills it.

**If it breaks**
- `422` with `"type": "json_invalid"` from curl on Windows → PowerShell mangled the quotes → use `curl.exe` with the body in a file (`-d "@body.json"`) or the `/docs` page.
- `500` on POST /expenses with `psycopg.errors.UndefinedTable` → the lifespan did not run because you started a different app object → run exactly `uvicorn app.main:app`.
- Changes to `models.py` do not appear in the database → `create_all` never alters existing tables → during development, `docker exec -it expense-db psql -U expenses -c "drop table expenses, categories"` and restart. (In a real project you would use Alembic migrations; see Going further.)

## Step 4 · Call an outside API asynchronously

**Goal:** `GET /expenses/{id}/converted?to=USD` converts an expense using a live exchange-rate API, with a timeout and a clear error for each way that service can fail.

Every real backend depends on services it does not control, and those services are slow, down, or return something unexpected. We call Frankfurter (free, keyless, ECB reference rates) with `httpx.AsyncClient`. The rule for outside calls: always set a timeout, translate each failure into an error your clients understand, and never let the outside service's error body leak through as yours.

```python title="app/rates.py"
import logging
from datetime import date
from decimal import Decimal

import httpx
from fastapi import Request

from app.config import get_settings
from app.errors import AppError

log = logging.getLogger("app.rates")


def get_http(request: Request) -> httpx.AsyncClient:
    """FastAPI dependency: the one shared HTTP client created at startup."""
    return request.app.state.http


async def get_rate(client: httpx.AsyncClient, base: str, target: str) -> tuple[Decimal, date]:
    if base == target:
        return Decimal("1"), date.today()

    settings = get_settings()
    try:
        resp = await client.get(
            settings.rates_url,
            params={"base": base, "symbols": target},
            timeout=settings.rates_timeout_s,
        )
    except httpx.TimeoutException as exc:
        log.warning("rates timeout base=%s target=%s", base, target)
        raise AppError(504, "rates_timeout", "The exchange-rate service did not answer in time.") from exc
    except httpx.HTTPError as exc:
        log.warning("rates unreachable: %r", exc)
        raise AppError(503, "rates_unavailable", "Could not reach the exchange-rate service.") from exc

    if resp.status_code in (400, 404, 422):
        raise AppError(400, "unsupported_currency", f"Cannot convert {base} to {target}.")
    if resp.status_code >= 400:
        log.warning("rates service returned %s", resp.status_code)
        raise AppError(503, "rates_unavailable", f"Exchange-rate service returned {resp.status_code}.")

    try:
        data = resp.json()
        rate = Decimal(str(data["rates"][target]))
        rate_date = date.fromisoformat(data["date"])
    except (ValueError, KeyError, TypeError) as exc:
        raise AppError(503, "rates_unavailable", "Exchange-rate service sent an unexpected response.") from exc
    return rate, rate_date
```

Now update `app/main.py`. Replace everything **above** the `# ---------- helpers ----------` line with this:

```python title="app/main.py (top of file)"
from contextlib import asynccontextmanager
from datetime import date
from decimal import Decimal

import httpx
from fastapi import Depends, FastAPI, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db import Base, engine, get_session
from app.errors import AppError, register_error_handlers
from app.models import Category, Expense
from app.rates import get_http, get_rate
from app.schemas import CategoryIn, CategoryOut, ConvertedOut, ExpenseIn, ExpenseOut, ExpenseUpdate


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    app.state.http = httpx.AsyncClient(headers={"User-Agent": "expense-api/0.1"}, follow_redirects=True)
    yield
    await app.state.http.aclose()


app = FastAPI(title="Expense API", version="0.1.0", lifespan=lifespan)
register_error_handlers(app)
```

Then add this route at the **bottom** of `app/main.py`:

```python title="app/main.py (add at the bottom)"
@app.get("/expenses/{expense_id}/converted", response_model=ConvertedOut)
async def convert_expense(
    expense_id: int,
    to: str = Query(pattern=r"^[A-Z]{3}$", description="Target currency, e.g. USD"),
    session: Session = Depends(get_session),
    http: httpx.AsyncClient = Depends(get_http),
):
    # The DB call is blocking, so run it in a worker thread; the HTTP call is awaited.
    expense = await run_in_threadpool(_get_expense, session, expense_id)
    rate, rate_date = await get_rate(http, expense.currency, to)
    return ConvertedOut(
        expense_id=expense.id,
        original_amount=expense.amount,
        original_currency=expense.currency,
        converted_amount=(expense.amount * rate).quantize(Decimal("0.01")),
        target_currency=to,
        rate=rate,
        rate_date=rate_date,
    )
```

**How this code works**
- `app.state.http = httpx.AsyncClient(...)` in the lifespan → one client for the whole process, so connections (and TLS handshakes) are reused. Creating a client per request is a common, slow mistake. `aclose()` after `yield` closes it on shutdown.
- `get_http` as a dependency → routes ask for the client instead of reaching into globals, which is what lets tests swap in a fake in Step 7.
- `timeout=settings.rates_timeout_s` → without it, a hung upstream holds your request (and a worker) for a long time. 5 seconds is generous for a rates lookup.
- Three failure buckets → timeout becomes **504**, network errors and upstream 5xx become **503** (our dependency is down, try later), and an upstream 404 for an unknown currency becomes **400** (the client asked for something impossible). Each has its own `code` so a client can react differently.
- `Decimal(str(data["rates"][target]))` → JSON numbers arrive as floats; going through `str` keeps `1.1165` as exactly `1.1165`.
- The final `try` around `resp.json()` → if the service changes its response shape, we return a clean 503 instead of a `KeyError` 500.
- `async def convert_expense` + `run_in_threadpool` → this route awaits network I/O, so it is `async`. Our SQLAlchemy session is synchronous; calling it directly inside an `async def` would block the event loop for every other request. `run_in_threadpool` runs it on a worker thread. The other routes are plain `def`, which FastAPI already runs in a thread pool.
- `.quantize(Decimal("0.01"))` → round to cents only at the end, after multiplying with the full-precision rate.

**Run it**
```bash
uvicorn app.main:app --reload
curl -s "localhost:8000/expenses/1/converted?to=USD"
curl -s "localhost:8000/expenses/1/converted?to=XYZ"
curl -s "localhost:8000/expenses/1/converted?to=usd"
```

**You should see**
```text
{"expense_id":1,"original_amount":"42.80","original_currency":"EUR","converted_amount":"47.79","target_currency":"USD","rate":"1.1165","rate_date":"2026-01-02"}
{"error":{"code":"unsupported_currency","message":"Cannot convert EUR to XYZ.","request_id":null}}
{"detail":[{"type":"string_pattern_mismatch","loc":["query","to"],"msg":"String should match pattern '^[A-Z]{3}$'", ...}]}
```

Your rate and date will differ: they are live.

**If it breaks**
- Every call returns `rates_unavailable` → you are offline or behind a proxy → `curl "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD"` directly; if the URL has moved, update `RATES_URL` in `.env` (that is why it is a setting).
- `AttributeError: 'State' object has no attribute 'http'` → the lifespan did not run → make sure `lifespan=lifespan` is passed to `FastAPI(...)` and restart uvicorn.
- To see the timeout path for real: set `RATES_TIMEOUT_S=0.001` in `.env`, restart, call the endpoint, and you get a 504. Set it back afterwards.

## Step 5 · Logging, request ids and a failure-path tour

**Goal:** every request produces one log line with method, path, status, duration and a request id, and that id is returned to the client in headers and error bodies.

When a user reports "I got an error", the request id is how you find the matching log line and stack trace in seconds. We add a tiny logging setup and an HTTP middleware.

```python title="app/logging_setup.py"
import logging


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    # uvicorn's own access log duplicates ours; keep its errors, drop the access lines.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
```

Replace everything above `# ---------- helpers ----------` in `app/main.py` once more, with this final version:

```python title="app/main.py (top of file)"
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import date
from decimal import Decimal

import httpx
from fastapi import Depends, FastAPI, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.db import Base, engine, get_session
from app.errors import AppError, register_error_handlers
from app.logging_setup import configure_logging
from app.models import Category, Expense
from app.rates import get_http, get_rate
from app.schemas import CategoryIn, CategoryOut, ConvertedOut, ExpenseIn, ExpenseOut, ExpenseUpdate

configure_logging(get_settings().log_level)
log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    app.state.http = httpx.AsyncClient(headers={"User-Agent": "expense-api/0.1"}, follow_redirects=True)
    log.info("startup complete")
    yield
    await app.state.http.aclose()


app = FastAPI(title="Expense API", version="0.1.0", lifespan=lifespan)
register_error_handlers(app)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    log.info("%s %s -> %s %.1fms id=%s", request.method, request.url.path,
             response.status_code, elapsed_ms, request_id)
    response.headers["x-request-id"] = request_id
    return response
```

**How this code works**
- `configure_logging(get_settings().log_level)` → log level comes from config, so production can run at `INFO` and you can flip to `DEBUG` without a code change.
- `request.headers.get("x-request-id") or uuid...` → if a load balancer or another service already assigned an id, we keep it, so one id follows the request across services.
- `request.state.request_id` → `error_body` in `errors.py` reads it from here, which is why it was written with `getattr(..., None)` back in Step 3.
- `time.perf_counter()` → a monotonic clock meant for measuring durations; `time.time()` can jump when the system clock is adjusted.
- `%s` placeholders instead of f-strings in log calls → the string is only built if the line is actually emitted.
- The middleware does not catch exceptions → an unhandled error skips our log line, but the catch-all handler logs it with the stack trace and the same request id is still in the 500 body.

**Run it**

Restart uvicorn and walk through each failure path on purpose:

```bash
curl -si localhost:8000/expenses/999 | grep -i -E "HTTP/|x-request-id"
curl -s -X POST localhost:8000/expenses -H "content-type: application/json" -d '{"description":"x","amount":"0","currency":"EUR","spent_on":"2026-01-01","category_id":1}'
curl -s -X POST localhost:8000/expenses -H "content-type: application/json" -d '{"description":"x","amount":"5","currency":"EUR","spent_on":"2026-01-01","category_id":77}'
docker stop expense-db && curl -s localhost:8000/expenses ; docker start expense-db
```

**You should see**

In the curl terminal:

```text
HTTP/1.1 404 Not Found
x-request-id: 5be0c2a91f3d
{"detail":[{"type":"greater_than","loc":["body","amount"],"msg":"Input should be greater than 0", ...}]}
{"error":{"code":"unknown_category","message":"No category with id 77.","request_id":"a41f9e0b7c22"}}
{"error":{"code":"internal_error","message":"Something went wrong on our side.","request_id":"0d9e37ab51c4"}}
```

In the uvicorn terminal:

```text
2026-01-03 10:30:12,481 INFO    app | GET /expenses/999 -> 404 3.1ms id=5be0c2a91f3d
2026-01-03 10:30:12,602 INFO    app | POST /expenses -> 422 1.2ms id=8c01d1e2aa90
2026-01-03 10:30:12,688 INFO    app | POST /expenses -> 422 4.0ms id=a41f9e0b7c22
2026-01-03 10:30:14,930 ERROR   app.errors | unhandled error on GET /expenses
Traceback (most recent call last):
  ...
psycopg.OperationalError: connection failed: ... Connection refused
```

The database-down case is exactly what the catch-all is for: the client gets a clean 500 with an id, and you get the full traceback.

**If it breaks**
- No `app |` log lines at all → `LOG_LEVEL` in `.env` is `WARNING` or higher, or `configure_logging` is not called → set `LOG_LEVEL=INFO` and check the call sits right after the imports in `main.py`.
- Two lines per request → uvicorn's access log is still on → check the `uvicorn.access` line in `logging_setup.py`.
- `grep` not found on Windows → drop the `| grep ...` part and look for the header in the output.

## Step 6 · Load realistic sample data

**Goal:** the database holds three months of believable expenses across five categories and three currencies.

An empty API teaches you nothing. A seeded one shows whether pagination, filters and the summary in Step 10 behave on data that looks real. The script talks to the API over HTTP rather than to the database, so it also acts as a smoke test of the whole stack.

```python title="scripts/seed.py"
"""Fill a running Expense API with three months of realistic sample data."""
import os
import random
import sys
from datetime import date, timedelta

import httpx

BASE_URL = os.getenv("API_URL", "http://localhost:8000")

CATEGORIES = {
    "Groceries": [("Supermarket run", 25, 110), ("Farmers market", 12, 40), ("Bakery", 4, 15)],
    "Rent": [("Monthly rent", 950, 950)],
    "Transport": [("Metro pass top-up", 20, 40), ("Taxi home", 12, 35), ("Train ticket", 18, 90)],
    "Eating out": [("Lunch with team", 12, 28), ("Dinner out", 30, 85), ("Coffee", 3, 6)],
    "Software": [("Cloud hosting", 5, 25), ("Code editor licence", 10, 10), ("Domain renewal", 12, 15)],
}
CURRENCIES = ["EUR"] * 6 + ["USD"] * 3 + ["GBP"]  # mostly EUR, some travel spending


def main() -> None:
    rng = random.Random(42)  # same data every run
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        ids: dict[str, int] = {}
        existing = {c["name"]: c["id"] for c in client.get("/categories").json()}
        for name in CATEGORIES:
            if name in existing:
                ids[name] = existing[name]
                continue
            resp = client.post("/categories", json={"name": name})
            resp.raise_for_status()
            ids[name] = resp.json()["id"]

        start = date(2026, 1, 1)
        created = 0
        for day in range(90):
            spent_on = start + timedelta(days=day)
            if spent_on.day == 1:
                todo = [("Rent", CATEGORIES["Rent"][0])]
            else:
                todo = []
            for _ in range(rng.choice([0, 0, 1, 1, 2])):
                cat = rng.choice(["Groceries", "Transport", "Eating out", "Software"])
                todo.append((cat, rng.choice(CATEGORIES[cat])))
            for cat, (desc, low, high) in todo:
                payload = {
                    "description": desc,
                    "amount": f"{rng.uniform(low, high):.2f}",
                    "currency": "EUR" if cat == "Rent" else rng.choice(CURRENCIES),
                    "spent_on": spent_on.isoformat(),
                    "category_id": ids[cat],
                }
                resp = client.post("/expenses", json=payload)
                if resp.status_code != 201:
                    sys.exit(f"Failed on {payload}: {resp.status_code} {resp.text}")
                created += 1
    print(f"Seeded {len(ids)} categories and {created} expenses into {BASE_URL}")


if __name__ == "__main__":
    main()
```

**How this code works**
- `random.Random(42)` → a seeded generator gives the same "random" data every run, so numbers in your README stay reproducible.
- `existing = {...}` → the script is safe to run twice for categories (it reuses them instead of hitting the 409). Expenses do get added again, so reset the DB if you want a clean slate.
- Rent on the 1st of each month in EUR, other spending on 0-2 random items a day in mostly EUR → a distribution with obvious patterns you can check by eye.
- `f"{rng.uniform(low, high):.2f}"` → amounts are sent as strings with two decimals, matching the schema's `decimal_places=2`.
- `API_URL` from the environment → the same script seeds your deployed API in Step 9.

**Run it**
```bash
python scripts/seed.py
curl -s "localhost:8000/expenses?limit=3&since=2026-03-25"
```

**You should see**
```text
Seeded 5 categories and 82 expenses into http://localhost:8000
[{"id":83,"description":"Coffee","amount":"4.71","currency":"EUR","spent_on":"2026-03-31",...},{"id":82,...},{"id":81,...}]
```

**If it breaks**
- `httpx.ConnectError` → the API is not running → start uvicorn first.
- `Failed on {...}: 422` → your schema and the script disagree (for example you tightened a rule) → read the `detail` in the message; it names the field.

## Step 7 · Test the happy paths and every error path

**Goal:** a pytest suite that runs in about a second with no Postgres and no internet, and covers 404, 409, 422, 400, 503, 504 and 500.

Tests that need a live database and a live third-party API are slow and flaky. FastAPI's dependency overrides let us swap `get_session` for an in-memory SQLite session and `get_http` for an httpx client with a **mock transport** that pretends to be Frankfurter, including pretending to fail.

```ini title="pytest.ini"
[pytest]
filterwarnings =
    ignore::sqlalchemy.exc.SAWarning
```

```python title="tests/conftest.py"
import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_session
from app.main import app
from app.rates import get_http


def fake_rates(request: httpx.Request) -> httpx.Response:
    """Stands in for the real exchange-rate API. Special codes trigger failures."""
    target = request.url.params["symbols"]
    if target == "TMO":
        raise httpx.ReadTimeout("simulated timeout", request=request)
    if target == "ERR":
        return httpx.Response(502, text="bad gateway")
    if target == "XXX":
        return httpx.Response(404, json={"message": "not found"})
    return httpx.Response(200, json={"amount": 1.0, "base": request.url.params["base"],
                                     "date": "2026-01-15", "rates": {target: 1.1}})


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory DB for every session in the test
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def client(session_factory):
    def override_session():
        with session_factory() as session:
            yield session

    async def override_http():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake_rates)) as http:
            yield http

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_http] = override_http
    # No "with" block: we skip the lifespan, so the real Postgres is never touched.
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture
def category_id(client) -> int:
    return client.post("/categories", json={"name": "Groceries"}).json()["id"]
```

```python title="tests/test_expenses.py"
from decimal import Decimal

from app.db import get_session
from app.main import app

EXPENSE = {"description": "Weekly shop", "amount": "10.00", "currency": "EUR",
           "spent_on": "2026-01-10"}


def make_expense(client, category_id, **overrides):
    payload = {**EXPENSE, "category_id": category_id, **overrides}
    resp = client.post("/expenses", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------- happy paths ----------

def test_create_and_get_expense(client, category_id):
    created = make_expense(client, category_id)
    resp = client.get(f"/expenses/{created['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["description"] == "Weekly shop"
    assert Decimal(body["amount"]) == Decimal("10.00")


def test_list_filters_by_category(client, category_id):
    other = client.post("/categories", json={"name": "Rent"}).json()["id"]
    make_expense(client, category_id)
    make_expense(client, other, description="January rent", amount="950.00")
    resp = client.get("/expenses", params={"category_id": other})
    assert [e["description"] for e in resp.json()] == ["January rent"]


def test_patch_then_delete(client, category_id):
    created = make_expense(client, category_id)
    resp = client.patch(f"/expenses/{created['id']}", json={"amount": "12.50", "currency": None})
    assert resp.status_code == 200
    assert Decimal(resp.json()["amount"]) == Decimal("12.50")
    assert resp.json()["currency"] == "EUR"  # null left it unchanged
    assert client.delete(f"/expenses/{created['id']}").status_code == 204
    assert client.get(f"/expenses/{created['id']}").status_code == 404


def test_convert(client, category_id):
    created = make_expense(client, category_id)
    resp = client.get(f"/expenses/{created['id']}/converted", params={"to": "USD"})
    assert resp.status_code == 200, resp.text
    assert Decimal(resp.json()["converted_amount"]) == Decimal("11.00")


# ---------- error paths ----------

def test_missing_expense_is_404_with_error_body(client):
    resp = client.get("/expenses/999")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "expense_not_found"


def test_negative_amount_is_422(client, category_id):
    resp = client.post("/expenses", json={**EXPENSE, "category_id": category_id, "amount": "-5"})
    assert resp.status_code == 422


def test_unknown_category_is_422(client):
    resp = client.post("/expenses", json={**EXPENSE, "category_id": 42})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "unknown_category"


def test_duplicate_category_is_409(client, category_id):
    resp = client.post("/categories", json={"name": "Groceries"})
    assert resp.status_code == 409


def test_unsupported_currency_is_400(client, category_id):
    created = make_expense(client, category_id)
    resp = client.get(f"/expenses/{created['id']}/converted", params={"to": "XXX"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "unsupported_currency"


def test_rates_service_down_is_503(client, category_id):
    created = make_expense(client, category_id)
    resp = client.get(f"/expenses/{created['id']}/converted", params={"to": "ERR"})
    assert resp.status_code == 503


def test_rates_timeout_is_504(client, category_id):
    created = make_expense(client, category_id)
    resp = client.get(f"/expenses/{created['id']}/converted", params={"to": "TMO"})
    assert resp.status_code == 504


def test_unexpected_error_is_clean_500(client):
    def broken_session():
        raise RuntimeError("database exploded")
        yield  # makes this a generator, like the real dependency

    app.dependency_overrides[get_session] = broken_session
    resp = client.get("/expenses")
    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "internal_error"
    assert "exploded" not in resp.text  # internals never leak to clients
```

**How this code works**
- `poolclass=StaticPool` with `sqlite+pysqlite://` → an in-memory SQLite database normally exists per connection; StaticPool reuses one connection so every session in a test sees the same data. Each test gets a fresh database because the fixture runs per test.
- `app.dependency_overrides[get_session] = ...` → FastAPI calls our function wherever a route says `Depends(get_session)`. This is the payoff of putting the session and HTTP client behind dependencies.
- `httpx.MockTransport(fake_rates)` → the real `get_rate` code runs, including its error handling; only the network is fake. Special target codes (`TMO`, `ERR`, `XXX`) trigger each failure branch.
- `raise httpx.ReadTimeout(...)` → simulates the exact exception httpx raises on a real timeout, so the `except httpx.TimeoutException` branch is exercised.
- `TestClient(app, raise_server_exceptions=False)` → by default the test client re-raises server errors into the test; turning it off lets us assert on the 500 response the user would see.
- No `with TestClient(...)` → the lifespan (which connects to Postgres and creates the shared client) does not run in tests.
- `filterwarnings` in `pytest.ini` → SQLite stores `Numeric` as floating point and SQLAlchemy warns about it. Fine for tests; production uses Postgres, which stores exact decimals.
- `assert "exploded" not in resp.text` → tests the security property, not just the status code.

**Run it**
```bash
pytest -q
```

**You should see**
```text
............                                                             [100%]
12 passed in 0.9s
```

**If it breaks**
- `ModuleNotFoundError: No module named 'app'` → run pytest from the project root, and make sure `tests/__init__.py` exists.
- `test_convert` fails with 503 → you forgot the `get_http` override, so the test hit the real lifespan-less app → check the fixture.
- Tests pass alone but fail together → a test left `dependency_overrides` modified → the `client` fixture's `clear()` must run after `yield`, as shown.

## Step 8 · Containerise it

**Goal:** `docker compose up` starts the API and Postgres together, and the API answers on port 8000.

The image is what you deploy, so it should be small, rebuild fast, and get all config from the environment.

```dockerfile title="Dockerfile"
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first: this layer is cached until requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Then the code, which changes often.
COPY app ./app

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
```

```text title=".dockerignore"
.venv
.env
__pycache__
.pytest_cache
.git
tests
*.db
```

```yaml title="compose.yaml"
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: expenses
      POSTGRES_PASSWORD: expenses
      POSTGRES_DB: expenses
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U expenses"]
      interval: 2s
      timeout: 3s
      retries: 15

  api:
    build: .
    environment:
      DATABASE_URL: postgresql+psycopg://expenses:expenses@db:5432/expenses
      LOG_LEVEL: INFO
    ports:
      - "8000:8000"
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

**How this code works**
- `python:3.12-slim` → small Debian base with Python; `psycopg[binary]` ships its own libpq, so no `apt-get` is needed.
- `COPY requirements.txt` then `pip install` before `COPY app` → Docker caches layers in order. Editing code only rebuilds the last layer, so rebuilds take seconds.
- `PYTHONUNBUFFERED=1` → logs appear immediately in `docker logs` instead of sitting in a buffer.
- `--host 0.0.0.0` → inside a container, `127.0.0.1` is only reachable from inside that container. This is the number one "it runs but I can't reach it" bug.
- `${PORT:-8000}` → hosts like Render and Heroku tell you which port to listen on via `$PORT`; locally it falls back to 8000. The `sh -c` wrapper is needed for the variable to expand.
- `@db:5432` in compose → services reach each other by service name on compose's network, not `localhost`.
- `condition: service_healthy` → the API waits until Postgres accepts connections, instead of crashing on the first `create_all`.
- `.dockerignore` keeps `.env` out of the image. Never bake secrets into images.

**Run it**
```bash
docker stop expense-db          # free port 5432 from Step 1's container
docker compose up --build -d
curl -s localhost:8000/health
API_URL=http://localhost:8000 python scripts/seed.py
docker compose logs api --tail 3
```

**You should see**
```text
{"status":"ok"}
Seeded 5 categories and 82 expenses into http://localhost:8000
api-1  | 2026-01-03 11:02:40,118 INFO    app | POST /expenses -> 201 6.4ms id=8f2d...
api-1  | 2026-01-03 11:02:40,127 INFO    app | POST /expenses -> 201 5.9ms id=c01a...
api-1  | 2026-01-03 11:02:40,135 INFO    app | POST /expenses -> 201 6.1ms id=77be...
```

**If it breaks**
- `api-1 exited with code 1` → `docker compose logs api` → usually a typo in `DATABASE_URL` or a missing package in `requirements.txt`.
- `curl: (52) Empty reply from server` → uvicorn bound to `127.0.0.1` → check the `--host 0.0.0.0` in `CMD`.
- Seeded data disappears after `docker compose down -v` → `-v` deletes the `pgdata` volume. Use plain `down` to keep data.

## Step 9 · Deploy to a public URL

**Goal:** the API is live on the internet, backed by a hosted PostgreSQL, and its `/docs` page loads.

We use Render because it builds straight from a Dockerfile in a GitHub repo and offers a free Postgres instance. The steps are almost identical on Fly.io (`fly launch`) or Railway.

```bash title="terminal"
git add .
git commit -m "Expense API: CRUD, conversions, error handling, tests, Docker"
git branch -M main
git remote add origin https://github.com/<your-username>/expense-api.git
git push -u origin main
```

Then, in the Render dashboard (menu names drift; check the current docs):

1. **New → PostgreSQL**. Name it `expense-db`, pick the free plan and the region closest to you. When it is ready, copy the **Internal Database URL**.
2. **New → Web Service**, connect your GitHub repo. Render detects the `Dockerfile`; keep runtime **Docker**.
3. Under **Environment**, add `DATABASE_URL` = the internal URL you copied, and `LOG_LEVEL` = `INFO`.
4. Set **Health Check Path** to `/health`. Create the service and watch the deploy log.

**How this works**
- The internal URL starts with `postgres://`; the `use_psycopg_driver` validator from Step 2 rewrites it, so no manual editing is needed.
- Render injects `PORT`; the `CMD` from Step 8 listens on it.
- The health check path means Render only routes traffic to a new deploy once `/health` returns 200, so a broken build does not replace a working one.
- The lifespan creates tables on first start. For a project you will keep changing, switch to Alembic migrations before your second schema change.

**Run it**
```bash
export API=https://expense-api-xxxx.onrender.com     # Windows PowerShell: $env:API="https://..."
curl -s $API/health
API_URL=$API python scripts/seed.py
curl -s "$API/expenses/1/converted?to=GBP"
```

Also open `$API/docs` in a browser and run one request from it.

**You should see**
```text
{"status":"ok"}
Seeded 5 categories and 82 expenses into https://expense-api-xxxx.onrender.com
{"expense_id":1,"original_amount":"950.00","original_currency":"EUR","converted_amount":"826.14",...}
```

**If it breaks**
- The first request takes 30-60 seconds → free instances sleep when idle and cold-start → expected; mention it in your README.
- Deploy log shows `connection refused` or `could not translate host name` → you used the external URL from a different region, or the DB is still provisioning → use the internal URL and redeploy.
- `ModuleNotFoundError` in the deploy log but tests pass locally → a package you installed by hand is missing from `requirements.txt` → `pip freeze | grep -i <name>`, add it, push.

## Step 10 · Build a feature with a coding agent, and own the result

**Goal:** a `GET /summary` endpoint built with a coding agent, reviewed diff by diff, covered by a test, plus a short write-up of one mistake the agent made.

Coding agents are fast at producing plausible code, and this domain has a classic trap they fall into: summing money across currencies. The habit you are practising is the verification loop: give a precise spec, let the agent work, read every diff, run the tests, and keep what you can explain.

Give your agent this spec (copy it as written):

```text title="agent prompt"
Add GET /summary to app/main.py in this FastAPI + SQLAlchemy 2 project.
- Returns one row per (category name, currency): count of expenses and total amount.
- Optional query param `since: date` filters by spent_on >= since.
- Never add amounts in different currencies together.
- Response model SummaryRow(category: str, currency: str, count: int, total: Decimal) in app/schemas.py.
- Sort by category name, then currency.
- Add tests/test_summary.py using the existing `client` and `category_id` fixtures.
Do not change any other endpoint. Run pytest and show me the output.
```

Review what it produces against this reference. Your version may differ in style; it must not differ in behaviour.

```python title="app/schemas.py (add at the bottom)"
class SummaryRow(BaseModel):
    category: str
    currency: str
    count: int
    total: Decimal
```

In `app/main.py`, change `from sqlalchemy import select` to `from sqlalchemy import func, select`, add `SummaryRow` to the `from app.schemas import ...` line, and add this route at the bottom:

```python title="app/main.py (add at the bottom)"
@app.get("/summary", response_model=list[SummaryRow])
def summary(since: date | None = None, session: Session = Depends(get_session)):
    stmt = (
        select(Category.name, Expense.currency, func.count(Expense.id), func.sum(Expense.amount))
        .join(Expense.category)
        .group_by(Category.name, Expense.currency)
        .order_by(Category.name, Expense.currency)
    )
    if since is not None:
        stmt = stmt.where(Expense.spent_on >= since)
    rows = session.execute(stmt).all()
    return [SummaryRow(category=n, currency=c, count=cnt, total=total) for n, c, cnt, total in rows]
```

```python title="tests/test_summary.py"
from decimal import Decimal


def test_summary_never_mixes_currencies(client, category_id):
    base = {"description": "x", "spent_on": "2026-01-10", "category_id": category_id}
    client.post("/expenses", json={**base, "amount": "10.00", "currency": "EUR"})
    client.post("/expenses", json={**base, "amount": "5.50", "currency": "EUR"})
    client.post("/expenses", json={**base, "amount": "20.00", "currency": "USD"})

    rows = client.get("/summary").json()

    assert [(r["category"], r["currency"], r["count"]) for r in rows] == [
        ("Groceries", "EUR", 2),
        ("Groceries", "USD", 1),
    ]
    assert Decimal(rows[0]["total"]) == Decimal("15.50")
```

```markdown title="AGENT_NOTES.md"
# Working with a coding agent on this repo

## What I delegated
- /summary endpoint and its test (spec in the PR description)
- First draft of the Dockerfile and compose.yaml

## One mistake I caught
**What it did:** <e.g. grouped only by category, so 10 EUR + 20 USD showed as "30">
**How I caught it:** <e.g. reading the diff: no currency in group_by; the test it wrote used one currency only>
**What I changed:** <e.g. grouped by (category, currency) and wrote a two-currency test that failed first>
**What I now put in specs:** <e.g. invariants like "never mix currencies", stated explicitly>
```

**How this code works**
- `func.count(...)`, `func.sum(...)` with `group_by(Category.name, Expense.currency)` → the database does the aggregation in one query, rather than loading every row into Python.
- `.join(Expense.category)` → joins through the relationship defined in `models.py`, so you do not have to restate the foreign key condition.
- The currency in the `group_by` → this is the line to check in the agent's diff. Agents frequently group by category only, or "helpfully" convert everything by calling the rates API in a loop (one HTTP call per row: slow and fragile).
- The test uses **two currencies** on purpose → a test with a single currency passes against the buggy version too. When reviewing an agent's tests, ask: would this test fail if the code were wrong?
- `AGENT_NOTES.md` → the deliverable asks for one real mistake. Common ones on this project: a `Float` column for money, a missing `session.rollback()` after `IntegrityError`, `--host 127.0.0.1` in the Dockerfile, creating an `httpx.AsyncClient` per request, or tests that hit the live rates API.

**Run it**
```bash
pytest -q
curl -s "localhost:8000/summary?since=2026-03-01"
```

**You should see**
```text
.............                                                            [100%]
13 passed in 1.0s
[{"category":"Eating out","currency":"EUR","count":4,"total":"118.07"},{"category":"Eating out","currency":"USD","count":1,"total":"21.40"},...]
```

**If it breaks**
- The agent edited other endpoints or the tests to make them pass → reject the diff and restate "do not change any other endpoint"; agents optimise for green tests, not for your intent.
- `total` comes back as a float like `15.5` → the agent used a plain `float` in `SummaryRow` → change it to `Decimal`.
- `/summary` returns 404 → the route was added below an `if __name__ == "__main__":` block or in a different file → move it into `app/main.py` with the other routes.

## Ship it

Write a README that lets a stranger run the project in five minutes:

- **What it is**: one paragraph and the public URL (plus a note that the free instance cold-starts).
- **Run locally**: `cp .env.example .env`, `docker compose up --build`, `python scripts/seed.py`.
- **Configuration**: a table of `DATABASE_URL`, `RATES_URL`, `RATES_TIMEOUT_S`, `LOG_LEVEL` with defaults.
- **Test**: `pip install -r requirements.txt && pytest -q`, and what the tests cover (list the status codes).
- **Example calls**: three curl commands with real responses, including one error.
- **Error format**: the `{"error": {"code", "message", "request_id"}}` shape and the list of codes.

Demo checklist before you share the link: `/health` is green, `/docs` loads, a converted amount works, a 404 shows the error shape, and the test badge or output is in the README.

For your portfolio write-up, include the numbers: endpoints (8), tests (13) and how long they take, p50 latency of a local `GET /expenses` from your logs versus a conversion call (the outside API usually dominates), image size (`docker images`), and the agent mistake from `AGENT_NOTES.md`.

## Going further

- Add API-key auth with a `users` table and an `owner_id` on expenses, so each key only sees its own data.
- Replace `create_all` with Alembic migrations and add a `notes` column without losing data.
- Add a GitHub Actions workflow that runs `pytest` and `mypy app` on every push.
- Cache exchange rates per (base, target, day) in Postgres so repeated conversions skip the outside call.
- Add `GET /summary?in=EUR` that converts each currency total once (not per row) and reports the rate date used.
