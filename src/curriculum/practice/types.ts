/**
 * The "learn it → see it → build it" layer that sits on top of every module.
 * One file per level (pNN.ts) exports `Record<moduleId, Practice>`.
 */

/** Agent Studio starting points a practice task can open (see src/studio/presets.ts) */
export type StudioPreset =
  | "rag-pipeline" // user → retriever → reranker → LLM → answer with citations
  | "react-agent" // one agent looping over tools (search, calculator, code) until done
  | "supervisor-workers" // a supervisor routing work to specialist agents and merging results
  | "research-team" // planner → parallel researchers → writer → critic loop
  | "router-cascade" // cheap model first, escalate to a strong model on low confidence
  | "guarded-agent" // input guardrail → agent with tools → output guardrail → human approval
  | "inference-serving" // gateway → router → GPU replicas with batching and a prefix cache
  | "layered-memory"; // memory router → agent with entity, episodic, vector and procedural memory

/** Interactive simulators a practice task can open (see src/sims) */
export type SimId =
  | "similarity" // embeddings in 2-D: cosine vs dot vs euclidean, top-k
  | "chunking" // chunk size / overlap against a sample document
  | "rrf" // fuse a keyword list and a vector list with Reciprocal Rank Fusion
  | "token-budget" // split a context window between system, history, retrieval, output
  | "router-cost" // route traffic between models by cost / latency / quality
  | "roofline" // arithmetic intensity: why prefill is compute-bound and decode is memory-bound
  | "kv-cache" // KV-cache memory per request vs context length, batch size, GPU memory
  | "batching" // static vs continuous batching (+ chunked prefill) on a request stream
  | "load-test" // concurrency ramp: TTFT, inter-token latency, p50/p95/p99, queue depth
  | "quantization" // FP16 / FP8 / INT8 / INT4 (AWQ, GPTQ): memory, speed, quality
  | "llm-anatomy" // prompt → tokens → embeddings → layers → logits → sampling, step by step
  | "memory-window" // buffer vs window vs token buffer vs summary buffer: tokens per turn and what is forgotten
  | "memory-decay" // forgetting curve: half-life, importance, reinforcement and the pruning threshold
  | "rag-metrics" // faithfulness, context precision and recall from labelled claims and chunks
  | "autoscaling"; // HPA reacting to a traffic ramp or spike: replicas, start-up lag, latency, cost

export interface Practice {
  /** a realistic everyday situation that works the same way as the concept */
  realLife: {
    /** short, concrete: "A restaurant kitchen during the dinner rush" */
    title: string;
    /** 2-4 sentences telling the everyday story */
    story: string;
    /** 2-4 rows that map the story onto the concept */
    mapping: { everyday: string; concept: string }[];
  };
  /** a hands-on implementation that proves the module, 30-120 minutes */
  build: {
    title: string;
    /** one sentence: what you will have running at the end */
    goal: string;
    minutes: number;
    /** tools and libraries, e.g. ["Python", "openai", "numpy"] */
    stack: string[];
    /** 3-6 imperative steps */
    steps: string[];
    /** optional short Python (or shell) skeleton, at most ~25 lines, with TODOs */
    starter?: string;
    /** 2-4 acceptance checks a learner can verify themselves */
    checks: string[];
    stretch?: string;
    /** open this Agent Studio preset alongside the task */
    studio?: StudioPreset;
    /** open this simulator alongside the task */
    sim?: SimId;
  };
}

export type PracticeMap = Record<string, Practice>;

/* ---------- interview bank ---------- */
export type InterviewCluster =
  | "fundamentals"
  | "prompting"
  | "rag"
  | "agents"
  | "evals"
  | "security"
  | "system-design"
  | "production"
  | "inference"
  | "fine-tuning"
  | "multimodal"
  | "behavioral";

export interface InterviewQ {
  id: string;
  cluster: InterviewCluster;
  /** the level that teaches what you need */
  level: number;
  difficulty: 1 | 2 | 3;
  q: string;
  /** what a strong answer covers, 3-6 bullets */
  strong: string[];
  /** answers that lose the room, 1-3 bullets */
  redFlags: string[];
  /** likely follow-ups, 1-3 */
  followUps: string[];
}

/* ---------- flashcards ---------- */
export interface Flashcard {
  id: string;
  level: number;
  /** a term or a short question */
  front: string;
  /** 1-3 sentences */
  back: string;
}
