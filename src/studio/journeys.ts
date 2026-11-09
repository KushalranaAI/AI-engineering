import { KINDS } from "./catalog";
import type { NodeKind, NodeParams, StudioEdge, StudioGraph, StudioNode } from "./types";

/**
 * Evolution journeys: one real product, designed step by step. Each stage changes one thing from the last, says why,
 * and says what to look for in the numbers. Modules link to the stage that shows what they teach.
 */
export interface Stage {
  title: string;
  /** what's different from the previous stage */
  change: string;
  /** the problem that forced the change */
  why: string;
  /** what to look at after pressing Simulate */
  watch: string;
  /** modules that teach this stage */
  modules: string[];
  rps?: number;
  graph: StudioGraph;
}
export interface Journey {
  id: string;
  title: string;
  /** the company and situation */
  scenario: string;
  stages: Stage[];
}

const n = (id: string, kind: NodeKind, x: number, y: number, params: Partial<NodeParams> = {}): StudioNode => ({ id, kind, x, y, params: { ...KINDS[kind].defaults, ...params } });
const e = (source: string, target: string, weight?: number): StudioEdge => ({ id: `${source}->${target}`, source, target, weight });
const Y = 160;

/* ---------- 1. a support assistant, from one prompt to production ---------- */
const askIn = (share = 0.8) => n("in", "input", 0, Y, { label: "Customer question", knowledgeShare: share, inTokens: 80 });
const answer = (x: number) => n("out", "output", x, Y, { label: "Answer" });
const ragLlm = (x: number, tier: NodeParams["tier"] = "medium") =>
  n("llm", "llm", x, Y, { label: "Answer from context", tier, inTokens: 2200, outTokens: 250, system: "Answer only from the context. Cite the passage. If it isn't there, say you don't know." });

const SUPPORT: Journey = {
  id: "support",
  title: "A support assistant for an online store",
  scenario: "ShopKart sells electronics online. It has 3,000 help articles and an orders database, and gets about 5 questions a second at peak. 80% of questions are about its own policies or a customer's own order.",
  stages: [
    {
      title: "Just call an LLM",
      change: "The simplest thing: send the question to a model and return its answer.",
      why: "Start here to see the baseline. It's fast and cheap, but the model has never seen ShopKart's policies or anyone's orders.",
      watch: "'Correct' sits around 30%. The model answers every question confidently, and most of those answers are made up. Nothing errors: this failure is silent.",
      modules: ["1.1", "1.9", "2.1", "2.2"],
      graph: { nodes: [askIn(), n("llm", "llm", 280, Y, { label: "General LLM", tier: "medium", inTokens: 300, outTokens: 250 }), answer(560)], edges: [e("in", "llm"), e("llm", "out")] },
    },
    {
      title: "Add retrieval (basic RAG)",
      change: "Embed the question, search the help articles, and give the top 5 passages to the model with an instruction to answer only from them.",
      why: "The facts live in ShopKart's documents, not in the model. Retrieval puts them in front of it.",
      watch: "Correct jumps to roughly 60-65%. Click the retriever: its recall (about 70%) now caps quality. A question whose passage wasn't retrieved is still answered from guesswork.",
      modules: ["4.3", "4.4", "4.5", "4.8", "4.9"],
      graph: {
        nodes: [askIn(), n("emb", "embedder", 220, Y), n("ret", "retriever", 440, Y, { label: "Vector search", recall: 0.7 }), ragLlm(680), answer(920)],
        edges: [e("in", "emb"), e("emb", "ret"), e("ret", "llm"), e("llm", "out")],
      },
    },
    {
      title: "Better retrieval: hybrid search and reranking",
      change: "Search by keywords (BM25) and meaning together, fuse the two lists, then rerank the top 30 with a cross-encoder.",
      why: "Vector search misses exact things customers type: order numbers, model names like 'XPS 13', and policy terms. Reranking puts the best passage first.",
      watch: "Recall rises to ~88%, and the reranker rescues half the misses. Correct passes 75%. Latency rises by ~150 ms: a good trade here.",
      modules: ["4.2", "4.6", "4.10", "4.11", "4.12", "7.8"],
      graph: {
        nodes: [askIn(), n("emb", "embedder", 200, Y), n("ret", "retriever", 400, Y, { label: "Hybrid search (BM25 + vectors)", recall: 0.88, latencyMs: 90 }), n("rr", "reranker", 620, Y, { label: "Cross-encoder rerank" }), ragLlm(840), answer(1060)],
        edges: [e("in", "emb"), e("emb", "ret"), e("ret", "rr"), e("rr", "llm"), e("llm", "out")],
      },
    },
    {
      title: "Order questions go to the database",
      change: "A router sends 'where is my order?' questions to an agent that looks the order up in the database. Everything else takes the RAG path.",
      why: "Order status isn't in any article. It changes every hour and belongs to one customer. A database lookup is the only correct source.",
      watch: "The order branch is almost always right, because the database gives the facts. The agent costs more per request, but only on its share of traffic.",
      modules: ["2.5", "2.6", "5.1", "5.3", "9.2"],
      graph: {
        nodes: [
          askIn(),
          n("rt", "router", 200, Y, { label: "Intent: policy or order?" }),
          n("emb", "embedder", 420, 40),
          n("ret", "retriever", 620, 40, { label: "Hybrid search", recall: 0.88, latencyMs: 90 }),
          n("rr", "reranker", 820, 40),
          n("llm", "llm", 1020, 40, { label: "Answer from context", tier: "medium", inTokens: 2200, outTokens: 250 }),
          n("ag", "agent", 520, 300, { label: "Order agent", tier: "medium", steps: 2, inTokens: 1500 }),
          n("db", "database", 820, 300, { label: "Orders DB" }),
          n("out", "output", 1240, Y, { label: "Answer" }),
        ],
        edges: [{ ...e("rt", "emb"), weight: 6 }, { ...e("rt", "ag"), weight: 4 }, e("in", "rt"), e("emb", "ret"), e("ret", "rr"), e("rr", "llm"), e("llm", "out"), e("ag", "db"), e("ag", "out")],
      },
    },
    {
      title: "Cut cost: cache and a cheap-first cascade",
      change: "A semantic cache answers repeated questions instantly. The RAG answer is tried with a small model first and escalated to the medium one only when it's unsure.",
      why: "A fifth of questions repeat ('what's the return window?'), and most answers are easy once the right passage is retrieved. Paying for the big model on every request is waste.",
      watch: "Cost per 1,000 requests drops sharply and p50 falls (cache hits take ~20 ms). Correct barely moves. Compare with the previous stage.",
      modules: ["9.3", "9.5", "6.7", "12.11"],
      graph: {
        nodes: [
          askIn(),
          n("cache", "cache", 180, Y, { label: "Semantic cache", hitRate: 0.2 }),
          n("rt", "router", 360, Y, { label: "Intent: policy or order?" }),
          n("ret", "retriever", 560, 40, { label: "Hybrid search", recall: 0.88, latencyMs: 110 }),
          n("rr", "reranker", 760, 40),
          n("cas", "cascade", 950, 40, { label: "Small first, escalate if unsure", escalateRate: 0.25 }),
          n("s", "llm", 1150, -60, { label: "Small model", tier: "small", inTokens: 2200, outTokens: 250 }),
          n("m", "llm", 1150, 140, { label: "Medium model", tier: "medium", inTokens: 2200, outTokens: 250 }),
          n("ag", "agent", 640, 320, { label: "Order agent", tier: "small", steps: 2, inTokens: 1500 }),
          n("db", "database", 900, 320, { label: "Orders DB" }),
          n("out", "output", 1400, Y, { label: "Answer" }),
        ],
        edges: [e("in", "cache"), e("cache", "rt"), { ...e("rt", "ret"), weight: 6 }, { ...e("rt", "ag"), weight: 4 }, e("ret", "rr"), e("rr", "cas"), e("cas", "s"), e("cas", "m"), e("s", "out"), e("m", "out"), e("ag", "db"), e("ag", "out")],
      },
    },
    {
      title: "Make it safe: guardrails and approvals",
      change: "An input guardrail screens for prompt injection and personal data. The order agent can now issue refunds, but refunds over ₹5,000 wait for a human.",
      why: "Once the assistant can act (refunds), a manipulated or mistaken answer costs money. Guardrails stop most attacks; a person signs off on the expensive actions.",
      watch: "Around 3% of requests are blocked. Some are attacks, some are false alarms you'd tune. The refund branch's p95 is dominated by the human: that's the price of safety, so gate only what needs it.",
      modules: ["8.1", "8.2", "8.3", "8.4", "8.6", "10.5"],
      graph: {
        nodes: [
          askIn(),
          n("g1", "guardrail", 180, Y, { label: "Injection & PII filter", blockRate: 0.03 }),
          n("cache", "cache", 360, Y, { label: "Semantic cache", hitRate: 0.2 }),
          n("rt", "router", 540, Y, { label: "Intent", latencyMs: 15 }),
          n("ret", "retriever", 740, 40, { label: "Hybrid search", recall: 0.88, latencyMs: 110 }),
          n("rr", "reranker", 940, 40),
          n("llm", "llm", 1140, 40, { label: "Answer", tier: "small", inTokens: 2200, outTokens: 250 }),
          n("ag", "agent", 760, 320, { label: "Order & refund agent", tier: "medium", steps: 3 }),
          n("db", "database", 1000, 420, { label: "Orders DB" }),
          n("h", "human", 1040, 260, { label: "Manager approves refunds", waitMs: 40000, approveRate: 0.92 }),
          n("out", "output", 1360, Y, { label: "Answer" }),
        ],
        edges: [e("in", "g1"), e("g1", "cache"), e("cache", "rt"), { ...e("rt", "ret"), weight: 7 }, { ...e("rt", "ag"), weight: 3 }, e("ret", "rr"), e("rr", "llm"), e("llm", "out"), e("ag", "db"), e("ag", "h"), e("h", "out")],
      },
    },
    {
      title: "Production: gateway, load balancer, your own GPUs",
      change: "At 40 questions a second, ShopKart self-hosts the answer model: an API gateway with rate limits, a load balancer, and two pools of vLLM servers sized for the traffic.",
      why: "At this volume the API bill is larger than renting GPUs, and the data must stay in ShopKart's cloud account. Now capacity is your problem: too few GPUs and the tail explodes.",
      watch: "Click a GPU pool: it shows the GPUs, batch size, requests/second and $/1M tokens for its model. Push traffic up to 60 req/s and watch a pool saturate, then add a replica.",
      modules: ["9.4", "9.6", "10.6", "12.2", "12.4", "12.10"],
      rps: 40,
      graph: {
        nodes: [
          askIn(),
          n("gw", "gateway", 180, Y, { label: "API gateway", rateLimit: 80 }),
          n("cache", "cache", 360, Y, { label: "Semantic cache", hitRate: 0.2 }),
          n("ret", "retriever", 540, Y, { label: "Hybrid search", recall: 0.88, latencyMs: 110 }),
          n("rr", "reranker", 720, Y),
          n("lb", "balancer", 900, Y),
          n("p1", "replicas", 1100, 40, { label: "vLLM pool A · 8B FP8 · H100", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 32, inTokens: 2200, outTokens: 250 }),
          n("p2", "replicas", 1100, 280, { label: "vLLM pool B · 8B FP8 · H100", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 32, inTokens: 2200, outTokens: 250 }),
          n("out", "output", 1360, Y, { label: "Answer" }),
        ],
        edges: [e("in", "gw"), e("gw", "cache"), e("cache", "ret"), e("ret", "rr"), e("rr", "lb"), e("lb", "p1"), e("lb", "p2"), e("p1", "out"), e("p2", "out")],
      },
    },
  ],
};

/* ---------- 2. from a chatbot to an agent team ---------- */
const AGENTS: Journey = {
  id: "agents",
  title: "From a chatbot to an agent team",
  scenario: "A travel company wants an assistant that doesn't just answer but books: it checks flights, hotels and the customer's calendar, then makes the booking.",
  stages: [
    {
      title: "One LLM call",
      change: "Ask a model to plan the trip from the request alone.",
      why: "The baseline. It writes a nice plan with flights that don't exist at prices it made up.",
      watch: "Correct is low (about 25%): the model has no live data. Fast and cheap, but useless for booking.",
      modules: ["1.9", "2.1"],
      graph: { nodes: [n("in", "input", 0, Y, { label: "Plan my trip", knowledgeShare: 0.9 }), n("llm", "llm", 280, Y, { label: "Trip planner", tier: "medium", outTokens: 500 }), n("out", "output", 560, Y, { label: "Plan" })], edges: [e("in", "llm"), e("llm", "out")] },
    },
    {
      title: "A tool-using agent",
      change: "Give the model tools (flight search, calendar, calculator) and let it loop: think, call a tool, read the result, repeat.",
      why: "Live prices and availability only come from APIs. An agent decides which call to make next.",
      watch: "Correct jumps because tools supply real facts. Latency and cost multiply with steps: each step is another model call plus a tool call.",
      modules: ["2.5", "2.6", "5.1", "5.2", "5.3"],
      graph: {
        nodes: [n("in", "input", 0, Y, { label: "Plan my trip", knowledgeShare: 0.9 }), n("ag", "agent", 260, Y, { label: "Travel agent", tier: "medium", steps: 4 }), n("t1", "tool", 560, 20, { label: "Flight search API", latencyMs: 900, failRate: 0.06, retries: 0 }), n("t2", "database", 560, 160, { label: "Customer calendar" }), n("t3", "tool", 560, 300, { label: "Calculator", toolKind: "calculator", latencyMs: 5, failRate: 0 }), n("out", "output", 860, Y, { label: "Plan" })],
        edges: [e("in", "ag"), e("ag", "t1"), e("ag", "t2"), e("ag", "t3"), e("ag", "out")],
      },
    },
    {
      title: "Reliable: retries, memory and a step cap",
      change: "Retry the flaky flight API with backoff, remember the customer's preferences, and cap the agent at a sensible number of steps.",
      why: "The flight API fails 6% of the time and the agent re-asked questions it had already answered. Agents fail in loops: bound them.",
      watch: "Failures fall (check the flight API's failure count). Memory adds a small, cheap call. Compare cost with the previous stage: the cap stops runaway loops.",
      modules: ["2.9", "5.5", "5.9", "6.4"],
      graph: {
        nodes: [n("in", "input", 0, Y, { label: "Plan my trip", knowledgeShare: 0.9 }), n("mem", "memory", 240, 320, { label: "Customer preferences" }), n("ag", "agent", 260, Y, { label: "Travel agent", tier: "medium", steps: 3 }), n("t1", "tool", 560, 20, { label: "Flight search API", latencyMs: 900, failRate: 0.06, retries: 2 }), n("t2", "database", 560, 160, { label: "Customer calendar" }), n("out", "output", 860, Y, { label: "Plan" })],
        edges: [e("in", "ag"), e("ag", "mem"), e("ag", "t1"), e("ag", "t2"), e("ag", "out")],
      },
    },
    {
      title: "A supervisor with specialists",
      change: "Split the work: a supervisor sends flights, hotels and visa checks to three specialists in parallel, then writes one itinerary.",
      why: "One agent juggling every tool got confused and slow. Specialists each have a small toolset and a focused prompt, and they run at the same time.",
      watch: "The whole request waits for the slowest specialist (the timeline shows the parallel bars). Cost goes up: you pay for three agents plus the merge. Is the quality gain worth it?",
      modules: ["5.6", "5.7", "6.2", "6.6"],
      graph: {
        nodes: [
          n("in", "input", 0, Y + 20, { label: "Plan my trip", knowledgeShare: 0.9 }),
          n("sup", "parallel", 220, Y + 20, { label: "Trip supervisor", tier: "medium" }),
          n("a1", "agent", 480, 20, { label: "Flights specialist", tier: "small", steps: 3 }),
          n("a2", "agent", 480, 180, { label: "Hotels specialist", tier: "small", steps: 3 }),
          n("a3", "agent", 480, 340, { label: "Visa checker", tier: "small", steps: 2 }),
          n("t1", "tool", 740, 20, { label: "Flight API", latencyMs: 900, failRate: 0.06, retries: 2 }),
          n("t2", "tool", 740, 180, { label: "Hotel API", latencyMs: 700, failRate: 0.04, retries: 2 }),
          n("w", "llm", 800, Y + 100, { label: "Write the itinerary", tier: "medium", inTokens: 4000, outTokens: 600 }),
          n("out", "output", 1040, Y + 100, { label: "Itinerary" }),
        ],
        edges: [e("in", "sup"), e("sup", "a1"), e("sup", "a2"), e("sup", "a3"), e("a1", "t1"), e("a2", "t2"), e("a1", "w"), e("a2", "w"), e("a3", "w"), e("w", "out")],
      },
    },
    {
      title: "Booking needs guardrails and a human",
      change: "Before anything is booked, an output check validates the itinerary and the customer approves the payment.",
      why: "Booking moves money and can't be undone easily. Agents can be tricked by malicious web content, or just be wrong.",
      watch: "p95 is now set by the human approval step. Blocked requests show where the output check catches bad itineraries.",
      modules: ["5.8", "8.4", "8.2", "10.5"],
      graph: {
        nodes: [
          n("in", "input", 0, Y + 20, { label: "Plan and book", knowledgeShare: 0.9 }),
          n("g1", "guardrail", 180, Y + 20, { label: "Input screen", blockRate: 0.02 }),
          n("sup", "parallel", 360, Y + 20, { label: "Trip supervisor", tier: "medium" }),
          n("a1", "agent", 600, 40, { label: "Flights specialist", tier: "small", steps: 3 }),
          n("a2", "agent", 600, 260, { label: "Hotels specialist", tier: "small", steps: 3 }),
          n("w", "llm", 860, Y + 20, { label: "Write the itinerary", tier: "medium", inTokens: 4000, outTokens: 600 }),
          n("g2", "guardrail", 1060, Y + 20, { label: "Itinerary check", blockRate: 0.04, latencyMs: 300 }),
          n("h", "human", 1240, Y + 20, { label: "Customer approves payment", waitMs: 60000, approveRate: 0.85 }),
          n("out", "output", 1440, Y + 20, { label: "Booked" }),
        ],
        edges: [e("in", "g1"), e("g1", "sup"), e("sup", "a1"), e("sup", "a2"), e("a1", "w"), e("a2", "w"), e("w", "g2"), e("g2", "h"), e("h", "out")],
      },
    },
    {
      title: "Quality loop: a critic",
      change: "A critic reviews each itinerary against the request (dates, budget, visa) and sends weak ones back for one revision.",
      why: "Specialists sometimes return a hotel on the wrong dates. A cheap reviewer catches many of these before the customer sees them.",
      watch: "Correct rises a few points; cost and time rise with the revise rate. Try revise rates of 0.1, 0.35 and 0.8 and find the sweet spot.",
      modules: ["5.2", "7.9", "6.8"],
      graph: {
        nodes: [
          n("in", "input", 0, Y + 20, { label: "Plan my trip", knowledgeShare: 0.9 }),
          n("sup", "parallel", 200, Y + 20, { label: "Trip supervisor", tier: "medium" }),
          n("a1", "agent", 440, 40, { label: "Flights specialist", tier: "small", steps: 3 }),
          n("a2", "agent", 440, 260, { label: "Hotels specialist", tier: "small", steps: 3 }),
          n("w", "llm", 700, Y + 20, { label: "Write the itinerary", tier: "medium", inTokens: 4000, outTokens: 600 }),
          n("cr", "critic", 920, Y + 20, { label: "Critic", reviseRate: 0.35 }),
          n("out", "output", 1140, Y + 20, { label: "Itinerary" }),
        ],
        edges: [e("in", "sup"), e("sup", "a1"), e("sup", "a2"), e("a1", "w"), e("a2", "w"), e("w", "cr"), e("cr", "out")],
      },
    },
  ],
};

/* ---------- 3. serving your own model at scale ---------- */
const pool = (id: string, x: number, y: number, p: Partial<NodeParams>) => n(id, "replicas", x, y, { inTokens: 1500, outTokens: 300, maxBatch: 64, ...p });
const SERVING: Journey = {
  id: "serving",
  title: "Serving your own model at scale",
  scenario: "A legal-tech startup serves a fine-tuned open model to lawyers who paste long contracts. Traffic doubles every quarter, and responses must start streaming fast.",
  stages: [
    {
      title: "One GPU, one model",
      change: "An 8B model in FP16 on a single H100, served by vLLM.",
      why: "The starting point. Click the pool to see the maths: weights take 16 GB, and the rest of the 80 GB holds the KV cache for concurrent requests.",
      watch: "At 2 req/s everything is calm. Read the sizing card: decode is memory-bound, and the batch that fits sets the throughput.",
      modules: ["1.5", "12.1", "12.2", "12.6"],
      rps: 2,
      graph: { nodes: [n("in", "input", 0, Y, { label: "Contract question" }), pool("p", 300, Y, { label: "vLLM · 8B · 1×H100", model: "8b", gpu: "h100", precision: "fp16", replicas: 1 }), n("out", "output", 600, Y, { label: "Streamed answer" })], edges: [e("in", "p"), e("p", "out")] },
    },
    {
      title: "Traffic grows: the tail explodes",
      change: "Nothing changed in the design. Traffic went from 2 to 20 requests a second.",
      why: "This is what happens to every service that's sized once and forgotten. The pool runs past ~70% utilisation and requests wait in the queue.",
      watch: "p50 looks fine but p99 shoots up, and some requests time out. The insights panel says which pool is overloaded. This is why you report p99, never the mean.",
      modules: ["12.3", "12.4", "9.4"],
      rps: 20,
      graph: { nodes: [n("in", "input", 0, Y, { label: "Contract question" }), pool("p", 300, Y, { label: "vLLM · 8B · 1×H100", model: "8b", gpu: "h100", precision: "fp16", replicas: 1 }), n("out", "output", 600, Y, { label: "Streamed answer" })], edges: [e("in", "p"), e("p", "out")] },
    },
    {
      title: "Scale out: replicas behind a load balancer",
      change: "Three replicas behind a load balancer, with a gateway that rate-limits each customer.",
      why: "One replica can't keep up. The sizing card's 'replicas for this traffic' tells you how many you need at 70% utilisation.",
      watch: "The tail comes back down. The cost per request includes the GPU-hours: compare $/1k requests with the API-based designs in the other journeys.",
      modules: ["12.10", "9.6"],
      rps: 20,
      graph: {
        nodes: [n("in", "input", 0, Y, { label: "Contract question" }), n("gw", "gateway", 200, Y, { label: "Gateway", rateLimit: 40 }), n("lb", "balancer", 400, Y), pool("p1", 620, 20, { label: "Replica 1", model: "8b", gpu: "h100", precision: "fp16", replicas: 1 }), pool("p2", 620, 180, { label: "Replica 2", model: "8b", gpu: "h100", precision: "fp16", replicas: 1 }), pool("p3", 620, 340, { label: "Replica 3", model: "8b", gpu: "h100", precision: "fp16", replicas: 1 }), n("out", "output", 900, Y, { label: "Streamed answer" })],
        edges: [e("in", "gw"), e("gw", "lb"), e("lb", "p1"), e("lb", "p2"), e("lb", "p3"), e("p1", "out"), e("p2", "out"), e("p3", "out")],
      },
    },
    {
      title: "Prefix cache and FP8",
      change: "Turn on prefix caching (every request starts with the same long system prompt and contract template) and serve the model in FP8.",
      why: "FP8 halves the bytes read per decode step and frees memory for more concurrent requests. A cache hit skips work entirely.",
      watch: "Click the pool: weights drop from 16 to 8 GB, the batch that fits grows, and requests/second per replica rises. You may now need one replica fewer.",
      modules: ["12.7", "12.8", "6.7"],
      rps: 20,
      graph: {
        nodes: [n("in", "input", 0, Y, { label: "Contract question" }), n("gw", "gateway", 200, Y, { label: "Gateway", rateLimit: 40 }), n("pc", "cache", 400, Y, { label: "Prefix / response cache", hitRate: 0.15, latencyMs: 4 }), n("lb", "balancer", 600, Y), pool("p1", 820, 60, { label: "Replica 1 · FP8", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 128 }), pool("p2", 820, 260, { label: "Replica 2 · FP8", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 128 }), n("out", "output", 1080, Y, { label: "Streamed answer" })],
        edges: [e("in", "gw"), e("gw", "pc"), e("pc", "lb"), e("lb", "p1"), e("lb", "p2"), e("p1", "out"), e("p2", "out")],
      },
    },
    {
      title: "Route by need: small model for easy work, 70B for hard",
      change: "A router sends short, routine questions to the 8B pool and long, tricky contracts to a 70B pool on two GPUs per replica.",
      why: "The 70B model is better but costs much more per token. Most questions don't need it.",
      watch: "Open the 70B pool: it needs tensor parallelism (2 GPUs per replica) just to fit, and serves far fewer requests per second. Shift the router weights and watch cost and p99 trade off.",
      modules: ["9.3", "12.11", "1.12"],
      rps: 20,
      graph: {
        nodes: [n("in", "input", 0, Y, { label: "Contract question" }), n("gw", "gateway", 180, Y, { label: "Gateway", rateLimit: 40 }), n("rt", "router", 380, Y, { label: "Route by length & difficulty" }), pool("s", 640, 40, { label: "8B pool · FP8 · H100", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 64 }), pool("b", 640, 300, { label: "70B pool · FP8 · H100", model: "70b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 2, maxBatch: 32, inTokens: 6000, outTokens: 500 }), n("out", "output", 920, Y, { label: "Streamed answer" })],
        edges: [e("in", "gw"), e("gw", "rt"), { ...e("rt", "s"), weight: 4 }, { ...e("rt", "b"), weight: 1 }, e("s", "out"), e("b", "out")],
      },
    },
  ],
};

export const JOURNEYS: Journey[] = [SUPPORT, AGENTS, SERVING];
export const journeyById = (id: string) => JOURNEYS.find((j) => j.id === id);

/** the stages that teach a module, for "See it in the system" links */
export function stagesForModule(moduleId: string): { journey: Journey; index: number; stage: Stage }[] {
  return JOURNEYS.flatMap((journey) => journey.stages.map((stage, index) => ({ journey, index, stage }))).filter((x) => x.stage.modules.includes(moduleId));
}
