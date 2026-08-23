import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionOrigin,
} from "@/lib/workflow-graph/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createApprovalGateService } from "./approval-gate";
import { criterionRecordsOf } from "./criteria/criterion-records";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  createWorkflowLayout,
  makeProfileSnapshot,
} from "./test-fixtures";
import {
  buildLaneIterationToolServer,
  createGraphWorkflowExecutionRouteHandlers,
  createGraphWorkflowRouteScriptValidatorService,
  createGraphWorkflowRouteValidationRoundService,
  launchGraphWorkflowExecution,
  OWNER_CONVERSATION_HEADER,
  type GraphWorkflowExecutionRouteDeps,
  type GraphWorkflowRouteValidationRoundServiceDeps,
} from "./execution-route-handlers";
import {
  CONVERSATION_CAPABILITY_HEADER,
  mintConversationCapability,
  verifyConversationCapability,
  type ConversationCapabilityVerification,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_HEADER,
  mintLaneCapability,
  verifyLaneCapability,
} from "@/lib/agent-gateway/lane-capability";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { CandidateScope } from "@/lib/git/diff";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type {
  DefinitionApprovalGateDecision,
  GraphExecutionLifecycleContext,
} from "./execution-lifecycle-port";
import {
  createGraphWorkflowManager,
  GraphWorkflowTransitionConflictError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
} from "./workflow-manager";
import {
  GraphExecutionContractViolationError,
  registerGraphExecutionContract,
  resetGraphExecutionContractForTesting,
} from "./execution-contract-port";
import { assertExecutionPrincipalFence } from "./principal-fence";
import type { GlobalConfig } from "@/lib/config/schemas";

function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
  });
}

function makeConversation(id: string): ConversationState {
  return conversationStateSchema.parse({
    id,
    scope: "session",
    transcriptPath: null,
    status: "idle",
    promptCount: 1,
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    agentBackend: "claude",
  });
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

/**
 * The launch outcome a manager returns for a run that BEGAN. Both launch verbs
 * answer with this shape, so a route test says which disposition it is
 * exercising rather than implying "started" by returning a bare execution.
 */
function acceptedLaunch(execution: GraphWorkflowExecution) {
  return { execution, awaitingDefinitionApproval: false };
}

/** The launch outcome for a run parked awaiting definition approval. */
function parkedLaunch(execution: GraphWorkflowExecution) {
  return { execution, awaitingDefinitionApproval: true };
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

function makeGlobalConfig(): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        timeoutMs: 60_000,
      },
    },
    defaultAgentBackend: "claude",
  };
}

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
  const runExecution = vi.fn();
  const launchSpecDeliveryExecution = vi.fn();
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
  const claimDefinitionApproval = vi.fn();
  const releaseDefinitionApprovalClaim = vi.fn();
  const markRunning = vi.fn(async () => {});
  const awaitingDefinitionApproval = vi.fn(async () => {});
  const executionAborted = vi.fn(async () => {});
  const admitDefinitionApproval = vi.fn<
    (
      context: GraphExecutionLifecycleContext,
      workflowExecutionId: string,
      origin: GraphWorkflowExecutionOrigin,
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
    runExecution,
    launchSpecDeliveryExecution,
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
    claimDefinitionApproval,
    releaseDefinitionApprovalClaim,
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
    // The approval act's reservation admits by default; tests that exercise a
    // losing race override it. Derived from the session fixture rather than
    // from getActiveExecution so a test's `mockResolvedValueOnce` chain on the
    // latter is not consumed here.
    claimDefinitionApproval.mockImplementation(
      async (input: { projectPath: string; sessionName: string }) => {
        const session = await getSession(input.projectPath, input.sessionName);
        const active = session?.graphWorkflowExecution ?? null;
        return active === null
          ? { ok: false, reason: "no_active_execution" }
          : { ok: true, execution: active };
      },
    );
    releaseDefinitionApprovalClaim.mockResolvedValue({ ok: true });
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
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

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
    const cleanBody = await response.json();
    expect(cleanBody).toMatchObject({
      execution: {
        executionId: "execution-active",
        status: "running",
        archived: false,
      },
    });
    expect(cleanBody.receipt).not.toHaveProperty("warnings");
  });

  it("returns committed-source warnings on an accepted saved-definition start", async () => {
    const warning = {
      path: "definition.charter.sourcesOfTruth.0.locator",
      message:
        'lint/source-locator-unresolvable: source is absent for session "session-1" on branch "csm/session-1" at commit launch-sha',
    };
    const startedExecution = createWorkflowExecution({
      id: "execution-source-warning",
      status: "running",
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue({
      ...acceptedLaunch(startedExecution),
      warnings: [warning],
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
    await expect(response.json()).resolves.toMatchObject({
      receipt: { status: "running", warnings: [warning] },
    });
  });

  it("ignores a caller-supplied conversation header, which is a claim rather than authority", async () => {
    // START used to take this header as the execution owner. The header is
    // exactly as forgeable as typing an id: every sibling conversation and
    // every lane can send it, and a session-membership check passes for all of
    // them. Ownership now comes only from a signature, so an unsigned caller
    // launches UNOWNED rather than as whoever it named (R9.4).
    const startedExecution = createWorkflowExecution({
      id: "execution-owned",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ conversations: [makeConversation("conv-owner")] }),
    );
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
        { [OWNER_CONVERSATION_HEADER]: "conv-owner" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "project",
    });
  });

  it("ignores an owner id supplied in the request body", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-forged",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ conversations: [makeConversation("conv-owner")] }),
    );
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1", ownerConversationId: "conv-forged" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(202);
    // No header, so there is no authenticated capture: the body's claim is not
    // a source of owner identity at all.
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "project",
    });
  });

  it("refuses to capture a conversation that does not belong to the session", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-unowned",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ conversations: [makeConversation("conv-owner")] }),
    );
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

    const response = await handlers.START(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "POST",
        { definitionId: "workflow-1" },
        { [OWNER_CONVERSATION_HEADER]: "conv-from-another-session" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    // The launch still proceeds — it is an ordinary unowned start — but the
    // unverifiable claim never becomes an owner.
    expect(response.status).toBe(202);
    expect(startExecution).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      definitionId: "workflow-1",
      tier: "project",
    });
  });

  it("threads supplied parameters into the shared start path on a parameterized start", async () => {
    const startedExecution = createWorkflowExecution({
      id: "execution-param",
      status: "running",
    });

    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

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
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

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
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));

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

  it("accepts a parked start as a 202 receipt rather than a refusal, without starting or halting the loop", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(
      parkedLaunch(
        createWorkflowExecution({
          id: "execution-review-1",
          status: "pending",
          seedDefinitionId: "workflow-1",
          seedDefinitionRevision: 1,
        }),
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

    // The park is an ACCEPTED launch (D7 R14, decision D1): the caller reads a
    // receipt, not a refusal it has to decode as a success.
    expect(response.status).toBe(202);
    const parkedBody = await response.json();
    expect(parkedBody.receipt).toMatchObject({
      executionId: "execution-review-1",
      status: "awaiting_definition_approval",
      origin: { kind: "template", definitionId: "workflow-1" },
    });
    expect(parkedBody.receipt).not.toHaveProperty("warnings");
    expect(parkedBody.code).toBeUndefined();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
  });

  it("keeps source warnings on a parked saved-definition start", async () => {
    const warning = {
      path: "definition.charter.sourcesOfTruth.0.locator",
      message:
        'lint/source-locator-unresolvable: source is absent for session "session-1" on branch "csm/session-1" at commit parked-sha',
    };
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue({
      ...parkedLaunch(
        createWorkflowExecution({
          id: "execution-warning-parked",
          status: "pending",
          seedDefinitionId: "workflow-1",
        }),
      ),
      warnings: [warning],
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
    await expect(response.json()).resolves.toMatchObject({
      receipt: {
        status: "awaiting_definition_approval",
        warnings: [warning],
      },
    });
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("reports a parked start through the lifecycle port before returning the accepted receipt", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    startExecution.mockResolvedValue(
      parkedLaunch(
        createWorkflowExecution({
          id: "execution-review-2",
          status: "pending",
          seedDefinitionId: "workflow-def-parked",
          seedDefinitionRevision: 4,
        }),
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

    expect(response.status).toBe(202);
    expect(awaitingDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-review-2",
      {
        kind: "template",
        definitionId: "workflow-def-parked",
        definitionRevision: 4,
        tier: "project",
      },
    );
  });

  it("leaves a gate-refused park exactly as it found it, still approvable", async () => {
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
        { executionId: parkedExecution.id },
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
      parkedExecution.origin,
    );
    // The refusal's remedy is "sign off, then approve again", so the act must
    // undo its own reservation and leave the approval UNRECORDED: a finalized
    // approval would make that remedy a lie and hand the run to a resume that
    // never consults the gate at all.
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(releaseDefinitionApprovalClaim).toHaveBeenCalledWith(
      expect.objectContaining({ expectedExecutionId: "execution-parked" }),
    );
    expect(recordPendingHaltReason).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("reserves the park, admits it, then finalizes the approval", async () => {
    // The saga's whole point (charter `reserve-before-side-effects`): the
    // reservation is the arbiter, the gate's durable admission is a
    // reservation-holder-only effect, and only an admitted act finalizes.
    const parkedExecution = createWorkflowExecution({
      id: "execution-order",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const approvedExecution = createWorkflowExecution({
      id: "execution-order",
      status: "running",
      seedDefinitionId: "workflow-def-9",
    });
    const order: string[] = [];
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
    claimDefinitionApproval.mockImplementation(async () => {
      order.push("claim");
      return { ok: true, execution: parkedExecution };
    });
    admitDefinitionApproval.mockImplementation(async () => {
      order.push("admit");
      return { ok: true };
    });
    recordDefinitionApproval.mockImplementation(async () => {
      order.push("record");
      return { ok: true, execution: approvedExecution };
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedExecution.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["claim", "admit", "record"]);
    expect(releaseDefinitionApprovalClaim).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).toHaveBeenCalled();
  });

  it("keeps the reservation when the finalize refuses behind an admitted gate", async () => {
    // Past the admission the consumer's records are durable, so a finalize that
    // refuses may no longer hand the park back: releasing here would let the
    // next rejection end a run the gate has already admitted.
    const parkedExecution = createWorkflowExecution({
      id: "execution-late-finalize",
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
    admitDefinitionApproval.mockResolvedValue({ ok: true });
    recordDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "claim_superseded",
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedExecution.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(releaseDefinitionApprovalClaim).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("performs no admission-gate write when the reservation loses", async () => {
    // A rejection (or another approval) reserved the park first. The losing act
    // never reaches the gate, so it leaves no durable admission behind for a
    // run it did not decide.
    const parkedExecution = createWorkflowExecution({
      id: "execution-lost-race",
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
    claimDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "decision_in_flight",
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedExecution.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(409);
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(releaseDefinitionApprovalClaim).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
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
      loadLiveEdit() {
        return {
          validateOperation: () => ({ ok: true }),
          accountabilityCoverageGroups: [],
        };
      },
      validateTaskCompletion() {
        return { ok: true };
      },
      deriveContextAcceptanceCriteria() {
        return { ok: true, acceptanceCriteriaByContextId: {} };
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
    // A pure verdict on bytes already in hand refuses ahead of the reservation,
    // so an unapprovable plan never leaves a reservation to clean up.
    expect(claimDefinitionApproval).not.toHaveBeenCalled();
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
        { executionId: parkedExecution.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(admitDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-parked-ok",
      parkedExecution.origin,
    );
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: parkedExecution.id,
    });
  });

  it("runs the same admission act for a parked one-off, addressed by execution and origin", async () => {
    const parkedOneOff = createWorkflowExecution({
      id: "execution-one-off-parked",
      status: "pending",
      origin: { kind: "one_off", planName: "Inline repair plan" },
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedOneOff }),
    );
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: createWorkflowExecution({
        id: "execution-one-off-parked",
        status: "running",
        origin: { kind: "one_off", planName: "Inline repair plan" },
      }),
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedOneOff.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    // ONE lifecycle act for both origins: the gate is consulted for a one-off
    // exactly as for a template, addressed by execution identity and the
    // recorded origin. What a consumer DOES with a one-off — correlate it by
    // definition or not — is its own decision, downstream of that origin.
    expect(admitDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      parkedOneOff.id,
      { kind: "one_off", planName: "Inline repair plan" },
    );
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: parkedOneOff.id,
    });
    expect(kickOffExecutionLoop).toHaveBeenCalled();
  });

  it("refuses a one-off approval the admission gate declines", async () => {
    const parkedOneOff = createWorkflowExecution({
      id: "execution-one-off-refused",
      status: "pending",
      origin: { kind: "one_off", planName: "Inline repair plan" },
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedOneOff }),
    );
    admitDefinitionApproval.mockResolvedValue({
      ok: false,
      code: "gate_blocked",
      unmetConditions: ["The linked spec execution is terminal (abandoned)."],
      instruction: "Start a new delivery instead.",
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedOneOff.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    // A gate that can refuse a template park refuses a one-off park too, or
    // the two origins are not running the same act.
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "gate_blocked",
    });
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(releaseDefinitionApprovalClaim).toHaveBeenCalledWith(
      expect.objectContaining({ expectedExecutionId: parkedOneOff.id }),
    );
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("answers a one-off approval with a receipt that names no definition", async () => {
    const parkedOneOff = createWorkflowExecution({
      id: "execution-one-off-receipt",
      status: "pending",
      origin: { kind: "one_off", planName: "Inline repair plan" },
      seedDefinitionId: "one-off:execution-one-off-receipt",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedOneOff }),
    );
    recordDefinitionApproval.mockResolvedValue({
      ok: true,
      execution: createWorkflowExecution({
        id: "execution-one-off-receipt",
        status: "running",
        origin: { kind: "one_off", planName: "Inline repair plan" },
        seedDefinitionId: "one-off:execution-one-off-receipt",
      }),
    });

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: parkedOneOff.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      execution: {
        executionId: "execution-one-off-receipt",
        status: "running",
        origin: { kind: "one_off", planName: "Inline repair plan" },
      },
    });
    // The seed fields on a one-off row are compatibility filler, not identity:
    // an act addressed by execution id alone may not answer with a definition
    // the run does not have.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("definitionId");
    expect(serialized).not.toContain("definitionRevision");
    expect(serialized).not.toContain("one-off:");
  });

  it("reports the parked execution and the origin it recorded", async () => {
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

    // The origin rides along because the caller has to establish WHICH run
    // holds the session's park before deciding it.
    await expect(
      handlers.findPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).resolves.toEqual({
      executionId: "execution-probe",
      origin: {
        kind: "template",
        definitionId: "workflow-1",
        definitionRevision: 1,
        tier: "project",
      },
    });

    getSession.mockResolvedValue(makeSession());
    await expect(
      handlers.findPendingDefinitionApproval({
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
      handlers.findPendingDefinitionApproval({
        projectPath: "/repo",
        sessionName: "session-1",
      }),
    ).resolves.toBeNull();
  });

  it("refuses approval when a different execution became active", async () => {
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
    });

    expect(result).toEqual({ ok: false, reason: "execution_mismatch" });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });

  it("refuses an approval body naming a workflow definition instead of the execution", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());

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

    expect(response.status).toBe(400);
    expect(recordDefinitionApproval).not.toHaveBeenCalled();
  });

  it("binds an HTTP approval to the execution shown to the human", async () => {
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
        { executionId: "execution-visible" },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-visible",
    });
  });

  it("approves a pending definition, reports the started run to the lifecycle port, and kicks off the loop", async () => {
    const parkedExecution = createWorkflowExecution({
      id: "execution-approved",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const approvedExecution = createWorkflowExecution({
      id: "execution-approved",
      status: "running",
      seedDefinitionId: "workflow-def-9",
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
        { executionId: approvedExecution.id },
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: approvedExecution.id,
    });
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-approved",
      approvedExecution.origin,
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
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-guarded",
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );
    recordDefinitionApproval.mockResolvedValue({
      ok: false,
      reason: "not_awaiting_approval",
    });

    const conflict = await handlers.APPROVE_DEFINITION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition",
        "POST",
        { executionId: "execution-guarded" },
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
        { executionId: "execution-guarded" },
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
    const parkedExecution = createWorkflowExecution({
      id: "execution-seam-approved",
      status: "pending",
      seedDefinitionId: "workflow-def-9",
      definitionApproval: {
        requestedAt: "2026-03-27T12:00:00.000Z",
        approvedAt: null,
      },
    });
    const approvedExecution = createWorkflowExecution({
      id: "execution-seam-approved",
      status: "running",
      seedDefinitionId: "workflow-def-9",
    });
    getSession.mockResolvedValue(
      makeSession({ graphWorkflowExecution: parkedExecution }),
    );
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
    // Even a caller that named no run finalizes against the run it reserved:
    // the reservation is what fixes the act's subject.
    expect(recordDefinitionApproval).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      expectedExecutionId: "execution-seam-approved",
    });
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-seam-approved",
      approvedExecution.origin,
    );
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
      execution: approvedExecution,
    });
  });

  it("reports definition-approval seam guard failures without engaging the loop", async () => {
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-seam-guarded",
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-03-27T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
    );
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

  it("maps the lease-held guard error to a 409 forwarding the blocker verbatim", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    const blocker = {
      executionId: "incumbent-1",
      status: "halted" as const,
      origin: { kind: "one_off" as const, planName: "Ship the search box" },
      originConversationId: "conv-origin",
      remedy: "resume_or_abandon" as const,
      deepLink: "/projects/repo/session-1/workflow?execution=incumbent-1",
    };
    startExecution.mockRejectedValue(
      new WorkflowStartGuardError(
        "active_execution",
        'Session "session-1" already has an active graph workflow execution',
        { blocker },
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
      code: "lease_held",
      details: blocker,
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
        {
          dirtyPaths: [
            {
              path: ".kiro/specs/new-feature/requirements.md",
              statusCode: "??",
              tracked: false,
            },
            { path: "src/edited.ts", statusCode: " M", tracked: true },
          ],
        },
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

  // R1.3 wants the refusal LOCATED, not merely worded. The path must point at
  // the field the caller actually wrote, which on START is `parameters`.
  it("locates a start-input rejection at the parameters field the caller sent", async () => {
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
    await expect(response.json()).resolves.toMatchObject({
      code: "missing_required",
      issues: [{ path: "parameters.ticket" }],
    });
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
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));
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
    startExecution.mockResolvedValue(acceptedLaunch(startedExecution));
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

  /**
   * STATUS reports Current, so Current there is the same LEASE projection it is
   * on EXECUTION and History (D7 decision D4) — a settled run still physically
   * occupying the active row holds nothing, and reporting it as Current is what
   * made a finished run render as the live one.
   *
   * Nothing disappears: the same row is what History carries it as, so this
   * asserts both halves. A projection that only hid it would trade one wrong
   * answer for a worse one.
   */
  it.each([
    { name: "completed", overrides: { status: "completed" as const } },
    {
      name: "non-resumably halted",
      overrides: {
        status: "halted" as const,
        haltReason: { type: "recovery_error" as const, message: "dead" },
      },
    },
    {
      name: "abandoned",
      overrides: {
        status: "halted" as const,
        haltReason: {
          type: "circuit_breaker" as const,
          contextId: "context-plan",
          condition: "retry_exhaustion" as const,
          summary: null,
        },
        abandonment: {
          abandonedAt: "2026-03-27T13:00:00.000Z",
          actor: { kind: "human" as const },
          reason: "superseded",
        },
      },
    },
  ])(
    "STATUS reports a lease-free $name row as history, not Current",
    async ({ overrides }) => {
      resolveProjectPath.mockResolvedValue("/repo");
      getSession.mockResolvedValue(makeSession());
      const settled = createWorkflowExecution({
        id: "execution-settled",
        ...overrides,
      });
      normalizeExecutionAfterRestart.mockResolvedValue(null);
      getActiveExecution.mockReset();
      getActiveExecution.mockResolvedValue(settled);
      listArchivedExecutions.mockResolvedValue([]);

      const response = await handlers.STATUS(
        makeRequest(
          "/api/projects/repo/sessions/session-1/graph-workflow",
          "GET",
        ),
        makeContext({ name: "repo", session: "session-1" }),
      );

      const body: unknown = await response.json();
      expect(body).toMatchObject({ execution: null });
      expect(
        body !== null &&
          typeof body === "object" &&
          "archivedExecutions" in body &&
          Array.isArray(body.archivedExecutions)
          ? body.archivedExecutions.map(
              (entry: { executionId: string }) => entry.executionId,
            )
          : [],
      ).toEqual(["execution-settled"]);
    },
  );

  it("STATUS still reports a resumably halted row as Current", async () => {
    // The counterpart: a resumable halt DOES hold the lease, so hiding it would
    // strand the run with no surface to resume it from.
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(makeSession());
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    getActiveExecution.mockReset();
    getActiveExecution.mockResolvedValue(
      createWorkflowExecution({
        id: "execution-resumable",
        status: "halted",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          summary: null,
        },
      }),
    );
    listArchivedExecutions.mockResolvedValue([]);

    const response = await handlers.STATUS(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-resumable" },
      archivedExecutions: [],
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

  it("does not present a lease-free active row as Current", async () => {
    // Current is a LEASE projection, not a row-position one (D7 decision D4).
    // A settled run awaiting normalization is still physically in the active
    // row, but it holds nothing — returning it as Current is what let the panel
    // render a finished run as the live one and drop it from History.
    resolveProjectPath.mockResolvedValue("/repo");
    normalizeExecutionAfterRestart.mockResolvedValue(null);
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-done",
          status: "completed",
          completedAt: "2026-03-27T13:30:00.000Z",
        }),
      }),
    );

    const response = await handlers.EXECUTION(
      makeRequest(
        "/api/projects/repo/sessions/session-1/graph-workflow/execution",
        "GET",
      ),
      makeContext({ name: "repo", session: "session-1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ execution: null });
  });

  it("returns the lease-free execution still in the active row as history", async () => {
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
          // A NON-resumable halt: it holds nothing, so it is historical from
          // the moment it settles even though normalization has not yet moved
          // it out of the active row (R4.2, R3.3).
          haltReason: {
            type: "recovery_error",
            message: "unrecoverable",
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
            type: "recovery_error",
            message: "unrecoverable",
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

  it("keeps a resumably halted run out of history because it is still Current", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue(
      makeSession({
        graphWorkflowExecution: createWorkflowExecution({
          id: "execution-halted",
          status: "halted",
          completedAt: "2026-03-27T13:30:00.000Z",
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
    await expect(response.json()).resolves.toEqual({ items: [] });
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
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unusedDep("archiveExecution"),
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      // Read to authorize the caller, not to decide: the decision still
      // resolves its own execution inside the approval-gate service's
      // serialized mutation.
      getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
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
      approvalScope: { kind: "whole_tree" },
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

describe("graph workflow approval-snapshot route handler", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const GATED_CONTEXT_ID = "context-implement";
  const SNAPSHOT_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/approval-snapshot";

  const SCOPED_PAYLOAD = {
    kind: "scoped" as const,
    snapshot: {
      contextId: GATED_CONTEXT_ID,
      ownedPaths: ["src/api"],
      treeHash: "owned-digest",
      diff: {
        files: [
          {
            filePath: "src/api/handler.ts",
            additions: 1,
            deletions: 0,
            hunks: [],
          },
        ],
        totalAdditions: 1,
        totalDeletions: 0,
      },
    },
  };

  function unusedDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by APPROVAL_SNAPSHOT`);
    };
  }

  function buildHandlers(overrides: {
    activeExecution?: GraphWorkflowExecution | null;
    resolveApprovalSnapshot?: GraphWorkflowExecutionRouteDeps["resolveApprovalSnapshot"];
  }) {
    return createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: async () =>
        makeSession({ worktreePath: "/repo/.worktrees/session-1" }),
      getActiveExecution: async () => overrides.activeExecution ?? null,
      ...(overrides.resolveApprovalSnapshot
        ? { resolveApprovalSnapshot: overrides.resolveApprovalSnapshot }
        : {}),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
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
    });
  }

  function getSnapshot(
    handlers: ReturnType<typeof buildHandlers>,
    query = `?contextId=${GATED_CONTEXT_ID}`,
  ) {
    return handlers.APPROVAL_SNAPSHOT(
      makeRequest(`${SNAPSHOT_URL}${query}`, "GET"),
      makeContext({ name: "repo", session: SESSION_NAME }),
    );
  }

  it("serves the owned-path-scoped change set as the approval payload", async () => {
    const resolveApprovalSnapshot = vi.fn(async () => SCOPED_PAYLOAD);
    const handlers = buildHandlers({
      activeExecution: createWorkflowExecution({ status: "running" }),
      resolveApprovalSnapshot,
    });

    const response = await getSnapshot(handlers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SCOPED_PAYLOAD);
    // Read from the CONTEXT's substrate, with the session worktree only as the
    // fallback the resolver applies when the context has no lane of its own.
    expect(resolveApprovalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: GATED_CONTEXT_ID,
        sessionWorktreePath: "/repo/.worktrees/session-1",
      }),
    );
  });

  it("passes a drifted verdict through instead of substituting a fresh read", async () => {
    const drifted = {
      kind: "drifted" as const,
      contextId: GATED_CONTEXT_ID,
      frozenTreeHash: "owned-digest",
      observedTreeHash: "owned-digest-moved",
    };
    const handlers = buildHandlers({
      activeExecution: createWorkflowExecution({ status: "running" }),
      resolveApprovalSnapshot: vi.fn(async () => drifted),
    });

    const response = await getSnapshot(handlers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(drifted);
  });

  it("forwards the gate identity the caller is rendering", async () => {
    const resolveApprovalSnapshot = vi.fn(async () => SCOPED_PAYLOAD);
    const handlers = buildHandlers({
      activeExecution: createWorkflowExecution({ status: "running" }),
      resolveApprovalSnapshot,
    });

    await getSnapshot(
      handlers,
      `?contextId=${GATED_CONTEXT_ID}&requestedAt=${encodeURIComponent("2026-06-10T09:00:00.000Z")}`,
    );

    expect(resolveApprovalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAt: "2026-06-10T09:00:00.000Z" }),
    );
  });

  it("404s for a superseded gate rather than answering with another gate's bytes", async () => {
    const handlers = buildHandlers({
      activeExecution: createWorkflowExecution({ status: "running" }),
      resolveApprovalSnapshot: vi.fn(async () => ({
        kind: "gate_superseded" as const,
      })),
    });

    expect((await getSnapshot(handlers)).status).toBe(404);
  });

  it("rejects a request with no contextId", async () => {
    const handlers = buildHandlers({
      activeExecution: createWorkflowExecution({ status: "running" }),
      resolveApprovalSnapshot: unusedDep("resolveApprovalSnapshot"),
    });

    expect((await getSnapshot(handlers, "")).status).toBe(400);
  });

  it("404s when the session has no active execution", async () => {
    const handlers = buildHandlers({
      activeExecution: null,
      resolveApprovalSnapshot: unusedDep("resolveApprovalSnapshot"),
    });

    expect((await getSnapshot(handlers)).status).toBe(404);
  });

  it.each([
    { kind: "unknown_context" } as const,
    { kind: "not_awaiting_approval" } as const,
  ])(
    "404s on $kind rather than answering with a change set",
    async (resolution) => {
      const handlers = buildHandlers({
        activeExecution: createWorkflowExecution({ status: "running" }),
        resolveApprovalSnapshot: vi.fn(async () => resolution),
      });

      expect((await getSnapshot(handlers)).status).toBe(404);
    },
  );
});

describe("graph workflow route validation round service", () => {
  const wholeTree: CandidateScope = { mode: "wholeTree" };
  const ownedByA: CandidateScope = { mode: "owned", ownedPaths: ["src/a"] };

  function makeService(
    overrides: Partial<GraphWorkflowRouteValidationRoundServiceDeps> = {},
  ) {
    return createGraphWorkflowRouteValidationRoundService({
      getSession: async () => makeSession(),
      readHeadSha: async () => "head-sha-1",
      computeCandidateIdentity: async () => "identity-1",
      ...overrides,
    });
  }

  it("reads the identity under the scope the caller asked for, in the context's own worktree", async () => {
    const computeCandidateIdentity = vi.fn(async () => "owned-digest-1");
    const readHeadSha = vi.fn(async () => "head-sha-1");
    const service = makeService({ computeCandidateIdentity, readHeadSha });

    const resolution = await service.resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-a",
      candidateScope: ownedByA,
      executionTarget: {
        isolation: "worktree",
        worktreePath: "/repo/.worktrees/lane-impl",
        branchName: "csm/session-1-lane-impl",
        laneId: "impl",
      },
    });

    expect(resolution).toEqual({
      kind: "resolved",
      identityScope: "owned",
      headSha: "head-sha-1",
      candidateTreeHash: "owned-digest-1",
    });
    expect(computeCandidateIdentity).toHaveBeenCalledWith(
      "/repo/.worktrees/lane-impl",
      ownedByA,
    );
    expect(readHeadSha).toHaveBeenCalledWith("/repo/.worktrees/lane-impl");
  });

  it("marks a whole-tree read as such so the two identity forms never compare", async () => {
    const resolution = await makeService().resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-a",
      candidateScope: wholeTree,
    });

    expect(resolution).toEqual({
      kind: "resolved",
      identityScope: "wholeTree",
      headSha: "head-sha-1",
      candidateTreeHash: "identity-1",
    });
  });

  it("reports unavailability rather than a partial identity", async () => {
    const noIdentity = await makeService({
      computeCandidateIdentity: async () => null,
    }).resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-a",
      candidateScope: ownedByA,
    });
    expect(noIdentity.kind).toBe("unavailable");

    const noHead = await makeService({
      readHeadSha: async () => null,
    }).resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-a",
      candidateScope: wholeTree,
    });
    expect(noHead.kind).toBe("unavailable");

    const noSession = await makeService({
      getSession: async () => null,
    }).resolveCandidateTree({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-a",
      candidateScope: wholeTree,
    });
    expect(noSession.kind).toBe("unavailable");
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
        placement: { lane: "context-codex", mode: "full" as const },
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
        consecutiveCandidateMismatchCount: 0,
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
          placement: { lane: "build", mode: "full" },
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
          placement: { lane: "build", mode: "full" },
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
      runExecution: unused("runExecution"),
      launchSpecDeliveryExecution: unused("launchSpecDeliveryExecution"),
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
    const startExecution = vi.fn(async () => acceptedLaunch(started));
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

  it("threads the caller-supplied owner conversation into the shared start path", async () => {
    const started = createWorkflowExecution({
      id: "execution-owned-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        ownerConversationId: "conv-planner",
      },
      makeSeamDeps({ startExecution, kickOffExecutionLoop }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
      ownerConversationId: "conv-planner",
    });
  });

  it("omits the owner entirely when the calling seam has no conversation identity", async () => {
    const started = createWorkflowExecution({
      id: "execution-unowned-seam",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
    const kickOffExecutionLoop = vi.fn(async () => {});

    await launchGraphWorkflowExecution(
      {
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        definitionId: "wf-1",
        ownerConversationId: null,
      },
      makeSeamDeps({ startExecution, kickOffExecutionLoop }),
    );

    expect(startExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      definitionId: "wf-1",
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
      return acceptedLaunch(started);
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

    // The recorded origin rides along so the lifecycle consumer can correlate
    // the run with work it prepared — by definition revision for a template
    // launch, and by nothing it has to invent for a one-off.
    expect(markRunning).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-lifecycle",
      started.origin,
    );
    expect(calls).toEqual(["start", "mark-running", "kickoff"]);
  });

  it("starts a zero-input launch without forwarding a parameters key", async () => {
    const started = createWorkflowExecution({
      id: "execution-zero",
      status: "running",
    });
    const startExecution = vi.fn(async () => acceptedLaunch(started));
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
});

describe("lifecycle contract: production slot auto-release", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";
  const NOW = "2026-06-10T10:00:00.000Z";
  const ABORT_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/abort";
  const START_URL = "/api/projects/repo/sessions/session-1/graph-workflow";

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
      throw new Error(`${name} should not be called by this flow`);
    };
  }

  /**
   * Real repository + real manager over the real (in-memory SQLite) store, with
   * the production route handlers on top. The slot is the persisted
   * `graph_workflow_executions` active row, so "the slot is free" can only be
   * proven by reading the store back — a JS fake would prove nothing about
   * durability.
   */
  function buildStack(
    overrides: Partial<GraphWorkflowExecutionRouteDeps> = {},
  ) {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
      now: () => NOW,
    });
    const repository = createGraphWorkflowExecutionRepository({
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
      eventPublisher,
    });
    // Two distinct spies on purpose. The manager already stops lane dev servers
    // inside its abort/halt transitions, so a shared spy could not tell the
    // release's own cleanup apart from the manager's — and completion, the one
    // transition with no manager-side cleanup, is exactly where the gap is.
    const managerStopLaneDevServers = vi.fn(async () => {});
    const releaseStopLaneDevServers = vi.fn(async () => {});
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now: () => NOW,
      stopExecutionLaneDevServers: managerStopLaneDevServers,
    });
    const handlers = createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: (projectPath, sessionName) =>
        manager.send(projectPath, sessionName, { type: "abort" }),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: repository.archiveActive,
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      getActiveExecution: repository.getActive,
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      executionAborted: async () => {},
      stopExecutionLaneDevServers: releaseStopLaneDevServers,
      ...overrides,
    });
    return {
      handlers,
      manager,
      repository,
      managerStopLaneDevServers,
      releaseStopLaneDevServers,
    };
  }

  async function seedActive(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedActive",
      () => ({ execution, events: [] }),
    );
  }

  function readActive(): Promise<GraphWorkflowExecution | null> {
    return fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
  }

  /**
   * The kickoff is fire-and-forget on every launch surface, so the completion
   * auto-release lands after the route has already answered. Poll the store
   * rather than the handler's response.
   */
  async function waitForFreeSlot(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readActive()) === null) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("slot was still held after the execution settled");
  }

  function runningExecution(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      id: "execution-live",
      status: "running",
      activeContextIds: ["context-plan"],
      ...overrides,
    });
  }

  it("frees the slot after the production abort route, archiving the run", async () => {
    const { handlers } = buildStack();
    await seedActive(runningExecution());

    const response = await handlers.ABORT(
      makeRequest(ABORT_URL, "POST"),
      makeContext({ name: PROJECT_NAME, session: SESSION_NAME }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-live", status: "aborted" },
    });
    // The whole point of auto-release: no separate clear act is needed.
    expect(await readActive()).toBeNull();
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived.map((entry) => entry.id)).toEqual(["execution-live"]);
  });

  it("frees the slot identically when a run reaches completed", async () => {
    const seeded = runningExecution({ id: "execution-finishing" });
    const stack = buildStack({
      startExecution: async () => acceptedLaunch(seeded),
      // Stands in for the execution loop: the graph runs out of work and the
      // manager records the terminal `completed` transition.
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "complete",
        });
      },
    });
    await seedActive(seeded);

    const response = await stack.handlers.START(
      makeRequest(START_URL, "POST", { definitionId: "workflow-1" }),
      makeContext({ name: PROJECT_NAME, session: SESSION_NAME }),
    );

    expect(response.status).toBe(202);
    await waitForFreeSlot();
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived.map((entry) => entry.status)).toEqual(["completed"]);
  });

  it("leaves a halted run holding the slot for resume", async () => {
    const stack = buildStack({
      startExecution: async () =>
        acceptedLaunch(runningExecution({ id: "execution-halting" })),
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "halt",
          reason: {
            type: "max_iterations",
            contextId: "context-plan",
            iterationCount: 1,
            summary: null,
          },
        });
      },
    });
    await seedActive(runningExecution({ id: "execution-halting" }));

    const response = await stack.handlers.START(
      makeRequest(START_URL, "POST", { definitionId: "workflow-1" }),
      makeContext({ name: PROJECT_NAME, session: SESSION_NAME }),
    );
    expect(response.status).toBe(202);

    // `halted` retains ownership: it is resumable, so releasing the slot would
    // admit unrelated work and race the resume.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const active = await readActive();
      if (active?.status === "halted") break;
    }
    const active = await readActive();
    expect(active?.status).toBe("halted");
    expect(active?.id).toBe("execution-halting");
  });

  it("stops lane dev servers when a completed run releases the slot", async () => {
    const laneExecution = runningExecution({ id: "execution-laned" });
    const planState = laneExecution.contextStates["context-plan"];
    if (!planState) throw new Error("fixture missing context-plan");
    planState.isolation = "worktree";
    planState.worktreePath = "/repo/.worktrees/session-1--lane-plan";

    const stack = buildStack({
      startExecution: async () => acceptedLaunch(laneExecution),
      kickOffExecutionLoop: async () => {
        await stack.manager.send(PROJECT_PATH, SESSION_NAME, {
          type: "complete",
        });
      },
    });
    await seedActive(laneExecution);

    await stack.handlers.START(
      makeRequest(START_URL, "POST", { definitionId: "workflow-1" }),
      makeContext({ name: PROJECT_NAME, session: SESSION_NAME }),
    );
    await waitForFreeSlot();

    // Completion is the one terminal transition the manager runs no dev-server
    // cleanup for — CLEAR was the backstop that caught it. Auto-release takes
    // CLEAR out of the operator's hands, so the release has to carry the
    // backstop or a finished run leaks its lane servers.
    expect(stack.managerStopLaneDevServers).not.toHaveBeenCalled();
    expect(stack.releaseStopLaneDevServers).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_PATH,
        execution: expect.objectContaining({ id: "execution-laned" }),
      }),
    );
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
});

describe("graph workflow execution by-id and result routes", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";
  const EXECUTION_ID = "execution-by-id";
  const BY_ID_URL = `/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/graph-workflow/executions/${EXECUTION_ID}`;
  const RESULT_URL = `${BY_ID_URL}/result`;

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
      throw new Error(`${name} should not be called by a by-id read`);
    };
  }

  function buildHandlers(store = fixture.store) {
    return createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: store.getSession,
      getActiveExecution: store.getActiveGraphWorkflowExecution,
      getExecutionById: store.getGraphWorkflowExecutionById,
      getBoundaryResultAfter: store.getGraphWorkflowBoundaryResultAfter,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
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
    });
  }

  function routeContext(executionId = EXECUTION_ID) {
    return makeContext({
      name: PROJECT_NAME,
      session: SESSION_NAME,
      executionId,
    });
  }

  async function persistExecution(execution: GraphWorkflowExecution) {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.by-id",
      () => ({ execution, events: [] }),
    );
  }

  it("returns a running Current row, a terminal physical Current row, and an archived History row through one schema", async () => {
    const handlers = buildHandlers();
    const running = createWorkflowExecution({
      id: EXECUTION_ID,
      status: "running",
    });
    await persistExecution(running);

    const runningResponse = await handlers.EXECUTION_BY_ID(
      makeRequest(BY_ID_URL, "GET"),
      routeContext(),
    );
    expect(runningResponse.status).toBe(200);
    expect(await runningResponse.json()).toEqual({ execution: running });

    const completed = createWorkflowExecution({
      ...running,
      status: "completed",
      completedAt: "2026-08-14T12:00:00.000Z",
    });
    await persistExecution(completed);
    const terminalResponse = await handlers.EXECUTION_BY_ID(
      makeRequest(BY_ID_URL, "GET"),
      routeContext(),
    );
    expect(await terminalResponse.json()).toEqual({ execution: completed });

    await fixture.store.archiveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const historyResponse = await handlers.EXECUTION_BY_ID(
      makeRequest(BY_ID_URL, "GET"),
      routeContext(),
    );
    expect(await historyResponse.json()).toEqual({ execution: completed });
  });

  it("returns not found when the execution id is outside the route scope", async () => {
    const execution = createWorkflowExecution({ id: EXECUTION_ID });
    await persistExecution(execution);
    const response = await buildHandlers().EXECUTION_BY_ID(
      makeRequest(`${BY_ID_URL}-other`, "GET"),
      routeContext(`${EXECUTION_ID}-other`),
    );

    expect(response.status).toBe(404);
  });

  it("returns only the first boundary after a cursor across archival and restart", async () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-08-14T12:00:00.000Z",
    });
    const running = createWorkflowExecution({
      id: EXECUTION_ID,
      status: "running",
      ownerConversationId: "conv-origin",
    });
    await persistExecution(running);
    const paused = createWorkflowExecution({ ...running, status: "paused" });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.pause-boundary",
      () => ({
        execution: paused,
        events: publisher.publishExecutionUpdate({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          previousExecution: running,
          nextExecution: paused,
        }).events,
      }),
    );
    const halted = createWorkflowExecution({ ...running, status: "halted" });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.halt-boundary",
      () => ({
        execution: halted,
        events: publisher.publishExecutionUpdate({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          previousExecution: running,
          nextExecution: halted,
        }).events,
      }),
    );

    const firstResponse = await buildHandlers().EXECUTION_RESULT(
      makeRequest(RESULT_URL, "GET"),
      routeContext(),
    );
    const first = await firstResponse.json();
    expect(first.result).toMatchObject({
      executionId: EXECUTION_ID,
      boundaryKind: "pause",
      status: "paused",
    });

    await fixture.store.archiveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const restarted = fixture.recreateStore();
    const nextResponse = await buildHandlers(restarted).EXECUTION_RESULT(
      makeRequest(`${RESULT_URL}?cursor=${first.result.cursor}`, "GET"),
      routeContext(),
    );
    expect(await nextResponse.json()).toMatchObject({
      result: {
        executionId: EXECUTION_ID,
        boundaryKind: "halt",
        status: "halted",
      },
    });
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
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
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

/**
 * The inline launch route (D7 R1, R2, R14; decision D1).
 *
 * RUN accepts the SAME document dialect `workflow validate`/`create` accept
 * plus a distinct inputs document, and refuses a bad plan through the same
 * accept-time gate BEFORE anything is persisted. These tests hold the route to
 * both halves: an accepted launch reaches the shared manager launch source with
 * the parsed plan and nothing else, and a refused one never reaches it at all.
 */
describe("graph workflow RUN route — inline one-off launch", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const RUN_URL = "/api/projects/repo/sessions/session-1/graph-workflow/run";

  const runExecution = vi.fn();
  const kickOffExecutionLoop = vi.fn(async () => {});
  const markRunning = vi.fn(async () => {});
  const awaitingDefinitionApproval = vi.fn(async () => {});

  function unusedDep(name: string) {
    return async (): Promise<never> => {
      throw new Error(`${name} should not be called by RUN`);
    };
  }

  function buildHandlers(
    session: SessionState = makeSession(),
    verifyCapability: (
      request: Request,
    ) => Promise<ConversationCapabilityVerification> = async () => ({
      kind: "absent",
    }),
  ) {
    return createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name: string) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: async () => session,
      getActiveExecution: async () => null,
      verifyConversationCapability: verifyCapability,
      runExecution,
      kickOffExecutionLoop,
      markRunning,
      awaitingDefinitionApproval,
      readRepoConfig: async () => null,
      readConfig: async () => makeGlobalConfig(),
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: unusedDep("archiveExecution"),
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      recordDefinitionApproval: unusedDep("recordDefinitionApproval"),
      admitDefinitionApproval: unusedDep("admitDefinitionApproval"),
      executionAborted: unusedDep("executionAborted"),
      stopExecutionLaneDevServers: unusedDep("stopExecutionLaneDevServers"),
      listArchivedExecutions: unusedDep("listArchivedExecutions"),
    } satisfies GraphWorkflowExecutionRouteDeps);
  }

  function makePlan(definition = createWorkflowDefinition()) {
    return {
      name: "Inline analysis",
      description: "A one-off plan authored mid-conversation",
      definition,
      layout: createWorkflowLayout(),
    };
  }

  function post(body: unknown, extraHeaders: Record<string, string> = {}) {
    return buildHandlers().RUN(
      makeRequest(RUN_URL, "POST", body, extraHeaders),
      makeContext({ name: "repo", session: SESSION_NAME }),
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
    kickOffExecutionLoop.mockResolvedValue(undefined);
    markRunning.mockResolvedValue(undefined);
    awaitingDefinitionApproval.mockResolvedValue(undefined);
  });

  it("accepts a valid plan with 202 and a receipt carrying the one-off origin and no definition id", async () => {
    const execution = createWorkflowExecution({
      id: "execution-inline",
      status: "running",
      origin: { kind: "one_off", planName: "Inline analysis" },
    });
    runExecution.mockResolvedValue({
      execution,
      awaitingDefinitionApproval: false,
    });

    const plan = makePlan();
    const response = await post({ plan });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.receipt).toMatchObject({
      executionId: "execution-inline",
      status: "running",
      origin: { kind: "one_off", planName: "Inline analysis" },
      deepLink: "/projects/repo/session-1/workflow?execution=execution-inline",
    });
    // R1.2's "never a definition id" is a claim about the WHOLE payload, so it
    // is asserted over the serialized body rather than over the fields we
    // happened to enumerate above.
    expect(JSON.stringify(body)).not.toContain("definitionId");
    expect(body.receipt).not.toHaveProperty("warnings");

    // The route hands the manager the PARSED plan document, never the raw body,
    // and never a definition identity of any kind. Parsing canonicalizes prose
    // acceptance criteria to records (#69 change 4 stage 1).
    expect(runExecution).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      plan: {
        name: plan.name,
        description: plan.description,
        definition: {
          ...plan.definition,
          executionContexts: plan.definition.executionContexts.map(
            (context) => ({
              ...context,
              acceptanceCriteria: criterionRecordsOf(
                context.acceptanceCriteria,
              ),
            }),
          ),
        },
        layout: plan.layout,
      },
    });
    expect(kickOffExecutionLoop).toHaveBeenCalledWith({
      projectPath: PROJECT_PATH,
      projectName: "repo",
      sessionName: SESSION_NAME,
      execution,
    });
  });

  it("appends committed-source warnings after synchronous plan warnings without refusing the run", async () => {
    const committedWarning = {
      path: "definition.charter.sourcesOfTruth.0.locator",
      message:
        'lint/source-locator-unresolvable: source is absent for session "session-1" on branch "csm/session-1" at commit inline-sha',
    };
    const execution = createWorkflowExecution({
      id: "execution-warning-order",
      status: "running",
      origin: { kind: "one_off", planName: "Inline analysis" },
    });
    runExecution.mockResolvedValue({
      execution,
      awaitingDefinitionApproval: false,
      warnings: [committedWarning],
    });
    const definition = createWorkflowDefinition();
    const firstContext = definition.executionContexts[0];
    if (firstContext === undefined) {
      throw new Error("fixture missing first execution context");
    }
    const plan = makePlan({
      ...definition,
      executionContexts: [
        {
          ...firstContext,
          acceptanceCriteria: "Every committed path is checked",
        },
        ...definition.executionContexts.slice(1),
      ],
    });

    const response = await post({ plan });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      receipt: {
        status: string;
        warnings: Array<{ path: string; message: string }>;
      };
    };
    expect(body.receipt.status).toBe("running");
    expect(body.receipt.warnings).toHaveLength(2);
    expect(body.receipt.warnings[0]).toMatchObject({
      path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
      message: expect.stringContaining("lint/open-quantifier"),
    });
    expect(body.receipt.warnings[1]).toEqual(committedWarning);
  });

  it("binds the inputs document through a channel distinct from the plan", async () => {
    const execution = createWorkflowExecution({
      id: "execution-bound",
      status: "running",
      origin: { kind: "one_off", planName: "Inline analysis" },
    });
    runExecution.mockResolvedValue({
      execution,
      awaitingDefinitionApproval: false,
    });

    const response = await post({
      plan: makePlan(),
      inputs: { ticket: "CC-42" },
    });

    expect(response.status).toBe(202);
    expect(runExecution).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { ticket: "CC-42" } }),
    );
  });

  /**
   * R1.3 refuses a bad input with a LOCATED issue, in the same
   * `{code, issues:[{path, message}]}` dialect the plan-validation refusal
   * above already speaks — otherwise a caller has to parse prose to learn which
   * input it got wrong. The path roots at `inputs` because that is the document
   * the RUN caller actually sent; the START equivalent roots at `parameters`.
   */
  it.each([
    [
      "a missing required input",
      { kind: "missing_required" as const, name: "ticket" },
      "missing_required",
      "inputs.ticket",
    ],
    [
      "an undeclared input name",
      { kind: "unknown_parameter" as const, name: "notAParam" },
      "unknown_parameter",
      "inputs.notAParam",
    ],
    [
      "a value outside the declared options",
      {
        kind: "invalid_value" as const,
        name: "tier",
        message: "expected one of: fast, slow",
      },
      "invalid_value",
      "inputs.tier",
    ],
  ])(
    "locates %s in the inputs document",
    async (_label, inputError, code, path) => {
      runExecution.mockRejectedValue(
        new WorkflowStartInputError(
          inputError,
          `Bad input "${inputError.name}"`,
        ),
      );

      const response = await post({ plan: makePlan(), inputs: {} });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        code: string;
        issues: { path: string; message: string }[];
      };
      expect(body.code).toBe(code);
      expect(body.issues).toHaveLength(1);
      expect(body.issues[0]?.path).toBe(path);
      // The message still names the offending parameter, so a surface that only
      // renders prose loses nothing by the payload gaining structure.
      expect(body.issues[0]?.message).toContain(inputError.name);
      expect(kickOffExecutionLoop).not.toHaveBeenCalled();
      expect(markRunning).not.toHaveBeenCalled();
    },
  );

  /**
   * R9.4/D11: the principal is DERIVED FROM A SIGNATURE, never from the
   * caller's claim. Membership is not authority — a sibling conversation, a
   * lane, or a copied id all pass a membership check, which is exactly the
   * forgery this refuses.
   */
  describe("origin conversation is derived from a signed capability", () => {
    const CAPABILITY_SECRET = "server-only-capability-key";

    function buildCapabilityHandlers(
      session: SessionState,
      secret: string | null = CAPABILITY_SECRET,
    ) {
      return createGraphWorkflowExecutionRouteHandlers({
        resolveProjectPath: async (name: string) =>
          name === "repo" ? PROJECT_PATH : null,
        getSession: async () => session,
        getActiveExecution: async () => null,
        runExecution,
        kickOffExecutionLoop,
        markRunning,
        awaitingDefinitionApproval,
        readRepoConfig: async () => null,
        readConfig: async () => ({}) as never,
        verifyConversationCapability: async (request: Request) =>
          verifyConversationCapability(
            request.headers.get(CONVERSATION_CAPABILITY_HEADER),
            secret,
          ),
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
        recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
        drainAndHalt: unusedDep("drainAndHalt"),
        recordApprovalDecision: unusedDep("recordApprovalDecision"),
        recordDefinitionApproval: unusedDep("recordDefinitionApproval"),
        admitDefinitionApproval: unusedDep("admitDefinitionApproval"),
        executionAborted: unusedDep("executionAborted"),
        stopExecutionLaneDevServers: unusedDep("stopExecutionLaneDevServers"),
        listArchivedExecutions: unusedDep("listArchivedExecutions"),
      } as unknown as GraphWorkflowExecutionRouteDeps);
    }

    function runWithHeaders(
      headers: Record<string, string>,
      session: SessionState,
      secret: string | null = CAPABILITY_SECRET,
    ) {
      return buildCapabilityHandlers(session, secret).RUN(
        makeRequest(RUN_URL, "POST", { plan: makePlan() }, headers),
        makeContext({ name: "repo", session: SESSION_NAME }),
      );
    }

    beforeEach(() => {
      runExecution.mockResolvedValue({
        execution: createWorkflowExecution({
          id: "execution-principal",
          status: "running",
          origin: { kind: "one_off", planName: "Inline analysis" },
        }),
        awaitingDefinitionApproval: false,
      });
    });

    it("derives the origin from a valid capability", async () => {
      const session = makeSession({
        conversations: [makeConversation("conv-owner")],
      });

      const response = await runWithHeaders(
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-owner" },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
        },
        session,
      );

      expect(response.status).toBe(202);
      expect(runExecution).toHaveBeenCalledWith(
        expect.objectContaining({ ownerConversationId: "conv-owner" }),
      );
    });

    it("fails closed on a forged signature rather than launching unowned", async () => {
      const session = makeSession({
        conversations: [makeConversation("conv-owner")],
      });
      const forged = mintConversationCapability(
        { sessionName: SESSION_NAME, conversationId: "conv-owner" },
        "not-the-server-key",
        1_760_000_000_000,
      );

      const response = await runWithHeaders(
        { [CONVERSATION_CAPABILITY_HEADER]: forged },
        session,
      );

      // A caller presenting a capability is never the browser — the browser
      // sends none — so a bad one is a failed authentication, not an anonymous
      // human. Launching it unowned would let a forgery consume the session's
      // one lease and leave no principal to answer for it.
      expect(response.status).toBe(403);
      expect(runExecution).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        code: "unverified_principal",
      });
    });

    // THE forgery the bare header allowed: conv-sibling is a real conversation
    // in this session, so a membership check admits it. Only the signature
    // distinguishes "is a conversation here" from "is THIS caller".
    it("refuses to own a run from an unsigned header claim naming a sibling conversation", async () => {
      const session = makeSession({
        conversations: [
          makeConversation("conv-owner"),
          makeConversation("conv-sibling"),
        ],
      });

      const response = await runWithHeaders(
        { [OWNER_CONVERSATION_HEADER]: "conv-sibling" },
        session,
      );

      expect(response.status).toBe(202);
      expect(runExecution).toHaveBeenCalledWith(
        expect.not.objectContaining({ ownerConversationId: expect.anything() }),
      );
      await expect(response.json()).resolves.toMatchObject({
        receipt: { originConversationId: null },
      });
    });

    // A capability minted for another session must not be replayable here.
    it("refuses a capability minted for a different session", async () => {
      const session = makeSession({
        conversations: [makeConversation("conv-owner")],
      });

      const response = await runWithHeaders(
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: "other-session", conversationId: "conv-owner" },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
        },
        session,
      );

      expect(response.status).toBe(403);
      expect(runExecution).not.toHaveBeenCalled();
    });

    // The signed conversation must still exist here; a capability naming a
    // conversation this session does not have is not an owner. This is the
    // DELETED-ORIGIN path: the conversation's capability outlives it, and the
    // membership re-check is what makes it inert.
    it("refuses a valid capability naming a conversation absent from the session", async () => {
      const session = makeSession({
        conversations: [makeConversation("conv-owner")],
      });

      const response = await runWithHeaders(
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-gone" },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
        },
        session,
      );

      expect(response.status).toBe(403);
      expect(runExecution).not.toHaveBeenCalled();
    });

    // A server with no key can verify nothing, so it can establish no agent
    // principal at all. It must refuse rather than fall back to the claim
    // sitting beside the capability in this very request.
    it("refuses a capability-bearing caller when the server has no capability key", async () => {
      const session = makeSession({
        conversations: [makeConversation("conv-owner")],
      });

      const response = await runWithHeaders(
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-owner" },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
          [OWNER_CONVERSATION_HEADER]: "conv-owner",
        },
        session,
        null,
      );

      expect(response.status).toBe(403);
      expect(runExecution).not.toHaveBeenCalled();
    });

    // A human browser launch presents no agent credentials at all and stays a
    // legitimate, unowned launch — the invariant's own final clause.
    it("accepts a credential-free human launch as unowned", async () => {
      const response = await runWithHeaders({}, makeSession());

      expect(response.status).toBe(202);
      expect(runExecution).toHaveBeenCalledWith(
        expect.not.objectContaining({ ownerConversationId: expect.anything() }),
      );
    });
  });

  /**
   * D11/D12 reserve the credential-free path for the human UI. An AGENT caller
   * — anything presenting a valid instance token — must prove which
   * conversation it is, or be refused outright. Launching unowned would let a
   * lane or a sibling agent create an execution against a free lease with no
   * verified authority at all, which is the nesting refusal D12 exists for.
   */
  describe("agent callers must present a verified capability to launch", () => {
    const CAPABILITY_SECRET = "server-only-capability-key";

    function buildAgentHandlers(
      transport: "absent" | "valid" | "invalid",
      secret: string | null = CAPABILITY_SECRET,
      session: SessionState = makeSession({
        conversations: [makeConversation("conv-owner")],
      }),
    ) {
      return createGraphWorkflowExecutionRouteHandlers({
        resolveProjectPath: async (name: string) =>
          name === "repo" ? PROJECT_PATH : null,
        getSession: async () => session,
        getActiveExecution: async () => null,
        runExecution,
        kickOffExecutionLoop,
        markRunning,
        awaitingDefinitionApproval,
        readRepoConfig: async () => null,
        readConfig: async () => ({}) as never,
        auth: { validateOptionalToken: async () => ({ kind: transport }) },
        verifyConversationCapability: async (request: Request) =>
          verifyConversationCapability(
            request.headers.get(CONVERSATION_CAPABILITY_HEADER),
            secret,
          ),
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
        recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
        drainAndHalt: unusedDep("drainAndHalt"),
        recordApprovalDecision: unusedDep("recordApprovalDecision"),
        recordDefinitionApproval: unusedDep("recordDefinitionApproval"),
        admitDefinitionApproval: unusedDep("admitDefinitionApproval"),
        executionAborted: unusedDep("executionAborted"),
        stopExecutionLaneDevServers: unusedDep("stopExecutionLaneDevServers"),
        listArchivedExecutions: unusedDep("listArchivedExecutions"),
      } as unknown as GraphWorkflowExecutionRouteDeps);
    }

    function agentPost(
      transport: "absent" | "valid" | "invalid",
      headers: Record<string, string> = {},
      secret: string | null = CAPABILITY_SECRET,
    ) {
      return buildAgentHandlers(transport, secret).RUN(
        makeRequest(RUN_URL, "POST", { plan: makePlan() }, headers),
        makeContext({ name: "repo", session: SESSION_NAME }),
      );
    }

    beforeEach(() => {
      runExecution.mockResolvedValue({
        execution: createWorkflowExecution({
          id: "execution-agent",
          status: "running",
          origin: { kind: "one_off", planName: "Inline analysis" },
        }),
        awaitingDefinitionApproval: false,
      });
    });

    it.each([
      ["no capability at all", {}],
      [
        "only an unsigned conversation claim",
        { [OWNER_CONVERSATION_HEADER]: "conv-owner" },
      ],
      [
        "a forged capability",
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-owner" },
            "not-the-server-key",
            1_760_000_000_000,
          ),
        },
      ],
    ])("refuses a token-bearing agent presenting %s", async (_l, headers) => {
      const response = await agentPost("valid", headers);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "unverified_principal",
      });
      // Nothing was launched: no execution, no loop, no lease consumed.
      expect(runExecution).not.toHaveBeenCalled();
      expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    });

    it("refuses an agent whose server has no capability key", async () => {
      const response = await agentPost(
        "valid",
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-owner" },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
        },
        null,
      );

      expect(response.status).toBe(403);
      expect(runExecution).not.toHaveBeenCalled();
    });

    it("admits an agent presenting a valid capability, as its owner", async () => {
      const response = await agentPost("valid", {
        [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
          { sessionName: SESSION_NAME, conversationId: "conv-owner" },
          CAPABILITY_SECRET,
          1_760_000_000_000,
        ),
      });

      expect(response.status).toBe(202);
      expect(runExecution).toHaveBeenCalledWith(
        expect.objectContaining({ ownerConversationId: "conv-owner" }),
      );
    });

    it("rejects a bad token before asking about capabilities", async () => {
      const response = await agentPost("invalid");

      expect(response.status).toBe(401);
      expect(runExecution).not.toHaveBeenCalled();
    });

    // The human UI presents no token, so it keeps launching unowned.
    it("still admits the credential-free human path", async () => {
      const response = await agentPost("absent");

      expect(response.status).toBe(202);
      expect(runExecution).toHaveBeenCalledWith(
        expect.not.objectContaining({ ownerConversationId: expect.anything() }),
      );
    });
  });

  it("captures the caller conversation server-side as the run's origin", async () => {
    const execution = createWorkflowExecution({
      id: "execution-owned",
      status: "running",
      origin: { kind: "one_off", planName: "Inline analysis" },
      ownerConversationId: "conv-owner",
    });
    runExecution.mockResolvedValue({
      execution,
      awaitingDefinitionApproval: false,
    });

    const response = await buildHandlers(
      makeSession({ conversations: [makeConversation("conv-owner")] }),
      // The origin is server-verified, so the caller proves its identity with a
      // signed capability; the bare header alone no longer owns a run.
      async (request: Request) =>
        verifyConversationCapability(
          request.headers.get(CONVERSATION_CAPABILITY_HEADER),
          "server-only-capability-key",
        ),
    ).RUN(
      makeRequest(
        RUN_URL,
        "POST",
        { plan: makePlan() },
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-owner" },
            "server-only-capability-key",
            1_760_000_000_000,
          ),
        },
      ),
      makeContext({ name: "repo", session: SESSION_NAME }),
    );

    expect(response.status).toBe(202);
    expect(runExecution).toHaveBeenCalledWith(
      expect.objectContaining({ ownerConversationId: "conv-owner" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      receipt: { originConversationId: "conv-owner" },
    });
  });

  it.each([
    [
      "a malformed schema",
      { name: "", definition: { schemaVersion: 1 }, layout: {} },
    ],
    [
      "a write-capable placement on the reserved session lane",
      {
        ...(() => {
          const definition = createWorkflowDefinition();
          const [first, ...rest] = definition.executionContexts;
          return {
            name: "Bad placement",
            description: "d",
            definition: {
              ...definition,
              executionContexts: [
                { ...first, placement: { lane: "session", mode: "full" } },
                ...rest,
              ],
            },
            layout: createWorkflowLayout(),
          };
        })(),
      },
    ],
    [
      "a dangling context reference",
      (() => {
        const definition = createWorkflowDefinition();
        return {
          name: "Dangling reference",
          description: "d",
          definition: {
            ...definition,
            edges: [
              ...definition.edges,
              {
                id: "edge-dangling",
                sourceContextId: "context-plan",
                targetContextId: "context-nowhere",
              },
            ],
          },
          layout: createWorkflowLayout(),
        };
      })(),
    ],
  ])(
    "refuses %s with located issues before anything is launched",
    async (_label, plan) => {
      const response = await post({ plan });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.issues.length).toBeGreaterThan(0);
      for (const issue of body.issues) {
        expect(typeof issue.path).toBe("string");
        expect(typeof issue.message).toBe("string");
      }
      // Fail-closed: the refusal happens before the manager is engaged at all,
      // so no execution, no definition, and no artifact can exist afterwards.
      expect(runExecution).not.toHaveBeenCalled();
      expect(kickOffExecutionLoop).not.toHaveBeenCalled();
    },
  );

  it("refuses a body with no plan document", async () => {
    const response = await post({ inputs: { ticket: "CC-42" } });

    expect(response.status).toBe(400);
    expect(runExecution).not.toHaveBeenCalled();
  });

  it("accepts an approvalRequired plan as a parked 202 receipt rather than a refusal", async () => {
    const parked = createWorkflowExecution({
      id: "execution-parked",
      status: "pending",
      origin: { kind: "one_off", planName: "Inline analysis" },
      definitionApproval: {
        requestedAt: "2026-08-13T00:00:00.000Z",
        approvedAt: null,
      },
    });
    runExecution.mockResolvedValue({
      execution: parked,
      awaitingDefinitionApproval: true,
    });

    const response = await post({ plan: makePlan() });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      receipt: {
        executionId: "execution-parked",
        status: "awaiting_definition_approval",
        origin: { kind: "one_off", planName: "Inline analysis" },
      },
    });
    // A park is an accepted launch that has not begun: the review is reported
    // and the loop stays untouched. The report names the recorded origin — a
    // consumer that received `one-off:execution-parked` here would read the
    // compatibility filler as a definition it could look up.
    expect(awaitingDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: "/repo", sessionName: "session-1" },
      "execution-parked",
      { kind: "one_off", planName: "Inline analysis" },
    );
    expect(kickOffExecutionLoop).not.toHaveBeenCalled();
  });
});

describe("graph workflow abandon route — the audited end of a resumable halt", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";
  const NOW = "2026-08-13T09:00:00.000Z";
  const ABANDON_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/abandon";

  const RESUMABLE_HALT = {
    type: "execution_loop_failed" as const,
    contextId: "context-plan",
    message: "the loop threw",
    cause: "unknown" as const,
  };

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
      throw new Error(`${name} should not be called by this flow`);
    };
  }

  /**
   * Production route handlers over the real manager and repository on the real
   * (in-memory SQLite) store: whether the lease was released is a fact about the
   * persisted active row, which only a real store can answer.
   */
  const CAPABILITY_SECRET = "server-only-capability-key";

  function buildStack(
    transport: "absent" | "valid" | "invalid" = "absent",
    archiveSeam: typeof fixture.store.archiveActiveGraphWorkflowExecution = (
      ...args
    ) => fixture.store.archiveActiveGraphWorkflowExecution(...args),
    routeExecution?: GraphWorkflowExecution,
  ) {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
      now: () => NOW,
    });
    const repository = createGraphWorkflowExecutionRepository({
      ensureCcArtifactsExcluded: async () => {},
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution: archiveSeam,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher,
    });
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now: () => NOW,
    });
    const stopExecutionLaneDevServers = vi.fn(async () => {});
    const handlers = createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      abandonExecution: manager.abandon,
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: repository.archiveActive,
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      getActiveExecution:
        routeExecution === undefined
          ? repository.getActive
          : async () => routeExecution,
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      stopExecutionLaneDevServers,
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
    });
    return { handlers, manager, repository, stopExecutionLaneDevServers };
  }

  async function seedActive(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedActive",
      () => ({ execution, events: [] }),
    );
  }

  function haltedExecution(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      id: "execution-halted",
      status: "halted",
      haltReason: RESUMABLE_HALT,
      ...overrides,
    });
  }

  function abandonRequest(body: unknown) {
    return makeRequest(ABANDON_URL, "POST", body);
  }

  const routeContext = () =>
    makeContext({ name: PROJECT_NAME, session: SESSION_NAME });

  it("archives the identified run into History, preserving its halt reason and its abandonment audit", async () => {
    const { handlers, stopExecutionLaneDevServers } = buildStack();
    await seedActive(haltedExecution());

    const response = await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-halted",
        reason: "Superseded by a new plan",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-halted", status: "halted" },
    });
    // Lane resources are torn down once, after the authoritative commit — the
    // winner's post-commit effect, never a side effect that precedes it.
    expect(stopExecutionLaneDevServers).toHaveBeenCalledTimes(1);
    expect(
      await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toBeNull();

    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe("halted");
    expect(archived[0]!.haltReason).toEqual(RESUMABLE_HALT);
    expect(archived[0]!.abandonment).toEqual({
      abandonedAt: NOW,
      actor: { kind: "human" },
      reason: "Superseded by a new plan",
    });
  });

  it("answers a one-off abandonment with a receipt that names no definition", async () => {
    const { handlers } = buildStack();
    await seedActive(
      haltedExecution({
        origin: { kind: "one_off", planName: "Inline repair plan" },
        seedDefinitionId: "one-off:execution-halted",
      }),
    );

    const response = await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-halted",
        reason: "Superseded by a new plan",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      execution: {
        executionId: "execution-halted",
        status: "halted",
        origin: { kind: "one_off", planName: "Inline repair plan" },
        archived: true,
      },
      abandoned: true,
    });
    // The seed fields on a one-off row are legacy-shaped compatibility filler;
    // rendering them as a real definition is what D2 forbids, and every
    // execution-addressed act answers with the recorded origin instead.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("definitionId");
    expect(serialized).not.toContain("definitionRevision");
    expect(serialized).not.toContain("one-off:");
  });

  it("appends the released audit row through the audited archive seam", async () => {
    const { handlers } = buildStack();
    await seedActive(haltedExecution());

    await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-halted",
        reason: "Superseded by a new plan",
      }),
      routeContext(),
    );

    const events = await fixture.store.getGraphWorkflowEventsTail(
      PROJECT_PATH,
      SESSION_NAME,
      "execution-halted",
      50,
    );
    const released = events.filter(
      (entry) => entry.event.type === "graph-workflow-execution-released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]!.event).toMatchObject({
      executionId: "execution-halted",
      status: "halted",
      reason: "abandoned",
    });
  });

  it("refuses a stale execution id with 409 and leaves the lease holder untouched", async () => {
    const { handlers } = buildStack();
    await seedActive(haltedExecution());

    const response = await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-somebody-else",
        reason: "Superseded",
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_mismatch",
    });
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.abandonment).toBeNull();
  });

  it("refuses a non-resumable halt, which already projects into History without a lease", async () => {
    const { handlers } = buildStack();
    await seedActive(
      haltedExecution({
        id: "execution-unrecoverable",
        haltReason: {
          type: "recovery_error",
          message: "unrecoverable",
        },
      }),
    );

    const response = await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-unrecoverable",
        reason: "Superseded",
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "not_lease_holding_halt",
    });
  });

  it("refuses a repeated abandon: the first act already moved the run to History", async () => {
    const { handlers } = buildStack();
    await seedActive(haltedExecution());

    const first = await handlers.ABANDON(
      abandonRequest({ executionId: "execution-halted", reason: "First" }),
      routeContext(),
    );
    expect(first.status).toBe(200);

    // The first act already relocated the run into History, so the session
    // owns nothing to abandon — the refusal is about the lease, not a second
    // audit quietly overwriting the first.
    const second = await handlers.ABANDON(
      abandonRequest({ executionId: "execution-halted", reason: "Second" }),
      routeContext(),
    );
    expect(second.status).toBe(404);
    await expect(second.json()).resolves.toMatchObject({
      code: "no_active_execution",
    });
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.abandonment?.reason).toBe("First");
  });

  it("rejects a body carrying no reason", async () => {
    const { handlers } = buildStack();
    await seedActive(haltedExecution());

    const response = await handlers.ABANDON(
      abandonRequest({ executionId: "execution-halted" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a body naming a workflow definition instead of the execution", async () => {
    const { handlers } = buildStack();
    await seedActive(haltedExecution());

    const response = await handlers.ABANDON(
      abandonRequest({
        executionId: "execution-halted",
        definitionId: "workflow-1",
        reason: "Superseded",
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
  });

  describe("who may end the lease holder's tenure", () => {
    /**
     * The ordinary-conversation half of the shared mutation contract: abandon
     * reads session MEMBERSHIP, so the human UI and any verified conversation
     * may end the tenure, and what the audit records is the signed identity of
     * whichever one did. An agent that cannot prove which conversation it is
     * still may not. Current and stale lane authority are exercised by the
     * common mutation table and the archive-turnover regression below.
     */
    async function seedOwnedHalt(ownerConversationId: string): Promise<void> {
      await seedActive(haltedExecution({ ownerConversationId }));
      for (const id of [ownerConversationId, "conv-sibling"]) {
        await fixture.seedConversation(
          PROJECT_PATH,
          SESSION_NAME,
          makeConversation(id),
        );
      }
    }

    function capabilityFor(conversationId: string): Record<string, string> {
      return {
        [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
          { sessionName: SESSION_NAME, conversationId },
          CAPABILITY_SECRET,
          1,
        ),
      };
    }

    async function abandonAs(
      transport: "absent" | "valid" | "invalid",
      headers: Record<string, string> = {},
    ) {
      const { handlers } = buildStack(transport);
      await seedOwnedHalt("conv-origin");
      return handlers.ABANDON(
        makeRequest(
          ABANDON_URL,
          "POST",
          { executionId: "execution-halted", reason: "Superseded" },
          headers,
        ),
        routeContext(),
      );
    }

    async function expectUntouchedLeaseHolder(): Promise<void> {
      const active = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(active?.id).toBe("execution-halted");
      expect(active?.abandonment).toBeNull();
      expect(
        await fixture.store.listArchivedGraphWorkflowExecutions(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toHaveLength(0);
    }

    it("refuses an invalid Command Center token and writes nothing", async () => {
      const response = await abandonAs("invalid", capabilityFor("conv-origin"));

      expect(response.status).toBe(401);
      await expectUntouchedLeaseHolder();
    });

    it.each([
      ["no capability at all", {}],
      [
        "only an unsigned conversation claim",
        { [OWNER_CONVERSATION_HEADER]: "conv-origin" },
      ],
      [
        "a forged capability",
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: "conv-origin" },
            "not-the-server-key",
            1,
          ),
        },
      ],
    ])(
      "refuses a token-bearing agent presenting %s",
      async (_label, headers) => {
        const response = await abandonAs("valid", headers);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: "unverified_principal",
        });
        await expectUntouchedLeaseHolder();
      },
    );

    // The audit is where a claim would do damage under membership authority:
    // every session conversation is admitted, so the actor recorded must still
    // be the SIGNED identity rather than the id the caller typed in a header.
    it("admits a verified sibling conversation and attributes the audit to its signed identity", async () => {
      const response = await abandonAs("valid", {
        ...capabilityFor("conv-sibling"),
        [OWNER_CONVERSATION_HEADER]: "conv-origin",
      });

      expect(response.status).toBe(200);
      const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(archived[0]!.abandonment?.actor).toEqual({
        kind: "conversation",
        conversationId: "conv-sibling",
      });
    });

    it("admits a verified conversation over a run no conversation originated", async () => {
      const { handlers } = buildStack("valid");
      await seedActive(haltedExecution());
      await fixture.seedConversation(
        PROJECT_PATH,
        SESSION_NAME,
        makeConversation("conv-sibling"),
      );

      const response = await handlers.ABANDON(
        makeRequest(
          ABANDON_URL,
          "POST",
          { executionId: "execution-halted", reason: "Superseded" },
          capabilityFor("conv-sibling"),
        ),
        routeContext(),
      );

      expect(response.status).toBe(200);
      const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(archived[0]!.abandonment?.actor).toEqual({
        kind: "conversation",
        conversationId: "conv-sibling",
      });
    });

    it("admits the origin conversation and attributes the audit to it", async () => {
      const response = await abandonAs("valid", capabilityFor("conv-origin"));

      expect(response.status).toBe(200);
      const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(archived[0]!.abandonment?.actor).toEqual({
        kind: "conversation",
        conversationId: "conv-origin",
      });
    });

    it("preserves the human UI's session-wide authority over a run a conversation launched", async () => {
      const response = await abandonAs("absent");

      expect(response.status).toBe(200);
      const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(archived[0]!.abandonment?.actor).toEqual({ kind: "human" });
    });
  });

  it("refuses a lane whose binding rotates before the archive transaction, writing nothing", async () => {
    const originConversationId = "conv-origin";
    const authorizedLaneConversationId = "conv-lane-authorized";
    const successorLaneConversationId = "conv-lane-successor";
    const staleRead = haltedExecution({
      ownerConversationId: originConversationId,
    });
    staleRead.taskStates["task-plan-1"] = {
      ...staleRead.taskStates["task-plan-1"]!,
      status: "running",
      lastConversationId: authorizedLaneConversationId,
    };
    const rebound = {
      ...staleRead,
      taskStates: {
        ...staleRead.taskStates,
        "task-plan-1": {
          ...staleRead.taskStates["task-plan-1"]!,
          lastConversationId: successorLaneConversationId,
        },
      },
    };
    await seedActive(rebound);
    for (const conversationId of [
      originConversationId,
      authorizedLaneConversationId,
      successorLaneConversationId,
    ]) {
      await fixture.seedConversation(
        PROJECT_PATH,
        SESSION_NAME,
        makeConversation(conversationId),
      );
    }
    const { handlers, stopExecutionLaneDevServers } = buildStack(
      "valid",
      undefined,
      staleRead,
    );

    const response = await handlers.ABANDON(
      makeRequest(
        ABANDON_URL,
        "POST",
        { executionId: "execution-halted", reason: "Superseded" },
        {
          [LANE_CAPABILITY_HEADER]: mintLaneCapability(
            {
              laneKind: "implementer",
              executionId: "execution-halted",
              contextId: "context-plan",
              conversationId: authorizedLaneConversationId,
            },
            CAPABILITY_SECRET,
            1,
          ),
        },
      ),
      routeContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_lane_principal",
      originConversationId,
    });
    expect(stopExecutionLaneDevServers).not.toHaveBeenCalled();
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.abandonment).toBeNull();
    expect(active?.taskStates["task-plan-1"]?.lastConversationId).toBe(
      successorLaneConversationId,
    );
    expect(
      await fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toEqual([]);
    expect(
      await fixture.store.getGraphWorkflowEventsTail(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-halted",
        50,
      ),
    ).toEqual([]);
  });

  it("refuses rather than reports success when the slot turns over first, leaving no audit behind", async () => {
    // The abandonment stamp and the History relocation are ONE transaction, so
    // a slot that turned over before the act landed refuses the whole act. A
    // split act would have committed the audit in a write of its own and then
    // reported an abandonment whose relocation never happened — and whose
    // durable boundary event was never appended.
    let raced = false;
    const { handlers } = buildStack("absent", async (...args) => {
      if (!raced) {
        raced = true;
        // A concurrent launch relocates the row into History first.
        await fixture.store.archiveActiveGraphWorkflowExecution(
          args[0],
          args[1],
          { reason: "normalized_on_admission", actor: null },
        );
      }
      return fixture.store.archiveActiveGraphWorkflowExecution(...args);
    });
    await seedActive(haltedExecution());

    const response = await handlers.ABANDON(
      abandonRequest({ executionId: "execution-halted", reason: "Superseded" }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.abandonment).toBeNull();
    const released = (
      await fixture.store.getGraphWorkflowEventsTail(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-halted",
        50,
      )
    ).filter(
      (entry) => entry.event.type === "graph-workflow-execution-released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]!.event).toMatchObject({
      reason: "normalized_on_admission",
    });
  });
});

describe("graph workflow definition rejection — the reviewed end of a parked launch", () => {
  const PROJECT_PATH = "/repo";
  const PROJECT_NAME = "repo";
  const SESSION_NAME = "session-1";
  const NOW = "2026-08-13T09:00:00.000Z";
  const REJECT_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/reject-definition";
  const APPROVE_URL =
    "/api/projects/repo/sessions/session-1/graph-workflow/approve-definition";

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
      throw new Error(`${name} should not be called by this flow`);
    };
  }

  /**
   * Production handlers over the real manager and repository on the real
   * (in-memory SQLite) store: whether a rejection released the lease and left a
   * reviewable History row is a fact about persisted rows, which only a real
   * store can answer.
   */
  function buildStack() {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
      now: () => NOW,
    });
    const repository = createGraphWorkflowExecutionRepository({
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
      eventPublisher,
    });
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      now: () => NOW,
    });
    const stopExecutionLaneDevServers = vi.fn(async () => {});
    const executionAborted = vi.fn(async () => {});
    const admitDefinitionApproval = vi.fn<
      (
        context: GraphExecutionLifecycleContext,
        workflowExecutionId: string,
        origin: GraphWorkflowExecutionOrigin,
      ) => Promise<DefinitionApprovalGateDecision>
    >(async () => ({ ok: true }));
    const handlers = createGraphWorkflowExecutionRouteHandlers({
      now: () => NOW,
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: fixture.store.getSession,
      normalizeExecutionAfterRestart: unusedDep(
        "normalizeExecutionAfterRestart",
      ),
      startExecution: unusedDep("startExecution"),
      runExecution: unusedDep("runExecution"),
      launchSpecDeliveryExecution: unusedDep("launchSpecDeliveryExecution"),
      pauseExecution: unusedDep("pauseExecution"),
      resumeExecution: unusedDep("resumeExecution"),
      abortExecution: unusedDep("abortExecution"),
      rejectDefinition: manager.rejectDefinition,
      claimDefinitionApproval: manager.claimDefinitionApproval,
      recordDefinitionApproval: manager.recordDefinitionApproval,
      releaseDefinitionApprovalClaim: manager.releaseDefinitionApprovalClaim,
      admitDefinitionApproval,
      markRunning: async () => {},
      executionAborted,
      resetExecutionContext: unusedDep("resetExecutionContext"),
      resetExecutionContextAssignment: unusedDep(
        "resetExecutionContextAssignment",
      ),
      archiveExecution: repository.archiveActive,
      kickOffExecutionLoop: unusedDep("kickOffExecutionLoop"),
      getActiveExecution: repository.getActive,
      recordPendingHaltReason: unusedDep("recordPendingHaltReason"),
      drainAndHalt: unusedDep("drainAndHalt"),
      recordApprovalDecision: unusedDep("recordApprovalDecision"),
      stopExecutionLaneDevServers,
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
    return {
      handlers,
      repository,
      stopExecutionLaneDevServers,
      executionAborted,
      admitDefinitionApproval,
    };
  }

  async function seedActive(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedActive",
      () => ({ execution, events: [] }),
    );
  }

  /**
   * A park whose decision was reserved by an act that never came back — the
   * shape a crash between the reservation and the finalize leaves behind.
   */
  function interruptedPark(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    return parkedOneOff({
      definitionApprovalClaim: {
        claimId: "claim-interrupted",
        claimedAt: "2026-08-13T08:00:00.000Z",
      },
      ...overrides,
    });
  }

  function parkedOneOff(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      id: "execution-parked",
      status: "pending",
      origin: { kind: "one_off", planName: "Inline repair plan" },
      definitionApproval: {
        requestedAt: "2026-08-13T08:55:00.000Z",
        approvedAt: null,
      },
      ...overrides,
    });
  }

  const routeContext = () =>
    makeContext({ name: PROJECT_NAME, session: SESSION_NAME });

  it("ends a parked one-off into History addressed by execution id alone", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { executionId: "execution-parked", status: "aborted" },
      rejected: true,
    });

    // The lease is free the moment the rejection returns: History never blocks.
    expect(
      await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toBeNull();

    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe("aborted");
    // The run stays reviewable with the snapshot nobody approved.
    expect(archived[0]!.definitionApproval).toEqual({
      requestedAt: "2026-08-13T08:55:00.000Z",
      approvedAt: null,
    });
    expect(archived[0]!.haltReason).toMatchObject({
      type: "aborted",
      cause: "definition_rejected",
    });
  });

  it("answers a one-off rejection with a receipt that names no definition", async () => {
    const { handlers } = buildStack();
    await seedActive(
      parkedOneOff({ seedDefinitionId: "one-off:execution-parked" }),
    );

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      execution: {
        executionId: "execution-parked",
        status: "aborted",
        origin: { kind: "one_off", planName: "Inline repair plan" },
        archived: true,
      },
      rejected: true,
    });
    // Same contract as approval: the act is addressed by execution id alone, so
    // its receipt may not hand back the compatibility filler as identity.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("definitionId");
    expect(serialized).not.toContain("definitionRevision");
    expect(serialized).not.toContain("one-off:");
  });

  it("reports a rejected template park to the aborted lifecycle consumer", async () => {
    // Rejection ends the run exactly as an abort does, so the downstream work
    // pinned to it must terminalize the same way: template-specific behavior is
    // the consumer's, downstream of the shared origin-aware act. Without this a
    // rejected template park strands its linked spec execution nonterminal.
    const { handlers, executionAborted } = buildStack();
    await seedActive(
      parkedOneOff({
        id: "execution-parked",
        origin: {
          kind: "template",
          definitionId: "workflow-def-9",
          definitionRevision: 3,
          tier: "project",
        },
      }),
    );

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(executionAborted).toHaveBeenCalledWith("execution-parked");
  });

  it("does not report a refused rejection to the aborted lifecycle consumer", async () => {
    const { handlers, executionAborted } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-stale" }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(executionAborted).not.toHaveBeenCalled();
  });

  it("records definition_rejected on the durable released audit row", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    const events = await fixture.store.getGraphWorkflowEventsTail(
      PROJECT_PATH,
      SESSION_NAME,
      "execution-parked",
      50,
    );
    const released = events.filter(
      (entry) => entry.event.type === "graph-workflow-execution-released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]!.event).toMatchObject({
      executionId: "execution-parked",
      status: "aborted",
      reason: "definition_rejected",
    });
  });

  it("refuses a body naming a workflow definition instead of the execution", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", {
        executionId: "execution-parked",
        definitionId: "workflow-1",
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
  });

  it("refuses a stale execution id and leaves the parked run untouched", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", {
        executionId: "execution-somebody-else",
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_mismatch",
    });
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
  });

  it("refuses a run that is not parked awaiting definition approval", async () => {
    const { handlers } = buildStack();
    await seedActive(
      createWorkflowExecution({ id: "execution-running", status: "running" }),
    );

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-running" }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "not_awaiting_approval",
    });
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("running");
  });

  it("refuses a second rejection: the first act already moved the run to History", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const first = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );
    expect(first.status).toBe(200);

    const second = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );
    expect(second.status).toBe(404);
    await expect(second.json()).resolves.toMatchObject({
      code: "no_active_execution",
    });
  });

  it("refuses agent transport with a machine-readable human_act_required", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      new NextRequest(`http://localhost${REJECT_URL}`, {
        method: "POST",
        headers: {
          authorization: "Bearer valid-agent-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ executionId: "execution-parked" }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
  });

  it("rejects an invalid token with 401 before touching the parked run", async () => {
    const { handlers } = buildStack();
    await seedActive(parkedOneOff());

    const response = await handlers.REJECT_DEFINITION(
      new NextRequest(`http://localhost${REJECT_URL}`, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ executionId: "execution-parked" }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(401);
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
  });

  it("releases lane resources before the record leaves the active position", async () => {
    const { handlers, stopExecutionLaneDevServers } = buildStack();
    await seedActive(parkedOneOff());

    await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(stopExecutionLaneDevServers).toHaveBeenCalledTimes(1);
  });

  /**
   * A reservation is taken BEFORE the admission consumer is called, so one that
   * outlives its holder may already have that consumer's durable records behind
   * it. Ending the run and dropping the reservation would strand those records
   * on a run this server killed — the interrupted act would have written and
   * lost. So the interrupted saga is FINISHED first, and what it finds decides
   * what the operator's act can still do.
   */
  it("finishes an interrupted decision before rejecting, admitting the run it may already have admitted", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(interruptedPark());
    admitDefinitionApproval.mockResolvedValue({ ok: true });

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    // The consumer is asked again (idempotently) rather than left holding an
    // admission for a run nobody finished deciding.
    expect(admitDefinitionApproval).toHaveBeenCalledWith(
      { projectPath: PROJECT_PATH, sessionName: SESSION_NAME },
      "execution-parked",
      expect.objectContaining({ kind: "one_off" }),
    );
    // It admitted, so the interrupted approval completes and the run starts.
    // The rejection arrives too late, and says so rather than undoing it.
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("running");
    expect(active?.definitionApprovalClaim).toBeNull();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "not_awaiting_approval",
    });
  });

  it("releases an interrupted decision the gate refuses, then rejects", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(interruptedPark());
    admitDefinitionApproval.mockResolvedValue({
      ok: false,
      code: "revision_not_approved",
      unmetConditions: ["The pinned revision is no longer approved."],
      instruction: "Sign off the revision, then approve again.",
    });

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    // Nothing was admitted, so the reservation is handed back and the park is
    // decidable again — by this rejection.
    expect(response.status).toBe(200);
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.haltReason).toMatchObject({
      cause: "definition_rejected",
    });
  });

  it("refuses to reject under a decision that is still live", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(
      parkedOneOff({
        definitionApprovalClaim: { claimId: "claim-live", claimedAt: NOW },
      }),
    );

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "decision_in_flight",
    });
    // A live holder finishes its own act; nothing here touches its admission.
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
    expect(active?.definitionApprovalClaim).toMatchObject({
      claimId: "claim-live",
    });
  });

  /**
   * Settlement finishes a decision, which means it can admit, approve and START
   * the run it settles. Addressed acts therefore may not settle whatever happens
   * to hold the session: a stale request naming a run that has already turned
   * over would otherwise decide its successor and then refuse — a refusal that
   * changed another execution (charter `reserve-before-side-effects`).
   */
  it("leaves a successor's interrupted decision alone when the rejection names another run", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(interruptedPark({ id: "execution-successor" }));

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-stale" }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_mismatch",
    });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe("execution-successor");
    expect(active?.status).toBe("pending");
    expect(active?.definitionApprovalClaim).toMatchObject({
      claimId: "claim-interrupted",
    });
  });

  it("leaves a successor's interrupted decision alone when the approval names another run", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(interruptedPark({ id: "execution-successor" }));

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(APPROVE_URL, "POST", { executionId: "execution-stale" }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_mismatch",
    });
    expect(admitDefinitionApproval).not.toHaveBeenCalled();
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe("execution-successor");
    expect(active?.status).toBe("pending");
    expect(active?.definitionApprovalClaim).toMatchObject({
      claimId: "claim-interrupted",
    });
  });

  /**
   * A THROWN consumer failure is the one answer that carries no promise about
   * what it wrote: the production spec consumer commits its approval, admission
   * and event before the notification work that can throw. Handing the
   * reservation back there would reopen the park for a rejection or abort while
   * those records stand — written and lost. So the reservation is KEPT, and the
   * park stays undecidable until the settlement finishes the saga forward.
   */
  it("keeps the reservation when the admission consumer fails after it may have written", async () => {
    const { handlers, admitDefinitionApproval } = buildStack();
    await seedActive(parkedOneOff());
    admitDefinitionApproval.mockRejectedValue(
      new Error("approval granted, then the notifier failed"),
    );

    const response = await handlers.APPROVE_DEFINITION(
      makeRequest(APPROVE_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );

    expect(response.status).toBe(500);
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("pending");
    expect(active?.definitionApprovalClaim).not.toBeNull();

    // And nothing may end the run underneath that possible admission.
    const rejection = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", { executionId: "execution-parked" }),
      routeContext(),
    );
    expect(rejection.status).toBe(409);
    await expect(rejection.json()).resolves.toMatchObject({
      code: "decision_in_flight",
    });
  });

  it("rejects a parked TEMPLATE launch through the same execution-addressed act", async () => {
    const { handlers } = buildStack();
    await seedActive(
      parkedOneOff({
        id: "execution-template-parked",
        origin: {
          kind: "template",
          definitionId: "workflow-1",
          definitionRevision: 3,
          tier: "project",
        },
        seedDefinitionId: "workflow-1",
        seedDefinitionRevision: 3,
      }),
    );

    const response = await handlers.REJECT_DEFINITION(
      makeRequest(REJECT_URL, "POST", {
        executionId: "execution-template-parked",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe("aborted");
    expect(archived[0]!.haltReason).toMatchObject({
      cause: "definition_rejected",
    });
  });
});

/**
 * Origin-scoped agent mutation and session-wide human authority (R9.1, R9.2,
 * R9.4, R10.1).
 *
 * Every case here uses REAL capabilities minted under a test secret and
 * verified through the production verifiers, so what is under test is the
 * server deriving a principal from a signature — not a fixture asserting a
 * principal into place. The claim/authority distinction is the whole subject:
 * a conversation id that is merely presented must never decide anything.
 */
describe("graph workflow mutation principals", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const CAPABILITY_SECRET = "server-only-capability-key";
  const BASE_URL = `/api/projects/repo/sessions/${SESSION_NAME}/graph-workflow`;

  const ORIGIN_CONV = "conv-origin";
  const SIBLING_CONV = "conv-sibling";
  const LANE_CONV = "conv-lane";

  function ownedExecution(
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const base = createWorkflowExecution({
      id: "execution-owned",
      status: "running",
      ...overrides,
    });
    return {
      ...base,
      ownerConversationId: ORIGIN_CONV,
      // Binds the lane conversation to context-plan, which is what makes a lane
      // capability CURRENT rather than merely well-signed.
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running",
          lastConversationId: LANE_CONV,
        },
      },
      ...overrides,
    };
  }

  function conversationCapability(
    conversationId: string,
    sessionName: string = SESSION_NAME,
  ): Record<string, string> {
    return {
      [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
        { sessionName, conversationId },
        CAPABILITY_SECRET,
        1_760_000_000_000,
      ),
    };
  }

  function laneCapability(input: {
    executionId: string;
    contextId: string;
    conversationId: string;
  }): Record<string, string> {
    return {
      [LANE_CAPABILITY_HEADER]: mintLaneCapability(
        { laneKind: "implementer", ...input },
        CAPABILITY_SECRET,
        1_760_000_000_000,
      ),
    };
  }

  function buildStack(input: {
    execution: GraphWorkflowExecution | null;
    session?: SessionState;
    /** "absent" is the browser; "valid" is a token-bearing agent. */
    transport?: "absent" | "valid";
    /**
     * The active row as the SERIALIZED WRITE finds it, when the lease turned
     * over after the route read it. Every write fake below applies the
     * production fence assertion against this row, which is exactly what the
     * execution repository does inside its `mutateActive` critical section
     * (proven separately in execution-repository.test.ts) — so what these cases
     * test is whether the ROUTE established the fence around its write.
     */
    activeAtWriteTime?: GraphWorkflowExecution | null;
  }) {
    const mutationApplied = vi.fn();
    const atWriteTime = (): void => {
      if (input.activeAtWriteTime !== undefined) {
        assertExecutionPrincipalFence(
          PROJECT_PATH,
          SESSION_NAME,
          input.activeAtWriteTime,
        );
      }
      mutationApplied();
    };
    const pauseExecution = vi.fn(async () => {
      atWriteTime();
      return createWorkflowExecution({
        id: "execution-owned",
        status: "paused",
      });
    });
    const abortExecution = vi.fn(async () => {
      atWriteTime();
      return createWorkflowExecution({
        id: "execution-owned",
        status: "aborted",
      });
    });
    const abandonExecution = vi.fn(async () => {
      atWriteTime();
      return {
        ok: true as const,
        execution: createWorkflowExecution({
          id: "execution-owned",
          status: "aborted",
        }),
      };
    });
    const runExecution = vi.fn(async () => ({
      execution: createWorkflowExecution({
        id: "execution-new",
        status: "running",
        origin: { kind: "one_off" as const, planName: "Inline analysis" },
      }),
      awaitingDefinitionApproval: false,
    }));
    const startExecution = vi.fn(async () => ({
      execution: createWorkflowExecution({
        id: "execution-template",
        status: "running",
      }),
      awaitingDefinitionApproval: false,
    }));
    const resumeExecution = vi.fn(async () => {
      atWriteTime();
      return createWorkflowExecution({
        id: "execution-owned",
        status: "running",
      });
    });
    const resetExecutionContext = vi.fn(async () => {
      atWriteTime();
      return createWorkflowExecution({
        id: "execution-owned",
        status: "running",
      });
    });
    const resetExecutionContextAssignment = vi.fn(async () => {
      atWriteTime();
      return createWorkflowExecution({
        id: "execution-owned",
        status: "running",
      });
    });
    const recordApprovalDecision = vi.fn(async () => {
      atWriteTime();
      return {
        ok: true as const,
        execution: createWorkflowExecution({
          id: "execution-owned",
          status: "running",
        }),
      };
    });

    const session =
      input.session ??
      makeSession({
        conversations: [
          makeConversation(ORIGIN_CONV),
          makeConversation(SIBLING_CONV),
          makeConversation(LANE_CONV),
        ],
      });

    const handlers = createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name: string) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: async () => session,
      getActiveExecution: async () => input.execution,
      auth: {
        validateOptionalToken: async () => ({
          kind: input.transport ?? "absent",
        }),
      },
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
      pauseExecution,
      abortExecution,
      abandonExecution,
      runExecution,
      startExecution,
      launchSpecDeliveryExecution: async () => {
        throw new Error(
          "launchSpecDeliveryExecution should not run in a principal test",
        );
      },
      resumeExecution,
      resetExecutionContext,
      resetExecutionContextAssignment,
      recordApprovalDecision,
      kickOffExecutionLoop: vi.fn(async () => {}),
      markRunning: vi.fn(async () => {}),
      awaitingDefinitionApproval: vi.fn(async () => {}),
      readRepoConfig: async () => null,
      readConfig: async () => makeGlobalConfig(),
      normalizeExecutionAfterRestart: vi.fn(async () => input.execution),
      archiveExecution: async () => {
        throw new Error("archiveExecution should not run in a principal test");
      },
      recordPendingHaltReason: async () => {
        throw new Error(
          "recordPendingHaltReason should not run in a principal test",
        );
      },
      drainAndHalt: async () => {
        throw new Error("drainAndHalt should not run in a principal test");
      },
      executionAborted: vi.fn(async () => {}),
      stopExecutionLaneDevServers: vi.fn(async () => {}),
    } satisfies GraphWorkflowExecutionRouteDeps);

    return {
      handlers,
      pauseExecution,
      abortExecution,
      abandonExecution,
      runExecution,
      startExecution,
      resumeExecution,
      resetExecutionContext,
      resetExecutionContextAssignment,
      recordApprovalDecision,
      mutationApplied,
    };
  }

  const inlinePlan = () => ({
    name: "Inline analysis",
    description: "A one-off plan authored mid-conversation",
    definition: createWorkflowDefinition(),
    layout: createWorkflowLayout(),
  });

  const routeContext = () =>
    makeContext({ name: "repo", session: SESSION_NAME });

  const pause = (
    stack: ReturnType<typeof buildStack>,
    headers: Record<string, string>,
  ) =>
    stack.handlers.PAUSE(
      makeRequest(`${BASE_URL}/pause`, "POST", {}, headers),
      routeContext(),
    );

  interface MutationAct {
    verb: string;
    act(
      stack: ReturnType<typeof buildStack>,
      headers: Record<string, string>,
    ): Promise<Response>;
    /** The service call that would have written had the act been admitted. */
    write(stack: ReturnType<typeof buildStack>): { mock: { calls: unknown[] } };
  }

  /**
   * Every agent-reachable mutation of a launched run, paired with the write it
   * performs. Driving the principal cases from one table is the point: mutation
   * authority is a property of the route FAMILY, so a verb that grows its own
   * dispatch branch fails here rather than going unnoticed because only pause
   * ever had a principal test.
   *
   * The two tables are the two authorities. The lifecycle verbs read session
   * MEMBERSHIP: steering a run in flight is work any conversation the session
   * verified may do. Resolving a context's approval gate keeps launch
   * authority, because it answers a question the run posed to whoever launched
   * it rather than steering the run.
   */
  const MEMBERSHIP_MUTATIONS: readonly MutationAct[] = [
    {
      verb: "pause",
      act: (stack, headers) => pause(stack, headers),
      write: (stack) => stack.pauseExecution,
    },
    {
      verb: "resume",
      act: (stack, headers) =>
        stack.handlers.RESUME(
          makeRequest(`${BASE_URL}/resume`, "POST", {}, headers),
          routeContext(),
        ),
      write: (stack) => stack.resumeExecution,
    },
    {
      verb: "abort",
      act: (stack, headers) =>
        stack.handlers.ABORT(
          makeRequest(`${BASE_URL}/abort`, "POST", {}, headers),
          routeContext(),
        ),
      write: (stack) => stack.abortExecution,
    },
    {
      verb: "abandon",
      act: (stack, headers) =>
        stack.handlers.ABANDON(
          makeRequest(
            `${BASE_URL}/abandon`,
            "POST",
            { executionId: "execution-owned", reason: "operator cleanup" },
            headers,
          ),
          routeContext(),
        ),
      write: (stack) => stack.abandonExecution,
    },
    {
      verb: "reset-context",
      act: (stack, headers) =>
        stack.handlers.RESET_CONTEXT(
          makeRequest(
            `${BASE_URL}/reset-context`,
            "POST",
            { executionId: "execution-owned", contextId: "context-plan" },
            headers,
          ),
          routeContext(),
        ),
      write: (stack) => stack.resetExecutionContext,
    },
    {
      verb: "reset-assignment",
      act: (stack, headers) =>
        stack.handlers.RESET_ASSIGNMENT(
          makeRequest(
            `${BASE_URL}/reset-assignment`,
            "POST",
            {
              executionId: "execution-owned",
              contextId: "context-plan",
              assignmentId: "assignment-1",
            },
            headers,
          ),
          routeContext(),
        ),
      write: (stack) => stack.resetExecutionContextAssignment,
    },
  ];

  const ORIGIN_MUTATIONS: readonly MutationAct[] = [
    {
      verb: "resolve-approval",
      act: (stack, headers) =>
        stack.handlers.RESOLVE_APPROVAL(
          makeRequest(
            `${BASE_URL}/resolve-approval`,
            "POST",
            { contextId: "context-plan", decision: "approve" },
            headers,
          ),
          routeContext(),
        ),
      write: (stack) => stack.recordApprovalDecision,
    },
  ];

  /** Every guarded verb, for the cases both authorities answer identically. */
  const MUTATIONS: readonly MutationAct[] = [
    ...MEMBERSHIP_MUTATIONS,
    ...ORIGIN_MUTATIONS,
  ];

  const cases = (mutations: readonly MutationAct[]) =>
    mutations.map((mutation) => [mutation.verb, mutation] as const);

  // The same act from the origin and from a sibling now converges: membership
  // authority means which conversation launched the run is not what decides.
  it("admits the origin conversation and a sibling alike", async () => {
    const originStack = buildStack({
      execution: ownedExecution(),
      transport: "valid",
    });
    const fromOrigin = await pause(
      originStack,
      conversationCapability(ORIGIN_CONV),
    );

    expect(fromOrigin.status).toBe(200);
    expect(originStack.pauseExecution).toHaveBeenCalledTimes(1);

    const siblingStack = buildStack({
      execution: ownedExecution(),
      transport: "valid",
    });
    const fromSibling = await pause(
      siblingStack,
      conversationCapability(SIBLING_CONV),
    );

    expect(fromSibling.status).toBe(200);
    expect(siblingStack.pauseExecution).toHaveBeenCalledTimes(1);
  });

  // R9.2 — human UI authority is session-wide, whatever launched the run. The
  // write is asserted, not just the status: a guard that admitted the caller
  // and then dropped the act on the floor would pass a status-only check.
  it.each(cases(MUTATIONS))(
    "admits a credential-free human UI %s on a run another conversation launched",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "absent",
      });

      const response = await mutation.act(stack, {});

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  // The write is asserted, not just the status: a guard that admitted the
  // caller and then dropped the act on the floor would pass a status-only check.
  it.each(cases(MEMBERSHIP_MUTATIONS))(
    "admits a session conversation's %s on a run it did not launch",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        conversationCapability(SIBLING_CONV),
      );

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  // Answering a context's approval gate is not steering the run, so it keeps
  // launch authority: the origin is named, and the refusal is write-free.
  it.each(cases(ORIGIN_MUTATIONS))(
    "refuses a non-origin conversation's %s write-free, naming the origin",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        conversationCapability(SIBLING_CONV),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "non_origin_principal",
        originConversationId: ORIGIN_CONV,
      });
      expect(mutation.write(stack).mock.calls).toHaveLength(0);
    },
  );

  // Authorization is against the ACTIVE run; the body's id is ADDRESSING. An
  // admitted caller therefore reaches the service's separate execution-mismatch
  // refusal rather than being answered by the principal guard.
  it("dispatches an admitted abandon that names a stale execution to the service", async () => {
    const stack = buildStack({
      execution: ownedExecution(),
      transport: "valid",
    });

    await stack.handlers.ABANDON(
      makeRequest(
        `${BASE_URL}/abandon`,
        "POST",
        { executionId: "execution-stale", reason: "operator cleanup" },
        conversationCapability(SIBLING_CONV),
      ),
      routeContext(),
    );

    expect(stack.abandonExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-stale" }),
    );
  });

  // R10.1 — "cannot launch" is not "cannot act": the lane drives its own run.
  it.each(cases(MUTATIONS))(
    "admits the current lane's %s on the execution it is driving",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        laneCapability({
          executionId: "execution-owned",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  it("refuses a lane whose binding rotates before its first serialized pause write", async () => {
    const authorizedExecution = ownedExecution();
    const activeAtWriteTime: GraphWorkflowExecution = {
      ...authorizedExecution,
      taskStates: {
        ...authorizedExecution.taskStates,
        "task-plan-1": {
          ...authorizedExecution.taskStates["task-plan-1"]!,
          lastConversationId: "conv-successor-lane",
        },
      },
    };
    const stack = buildStack({
      execution: authorizedExecution,
      activeAtWriteTime,
      transport: "valid",
    });

    const response = await pause(
      stack,
      laneCapability({
        executionId: "execution-owned",
        contextId: "context-plan",
        conversationId: LANE_CONV,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_lane_principal",
      originConversationId: ORIGIN_CONV,
    });
    expect(stack.mutationApplied).not.toHaveBeenCalled();
  });

  // R9.4 — an id the caller merely presents is not authority, even when it
  // names a conversation this session really has. Read on the verb that still
  // discriminates by origin: under membership authority the claim buys nothing
  // because the signed sibling identity is already admitted.
  it("refuses an agent whose claimed conversation header is not its signed identity", async () => {
    const stack = buildStack({
      execution: ownedExecution(),
      transport: "valid",
    });

    const response = await stack.handlers.RESOLVE_APPROVAL(
      makeRequest(
        `${BASE_URL}/resolve-approval`,
        "POST",
        { contextId: "context-plan", decision: "approve" },
        {
          ...conversationCapability(SIBLING_CONV),
          [OWNER_CONVERSATION_HEADER]: ORIGIN_CONV,
        },
      ),
      routeContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "non_origin_principal",
    });
    expect(stack.recordApprovalDecision).not.toHaveBeenCalled();
  });

  // R9.4 — a deleted origin leaves a run no agent can act on, while the human
  // UI still can. The capability outlives the conversation; membership does not.
  it("admits no agent once the origin conversation is deleted, but still admits the human UI", async () => {
    const sessionWithoutOrigin = makeSession({
      conversations: [makeConversation(SIBLING_CONV)],
    });

    const agentStack = buildStack({
      execution: ownedExecution(),
      session: sessionWithoutOrigin,
      transport: "valid",
    });
    const agent = await pause(agentStack, conversationCapability(ORIGIN_CONV));

    expect(agent.status).toBe(403);
    await expect(agent.json()).resolves.toMatchObject({
      code: "unverified_principal",
    });
    expect(agentStack.pauseExecution).not.toHaveBeenCalled();

    const humanStack = buildStack({
      execution: ownedExecution(),
      session: sessionWithoutOrigin,
      transport: "absent",
    });
    const human = await pause(humanStack, {});

    expect(human.status).toBe(200);
    expect(humanStack.pauseExecution).toHaveBeenCalledTimes(1);
  });

  const sessionWithoutOriginConversation = () =>
    makeSession({
      conversations: [
        makeConversation(SIBLING_CONV),
        makeConversation(LANE_CONV),
      ],
    });

  // A lane's authority to drive its own context never came from the origin
  // conversation; the deleted-origin gate refused it only as collateral of the
  // rule that the origin is the one conversation that may act.
  it.each(cases(MEMBERSHIP_MUTATIONS))(
    "admits the current lane's %s once the execution origin is deleted",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        session: sessionWithoutOriginConversation(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        laneCapability({
          executionId: "execution-owned",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  it.each(cases(MEMBERSHIP_MUTATIONS))(
    "admits a session conversation's %s once the execution origin is deleted",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        session: sessionWithoutOriginConversation(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        conversationCapability(SIBLING_CONV),
      );

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  // Under launch authority the vacancy is inherited by nobody, lane included.
  it.each(cases(ORIGIN_MUTATIONS))(
    "refuses the current lane's %s write-free once the execution origin is deleted",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        session: sessionWithoutOriginConversation(),
        transport: "valid",
      });

      const response = await mutation.act(
        stack,
        laneCapability({
          executionId: "execution-owned",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "origin_conversation_absent",
        originConversationId: ORIGIN_CONV,
      });
      expect(mutation.write(stack).mock.calls).toHaveLength(0);
    },
  );

  // R9.4 — the cheapest escalation on the port: present a junk lane header and
  // nothing else. Reading "failed to authenticate" as "must be the browser"
  // would answer it with session-wide authority.
  it.each(cases(MUTATIONS))(
    "refuses a forged lane credential's %s write-free instead of reading it as the human UI",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "absent",
      });

      const response = await mutation.act(stack, {
        [LANE_CAPABILITY_HEADER]: "cclc1.ZmFrZQ.bm90LWEtc2lnbmF0dXJl",
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "unverified_principal",
      });
      expect(mutation.write(stack).mock.calls).toHaveLength(0);
    },
  );

  // R9.4 — a lane capability signs no session, so membership is the only thing
  // binding it to one. Without it, a credential minted in another session (or
  // one whose conversation is gone) still acts here.
  it("refuses a well-signed lane whose conversation this session does not have", async () => {
    const stack = buildStack({
      execution: ownedExecution(),
      session: makeSession({
        conversations: [makeConversation(ORIGIN_CONV)],
      }),
      transport: "valid",
    });

    const response = await pause(
      stack,
      laneCapability({
        executionId: "execution-owned",
        contextId: "context-plan",
        conversationId: LANE_CONV,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "unverified_principal",
    });
    expect(stack.pauseExecution).not.toHaveBeenCalled();
  });

  // R9.1/R9.4 — the guard authorizes the run it READ; the write goes to
  // "the session's active run". Those diverge exactly when E1 settles and a
  // successor takes the lease in the gap, and that is when an authorization
  // that named E1's origin must NOT be spent on E2.
  it.each(cases(MUTATIONS))(
    "refuses the origin's %s once a successor took the lease mid-act",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "valid",
        activeAtWriteTime: createWorkflowExecution({
          id: "execution-successor",
          status: "running",
        }),
      });

      const response = await mutation.act(
        stack,
        conversationCapability(ORIGIN_CONV),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "execution_turnover",
      });
    },
  );

  it.each(cases(MUTATIONS))(
    "carries a current lane's %s authority no further than its own execution",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "valid",
        activeAtWriteTime: createWorkflowExecution({
          id: "execution-successor",
          status: "running",
        }),
      });

      const response = await mutation.act(
        stack,
        laneCapability({
          executionId: "execution-owned",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "execution_turnover",
      });
    },
  );

  // R9.2 — the human UI is session-wide by contract, so it is deliberately
  // NOT fenced: "pause whatever this session is running" is the act, and
  // pinning it to a run the operator has since replaced would break it.
  it.each(cases(MUTATIONS))(
    "leaves the human UI's %s unfenced across a lease turnover",
    async (_verb, mutation) => {
      const stack = buildStack({
        execution: ownedExecution(),
        transport: "absent",
        activeAtWriteTime: createWorkflowExecution({
          id: "execution-successor",
          status: "running",
        }),
      });

      const response = await mutation.act(stack, {});

      expect(response.status).toBe(200);
      expect(mutation.write(stack).mock.calls).toHaveLength(1);
    },
  );

  it("refuses a lane whose binding has moved on", async () => {
    // The retired lane's conversation still EXISTS in the session — it is only
    // no longer the one driving the context. Keeping it in membership is what
    // isolates the freshness half of lane authority from the membership half.
    const stack = buildStack({
      execution: ownedExecution(),
      session: makeSession({
        conversations: [
          makeConversation(ORIGIN_CONV),
          makeConversation(SIBLING_CONV),
          makeConversation(LANE_CONV),
          makeConversation("conv-retired-lane"),
        ],
      }),
      transport: "valid",
    });

    const response = await pause(
      stack,
      laneCapability({
        executionId: "execution-owned",
        contextId: "context-plan",
        conversationId: "conv-retired-lane",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_lane_principal",
    });
    expect(stack.pauseExecution).not.toHaveBeenCalled();
  });

  it.each([ORIGIN_CONV, SIBLING_CONV])(
    "derives a template start's owner from ordinary conversation %s, never the claimed id",
    async (conversationId) => {
      const stack = buildStack({ execution: null, transport: "valid" });

      const response = await stack.handlers.START(
        makeRequest(
          BASE_URL,
          "POST",
          { definitionId: "workflow-def-1" },
          {
            ...conversationCapability(conversationId),
            [OWNER_CONVERSATION_HEADER]: "conv-claimed",
          },
        ),
        routeContext(),
      );

      expect(response.status).toBe(202);
      expect(stack.startExecution).toHaveBeenCalledWith(
        expect.objectContaining({ ownerConversationId: conversationId }),
      );
      expect(stack.startExecution).not.toHaveBeenCalledWith(
        expect.objectContaining({ ownerConversationId: "conv-claimed" }),
      );
    },
  );

  // R10.1 — both launch verbs, because nesting is a property of launching, not
  // of the inline dialect: a lane denied `run` that could still `start` a
  // template would nest a run inside a run through the other door.
  it.each([
    [
      "run",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.RUN(
          makeRequest(
            `${BASE_URL}/run`,
            "POST",
            { plan: inlinePlan() },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.runExecution,
    ],
    [
      "start",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.START(
          makeRequest(
            `${BASE_URL}`,
            "POST",
            { definitionId: "workflow-def-1" },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.startExecution,
    ],
  ])(
    "refuses a lane's workflow %s as nesting even with the lease free, and creates nothing",
    async (_verb, launch, launched) => {
      // No active execution: the session's lease is FREE, so nothing but the
      // nesting rule itself can be producing this refusal.
      const stack = buildStack({ execution: null, transport: "valid" });

      const response = await launch(
        stack,
        laneCapability({
          executionId: "execution-owned",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "workflow_nesting_refused",
      });
      expect(launched(stack)).not.toHaveBeenCalled();
    },
  );

  // R10.1 — a lane credential that FAILS to authenticate must not buy more than
  // one that succeeds. A valid lane is refused as nesting; an invalid one that
  // fell through to the human-UI branch would be admitted to launch outright,
  // which is the escalation this pins closed on both launch doors.
  it.each([
    [
      "run",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.RUN(
          makeRequest(
            `${BASE_URL}/run`,
            "POST",
            { plan: inlinePlan() },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.runExecution,
    ],
    [
      "start",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.START(
          makeRequest(
            `${BASE_URL}`,
            "POST",
            { definitionId: "workflow-def-1" },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.startExecution,
    ],
  ] as const)(
    "refuses a forged lane credential's workflow %s and creates nothing",
    async (_verb, launch, launched) => {
      const stack = buildStack({ execution: null, transport: "absent" });

      const response = await launch(stack, {
        [LANE_CAPABILITY_HEADER]: "cclc1.ZmFrZQ.bm90LWEtc2lnbmF0dXJl",
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "unverified_principal",
      });
      expect(launched(stack)).not.toHaveBeenCalled();
    },
  );

  // A lane capability signs no session, so a credential minted elsewhere — or
  // one whose conversation has since been deleted — reaches the launch door
  // perfectly well signed. Identity fails first, before the nesting rule: the
  // server never establishes a lane principal it cannot place in this session.
  it.each([
    [
      "run",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.RUN(
          makeRequest(
            `${BASE_URL}/run`,
            "POST",
            { plan: inlinePlan() },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.runExecution,
    ],
    [
      "start",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.START(
          makeRequest(
            `${BASE_URL}`,
            "POST",
            { definitionId: "workflow-def-1" },
            headers,
          ),
          routeContext(),
        ),
      (stack: ReturnType<typeof buildStack>) => stack.startExecution,
    ],
  ] as const)(
    "refuses a nonmember lane's workflow %s and creates nothing",
    async (_verb, launch, launched) => {
      const stack = buildStack({
        execution: null,
        transport: "valid",
        session: makeSession({
          conversations: [makeConversation(ORIGIN_CONV)],
        }),
      });

      const response = await launch(
        stack,
        laneCapability({
          executionId: "execution-elsewhere",
          contextId: "context-plan",
          conversationId: LANE_CONV,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "unverified_principal",
      });
      expect(launched(stack)).not.toHaveBeenCalled();
    },
  );

  // The boundary of the turnover pin, stated as a contract rather than left to
  // be inferred. A lane's admission asks two questions — is this my execution,
  // and am I still driving my context — and both are re-asked at the first
  // serialized write. That successful check retains admission for the rest of
  // the act: `pause` retires the running task the binding resolves through, so
  // re-deriving freshness after the act's own first write would refuse its
  // follow-through writes.
  it("keeps a current lane's act on its own execution admitted through the write", async () => {
    const stack = buildStack({
      execution: ownedExecution(),
      transport: "valid",
      activeAtWriteTime: ownedExecution(),
    });

    const response = await pause(
      stack,
      laneCapability({
        executionId: "execution-owned",
        contextId: "context-plan",
        conversationId: LANE_CONV,
      }),
    );

    expect(response.status).toBe(200);
    expect(stack.pauseExecution).toHaveBeenCalledTimes(1);
  });

  // The two human-review acts. "Human-only" has to mean the absence of EVERY
  // agent credential: an agent holding a capability can simply omit the
  // instance token, so a handler that reads only the token would hand it the
  // review act it is barred from.
  it.each([
    [
      "approval",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.APPROVE_DEFINITION(
          makeRequest(
            `${BASE_URL}/approve-definition`,
            "POST",
            { executionId: "execution-owned" },
            headers,
          ),
          routeContext(),
        ),
    ],
    [
      "rejection",
      (stack: ReturnType<typeof buildStack>, headers: Record<string, string>) =>
        stack.handlers.REJECT_DEFINITION(
          makeRequest(
            `${BASE_URL}/reject-definition`,
            "POST",
            { executionId: "execution-owned" },
            headers,
          ),
          routeContext(),
        ),
    ],
  ])(
    "refuses definition %s to a capability-bearing caller that presents no token",
    async (_act, decide) => {
      const stack = buildStack({
        execution: ownedExecution({ status: "pending" }),
        transport: "absent",
      });

      const response = await decide(stack, conversationCapability(ORIGIN_CONV));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "human_act_required",
      });
    },
  );
});

/**
 * The turnover race end to end, on the real (in-memory SQLite) store.
 *
 * The stack above proves the ROUTE establishes the fence; the repository suite
 * proves the critical section applies it. This proves the property they exist
 * for: an authorization granted over E1 does not write to E2, and the refusal
 * leaves E2 byte-for-byte as it was. Only a real store can answer that — a fake
 * cannot tell "refused before the reducer" from "reduced and discarded".
 */
describe("graph workflow mutation turnover — end to end", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";
  const CAPABILITY_SECRET = "server-only-capability-key";
  const ORIGIN_CONV = "conv-origin";
  const BASE_URL = `/api/projects/repo/sessions/${SESSION_NAME}/graph-workflow`;

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  it("refuses the origin's pause against a successor and leaves the successor untouched", async () => {
    const repository = createGraphWorkflowExecutionRepository({
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
      eventPublisher: createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        dispatchPush: () => {},
      }),
    });
    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
    });

    // The successor holds the lease and belongs to nobody the caller can be.
    const successor = {
      ...createWorkflowExecution({
        id: "execution-successor",
        status: "running",
      }),
      ownerConversationId: null,
    };
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedSuccessor",
      () => ({ execution: successor, events: [] }),
    );
    const before = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    const unusedRouteDep = async (): Promise<never> => {
      throw new Error("unused dependency reached in the pause turnover test");
    };

    const handlers = createGraphWorkflowExecutionRouteHandlers({
      resolveProjectPath: async (name: string) =>
        name === "repo" ? PROJECT_PATH : null,
      getSession: async () =>
        makeSession({ conversations: [makeConversation(ORIGIN_CONV)] }),
      normalizeExecutionAfterRestart: unusedRouteDep,
      startExecution: unusedRouteDep,
      runExecution: unusedRouteDep,
      launchSpecDeliveryExecution: unusedRouteDep,
      // The stale read that IS the race: the route authorizes the run the
      // caller launched, which settled a moment ago.
      getActiveExecution: async () => ({
        ...createWorkflowExecution({
          id: "execution-owned",
          status: "running",
        }),
        ownerConversationId: ORIGIN_CONV,
      }),
      pauseExecution: (projectPath: string, sessionName: string) =>
        manager.send(projectPath, sessionName, { type: "pause" }),
      resumeExecution: unusedRouteDep,
      abortExecution: unusedRouteDep,
      resetExecutionContext: unusedRouteDep,
      resetExecutionContextAssignment: unusedRouteDep,
      archiveExecution: unusedRouteDep,
      kickOffExecutionLoop: unusedRouteDep,
      recordPendingHaltReason: unusedRouteDep,
      drainAndHalt: unusedRouteDep,
      recordApprovalDecision: unusedRouteDep,
      auth: { validateOptionalToken: async () => ({ kind: "valid" as const }) },
      verifyConversationCapability: async (request: Request) =>
        verifyConversationCapability(
          request.headers.get(CONVERSATION_CAPABILITY_HEADER),
          CAPABILITY_SECRET,
        ),
    } satisfies GraphWorkflowExecutionRouteDeps);

    const response = await handlers.PAUSE(
      makeRequest(
        `${BASE_URL}/pause`,
        "POST",
        {},
        {
          [CONVERSATION_CAPABILITY_HEADER]: mintConversationCapability(
            { sessionName: SESSION_NAME, conversationId: ORIGIN_CONV },
            CAPABILITY_SECRET,
            1_760_000_000_000,
          ),
        },
      ),
      makeContext({ name: "repo", session: SESSION_NAME }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_turnover",
      authorizedExecutionId: "execution-owned",
      activeExecutionId: "execution-successor",
    });

    // Write-free, proven against the persisted row rather than a spy: the
    // successor is still running and its state revision never advanced, which
    // it would have on any committed mutation — including one that reduced to
    // an unchanged execution.
    const after = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(after?.status).toBe("running");
    expect(after?.executionStateRevision).toBe(before?.executionStateRevision);
    expect(
      fixture.graphWorkflowEvents.findRecordsByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-successor",
      ),
    ).toEqual([]);
  });
});
