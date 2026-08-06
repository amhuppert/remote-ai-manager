import { describe, expect, it, vi } from "vitest";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeValidatorAssignment,
  seedAssignment,
} from "./test-fixtures";
import {
  createGraphWorkflowValidationService,
  type GraphWorkflowContextValidatorInput,
} from "./execution-validation";
import type { ValidatorCohort } from "./config-schemas";
import type { ValidatorRunResult } from "./validator-runner";

const SINGLE_ASSIGNMENT_COHORT: ValidatorCohort = {
  enabled: true,
  assignments: [makeValidatorAssignment()],
};

function buildExecutionWithContextValidator(
  cohort: ValidatorCohort = SINGLE_ASSIGNMENT_COHORT,
) {
  const baseDefinition = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: baseDefinition.executionContexts.map((context) =>
      context.id === "context-plan"
        ? {
            ...context,
            acceptanceCriteria:
              "Every task summary is complete and the plan document is updated.",
            contextValidator: {
              ...cohort,
              assignments: cohort.assignments.map((assignment) =>
                seedAssignment(assignment),
              ),
            },
          }
        : context,
    ),
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Inspect code",
        instructions: "Read the relevant files.",
        source: "user",
      },
      {
        id: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        title: "Write plan",
        instructions: "Document the implementation plan.",
        source: "user",
      },
      ...baseDefinition.tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });

  const execution = createWorkflowExecution({
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        totalTaskCount: 2,
        completedTaskCount: 2,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase and documented the current behavior.",
        startedAt: "2026-03-27T16:00:00.000Z",
        completedAt: "2026-03-27T16:05:00.000Z",
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "completed",
        summary: "Drafted the implementation plan and linked the updated doc.",
        startedAt: "2026-03-27T16:05:00.000Z",
        completedAt: "2026-03-27T16:10:00.000Z",
        lastConversationId: "conversation-seed",
        failureMessage: null,
        failureHistory: [],
      },
    },
  });

  return { definition, execution };
}

function emptyMetadata(): ValidatorRunResult["metadata"] {
  return {
    sessionRef: null,
    reviewArtifact: null,
    limitEvaluation: "disabled",
    rotateBeforeNextTurn: false,
  };
}

describe("graph workflow execution validation service", () => {
  it("returns kind=fail with reopened tasks when runner blocks context completion", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "fail",
          summary: "The plan document is still missing key migration notes.",
          issues: [
            {
              taskId: "task-plan-2",
              title: "Plan incomplete",
              description:
                "The migration rollback steps are not documented in the plan.",
            },
          ],
          reopenTaskIds: ["task-plan-2"],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextValidator).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          id: "context-plan",
          acceptanceCriteria:
            "Every task summary is complete and the plan document is updated.",
        }),
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.summary).toBe(
        "The plan document is still missing key migration notes.",
      );
      expect(result.reopenTaskIds).toEqual(["task-plan-2"]);
      expect(result.feedback).toContain(
        "Context validation blocked completion",
      );
      expect(result.feedback).toContain("task-plan-2");
    }
  });

  it("returns kind=pass when runner approves the completed context", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "pass",
          summary: "All acceptance criteria were satisfied.",
          issues: [],
          reopenTaskIds: [],
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.summary).toBe("All acceptance criteria were satisfied.");
      expect(result.reopenTaskIds).toEqual([]);
      expect(result.feedback).toContain("Context validation passed");
    }
  });

  it("exhausts the specialist's attempts before reporting an infrastructure outcome", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "infra_error",
          reason: "exception",
          message: "Codex rate limit exceeded",
          engine: "codex",
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    // One initial dispatch plus two retries against the unchanged candidate.
    expect(runContextValidator).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("infra_exhausted");
    if (result.kind === "infra_exhausted") {
      expect(result.reason).toBe("exception");
      expect(result.message).toBe("Codex rate limit exceeded");
      expect(result.engine).toBe("codex");
      expect(result.attempts).toBe(3);
      expect(result.assignmentId).toBe("general");
    }
  });

  it("propagates kind=asked_user unchanged when the runner reports a pending question", async () => {
    const { execution } = buildExecutionWithContextValidator();
    const questions = [
      {
        id: "q-1",
        question:
          "Should the validator treat the partial migration as passing?",
        options: [
          { label: "Yes", recommended: false },
          { label: "No", recommended: false },
        ],
        multiSelect: false,
        required: true,
        allowNote: true,
      },
    ];
    const runContextValidator = vi.fn(
      async (): Promise<ValidatorRunResult> => ({
        result: {
          kind: "asked_user",
          conversationId: "conversation-validator-1",
          questionBatchId: "batch-validator-1",
          questions,
        },
        metadata: emptyMetadata(),
      }),
    );
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(result.kind).toBe("asked_user");
    if (result.kind === "asked_user") {
      expect(result.parked).toHaveLength(1);
      expect(result.parked[0].conversationId).toBe("conversation-validator-1");
      expect(result.parked[0].questionBatchId).toBe("batch-validator-1");
      expect(result.parked[0].questions).toHaveLength(1);
      expect(result.parked[0].questions[0]!.question).toBe(
        "Should the validator treat the partial migration as passing?",
      );
    }
  });

  it("returns kind=pass with disabled feedback when context validation is not enabled", async () => {
    const execution = createWorkflowExecution();
    const runContextValidator = vi.fn();
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextValidator).not.toHaveBeenCalled();
    expect(result.kind).toBe("pass");
    if (result.kind === "pass") {
      expect(result.reopenTaskIds).toEqual([]);
      expect(result.feedback).toBe("Context validation is not enabled.");
    }
  });

  it("keeps a disabled cohort's dormant assignments out of execution", async () => {
    const { execution } = buildExecutionWithContextValidator({
      enabled: false,
      assignments: [
        makeValidatorAssignment({ id: "security" }),
        makeValidatorAssignment({ id: "performance" }),
      ],
    });
    const runContextValidator = vi.fn();
    const service = createGraphWorkflowValidationService({
      runContextValidator,
    });

    const result = await service.validateContextCompletion({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
    });

    expect(runContextValidator).not.toHaveBeenCalled();
    expect(result.kind).toBe("pass");
  });

  describe("cohort execution", () => {
    function threeSpecialistCohort(): ValidatorCohort {
      return {
        enabled: true,
        assignments: [
          makeValidatorAssignment({
            id: "security",
            focus: "auth boundaries",
          }),
          makeValidatorAssignment({
            id: "performance",
            strategy: "task",
            agent: {
              backend: "codex",
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
            },
            continuity: { enabled: false },
          }),
          makeValidatorAssignment({ id: "docs" }),
        ],
      };
    }

    function passingRun(summary: string): ValidatorRunResult {
      return {
        result: { kind: "pass", summary, issues: [], reopenTaskIds: [] },
        metadata: emptyMetadata(),
      };
    }

    it("runs every assignment in cohort order and passes only when all pass", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const runContextValidator = vi.fn(
        async (input: {
          validator: { id: string };
        }): Promise<ValidatorRunResult> =>
          passingRun(`${input.validator.id} found nothing blocking.`),
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(
        runContextValidator.mock.calls.map(([input]) => input.validator),
      ).toEqual([
        expect.objectContaining({
          id: "security",
          focus: "auth boundaries",
          strategy: "conversation",
        }),
        expect.objectContaining({
          id: "performance",
          strategy: "task",
          agent: {
            backend: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          continuity: { enabled: false },
        }),
        expect.objectContaining({ id: "docs" }),
      ]);
      expect(result.kind).toBe("pass");
      if (result.kind === "pass") {
        expect(result.summary).toContain("security");
        expect(result.summary).toContain("performance");
        expect(result.summary).toContain("docs");
      }
    });

    it("runs every specialist and blocks completion on the one that rejected, attributing its findings", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const runContextValidator = vi.fn(
        async (input: {
          validator: { id: string };
        }): Promise<ValidatorRunResult> => {
          if (input.validator.id !== "performance") {
            return passingRun(`${input.validator.id} approved.`);
          }
          return {
            result: {
              kind: "fail",
              summary: "The plan document skips the hot-path budget.",
              issues: [
                {
                  taskId: "task-plan-2",
                  title: "Missing budget",
                  description: "No latency budget is recorded.",
                },
              ],
              reopenTaskIds: ["task-plan-2"],
            },
            metadata: emptyMetadata(),
          };
        },
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      // Every specialist reviews the same frozen candidate — there is no
      // cohort-internal short circuit, so `docs` runs even though `performance`
      // has already rejected.
      expect(
        runContextValidator.mock.calls.map(([input]) => input.validator.id),
      ).toEqual(["security", "performance", "docs"]);
      expect(result.kind).toBe("fail");
      if (result.kind === "fail") {
        expect(result.summary).toContain("performance");
        expect(result.summary).toContain(
          "The plan document skips the hot-path budget.",
        );
        expect(result.reopenTaskIds).toEqual(["task-plan-2"]);
      }
    });

    it("stops the cohort on an infra error instead of reporting a verdict", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const runContextValidator = vi.fn(
        async (input: {
          validator: { id: string };
        }): Promise<ValidatorRunResult> => {
          if (input.validator.id !== "performance") {
            return passingRun(`${input.validator.id} approved.`);
          }
          return {
            result: {
              kind: "infra_error",
              reason: "exception",
              message: "Codex rate limit exceeded",
              engine: "codex",
            },
            metadata: emptyMetadata(),
          };
        },
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      // The affected lane retries alone; its siblings ran once each and their
      // verdicts stand, so the round ends unconcluded on the unheard specialist
      // rather than on a verdict nobody rendered.
      const dispatched = runContextValidator.mock.calls.map(
        ([input]) => input.validator.id,
      );
      expect(dispatched.filter((id) => id === "security")).toHaveLength(1);
      expect(dispatched.filter((id) => id === "docs")).toHaveLength(1);
      expect(dispatched.filter((id) => id === "performance")).toHaveLength(3);
      expect(result.kind).toBe("infra_exhausted");
      if (result.kind === "infra_exhausted") {
        expect(result.engine).toBe("codex");
        expect(result.assignmentId).toBe("performance");
        expect(result.attempts).toBe(3);
      }
    });

    it("parks the cohort when an assignment asks the user a question", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const runContextValidator = vi.fn(
        async (input: {
          validator: { id: string };
        }): Promise<ValidatorRunResult> => {
          if (input.validator.id !== "security") {
            return passingRun(`${input.validator.id} approved.`);
          }
          return {
            result: {
              kind: "asked_user",
              conversationId: "conversation-security",
              questionBatchId: "batch-security",
              questions: [
                {
                  id: "q-1",
                  question: "Is the legacy token path in scope?",
                  options: [
                    { label: "Yes", recommended: false },
                    { label: "No", recommended: false },
                  ],
                  multiSelect: false,
                  required: true,
                  allowNote: true,
                },
              ],
            },
            metadata: emptyMetadata(),
          };
        },
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      // Questions are per-lane: a parked specialist does not stop its siblings,
      // which all started at the same time and reviewed the same candidate. The
      // round simply cannot conclude while one of them has not reported.
      expect(
        runContextValidator.mock.calls.map(([input]) => input.validator.id),
      ).toEqual(["security", "performance", "docs"]);
      expect(result.kind).toBe("asked_user");
      if (result.kind === "asked_user") {
        expect(result.parked[0].conversationId).toBe("conversation-security");
      }
    });

    it("attributes every finding to the specialist that raised it, whatever the validator wrote", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      // Two specialists word one objection identically — nothing in the text
      // says who found it. Attribution has to be stamped by the engine at the
      // one point that knows: the dispatch that ran the assignment.
      const runContextValidator = vi.fn(
        async (input: {
          validator: { id: string };
        }): Promise<ValidatorRunResult> => {
          if (input.validator.id === "docs") {
            return passingRun("docs approved.");
          }
          return {
            result: {
              kind: "fail",
              summary: "The rollback path is undocumented.",
              issues: [
                {
                  taskId: "task-plan-2",
                  title: "Undocumented rollback",
                  description: "The rollback path is undocumented.",
                },
              ],
              reopenTaskIds: ["task-plan-2"],
            },
            metadata: emptyMetadata(),
          };
        },
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(result.kind).toBe("fail");
      if (result.kind !== "fail") return;
      expect(result.issues).toEqual([
        {
          assignmentId: "security",
          taskId: "task-plan-2",
          title: "Undocumented rollback",
          description: "The rollback path is undocumented.",
        },
        {
          assignmentId: "performance",
          taskId: "task-plan-2",
          title: "Undocumented rollback",
          description: "The rollback path is undocumented.",
        },
      ]);
      expect(result.reopenTaskIds).toEqual(["task-plan-2"]);
    });

    it("stamps a lone reviewer's findings too, so attribution never depends on cohort size", async () => {
      const { execution } = buildExecutionWithContextValidator();
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (): Promise<ValidatorRunResult> => ({
          result: {
            kind: "fail",
            summary: "The plan skips the migration notes.",
            issues: [
              {
                taskId: "task-plan-2",
                title: "Missing migration notes",
                description: "Document the migration.",
              },
            ],
            reopenTaskIds: ["task-plan-2"],
          },
          metadata: emptyMetadata(),
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(result.kind).toBe("fail");
      if (result.kind !== "fail") return;
      expect(result.issues[0]).toMatchObject({ assignmentId: "general" });
      // The seeded single-reviewer default still reads exactly as it did before
      // cohorts existed: only the structured attribution is added.
      expect(result.summary).toBe("The plan skips the migration notes.");
    });

    it("reports every parked lane, in cohort order", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (input): Promise<ValidatorRunResult> => {
          if (input.validator.id === "docs") {
            return passingRun("docs approved.");
          }
          return {
            result: {
              kind: "asked_user",
              conversationId: `conversation-${input.validator.id}`,
              questionBatchId: `batch-${input.validator.id}`,
              questions: [],
            },
            metadata: emptyMetadata(),
          };
        },
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(result.kind).toBe("asked_user");
      if (result.kind !== "asked_user") return;
      // Both askers are named. Reporting only the first would strand the
      // second's question with nothing downstream able to route its answer.
      expect(
        result.parked.map((lane) => [lane.assignmentId, lane.questionBatchId]),
      ).toEqual([
        ["security", "batch-security"],
        ["performance", "batch-performance"],
      ]);
    });

    it("delivers an answer block only to the lane that parked on that batch", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const context = execution.workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      );
      const assignments = context?.contextValidator.assignments ?? [];
      const answered: Record<string, boolean> = {};
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (input): Promise<ValidatorRunResult> => {
          answered[input.validator.id] = input.resumeUserInput !== undefined;
          return {
            result: {
              kind: "pass",
              summary: `${input.validator.id} approved.`,
              issues: [],
              reopenTaskIds: [],
            },
            metadata: emptyMetadata(),
            roundToken: input.roundToken ?? null,
          };
        },
      });

      await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        resumeUserInputs: [
          {
            // `performance` is the lane that asked; the others never saw the
            // question and must not be handed its answers.
            laneKey: "context_validator:performance",
            lane: "context_validator",
            answers: {},
            questionBatchId: "batch-performance",
            conversationId: "conversation-performance",
          },
        ],
        round: {
          seq: 1,
          candidate: {
            headSha: "head-1",
            candidateTreeHash: "tree-a",
            taskStateHash: "tasks-a",
          },
          assignments,
        },
      });

      expect(answered).toEqual({
        security: false,
        performance: true,
        docs: false,
      });
    });
  });

  describe("round candidate identity", () => {
    function threeSpecialistCohort(): ValidatorCohort {
      return {
        enabled: true,
        assignments: [
          makeValidatorAssignment({ id: "security" }),
          makeValidatorAssignment({ id: "performance" }),
        ],
      };
    }

    it("rejects a specialist result whose candidate moved, without mapping it to a verdict", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const runContextValidator = vi.fn(
        async (): Promise<ValidatorRunResult> => ({
          result: {
            kind: "fail",
            summary: "Rollback notes are missing.",
            issues: [
              {
                taskId: "task-plan-2",
                title: "Missing rollback notes",
                description: "Add rollback guidance.",
              },
            ],
            reopenTaskIds: ["task-plan-2"],
          },
          metadata: emptyMetadata(),
        }),
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator,
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        verifyCandidate: async () => false,
      });

      // The runner's own verdict was a `fail`. It must NOT survive as one: the
      // work it judged no longer exists, so the round reports an identity
      // mismatch and the engine records nothing.
      expect(result).toEqual({
        kind: "candidate_mismatch",
        stage: "specialist_result",
        assignmentId: "security",
        // The tree genuinely moved, as opposed to the result belonging to a
        // round that is over — the incident vocabulary distinguishes them.
        reason: "candidate_moved",
      });
      // Both specialists had already started — they are dispatched together —
      // and both results were discarded. A mismatch is reported once for the
      // round, naming the first specialist in cohort order.
      expect(runContextValidator).toHaveBeenCalledTimes(2);
    });

    it("accepts results normally when the candidate held", async () => {
      const { execution } = buildExecutionWithContextValidator(
        threeSpecialistCohort(),
      );
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (input) => ({
          result: {
            kind: "pass",
            summary: `${input.validator.id} approved.`,
            issues: [],
            reopenTaskIds: [],
          },
          metadata: emptyMetadata(),
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        verifyCandidate: async () => true,
      });

      expect(result.kind).toBe("pass");
    });
  });

  describe("round common inputs", () => {
    function twoSpecialistCohort(): ValidatorCohort {
      return {
        enabled: true,
        assignments: [
          makeValidatorAssignment({ id: "security" }),
          makeValidatorAssignment({ id: "performance" }),
        ],
      };
    }

    it("renders the shared inputs once per round and hands every specialist the same bytes", async () => {
      const { execution } = buildExecutionWithContextValidator(
        twoSpecialistCohort(),
      );

      // A renderer that would produce DIFFERENT bytes on a second call. If the
      // service re-derived per specialist, the two members of this round would
      // see different pictures of the same candidate — which is exactly the
      // failure a once-per-round rendering rules out.
      let renderCount = 0;
      const renderRoundCommonSections = vi.fn(async () => {
        renderCount += 1;
        return {
          diffScopeSection: `## Changes under review (probe ${renderCount})`,
          candidateTreeHash: null,
        };
      });

      const received: (string | undefined)[] = [];
      const service = createGraphWorkflowValidationService({
        renderRoundCommonSections,
        runContextValidator: async (input) => {
          received.push(input.roundCommonSections?.diffScopeSection);
          return {
            result: {
              kind: "pass",
              summary: `${input.validator.id} approved.`,
              issues: [],
              reopenTaskIds: [],
            },
            metadata: emptyMetadata(),
          };
        },
      });

      await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(renderRoundCommonSections).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(2);
      expect(received[0]).toBe("## Changes under review (probe 1)");
      expect(received[1]).toBe(received[0]);
    });

    it("renders nothing extra when no round renderer is wired", async () => {
      const { execution } = buildExecutionWithContextValidator(
        twoSpecialistCohort(),
      );
      const received: (unknown | undefined)[] = [];
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (input) => {
          received.push(input.roundCommonSections);
          return {
            result: {
              kind: "pass",
              summary: "ok",
              issues: [],
              reopenTaskIds: [],
            },
            metadata: emptyMetadata(),
          };
        },
      });

      await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
      });

      expect(received).toEqual([undefined, undefined]);
    });
  });

  describe("the frozen round governs dispatch", () => {
    const FROZEN_CANDIDATE = {
      headSha: "head-1",
      candidateTreeHash: "tree-frozen",
      taskStateHash: "tasks-1",
    };

    function roundOf(
      assignmentIds: string[],
      overrides: { seq?: number } = {},
    ) {
      return {
        seq: overrides.seq ?? 4,
        candidate: FROZEN_CANDIDATE,
        assignments: assignmentIds.map((id) =>
          seedAssignment(makeValidatorAssignment({ id })),
        ),
      };
    }

    function passingRunner(seen: string[]) {
      return async (
        input: GraphWorkflowContextValidatorInput,
      ): Promise<ValidatorRunResult> => {
        seen.push(input.validator.id);
        return {
          result: {
            kind: "pass",
            summary: `${input.validator.id} approved.`,
            issues: [],
            reopenTaskIds: [],
          },
          metadata: emptyMetadata(),
          roundToken: input.roundToken ?? null,
        };
      };
    }

    it("dispatches the roster frozen at round start, not the cohort the definition now declares", async () => {
      // The definition changed after the freeze — a live config edit mid-round.
      // The round owns the candidate, so the round's roster is who reviews it.
      const { execution } = buildExecutionWithContextValidator({
        enabled: true,
        assignments: [makeValidatorAssignment({ id: "swapped-in" })],
      });
      const seen: string[] = [];
      const service = createGraphWorkflowValidationService({
        runContextValidator: passingRunner(seen),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        round: roundOf(["security", "performance"]),
      });

      expect(result.kind).toBe("pass");
      expect(seen).toEqual(["security", "performance"]);
    });

    it("stamps every dispatch with the round's (seq, candidate) token", async () => {
      const { execution } = buildExecutionWithContextValidator();
      const tokens: unknown[] = [];
      const service = createGraphWorkflowValidationService({
        runContextValidator: async (input) => {
          tokens.push(input.roundToken);
          return {
            result: {
              kind: "pass",
              summary: "ok",
              issues: [],
              reopenTaskIds: [],
            },
            metadata: emptyMetadata(),
            roundToken: input.roundToken ?? null,
          };
        },
      });

      await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        round: roundOf(["security"], { seq: 7 }),
      });

      expect(tokens).toEqual([{ seq: 7, candidate: FROZEN_CANDIDATE }]);
    });

    it("rejects a result carrying an older round's token, even when the tree looks unchanged", async () => {
      // The stale-result case the worktree re-probe cannot catch: round 6's
      // verdict arrives during round 7 against an identical candidate. Only the
      // token tells them apart, so the token is what decides.
      const { execution } = buildExecutionWithContextValidator();
      const service = createGraphWorkflowValidationService({
        runContextValidator: async () => ({
          result: {
            kind: "fail",
            summary: "Rollback notes are missing.",
            issues: [
              {
                taskId: "task-plan-2",
                title: "Missing rollback notes",
                description: "Add rollback guidance.",
              },
            ],
            reopenTaskIds: ["task-plan-2"],
          },
          metadata: emptyMetadata(),
          roundToken: { seq: 6, candidate: FROZEN_CANDIDATE },
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        // The worktree still holds the frozen candidate — the only difference
        // is which round the result belongs to.
        verifyCandidate: async () => true,
        round: roundOf(["security"], { seq: 7 }),
      });

      expect(result).toEqual({
        kind: "candidate_mismatch",
        stage: "specialist_result",
        assignmentId: "security",
        // Nothing moved: the answer simply belongs to a round that is over.
        reason: "stale_round_token",
      });
    });

    it("rejects a result carrying the right seq but a different candidate", async () => {
      const { execution } = buildExecutionWithContextValidator();
      const service = createGraphWorkflowValidationService({
        runContextValidator: async () => ({
          result: {
            kind: "pass",
            summary: "ok",
            issues: [],
            reopenTaskIds: [],
          },
          metadata: emptyMetadata(),
          roundToken: {
            seq: 7,
            candidate: { ...FROZEN_CANDIDATE, candidateTreeHash: "tree-other" },
          },
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        verifyCandidate: async () => true,
        round: roundOf(["security"], { seq: 7 }),
      });

      expect(result.kind).toBe("candidate_mismatch");
    });

    it("launches nobody when the shared diff was rendered from a different tree", async () => {
      // The rendered patch IS what the specialists review. If it came from a
      // tree other than the frozen candidate, the round cannot certify the
      // frozen one, so it concludes before a single validator is spent.
      const { execution } = buildExecutionWithContextValidator();
      const runContextValidator = vi.fn(async () => ({
        result: {
          kind: "pass" as const,
          summary: "ok",
          issues: [],
          reopenTaskIds: [],
        },
        metadata: emptyMetadata(),
        roundToken: null,
      }));
      const service = createGraphWorkflowValidationService({
        runContextValidator,
        renderRoundCommonSections: async () => ({
          diffScopeSection: "## Changes Under Review",
          candidateTreeHash: "tree-moved",
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        round: roundOf(["security"]),
      });

      expect(result).toEqual({
        kind: "candidate_mismatch",
        stage: "diff_render",
        assignmentId: null,
        // The tree the reviewers WOULD have read, so the incident an operator
        // sees names the divergence instead of reporting an empty one — a
        // worktree re-probe cannot recover it, since by then the render is over.
        observedTreeHash: "tree-moved",
      });
      expect(runContextValidator).not.toHaveBeenCalled();
    });

    it("launches nobody when the shared diff could not be read at all", async () => {
      const { execution } = buildExecutionWithContextValidator();
      const runContextValidator = vi.fn(async () => ({
        result: {
          kind: "pass" as const,
          summary: "ok",
          issues: [],
          reopenTaskIds: [],
        },
        metadata: emptyMetadata(),
        roundToken: null,
      }));
      const service = createGraphWorkflowValidationService({
        runContextValidator,
        renderRoundCommonSections: async () => ({
          diffScopeSection: "## Changes Under Review\n\nDiff scope unavailable",
          candidateTreeHash: null,
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        round: roundOf(["security"]),
      });

      expect(result.kind).toBe("candidate_mismatch");
      expect(runContextValidator).not.toHaveBeenCalled();
    });

    it("proceeds when the rendered diff came from the frozen tree", async () => {
      const { execution } = buildExecutionWithContextValidator();
      const seen: string[] = [];
      const service = createGraphWorkflowValidationService({
        runContextValidator: passingRunner(seen),
        renderRoundCommonSections: async () => ({
          diffScopeSection: "## Changes Under Review",
          candidateTreeHash: "tree-frozen",
        }),
      });

      const result = await service.validateContextCompletion({
        projectPath: "/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        round: roundOf(["security"]),
      });

      expect(result.kind).toBe("pass");
      expect(seen).toEqual(["security"]);
    });
  });
});
