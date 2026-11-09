import { SERVER_HEADERS, anthropicClient, postCompletion, providerError, serverPath } from "./client";
import { DEFAULT_MODELS, type AiSettings } from "./settings";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM = `You are the tutor built into "AI Engineer Path", a self-paced course that takes a software engineer to shipping production AI systems: 16 levels in 7 phases (foundations, retrieval, agents, evaluation and security, production, multimodal and fine-tuning, interviews), each with modules, lessons and portfolio projects.
The learner is looking at one screen. Everything you can see about it is in the "Screen context" JSON below - the lesson text, the level outline, the project brief, or their progress.

How to answer:
- Answer the question they ask, grounded in the screen context. If the context doesn't contain what you need, say so and point them to the right level or module.
- Teach, don't just tell: explain why, give a small concrete example (often a short Python snippet), and name the trade-off.
- When asked to quiz, ask ONE question at a time, wait for their answer, then give honest feedback and the next question.
- On projects and "Try it" exercises, guide with hints first. Don't hand over a full solution unless they explicitly ask.
- Be accurate about fast-moving tools: prefer durable concepts, and say when something depends on the provider or version.
- Be brief: a short paragraph or a few bullets. Define a term the first time you use it. Markdown is fine.
- If the question is unrelated to AI engineering or this course, answer in one sentence and steer back.`;

const MAX_CONTEXT_CHARS = 28000;

/** The screen context as compact JSON, trimmed so one question never gets very large. */
function contextText(context: unknown): string {
  const json = JSON.stringify(context ?? {});
  return json.length > MAX_CONTEXT_CHARS ? json.slice(0, MAX_CONTEXT_CHARS) + ' ...(truncated)"}' : json;
}

/** Read an OpenAI-style server-sent-event stream, calling onDelta with each piece of text. */
async function streamOpenAi(url: string, headers: Record<string, string>, body: object, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok || !res.body) throw providerError(res.status, await res.text());
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const piece = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* partial JSON line - ignore */
      }
    }
  }
  return full;
}

/**
 * Ask the configured provider a free-form question. `context` is what is on the learner's screen right now; it is
 * rebuilt for every question and never includes the API key. Text is streamed through `onDelta` where the provider allows.
 */
export async function chatAi(s: AiSettings, history: ChatMsg[], context: unknown, onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  return completeAi(s, `${SYSTEM}\n\nScreen context (JSON):\n${contextText(context)}`, history, onDelta, signal);
}

/** One streamed completion with any system prompt (the tutor, and live runs in Agent Studio). */
export async function completeAi(s: AiSettings, system: string, history: ChatMsg[], onDelta: (t: string) => void, signal?: AbortSignal, maxTokens = 2048): Promise<string> {
  if (s.provider === "anthropic") {
    const client = anthropicClient(s);
    const stream = client.messages.stream(
      { model: s.model || DEFAULT_MODELS.anthropic, max_tokens: maxTokens, system, messages: history },
      { signal },
    );
    stream.on("text", onDelta);
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new Error("The model declined to answer this one.");
    return final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  const messages = [{ role: "system", content: system }, ...history];
  if (s.provider === "openai") {
    const body = { model: s.model || DEFAULT_MODELS.openai, messages };
    if (s.viaServer) return streamOpenAi(serverPath("openai/v1/chat/completions"), SERVER_HEADERS, body, onDelta, signal);
    const headers = { authorization: `Bearer ${s.apiKey}` };
    try {
      return await streamOpenAi("https://api.openai.com/v1/chat/completions", headers, body, onDelta, signal);
    } catch (e) {
      if (!(e instanceof TypeError) || signal?.aborted) throw e;
      const text = await postCompletion("https://api.openai.com/v1/chat/completions", headers, body, true, signal); // network/CORS → local relay
      onDelta(text);
      return text;
    }
  }
  if (s.provider === "azure") {
    if (s.viaServer) {
      const text = await postCompletion(serverPath("azure/chat/completions"), SERVER_HEADERS, { messages }, false, signal);
      onDelta(text);
      return text;
    }
    const base = s.azureEndpoint.trim().replace(/\/+$/, "");
    const url = `${base}/openai/deployments/${encodeURIComponent(s.azureDeployment.trim())}/chat/completions?api-version=${encodeURIComponent(s.azureApiVersion || "2024-10-21")}`;
    const text = await postCompletion(url, { "api-key": s.apiKey }, { messages }, true, signal);
    onDelta(text);
    return text;
  }
  throw new Error("No AI provider is configured.");
}
