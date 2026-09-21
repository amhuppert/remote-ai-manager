import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";
import { createMockBackendRuntime } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createWorkflowExecution, seedAssignment } from "./test-fixtures";
import { createValidatorCohortRunner } from "./validator-cohort-runner";
import { createValidatorRunner } from "./validator-runner";
import {
  createGraphLaneContinuity,
  type GraphLaneContinuityDeps,
} from "./lane-continuity";
import { createGraphLaneStore } from "./graph-lane-store";
import { applyFixtureMutation } from "./testing/execution-mutation-fixture";
import { createTestGraphExecutionContract } from "./testing/execution-contract";

const PROJECT = "/review";
const SESSION = "session";
const NOW = "2026-09-19T00:00:00.000Z";
const BACKEND_REF: AgentSessionRef = {
  backend: "claude",
  ref: "provider-session",
};

async function runRetryRound(disposition: "retain" | "clear") {
  const runtimeRefs: (AgentSessionRef | null)[] = [];
  const lifecycle = await createLifecycleFixture({
    address: {
      projectPath: PROJECT,
      target: {
        scope: "session",
        projectName: "review",
        sessionName: SESSION,
        conversationId: "fixture-anchor",
      },
    },
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        async createRuntime(input) {
          runtimeRefs.push(input.persistedRef);
          return createMockBackendRuntime({
            modelSelection: input.modelSelection,
            fsWritePolicy: input.fsWritePolicy,
            async sendTurn(turn) {
              await turn.onEvent({ type: "input_accepted" });
              return {
                backendRef: disposition === "retain" ? BACKEND_REF : null,
                continuationDisposition: disposition,
                costUsd: null,
                durationMs: 1,
                numTurns: 1,
                contextTokens: 0,
                contextWindowMax: null,
                contentBlocks: [],
                compacted: false,
                aborted: false,
                failure: {
                  kind: "backend_error",
                  message: "provider transport failure",
                  retryable: false,
                },
              };
            },
          });
        },
      }),
    },
  });
  const fixture = lifecycle.persistence;
  const worktree = mkdtempSync(path.join(tmpdir(), "cc-validator-retry-"));
  try {
    const storage = createGraphWorkflowExecutionsRepo(fixture.db);
    const initial = createWorkflowExecution({ status: "running" });
    const context = initial.workingDefinition.executionContexts[0];
    if (!context) throw new Error("missing fixture context");
    context.contextValidator = {
      enabled: true,
      assignments: [
        seedAssignment({
          id: "reviewer",
          profile: { tier: "builtin", id: "general-reviewer" },
          authority: "blocking",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        }),
      ],
    };
    storage.setActive(PROJECT, SESSION, initial, NOW);
    const repository: GraphLaneContinuityDeps["executionRepository"] = {
      async mutateActive(projectPath, sessionName, fn) {
        const current = storage.getActive(projectPath, sessionName);
        if (!current) throw new Error("missing persisted execution");
        return applyFixtureMutation(current, fn, (next) => {
          storage.setActive(projectPath, sessionName, next, NOW);
        });
      },
    };
    let createdConversations = 0;
    const continuityService = createGraphLaneContinuity({
      laneService: createLaneService({
        store: createGraphLaneStore({
          listActiveExecutions: async () => storage.listActive(),
          mutateActiveExecution: repository.mutateActive,
        }),
      }),
      executionRepository: repository,
      async createConversation(_project, _session, options) {
        const id = `conversation-${++createdConversations}`;
        await fixture.seedConversation(
          PROJECT,
          SESSION,
          makeConversationState({
            id,
            role: "validator",
            profileSnapshot: options.profileSnapshot,
          }),
        );
        return { id };
      },
      getConversation: fixture.store.getConversation,
    });
    const dispatched: string[] = [];
    const runner = createValidatorRunner({
      executionContract: createTestGraphExecutionContract(),
      resolveWorktreePath: async () => worktree,
      continuityService,
      executionRepository: repository,
      getProjectDisplayName: () => "review",
      readLaneConversation: async () => null,
      readValidatorConversationTelemetry: async () => null,
      executeConversationTurn: async (input) => {
        dispatched.push(input.binding.address.target.conversationId);
        return lifecycle.manager.executeConversationTurn(input);
      },
      stopConversationActor: lifecycle.manager.stopConversationActor,
    });
    const cohort = createValidatorCohortRunner({
      runContextValidator: runner.runContextValidator,
      renderRoundCommonSections: async () => ({
        diffScopeSection: "",
        candidateTreeHash: null,
      }),
    });
    const result = await cohort.validateContextCompletion({
      projectPath: PROJECT,
      sessionName: SESSION,
      execution: initial,
      contextId: context.id,
    });
    const lane = storage.getActive(PROJECT, SESSION)?.laneStates[context.id]?.[
      "context_validator:reviewer"
    ];
    const conversation = await fixture.store.getConversation(
      PROJECT,
      SESSION,
      "conversation-1",
    );
    return {
      result,
      dispatched,
      createdConversations,
      lane,
      conversation,
      runtimeRefs,
    };
  } finally {
    await lifecycle.close();
    rmSync(worktree, { recursive: true, force: true });
  }
}

describe("validator cohort retry continuity", () => {
  it("retries the first conversation instead of creating replacement conversations", async () => {
    const run = await runRetryRound("retain");
    expect(run.result.kind).toBe("infra_exhausted");
    expect(run.dispatched).toEqual([
      "conversation-1",
      "conversation-1",
      "conversation-1",
    ]);
    expect(run.createdConversations).toBe(1);
    expect(run.lane?.workflowConversationId).toBe("conversation-1");
    expect(run.runtimeRefs).toEqual([null, BACKEND_REF, BACKEND_REF]);
    expect(run.conversation?.backendRef).toEqual(BACKEND_REF);
  });

  it("lets the actor reopen the same validator conversation after its continuation is cleared", async () => {
    const run = await runRetryRound("clear");
    expect(run.result.kind).toBe("infra_exhausted");
    expect(run.dispatched).toEqual([
      "conversation-1",
      "conversation-1",
      "conversation-1",
    ]);
    expect(run.runtimeRefs).toEqual([null, null, null]);
    expect(run.conversation?.backendRef).toBeNull();
    expect(run.conversation?.promptCount).toBe(3);
    expect(run.lane?.workflowConversationId).toBe("conversation-1");
    expect(run.createdConversations).toBe(1);
  });
});
