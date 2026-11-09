/** The seven phases of the path. Each level belongs to exactly one, and each phase has its own colour. */
export type PhaseId = "foundations" | "retrieval" | "agentic" | "trust" | "production" | "frontier" | "interview";

/** One idea inside a module. Topics are the smallest thing a learner ticks off. */
export interface Topic {
  /** short title, e.g. "Cosine, dot product and Euclidean distance" */
  title: string;
  /** one or two plain sentences: what you will be able to do or explain */
  detail: string;
}

/** A module: a few study sessions on one subject, ending with a concrete outcome. */
export interface Module {
  /** "<level>.<n>", e.g. "4.3". Lessons in content/ are matched by this id. */
  id: string;
  title: string;
  /** rough number of ~1 hour study sessions */
  sessions: number;
  topics: Topic[];
  /** "You can …" - the check that tells you the module is done */
  outcome: string;
  /** set when this module is a capstone; it points at a project in the same level */
  projectId?: string;
}

/** A build that proves a level. Done when every step is ticked and the deliverable exists. */
export interface Project {
  /** kebab-case, unique across the whole path, e.g. "hybrid-search-engine" */
  id: string;
  title: string;
  /** one sentence: what you build and why it matters */
  summary: string;
  steps: { title: string; detail: string }[];
  /** what you should have at the end */
  deliverable: string;
  /** ideas for going further once the basic version works */
  stretch?: string[];
}

export interface Level {
  number: number;
  title: string;
  /** a very short label for chips and the map, e.g. "RAG" */
  short: string;
  phase: PhaseId;
  /** 1-3 sentences: what this level is for */
  summary: string;
  /** how often this comes up in interviews (1-10) and why */
  interviewWeight: number;
  interviewNote: string;
  /** how much of day-to-day AI engineering work this is (1-10) and why */
  jobWeight: number;
  jobNote: string;
  /** level numbers you should be comfortable with first */
  assumes: number[];
  modules: Module[];
  projects: Project[];
}

export interface Phase {
  id: PhaseId;
  title: string;
  /** a few words, e.g. "agents, context engineering" */
  tagline: string;
  /** CSS colour token name suffix: var(--ph-<id>) */
  icon: string;
}
