import { completeAi } from "../ai/chat";
import type { AiSettings } from "../ai/settings";
import { TOOL_KINDS } from "./catalog";
import type { StudioEdge, StudioGraph, StudioNode } from "./types";

/**
 * Run a graph once, for real, with the learner's AI key. Model nodes make real calls; tools other than the calculator,
 * retriever and memory are simulated (no real APIs are connected), and the UI says so.
 */
export interface LiveEvent {
  node: string;
  phase: "start" | "delta" | "done" | "blocked" | "error";
  text?: string;
}

interface State {
  question: string;
  context: string[];
  draft: string;
  notes: string[];
}

export interface LiveHooks {
  emit: (e: LiveEvent) => void;
  /** a person approves or rejects (the UI shows a dialog) */
  approve: (label: string, draft: string) => Promise<boolean>;
  signal?: AbortSignal;
}

const sessionCache = new Map<string, string>();

/** tiny safe arithmetic: numbers, + - * / ( ) . % and spaces only */
export function calc(expr: string): string {
  const e = expr.replace(/[,\s]/g, "");
  if (!/^[\d+\-*/().%]+$/.test(e)) return "calculator only accepts arithmetic";
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e.replace(/%/g, "/100")});`)();
    return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "not a finite number";
  } catch {
    return "could not parse that expression";
  }
}

/** keyword-overlap search over paragraphs (honest stand-in for embeddings in a browser) */
export function keywordSearch(docs: string, query: string, k: number): string[] {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const q = words(query);
  return docs
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ p, score: [...words(p)].filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p);
}

const INJECTION = /(ignore (all|any|the|previous|prior) (instructions|rules)|reveal (your|the) (system )?prompt|you are now|developer mode)/i;
const PII = /([\w.+-]+@[\w-]+\.[\w.]+|\b\d{10}\b|\b(?:\d[ -]?){13,16}\b)/;

export async function runLive(graph: StudioGraph, question: string, ai: AiSettings, hooks: LiveHooks): Promise<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, StudioEdge[]>();
  for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);
  const start = graph.nodes.find((n) => n.kind === "input");
  if (!start) throw new Error("Add a User request node to start from.");
  const visits = new Map<string, number>();
  let finished = false;
  let final = "";

  const ask = async (n: StudioNode, system: string, user: string, maxTokens = 700) => {
    let text = "";
    await completeAi(ai, system, [{ role: "user", content: user }], (d) => ((text += d), hooks.emit({ node: n.id, phase: "delta", text: d })), hooks.signal, maxTokens);
    return text.trim();
  };
  const prompt = (s: State) =>
    [`Question: ${s.question}`, s.context.length ? `Context:\n${s.context.map((c, i) => `[${i + 1}] ${c}`).join("\n")}` : "", s.draft ? `Work so far:\n${s.draft}` : "", s.notes.length ? `Notes:\n${s.notes.join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");

  const reach = (from: string) => {
    const seen = new Set<string>();
    const q = [from];
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      for (const e of out.get(id) ?? []) if (!(n?.kind === "agent" && TOOL_KINDS.includes(byId.get(e.target)!.kind))) q.push(e.target);
    }
    return seen;
  };
  const joinOf = (ids: string[]) => {
    const sets = ids.map(reach);
    return [...sets[0]].find((x) => sets.every((s) => s.has(x)));
  };

  async function tool(t: StudioNode, input: string, s: State): Promise<string> {
    if (t.kind === "retriever") {
      const hits = keywordSearch(t.params.docs ?? "", input || s.question, t.params.topK ?? 3);
      return hits.length ? hits.join("\n---\n") : "(no matching documents)";
    }
    if (t.kind === "memory") return "(no stored memories for this user yet)";
    if (t.params.toolKind === "calculator") return calc(input);
    return `(simulated ${t.params.toolKind ?? "tool"} "${t.params.label}": no real API is connected in the browser, so treat this as a placeholder result for "${input.slice(0, 80)}")`;
  }

  async function visit(id: string, s: State, stop?: string): Promise<void> {
    if (finished || id === stop || hooks.signal?.aborted) return;
    const n = byId.get(id);
    if (!n) return;
    const v = (visits.get(id) ?? 0) + 1;
    visits.set(id, v);
    if (v > 4) return;
    const outs = out.get(id) ?? [];
    const next = async (edges = outs) => {
      for (const e of edges) await visit(e.target, s, stop);
    };
    hooks.emit({ node: id, phase: "start" });
    const done = (text?: string) => hooks.emit({ node: id, phase: "done", text });

    switch (n.kind) {
      case "input":
        done(s.question);
        return next();
      case "output":
        final = s.draft || "(no answer was produced)";
        finished = true;
        return done(final);
      case "llm":
      case "critic": {
        if (n.kind === "critic") {
          const verdict = await ask(n, n.params.system ?? "Review the draft. Reply APPROVE or list fixes.", prompt(s), 300);
          if (!/^\s*approve/i.test(verdict)) {
            const revised = await ask(n, "Revise the draft using the reviewer's feedback. Return only the improved answer.", `${prompt(s)}\n\nReviewer feedback:\n${verdict}`);
            s.draft = revised;
            done("sent back for one revision");
          } else done("approved");
          return next();
        }
        s.draft = await ask(n, n.params.system ?? "You are a helpful assistant.", prompt(s));
        done();
        return next();
      }
      case "agent": {
        const tools = outs.filter((e) => TOOL_KINDS.includes(byId.get(e.target)!.kind)).map((e) => byId.get(e.target)!);
        const rest = outs.filter((e) => !tools.some((t) => t.id === e.target));
        const names = tools.map((t) => `- ${t.params.label} (${t.kind === "retriever" ? "search the knowledge base" : t.params.toolKind ?? t.kind})`).join("\n");
        const sys = `${n.params.system ?? "You are an agent."}\n\nYou can use these tools:\n${names || "(none)"}\n\nEach turn reply with exactly one line:\nTOOL: <tool name> | <input>\nor\nFINAL: <your answer>`;
        const scratch: string[] = [];
        const maxSteps = Math.max(1, Math.min(8, Math.round((n.params.steps ?? 3) * 1.5)));
        for (let step = 0; step < maxSteps; step++) {
          const reply = await ask(n, sys, `${prompt(s)}${scratch.length ? `\n\nYour steps so far:\n${scratch.join("\n")}` : ""}`, 400);
          const m = reply.match(/TOOL:\s*([^|\n]+)\|\s*([^\n]*)/i);
          if (m && tools.length) {
            const t = tools.find((x) => x.params.label.toLowerCase() === m[1].trim().toLowerCase()) ?? tools.find((x) => m[1].toLowerCase().includes(x.params.label.toLowerCase().split(" ")[0])) ?? tools[0];
            hooks.emit({ node: t.id, phase: "start" });
            const result = await tool(t, m[2].trim(), s);
            if (t.kind === "retriever") s.context.push(result);
            hooks.emit({ node: t.id, phase: "done", text: result });
            scratch.push(`TOOL ${t.params.label}(${m[2].trim()}) → ${result.slice(0, 600)}`);
            continue;
          }
          s.draft = reply.replace(/^\s*FINAL:\s*/i, "");
          break;
        }
        if (!s.draft) s.draft = scratch.join("\n");
        done(`${scratch.length} tool call${scratch.length === 1 ? "" : "s"}`);
        return next(rest);
      }
      case "tool":
      case "memory":
      case "retriever": {
        const r = await tool(n, s.question, s);
        if (n.kind === "retriever") s.context.push(...r.split("\n---\n"));
        else s.notes.push(`${n.params.label}: ${r}`);
        done(r);
        return next();
      }
      case "reranker":
        s.context = s.context.slice(0, Math.max(1, Math.min(s.context.length, 3)));
        done(`kept the top ${s.context.length} passages`);
        return next();
      case "router": {
        if (outs.length < 2) return done(), next();
        const labels = outs.map((e, i) => `${i + 1}. ${byId.get(e.target)?.params.label}`).join("\n");
        const pick = await ask(n, "You route requests. Reply with only the number of the best route.", `Request: ${s.question}\n\nRoutes:\n${labels}`, 10);
        const i = Math.max(0, Math.min(outs.length - 1, (parseInt(pick.match(/\d+/)?.[0] ?? "1", 10) || 1) - 1));
        done(`→ ${byId.get(outs[i].target)?.params.label}`);
        return next([outs[i]]);
      }
      case "cascade": {
        const [first, second] = outs;
        if (!first) return done();
        const join = second ? joinOf([first.target, second.target]) : undefined;
        await visit(first.target, s, join);
        const unsure = /(not sure|don'?t know|cannot|can't|unable|unclear)/i.test(s.draft) || s.draft.length < 25;
        if (second && unsure) {
          done("first answer looked unsure → escalated");
          await visit(second.target, s, join);
        } else done("first answer accepted");
        if (join) await visit(join, s, stop);
        return;
      }
      case "parallel": {
        const join = joinOf(outs.map((e) => e.target));
        const branches = await Promise.all(
          outs.map(async (e) => {
            const b: State = { ...s, context: [...s.context], notes: [...s.notes], draft: "" };
            await visit(e.target, b, join);
            return { label: byId.get(e.target)?.params.label, b };
          }),
        );
        for (const { b } of branches) s.context.push(...b.context.filter((c) => !s.context.includes(c)));
        const merged = branches.map((x) => `### ${x.label}\n${x.b.draft}`).join("\n\n");
        s.draft = await ask(n, n.params.system ?? "Merge the specialists' findings into one answer.", `${prompt({ ...s, draft: "" })}\n\nSpecialist findings:\n${merged}`);
        done("merged");
        if (join) await visit(join, s, stop);
        return;
      }
      case "guardrail": {
        const text = s.draft || s.question;
        const hit = INJECTION.test(text) ? "possible prompt injection" : PII.test(text) ? "personal data (email, phone or card number)" : "";
        if (hit) {
          final = `Blocked by ${n.params.label}: ${hit}.`;
          finished = true;
          return hooks.emit({ node: id, phase: "blocked", text: final });
        }
        done("passed");
        return next();
      }
      case "human": {
        const ok = await hooks.approve(n.params.label, s.draft || s.question);
        if (!ok) {
          final = `Rejected at ${n.params.label}.`;
          finished = true;
          return hooks.emit({ node: id, phase: "blocked", text: final });
        }
        done("approved");
        return next();
      }
      case "cache": {
        const key = s.question.trim().toLowerCase();
        const hit = sessionCache.get(key);
        if (hit) {
          final = hit;
          finished = true;
          return done("cache hit");
        }
        done("miss");
        await next();
        if (final && !final.startsWith("Blocked") && !final.startsWith("Rejected")) sessionCache.set(key, final);
        return;
      }
      case "replicas":
      case "queue":
        done(n.kind === "queue" ? "queued and picked up by a worker" : "served by this pool (no queue in a single live run)");
        return next();
      case "gateway":
        done("authenticated, within rate limit");
        return next();
      case "balancer":
        if (!outs.length) return done();
        done("sent to one of its targets");
        return next([outs[Math.floor(Math.random() * outs.length)]]);
      case "embedder":
        done("query embedded (keyword search stands in for vectors in the browser)");
        return next();
      case "database": {
        const r = await tool(n, s.question, s);
        s.notes.push(`${n.params.label}: ${r}`);
        done(r);
        return next();
      }
    }
  }

  await visit(start.id, { question, context: [], draft: "", notes: [] });
  return final || "(the graph ended without reaching an Answer node)";
}
