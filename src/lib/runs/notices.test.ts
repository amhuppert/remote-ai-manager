import { describe, expect, it } from "vitest";
import { composeBoundaryNotice } from "./notices";
import type { RunBoundary } from "./schemas";

const run = { runId: "run-1" };

function boundary(kind: RunBoundary["kind"], detail: unknown): RunBoundary {
  return {
    seq: 3,
    runId: "run-1",
    occurrence: "o",
    kind,
    summary: "Fix it: something happened.",
    detail,
    recordedAt: "t",
    notifiedAt: null,
  };
}

describe("run boundary notices", () => {
  it("names the dispositions that clear the halt and the occurrence they must cite", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("halted", {
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
      boundary("question", { contextId: "run-1.agent", questionId: "q-1" }),
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
      boundary("approval", { contextId: "run-1.agent", candidateId: "c-1" }),
    );
    expect(notice).toContain("Only Alex can decide this");
    expect(notice).not.toContain("cctl run decide");
  });

  it("does not offer resume for a route or loop halt, and says whether another notice follows", () => {
    const waiting = composeBoundaryNotice(
      run,
      boundary("halted", { runHalt: "loop_exhausted", otherWorkRemains: true }),
    );
    expect(waiting).not.toContain("cctl run resume");
    expect(waiting).toContain("cctl run cancel run-1");
    expect(waiting).toContain("another notice follows once only halted routes or loops remain");

    const stalled = composeBoundaryNotice(
      run,
      boundary("halted", { runHalt: "stalled", otherWorkRemains: false }),
    );
    expect(stalled).not.toContain("cctl run resume");
    expect(stalled).not.toContain("another notice follows");
    expect(stalled).toContain("cctl run cancel run-1");
  });

  it("tells the owner to retry a lane once what stopped its publication is fixed", () => {
    const notice = composeBoundaryNotice(
      run,
      boundary("halted", { runHalt: "lane_publication", lane: "api", otherWorkRemains: false }),
    );
    expect(notice).toContain("cctl run retry run-1 --lane api");
    expect(notice).not.toContain("cctl run resume");
  });
});
