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

/** In path order: how LLMs work -> retrieval -> context -> system design -> inference serving. */
export const SIMS: SimDef[] = [llmAnatomy, similarity, chunking, rrf, tokenBudget, routerCost, roofline, kvCache, quantization, batching, loadTest];
