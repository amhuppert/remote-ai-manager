import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createApprovalGateService } from "./approval-gate";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowExecution, makeProfileSnapshot } from "./test-fixtures";
import {
  buildLaneIterationToolServer,
  createGraphWorkflowExecutionRouteHandlers,
  createGraphWorkflowRouteScriptValidatorService,
  launchGraphWorkflowExecution,
  resolveGraphValidatorTimeoutMs,
  type GraphWorkflowExecutionRouteDeps,
} from "./execution-route-handlers";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type {
  DefinitionApprovalGateDecision,
  GraphExecutionLifecycleContext,
} from "./execution-lifecycle-port";
import {
  GraphWorkflowTransitionConflictError,
  WorkflowDefinitionApprovalRequiredError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
} from "./workflow-manager";
import {
  GraphExecutionContractViolationError,
  registerGraphExecutionContract,
  resetGraphExecutionContractForTesting,
} from "./execution-contract-port";

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
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

describe("resolveGraphValidatorTimeoutMs", () => {
  const config = {
    agentBackends: {
      claude: { model: "opus", timeoutMs: 45_000 },
      codex: { model: "gpt-5.4", timeoutMs: null },
    },
  };

  it("uses the selected validator backend profile without an enablement gate", () => {
    expect(resolveGraphValidatorTimeoutMs(config, "claude")).toBe(45_000);
    expect(resolveGraphValidatorTimeoutMs(config, "codex")).toBe(0);
  });
});

describe("graph workflow execution route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const getSession =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<SessionState | null>
    >();
  const startExecution = vi.fn();
  const pauseExecution = vi.fn();
  const resumeExecution = vi.fn();
  const abortExecution = vi.fn();
  const archiveExecution = vi.fn();
  const normalizeExecutionAfterRestart = vi.fn();
  const kickOffExecutionLoop = vi.fn();
  const resetExecutionContext = vi.fn();
  const resetExecutionContextAssignment = vi.fn();
  const getActiveExecution = vi.fn();
  const recordPendingHaltReason = vi.fn();
  const drainAndHalt = vi.fn();
  const recordApprovalDecision = vi.fn();
  const recordDefinitionApproval = vi.fn();
  const markRunning = vi.fn(async () => {});
  const awaitingDefinitionApproval = vi.fn(async () => {});
  const executionAborted = vi.fn(async () => {});
  const admitDefinitionApproval = vi.fn<
    (
      context: GraphExecutionLifecycleContext,
      workflowExecutionId: string,
      definitionId: string,
      definitionRevision: number,
    ) => Promise<DefinitionApprovalGateDecision>
  >(async () => ({ ok: true }));
  const stopExecutionLaneDevServers = vi.fn(async () => {});
  const listArchivedExecutions =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<GraphWorkflowExecution[]>
    >();

  const handlers = createGraphWorkflowExecutionRouteHandlers({
    resolveProjectPath,
    getSession,
    startExecution,
    pauseExecution,
    resumeExecution,
    abortExecution,
    archiveExecution,
    normalizeExecutionAfterRestart,
    kickOffExecutionLoop,
    resetExecutionContext,
    resetExecutionContextAssignment,
    getActiveExecution,
    recordPendingHaltReason,
    drainAndHalt,
    recordApprovalDecision,
    recordDefinitionApproval,
    markRunning,
    awaitingDefinitionApproval,
    admitDefinitionApproval,
    executionAborted,
    stopExecutionLaneDevServers,
    listArchivedExecutions,
    auth: {
      async validateOptionalToken(request) {
        const header = request.headers.get("authorization");
        if (header === null) return { kind: "absent" };
        return header === "Bearer valid-agent-token"
          ? { kind: "valid" }
          : { kind: "invalid" };
      },
    },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    listArchivedExecutions.mockResolvedValue([]);
    // The active execution no longer rides the session row; route handlers read
    // it via getActiveExecution. The fixtures still seed it on the session, so
    // by default surface whatever the current getSession mock returns. Tests
    // that need a distinct active execution override getActiveExecution.
    getActiveExecution.mockImplementation(
      async (projectPath: string, sessionName: string) => {
        const session = await getSession(projectPath, sessionName);
        return session?.graphWorkflowExecution ?? null;
      },
    );
  });

  afterEach(() => {
    resetGraphExecutionContractForTesting();
  });

  it("delegates a zero-input start to the shared start path and returns 202", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-active",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    // The active-execution archive + dirty guard now live in the shared start
    // path; the handler delegates without owning either guard.
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "project",
    });
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: startedExecution,
    });
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        executionId: "execution-active",
        status: "running",
        archived: false,
      },
    });
  });

  it("threads supplied parameters into the shared start path on a parameterized start", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-param",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", parameters: { ticket: "CC-42" } },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "project",
      parameters: { ticket: "CC-42" },
    });
  });

  it("guards an HTTP launch with the selected definition revision", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-revision-guarded",
      status: "running",
      seedDefinitionRevision: 4,
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", definitionRevision: 4 },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      expectedDefinitionRevision: 4,
      tier: "project",
    });
  });

  it("threads an explicit global tier into the shared start path (R3.4)", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-global",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", tier: "global" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "global",
    });
  });

  it("maps a prerequisites-unmet rejection to a structured 409 with itemized details.missing and starts no loop (R6.2, R6.3)", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowPrerequisitesUnmetError(
        [
          { kind: "path", path: ".kiro", label: null, reason: "absent" },
          {
            kind: "skill",
            skill: "kiro-spec-init",
            backend: "codex",
            label: null,
            reason: "probe_error",
          },
        ],
        "Cannot start the workflow: 2 declared prerequisite(s) are unmet in the session worktree.",
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", tier: "global" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "prerequisites_unmet",
      details: {
        missing: [
          { kind: "path", path: ".kiro", reason: "absent" },
          {
            kind: "skill",
            skill: "kiro-spec-init",
            backend: "codex",
            reason: "probe_error",
          },
        ],
      },
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
  });

  it("maps a pending definition approval to a machine-readable 409 without starting or halting the loop", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowDefinitionApprovalRequiredError(
        "execution-review-1",
        "workflow-1",
        1,
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Workflow execution execution-review-1 was created and parked awaiting definition approval",
      code: "definition_approval_required",
      executionId: "execution-review-1",
      instruction:
        "Approve the pending workflow definition to resume execution execution-review-1.",
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
  });

  it("reports a parked start through the lifecycle port before returning the machine-readable 409", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowDefinitionApprovalRequiredError(
        "execution-review-2",
        "workflow-def-parked",
        4,
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-def-parked" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(awaitingDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-review-2",
      "workflow-def-parked",
      4,
    );
  });

  it("consults the registered admission gate before recording a definition approval and refuses machine-readably", async () => {
    const parkedExecution = createWorkflowExecution({
      id: "execution-parked",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
    admitDefinitionApproval.mockResolvedValue({
      ok: false,
      code: "revision_not_approved",
      unmetConditions: ["The pinned revision is no longer approved."],
      instruction: "Sign off the revision, then approve again.",
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: parkedExecution.id,
          definitionId: parkedExecution.seedDefinitionId,
          definitionRevision: parkedExecution.seedDefinitionRevision,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "revision_not_approved",
      unmetConditions: ["The pinned revision is no longer approved."],
      instruction: "Sign off the revision, then approve again.",
    });
    expect(admitDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-parked",
      "workflow-def-9",
      parkedExecution.seedDefinitionRevision,
    );
    // The refused approval records nothing and starts nothing.
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("refuses an unscoped HTTP definition approval body", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {},
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(400);
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
  });

  it("refuses an invalid execution contract before recording the spec-side approval admission", async () => {
    const parkedExecution = createWorkflowExecution({
      id: "execution-invalid-contract",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
    registerGraphExecutionContract({
      validateDefinition() {
        return {
          ok: false,
          code: "spec_dependency_embedding_invalid",
          issues: [
            {
              code: "spec-dependency-order-invalid",
              message: "T1 must precede T2.",
            },
          ],
          instruction: "Restore the declared task precedence.",
        };
      },
      validateLiveEdit() {
        return { ok: true };
      },
      validateTaskCompletion() {
        return { ok: true };
      },
      deriveContextAcceptanceCriteria() {
        return { ok: true, acceptanceCriteriaByContextId: {} };
      },
      deriveCriterionContextCoverage() {
        return {};
      },
    });

    await expect(
      handlers.approveDefinition({
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "session-1",
      }),
    ).rejects.toMatchObject({
      code: "spec_dependency_embedding_invalid",
    });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("records the approval when the admission gate admits the parked definition", async () => {
    const parkedExecution = createWorkflowExecution({
      id: "execution-parked-ok",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const approvedExecution = createWorkflowExecution({
      id: "execution-parked-ok",
      status: "running",
      seedDefinitionId: "workflow-def-9",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
    admitDefinitionApproval.mockResolvedValue({ ok: true });
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: approvedExecution,
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: parkedExecution.id,
          definitionId: parkedExecution.seedDefinitionId,
          definitionRevision: parkedExecution.seedDefinitionRevision,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(admitDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-parked-ok",
      "workflow-def-9",
      parkedExecution.seedDefinitionRevision,
    );
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: parkedExecution.id,
      expectedDefinitionId: parkedExecution.seedDefinitionId,
      expectedDefinitionRevision: parkedExecution.seedDefinitionRevision,
    });
  });

  it("reports whether the session's active execution awaits definition approval", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-probe",
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );

    await expect(
      handlers.hasPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).resolves.toBe("execution-probe");

    getSession.mockResolvedValue(makeSession());
    await expect(
      handlers.hasPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).resolves.toBeNull();

    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-decided",
          status: "running",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: "2026-03-27T12:05:00.000Z",
          },
        }),
      }),
    );
    await expect(
      handlers.hasPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).resolves.toBeNull();
  });

  it("does not report an unrelated parked definition as the expected pending definition", async () => {
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-unrelated",
          status: "pending",
          seedDefinitionId: "workflow-def-unrelated",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );

    await expect(
      handlers.hasPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
        expectedDefinitionId: "workflow-def-expected",
      }),
    ).resolves.toBeNull();
  });

  it("does not report another revision of the expected definition as pending", async () => {
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-revised",
          status: "pending",
          seedDefinitionId: "workflow-def-expected",
          seedDefinitionRevision: 4,
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );

    await expect(
      handlers.hasPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
        expectedDefinitionId: "workflow-def-expected",
        expectedDefinitionRevision: 3,
      }),
    ).resolves.toBeNull();
  });

  it("refuses the non-HTTP approval seam when the parked definition does not match the expected definition", async () => {
    const unrelatedParked = createWorkflowExecution({
      id: "execution-unrelated",
      status: "pending",
      seedDefinitionId: "workflow-def-unrelated",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const unrelatedApproved = createWorkflowExecution({
      id: "execution-unrelated",
      status: "running",
      seedDefinitionId: "workflow-def-unrelated",
    });
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: unrelatedParked }),
    );
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: unrelatedApproved,
    });

    const result = await handlers.approveDefinition({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      expectedDefinitionId: "workflow-def-expected",
    });

    expect(result).toEqual({ ok: false, reason: "definition_mismatch" });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("refuses approval when a different execution of the expected definition became active", async () => {
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-replacement",
          status: "pending",
          seedDefinitionId: "workflow-def-shared",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );

    const result = await handlers.approveDefinition({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-stale",
      expectedDefinitionId: "workflow-def-shared",
    });

    expect(result).toEqual({ ok: false, reason: "execution_mismatch" });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("binds an HTTP approval to the execution and definition shown to the human", async () => {
    const parkedExecution = createWorkflowExecution({
      id: "execution-visible",
      status: "pending",
      seedDefinitionId: "workflow-def-visible",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const approvedExecution = createWorkflowExecution({
      id: "execution-visible",
      status: "running",
      seedDefinitionId: "workflow-def-visible",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: approvedExecution,
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: "execution-visible",
          definitionId: "workflow-def-visible",
          definitionRevision: 1,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-visible",
      expectedDefinitionId: "workflow-def-visible",
      expectedDefinitionRevision: 1,
    });
  });

  it("approves a pending definition, reports the started run to the lifecycle port, and kicks off the loop", async () => {
    const approvedExecution = createWorkflowExecution({
      id: "execution-approved",
      status: "running",
      seedDefinitionId: "workflow-def-9",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: approvedExecution,
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: approvedExecution.id,
          definitionId: approvedExecution.seedDefinitionId,
          definitionRevision: approvedExecution.seedDefinitionRevision,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: approvedExecution.id,
      expectedDefinitionId: approvedExecution.seedDefinitionId,
      expectedDefinitionRevision: approvedExecution.seedDefinitionRevision,
    });
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-approved",
      "workflow-def-9",
      approvedExecution.seedDefinitionRevision,
    );
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: approvedExecution,
    });
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-approved", status: "running" },
    });
  });

  it("maps definition-approval guard failures without engaging the loop", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    recordDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "not_awaiting_approval",
    });

    const conflict = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: "execution-guarded",
          definitionId: "workflow-def-guarded",
          definitionRevision: 1,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(conflict.status).toBe(409);
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();

    recordDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "no_active_execution",
    });
    const missing = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        {
          executionId: "execution-guarded",
          definitionId: "workflow-def-guarded",
          definitionRevision: 1,
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(missing.status).toBe(404);
  });

  it("refuses agent-transport definition approval with a machine-readable human_act_required", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.APPROVE_DEFINITION(
      new NextRequest(
        "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        {
          method: "POST",
          headers: { authorization: "Bearer valid-agent-token" },
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      code?: string;
      instruction?: string;
    };
    expect(payload.code).toBe("human_act_required");
    expect(payload.instruction?.length).toBeGreaterThan(0);
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("rejects an invalid token on definition approval with 401", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.APPROVE_DEFINITION(
      new NextRequest(
        "http://localhost/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        { method: "POST", headers: { authorization: "Bearer wrong" } },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(401);
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
  });

  it("approves and starts through the non-HTTP definition-approval seam", async () => {
    const approvedExecution = createWorkflowExecution({
      id: "execution-seam-approved",
      status: "running",
      seedDefinitionId: "workflow-def-9",
    });
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: approvedExecution,
    });

    const result = await handlers.approveDefinition({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
    });

    expect(result).toMatchObject({ ok: true });
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
    });
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-seam-approved",
      "workflow-def-9",
      approvedExecution.seedDefinitionRevision,
    );
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: approvedExecution,
    });
  });

  it("reports definition-approval seam guard failures without engaging the loop", async () => {
    recordDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "not_awaiting_approval",
    });

    const result = await handlers.approveDefinition({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
    });

    expect(result).toEqual({ ok: false, reason: "not_awaiting_approval" });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("maps the active-execution guard error to a 409", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowStartGuardError(
        "active_execution",
        'Session "session-1" already has an active graph workflow execution',
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        'Session "session-1" already has an active graph workflow execution',
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("maps an execution-contract start refusal to a machine-readable 409", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new GraphExecutionContractViolationError({
        ok: false,
        code: "spec_dependency_embedding_invalid",
        issues: [
          {
            code: "spec-dependency-order-invalid",
            message: "T1 must precede T2.",
          },
        ],
        instruction: "Restore the declared task precedence.",
      }),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "spec_dependency_embedding_invalid",
      errors: [{ code: "spec-dependency-order-invalid" }],
      instruction: "Restore the declared task precedence.",
    });
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("maps the uncommitted-changes guard error to a structured 409", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowStartGuardError(
        "uncommitted_changes",
        "Cannot start the workflow while the session worktree has 2 uncommitted change(s). Workflow lanes are created from the committed branch, so uncommitted files would be missing. Commit your changes and try again.",
        [
          {
            path: ".kiro/specs/new-feature/requirements.md",
            statusCode: "??",
            tracked: false,
          },
          { path: "src/edited.ts", statusCode: " M", tracked: true },
        ],
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "uncommitted_changes",
      details: {
        totalCount: 2,
        paths: [".kiro/specs/new-feature/requirements.md", "src/edited.ts"],
      },
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("maps a start-input rejection to a 400 naming the offending parameter", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new WorkflowStartInputError(
        { kind: "missing_required", name: "ticket" },
        'Required parameter "ticket" was not supplied',
      ),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", parameters: {} },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("ticket");
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("maps a missing-definition error from the shared start path to a 404", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockRejectedValue(
      new Error('Workflow definition "workflow-1" was not found'),
    );

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Workflow definition "workflow-1" was not found',
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("records an execution_loop_failed halt reason when the kickoff promise rejects", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-loop-crash",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);
    kickOffExecutionLoop.mockRejectedValue(new Error("loop boom"));
    // The shared start path owns the active-execution guard now, so the handler
    // only reads getActiveExecution from the post-crash halt path, which finds
    // the just-started execution.
    getActiveExecution.mockReset();
    getActiveExecution.mockResolvedValue(startedExecution);
    recordPendingHaltReason.mockResolvedValue({
      execution: startedExecution,
      accepted: true,
    });
    drainAndHalt.mockResolvedValue({
      ...startedExecution,
      status: "halted",
    });

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(getActiveExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(recordPendingHaltReason).toHaveBeenCalledTimes(1);
    const haltCall = recordPendingHaltReason.mock.calls[0]?.[0] as {
      projectPath: string;
      sessionName: string;
      reason: { type: string; cause?: string; message?: string };
    };
    expect(haltCall.projectPath).toBe("/repo");
    expect(haltCall.sessionName).toBe("session-1");
    expect(haltCall.reason.type).toBe("execution_loop_failed");
    expect(haltCall.reason.cause).toBe("unknown");
    expect(haltCall.reason.message).toBe("loop boom");
    expect(drainAndHalt).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-loop-crash",
    });
  });

  it("skips halt recording on kickoff failure when no active execution exists", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-ghost",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(startedExecution);
    kickOffExecutionLoop.mockRejectedValue(new Error("loop boom"));
    getActiveExecution.mockResolvedValue(null);

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(getActiveExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
    expect(drainAndHalt).not.toHaveBeenCalled();
  });

  it("returns active status with interrupted task details and archived history summaries", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "paused",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "interrupted",
              summary: null,
              startedAt: "2026-03-27T12:05:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-1",
              failureMessage: null,
              failureHistory: [],
            },
          },
        }),
      }),
    );
    listArchivedExecutions.mockResolvedValue([
      createWorkflowExecution({
        id: "execution-history-1",
        status: "aborted",
        completedAt: "2026-03-27T11:00:00.000Z",
        haltReason: { type: "aborted", cause: null, summary: null },
      }),
    ]);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      execution: {
        executionId: "execution-1",
        definitionId: "workflow-1",
        definitionRevision: 1,
        status: "paused",
        startedAt: "2026-03-27T12:00:00.000Z",
        completedAt: null,
        activeContextIds: ["context-plan"],
        activeContextTitles: ["Plan"],
        activeBatchIds: [],
        activeJoinIds: [],
        haltReason: null,
        pendingHaltReason: null,
        contextMergeProgress: [],
        joinProgress: [],
        finalPublishState: null,
        archived: false,
      },
      archivedExecutions: [
        {
          executionId: "execution-history-1",
          definitionId: "workflow-1",
          definitionRevision: 1,
          status: "aborted",
          startedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T11:00:00.000Z",
          activeContextIds: [],
          activeContextTitles: [],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: { type: "aborted", cause: null, summary: null },
          pendingHaltReason: null,
          contextMergeProgress: [],
          joinProgress: [],
          finalPublishState: null,
          archived: true,
        },
      ],
    });
  });

  it("orders contextMergeProgress by activeContextIds, not workflow definition order", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-verify", "context-plan"],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "running",
              isolation: "worktree",
              branchName: "csm/session-1-context-plan",
              batchId: "batch-9",
              laneId: null,
              joinId: null,
              mergeStatus: "in-progress",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
            "context-verify": {
              ...baseExecution.contextStates["context-verify"]!,
              status: "running",
              isolation: "worktree",
              branchName: "csm/session-1-context-verify",
              batchId: "batch-9",
              laneId: null,
              joinId: null,
              mergeStatus: "pending",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        contextMergeProgress: Array<{ contextId: string }>;
      };
    };
    expect(json.execution.contextMergeProgress.map((m) => m.contextId)).toEqual(
      ["context-verify", "context-plan"],
    );
  });

  it("summarizes two simultaneously active contexts with mixed merge progress", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan", "context-implement"],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          contextStates: {
            ...baseExecution.contextStates,
            "context-plan": {
              ...baseExecution.contextStates["context-plan"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/session-1.context-plan",
              branchName: "csm/session-1-context-plan",
              batchId: "batch-1",
              laneId: null,
              joinId: null,
              mergeStatus: "in-progress",
              cleanupStatus: "pending",
              lastMergeError: null,
            },
            "context-implement": {
              ...baseExecution.contextStates["context-implement"]!,
              status: "running",
              isolation: "worktree",
              worktreePath: "/repo/.worktrees/session-1.context-implement",
              branchName: "csm/session-1-context-implement",
              batchId: "batch-1",
              laneId: null,
              joinId: null,
              mergeStatus: "merged-success",
              cleanupStatus: "removed",
              lastMergeError: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        activeContextIds: string[];
        activeContextTitles: string[];
        activeBatchIds: string[];
        contextMergeProgress: Array<{
          contextId: string;
          mergeStatus: string;
          cleanupStatus: string;
          branchName: string | null;
        }>;
      };
    };
    expect(json.execution.activeContextIds).toEqual([
      "context-plan",
      "context-implement",
    ]);
    expect(json.execution.activeContextTitles).toEqual(["Plan", "Implement"]);
    expect(json.execution.activeBatchIds).toEqual(["batch-1"]);
    expect(json.execution.contextMergeProgress).toEqual([
      {
        contextId: "context-plan",
        branchName: "csm/session-1-context-plan",
        mergeStatus: "in-progress",
        cleanupStatus: "pending",
        lastMergeError: null,
      },
      {
        contextId: "context-implement",
        branchName: "csm/session-1-context-implement",
        mergeStatus: "merged-success",
        cleanupStatus: "removed",
        lastMergeError: null,
      },
    ]);
  });

  it("exposes activeJoinIds and per-join progress so operators can see pending/running joins in the REST summary", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-implement"],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          joins: {
            "join-merge": {
              joinId: "join-merge",
              kind: "context_merge",
              contextId: "context-implement",
              targetLaneId: "lane-target",
              sourceLaneIds: ["lane-a", "lane-b"],
              mergedSourceLaneIds: ["lane-a"],
              validationDebtSourceLaneIds: [],
              status: "running",
              errorMessage: null,
              conflicts: null,
              conflictGuidance: null,
              createdAt: "2026-04-02T08:00:00.000Z",
              updatedAt: "2026-04-02T08:00:00.000Z",
              completedAt: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        activeJoinIds: string[];
        joinProgress: Array<{
          joinId: string;
          kind: string;
          contextId: string | null;
          targetLaneId: string;
          sourceLaneIds: string[];
          mergedSourceLaneIds: string[];
          status: string;
        }>;
      };
    };
    expect(json.execution.activeJoinIds).toEqual(["join-merge"]);
    expect(json.execution.joinProgress).toEqual([
      {
        joinId: "join-merge",
        kind: "context_merge",
        contextId: "context-implement",
        targetLaneId: "lane-target",
        sourceLaneIds: ["lane-a", "lane-b"],
        mergedSourceLaneIds: ["lane-a"],
        status: "running",
      },
    ]);
  });

  it("surfaces final publish state in the REST summary when a final_publish join is active", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const baseExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
    });
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: {
          ...baseExecution,
          joins: {
            "join-publish": {
              joinId: "join-publish",
              kind: "final_publish",
              contextId: null,
              targetLaneId: "__session__",
              sourceLaneIds: ["lane-plan"],
              mergedSourceLaneIds: [],
              validationDebtSourceLaneIds: [],
              status: "running",
              errorMessage: null,
              conflicts: null,
              conflictGuidance: null,
              createdAt: "2026-04-02T09:00:00.000Z",
              updatedAt: "2026-04-02T09:00:00.000Z",
              completedAt: null,
            },
          },
        },
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      execution: {
        activeJoinIds: string[];
        finalPublishState: {
          joinId: string;
          targetLaneId: string;
          sourceLaneIds: string[];
          mergedSourceLaneIds: string[];
          status: string;
        } | null;
      };
    };
    expect(json.execution.activeJoinIds).toEqual(["join-publish"]);
    expect(json.execution.finalPublishState).toEqual({
      joinId: "join-publish",
      targetLaneId: "__session__",
      sourceLaneIds: ["lane-plan"],
      mergedSourceLaneIds: [],
      status: "running",
    });
  });

  it("normalizes an in-flight iteration before returning status", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "running",
              summary: null,
              startedAt: "2026-03-27T12:05:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-1",
              failureMessage: null,
              failureHistory: [],
            },
          },
          machineSnapshot: {
            schemaVersion: 1,
            lifecycleStatus: "running",
            activeContextId: "context-plan",
            recoveryMode: "none",
            hasLiveIteration: true,
          },
        }),
      }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
        machineSnapshot: {
          schemaVersion: 1,
          lifecycleStatus: "paused",
          activeContextId: "context-plan",
          recoveryMode: "restart_normalized",
          hasLiveIteration: false,
        },
      }),
    );

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(normalizeExecutionAfterRestart).toHaveBeenCalledWith(
      "/repo",
      "session-1",
    );
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        status: "paused",
      },
    });
  });

  it("EXECUTION returns the raw active execution sourced via getActiveExecution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    const active = createWorkflowExecution({
      id: "execution-1",
      status: "running",
    });
    getActiveExecution.mockReset();
    getActiveExecution.mockResolvedValue(active);

    const response = await handlers.EXECUTION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/execution",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(getActiveExecution).toHaveBeenCalledWith("/repo", "session-1");
    await expect(response.json()).resolves.toEqual({ execution: active });
  });

  it("EXECUTION prefers the restart-normalized execution and returns null when absent", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    const normalized = createWorkflowExecution({
      id: "execution-normalized",
      status: "paused",
    });
    normalizeExecutionAfterRestart.mockResolvedValue(normalized);
    getActiveExecution.mockReset();
    getActiveExecution.mockResolvedValue(null);

    const present = await handlers.EXECUTION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/execution",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(normalizeExecutionAfterRestart).toHaveBeenCalledWith(
      "/repo",
      "session-1",
    );
    await expect(present.json()).resolves.toMatchObject({
      execution: { id: "execution-normalized" },
    });

    normalizeExecutionAfterRestart.mockResolvedValue(null);
    const absent = await handlers.EXECUTION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/execution",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    await expect(absent.json()).resolves.toEqual({ execution: null });
  });

  it("returns history items that include the current terminal execution for review", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-halted",
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
          activeContextIds: ["context-plan"],
          taskStates: {
            "task-plan-1": {
              taskId: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              status: "interrupted",
              summary: null,
              startedAt: "2026-03-27T13:10:00.000Z",
              completedAt: null,
              lastConversationId: "conversation-2",
              failureMessage: "validation blocked completion",
              failureHistory: [],
            },
          },
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "validator blocked completion",
            failureCount: 2,
          },
        }),
      }),
    );

    const response = await handlers.HISTORY(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/history",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          executionId: "execution-halted",
          definitionId: "workflow-1",
          definitionRevision: 1,
          status: "halted",
          startedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T13:30:00.000Z",
          activeContextIds: ["context-plan"],
          activeContextTitles: ["Plan"],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "validator blocked completion",
            failureCount: 2,
          },
          pendingHaltReason: null,
          contextMergeProgress: [],
          joinProgress: [],
          finalPublishState: null,
          archived: false,
        },
      ],
    });
  });

  it("maps pause, resume, and abort control routes to the workflow manager", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    pauseExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    abortExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "aborted",
        completedAt: "2026-03-27T12:10:00.000Z",
        haltReason: { type: "aborted", cause: null, summary: null },
      }),
    );

    const pauseResponse = await handlers.PAUSE(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/pause",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(pauseResponse.status).toBe(200);

    const resumeResponse = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(resumeResponse.status).toBe(200);

    const abortResponse = await handlers.ABORT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/abort",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(abortResponse.status).toBe(200);

    expect(pauseExecution).toHaveBeenCalledWith("/repo", "session-1");
    expect(resumeExecution).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      undefined,
    );
    expect(abortExecution).toHaveBeenCalledWith("/repo", "session-1");
  });

  it("returns a structured 409 when completion wins before pause", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    pauseExecution.mockRejectedValue(
      new GraphWorkflowTransitionConflictError(
        "pause",
        "completed",
        ["running"],
        "Only running graph workflow executions can be paused",
      ),
    );

    const response = await handlers.PAUSE(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/pause",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Only running graph workflow executions can be paused",
      code: "workflow_transition_conflict",
      details: {
        action: "pause",
        currentStatus: "completed",
        allowedStatuses: ["running"],
      },
    });
  });

  it("returns 409 without halt recovery when a pending execution cannot be resumed", async () => {
    const pendingExecution = createWorkflowExecution({
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: pendingExecution }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    resumeExecution.mockRejectedValue(
      new GraphWorkflowTransitionConflictError(
        "resume",
        "pending",
        ["paused", "halted"],
        "Only paused or halted graph workflow executions can be resumed",
      ),
    );

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
    expect(drainAndHalt).not.toHaveBeenCalled();
  });

  it("does not drain when a resume-loop failure loses a race to a non-running transition", async () => {
    const resumedExecution = createWorkflowExecution({ status: "running" });
    const concurrentlyPausedExecution = createWorkflowExecution({
      status: "paused",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: resumedExecution }),
    );
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    resumeExecution.mockResolvedValue(resumedExecution);
    kickOffExecutionLoop.mockRejectedValue(new Error("resume loop failed"));
    recordPendingHaltReason.mockResolvedValue({
      execution: concurrentlyPausedExecution,
      accepted: false,
    });

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    expect(recordPendingHaltReason).toHaveBeenCalledTimes(1);
    expect(drainAndHalt).not.toHaveBeenCalled();
  });

  it("does not report a failed loop against a replacement running execution", async () => {
    const failedExecution = createWorkflowExecution({
      id: "execution-failed",
      status: "running",
    });
    const replacementExecution = createWorkflowExecution({
      id: "execution-replacement",
      status: "running",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: failedExecution }),
    );
    getActiveExecution.mockResolvedValue(replacementExecution);
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    resumeExecution.mockResolvedValue(failedExecution);
    kickOffExecutionLoop.mockRejectedValue(new Error("failed loop"));

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    expect(recordPendingHaltReason).not.toHaveBeenCalled();
    expect(drainAndHalt).not.toHaveBeenCalled();
  });

  it("reports a successful abort to the execution lifecycle port", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    const abortedExecution = createWorkflowExecution({
      status: "aborted",
      completedAt: "2026-03-27T12:10:00.000Z",
      haltReason: { type: "aborted", cause: null, summary: null },
    });
    abortExecution.mockResolvedValue(abortedExecution);

    const response = await handlers.ABORT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/abort",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(executionAborted).toHaveBeenCalledWith(abortedExecution.id);
  });

  it("keeps a successful abort response when the lifecycle report fails", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    abortExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "aborted",
        completedAt: "2026-03-27T12:10:00.000Z",
        haltReason: { type: "aborted", cause: null, summary: null },
      }),
    );
    executionAborted.mockRejectedValue(new Error("consumer offline"));

    const response = await handlers.ABORT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/abort",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
  });

  it("threads conflict guidance from the resume body to the workflow manager", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({ status: "running" }),
    );

    const guidance = [
      { file: "src/foo.ts", decision: "rejected", feedback: "keep both" },
    ];
    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
        { conflictGuidance: guidance },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(200);
    expect(resumeExecution).toHaveBeenCalledWith("/repo", "session-1", {
      conflictGuidance: guidance,
    });
  });

  it("rejects a malformed resume body with 400", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
        { conflictGuidance: [{ file: "x", decision: "bogus" }] },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );
    expect(response.status).toBe(400);
    expect(resumeExecution).not.toHaveBeenCalled();
  });

  it("normalizes stale running executions before resuming them", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(
      createWorkflowExecution({
        status: "paused",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );
    resumeExecution.mockResolvedValue(
      createWorkflowExecution({
        status: "running",
        activeContextIds: ["context-plan"],
        taskStates: {
          "task-plan-1": {
            taskId: "task-plan-1",
            contextId: "context-plan",
            order: 1,
            status: "interrupted",
            summary: null,
            startedAt: "2026-03-27T12:05:00.000Z",
            completedAt: null,
            lastConversationId: "conversation-1",
            failureMessage: null,
            failureHistory: [],
          },
        },
      }),
    );

    const response = await handlers.RESUME(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/resume",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(normalizeExecutionAfterRestart).toHaveBeenCalledWith(
      "/repo",
      "session-1",
    );
    expect(resumeExecution).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      undefined,
    );
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: expect.objectContaining({
        status: "running",
        activeContextIds: ["context-plan"],
      }),
    });
  });

  it("clears a terminal execution by archiving it", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "tests failed",
            failureCount: 2,
          },
        }),
      }),
    );

    const response = await handlers.CLEAR(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/clear",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(archiveExecution).toHaveBeenCalledWith("/repo", "session-1");
  });

  it("stops lane dev servers before archiving on clear", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
          haltReason: {
            type: "circuit_breaker",
            contextId: "context-plan",
            condition: "retry_exhaustion",
            summary: "tests failed",
            failureCount: 2,
          },
        }),
      }),
    );

    await handlers.CLEAR(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/clear",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(stopExecutionLaneDevServers).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/repo" }),
    );
    expect(archiveExecution).toHaveBeenCalledWith("/repo", "session-1");
  });

  it("resets a selected context and returns the execution summary without kicking off the loop", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "paused",
          activeContextIds: ["context-implement"],
        }),
      }),
    );
    resetExecutionContext.mockResolvedValue(
      createWorkflowExecution({
        id: "execution-reset",
        status: "paused",
        activeContextIds: [],
      }),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-reset", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(resetExecutionContext).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      "context-implement",
    );
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        executionId: "execution-reset",
        status: "paused",
        activeContextIds: [],
        archived: false,
      },
    });
  });

  it("returns 400 when the reset-context request body is invalid", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(400);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("returns 409 when the workflow manager rejects a reset against a running execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "running",
        }),
      }),
    );
    resetExecutionContext.mockRejectedValue(
      new Error(
        "Reset only allowed when the workflow is paused or halted (current status: running).",
      ),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-reset", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
  });

  it("returns 409 when the request executionId does not match the active execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-current",
          status: "paused",
        }),
      }),
    );

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-stale", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("resets one validator assignment and reports the execution it left behind", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "halted",
        }),
      }),
    );
    resetExecutionContextAssignment.mockResolvedValue(
      createWorkflowExecution({ id: "execution-reset", status: "halted" }),
    );

    const response = await handlers.RESET_ASSIGNMENT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-assignment",
        "POST",
        {
          executionId: "execution-reset",
          contextId: "context-implement",
          assignmentId: "alpha",
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(resetExecutionContextAssignment).toHaveBeenCalledWith(
      "/repo",
      "session-1",
      "context-implement",
      "alpha",
    );
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-reset", status: "halted" },
    });
  });

  it("returns 400 when the reset-assignment request omits the assignment", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

    const response = await handlers.RESET_ASSIGNMENT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-assignment",
        "POST",
        { executionId: "execution-reset", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(400);
    expect(resetExecutionContextAssignment).not.toHaveBeenCalled();
  });

  it("returns 409 when a validator assignment reset targets a running execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-reset",
          status: "running",
        }),
      }),
    );
    resetExecutionContextAssignment.mockRejectedValue(
      new Error(
        "Resetting a validator assignment is only allowed when the workflow is paused or halted (current status: running).",
      ),
    );

    const response = await handlers.RESET_ASSIGNMENT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-assignment",
        "POST",
        {
          executionId: "execution-reset",
          contextId: "context-implement",
          assignmentId: "alpha",
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
  });

  it("returns 409 when a validator assignment reset names a stale execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-current",
          status: "halted",
        }),
      }),
    );

    const response = await handlers.RESET_ASSIGNMENT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-assignment",
        "POST",
        {
          executionId: "execution-stale",
          contextId: "context-implement",
          assignmentId: "alpha",
        },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(resetExecutionContextAssignment).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no active execution to reset", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession({ graphWorkflowExecution: null }));

    const response = await handlers.RESET_CONTEXT(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/reset-context",
        "POST",
        { executionId: "execution-current", contextId: "context-implement" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(404);
    expect(resetExecutionContext).not.toHaveBeenCalled();
  });

  it("rejects clearing a non-terminal execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          status: "running",
        }),
      }),
    );

    const response = await handlers.CLEAR(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/clear",
        "POST",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(archiveExecution).not.toHaveBeenCalled();
  });
});

describe("graph workflow resolve-approval route handler", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const GATED_CONTEXT_ID = "context-implement";
  const CONVERSATION_ID = "conv-gate-1";
  const NOW = "2026-06-10T10:00:00.000Z";
  const RESOLVE_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/resolve-approval";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  function unusedDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by RESOLVE_APPROVAL`);
    };
  }

  function buildHandlers() {
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
      eventPublisher: createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
        now: () => NOW,
      }),
    });
    const approvalGateService = createApprovalGateService({
      mutateActive: repository.mutateActive,
      now: () => NOW,
    });
    return createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      recordApprovalDecision: approvalGateService.recordDecision,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unusedDep("archiveExecution"),
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      getActiveExecution: unusedDep("getActiveExecution"),
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
    });
  }

  function buildGatedExecution(
    input: {
      executionStatus?: GraphWorkflowExecution["status"];
    } = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      status: input.executionStatus ?? "running",
    });
    const contextState = execution.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("fixture missing gated context");
    contextState.status = "awaiting_approval";
    contextState.pendingApproval = {
      conversationId: CONVERSATION_ID,
      requestedAt: "2026-06-10T09:00:00.000Z",
      decision: null,
    };
    return execution;
  }

  async function seedExecution(execution: GraphWorkflowExecution | null) {
    if (execution === null) return;
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedExecution",
      () => ({ execution, events: [] }),
    );
  }

  async function reloadGatedContext() {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const contextState = execution?.contextStates[GATED_CONTEXT_ID];
    if (!contextState) throw new Error("gated context missing after reload");
    return contextState;
  }

  function postResolveApproval(
    handlers: ReturnType<typeof buildHandlers>,
    body: unknown,
    params: Record<string, string> = { name: "repo", session: SESSION_NAME },
  ) {
    return handlers.RESOLVE_APPROVAL(
      makeRequest(RESOLVE_URL, "POST", body),
      makeContext(params),
    );
  }

  it("records an approval, returns the execution payload, and persists the decision", async () => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution());

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        executionId: "execution-1",
        status: "running",
        archived: false,
      },
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_approval");
    expect(reloaded.pendingApproval?.decision).toEqual({
      type: "approved",
      decidedAt: NOW,
    });
  });

  it("records a rejection with the trimmed message and persists it", async () => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution());

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "reject",
      message: "  Rename the endpoint to /v2  ",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-1" },
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toEqual({
      type: "rejected",
      message: "Rename the endpoint to /v2",
      decidedAt: NOW,
    });
  });

  it("returns 409 already_decided on a second decision and preserves the first", async () => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution());

    const first = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });
    expect(first.status).toBe(200);

    const second = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "reject",
      message: "Changed my mind",
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("already_decided");

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toEqual({
      type: "approved",
      decidedAt: NOW,
    });
  });

  it("returns 404 when the session has no active execution", async () => {
    const handlers = buildHandlers();
    await seedExecution(null);

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown project", async () => {
    const handlers = buildHandlers();

    const response = await postResolveApproval(
      handlers,
      { contextId: GATED_CONTEXT_ID, decision: "approve" },
      { name: "missing-project", session: SESSION_NAME },
    );

    expect(response.status).toBe(404);
  });

  it("returns 404 for an unknown session", async () => {
    const handlers = buildHandlers();

    const response = await postResolveApproval(
      handlers,
      { contextId: GATED_CONTEXT_ID, decision: "approve" },
      { name: "repo", session: "session-missing" },
    );

    expect(response.status).toBe(404);
  });

  it.each([
    [
      "reject without a message",
      { contextId: "context-implement", decision: "reject" },
    ],
    [
      "reject with a whitespace-only message",
      { contextId: "context-implement", decision: "reject", message: "   " },
    ],
    [
      "an unknown decision value",
      { contextId: "context-implement", decision: "maybe" },
    ],
    ["a missing contextId", { decision: "approve" }],
  ])("returns 400 for %s", async (_label, body) => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution());

    const response = await postResolveApproval(handlers, body);

    expect(response.status).toBe(400);
    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toBeNull();
  });

  it("returns 409 execution_not_running for an aborted execution and leaves state unchanged", async () => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution({ executionStatus: "aborted" }));

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("execution_not_running");

    const reloaded = await reloadGatedContext();
    expect(reloaded.pendingApproval?.decision).toBeNull();
  });

  it("returns 409 not_awaiting_approval when the context is not gated", async () => {
    const handlers = buildHandlers();
    const execution = createWorkflowExecution({ status: "running" });
    await seedExecution(execution);

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not_awaiting_approval");
  });

  it("records a deferred decision while the execution is paused", async () => {
    const handlers = buildHandlers();
    await seedExecution(buildGatedExecution({ executionStatus: "paused" }));

    const response = await postResolveApproval(handlers, {
      contextId: GATED_CONTEXT_ID,
      decision: "approve",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-1", status: "paused" },
    });

    const reloaded = await reloadGatedContext();
    expect(reloaded.status).toBe("awaiting_approval");
    expect(reloaded.pendingApproval?.decision).toEqual({
      type: "approved",
      decidedAt: NOW,
    });
  });
});

describe("graph workflow route script validator service", () => {
  it("maps session and config state into the script validator runner input", async () => {
    const getSession = vi.fn(async () =>
      makeSession({
        worktreePath: "/repo/.worktrees/session-1",
        branchName: "csm/session-1",
      }),
    );
    const readConfig = vi.fn(async () => ({
      preMergeTimeoutMs: 123_000,
    }));
    const runScriptValidator = vi.fn(async () => ({ kind: "pass" as const }));

    const service = createGraphWorkflowRouteScriptValidatorService({
      getSession,
      readConfig,
      runScriptValidator,
    });

    const execution = createWorkflowExecution({
      id: "execution-script-1",
      status: "running",
    });
    const context = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === "context-plan",
    );
    if (!context) throw new Error("context-plan fixture missing");
    context.scriptValidator = {
      commands: ["typecheck", "test"],
    };
    const signal = new AbortController().signal;

    const result = await service.runScriptValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      signal,
    });

    expect(result).toEqual({ kind: "pass" });
    expect(getSession).toHaveBeenCalledWith("/repo", "session-1");
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(runScriptValidator).toHaveBeenCalledWith({
      projectPath: "/repo",
      worktreePath: "/repo/.worktrees/session-1",
      sessionName: "session-1",
      branchName: "csm/session-1",
      executionId: "execution-script-1",
      contextId: "context-plan",
      // Solo context (no executionTarget): scope against the session's own
      // merge target, since it runs on the session branch itself.
      targetBranch: "main",
      timeoutMs: 123_000,
      commands: ["typecheck", "test"],
      signal,
    });
  });

  it("scopes a worktree-isolated context against the session branch (its fan-in target)", async () => {
    const getSession = vi.fn(async () =>
      makeSession({
        worktreePath: "/repo/.worktrees/session-1",
        branchName: "csm/session-1",
        targetBranch: "main",
      }),
    );
    const readConfig = vi.fn(async () => ({ preMergeTimeoutMs: 123_000 }));
    const runScriptValidator = vi.fn(async () => ({ kind: "pass" as const }));

    const service = createGraphWorkflowRouteScriptValidatorService({
      getSession,
      readConfig,
      runScriptValidator,
    });

    const execution = createWorkflowExecution({
      id: "execution-script-1",
      status: "running",
    });

    await service.runScriptValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      executionTarget: {
        worktreePath: "/repo/.worktrees/session-1.context-plan",
        branchName: "csm/session-1-context-plan",
        isolation: "worktree",
        laneId: null,
      },
    });

    expect(runScriptValidator).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: "csm/session-1" }),
    );
  });
});

// -- Implementer runner wiring: unified executePromptStream path ---------------
// These tests exercise the same wiring pattern used by execution-route-handlers.ts
// to wire implementer turns through createGraphWorkflowImplementerRunner, verifying
// that both Claude and Codex backends use executePromptStream and that no
// implementer-only in-memory resume cache is needed.

import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import {
  createGraphWorkflowIterationOrchestrator,
  type GraphWorkflowRunAgentIterationInput,
} from "@/lib/workflow-graph/iteration-orchestrator";
import { createResolvedWorkflowDefinition } from "./test-fixtures";
function createCodexWorkflowExecution(): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: [
      {
        id: "context-codex",
        title: "Codex Implement",
        acceptanceCriteria: "TBD",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          profileSnapshot: makeProfileSnapshot(),
          agent: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
          },
        },
        contextValidator: { enabled: false, assignments: [] },
        scriptValidator: { commands: [] },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      },
    ],
    tasks: [
      {
        id: "task-codex-1",
        contextId: "context-codex",
        order: 1,
        title: "Build feature",
        instructions: "Implement the feature.",
        source: "user",
      },
    ],
    edges: [],
  });

  return createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-codex"],
    workingDefinition: definition,
    contextStates: {
      "context-codex": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "context-codex",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-codex-1": {
        taskId: "task-codex-1",
        contextId: "context-codex",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
  });
}

describe("implementer runner wiring (unified executePromptStream path)", () => {
  it("codex implementer turns flow through executePromptStream without a resume cache", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conv-codex-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    }));
    const implementerRunner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => ({
        backendRef: {
          backend: "codex" as const,
          threadId: "thread-codex-1",
        },
      })) as never,
    });

    const execution = createCodexWorkflowExecution();
    let activeExecution = execution;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: {
        async getActive() {
          return activeExecution;
        },
        async mutateActive(_p, _s, fn) {
          const result = await fn(structuredClone(activeExecution));
          activeExecution =
            "execution" in result && "events" in result
              ? result.execution
              : result;
          return activeExecution;
        },
      },
      findLatestContextValidationEvent: async () => null,
      createConversation: vi.fn(async () => ({ id: "conv-codex-1" })),
      createToolServer: vi.fn(() => ({ server: { servers: [] } })),
      // Wire runAgentIteration the same way execution-route-handlers.ts does
      async runAgentIteration(input: GraphWorkflowRunAgentIterationInput) {
        return implementerRunner.runIteration({
          projectPath: input.projectPath,
          session: makeSession(),
          prompt: input.prompt,
          conversationId: input.conversationId,
          executionId: input.executionId,
          contextId: input.contextId,
          backend: input.backend,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          toolServer: input.toolServer,
        });
      },
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-codex",
    });

    // executePromptStream must be called with codex backend — no task runner fallback
    expect(executePromptStream).toHaveBeenCalledWith(
      expect.anything(), // projectPath
      expect.anything(), // session
      expect.anything(), // prompt
      expect.anything(), // emit
      expect.anything(), // conversationId
      "gpt-5.4-mini", // modelId
      undefined, // images
      expect.objectContaining({ backend: "codex", autonomous: true }),
    );
  });

  it("consecutive codex implementer turns each go through executePromptStream (no in-memory cache)", async () => {
    let callCount = 0;
    const executePromptStream = vi.fn(async () => {
      callCount++;
      return {
        conversationId: `conv-codex-${callCount}`,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });
    const implementerRunner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => ({
        backendRef: {
          backend: "codex" as const,
          threadId: "thread-codex-seeded",
        },
      })) as never,
    });

    const execution = createCodexWorkflowExecution();
    let activeExecution = execution;

    const orchestrator = createGraphWorkflowIterationOrchestrator({
      executionRepository: {
        async getActive() {
          return activeExecution;
        },
        async mutateActive(_p, _s, fn) {
          const result = await fn(structuredClone(activeExecution));
          activeExecution =
            "execution" in result && "events" in result
              ? result.execution
              : result;
          return activeExecution;
        },
      },
      findLatestContextValidationEvent: async () => null,
      createConversation: vi.fn(async () => ({ id: "conv-codex-1" })),
      createToolServer: vi.fn(() => ({ server: { servers: [] } })),
      async runAgentIteration(input: GraphWorkflowRunAgentIterationInput) {
        return implementerRunner.runIteration({
          projectPath: input.projectPath,
          session: makeSession(),
          prompt: input.prompt,
          conversationId: input.conversationId,
          executionId: input.executionId,
          contextId: input.contextId,
          backend: input.backend,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          toolServer: input.toolServer,
        });
      },
      now: () => "2026-03-27T16:00:00.000Z",
    });

    await orchestrator.runIteration({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      contextId: "context-codex",
    });

    // Initial call + 2 follow-ups = 3 calls, all through executePromptStream.
    // Each call proves no in-memory resume cache is used — the runner delegates
    // every turn to executePromptStream rather than caching a backend ref.
    expect(executePromptStream).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(executePromptStream).toHaveBeenNthCalledWith(
        i + 1,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "gpt-5.4-mini",
        undefined,
        expect.objectContaining({ backend: "codex", autonomous: true }),
      );
    }
  });
});

describe("launchGraphWorkflowExecution (production start+kickoff seam)", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";

  function makeSeamDeps(
    overrides: Partial<GraphWorkflowExecutionRouteDeps> = {},
  ): GraphWorkflowExecutionRouteDeps {
    const unused = (name: string) => {
      return async (): Promise<never> => {
        throw new Error(
          `${name} should not be called by the start+kickoff seam`,
        );
      };
    };
    return {
      resolveProjectPath: unused("resolveProjectPath"),
      getSession: unused("getSession"),
      normalizeExecutionAfterRestart: unused("normalizeExecutionAfterRestart"),
      startExecution: unused("startExecution"),
      pauseExecution: unused("pauseExecution"),
      resumeExecution: unused("resumeExecution"),
      abortExecution: unused("abortExecution"),
      resetExecutionContext: unused("resetExecutionContext"),
      resetExecutionContextAssignment: unused(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unused("archiveExecution"),
      kickOffExecutionLoop: unused("kickOffExecutionLoop"),
      getActiveExecution: unused("getActiveExecution"),
      recordPendingHaltReason: unused("recordPendingHaltReason"),
      drainAndHalt: unused("drainAndHalt"),
      recordApprovalDecision: unused("recordApprovalDecision"),
      ...overrides,
    };
  }

  it("calls startExecution with the supplied parameters, kicks off the loop, and returns the started execution", async () => {
    const started = createWorkflowExecution({
      id: "execution-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => started);
    const kickOffExecutionLoop = vi.fn(async () => {});

    const result = await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        parameters: { ticket: "CC-42" },
      },
      makeSeamDeps({ startExecution, kickOffExecutionLoop }),
    );

    expect(result).toBe(started);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
      parameters: { ticket: "CC-42" },
    });
    // Kickoff is fire-and-forget; flush microtasks so the queued call lands.
    await Promise.resolve();
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      execution: started,
    });
  });

  it("marks a linked spec execution running before kicking off the workflow loop", async () => {
    const started = createWorkflowExecution({
      id: "execution-lifecycle",
      status: "running",
    });
    const calls: string[] = [];
    const startExecution = vi.fn(async () => {
      calls.push("start");
      return started;
    });
    const markRunning = vi.fn(async () => {
      calls.push("mark-running");
    });
    const kickOffExecutionLoop = vi.fn(async () => {
      calls.push("kickoff");
    });

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
      },
      makeSeamDeps({ startExecution, markRunning, kickOffExecutionLoop }),
    );

    // The started definition id rides along so the lifecycle consumer can
    // correlate the run with work it prepared under that definition.
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-lifecycle",
      started.seedDefinitionId,
      started.seedDefinitionRevision,
    );
    expect(calls).toEqual(["start", "mark-running", "kickoff"]);
  });

  it("starts a zero-input launch without forwarding a parameters key", async () => {
    const started = createWorkflowExecution({
      id: "execution-zero",
      status: "running",
    });
    const startExecution = vi.fn(async () => started);
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-static",
      },
      makeSeamDeps({ startExecution, kickOffExecutionLoop }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-static",
    });
  });

  it("propagates a guard error without kicking off the loop", async () => {
    const startExecution = vi.fn(async () => {
      throw new WorkflowStartGuardError(
        "active_execution",
        'Session "session-1" already has an active graph workflow execution',
      );
    });
    const kickOffExecutionLoop = vi.fn(async () => {});

    await expect(
      launchGraphWorkflowExecution(
        {
          projectPath: PROJECT_PATH,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          definitionId: "wf-1",
        },
        makeSeamDeps({ startExecution, kickOffExecutionLoop }),
      ),
    ).rejects.toBeInstanceOf(WorkflowStartGuardError);

    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("propagates an input error without kicking off the loop", async () => {
    const startExecution = vi.fn(async () => {
      throw new WorkflowStartInputError(
        { kind: "missing_required", name: "env" },
        'Required parameter "env" was not supplied',
      );
    });
    const kickOffExecutionLoop = vi.fn(async () => {});

    await expect(
      launchGraphWorkflowExecution(
        {
          projectPath: PROJECT_PATH,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          definitionId: "wf-1",
        },
        makeSeamDeps({ startExecution, kickOffExecutionLoop }),
      ),
    ).rejects.toBeInstanceOf(WorkflowStartInputError);

    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("propagates a not-found error without kicking off the loop", async () => {
    const startExecution = vi.fn(async () => {
      throw new Error('Workflow definition "nope" was not found');
    });
    const kickOffExecutionLoop = vi.fn(async () => {});

    await expect(
      launchGraphWorkflowExecution(
        {
          projectPath: PROJECT_PATH,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          definitionId: "nope",
        },
        makeSeamDeps({ startExecution, kickOffExecutionLoop }),
      ),
    ).rejects.toThrow('Workflow definition "nope" was not found');

    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });
});

describe("buildLaneIterationToolServer (Phase 3 lane MCP detachment)", () => {
  it("attaches no in-process CC MCP server to new lane conversations", () => {
    const toolServer = buildLaneIterationToolServer();
    const config = toolServer.server as PortableMcpConfig;

    // The lane tools are now the `cctl workflow …` verbs, so a freshly spawned
    // lane conversation's transient tool server carries no server entries.
    expect(config.servers).toEqual([]);
  });

  it("is a no-op when merged into a conversation's portable-MCP config", () => {
    // Mirrors compose's mergeTransientLast contract: an empty transient adds
    // nothing, so a lane spawn cannot re-introduce an in-process CC server.
    const server = buildLaneIterationToolServer().server as PortableMcpConfig;
    expect(server.servers.length).toBe(0);
  });
});

describe("graph workflow events route — paginated ledger mode (D4 R16.2)", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const EXECUTION_ID = "execution-1";
  const EVENTS_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/events";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  function unusedDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by EVENTS`);
    };
  }

  /**
   * The route over the REAL page reader: the events land through the same
   * mutation seam production uses, so the cursor the route hands back is the
   * repository's own keyset cursor rather than a shape invented at the edge.
   */
  function buildHandlers() {
    return createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      getActiveExecution: async () => null,
      getEventsTail: fixture.store.getGraphWorkflowEventsTail,
      getEventsPage: fixture.store.getGraphWorkflowEventsPage,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unusedDep("archiveExecution"),
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      recordDefinitionApproval: unusedDep("recordDefinitionApproval"),
      markRunning: unusedDep("markRunning"),
      awaitingDefinitionApproval: unusedDep("awaitingDefinitionApproval"),
      admitDefinitionApproval: unusedDep("admitDefinitionApproval"),
      executionAborted: unusedDep("executionAborted"),
      stopExecutionLaneDevServers: unusedDep("stopExecutionLaneDevServers"),
      listArchivedExecutions: unusedDep("listArchivedExecutions"),
    });
  }

  async function seedEvents(count: number): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedEvents",
      () => ({
        execution: createWorkflowExecution({ status: "running" }),
        events: Array.from({ length: count }, (_, index) => ({
          occurredAt: `2026-08-04T00:00:0${index}.000Z`,
          preReset: false,
          event: {
            type: "graph-workflow-context-status" as const,
            projectName: "repo",
            sessionName: SESSION_NAME,
            executionId: EXECUTION_ID,
            contextId: `ctx-${index}`,
            status: "running" as const,
            remainingTaskCount: 1,
            iterationCount: 1,
          },
        })),
      }),
    );
  }

  function get(url: string) {
    return buildHandlers().EVENTS(
      makeRequest(url, "GET"),
      makeContext({ name: "repo", session: SESSION_NAME }),
    );
  }

  it("walks the full log through the cursor the previous page returned", async () => {
    await seedEvents(5);

    const first = await get(
      `${EVENTS_URL}?executionId=${EXECUTION_ID}&page=true&limit=2`,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(
      firstBody.events.map((row: { seq: number }) => row.seq),
    ).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.events[1].seq);
    expect(firstBody.events[0].event.contextId).toBe("ctx-0");

    const seen: string[] = firstBody.events.map(
      (row: { event: { contextId: string } }) => row.event.contextId,
    );
    let cursor: number | null = firstBody.nextCursor;
    while (cursor !== null) {
      const next = await get(
        `${EVENTS_URL}?executionId=${EXECUTION_ID}&page=true&limit=2&cursor=${cursor}`,
      );
      const body = await next.json();
      seen.push(
        ...body.events.map(
          (row: { event: { contextId: string } }) => row.event.contextId,
        ),
      );
      cursor = body.nextCursor;
    }

    expect(seen).toEqual(["ctx-0", "ctx-1", "ctx-2", "ctx-3", "ctx-4"]);
  });

  it("reads newest-first when asked, and leaves the tail mode untouched", async () => {
    await seedEvents(3);

    const desc = await get(
      `${EVENTS_URL}?executionId=${EXECUTION_ID}&page=true&limit=2&direction=desc`,
    );
    const descBody = await desc.json();
    expect(
      descBody.events.map(
        (row: { event: { contextId: string } }) => row.event.contextId,
      ),
    ).toEqual(["ctx-2", "ctx-1"]);

    // No `page` param: the historical tail contract, with no cursor field and
    // no `seq` on the rows.
    const tail = await get(`${EVENTS_URL}?executionId=${EXECUTION_ID}`);
    const tailBody = await tail.json();
    expect(tailBody.nextCursor).toBeUndefined();
    expect(tailBody.events).toHaveLength(3);
    expect(tailBody.events[0].seq).toBeUndefined();
  });

  it("falls back to the default page size when the limit is unusable", async () => {
    await seedEvents(3);

    for (const limit of ["0", "-4", "abc"]) {
      const response = await get(
        `${EVENTS_URL}?executionId=${EXECUTION_ID}&page=true&limit=${limit}`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        nextCursor: null,
      });
    }
  });

  it("returns an empty page when the session has no execution", async () => {
    const response = await get(`${EVENTS_URL}?page=true`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });
});
