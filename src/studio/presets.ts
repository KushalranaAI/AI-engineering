import type { StudioPreset } from "../curriculum/practice/types";
import { KINDS } from "./catalog";
import type { NodeKind, NodeParams, StudioEdge, StudioGraph, StudioNode } from "./types";

export interface Preset {
  id: StudioPreset;
  title: string;
  /** the real product this models */
  scenario: string;
  /** which levels it belongs to */
  levels: number[];
  /** things to change and what you should see */
  tryThis: string[];
  rps?: number;
  graph: StudioGraph;
}

const node = (id: string, kind: NodeKind, x: number, y: number, params: Partial<NodeParams> = {}): StudioNode => ({
  id,
  kind,
  x,
  y,
  params: { ...KINDS[kind].defaults, ...params },
});
const edge = (source: string, target: string, weight?: number): StudioEdge => ({ id: `${source}->${target}`, source, target, weight });

export const PRESETS: Preset[] = [
  {
    id: "rag-pipeline",
    title: "Help-centre RAG",
    scenario: "An online store's help bot answers from 3,000 policy and FAQ articles, with a cache for the questions everyone asks.",
    levels: [4, 9],
    tryThis: [
      "Lower the retriever's recall to 0.6 and watch 'correct' fall, even though nothing errors.",
      "Delete the reranker: latency drops a little, correctness drops more.",
      "Raise the cache hit rate to 0.4: cost and p50 both fall.",
      "Swap the LLM to Large: correctness rises a few points, cost jumps. Is it worth it?",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 120, { label: "Customer question" }),
        node("cache", "cache", 220, 120, { label: "Semantic cache", hitRate: 0.18 }),
        node("ret", "retriever", 440, 120, { label: "Hybrid search", recall: 0.78 }),
        node("rr", "reranker", 660, 120, { label: "Cross-encoder rerank" }),
        node("llm", "llm", 880, 120, { label: "Answer with citations", tier: "medium", inTokens: 2200, outTokens: 250, system: "Answer only from the provided context. Cite the paragraph you used. If the context doesn't contain the answer, say you don't know." }),
        node("out", "output", 1100, 120, { label: "Answer + sources" }),
      ],
      edges: [edge("in", "cache"), edge("cache", "ret"), edge("ret", "rr"), edge("rr", "llm"), edge("llm", "out")],
    },
  },
  {
    id: "react-agent",
    title: "Tool-using agent",
    scenario: "A travel assistant that searches flights, checks the calendar and does currency maths before answering.",
    levels: [2, 5],
    tryThis: [
      "Raise the agent's steps from 3 to 8 and watch cost and p95 climb.",
      "Set the flight API's fail rate to 0.2: see failures and retries in the trace.",
      "Give the calculator 0 retries, then 2: retries trade latency for reliability.",
      "Switch the agent to Small: cheaper and faster, but count the correct answers.",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 160, { label: "Plan my trip" }),
        node("ag", "agent", 260, 160, { label: "Travel agent", tier: "medium", steps: 4, system: "You plan trips. Use the tools to check flights, the calendar and prices, then give a short plan." }),
        node("t1", "tool", 560, 20, { label: "Flight search API", toolKind: "api", latencyMs: 900, failRate: 0.05, costPerCall: 0.002 }),
        node("t2", "tool", 560, 160, { label: "Calendar", toolKind: "api", latencyMs: 250, failRate: 0.01 }),
        node("t3", "tool", 560, 300, { label: "Calculator", toolKind: "calculator", latencyMs: 5, failRate: 0 }),
        node("out", "output", 860, 160, { label: "Trip plan" }),
      ],
      edges: [edge("in", "ag"), edge("ag", "t1"), edge("ag", "t2"), edge("ag", "t3"), edge("ag", "out")],
    },
  },
  {
    id: "supervisor-workers",
    title: "Supervisor and specialists",
    scenario: "A bank's support assistant: a supervisor sends each question to billing, card and fraud specialists in parallel, then writes one reply.",
    levels: [5],
    tryThis: [
      "Make the fraud specialist slow (steps 6): the whole request waits for the slowest branch.",
      "Replace the fan-out with a Router: one specialist per request, far cheaper. When is that enough?",
      "Add a guardrail before the supervisor and set its block rate to 0.05.",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 180, { label: "Customer message" }),
        node("sup", "parallel", 240, 180, { label: "Supervisor", tier: "medium" }),
        node("a1", "agent", 520, 30, { label: "Billing specialist", tier: "small", steps: 2 }),
        node("a2", "agent", 520, 180, { label: "Card specialist", tier: "small", steps: 2 }),
        node("a3", "agent", 520, 330, { label: "Fraud specialist", tier: "medium", steps: 3 }),
        node("db", "tool", 800, 330, { label: "Transactions DB", toolKind: "db", latencyMs: 120, failRate: 0.01 }),
        node("w", "llm", 840, 180, { label: "Write the reply", tier: "medium", inTokens: 2500, outTokens: 300 }),
        node("out", "output", 1080, 180, { label: "Reply" }),
      ],
      edges: [edge("in", "sup"), edge("sup", "a1"), edge("sup", "a2"), edge("sup", "a3"), edge("a3", "db"), edge("a1", "w"), edge("a2", "w"), edge("a3", "w"), edge("w", "out")],
    },
  },
  {
    id: "research-team",
    title: "Research team",
    scenario: "A market-research assistant: a planner splits the question, three researchers search in parallel, a writer drafts, a critic sends weak drafts back.",
    levels: [5, 6],
    tryThis: [
      "Raise the critic's revise rate to 0.8: quality goes up, so do cost and time. Find the sweet spot.",
      "Make one researcher's search fail 30% of the time: the merge still answers, with less to go on.",
      "Drop to two researchers and compare correctness per dollar.",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 200, { label: "Research question" }),
        node("plan", "llm", 200, 200, { label: "Planner", tier: "large", inTokens: 800, outTokens: 300, system: "Split the question into 3 independent sub-questions." }),
        node("fan", "parallel", 420, 200, { label: "Dispatch researchers", tier: "small", inTokens: 4000, outTokens: 200 }),
        node("r1", "agent", 680, 40, { label: "Researcher A", tier: "small", steps: 3 }),
        node("r2", "agent", 680, 200, { label: "Researcher B", tier: "small", steps: 3 }),
        node("r3", "agent", 680, 360, { label: "Researcher C", tier: "small", steps: 3 }),
        node("web", "tool", 960, 360, { label: "Web search", toolKind: "search" }),
        node("wr", "llm", 960, 200, { label: "Writer", tier: "large", inTokens: 6000, outTokens: 900 }),
        node("cr", "critic", 1200, 200, { label: "Critic", reviseRate: 0.35 }),
        node("out", "output", 1420, 200, { label: "Report" }),
      ],
      edges: [edge("in", "plan"), edge("plan", "fan"), edge("fan", "r1"), edge("fan", "r2"), edge("fan", "r3"), edge("r1", "web"), edge("r2", "web"), edge("r3", "web"), edge("r1", "wr"), edge("r2", "wr"), edge("r3", "wr"), edge("wr", "cr"), edge("cr", "out")],
    },
  },
  {
    id: "router-cascade",
    title: "Cheap-first cascade",
    scenario: "A coding-help chatbot: a small model answers first and only hard questions go to the frontier model.",
    levels: [2, 9, 12],
    tryThis: [
      "Set escalate rate to 0 (always small) and to 1 (always both): compare $/1k requests and correct answers.",
      "Find the escalate rate where you keep ~90% of the large model's correctness for a fraction of the cost.",
      "Add a cache in front: repeated questions skip both models.",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 150, { label: "Developer question" }),
        node("cas", "cascade", 220, 150, { label: "Confidence cascade", escalateRate: 0.25 }),
        node("s", "llm", 460, 40, { label: "Small model", tier: "small", inTokens: 1200, outTokens: 300 }),
        node("l", "llm", 460, 260, { label: "Frontier model", tier: "large", inTokens: 1600, outTokens: 400 }),
        node("out", "output", 720, 150, { label: "Answer" }),
      ],
      edges: [edge("in", "cas"), edge("cas", "s"), edge("cas", "l"), edge("s", "out"), edge("l", "out")],
    },
  },
  {
    id: "guarded-agent",
    title: "Guarded refund agent",
    scenario: "An e-commerce agent that can issue refunds: guardrails on the way in and out, and a manager approves refunds over the limit.",
    levels: [8, 9],
    tryThis: [
      "Raise the input guardrail's block rate to 0.15: safer, but how many genuine customers are you turning away?",
      "Set the manager's wait to 5 s (an instant approval UI) and watch p95 collapse.",
      "Remove human approval entirely. What did you just trade away?",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 150, { label: "Customer request" }),
        node("g1", "guardrail", 200, 150, { label: "Injection & PII filter", blockRate: 0.04 }),
        node("ag", "agent", 420, 150, { label: "Refund agent", tier: "medium", steps: 3 }),
        node("ord", "tool", 640, 20, { label: "Orders API", toolKind: "api", latencyMs: 300, failRate: 0.02 }),
        node("mem", "memory", 640, 290, { label: "Customer history" }),
        node("h", "human", 700, 150, { label: "Manager approval", waitMs: 40000, approveRate: 0.92 }),
        node("g2", "guardrail", 920, 150, { label: "Output policy check", blockRate: 0.01, latencyMs: 60 }),
        node("out", "output", 1120, 150, { label: "Refund issued" }),
      ],
      edges: [edge("in", "g1"), edge("g1", "ag"), edge("ag", "ord"), edge("ag", "mem"), edge("ag", "h"), edge("h", "g2"), edge("g2", "out")],
    },
  },
  {
    id: "inference-serving",
    title: "Self-hosted inference",
    scenario: "Your own model behind a gateway: a router sends long-context requests to a big-GPU pool and the rest to a small pool, with a prefix cache in front.",
    levels: [12],
    rps: 6,
    tryThis: [
      "Push traffic from 6 to 26 req/s: watch the big pool tip past ~70% utilisation and p99 explode.",
      "Add one replica to the hot pool and see the tail come back. That's autoscaling on queue depth.",
      "Raise the prefix-cache hit rate: fewer requests reach the GPUs at all.",
      "Shift router weights toward the big pool: what happens to cost and latency?",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 170, { label: "API request" }),
        node("gw", "tool", 200, 170, { label: "Gateway (auth, rate limit)", toolKind: "api", latencyMs: 8, failRate: 0, costPerCall: 0 }),
        node("pc", "cache", 420, 170, { label: "Prefix / response cache", hitRate: 0.15, latencyMs: 4 }),
        node("rt", "router", 640, 170, { label: "Route by context length" }),
        node("p1", "replicas", 880, 50, { label: "Small pool · 8B FP8 · H100", model: "8b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 32, inTokens: 1500, outTokens: 300 }),
        node("p2", "replicas", 880, 290, { label: "Big pool · 70B FP8 · 2×H100", model: "70b", gpu: "h100", precision: "fp8", kvPrecision: "fp8", replicas: 1, maxBatch: 32, inTokens: 6000, outTokens: 300 }),
        node("out", "output", 1120, 170, { label: "Streamed response" }),
      ],
      edges: [edge("in", "gw"), edge("gw", "pc"), edge("pc", "rt"), { ...edge("rt", "p1"), weight: 3 }, { ...edge("rt", "p2"), weight: 1 }, edge("p1", "out"), edge("p2", "out")],
    },
  },
  {
    id: "layered-memory",
    title: "Assistant with layered memory",
    scenario: "A shopping assistant that remembers its customers: a memory router sends small talk straight to a cheap reply and sends everything else to an agent that can read entity, episodic, vector and procedural memory.",
    levels: [6],
    tryThis: [
      "Delete the router and connect the input straight to the agent: every message now pays for the agent loop and its memory calls. Compare cost and p50.",
      "Raise the agent's steps from 3 to 6: each extra step is another model call plus memory reads. Where does p95 go?",
      "Set the vector memory's fail rate to 0.1 and watch failures: what should the agent do when a memory store is down (6.7)?",
      "Change the router's weights from 3/7 to 6/4: more traffic skips memory. When would that hurt answer quality?",
    ],
    graph: {
      nodes: [
        node("in", "input", 0, 170, { label: "Customer message", knowledgeShare: 0.6 }),
        node("rt", "router", 220, 170, { label: "Memory router (intent)", latencyMs: 20 }),
        node("sm", "llm", 480, 20, { label: "Small-talk reply (no memory)", tier: "small", inTokens: 400, outTokens: 60 }),
        node("ag", "agent", 480, 220, { label: "Assistant with memory", tier: "medium", steps: 3, inTokens: 2200, outTokens: 250, system: "You are a shopping assistant. Use the memory tools to recall the customer's details, past orders and preferences before answering." }),
        node("m1", "memory", 780, 40, { label: "Entity memory (exact facts)", latencyMs: 15 }),
        node("m2", "memory", 780, 170, { label: "Episodic memory (past sessions)", latencyMs: 40 }),
        node("m3", "memory", 780, 300, { label: "Vector memory (preferences)", latencyMs: 60, failRate: 0.01 }),
        node("m4", "memory", 780, 430, { label: "Procedural rules (playbook)", latencyMs: 10 }),
        node("out", "output", 1060, 170, { label: "Reply" }),
      ],
      edges: [
        edge("in", "rt"),
        { ...edge("rt", "sm"), weight: 3 },
        { ...edge("rt", "ag"), weight: 7 },
        edge("sm", "out"),
        edge("ag", "m1"),
        edge("ag", "m2"),
        edge("ag", "m3"),
        edge("ag", "m4"),
        edge("ag", "out"),
      ],
    },
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
