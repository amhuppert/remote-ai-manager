import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
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
  const fixture = createPersistenceFixture();
  const worktree = mkdtempSync(path.join(tmpdir(), "cc-validator-retry-"));
  try {
    fixture.seedProject(PROJECT);
    fixture.seedSession(PROJECT, SESSION);
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
      createConversation: async () => ({
        id: `conversation-${++createdConversations}`,
      }),
      getConversation: async (_project, _session, id) => ({
        id,
        promptCount: 1,
        backendRef: BACKEND_REF,
      }),
    });
    const dispatched: string[] = [];
    const runner = createValidatorRunner({
      executionContract: createTestGraphExecutionContract(),
      resolveWorktreePath: async () => worktree,
      resolveTimeoutMs: async () => 1000,
      continuityService,
      executionRepository: repository,
      getProjectDisplayName: () => "review",
      readLaneConversation: async () => null,
      readValidatorConversationTelemetry: async () => null,
      executeWorkflowTaskRun: async (input) => {
        dispatched.push(input.binding.address.target.conversationId);
        return {
          kind: "error",
          error: "provider transport failure",
          aborted: false,
          backendRef: disposition === "retain" ? BACKEND_REF : null,
          continuationDisposition: disposition,
          usage: {
            costUsd: null,
            durationMs: null,
            contextTokens: null,
            contextWindowMax: null,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
          },
        };
      },
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
    return { result, dispatched, createdConversations, lane };
  } finally {
    fixture.close();
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
  });

  it("stops dispatching a validator after its continuation is lost", async () => {
    const run = await runRetryRound("clear");
    expect(run.result.kind).toBe("infra_exhausted");
    expect(run.dispatched).toHaveLength(1);
    expect(run.lane?.staleSession).toBe(true);
    expect(run.createdConversations).toBe(1);
  });
});
