---
project: multimodal-app
title: A multimodal app on real inputs
hours: 10
stack: Python 3.11, openai SDK (any OpenAI-compatible vision + speech endpoint), Pillow, numpy, ffmpeg, pydantic, FastAPI, optional faster-whisper and Hugging Face datasets
cost: About $1-3 of API calls for 50 receipts and voice notes (estimate); free with local models (Ollama vision model + faster-whisper)
---

You will build an expense-capture app that takes two inputs people actually produce on the move: a phone photo of a
receipt and a short voice note ("client lunch with Acme, three of us"). It reads the receipt with a vision model,
transcribes the note with a speech model, merges both into one expense record, and flags anything it is not sure about
instead of inventing it. You will test it on 20-50 messy real inputs, measure accuracy and per-modality latency and
cost, write up one real failure, and package it so someone else can run it on their own receipts. The same skeleton
works for any image + audio build (inspection reports, field notes, delivery proofs).

## Before you start
- Python 3.11+ and ffmpeg (`ffmpeg -version`; install with `brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`).
- An OpenAI-compatible endpoint with a vision model and a speech-to-text model. Examples use `gpt-4o-mini` and `whisper-1`, read from env. Fully local option: Ollama with a vision model (`ollama pull qwen2.5vl:7b`) and `STT_BACKEND=local` (faster-whisper on CPU).
- Your phone: you will photograph receipts and record voice notes. Real, crumpled, badly lit receipts are the point.
- Builds on Level 13 lessons on vision failures, schema-first document extraction and speech-to-text.

```text title="final folder structure"
expense-capture/
├── .env.example
├── SCOPE.md
├── FAILURES.md
├── README.md
├── data/
│   ├── inputs/            # r001.jpg, r001.m4a, ... and cord_000.jpg ...
│   └── labels.jsonl       # hand-written ground truth
├── scripts/fetch_cord.py
├── app/
│   ├── __init__.py
│   ├── config.py
│   ├── schema.py
│   ├── images.py          # orientation, resize, quality checks
│   ├── vision.py          # receipt -> structured fields
│   ├── audio.py           # convert, silence check, transcribe, parse note
│   ├── fuse.py            # merge + validation rules
│   ├── pipeline.py        # orchestration + per-modality metrics
│   └── server.py          # FastAPI endpoint
├── evals/run_eval.py
├── tests/test_checks.py
└── results/
```

## How it fits together

```text
 receipt.jpg ──> images.py (rotate, resize, blur/dark check) ──> vision.py (JSON fields + evidence) ──┐
                                                                                                     ├─> fuse.py ──> Expense
 note.m4a ────> audio.py (ffmpeg 16 kHz, silence check) ──> speech-to-text ──> note parser (JSON) ───┘   (warnings, needs_review)
                                         every stage timed and costed in pipeline.py ──> evals/run_eval.py
```

The photo is rotated upright, shrunk to a size the model handles well, and checked for blur and darkness. The vision
model returns structured fields plus the exact text it read for the total. In parallel, the voice note is converted to
16 kHz mono, checked for silence (speech models invent text on silence), transcribed and parsed into category and
purpose. The fusion step cross-checks the two: do items add up, does the evidence support the total, does the spoken
amount match the printed one. Anything doubtful sets `needs_review` instead of guessing.

## Step 1 · Choose, scope and connect
**Goal:** a written definition of success and a working connection to your vision and speech models.

Scope first, because "make it work on receipts" has no finish line. Write what the app does, what it refuses to do,
and the numbers that mean success.

```bash title="terminal"
mkdir expense-capture && cd expense-capture
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install "openai>=1.40" "pydantic>=2.7" pillow numpy fastapi uvicorn python-multipart pytest
pip install faster-whisper datasets                      # optional: local STT, public sample receipts
mkdir -p app data/inputs scripts evals tests results && touch app/__init__.py
```

```markdown title="SCOPE.md"
# Expense capture: scope

**Input:** one receipt photo (JPEG/PNG from a phone) + optional voice note (any format ffmpeg reads, max 2 minutes).
**Output:** merchant, date, currency, total, tax, line items, category, purpose, attendees, warnings, needs_review.

## Success (measured on >= 30 real examples)
- Total correct on >= 90% of receipts.
- Silent errors (wrong total AND not flagged for review) <= 2%.
- Category correct on >= 85% of voice notes.
- p95 end-to-end latency <= 15 s; cost <= $0.01 per expense.

## Out of scope
Multi-page invoices, handwritten receipts, currency conversion, policy approval.

## Rule
When unsure, flag. A flagged receipt costs a human 20 seconds; a wrong total that slips through costs an audit finding.
```

```python title="app/config.py"
"""All model choices and prices come from the environment so providers can be swapped."""
import os

from openai import OpenAI

BASE_URL = os.getenv("BASE_URL") or None
API_KEY = os.getenv("API_KEY") or os.getenv("OPENAI_API_KEY", "not-needed")
VISION_MODEL = os.getenv("VISION_MODEL", "gpt-4o-mini")      # example ids; check your provider
TEXT_MODEL = os.getenv("TEXT_MODEL", "gpt-4o-mini")
STT_MODEL = os.getenv("STT_MODEL", "whisper-1")
STT_BACKEND = os.getenv("STT_BACKEND", "api")                # "api" or "local" (faster-whisper)
STT_BASE_URL = os.getenv("STT_BASE_URL") or BASE_URL

# USD, examples only - read your provider's price page
PRICE_VISION_IN = float(os.getenv("PRICE_VISION_IN_PER_M", "0.15"))
PRICE_VISION_OUT = float(os.getenv("PRICE_VISION_OUT_PER_M", "0.60"))
PRICE_TEXT_IN = float(os.getenv("PRICE_TEXT_IN_PER_M", "0.15"))
PRICE_TEXT_OUT = float(os.getenv("PRICE_TEXT_OUT_PER_M", "0.60"))
PRICE_STT_PER_MIN = float(os.getenv("PRICE_STT_PER_MIN", "0.006"))

client = OpenAI(base_url=BASE_URL, api_key=API_KEY, timeout=90, max_retries=2)
stt_client = OpenAI(base_url=STT_BASE_URL, api_key=API_KEY, timeout=90, max_retries=2)

if __name__ == "__main__":
    r = client.chat.completions.create(model=TEXT_MODEL, messages=[{"role": "user", "content": "Reply with OK"}], max_tokens=5)
    print("text model:", TEXT_MODEL, "->", r.choices[0].message.content)
    print("vision model:", VISION_MODEL, "| stt:", STT_BACKEND, STT_MODEL)
```

**How this code works**
- Separate `VISION_MODEL`, `TEXT_MODEL`, `STT_MODEL` → each modality can move to a different provider or on-device without touching pipeline code. The stretch goal depends on this.
- `STT_BASE_URL` → many local servers do chat but not transcription; you can point speech at a different endpoint.
- Prices per modality → images are billed as tokens, audio by the minute. Cost per request needs both.
- The success rules include "silent errors" → the metric that matters for extraction is not accuracy alone but wrong answers nobody was told to check.

**Run it**
```bash title="terminal"
export OPENAI_API_KEY=sk-...     # local: export BASE_URL=http://localhost:11434/v1 VISION_MODEL=qwen2.5vl:7b TEXT_MODEL=qwen2.5vl:7b STT_BACKEND=local
python -m app.config
```

**You should see**
```text
text model: gpt-4o-mini -> OK
vision model: gpt-4o-mini | stt: api whisper-1
```

**If it breaks**
- `AuthenticationError` → the key is not exported in this shell.
- Ollama `model not found` → `ollama pull qwen2.5vl:7b` first; vision models are several GB.

## Step 2 · Collect real inputs and label them
**Goal:** 20-50 real receipt photos, voice notes for at least half of them, and a hand-written `labels.jsonl`.

Curated samples hide every interesting failure. Photograph receipts from your wallet or recycling bin: faded thermal
paper, folds, shadows, a receipt on a patterned table, one at an angle, one in another language if you have it. Record
voice notes in a kitchen, on a street, one whispered, one with a long pause, one accidental empty recording. Name
pairs `r001.jpg` + `r001.m4a`. For extra variety, pull a few public receipts from the CORD dataset.

```python title="scripts/fetch_cord.py"
"""Add N labelled receipts from the public CORD dataset (Indonesian receipts, totals in IDR)."""
import json
import re
import sys
from pathlib import Path

from datasets import load_dataset

N = int(sys.argv[1]) if len(sys.argv) > 1 else 10
out = Path("data/inputs")
out.mkdir(parents=True, exist_ok=True)
ds = load_dataset("naver-clova-ix/cord-v2", split="test")    # check the current docs if the id moves

with open("data/labels.jsonl", "a", encoding="utf-8") as f:
    for i, row in enumerate(ds.select(range(N))):
        gt = json.loads(row["ground_truth"])["gt_parse"]
        total_text = (gt.get("total") or {}).get("total_price")
        total_text = total_text[0] if isinstance(total_text, list) else total_text
        total = float(re.sub(r"[^\d]", "", total_text)) if total_text else None
        name = f"cord_{i:03d}.jpg"
        row["image"].convert("RGB").save(out / name, quality=90)
        f.write(json.dumps({"id": f"cord_{i:03d}", "image": f"inputs/{name}", "audio": None,
                            "merchant": None, "date": None, "currency": "IDR", "total": total,
                            "category": None}) + "\n")
print(f"saved {N} CORD receipts")
```

```json title="data/labels.jsonl (your own lines, one per receipt)"
{"id": "r001", "image": "inputs/r001.jpg", "audio": "inputs/r001.m4a", "merchant": "Pret A Manger", "date": "2026-10-14", "currency": "GBP", "total": 11.85, "category": "meals"}
{"id": "r002", "image": "inputs/r002.jpg", "audio": "inputs/r002.m4a", "merchant": "Shell", "date": "2026-10-15", "currency": "EUR", "total": 64.20, "category": "travel"}
{"id": "r003", "image": "inputs/r003.jpg", "audio": null, "merchant": "Staples", "date": "2026-09-30", "currency": "USD", "total": 23.47, "category": null}
```

**How this code works**
- `gt_parse["total"]["total_price"]` → CORD stores prices as printed strings like `"60.000"` (thousands separators, no decimals), so stripping non-digits gives the integer amount. Fields CORD does not label (merchant, date) are `null`, and the evaluator skips null labels.
- Labels are written by you, from the paper, before you run the model → if you label from the model's output you will copy its mistakes into your ground truth.
- `category` labels come from what you said in the voice note → the speech half gets its own accuracy number.

**Run it**
```bash title="terminal"
python scripts/fetch_cord.py 10
ls data/inputs | head; wc -l data/labels.jsonl
```

**You should see**
```text
saved 10 CORD receipts
cord_000.jpg  cord_001.jpg ...  r001.jpg  r001.m4a  r002.jpg ...
32 data/labels.jsonl
```

**If it breaks**
- iPhone photos are `.HEIC` → `pip install pillow-heif` and add `from pillow_heif import register_heif_opener; register_heif_opener()` at the top of `app/images.py`, or export as JPEG.
- `datasets` download is slow → skip CORD; your own receipts matter more.

## Step 3 · Prepare images and catch bad photos
**Goal:** every photo upright, resized, and scored for blur, darkness and resolution before any model sees it.

Vision models are confidently wrong on bad images. A cheap local check lets you warn the user ("retake: too dark")
instead of extracting garbage.

```python title="app/images.py"
"""Load a phone photo, fix orientation, resize, and measure quality."""
import base64
import io
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, ImageStat

MAX_SIDE = 1600          # long side in pixels; enough for receipt text, keeps image tokens bounded
MIN_SHORT_SIDE = 500
BLUR_THRESHOLD = 150.0   # edge variance; calibrate on your own photos in this step
DARK, BRIGHT = 70.0, 235.0


def load_image(path: str | Path) -> Image.Image:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)       # phones store rotation in EXIF, not in the pixels
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return img


def quality_report(img: Image.Image) -> dict:
    gray = img.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)
    return {
        "width": img.width,
        "height": img.height,
        "sharpness": round(ImageStat.Stat(edges).var[0], 1),
        "brightness": round(ImageStat.Stat(gray).mean[0], 1),
    }


def quality_warnings(report: dict) -> list[str]:
    warnings = []
    if report["sharpness"] < BLUR_THRESHOLD:
        warnings.append("image_blurry")
    if report["brightness"] < DARK:
        warnings.append("image_too_dark")
    if report["brightness"] > BRIGHT:
        warnings.append("image_overexposed")
    if min(report["width"], report["height"]) < MIN_SHORT_SIDE:
        warnings.append("image_low_resolution")
    return warnings


def to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


if __name__ == "__main__":
    for path in sorted(Path("data/inputs").glob("*.jpg")):
        rep = quality_report(load_image(path))
        print(f"{path.name:<14} {rep['width']}x{rep['height']}  sharp={rep['sharpness']:>7}  "
              f"bright={rep['brightness']:>5}  {quality_warnings(rep) or 'ok'}")
```

**How this code works**
- `ImageOps.exif_transpose` → phone photos are often stored sideways with a rotation tag. Sending them unrotated is a top cause of "the model can't read it".
- `thumbnail((1600, 1600))` → keeps aspect ratio and only shrinks. Larger images cost more tokens (vision models tile them) without helping on receipts; much smaller and small print becomes unreadable.
- Sharpness = variance of an edge-filtered image → crisp text has many strong edges; blur flattens them. It is crude, so the threshold must be calibrated: look at the printed scores of a sharp and a blurry photo and put `BLUR_THRESHOLD` between them.
- Warnings, not rejections → we still try extraction; the warning raises the review flag later.

**Run it**
```bash title="terminal"
python -m app.images
```

**You should see**
```text
cord_000.jpg   864x1296  sharp=  412.3  bright=171.2  ok
r001.jpg       1200x1600  sharp=  388.9  bright=158.4  ok
r004.jpg       1200x1600  sharp=   61.2  bright=149.0  ['image_blurry']
r009.jpg       1200x1600  sharp=  220.5  bright= 52.7  ['image_too_dark']
```

**If it breaks**
- Every image flagged blurry → your threshold is too high for your camera; lower it until only the truly blurry ones trip.
- `UnidentifiedImageError` → the file is HEIC or a PDF; see Step 2.

## Step 4 · Extract receipt fields with a vision model
**Goal:** a validated `Receipt` object from one photo, with nulls for unreadable fields and the evidence text for the total.

```python title="app/schema.py"
from pydantic import BaseModel, Field


class LineItem(BaseModel):
    description: str
    amount: float | None = None


class Receipt(BaseModel):
    merchant: str | None = None
    date: str | None = Field(None, description="YYYY-MM-DD")
    currency: str | None = None
    total: float | None = None
    tax: float | None = None
    items: list[LineItem] = []
    unreadable_fields: list[str] = []
    total_evidence: str | None = None


class VoiceNote(BaseModel):
    category: str | None = None          # meals | travel | lodging | office | other
    purpose: str | None = None
    attendees: list[str] = []
    mentioned_total: float | None = None


class Expense(BaseModel):
    receipt: Receipt
    note: VoiceNote | None = None
    transcript: str | None = None
    warnings: list[str] = []
    needs_review: bool = False
```

```python title="app/vision.py"
"""Receipt photo -> Receipt, with one repair attempt if the JSON is invalid."""
from PIL import Image
from pydantic import ValidationError

from app.config import VISION_MODEL, client
from app.images import to_data_url
from app.schema import Receipt

PROMPT = """Extract this receipt as a JSON object with keys:
merchant, date (YYYY-MM-DD), currency (ISO 4217 code), total, tax, items (list of {description, amount}),
unreadable_fields (list of key names you could not read), total_evidence (the exact characters printed for the total).
Rules:
- Copy numbers exactly as printed; use a dot as the decimal separator in numbers.
- If a field is missing, cut off, faded or ambiguous, set it to null and list it in unreadable_fields.
- Never compute, estimate or guess a value that is not printed.
Return only the JSON object."""


def extract_receipt(img: Image.Image) -> tuple[Receipt, dict]:
    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": to_data_url(img), "detail": "high"}},
        ],
    }]
    usage = {"in": 0, "out": 0, "repairs": 0}
    for attempt in range(2):
        resp = client.chat.completions.create(
            model=VISION_MODEL, messages=messages, temperature=0, max_tokens=900,
            response_format={"type": "json_object"},
        )
        usage["in"] += resp.usage.prompt_tokens
        usage["out"] += resp.usage.completion_tokens
        raw = resp.choices[0].message.content or ""
        try:
            return Receipt.model_validate_json(raw), usage
        except ValidationError as err:
            usage["repairs"] += 1
            messages += [{"role": "assistant", "content": raw},
                         {"role": "user", "content": f"That JSON failed validation: {err.errors()[:3]}. Return corrected JSON only."}]
    return Receipt(unreadable_fields=["all"]), usage


if __name__ == "__main__":
    import sys

    from app.images import load_image

    receipt, use = extract_receipt(load_image(sys.argv[1]))
    print(receipt.model_dump_json(indent=2))
    print(use)
```

**How this code works**
- `unreadable_fields` and `total_evidence` → giving the model an honest way out ("I could not read it") and asking it to quote what it read are the two cheapest defences against invented values.
- `"Never compute"` → models love to "help" by summing items when the total is torn off. That produces a plausible number with no basis on the paper.
- `response_format={"type": "json_object"}` → asks for syntactically valid JSON; `model_validate_json` then checks types. Strict JSON-schema output is better where your provider supports it (`# check the current docs`).
- The repair loop sends the validation error back once → fixes most type slips (a total as `"12,50"`), and `repairs` is counted so you see how often it happens.
- `resp.usage.prompt_tokens` includes the image tokens → this is the vision cost you will report.

**Run it**
```bash title="terminal"
python -m app.vision data/inputs/r001.jpg
```

**You should see**
```text
{
  "merchant": "Pret A Manger",
  "date": "2026-10-14",
  "currency": "GBP",
  "total": 11.85,
  "tax": 1.98,
  "items": [{"description": "Chicken Caesar Baguette", "amount": 6.45}, {"description": "Flat White", "amount": 3.40}, {"description": "Crisps", "amount": 2.00}],
  "unreadable_fields": [],
  "total_evidence": "TOTAL £11.85"
}
{'in': 1143, 'out': 132, 'repairs': 0}
```

**If it breaks**
- `400 ... image_url is only supported by certain models` → `VISION_MODEL` is a text-only model.
- `response_format` rejected → some local servers do not support it; remove the argument and keep the "Return only the JSON object" instruction.
- Date like `14/10/26` comes back unconverted → the validation in Step 6 catches it; do not fix it in the prompt yet, measure first.

## Step 5 · Transcribe the voice note safely
**Goal:** a voice note converted, checked for silence, transcribed and parsed into category, purpose and attendees.

Speech-to-text models trained on subtitles famously "hear" phrases like "Thank you for watching." in silence. So we
measure the audio before sending it, and distrust known phantom phrases.

```python title="app/audio.py"
"""Voice note -> transcript -> VoiceNote, with silence and hallucination guards."""
import json
import subprocess
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

from app.config import STT_BACKEND, STT_MODEL, TEXT_MODEL, client, stt_client
from app.schema import VoiceNote

SPEECH_DBFS = -40.0          # frames louder than this count as speech (crude; calibrate)
PHANTOM_PHRASES = ("thank you for watching", "thanks for watching", "subtitles by", "please subscribe")
_local_model = None


def to_wav16k(path: str | Path) -> Path:
    out = Path(tempfile.mkdtemp()) / "note.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", "16000", str(out)],
                   check=True)
    return out


def audio_stats(wav_path: Path) -> dict:
    with wave.open(str(wav_path), "rb") as w:
        rate = w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size == 0:
        return {"duration_s": 0.0, "rms_dbfs": -120.0, "speech_ratio": 0.0}
    frame = int(rate * 0.03)
    n = max(1, samples.size // frame)
    frames = samples[: n * frame].reshape(n, -1) if samples.size >= frame else samples.reshape(1, -1)
    frame_db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    return {
        "duration_s": round(samples.size / rate, 2),
        "rms_dbfs": round(float(20 * np.log10(np.sqrt((samples ** 2).mean()) + 1e-9)), 1),
        "speech_ratio": round(float((frame_db > SPEECH_DBFS).mean()), 2),
    }


def audio_warnings(stats: dict) -> list[str]:
    warnings = []
    if stats["duration_s"] < 0.7:
        warnings.append("audio_empty")
    elif stats["speech_ratio"] < 0.10:
        warnings.append("audio_mostly_silence")
    if stats["duration_s"] > 120:
        warnings.append("audio_too_long")
    if -120 < stats["rms_dbfs"] < -45:
        warnings.append("audio_very_quiet")
    return warnings


def transcribe(wav_path: Path) -> str:
    global _local_model
    if STT_BACKEND == "local":
        from faster_whisper import WhisperModel
        if _local_model is None:
            _local_model = WhisperModel("small", device="cpu", compute_type="int8")
        segments, _info = _local_model.transcribe(str(wav_path), vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()
    with open(wav_path, "rb") as f:
        return stt_client.audio.transcriptions.create(model=STT_MODEL, file=f).text.strip()


def parse_note(transcript: str) -> tuple[VoiceNote, dict]:
    resp = client.chat.completions.create(
        model=TEXT_MODEL, temperature=0, max_tokens=200, response_format={"type": "json_object"},
        messages=[{"role": "system", "content": (
            "Extract from an expense voice note a JSON object with keys: category (one of meals, travel, "
            "lodging, office, other), purpose (short phrase), attendees (list of names or companies), "
            "mentioned_total (number or null). Use null when not said. Do not invent.")},
                  {"role": "user", "content": transcript}],
    )
    note = VoiceNote.model_validate(json.loads(resp.choices[0].message.content or "{}"))
    return note, {"in": resp.usage.prompt_tokens, "out": resp.usage.completion_tokens}


def process_audio(path: str | Path) -> dict:
    t0 = time.perf_counter()
    wav = to_wav16k(path)
    stats = audio_stats(wav)
    warnings = audio_warnings(stats)
    transcript, note, usage = None, None, {"in": 0, "out": 0}
    stt_ms = parse_ms = 0.0
    if "audio_empty" not in warnings and "audio_mostly_silence" not in warnings:
        t1 = time.perf_counter()
        transcript = transcribe(wav)
        stt_ms = (time.perf_counter() - t1) * 1000
        if not transcript or transcript.lower().strip(" .!") in PHANTOM_PHRASES or len(transcript) < 3:
            warnings.append("transcript_suspect")
        else:
            t2 = time.perf_counter()
            note, usage = parse_note(transcript)
            parse_ms = (time.perf_counter() - t2) * 1000
    return {"stats": stats, "warnings": warnings, "transcript": transcript, "note": note, "usage": usage,
            "prep_ms": (time.perf_counter() - t0) * 1000 - stt_ms - parse_ms, "stt_ms": stt_ms, "parse_ms": parse_ms}


if __name__ == "__main__":
    import sys

    out = process_audio(sys.argv[1])
    print(out["stats"], out["warnings"])
    print("transcript:", out["transcript"])
    print("note:", out["note"])
```

**How this code works**
- `ffmpeg -ac 1 -ar 16000` → speech models work at 16 kHz mono; converting once means any phone format (m4a, ogg, webm) works and the stats code only needs WAV.
- `speech_ratio` → fraction of 30 ms frames louder than -40 dBFS. An accidental pocket recording has almost none, so we skip STT entirely and save both cost and a phantom transcript. Street noise can fool this threshold; calibrate on your noisy recordings.
- `PHANTOM_PHRASES` → known hallucinations on near-silence. Flagging them is a band-aid; the silence check is the real fix.
- `vad_filter=True` for local faster-whisper → voice activity detection drops silent stretches before decoding, the local equivalent of the guard above.
- The parser prompt restricts `category` to five values and says "Do not invent" → open-ended categories make accuracy unmeasurable.

**Run it**
```bash title="terminal"
python -m app.audio data/inputs/r001.m4a
python -m app.audio data/inputs/r007.m4a     # your accidental near-silent recording
```

**You should see**
```text
{'duration_s': 6.84, 'rms_dbfs': -24.1, 'speech_ratio': 0.71} []
transcript: Client lunch with Acme, three of us, about twelve pounds.
note: category='meals' purpose='client lunch' attendees=['Acme'] mentioned_total=12.0
{'duration_s': 4.02, 'rms_dbfs': -58.3, 'speech_ratio': 0.0} ['audio_mostly_silence', 'audio_very_quiet']
transcript: None
note: None
```

**If it breaks**
- `FileNotFoundError: 'ffmpeg'` → ffmpeg is not on PATH; reopen the terminal after installing.
- `404` on transcription → your `BASE_URL` server has no `/audio/transcriptions`; set `STT_BACKEND=local` or point `STT_BASE_URL` elsewhere.
- Every note flagged silent → your mic records quietly; lower `SPEECH_DBFS` to -50 after checking the printed `rms_dbfs` of a good note.

## Step 6 · Fuse the modalities and add validation rules
**Goal:** one `Expense` per input pair, cross-checked across modalities, with timing and cost per stage, plus offline tests.

```python title="app/fuse.py"
"""Cross-modal checks. Every rule exists because of a failure seen on real inputs."""
import re
from datetime import date, datetime, timedelta

from app.schema import Expense, Receipt, VoiceNote

BLOCKING = {"total_missing", "total_not_in_evidence", "items_do_not_add_up", "voice_total_mismatch",
            "date_invalid", "image_blurry", "image_too_dark", "transcript_suspect"}


def digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def check_receipt(r: Receipt) -> list[str]:
    w = []
    if r.total is None:
        w.append("total_missing")
    elif r.total_evidence is not None:
        expected = digits(f"{r.total:.2f}")
        found = digits(r.total_evidence)
        if expected not in found and expected.rstrip("0") not in found and digits(f"{r.total:.0f}") != found:
            w.append("total_not_in_evidence")
    amounts = [i.amount for i in r.items if i.amount is not None]
    if r.total is not None and amounts:
        s = sum(amounts)
        tol = max(0.02, 0.01 * r.total)
        if abs(s - r.total) > tol and (r.tax is None or abs(s + r.tax - r.total) > tol):
            w.append("items_do_not_add_up")
    if r.date:
        try:
            d = datetime.strptime(r.date, "%Y-%m-%d").date()
            if d > date.today() or d < date.today() - timedelta(days=730):
                w.append("date_invalid")
        except ValueError:
            w.append("date_invalid")
    w += [f"unreadable_{f}" for f in r.unreadable_fields]
    return w


def check_cross(r: Receipt, note: VoiceNote | None) -> list[str]:
    if note and note.mentioned_total is not None and r.total:
        if abs(note.mentioned_total - r.total) > max(1.0, 0.1 * r.total):
            return ["voice_total_mismatch"]
    return []


def fuse(receipt: Receipt, note: VoiceNote | None, transcript: str | None, warnings: list[str]) -> Expense:
    all_w = list(dict.fromkeys(warnings + check_receipt(receipt) + check_cross(receipt, note)))
    needs_review = bool(set(all_w) & BLOCKING) or any(w == "unreadable_total" for w in all_w)
    return Expense(receipt=receipt, note=note, transcript=transcript, warnings=all_w, needs_review=needs_review)
```

```python title="app/pipeline.py"
"""Run one expense end to end and record latency and cost per modality."""
import time
from concurrent.futures import ThreadPoolExecutor

from app import config
from app.audio import process_audio
from app.fuse import fuse
from app.images import load_image, quality_report, quality_warnings
from app.vision import extract_receipt


def run_image(path: str) -> dict:
    t0 = time.perf_counter()
    img = load_image(path)
    warnings = quality_warnings(quality_report(img))
    t1 = time.perf_counter()
    receipt, usage = extract_receipt(img)
    t2 = time.perf_counter()
    return {"receipt": receipt, "usage": usage, "warnings": warnings,
            "prep_ms": (t1 - t0) * 1000, "vision_ms": (t2 - t1) * 1000}


def process(image_path: str, audio_path: str | None = None) -> tuple[dict, dict]:
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as pool:          # the two modalities are independent
        img_f = pool.submit(run_image, image_path)
        aud_f = pool.submit(process_audio, audio_path) if audio_path else None
        img = img_f.result()
        aud = aud_f.result() if aud_f else None

    expense = fuse(img["receipt"], aud["note"] if aud else None, aud["transcript"] if aud else None,
                   img["warnings"] + (aud["warnings"] if aud else []))
    audio_minutes = (aud["stats"]["duration_s"] / 60) if aud and aud["transcript"] is not None else 0.0
    metrics = {
        "image_prep_ms": img["prep_ms"],
        "vision_ms": img["vision_ms"],
        "audio_prep_ms": aud["prep_ms"] if aud else 0.0,
        "stt_ms": aud["stt_ms"] if aud else 0.0,
        "note_parse_ms": aud["parse_ms"] if aud else 0.0,
        "total_ms": (time.perf_counter() - t0) * 1000,
        "vision_cost": img["usage"]["in"] / 1e6 * config.PRICE_VISION_IN + img["usage"]["out"] / 1e6 * config.PRICE_VISION_OUT,
        "stt_cost": 0.0 if config.STT_BACKEND == "local" else audio_minutes * config.PRICE_STT_PER_MIN,
        "text_cost": (aud["usage"]["in"] / 1e6 * config.PRICE_TEXT_IN + aud["usage"]["out"] / 1e6 * config.PRICE_TEXT_OUT) if aud else 0.0,
        "vision_repairs": img["usage"]["repairs"],
    }
    return expense.model_dump(), metrics


if __name__ == "__main__":
    import json
    import sys

    exp, m = process(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    print(json.dumps(exp, indent=2))
    print({k: round(v, 5) if isinstance(v, float) else v for k, v in m.items()})
```

```python title="tests/test_checks.py"
import wave

import numpy as np

from app.audio import audio_stats, audio_warnings
from app.fuse import check_receipt, fuse
from app.schema import LineItem, Receipt, VoiceNote


def test_total_supported_by_evidence_passes():
    r = Receipt(total=11.85, total_evidence="TOTAL £11.85", date="2026-10-14")
    assert "total_not_in_evidence" not in check_receipt(r)


def test_invented_total_is_flagged():
    r = Receipt(total=19.40, total_evidence="TOTAL £11.85")
    assert "total_not_in_evidence" in check_receipt(r)


def test_items_that_do_not_add_up_are_flagged():
    r = Receipt(total=30.0, items=[LineItem(description="a", amount=10.0), LineItem(description="b", amount=5.0)])
    assert "items_do_not_add_up" in check_receipt(r)


def test_voice_mismatch_needs_review():
    e = fuse(Receipt(total=64.20, total_evidence="64,20"), VoiceNote(mentioned_total=46.0), "forty six", [])
    assert e.needs_review and "voice_total_mismatch" in e.warnings


def test_silence_detected(tmp_path):
    path = tmp_path / "silent.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((np.random.randn(16000 * 3) * 20).astype(np.int16).tobytes())
    assert "audio_mostly_silence" in audio_warnings(audio_stats(path))
```

**How this code works**
- `total_not_in_evidence` → compares digits only, so `£11.85`, `11,85` and `TOTAL 11.85 GBP` all match 11.85, while a total the model computed but did not read fails. This is the invented-value detector.
- `items_do_not_add_up` allows for tax → many receipts list pre-tax items; without the tax branch you flag half of Europe.
- `voice_total_mismatch` → the cross-modal check. If the user says "about forty-six" and the receipt says 64.20, one of the two modalities misread (or the user did); a human should look.
- `BLOCKING` → only some warnings force review. "unreadable_tax" alone does not; a missing total does.
- `ThreadPoolExecutor` → image and audio are independent, so total latency is the slower branch, not the sum. Per-stage timings are still recorded separately.
- `stt_cost` uses minutes only when STT actually ran → skipped silent notes cost nothing, which is one benefit of the guard.

**Run it**
```bash title="terminal"
pytest -q
python -m app.pipeline data/inputs/r001.jpg data/inputs/r001.m4a
```

**You should see**
```text
5 passed in 0.31s
{
  "receipt": {"merchant": "Pret A Manger", "date": "2026-10-14", "currency": "GBP", "total": 11.85, ...},
  "note": {"category": "meals", "purpose": "client lunch", "attendees": ["Acme"], "mentioned_total": 12.0},
  "transcript": "Client lunch with Acme, three of us, about twelve pounds.",
  "warnings": [],
  "needs_review": false
}
{'image_prep_ms': 61.3, 'vision_ms': 3120.5, 'audio_prep_ms': 140.2, 'stt_ms': 980.4, 'note_parse_ms': 702.9, 'total_ms': 3195.1, 'vision_cost': 0.00025, 'stt_cost': 0.00068, 'text_cost': 6e-05, 'vision_repairs': 0}
```

**If it breaks**
- `ImportError` in tests → run `pytest` from the project root so `app` is importable (add an empty `tests/__init__.py` if your setup needs it).
- Every receipt gets `items_do_not_add_up` → discounts or service charges; add them as negative/positive items in the prompt's schema, then remeasure.

## Step 7 · Measure on all your inputs
**Goal:** accuracy per field, silent-error rate, and a per-modality latency and cost table over the whole set.

```python title="evals/run_eval.py"
"""Run the pipeline on every labelled example and report accuracy, latency and cost per modality."""
import json
import statistics
from difflib import SequenceMatcher
from pathlib import Path

from app.pipeline import process

DATA = Path("data")


def p95(xs: list[float]) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))] if xs else 0.0


def main() -> None:
    labels = [json.loads(line) for line in (DATA / "labels.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = []
    for lab in labels:
        audio = str(DATA / lab["audio"]) if lab.get("audio") else None
        try:
            exp, m = process(str(DATA / lab["image"]), audio)
        except Exception as exc:
            print(f"ERROR {lab['id']}: {exc}")
            continue
        r = exp["receipt"]
        row = {"id": lab["id"], "needs_review": exp["needs_review"], "warnings": exp["warnings"], **m}
        if lab.get("total") is not None:
            row["total_ok"] = r["total"] is not None and abs(r["total"] - lab["total"]) < 0.011
            row["silent_error"] = not row["total_ok"] and not exp["needs_review"]
        if lab.get("date"):
            row["date_ok"] = r["date"] == lab["date"]
        if lab.get("merchant"):
            row["merchant_ok"] = SequenceMatcher(None, (r["merchant"] or "").lower(), lab["merchant"].lower()).ratio() >= 0.8
        if lab.get("category"):
            row["category_ok"] = (exp["note"] or {}).get("category") == lab["category"]
        rows.append(row)
        print(f"{lab['id']:<10} total_ok={row.get('total_ok')} review={exp['needs_review']} {exp['warnings']}")

    def rate(key: str) -> str:
        vals = [r[key] for r in rows if key in r]
        return f"{sum(vals) / len(vals):.0%} (n={len(vals)})" if vals else "n/a"

    print("\n| metric | value |\n|---|---|")
    for key in ["total_ok", "date_ok", "merchant_ok", "category_ok", "silent_error"]:
        print(f"| {key} | {rate(key)} |")
    print(f"| flagged for review | {sum(r['needs_review'] for r in rows) / len(rows):.0%} |")

    print("\n| modality | stage | p50 ms | p95 ms | mean cost $ |\n|---|---|---|---|---|")
    stages = [("image", "image_prep_ms", None), ("image", "vision_ms", "vision_cost"),
              ("audio", "audio_prep_ms", None), ("audio", "stt_ms", "stt_cost"), ("text", "note_parse_ms", "text_cost"),
              ("all", "total_ms", None)]
    for modality, key, cost_key in stages:
        vals = [r[key] for r in rows if r[key] > 0] or [0.0]
        cost = statistics.mean(r[cost_key] for r in rows) if cost_key else 0.0
        print(f"| {modality} | {key} | {statistics.median(vals):.0f} | {p95(vals):.0f} | {cost:.5f} |")
    total_cost = statistics.mean(r["vision_cost"] + r["stt_cost"] + r["text_cost"] for r in rows)
    print(f"\nmean cost per expense: ${total_cost:.5f}")
    Path("results").mkdir(exist_ok=True)
    Path("results/eval.json").write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
```

**How this code works**
- Null labels are skipped per field → CORD rows count toward totals only; your own rows count toward everything.
- `silent_error` → wrong total and not flagged. Track it separately from accuracy: an app at 85% accuracy with 0% silent errors is shippable; 95% with 5% silent errors is not.
- Stage latencies only include non-zero values → notes skipped as silent do not drag the STT median to zero.
- Merchant uses fuzzy match ≥ 0.8 → "PRET A MANGER LTD" vs "Pret A Manger" should count; exact match would understate quality.

**Run it**
```bash title="terminal"
python -m evals.run_eval | tee results/eval.md
```

**You should see**
```text
| metric | value |
|---|---|
| total_ok | 88% (n=32) |
| date_ok | 91% (n=22) |
| merchant_ok | 95% (n=22) |
| category_ok | 87% (n=15) |
| silent_error | 3% (n=32) |
| flagged for review | 22% |

| modality | stage | p50 ms | p95 ms | mean cost $ |
|---|---|---|---|---|
| image | vision_ms | 3050 | 6900 | 0.00026 |
| audio | stt_ms | 940 | 1800 | 0.00052 |
...
mean cost per expense: $0.00085
```

**If it breaks**
- `RateLimitError` midway → add `time.sleep(1)` in the loop or lower `max_retries` expectations; rerun only failed ids.
- Silent errors above your SCOPE bar → that is Step 8's material. Open `results/eval.json`, find them, and look at the photos.

## Step 8 · Write up one real failure
**Goal:** `FAILURES.md` documenting one failure you actually hit: what broke, how you noticed, what you changed, and the before/after numbers.

Pick the failure that taught you the most, often a silent error. Rerun the eval after your fix and record both numbers.

```markdown title="FAILURES.md"
# Failure: invented totals on torn receipts

**What broke.** On 3 of 32 receipts the bottom was folded or torn. The model returned a total anyway, e.g. 19.40 on
r014 where the visible subtotal was 17.90 and the total line was missing. It summed the items and added a tip that
was never printed.

**How we noticed.** `silent_error` was 9% on the first eval run. All three silent errors were torn receipts. The
`total_evidence` field on r014 said "Subtotal 17.90", which does not contain 19.40.

**What we changed.**
1. Prompt: "Never compute, estimate or guess a value that is not printed" and `unreadable_fields`.
2. Code: `total_not_in_evidence` check in `app/fuse.py` forces review when the evidence digits do not contain the total.
3. Test: `test_invented_total_is_flagged`.

**Result.** silent_error 9% -> 3% (1 remaining: a faded receipt where the evidence itself was misread as 11.65 vs
11.85). total_ok unchanged at 88%. Review rate rose from 16% to 22%, about 6 seconds of extra human time per
expense on average.

**Still open.** Faded thermal paper. Next: a retake prompt when sharpness and contrast are both low.
```

**How this code works**
- What / how noticed / change / result → the structure interviewers and reviewers look for; "how we noticed" proves the measurement was doing its job.
- The trade-off line (more reviews) → every safety check has a cost; state it in numbers.

**Run it**
```bash title="terminal"
python -m evals.run_eval > results/eval-after-fix.md && diff results/eval.md results/eval-after-fix.md
```

**You should see**
```text
< | silent_error | 9% (n=32) |
> | silent_error | 3% (n=32) |
```

**If it breaks**
- No failures found → your inputs are too clean. Add five ugly ones (crumpled, dim, angled, a blank recording) and rerun.

## Step 9 · Package it for someone else
**Goal:** an HTTP endpoint, an `.env.example`, and a README that lets a stranger run it on their own receipts.

```python title="app/server.py"
"""POST /expense with a receipt image and an optional voice note."""
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile

from app.pipeline import process

app = FastAPI(title="Expense capture")
MAX_BYTES = 15 * 1024 * 1024


def _save(upload: UploadFile, folder: Path) -> str:
    path = folder / Path(upload.filename or "upload").name
    with open(path, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    if path.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "file too large")
    return str(path)


@app.post("/expense")
def expense(image: UploadFile = File(...), audio: UploadFile | None = File(None)):
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        image_path = _save(image, folder)
        audio_path = _save(audio, folder) if audio else None
        result, metrics = process(image_path, audio_path)
    return {"expense": result, "metrics": metrics}
```

```ini title=".env.example"
OPENAI_API_KEY=
BASE_URL=
VISION_MODEL=gpt-4o-mini
TEXT_MODEL=gpt-4o-mini
STT_BACKEND=api
STT_MODEL=whisper-1
PRICE_VISION_IN_PER_M=0.15
PRICE_VISION_OUT_PER_M=0.60
PRICE_STT_PER_MIN=0.006
```

**How this code works**
- `def` (not `async def`) → the pipeline makes blocking SDK calls; FastAPI runs sync endpoints in a thread pool, so the server stays responsive.
- `TemporaryDirectory` → uploads are deleted after processing. Receipts contain card digits and names; do not keep what you do not need.
- `Path(upload.filename).name` → strips any directory parts a client sends, so a crafted filename cannot write outside the temp folder.

**Run it**
```bash title="terminal"
uvicorn app.server:app --port 8000 &
curl -s -F image=@data/inputs/r002.jpg -F audio=@data/inputs/r002.m4a localhost:8000/expense | python -m json.tool | head -20
```

**You should see**
```text
{
    "expense": {
        "receipt": { "merchant": "Shell", "date": "2026-10-15", "currency": "EUR", "total": 64.2, ... },
        "note": { "category": "travel", "purpose": "fuel for client visit", ... },
        "warnings": [],
        "needs_review": false
    },
    "metrics": { "vision_ms": 2890.1, "stt_ms": 1012.7, ... }
}
```

**If it breaks**
- `Form data requires "python-multipart"` → `pip install python-multipart`.
- `422 Unprocessable Entity` → the field names must be exactly `image` and `audio`.

## Ship it
- README: what it does (two modalities, one record), a 30-second demo GIF, setup (`pip install -r requirements.txt`, ffmpeg, `.env` from `.env.example`), how to add your own inputs and labels, how to run `python -m evals.run_eval`, and the local-only option.
- Paste the accuracy table and the per-modality latency and cost table from Step 7, with model ids and the date measured.
- Link `SCOPE.md` and `FAILURES.md`. Do not commit your own receipts if they contain personal data; ship the CORD fetch script and a few synthetic samples instead.
- `pip freeze > requirements.txt`, and add a GitHub Action running `pytest` (the tests need no API keys).
- Portfolio write-up: total accuracy, silent-error rate before and after your fix, p95 latency per modality, cost per expense, and the one-paragraph failure story.

## Going further
- Move speech on-device (`STT_BACKEND=local`) and compare accuracy, latency and cost per expense against the API.
- Swap `VISION_MODEL` for a second model (or a local Qwen2.5-VL) and rerun the eval; report which fields changed.
- Add a deterministic OCR pass (Tesseract) and use it as a second source of evidence for the total.
- Add a "retake" response when an image is blurry or dark, and measure how many silent errors it prevents.
- Stream the voice note from the browser with a small web UI and show the extracted record live.
