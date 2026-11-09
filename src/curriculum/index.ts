import type { Level, Module, Phase, PhaseId, Project } from "./types";
import { L0 } from "./levels/l00";
import { L1 } from "./levels/l01";
import { L2 } from "./levels/l02";
import { L3 } from "./levels/l03";
import { L4 } from "./levels/l04";
import { L5 } from "./levels/l05";
import { L6 } from "./levels/l06";
import { L7 } from "./levels/l07";
import { L8 } from "./levels/l08";
import { L9 } from "./levels/l09";
import { L10 } from "./levels/l10";
import { L11 } from "./levels/l11";
import { L12 } from "./levels/l12";
import { L13 } from "./levels/l13";
import { L14 } from "./levels/l14";
import { L15 } from "./levels/l15";
import { L16 } from "./levels/l16";
import type { Flashcard, InterviewQ, Practice, PracticeMap } from "./practice/types";

export type { Level, Module, Phase, PhaseId, Project, Topic } from "./types";
export type { Flashcard, InterviewCluster, InterviewQ, Practice, SimId, StudioPreset } from "./practice/types";

export const PHASES: Phase[] = [
  { id: "foundations", title: "Foundations", tagline: "software, how LLMs work, APIs, prompting", icon: "blocks" },
  { id: "retrieval", title: "Retrieval", tagline: "search, embeddings, RAG", icon: "search" },
  { id: "agentic", title: "Agents", tagline: "tools, memory, context engineering", icon: "bot" },
  { id: "trust", title: "Evaluation & Security", tagline: "evals, guardrails, attacks", icon: "shield" },
  { id: "production", title: "Production", tagline: "system design, LLMOps, platforms", icon: "server" },
  { id: "frontier", title: "Frontier & Portfolio", tagline: "multimodal, fine-tuning, projects", icon: "sparkles" },
  { id: "interview", title: "Interview", tagline: "scenarios, design rounds, mocks", icon: "messages" },
];

export const LEVELS: Level[] = [L0, L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, L12, L13, L14, L15, L16];

export const phaseById = (id: PhaseId) => PHASES.find((p) => p.id === id)!;
export const levelsInPhase = (id: PhaseId) => LEVELS.filter((l) => l.phase === id);
export const levelByNumber = (n: number) => LEVELS.find((l) => l.number === n);

/** every module in path order */
export const MODULES: Module[] = LEVELS.flatMap((l) => l.modules);
export const moduleById = (id: string) => MODULES.find((m) => m.id === id);
export const levelOfModule = (id: string) => LEVELS.find((l) => l.modules.some((m) => m.id === id))!;

export const PROJECTS: (Project & { level: number })[] = LEVELS.flatMap((l) => l.projects.map((p) => ({ ...p, level: l.number })));
export const projectById = (id: string) => PROJECTS.find((p) => p.id === id);
/** the capstone module that points at a project, if any */
export const moduleOfProject = (id: string) => MODULES.find((m) => m.projectId === id);

export const sessionsOf = (l: Level) => l.modules.reduce((n, m) => n + m.sessions, 0);
export const TOTAL_SESSIONS = LEVELS.reduce((n, l) => n + sessionsOf(l), 0);

/** "0–3" style label for the levels in a phase */
export function phaseRange(id: PhaseId): string {
  const ns = levelsInPhase(id).map((l) => l.number);
  return ns.length > 1 ? `${ns[0]}–${ns[ns.length - 1]}` : `${ns[0]}`;
}

/* ---------- practice, interview bank, flashcards (loaded by file pattern, so each can be added independently) ---------- */
const practiceFiles = import.meta.glob("./practice/p*.ts", { eager: true, import: "PRACTICE" }) as Record<string, PracticeMap>;
const PRACTICE: PracticeMap = Object.assign({}, ...Object.values(practiceFiles));
export const practiceFor = (moduleId: string): Practice | undefined => PRACTICE[moduleId];

const qFiles = import.meta.glob("./practice/interview*.ts", { eager: true, import: "QUESTIONS" }) as Record<string, InterviewQ[]>;
export const QUESTIONS: InterviewQ[] = Object.values(qFiles).flat();

const cardFiles = import.meta.glob("./practice/flashcards*.ts", { eager: true, import: "FLASHCARDS" }) as Record<string, Flashcard[]>;
export const FLASHCARDS: Flashcard[] = Object.values(cardFiles).flat();
