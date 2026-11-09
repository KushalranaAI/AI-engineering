import { create } from "zustand";
import { FLASHCARDS, LEVELS, MODULES, PROJECTS, levelOfModule, moduleById, practiceFor, projectById, type Level, type Module } from "../curriculum";
import { guideFor } from "../curriculum/guides";
import { migrateRecord } from "../curriculum/idmap";

/** The four steps of every module, in order. */
export const FLOW = ["read", "relate", "build", "check"] as const;
export type FlowStep = (typeof FLOW)[number];

/** Local-first progress. Everything lives in this browser; export/import keeps it portable. */
export interface ProgressData {
  /** "<moduleId>:<topicIndex>" */
  topics: Record<string, true>;
  /** modules the learner completed */
  modules: Record<string, true>;
  /** "<moduleId>:<step>" for the read → relate → build → check flow */
  flow: Record<string, true>;
  /** "<moduleId>:<buildStepIndex>" */
  builds: Record<string, true>;
  /** "<projectId>:<stepIndex>" (guide steps when the project has a guide, else brief steps) */
  steps: Record<string, true>;
  links: Record<string, string>;
  notes: Record<string, string>;
  /** "Check yourself" self-grades: "<moduleId>:<q>" → true (got it) / false (review) */
  checks: Record<string, boolean>;
  /** flashcard Leitner boxes: id → { box 0-5, due YYYY-MM-DD } */
  cards: Record<string, { box: number; due: string }>;
  /** interview questions practised */
  practiced: Record<string, true>;
  /** YYYY-MM-DD → number of things done that day */
  days: Record<string, number>;
  /** module-numbering version: 2 = after the memory, eval, guardrail and Kubernetes modules were inserted */
  idScheme?: number;
  startLevel: number;
  onboarded: boolean;
  sprintStart?: string;
  dailyGoal: number;
}

const KEY = "ai-path:progress:v1";
const EMPTY: ProgressData = { topics: {}, modules: {}, flow: {}, builds: {}, steps: {}, links: {}, notes: {}, checks: {}, cards: {}, practiced: {}, days: {}, idScheme: 2, startLevel: 0, onboarded: false, dailyGoal: 1 };

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return today(d);
};

function load(): ProgressData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch {
    /* storage unavailable - start fresh */
  }
  return structuredClone(EMPTY);
}

export function sanitize(x: unknown): ProgressData {
  const o = (x && typeof x === "object" ? x : {}) as Partial<ProgressData>;
  const rec = <T,>(v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
  // Progress saved before idScheme 2 uses the old module numbers: move those keys to today's numbers once.
  const old = o.idScheme !== 2;
  const byModule = <T,>(v: unknown) => (old ? migrateRecord(rec<T>(v)) : rec<T>(v));
  return {
    idScheme: 2,
    topics: byModule(o.topics),
    modules: byModule(o.modules),
    flow: byModule(o.flow),
    builds: byModule(o.builds),
    steps: rec(o.steps),
    links: rec(o.links),
    notes: byModule(o.notes),
    checks: byModule(o.checks),
    cards: rec(o.cards),
    practiced: rec(o.practiced),
    days: rec(o.days),
    startLevel: Number.isInteger(o.startLevel) ? Math.max(0, Math.min(LEVELS.length - 1, o.startLevel!)) : 0,
    onboarded: o.onboarded === true,
    sprintStart: typeof o.sprintStart === "string" ? o.sprintStart : undefined,
    dailyGoal: Number.isInteger(o.dailyGoal) && o.dailyGoal! > 0 ? o.dailyGoal! : 1,
  };
}

function save(p: ProgressData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage full or blocked */
  }
}

interface Store extends ProgressData {
  toggleTopic: (moduleId: string, i: number) => void;
  setFlow: (moduleId: string, step: FlowStep, done: boolean) => void;
  toggleBuild: (moduleId: string, i: number) => void;
  setModuleDone: (moduleId: string, done: boolean) => void;
  toggleStep: (projectId: string, i: number) => void;
  setStep: (projectId: string, i: number, done: boolean) => void;
  setLink: (projectId: string, url: string) => void;
  setNote: (id: string, text: string) => void;
  gradeCheck: (moduleId: string, i: number, gotIt: boolean | null) => void;
  gradeCard: (id: string, grade: "again" | "good" | "easy") => void;
  togglePracticed: (id: string) => void;
  setStartLevel: (n: number) => void;
  finishOnboarding: (startLevel: number) => void;
  setDailyGoal: (n: number) => void;
  startSprint: (date?: string) => void;
  stopSprint: () => void;
  replace: (data: unknown) => void;
  reset: () => void;
}

const bump = (days: Record<string, number>, by = 1) => ({ ...days, [today()]: Math.max(0, (days[today()] ?? 0) + by) });
const toggle = (r: Record<string, true>, k: string): [Record<string, true>, boolean] => {
  const next = { ...r };
  const on = !next[k];
  if (on) next[k] = true;
  else delete next[k];
  return [next, on];
};

/** Leitner intervals in days for boxes 0..5 */
export const BOX_DAYS = [0, 1, 3, 7, 16, 35];

export const useProgress = create<Store>((set, get) => {
  const commit = (patch: Partial<ProgressData>) => {
    set(patch);
    const s = get();
    const data: ProgressData = { idScheme: 2, topics: s.topics, modules: s.modules, flow: s.flow, builds: s.builds, steps: s.steps, links: s.links, notes: s.notes, checks: s.checks, cards: s.cards, practiced: s.practiced, days: s.days, startLevel: s.startLevel, onboarded: s.onboarded, sprintStart: s.sprintStart, dailyGoal: s.dailyGoal };
    save(data);
  };
  /** a capstone module is complete exactly when every step of its project is */
  const syncCapstone = (projectId: string, steps: Record<string, true>, modules: Record<string, true>) => {
    const n = projectStepCount(projectId);
    const mod = MODULES.find((m) => m.projectId === projectId);
    const out = { ...modules };
    if (mod && n) {
      if (Array.from({ length: n }, (_, j) => steps[`${projectId}:${j}`]).every(Boolean)) out[mod.id] = true;
      else delete out[mod.id];
    }
    return out;
  };
  return {
    ...load(),
    toggleTopic: (moduleId, i) => {
      const [topics, on] = toggle(get().topics, `${moduleId}:${i}`);
      commit({ topics, days: on ? bump(get().days) : get().days });
    },
    setFlow: (moduleId, step, done) => {
      const flow = { ...get().flow };
      const k = `${moduleId}:${step}`;
      if (done === !!flow[k]) return;
      if (done) flow[k] = true;
      else delete flow[k];
      commit({ flow, days: done ? bump(get().days) : get().days });
    },
    toggleBuild: (moduleId, i) => {
      const [builds, on] = toggle(get().builds, `${moduleId}:${i}`);
      commit({ builds, days: on ? bump(get().days) : get().days });
    },
    setModuleDone: (moduleId, done) => {
      const modules = { ...get().modules };
      if (done === !!modules[moduleId]) return;
      if (done) modules[moduleId] = true;
      else delete modules[moduleId];
      const topics = { ...get().topics };
      const flow = { ...get().flow };
      if (done) {
        moduleById(moduleId)?.topics.forEach((_, i) => (topics[`${moduleId}:${i}`] = true));
        FLOW.forEach((f) => (flow[`${moduleId}:${f}`] = true));
      }
      commit({ modules, topics, flow, days: done ? bump(get().days, 2) : get().days });
    },
    toggleStep: (projectId, i) => {
      const [steps, on] = toggle(get().steps, `${projectId}:${i}`);
      commit({ steps, modules: syncCapstone(projectId, steps, get().modules), days: on ? bump(get().days) : get().days });
    },
    setStep: (projectId, i, done) => {
      const k = `${projectId}:${i}`;
      if (done === !!get().steps[k]) return;
      const steps = { ...get().steps };
      if (done) steps[k] = true;
      else delete steps[k];
      commit({ steps, modules: syncCapstone(projectId, steps, get().modules), days: done ? bump(get().days) : get().days });
    },
    setLink: (projectId, url) => commit({ links: { ...get().links, [projectId]: url.trim() } }),
    setNote: (id, text) => {
      const notes = { ...get().notes };
      if (text.trim()) notes[id] = text;
      else delete notes[id];
      commit({ notes });
    },
    gradeCheck: (moduleId, i, gotIt) => {
      const checks = { ...get().checks };
      const k = `${moduleId}:${i}`;
      if (gotIt === null) delete checks[k];
      else checks[k] = gotIt;
      commit({ checks });
    },
    gradeCard: (id, grade) => {
      const cur = get().cards[id]?.box ?? 0;
      const box = grade === "again" ? 0 : grade === "good" ? Math.min(5, cur + 1) : Math.min(5, cur + 2);
      commit({ cards: { ...get().cards, [id]: { box, due: addDays(grade === "again" ? 0 : BOX_DAYS[box]) } }, days: bump(get().days) });
    },
    togglePracticed: (id) => {
      const [practiced, on] = toggle(get().practiced, id);
      commit({ practiced, days: on ? bump(get().days) : get().days });
    },
    setStartLevel: (n) => commit({ startLevel: n }),
    finishOnboarding: (n) => commit({ startLevel: n, onboarded: true }),
    setDailyGoal: (n) => commit({ dailyGoal: Math.max(1, Math.min(8, n)) }),
    startSprint: (date) => commit({ sprintStart: date ?? today() }),
    stopSprint: () => commit({ sprintStart: undefined }),
    replace: (data) => commit(sanitize(data)),
    reset: () => commit(structuredClone(EMPTY)),
  };
});

/* ---------- derived values ---------- */

export type Snapshot = Pick<ProgressData, "topics" | "modules" | "steps" | "startLevel" | "days" | "flow">;

/** how many checkable steps a project has: its guide's steps, or its brief's steps */
export function projectStepCount(projectId: string): number {
  return guideFor(projectId)?.steps.length || projectById(projectId)?.steps.length || 0;
}

export const topicsDone = (p: Pick<ProgressData, "topics">, m: Module) => m.topics.filter((_, i) => p.topics[`${m.id}:${i}`]).length;
export const flowDone = (p: Pick<ProgressData, "flow">, m: Module) => FLOW.filter((f) => p.flow[`${m.id}:${f}`]).length;

/** the first unfinished step of a module */
export function currentStep(p: Pick<ProgressData, "flow">, m: Module): FlowStep {
  return FLOW.find((f) => !p.flow[`${m.id}:${f}`]) ?? "check";
}

/** 0..1 for one module */
export function moduleFraction(p: Snapshot, m: Module): number {
  if (p.modules[m.id]) return 1;
  if (m.projectId) return projectFraction(p, m.projectId);
  return Math.min(0.95, flowDone(p, m) / FLOW.length);
}

export function levelFraction(p: Snapshot, l: Level): number {
  const total = l.modules.reduce((n, m) => n + m.sessions, 0) || 1;
  return l.modules.reduce((n, m) => n + moduleFraction(p, m) * m.sessions, 0) / total;
}

export const isLevelDone = (p: Snapshot, l: Level) => l.modules.length > 0 && l.modules.every((m) => p.modules[m.id]);

export function sessionsDone(p: Pick<ProgressData, "modules">): number {
  return MODULES.reduce((n, m) => n + (p.modules[m.id] ? m.sessions : 0), 0);
}

/** the module to study next: the first unfinished one from the learner's start level */
export function nextModule(p: Snapshot): Module | undefined {
  return LEVELS.filter((l) => l.number >= p.startLevel)
    .flatMap((l) => l.modules)
    .find((m) => !p.modules[m.id]);
}

export function projectFraction(p: Pick<ProgressData, "steps">, projectId: string): number {
  const n = projectStepCount(projectId);
  if (!n) return 0;
  return Array.from({ length: n }, (_, i) => p.steps[`${projectId}:${i}`]).filter(Boolean).length / n;
}
export const projectsShipped = (p: Pick<ProgressData, "steps">) => PROJECTS.filter((pr) => projectFraction(p, pr.id) === 1).length;

/** flashcards due today (unseen cards from levels the learner has reached count as due) */
export function dueCards(p: Pick<ProgressData, "cards" | "modules" | "startLevel">) {
  const reached = new Set(LEVELS.filter((l) => l.number <= Math.max(p.startLevel, ...MODULES.filter((m) => p.modules[m.id]).map((m) => levelOfModule(m.id).number))).map((l) => l.number));
  const t = today();
  return FLASHCARDS.filter((c) => {
    const s = p.cards[c.id];
    return s ? s.due <= t : reached.has(c.level);
  });
}

export function streak(days: Record<string, number>, now = new Date()): number {
  const d = new Date(now);
  if (!days[today(d)]) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days[today(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** does this module have a Relate/Build layer? */
export const hasPractice = (m: Module) => !!practiceFor(m.id);
