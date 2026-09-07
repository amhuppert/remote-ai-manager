import { describe, expect, it } from "vitest";
import type { ContextDecision } from "./context-outcome";
import { changed } from "./execution-mutation";
import {
  createCohortExecution,
  createHarness,
  metadata,
  NOW,
  passResult,
  planDefectResult,
  TREE_A,
} from "./testing/cohort-engine-harness";

const cases: Array<{
  scenario:
    | "approval"
    | "question"
    | "fast_answer"
    | "collaboration"
    | "drift"
    | "stale_result"
    | "superseded"
    | "halt"
    | "stopped"
    | "certified";
  expected: Partial<ContextDecision>;
}> = [
  { scenario: "approval", expected: { kind: "await_approval" } },
  { scenario: "question", expected: { kind: "await_user_input" } },
  {
    scenario: "fast_answer",
    expected: {
      kind: "deliver_validator_answers",
      laneKeys: ["context_validator:general"],
    },
  },
  {
    scenario: "collaboration",
    expected: { kind: "await_collaboration", workflowId: "collaboration-1" },
  },
  { scenario: "drift", expected: { kind: "yield", reason: "rescheduled" } },
  {
    scenario: "stale_result",
    expected: { kind: "yield", reason: "rescheduled" },
  },
  { scenario: "superseded", expected: { kind: "yield", reason: "superseded" } },
  { scenario: "halt", expected: { kind: "halted" } },
  { scenario: "stopped", expected: { kind: "execution_stopped" } },
  { scenario: "certified", expected: { kind: "ready_to_land" } },
];

const questions = [
  {
    id: "q1",
    question: "Proceed?",
    options: [{ label: "Yes", recommended: false }],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

describe("context decisions from certification and finalization", () => {
  it.each(cases)(
    "returns the owning decision for $scenario",
    async ({ scenario, expected }) => {
      const execution = createCohortExecution({
        assignmentIds: ["general"],
        consecutiveFailureCount: 0,
      });
      const context = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      );
      if (!context) throw new Error("Missing context fixture");
      context.humanApprovalGate.enabled = scenario === "approval";
      let probes = 0;
      const harness = createHarness({
        execution,
        productionSignalHalt: true,
        resolveCandidateTree: () => {
          probes += 1;
          return scenario === "drift" && probes > 1
            ? {
                kind: "resolved",
                identityScope: "wholeTree",
                headSha: "head-1",
                candidateTreeHash: "tree-moved",
              }
            : TREE_A;
        },
        runContextValidator: async (input) => {
          if (
            ["superseded", "stopped", "collaboration", "fast_answer"].includes(
              scenario,
            )
          ) {
            await harness.repository.mutateActive(
              "/repo",
              "session-1",
              (latest) => {
                const state = latest.contextStates["context-plan"];
                if (!state) throw new Error("Missing context state");
                if (scenario === "superseded") state.status = "ready";
                if (scenario === "stopped") latest.status = "paused";
                if (scenario === "collaboration") {
                  latest.pendingCollaborations["context-plan"] = {
                    workflowId: "collaboration-1",
                    contextId: "context-plan",
                    conversationId: "conversation-1",
                    parentImplementerTurnId: "turn-1",
                    brief: "Resolve the implementation choice",
                    startedAt: NOW,
                  };
                }
                if (scenario === "fast_answer") {
                  state.pendingUserInputs["context_validator:general"] = {
                    conversationId: "conversation-general",
                    lane: "context_validator",
                    questionBatchId: "batch-1",
                    questions,
                    requestedAt: NOW,
                    roundSeq: state.validationRound?.seq ?? null,
                    answers: {
                      byQuestionId: {
                        q1: {
                          selected: ["Yes"],
                          note: null,
                          skipped: false,
                          question: "Proceed?",
                        },
                      },
                      answeredAt: NOW,
                    },
                  };
                }
                return changed(latest);
              },
            );
          }
          return {
            result:
              scenario === "question" || scenario === "fast_answer"
                ? {
                    kind: "asked_user",
                    conversationId: "conversation-general",
                    questionBatchId: "batch-1",
                    questions,
                  }
                : scenario === "halt"
                  ? planDefectResult("general")
                  : passResult("general"),
            metadata: metadata(),
            roundToken:
              scenario === "stale_result" ? null : (input.roundToken ?? null),
          };
        },
      });
      const result = await harness.run();
      expect(result.decision).toMatchObject(expected);
      if (
        scenario === "question" ||
        scenario === "fast_answer" ||
        scenario === "halt"
      ) {
        expect(harness.contextState()?.validationRound?.phase).toBe(
          "specialists",
        );
        expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
      }
      if (
        scenario === "drift" ||
        scenario === "stale_result" ||
        scenario === "superseded"
      ) {
        expect(harness.contextState()?.status).toBe("ready");
      }
    },
  );
});
