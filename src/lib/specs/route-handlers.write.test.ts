import { describe, expect, it, vi } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { PersistenceError } from "@/lib/shared/errors";
import {
  SpecRevisionImmutableError,
  StaleStageConflictError,
} from "@/lib/state-store/specs-repo";

import {
  SpecRevisionInReviewError,
  StageBlockedWriteError,
} from "./authoring-service";
import type { Spec, SpecAssumptionRow, SpecRevision } from "./schemas";
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

function revision(
  fields: Pick<SpecRevision, "id" | "number" | "state">,
): SpecRevision {
  return {
    specId: spec.id,
    authoringStage: "plan",
    basedOnRevisionId: null,
    contentHash: null,
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "a".repeat(64),
    proposedAt: null,
    approvedAt: null,
    externalDelivery: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    ...fields,
  };
}

function instructionOf(refusal: unknown): string {
  return typeof refusal === "object" &&
    refusal !== null &&
    "instruction" in refusal &&
    typeof refusal.instruction === "string"
    ? refusal.instruction
    : "";
}

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
      returnToRequirements: vi.fn(async () => ({
        revision: revision({
          id: "revision-requirements",
          number: 3,
          state: "draft",
        }),
        withdrawnRevision: revision({
          id: "revision-design",
          number: 2,
          state: "withdrawn",
        }),
      })),
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
          externalDelivery: null,
          createdAt: "2026-07-18T00:00:00.000Z",
        },
      })),
    },
    review: {
      comment: vi.fn(),
      replyToThread: vi.fn(async (input: unknown) => ({
        ok: true as const,
        value: {
          id: "comment-reply-1",
          thread_id: (input as { threadId: string }).threadId,
        },
      })),
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
        value: {
          id: "question-1",
          spec_id: spec.id,
          number: 1,
          element_id: null,
          text: (input as { text: string }).text,
          provenance_json: JSON.stringify({ kind: "human" }),
          record_version: 1,
          status: "open" as const,
          answer: null,
          answered_at: null,
          withdrawn_at: null,
          created_at: "2026-07-18T00:00:00.000Z",
          updated_at: "2026-07-18T00:00:00.000Z",
        },
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
          record_version: 2,
          disposition: "confirmed" as const,
          disposed_at: "2026-07-18T01:00:00.000Z",
          withdrawn_at: null,
          supersedes_assumption_id: null,
          supersession_operation_id: null,
          supersession_request_hash: null,
          created_at: "2026-07-18T00:00:00.000Z",
          updated_at: "2026-07-18T01:00:00.000Z",
        },
      })),
      editAttentionRecord: vi.fn(),
      withdrawAttentionRecord: vi.fn(),
      supersedeAssumption: vi.fn(),
      citeAssumption: vi.fn(),
      unciteAssumption: vi.fn(),
      changePolicy: vi.fn(),
    },
    evidence: {
      requestWaiver: vi.fn(),
      grantWaiver: vi.fn(),
      markWaiverStaleForCriterionChange: vi.fn(),
      setDisposition: vi.fn(),
    },
    execution: {
      start: vi.fn(),
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
    verify: vi.fn(async () => ({
      ok: false,
      checkedRevisionIds: ["revision-1"],
      mismatches: [{ revisionId: "revision-1" }],
    })),
  } as unknown as SpecMutationServices;
}

function createDeps(
  services: SpecMutationServices,
  overrides: Partial<SpecWriteRouteDeps> = {},
): SpecWriteRouteDeps {
  const currentRevision = revision({
    id: "revision-1",
    number: 1,
    state: "draft",
  });
  const defaultQuestion = {
    id: "question-1",
    spec_id: spec.id,
    number: 1,
    element_id: null,
    text: "Question",
    provenance_json: JSON.stringify({ kind: "human" }),
    record_version: 1,
    status: "open" as const,
    answer: null,
    answered_at: null,
    withdrawn_at: null,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
  };
  return {
    auth,
    resolveProjectPath: async (name) =>
      name === "demo" ? spec.projectPath : null,
    resolveSpec: async (projectPath, slug) =>
      projectPath === spec.projectPath && slug === spec.slug ? spec : null,
    getServices: async () => services,
    listRevisions: async () => [currentRevision],
    getRevisionSnapshot: async (revisionId) =>
      revisionId === currentRevision.id
        ? {
            revision: currentRevision,
            elements: [],
            assumptionCitations: [],
          }
        : null,
    findQuestionsBySpecId: () => [defaultQuestion],
    findAssumptionsBySpecId: () => [],
    findEventsBySpecId: () => [],
    ...overrides,
  };
}

describe("spec write route handlers", () => {
  it("maps authoring-agent-only attention refusals to HTTP 403", async () => {
    const services = createServices();
    vi.mocked(services.review.editAttentionRecord).mockResolvedValueOnce({
      ok: false as const,
      refusal: {
        code: "authoring_agent_required" as const,
        unmetConditions: ["Attention correction is an agent act."],
        instruction: "Run the correction from an authoring conversation.",
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({
        recordId: "question-1",
        expectedRecordVersion: 1,
        payload: { kind: "question", text: "Corrected question" },
      }),
      routeContext("edit-attention"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "authoring_agent_required",
    });
  });

  it("admits an operation-id supersession replay without a draft revision", async () => {
    const services = createServices();
    vi.mocked(services.review.supersedeAssumption).mockResolvedValueOnce({
      ok: true,
      value: {
        operation: "superseded",
        recordKind: "assumption",
        recordId: "assumption-1",
        recordHandle: "A1",
        previousRecordVersion: 4,
        newRecordVersion: 4,
        lifecycle: "confirmed",
        draftRevisionId: "revision-original",
        previousCitationVersion: 6,
        newCitationVersion: 6,
        citationChanges: { added: [], removed: [], refreshed: [] },
        successor: { id: "assumption-2", handle: "A2" },
        idempotentReplay: true,
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const payload = {
      operationId: "supersede-operation",
      reason: "The premise needed correction.",
      text: "The validator is deterministic under a pinned revision.",
      attachment: { kind: "spec" as const },
      citations: { kind: "clear" as const },
    };

    const response = await handlers.specActionPOST(
      postRequest(
        {
          assumptionId: "assumption-1",
          expectedRecordVersion: 3,
          expectedCitationVersion: 5,
          payload,
        },
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
          "x-cc-agent-backend": "codex",
        },
      ),
      routeContext("supersede-assumption"),
    );

    expect(response.status).toBe(200);
    expect(services.review.supersedeAssumption).toHaveBeenCalledWith({
      specId: spec.id,
      assumptionId: "assumption-1",
      expectedRecordVersion: 3,
      expectedCitationVersion: 5,
      payload,
      actor: {
        kind: "agent",
        conversationId: "conversation-agent",
        backend: "codex",
      },
    });
  });

  it("refuses every human-only action from agent transport before parsing", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));
    const agentHeaders = {
      authorization: "Bearer valid",
      "x-cc-conversation-id": "conversation-agent",
    };

    for (const action of [
      "approve-item",
      "unapprove-item",
      "sign-off",
      "approve-remaining-and-sign-off",
      "bulk-approve",
      "grant-gate-approval",
      "grant-waiver",
      "change-policy",
      "dispose-assumption",
      "answer-question",
      "rename",
      "abandon-spec",
    ]) {
      const response = await handlers.specActionPOST(
        postRequest({}, agentHeaders),
        routeContext(action),
      );

      expect(response.status, action).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "human_act_required",
      });
    }

    expect(services.review.answerQuestion).not.toHaveBeenCalled();
    expect(services.authoring.renameSpec).not.toHaveBeenCalled();
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

  it("returns the winning draft on a stale-stage advance conflict", async () => {
    const services = createServices();
    const currentRevision: SpecRevision = {
      id: "revision-2",
      specId: spec.id,
      number: 2,
      state: "draft" as const,
      authoringStage: "design" as const,
      basedOnRevisionId: "revision-1",
      contentHash: null,
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: null,
      approvedAt: null,
      externalDelivery: null,
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

  it("refuses an amendment that would fork past a revision under review", async () => {
    const services = createServices();
    vi.mocked(services.authoring.openAmendment).mockRejectedValueOnce(
      new SpecRevisionInReviewError(spec.id, {
        kind: "blocked_by_proposal",
        proposals: [
          revision({ id: "revision-2", number: 2, state: "proposed" }),
        ],
        approved: revision({ id: "revision-1", number: 1, state: "approved" }),
      }),
    );
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest(
        {},
        {
          authorization: "Bearer valid",
          "x-cc-conversation-id": "conversation-agent",
        },
      ),
      routeContext("open-amendment"),
    );

    expect(response.status).toBe(409);
    const refusal: unknown = await response.json();
    expect(refusal).toMatchObject({
      code: "revision_in_review",
      unmetConditions: [expect.stringContaining("Revision 2")],
      details: {
        proposals: [{ id: "revision-2", number: 2 }],
        approvedBaseRevisionId: "revision-1",
      },
    });
    const instruction = instructionOf(refusal);
    expect(instruction).toContain("revision 2");
    expect(instruction).toContain("Spec Studio");
    expect(instruction).toContain("request changes");
    // The proposing agent's own exit is the third recovery; telling the reader
    // to open an amendment is the instruction `spec amend` itself refuses.
    expect(instruction).toContain("cctl spec withdraw-proposal");
    expect(instruction).not.toContain("Open an amendment draft");
  });

  it("returns an exact Design revision to Requirements for human or agent callers", async () => {
    const services = createServices();
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({
        expectedRevisionId: "revision-design",
        reason: "Requirements need clarification.",
      }),
      routeContext("return-to-requirements"),
    );

    expect(response.status).toBe(200);
    expect(services.authoring.returnToRequirements).toHaveBeenCalledWith({
      specId: spec.id,
      expectedRevisionId: "revision-design",
      reason: "Requirements need clarification.",
      actor: { kind: "human" },
    });
  });

  it.each([
    ["proposed", "revision_in_review"],
    ["approved", "amendment_required"],
  ] as const)(
    "refuses a write into a %s revision with the %s code",
    async (state, code) => {
      const services = createServices();
      vi.mocked(services.authoring.upsertDraftElement).mockRejectedValueOnce(
        new SpecRevisionImmutableError("revision-3", 2, state),
      );
      const handlers = createSpecWriteRouteHandlers(createDeps(services));

      const response = await handlers.specActionPOST(
        postRequest(
          {
            revisionId: "revision-3",
            elementId: "requirement-1",
            kind: "requirement",
            parentElementId: null,
            payload: firstElement.payload,
            baseElementVersion: 1,
          },
          {
            authorization: "Bearer valid",
            "x-cc-conversation-id": "conversation-agent",
          },
        ),
        routeContext("draft-upsert"),
      );

      expect(response.status).toBe(409);
      const refusal: unknown = await response.json();
      expect(refusal).toMatchObject({ code });
      const instruction = instructionOf(refusal);
      if (code === "amendment_required") {
        expect(instruction).toBe(
          "Open an amendment draft before changing approved content.",
        );
      } else {
        // Pointing a write against a revision under review at `spec amend`
        // contradicts itself: that command refuses for the same reason. The
        // revision is named by number, as every other surface names it, and
        // the refused act is the write the caller actually attempted.
        expect(instruction).toBe(
          "Revision 2 is under review. Conclude that review before editing it: sign off revision 2 in Spec Studio, have a human request changes on it, or — if this conversation proposed it and no human has acted on it yet — run `cctl spec withdraw-proposal <slug> --revision <revision-id>` to take it back and continue in the draft it reopens. Writing into it now would change content a reviewer is reading.",
        );
        expect(instruction).not.toContain("revision-3");
      }
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
      record_version: 1,
      disposition: "proposed" as const,
      disposed_at: null,
      withdrawn_at: null,
      supersedes_assumption_id: null,
      supersession_operation_id: null,
      supersession_request_hash: null,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    };
    let currentAssumption: SpecAssumptionRow = assumptionRow;
    vi.mocked(services.review.proposeAssumption).mockImplementationOnce(
      async () => {
        currentAssumption = assumptionRow;
        return { ok: true as const, value: currentAssumption };
      },
    );
    vi.mocked(services.review.disposeAssumption).mockImplementationOnce(
      async () => {
        currentAssumption = {
          ...assumptionRow,
          record_version: 2,
          disposition: "confirmed" as const,
          disposed_at: "2026-07-18T01:00:00.000Z",
          updated_at: "2026-07-18T01:00:00.000Z",
        };
        return { ok: true as const, value: currentAssumption };
      },
    );
    const handlers = createSpecWriteRouteHandlers(
      createDeps(services, {
        findAssumptionsBySpecId: () => [currentAssumption],
      }),
    );

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
      postRequest({
        assumptionId: "assumption-2",
        recordVersion: 1,
        disposition: "confirmed",
      }),
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

  it("returns the handle allocated to a newly opened question", async () => {
    const services = createServices();
    const openedQuestion = {
      id: "question-1",
      spec_id: spec.id,
      number: 3,
      element_id: null,
      text: "Which backend owns retries?",
      provenance_json: JSON.stringify({ kind: "human" }),
      record_version: 1,
      status: "open" as const,
      answer: null,
      answered_at: null,
      withdrawn_at: null,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    };
    vi.mocked(services.review.openQuestion).mockResolvedValueOnce({
      ok: true as const,
      value: openedQuestion,
    });
    const handlers = createSpecWriteRouteHandlers(
      createDeps(services, {
        findQuestionsBySpecId: () => [openedQuestion],
      }),
    );

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

  it("returns the launched approved candidate with the execution's parsed plan scope", async () => {
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
        execution_start_dial: "gate" as const,
        workflow_definition_id: "workflow-definition-1",
        workflow_definition_revision: 1,
        workflow_execution_id: null,
        session_name: "feature-session",
        delivered_at: null,
        abandoned_reason: null,
        cleanup_phase: null,
        linked_workflow_execution_id: null,
        cleanup_last_error: null,
        cleanup_last_error_at: null,
        created_at: "2026-07-18T00:00:00.000Z",
        updated_at: "2026-07-18T00:00:00.000Z",
      },
      workflowDefinition: { id: "workflow-definition-1", revision: 1 },
      revisionNumber: 4,
      deliveryPlan: {
        attemptId: "attempt-approved",
        candidateId: "candidate-approved",
        candidateHash: "sha256:candidate",
        workflowExecutionId: "workflow-execution-9",
        resolvedDefinitionHash: `sha256:${"d".repeat(64)}`,
      },
    });
    const handlers = createSpecWriteRouteHandlers(createDeps(services));

    const response = await handlers.specActionPOST(
      postRequest({
        revisionId: "revision-1",
        sessionName: "feature-session",
        parameters: {
          required: "ticket-66",
          mode: "careful",
          brief: "Preserve this text exactly.\nIncluding its newline.",
        },
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
        workflowExecutionId: null,
        scope: {
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: ["criterion-1"],
          exclusionDispositions: [],
        },
        sessionName: "feature-session",
      },
      workflowDefinition: { id: "workflow-definition-1", revision: 1 },
      deliveryPlan: {
        attemptId: "attempt-approved",
        candidateId: "candidate-approved",
        candidateHash: "sha256:candidate",
        workflowExecutionId: "workflow-execution-9",
        resolvedDefinitionHash: `sha256:${"d".repeat(64)}`,
      },
    });
    expect(services.execution.start).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: {
          required: "ticket-66",
          mode: "careful",
          brief: "Preserve this text exactly.\nIncluding its newline.",
        },
      }),
    );
    expect(body.execution).not.toHaveProperty("scope_json");
    expect(body.execution).not.toHaveProperty("spec_id");
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

  it("preserves ok on a clean integrity report instead of stripping the result envelope", async () => {
    const services = createServices();
    vi.mocked(services.verify).mockResolvedValueOnce({
      ok: true,
      checkedRevisionIds: ["revision-1"],
      mismatches: [],
      consistencyFindings: [],
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
      consistencyFindings: [],
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
