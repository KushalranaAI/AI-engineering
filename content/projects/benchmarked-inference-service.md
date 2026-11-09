---
project: benchmarked-inference-service
title: A benchmarked inference service
hours: 12
stack: Python 3.11, vLLM (Docker), llama.cpp server (no-GPU path), Prometheus, Grafana, docker compose, httpx + asyncio
cost: GPU path about $5-15 of rented GPU time (an L4/A10-class card at roughly $0.40-1.00/hour, estimates); no-GPU path free
---

You will serve an open-weight model behind an OpenAI-compatible endpoint, watch it on a Grafana dashboard, hammer it
with a load tester you wrote yourself at up to 1,000+ concurrent requests, tune it one knob at a time, and publish a
benchmark report with p50/p95/p99 time to first token (TTFT), inter-token latency (ITL), throughput and dollars per
million tokens. Anyone can clone your repo and rerun it with one command. This is the evidence an inference or platform
team wants before choosing an engine, a GPU or a price.

## Before you start
- **GPU path:** rent one GPU VM with Docker and the NVIDIA Container Toolkit preinstalled (RunPod, Lambda, Vast, a cloud
  VM with an L4, A10G or H100). Check `nvidia-smi` and `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` both work. Model: `Qwen/Qwen2.5-7B-Instruct` (24 GB card) or any 7-8B model.
- **No-GPU path:** any laptop with 8 GB+ RAM and Docker. You serve `Qwen2.5-0.5B-Instruct` as a GGUF with llama.cpp's server. Concurrency is smaller, the shapes are the same.
- Python 3.11+ on the machine that runs the load test (the GPU VM itself is fine).
- On Windows use WSL2 for everything in this guide.
- Builds on Level 12 lessons 12.1-12.9: roofline, vLLM flags, metrics, percentiles, batching, prefix caching, quantization, speculative decoding.

```text title="final folder structure"
inference-bench/
├── .env
├── docker-compose.yml
├── prometheus/prometheus.yml
├── grafana/
│   ├── provisioning/datasources/prometheus.yml
│   ├── provisioning/dashboards/dashboards.yml
│   └── dashboards/inference.json
├── bench/
│   ├── __init__.py
│   ├── predict.py      # memory and speed estimates from the model config
│   ├── workload.py     # seeded prompts: random, shared-prefix, copy
│   ├── stats.py        # percentiles and run summaries
│   ├── loadtest.py     # asyncio streaming load tester
│   └── report.py       # markdown table + $/1M tokens
├── scripts/env_report.sh
├── tests/test_stats.py
└── results/            # env.txt, summary.jsonl, raw/*.jsonl
```

## How it fits together

```text
 loadtest.py ──N concurrent streaming requests──> :8000  vLLM (GPU)  or  llama.cpp server (CPU)
    │  (asyncio + httpx, seeded workload)              │ /metrics
    │                                                  ▼
    ├─> results/raw/*.jsonl (every request)        Prometheus :9090 ──> Grafana :3000 dashboard
    └─> results/summary.jsonl ──> report.py ──> README table with $/1M tokens
```

The load tester opens N streaming chat requests at once from a seeded workload, timestamps every token chunk and
saves one record per request. The engine batches those requests on the GPU (or CPU) and exposes histograms and
counters on `/metrics`, which Prometheus scrapes every five seconds and Grafana draws. After each run the summary line
(percentiles, throughput, errors) is appended to `summary.jsonl`, and the report script turns all runs into a
before/after table with cost.

## Step 1 · Pick hardware, a model, and record the environment
**Goal:** a project folder, a pinned model revision and engine image, and `results/env.txt` describing the machine.

A benchmark nobody can reproduce is an anecdote. Write down the hardware, driver, engine version and the exact model
commit before you measure anything.

```bash title="terminal"
mkdir inference-bench && cd inference-bench
python3 -m venv .venv && source .venv/bin/activate
pip install "httpx>=0.27" "huggingface_hub>=0.24" numpy pytest
mkdir -p bench scripts tests results/raw prometheus grafana/provisioning/datasources grafana/provisioning/dashboards grafana/dashboards models
touch bench/__init__.py
python -c "from huggingface_hub import HfApi; print(HfApi().model_info('Qwen/Qwen2.5-7B-Instruct').sha)"
```

```ini title=".env"
# ---- GPU path ----
MODEL=Qwen/Qwen2.5-7B-Instruct
MODEL_REVISION=main              # replace with the sha printed above
MAX_MODEL_LEN=8192
VLLM_IMAGE=vllm/vllm-openai:v0.11.0   # pin an exact tag; check the current docs for the latest
VLLM_EXTRA_ARGS=--no-enable-prefix-caching
# ---- no-GPU path ----
LLAMA_IMAGE=ghcr.io/ggml-org/llama.cpp:server   # pin a dated build tag (server-bNNNN) for the final report
GGUF_MODEL=Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
LLAMA_PARALLEL=8
# ---- both ----
HF_TOKEN=
GPU_HOURLY_USD=0.70              # what you actually pay; estimate until you have the invoice
```

```bash title="scripts/env_report.sh"
#!/usr/bin/env bash
# Write everything needed to reproduce a run into results/env.txt
set -uo pipefail
mkdir -p results
{
  echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(uname -srm)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "gpu: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader)"
    echo "cuda: $(nvidia-smi | grep -o 'CUDA Version: [0-9.]*')"
  else
    echo "gpu: none"
    echo "cpu: $(lscpu 2>/dev/null | grep 'Model name' | sed 's/Model name: *//' || sysctl -n machdep.cpu.brand_string)"
    echo "cores: $(nproc 2>/dev/null || sysctl -n hw.ncpu)"
  fi
  echo "docker: $(docker --version)"
  grep -E '^(MODEL|MODEL_REVISION|MAX_MODEL_LEN|VLLM_IMAGE|VLLM_EXTRA_ARGS|LLAMA_IMAGE|GGUF_MODEL|LLAMA_PARALLEL|GPU_HOURLY_USD)=' .env
  for img in $(grep -E '^(VLLM_IMAGE|LLAMA_IMAGE)=' .env | cut -d= -f2 | cut -d' ' -f1); do
    echo "digest: $(docker image inspect --format '{{index .RepoDigests 0}}' "$img" 2>/dev/null || echo "$img (not pulled yet)")"
  done
} | tee results/env.txt
```

**How this code works**
- `model_info(...).sha` → the commit hash of the model repo. `main` moves; a sha does not. Paste it into `MODEL_REVISION`.
- `VLLM_IMAGE` pinned to a tag → vLLM changes defaults between releases (prefix caching, scheduler, metric names). An unpinned `latest` makes last week's numbers incomparable.
- `VLLM_EXTRA_ARGS=--no-enable-prefix-caching` → the baseline turns prefix caching off explicitly so the later tuning step measures its effect cleanly.
- `GPU_HOURLY_USD` → the cost step uses the price you paid, not a list price.
- `RepoDigests` → the image digest pins the exact engine build even if a tag is re-pushed.

**Run it**
```bash title="terminal"
chmod +x scripts/env_report.sh && ./scripts/env_report.sh
```

**You should see**
```text
date_utc: 2026-11-06T10:12:41Z
host: Linux 5.15.0-119-generic x86_64
gpu: NVIDIA L4, 23034 MiB, 550.90.07
cuda: CUDA Version: 12.4
docker: Docker version 27.3.1, build ce12230
MODEL=Qwen/Qwen2.5-7B-Instruct
MODEL_REVISION=a09a35458c702b33eeacc393d103063234e8bc28
...
digest: vllm/vllm-openai:v0.11.0 (not pulled yet)
```

**If it breaks**
- `nvidia-smi: command not found` on a GPU VM → the image lacks drivers; pick a "PyTorch/CUDA" template from your provider.
- `docker: permission denied` → `sudo usermod -aG docker $USER` and log in again.
- Hugging Face 401 → the model is gated; accept its licence on the website and set `HF_TOKEN`.

## Step 2 · Predict before you measure
**Goal:** written estimates of weight memory, KV cache per token, max concurrent sequences and decode ceilings.

If you cannot predict roughly what the GPU should do, you cannot tell a good result from a misconfigured one. Decode
is memory-bandwidth bound: every step reads all the weights once, plus the KV cache of every sequence in the batch.

```python title="bench/predict.py"
"""Back-of-envelope serving estimates from a model's config.json and a GPU datasheet."""
import argparse
import json

from huggingface_hub import hf_hub_download

p = argparse.ArgumentParser()
p.add_argument("--model", default="Qwen/Qwen2.5-7B-Instruct")
p.add_argument("--revision", default="main")
p.add_argument("--params-b", type=float, default=7.6, help="parameters in billions (from the model card)")
p.add_argument("--weight-bytes", type=float, default=2.0, help="2 for BF16, 1 for FP8/INT8, ~0.55 for 4-bit")
p.add_argument("--kv-bytes", type=float, default=2.0, help="2 for BF16 KV cache, 1 for FP8")
p.add_argument("--gpu-gb", type=float, default=24.0)
p.add_argument("--bandwidth-gbs", type=float, default=300.0, help="L4 ~300, A10G ~600, H100 SXM ~3350")
p.add_argument("--tflops", type=float, default=121.0, help="dense BF16 TFLOPS from the datasheet")
p.add_argument("--util", type=float, default=0.90, help="--gpu-memory-utilization")
p.add_argument("--overhead-gb", type=float, default=2.0, help="activations, CUDA graphs, runtime")
p.add_argument("--avg-seq", type=int, default=650, help="avg prompt + output tokens per request")
a = p.parse_args()

cfg = json.load(open(hf_hub_download(a.model, "config.json", revision=a.revision)))
layers = cfg["num_hidden_layers"]
heads = cfg["num_attention_heads"]
kv_heads = cfg.get("num_key_value_heads", heads)
head_dim = cfg.get("head_dim") or cfg["hidden_size"] // heads

kv_per_token = 2 * layers * kv_heads * head_dim * a.kv_bytes          # K and V, every layer
weights_gb = a.params_b * a.weight_bytes
kv_pool_gb = a.gpu_gb * a.util - weights_gb - a.overhead_gb
kv_tokens = kv_pool_gb * 1e9 / kv_per_token
max_seqs = kv_tokens / a.avg_seq

print(f"layers={layers} heads={heads} kv_heads={kv_heads} head_dim={head_dim}")
print(f"KV cache per token: {kv_per_token / 1024:.1f} KiB")
print(f"weights: {weights_gb:.1f} GB   KV pool: {kv_pool_gb:.1f} GB = {kv_tokens:,.0f} tokens")
print(f"max concurrent sequences at {a.avg_seq} tokens each: {max_seqs:,.0f}")
print(f"single-stream decode ceiling: {a.bandwidth_gbs / weights_gb:.1f} tok/s (bandwidth bound)")
print(f"compute ceiling: {a.tflops * 1e12 / (2 * a.params_b * 1e9):,.0f} tok/s total")
for batch in (1, 8, 32, 128, 256):
    if batch > max_seqs:
        print(f"batch {batch:>4}: does not fit in KV cache -> requests queue")
        continue
    bytes_per_step = weights_gb * 1e9 + batch * a.avg_seq * kv_per_token
    step_s = bytes_per_step / (a.bandwidth_gbs * 1e9)
    print(f"batch {batch:>4}: ~{step_s * 1000:.0f} ms/step, ~{batch / step_s:,.0f} tok/s aggregate, "
          f"~{1 / step_s:.1f} tok/s per stream")
```

**How this code works**
- `2 * layers * kv_heads * head_dim * kv_bytes` → one K and one V vector per layer per KV head. Grouped-query attention (`kv_heads` 4 instead of 28) is why modern 7B models fit long contexts.
- `kv_pool_gb` → vLLM takes `util × GPU memory`, loads the weights, reserves overhead, and turns the rest into KV cache blocks. Compare with the "KV cache" line in vLLM's startup log in Step 3.
- `bandwidth / weights` → a single stream can never decode faster than reading all weights once per token.
- The batch loop → bigger batches share one weight read, so aggregate throughput climbs while per-stream speed falls. Past `max_seqs`, extra requests wait in the queue, which is what you will see at 1,000 concurrency.

**Run it**
```bash title="terminal"
python -m bench.predict | tee results/prediction.txt
# no-GPU path, roughly: python -m bench.predict --model Qwen/Qwen2.5-0.5B-Instruct --params-b 0.5 --weight-bytes 0.6 --gpu-gb 8 --bandwidth-gbs 50 --tflops 1 --util 1 --overhead-gb 1
```

**You should see**
```text
layers=28 heads=28 kv_heads=4 head_dim=128
KV cache per token: 56.0 KiB
weights: 15.2 GB   KV pool: 4.4 GB = 76,730 tokens
max concurrent sequences at 650 tokens each: 118
single-stream decode ceiling: 19.7 tok/s (bandwidth bound)
compute ceiling: 7,961 tok/s total
batch    1: ~51 ms/step, ~20 tok/s aggregate, ~19.7 tok/s per stream
batch   32: ~54 ms/step, ~589 tok/s aggregate, ~18.4 tok/s per stream
batch  128: does not fit in KV cache -> requests queue
```

**If it breaks**
- `KeyError: 'num_hidden_layers'` → multimodal or unusual configs nest the text config; look under `cfg["text_config"]`.
- Negative KV pool → the model does not fit at this precision. Use a 4-bit or FP8 checkpoint (`--weight-bytes 0.55`) or a smaller model.

## Step 3 · Serve the model in a container
**Goal:** an OpenAI-compatible endpoint on `localhost:8000` from vLLM (GPU) or llama.cpp (CPU), launched by one command.

```yaml title="docker-compose.yml"
services:
  vllm:
    image: ${VLLM_IMAGE}
    profiles: ["gpu"]
    ipc: host
    ports:
      - "8000:8000"
    volumes:
      - ${HOME}/.cache/huggingface:/root/.cache/huggingface
    environment:
      - HF_TOKEN=${HF_TOKEN}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >-
        python3 -m vllm.entrypoints.openai.api_server
        --host 0.0.0.0 --port 8000
        --model ${MODEL} --revision ${MODEL_REVISION}
        --served-model-name bench
        --max-model-len ${MAX_MODEL_LEN}
        --gpu-memory-utilization 0.90
        ${VLLM_EXTRA_ARGS}
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  llamacpp:
    image: ${LLAMA_IMAGE}
    profiles: ["cpu"]
    ports:
      - "8000:8080"
    volumes:
      - ./models:/models
    environment:
      - LLAMA_CACHE=/models
    command: ["-hf", "${GGUF_MODEL}", "--host", "0.0.0.0", "--port", "8080",
              "--parallel", "${LLAMA_PARALLEL}", "-c", "16384", "--metrics", "--alias", "bench"]

  prometheus:
    image: prom/prometheus:v2.55.1
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro

  grafana:
    image: grafana/grafana:11.3.0
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/var/lib/grafana/dashboards:ro
```

```python title="bench/smoke.py"
"""One non-streaming request to prove the endpoint works and the model name matches."""
import os

from openai import OpenAI

client = OpenAI(base_url=os.getenv("BASE_URL", "http://localhost:8000/v1"), api_key="not-needed")
resp = client.chat.completions.create(
    model=os.getenv("MODEL_NAME", "bench"),
    messages=[{"role": "user", "content": "In one sentence, what is a KV cache?"}],
    max_tokens=60,
    temperature=0,
)
print(resp.choices[0].message.content)
print("usage:", resp.usage.prompt_tokens, "in /", resp.usage.completion_tokens, "out")
```

**How this code works**
- `profiles: ["gpu"]` / `["cpu"]` → one file serves both paths; `--profile gpu` starts vLLM, `--profile cpu` starts llama.cpp. Prometheus and Grafana have no profile, so they always start.
- `entrypoint: /bin/sh -c` with a folded string → lets `${VLLM_EXTRA_ARGS}` from `.env` expand into several flags. Compose substitutes the variables; the shell splits them. Each tuning run only edits `.env`.
- `python3 -m vllm.entrypoints.openai.api_server` → the server module present in every vLLM image; `vllm serve` is the newer equivalent. `# check the current docs` for flag names in your pinned version.
- `--served-model-name bench` / `--alias bench` → the load tester always asks for `bench`, whatever model is behind it.
- `ipc: host` → PyTorch uses shared memory between processes; without it vLLM can crash under load.
- llama.cpp `-c 16384 --parallel 8` → the context is split across slots, 2,048 tokens each. Requests beyond 8 wait in its queue.
- `pip install openai` is needed for the smoke test only.

**Run it**
```bash title="terminal"
pip install openai
docker compose --profile gpu up -d vllm          # no-GPU path: docker compose --profile cpu up -d llamacpp
docker compose logs -f vllm                      # wait for "Application startup complete", then Ctrl+C
python -m bench.smoke
```

**You should see**
```text
INFO ... # GPU blocks: 4790 ...  or  KV cache size: 76,640 tokens; Maximum concurrency for 8,192 tokens per request: 9.36x
INFO:     Application startup complete.
A KV cache stores the attention keys and values of earlier tokens so they are not recomputed at each decoding step.
usage: 37 in / 26 out
```
Compare the KV cache tokens in the log with your Step 2 prediction. Within 15-20% means you understand the memory.

**If it breaks**
- `CUDA out of memory` at startup → lower `MAX_MODEL_LEN` to 4096 or use an AWQ checkpoint; the log says how much KV space one sequence needs.
- `could not select device driver "nvidia"` → install the NVIDIA Container Toolkit and restart Docker.
- llama.cpp exits with `failed to download` → the `-hf` quant tag must match a file in the repo; `# check the current docs` for the tag syntax, or download the `.gguf` into `models/` and use `-m /models/<file>.gguf`.
- SGLang instead: swap the service to `lmsysorg/sglang:<tag>` with `python3 -m sglang.launch_server --model-path ${MODEL} --host 0.0.0.0 --port 8000 --enable-metrics`; everything else in this guide is unchanged.

## Step 4 · Scrape metrics and build the dashboard
**Goal:** Prometheus scraping the engine and a provisioned Grafana dashboard showing TTFT, ITL, throughput, queue depth and KV cache usage.

```yaml title="prometheus/prometheus.yml"
global:
  scrape_interval: 5s
scrape_configs:
  - job_name: vllm
    static_configs:
      - targets: ["vllm:8000"]
  - job_name: llamacpp
    static_configs:
      - targets: ["llamacpp:8080"]
```

```yaml title="grafana/provisioning/datasources/prometheus.yml"
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prom
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

```yaml title="grafana/provisioning/dashboards/dashboards.yml"
apiVersion: 1
providers:
  - name: inference
    folder: Inference
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

```json title="grafana/dashboards/inference.json"
{
  "uid": "inference",
  "title": "Inference service",
  "schemaVersion": 39,
  "refresh": "5s",
  "time": { "from": "now-30m", "to": "now" },
  "panels": [
    {
      "id": 1, "type": "timeseries", "title": "TTFT (s)",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [
        { "refId": "A", "legendFormat": "p50", "expr": "histogram_quantile(0.50, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))" },
        { "refId": "B", "legendFormat": "p95", "expr": "histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))" },
        { "refId": "C", "legendFormat": "p99", "expr": "histogram_quantile(0.99, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))" }
      ]
    },
    {
      "id": 2, "type": "timeseries", "title": "Inter-token latency (s)",
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [
        { "refId": "A", "legendFormat": "p50", "expr": "histogram_quantile(0.50, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[1m])))" },
        { "refId": "B", "legendFormat": "p99", "expr": "histogram_quantile(0.99, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[1m])))" },
        { "refId": "C", "legendFormat": "p99 (older vLLM)", "expr": "histogram_quantile(0.99, sum by (le) (rate(vllm:time_per_output_token_seconds_bucket[1m])))" }
      ]
    },
    {
      "id": 3, "type": "timeseries", "title": "Throughput (tokens/s)",
      "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [
        { "refId": "A", "legendFormat": "output", "expr": "sum(rate(vllm:generation_tokens_total[1m]))" },
        { "refId": "B", "legendFormat": "prompt", "expr": "sum(rate(vllm:prompt_tokens_total[1m]))" },
        { "refId": "C", "legendFormat": "output (llama.cpp)", "expr": "sum(llamacpp:predicted_tokens_seconds)" }
      ]
    },
    {
      "id": 4, "type": "timeseries", "title": "Queue depth",
      "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [
        { "refId": "A", "legendFormat": "running", "expr": "sum(vllm:num_requests_running)" },
        { "refId": "B", "legendFormat": "waiting", "expr": "sum(vllm:num_requests_waiting)" },
        { "refId": "C", "legendFormat": "processing (llama.cpp)", "expr": "sum(llamacpp:requests_processing)" },
        { "refId": "D", "legendFormat": "deferred (llama.cpp)", "expr": "sum(llamacpp:requests_deferred)" }
      ]
    },
    {
      "id": 5, "type": "timeseries", "title": "KV cache usage and preemptions",
      "gridPos": { "x": 0, "y": 16, "w": 24, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prom" },
      "targets": [
        { "refId": "A", "legendFormat": "KV usage", "expr": "max(vllm:kv_cache_usage_perc) or max(vllm:gpu_cache_usage_perc)" },
        { "refId": "B", "legendFormat": "preemptions/s", "expr": "sum(rate(vllm:num_preemptions_total[1m]))" },
        { "refId": "C", "legendFormat": "prefix cache hit rate", "expr": "sum(rate(vllm:prefix_cache_hits_total[1m])) / sum(rate(vllm:prefix_cache_queries_total[1m]))" }
      ]
    }
  ]
}
```

**How this code works**
- `scrape_interval: 5s` → load-test runs last minutes, so the default 1-minute interval would hide spikes.
- Two scrape jobs → whichever engine is not running shows as "down" in Prometheus; that is harmless.
- `histogram_quantile(0.95, sum by (le) (rate(..._bucket[1m])))` → percentiles from histogram buckets over a sliding minute. These are approximations bounded by bucket edges; your load tester's raw timings are the numbers you publish, and the dashboard tells you why they look that way.
- Older and newer metric names side by side (`inter_token_latency` vs `time_per_output_token`, `kv_cache_usage_perc` vs `gpu_cache_usage_perc`) → whichever your pinned version exposes draws a line. `# check the current docs` for your version's metric list.
- Provisioning files → the dashboard is code in your repo; anyone who runs `docker compose up` gets the same panels.

**Run it**
```bash title="terminal"
docker compose --profile gpu up -d prometheus grafana
curl -s localhost:8000/metrics | grep -E '^vllm:' | cut -d'{' -f1 | sort -u | head
```
Open `http://localhost:9090/targets` and `http://localhost:3000/d/inference` (tunnel the ports with `ssh -L 3000:localhost:3000 -L 9090:localhost:9090 user@gpu-host` if the GPU is remote).

**You should see**
```text
vllm:e2e_request_latency_seconds_bucket
vllm:generation_tokens_total
vllm:kv_cache_usage_perc
vllm:num_preemptions_total
vllm:num_requests_running
vllm:num_requests_waiting
...
```
Prometheus shows `vllm` (or `llamacpp`) as UP; Grafana shows the five panels, mostly empty until load arrives.

**If it breaks**
- Target DOWN with `no such host` → that engine is not running; expected for the other path.
- Empty dashboard → check `curl localhost:8000/metrics` returns text, and that the datasource uid is `prom`.
- llama.cpp `/metrics` returns 501 → you forgot `--metrics`.

## Step 5 · Write the load tester
**Goal:** a seeded workload generator and an asyncio client that measures TTFT, ITL, TPOT, end-to-end latency and throughput per request.

Off-the-shelf tools exist (vLLM's `vllm bench serve`, `genai-perf`, Locust). Writing your own once teaches you exactly
what each number means. The client streams every request and timestamps each content chunk.

```python title="bench/workload.py"
"""Seeded synthetic workloads. Same seed -> identical prompts on every machine."""
import random

WORDS = (
    "system latency token batch memory cache server request model queue budget engine cluster "
    "region throughput window prompt context answer vector index search policy report metric "
    "signal error retry timeout network storage compute kernel layer weight value key attention "
    "decode prefill schedule replica gateway invoice customer order account ticket summary"
).split()


def _text(rng: random.Random, n_words: int) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(n_words))


def make_requests(n: int, seed: int, mode: str = "random", in_words: tuple[int, int] = (150, 450),
                  out_tokens: int = 128, prefix_words: int = 1200) -> list[dict]:
    rng = random.Random(seed)
    shared = _text(random.Random(0), prefix_words)          # identical for every request and run
    requests = []
    for i in range(n):
        body = _text(rng, rng.randint(*in_words))
        if mode == "random":
            messages = [{"role": "user", "content": f"Request {i}. Summarise these notes:\n{body}"}]
        elif mode == "shared-prefix":
            messages = [
                {"role": "system", "content": f"You are a support assistant. Reference manual:\n{shared}"},
                {"role": "user", "content": f"Ticket {i}: {_text(rng, 40)}"},
            ]
        elif mode == "copy":
            messages = [{"role": "user", "content": f"Repeat the following text exactly, word for word:\n{body}"}]
        else:
            raise ValueError(f"unknown mode {mode}")
        requests.append({"messages": messages, "max_tokens": out_tokens})
    return requests
```

```python title="bench/stats.py"
"""Percentiles and per-run summaries. Pure functions so they are easy to test."""


def percentile(values: list[float], p: float) -> float | None:
    """Linear-interpolated percentile, p in [0, 100]. Same definition as numpy's default."""
    if not values:
        return None
    xs = sorted(values)
    k = (len(xs) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summarize(records: list[dict], wall_s: float, slo_ttft: float, slo_tpot: float) -> dict:
    ok = [r for r in records if r["ok"]]
    ttft = [r["ttft"] for r in ok]
    tpot = [r["tpot"] for r in ok if r["tpot"] is not None]
    e2e = [r["e2e"] for r in ok]
    itl = [g for r in ok for g in r["itl"]]
    out_tokens = sum(r["out_tokens"] for r in ok)
    good = [r for r in ok if r["ttft"] <= slo_ttft and (r["tpot"] or 0) <= slo_tpot]

    def ms(xs: list[float], p: float) -> float | None:
        v = percentile(xs, p)
        return None if v is None else round(v * 1000, 1)

    return {
        "requests": len(records),
        "errors": len(records) - len(ok),
        "wall_s": round(wall_s, 2),
        "ttft_p50_ms": ms(ttft, 50), "ttft_p95_ms": ms(ttft, 95), "ttft_p99_ms": ms(ttft, 99),
        "tpot_p50_ms": ms(tpot, 50), "tpot_p95_ms": ms(tpot, 95), "tpot_p99_ms": ms(tpot, 99),
        "itl_p50_ms": ms(itl, 50), "itl_p95_ms": ms(itl, 95), "itl_p99_ms": ms(itl, 99),
        "e2e_p50_s": round(percentile(e2e, 50) or 0, 2), "e2e_p95_s": round(percentile(e2e, 95) or 0, 2),
        "e2e_p99_s": round(percentile(e2e, 99) or 0, 2),
        "output_tok_s": round(out_tokens / wall_s, 1) if wall_s else 0.0,
        "req_s": round(len(ok) / wall_s, 2) if wall_s else 0.0,
        "goodput_req_s": round(len(good) / wall_s, 2) if wall_s else 0.0,
    }
```

```python title="bench/loadtest.py"
"""Closed-loop streaming load test against an OpenAI-compatible /v1/chat/completions endpoint."""
import argparse
import asyncio
import json
import os
import time
from pathlib import Path

import httpx

from bench.stats import summarize
from bench.workload import make_requests


async def one_request(client: httpx.AsyncClient, url: str, model: str, req: dict, extra: dict) -> dict:
    payload = {
        "model": model,
        "messages": req["messages"],
        "max_tokens": req["max_tokens"],
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        "ignore_eos": True,            # vLLM and llama.cpp extension: always generate max_tokens
        **extra,
    }
    t0 = time.perf_counter()
    first = last = None
    gaps: list[float] = []
    chunks = 0
    usage = None
    error = None
    try:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code != 200:
                error = f"HTTP {resp.status_code}: {(await resp.aread())[:200]!r}"
            else:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[len("data: "):].strip()
                    if data == "[DONE]":
                        break
                    obj = json.loads(data)
                    if obj.get("usage"):
                        usage = obj["usage"]
                    choices = obj.get("choices") or []
                    if choices and (choices[0].get("delta") or {}).get("content"):
                        now = time.perf_counter()
                        if first is None:
                            first = now
                        else:
                            gaps.append(now - last)
                        last = now
                        chunks += 1
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    end = time.perf_counter()
    out_tokens = usage["completion_tokens"] if usage else chunks
    return {
        "ok": error is None and first is not None,
        "error": error,
        "ttft": (first - t0) if first else None,
        "e2e": end - t0,
        "itl": gaps,
        "tpot": (end - first) / (out_tokens - 1) if first and out_tokens > 1 else None,
        "in_tokens": usage["prompt_tokens"] if usage else None,
        "out_tokens": out_tokens,
    }


async def run_level(url: str, model: str, requests: list[dict], concurrency: int, timeout: float,
                    extra: dict) -> tuple[list[dict], float]:
    limits = httpx.Limits(max_connections=concurrency + 10, max_keepalive_connections=concurrency + 10)
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(limits=limits, timeout=httpx.Timeout(timeout, connect=60)) as client:
        await asyncio.gather(*(one_request(client, url, model, r, extra) for r in requests[:3]))  # warm-up

        async def guarded(r: dict) -> dict:
            async with sem:
                return await one_request(client, url, model, r, extra)

        start = time.perf_counter()
        records = await asyncio.gather(*(guarded(r) for r in requests))
        return list(records), time.perf_counter() - start


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--label", required=True, help="e.g. baseline, prefix-on, awq")
    p.add_argument("--concurrency", default="1,8,32,128,512,1024", help="comma-separated ladder")
    p.add_argument("--requests", type=int, default=0, help="per level; default max(2*concurrency, 16)")
    p.add_argument("--mode", default="random", choices=["random", "shared-prefix", "copy"])
    p.add_argument("--out-tokens", type=int, default=128)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--timeout", type=float, default=900)
    p.add_argument("--slo-ttft", type=float, default=2.0, help="seconds")
    p.add_argument("--slo-tpot", type=float, default=0.10, help="seconds per output token")
    p.add_argument("--extra-body", default="{}", help='JSON merged into each request, e.g. {"cache_prompt": false}')
    p.add_argument("--base-url", default=os.getenv("BASE_URL", "http://localhost:8000/v1"))
    p.add_argument("--model", default=os.getenv("MODEL_NAME", "bench"))
    a = p.parse_args()

    url = a.base_url.rstrip("/") + "/chat/completions"
    Path("results/raw").mkdir(parents=True, exist_ok=True)
    for c in [int(x) for x in a.concurrency.split(",")]:
        n = a.requests or max(2 * c, 16)
        reqs = make_requests(n, a.seed, a.mode, out_tokens=a.out_tokens)
        records, wall = asyncio.run(run_level(url, a.model, reqs, c, a.timeout, json.loads(a.extra_body)))
        summary = {"label": a.label, "mode": a.mode, "concurrency": c, "out_tokens": a.out_tokens,
                   "seed": a.seed, **summarize(records, wall, a.slo_ttft, a.slo_tpot)}
        with open(f"results/raw/{a.label}-{a.mode}-c{c}.jsonl", "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        with open("results/summary.jsonl", "a") as f:
            f.write(json.dumps(summary) + "\n")
        errors = [r["error"] for r in records if r["error"]][:2]
        print(f"c={c:>5} n={n:>5} err={summary['errors']:>3} ttft p50/p95/p99={summary['ttft_p50_ms']}/"
              f"{summary['ttft_p95_ms']}/{summary['ttft_p99_ms']} ms  tpot p50={summary['tpot_p50_ms']} ms  "
              f"itl p99={summary['itl_p99_ms']} ms  out={summary['output_tok_s']} tok/s  {errors or ''}")


if __name__ == "__main__":
    main()
```

```python title="tests/test_stats.py"
from bench.stats import percentile, summarize
from bench.workload import make_requests


def test_percentile_matches_numpy_linear():
    xs = [1.0, 2.0, 3.0, 4.0]
    assert percentile(xs, 50) == 2.5
    assert percentile(xs, 0) == 1.0
    assert percentile(xs, 100) == 4.0
    assert percentile([], 99) is None


def test_summarize_counts_errors_and_throughput():
    ok = {"ok": True, "error": None, "ttft": 0.2, "e2e": 1.2, "itl": [0.01, 0.02], "tpot": 0.01, "out_tokens": 100}
    bad = {"ok": False, "error": "HTTP 500", "ttft": None, "e2e": 0.1, "itl": [], "tpot": None, "out_tokens": 0}
    s = summarize([ok, ok, bad], wall_s=2.0, slo_ttft=1.0, slo_tpot=0.05)
    assert s["errors"] == 1
    assert s["output_tok_s"] == 100.0
    assert s["goodput_req_s"] == 1.0


def test_workload_is_deterministic():
    assert make_requests(5, seed=7) == make_requests(5, seed=7)
    assert make_requests(5, seed=7) != make_requests(5, seed=8)
```

**How this code works**
- `ignore_eos: True` + fixed `max_tokens` → every request produces exactly the same number of output tokens, so runs are comparable. Without it, one config that happens to stop early looks "faster".
- `stream_options: {"include_usage": True}` → the final chunk carries real token counts; chunk counting is only the fallback.
- TTFT = first content chunk minus send time; ITL = gaps between chunks; TPOT = (end − first token) / (tokens − 1). With speculative decoding several tokens arrive in one chunk, so ITL gaps get spikier while TPOT stays honest. Report both.
- `asyncio.Semaphore(concurrency)` → a closed loop: exactly `c` requests in flight; a new one starts when one finishes. This measures capacity; an open loop at a fixed arrival rate measures behaviour under a traffic pattern (see Going further).
- `httpx.Limits(max_connections=concurrency + 10)` → httpx defaults to 100 connections, which would silently cap your "1,000 concurrent" test at 100. This is the classic load-testing bug.
- Warm-up → the first requests pay for CUDA graph capture and caches; they are not in the measured set.
- Raw records saved per level → anyone can recompute your percentiles, which is what makes the benchmark checkable.
- `goodput_req_s` → requests per second that met both SLOs. Throughput that misses the latency target is not sellable.

**Run it**
```bash title="terminal"
pytest -q
python -m bench.loadtest --label smoke --concurrency 1,4 --requests 8 --out-tokens 32
```

**You should see**
```text
3 passed in 0.04s
c=    1 n=    8 err=  0 ttft p50/p95/p99=48.3/61.0/62.1 ms  tpot p50=52.1 ms  itl p99=55.0 ms  out=18.4 tok/s
c=    4 n=    8 err=  0 ttft p50/p95/p99=71.9/90.4/91.0 ms  tpot p50=53.0 ms  itl p99=58.7 ms  out=71.2 tok/s
```
The single-stream TPOT (~52 ms → ~19 tok/s) should sit just under the Step 2 ceiling (19.7 tok/s on an L4).

**If it breaks**
- Every request `HTTP 400 ... ignore_eos` → your engine rejects unknown fields; remove `ignore_eos` and set `"min_tokens"` via `--extra-body '{"min_tokens": 128}'` (vLLM) instead.
- `ttft` is `None` and `ok` false with no error → the stream had no content chunks, usually `max_tokens` 0 or a template problem; run `bench.smoke`.
- `ReadTimeout` → raise `--timeout`; on the CPU path long queues are normal.

## Step 6 · Run the baseline ladder past 1,000 concurrent requests
**Goal:** a baseline at rising concurrency up to 1,024, with p50/p95/p99 TTFT, ITL, end-to-end latency and throughput recorded.

```bash title="terminal"
ulimit -n 65536                                   # 1,000+ sockets need file descriptors
./scripts/env_report.sh > /dev/null
python -m bench.loadtest --label baseline --concurrency 1,8,32,128,512,1024
# no-GPU path:
# python -m bench.loadtest --label baseline --concurrency 1,4,16,64 --out-tokens 64
# python -m bench.loadtest --label baseline-overload --concurrency 1000 --requests 1000 --out-tokens 16 --timeout 3600
```
Watch Grafana while it runs: `waiting` climbs once `running` hits the KV cache ceiling.

**How this code works**
- The ladder → throughput rises with concurrency until the batch fills (the knee), then only latency rises. Your report needs points on both sides of the knee.
- 1,024 concurrent on a card that fits ~118 sequences → most requests queue. TTFT p99 explodes while output tokens per second plateaus. That is the honest picture of overload, and the reason autoscaling watches queue depth.
- No-GPU overload run with 16 output tokens → still pushes 1,000 concurrent connections through the client and server, in minutes rather than hours.

**You should see** (L4, Qwen2.5-7B BF16; your numbers will differ)
```text
c=    1 n=   16 err=  0 ttft p50/p95/p99=52/66/70 ms     tpot p50=52.4 ms  itl p99=56 ms   out=18.7 tok/s
c=    8 n=   16 err=  0 ttft p50/p95/p99=95/140/151 ms   tpot p50=54.0 ms  itl p99=71 ms   out=140.2 tok/s
c=   32 n=   64 err=  0 ttft p50/p95/p99=180/420/510 ms  tpot p50=58.9 ms  itl p99=160 ms  out=498.0 tok/s
c=  128 n=  256 err=  0 ttft p50/p95/p99=2210/6890/7400 ms tpot p50=74.0 ms itl p99=410 ms out=1090.5 tok/s
c=  512 n= 1024 err=  0 ttft p50/p95/p99=31800/58100/60900 ms tpot p50=79.2 ms itl p99=450 ms out=1162.3 tok/s
c= 1024 n= 2048 err=  0 ttft p50/p95/p99=64000/118500/121900 ms tpot p50=79.8 ms itl p99=470 ms out=1170.8 tok/s
```

**If it breaks**
- Errors `ConnectError` / `Too many open files` at 512+ → `ulimit -n` was not raised in this shell.
- Server logs `preempted` constantly and throughput drops → the KV cache is overcommitted; that is a finding, note it and tune in Step 8.
- Throughput still climbing at 1,024 → you have a big GPU or a small model. Extend the ladder (2048) until it plateaus.

## Step 7 · Tune: prefix caching on a shared-prefix workload
**Goal:** a measured before/after for prefix caching using a workload where every request shares a long system prompt.

Change one thing, rerun the same test, keep it only if it helps. Prefix caching reuses KV blocks for identical prompt
prefixes, so it only matters when prompts share a prefix: test it on that workload, not the random one.

```bash title="terminal"
# OFF (already set in .env): VLLM_EXTRA_ARGS=--no-enable-prefix-caching
docker compose --profile gpu up -d --force-recreate vllm && sleep 90
python -m bench.loadtest --label prefix-off --mode shared-prefix --concurrency 32,128
# ON: edit .env -> VLLM_EXTRA_ARGS=--enable-prefix-caching
docker compose --profile gpu up -d --force-recreate vllm && sleep 90
python -m bench.loadtest --label prefix-on --mode shared-prefix --concurrency 32,128
# no-GPU path: llama.cpp reuses each slot's cached prompt by default; compare
# --extra-body '{"cache_prompt": false}' (label prefix-off) against the default (label prefix-on)
```

**How this code works**
- `--force-recreate` → restarts the container with the new `.env`, so the flag actually changes. `sleep 90` covers model load; check `docker compose logs vllm` if unsure.
- `shared-prefix` mode → a ~1,500-token manual shared by every request plus a short unique ticket. Prefill dominates, so TTFT is where the win shows.
- Dashboard "prefix cache hit rate" → should jump toward 0.9+ with caching on. If it does not, the prefix is not byte-identical (a timestamp in a system prompt kills caching).

**You should see**
```text
prefix-off  c=  128 ttft p50/p95/p99=3150/7900/8600 ms  out=905.1 tok/s
prefix-on   c=  128 ttft p50/p95/p99=640/1900/2300 ms   out=1121.4 tok/s
```

**If it breaks**
- `unrecognized arguments: --no-enable-prefix-caching` → older vLLM only has `--enable-prefix-caching` (off by default there); drop the "off" flag. `# check the current docs`.
- No difference at all → you ran the `random` mode, or caching was already on in both runs; confirm the flag in `docker compose logs vllm | grep -i prefix`.

## Step 8 · Tune: batch size and token budget
**Goal:** a sweep of `--max-num-seqs` and `--max-num-batched-tokens` showing their effect on TTFT, ITL and throughput.

The scheduler decides how many sequences run together (`max-num-seqs`) and how many tokens one step may process
(`max-num-batched-tokens`, shared by prefill chunks and decodes under chunked prefill). Small budgets protect ITL;
large budgets raise throughput and TTFT variance.

```bash title="terminal"
for cfg in "--max-num-seqs 64" "--max-num-seqs 256" "--max-num-seqs 256 --max-num-batched-tokens 2048" "--max-num-seqs 256 --max-num-batched-tokens 16384"; do
  label="batch-$(echo $cfg | tr -d '-' | tr ' ' '_')"
  sed -i "s|^VLLM_EXTRA_ARGS=.*|VLLM_EXTRA_ARGS=--enable-prefix-caching $cfg|" .env
  docker compose --profile gpu up -d --force-recreate vllm && sleep 90
  python -m bench.loadtest --label "$label" --concurrency 32,128,512
done
# no-GPU path: vary LLAMA_PARALLEL=4, 8, 16 in .env, recreate llamacpp, run --concurrency 4,16,64
```

**How this code works**
- The `sed` line rewrites only `VLLM_EXTRA_ARGS` → each run differs from the last by exactly the flags in `cfg`, and the label records them.
- `--max-num-seqs 64` → caps the batch below what KV allows; expect lower ITL and lower throughput, with more queueing (higher TTFT) at high concurrency.
- `--max-num-batched-tokens 2048` → long prefills are chunked into small pieces, so decodes are not stalled behind them; ITL p99 falls, TTFT rises a little.
- Watch preemptions on the dashboard → a batch bigger than the KV cache can hold shows up as preemptions and wasted recompute.

**You should see**
```text
batch-maxnumseqs_64                         c= 512 ttft p95=79100 ms itl p99=140 ms out=890.2 tok/s
batch-maxnumseqs_256                        c= 512 ttft p95=58000 ms itl p99=440 ms out=1165.0 tok/s
batch-maxnumseqs_256_maxnumbatchedtokens_2048  c= 512 ttft p95=61200 ms itl p99=190 ms out=1120.7 tok/s
```
Pick the config that maximises goodput at your SLO, not raw throughput.

**If it breaks**
- vLLM refuses to start: `max_num_batched_tokens ... smaller than max_model_len` → with chunked prefill disabled the budget must cover a full prompt; keep chunked prefill on or raise the budget.
- `sed: -i` errors on macOS → use `sed -i ''`.

## Step 9 · Tune: quantization and speculative decoding
**Goal:** before/after rows for a 4-bit or FP8 model and for n-gram speculative decoding.

Quantization shrinks weights (more KV room, faster bandwidth-bound decode) at some quality risk. Speculative decoding
drafts several tokens and verifies them in one pass; it helps most when output is predictable from the input.

```bash title="terminal"
# A) AWQ 4-bit weights (any GPU): edit .env
#    MODEL=Qwen/Qwen2.5-7B-Instruct-AWQ   MODEL_REVISION=<its sha>   VLLM_EXTRA_ARGS=--enable-prefix-caching --max-num-seqs 256
docker compose --profile gpu up -d --force-recreate vllm && sleep 90
python -m bench.loadtest --label awq --concurrency 1,32,128,512
# B) FP8 on Ada/Hopper (L4, H100), back on the BF16 model:
#    MODEL=Qwen/Qwen2.5-7B-Instruct   VLLM_EXTRA_ARGS=--enable-prefix-caching --max-num-seqs 256 --quantization fp8 --kv-cache-dtype fp8
docker compose --profile gpu up -d --force-recreate vllm && sleep 120
python -m bench.loadtest --label fp8 --concurrency 1,32,128,512
# C) speculative decoding (n-gram, no draft model), compared on the copy workload:
#    VLLM_EXTRA_ARGS=--enable-prefix-caching --speculative-config '{"method": "ngram", "num_speculative_tokens": 4, "prompt_lookup_max": 4}'
docker compose --profile gpu up -d --force-recreate vllm && sleep 90
python -m bench.loadtest --label spec-ngram --mode copy --concurrency 1,8,32
# ...and the same --mode copy run with the speculative flag removed, labelled spec-off
# no-GPU path: change GGUF_MODEL to ...:Q8_0 and compare with Q4_K_M
```

**How this code works**
- AWQ checkpoint → vLLM detects the format from the model config and uses fast Marlin kernels; weights drop from ~15 GB to ~5.5 GB, so the KV pool more than doubles. Rerun `bench.predict --weight-bytes 0.55` and compare.
- `--quantization fp8 --kv-cache-dtype fp8` → dynamic FP8 weights and an FP8 KV cache, halving both. Native FP8 math needs Ada or Hopper; on Ampere (A10) vLLM falls back to weight-only kernels, so gains are smaller. `# check the current docs`.
- `--speculative-config` JSON → the n-gram drafter proposes tokens by matching the last few tokens against the prompt. On the copy workload acceptance is high and TPOT at low concurrency drops; at high concurrency the GPU is already busy and gains shrink or reverse. `# check the current docs` for the config keys in your version.
- Greedy speculative decoding is lossless; quantization is not. Spot-check a few outputs (or run the stretch eval) before you keep a quantized config.

**You should see**
```text
awq         c=    1 tpot p50=24.1 ms  out=40.8 tok/s     c=  512 out=1580.2 tok/s
fp8         c=    1 tpot p50=29.5 ms  out=33.5 tok/s     c=  512 out=1490.6 tok/s
spec-off    c=    1 tpot p50=52.3 ms  (copy workload)
spec-ngram  c=    1 tpot p50=21.7 ms  (copy workload)    c=   32 tpot p50=49.0 ms
```

**If it breaks**
- `ValueError: fp8 quantization is currently not supported in <GPU>` → your card or version lacks FP8; skip B and note it.
- AWQ server starts but outputs gibberish → wrong `MODEL_REVISION` (the sha of the base model, not the AWQ repo).
- Spec decoding shows no gain → you used the `random` workload, where n-grams never match. That is a correct and reportable result.

## Step 10 · Cost it and write the report
**Goal:** a markdown table of every run with p50/p95/p99 latencies, throughput and $/1M output tokens, plus the best config at your SLO.

```python title="bench/report.py"
"""Turn results/summary.jsonl into README tables with cost."""
import argparse
import json
import os
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--gpu-hourly", type=float, default=float(os.getenv("GPU_HOURLY_USD", "0.70")))
p.add_argument("--slo-ttft-ms", type=float, default=2000)
p.add_argument("--slo-tpot-ms", type=float, default=100)
a = p.parse_args()

rows = [json.loads(line) for line in Path("results/summary.jsonl").read_text().splitlines() if line.strip()]
rows = [r for r in rows if r["label"] != "smoke"]


def usd_per_m(tok_s: float) -> float:
    return a.gpu_hourly / (tok_s * 3600) * 1e6 if tok_s else float("inf")


print(f"GPU price used: ${a.gpu_hourly:.2f}/hour\n")
print("| run | workload | conc | err | TTFT p50/p95/p99 ms | TPOT p50/p95 ms | ITL p99 ms | E2E p95 s | out tok/s | $/1M out |")
print("|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print(f"| {r['label']} | {r['mode']} | {r['concurrency']} | {r['errors']} | "
          f"{r['ttft_p50_ms']}/{r['ttft_p95_ms']}/{r['ttft_p99_ms']} | {r['tpot_p50_ms']}/{r['tpot_p95_ms']} | "
          f"{r['itl_p99_ms']} | {r['e2e_p95_s']} | {r['output_tok_s']} | {usd_per_m(r['output_tok_s']):.2f} |")

ok = [r for r in rows if r["errors"] == 0 and r["ttft_p95_ms"] is not None
      and r["ttft_p95_ms"] <= a.slo_ttft_ms and (r["tpot_p95_ms"] or 0) <= a.slo_tpot_ms]
if ok:
    best = max(ok, key=lambda r: r["output_tok_s"])
    per_request = usd_per_m(best["output_tok_s"]) * best["out_tokens"] / 1e6
    print(f"\nBest within SLO (p95 TTFT <= {a.slo_ttft_ms:.0f} ms, p95 TPOT <= {a.slo_tpot_ms:.0f} ms): "
          f"{best['label']} at concurrency {best['concurrency']}, {best['output_tok_s']} tok/s, "
          f"${usd_per_m(best['output_tok_s']):.2f} per 1M output tokens, ${per_request:.5f} per request")
else:
    print("\nNo run met the SLO. Relax the target or lower concurrency.")
```

**How this code works**
- `gpu_hourly / (tok_s * 3600) * 1e6` → dollars per hour divided by tokens per hour, scaled to a million. It assumes the GPU is kept busy at that rate; real utilisation is lower, so say so in the write-up.
- The SLO filter → the headline number is the best throughput that still meets your latency target. Throughput at concurrency 1,024 with a 2-minute TTFT is not a price anyone can sell.
- Per request → $/token × output tokens per request; input tokens cost GPU time too and are already inside the measured throughput.

**Run it**
```bash title="terminal"
python -m bench.report | tee results/report.md
```

**You should see**
```text
GPU price used: $0.70/hour

| run | workload | conc | err | TTFT p50/p95/p99 ms | TPOT p50/p95 ms | ITL p99 ms | E2E p95 s | out tok/s | $/1M out |
|---|---|---|---|---|---|---|---|---|---|
| baseline | random | 32 | 0 | 180/420/510 | 58.9/63.2 | 160 | 8.1 | 498.0 | 0.39 |
| awq | random | 128 | 0 | 690/1650/1980 | 61.0/68.4 | 210 | 9.3 | 1350.4 | 0.14 |
...
Best within SLO (p95 TTFT <= 2000 ms, p95 TPOT <= 100 ms): awq at concurrency 128, 1350.4 tok/s, $0.14 per 1M output tokens, $0.00002 per request
```

**If it breaks**
- `KeyError: 'mode'` → old summary lines from an earlier script version; delete `results/summary.jsonl` and rerun the runs you report.
- Everything costs `inf` → a run had zero throughput (all errors); check its raw file.

## Ship it
- Push the repo publicly with `.env` (no tokens), `docker-compose.yml`, the Prometheus and Grafana files, `bench/`, `tests/`, `results/env.txt`, `results/summary.jsonl`, `results/raw/` (gzip it if large) and `results/report.md`.
- Export the dashboard after a run (Grafana → Share → Export) and commit the JSON with a screenshot of the baseline ramp to 1,024.
- README sections: hardware and versions (paste `env.txt`), predicted vs measured (KV tokens, single-stream tok/s, the knee), the before/after tuning table, the best config at your SLO with $/1M tokens and the hourly price you paid, what you kept and what you rejected, and one-command reproduction:
  `docker compose --profile gpu up -d && python -m bench.loadtest --label baseline && python -m bench.report`.
- Write-up (500-800 words): the predicted-vs-measured gap and why, the knee, the biggest win, a tuning change that did not help, and the cost number with its utilisation caveat.
- Shut the GPU down. Idle rented GPUs are the most common surprise bill in this project.

## Going further
- Run the same ladder on SGLang (swap the service, keep the tester) and explain the differences, especially on the shared-prefix workload.
- Add a 50-question quality check to every tuning run so a faster but worse quantized model is visible in the table.
- Add an open-loop mode (Poisson arrivals at a fixed request rate) and find the rate where p99 TTFT crosses your SLO.
- Deploy on Kubernetes with KEDA scaling on `vllm:num_requests_waiting` and show a ramp test scaling out.
- Try a real draft model (`"method": "eagle"` or a small same-family model) and compare acceptance rates with n-gram.
