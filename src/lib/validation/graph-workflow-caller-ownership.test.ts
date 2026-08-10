import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowCharterService } from "@/lib/workflow-graph/charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import {
  createGraphWorkflowExecutionRouteHandlers,
  OWNER_CONVERSATION_HEADER,
} from "@/lib/workflow-graph/execution-route-handlers";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import {
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import { repoValidationConfigSchema } from "./schemas";
import {
  createProductionValidationCallerResolver,
  type ProductionValidationResolverDeps,
} from "./singleton";

/**
 * Who owns a session's validation slot while a graph-workflow execution holds
 * it. Separate from `singleton.test.ts` because the owner identity these cases
 * turn on must be PRODUCED by the real HTTP start seam over the real store — a
 * seeded `ownerConversationId` would only prove the resolver reads a field.
 */

const T = "2026-08-05T10:00:00.000Z";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: T,
    lastActivityAt: T,
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  };
}

function implementerLaneState(
  conversationId: string,
): GraphWorkflowAgentSessionState {
  return {
    lane: "implementer",
    contextId: "context-implement",
    backend: "claude",
    refKind: "conversation",
    workflowConversationId: conversationId,
    metrics: { rotateBeforeNextTurn: false },
    limitEvaluation: "supported",
    lastUsedAt: T,
  };
}

function activeLaneExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      "context-implement": {
        ...base.contextStates["context-implement"]!,
        laneId: "lane-1",
      },
    },
    executionLanes: {
      "lane-1": {
        laneId: "lane-1",
        kind: "worktree",
        status: "active",
        worktreePath: "/repo/.worktrees/session-1.lane-1",
        branchName: "csm/session-1-lane-1",
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: T,
        updatedAt: T,
      },
    },
    laneStates: {
      "context-implement": { implementer: implementerLaneState("conv-lane") },
    },
    ...overrides,
  };
}

function resolverDeps(opts: {
  session?: SessionState | null;
  execution?: GraphWorkflowExecution | null;
}): ProductionValidationResolverDeps {
  return {
    getSession: async () => opts.session ?? null,
    getActiveGraphWorkflowExecution: async () => opts.execution ?? null,
    readRepoValidation: async () =>
      repoValidationConfigSchema.parse({
        commands: {
          typecheck: { command: "scripts/validate/typecheck.sh", cost: 2 },
          test: { command: "scripts/validate/test.sh", cost: 8 },
        },
      }),
  };
}

describe("createProductionValidationCallerResolver ownership of a slot-holding execution", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const OWNER_CONVERSATION_ID = "conv-owner";
  const OTHER_CONVERSATION_ID = "conv-other";
  const FORGED_CONVERSATION_ID = "conv-forged";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  function conversation(id: string): ConversationState {
    return conversationStateSchema.parse({
      id,
      scope: "session",
      transcriptPath: null,
      status: "idle",
      promptCount: 1,
      createdAt: T,
      lastActivityAt: T,
      agentBackend: "claude",
    });
  }

  /**
   * The real HTTP start seam over the real store: owner identity has to be
   * PRODUCED by production code here, not handed to the resolver by the test.
   * A fixture that seeded `ownerConversationId` directly would prove the
   * resolver reads a field while saying nothing about whether any start seam
   * ever writes one.
   */
  async function startThroughProductionRoute(input: {
    header?: string;
    body?: Record<string, unknown>;
  }): Promise<void> {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
      now: () => T,
    });
    const repository = createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher,
      charterService: createWorkflowCharterService({
        writeFile: async () => {},
        ensureDir: async () => {},
        publishCharterRegistered: eventPublisher.publishCharterRegistered,
      }),
    });
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      getSession: fixture.store.getSession,
      // The dirty-worktree guard probes a real git worktree; these fixture
      // paths have none, so answer "clean" rather than let the probe decide.
      readSessionWorktreeDirtyPaths: async () => [],
      async loadDefinition() {
        return createWorkflowDefinitionRecord({ id: "workflow-1" });
      },
      now: () => T,
      createExecutionId: () => "execution-started",
    });
    const handlers = createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      startExecution: (startInput) => manager.start(startInput),
      // The loop never runs, so the started execution holds the slot with zero
      // lane conversations — exactly the state that stranded planners.
      kickOffExecutionLoop: async () => {},
      normalizeExecutionAfterRestart: unusedResolverDep(
        "normalizeExecutionAfterRestart",
      ),
      pauseExecution: unusedResolverDep("pauseExecution"),
      resumeExecution: unusedResolverDep("resumeExecution"),
      abortExecution: unusedResolverDep("abortExecution"),
      resetExecutionContext: unusedResolverDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedResolverDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: repository.archiveActive,
      getActiveExecution: repository.getActive,
      recordPendingHaltReason: unusedResolverDep("recordPendingHaltReason"),
      drainAndHalt: unusedResolverDep("drainAndHalt"),
      recordApprovalDecision: unusedResolverDep("recordApprovalDecision"),
    });

    const response = await handlers.START(
      new NextRequest(
        "http://localhost/api/projects/repo/sessions/session-1/graph-workflow",
        {
          method: "POST",
          body: JSON.stringify({
            definitionId: "workflow-1",
            ...(input.body ?? {}),
          }),
          headers: {
            "content-type": "application/json",
            ...(input.header === undefined
              ? {}
              : { [OWNER_CONVERSATION_HEADER]: input.header }),
          },
        },
      ),
      { params: Promise.resolve({ name: "repo", session: SESSION_NAME }) },
    );
    if (response.status !== 202) {
      throw new Error(
        `production start failed: ${response.status} ${await response.text()}`,
      );
    }
  }

  function unusedResolverDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by the start smoke test`);
    };
  }

  /** The resolver reading the SAME store the production start wrote to. */
  function storeBackedResolver() {
    return createProductionValidationCallerResolver({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      readRepoValidation: async () => null,
    });
  }

  function resolve(conversationId: string) {
    return storeBackedResolver().resolveCaller({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId,
    });
  }

  it("admits exactly the captured owner of a zero-lane execution and refuses everyone else", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversation(OWNER_CONVERSATION_ID),
    );
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversation(OTHER_CONVERSATION_ID),
    );

    await startThroughProductionRoute({
      header: OWNER_CONVERSATION_ID,
      // A client-supplied owner claim rides along; only the verified header may
      // become the owner.
      body: { ownerConversationId: FORGED_CONVERSATION_ID },
    });

    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.ownerConversationId).toBe(OWNER_CONVERSATION_ID);

    await expect(resolve(OWNER_CONVERSATION_ID)).resolves.toMatchObject({
      kind: "session",
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      sessionName: SESSION_NAME,
    });
    await expect(resolve(OTHER_CONVERSATION_ID)).resolves.toMatchObject({
      kind: "ambiguous",
    });
    await expect(resolve(FORGED_CONVERSATION_ID)).resolves.toMatchObject({
      kind: "ambiguous",
    });
  });

  it("captures no owner from a request-body claim, leaving the run unowned", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversation(FORGED_CONVERSATION_ID),
    );

    await startThroughProductionRoute({
      body: { ownerConversationId: FORGED_CONVERSATION_ID },
    });

    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.ownerConversationId).toBeNull();
    await expect(resolve(FORGED_CONVERSATION_ID)).resolves.toMatchObject({
      kind: "ambiguous",
    });
  });

  it("refuses every conversation for a legacy zero-lane execution with a null owner", async () => {
    // A run started before owner capture existed: fail-closed, because
    // "unowned" must never widen into "open to anyone".
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedLegacy",
      () => ({
        execution: {
          ...createWorkflowExecution({ status: "running" }),
          ownerConversationId: null,
          laneStates: {},
        },
        events: [],
      }),
    );

    await expect(resolve(OWNER_CONVERSATION_ID)).resolves.toMatchObject({
      kind: "ambiguous",
    });
  });

  it("refuses a claimed workflow identity even from the owner conversation", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversation(OWNER_CONVERSATION_ID),
    );
    await startThroughProductionRoute({ header: OWNER_CONVERSATION_ID });

    // The bypass grants a plain session-scoped caller. A lane identity claim
    // has no lane to match, so it stays refused.
    await expect(
      storeBackedResolver().resolveCaller({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: OWNER_CONVERSATION_ID,
        claimedWorkflow: {
          executionId: "execution-started",
          contextId: "context-plan",
        },
      }),
    ).resolves.toMatchObject({ kind: "ambiguous" });
  });

  it.each(["halted", "paused"] as const)(
    "keeps a %s run with lanes fail-closed against non-lane conversations",
    async (status) => {
      const resolver = createProductionValidationCallerResolver(
        resolverDeps({
          session: session(),
          execution: activeLaneExecution({
            status,
            ownerConversationId: OWNER_CONVERSATION_ID,
            ...(status === "halted"
              ? {
                  haltReason: {
                    type: "recovery_error" as const,
                    message: "stalled",
                  },
                }
              : {}),
          }),
        }),
      );

      // A resumable run RETAINS ownership, and it has lanes to classify with —
      // so the owner bypass does not apply and the lane rules still govern.
      await expect(
        resolver.resolveCaller({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId: OWNER_CONVERSATION_ID,
        }),
      ).resolves.toMatchObject({ kind: "ambiguous" });
      await expect(
        resolver.resolveCaller({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId: "conv-lane",
        }),
      ).resolves.toMatchObject({ kind: "graph_lane" });
    },
  );
});
