import { describe, expect, it } from "vitest";
import {
  buildValidationRoundRoster,
  candidateIdentityMatches,
  computeTaskStateHash,
  concludeValidationRound,
  describeCandidateDrift,
  freezeValidationCandidate,
  isValidationRoundOpen,
  openValidationRound,
  reconcileValidationRoster,
} from "./validation-round";
import { makeSeededValidatorAssignment } from "./test-fixtures";
import type {
  GraphWorkflowTaskState,
  GraphWorkflowValidationCandidate,
} from "./schemas";

function taskState(
  overrides: Partial<GraphWorkflowTaskState> & { taskId: string },
): GraphWorkflowTaskState {
  return {
    contextId: "ctx-1",
    order: 1,
    status: "completed",
    summary: "done",
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

function taskStates(
  ...states: GraphWorkflowTaskState[]
): Record<string, GraphWorkflowTaskState> {
  return Object.fromEntries(states.map((state) => [state.taskId, state]));
}

describe("computeTaskStateHash", () => {
  it("binds validation identity to the captured handoff and its schema", () => {
    const input = {
      tree: {
        identityScope: "wholeTree" as const,
        headSha: "head",
        candidateTreeHash: "tree",
      },
      taskStates: taskStates(taskState({ taskId: "t-1" })),
      contextId: "ctx-1",
      outputSchema: { type: "object", required: ["issues"] },
      outputValue: { issues: ["issue-1"] },
    };
    const frozen = freezeValidationCandidate(input);
    expect(
      candidateIdentityMatches(
        frozen,
        freezeValidationCandidate({ ...input, outputValue: { issues: [] } }),
      ),
    ).toBe(false);
    expect(
      candidateIdentityMatches(
        frozen,
        freezeValidationCandidate({
          ...input,
          outputSchema: { type: "object" },
        }),
      ),
    ).toBe(false);
    expect(frozen.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("covers the context's task tuples and moves when one of them changes", () => {
    const before = taskStates(
      taskState({ taskId: "t-1", order: 1 }),
      taskState({ taskId: "t-2", order: 2 }),
    );
    const baseline = computeTaskStateHash(before, "ctx-1");

    expect(
      computeTaskStateHash(
        taskStates(
          taskState({ taskId: "t-1", order: 1 }),
          taskState({ taskId: "t-2", order: 2, summary: "reworked" }),
        ),
        "ctx-1",
      ),
    ).not.toBe(baseline);

    expect(
      computeTaskStateHash(
        taskStates(
          taskState({ taskId: "t-1", order: 1 }),
          taskState({ taskId: "t-2", order: 2, status: "pending" }),
        ),
        "ctx-1",
      ),
    ).not.toBe(baseline);

    // A task the validator would see is a new tuple, so the generation moves.
    expect(
      computeTaskStateHash(
        taskStates(
          taskState({ taskId: "t-1", order: 1 }),
          taskState({ taskId: "t-2", order: 2 }),
          taskState({ taskId: "t-3", order: 3 }),
        ),
        "ctx-1",
      ),
    ).not.toBe(baseline);
  });

  it("is stable across record insertion order", () => {
    const forward = taskStates(
      taskState({ taskId: "t-1", order: 1 }),
      taskState({ taskId: "t-2", order: 2 }),
    );
    const reversed = taskStates(
      taskState({ taskId: "t-2", order: 2 }),
      taskState({ taskId: "t-1", order: 1 }),
    );

    expect(computeTaskStateHash(reversed, "ctx-1")).toBe(
      computeTaskStateHash(forward, "ctx-1"),
    );
  });

  it("ignores tasks belonging to other contexts", () => {
    const own = taskStates(taskState({ taskId: "t-1", order: 1 }));
    const withNeighbour = taskStates(
      taskState({ taskId: "t-1", order: 1 }),
      taskState({ taskId: "t-9", contextId: "ctx-2", order: 1 }),
    );

    expect(computeTaskStateHash(withNeighbour, "ctx-1")).toBe(
      computeTaskStateHash(own, "ctx-1"),
    );
  });
});

describe("openValidationRound", () => {
  const candidate = freezeValidationCandidate({
    tree: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-1",
    },
    taskStates: taskStates(taskState({ taskId: "t-1" })),
    contextId: "ctx-1",
  });

  it("freezes the roster in cohort order with each assignment's delivered identity", () => {
    const assignments = [
      makeSeededValidatorAssignment({
        id: "security-reviewer",
        profile: { tier: "project", id: "security" },
      }),
      makeSeededValidatorAssignment({ id: "general" }),
    ];

    const round = openValidationRound({
      previousRound: null,
      candidate,
      assignments,
      startedAt: "2026-08-04T10:00:00.000Z",
    });

    expect(round.roster.map((entry) => entry.assignmentId)).toEqual([
      "security-reviewer",
      "general",
    ]);
    expect(round.roster[0]).toEqual({
      assignmentId: "security-reviewer",
      profileRef: { tier: "project", id: "security" },
      revision: assignments[0]!.profileSnapshot.revision,
      resolvedInstructionHash:
        assignments[0]!.profileSnapshot.resolvedInstructionHash,
    });
  });

  it("starts every specialist pending in the script phase, before any validator runs", () => {
    const round = openValidationRound({
      previousRound: null,
      candidate,
      assignments: [
        makeSeededValidatorAssignment({ id: "general" }),
        makeSeededValidatorAssignment({ id: "security-reviewer" }),
      ],
      startedAt: "2026-08-04T10:00:00.000Z",
    });

    expect(round.phase).toBe("script");
    expect(round.startedAt).toBe("2026-08-04T10:00:00.000Z");
    expect(round.candidate).toEqual(candidate);
    expect(Object.keys(round.specialists).sort()).toEqual([
      "general",
      "security-reviewer",
    ]);
    for (const specialist of Object.values(round.specialists)) {
      expect(specialist).toEqual({
        state: "pending",
        attempts: 0,
        summary: null,
        issues: [],
        advisories: [],
        questionToken: null,
        sessionRef: null,
        reviewArtifact: null,
        lastInfraFailure: null,
      });
    }
  });

  it("numbers rounds monotonically per context", () => {
    const first = openValidationRound({
      previousRound: null,
      candidate,
      assignments: [makeSeededValidatorAssignment()],
      startedAt: "2026-08-04T10:00:00.000Z",
    });
    const second = openValidationRound({
      previousRound: first,
      candidate,
      assignments: [makeSeededValidatorAssignment()],
      startedAt: "2026-08-04T10:05:00.000Z",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("keeps numbering forward from a round that already concluded", () => {
    // A concluded round is retained precisely so the NEXT round can be told
    // apart from it. If conclusion erased the record, every round would reopen
    // as seq 1 and a stale result would be indistinguishable from a fresh one.
    const concluded = concludeValidationRound(
      openValidationRound({
        previousRound: null,
        candidate,
        assignments: [makeSeededValidatorAssignment()],
        startedAt: "2026-08-04T10:00:00.000Z",
      }),
      "failed",
    );

    expect(concluded.phase).toBe("concluded");
    expect(concluded.outcome).toBe("failed");
    expect(isValidationRoundOpen(concluded)).toBe(false);

    const next = openValidationRound({
      previousRound: concluded,
      candidate,
      assignments: [makeSeededValidatorAssignment()],
      startedAt: "2026-08-04T10:05:00.000Z",
    });
    expect(next.seq).toBe(2);
    expect(isValidationRoundOpen(next)).toBe(true);
  });
});

describe("reconcileValidationRoster", () => {
  const frozen = buildValidationRoundRoster([
    makeSeededValidatorAssignment({ id: "security" }),
    makeSeededValidatorAssignment({ id: "performance" }),
  ]);

  it("resolves the frozen roster back to runnable assignments in roster order", () => {
    // Definition order differs from roster order; the ROSTER decides.
    const result = reconcileValidationRoster(frozen, [
      makeSeededValidatorAssignment({ id: "performance" }),
      makeSeededValidatorAssignment({ id: "security" }),
    ]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.assignments.map((entry) => entry.id)).toEqual([
      "security",
      "performance",
    ]);
  });

  it("reports drift when a rostered assignment is gone", () => {
    const result = reconcileValidationRoster(frozen, [
      makeSeededValidatorAssignment({ id: "security" }),
    ]);

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.detail).toContain("performance");
  });

  it("reports drift when an assignment's delivered instructions changed", () => {
    const edited = makeSeededValidatorAssignment({ id: "performance" });
    const result = reconcileValidationRoster(frozen, [
      makeSeededValidatorAssignment({ id: "security" }),
      {
        ...edited,
        profileSnapshot: {
          ...edited.profileSnapshot,
          resolvedInstructionHash: "rewritten-mid-round",
        },
      },
    ]);

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.detail).toContain("performance");
  });

  it("reports drift when a seat was repointed at a different profile", () => {
    // The delivered text is byte-identical and the revision matches; only WHICH
    // profile the seat names has changed. The roster records the profile that
    // owned the candidate, so dispatching the substitute would make the
    // persisted roster describe a reviewer that never ran.
    const result = reconcileValidationRoster(frozen, [
      makeSeededValidatorAssignment({ id: "security" }),
      makeSeededValidatorAssignment({
        id: "performance",
        profile: { tier: "project", id: "impostor-reviewer" },
      }),
    ]);

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.detail).toContain("performance");
  });

  it("reports drift when the definition added a reviewer after the freeze", () => {
    const result = reconcileValidationRoster(frozen, [
      makeSeededValidatorAssignment({ id: "security" }),
      makeSeededValidatorAssignment({ id: "performance" }),
      makeSeededValidatorAssignment({ id: "late-arrival" }),
    ]);

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.detail).toContain("late-arrival");
  });
});

describe("candidateIdentityMatches", () => {
  const frozen: GraphWorkflowValidationCandidate = {
    identityScope: "wholeTree",
    headSha: "head-1",
    candidateTreeHash: "tree-1",
    taskStateHash: "tasks-1",
  };

  it("accepts an identical identity", () => {
    expect(candidateIdentityMatches(frozen, { ...frozen })).toBe(true);
  });

  it("rejects a move in any of the three components", () => {
    expect(
      candidateIdentityMatches(frozen, { ...frozen, headSha: "head-2" }),
    ).toBe(false);
    expect(
      candidateIdentityMatches(frozen, {
        ...frozen,
        candidateTreeHash: "tree-2",
      }),
    ).toBe(false);
    expect(
      candidateIdentityMatches(frozen, { ...frozen, taskStateHash: "tasks-2" }),
    ).toBe(false);
  });

  it("names the components that moved", () => {
    expect(
      describeCandidateDrift(frozen, {
        identityScope: "wholeTree",
        headSha: "head-2",
        candidateTreeHash: "tree-1",
        taskStateHash: "tasks-2",
      }),
    ).toBe("headSha, taskStateHash");
  });
});

describe("candidateIdentityMatches for an owned-subset candidate", () => {
  const frozen: GraphWorkflowValidationCandidate = {
    identityScope: "owned",
    headSha: "head-1",
    candidateTreeHash: "owned-digest-1",
    taskStateHash: "tasks-1",
  };

  it("accepts an identical identity", () => {
    expect(candidateIdentityMatches(frozen, { ...frozen })).toBe(true);
  });

  it("holds through HEAD movement, because a sibling landing is not this context's change", () => {
    // A concurrent same-lane sibling commits its own owned paths mid-round. HEAD
    // moves; nothing this context owns did. Charging that as drift would make an
    // enveloped context's round un-completable whenever a sibling lands.
    expect(
      candidateIdentityMatches(frozen, { ...frozen, headSha: "head-2" }),
    ).toBe(true);
  });

  it("rejects a move in the owned subset or in the task state", () => {
    expect(
      candidateIdentityMatches(frozen, {
        ...frozen,
        candidateTreeHash: "owned-digest-2",
      }),
    ).toBe(false);
    expect(
      candidateIdentityMatches(frozen, { ...frozen, taskStateHash: "tasks-2" }),
    ).toBe(false);
  });

  it("rejects an observation re-read under a different scope", () => {
    // An owned-subset digest and a whole-tree object id are not comparable, so a
    // scope that changed under the round is drift rather than a value to compare.
    expect(
      candidateIdentityMatches(frozen, {
        ...frozen,
        identityScope: "wholeTree",
      }),
    ).toBe(false);
    expect(
      describeCandidateDrift(frozen, {
        ...frozen,
        identityScope: "wholeTree",
      }),
    ).toBe("identityScope");
  });

  it("never names headSha as drift", () => {
    expect(
      describeCandidateDrift(frozen, {
        ...frozen,
        headSha: "head-2",
        candidateTreeHash: "owned-digest-2",
      }),
    ).toBe("candidateTreeHash");
  });
});

describe("freezeValidationCandidate", () => {
  it("records the scope the identity was read under", () => {
    expect(
      freezeValidationCandidate({
        tree: {
          identityScope: "owned",
          headSha: "head-1",
          candidateTreeHash: "owned-digest-1",
        },
        taskStates: taskStates(taskState({ taskId: "t-1" })),
        contextId: "ctx-1",
      }).identityScope,
    ).toBe("owned");

    expect(
      freezeValidationCandidate({
        tree: {
          identityScope: "wholeTree",
          headSha: "head-1",
          candidateTreeHash: "tree-1",
        },
        taskStates: taskStates(taskState({ taskId: "t-1" })),
        contextId: "ctx-1",
      }).identityScope,
    ).toBe("wholeTree");
  });
});

describe("buildValidationRoundRoster", () => {
  it("preserves cohort order so the roster reads as the authored cohort", () => {
    const roster = buildValidationRoundRoster([
      makeSeededValidatorAssignment({ id: "a-first" }),
      makeSeededValidatorAssignment({ id: "b-second" }),
      makeSeededValidatorAssignment({ id: "c-third" }),
    ]);

    expect(roster.map((entry) => entry.assignmentId)).toEqual([
      "a-first",
      "b-second",
      "c-third",
    ]);
  });
});
