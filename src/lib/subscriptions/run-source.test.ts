import { describe, expect, it } from "vitest";
import { runBoundarySchema, type RunBoundary } from "@/lib/runs/schemas";
import { createRunSourceReader } from "./run-source";

const owner = { projectPath: "/repo", conversationId: "owner" };
const source = { id: "run-1" };

function boundary(seq: number, occurrence: string, detail: RunBoundary["detail"], summary: string): RunBoundary {
  return runBoundarySchema.parse({
    seq,
    runId: "run-1",
    occurrence,
    kind: detail.kind,
    summary,
    detail,
    recordedAt: `2026-10-06T10:0${seq}:00.000Z`,
  });
}

const boundaries = [
  boundary(1, "ctx:question:q-1", { kind: "question", contextId: "ctx", questionId: "q-1" }, "Fix the notice: a question."),
  boundary(2, "ctx:question:q-2", { kind: "question", contextId: "ctx", questionId: "q-2" }, "Fix the notice: a question."),
  boundary(3, "run:succeeded", { kind: "succeeded", outputs: { files: 1 } }, "Fix the notice: succeeded."),
];
const questions: Record<string, { questionText: string; state: "open" | "answered" | "withdrawn" }> = {
  "q-1": { questionText: "Which file?", state: "answered" },
  "q-2": { questionText: "Which helper?", state: "open" },
};
const read = createRunSourceReader({
  run: (runId) => (runId === "run-1" ? { runId, projectPath: "/repo", title: "Fix the notice" } : null),
  boundaries: () => boundaries,
  question: (questionId) => questions[questionId] ?? null,
});

describe("run subscription source", () => {
  it("starts a new follow after the boundaries already recorded", async () => {
    expect(await read(owner, source, null)).toEqual({ cursor: "3", facts: [], missing: false });
  });

  it("reads each later boundary as a fact carrying the owner's notice, and withdraws a question already answered", async () => {
    const result = await read(owner, source, "0");

    expect(result.cursor).toBe("3");
    expect(result.withdrawnOccurrenceIds).toEqual(["ctx:question:q-1"]);
    expect(result.facts.map((fact) => [fact.occurrenceId, fact.eventKind, fact.category])).toEqual([
      ["ctx:question:q-2", "run-boundary:question", "decision"],
      ["run:succeeded", "run-boundary:succeeded", "outcome"],
    ]);
    const [question] = result.facts;
    expect(question).toMatchObject({ sourceTitle: "Fix the notice", retrievalHandle: "cctl run show run-1" });
    expect(question?.sourceText).toContain("Question: Which helper?");
    expect(question?.sourceText).toContain("cctl run answer run-1 --question q-2");
  });

  it("reads nothing new past the latest boundary", async () => {
    expect((await read(owner, source, "3")).facts).toEqual([]);
  });

  it("reports a run of another project as missing", async () => {
    expect(await read({ ...owner, projectPath: "/other" }, source, "0")).toEqual({
      cursor: "0",
      facts: [],
      missing: true,
    });
  });
});
