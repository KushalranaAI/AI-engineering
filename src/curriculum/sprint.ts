import { LEVELS, type Module } from "./index";

/**
 * The 100-day sprint: the core of the path (LLMs, APIs, prompting, RAG, agents, evals, security, shipping) on a fixed
 * calendar. Levels 0 and 9, 11-15 stay in the full path. Days inside a stage are shared out by each module's sessions.
 */
export interface SprintStage {
  title: string;
  blurb: string;
  levels: number[];
  /** module ids to leave out to fit the calendar (deep-dives the full path keeps) */
  skip?: string[];
  days: number;
}

export const SPRINT_STAGES: SprintStage[] = [
  { title: "How LLMs work", blurb: "Tokens, context, sampling, and choosing a model.", levels: [1], days: 6 },
  { title: "Building with LLM APIs", blurb: "Streaming, structured output, tool calls and reliable workflows.", levels: [2], days: 11 },
  { title: "Prompting", blurb: "Instructions that make model behaviour predictable, and how to test them.", levels: [3], days: 7 },
  { title: "Retrieval and RAG", blurb: "Search first, then grounded answers, then the advanced patterns.", levels: [4], days: 32 },
  { title: "Agents", blurb: "Tools, state, memory, multi-agent systems and context management.", levels: [5, 6], days: 27 },
  { title: "Evaluate, secure, ship", blurb: "Evals, guardrails and getting it to production.", levels: [7, 8, 10], days: 17 },
];

export const SPRINT_DAYS = SPRINT_STAGES.reduce((n, s) => n + s.days, 0);

export interface SprintDay {
  day: number;
  stage: number;
  modules: Module[];
}

export function sprintPlan(): SprintDay[] {
  const out: SprintDay[] = [];
  let dayBase = 0;
  SPRINT_STAGES.forEach((stage, si) => {
    const mods = LEVELS.filter((l) => stage.levels.includes(l.number))
      .flatMap((l) => l.modules)
      .filter((m) => !stage.skip?.includes(m.id));
    const total = mods.reduce((n, m) => n + m.sessions, 0) || 1;
    const days: Module[][] = Array.from({ length: stage.days }, () => []);
    let cum = 0;
    for (const m of mods) {
      const start = Math.min(stage.days - 1, Math.floor((cum / total) * stage.days));
      const end = Math.min(stage.days - 1, Math.max(start, Math.ceil(((cum + m.sessions) / total) * stage.days) - 1));
      for (let d = start; d <= end; d++) days[d].push(m);
      cum += m.sessions;
    }
    days.forEach((modules, i) => out.push({ day: dayBase + i + 1, stage: si, modules }));
    dayBase += stage.days;
  });
  return out;
}
