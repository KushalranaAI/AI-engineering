import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "12.1": {
    realLife: {
      title: "A print shop with its originals in the basement",
      story:
        "A print shop has a very fast copier, but every original document is stored in a basement archive and the clerk must fetch it before copying. One customer wanting one copy waits mostly for the trip downstairs. If fifty customers want the same document, one trip serves them all. A customer printing a 300-page thesis keeps the copier itself busy, and the trip hardly matters.",
      mapping: [
        { everyday: "The trip to the basement archive", concept: "Reading weights from HBM: bounded by memory bandwidth" },
        { everyday: "The copier's pages per minute", concept: "The GPU's tensor FLOP/s" },
        { everyday: "One trip serving fifty customers", concept: "Batched decode: one weight read shared by many sequences, raising arithmetic intensity" },
        { everyday: "The 300-page thesis", concept: "Prefill of a long prompt: compute-bound. Breaks down: GPUs also re-read a growing KV cache each step, which the analogy leaves out" },
      ],
    },
    build: {
      title: "A roofline and memory calculator for real models",
      goal: "A Python script that reads a model's config.json and a GPU spec and prints weight memory, KV cache per token, max concurrent sequences, and prefill/decode time estimates with their bound.",
      minutes: 60,
      stack: ["Python", "huggingface_hub", "json"],
      steps: [
        "Download config.json for three open models of different sizes (for example a 1.5B, an 8B and a 70B) with huggingface_hub.",
        "Compute weight bytes for BF16, FP8 and INT4, and KV cache bytes per token from num_hidden_layers, num_key_value_heads and head_dim (hidden_size / num_attention_heads when head_dim is missing).",
        "For two GPUs (for example an 80 GB H100 and a 24 GB L4, with datasheet bandwidth and dense BF16 FLOP/s), compute the ridge point and the KV tokens that fit after weights and a 3 GB overhead at 90% memory utilisation.",
        "Estimate decode time per step at batch 1, 32 and 256 (weights plus KV bytes read vs FLOPs) and prefill time for a 2,000-token prompt; label each as memory- or compute-bound.",
        "Print a table, and mark combinations where the model does not fit at all.",
      ],
      starter: `import json
from huggingface_hub import hf_hub_download

GPUS = {"H100": {"mem_gb": 80, "bw_tbs": 3.35, "tflops": 990},
        "L4":   {"mem_gb": 24, "bw_tbs": 0.30, "tflops": 121}}

def load_cfg(repo: str) -> dict:
    return json.load(open(hf_hub_download(repo, "config.json")))

def kv_bytes_per_token(cfg: dict, dtype_bytes: int = 2) -> int:
    # TODO: 2 * layers * kv_heads * head_dim * dtype_bytes
    ...

def decode_step_ms(params: float, wbytes: float, batch: int, ctx: int, kvpt: int, gpu: dict):
    # TODO: bytes = params*wbytes + batch*ctx*kvpt ; flops = 2*params*batch
    # TODO: return max(bytes/bandwidth, flops/peak) in ms and which one won
    ...

for repo, params in [("Qwen/Qwen2.5-1.5B-Instruct", 1.5e9), ("Qwen/Qwen2.5-7B-Instruct", 7.6e9)]:
    cfg = load_cfg(repo)
    # TODO: print the table for each GPU and weight dtype
`,
      checks: [
        "An 8B-class model in BF16 shows about 16 GB of weights and a single-stream decode ceiling near 200 tokens/s on the H100.",
        "Decode at batch 1 is labelled memory-bound and prefill of 2,000 tokens compute-bound.",
        "A 70B model in BF16 is flagged as not fitting on one 80 GB GPU.",
        "Your KV-per-token figure for Llama-3.1-8B-like configs is 128 KiB in BF16.",
      ],
      stretch: "Add tensor parallelism: divide weights and bandwidth by N and add an estimated all-reduce cost per layer, then see where TP=2 stops helping.",
      sim: "roofline",
    },
  },
  "12.2": {
    realLife: {
      title: "Setting up a food truck for a festival",
      story:
        "Before a weekend festival, a food truck owner decides how much of the fridge holds raw stock and how much holds prepared orders, how many orders can be on the grill at once, and the largest order the truck will accept. Two trucks selling the same menu can be set up differently and serve very different crowds. The owner writes the setup down so next year's truck starts the same way.",
      mapping: [
        { everyday: "Fridge space for prepared orders", concept: "GPU memory left for KV cache after weights (--gpu-memory-utilization / --mem-fraction-static)" },
        { everyday: "Orders on the grill at once", concept: "--max-num-seqs: the batch size limit" },
        { everyday: "Largest order accepted", concept: "--max-model-len / --context-length" },
        { everyday: "The written setup sheet", concept: "Pinned versions and a launch script that make the deployment reproducible" },
      ],
    },
    build: {
      title: "One model, two engines, one client",
      goal: "The same open-weight model served by vLLM and SGLang (or llama.cpp on a laptop), with launch scripts, recorded KV capacity and a client that talks to both.",
      minutes: 90,
      stack: ["vLLM", "SGLang", "llama.cpp (no-GPU path)", "Docker", "openai"],
      steps: [
        "Rent one GPU for a few hours (a 24 GB card is enough for a 7B model) or, without a GPU, download a 1.5B GGUF model for llama.cpp.",
        "Write launch_vllm.sh and launch_sglang.sh with pinned versions and explicit flags for context length, memory fraction, max sequences and tensor parallel size.",
        "Start each engine, wait for /health, and copy the KV cache capacity and maximum concurrency lines from the startup logs into versions.txt along with GPU, driver and model revision.",
        "Write one Python client using the openai package that sends the same 10 prompts to both base URLs and prints latency and token usage.",
        "Restart vLLM with half the context length and record how the reported maximum concurrency changes.",
      ],
      starter: `#!/usr/bin/env bash
# launch_vllm.sh - check 'vllm serve --help' for your pinned version
set -euo pipefail
MODEL="Qwen/Qwen2.5-7B-Instruct"
vllm serve "$MODEL" \\
  --dtype bfloat16 \\
  --max-model-len 8192 \\
  --gpu-memory-utilization 0.90 \\
  --max-num-seqs 256 \\
  --port 8000
# TODO: launch_sglang.sh with python -m sglang.launch_server ... --enable-metrics
# TODO: no GPU? llama-server -m <model>.gguf -c 8192 -np 8 --metrics --port 8080
`,
      checks: [
        "Both servers answer the same client code with only the base URL changed.",
        "versions.txt lists engine versions, model revision, GPU and every launch flag.",
        "You can explain the KV capacity number in the log using the formula from 12.1, within about 20%.",
      ],
      stretch: "Containerise both with pinned image digests and a docker-compose.yml that starts either engine with one command.",
      studio: "inference-serving",
    },
  },
  "12.3": {
    realLife: {
      title: "The board in a hospital emergency department",
      story:
        "A busy emergency department runs on a wall board: how many people are in the waiting room, how long each waited before a doctor first saw them, how often nurses check in on admitted patients, and how many are discharged per hour. The head nurse reads the board before changing anything, and the waiting-room count tells her about trouble before the complaints do.",
      mapping: [
        { everyday: "People in the waiting room", concept: "Queue depth (num_requests_waiting)" },
        { everyday: "Time until a doctor first sees you", concept: "Time to first token (queue wait plus prefill)" },
        { everyday: "Gap between nurse check-ins", concept: "Inter-token latency (ITL / TPOT)" },
        { everyday: "Patients discharged per hour", concept: "Throughput in tokens or requests per second. Breaks down: patients don't share a doctor's attention the way batched sequences share a GPU step" },
      ],
    },
    build: {
      title: "An inference dashboard before any tuning",
      goal: "Prometheus scraping your engine and a Grafana dashboard with TTFT and ITL percentiles, token throughput, queue depth and KV cache usage, plus a recorded baseline.",
      minutes: 75,
      stack: ["Docker Compose", "Prometheus", "Grafana", "vLLM or llama.cpp"],
      steps: [
        "List the metric names your engine exposes with curl on /metrics and note the ones for latency histograms, running and waiting requests, KV usage, tokens and preemptions.",
        "Write a docker-compose.yml with Prometheus (5 s scrape interval) and Grafana, and a prometheus.yml that scrapes the engine.",
        "Build panels: p50/p95/p99 TTFT and ITL with histogram_quantile over summed buckets, output tokens per second, running vs waiting requests, KV cache usage and preemptions.",
        "Send 50 requests sequentially, then 50 concurrently, and screenshot the dashboard for both.",
        "Export the dashboard JSON into your repo and write three sentences describing the baseline.",
      ],
      starter: `# prometheus.yml
global:
  scrape_interval: 5s
scrape_configs:
  - job_name: inference
    static_configs:
      - targets: ["host.docker.internal:8000"]   # TODO: your engine host:port

# Grafana panel queries (PromQL) - check metric names on your /metrics
# p95 TTFT:
#   histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))
# TODO: p99 ITL
# TODO: output tokens/s from the generation tokens counter
# TODO: running and waiting requests, KV cache usage, preemptions
`,
      checks: [
        "The waiting-requests panel rises above zero during the concurrent burst and returns to zero afterwards.",
        "TTFT p95 is visibly higher in the concurrent run than in the sequential one.",
        "Dashboard JSON is committed and re-imports cleanly into a fresh Grafana.",
      ],
      stretch: "Add NVIDIA's DCGM exporter and put GPU memory and power next to the engine metrics; note where GPU utilisation misleads.",
      sim: "load-test",
    },
  },
  "12.4": {
    realLife: {
      title: "Testing stadium gates before a cricket final",
      story:
        "Before a final, organisers rehearse entry. A few volunteers walking through tell them nothing; they need tens of thousands arriving on the real schedule, whether or not the gates keep up. They report how long the typical fan waited and how long the slowest one in a hundred waited, because that fan is the one on the evening news.",
      mapping: [
        { everyday: "Fans arriving on schedule regardless of the queue", concept: "Open-loop load at a fixed arrival rate" },
        { everyday: "Volunteers who only walk in after the last one is through", concept: "Closed-loop load, which hides queueing" },
        { everyday: "The slowest fan in a hundred", concept: "p99 latency, not the mean" },
        { everyday: "The arrival rate where the queue stops clearing", concept: "The knee: the highest load that still meets the SLO" },
      ],
    },
    build: {
      title: "A 1,000-concurrency load test with honest percentiles",
      goal: "An asyncio load generator plus a vllm bench serve run that ramp to at least 1,000 concurrent streams and report p50/p95/p99 TTFT, ITL and end-to-end latency with a marked knee.",
      minutes: 120,
      stack: ["Python", "asyncio", "openai", "numpy", "vllm bench serve or genai-perf"],
      steps: [
        "Write an asyncio client that streams responses and records TTFT, every inter-token gap and end-to-end time per request, counting errors and timeouts separately.",
        "Sample input and output lengths from a realistic distribution (for example a public chat dataset) with a fixed seed, and cap output with max_tokens.",
        "Raise the client's file and connection limits, run it from a separate machine if possible, and confirm its CPU stays below saturation.",
        "Ramp concurrency 1, 8, 32, 128, 256, 512, 1,000, 1,500 and record throughput and p50/p95/p99 for each step in a CSV.",
        "Repeat the 1,000 step with vllm bench serve (or genai-perf) and compare its numbers with yours.",
        "Plot throughput and p95 TTFT against concurrency and mark the knee against an SLO you choose.",
      ],
      starter: `import asyncio, time, numpy as np
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="http://localhost:8000/v1", api_key="x", timeout=600)
MODEL = "Qwen/Qwen2.5-7B-Instruct"

async def one(prompt: str, max_tokens: int) -> dict:
    t0 = time.perf_counter(); stamps = []
    # TODO: stream a chat completion, append time.perf_counter() per content chunk
    # TODO: return ttft, list of inter-token gaps, e2e, ok/error
    ...

async def step(concurrency: int, prompts: list[tuple[str, int]]) -> dict:
    sem = asyncio.Semaphore(concurrency)
    # TODO: run all prompts under the semaphore, gather results
    # TODO: compute p50/p95/p99 for ttft, itl, e2e; output tokens/s; errors
    ...

# TODO: for c in [1, 8, 32, 128, 256, 512, 1000, 1500]: write a CSV row
`,
      checks: [
        "The report shows p50, p95 and p99 for TTFT, ITL and end-to-end latency at every step, never only the mean.",
        "At least one step runs 1,000 or more concurrent requests with the error count reported.",
        "Your client's numbers and the benchmark tool's numbers agree within about 10-15% at the same concurrency.",
        "The knee is marked and matches the point where waiting requests stop returning to zero on your dashboard.",
      ],
      stretch: "Add an open-loop mode with Poisson arrivals at a fixed rate and compare where its knee falls versus the closed-loop ramp.",
      sim: "load-test",
    },
  },
  "12.5": {
    realLife: {
      title: "A metro line versus a chartered tour bus",
      story:
        "A chartered tour bus leaves when everyone is aboard and only takes new passengers after the whole tour returns, even if most people got off at the first stop. A metro train lets people off and on at every station, so seats rarely stay empty. When a school group of 200 arrives, the station staff split them across several trains instead of holding one train at the platform while they all board.",
      mapping: [
        { everyday: "Tour bus that waits for the whole tour", concept: "Static batching: the batch runs until its longest sequence finishes" },
        { everyday: "Boarding and leaving at every station", concept: "Continuous batching: the scheduler admits and retires sequences every step" },
        { everyday: "Splitting the school group across trains", concept: "Chunked prefill: a long prompt is split across steps so decodes keep moving" },
        { everyday: "Carriage capacity per train", concept: "The per-step token budget (max-num-batched-tokens)" },
      ],
    },
    build: {
      title: "Read the scheduler, then tune its budget",
      goal: "A one-page annotated walkthrough of one scheduling step in vLLM or SGLang, and a measured TTFT vs ITL trade-off from sweeping the token budget.",
      minutes: 120,
      stack: ["vLLM or SGLang source", "Python", "your 12.4 load tester", "Grafana"],
      steps: [
        "Check out the engine source at the exact version you deployed and find the scheduler's main schedule function (search for 'def schedule' or 'max_num_batched_tokens').",
        "Write a one-page note: how running requests are served, how waiting requests are admitted, where the token budget is spent, and what triggers preemption, with file and line references.",
        "Build a mixed workload: 64 steady chat streams plus one 16,000-token prompt every 10 seconds.",
        "Run it with max-num-batched-tokens of 2,048, 8,192 and 16,384 (or SGLang's chunked-prefill-size), recording chat p99 ITL and long-prompt TTFT.",
        "Pick a setting for a chat SLO you state, and justify it from the table.",
      ],
      starter: `# sweep.py - reuse your load tester from 12.4
import subprocess, json

BUDGETS = [2048, 8192, 16384]
results = []
for b in BUDGETS:
    # TODO: restart the engine with --max-num-batched-tokens b (check current flag)
    # TODO: wait for /health, warm up
    # TODO: run 64 chat streams + one 16k prompt every 10 s for 3 minutes
    # TODO: collect chat ITL p50/p99 and long-prompt TTFT p50/p95
    results.append({"budget": b})
print(json.dumps(results, indent=2))
`,
      checks: [
        "Your note names the files and functions for admission, budget accounting and preemption at your engine version.",
        "Chat p99 ITL rises as the budget grows, and long-prompt TTFT falls.",
        "Your chosen setting meets the SLO you wrote down in the load test.",
      ],
      stretch: "Do the same reading for the other engine and list three concrete differences between the two schedulers.",
      sim: "batching",
    },
  },
  "12.6": {
    realLife: {
      title: "A hotel checking in a conference group",
      story:
        "A hotel used to block a whole floor for every conference group, even when half the delegates never came. Now the front desk gives rooms one at a time as delegates arrive, anywhere in the building, and keeps a list of which rooms belong to which group. When the hotel is full and a delegate needs another night, the manager asks the most recently arrived group to leave and check in again later.",
      mapping: [
        { everyday: "Blocking a whole floor per group", concept: "Contiguous KV reservation for the maximum length, mostly wasted" },
        { everyday: "Rooms handed out one at a time, anywhere", concept: "Fixed-size KV blocks allocated on demand from a pool" },
        { everyday: "The front desk's list of rooms per group", concept: "The block table mapping logical blocks to physical blocks" },
        { everyday: "Asking a group to leave and re-check in", concept: "Preemption with recompute. Breaks down: the group's luggage is gone; the engine must recompute their KV from scratch" },
      ],
    },
    build: {
      title: "Trace a token to its memory address, then stress the cache",
      goal: "A written trace of how vLLM maps a token position to a physical KV slot, plus a measured preemption threshold and an FP8 KV cache comparison on your hardware.",
      minutes: 120,
      stack: ["vLLM source", "Python", "Grafana", "your load tester"],
      steps: [
        "Read the block pool, the KV cache manager's allocate function and the worker's block table in the vLLM source at your version; write down how a token index becomes a block id and offset.",
        "Using the KV formula, predict the number of concurrent 8,000-token sequences your GPU can hold.",
        "Run a load test that ramps concurrency of 8,000-token requests past that prediction and watch KV usage, the preemption counter and p99 latency.",
        "Restart with --kv-cache-dtype fp8 (check current flag), repeat, and compare capacity, preemptions and latency.",
        "Run 30 long-context questions from your eval set under both cache types and compare answers.",
      ],
      starter: `def kv_bytes_per_token(layers: int, kv_heads: int, head_dim: int, dtype_bytes: int) -> int:
    return 2 * layers * kv_heads * head_dim * dtype_bytes

def max_seqs(free_gb: float, tokens_per_seq: int, kvpt: int, block: int = 16) -> int:
    # TODO: round tokens_per_seq up to whole blocks, then divide free memory
    ...

def physical_slot(block_table: list[int], token_idx: int, block: int = 16) -> tuple[int, int]:
    # TODO: return (physical block id, offset inside the block)
    ...

# TODO: plug in your model's config and the free memory from the vLLM startup log
`,
      checks: [
        "Your predicted concurrency is within about 20% of where preemptions start.",
        "The preemption counter rises and p99 latency jumps once you pass the KV capacity.",
        "FP8 KV roughly doubles the token capacity reported in the startup log.",
        "You report whether long-context answers changed with the FP8 cache.",
      ],
      stretch: "Try a KV offloading connector or SGLang's hierarchical cache and measure how much it helps a workload of repeated long documents.",
      sim: "kv-cache",
    },
  },
  "12.7": {
    realLife: {
      title: "A delivery app reusing the route out of the warehouse",
      story:
        "Every delivery from a city warehouse starts along the same highway before splitting off to different neighbourhoods. The routing app computes that shared stretch once and reuses it, only working out the last few kilometres for each address. If the warehouse moves even one street, none of the saved routes apply, because every route was computed from the old starting point.",
      mapping: [
        { everyday: "The shared highway stretch", concept: "The common prompt prefix (system prompt, tools, few-shot examples)" },
        { everyday: "Computing only the last kilometres", concept: "Prefilling only the tokens after the cached prefix" },
        { everyday: "The warehouse moving one street", concept: "A changed early token (like a timestamp) invalidating every block after it" },
        { everyday: "Sending riders from the warehouse that has the route saved", concept: "Prefix-aware routing to the replica holding the cache" },
      ],
    },
    build: {
      title: "Measure what prefix caching buys your workload",
      goal: "A benchmark of three workloads with prefix caching on and off, showing hit rate and TTFT, and a fixed prompt template that keeps the hit rate high.",
      minutes: 60,
      stack: ["vLLM or SGLang", "Python", "Prometheus"],
      steps: [
        "Create three 500-request workloads: a 2,000-token shared system prompt plus short questions; multi-turn chats of 6 turns; unique one-off prompts of the same length.",
        "Add a fourth variant of the first workload with a timestamp on the first line of the system prompt.",
        "Run all four with prefix caching enabled and disabled, recording TTFT p50/p95 and the prefix cache hit rate from /metrics.",
        "Rewrite the timestamp template so variable content comes after the stable part, rerun it, and record the change.",
      ],
      checks: [
        "The shared-prompt workload shows a high hit rate and a TTFT drop of several times with caching on.",
        "The unique-prompt workload shows no meaningful change.",
        "The timestamp variant has a near-zero hit rate until you move the timestamp after the stable prefix.",
      ],
      stretch: "Run two replicas behind round-robin and behind session-hash routing, and compare hit rates for the multi-turn workload.",
      studio: "inference-serving",
    },
  },
  "12.8": {
    realLife: {
      title: "Compressing photos before sending them to a group chat",
      story:
        "Phones shrink photos before sending them to a family group chat. The files are a fraction of the size and send much faster, and holiday snaps look the same. But a screenshot of a bank statement with tiny numbers comes out blurry, so for those you send the original file.",
      mapping: [
        { everyday: "A smaller file that sends faster", concept: "Fewer bytes per weight, so faster memory-bound decode and more room for KV cache" },
        { everyday: "Holiday snaps that look the same", concept: "Most tasks score nearly the same after FP8 or good INT4 quantization" },
        { everyday: "The blurry bank statement", concept: "Fragile tasks (long context, maths, code, strict formats) that degrade first" },
        { everyday: "Choosing original or compressed per photo", concept: "Choosing a format per workload based on your own eval. Breaks down: a model is quantized once at load time, not per request" },
      ],
    },
    build: {
      title: "BF16 vs FP8 vs INT4 on your own eval",
      goal: "A table comparing three quantization variants of one model on memory, KV capacity, latency, throughput at load and eval score.",
      minutes: 120,
      stack: ["vLLM", "Python", "your 12.4 load tester", "your eval set from Level 7"],
      steps: [
        "Pick one 7-8B model and obtain three variants: the BF16 original, FP8 (on-the-fly with --quantization fp8 or a published FP8 checkpoint) and a trusted AWQ or GPTQ INT4 checkpoint.",
        "For each, record weight memory and KV capacity from the startup log.",
        "Measure single-stream decode tokens/s and throughput plus p95 ITL at 256 concurrent requests.",
        "Run 50-100 questions from your eval set with greedy decoding and score them, including some fragile cases (long input, numbers, JSON output).",
        "Fill one comparison table and pick the cheapest variant whose score you accept, in writing.",
      ],
      checks: [
        "Weight memory falls roughly 2x for FP8 and 3x for INT4 compared with BF16.",
        "You report throughput at 256 concurrency, not only batch-1 speed.",
        "The eval score for each variant is reported with the categories where it dropped most.",
      ],
      stretch: "Quantize the model yourself with llm-compressor using a calibration set drawn from your own traffic and compare it with the published checkpoint.",
      sim: "quantization",
    },
  },
  "12.9": {
    realLife: {
      title: "A manager approving a junior's draft reply",
      story:
        "A junior drafts the next five sentences of a customer email. The manager reads all five in one go, keeps them up to the first sentence she disagrees with, writes that sentence herself, and hands it back. On routine replies most sentences survive and the email is done in a fraction of the time; on a delicate complaint she rewrites nearly everything and the junior's drafts just cost reading time.",
      mapping: [
        { everyday: "The junior's five drafted sentences", concept: "Draft tokens from n-gram lookup, a small model or EAGLE-style heads" },
        { everyday: "The manager reading all five at once", concept: "One target forward pass verifying k tokens" },
        { everyday: "Keeping sentences up to the first disagreement", concept: "Accepting the longest agreeing prefix plus one target token, so output is unchanged" },
        { everyday: "The delicate complaint", concept: "Low acceptance rate, where speculation stops paying. Breaks down: a busy manager with a full inbox is the large-batch case, where she has no spare reading time at all" },
      ],
    },
    build: {
      title: "Where speculative decoding helps and where it doesn't",
      goal: "A measured comparison of speculative decoding on two workloads and three concurrency levels, plus a short log of one inference paper's claim tested on your setup.",
      minutes: 90,
      stack: ["vLLM or SGLang", "Python", "your 12.4 load tester"],
      steps: [
        "Enable n-gram speculative decoding with 4 speculative tokens using the engine's speculative config flag (check current syntax).",
        "Build two workloads: a copy-heavy edit task (fix typos in a 400-word passage) and an open-ended story task.",
        "Run both at concurrency 1, 32 and 256, with and without speculation, recording ITL p50/p95, output throughput and the acceptance rate the engine reports.",
        "Write a two-line rule for when you would turn speculation on in production.",
        "Pick one recent inference paper or engine release note, write down a single claim and its conditions, and test a scaled-down version on your server.",
      ],
      checks: [
        "The edit task shows a clear ITL gain at low concurrency and a higher acceptance rate than the story task.",
        "At 256 concurrency the gain shrinks or reverses, and you report it.",
        "Your research log entry states the claim, the paper's conditions and your own result.",
      ],
      stretch: "Try an EAGLE-style drafter for your model if one is published and compare its acceptance rate with n-gram lookup.",
      studio: "inference-serving",
    },
  },
  "12.10": {
    realLife: {
      title: "A bank opening counters by the token queue",
      story:
        "A bank branch watches the number of people holding queue tokens, not how busy the security guard looks, to decide when to open another counter. Opening one takes ten minutes because the cashier must collect a cash drawer and log in, so the manager opens early when the queue grows and closes counters slowly after the rush. A greeter sends customers with ongoing cases back to the cashier who already has their file.",
      mapping: [
        { everyday: "People holding queue tokens", concept: "Waiting requests (queue depth) as the autoscaling signal" },
        { everyday: "How busy the guard looks", concept: "CPU utilisation, which says little about GPU load" },
        { everyday: "Ten minutes to open a counter", concept: "Cold start: node, image pull, weight load and warm-up" },
        { everyday: "Sending customers to the cashier with their file", concept: "Load- and prefix-aware routing across replicas" },
      ],
    },
    build: {
      title: "Autoscale an inference server on queue depth",
      goal: "A local Kubernetes deployment of an inference server that KEDA scales on a Prometheus queue metric, with a burst test showing scale-out and scale-in.",
      minutes: 120,
      stack: ["kind or minikube", "llama.cpp server (or vLLM on a GPU cluster)", "Prometheus", "KEDA", "kubectl"],
      steps: [
        "Create a local cluster and deploy llama.cpp's server with a small GGUF model, --metrics on, a startup probe with a generous threshold and the model on a persistent volume.",
        "Install Prometheus (for example via a Helm chart) and confirm it scrapes the server's queue metric.",
        "Install KEDA and add a ScaledObject with a Prometheus trigger on the summed queue metric, min 1 and max 4 replicas, and a long cooldown.",
        "Fire a burst of 200 concurrent requests and record replicas, queue depth and p95 latency over time.",
        "Write down the time from queue growth to a new replica serving traffic, and explain each part of the delay.",
      ],
      starter: `apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: llm
spec:
  scaleTargetRef:
    name: llm                 # TODO: your Deployment name
  minReplicaCount: 1
  maxReplicaCount: 4
  cooldownPeriod: 600
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-server.monitoring:80   # TODO
        query: sum(llamacpp:requests_deferred)  # TODO: check the name on /metrics
        threshold: "4"
`,
      checks: [
        "Replicas increase during the burst without any CPU-based HPA.",
        "Replicas return to the minimum only after the cooldown, not immediately.",
        "Your timeline separates scheduling, image pull, model load and warm-up.",
      ],
      stretch: "Replace the Service with a prefix- or load-aware router and compare p95 latency during the same burst.",
      studio: "inference-serving",
    },
  },
  "12.11": {
    realLife: {
      title: "A courier choosing bicycle, scooter or van",
      story:
        "A city courier decides per parcel whether to send a bicycle, a scooter or a van, based on size, deadline and price. A van is cheap per parcel only when it leaves full; a half-empty van on a quiet afternoon costs more per parcel than a scooter. Every parcel has a weight limit, and anything heavier is refused or quoted separately.",
      mapping: [
        { everyday: "Bicycle, scooter or van per parcel", concept: "A router choosing a model by cost, latency and quality" },
        { everyday: "A full van vs a half-empty one", concept: "GPU utilisation driving self-hosted cost per request" },
        { everyday: "Cost per parcel, per customer, per month", concept: "Cost per request, per task and per user" },
        { everyday: "The weight limit per parcel", concept: "A token budget per request. Breaks down: parcels don't grow in transit, but agent tasks grow with every step" },
      ],
    },
    build: {
      title: "A cost model, a router and an enforced token budget",
      goal: "A small gateway that routes requests between a self-hosted model and a hosted API by cost, latency and quality, enforces a token budget, and logs cost per request, task and user.",
      minutes: 120,
      stack: ["Python", "FastAPI", "openai", "tiktoken or the model's tokenizer"],
      steps: [
        "From your load test, compute cost per request at 30% and 70% utilisation, and the break-even utilisation against a hosted API you would otherwise use.",
        "Write a budget function that counts tokens with the serving model's tokenizer and trims history, then retrieved chunks, then input, to fixed caps, and sets max_tokens.",
        "Write a router that picks the cheapest route meeting a per-category quality threshold (from your eval) and the request's latency SLO, with escalation when a JSON schema check fails.",
        "Log route, tokens in and out, latency and cost for every request with a task id and user id.",
        "Replay 300 requests and report cost per request, per task and per user, and the share of traffic per route.",
      ],
      starter: `from dataclasses import dataclass

ROUTES = {"self-hosted-8b": {"usd_per_1k": 0.0004, "p95_ms": 300, "quality": {"faq": 0.9, "reasoning": 0.6}},
          "hosted-large":   {"usd_per_1k": 0.01,   "p95_ms": 1200, "quality": {"faq": 0.95, "reasoning": 0.9}}}
CAPS = {"system": 1500, "history": 3000, "context": 2500, "input": 2000, "output": 600}

@dataclass
class Req:
    category: str; slo_ms: int; parts: dict; task_id: str; user_id: str

def apply_budget(req: Req, count) -> Req:
    # TODO: trim history, then context, then input to CAPS using count()
    ...

def route(req: Req, min_quality: float = 0.85) -> str:
    # TODO: filter routes by quality[category] and p95_ms <= slo, pick cheapest
    # TODO: fall back to the strongest route if none qualifies
    ...
`,
      checks: [
        "No request sent to a model exceeds the caps, verified by the logged token counts.",
        "Reasoning-category requests go to the stronger route, FAQ requests to the cheaper one.",
        "The report shows cost per request, per task and per user, and the break-even utilisation.",
      ],
      stretch: "Train a small classifier on logged requests where the cheap route failed its check, and compare its routing savings with the rule-based version.",
      sim: "router-cost",
      studio: "router-cascade",
    },
  },
  "12.12": {
    realLife: {
      title: "A magazine's published road test",
      story:
        "A car magazine publishes fuel economy and 0-100 times, but also the route, the weather, the tyre pressure and the exact trim tested, so readers and rival magazines can repeat the test. A number without those conditions is just an advert.",
      mapping: [
        { everyday: "Fuel economy and acceleration figures", concept: "Throughput, $/1M tokens, TTFT and ITL percentiles" },
        { everyday: "Route, weather, tyre pressure, trim", concept: "Hardware, versions, flags, workload distribution and seed" },
        { everyday: "Before and after a tune-up", concept: "Your baseline vs tuned configuration table" },
        { everyday: "Rivals repeating the test", concept: "A one-command reproduction others can run and compare" },
      ],
    },
    build: {
      title: "First milestone: a reproducible baseline",
      goal: "A public repo where one command deploys your model, starts Prometheus and Grafana, and runs the baseline load test that produces a results table.",
      minutes: 120,
      stack: ["vLLM or SGLang (llama.cpp for the no-GPU path)", "Docker Compose", "Prometheus", "Grafana", "Python"],
      steps: [
        "Choose your hardware path (one rented GPU with a 7-8B model, or a laptop with a 0.5-3B model) and write your predicted memory, KV capacity and decode ceiling in the README before measuring.",
        "Create the repo with launch script, docker-compose.yml (engine, Prometheus, Grafana), dashboard JSON and versions.txt.",
        "Add the load test with a fixed workload file and seed, and a make target or script that runs the full concurrency ramp up to 1,000+ and writes results to CSV.",
        "Run it, generate a results table (p50/p95/p99 TTFT, ITL, e2e, throughput, errors) and the $/1M output tokens at your SLO from the hourly price you paid.",
        "Ask a friend, or a fresh cloud machine, to run the one command and confirm the numbers land within about 10%.",
      ],
      checks: [
        "A fresh clone reaches a results table with one documented command.",
        "The README shows predicted vs measured numbers side by side.",
        "The baseline table includes p50/p95/p99 and $/1M tokens, not just averages.",
      ],
      stretch: "Add the tuning runs (batching budget, prefix cache, quantization, speculative decoding) as separate configs so the before/after table regenerates from the same script.",
      studio: "inference-serving",
      sim: "load-test",
    },
  },
};
