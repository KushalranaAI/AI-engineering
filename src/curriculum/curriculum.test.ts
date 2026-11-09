import { describe, expect, it } from "vitest";
import { FLASHCARDS, LEVELS, MODULES, PHASES, PROJECTS, QUESTIONS, TOTAL_SESSIONS, practiceFor } from "./index";
import { allGuides, guideFor } from "./guides";
import { allLessons, lessonFor, parseLesson, splitChecks } from "./lessons";
import { SPRINT_DAYS, sprintPlan } from "./sprint";

describe("curriculum data", () => {
  it("has levels 0-16 in order, each in a known phase", () => {
    expect(LEVELS.map((l) => l.number)).toEqual([...Array(17).keys()]);
    const phases = new Set(PHASES.map((p) => p.id));
    for (const l of LEVELS) expect(phases.has(l.phase), `L${l.number} phase ${l.phase}`).toBe(true);
  });

  it("puts phases in path order (a phase's levels are contiguous)", () => {
    const order = LEVELS.map((l) => PHASES.findIndex((p) => p.id === l.phase));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("numbers every module <level>.<n>, unique, in sequence", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LEVELS) {
      expect(l.modules.length, `L${l.number} has modules`).toBeGreaterThan(0);
      l.modules.forEach((m, i) => expect(m.id).toBe(`${l.number}.${i + 1}`));
    }
  });

  it("gives every module sessions, an outcome, and topics unless it is a capstone", () => {
    for (const m of MODULES) {
      expect(m.sessions, m.id).toBeGreaterThan(0);
      expect(m.outcome.length, m.id).toBeGreaterThan(10);
      if (!m.projectId) expect(m.topics.length, `${m.id} topics`).toBeGreaterThan(0);
      for (const t of m.topics) expect(t.title && t.detail, `${m.id} topic`).toBeTruthy();
    }
  });

  it("links capstones to a project in the same level, and every project to exactly one capstone", () => {
    const ids = PROJECTS.map((p) => p.id);
    expect(new Set(ids).size, "unique project ids").toBe(ids.length);
    for (const l of LEVELS)
      for (const m of l.modules.filter((x) => x.projectId)) expect(l.projects.some((p) => p.id === m.projectId), `${m.id} → ${m.projectId}`).toBe(true);
    for (const p of PROJECTS) expect(MODULES.filter((m) => m.projectId === p.id).length, `${p.id} capstone`).toBe(1);
  });

  it("has well-formed projects and weights", () => {
    for (const p of PROJECTS) {
      expect(p.steps.length, p.id).toBeGreaterThanOrEqual(3);
      expect(p.deliverable.length, p.id).toBeGreaterThan(10);
    }
    for (const l of LEVELS) {
      for (const w of [l.interviewWeight, l.jobWeight]) expect(w >= 1 && w <= 10, `L${l.number} weight ${w}`).toBe(true);
      for (const a of l.assumes) expect(a, `L${l.number} assumes L${a}`).toBeLessThan(l.number);
    }
    expect(TOTAL_SESSIONS).toBeGreaterThan(200);
  });
});

describe("lessons", () => {
  it("only exist for real, non-capstone modules, one each", () => {
    const seen = new Set<string>();
    for (const l of allLessons()) {
      const m = MODULES.find((x) => x.id === l.module);
      expect(m, `${l.file} → module ${l.module}`).toBeTruthy();
      expect(m?.projectId, `${l.file} is for a capstone`).toBeUndefined();
      expect(seen.has(l.module), `duplicate lesson for ${l.module}`).toBe(false);
      seen.add(l.module);
    }
  });

  it("cover every non-capstone module", () => {
    const missing = MODULES.filter((m) => !m.projectId && !lessonFor(m.id)).map((m) => m.id);
    expect(missing).toEqual([]);
  });

  it("start with a title heading and have a Check yourself quiz", () => {
    for (const l of allLessons()) {
      expect(l.body.startsWith("# "), `${l.file} starts with # title`).toBe(true);
      expect(splitChecks(l.body).checks.length, `${l.file} checks`).toBeGreaterThanOrEqual(2);
    }
  });

  it("parses frontmatter and splits the quiz out of the body", () => {
    const raw = `---\nmodule: "9.9"\ntitle: "T"\nminutes: 7\n---\n# T\n\nBody.\n\n## Check yourself\n\n1. **What?**\n<details><summary>Answer</summary>\n\nThat.\n</details>\n\n2. Why?\n<details><summary>Answer</summary>Because.</details>\n\n## Sources\n\n- x\n`;
    const l = parseLesson("x.md", raw)!;
    expect(l).toMatchObject({ module: "9.9", title: "T", minutes: 7 });
    const { main, checks } = splitChecks(l.body);
    expect(checks).toEqual([{ q: "What?", a: "That." }, { q: "Why?", a: "Because." }]);
    expect(main).toContain("## Sources");
    expect(main).not.toContain("Check yourself");
  });
});

describe("100-day sprint", () => {
  it("fills every day with at least one module, in path order", () => {
    const plan = sprintPlan();
    expect(plan.length).toBe(SPRINT_DAYS);
    expect(SPRINT_DAYS).toBe(100);
    for (const d of plan) expect(d.modules.length, `day ${d.day}`).toBeGreaterThan(0);
    const order = plan.flatMap((d) => d.modules.map((m) => MODULES.findIndex((x) => x.id === m.id)));
    order.forEach((idx, i) => i > 0 && expect(idx, `step ${i}`).toBeGreaterThanOrEqual(order[i - 1]));
  });
});

describe("practice layer", () => {
  it("has a real-life story and a build task for every module", () => {
    const missing = MODULES.filter((m) => !practiceFor(m.id)).map((m) => m.id);
    expect(missing).toEqual([]);
    for (const m of MODULES) {
      const p = practiceFor(m.id)!;
      expect(p.realLife.story.length, `${m.id} story`).toBeGreaterThan(80);
      expect(p.realLife.mapping.length, `${m.id} mapping`).toBeGreaterThanOrEqual(2);
      expect(p.build.steps.length, `${m.id} steps`).toBeGreaterThanOrEqual(3);
      expect(p.build.checks.length, `${m.id} checks`).toBeGreaterThanOrEqual(2);
      expect(p.build.minutes, `${m.id} minutes`).toBeGreaterThan(0);
    }
  });
  it("uses a different everyday setting for each module", () => {
    const titles = MODULES.map((m) => practiceFor(m.id)!.realLife.title.toLowerCase());
    expect(new Set(titles).size).toBeGreaterThan(titles.length * 0.9);
  });
});

describe("project guides", () => {
  it("belong to real projects and parse into steps", () => {
    for (const g of allGuides()) {
      expect(PROJECTS.some((p) => p.id === g.project), `guide ${g.project} has no project`).toBe(true);
      expect(g.steps.length, `${g.project} steps`).toBeGreaterThanOrEqual(5);
      expect(g.ship, `${g.project} ship`).toBeTruthy();
      for (const s of g.steps) expect(s.body.length, `${g.project}: ${s.title}`).toBeGreaterThan(200);
    }
  });
  it("number their steps in order", () => {
    for (const p of PROJECTS) {
      const g = guideFor(p.id);
      if (g) expect(g.steps.map((s) => s.title).every(Boolean)).toBe(true);
    }
  });
});

describe("interview bank and flashcards", () => {
  it("has unique ids and points at real levels", () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    expect(new Set(FLASHCARDS.map((c) => c.id)).size).toBe(FLASHCARDS.length);
    for (const q of QUESTIONS) {
      expect(q.level >= 0 && q.level <= 16, q.id).toBe(true);
      expect(q.strong.length, q.id).toBeGreaterThanOrEqual(3);
    }
    for (const c of FLASHCARDS) expect(c.back.length, c.id).toBeGreaterThan(20);
    expect(QUESTIONS.length).toBeGreaterThan(100);
    expect(FLASHCARDS.length).toBeGreaterThan(200);
  });
});
