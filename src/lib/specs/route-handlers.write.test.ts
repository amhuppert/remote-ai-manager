import { describe, expect, it, vi } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { PersistenceError } from "@/lib/shared/errors";
import {
  SpecElementIdTakenError,
  StaleStageConflictError,
} from "@/lib/state-store/specs-repo";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import {
  SpecSlugTakenError,
  StageBlockedWriteError,
} from "./authoring-service";
import type { Spec } from "./schemas";
import {
  createSpecWriteRouteHandlers,
  type SpecMutationServices,
  type SpecWriteRouteDeps,
} from "./route-handlers";

const spec: Spec = {
  id: "spec-1",
  projectPath: "/repos/demo",
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

function routeContext(action: string) {
  return {
    params: Promise.resolve({ name: "demo", slug: spec.slug, action }),
  };
}

function projectRouteContext(action: string) {
  return {
    params: Promise.resolve({ name: "demo", action }),
  };
}

const firstElement = {
  elementId: "requirement-1",
  kind: "requirement",
  parentElementId: null,
  position: 0,
  payload: {
    kind: "requirement",
    statement: "Specs are born from the first draft save.",
    priority: "must",
    risk: "high",
  },
} as const;

const createBody = {
  slug: spec.slug,
  name: spec.name,
  gatePolicy: spec.gatePolicy,
  initialElement: firstElement,
} as const;

function postRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    `http://cc.test/api/specs/demo/${spec.slug}/actions/test`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}

const auth: AgentAuth = {
  async requireToken(request) {
    const result = await this.validateOptionalToken(request);
    return result.kind === "valid"
      ? null
      : Response.json({ error: "Invalid token" }, { status: 401 });
  },
  async validateOptionalToken(request) {
    const value = request.headers.get("authorization");
    if (value === null) return { kind: "absent" };
    return value === "Bearer valid" ? { kind: "valid" } : { kind: "invalid" };
  },
};

function createServices() {
  return {
    authoring: {
      createSpec: vi.fn(),
      upsertDraftElement: vi.fn(),
      upsertDraftElements: vi.fn(),
      reorderDraftElement: vi.fn(),
      removeDraftElement: vi.fn(),
      openAmendment: vi.fn(),
      renameSpec: vi.fn(async () => ({
        spec: { ...spec, slug: "native-sdd-v2" },
        alias: {
          projectPath: spec.projectPath,
          slug: spec.slug,
          specId: spec.id,
          createdAt: "2026-07-19T00:00:00.000Z",
        },
      })),
      proposeRevision: vi.fn(async () => ({
        ok: true as const,
        revision: { id: "revision-1" },
        diff: { changes: [] },
        absorbedSignOff: false,
      })),
      advanceAuthoringStage: vi.fn(async () => ({
        ok: true as const,
        revision: {
          id: "revision-1",
          specId: spec.id,
          number: 1,
          state: "draft" as const,
          authoringStage: "design" as const,
          basedOnRevisionId: null,
          contentHash: null,
          proposedAt: null,
          approvedAt: null,
          createdAt: "2026-07-18T00:00:00.000Z",
        },
      })),
    },
    review: {
      comment: vi.fn(),
      resolveThread: vi.fn(),
      requestChanges: vi.fn(),
      approveItem: vi.fn(async () => ({
        ok: true as const,
        value: { id: "approval-1" },
      })),
      unapproveItem: vi.fn(async () => ({
        ok: true as const,
        value: { id: "approval-1" },
      })),
      signOffRevision: vi.fn(),
      grantGateApproval: vi.fn(async () => ({
        ok: true as const,
        value: { id: "approval-delivery-1" },
      })),
      withdraw: vi.fn(),
      bulkApprove: vi.fn(),
      openQuestion: vi.fn(async (input: unknown) => ({
        ok: true as const,
        value: { id: "question-1", number: 1, input },
      })),
      answerQuestion: vi.fn(),
      proposeAssumption: vi.fn(),
      disposeAssumption: vi.fn(async () => ({
        ok: true as const,
        value: {
          id: "assumption-1",
          spec_id: "spec-1",
          number: 1,
          element_id: null,
          text: "Assuming the default locale.",
          proposed_by_json: JSON.stringify({
            kind: "agent",
            conversationId: "conversation-agent",
          }),
          disposition: "confirmed" as const,
          disposed_at: "2026-07-18T01:00:00.000Z",
          created_at: "2026-07-18T00:00:00.000Z",
          updated_at: "2026-07-18T01:00:00.000Z",
        },
      })),
      changePolicy: vi.fn(),
    },
    evidence: {
      attachEvidence: vi.fn(),
      recordProofVerdict: vi.fn(),
      claimTaskComplete: vi.fn(),
      reopenTaskClaim: vi.fn(),
      requestWaiver: vi.fn(),
      grantWaiver: vi.fn(),
      markWaiverStaleForCriterionChange: vi.fn(),
      setDisposition: vi.fn(),
    },
    execution: {
      start: vi.fn(),
      approveExecutionStart: vi.fn(async () => ({
        ok: true as const,
        value: { id: "execution-1", state: "running" },
      })),
      linkWorkflowExecution: vi.fn(),
      markRunning: vi.fn(),
      markDelivered: vi.fn(),
      abandonExecution: vi.fn(),
      abandonSpec: vi.fn(),
      captureScopeAmendment: vi.fn(),
      getStatus: vi.fn(),
    },
    links: {
      promoteConversation: vi.fn(),
      graduateTicket: vi.fn(),
      materializeApprovedTasks: vi.fn(),
      linkTicket: vi.fn(),
      getSpecLinkedTickets: vi.fn(),
      getTicketReadThrough: vi.fn(),
    },
    ingestEvidenceBestEffort: vi.fn(),
    verify: vi.fn(async () => ({
      ok: false,
      checkedRevisionIds: ["revision-1"],
      mismatches: [{ revisionId: "revision-1" }],
    })),
  } as unknown as SpecMutationServices;
}

function createDeps(services: SpecMutationServices): SpecWriteRouteDeps {
  return {
    auth,
    resolveProjectPath: async (name) =>
      name === "demo" ? spec.projectPath : null,
    resolveSpec: async (projectPath, slug) =>
      projectPath === spec.projectPath && slug === spec.slug ? spec : null,
    getServices: async () => services,
  };
}

describe("spec write route handlers", () => {
  it("rejects a create body without a first element before reaching the service", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.projectActionPOST(
      postRequest(
        { slug: spec.slug, name: spec.name, gatePolicy: spec.gatePolicy },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      projectRouteContext("create"),
    );

    expect(response.status).toBe(400);
    expect(services.authoring.createSpec).not.toHaveBeenCalled();
  });

  it("forwards the first element and transport actor to one createSpec call", async () => {
    const services = createServices();
    vi.mocked(services.authoring.createSpec).mockResolvedValueOnce({
      spec,
      draft: { id: "revision-1" },
      element: { id: firstElement.elementId },
      version: { elementVersion: 1 },
    } as never);
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.projectActionPOST(
      postRequest(createBody, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
        "x-cc-agent-backend": "codex",
      }),
      projectRouteContext("create"),
    );

    expect(response.status).toBe(200);
    expect(services.authoring.createSpec).toHaveBeenCalledWith({
      slug: spec.slug,
      name: spec.name,
      gatePolicy: spec.gatePolicy,
      initialElement: firstElement,
      projectPath: spec.projectPath,
      actor: {
        kind: "agent",
        conversationId: "conversation-agent",
        backend: "codex",
      },
    });
  });

  it("maps a taken slug to HTTP 409 with the typed slug_taken refusal", async () => {
    const services = createServices();
    vi.mocked(services.authoring.createSpec).mockRejectedValueOnce(
      new SpecSlugTakenError(spec.projectPath, spec.slug, spec.id, spec.name),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.projectActionPOST(
      postRequest(createBody, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      projectRouteContext("create"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "slug_taken",
      details: { existingSpecId: spec.id },
      instruction: expect.stringContaining("cctl spec"),
    });
  });

  it("identifies a globally reused element ID and tells the caller how to recover", async () => {
    const services = createServices();
    vi.mocked(services.authoring.createSpec).mockRejectedValueOnce(
      new SpecElementIdTakenError("sec-problem", "spec-existing"),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.projectActionPOST(
      postRequest(createBody, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      projectRouteContext("create"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "element_id_taken",
      unmetConditions: [
        'Spec element ID "sec-problem" is already used by spec "spec-existing"; element IDs are globally unique.',
      ],
      instruction:
        'Choose a globally unique element ID, preferably prefixed with the spec slug (for example, "<spec-slug>-sec-problem"), then retry.',
      details: {
        elementId: "sec-problem",
        existingSpecId: "spec-existing",
      },
    });
  });

  it("preserves a stage-blocked write refusal at the HTTP boundary", async () => {
    const services = createServices();
    const refusal = {
      code: "stage_blocked" as const,
      unmetConditions: [
        "A task cannot be authored during the requirements stage.",
      ],
      instruction:
        "Propose the requirements stage and obtain sign-off before authoring task content.",
    };
    vi.mocked(services.authoring.createSpec).mockRejectedValueOnce(
      new StageBlockedWriteError(refusal),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.projectActionPOST(
      postRequest(createBody, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      projectRouteContext("create"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(refusal);
  });

  it.each([
    ["gate_blocked", 409],
    ["lint_blocked", 409],
    ["human_act_required", 403],
    ["validation", 400],
    ["not_found", 404],
  ] as const)(
    "maps %s refusals to HTTP %i with the body unchanged",
    async (code, status) => {
      const services = createServices();
      const refusal = {
        code,
        unmetConditions: [`${code} condition`],
        instruction: `${code} instruction`,
      };
      vi.mocked(services.authoring.proposeRevision).mockResolvedValueOnce({
        ok: false,
        refusal,
      });
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest(
          { revisionId: "revision-1" },
          {
            authorization: "Bearer valid",
            "x-cc-conversation-id": "conversation-1",
          },
        ),
        routeContext("propose"),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(refusal);
    },
  );

  it("forwards an expected-stage advance with transport provenance", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        { revisionId: "revision-1", expectedStage: "requirements" },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
          "x-cc-agent-backend": "codex",
        },
      ),
      routeContext("advance"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: { id: "revision-1", authoringStage: "design" },
    });
    expect(services.authoring.advanceAuthoringStage).toHaveBeenCalledWith({
      specId: spec.id,
      revisionId: "revision-1",
      expectedStage: "requirements",
      actor: {
        kind: "agent",
        conversationId: "conversation-agent",
        backend: "codex",
      },
    });
  });

  it("returns the winning draft on a stale-stage advance conflict", async () => {
    const services = createServices();
    const currentRevision = {
      id: "revision-2",
      specId: spec.id,
      number: 2,
      state: "draft" as const,
      authoringStage: "design" as const,
      basedOnRevisionId: "revision-1",
      contentHash: null,
      proposedAt: null,
      approvedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    vi.mocked(services.authoring.advanceAuthoringStage).mockRejectedValueOnce(
      new StaleStageConflictError(
        spec.id,
        "revision-1",
        "requirements",
        currentRevision,
      ),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        { revisionId: "revision-1", expectedStage: "requirements" },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("advance"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_stage",
      instruction: expect.stringContaining("advance that exact revision"),
      details: {
        expectedRevisionId: "revision-1",
        expectedStage: "requirements",
        currentRevision: { id: "revision-2", authoringStage: "design" },
      },
    });
  });

  it("points a draft-less advance conflict at the command that opens a draft", async () => {
    const services = createServices();
    vi.mocked(services.authoring.advanceAuthoringStage).mockRejectedValueOnce(
      new StaleStageConflictError(spec.id, "revision-7", "design", null),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        { revisionId: "revision-7", expectedStage: "design" },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("advance"),
    );

    expect(response.status).toBe(409);
    const refusal: unknown = await response.json();
    expect(refusal).toMatchObject({
      code: "stale_stage",
      details: { expectedRevisionId: "revision-7", currentRevision: null },
    });
    const instruction =
      typeof refusal === "object" &&
      refusal !== null &&
      "instruction" in refusal &&
      typeof refusal.instruction === "string"
        ? refusal.instruction
        : "";
    expect(instruction).toContain(`cctl spec amend ${spec.slug}`);
    expect(instruction).not.toContain("Read the current draft");
  });

  it("derives and records actor provenance from both transports", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const agentResponse = await handlers.specActionPOST(
      postRequest(
        { elementId: null, text: "Agent question" },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
          "x-cc-agent-backend": "codex",
        },
      ),
      routeContext("open-question"),
    );
    expect(agentResponse.status).toBe(200);

    const humanResponse = await handlers.specActionPOST(
      postRequest({ elementId: null, text: "Human question" }),
      routeContext("open-question"),
    );
    expect(humanResponse.status).toBe(200);

    expect(services.review.openQuestion).toHaveBeenNthCalledWith(1, {
      specId: spec.id,
      elementId: null,
      text: "Agent question",
      actor: {
        kind: "agent",
        conversationId: "conversation-agent",
        backend: "codex",
      },
    });
    expect(services.review.openQuestion).toHaveBeenNthCalledWith(2, {
      specId: spec.id,
      elementId: null,
      text: "Human question",
      actor: { kind: "human" },
    });
  });

  it("returns the handle allocated to a newly opened question", async () => {
    const services = createServices();
    vi.mocked(services.review.openQuestion).mockResolvedValueOnce({
      ok: true as const,
      value: {
        id: "question-1",
        spec_id: spec.id,
        number: 3,
        element_id: null,
        text: "Which backend owns retries?",
        provenance_json: JSON.stringify({ kind: "human" }),
        status: "open" as const,
        answer: null,
        answered_at: null,
        created_at: "2026-07-18T00:00:00.000Z",
        updated_at: "2026-07-18T00:00:00.000Z",
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({ elementId: null, text: "Which backend owns retries?" }),
      routeContext("open-question"),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    // The writer gets the same domain shape every read projects — camelCase
    // fields and parsed provenance, never the raw persistence row.
    expect(body).toMatchObject({
      id: "question-1",
      number: 3,
      handle: "Q3",
      elementId: null,
      status: "open",
      provenance: { kind: "human" },
    });
    expect(body).not.toHaveProperty("spec_id");
    expect(body).not.toHaveProperty("provenance_json");
  });

  it("returns the domain-shaped assumption for propose and dispose", async () => {
    const services = createServices();
    const assumptionRow = {
      id: "assumption-2",
      spec_id: spec.id,
      number: 2,
      element_id: "requirement-1",
      text: "Assuming the default locale.",
      proposed_by_json: JSON.stringify({
        kind: "agent",
        conversationId: "conversation-agent",
      }),
      disposition: "proposed" as const,
      disposed_at: null,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    };
    vi.mocked(services.review.proposeAssumption).mockResolvedValueOnce({
      ok: true as const,
      value: assumptionRow,
    });
    vi.mocked(services.review.disposeAssumption).mockResolvedValueOnce({
      ok: true as const,
      value: {
        ...assumptionRow,
        disposition: "confirmed" as const,
        disposed_at: "2026-07-18T01:00:00.000Z",
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const proposed = await handlers.specActionPOST(
      postRequest(
        { elementId: "requirement-1", text: "Assuming the default locale." },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("propose-assumption"),
    );
    expect(proposed.status).toBe(200);
    const proposedBody: unknown = await proposed.json();
    expect(proposedBody).toMatchObject({
      id: "assumption-2",
      handle: "A2",
      elementId: "requirement-1",
      disposition: "proposed",
      proposedBy: { kind: "agent", conversationId: "conversation-agent" },
    });
    expect(proposedBody).not.toHaveProperty("proposed_by_json");

    const disposed = await handlers.specActionPOST(
      postRequest({ assumptionId: "assumption-2", disposition: "confirmed" }),
      routeContext("dispose-assumption"),
    );
    expect(disposed.status).toBe(200);
    const disposedBody: unknown = await disposed.json();
    expect(disposedBody).toMatchObject({
      id: "assumption-2",
      handle: "A2",
      disposition: "confirmed",
      disposedAt: "2026-07-18T01:00:00.000Z",
    });
    expect(disposedBody).not.toHaveProperty("disposed_at");
  });

  it("returns the started execution in the domain shape with its parsed scope", async () => {
    const services = createServices();
    vi.mocked(services.execution.start).mockResolvedValueOnce({
      ok: true as const,
      execution: {
        id: "execution-9",
        spec_id: spec.id,
        revision_id: "revision-1",
        scope_json: JSON.stringify({
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: ["criterion-1"],
          exclusionDispositions: [],
        }),
        state: "definition_review" as const,
        workflow_definition_id: "workflow-definition-1",
        workflow_execution_id: null,
        session_name: "feature-session",
        delivered_at: null,
        abandoned_reason: null,
        created_at: "2026-07-18T00:00:00.000Z",
        updated_at: "2026-07-18T00:00:00.000Z",
      },
      definition: createWorkflowDefinitionRecord({
        id: "workflow-definition-1",
      }),
      revisionNumber: 4,
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({
        revisionId: "revision-1",
        scope: {
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: ["criterion-1"],
          exclusionDispositions: [],
        },
        sessionName: "feature-session",
      }),
      routeContext("start-execution"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      execution: {
        id: "execution-9",
        specId: spec.id,
        revisionId: "revision-1",
        revisionNumber: 4,
        state: "definition_review",
        workflowDefinitionId: "workflow-definition-1",
        workflowExecutionId: null,
        scope: {
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: ["criterion-1"],
          exclusionDispositions: [],
        },
        sessionName: "feature-session",
      },
      definition: { id: "workflow-definition-1" },
    });
    expect(body.execution).not.toHaveProperty("scope_json");
    expect(body.execution).not.toHaveProperty("spec_id");
  });

  it("passes the human transport actor through every evidence mutation that records separate provenance", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const cases = [
      ["reopen-claim", { claimId: "claim-1" }],
      [
        "grant-waiver",
        {
          criterionElementId: "criterion-1",
          revisionId: "revision-1",
          reason: "Human judgment",
        },
      ],
      [
        "mark-waiver-stale",
        { waiverId: "waiver-1", laterRevisionId: "revision-2" },
      ],
      [
        "set-disposition",
        {
          executionId: "execution-1",
          criterionElementId: "criterion-1",
          disposition: "delivered_elsewhere",
          deliveredByExecutionId: "execution-prior",
        },
      ],
    ] as const;

    for (const [action, body] of cases) {
      const response = await handlers.specActionPOST(
        postRequest(body),
        routeContext(action),
      );
      expect(response.status).toBe(200);
    }

    expect(services.evidence.reopenTaskClaim).toHaveBeenCalledWith("claim-1", {
      kind: "human",
    });
    expect(services.evidence.grantWaiver).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "human" } }),
    );
    expect(
      services.evidence.markWaiverStaleForCriterionChange,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "human" } }),
    );
    expect(services.evidence.setDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "human" } }),
    );
  });

  it.each([
    "link-workflow-execution",
    "mark-execution-running",
    "mark-delivered",
  ])(
    "keeps the system-owned %s callback off transport routes",
    async (action) => {
      const services = createServices();
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest({}),
        routeContext(action),
      );

      expect(response.status).toBe(404);
      expect(services.execution.linkWorkflowExecution).not.toHaveBeenCalled();
      expect(services.execution.markRunning).not.toHaveBeenCalled();
      expect(services.execution.markDelivered).not.toHaveBeenCalled();
    },
  );

  it.each([[[] as string[]], [["commit"]], [["screenshot"]]])(
    "refuses a criterion write whose strategy %j cannot be machine-proven",
    async (kinds) => {
      const services = createServices();
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest({
          revisionId: "revision-1",
          elementId: "criterion-unprovable",
          kind: "criterion",
          parentElementId: "requirement-1",
          payload: {
            kind: "criterion",
            text: "This obligation must stay provable.",
            validationStrategy: { kinds },
          },
          baseElementVersion: null,
        }),
        routeContext("draft-upsert"),
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ code: "validation" });
      expect(JSON.stringify(body.issues)).toMatch(
        /machine-provable evidence kind|Invalid/,
      );
      expect(services.authoring.upsertDraftElement).not.toHaveBeenCalled();
    },
  );

  // Removed with the evidence-kind narrowing (ticket #24): both actions had
  // zero production callers, and manual evidence attachment / human proof
  // verdicts no longer exist as surfaces. The bare 404 is the documented
  // contract for the removed endpoints, not an accident.
  it.each(["attach-evidence", "record-verdict"])(
    "returns 404 for the removed %s action",
    async (action) => {
      const services = createServices();
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest({
          criterionElementId: "criterion-1",
          revisionId: "revision-1",
          evidenceIds: ["evidence-1"],
        }),
        routeContext(action),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: "Spec action not found",
      });
      expect(services.evidence.attachEvidence).not.toHaveBeenCalled();
      expect(services.evidence.recordProofVerdict).not.toHaveBeenCalled();
    },
  );

  it("refuses an approval grant from agent transport before calling the service", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        {
          revisionId: "revision-1",
          subjectKind: "requirement",
          elementId: "requirement-1",
        },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("approve-item"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.review.approveItem).not.toHaveBeenCalled();
  });

  it("removes an item approval from human transport only", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = {
      revisionId: "revision-1",
      subjectKind: "requirement",
      elementId: "requirement-1",
    };

    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("unapprove-item"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.review.unapproveItem).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("unapprove-item"),
    );
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toEqual({ id: "approval-1" });
    expect(services.review.unapproveItem).toHaveBeenCalledWith({
      specId: spec.id,
      revisionId: "revision-1",
      subjectKind: "requirement",
      elementId: "requirement-1",
      actor: { kind: "human" },
    });
  });

  it("answers a question from human transport only", async () => {
    const services = createServices();
    vi.mocked(services.review.answerQuestion).mockResolvedValue({
      ok: true as const,
      value: {
        id: "question-1",
        spec_id: spec.id,
        number: 1,
        element_id: null,
        text: "Round or truncate?",
        provenance_json: JSON.stringify({ kind: "human" }),
        status: "answered",
        answer: "Round to one decimal.",
        answered_at: "2026-07-18T00:00:00.000Z",
        created_at: "2026-07-18T00:00:00.000Z",
        updated_at: "2026-07-18T00:00:00.000Z",
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = { questionId: "question-1", answer: "Round to one decimal." };

    // The agent opened the question FOR a human; answering it from agent
    // transport would silently clear its own blocking signal.
    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("answer-question"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.review.answerQuestion).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("answer-question"),
    );
    expect(humanResponse.status).toBe(200);
    expect(services.review.answerQuestion).toHaveBeenCalledWith({
      specId: spec.id,
      questionId: "question-1",
      answer: "Round to one decimal.",
      actor: { kind: "human" },
    });
  });

  it("grants a delivery gate approval from human transport only", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = {
      revisionId: "revision-1",
      executionId: "execution-1",
      gate: "delivery",
    };

    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("grant-gate-approval"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.review.grantGateApproval).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("grant-gate-approval"),
    );
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toEqual({
      id: "approval-delivery-1",
    });
    expect(services.review.grantGateApproval).toHaveBeenCalledWith({
      specId: spec.id,
      revisionId: "revision-1",
      executionId: "execution-1",
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });
  });

  it("approves execution start from human transport only, threading the project route name", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = { executionId: "execution-1" };

    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("approve-execution-start"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.execution.approveExecutionStart).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("approve-execution-start"),
    );
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toEqual({
      id: "execution-1",
      state: "running",
    });
    expect(services.execution.approveExecutionStart).toHaveBeenCalledWith({
      specId: spec.id,
      executionId: "execution-1",
      approver: "operator",
      projectName: "demo",
      actor: { kind: "human" },
    });
  });

  it("disposes assumptions from human transport only, refusing agent transport before the service", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = { assumptionId: "assumption-1", disposition: "confirmed" };

    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("dispose-assumption"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
      unmetConditions: [
        "dispose-assumption is a human-only Spec Studio action.",
      ],
    });
    expect(services.review.disposeAssumption).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("dispose-assumption"),
    );
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toMatchObject({
      id: "assumption-1",
      handle: "A1",
      disposition: "confirmed",
    });
    expect(services.review.disposeAssumption).toHaveBeenCalledWith({
      specId: spec.id,
      assumptionId: "assumption-1",
      disposition: "confirmed",
      actor: { kind: "human" },
    });
  });

  it("renames from human transport only, refusing agent transport before the service", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const body = { slug: "native-sdd-v2" };

    const agentResponse = await handlers.specActionPOST(
      postRequest(body, {
        authorization: "Bearer valid",
        "x-cc-conversation-id": "conversation-agent",
      }),
      routeContext("rename"),
    );
    expect(agentResponse.status).toBe(403);
    await expect(agentResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.authoring.renameSpec).not.toHaveBeenCalled();

    const humanResponse = await handlers.specActionPOST(
      postRequest(body),
      routeContext("rename"),
    );
    expect(humanResponse.status).toBe(200);
    await expect(humanResponse.json()).resolves.toMatchObject({
      spec: { slug: "native-sdd-v2" },
      alias: { slug: spec.slug, specId: spec.id },
    });
    expect(services.authoring.renameSpec).toHaveBeenCalledWith({
      specId: spec.id,
      slug: "native-sdd-v2",
      actor: { kind: "human" },
    });
  });

  it("abandons a whole spec from human transport only, keeping abandon-execution agent-reachable", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const agentHeaders = {
      authorization: "Bearer valid",
      "x-cc-conversation-id": "conversation-agent",
    };

    const agentSpecResponse = await handlers.specActionPOST(
      postRequest({ reason: "superseded" }, agentHeaders),
      routeContext("abandon-spec"),
    );
    expect(agentSpecResponse.status).toBe(403);
    await expect(agentSpecResponse.json()).resolves.toMatchObject({
      code: "human_act_required",
    });
    expect(services.execution.abandonSpec).not.toHaveBeenCalled();

    const humanSpecResponse = await handlers.specActionPOST(
      postRequest({ reason: "superseded" }),
      routeContext("abandon-spec"),
    );
    expect(humanSpecResponse.status).toBe(200);
    expect(services.execution.abandonSpec).toHaveBeenCalledWith({
      specId: spec.id,
      reason: "superseded",
      actor: { kind: "human" },
    });

    const agentExecutionResponse = await handlers.specActionPOST(
      postRequest(
        { executionId: "execution-1", reason: "restarting" },
        agentHeaders,
      ),
      routeContext("abandon-execution"),
    );
    expect(agentExecutionResponse.status).toBe(200);
    expect(services.execution.abandonExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "execution-1",
        reason: "restarting",
        actor: expect.objectContaining({ kind: "agent" }),
      }),
    );
  });

  it("rejects an invalid rename slug before reaching the service", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({ slug: "Not A Slug!" }),
      routeContext("rename"),
    );

    expect(response.status).toBe(400);
    expect(services.authoring.renameSpec).not.toHaveBeenCalled();
  });

  it("preserves ok on a clean integrity report instead of stripping the result envelope", async () => {
    const services = createServices();
    vi.mocked(services.verify).mockResolvedValueOnce({
      ok: true,
      checkedRevisionIds: ["revision-1"],
      mismatches: [],
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({}),
      routeContext("verify"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      checkedRevisionIds: ["revision-1"],
      mismatches: [],
    });
  });

  it("returns integrity mismatches as a successful failed report", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({}),
      routeContext("verify"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      checkedRevisionIds: ["revision-1"],
      mismatches: [{ revisionId: "revision-1" }],
    });
  });

  it("routes a batch draft write to one service call carrying the transport actor", async () => {
    const services = createServices();
    vi.mocked(services.authoring.upsertDraftElements).mockResolvedValueOnce({
      ok: true,
      revisionId: "revision-1",
      written: [
        {
          index: 0,
          elementId: "requirement-1",
          handle: "R1",
          element: { id: "requirement-1" },
          version: { elementVersion: 1 },
        },
      ],
    } as never);
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        {
          revisionId: "revision-1",
          elements: [
            {
              elementId: "requirement-1",
              kind: "requirement",
              parentElementId: null,
              payload: firstElement.payload,
              baseElementVersion: null,
            },
          ],
        },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("draft-batch"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revisionId: "revision-1",
      written: [{ index: 0, elementId: "requirement-1", handle: "R1" }],
    });
    expect(services.authoring.upsertDraftElements).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: spec.id,
        revisionId: "revision-1",
        actor: {
          kind: "agent",
          conversationId: "conversation-agent",
        },
      }),
    );
  });

  it("returns a batch refusal as a conflict carrying every indexed element refusal", async () => {
    const services = createServices();
    vi.mocked(services.authoring.upsertDraftElements).mockResolvedValueOnce({
      ok: false,
      refusals: [
        {
          index: 1,
          elementId: "requirement-2",
          code: "stale_element",
          unmetConditions: ["requirement-2 is at version 3, not 1"],
          instruction: "Re-read requirement-2 and resubmit the batch.",
          currentElementVersion: 3,
        },
      ],
    } as never);
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        {
          revisionId: "revision-1",
          elements: [
            {
              elementId: "requirement-1",
              kind: "requirement",
              parentElementId: null,
              payload: firstElement.payload,
              baseElementVersion: null,
            },
          ],
        },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("draft-batch"),
    );

    expect(response.status).toBe(409);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      code: "stale_element",
      unmetConditions: [
        "[1] requirement-2: requirement-2 is at version 3, not 1",
      ],
      details: {
        refusals: [
          expect.objectContaining({
            index: 1,
            elementId: "requirement-2",
            currentElementVersion: 3,
          }),
        ],
      },
    });
  });

  it("returns 400 for invalid input and 401 for an invalid bearer token", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const invalidInput = await handlers.specActionPOST(
      postRequest({ revisionId: "revision-1" }),
      routeContext("open-question"),
    );
    expect(invalidInput.status).toBe(400);

    const invalidToken = await handlers.specActionPOST(
      postRequest(
        { revisionId: "revision-1" },
        { authorization: "Bearer wrong" },
      ),
      routeContext("propose"),
    );
    expect(invalidToken.status).toBe(401);
    expect(services.authoring.proposeRevision).not.toHaveBeenCalled();
  });

  it.each([
    [
      new PersistenceError({
        kind: "not_found",
        entity: "spec_element",
        identifier: "element-missing",
      }),
      404,
    ],
    [
      new PersistenceError({
        kind: "validation",
        entity: "spec_element",
        identifier: "element-invalid",
        issues: [{ path: ["revisionId"], message: "revision is invalid" }],
      }),
      400,
    ],
  ] as const)(
    "maps repository %s failures to HTTP %i",
    async (failure, status) => {
      const services = createServices();
      vi.mocked(services.authoring.reorderDraftElement).mockRejectedValueOnce(
        failure,
      );
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest({
          revisionId: "revision-1",
          elementId: "element-1",
          baseElementVersion: 1,
          position: 2,
        }),
        routeContext("draft-reorder"),
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        code: failure.failure.kind,
      });
    },
  );
});
