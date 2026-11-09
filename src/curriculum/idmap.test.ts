import { describe, expect, it } from "vitest";
import { LEVELS, MODULES, PROJECTS, QUESTIONS, FLASHCARDS, practiceFor } from "./index";
import { lessonFor } from "./lessons";
import { guideFor } from "./guides";
import { migrateKey, migrateModuleId, migrateRecord } from "./idmap";
import { sanitize } from "../state/progress";

describe("module id migration", () => {
  it("moves modules that were pushed down by inserted ones, and leaves the rest", () => {
    // Level 4: "Chunking" was 4.2, now 4.3; the hybrid-search capstone was 4.7, now 4.8; the RAG capstone 4.15 → 4.16
    expect(migrateModuleId("4.1")).toBe("4.1");
    expect(migrateModuleId("4.2")).toBe("4.3");
    expect(migrateModuleId("4.7")).toBe("4.8");
    expect(migrateModuleId("4.15")).toBe("4.16");
    // Level 6: 6.1-6.4 stay; long-context strategies 6.5 → 6.15; capstone 6.9 → 6.19
    expect(migrateModuleId("6.4")).toBe("6.4");
    expect(migrateModuleId("6.5")).toBe("6.15");
    expect(migrateModuleId("6.9")).toBe("6.19");
    // Level 7
    expect(["7.6", "7.7", "7.8", "7.9"].map(migrateModuleId)).toEqual(["7.6", "7.9", "7.10", "7.12"]);
    // Level 8
    expect(["8.3", "8.4", "8.9"].map(migrateModuleId)).toEqual(["8.3", "8.6", "8.11"]);
    // Level 10
    expect(["10.8", "10.9", "10.10", "10.11"].map(migrateModuleId)).toEqual(["10.8", "10.12", "10.13", "10.14"]);
    // Other levels and non-module ids are untouched
    expect(migrateModuleId("5.3")).toBe("5.3");
    expect(migrateModuleId("hybrid-search-engine")).toBe("hybrid-search-engine");
  });

  it("rewrites progress keys of every shape", () => {
    expect(migrateKey("6.5")).toBe("6.15");
    expect(migrateKey("6.5:read")).toBe("6.15:read");
    expect(migrateKey("4.2:3")).toBe("4.3:3");
    expect(migrateKey("llmops-lifecycle:2")).toBe("llmops-lifecycle:2");
    expect(migrateRecord({ "6.5": true, "2.1": true })).toEqual({ "6.15": true, "2.1": true });
  });

  it("migrates saved progress once, then leaves numbering alone", () => {
    const old = sanitize({ modules: { "6.5": true, "10.9": true }, flow: { "4.2:read": true }, notes: { "8.4": "x", "hybrid-search-engine": "y" } });
    expect(old.modules).toEqual({ "6.15": true, "10.12": true });
    expect(old.flow).toEqual({ "4.3:read": true });
    expect(old.notes).toEqual({ "8.6": "x", "hybrid-search-engine": "y" });
    expect(old.idScheme).toBe(2);
    // data already on the new scheme is not shifted a second time
    const again = sanitize(old);
    expect(again.modules).toEqual({ "6.15": true, "10.12": true });
    expect(again.notes).toEqual({ "8.6": "x", "hybrid-search-engine": "y" });
  });
});

describe("the updated curriculum", () => {
  const ids = (n: number) => LEVELS[n].modules.map((m) => m.id);
  const title = (id: string) => MODULES.find((m) => m.id === id)!.title;

  it("has the module counts of the new table of contents", () => {
    expect(ids(4)).toHaveLength(16);
    expect(ids(6)).toHaveLength(19);
    expect(ids(7)).toHaveLength(14);
    expect(ids(8)).toHaveLength(11);
    expect(ids(9)).toHaveLength(10);
    expect(ids(10)).toHaveLength(14);
  });

  it("places the new modules where the table of contents puts them", () => {
    expect(title("4.2")).toMatch(/Airflow/);
    expect(title("6.5")).toMatch(/Short-term memory/);
    expect(title("6.14")).toMatch(/Forgetting/);
    expect(title("6.15")).toMatch(/Long-context/);
    expect(title("7.7")).toMatch(/golden datasets/i);
    expect(title("7.8")).toMatch(/LLM-as-a-judge/);
    expect(title("7.10")).toMatch(/RAGAS/);
    expect(title("7.11")).toMatch(/RAG metrics/);
    expect(title("7.13")).toMatch(/dashboards/);
    expect(title("8.4")).toMatch(/NeMo Guardrails/);
    expect(title("8.5")).toMatch(/NeMo Guardrails deep dive/);
    expect(title("10.9")).toMatch(/EKS/);
    expect(title("10.10")).toMatch(/Locust/);
    expect(title("10.11")).toMatch(/Autoscaling/);
    expect(title("10.12")).toMatch(/Monitoring/);
  });

  it("gives every new module a lesson, a real-life story and a build", () => {
    const fresh = ["4.2", "6.5", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "6.12", "6.13", "6.14", "7.7", "7.8", "7.11", "7.13", "8.4", "8.5", "10.9", "10.10", "10.11"];
    for (const id of fresh) {
      expect(lessonFor(id), `lesson ${id}`).toBeTruthy();
      expect(practiceFor(id)?.build.steps.length, `practice ${id}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("adds the eval-suite capstone with a full guide, and updates the other capstones", () => {
    expect(PROJECTS.some((p) => p.id === "rag-eval-suite" && p.level === 7)).toBe(true);
    expect(MODULES.find((m) => m.projectId === "rag-eval-suite")?.id).toBe("7.14");
    const g = guideFor("rag-eval-suite")!;
    expect(g.steps.length).toBeGreaterThanOrEqual(7);
    expect(guideFor("context-managed-agent")!.steps.some((s) => /layered memory/i.test(s.title))).toBe(true);
    expect(guideFor("red-team-agentic-rag")!.steps.some((s) => /guardrail framework/i.test(s.title))).toBe(true);
  });

  it("adds flashcards and interview questions for the new topics", () => {
    expect(FLASHCARDS.filter((c) => c.id.startsWith("fc-6n-")).length).toBeGreaterThanOrEqual(20);
    expect(QUESTIONS.filter((q) => q.level === 6 && q.id.startsWith("memory-")).length).toBeGreaterThanOrEqual(3);
  });
});
