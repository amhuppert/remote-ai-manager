import { createGraphWorkflowGates } from "./engine-composition";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createGraphWorkflowContextServices } from "./engine-composition";
import { createGraphWorkflowManager } from "./workflow-manager";
import { createGraphWorkflowSignalHaltHandler } from "./graph-workflow-signal-halt";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { createPersistenceGraphRepository } from "./testing/persistence-repository-fixture";
import {
  createCohortExecution,
  failResult,
  INFRA_RESULT,
  metadata,
  NOW,
  passResult,
  planDefectResult,
  TREE_A,
} from "./testing/cohort-engine-harness";

const cases = [
  { mode: "review_rejection", failures: 3 },
  { mode: "output_rejection", failures: 3 },
  { mode: "certified", failures: 0 },
  { mode: "infra", failures: 2 },
  { mode: "question", failures: 2 },
  { mode: "plan_defect", failures: 2 },
] as const;

describe("durable context accounting", () => {
  it.each(cases)(
    "settles $mode with its evidence and one accounting decision",
    async ({ mode, failures }) => {
      const fixture = createPersistenceFixture();
      try {
        fixture.seedProject("/repo");
        fixture.seedSession("/repo", "session-1");
        const execution = createCohortExecution({
          assignmentIds: ["general"],
          consecutiveFailureCount: 2,
        });
        const context = execution.workingDefinition.executionContexts.find(
          (entry) => entry.id === "context-plan",
        );
        if (!context) throw new Error("Missing accounting fixture context");
        context.outputSchema = {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        };
        const priorIterations =
          execution.contextStates["context-plan"]?.iterationCount;
        await fixture.store.mutateActiveGraphWorkflowExecution(
          "/repo",
          "session-1",
          "fixture.seed",
          () => ({ kind: "commit", execution, events: [], value: undefined }),
        );
        const repository = createPersistenceGraphRepository(fixture);
        const read = () => {
          const value = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
            "/repo",
            "session-1",
          );
          if (!value) throw new Error("Missing persisted execution");
          return value;
        };
        const eventPublisher = createGraphWorkflowExecutionEventPublisher({
          now: () => NOW,
          broadcast: () => {},
          dispatchPush: () => {},
        });
        const policy = createTestGraphExecutionContract();
        const manager = createGraphWorkflowManager({
          executionRepository: repository,
          executionContract: policy,
          eventPublisher,
          loadDefinition: async () => null,
          getSession: fixture.store.getSession,
          abortConversation: () => {},
          abortExecutionLoop: () => {},
          stopExecutionLaneDevServers: async () => {},
          now: () => NOW,
        });
        const observedBeforeVerdict: number[] = [];
        const { iterationOrchestrator } = createGraphWorkflowContextServices({
          storage: {
            executionRepository: repository,
            eventPublisher,
            findLatestContextValidationEvent: async (
              projectPath,
              sessionName,
              executionId,
              contextId,
            ) =>
              fixture.graphWorkflowEvents.findLatestForContext(
                projectPath,
                sessionName,
                executionId,
                contextId,
                "graph-workflow-validation-result",
              ),
          },
          conversation: {
            continuityService: null,
            createConversation: async () => ({ id: "conversation-output" }),
            runAgentIteration: async () => {
              throw new Error("Completed work must only certify");
            },
            outputCaptureService: {
              captureContextOutput: async () =>
                mode === "output_rejection"
                  ? {
                      kind: "rejected",
                      summary: "Missing summary",
                      issues: [{ title: "$.summary", description: "required" }],
                      rejectedText: "{}",
                    }
                  : {
                      kind: "captured",
                      value: { summary: "Reviewed work" },
                      parse: { source: "native" },
                    },
            },
            advisoryResponseService: {
              runAdvisoryResponse: async () => {
                throw new Error("No advisories in this scenario");
              },
            },
          },
          validation: {
            validationRoundService: {
              resolveCandidateTree: async () => TREE_A,
            },
            scriptValidatorService: {
              runScriptValidator: async () => ({
                kind: "pass",
                treeState: { headSha: "head-1", dirty: true },
                command: "pre-merge",
              }),
            },
            cohort: {
              runContextValidator: async (input) => {
                const state = read().contextStates["context-plan"];
                if (!state) throw new Error("Missing persisted context state");
                observedBeforeVerdict.push(state.consecutiveFailureCount);
                return {
                  result:
                    mode === "review_rejection"
                      ? failResult("general", ["task-plan-1"])
                      : mode === "infra"
                        ? INFRA_RESULT
                        : mode === "plan_defect"
                          ? planDefectResult("general")
                          : mode === "question"
                            ? {
                                kind: "asked_user",
                                conversationId: "conversation-general",
                                questionBatchId: "batch-1",
                                questions: [
                                  {
                                    id: "q1",
                                    question: "Proceed?",
                                    options: [
                                      { label: "Yes", recommended: false },
                                    ],
                                    multiSelect: false,
                                    required: true,
                                    allowNote: true,
                                  },
                                ],
                              }
                            : passResult("general"),
                  metadata: metadata(),
                  roundToken: input.roundToken ?? null,
                };
              },
            },
          },
          policy: {
            ...createGraphWorkflowGates({
              getActive: repository.getActive,
              mutateActive: repository.mutateActive,
              eventPublisher,
              clearConversationQuestion: async () => false,
              now: () => NOW,
            }),
            readRepoConfig,
            readLaneConversation: async () => null,
            createTaskId: () => `task-${randomUUID()}`,
            executionContract: policy,
            signalHalt: createGraphWorkflowSignalHaltHandler(manager),
            materializeWorkflowDocuments: async ({ execution }) => execution,
            now: () => NOW,
          },
        });
        await iterationOrchestrator.runIteration({
          projectPath: "/repo",
          projectName: "repo",
          sessionName: "session-1",
          contextId: "context-plan",
        });
        const persisted = read();
        expect(
          persisted.contextStates["context-plan"]?.consecutiveFailureCount,
        ).toBe(failures);
        expect(observedBeforeVerdict.every((count) => count === 2)).toBe(true);
        expect(observedBeforeVerdict.length > 0).toBe(
          mode !== "output_rejection",
        );
        expect(persisted.contextOutputs["context-plan"] !== undefined).toBe(
          mode === "certified",
        );
        if (mode === "output_rejection") {
          expect(persisted.contextStates["context-plan"]?.iterationCount).toBe(
            (priorIterations ?? 0) + 1,
          );
        }
        const failureEvents = fixture.graphWorkflowEvents
          .findByExecution("/repo", "session-1", execution.id)
          .filter(
            (entry) =>
              entry.event.type === "graph-workflow-validation-result" &&
              !entry.event.pass,
          );
        expect(failureEvents).toHaveLength(
          mode === "review_rejection" || mode === "output_rejection" ? 1 : 0,
        );
      } finally {
        fixture.close();
      }
    },
  );
});
