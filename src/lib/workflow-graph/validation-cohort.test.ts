import { describe, expect, it, vi } from "vitest";
import {
  COHORT_ADMISSION_WAITS,
  COHORT_SPECIALIST_ATTEMPTS,
  concludeCohort,
  runCohortLanes,
  type CohortDispatchOutcome,
  type CohortLane,
  type CohortLaneProgress,
} from "./validation-cohort";

function pass(assignmentId: string, summary = "Looks good."): CohortLane {
  return {
    assignmentId,
    attempts: 0,
    settlement: {
      kind: "pass",
      summary,
      feedback: `Context validation passed.\n${summary}`,
      issues: [],
      reopenTaskIds: [],
      sessionRef: null,
      reviewArtifact: null,
    },
  };
}

/**
 * A rejection whose finding TEXT names nothing about who wrote it — which is
 * what a real validator produces, since a reviewer writes about the work rather
 * than about itself. Attribution therefore has to come from the finding's own
 * `assignmentId`, never from a title a test happened to label.
 */
function fail(
  assignmentId: string,
  taskIds: string[],
  summary = `${assignmentId}: rejected`,
): CohortLane {
  return {
    assignmentId,
    attempts: 0,
    settlement: {
      kind: "fail",
      summary,
      feedback: `Context validation blocked completion.\n${summary}`,
      issues: taskIds.map((taskId) => ({
        assignmentId,
        taskId,
        title: `Unfinished work in ${taskId}`,
        description: `${taskId} needs another pass.`,
      })),
      reopenTaskIds: taskIds,
      sessionRef: null,
      reviewArtifact: null,
    },
  };
}

function exhausted(assignmentId: string, attempts = 3): CohortLane {
  return {
    assignmentId,
    attempts,
    settlement: {
      kind: "infra_exhausted",
      assignmentId,
      attempts,
      reason: "exception",
      message: "provider unavailable",
      engine: "claude",
    },
  };
}

function parked(assignmentId: string): CohortLane {
  return {
    assignmentId,
    attempts: 0,
    settlement: {
      kind: "asked_user",
      conversationId: `conv-${assignmentId}`,
      questionBatchId: `batch-${assignmentId}`,
      questions: [],
    },
  };
}

function mismatched(assignmentId: string): CohortLane {
  return {
    assignmentId,
    attempts: 0,
    settlement: {
      kind: "candidate_mismatch",
      stage: "specialist_result",
      assignmentId,
    },
  };
}

describe("concludeCohort: precedence", () => {
  it("concludes as a pass only when every specialist passed", () => {
    const conclusion = concludeCohort([
      pass("general", "general: fine"),
      pass("security-reviewer", "security-reviewer: fine"),
    ]);

    expect(conclusion.kind).toBe("passed");
    if (conclusion.kind !== "passed") return;
    expect(conclusion.summary).toBe("general: fine\nsecurity-reviewer: fine");
  });

  it("concludes semantically on any rejection once every non-infra specialist has reported", () => {
    // The precedence rule the amended R6 turns on: a rejection is a conclusion
    // even with an infra-failed sibling, because remediation does not need the
    // unheard specialist's opinion to know the work is going back.
    const conclusion = concludeCohort([
      pass("general"),
      fail("security-reviewer", ["task-plan-1"]),
      exhausted("perf-reviewer"),
    ]);

    expect(conclusion.kind).toBe("failed");
  });

  it("leaves the round unconcluded when nothing rejected and a specialist is exhausted", () => {
    // All-of semantics: an unheard REQUIRED validator makes the round
    // unconcludable. Passing siblings cannot vouch for what it would have said.
    const conclusion = concludeCohort([
      pass("general"),
      exhausted("security-reviewer", 3),
    ]);

    expect(conclusion.kind).toBe("unconcluded");
    if (conclusion.kind !== "unconcluded") return;
    expect(conclusion.assignmentId).toBe("security-reviewer");
    expect(conclusion.attempts).toBe(3);
  });

  it("names the first exhausted specialist in cohort order, not in completion order", () => {
    const conclusion = concludeCohort([
      exhausted("general", 3),
      pass("security-reviewer"),
      exhausted("perf-reviewer", 3),
    ]);

    expect(conclusion.kind).toBe("unconcluded");
    if (conclusion.kind !== "unconcluded") return;
    expect(conclusion.assignmentId).toBe("general");
  });

  it("does not conclude while a specialist is parked on a question", () => {
    // A parked lane has not reported, so "every non-infra-failed specialist has
    // reported" is false and the rejection cannot conclude the round yet.
    const conclusion = concludeCohort([
      fail("general", ["task-plan-1"]),
      parked("security-reviewer"),
    ]);

    expect(conclusion.kind).toBe("parked");
    if (conclusion.kind !== "parked") return;
    expect(conclusion.parked.map((lane) => lane.conversationId)).toEqual([
      "conv-security-reviewer",
    ]);
  });

  it("names every parked lane and retains the verdicts that already settled", () => {
    // Two lanes may be waiting on the human at once. Reporting only the first
    // would strand the second's question — nothing downstream could route an
    // answer to a lane whose existence the conclusion never mentioned.
    const conclusion = concludeCohort([
      pass("general", "general: fine"),
      parked("security-reviewer"),
      parked("perf-reviewer"),
    ]);

    expect(conclusion.kind).toBe("parked");
    if (conclusion.kind !== "parked") return;
    expect(conclusion.parked).toEqual([
      {
        assignmentId: "security-reviewer",
        conversationId: "conv-security-reviewer",
        questionBatchId: "batch-security-reviewer",
        questions: [],
      },
      {
        assignmentId: "perf-reviewer",
        conversationId: "conv-perf-reviewer",
        questionBatchId: "batch-perf-reviewer",
        questions: [],
      },
    ]);
    // The passing sibling's verdict survives the park: a resume that re-ran it
    // would re-review a candidate its reviewer already judged.
    expect(conclusion.settled.map((lane) => lane.assignmentId)).toEqual([
      "general",
    ]);
  });

  it("a candidate mismatch outranks every verdict in the round", () => {
    // Nothing may be recorded for a round that cannot prove what it reviewed —
    // not even a rejection that arrived from a specialist that saw the frozen
    // candidate.
    const conclusion = concludeCohort([
      fail("general", ["task-plan-1"]),
      mismatched("security-reviewer"),
    ]);

    expect(conclusion.kind).toBe("candidate_mismatch");
    if (conclusion.kind !== "candidate_mismatch") return;
    expect(conclusion.assignmentId).toBe("security-reviewer");
  });
});

describe("concludeCohort: aggregate assembly", () => {
  it("groups findings by assignment in cohort order and dedupes only the reopened task ids", () => {
    const conclusion = concludeCohort([
      fail("general", ["task-plan-1", "task-plan-2"], "general: two problems"),
      fail(
        "security-reviewer",
        ["task-plan-2", "task-plan-3"],
        "security-reviewer: one overlap",
      ),
    ]);

    expect(conclusion.kind).toBe("failed");
    if (conclusion.kind !== "failed") return;

    // Findings are NOT deduplicated — two reviewers objecting to one task for
    // different reasons is two findings, and collapsing them would silently
    // drop one specialist's review. Each stays attributed to the specialist
    // that raised it, contiguously and in cohort order, so a reader of the
    // aggregate can tell the two reviews apart without parsing prose.
    expect(
      conclusion.issues.map((issue) => [issue.assignmentId, issue.taskId]),
    ).toEqual([
      ["general", "task-plan-1"],
      ["general", "task-plan-2"],
      ["security-reviewer", "task-plan-2"],
      ["security-reviewer", "task-plan-3"],
    ]);
    // Task ids ARE deduplicated: reopening a task twice is not two reopens.
    expect(conclusion.reopenTaskIds).toEqual([
      "task-plan-1",
      "task-plan-2",
      "task-plan-3",
    ]);
    expect(conclusion.summary).toBe(
      "general: two problems\nsecurity-reviewer: one overlap",
    );
  });

  it("keeps two textually identical findings apart by the assignment that raised them", () => {
    // Two reviewers can word the same objection identically. Without explicit
    // attribution the aggregate would read as one specialist repeating itself,
    // and neither remediation nor evidence ingestion could say who found what.
    const conclusion = concludeCohort([
      fail("security-reviewer", ["task-plan-1"]),
      fail("perf-reviewer", ["task-plan-1"]),
    ]);

    expect(conclusion.kind).toBe("failed");
    if (conclusion.kind !== "failed") return;
    expect(conclusion.issues).toEqual([
      {
        assignmentId: "security-reviewer",
        taskId: "task-plan-1",
        title: "Unfinished work in task-plan-1",
        description: "task-plan-1 needs another pass.",
      },
      {
        assignmentId: "perf-reviewer",
        taskId: "task-plan-1",
        title: "Unfinished work in task-plan-1",
        description: "task-plan-1 needs another pass.",
      },
    ]);
    expect(conclusion.reopenTaskIds).toEqual(["task-plan-1"]);
  });

  it("assembles in configured cohort order even when lanes are supplied out of it", () => {
    // The lanes array IS the cohort order; a caller that appended in completion
    // order would produce a different aggregate for the same round, which is
    // exactly what R16.1 forbids.
    const conclusion = concludeCohort([
      pass("general", "general: ok"),
      fail("security-reviewer", ["task-plan-2"], "security-reviewer: no"),
      fail("perf-reviewer", ["task-plan-1"], "perf-reviewer: no"),
    ]);

    expect(conclusion.kind).toBe("failed");
    if (conclusion.kind !== "failed") return;
    expect(conclusion.summary).toBe(
      "general: ok\nsecurity-reviewer: no\nperf-reviewer: no",
    );
    expect(conclusion.reopenTaskIds).toEqual(["task-plan-2", "task-plan-1"]);
  });

  it("carries the settled verdicts through an unconcluded round", () => {
    // Retained, not discarded: a resume reruns only the unsettled specialists,
    // which is only sound if what the settled ones already said survives.
    const lanes = [
      pass("general", "general: ok"),
      exhausted("security-reviewer"),
    ];
    const conclusion = concludeCohort(lanes);

    expect(conclusion.kind).toBe("unconcluded");
    if (conclusion.kind !== "unconcluded") return;
    expect(conclusion.settled.map((lane) => lane.assignmentId)).toEqual([
      "general",
    ]);
  });
});

describe("runCohortLanes: simultaneous dispatch", () => {
  it("starts every lane before any lane settles", async () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();

    const lanes = runCohortLanes({
      assignmentIds: ["general", "security-reviewer", "perf-reviewer"],
      dispatch: async (assignmentId): Promise<CohortDispatchOutcome> => {
        started.push(assignmentId);
        await new Promise<void>((resolve) => gates.set(assignmentId, resolve));
        return {
          kind: "pass",
          summary: `${assignmentId}: ok`,
          feedback: "Context validation passed.",
          issues: [],
          reopenTaskIds: [],
        };
      },
    });

    // Nothing has been released, so no lane can have finished — yet all three
    // must already be running.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["general", "security-reviewer", "perf-reviewer"]);

    for (const release of gates.values()) release();
    const settled = await lanes;
    expect(settled.map((lane) => lane.assignmentId)).toEqual([
      "general",
      "security-reviewer",
      "perf-reviewer",
    ]);
  });

  it("an artificially slow specialist never delays a sibling's start or settlement", async () => {
    const started: string[] = [];
    const settledOrder: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const lanesPromise = runCohortLanes({
      assignmentIds: ["slow", "fast-a", "fast-b"],
      dispatch: async (assignmentId): Promise<CohortDispatchOutcome> => {
        started.push(assignmentId);
        if (assignmentId === "slow") await slowGate;
        settledOrder.push(assignmentId);
        return {
          kind: "pass",
          summary: `${assignmentId}: ok`,
          feedback: "Context validation passed.",
          issues: [],
          reopenTaskIds: [],
        };
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["slow", "fast-a", "fast-b"]);
    // Both fast lanes are DONE while the slow one is still blocked.
    expect(settledOrder).toEqual(["fast-a", "fast-b"]);

    releaseSlow();
    const lanes = await lanesPromise;
    // Assembly is in cohort order regardless of that completion order.
    expect(lanes.map((lane) => lane.assignmentId)).toEqual([
      "slow",
      "fast-a",
      "fast-b",
    ]);
  });
});

describe("runCohortLanes: attempt accounting", () => {
  it("charges an attempt per admitted dispatch that fails as infrastructure, and exhausts at the cap", async () => {
    const dispatch = vi.fn(
      async (): Promise<CohortDispatchOutcome> => ({
        kind: "infra_error",
        reason: "exception",
        message: "provider 500",
        engine: "claude",
        sessionRef: null,
        reviewArtifact: null,
      }),
    );

    const lanes = await runCohortLanes({
      assignmentIds: ["general"],
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(COHORT_SPECIALIST_ATTEMPTS);
    expect(lanes[0]!.attempts).toBe(COHORT_SPECIALIST_ATTEMPTS);
    expect(lanes[0]!.settlement.kind).toBe("infra_exhausted");
  });

  it("retries only the affected specialist and retains its siblings' verdicts", async () => {
    const calls: string[] = [];
    let generalAttempts = 0;

    const lanes = await runCohortLanes({
      assignmentIds: ["general", "security-reviewer"],
      dispatch: async (assignmentId): Promise<CohortDispatchOutcome> => {
        calls.push(assignmentId);
        if (assignmentId === "general") {
          generalAttempts += 1;
          if (generalAttempts < 3) {
            return {
              kind: "infra_error",
              reason: "exception",
              message: "flaky",
              engine: "claude",
              sessionRef: null,
              reviewArtifact: null,
            };
          }
        }
        return {
          kind: "pass",
          summary: `${assignmentId}: ok`,
          feedback: "Context validation passed.",
          issues: [],
          reopenTaskIds: [],
        };
      },
    });

    // The sibling ran exactly once — a retry is the affected lane's business.
    expect(calls.filter((id) => id === "security-reviewer")).toHaveLength(1);
    expect(calls.filter((id) => id === "general")).toHaveLength(3);
    expect(lanes[0]!.attempts).toBe(2);
    expect(lanes[0]!.settlement.kind).toBe("pass");
    expect(lanes[1]!.settlement.kind).toBe("pass");
  });

  it("does not charge an attempt for a dispatch the queue never admitted", async () => {
    let call = 0;
    const lanes = await runCohortLanes({
      assignmentIds: ["general"],
      dispatch: async (): Promise<CohortDispatchOutcome> => {
        call += 1;
        if (call <= 2) {
          return {
            kind: "queue_admission_timeout",
            message: "no slot",
            engine: "claude",
          };
        }
        return {
          kind: "pass",
          summary: "general: ok",
          feedback: "Context validation passed.",
          issues: [],
          reopenTaskIds: [],
        };
      },
    });

    // Two waits, one verdict, zero attempts consumed: queue depth is not a
    // reflection on the specialist, so it must not eat its retry budget.
    expect(call).toBe(3);
    expect(lanes[0]!.attempts).toBe(0);
    expect(lanes[0]!.settlement.kind).toBe("pass");
  });

  it("leaves the full retry budget intact for an infra failure that follows queue pressure", async () => {
    let call = 0;
    const lanes = await runCohortLanes({
      assignmentIds: ["general"],
      dispatch: async (): Promise<CohortDispatchOutcome> => {
        call += 1;
        if (call === 1) {
          return {
            kind: "queue_admission_timeout",
            message: "no slot",
            engine: "claude",
          };
        }
        return {
          kind: "infra_error",
          reason: "exception",
          message: "provider 500",
          engine: "claude",
          sessionRef: null,
          reviewArtifact: null,
        };
      },
    });

    // One wait plus a full three admitted-and-failed dispatches.
    expect(call).toBe(1 + COHORT_SPECIALIST_ATTEMPTS);
    expect(lanes[0]!.attempts).toBe(COHORT_SPECIALIST_ATTEMPTS);
  });

  it("stops re-queuing after a bounded number of waits, without charging an attempt", async () => {
    const dispatch = vi.fn(
      async (): Promise<CohortDispatchOutcome> => ({
        kind: "queue_admission_timeout",
        message: "no slot",
        engine: "claude",
      }),
    );

    const lanes = await runCohortLanes({
      assignmentIds: ["general"],
      dispatch,
    });

    // Sustained pressure has to terminate — an unbounded re-queue would hang the
    // round forever — but it terminates as an unheard specialist with zero
    // attempts charged, never as a verdict.
    expect(dispatch).toHaveBeenCalledTimes(COHORT_ADMISSION_WAITS);
    expect(lanes[0]!.attempts).toBe(0);
    expect(lanes[0]!.settlement).toMatchObject({
      kind: "infra_exhausted",
      reason: "never_admitted",
    });
  });
});

describe("runCohortLanes: retained lanes", () => {
  it("does not re-dispatch a specialist that already settled", async () => {
    const dispatch = vi.fn(
      async (assignmentId: string): Promise<CohortDispatchOutcome> => ({
        kind: "pass",
        summary: `${assignmentId}: ok`,
        feedback: "Context validation passed.",
        issues: [],
        reopenTaskIds: [],
      }),
    );

    const lanes = await runCohortLanes({
      assignmentIds: ["general", "security-reviewer"],
      retained: { general: pass("general", "general: settled last round") },
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("security-reviewer", 1);
    expect(lanes[0]!.settlement).toMatchObject({
      summary: "general: settled last round",
    });
    expect(lanes.map((lane) => lane.assignmentId)).toEqual([
      "general",
      "security-reviewer",
    ]);
  });

  it("gives an unsettled specialist a fresh attempt budget on every pass", async () => {
    // Only SETTLED lanes are retained, so a lane that comes back to run again
    // starts at zero — which is what makes "resuming resets that round's attempt
    // counters" true without the resume path counting anything itself.
    const dispatch = vi.fn(
      async (): Promise<CohortDispatchOutcome> => ({
        kind: "infra_error",
        reason: "exception",
        message: "still broken",
        engine: "claude",
        sessionRef: null,
        reviewArtifact: null,
      }),
    );

    const lanes = await runCohortLanes({
      assignmentIds: ["general"],
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(COHORT_SPECIALIST_ATTEMPTS);
    expect(lanes[0]!.attempts).toBe(COHORT_SPECIALIST_ATTEMPTS);
  });
});

describe("runCohortLanes: progress reporting", () => {
  it("reports each lane's running and settled states with its attempt count", async () => {
    const progress: CohortLaneProgress[] = [];
    let call = 0;

    await runCohortLanes({
      assignmentIds: ["general"],
      dispatch: async (): Promise<CohortDispatchOutcome> => {
        call += 1;
        if (call === 1) {
          return {
            kind: "infra_error",
            reason: "exception",
            message: "flaky",
            engine: "claude",
            sessionRef: null,
            reviewArtifact: null,
          };
        }
        return {
          kind: "fail",
          summary: "general: no",
          feedback: "Context validation blocked completion.",
          issues: [
            {
              assignmentId: "general",
              taskId: "task-plan-1",
              title: "Missing notes",
              description: "Add them.",
            },
          ],
          reopenTaskIds: ["task-plan-1"],
        };
      },
      onProgress: (update) => progress.push(update),
    });

    // The attempt count has to be observable BEFORE the round ends — it is what
    // survives a reload, and a halt publishes it.
    expect(progress).toEqual([
      { assignmentId: "general", attempts: 0, state: "running" },
      // The infrastructure failure is reported as it happens, with the reason
      // intact: the engine files it as a non-verdict incident rather than
      // inferring one from a rising attempt count.
      {
        assignmentId: "general",
        attempts: 1,
        state: "running",
        infraFailure: {
          reason: "exception",
          message: "flaky",
          engine: "claude",
        },
      },
      { assignmentId: "general", attempts: 1, state: "running" },
      {
        assignmentId: "general",
        attempts: 1,
        state: "verdict_fail",
        summary: "general: no",
        issues: [
          {
            assignmentId: "general",
            taskId: "task-plan-1",
            title: "Missing notes",
            description: "Add them.",
          },
        ],
        // Carried alongside the state change so the write that ACCEPTS the
        // verdict can publish its detail in the same mutation.
        verdict: { pass: false, sessionRef: null, reviewArtifact: null },
      },
    ]);
  });
});
