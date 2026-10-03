import { describe, expect, it } from "vitest";
import { composeBoundaryNotice } from "./notices";
import type { RunBoundary } from "./schemas";

const run = { runId: "run-1" };

function boundary(kind: RunBoundary["kind"], detail: unknown): RunBoundary {
  return { seq: 3, runId: "run-1", occurrence: "o", kind, summary: "Fix it: something happened.", detail, recordedAt: "t", notifiedAt: null };
}

describe("run boundary notices", () => {
  it("names the dispositions that clear the halt and the occurrence they must cite", () => {
    const notice = composeBoundaryNotice(run, boundary("halted", { contextId: "run-1.agent", halt: "turn_failed", occurrence: "occ-7" }));
    expect(notice).toContain("continue, replace_seat, confirm_effect");
    expect(notice).toContain("cctl run resume run-1 --context run-1.agent --occurrence occ-7 --disposition <kind>");
  });

  it("carries the question text and the exact answer command", () => {
    const notice = composeBoundaryNotice(run, boundary("question", { contextId: "run-1.agent", questionId: "q-1" }), {
      questionText: "Which file?",
    });
    expect(notice).toContain("Question: Which file?");
    expect(notice).toContain("cctl run answer run-1 --question q-1");
  });

  it("tells the owner that only Alex can approve, without offering an approval command", () => {
    const notice = composeBoundaryNotice(run, boundary("approval", { contextId: "run-1.agent", candidateId: "c-1" }));
    expect(notice).toContain("Only Alex can decide this");
    expect(notice).not.toContain("cctl run decide");
  });
});
