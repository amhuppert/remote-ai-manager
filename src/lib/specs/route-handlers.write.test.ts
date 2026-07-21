import { describe, expect, it, vi } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { PersistenceError } from "@/lib/shared/errors";

import { SpecSlugTakenError } from "./authoring-service";
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
    },
    review: {
      comment: vi.fn(),
      resolveThread: vi.fn(),
      requestChanges: vi.fn(),
      approveItem: vi.fn(async () => ({
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
        value: { id: "question-1", input },
      })),
      answerQuestion: vi.fn(),
      proposeAssumption: vi.fn(),
      disposeAssumption: vi.fn(async () => ({
        ok: true as const,
        value: { id: "assumption-1", disposition: "confirmed" },
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

  it("passes the human transport actor through every evidence mutation that records separate provenance", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const cases = [
      [
        "record-verdict",
        {
          criterionElementId: "criterion-1",
          revisionId: "revision-1",
          evidenceIds: ["evidence-1"],
        },
      ],
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

    expect(services.evidence.recordProofVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "human" } }),
    );
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
    await expect(humanResponse.json()).resolves.toEqual({
      id: "assumption-1",
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
