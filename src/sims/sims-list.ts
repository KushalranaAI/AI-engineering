import type { SimDef } from "./types";
import { def as llmAnatomy } from "./llm-anatomy";
import { def as similarity } from "./similarity";
import { def as chunking } from "./chunking";
import { def as rrf } from "./rrf";
import { def as tokenBudget } from "./token-budget";
import { def as routerCost } from "./router-cost";
import { def as roofline } from "./roofline";
import { def as kvCache } from "./kv-cache";
import { def as batching } from "./batching";
import { def as loadTest } from "./load-test";
import { def as quantization } from "./quantization";
import { def as memoryWindow } from "./memory-window";
import { def as memoryDecay } from "./memory-decay";
import { def as ragMetrics } from "./rag-metrics";
import { def as autoscaling } from "./autoscaling";

/** In path order: how LLMs work -> retrieval -> context and memory -> evals -> system design -> inference serving and scaling. */
export const SIMS: SimDef[] = [llmAnatomy, similarity, chunking, rrf, tokenBudget, memoryWindow, memoryDecay, ragMetrics, routerCost, roofline, kvCache, quantization, batching, loadTest, autoscaling];
