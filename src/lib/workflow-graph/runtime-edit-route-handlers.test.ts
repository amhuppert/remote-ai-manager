import { applyFixtureMutation } from "./testing/execution-mutation-fixture";
import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowSSEEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  stubAssignmentSnapshotPreparation,
} from "./test-fixtures";
import type { LiveEditDeps } from "./runtime-edits";
import {
  createGraphWorkflowRuntimeEditRouteHandlers,
  type GraphWorkflowRuntimeEditRouteDeps,
} from "./runtime-edit-route-handlers";
import {
  CONVERSATION_CAPABILITY_HEADER,
  mintConversationCapability,
  verifyConversationCapability,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_HEADER,
  mintLaneCapability,
  verifyLaneCapability,
} from "@/lib/agent-gateway/lane-capability";
import { assertExecutionPrincipalFence } from "./principal-fence";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";

function principalSession(conversationIds: readonly string[]) {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    branchName: `csm/${SESSION_NAME}`,
    createdAt: "2026-08-14T10:00:00.000Z",
    lastActivityAt: "2026-08-14T10:00:00.000Z",
    conversations: conversationIds.map((id) =>
      conversationStateSchema.parse({
        id,
        transcriptPath: null,
        status: "awaiting",
        promptCount: 0,
        createdAt: "2026-08-14T10:00:00.000Z",
        lastActivityAt: "2026-08-14T10:00:00.000Z",
      }),
    ),
  });
}

const TEST_LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => ({
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      enabled: { value: true, source: "global" },
      secondAgent: {
        value: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
        source: "global",
      },
      negotiationRounds: { value: 3, source: "global" },
      autonomousResolutionThreshold: { value: "minor", source: "global" },
    },
    agentValidation: {
      implementer: { value: { mode: "all", except: [] }, source: "global" },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
      },
    },
    memory: {
      implementer: {
        read: { value: "ambient", source: "global" },
        contribute: { value: "on", source: "global" },
      },
      validator: {
        read: { value: "off", source: "global" },
        contribute: { value: "off", source: "global" },
      },
    },
  }),
  validationCommandPreflight: () => ({
    commandCosts: {},
    concurrencyLimit: 8,
  }),
  snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
  now: () => "2026-07-29T10:00:00.000Z",
};

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    },
  );
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

const routeParams = makeContext({ name: "repo", session: "session-1" });

describe("graph workflow runtime edit route handlers (live edits)", () => {
  let fixture: PersistenceFixture;
  let broadcast: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof createGraphWorkflowRuntimeEditRouteHandlers>;
  let routeDeps: GraphWorkflowRuntimeEditRouteDeps;
  let buildLiveEditDeps: ReturnType<typeof vi.fn>;
  let writeCharterDocument: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    broadcast = vi.fn<(_event: GraphWorkflowSSEEvent) => void>();
    const publisher = createGraphWorkflowExecutionEventPublisher({ broadcast });
    const repository = createGraphWorkflowExecutionRepository({
      getGraphWorkflowPendingArtifacts: async () => null,
      clearGraphWorkflowPendingArtifacts: async () => false,

      // No git worktree in this harness; the real exclusion would shell out.
      ensureCcArtifactsExcluded: async () => {},
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher: publisher,
    });

    buildLiveEditDeps = vi.fn(async () => TEST_LIVE_EDIT_DEPS);
    writeCharterDocument = vi.fn(async () => {});

    routeDeps = {
      executionContract: createNonParticipatingGraphExecutionContract(),
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
      mutateActive: repository.mutateActive,
      buildLiveEditDeps,
      prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
      publishLiveEditApplied: publisher.publishLiveEditApplied,
      publishCharterUpdated: publisher.publishCharterUpdated,
      writeCharterDocument,
    };
    handlers = createGraphWorkflowRuntimeEditRouteHandlers(routeDeps);
  });

  afterEach(() => {
    fixture.close();
  });

  async function seedExecution(
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "seed-execution",
      () => ({
        kind: "commit",
        value: undefined,
        ...{ execution, events: [] },
      }),
    );
  }

  async function reload(): Promise<GraphWorkflowExecution | null> {
    return fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
  }

  function liveEditEventRows() {
    return fixture.graphWorkflowEvents
      .findByExecution(PROJECT_PATH, SESSION_NAME, "execution-1")
      .filter((row) => row.event.type === "graph-workflow-live-edit-applied");
  }

  function updateContext(overrides: Record<string, unknown> = {}) {
    return {
      executionId: "execution-1",
      baseLiveRevision: 1,
      source: "cli" as const,
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          title: "Implement carefully",
        },
      ],
      ...overrides,
    };
  }

  /**
   * R6.5 — the running-time structural exception is exactly two SERVER-DERIVED
   * paths (lane-agent expansion and engine loop unrolling). This endpoint is
   * the one both client surfaces use: `cctl workflow live edit` sends
   * `source: "cli"` and the execution inspector sends `source: "ui"`. Neither
   * may reshape a running graph, so the whole structural vocabulary is pinned
   * against both.
   */
  describe("structural edits stay pause-only for the CLI and UI surfaces", () => {
    const STRUCTURAL_OPS = [
      {
        label: "add-context",
        operation: {
          type: "add-context",
          id: "context-new",
          title: "New",
          acceptanceCriteria: "Something is done",
        },
      },
      {
        label: "remove-context",
        operation: { type: "remove-context", contextId: "context-verify" },
      },
      {
        label: "add-edge",
        operation: {
          type: "add-edge",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      },
      {
        label: "remove-edge",
        operation: { type: "remove-edge", edgeId: "edge-implement-verify" },
      },
    ] as const;

    for (const source of ["cli", "ui"] as const) {
      for (const { label, operation } of STRUCTURAL_OPS) {
        it(`refuses ${label} from the ${source} surface while the execution runs`, async () => {
          await seedExecution(
            createWorkflowExecution({
              status: "running",
              activeContextIds: ["context-plan"],
            }),
          );

          const response = await handlers.POST(
            makeRequest("POST", {
              executionId: "execution-1",
              baseLiveRevision: 1,
              source,
              operations: [operation],
            }),
            routeParams,
          );

          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({
            code: "requires_pause",
          });
          // Fail-closed: no graph change, no revision bump, no audit row.
          const reloaded = await reload();
          expect(reloaded?.liveRevision).toBe(1);
          expect(
            reloaded?.workingDefinition.executionContexts.map(
              (context) => context.id,
            ),
          ).toEqual(["context-plan", "context-implement", "context-verify"]);
          expect(liveEditEventRows()).toHaveLength(0);
        });
      }
    }

    it("accepts the same structural edit once the execution is paused", async () => {
      await seedExecution(createWorkflowExecution({ status: "paused" }));

      const response = await handlers.POST(
        makeRequest("POST", {
          executionId: "execution-1",
          baseLiveRevision: 1,
          source: "cli",
          operations: [
            {
              type: "add-context",
              id: "context-new",
              title: "New",
              acceptanceCriteria: "Something is done",
            },
            {
              type: "add-edge",
              sourceContextId: "context-verify",
              targetContextId: "context-new",
            },
          ],
        }),
        routeParams,
      );

      expect(response.status).toBe(200);
      const reloaded = await reload();
      expect(
        reloaded?.workingDefinition.executionContexts.map(
          (context) => context.id,
        ),
      ).toContain("context-new");
    });
  });

  it("rejects a malformed body with a codeless 400 and issues", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", { source: "cli", operations: [] }),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).not.toHaveProperty("code");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("rejects invalid JSON with a codeless 400", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const request = new NextRequest(
      "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
      {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      },
    );

    const response = await handlers.POST(request, routeParams);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).not.toHaveProperty("code");
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      makeContext({ name: "unknown", session: "session-1" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session is unknown", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      makeContext({ name: "repo", session: "ghost" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when there is no active execution", async () => {
    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 execution_mismatch when executionId is not the active one", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ executionId: "execution-other" })),
      routeParams,
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("execution_mismatch");
  });

  it("returns 409 revision_conflict with currentLiveRevision", async () => {
    await seedExecution(
      createWorkflowExecution({ status: "paused", liveRevision: 4 }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ baseLiveRevision: 2 })),
      routeParams,
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("revision_conflict");
    expect(body.currentLiveRevision).toBe(4);
  });

  it("returns 409 not_editable for a completed execution", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "completed",
        completedAt: "2026-03-27T13:00:00.000Z",
      }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 409 not_editable for an aborted execution", async () => {
    await seedExecution(createWorkflowExecution({ status: "aborted" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 409 not_editable for a non-resumable halt", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "halted",
        haltReason: { type: "recovery_error", message: "boom" },
      }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_editable");
  });

  it("returns 409 not_editable for a snapshot parked awaiting definition approval", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-03-27T12:30:00.000Z",
          approvedAt: null,
        },
      }),
    );

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("not_editable");
    // The refusal names the park, so the operator's remedy is approve or
    // reject rather than "pause and retry".
    expect(body.error).toContain("awaiting-definition-approval");
  });

  it("returns 400 requires_pause for a started context on a running execution", async () => {
    const base = createWorkflowExecution({ status: "running" });
    await seedExecution({
      ...base,
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-plan",
              title: "Cannot edit while running",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("requires_pause");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  // #80 I-12: the reason a structural batch waits for an idle scheduler has to
  // reach the wire, or the CLI has no why-line to render and "quiescent" stays
  // a word the caller has to guess the meaning of.
  it("carries the quiescence rationale and the pause/edit/resume act on a structural refusal", async () => {
    const base = createWorkflowExecution({ status: "running" });
    await seedExecution({
      ...base,
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "add-context",
              id: "context-new",
              title: "New",
              acceptanceCriteria: "Something is done",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("requires_pause");
    expect(body.rationale).toBe(
      "structural edits apply atomically against a quiescent scheduler so no lane reads a half-applied definition",
    );
    expect(body.instruction).toContain("pause, edit, resume");
  });

  it("returns a machine-readable 409 when the registered contract refuses", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));
    handlers = createGraphWorkflowRuntimeEditRouteHandlers({
      ...routeDeps,
      executionContract: {
        loadPromptProjection: async () => null,

        validateDefinition: () => ({ ok: true }),
        loadLiveEdit: () => ({
          validateOperation: () => ({
            ok: false,
            code: "contract_refused",
            issues: [
              {
                code: "contract-refused",
                message: "The contract refused this operation.",
                taskId: "task-implement-1",
              },
            ],
            instruction: "Start a new execution to use a different grouping.",
          }),
          accountabilityCoverageGroups: [],
        }),
        validateTaskCompletion: () => ({ ok: true }),
        deriveContextAcceptanceCriteria: () => ({
          ok: true,
          acceptanceCriteriaByContextId: {},
        }),
      },
    });

    const response = await handlers.POST(
      makeRequest("POST", {
        executionId: "execution-1",
        baseLiveRevision: 1,
        source: "cli",
        operations: [
          {
            type: "move-task",
            taskId: "task-implement-1",
            targetContextId: "context-verify",
          },
        ],
      }),
      routeParams,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "contract_refused",
      issues: [
        {
          path: "operations[0]",
          message: expect.stringContaining("contract-refused"),
        },
      ],
      instruction: "Start a new execution to use a different grouping.",
    });
    expect((await reload())?.liveRevision).toBe(1);
  });

  it("returns 400 frozen when editing a completed context", async () => {
    const base = createWorkflowExecution({ status: "paused" });
    await seedExecution({
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "completed",
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-plan",
              title: "Cannot edit completed",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("frozen");
  });

  it("returns a machine-readable 409 with amend-at-source guidance for a locked region", async () => {
    const base = createWorkflowExecution({ status: "paused" });
    await seedExecution({
      ...base,
      workingDefinition: {
        ...base.workingDefinition,
        lockedRegions: [
          {
            paths: ["/executionContexts/context-implement/acceptanceCriteria"],
            sourceUri: "contract://criteria/R17.4",
            reason: "Acceptance criteria are contract-derived",
          },
        ],
      },
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              acceptanceCriteria: "Weakened criteria",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "region_locked",
      instruction:
        'Amend at source contract://criteria/R17.4 and recompile the workflow definition. This refusal applies to active execution "execution-1".',
    });
    expect(
      (await reload())?.workingDefinition.executionContexts.find(
        (context) => context.id === "context-implement",
      )?.acceptanceCriteria,
    ).toBe("Feature implemented");
  });

  it("returns 400 invalid_edit for an unknown context", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "no-such-context",
              title: "x",
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_edit");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("rejects an oversized selection without persisting or publishing the live edit", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));
    buildLiveEditDeps.mockResolvedValue({
      ...TEST_LIVE_EDIT_DEPS,
      validationCommandPreflight: () => ({
        commandCosts: { test: 5 },
        concurrencyLimit: 4,
      }),
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              scriptValidator: { commands: ["test"] },
            },
          ],
        }),
      ),
      routeParams,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(body.code).toBe("validation_cost_exceeds_limit");
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        path: "executionContexts.context-implement.scriptValidator.commands.0",
        message: expect.stringMatching(
          /validation_cost_exceeds_limit.*cost 5.*limit 4.*lower-worker/,
        ),
      }),
    );
    expect((await reload())?.liveRevision).toBe(1);
    expect(liveEditEventRows()).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "graph-workflow-live-edit-applied" }),
    );
  });

  it("dry-run never persists, bumps, or emits events", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ dryRun: true })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      applied: 1,
      liveRevision: 1,
      affectedContextIds: ["context-implement"],
      dryRun: true,
    });

    const reloaded = await reload();
    expect(reloaded?.liveRevision).toBe(1);
    const context = reloaded?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.title).toBe("Implement");
    expect(liveEditEventRows()).toHaveLength(0);
    expect(
      broadcast.mock.calls.some(
        ([event]) => event.type === "graph-workflow-live-edit-applied",
      ),
    ).toBe(false);
  });

  it("applies an accepted batch: bumps liveRevision, emits + persists the event", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      applied: 1,
      liveRevision: 2,
      affectedContextIds: ["context-implement"],
      dryRun: false,
    });
    expect(body).not.toHaveProperty("execution");

    const reloaded = await reload();
    expect(reloaded?.liveRevision).toBe(2);
    const context = reloaded?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.title).toBe("Implement carefully");

    const rows = liveEditEventRows();
    expect(rows).toHaveLength(1);
    const event = rows[0]?.event;
    expect(event).toMatchObject({
      type: "graph-workflow-live-edit-applied",
      executionId: "execution-1",
      liveRevision: 2,
      operationCount: 1,
      affectedContextIds: ["context-implement"],
      source: "cli",
    });

    const broadcastEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-live-edit-applied");
    expect(broadcastEvents).toHaveLength(1);
    expect(broadcastEvents[0]).toMatchObject({
      source: "cli",
      liveRevision: 2,
    });
  });

  it("persists context-validator command edits on an unstarted context while the execution runs", async () => {
    await seedExecution(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
      }),
    );
    buildLiveEditDeps.mockResolvedValue({
      ...TEST_LIVE_EDIT_DEPS,
      validationCommandPreflight: () => ({
        commandCosts: { typecheck: 2 },
        concurrencyLimit: 8,
      }),
    });

    const response = await handlers.POST(
      makeRequest(
        "POST",
        updateContext({
          source: "ui",
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              agentValidation: {
                implementer: {
                  value: { mode: "all", except: [] },
                  source: "global",
                },
                contextValidator: {
                  value: { mode: "only", commands: ["typecheck"] },
                  source: "per-node",
                },
              },
            },
          ],
        }),
      ),
      routeParams,
    );

    const responseBody = await response.clone().json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    const context = (await reload())?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    );
    expect(context?.agentValidation?.contextValidator).toEqual({
      value: { mode: "only", commands: ["typecheck"] },
      source: "per-node",
      commands: ["typecheck"],
    });
  });

  it("attributes the source from the request (ui)", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ source: "ui" })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const rows = liveEditEventRows();
    expect(rows[0]?.event).toMatchObject({ source: "ui" });
  });

  it("attributes the source from the request (ui)", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext({ source: "ui" })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const rows = liveEditEventRows();
    expect(rows[0]?.event).toMatchObject({ source: "ui" });
  });

  function charterUpdatedEventRows() {
    return fixture.graphWorkflowEvents
      .findByExecution(PROJECT_PATH, SESSION_NAME, "execution-1")
      .filter((row) => row.event.type === "graph-workflow-charter-updated");
  }

  function amendCharter(overrides: Record<string, unknown> = {}) {
    return {
      executionId: "execution-1",
      baseLiveRevision: 1,
      source: "cli" as const,
      operations: [
        {
          type: "amend-charter",
          rationale: "the mission drifted from what the run actually needs",
          mission: "Amended mission statement",
        },
      ],
      ...overrides,
    };
  }

  it("applies amend-charter: persists the amendment, emits charter-updated, rewrites charter.md", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", amendCharter()),
      routeParams,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ applied: 1, liveRevision: 2, dryRun: false });

    const reloaded = await reload();
    expect(reloaded?.charter.mission).toBe("Amended mission statement");
    expect(reloaded?.charterAmendments).toHaveLength(1);
    expect(reloaded?.charterAmendments[0]).toMatchObject({
      seq: 1,
      source: "cli",
      amendedAt: "2026-07-29T10:00:00.000Z",
      fieldsChanged: ["mission"],
    });

    const charterRows = charterUpdatedEventRows();
    expect(charterRows).toHaveLength(1);
    expect(charterRows[0]?.event).toMatchObject({
      type: "graph-workflow-charter-updated",
      executionId: "execution-1",
      charterHash: reloaded?.charterAmendments[0]?.charterHash,
    });
    expect(liveEditEventRows()).toHaveLength(1);

    const broadcastTypes = broadcast.mock.calls.map(([event]) => event.type);
    expect(broadcastTypes).toContain("graph-workflow-live-edit-applied");
    expect(broadcastTypes).toContain("graph-workflow-charter-updated");

    const session = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(writeCharterDocument).toHaveBeenCalledTimes(1);
    const writeInput = writeCharterDocument.mock.calls[0]?.[0] as {
      worktreePath: string;
      markdown: string;
    };
    expect(writeInput.worktreePath).toBe(session?.worktreePath);
    expect(writeInput.markdown).toContain("Amended mission statement");
  });

  it("dry-run amend-charter leaves the charter, log, events, and document untouched", async () => {
    const seeded = createWorkflowExecution({ status: "paused" });
    await seedExecution(seeded);

    const response = await handlers.POST(
      makeRequest("POST", amendCharter({ dryRun: true })),
      routeParams,
    );

    expect(response.status).toBe(200);
    const reloaded = await reload();
    expect(reloaded?.charter.mission).toBe(seeded.charter.mission);
    expect(reloaded?.charterAmendments).toHaveLength(0);
    expect(reloaded?.liveRevision).toBe(1);
    expect(charterUpdatedEventRows()).toHaveLength(0);
    expect(writeCharterDocument).not.toHaveBeenCalled();
  });

  it("a batch without amend-charter emits no charter-updated and writes no document", async () => {
    await seedExecution(createWorkflowExecution({ status: "paused" }));

    const response = await handlers.POST(
      makeRequest("POST", updateContext()),
      routeParams,
    );

    expect(response.status).toBe(200);
    expect(charterUpdatedEventRows()).toHaveLength(0);
    expect(writeCharterDocument).not.toHaveBeenCalled();
  });
});

/**
 * Live edit is scoped by the same principal rules as the lifecycle verbs
 * (R9.1/R9.4). It restructures a run in flight, so an agent that may not pause
 * a run must not be able to rewrite it either.
 *
 * Stubbed deps rather than the persistence fixture above: the guard runs before
 * any state is read or written, and the property under test is precisely that
 * a refused caller never reaches the apply.
 */
describe("graph workflow runtime edit route principals", () => {
  const CAPABILITY_SECRET = "server-only-capability-key";
  const ORIGIN_CONV = "conv-origin";
  const SIBLING_CONV = "conv-sibling";
  const LANE_CONV = "conv-lane";
  /** Exists in the session; simply no longer drives the context. */
  const RETIRED_LANE_CONV = "conv-retired-lane";

  function ownedExecution(): GraphWorkflowExecution {
    const base = createWorkflowExecution({
      id: "execution-owned",
      status: "running",
    });
    return {
      ...base,
      ownerConversationId: ORIGIN_CONV,
      // The running task is what makes a lane capability CURRENT rather than
      // merely well-signed.
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running",
          lastConversationId: LANE_CONV,
        },
      },
    };
  }

  function buildStack(
    transport: "absent" | "valid",
    options: {
      /**
       * The session's conversations. A lane conversation IS a conversation on
       * the session, so the default carries it: a lane capability signs no
       * session, and membership is the only thing binding it to this one.
       */
      conversationIds?: readonly string[];
      /** The execution the route reads when it guards the caller. */
      execution?: GraphWorkflowExecution;
      /** The execution present at write time, for turnover fencing. */
      activeAtWriteTime?: GraphWorkflowExecution;
    } = {},
  ) {
    const conversationIds = options.conversationIds ?? [
      ORIGIN_CONV,
      SIBLING_CONV,
      LANE_CONV,
      RETIRED_LANE_CONV,
    ];
    const { activeAtWriteTime } = options;
    const readExecution = options.execution ?? ownedExecution();
    const applyMutation = vi.fn();
    const mutationAttempt = vi.fn();
    const mutateActive: GraphWorkflowRuntimeEditRouteDeps["mutateActive"] =
      async (_p, _s, reduce) => {
        mutationAttempt();
        if (activeAtWriteTime !== undefined) {
          assertExecutionPrincipalFence(
            PROJECT_PATH,
            SESSION_NAME,
            activeAtWriteTime,
          );
        }
        applyMutation();
        return applyFixtureMutation(
          activeAtWriteTime ?? readExecution,
          reduce,
          () => {},
        );
      };
    const buildLiveEditDeps = vi.fn(async () => TEST_LIVE_EDIT_DEPS);

    const handlers = createGraphWorkflowRuntimeEditRouteHandlers({
      executionContract: createNonParticipatingGraphExecutionContract(),
      resolveProjectPath: async (name: string) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: async () => principalSession(conversationIds),
      getActiveExecution: async () => readExecution,
      mutateActive,
      buildLiveEditDeps,
      prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
      publishLiveEditApplied: vi.fn(),
      publishCharterUpdated: vi.fn(),
      writeCharterDocument: vi.fn(async () => {}),
      auth: { validateOptionalToken: async () => ({ kind: transport }) },
      verifyConversationCapability: async (request: Request) =>
        verifyConversationCapability(
          request.headers.get(CONVERSATION_CAPABILITY_HEADER),
          CAPABILITY_SECRET,
        ),
      verifyLaneCapability: async (request: Request) =>
        verifyLaneCapability(
          request.headers.get(LANE_CAPABILITY_HEADER),
          CAPABILITY_SECRET,
        ),
    } satisfies GraphWorkflowRuntimeEditRouteDeps);

    return {
      handlers,
      mutateActive: mutationAttempt,
      buildLiveEditDeps,
      applyMutation,
    };
  }

  function editRequest(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(
      "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/runtime-edits",
      {
        method: "POST",
        body: JSON.stringify({
          executionId: "execution-owned",
          baseLiveRevision: 1,
          source: "cli" as const,
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              title: "Implement carefully",
            },
          ],
        }),
        headers: { "content-type": "application/json", ...headers },
      },
    );
  }

  const capabilityFor = (conversationId: string) => ({
    [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
      { sessionName: SESSION_NAME, conversationId },
      CAPABILITY_SECRET,
      1_760_000_000_000,
    ),
  });

  const laneCapabilityFor = (conversationId: string) => ({
    [LANE_CAPABILITY_HEADER]: mintLaneCapability(
      {
        laneKind: "implementer",
        executionId: "execution-owned",
        contextId: "context-plan",
        conversationId,
      },
      CAPABILITY_SECRET,
      1_760_000_000_000,
    ),
  });

  // Editing a run in flight is authored work, and the conversation holding the
  // context to fix a plan is routinely not the one that typed the launch. The
  // edit route therefore reads authority from session membership, which the
  // verified capability already proves.
  it("admits a session conversation that did not launch the run", async () => {
    const stack = buildStack("valid");

    const response = await stack.handlers.POST(
      editRequest(capabilityFor(SIBLING_CONV)),
      routeParams,
    );

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("admits a session conversation's edit of a run with no recorded origin", async () => {
    // A UI-launched run records no origin at all, which under the origin rule
    // meant no agent could ever edit it.
    const unowned = ownedExecution();
    unowned.ownerConversationId = null;
    const stack = buildStack("valid", { execution: unowned });

    const response = await stack.handlers.POST(
      editRequest(capabilityFor(SIBLING_CONV)),
      routeParams,
    );

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("admits a session conversation's edit when the recorded origin was deleted", async () => {
    const stack = buildStack("valid", {
      conversationIds: [SIBLING_CONV, LANE_CONV],
    });

    const response = await stack.handlers.POST(
      editRequest(capabilityFor(SIBLING_CONV)),
      routeParams,
    );

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("refuses a token-bearing agent that presents no capability", async () => {
    const stack = buildStack("valid");

    const response = await stack.handlers.POST(editRequest(), routeParams);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "unverified_principal",
    });
    expect(stack.mutateActive).not.toHaveBeenCalled();
  });

  it("admits the origin conversation past the guard", async () => {
    const stack = buildStack("valid");

    const response = await stack.handlers.POST(
      editRequest(capabilityFor(ORIGIN_CONV)),
      routeParams,
    );

    // Past the guard the apply runs for real; whatever it answers, the caller
    // was not turned away as a principal.
    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("admits the credential-free human UI regardless of origin", async () => {
    const stack = buildStack("absent");

    const response = await stack.handlers.POST(editRequest(), routeParams);

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  // A lane restructures the run it is driving — expansion and plan repair are
  // exactly this act — so the edit route admits it on its own execution.
  it("admits the current lane's edit of the execution it is driving", async () => {
    const stack = buildStack("valid");

    const response = await stack.handlers.POST(
      editRequest(laneCapabilityFor(LANE_CONV)),
      routeParams,
    );

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("refuses a lane whose binding rotates before its first serialized edit write", async () => {
    const rebound = ownedExecution();
    rebound.taskStates["task-plan-1"] = {
      ...rebound.taskStates["task-plan-1"]!,
      lastConversationId: "conv-successor-lane",
    };
    const stack = buildStack("valid", { activeAtWriteTime: rebound });

    const response = await stack.handlers.POST(
      editRequest(laneCapabilityFor(LANE_CONV)),
      routeParams,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_lane_principal",
      originConversationId: ORIGIN_CONV,
    });
    expect(stack.applyMutation).not.toHaveBeenCalled();
  });

  // A lane's authority to restructure the run it drives never came from the
  // origin conversation; the deleted-origin gate refused it only as collateral
  // of the rule that the origin is the one conversation that may act.
  it("admits the current lane's edit when the execution origin was deleted", async () => {
    const stack = buildStack("valid", {
      conversationIds: [SIBLING_CONV, LANE_CONV],
    });

    const response = await stack.handlers.POST(
      editRequest(laneCapabilityFor(LANE_CONV)),
      routeParams,
    );

    expect(response.status).not.toBe(403);
    expect(stack.buildLiveEditDeps).toHaveBeenCalled();
  });

  it("refuses a lane whose binding has moved on, write-free", async () => {
    const stack = buildStack("valid");

    const response = await stack.handlers.POST(
      editRequest(laneCapabilityFor(RETIRED_LANE_CONV)),
      routeParams,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_lane_principal",
    });
    expect(stack.mutateActive).not.toHaveBeenCalled();
    expect(stack.buildLiveEditDeps).not.toHaveBeenCalled();
  });

  // The escalation a token-free forgery would buy if a failed lane
  // authentication fell through to the human-UI branch: session-wide authority
  // to restructure a run in flight.
  it("refuses a forged lane credential's edit rather than reading it as the human UI", async () => {
    const stack = buildStack("absent");

    const response = await stack.handlers.POST(
      editRequest({
        [LANE_CAPABILITY_HEADER]: "cclc1.ZmFrZQ.bm90LWEtc2lnbmF0dXJl",
      }),
      routeParams,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "unverified_principal",
    });
    expect(stack.mutateActive).not.toHaveBeenCalled();
    expect(stack.buildLiveEditDeps).not.toHaveBeenCalled();
  });

  it("refuses a well-signed lane whose conversation this session does not have", async () => {
    // A lane capability carries no session in its signature, so a credential
    // minted for another session — or one whose conversation was deleted — is
    // caught here or not at all.
    const stack = buildStack("valid", {
      conversationIds: [ORIGIN_CONV, SIBLING_CONV],
    });

    const response = await stack.handlers.POST(
      editRequest(laneCapabilityFor(LANE_CONV)),
      routeParams,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "unverified_principal",
    });
    expect(stack.mutateActive).not.toHaveBeenCalled();
    expect(stack.buildLiveEditDeps).not.toHaveBeenCalled();
  });
});
