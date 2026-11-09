---
project: voice-or-vision-app
title: Voice or vision app
hours: 12
stack: Python 3.11, Pillow, NumPy, pypdfium2, OpenAI-compatible vision model, pydantic v2, FastAPI, Docker, Hugging Face Spaces (voice track - faster-whisper, pyttsx3/Piper)
cost: About $0.10-0.50 to evaluate 30-60 receipts with a small vision model; hosting free on Hugging Face Spaces
---

You will ship a **receipt reader**: upload a phone photo or a PDF of a receipt and get back validated, structured data
(merchant, date, currency, line items, subtotal, tax, total) with warnings when the arithmetic does not add up. It
refuses blurry photos before paying for a model call, retries sideways photos, and handles multi-page PDFs. Your README
will report field-level accuracy on 30+ labelled receipts, p50/p95 latency and cost per image, plus a demo video on
real receipts. Each step also has a **voice track** note for building a spoken expense logger instead
(faster-whisper → LLM extraction → text-to-speech), measured on time to first audio.

## Before you start
- Python 3.11+, Docker, an API key for a vision-capable model (`gpt-4o-mini` works and is cheap; locally, Ollama with `qwen2.5vl` or `llama3.2-vision` via `BASE_URL=http://localhost:11434/v1`).
- A free Hugging Face account for hosting.
- **Pick one track.** Vision (this guide's main path) is easier to measure and to demo reliably on a free host. Voice is more impressive live but needs care with latency and audio I/O. Do not build both; a finished, measured single track beats two half-built ones.
- Builds on the structured-output project (validated JSON with retries) and the deployment basics from earlier levels.

```text title="final layout"
receipts/
├── app/
│   ├── schema.py       # Receipt model + arithmetic checks
│   ├── preprocess.py   # EXIF rotation, resize, contrast, blur score, PDF pages
│   ├── vision.py       # vision model call -> validated Receipt
│   ├── pipeline.py     # blur gate, rotation retry, warnings
│   └── api.py          # FastAPI + upload page
├── data/fetch_cord.py  # 30 labelled public receipts
├── data/images/ · data/labels.jsonl
├── eval/run_eval.py
├── tests/test_pipeline.py
├── voice/expense_logger.py   # voice track alternative
└── Dockerfile
```

## How it fits together

```text
 photo / PDF ──► load_pages ──► EXIF rotate · RGB · ≤1600 px · autocontrast
                                   │
                         blur score < threshold? ── yes ──► "retake" (no model call, $0)
                                   │ no
                                   ▼
             vision model (JSON mode, schema in prompt) ──► pydantic Receipt (retry once on invalid JSON)
                                   │
                total missing / illegible? ── yes ──► retry rotated 90°
                                   ▼
             arithmetic checks (items vs subtotal, subtotal + tax vs total, future date)
                                   ▼
             {status: ok | needs_review, receipt, warnings, latency_ms, cost_usd}
```

An upload becomes one or more normalised images. A cheap local sharpness check rejects photos that would only produce
guesses. The images go to a vision model with the JSON schema in the prompt, and the reply must validate as a
`Receipt`. If the model cannot find a total, the pipeline tries once more with the image turned sideways. Finally,
plain arithmetic flags receipts a human should check, and every response carries its latency and cost.

## Step 1 · Choose the track and define the output
**Goal:** a schema for the data you will extract and the checks that decide when a human should look.

The schema is the product. Fields are optional because real receipts are missing things; `legible` gives the model an
honest way to say "I can't read this" instead of inventing numbers.

```bash title="terminal"
mkdir receipts && cd receipts
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install "openai>=1.40" "pydantic>=2.7" pillow numpy pypdfium2 fastapi uvicorn python-multipart pytest
mkdir -p app data/images eval tests voice && touch app/__init__.py
printf "[pytest]\npythonpath = .\n" > pytest.ini
```

```python title="app/schema.py"
import datetime as dt

from pydantic import BaseModel, Field, field_validator


class LineItem(BaseModel):
    description: str
    quantity: float = Field(default=1, gt=0)
    amount: float = Field(description="line total as printed")


class Receipt(BaseModel):
    merchant: str | None = None
    date: dt.date | None = Field(default=None, description="purchase date, YYYY-MM-DD")
    currency: str | None = Field(default=None, description="ISO 4217 code, e.g. USD, EUR, IDR")
    line_items: list[LineItem] = Field(default_factory=list)
    subtotal: float | None = None
    tax: float | None = None
    total: float | None = Field(default=None, description="the final amount paid")
    legible: bool = Field(default=True, description="false if the image is too blurry, cut off or not a receipt")

    @field_validator("currency")
    @classmethod
    def upper_currency(cls, v: str | None) -> str | None:
        return v.strip().upper()[:3] if v else v


def consistency_warnings(r: Receipt, tolerance: float = 0.02) -> list[str]:
    """Arithmetic checks a human bookkeeper would do. Warnings, not errors: receipts have discounts and tips."""
    warnings: list[str] = []
    if r.total is None:
        warnings.append("no total found")
        return warnings
    items = sum(i.amount for i in r.line_items)
    if r.line_items and r.subtotal is not None and abs(items - r.subtotal) > tolerance * max(r.subtotal, 1):
        warnings.append(f"line items sum to {items:.2f} but subtotal is {r.subtotal:.2f}")
    if r.subtotal is not None and r.tax is not None and abs(r.subtotal + r.tax - r.total) > tolerance * max(r.total, 1):
        warnings.append(f"subtotal + tax = {r.subtotal + r.tax:.2f} but total is {r.total:.2f}")
    if r.date and r.date > dt.date.today():
        warnings.append(f"date {r.date} is in the future")
    return warnings
```

**How this code works**
- `import datetime as dt` and `date: dt.date` → a field named `date` with the type `date` makes pydantic resolve the annotation to the field itself and fail. Importing the module under an alias avoids the clash, a classic bug.
- `total` has a description that says "the final amount paid". Receipts print several totals (subtotal, total, cash, change); field descriptions are instructions to the model.
- `upper_currency` normalises `usd` / `USD ` to `USD`, so evaluation compares like with like.
- `consistency_warnings` returns warnings, not errors. Discounts, tips and rounding break naive arithmetic, so the result is "needs review", not a rejection. A 2% tolerance absorbs rounding.

**Voice track alternative:** define an `Expense` model instead (amount, currency, merchant, category as a `Literal`, date), as in `voice/expense_logger.py` in Step 4. Your "consistency check" is that the amount is positive and the date is not in the future.

**Run it**
```bash title="terminal"
python -c "
from app.schema import Receipt, LineItem, consistency_warnings
r = Receipt(total=12.0, subtotal=10.0, tax=0.8, line_items=[LineItem(description='latte', amount=10.0)], currency='usd')
print(r.currency, consistency_warnings(r))"
```

**You should see**
```text
USD ['subtotal + tax = 10.80 but total is 12.00']
```

**If it breaks**
- `TypeError: unsupported operand type(s) for |: 'FieldInfo' and 'NoneType'` → you wrote `from datetime import date` and a field called `date`. Use the `dt` alias as shown.

## Step 2 · Get labelled data
**Goal:** at least 30 receipt images with ground-truth labels in `data/labels.jsonl`.

Start with a public set so you have numbers on day one, then add your own photos, which are what your demo will
actually face. CORD-v2 has Indonesian receipts with labelled totals and line items.

```python title="data/fetch_cord.py"
"""Download 30 labelled receipts from the CORD-v2 test split (Indonesian receipts, CC BY 4.0)."""
import json
import re
from pathlib import Path

from datasets import load_dataset  # pip install datasets; check the current docs

out = Path("data/images")
out.mkdir(parents=True, exist_ok=True)
rows = []
for i, ex in enumerate(load_dataset("naver-clova-ix/cord-v2", split="test").select(range(30))):
    gt = json.loads(ex["ground_truth"])["gt_parse"]
    total_text = str((gt.get("total") or {}).get("total_price") or "")
    menu = gt.get("menu") or []
    name = f"cord_{i:03d}.png"
    ex["image"].save(out / name)
    rows.append({
        "file": name,
        "total": int(re.sub(r"\D", "", total_text)) if re.search(r"\d", total_text) else None,
        "n_items": len(menu) if isinstance(menu, list) else 1,
        "currency": "IDR",
    })
with open("data/labels.jsonl", "w", encoding="utf-8") as f:
    f.writelines(json.dumps(r) + "\n" for r in rows)
print(f"saved {len(rows)} images; {sum(r['total'] is not None for r in rows)} have a labelled total")
```

Then photograph 10-30 of your own receipts (crumpled, angled, one blurry, one sideways, one long) and add a line per
image by hand, filling only the fields you checked:

```json title="data/labels.jsonl (your own rows)"
{"file": "own_001.jpg", "total": 23.45, "currency": "EUR", "date": "2026-10-02", "merchant": "Lidl", "n_items": 6}
{"file": "own_002.jpg", "total": 4.2, "currency": "GBP", "date": "2026-10-05", "merchant": "Pret", "n_items": 2}
```

**How this code works**
- `gt_parse` is CORD's structured ground truth. `total_price` is a string like `"60.000"`, so we keep the digits only (IDR has no minor unit). # check the current docs for the dataset fields
- `menu` is a list of line items, or a single dict when there is only one, hence the `isinstance` check.
- Labels are per field, and missing labels are skipped in the eval, so your own rows can label more fields (merchant, date) than CORD does.
- Remove anything personal (card digits, loyalty numbers) from your own photos before committing them, or keep them out of the public repo and publish only the scores.

**Run it**
```bash title="terminal"
pip install datasets
python data/fetch_cord.py
head -2 data/labels.jsonl
```

**You should see**
```text
saved 30 images; 30 have a labelled total
{"file": "cord_000.png", "total": 45500, "n_items": 3, "currency": "IDR"}
{"file": "cord_001.png", "total": 1347000, "n_items": 6, "currency": "IDR"}
```

**If it breaks**
- `DatasetNotFoundError` → the dataset id moved; search the Hugging Face Hub for "cord-v2". Any receipt dataset with totals works; adapt the field names.

**Voice track alternative:** record 30 short clips (`"spent twelve fifty at Pret on lunch"`) across at least three speakers, accents and a noisy room, and label each with the expected `Expense` JSON.

## Step 3 · Preprocess images and detect blur
**Goal:** every upload becomes upright, right-sized images, with a sharpness score computed locally.

```python title="app/preprocess.py"
import io

import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 1600
BLUR_THRESHOLD = 60.0  # tune on your own photos (Step 6)


def blur_score(img: Image.Image) -> float:
    """Variance of the Laplacian: low means few sharp edges, i.e. blurry."""
    g = np.asarray(img.convert("L").resize((800, int(800 * img.height / img.width))), dtype=np.float32)
    lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:])
    return float(lap.var())


def prepare(img: Image.Image) -> Image.Image:
    img = ImageOps.exif_transpose(img)          # phone photos store rotation in EXIF
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))         # keeps aspect ratio, never upscales
    return ImageOps.autocontrast(img, cutoff=1)


def load_pages(filename: str, data: bytes, max_pages: int = 4) -> list[Image.Image]:
    """Images from a photo or a (multi-page) PDF, ready for the model."""
    if filename.lower().endswith(".pdf"):
        import pypdfium2 as pdfium  # check the current docs

        pdf = pdfium.PdfDocument(data)
        pages = [pdf[i].render(scale=2).to_pil() for i in range(min(len(pdf), max_pages))]
    else:
        pages = [Image.open(io.BytesIO(data))]
    return [prepare(p) for p in pages]


def to_jpeg(img: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()
```

**How this code works**
- `ImageOps.exif_transpose` → phones save portrait photos as landscape pixels plus an EXIF "rotate 90°" tag. Browsers honour the tag; models receive raw pixels. Without this line many phone photos arrive sideways.
- `thumbnail((1600, 1600))` → vision models bill by image tiles. A 4000 px photo costs several times more than 1600 px and is rarely more accurate for receipts. Measure this in Step 7 if you doubt it.
- `autocontrast(cutoff=1)` → stretches faded thermal-paper text toward black and white.
- `blur_score` is the variance of the Laplacian (a second-derivative filter written with NumPy slicing): sharp text has strong edges, so high variance; a blurry photo has almost none. Resizing to 800 px first makes the score comparable across resolutions.
- `load_pages` renders up to 4 PDF pages at 2× scale, which keeps small print readable.

**Run it**
```bash title="terminal"
python -c "
from PIL import Image, ImageFilter
from app.preprocess import blur_score, prepare
img = prepare(Image.open('data/images/cord_000.png'))
print(img.size, round(blur_score(img)), round(blur_score(img.filter(ImageFilter.GaussianBlur(4)))))"
```

**You should see**
```text
(864, 1296) 412 9
```

**If it breaks**
- `UnidentifiedImageError` on an iPhone photo → it is HEIC. `pip install pillow-heif` and call `pillow_heif.register_heif_opener()` at the top of `preprocess.py`.

**Voice track alternative:** the equivalent step is audio normalisation: convert to 16 kHz mono WAV (`ffmpeg -i in.m4a -ar 16000 -ac 1 clip.wav`) and use faster-whisper's `vad_filter=True` to trim silence, which cuts transcription time on short clips.

## Step 4 · Call the vision model and validate the result
**Goal:** `extract(pages)` returns a validated `Receipt` plus latency, tokens and cost.

```python title="app/vision.py"
import base64
import json
import os
import time

from openai import OpenAI
from pydantic import ValidationError

from app.preprocess import to_jpeg
from app.schema import Receipt

MODEL = os.getenv("VISION_MODEL", "gpt-4o-mini")  # any vision-capable model; check the current docs
PRICE_IN = float(os.getenv("PRICE_IN_PER_M", "0.15"))
PRICE_OUT = float(os.getenv("PRICE_OUT_PER_M", "0.60"))
client = OpenAI(base_url=os.getenv("BASE_URL") or None, api_key=os.getenv("OPENAI_API_KEY", "not-needed"), timeout=90)

PROMPT = f"""Read this receipt (all pages belong to ONE receipt) and return ONE JSON object matching this schema:
{json.dumps(Receipt.model_json_schema())}
Rules:
- Copy numbers exactly as printed, as plain numbers without currency symbols or thousands separators.
- In currencies without decimals (IDR, JPY, KRW) a value printed '60.000' or '60,000' means 60000.
- Use null for anything you cannot read. Never guess a total.
- Set legible=false if the image is too blurry, cut off, or not a receipt."""


def extract(pages, retries: int = 1) -> tuple[Receipt, dict]:
    content = [{"type": "text", "text": PROMPT}] + [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(to_jpeg(p)).decode()}}
        for p in pages
    ]
    messages = [{"role": "user", "content": content}]
    start, tokens_in, tokens_out = time.perf_counter(), 0, 0
    for _ in range(retries + 1):
        resp = client.chat.completions.create(model=MODEL, messages=messages, temperature=0,
                                              response_format={"type": "json_object"})
        if resp.usage:
            tokens_in += resp.usage.prompt_tokens
            tokens_out += resp.usage.completion_tokens
        raw = resp.choices[0].message.content or ""
        try:
            receipt = Receipt.model_validate_json(raw)
            break
        except ValidationError as err:
            messages += [{"role": "assistant", "content": raw},
                         {"role": "user", "content": f"That JSON is invalid:\n{err}\nReturn corrected JSON only."}]
    else:
        receipt = Receipt(legible=False)  # never valid: treat as unreadable rather than crash
    meta = {"model": MODEL, "latency_ms": round((time.perf_counter() - start) * 1000),
            "tokens_in": tokens_in, "tokens_out": tokens_out,
            "cost_usd": (tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6}
    return receipt, meta
```

**How this code works**
- Images go in as base64 `data:` URLs inside a multi-part user message, the format OpenAI-compatible vision endpoints accept. Several pages are several image parts in the same message.
- The JSON schema is generated from the pydantic model and pasted into the prompt, so the prompt can never drift from the validator.
- The rules carry the domain knowledge that moves accuracy: no thousands separators, the `60.000` convention for currencies without decimals, and "never guess a total".
- `response_format={"type": "json_object"}` → asks for syntactically valid JSON. Pydantic then checks it is the *right* JSON; one retry shows the model its validation error.
- The `for ... else` falls back to `Receipt(legible=False)` if the model never produces valid JSON, so one bad response becomes "needs review" instead of a 500.
- Cost comes from reported usage, which for vision includes the image tokens. That number is the most surprising one in your README for most readers.

**Run it**
```bash title="terminal"
export OPENAI_API_KEY=sk-...
python -c "
from pathlib import Path
from app.preprocess import load_pages
from app.vision import extract
r, meta = extract(load_pages('x.png', Path('data/images/cord_000.png').read_bytes()))
print(r.model_dump_json(exclude_none=True)[:300]); print(meta)"
```

**You should see**
```text
{"merchant":"...","currency":"IDR","line_items":[{"description":"NASI GORENG","quantity":1.0,"amount":25000.0},...],"total":45500.0,"legible":true}
{'model': 'gpt-4o-mini', 'latency_ms': 3120, 'tokens_in': 9012, 'tokens_out': 142, 'cost_usd': 0.00143}
```

**If it breaks**
- `400 ... image_url is only supported by certain models` → `VISION_MODEL` is a text-only model. Pick a vision model.
- `total` is 45.5 instead of 45500 → the model read the dot as a decimal point. That is exactly the error the prompt rule targets; it will still happen sometimes, and the eval will count it.

**Voice track alternative:** the core loop is speech-to-text, LLM extraction into the schema, then text-to-speech confirmation. The whole thing fits in one file:

```python title="voice/expense_logger.py"
"""Voice track: say an expense, get it validated, logged and read back. Usage: python voice/expense_logger.py clip.wav"""
import datetime as dt
import json
import os
import sys
import time
from typing import Literal

import pyttsx3  # offline TTS; Piper or a cloud TTS sounds better. check the current docs
from faster_whisper import WhisperModel  # pip install faster-whisper; check the current docs
from openai import OpenAI
from pydantic import BaseModel, Field


class Expense(BaseModel):
    amount: float = Field(gt=0)
    currency: str = "USD"
    merchant: str | None = None
    category: Literal["food", "transport", "housing", "shopping", "health", "other"]
    date: dt.date


client = OpenAI(base_url=os.getenv("BASE_URL") or None, api_key=os.getenv("OPENAI_API_KEY", "not-needed"))
stt = WhisperModel(os.getenv("WHISPER_SIZE", "small"), device="cpu", compute_type="int8")


def log_expense(wav_path: str) -> Expense:
    t0 = time.perf_counter()
    segments, _ = stt.transcribe(wav_path, vad_filter=True, language="en")
    text = " ".join(s.text.strip() for s in segments)
    t_stt = time.perf_counter()

    resp = client.chat.completions.create(
        model=os.getenv("MODEL", "gpt-4o-mini"), temperature=0, response_format={"type": "json_object"},
        messages=[{"role": "system", "content": f"Today is {dt.date.today()}. Extract the expense as JSON "
                                                f"matching {json.dumps(Expense.model_json_schema())}"},
                  {"role": "user", "content": text}])
    expense = Expense.model_validate_json(resp.choices[0].message.content or "{}")
    t_llm = time.perf_counter()

    reply = f"Logged {expense.amount:g} {expense.currency} at {expense.merchant or 'an unknown place'} for {expense.category}."
    engine = pyttsx3.init()
    engine.save_to_file(reply, "reply.wav")
    engine.runAndWait()
    t_tts = time.perf_counter()
    print(f"heard: {text!r}\n{expense.model_dump_json()}\n"
          f"stt={1000 * (t_stt - t0):.0f} ms  llm={1000 * (t_llm - t_stt):.0f} ms  "
          f"tts={1000 * (t_tts - t_llm):.0f} ms  time to audio={1000 * (t_tts - t0):.0f} ms")
    return expense


if __name__ == "__main__":
    log_expense(sys.argv[1])
```

Install with `pip install faster-whisper pyttsx3`. The printed `time to audio` is your headline metric; the stage breakdown shows where to optimise (usually a smaller Whisper model, or streaming the LLM reply into TTS sentence by sentence). For interruption handling, stop playback when the microphone's voice-activity detector fires.

## Step 5 · The pipeline: hard cases first
**Goal:** one function that gates blurry input, retries sideways photos and flags inconsistent results.

```python title="app/pipeline.py"
from app import vision
from app.preprocess import BLUR_THRESHOLD, blur_score, load_pages
from app.schema import consistency_warnings


def read_receipt(filename: str, data: bytes) -> dict:
    pages = load_pages(filename, data)
    sharpness = min(blur_score(p) for p in pages)
    if sharpness < BLUR_THRESHOLD:
        # Do not pay for a model call that would guess: ask for a better photo instead.
        return {"status": "retake", "reason": f"image looks blurry (sharpness {sharpness:.0f})", "pages": len(pages)}

    receipt, meta = vision.extract(pages)
    if not receipt.legible or receipt.total is None:
        # Hard case: sideways photos with no EXIF tag. Try once at 90 degrees before giving up.
        rotated, meta2 = vision.extract([p.rotate(90, expand=True) for p in pages])
        meta = {**meta2, "latency_ms": meta["latency_ms"] + meta2["latency_ms"],
                "cost_usd": meta["cost_usd"] + meta2["cost_usd"], "rotated_retry": True}
        if rotated.total is not None:
            receipt = rotated

    warnings = consistency_warnings(receipt)
    status = "ok" if receipt.legible and not warnings else "needs_review"
    return {"status": status, "receipt": receipt.model_dump(mode="json"), "warnings": warnings,
            "pages": len(pages), "sharpness": round(sharpness), **meta}
```

**How this code works**
- **Blurry** → refuse before the model call. It saves money and gives a better user experience: "retake the photo" now beats a confident wrong total later.
- **Sideways** → EXIF fixes most rotation, but screenshots, scans and re-saved images have no tag. If the model finds no total or says illegible, one retry at 90° costs one more call only on the hard cases. `rotate(90, expand=True)` keeps the whole image instead of cropping it.
- **Multi-page** → `load_pages` already returns every page, and `min(blur_score ...)` means one blurry page triggers a retake.
- **Inconsistent** → arithmetic warnings set `status: needs_review`. In a real expense tool, that sends the receipt to a human queue rather than straight to the books.
- Latency and cost of the retry are added to the first call's, so the metrics show what the user actually waited and paid.

**Run it**
```bash title="terminal"
python -c "
from pathlib import Path
from PIL import Image
from app.pipeline import read_receipt
img = Image.open('data/images/cord_000.png').rotate(90, expand=True); img.save('data/sideways.png')
for f in ['data/images/cord_000.png', 'data/sideways.png']:
    r = read_receipt(f, Path(f).read_bytes()); print(r['status'], r['receipt']['total'], r.get('rotated_retry', False), r['latency_ms'])"
```

**You should see**
```text
ok 45500.0 False 3050
ok 45500.0 True 6870
```
(The sideways image may also be read correctly on the first try; strong models often cope. Either way you can now see it in the output.)

**If it breaks**
- Every upload comes back `retake` → `BLUR_THRESHOLD` is too high for your images. Step 7 shows how to tune it.

**Voice track alternative:** the hard cases are noise, accents and the user talking over the reply. Test with a fan running, with a second speaker, and by interrupting; add a confirmation turn ("Did you say 12.50?") when the transcription's average log-probability is low.

## Step 6 · Tests for the hard cases
**Goal:** offline tests proving the blur gate, the downscaling, the arithmetic checks and the rotation retry.

```python title="tests/test_pipeline.py"
from datetime import date, timedelta

from PIL import Image, ImageDraw, ImageFilter

from app import pipeline, vision
from app.preprocess import BLUR_THRESHOLD, blur_score, prepare, to_jpeg
from app.schema import LineItem, Receipt, consistency_warnings


def receipt_image() -> Image.Image:
    img = Image.new("RGB", (900, 1400), "white")
    draw = ImageDraw.Draw(img)
    for y in range(40, 1360, 40):
        draw.text((40, y), "LATTE 1 x 4.50      4.50   TOTAL 12.30", fill="black")
    return img


def test_blur_detection_separates_sharp_from_blurry():
    sharp = receipt_image()
    assert blur_score(sharp) > BLUR_THRESHOLD > blur_score(sharp.filter(ImageFilter.GaussianBlur(4)))


def test_prepare_downscales_large_photos():
    assert max(prepare(Image.new("RGB", (4000, 3000))).size) == 1600


def test_consistency_checks():
    good = Receipt(total=10.8, subtotal=10.0, tax=0.8, line_items=[LineItem(description="a", amount=10.0)])
    assert consistency_warnings(good) == []
    bad = Receipt(total=99.0, subtotal=10.0, tax=0.8, date=date.today() + timedelta(days=3))
    assert len(consistency_warnings(bad)) == 2


def test_blurry_upload_skips_the_model(monkeypatch):
    called = []
    monkeypatch.setattr(vision, "extract", lambda pages: called.append(1))
    blurry = to_jpeg(receipt_image().filter(ImageFilter.GaussianBlur(6)))
    assert pipeline.read_receipt("r.jpg", blurry)["status"] == "retake" and not called


def test_sideways_photo_gets_a_rotated_retry(monkeypatch):
    calls = []

    def fake_extract(pages):
        calls.append(pages[0].size)
        found = Receipt(total=12.3) if len(calls) == 2 else Receipt(legible=False)
        return found, {"model": "fake", "latency_ms": 5, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}

    monkeypatch.setattr(vision, "extract", fake_extract)
    result = pipeline.read_receipt("r.jpg", to_jpeg(receipt_image()))
    assert result["receipt"]["total"] == 12.3 and result["rotated_retry"]
    assert calls[0] == calls[1][::-1]  # the second call saw the image turned 90 degrees
```

**How this code works**
- `receipt_image()` draws a synthetic receipt, so tests need no files and no network.
- `test_blurry_upload_skips_the_model` replaces `vision.extract` with a function that records calls, proving the gate saves the model call, not just that it returns "retake".
- `test_sideways_photo_gets_a_rotated_retry` makes the fake model fail on the first call and succeed on the second, then checks that the second call received the image with width and height swapped.

**Run it**
```bash title="terminal"
pytest -q
```

**You should see**
```text
.....                                                                    [100%]
5 passed in 1.2s
```

**If it breaks**
- `test_blur_detection...` fails → you changed `BLUR_THRESHOLD`; the synthetic images score roughly 1,900 (sharp) and under 1 (blurred), so any threshold between 5 and 500 passes.

## Step 7 · Measure field accuracy, latency and cost
**Goal:** a results table for the README, and a list of misses to learn from.

```python title="eval/run_eval.py"
"""Field-level accuracy, latency and cost over data/labels.jsonl."""
import json
import statistics
from pathlib import Path

from app.pipeline import read_receipt

labels = [json.loads(line) for line in open("data/labels.jsonl", encoding="utf-8")]
FIELDS = ["total", "currency", "n_items", "date", "merchant"]
correct = {f: 0 for f in FIELDS}
counted = {f: 0 for f in FIELDS}
latencies, costs, misses, retakes = [], [], [], 0
EMPTY = {"total": None, "line_items": [], "merchant": None, "currency": None, "date": None}


def matches(field: str, label, receipt: dict) -> bool:
    if field == "total":
        return receipt["total"] is not None and abs(receipt["total"] - label) <= max(0.01, 0.005 * label)
    if field == "n_items":
        return len(receipt["line_items"]) == label
    if field == "merchant":
        return bool(receipt["merchant"]) and label.lower() in receipt["merchant"].lower()
    return str(receipt.get(field) or "").upper() == str(label).upper()


for row in labels:
    result = read_receipt(row["file"], Path("data/images", row["file"]).read_bytes())
    if result["status"] == "retake":
        retakes += 1
        receipt = EMPTY
    else:
        receipt = result["receipt"]
        latencies.append(result["latency_ms"])
        costs.append(result["cost_usd"])
    for field in FIELDS:
        if row.get(field) is None:
            continue  # this image has no label for that field
        counted[field] += 1
        if matches(field, row[field], receipt):
            correct[field] += 1
        else:
            got = len(receipt["line_items"]) if field == "n_items" else receipt.get(field)
            misses.append({"file": row["file"], "field": field, "label": row[field], "got": got,
                           "status": result["status"]})

lat = sorted(latencies) or [0]
print(f"images={len(labels)}  retake={retakes}  p50={statistics.median(lat):.0f} ms  "
      f"p95={lat[int(0.95 * (len(lat) - 1))]:.0f} ms  cost/image=${statistics.mean(costs or [0]):.4f}\n")
print("| Field | Accuracy | n |\n|---|---|---|")
for field in FIELDS:
    if counted[field]:
        print(f"| {field} | {correct[field] / counted[field]:.0%} | {counted[field]} |")
Path("eval/misses.jsonl").write_text("".join(json.dumps(m) + "\n" for m in misses), encoding="utf-8")
print(f"\n{len(misses)} misses written to eval/misses.jsonl")
```

**How this code works**
- Each field has its own match rule: totals within 0.5% (or one cent), line-item count exact, merchant as a case-insensitive substring, everything else exact.
- Fields without a label for an image are skipped, so CORD rows and your own rows can be mixed.
- A `retake` counts as wrong on every labelled field. That is honest: the user did not get data. Report the retake count separately so readers can see why.
- `eval/misses.jsonl` is where the insight is. Group the misses by cause (decimal-separator confusion, subtotal read as total, item lines merged) and put the top three in the README.
- Tune `BLUR_THRESHOLD` here: print `sharpness` for your own photos, set the threshold just below the blurriest one that was read correctly, and rerun.

**Run it**
```bash title="terminal"
python -m eval.run_eval | tee eval/results.md
```

**You should see** (your numbers will differ)
```text
images=40  retake=1  p50=3180 ms  p95=6420 ms  cost/image=$0.0016

| Field | Accuracy | n |
|---|---|---|
| total | 88% | 40 |
| currency | 95% | 40 |
| n_items | 70% | 40 |
| date | 90% | 10 |
| merchant | 80% | 10 |

9 misses written to eval/misses.jsonl
```

**If it breaks**
- `ModuleNotFoundError: eval` → run with `python -m eval.run_eval` from the project root (the folder needs no `__init__.py` on Python 3.11+, but it must be run as a module).
- Accuracy on `total` is far below 80% for CORD → check a few misses; if they are all 1000x off, the model ignores the separator rule. Try a stronger model and report both in a comparison table.

**Voice track alternative:** measure word error rate (`pip install jiwer`; `jiwer.wer(reference, hypothesis)`) on your 30 clips, field accuracy of the extracted `Expense`, and p50/p95 of time to first audio. Report them split by quiet versus noisy clips.

## Step 8 · Serve it and deploy
**Goal:** a public upload page that works from a phone camera.

```python title="app/api.py"
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from PIL import UnidentifiedImageError

from app.pipeline import read_receipt

app = FastAPI(title="Receipt reader")
MAX_BYTES = 8 * 1024 * 1024
PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt reader</title>
<style>body{font:16px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem}
pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem}</style></head><body>
<h1>Receipt reader</h1><p>Upload a photo or PDF of a receipt. Files are processed in memory and not stored.</p>
<input id="f" type="file" accept="image/*,.pdf" capture="environment"><pre id="out"></pre>
<script>
document.getElementById("f").onchange = async e => {
  const out = document.getElementById("out"); out.textContent = "Reading...";
  const fd = new FormData(); fd.append("file", e.target.files[0]);
  const r = await fetch("/receipts", {method: "POST", body: fd});
  out.textContent = JSON.stringify(await r.json(), null, 2);
};
</script></body></html>"""


@app.post("/receipts")
async def receipts(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file too large (8 MB max)")
    try:
        return read_receipt(file.filename or "upload.jpg", data)
    except UnidentifiedImageError:
        raise HTTPException(400, "not an image or PDF we can read")


@app.get("/", response_class=HTMLResponse)
def home():
    return PAGE
```

```dockerfile title="Dockerfile"
FROM python:3.11-slim
WORKDIR /srv
RUN pip install --no-cache-dir "openai>=1.40" "pydantic>=2.7" pillow numpy pypdfium2 fastapi uvicorn python-multipart
COPY app ./app
ENV PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "7860"]
```

**How this code works**
- `capture="environment"` on the file input opens the rear camera on phones, which makes the demo feel like an app.
- Files are read into memory and never written to disk: say so on the page. Receipts contain card digits and locations, and "we don't store your upload" is a privacy decision worth stating.
- The 8 MB limit and the `UnidentifiedImageError` handler turn bad uploads into clear 4xx errors.
- Port 7860 is what Hugging Face Docker Spaces expect. On Fly.io or Render, change it to their port.

**Run it**
```bash title="terminal"
uvicorn app.api:app --reload --port 7860      # open http://localhost:7860 on your laptop or phone (same Wi-Fi)
docker build -t receipts . && docker run -p 7860:7860 -e OPENAI_API_KEY receipts
```
To deploy: create a new Space on Hugging Face (SDK: Docker), push this folder to it with git, and add `OPENAI_API_KEY` under Settings → Variables and secrets. Set a monthly spend limit with your provider, too.

**You should see**
```text
{
  "status": "ok",
  "receipt": {"merchant": "Pret A Manger", "date": "2026-11-03", "currency": "GBP", "line_items": [...], "total": 7.85, "legible": true},
  "warnings": [],
  "pages": 1,
  "sharpness": 388,
  "model": "gpt-4o-mini",
  "latency_ms": 2890,
  "cost_usd": 0.0014
}
```

**If it breaks**
- The Space builds but shows "Application not responding" → the app is not listening on `0.0.0.0:7860`.
- Uploads from a phone fail with 413 → modern phone photos can exceed 8 MB; resize in the browser first or raise the limit.

**Voice track alternative:** deploy the voice logger as a Gradio app on a Hugging Face Space (`gr.Audio(sources=["microphone"])` in, `gr.Audio` out) or behind a phone number with a telephony provider's media-stream API. Report time to first audio measured from the hosted version, not your laptop.

## Ship it
- **README, results first:** one line ("Photo of a receipt in, validated expense data out, in about 3 seconds for $0.0015"), the live Space link and a 2-minute video; the architecture diagram; the accuracy table with n per field, p50/p95 latency and cost per image; the hard cases you handled (blur gate, rotation retry, multi-page PDFs, arithmetic review) each with a before/after example; the top three failure causes from `misses.jsonl`.
- **Demo video:** a real crumpled receipt from your pocket, a blurry one getting "retake", a sideways one being read, a PDF invoice, and a receipt that comes back `needs_review` with the warning shown.
- **Key decisions:** downscale to 1600 px (cost), blur gate before the model (cost and honesty), warnings rather than rejections, no image storage (privacy).

## Going further
- Compare two vision models (a small hosted one and a local `qwen2.5vl`) on accuracy, p95 latency and cost per image in one table.
- Add a tool call to a real system: write accepted receipts to a Google Sheet or an expenses database after the user confirms the extracted fields.
- Add an OCR baseline (Tesseract text, then a text-only LLM) and show where the vision model wins and where OCR is cheaper.
- Detect and crop the receipt from a cluttered background (largest bright quadrilateral) before sending it, and measure the accuracy change.
- Voice track: stream TTS sentence by sentence and add barge-in, then report the change in time to first audio.
