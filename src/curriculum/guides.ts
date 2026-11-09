/** Code-level project build guides in content/projects/<project-id>.md (format: docs/project-guides.md). */
export interface GuideStep {
  title: string;
  /** the "**Goal:** ..." line, if present */
  goal: string;
  body: string;
}
export interface Guide {
  project: string;
  title: string;
  hours?: number;
  stack?: string;
  cost?: string;
  intro: string;
  /** "Before you start", "How it fits together", ... in order */
  sections: { title: string; body: string }[];
  steps: GuideStep[];
  ship?: string;
  further?: string;
}

const files = import.meta.glob("../../content/projects/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function parseGuide(raw: string): Guide | null {
  const m = raw.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*?)\s*(#.*)?$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  if (!meta.project) return null;
  const body = m[2];
  // split on level-2 headings, but not inside fenced code blocks
  const parts: { title: string; body: string }[] = [];
  let cur: { title: string; lines: string[] } = { title: "", lines: [] };
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      parts.push({ title: cur.title, body: cur.lines.join("\n").trim() });
      cur = { title: h[1], lines: [] };
    } else cur.lines.push(line);
  }
  parts.push({ title: cur.title, body: cur.lines.join("\n").trim() });

  const g: Guide = { project: meta.project, title: meta.title ?? meta.project, hours: meta.hours ? Number(meta.hours) : undefined, stack: meta.stack, cost: meta.cost, intro: parts[0]?.body ?? "", sections: [], steps: [] };
  for (const p of parts.slice(1)) {
    const step = p.title.match(/^Step\s+\d+\s*[·:.\-–—]\s*(.+)$/i);
    if (step) {
      const goal = p.body.match(/^\*\*Goal:?\*\*:?\s*(.+)$/m)?.[1]?.trim() ?? "";
      g.steps.push({ title: step[1], goal, body: p.body.replace(/^\*\*Goal:?\*\*:?.*$/m, "").trim() });
    } else if (/^ship it/i.test(p.title)) g.ship = p.body;
    else if (/^going further/i.test(p.title)) g.further = p.body;
    else g.sections.push(p);
  }
  return g;
}

const GUIDES = new Map<string, Guide>();
for (const raw of Object.values(files)) {
  const g = parseGuide(raw);
  if (g) GUIDES.set(g.project, g);
}
export const guideFor = (projectId: string) => GUIDES.get(projectId);
export const allGuides = () => [...GUIDES.values()];
