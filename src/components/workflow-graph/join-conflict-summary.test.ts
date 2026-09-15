import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { deriveJoinConflictSummary } from "./join-conflict-summary";

const JOIN_ID = "join_delivery_1";

const JOIN_FAILURE: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: JOIN_ID,
  joinKind: "context_merge",
  contextId: "context-implement",
  sourceLaneIds: ["lane-plan", "lane-implement"],
  targetLaneId: "delivery",
  message: "merge conflict",
  conflictFiles: ["src/checkout/audit.ts"],
};

function joinState(
  overrides: Partial<GraphWorkflowExecutionJoinState> = {},
): GraphWorkflowExecutionJoinState {
  return {
    joinId: JOIN_ID,
    kind: "context_merge",
    contextId: "context-implement",
    targetLaneId: "delivery",
    sourceLaneIds: ["lane-plan", "lane-implement"],
    mergedSourceLaneIds: ["lane-plan"],
    validationDebtSourceLaneIds: [],
    sourceLaneContextIds: {
      "lane-plan": ["context-plan"],
      "lane-implement": ["context-implement"],
    },
    status: "conflicts",
    errorMessage: "both wrote the timeout branch",
    conflicts: {
      files: ["src/checkout/audit.ts"],
      message: "merge conflict",
      analysis: null,
    },
    conflictGuidance: null,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:05:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

/**
 * A halted execution as the engine actually persists one: per-source merge
 * progress lives on `execution.joins[joinId]`, and the CONTEXT states carry no
 * join stamp at all — a context_merge join stamps only the downstream target,
 * and a final_publish join stamps no context.
 */
function executionWithJoin(
  join: GraphWorkflowExecutionJoinState = joinState(),
): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "halted" });
  return {
    ...base,
    joins: { [join.joinId]: join },
    executionLanes: {
      "lane-plan": {
        laneId: "lane-plan",
        kind: "worktree",
        status: "active",
        worktreePath: "/tmp/lane-plan",
        branchName: "wf/lane-plan",
        includedContextIds: ["context-plan"],
        lastCommittingContextId: "context-plan",
        commitSnapshots: [],
        createdAt: "2026-08-21T09:00:00.000Z",
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
      "lane-implement": {
        laneId: "lane-implement",
        kind: "worktree",
        status: "active",
        worktreePath: "/tmp/lane-implement",
        branchName: "wf/lane-implement",
        includedContextIds: ["context-implement"],
        lastCommittingContextId: "context-implement",
        commitSnapshots: [],
        createdAt: "2026-08-21T09:00:00.000Z",
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
    },
  };
}

describe("deriveJoinConflictSummary", () => {
  it("names the target lane, the join and which members merged", () => {
    const summary = deriveJoinConflictSummary(
      executionWithJoin(),
      JOIN_FAILURE,
    );

    expect(summary).not.toBeNull();
    expect(summary?.joinId).toBe(JOIN_ID);
    expect(summary?.laneLabel).toBe("delivery");
    expect(summary?.mergedCount).toBe(1);
    expect(summary?.members).toEqual([
      {
        laneId: "lane-plan",
        contextId: "context-plan",
        title: "Plan",
        status: "merged",
        detail: null,
      },
      {
        laneId: "lane-implement",
        contextId: "context-implement",
        title: "Implement",
        status: "blocked",
        detail: "both wrote the timeout branch",
      },
    ]);
    expect(summary?.blockedMember?.contextId).toBe("context-implement");
    expect(summary?.conflictFiles).toEqual(["src/checkout/audit.ts"]);
  });

  // A blocked LANE can carry several contexts, and every one of them is
  // reported blocked because none of them landed. Only one is actionable
  // though, so the summary has to hand out a single member — the one it names
  // AND the one it navigates to. Two lookups (first-blocked for the sentence,
  // last-committer for the destination) is how a card comes to describe one
  // context while its buttons open another.
  it("names and navigates to the same member when the blocked lane carries several contexts", () => {
    const base = executionWithJoin(
      joinState({
        sourceLaneContextIds: {
          "lane-plan": ["context-plan"],
          "lane-implement": ["context-implement", "context-verify"],
        },
      }),
    );
    const summary = deriveJoinConflictSummary(
      {
        ...base,
        executionLanes: {
          ...base.executionLanes,
          "lane-implement": {
            ...base.executionLanes["lane-implement"]!,
            includedContextIds: ["context-implement", "context-verify"],
            lastCommittingContextId: "context-verify",
          },
        },
      },
      JOIN_FAILURE,
    );

    // Both members of the blocked lane are listed as blocked — the roster is
    // the whole truth about what did not land.
    expect(
      summary?.members
        .filter((member) => member.status === "blocked")
        .map((member) => member.contextId),
    ).toEqual(["context-implement", "context-verify"]);
    // …but exactly one is the subject, and it carries its own title.
    expect(summary?.blockedMember).toEqual({
      laneId: "lane-implement",
      contextId: "context-verify",
      title: "Verify",
      status: "blocked",
      detail: "both wrote the timeout branch",
    });
  });

  // The runner merges sources in order and stops at the first refusal, so only
  // that lane is blocked; the ones behind it were never attempted and must not
  // be reported as failures the operator has to resolve.
  it("blocks only the lane the merge stopped on and leaves the rest pending", () => {
    const summary = deriveJoinConflictSummary(
      executionWithJoin(
        joinState({
          sourceLaneIds: ["lane-plan", "lane-implement", "lane-docs"],
          mergedSourceLaneIds: ["lane-plan"],
          sourceLaneContextIds: {
            "lane-plan": ["context-plan"],
            "lane-implement": ["context-implement"],
            "lane-docs": ["context-review"],
          },
        }),
      ),
      { ...JOIN_FAILURE, sourceLaneIds: ["lane-plan", "lane-implement"] },
    );

    expect(summary?.members.map((member) => member.status)).toEqual([
      "merged",
      "blocked",
      "pending",
    ]);
    expect(summary?.blockedMember?.contextId).toBe("context-implement");
  });

  // The final publish stamps no context and lists the session lane as target;
  // its members still have to be nameable, or the card loses both its roster
  // and its two navigation actions.
  it("derives a final-publish join from its source lanes", () => {
    const summary = deriveJoinConflictSummary(
      executionWithJoin(
        joinState({
          joinId: "join_publish",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "__session__",
          mergedSourceLaneIds: [],
          errorMessage: "pre-merge validation failed",
        }),
      ),
      {
        ...JOIN_FAILURE,
        joinId: "join_publish",
        joinKind: "final_publish",
        contextId: null,
        targetLaneId: "__session__",
      },
    );

    // The lane the card and the gate row NAME, so it is the lane's display
    // name — the same one the band header shows — not the internal id. It is
    // also what the canvas matches a band on, so the raw id would leave a
    // drawn session band unanchored.
    expect(summary?.laneLabel).toBe("session");
    expect(summary?.mergedCount).toBe(0);
    expect(summary?.blockedMember?.contextId).toBe("context-plan");
    expect(summary?.members[0]).toEqual({
      laneId: "lane-plan",
      contextId: "context-plan",
      title: "Plan",
      status: "blocked",
      detail: "pre-merge validation failed",
    });
  });

  it.each([undefined, { "lane-plan": [], "lane-implement": [] }])(
    "reports unknown members when transfer coverage is absent or empty",
    (sourceLaneContextIds) => {
      const summary = deriveJoinConflictSummary(
        executionWithJoin(joinState({ sourceLaneContextIds })),
        JOIN_FAILURE,
      );
      expect(summary?.members.map((member) => member.contextId)).toEqual([
        null,
        null,
      ]);
      expect(summary?.members.map((member) => member.laneId)).toEqual([
        "lane-plan",
        "lane-implement",
      ]);
    },
  );

  // Progress is on the join record, so a halt whose join row is gone can still
  // name the lanes the reason carries — but it must not invent merge outcomes.
  it("lists the halt's source lanes when the join record is missing", () => {
    const base = createWorkflowExecution({ status: "halted" });
    const summary = deriveJoinConflictSummary(base, JOIN_FAILURE);

    expect(summary?.members.map((member) => member.laneId)).toEqual([
      "lane-plan",
      "lane-implement",
    ]);
    expect(summary?.mergedCount).toBe(0);
  });

  it("reports the conflicting files the join recorded over the halt's list", () => {
    const summary = deriveJoinConflictSummary(
      executionWithJoin(
        joinState({
          conflicts: {
            files: ["src/checkout/audit.ts", "src/risk/rules.ts"],
            message: null,
            analysis: null,
          },
        }),
      ),
      { ...JOIN_FAILURE, conflictFiles: [] },
    );

    expect(summary?.conflictFiles).toEqual([
      "src/checkout/audit.ts",
      "src/risk/rules.ts",
    ]);
  });

  it("is null for a halt that is not a join failure", () => {
    expect(
      deriveJoinConflictSummary(createWorkflowExecution(), {
        type: "recovery_error",
        message: "boom",
      }),
    ).toBeNull();
  });
});
