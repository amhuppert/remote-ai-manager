import { describe, expect, it } from "vitest";
import type { GraphWorkflowValidationIncidentEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowValidationRound } from "@/lib/workflow-graph/schemas";
import { deriveCohortRoundView } from "./cohort-round-view";

function round(
  overrides: Partial<GraphWorkflowValidationRound> = {},
): GraphWorkflowValidationRound {
  return {
    seq: 2,
    candidate: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "tree-1",
      taskStateHash: "tasks-1",
    },
    roster: [
      {
        assignmentId: "general",
        profileRef: { tier: "builtin", id: "general-reviewer" },
        revision: 1,
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
        strategy: "conversation",
      },
      {
        assignmentId: "security",
        profileRef: { tier: "project", id: "security-reviewer" },
        revision: 4,
        resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
        strategy: "task",
      },
    ],
    specialists: {
      general: {
        state: "verdict_pass",
        attempts: 1,
        summary: "Fine.",
        issues: [],
        advisories: [],
        questionToken: null,
        sessionRef: null,
        reviewArtifact: null,
        lastInfraFailure: null,
      },
    },
    phase: "specialists",
    outcome: null,
    startedAt: "2026-03-27T10:00:00.000Z",
    ...overrides,
  };
}

function incident(
  overrides: Partial<GraphWorkflowValidationIncidentEvent> = {},
): GraphWorkflowValidationIncidentEvent & { occurredAt: string } {
  return {
    occurredAt: "2026-03-27T10:01:00.000Z",
    type: "graph-workflow-validation-incident",
    projectName: "project",
    sessionName: "session",
    executionId: "execution-1",
    contextId: "context-plan",
    incident: "infra_failure",
    roundSeq: 2,
    stage: "specialist_result",
    assignmentId: "security",
    attempts: 1,
    driftedComponents: "",
    message: "Lane crashed",
    ...overrides,
  };
}

describe("deriveCohortRoundView", () => {
  it("returns nothing for a context that has never opened a round", () => {
    expect(deriveCohortRoundView({ round: null, incidents: [] })).toBeNull();
    expect(
      deriveCohortRoundView({ round: undefined, incidents: [] }),
    ).toBeNull();
  });

  it("lists a frozen seat the round never dispatched instead of dropping it", () => {
    const view = deriveCohortRoundView({ round: round(), incidents: [] });

    // The undispatched seat still has to pass for the round to conclude, so
    // hiding it would understate what the context is waiting on.
    expect(view?.members.map((member) => member.assignmentId)).toEqual([
      "general",
      "security",
    ]);
    const security = view?.members[1];
    expect(security?.state).toBe("pending");
    expect(security?.outcomeKind).toBe("open");
    expect(security?.profileLabel).toBe("project:security-reviewer@4");
  });

  it("keeps another round's incidents off this round's record", () => {
    const view = deriveCohortRoundView({
      round: round(),
      incidents: [
        incident({ message: "This round" }),
        incident({ roundSeq: 1, message: "A previous round" }),
      ],
    });

    expect(view?.incidents.map((entry) => entry.message)).toEqual([
      "This round",
    ]);
  });

  it("separates an infrastructure conclusion from a semantic one", () => {
    expect(
      deriveCohortRoundView({
        round: round({ phase: "concluded", outcome: "failed" }),
        incidents: [],
      }),
    ).toMatchObject({
      aggregateKind: "semantic",
      aggregateLabel: "Cohort rejected",
    });

    expect(
      deriveCohortRoundView({
        round: round({ phase: "concluded", outcome: "roster_drift" }),
        incidents: [],
      }),
    ).toMatchObject({
      aggregateKind: "infrastructure",
      aggregateLabel: "Cohort roster drifted mid-round",
    });

    // A script-gate refusal IS a judgement of the candidate, not an accident
    // that happened to the round.
    expect(
      deriveCohortRoundView({
        round: round({ phase: "concluded", outcome: "script_failed" }),
        incidents: [],
      }),
    ).toMatchObject({ aggregateKind: "semantic" });
  });
});
