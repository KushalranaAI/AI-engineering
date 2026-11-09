import type { PracticeMap } from "./types";

export const PRACTICE: PracticeMap = {
  "1.1": {
    realLife: {
      title: "Your phone keyboard's next-word suggestions",
      story:
        "Type 'Reached home, will call you' on your phone and the keyboard offers 'later', 'tomorrow', 'back'. Tap one and it immediately suggests the next word based on everything typed so far. Keep tapping the middle suggestion and you get a fluent but rambling message. It never looked anything up; it only learned which words tend to follow which from a lot of typing.",
      mapping: [
        { everyday: "Three suggested words with the best one in the middle", concept: "A probability distribution over the next token" },
        { everyday: "Tap one, and new suggestions appear based on the whole message", concept: "Append the chosen token and predict again: the generation loop" },
        { everyday: "Fluent sentences with no fact-checking", concept: "Likely text, not a database lookup" },
        { everyday: "Where it breaks: an LLM sees far more context and was trained on vastly more text, so it can follow instructions and do many tasks", concept: "Scale turns next-token prediction into general ability" },
      ],
    },
    build: {
      title: "Watch next-token prediction happen with a tiny local model",
      goal: "A script that runs a small open model locally, prints the top-5 next-token probabilities at each step, and generates text one token at a time with your own loop.",
      minutes: 45,
      stack: ["Python", "transformers", "torch"],
      steps: [
        "Install `transformers` and `torch` and load a small causal model such as `Qwen/Qwen2.5-0.5B` (or `gpt2` if your machine is slow).",
        "Tokenise a prompt like 'The capital of France is' and run one forward pass; softmax the last position's logits and print the top 5 tokens with probabilities.",
        "Write your own loop: pick the top token, append it, repeat 15 times, printing the top-3 alternatives at each step.",
        "Swap greedy picking for random sampling from the distribution and run it three times; compare the three outputs.",
        "Try a prompt asking the same model to translate, then to classify sentiment, and note that the loop did not change, only the input.",
      ],
      starter:
        "import torch\nfrom transformers import AutoModelForCausalLM, AutoTokenizer\n\nname = \"Qwen/Qwen2.5-0.5B\"\ntok = AutoTokenizer.from_pretrained(name)\nmodel = AutoModelForCausalLM.from_pretrained(name)\n\nids = tok(\"The capital of France is\", return_tensors=\"pt\").input_ids\nfor step in range(15):\n    with torch.no_grad():\n        logits = model(ids).logits[0, -1]\n    probs = torch.softmax(logits, dim=-1)\n    top = torch.topk(probs, 3)\n    # TODO: print each candidate with tok.decode(...) and its probability\n    # TODO: choose next id (greedy first, then torch.multinomial)\n    # TODO: ids = torch.cat([ids, next_id.view(1, 1)], dim=1)\nprint(tok.decode(ids[0]))",
      checks: [
        "Your printout shows ' Paris' as a high-probability candidate after the France prompt.",
        "Greedy runs give identical text every time; sampled runs differ.",
        "You can point to the single line in your loop that makes generation one token at a time.",
      ],
      stretch: "Compare the top-5 list for the same prompt on `gpt2` and on Qwen and explain the difference in two sentences.",
    },
  },
  "1.2": {
    realLife: {
      title: "Paying per word on a courier's telegram-style SMS pack",
      story:
        "A bulk SMS plan bills you by message segment, not by idea. A plain English message fits in one segment, but the same message in Hindi, or with a couple of emoji, switches encoding and splits into three segments, so it costs three times as much and arrives in pieces. You learn to watch the segment counter, not the word count.",
      mapping: [
        { everyday: "Message segments the operator bills by", concept: "Tokens, the unit of price and context" },
        { everyday: "Hindi or emoji turning one segment into three", concept: "Non-Latin scripts and emoji using more tokens per character" },
        { everyday: "Same idea, different bill", concept: "Similar word counts, very different token counts" },
        { everyday: "Where it breaks: SMS splits on fixed character counts, while tokenizers split on learned sub-word pieces that differ between models", concept: "Tokenizer-specific splits" },
      ],
    },
    build: {
      title: "A token cost inspector for mixed text",
      goal: "A script that shows how a piece of text splits into tokens under two tokenizers and estimates its cost and context share.",
      minutes: 40,
      stack: ["Python", "tiktoken", "transformers (tokenizer only)"],
      steps: [
        "Write a function that takes text and returns token ids, the decoded pieces, and token count, using `tiktoken.get_encoding(\"o200k_base\")`.",
        "Add a second tokenizer from Hugging Face (for example the Qwen or Llama tokenizer) and show both splits side by side.",
        "Run it on: a UPI transaction SMS, a Hindi or Tamil sentence, a JSON blob, a line of Python, and a phone number list; print pieces separated by `|`.",
        "Add a cost column using an example price you set as a constant (for example $0.15 per million input tokens) and a 'percent of a 128k window' column.",
        "Explain in a comment why the model might miscount letters in 'strawberry', using the printed pieces as evidence.",
      ],
      starter:
        "import tiktoken\nfrom transformers import AutoTokenizer\n\nPRICE_PER_M = 0.15  # example price, not a fact\nenc = tiktoken.get_encoding(\"o200k_base\")\nhf = AutoTokenizer.from_pretrained(\"Qwen/Qwen2.5-0.5B\")\n\nSAMPLES = {\n    \"upi_sms\": \"Rs.450.00 debited from A/c XX1234 to VPA chai@okicici on 06-11-26\",\n    \"hindi\": \"\",  # TODO\n    \"json\": '{\"order_id\": 1192, \"status\": \"shipped\"}',\n    # TODO: python line, number list, emoji\n}\n\nfor name, text in SAMPLES.items():\n    ids = enc.encode(text)\n    pieces = [enc.decode([i]) for i in ids]\n    # TODO: same for hf; print counts, '|'.join(pieces), chars per token, cost\n    ...",
      checks: [
        "The Hindi sample shows clearly fewer characters per token than the English sample.",
        "The two tokenizers give different counts for at least three samples.",
        "Your cost column is computed from the token count, not from words or characters.",
      ],
      stretch: "Find a 10-word English sentence and a 10-word sentence in another language whose token counts differ by more than 2x.",
    },
  },
  "1.3": {
    realLife: {
      title: "A cricket scorer reading back through the over",
      story:
        "When a commentator says 'he's been hit there again', the scorer looks back through the earlier balls to work out who 'he' is and where 'there' is: the batter from two balls ago, the cover region from the last boundary. Each new ball's meaning is built from the earlier balls that matter, never from balls not yet bowled. A large commentary team covers more, but a small team where only the relevant specialist speaks on each ball can be just as sharp and cheaper to run.",
      mapping: [
        { everyday: "Looking back to find who 'he' refers to", concept: "Attention: a token gathering information from relevant earlier tokens" },
        { everyday: "Only past balls count, never future ones", concept: "Causal masking" },
        { everyday: "What the scorer is looking for vs how each past ball is labelled vs what it contributes", concept: "Query, key and value" },
        { everyday: "Only the relevant specialist commentator speaks per ball", concept: "Mixture-of-experts: total vs active parameters" },
      ],
    },
    build: {
      title: "Single-head causal attention from scratch in NumPy",
      goal: "A NumPy implementation of one attention head with a causal mask, plus an MoE memory calculator, both checked against known numbers.",
      minutes: 75,
      stack: ["Python", "numpy"],
      steps: [
        "Create random embeddings for a 6-token sentence (shape 6 x 16) and random weight matrices Wq, Wk, Wv (16 x 8).",
        "Compute Q, K, V, the scores Q K^T / sqrt(d), apply a causal mask (set future positions to -inf), softmax each row and multiply by V.",
        "Print the attention weight matrix and confirm the upper triangle is all zeros.",
        "Hand-craft K and Q so token 5 ('it') attends mostly to token 1 ('animal'), and show it in the printed weights.",
        "Write `moe_memory(total_params_b, active_params_b, bytes_per_param)` that prints memory needed to load the weights and compute used per token; run it on a model card of your choice (for example a 47B-total, 13B-active model).",
      ],
      starter:
        "import numpy as np\nrng = np.random.default_rng(0)\nT, d_model, d = 6, 16, 8\nX = rng.normal(size=(T, d_model))\nWq, Wk, Wv = (rng.normal(size=(d_model, d)) for _ in range(3))\n\nQ, K, V = X @ Wq, X @ Wk, X @ Wv\nscores = Q @ K.T / np.sqrt(d)\n# TODO: mask = np.triu(np.ones((T, T)), k=1).astype(bool); scores[mask] = -np.inf\n# TODO: row-wise softmax -> weights\n# TODO: out = weights @ V\n\ndef moe_memory(total_b: float, active_b: float, bytes_per_param: float = 2.0) -> None:\n    # TODO: GB to load = total_b * bytes_per_param; per-token compute ~ active_b\n    ...",
      checks: [
        "Every row of the weight matrix sums to 1 and the upper triangle is exactly 0.",
        "Row 0 puts all its weight on position 0.",
        "Your hand-crafted case puts more than half of token 5's weight on token 1.",
        "The MoE calculator shows loading memory follows total parameters while per-token compute follows active ones.",
      ],
      stretch: "Extend to two heads with different weights and concatenate their outputs.",
    },
  },
  "1.4": {
    realLife: {
      title: "A medical graduate becoming a clinic doctor",
      story:
        "After years of reading textbooks a medical graduate knows an enormous amount, but on day one at a clinic she might answer a patient's question with a lecture or a list of exam questions. Internship teaches the format: listen, ask follow-ups, explain plainly, refer when unsure. Senior doctors then rate her consultations and she adjusts toward the ones they prefer, including politely refusing to prescribe what isn't needed.",
      mapping: [
        { everyday: "Years of reading textbooks", concept: "Pretraining on next-token prediction over huge text" },
        { everyday: "Internship showing what a good consultation looks like", concept: "Supervised fine-tuning on example conversations" },
        { everyday: "Seniors rating consultations, she drifts toward the preferred ones", concept: "Preference or reinforcement training" },
        { everyday: "Where it breaks: the model never checks a patient; it only learns what good answers look like, so it can still be confidently wrong", concept: "Post-training shapes behaviour, not truthfulness" },
      ],
    },
    build: {
      title: "Base vs instruct vs your own tiny SFT",
      goal: "A notebook comparing a base model and its instruct sibling on five prompts, then nudging the base model with a handful of supervised examples to see the format change.",
      minutes: 90,
      stack: ["Python", "transformers", "trl (optional)", "torch"],
      steps: [
        "Load a small base model and its instruct version (for example the 0.5B Qwen pair) and run five prompts: a question, a list request, a refusal-worthy request, a rewrite, and a math word problem.",
        "For the instruct model use the chat template (`tok.apply_chat_template`); for the base model send raw text, and tabulate the differences in format and behaviour.",
        "Write 30 tiny instruction/response pairs in one consistent style (for example 'Answer in exactly two bullet points').",
        "Fine-tune the base model on them for a few hundred steps with TRL's SFTTrainer (or a short manual loop); keep it CPU/GPU friendly with a small batch.",
        "Rerun the five prompts on the tuned base model and compare with the other two.",
      ],
      checks: [
        "Your table shows the base model continuing text (or inventing more questions) where the instruct model answers.",
        "After your SFT, the base model follows the two-bullet style on prompts not in your 30 examples.",
        "You can name one thing your SFT did not fix (facts, refusals, or reasoning) and why.",
      ],
      stretch: "Add five deliberately bad responses and ten good ones and describe how a preference method such as DPO would use them.",
    },
  },
  "1.5": {
    realLife: {
      title: "A tea stall at a railway platform",
      story:
        "When you order at a station chai stall, the vendor first takes in the whole order at once: four cups, two without sugar, one extra strong. That part is quick. Then he pours cup by cup, and each cup takes the same few seconds, so twelve cups take far longer than two. He keeps the order in his head rather than asking you to repeat it before every cup.",
      mapping: [
        { everyday: "Taking in the whole order at once", concept: "Prefill: processing the prompt in parallel" },
        { everyday: "Pouring cup by cup", concept: "Decode: generating output tokens one at a time" },
        { everyday: "Time until your first cup is in hand", concept: "Time to first token (TTFT)" },
        { everyday: "Remembering the order instead of hearing it again for every cup", concept: "The KV cache" },
      ],
    },
    build: {
      title: "A latency profiler for prompt and output length",
      goal: "A script that measures TTFT, tokens per second and total time across a grid of input and output sizes, and plots how each one scales.",
      minutes: 60,
      stack: ["Python", "openai or anthropic SDK", "matplotlib"],
      steps: [
        "Write `measure(prompt, max_tokens)` that streams a response and records TTFT (first content chunk), total time, and output token count from final usage.",
        "Build a grid: input sizes of about 200, 2,000 and 20,000 tokens (pad with a long document) and requested outputs of about 20, 200 and 1,000 tokens.",
        "Run each cell three times and keep the median.",
        "Plot TTFT against input size and total time against output size; compute tokens per second for each run.",
        "Write two sentences explaining which axis drives TTFT and which drives total time, using your numbers.",
      ],
      starter:
        "import time\nfrom openai import OpenAI\nclient = OpenAI()\n\ndef measure(prompt: str, max_tokens: int, model: str = \"gpt-4o-mini\") -> dict:\n    t0 = time.perf_counter()\n    ttft = None\n    out_tokens = 0\n    stream = client.chat.completions.create(\n        model=model, max_tokens=max_tokens, stream=True,\n        stream_options={\"include_usage\": True},\n        messages=[{\"role\": \"user\", \"content\": prompt}],\n    )\n    for chunk in stream:\n        # TODO: set ttft on the first chunk with content\n        # TODO: read chunk.usage.completion_tokens when present\n        ...\n    total = time.perf_counter() - t0\n    return {\"ttft\": ttft, \"total\": total, \"out\": out_tokens}\n\n# TODO: grid over input sizes x output sizes, median of 3, plot",
      checks: [
        "TTFT grows with input size while staying much smaller than total time for long outputs.",
        "Total time grows roughly linearly with output tokens.",
        "Tokens per second is roughly stable for a given model across output sizes.",
      ],
      stretch: "Repeat the 20,000-token run twice in a row and see whether provider-side prompt caching lowers TTFT on the second call.",
      sim: "roofline",
    },
  },
  "1.6": {
    realLife: {
      title: "Picking a song on a long road trip",
      story:
        "On a family drive, Dad always plays the top song on his most-played list: safe, predictable, the same every trip. Your cousin shuffles the whole library, which is fun until a horror podcast starts. The sensible setting is 'shuffle, but only among the 20 songs we actually like', and you stop when you reach home.",
      mapping: [
        { everyday: "Always the most-played song", concept: "Greedy decoding or temperature 0" },
        { everyday: "Shuffling the entire library", concept: "High temperature: flattening the distribution" },
        { everyday: "Shuffle only among the songs you like", concept: "Top-p / top-k: sampling from the likely set" },
        { everyday: "Stopping when you reach home", concept: "Max tokens and stop sequences" },
      ],
    },
    build: {
      title: "A sampling lab with your own sampler",
      goal: "A local sampler that applies temperature, top-k and top-p to real model logits, plus an API experiment that picks settings for three task types by measurement.",
      minutes: 60,
      stack: ["Python", "numpy", "transformers or an LLM API"],
      steps: [
        "Implement `sample(logits, temperature, top_k, top_p)` in NumPy: scale by temperature, keep the top-k, then keep the smallest set reaching top_p, renormalise, and draw.",
        "Feed it logits from a small local model (as in 1.1) and print how many candidate tokens survive filtering at each setting.",
        "Using an API, run three tasks ten times each at three settings: extracting a date from an SMS, naming a bakery, and continuing a story; count distinct outputs and errors.",
        "Add a stop sequence (for example a blank line) to the story task and confirm it cuts output where you expect.",
        "Write a one-line recommended setting per task backed by your counts.",
      ],
      starter:
        "import numpy as np\nrng = np.random.default_rng()\n\ndef sample(logits: np.ndarray, temperature: float = 1.0, top_k: int | None = None, top_p: float | None = None) -> int:\n    if temperature == 0:\n        return int(np.argmax(logits))\n    z = logits / temperature\n    probs = np.exp(z - z.max()); probs /= probs.sum()\n    order = np.argsort(probs)[::-1]\n    # TODO: if top_k, keep only order[:top_k]\n    # TODO: if top_p, keep the shortest prefix of order whose cumulative prob >= top_p\n    # TODO: renormalise kept probs and draw with rng.choice\n    ...",
      checks: [
        "At temperature 0 your sampler returns the same id every call.",
        "top_p=0.9 keeps far fewer candidates than top_p=1.0 on a confident prompt.",
        "Date extraction gives one distinct answer at low temperature and wobbles at high temperature.",
      ],
      stretch: "Check which of these knobs your provider's reasoning model accepts and note what the API does with the rest.",
    },
  },
  "1.7": {
    realLife: {
      title: "A CA preparing a tax return vs answering a quick question",
      story:
        "Ask your chartered accountant 'is my rent receipt valid for HRA?' and she answers in ten seconds. Ask her to plan a year's taxes across salary, capital gains and a rental flat, and she takes the file home, works through it on scratch paper, and bills for the hours. Asking her to spend an evening on the HRA question would just cost you more for the same answer.",
      mapping: [
        { everyday: "Scratch-paper work before the final advice", concept: "Thinking tokens produced before the answer" },
        { everyday: "Billing by hours spent", concept: "Paying for reasoning tokens and extra latency" },
        { everyday: "Telling her the goal and constraints, not how to do the arithmetic", concept: "Prompting reasoning models with goal, context and success criteria" },
        { everyday: "The quick HRA question", concept: "Tasks where reasoning adds cost but no quality" },
      ],
    },
    build: {
      title: "A reasoning-budget A/B harness",
      goal: "A script that runs a mixed task set at several reasoning effort levels and reports accuracy, latency and billed tokens per level per task type.",
      minutes: 75,
      stack: ["Python", "an API with a reasoning model (effort or thinking budget setting)", "pandas"],
      steps: [
        "Write 12 tasks with checkable answers: 4 multi-constraint scheduling or logic puzzles, 4 arithmetic word problems, 4 simple classifications.",
        "Run each on one reasoning model at low, medium and high effort (or thinking budgets such as 1k, 4k, 16k tokens; check the current docs for the exact parameter).",
        "Record correctness, wall time, output tokens and any reported reasoning tokens.",
        "Compute cost per correct answer for each task type and effort level using example prices.",
        "Write a rule of thumb for your app: which task types get which effort.",
      ],
      checks: [
        "Your table shows accuracy gains on puzzles that are larger than on classifications.",
        "Billed tokens for 'high' are several times 'low' on the same task.",
        "Your rule of thumb names at least one task type where low effort is the right choice.",
      ],
      stretch: "Add a non-reasoning model as a fourth column and see where it matches the reasoning model at lower cost.",
      sim: "router-cost",
    },
  },
  "1.8": {
    realLife: {
      title: "Packing a cabin bag for a flight",
      story:
        "Your cabin bag has a hard 7 kg limit. Laptop and charger are non-negotiable, clothes for three days compete with the gift for your aunt, and you must leave room for the shawl she will hand you to bring back. Stuffing it full means the thing you need at security is buried in the middle and you can't find it, and whatever doesn't fit stays home no matter how important it was.",
      mapping: [
        { everyday: "The 7 kg limit", concept: "The context window size in tokens" },
        { everyday: "Laptop, clothes, gift all competing for weight", concept: "System prompt, history, documents and tool results competing for space" },
        { everyday: "Room kept for the shawl coming back", concept: "Reserving space for the output tokens" },
        { everyday: "The item buried in the middle", concept: "Lost-in-the-middle and dilution in long contexts" },
      ],
    },
    build: {
      title: "A context budgeter with a needle test",
      goal: "A function that packs system prompt, history and documents into a fixed token budget with output reserved, plus a needle test showing where packing order matters.",
      minutes: 75,
      stack: ["Python", "tiktoken", "an LLM API"],
      steps: [
        "Write `pack(system, history, docs, budget, reserve_output)` that always keeps the system prompt and latest user message, then adds documents by priority and the most recent history turns until the budget is hit.",
        "Log what was dropped and how many tokens each part used.",
        "Create a 20k-token document set with one key fact; run the same question with the fact packed at the start, middle and end of the context.",
        "Then rerun with a smaller budget where your packer puts only the three most relevant chunks (by keyword overlap) in the context.",
        "Compare accuracy and cost of 'stuff everything' vs 'pack the relevant few'.",
      ],
      starter:
        "import tiktoken\nenc = tiktoken.get_encoding(\"o200k_base\")\nn = lambda s: len(enc.encode(s))\n\ndef pack(system: str, history: list[str], docs: list[tuple[int, str]], budget: int, reserve_output: int):\n    used = n(system) + n(history[-1]) + reserve_output\n    kept_docs, kept_hist, dropped = [], [history[-1]], []\n    for prio, doc in sorted(docs, reverse=True):\n        # TODO: add doc if it fits, else record in dropped\n        ...\n    for turn in reversed(history[:-1]):\n        # TODO: add older turns newest-first while they fit\n        ...\n    return kept_docs, list(reversed(kept_hist)), dropped, used",
      checks: [
        "The packed total plus reserved output never exceeds the budget.",
        "Your needle test shows at least one position where the model misses or blurs the fact.",
        "The 'relevant few' run is cheaper and at least as accurate as the 'stuff everything' run.",
      ],
      stretch: "Add a summary of dropped history turns as a single short message instead of losing them entirely.",
      sim: "token-budget",
    },
  },
  "1.9": {
    realLife: {
      title: "A confident auto-rickshaw driver who never says 'I don't know'",
      story:
        "Some auto drivers know the city brilliantly: they rephrase your vague directions, translate between three languages, and find the shortcut. Ask about a lane that opened last month or a shop that doesn't exist, and many will still nod and drive somewhere confidently. You learn to trust them for routing and conversation, and to check the map for the exact address.",
      mapping: [
        { everyday: "Great at rephrasing directions and translating", concept: "Strengths: transformation, translation, summarising" },
        { everyday: "Confidently driving to a shop that doesn't exist", concept: "Hallucination: producing likely text instead of checking truth" },
        { everyday: "Not knowing the lane opened last month", concept: "Stale knowledge after the training cutoff" },
        { everyday: "Checking the map for the final address", concept: "Safeguards: grounding, validation, verification" },
      ],
    },
    build: {
      title: "A reliability probe: run each task 10 times",
      goal: "A script that runs a small battery of task types ten times each and reports per-task success rate, so you know which tasks need safeguards.",
      minutes: 60,
      stack: ["Python", "an LLM API", "pandas"],
      steps: [
        "Write 15 test items across five types with an automatic checker each: extraction (date from a bill), arithmetic (multi-digit multiplication), false-premise questions, recent events after the model's cutoff, and following a 3-rule format instruction.",
        "Run every item ten times at your app's normal temperature and record pass or fail with your checker.",
        "Report success rate per type and the most common failure for each.",
        "For the two weakest types, add a safeguard (a Python calculator for arithmetic, an 'answer only from this text' context for facts) and rerun.",
      ],
      checks: [
        "Each task type has a success rate out of 10 runs, not a single yes/no.",
        "At least one task type is near 100% and at least one is clearly unreliable.",
        "Your safeguards measurably raise the success rate of the two weakest types.",
      ],
      stretch: "Ask the model to rate its own confidence and check whether high confidence predicts correctness.",
    },
  },
  "1.10": {
    realLife: {
      title: "Getting from Bengaluru airport to the city",
      story:
        "You can book a premium cab app (fast, comfortable, but you pay their price and they have your trip data), drive your own car (full control and privacy, but you handle fuel, parking and breakdowns), or take a hotel shuttle run by someone else using a standard bus. Each fits a different traveller, and the shuttle you liked last year may change routes or stop running.",
      mapping: [
        { everyday: "Premium cab app", concept: "Closed API models: top capability, less control, data leaves your account" },
        { everyday: "Driving your own car", concept: "Self-hosting open weights: control and privacy, plus operations work" },
        { everyday: "Hotel shuttle using a standard bus", concept: "Managed platforms and hosted open models" },
        { everyday: "Shuttle changing routes or stopping", concept: "Model versions, deprecations and pinning" },
      ],
    },
    build: {
      title: "Run the same task on a closed API and a local open model",
      goal: "One script that sends the same 10 prompts to a closed API model and an open-weight model running locally, with a comparison of quality, latency and what you'd need to ship each.",
      minutes: 75,
      stack: ["Python", "Ollama (local)", "an LLM API", "openai SDK"],
      steps: [
        "Install Ollama and pull a small open model (for example a 3B-8B instruct model); read its licence and note what it allows commercially.",
        "Point the OpenAI SDK at Ollama's OpenAI-compatible endpoint (`base_url=\"http://localhost:11434/v1\"`) and at your closed provider, behind one function.",
        "Run 10 prompts from one realistic task (for example summarising support tickets) through both, pinning an exact model version string for the API.",
        "Record latency, a 1-5 quality score you assign, and the model's knowledge cutoff from its card.",
        "Write a short table: data residency, cost model, ops work, licence and deprecation risk for each option.",
      ],
      starter:
        "import time\nfrom openai import OpenAI\n\nPROVIDERS = {\n    \"closed\": (OpenAI(), \"gpt-4o-mini-2024-07-18\"),  # pin an exact version\n    \"local\": (OpenAI(base_url=\"http://localhost:11434/v1\", api_key=\"ollama\"), \"llama3.2\"),\n}\n\ndef ask(provider: str, prompt: str) -> tuple[str, float]:\n    client, model = PROVIDERS[provider]\n    t0 = time.perf_counter()\n    # TODO: chat.completions.create with model and one user message\n    ...\n\n# TODO: loop 10 prompts x 2 providers, store text + latency, score by hand",
      checks: [
        "Both providers run from the same function with only configuration changing.",
        "Your table records the licence terms of the open model in your own words.",
        "You can state which option you'd pick for confidential data and why.",
      ],
      stretch: "Add a hosted open-model provider as a third route and compare its latency with your laptop.",
    },
  },
  "1.11": {
    realLife: {
      title: "Choosing a coaching institute by its toppers' board",
      story:
        "Coaching centres plaster their walls with toppers' ranks. Some of those toppers joined a month before the exam, some ranks are from a mock test the centre wrote itself, and the subject you are weak in may not be where they shine. Sensible parents use the board to shortlist three centres, then sit in on a class covering their child's actual weak topic.",
      mapping: [
        { everyday: "Toppers' board on the wall", concept: "A public leaderboard" },
        { everyday: "Ranks from a mock the centre wrote itself", concept: "Contamination and tuning to public test sets" },
        { everyday: "Strong in physics, but your child needs chemistry", concept: "Benchmarks that don't match your task" },
        { everyday: "Sitting in on a class for your actual weak topic", concept: "Deciding with your own examples" },
      ],
    },
    build: {
      title: "A mini private benchmark that can disagree with the leaderboard",
      goal: "A 25-item private eval for one task, run against three shortlisted models, producing a ranking you can compare with a public leaderboard.",
      minutes: 90,
      stack: ["Python", "an LLM API or OpenRouter", "pandas"],
      steps: [
        "Pick a task you care about (for example extracting amount, merchant and date from bank SMS) and write 25 inputs with exact expected outputs, including 5 messy ones.",
        "Shortlist three models from a public leaderboard and note their published rank and the benchmark it came from.",
        "Write a deterministic scorer (exact field match) and run each model once at temperature 0.",
        "Rank by your score, then add a column for cost per 1,000 items and median latency.",
        "Write three sentences on where your ranking differs from the leaderboard and why.",
      ],
      checks: [
        "Your scorer is code, not your judgment, and runs on all 25 items in one command.",
        "The final table has score, cost and latency for all three models.",
        "You can name one reason a public score would not transfer to this task.",
      ],
      stretch: "Check whether any of your 25 items appear verbatim online; replace them with fresh ones if so.",
    },
  },
  "1.12": {
    realLife: {
      title: "Buying a used two-wheeler for a daily commute",
      story:
        "You list what matters for a 15 km city commute: mileage, service centre nearby, seat height, budget, resale. Some are deal-breakers (budget, seat height) and knock bikes out straight away; the rest you compare by test-riding the three survivors on your actual route, not by reading magazine top-10 lists. You pick the one that does your route well at your price, even if it's not the fastest.",
      mapping: [
        { everyday: "Your list of what matters", concept: "The eight dimensions: capability, quality, latency, cost, context, modalities, privacy, API features" },
        { everyday: "Deal-breakers that knock bikes out", concept: "Hard filters (privacy, context size, budget)" },
        { everyday: "Test-riding on your actual route", concept: "Measuring on your own examples" },
        { everyday: "Picking good-enough over fastest", concept: "Choosing by requirements, not popularity" },
      ],
    },
    build: {
      title: "A reusable model-selection script with a decision record",
      goal: "A config-driven script that filters candidates by hard requirements, runs survivors on your examples, and writes a one-page decision record.",
      minutes: 90,
      stack: ["Python", "an LLM API or OpenRouter", "pyyaml", "pandas"],
      steps: [
        "Write `requirements.yaml` for one task: hard filters (max price per million tokens, min context, must support JSON output, data region) and soft weights for quality, latency and cost.",
        "Write `candidates.yaml` with 5-6 models and their published facts copied from pricing pages and model cards.",
        "Filter by hard requirements in code, run the survivors on 20 of your examples, and score quality with a deterministic checker.",
        "Combine quality, measured p50 latency and estimated monthly cost (from your expected volume) into a weighted score.",
        "Generate `DECISION.md` listing requirements, eliminated models with the reason, results table, the choice, and when to re-test.",
      ],
      checks: [
        "Changing a hard filter in YAML changes which models are tested, with no code edits.",
        "Every eliminated model has a stated reason in the decision record.",
        "Monthly cost is computed from your volume assumption, which is written down.",
      ],
      stretch: "Add a re-test trigger: rerun the script against a pinned new model version and diff the decision.",
      sim: "router-cost",
    },
  },
};
