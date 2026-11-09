/** Lessons are markdown files in /content, one per module, matched to the curriculum by the `module` id in their frontmatter. */
export interface Lesson {
  module: string;
  title: string;
  minutes: number;
  body: string;
  file: string;
}

const files = import.meta.glob("../../content/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function parseLesson(file: string, raw: string): Lesson | null {
  const m = raw.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.module) return null;
  return { module: meta.module, title: meta.title ?? meta.module, minutes: Number(meta.minutes ?? 10), body: m[2].trim(), file };
}

const LESSONS = new Map<string, Lesson>();
for (const [file, raw] of Object.entries(files)) {
  const l = parseLesson(file, raw);
  if (l) LESSONS.set(l.module, l);
}

export const lessonFor = (moduleId: string) => LESSONS.get(moduleId);
export const lessonCount = () => LESSONS.size;
export const allLessons = () => [...LESSONS.values()];

/** split a lesson into the main text and its "Check yourself" questions, so the page can render them as a quiz */
export function splitChecks(body: string): { main: string; checks: { q: string; a: string }[] } {
  const idx = body.search(/^## Check yourself\s*$/m);
  if (idx < 0) return { main: body, checks: [] };
  const rest = body.slice(idx).replace(/^## Check yourself\s*$/m, "");
  const end = rest.search(/^## /m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const after = end >= 0 ? rest.slice(end) : "";
  const checks: { q: string; a: string }[] = [];
  const re = /([\s\S]*?)<details>\s*<summary>[^<]*<\/summary>([\s\S]*?)<\/details>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) {
    const q = m[1].trim().replace(/^\d+[.)]\s*/, "").replace(/^[-*]\s+/, "").replace(/^\*\*(.*)\*\*$/s, "$1").trim();
    if (q) checks.push({ q, a: m[2].trim() });
  }
  if (!checks.length) return { main: body, checks: [] };
  return { main: (body.slice(0, idx) + after).trim(), checks };
}
