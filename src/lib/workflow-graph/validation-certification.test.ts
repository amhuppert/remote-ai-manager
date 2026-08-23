import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "./schemas";
import { createWorkflowExecution } from "./test-fixtures";
import {
  findValidationCertificationDebt,
  validationCertification,
} from "./validation-certification";

const CONTEXT_ID = "context-plan";
const NOW = "2026-08-22T12:00:00.000Z";

function singleContextExecution(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  execution.workingDefinition.executionContexts =
    execution.workingDefinition.executionContexts.filter(
      (context) => context.id === CONTEXT_ID,
    );
  execution.workingDefinition.tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === CONTEXT_ID,
  );
  execution.workingDefinition.edges = [];
  execution.contextStates = {
    [CONTEXT_ID]: execution.contextStates[CONTEXT_ID]!,
  };
  execution.taskStates = Object.fromEntries(
    Object.entries(execution.taskStates).filter(
      ([, task]) => task.contextId === CONTEXT_ID,
    ),
  );
  execution.contextStates[CONTEXT_ID]!.status = "completed";
  execution.contextStates[CONTEXT_ID]!.completedTaskCount =
    execution.contextStates[CONTEXT_ID]!.totalTaskCount;
  return execution;
}

function round(
  phase: GraphWorkflowValidationRound["phase"],
  outcome: GraphWorkflowValidationRound["outcome"],
): GraphWorkflowValidationRound {
  return {
    seq: 3,
    candidate: {
      headSha: "head",
      candidateTreeHash: "tree",
      taskStateHash: "tasks",
      identityScope: "wholeTree",
    },
    roster: [],
    specialists: {},
    phase,
    outcome,
    startedAt: NOW,
  };
}

describe("validation certification", () => {
  it("does not require a round when both validator surfaces are disabled", () => {
    const execution = singleContextExecution();

    expect(validationCertification(execution, CONTEXT_ID)).toEqual({
      status: "not_required",
    });
    expect(findValidationCertificationDebt(execution)).toEqual([]);
  });

  it("classifies an absent required round as debt", () => {
    const execution = singleContextExecution();
    execution.workingDefinition.executionContexts[0]!.scriptValidator = {
      commands: ["test"],
    };

    expect(validationCertification(execution, CONTEXT_ID)).toEqual({
      status: "owed",
      reason: "round_absent",
      round: null,
    });
    expect(findValidationCertificationDebt(execution)).toEqual([
      {
        contextId: CONTEXT_ID,
        certification: {
          status: "owed",
          reason: "round_absent",
          round: null,
        },
      },
    ]);
  });

  it.each(["script", "specialists"] as const)(
    "classifies an open %s round as debt",
    (phase) => {
      const execution = singleContextExecution();
      execution.workingDefinition.executionContexts[0]!.contextValidator = {
        enabled: true,
        assignments: [],
      };
      execution.contextStates[CONTEXT_ID]!.validationRound = round(phase, null);

      expect(validationCertification(execution, CONTEXT_ID)).toEqual({
        status: "owed",
        reason: "round_open",
        round: { seq: 3, phase, outcome: null },
      });
    },
  );

  it("distinguishes a concluded non-pass from a passing certification", () => {
    const execution = singleContextExecution();
    execution.workingDefinition.executionContexts[0]!.scriptValidator = {
      commands: ["test"],
    };
    execution.contextStates[CONTEXT_ID]!.validationRound = round(
      "concluded",
      null,
    );

    expect(validationCertification(execution, CONTEXT_ID)).toEqual({
      status: "owed",
      reason: "round_concluded_without_pass",
      round: { seq: 3, phase: "concluded", outcome: null },
    });

    execution.contextStates[CONTEXT_ID]!.validationRound!.outcome = "passed";
    expect(validationCertification(execution, CONTEXT_ID)).toEqual({
      status: "passed",
      roundSeq: 3,
    });
    expect(findValidationCertificationDebt(execution)).toEqual([]);
  });
});
