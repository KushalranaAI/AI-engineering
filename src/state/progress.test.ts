import { beforeEach, describe, expect, it } from "vitest";
import { LEVELS, PROJECTS, moduleOfProject } from "../curriculum";
import { FLOW, dueCards, levelFraction, moduleFraction, nextModule, projectFraction, projectStepCount, streak, today, useProgress } from "./progress";

beforeEach(() => useProgress.getState().reset());

describe("progress", () => {
  it("starts at the first module of the chosen start level", () => {
    expect(nextModule(useProgress.getState())?.id).toBe("0.1");
    useProgress.getState().setStartLevel(4);
    expect(nextModule(useProgress.getState())?.id).toBe("4.1");
  });

  it("moves 'next' past completed modules and ticks their topics", () => {
    const s = useProgress.getState();
    s.setModuleDone("0.1", true);
    const p = useProgress.getState();
    expect(nextModule(p)?.id).toBe("0.2");
    const m = LEVELS[0].modules[0];
    expect(m.topics.every((_, i) => p.topics[`0.1:${i}`])).toBe(true);
    expect(moduleFraction(p, m)).toBe(1);
  });

  it("counts finished flow steps as partial module progress, below 100% until completed", () => {
    const m = LEVELS[1].modules[0];
    useProgress.getState().setFlow(m.id, "read", true);
    useProgress.getState().setFlow(m.id, "relate", true);
    const f = moduleFraction(useProgress.getState(), m);
    expect(f).toBeCloseTo(0.5);
    useProgress.getState().setFlow(m.id, "build", true);
    useProgress.getState().setFlow(m.id, "check", true);
    expect(moduleFraction(useProgress.getState(), m)).toBeLessThan(1);
    useProgress.getState().setModuleDone(m.id, true);
    expect(moduleFraction(useProgress.getState(), m)).toBe(1);
    expect(FLOW.every((s) => useProgress.getState().flow[`${m.id}:${s}`])).toBe(true);
  });

  it("completes a capstone module exactly when every project step is ticked", () => {
    const proj = PROJECTS[0];
    const mod = moduleOfProject(proj.id)!;
    const n = projectStepCount(proj.id);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) useProgress.getState().toggleStep(proj.id, i);
    expect(useProgress.getState().modules[mod.id]).toBe(true);
    expect(projectFraction(useProgress.getState(), proj.id)).toBe(1);
    useProgress.getState().toggleStep(proj.id, 0);
    expect(useProgress.getState().modules[mod.id]).toBeUndefined();
  });

  it("reaches 100% for a level when every module is done", () => {
    const l = LEVELS[3];
    for (const m of l.modules) useProgress.getState().setModuleDone(m.id, true);
    expect(levelFraction(useProgress.getState(), l)).toBeCloseTo(1);
  });

  it("logs activity for today", () => {
    useProgress.getState().toggleTopic("1.1", 0);
    expect(useProgress.getState().days[today()]).toBeGreaterThan(0);
  });

  it("ignores junk when importing", () => {
    useProgress.getState().replace({ modules: { "2.1": true }, startLevel: 99, days: "nope", notes: ["x"] });
    const p = useProgress.getState();
    expect(p.modules).toEqual({ "2.1": true });
    expect(p.startLevel).toBe(LEVELS.length - 1);
    expect(p.days).toEqual({});
    expect(p.notes).toEqual({});
  });
});

describe("streak", () => {
  const d = (s: string) => new Date(s + "T12:00:00");
  it("counts back from today, or from yesterday if today is empty", () => {
    const days = { "2026-11-04": 1, "2026-11-05": 2, "2026-11-06": 1 };
    expect(streak(days, d("2026-11-06"))).toBe(3);
    expect(streak(days, d("2026-11-07"))).toBe(3);
    expect(streak(days, d("2026-11-08"))).toBe(0);
    expect(streak({}, d("2026-11-06"))).toBe(0);
  });
});

describe("spaced repetition", () => {
  it("makes cards from reached levels due, then pushes them out as you grade them", () => {
    useProgress.getState().setStartLevel(4);
    const due = dueCards(useProgress.getState());
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((c) => c.level <= 4)).toBe(true);
    const id = due[0].id;
    useProgress.getState().gradeCard(id, "good");
    expect(dueCards(useProgress.getState()).some((c) => c.id === id)).toBe(false);
    useProgress.getState().gradeCard(id, "again");
    expect(dueCards(useProgress.getState()).some((c) => c.id === id)).toBe(true);
  });
});
