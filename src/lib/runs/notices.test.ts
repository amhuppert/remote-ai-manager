import { describe, expect, it } from "vitest";
import { composeBoundaryNotice } from "./notices";
import type { RunBoundary } from "./schemas";

const run = { runId: "run-1" };

function boundary(kind: RunBoundary["kind"], detail: RunBoundary["detail"]): RunBoundary {
  return {
    seq: 3,
    runId: "run-1",
    occurrence: "o",
    kind,
    summary: "Fix it: something happened.",
    detail,
    recordedAt: "t",
  };
}

describe("run boundary notices", () => {
  it("names the dispositions that clear the halt and the occurrence they must cite", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("halted", {
        kind: "context_halt",
        contextId: "run-1.agent",
        halt: "turn_failed",
        occurrence: "occ-7",
        dispositions: ["continue", "replace_seat", "confirm_effect"],
      }),
    );
    expect(notice).toContain("continue, replace_seat, confirm_effect");
    expect(notice).toContain(
      "cctl run resume run-1 --context run-1.agent --occurrence occ-7 --disposition <kind>",
    );
  });

  it("carries the question text and the exact answer command", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("question", { kind: "question", contextId: "run-1.agent", questionId: "q-1" }),
      {
        questionText: "Which file?",
      },
    );
    expect(notice).toContain("Question: Which file?");
    expect(notice).toContain("cctl run answer run-1 --question q-1");
  });

  it("tells the owner that only Alex can approve, without offering an approval command", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("approval", { kind: "approval", contextId: "run-1.agent", candidateId: "c-1" }),
    );
    expect(notice).toContain("Only Alex can decide this");
    expect(notice).not.toContain("cctl run decide");
  });

  it("offers an amendment, not resume, for a route or loop halt, and says whether another notice follows", () => {
    const waiting = composeBoundaryNotice(
      run,
      boundary("halted", { kind: "run_halt", halt: "loop_exhausted", clearedBy: "amend", otherWorkRemains: true }),
    );
    expect(waiting).not.toContain("cctl run resume");
    expect(waiting).toContain("cctl run amend run-1 --file");
    expect(waiting).toContain("another notice follows once only halted routes or loops remain");

    const stalled = composeBoundaryNotice(
      run,
      boundary("halted", { kind: "stalled", clearedBy: "amend" }),
    );
    expect(stalled).not.toContain("cctl run resume");
    expect(stalled).not.toContain("another notice follows");
    expect(stalled).toContain("cctl run amend run-1 --file");
    expect(stalled).toContain("cctl run definition run-1");
  });

  it("offers only cancelling for a loop whose exit result cannot be read, which no amendment of a started loop changes", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("halted", { kind: "run_halt", halt: "loop_unevaluable", clearedBy: "cancel", otherWorkRemains: false }),
    );
    expect(notice).not.toContain("cctl run amend");
    expect(notice).toContain("cctl run cancel run-1");

    const onlyUnreadableLoops = composeBoundaryNotice(
      run,
      boundary("halted", { kind: "stalled", clearedBy: "cancel" }),
    );
    expect(onlyUnreadableLoops).not.toContain("cctl run amend");
    expect(onlyUnreadableLoops).toContain("cctl run cancel run-1");
  });

  it("tells the owner to retry a lane once what stopped its publication is fixed", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("halted", { kind: "run_halt", halt: "lane_publication", clearedBy: "retry_lane", lane: "api", otherWorkRemains: false }),
    );
    expect(notice).toContain("cctl run retry run-1 --lane api");
    expect(notice).not.toContain("cctl run resume");
  });
});
