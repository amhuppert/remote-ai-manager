import { describe, expect, it, vi } from "vitest";

import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecCommentRow,
  SpecCriterionDispositionRow,
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecLinkRow,
  SpecProofVerdictRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecTaskClaimRow,
  SpecWaiverRow,
} from "./schemas";
import { createSpecRouteHandlers, type SpecRouteDeps } from "./route-handlers";

const PROJECT_PATH = "/repos/demo";

const spec: Spec = {
  id: "spec-1",
  projectPath: PROJECT_PATH,
  slug: "current-slug",
  name: "Current spec",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const revision: SpecRevision = {
  id: "revision-1",
  specId: spec.id,
  number: 1,
  state: "draft",
  basedOnRevisionId: null,
  contentHash: null,
  proposedAt: null,
  approvedAt: null,
  createdAt: "2026-07-18T00:00:00.000Z",
};

const snapshot: SpecRevisionSnapshot = {
  revision,
  elements: [
    {
      element: {
        id: "requirement-1",
        specId: spec.id,
        kind: "requirement",
        number: 1,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "The route resolves renamed specs",
          priority: "must",
          risk: "medium",
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: spec.id,
        kind: "criterion",
        number: 1,
        parentElementId: "requirement-1",
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion",
          text: "The old slug returns the current spec",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    },
    {
      element: {
        id: "decision-1",
        specId: spec.id,
        kind: "decision",
        number: 1,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: revision.id,
        elementId: "decision-1",
        position: 2,
        payload: {
          kind: "decision",
          title: "Compose shared route resolution",
          chosenApproach: "Use the project resolver and spec repository",
          rejectedAlternatives: [],
          reason: "The shared ladder owns 404 responses",
          tracedRequirementElementIds: ["requirement-1"],
        },
        payloadHash: "decision-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    },
    {
      element: {
        id: "task-1",
        specId: spec.id,
        kind: "task",
        number: 1,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 3,
        payload: {
          kind: "task",
          title: "Build read routes",
          instructions: "Expose the spec read surface",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: ["decision-1"],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    },
  ],
};

const question: SpecQuestionRow = {
  id: "question-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "Which aliases are supported?",
  provenance_json: JSON.stringify({ kind: "agent", conversationId: "conv-1" }),
  status: "open",
  answer: null,
  answered_at: null,
  created_at: revision.createdAt,
  updated_at: revision.createdAt,
};

const assumption: SpecAssumptionRow = {
  id: "assumption-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "SQLite remains authoritative.",
  proposed_by_json: JSON.stringify({
    kind: "agent",
    conversationId: "conv-1",
  }),
  disposition: "rejected",
  disposed_at: "2026-07-18T01:00:00.000Z",
  created_at: revision.createdAt,
  updated_at: revision.createdAt,
};

function routeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function execution(
  overrides: Partial<SpecExecutionRow> = {},
): SpecExecutionRow {
  return {
    id: "execution-1",
    spec_id: spec.id,
    revision_id: revision.id,
    scope_json: JSON.stringify({ selectedTaskIds: ["task-1"] }),
    state: "delivered",
    workflow_definition_id: "workflow-definition-1",
    workflow_execution_id: "workflow-execution-1",
    session_name: "session-1",
    delivered_at: revision.createdAt,
    abandoned_reason: null,
    created_at: revision.createdAt,
    updated_at: revision.createdAt,
    ...overrides,
  };
}

function createDeps(overrides: Partial<SpecRouteDeps> = {}): SpecRouteDeps {
  return {
    resolveProjectPath: async (name) => (name === "demo" ? PROJECT_PATH : null),
    listSpecs: async () => [spec],
    resolveSpec: async (_projectPath, slug) =>
      slug === "old-slug" || slug === spec.slug ? spec : null,
    listAliases: async () => [
      {
        projectPath: PROJECT_PATH,
        slug: "old-slug",
        specId: spec.id,
        createdAt: revision.createdAt,
      },
    ],
    listRevisions: async () => [revision],
    getRevisionSnapshot: async (revisionId) =>
      revisionId === revision.id ? snapshot : null,
    lintDraft: async () => [
      {
        ruleId: "uncovered_criterion",
        severity: "blocks_propose",
        elementHandle: "R1.1",
        message: "R1.1 must be covered",
      },
    ],
    findApprovalsBySpecId: () => [] as SpecApprovalRow[],
    findCommentsByRevision: () => [],
    findGateAdmissionsByRevision: () => [] as SpecGateAdmissionRow[],
    findLinksBySpecId: () => [] as SpecLinkRow[],
    getLinkedTickets: async () => [],
    findQuestionsBySpecId: () => [question],
    findAssumptionsBySpecId: () => [assumption],
    findExecutionsBySpecId: () => [] as SpecExecutionRow[],
    findTaskClaimsBySpecId: () => [],
    findWorkflowEventsByExecution: () => [],
    reconcileExecution: async (_projectPath, candidate) => candidate,
    ingestExecutionEvidenceBestEffort: async () => undefined,
    findCriterionDispositionsByExecution: () => [],
    findEvidenceByCriterionRevision: () => [],
    findProofVerdictsByCriterionRevision: () => [],
    findWaiverForCriterionRevision: () => null,
    exportSpec: async () => ({ markdownFiles: [], manifest: "{}\n" }),
    verifySpec: async () => ({
      ok: true,
      checkedRevisionIds: [],
      mismatches: [],
    }),
    measureProject: async () => ({
      definitionsVersion: "native-sdd-measures-v1",
      requirementCausedRework: {
        reopenedClaimCount: 0,
        postApprovalRevisionCount: 0,
        totalReworkEventCount: 0,
        claimIds: [],
        revisionIds: [],
      },
      approvalFriction: {
        activeReviewTimeMs: 0,
        interventionCount: 0,
        reapprovalLoopCount: 0,
      },
      traceabilityCompleteness: {
        deliveredInScopeCriterionCount: 0,
        completeChainCount: 0,
        share: null,
        completeCriterionIds: [],
        incompleteCriterionIds: [],
      },
      automaticEvidenceCapture: {
        automaticallyIngestedCount: 0,
        manuallyAttachedCount: 0,
        totalEvidenceCount: 0,
        share: null,
      },
      navigationChains: [],
    }),
    ...overrides,
  };
}

describe("spec read route handlers", () => {
  it("resolves an alias and returns the current full view", async () => {
    const approval: SpecApprovalRow = {
      id: "approval-1",
      spec_id: spec.id,
      subject_kind: "requirement",
      element_id: "requirement-1",
      revision_id: revision.id,
      approver: "alex",
      granted_at: revision.createdAt,
      validity: "valid",
    };
    const comment: SpecCommentRow = {
      id: "comment-1",
      spec_id: spec.id,
      thread_id: "thread-1",
      parent_comment_id: null,
      element_id: "requirement-1",
      anchor_json: "{}",
      revision_id: revision.id,
      body: "Keep the address stable.",
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 0,
      resolution: "open",
      created_at: revision.createdAt,
      updated_at: revision.createdAt,
    };
    const deliveredExecution = execution();
    const disposition: SpecCriterionDispositionRow = {
      execution_id: deliveredExecution.id,
      criterion_element_id: "criterion-1",
      disposition: "waived",
      waiver_id: "waiver-1",
      delivered_by_execution_id: null,
      created_at: revision.createdAt,
      updated_at: revision.createdAt,
    };
    const waiver: SpecWaiverRow = {
      id: "waiver-1",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: revision.id,
      reason: "Alex accepted the bounded risk.",
      waived_at: revision.createdAt,
      stale: 0,
    };
    const getLinkedTickets = vi.fn(async () => [
      {
        projectName: "demo",
        number: 12,
        title: "Ship reverse ticket links",
      },
    ]);
    const handlers = createSpecRouteHandlers(
      createDeps({
        findApprovalsBySpecId: () => [approval],
        findCommentsByRevision: () => [comment],
        findExecutionsBySpecId: () => [deliveredExecution],
        findCriterionDispositionsByExecution: () => [disposition],
        findWaiverForCriterionRevision: () => waiver,
        getLinkedTickets,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/old-slug"),
      routeContext({ name: "demo", slug: "old-slug" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      spec: { id: spec.id, slug: "current-slug" },
      aliases: [{ slug: "old-slug" }],
      currentRevision: {
        revision: { id: revision.id },
        elements: expect.any(Array),
      },
      approvals: [approval],
      comments: [comment],
      executions: [deliveredExecution],
      criterionDispositions: [disposition],
      waivers: [waiver],
      elementStatuses: {
        requirements: [
          {
            elementId: "requirement-1",
            status: {
              approval: "valid",
              coverage: "covered",
              proof: "waived",
            },
          },
        ],
        tasks: [
          {
            elementId: "task-1",
            status: { status: "pending", claimEvidenceIds: [] },
          },
        ],
      },
      status: {
        phase: { primary: "draft" },
      },
      linkedTickets: [
        {
          projectName: "demo",
          number: 12,
          title: "Ship reverse ticket links",
        },
      ],
    });
    expect(getLinkedTickets).toHaveBeenCalledWith(PROJECT_PATH, spec.id);
  });

  it("carries question and assumption projections on the detail view", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.questions).toEqual([
      {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which aliases are supported?",
        status: "open",
        answer: null,
        answeredAt: null,
        provenance: { kind: "agent", conversationId: "conv-1" },
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    ]);
    expect(body.assumptions).toEqual([
      {
        id: "assumption-1",
        number: 1,
        handle: "A1",
        elementId: "requirement-1",
        text: "SQLite remains authoritative.",
        disposition: "rejected",
        disposedAt: "2026-07-18T01:00:00.000Z",
        proposedBy: { kind: "agent", conversationId: "conv-1" },
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    ]);
  });

  it("lists assumptions with dispositions in the status view", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assumptions).toEqual([
      {
        id: "assumption-1",
        handle: "A1",
        text: "SQLite remains authoritative.",
        disposition: "rejected",
        elementId: "requirement-1",
      },
    ]);
  });

  it("resolves bare Q and A handles to typed question and assumption views", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const questionResponse = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/Q1"),
      routeContext({ name: "demo", slug: spec.slug, element: "Q1" }),
    );
    expect(questionResponse.status).toBe(200);
    await expect(questionResponse.json()).resolves.toEqual({
      specId: spec.id,
      slug: spec.slug,
      kind: "question",
      handle: "Q1",
      question: {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which aliases are supported?",
        status: "open",
        answer: null,
        answeredAt: null,
        provenance: { kind: "agent", conversationId: "conv-1" },
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    });

    const assumptionResponse = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/A1"),
      routeContext({ name: "demo", slug: spec.slug, element: "A1" }),
    );
    expect(assumptionResponse.status).toBe(200);
    await expect(assumptionResponse.json()).resolves.toEqual({
      specId: spec.id,
      slug: spec.slug,
      kind: "assumption",
      handle: "A1",
      assumption: {
        id: "assumption-1",
        number: 1,
        handle: "A1",
        elementId: "requirement-1",
        text: "SQLite remains authoritative.",
        disposition: "rejected",
        disposedAt: "2026-07-18T01:00:00.000Z",
        proposedBy: { kind: "agent", conversationId: "conv-1" },
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    });
  });

  it("returns 404 for an unallocated Q or A handle", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/Q9"),
      routeContext({ name: "demo", slug: spec.slug, element: "Q9" }),
    );

    expect(response.status).toBe(404);
  });

  it("returns the proposed revision base snapshot for review mode", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      id: "revision-approved",
      state: "approved",
      contentHash: "approved-hash",
      approvedAt: revision.createdAt,
    };
    const proposedRevision: SpecRevision = {
      ...revision,
      id: "revision-proposed",
      number: 2,
      state: "proposed",
      basedOnRevisionId: approvedRevision.id,
      contentHash: "proposed-hash",
      proposedAt: revision.createdAt,
    };
    const snapshotFor = (candidate: SpecRevision): SpecRevisionSnapshot => ({
      revision: candidate,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: candidate.id },
      })),
    });
    const approvedSnapshot = snapshotFor(approvedRevision);
    const proposedSnapshot = snapshotFor(proposedRevision);
    const activeExecution = execution({
      revision_id: approvedRevision.id,
      state: "definition_review",
      workflow_execution_id: null,
      delivered_at: null,
    });
    const approvedWaiver: SpecWaiverRow = {
      id: "waiver-approved-revision",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: approvedRevision.id,
      reason: "Alex accepted the pinned revision risk.",
      waived_at: revision.createdAt,
      stale: 0,
    };
    const approvedEvidence: SpecEvidenceRow = {
      id: "evidence-approved-revision",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: approvedRevision.id,
      kind: "test_run",
      ref_json: JSON.stringify({
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-1",
        eventId: 7,
        contextId: "validation",
      }),
      evaluated_state_json: JSON.stringify({ relevantPaths: [] }),
      producer_json: JSON.stringify({ kind: "agent" }),
      execution_id: activeExecution.id,
      source_event_id: 7,
      created_at: revision.createdAt,
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, proposedRevision],
        getRevisionSnapshot: async (revisionId) => {
          if (revisionId === approvedRevision.id) return approvedSnapshot;
          if (revisionId === proposedRevision.id) return proposedSnapshot;
          return null;
        },
        findExecutionsBySpecId: () => [activeExecution],
        findWaiverForCriterionRevision: (_criterionId, revisionId) =>
          revisionId === approvedRevision.id ? approvedWaiver : null,
        findEvidenceByCriterionRevision: (_criterionId, revisionId) =>
          revisionId === approvedRevision.id ? [approvedEvidence] : [],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      baseRevision: { revision: { id: approvedRevision.id, number: 1 } },
      currentRevision: { revision: { id: proposedRevision.id, number: 2 } },
      waivers: [approvedWaiver],
    });

    const elementResponse = await handlers.getSpecElementGET(
      new Request(
        `http://cc.test/api/specs/demo/current-slug/elements/R1.1?revisionId=${approvedRevision.id}`,
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1.1" }),
    );
    expect(elementResponse.status).toBe(200);
    await expect(elementResponse.json()).resolves.toMatchObject({
      revision: { id: approvedRevision.id },
      evidenceState: [{ evidence: [approvedEvidence] }],
    });
  });

  it("returns review comments from prior revisions for amendment re-anchoring", async () => {
    const withdrawnRevision: SpecRevision = {
      ...revision,
      id: "revision-withdrawn",
      state: "withdrawn",
      contentHash: "withdrawn-hash",
      proposedAt: revision.createdAt,
    };
    const draftRevision: SpecRevision = {
      ...revision,
      id: "revision-draft-2",
      number: 2,
      basedOnRevisionId: withdrawnRevision.id,
    };
    const commentFor = (id: string, revisionId: string): SpecCommentRow => ({
      id,
      spec_id: spec.id,
      thread_id: id,
      parent_comment_id: null,
      element_id: "requirement-1",
      anchor_json: "{}",
      revision_id: revisionId,
      body: `Comment ${id}`,
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 0,
      resolution: "open",
      created_at: revision.createdAt,
      updated_at: revision.createdAt,
    });
    const oldComment = commentFor("comment-old", withdrawnRevision.id);
    const currentComment = commentFor("comment-current", draftRevision.id);
    const findCommentsByRevision = vi.fn((revisionId: string) => {
      if (revisionId === withdrawnRevision.id) return [oldComment];
      if (revisionId === draftRevision.id) return [currentComment];
      return [];
    });
    const snapshotFor = (candidate: SpecRevision): SpecRevisionSnapshot => ({
      revision: candidate,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: candidate.id },
      })),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [withdrawnRevision, draftRevision],
        getRevisionSnapshot: async (revisionId) => {
          if (revisionId === withdrawnRevision.id) {
            return snapshotFor(withdrawnRevision);
          }
          if (revisionId === draftRevision.id)
            return snapshotFor(draftRevision);
          return null;
        },
        findCommentsByRevision,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      comments: [oldComment, currentComment],
    });
    expect(findCommentsByRevision).toHaveBeenCalledWith(withdrawnRevision.id);
    expect(findCommentsByRevision).toHaveBeenCalledWith(draftRevision.id);
  });

  it("retains an older active execution snapshot beyond the current revision base", async () => {
    const revisionFor = (
      id: string,
      number: number,
      state: SpecRevision["state"],
      basedOnRevisionId: string | null,
    ): SpecRevision => ({
      ...revision,
      id,
      number,
      state,
      basedOnRevisionId,
      contentHash: state === "draft" ? null : `${id}-hash`,
      proposedAt: state === "draft" ? null : revision.createdAt,
      approvedAt: state === "approved" ? revision.createdAt : null,
    });
    const pinnedRevision = revisionFor(
      "revision-approved-1",
      1,
      "approved",
      null,
    );
    const currentApprovedRevision = revisionFor(
      "revision-approved-2",
      2,
      "approved",
      pinnedRevision.id,
    );
    const withdrawnRevision = revisionFor(
      "revision-withdrawn-3",
      3,
      "withdrawn",
      currentApprovedRevision.id,
    );
    const draftRevision = revisionFor(
      "revision-draft-4",
      4,
      "draft",
      withdrawnRevision.id,
    );
    const snapshotFor = (candidate: SpecRevision): SpecRevisionSnapshot => ({
      revision: candidate,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: candidate.id },
      })),
    });
    const snapshots = new Map(
      [
        pinnedRevision,
        currentApprovedRevision,
        withdrawnRevision,
        draftRevision,
      ].map((candidate) => [candidate.id, snapshotFor(candidate)]),
    );
    const activeExecution = execution({
      revision_id: pinnedRevision.id,
      state: "running",
      delivered_at: null,
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [
          pinnedRevision,
          currentApprovedRevision,
          withdrawnRevision,
          draftRevision,
        ],
        getRevisionSnapshot: async (revisionId) =>
          snapshots.get(revisionId) ?? null,
        findExecutionsBySpecId: () => [activeExecution],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentRevision: { revision: { id: draftRevision.id } },
      baseRevision: { revision: { id: withdrawnRevision.id } },
      currentApprovedRevision: {
        revision: { id: currentApprovedRevision.id },
      },
      executionRevisionSnapshots: [{ revision: { id: pinnedRevision.id } }],
    });
  });

  it("projects requirement proof and each task's accepted completion claim", async () => {
    const verdict: SpecProofVerdictRow = {
      id: "verdict-detail",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: revision.id,
      execution_id: "execution-1",
      verdict_kind: "deterministic_validator",
      evidence_ids_json: JSON.stringify(["evidence-1"]),
      verdict_at: revision.createdAt,
      stale_at: null,
      stale_reason: null,
    };
    const claim: SpecTaskClaimRow = {
      id: "claim-task-1",
      spec_id: spec.id,
      task_element_id: "task-1",
      execution_id: "execution-1",
      actor_json: JSON.stringify({ kind: "agent" }),
      evidence_ids_json: JSON.stringify(["evidence-1"]),
      claimed_at: revision.createdAt,
      status: "accepted",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [
          execution({ state: "running", delivered_at: null }),
        ],
        findTaskClaimsBySpecId: () => [claim],
        findWorkflowEventsByExecution: () => [
          {
            occurredAt: revision.createdAt,
            preReset: false,
            event: {
              type: "graph-workflow-task-status",
              projectName: "demo",
              sessionName: "session-1",
              executionId: "workflow-execution-1",
              taskId: "spec-task-task-1",
              contextId: "context-1",
              status: "completed",
              source: "agent",
              order: 1,
            },
          },
        ],
        findProofVerdictsByCriterionRevision: () => [verdict],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      elementStatuses: {
        requirements: [
          {
            elementId: "requirement-1",
            status: { proof: "proven" },
          },
        ],
        tasks: [
          {
            elementId: "task-1",
            status: {
              status: "claimed",
              claimEvidenceIds: ["evidence-1"],
            },
          },
        ],
      },
    });
  });

  it.each(["running", "completed", "interrupted", "failed"] as const)(
    "maps compiled workflow task status %s back to its spec task element",
    async (taskStatus) => {
      const handlers = createSpecRouteHandlers(
        createDeps({
          findExecutionsBySpecId: () => [
            execution({ state: "running", delivered_at: null }),
          ],
          findWorkflowEventsByExecution: () => [
            {
              occurredAt: revision.createdAt,
              preReset: false,
              event: {
                type: "graph-workflow-task-status",
                projectName: "demo",
                sessionName: "session-1",
                executionId: "workflow-execution-1",
                taskId: "spec-task-task-1",
                contextId: "context-task-1",
                status: taskStatus,
                source: "agent",
                order: 1,
              },
            },
          ],
        }),
      );

      const response = await handlers.getSpecGET(
        new Request("http://cc.test/api/specs/demo/current-slug"),
        routeContext({ name: "demo", slug: spec.slug }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        elementStatuses: {
          tasks: [
            {
              elementId: "task-1",
              status: { status: taskStatus, claimEvidenceIds: [] },
            },
          ],
        },
      });
    },
  );

  it("does not request approval again for unchanged carried-forward elements", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      id: "revision-approved",
      state: "approved",
      contentHash: "approved-hash",
      approvedAt: revision.createdAt,
    };
    const proposedRevision: SpecRevision = {
      ...revision,
      id: "revision-proposed",
      number: 2,
      state: "proposed",
      basedOnRevisionId: approvedRevision.id,
      contentHash: "proposed-hash",
      proposedAt: revision.createdAt,
    };
    const proposedSnapshot: SpecRevisionSnapshot = {
      revision: proposedRevision,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: proposedRevision.id },
      })),
    };
    const carriedApprovals: SpecApprovalRow[] = [
      {
        id: "approval-requirement",
        spec_id: spec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: approvedRevision.id,
        approver: "alex",
        granted_at: revision.createdAt,
        validity: "valid",
      },
      {
        id: "approval-decision",
        spec_id: spec.id,
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: approvedRevision.id,
        approver: "alex",
        granted_at: revision.createdAt,
        validity: "valid",
      },
      {
        id: "approval-plan",
        spec_id: spec.id,
        subject_kind: "plan",
        element_id: null,
        revision_id: approvedRevision.id,
        approver: "alex",
        granted_at: revision.createdAt,
        validity: "valid",
      },
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, proposedRevision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === proposedRevision.id ? proposedSnapshot : snapshot,
        findApprovalsBySpecId: () => carriedApprovals,
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pendingApprovals: [
        {
          gate: "execution_start",
          subject: "execution_start",
          elementId: null,
        },
        { gate: "delivery", subject: "delivery", elementId: null },
      ],
    });
  });

  it("returns a complete status payload", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      specId: spec.id,
      slug: spec.slug,
      phase: { primary: "draft" },
      gates: [
        { gate: "requirements", dial: "gate", state: "pending" },
        { gate: "design", dial: "gate", state: "pending" },
        { gate: "plan", dial: "gate", state: "pending" },
        { gate: "execution_start", dial: "gate", state: "pending" },
        { gate: "delivery", dial: "gate", state: "pending" },
      ],
      pendingApprovals: expect.arrayContaining([
        { gate: "requirements", subject: "R1", elementId: "requirement-1" },
        { gate: "design", subject: "D1", elementId: "decision-1" },
        { gate: "plan", subject: "plan", elementId: null },
        {
          gate: "execution_start",
          subject: "execution_start",
          elementId: null,
        },
        { gate: "delivery", subject: "delivery", elementId: null },
      ]),
      openQuestions: [
        {
          id: question.id,
          handle: "Q1",
          text: question.text,
          elementId: question.element_id,
        },
      ],
      assumptions: [
        {
          id: assumption.id,
          handle: "A1",
          text: assumption.text,
          disposition: assumption.disposition,
          elementId: assumption.element_id,
        },
      ],
      coverage: {
        coveredCriteria: 1,
        totalCriteria: 1,
        percentage: 100,
      },
      delivery: {
        allWaived: false,
        provenCount: 0,
        totalInScope: 0,
      },
    });
  });

  it("14.1 rolls delivery up over the active execution's pinned in-scope criteria", async () => {
    const approvedRevision = { ...revision, state: "approved" as const };
    const approvedSnapshot: SpecRevisionSnapshot = {
      revision: approvedRevision,
      elements: [
        ...snapshot.elements.map((row) => ({
          ...row,
          version: { ...row.version, revisionId: approvedRevision.id },
        })),
        {
          element: {
            id: "criterion-2",
            specId: spec.id,
            kind: "criterion",
            number: 2,
            parentElementId: "requirement-1",
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: approvedRevision.id,
            elementId: "criterion-2",
            position: 4,
            payload: {
              kind: "criterion",
              text: "A deferred criterion remains outside this delivery",
              validationStrategy: { kinds: ["test_run"] },
            },
            payloadHash: "criterion-2-hash",
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        },
      ],
    };
    const activeExecution = execution({
      state: "running",
      delivered_at: null,
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [
          { criterionId: "criterion-2", disposition: "deferred" },
        ],
      }),
    });
    const dispositions: SpecCriterionDispositionRow[] = [
      {
        execution_id: activeExecution.id,
        criterion_element_id: "criterion-1",
        disposition: "in_scope",
        waiver_id: null,
        delivered_by_execution_id: null,
        created_at: revision.createdAt,
        updated_at: revision.createdAt,
      },
      {
        execution_id: activeExecution.id,
        criterion_element_id: "criterion-2",
        disposition: "deferred",
        waiver_id: null,
        delivered_by_execution_id: null,
        created_at: revision.createdAt,
        updated_at: revision.createdAt,
      },
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision],
        getRevisionSnapshot: async () => approvedSnapshot,
        findExecutionsBySpecId: () => [activeExecution],
        findCriterionDispositionsByExecution: () => dispositions,
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      delivery: {
        allWaived: false,
        provenCount: 0,
        totalInScope: 1,
      },
    });
  });

  it("scopes execution_start and delivery gate admissions to the current run — an older run's admission never admits a new run", async () => {
    const olderDelivered = execution({
      id: "execution-old",
      state: "delivered",
      created_at: "2026-07-01T10:00:00.000Z",
      updated_at: "2026-07-01T10:00:00.000Z",
    });
    const newerActive = execution({
      id: "execution-new",
      state: "definition_review",
      workflow_execution_id: null,
      delivered_at: null,
      created_at: "2026-07-02T10:00:00.000Z",
      updated_at: "2026-07-02T10:00:00.000Z",
    });
    const admissionFor = (
      gate: "execution_start" | "delivery",
      executionId: string,
    ): SpecGateAdmissionRow => ({
      id: `admission-${gate}-${executionId}`,
      spec_id: spec.id,
      gate,
      basis: "human_approval",
      approval_id: null,
      revision_id: revision.id,
      execution_id: executionId,
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-07-01T10:00:00.000Z",
    });
    const staleAdmissions = [
      admissionFor("execution_start", olderDelivered.id),
      admissionFor("delivery", olderDelivered.id),
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [olderDelivered, newerActive],
        findGateAdmissionsByRevision: () => staleAdmissions,
      }),
    );

    const stale = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as {
      gates: Array<{ gate: string; state: string }>;
    };
    expect(
      staleBody.gates.find((gate) => gate.gate === "execution_start"),
    ).toMatchObject({ state: "pending" });
    expect(
      staleBody.gates.find((gate) => gate.gate === "delivery"),
    ).toMatchObject({ state: "pending" });

    // An admission scoped to the current run reads admitted.
    const scopedHandlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [olderDelivered, newerActive],
        findGateAdmissionsByRevision: () => [
          ...staleAdmissions,
          admissionFor("execution_start", newerActive.id),
        ],
      }),
    );
    const scoped = await scopedHandlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const scopedBody = (await scoped.json()) as {
      gates: Array<{ gate: string; state: string }>;
    };
    expect(
      scopedBody.gates.find((gate) => gate.gate === "execution_start"),
    ).toMatchObject({ state: "admitted" });
    expect(
      scopedBody.gates.find((gate) => gate.gate === "delivery"),
    ).toMatchObject({ state: "pending" });
  });

  it("reads execution-scoped admissions from the active run's pinned revision while a newer draft amendment exists", async () => {
    const approvedPinned = {
      ...revision,
      state: "approved" as const,
      approvedAt: "2026-07-01T09:00:00.000Z",
    };
    const newerDraft: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      state: "draft",
      basedOnRevisionId: approvedPinned.id,
      createdAt: "2026-07-02T09:00:00.000Z",
    };
    const activeRun = execution({
      id: "execution-pinned",
      state: "running",
      revision_id: approvedPinned.id,
      delivered_at: null,
    });
    const startAdmission: SpecGateAdmissionRow = {
      id: "admission-start-pinned",
      spec_id: spec.id,
      gate: "execution_start",
      basis: "notify_policy",
      approval_id: null,
      revision_id: approvedPinned.id,
      execution_id: activeRun.id,
      actor_json: JSON.stringify({ kind: "system" }),
      created_at: "2026-07-02T10:00:00.000Z",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedPinned, newerDraft],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === approvedPinned.id
            ? { ...snapshot, revision: approvedPinned }
            : revisionId === newerDraft.id
              ? { ...snapshot, revision: newerDraft }
              : null,
        findExecutionsBySpecId: () => [activeRun],
        // The repo indexes admissions by the revision they were granted
        // against — the run's pinned revision, not the newer draft.
        findGateAdmissionsByRevision: (revisionId) =>
          revisionId === approvedPinned.id ? [startAdmission] : [],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      gates: Array<{ gate: string; state: string }>;
    };
    expect(
      body.gates.find((gate) => gate.gate === "execution_start"),
    ).toMatchObject({ state: "admitted" });
  });

  it("projects delivery from every criterion in the current approved revision", async () => {
    const earlierApproved = { ...revision, state: "approved" as const };
    const currentApproved = {
      ...revision,
      id: "revision-2",
      number: 2,
      state: "approved" as const,
      basedOnRevisionId: revision.id,
    };
    const currentSnapshot: SpecRevisionSnapshot = {
      revision: currentApproved,
      elements: [
        ...snapshot.elements.map((row) => ({
          ...row,
          version: { ...row.version, revisionId: currentApproved.id },
        })),
        {
          element: {
            id: "criterion-2",
            specId: spec.id,
            kind: "criterion",
            number: 2,
            parentElementId: "requirement-1",
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: currentApproved.id,
            elementId: "criterion-2",
            position: 4,
            payload: {
              kind: "criterion",
              text: "The current revision criterion is still pending",
              validationStrategy: { kinds: ["test_run"] },
            },
            payloadHash: "criterion-2-hash",
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        },
      ],
    };
    const deliveredEarlier = execution({ revision_id: earlierApproved.id });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [earlierApproved, currentApproved],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === currentApproved.id ? currentSnapshot : snapshot,
        findExecutionsBySpecId: () => [deliveredEarlier],
        findCriterionDispositionsByExecution: () => [
          {
            execution_id: deliveredEarlier.id,
            criterion_element_id: "criterion-1",
            disposition: "in_scope",
            waiver_id: null,
            delivered_by_execution_id: null,
            created_at: revision.createdAt,
            updated_at: revision.createdAt,
          },
        ],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      phase: { primary: "approved" },
    });
  });

  it("reconciles callback-loss lifecycle state before projecting status", async () => {
    const approvedRevision = { ...revision, state: "approved" as const };
    const approvedSnapshot = { ...snapshot, revision: approvedRevision };
    const stored = execution({ state: "running", delivered_at: null });
    const reconciled = execution();
    const reconcileExecution = vi.fn(async () => reconciled);
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision],
        getRevisionSnapshot: async () => approvedSnapshot,
        findExecutionsBySpecId: () => [stored],
        reconcileExecution,
        findCriterionDispositionsByExecution: () => [
          {
            execution_id: stored.id,
            criterion_element_id: "criterion-1",
            disposition: "in_scope",
            waiver_id: null,
            delivered_by_execution_id: null,
            created_at: revision.createdAt,
            updated_at: revision.createdAt,
          },
        ],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      phase: { primary: "delivered" },
    });
    expect(reconcileExecution).toHaveBeenCalledWith(PROJECT_PATH, stored);
  });

  it("returns task plan approval and evidence after best-effort ingestion", async () => {
    const planApproval: SpecApprovalRow = {
      id: "approval-plan-1",
      spec_id: spec.id,
      subject_kind: "plan",
      element_id: null,
      revision_id: revision.id,
      approver: "operator",
      granted_at: revision.createdAt,
      validity: "valid",
    };
    const evidence: SpecEvidenceRow = {
      id: "evidence-1",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: revision.id,
      kind: "test_run",
      ref_json: JSON.stringify({ kind: "test_run", eventId: 1 }),
      evaluated_state_json: JSON.stringify({ relevantPaths: [] }),
      producer_json: JSON.stringify({ kind: "system" }),
      execution_id: "execution-1",
      source_event_id: 1,
      created_at: revision.createdAt,
    };
    const verdict: SpecProofVerdictRow = {
      id: "verdict-1",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: revision.id,
      execution_id: "execution-1",
      verdict_kind: "deterministic_validator",
      evidence_ids_json: JSON.stringify([evidence.id]),
      verdict_at: revision.createdAt,
      stale_at: null,
      stale_reason: null,
    };
    const materialized: SpecEvidenceRow[] = [];
    const ingestExecutionEvidenceBestEffort = vi.fn(async () => {
      materialized.push(evidence);
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        findApprovalsBySpecId: () => [planApproval],
        findExecutionsBySpecId: () => [execution()],
        ingestExecutionEvidenceBestEffort,
        findEvidenceByCriterionRevision: () => materialized,
        findProofVerdictsByCriterionRevision: () => [verdict],
      }),
    );

    const response = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/T1"),
      routeContext({ name: "demo", slug: spec.slug, element: "T1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      handle: "T1",
      approvals: [{ id: planApproval.id, element_id: null }],
      evidenceState: [
        {
          criterionElementId: "criterion-1",
          evidence: [{ id: evidence.id }],
          verdicts: [{ id: verdict.id }],
        },
      ],
    });
    expect(ingestExecutionEvidenceBestEffort).toHaveBeenCalledWith(
      PROJECT_PATH,
      "execution-1",
    );
  });

  it("serializes same-revision evidence ingestion so a later execution cannot self-contend", async () => {
    const earlierExecution = execution({
      id: "execution-earlier",
      state: "abandoned",
      workflow_execution_id: "workflow-execution-earlier",
      delivered_at: null,
      abandoned_reason: "Superseded by the later execution",
    });
    const laterExecution = execution({
      id: "execution-later",
      state: "running",
      workflow_execution_id: "workflow-execution-later",
      delivered_at: null,
    });
    const laterEvidence: SpecEvidenceRow = {
      id: "evidence-from-later-execution",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: revision.id,
      kind: "test_run",
      ref_json: JSON.stringify({
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-later",
        eventId: 42,
        contextId: "context-1",
      }),
      evaluated_state_json: JSON.stringify({ relevantPaths: [] }),
      producer_json: JSON.stringify({ kind: "system" }),
      execution_id: laterExecution.id,
      source_event_id: 42,
      created_at: revision.createdAt,
    };
    const materialized: SpecEvidenceRow[] = [];
    let concurrentIngestions = 0;
    let maxConcurrentIngestions = 0;
    const ingestExecutionEvidenceBestEffort = vi.fn(
      async (_projectPath: string, executionId: string) => {
        concurrentIngestions += 1;
        maxConcurrentIngestions = Math.max(
          maxConcurrentIngestions,
          concurrentIngestions,
        );
        if (concurrentIngestions > 1) {
          concurrentIngestions -= 1;
          return;
        }

        await Promise.resolve();
        if (executionId === laterExecution.id) {
          materialized.push(laterEvidence);
        }
        concurrentIngestions -= 1;
      },
    );
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [earlierExecution, laterExecution],
        ingestExecutionEvidenceBestEffort,
        findEvidenceByCriterionRevision: () => materialized,
      }),
    );

    const response = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/T1"),
      routeContext({ name: "demo", slug: spec.slug, element: "T1" }),
    );

    expect(response.status).toBe(200);
    expect(maxConcurrentIngestions).toBe(1);
    await expect(response.json()).resolves.toMatchObject({
      evidenceState: [
        {
          criterionElementId: "criterion-1",
          evidence: [{ id: laterEvidence.id }],
        },
      ],
    });
  });

  it("derives reference staleness from observed and latest-containing hashes", async () => {
    const changedRevision: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: revision.id,
    };
    const restoredRevision: SpecRevision = {
      ...revision,
      id: "revision-3",
      number: 3,
      basedOnRevisionId: changedRevision.id,
    };
    const snapshotAt = (
      candidate: SpecRevision,
      requirementHash: string,
    ): SpecRevisionSnapshot => ({
      revision: candidate,
      elements: snapshot.elements.map((row) => ({
        ...row,
        version: {
          ...row.version,
          revisionId: candidate.id,
          payloadHash:
            row.element.id === "requirement-1"
              ? requirementHash
              : row.version.payloadHash,
        },
      })),
    });
    const snapshots = new Map([
      [revision.id, snapshotAt(revision, "observed-hash")],
      [changedRevision.id, snapshotAt(changedRevision, "changed-hash")],
      [restoredRevision.id, snapshotAt(restoredRevision, "observed-hash")],
    ]);
    const revisions = [revision, changedRevision];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => revisions,
        getRevisionSnapshot: async (revisionId) =>
          snapshots.get(revisionId) ?? null,
      }),
    );

    const changedResponse = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?observedRevision=1",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );

    expect(changedResponse.status).toBe(200);
    await expect(changedResponse.json()).resolves.toMatchObject({
      referenceState: {
        observedRevision: 1,
        observedPayloadHash: "observed-hash",
        latestContainingRevision: 2,
        latestPayloadHash: "changed-hash",
      },
    });

    revisions.push(restoredRevision);
    const restoredResponse = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?observedRevision=1",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );

    await expect(restoredResponse.json()).resolves.toMatchObject({
      referenceState: {
        observedRevision: 1,
        observedPayloadHash: "observed-hash",
        latestContainingRevision: 3,
        latestPayloadHash: "observed-hash",
      },
    });
  });

  it("keeps a reference fresh when a newer revision leaves the element untouched", async () => {
    const newerRevision: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: revision.id,
    };
    const newerSnapshot: SpecRevisionSnapshot = {
      revision: newerRevision,
      elements: snapshot.elements.map((row) => ({
        ...row,
        version: { ...row.version, revisionId: newerRevision.id },
      })),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [revision, newerRevision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === newerRevision.id ? newerSnapshot : snapshot,
      }),
    );

    const response = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?observedRevision=1",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );

    await expect(response.json()).resolves.toMatchObject({
      referenceState: {
        observedPayloadHash: "requirement-hash",
        latestContainingRevision: 2,
        latestPayloadHash: "requirement-hash",
      },
    });
  });

  it("returns exactly the lint predicate output for the current draft", async () => {
    const findings = [
      {
        ruleId: "dangling_handle",
        severity: "blocks_propose" as const,
        elementHandle: "D1",
        message: "D1 cites an unknown element",
      },
    ];
    const lintDraft = vi.fn(async () => findings);
    const handlers = createSpecRouteHandlers(createDeps({ lintDraft }));

    const response = await handlers.getSpecLintGET(
      new Request("http://cc.test/api/specs/demo/current-slug/lint"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revisionId: revision.id,
      findings,
    });
    expect(lintDraft).toHaveBeenCalledWith(spec.id, revision.id);
  });

  it("runs lint against the latest approved revision when no draft exists", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "approved-content-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const approvedSnapshot: SpecRevisionSnapshot = {
      revision: approvedRevision,
      elements: snapshot.elements.map((row) => ({
        ...row,
        version: { ...row.version, revisionId: approvedRevision.id },
      })),
    };
    const findings = [
      {
        ruleId: "dangling_handle",
        severity: "blocks_propose" as const,
        elementHandle: "D1",
        message: "D1 cites an unknown element",
      },
    ];
    const lintDraft = vi.fn(async () => findings);
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision],
        getRevisionSnapshot: async () => approvedSnapshot,
        lintDraft,
      }),
    );

    const response = await handlers.getSpecLintGET(
      new Request("http://cc.test/api/specs/demo/current-slug/lint"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revisionId: approvedRevision.id,
      findings,
    });
    expect(lintDraft).toHaveBeenCalledWith(spec.id, approvedRevision.id);
  });

  it("uses the shared project, spec, and element 404 ladder", async () => {
    const resolveSpec = vi.fn(createDeps().resolveSpec);
    const handlers = createSpecRouteHandlers(createDeps({ resolveSpec }));

    const projectResponse = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/missing/current-slug"),
      routeContext({ name: "missing", slug: spec.slug }),
    );
    expect(projectResponse.status).toBe(404);
    await expect(projectResponse.json()).resolves.toEqual({
      error: "Project not found",
    });
    expect(resolveSpec).not.toHaveBeenCalled();

    const specResponse = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/missing"),
      routeContext({ name: "demo", slug: "missing" }),
    );
    expect(specResponse.status).toBe(404);
    await expect(specResponse.json()).resolves.toEqual({
      error: "Spec not found",
    });

    const elementResponse = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/R9"),
      routeContext({ name: "demo", slug: spec.slug, element: "R9" }),
    );
    expect(elementResponse.status).toBe(404);
    await expect(elementResponse.json()).resolves.toEqual({
      error: "Spec element not found",
    });
  });

  it("lists project inventory and searches requirements and decisions", async () => {
    const handlers = createSpecRouteHandlers(
      createDeps({
        findLinksBySpecId: () => [
          {
            id: "link-ticket",
            spec_id: spec.id,
            object_kind: "ticket",
            object_ref_json: JSON.stringify({ projectName: "demo", number: 7 }),
            direction: "outbound",
            category: "reference",
            snapshot_json: null,
            element_ids_json: null,
            actor_json: JSON.stringify({ kind: "human", actorId: "alex" }),
            created_at: revision.createdAt,
          },
          {
            id: "link-conversation",
            spec_id: spec.id,
            object_kind: "conversation",
            object_ref_json: JSON.stringify({
              conversationId: "conversation-1",
            }),
            direction: "inbound",
            category: "source",
            snapshot_json: null,
            element_ids_json: null,
            actor_json: JSON.stringify({ kind: "human", actorId: "alex" }),
            created_at: revision.createdAt,
          },
        ],
      }),
    );

    const inventory = await handlers.listSpecsGET(
      new Request("http://cc.test/api/specs/demo"),
      routeContext({ name: "demo" }),
    );
    expect(inventory.status).toBe(200);
    await expect(inventory.json()).resolves.toMatchObject({
      specs: [
        {
          spec: { id: spec.id },
          counts: { requirements: 1, criteria: 1, decisions: 1, tasks: 1 },
          delivery: { allWaived: false, provenCount: 0, totalInScope: 0 },
          linkedWork: {
            tickets: 1,
            conversations: 1,
            sessions: 0,
            workflowExecutions: 0,
            mergeJobs: 0,
          },
        },
      ],
    });

    const search = await handlers.searchSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug/search?q=route"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toEqual({
      query: "route",
      results: [
        expect.objectContaining({ handle: "R1", kind: "requirement" }),
        expect.objectContaining({ handle: "D1", kind: "decision" }),
      ],
    });
  });
});
