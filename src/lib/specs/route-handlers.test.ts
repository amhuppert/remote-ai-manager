import { describe, expect, it, vi } from "vitest";

import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecCommentRow,
  SpecCriterionDispositionRow,
  SpecDeliveryVerdictRow,
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecLinkRow,
  SpecProofVerdictRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";
import { lint } from "./lint";
import {
  createSpecRouteHandlers,
  SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT,
  SPEC_OUTLINE_ROOT_LIMIT,
  type SpecRouteDeps,
} from "./route-handlers";
import {
  specCommentsViewSchema,
  specDetailViewSchema,
  specEditContextViewSchema,
  specShowOutlineViewSchema,
  specProjectSearchViewSchema,
  specStatusViewSchema,
} from "./view-schemas";

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
  authoringStage: "plan",
  basedOnRevisionId: null,
  contentHash: null,
  proposedAt: null,
  approvedAt: null,
  externalDelivery: null,
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
    execution_start_dial: "gate",
    workflow_definition_id: null,
    workflow_definition_revision: null,
    workflow_seed_source_json: JSON.stringify({
      kind: "spec_delivery",
      specSlug: "native-sdd",
      candidateId: "launch-1",
    }),
    workflow_execution_binding_json: JSON.stringify({
      dispositions: [],
      claims: [],
    }),
    workflow_execution_id: "workflow-execution-1",
    session_name: "session-1",
    delivered_at: revision.createdAt,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
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
    findEventsBySpecId: () => [],
    findGateAdmissionsBySpecId: () => [] as SpecGateAdmissionRow[],
    findLinksBySpecId: () => [] as SpecLinkRow[],
    getLinkedTickets: async () => [],
    findQuestionsBySpecId: () => [question],
    findAssumptionsBySpecId: () => [assumption],
    findExecutionsBySpecId: () => [] as SpecExecutionRow[],
    findWorkflowEventsByExecution: () => [],
    reconcileExecution: async (_projectPath, candidate) => ({
      execution: candidate,
      workflowStatus: null,
    }),
    findCriterionDispositionsByExecution: () => [],
    findEvidenceByCriterionRevision: () => [],
    findProofVerdictsByCriterionRevision: () => [],
    findDeliveryVerdictsBySpecExecutionId: () => [],
    findExecutionBindingBySpecExecutionId: () => null,
    findWaiverForCriterionRevision: () => null,
    findWaiverById: () => null,
    findWaiversByRevision: () => [],
    exportSpec: async () => ({ markdownFiles: [], manifest: "{}\n" }),
    verifySpec: async () => ({
      ok: true,
      checkedRevisionIds: [],
      mismatches: [],
      consistencyFindings: [],
    }),
    measureProject: async () => ({
      definitionsVersion: "native-sdd-measures-v2",
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
  it("returns a bounded nested current-revision outline with stable handles and domain status", async () => {
    const multilineStatement = `  Agents can inspect   the current revision\nwithout transferring ${"every payload ".repeat(20)}  `;
    const [requirementRow, criterionRow, decisionRow, taskRow] =
      snapshot.elements;
    if (
      requirementRow === undefined ||
      criterionRow === undefined ||
      decisionRow === undefined ||
      taskRow === undefined
    ) {
      throw new Error("outline fixture requires four content elements");
    }
    const outlineSnapshot: SpecRevisionSnapshot = {
      ...snapshot,
      elements: [
        {
          ...requirementRow,
          version: {
            ...requirementRow.version,
            payload: {
              kind: "requirement",
              statement: multilineStatement,
              priority: "must",
              risk: "medium",
            },
          },
        },
        decisionRow,
        taskRow,
        criterionRow,
        {
          element: {
            id: "section-1",
            specId: spec.id,
            kind: "section",
            number: null,
            parentElementId: null,
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: revision.id,
            elementId: "section-1",
            position: 4,
            payload: {
              kind: "section",
              role: "intent_problem",
              title: "Problem",
              body: "The read path is too large.",
            },
            payloadHash: "section-hash",
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        },
      ],
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        getRevisionSnapshot: async (revisionId) =>
          revisionId === revision.id ? outlineSnapshot : null,
      }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/old-slug/outline"),
      routeContext({ name: "demo", slug: "old-slug" }),
    );

    expect(response.status).toBe(200);
    const body = specShowOutlineViewSchema.parse(await response.json());
    expect(body).toMatchObject({
      spec: { id: spec.id, slug: spec.slug, name: spec.name },
      revision: {
        role: "current",
        id: revision.id,
        number: 1,
        state: "draft",
        authoringStage: "plan",
        basedOnRevisionId: null,
      },
      phase: { primary: "draft", authoringStage: "plan" },
      counts: {
        requirements: 1,
        criteria: 1,
        decisions: 1,
        tasks: 1,
        sections: 1,
      },
      requirements: [
        {
          handle: "R1",
          elementId: "requirement-1",
          elementVersion: 1,
          priority: "must",
          risk: "medium",
          status: {
            approval: "unapproved",
            coverage: "covered",
            proof: "pending",
          },
          criteria: [
            {
              handle: "R1.1",
              elementId: "criterion-1",
              elementVersion: 1,
              validationKinds: ["test_run"],
              status: { coverage: "covered", proof: "pending" },
              summary: "The old slug returns the current spec",
            },
          ],
        },
      ],
      decisions: [
        {
          handle: "D1",
          elementId: "decision-1",
          elementVersion: 1,
          summary: "Compose shared route resolution",
          status: { approval: "unapproved" },
        },
      ],
      tasks: [
        {
          handle: "T1",
          elementId: "task-1",
          elementVersion: 1,
          summary: "Build read routes",
          status: { status: "pending" },
        },
      ],
      disclosure: {
        requirements: { total: 1, returned: 1, truncated: false },
        criteria: { total: 1, returned: 1, truncated: false },
        decisions: { total: 1, returned: 1, truncated: false },
        tasks: { total: 1, returned: 1, truncated: false },
        sections: { total: 1, returned: 0, truncated: true },
        next: `cctl spec show ${spec.slug} --rendered`,
      },
    });
    expect(body.requirements[0]?.summary).toHaveLength(160);
    expect(body.requirements[0]?.summary).not.toContain("\n");
    expect(body.requirements[0]?.summary.endsWith("…")).toBe(true);
  });

  it("shows approvals only when they apply to the current amendment content", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      id: "revision-approved",
      state: "approved",
      contentHash: "approved-content-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const amendmentRevision: SpecRevision = {
      ...revision,
      id: "revision-amendment",
      number: 2,
      basedOnRevisionId: approvedRevision.id,
    };
    const snapshotFor = (
      targetRevision: SpecRevision,
      changed: boolean,
    ): SpecRevisionSnapshot => ({
      revision: targetRevision,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: {
          ...entry.version,
          revisionId: targetRevision.id,
          ...(changed && entry.element.kind === "requirement"
            ? {
                payload: {
                  kind: "requirement" as const,
                  statement: "The amendment changes this requirement.",
                  priority: "must" as const,
                  risk: "high" as const,
                },
                payloadHash: "amended-requirement-hash",
              }
            : {}),
          ...(changed && entry.element.kind === "decision"
            ? {
                payload: {
                  kind: "decision" as const,
                  title: "The amendment changes this decision",
                  chosenApproach: "Use the amended approach",
                  rejectedAlternatives: [],
                  reason: "The prior decision no longer applies",
                  tracedRequirementElementIds: ["requirement-1"],
                },
                payloadHash: "amended-decision-hash",
              }
            : {}),
        },
      })),
    });
    const approvedSnapshot = snapshotFor(approvedRevision, false);
    const amendmentSnapshot = snapshotFor(amendmentRevision, true);
    const approvals: SpecApprovalRow[] = [
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
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, amendmentRevision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === approvedRevision.id
            ? approvedSnapshot
            : revisionId === amendmentRevision.id
              ? amendmentSnapshot
              : null,
        findApprovalsBySpecId: () => approvals,
      }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = specShowOutlineViewSchema.parse(await response.json());
    expect(body.requirements[0]?.status.approval).toBe("unapproved");
    expect(body.decisions[0]?.status.approval).toBe("unapproved");
  });

  it("preserves stale and closed approval state in the element outline", async () => {
    const approvals: SpecApprovalRow[] = [
      {
        id: "approval-requirement-stale",
        spec_id: spec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: revision.id,
        approver: "alex",
        granted_at: revision.createdAt,
        validity: "stale",
      },
      {
        id: "approval-decision-closed",
        spec_id: spec.id,
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: revision.id,
        approver: "alex",
        granted_at: revision.createdAt,
        validity: "closed",
      },
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({ findApprovalsBySpecId: () => approvals }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const body = specShowOutlineViewSchema.parse(await response.json());

    expect(body.requirements[0]?.status.approval).toBe("stale");
    expect(body.decisions[0]?.status.approval).toBe("closed");
  });

  it("caps root collections and each requirement's nested criteria while reporting every omission", async () => {
    const requirements = Array.from(
      { length: SPEC_OUTLINE_ROOT_LIMIT + 1 },
      (_, index) => ({
        element: {
          id: `requirement-${index + 1}`,
          specId: spec.id,
          kind: "requirement" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: revision.createdAt,
        },
        version: {
          revisionId: revision.id,
          elementId: `requirement-${index + 1}`,
          position: index,
          payload: {
            kind: "requirement" as const,
            statement: `Requirement ${index + 1} ${"bounded summary ".repeat(20)}`,
            priority: "must" as const,
            risk: "low" as const,
          },
          payloadHash: `requirement-hash-${index + 1}`,
          elementVersion: 1,
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
        },
      }),
    );
    const criteria = requirements.flatMap((requirement, requirementIndex) =>
      Array.from(
        { length: SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT + 1 },
        (_, criterionIndex) => ({
          element: {
            id: `criterion-${requirementIndex + 1}-${criterionIndex + 1}`,
            specId: spec.id,
            kind: "criterion" as const,
            number: criterionIndex + 1,
            parentElementId: requirement.element.id,
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: revision.id,
            elementId: `criterion-${requirementIndex + 1}-${criterionIndex + 1}`,
            position:
              requirements.length +
              requirementIndex *
                (SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT + 1) +
              criterionIndex,
            payload: {
              kind: "criterion" as const,
              text: `Criterion ${requirementIndex + 1}.${criterionIndex + 1} ${"bounded summary ".repeat(20)}`,
              validationStrategy: {
                kinds: [
                  "test_run" as const,
                  "test_run" as const,
                  "validator_verdict" as const,
                ],
              },
            },
            payloadHash: `criterion-hash-${requirementIndex + 1}-${criterionIndex + 1}`,
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        }),
      ),
    );
    const decisions = Array.from(
      { length: SPEC_OUTLINE_ROOT_LIMIT + 1 },
      (_, index) => ({
        element: {
          id: `decision-${index + 1}`,
          specId: spec.id,
          kind: "decision" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: revision.createdAt,
        },
        version: {
          revisionId: revision.id,
          elementId: `decision-${index + 1}`,
          position: requirements.length + criteria.length + index,
          payload: {
            kind: "decision" as const,
            title: `Decision ${index + 1} ${"bounded summary ".repeat(20)}`,
            chosenApproach: "Choose it",
            rejectedAlternatives: [],
            reason: "Bounded output",
            tracedRequirementElementIds: [],
          },
          payloadHash: `decision-hash-${index + 1}`,
          elementVersion: 1,
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
        },
      }),
    );
    const tasks = Array.from(
      { length: SPEC_OUTLINE_ROOT_LIMIT + 1 },
      (_, index) => ({
        element: {
          id: `task-${index + 1}`,
          specId: spec.id,
          kind: "task" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: revision.createdAt,
        },
        version: {
          revisionId: revision.id,
          elementId: `task-${index + 1}`,
          position:
            requirements.length + criteria.length + decisions.length + index,
          payload: {
            kind: "task" as const,
            title: `Task ${index + 1} ${"bounded summary ".repeat(20)}`,
            instructions: "Build it",
            tracedRequirementElementIds: [],
            tracedDecisionElementIds: [],
            coveredCriterionElementIds: [],
            dependsOnTaskElementIds: [],
          },
          payloadHash: `task-hash-${index + 1}`,
          elementVersion: 1,
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
        },
      }),
    );
    const firstRequirement = requirements.at(0);
    if (firstRequirement === undefined) {
      throw new Error("bounded outline fixture requires one requirement");
    }
    const unaddressableRequirement = {
      ...firstRequirement,
      element: {
        ...firstRequirement.element,
        id: "0-unaddressable-requirement",
        number: 1e21,
      },
      version: {
        ...firstRequirement.version,
        elementId: "0-unaddressable-requirement",
        position: 0,
      },
    };
    const boundedSnapshot: SpecRevisionSnapshot = {
      revision,
      elements: [
        unaddressableRequirement,
        ...requirements,
        ...criteria,
        ...decisions,
        ...tasks,
      ],
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        getRevisionSnapshot: async (revisionId) =>
          revisionId === revision.id ? boundedSnapshot : null,
      }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const body = specShowOutlineViewSchema.parse(await response.json());

    expect(body.requirements).toHaveLength(SPEC_OUTLINE_ROOT_LIMIT);
    expect(body.requirements[0]?.criteria).toHaveLength(
      SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT,
    );
    expect(body.requirements[0]?.criteria[0]?.validationKinds).toEqual([
      "test_run",
      "validator_verdict",
    ]);
    expect(JSON.stringify(body)).not.toContain("0-unaddressable-requirement");
    expect(body.decisions).toHaveLength(SPEC_OUTLINE_ROOT_LIMIT);
    expect(body.tasks).toHaveLength(SPEC_OUTLINE_ROOT_LIMIT);
    expect(body.tasks[0]?.status).toEqual({ status: "pending" });
    expect(body.disclosure).toMatchObject({
      requirements: {
        total: SPEC_OUTLINE_ROOT_LIMIT + 2,
        returned: SPEC_OUTLINE_ROOT_LIMIT,
        truncated: true,
      },
      criteria: {
        total:
          (SPEC_OUTLINE_ROOT_LIMIT + 1) *
          (SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT + 1),
        returned:
          SPEC_OUTLINE_ROOT_LIMIT * SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT,
        truncated: true,
      },
      decisions: {
        total: SPEC_OUTLINE_ROOT_LIMIT + 1,
        returned: SPEC_OUTLINE_ROOT_LIMIT,
        truncated: true,
      },
      tasks: {
        total: SPEC_OUTLINE_ROOT_LIMIT + 1,
        returned: SPEC_OUTLINE_ROOT_LIMIT,
        truncated: true,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(
      60 * 1024,
    );
  });

  it("surfaces the empty-design advisory in status for an approved design revision", async () => {
    const approvedDesignRevision: SpecRevision = {
      ...revision,
      state: "approved",
      authoringStage: "design",
      contentHash: "approved-design-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const approvedDesignSnapshot: SpecRevisionSnapshot = {
      revision: approvedDesignRevision,
      elements: snapshot.elements
        .filter(({ element }) =>
          ["requirement", "criterion"].includes(element.kind),
        )
        .map((entry) => ({
          ...entry,
          version: {
            ...entry.version,
            revisionId: approvedDesignRevision.id,
          },
        })),
    };
    const [approvedRequirement, approvedCriterion] =
      approvedDesignSnapshot.elements;
    if (approvedRequirement === undefined || approvedCriterion === undefined) {
      throw new Error(
        "approved design fixture requires requirement and criterion",
      );
    }
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedDesignRevision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === approvedDesignRevision.id
            ? approvedDesignSnapshot
            : null,
        lintDraft: async () => [
          ...Array.from({ length: 6 }, (_unused, index) => ({
            ruleId: `test.blocker-${index + 1}`,
            severity: "blocks_propose" as const,
            elementHandle: `R${index + 1}`,
            message: `Blocking finding ${index + 1}.`,
          })),
          ...lint(
            {
              specHandle: spec.slug,
              authoringStage: "design",
              elements: [
                {
                  id: "requirement-1",
                  handle: "R1",
                  payloadHash: "requirement-hash",
                  payload: approvedRequirement.version.payload,
                },
                {
                  id: "criterion-1",
                  handle: "R1.1",
                  parentElementId: "requirement-1",
                  payloadHash: "criterion-hash",
                  payload: approvedCriterion.version.payload,
                },
              ],
            },
            {},
          ),
        ],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const status = specStatusViewSchema.parse(await response.json());
    expect(status.draftHealth?.top).toContainEqual({
      ruleId: "9.13.design-stage-without-design-content",
      severity: "advisory",
      elementHandle: spec.slug,
      message:
        "Design-stage revision carries no decision or design narrative elements.",
    });
    expect(status.draftHealth?.top).toHaveLength(6);
  });

  it("keeps an approved legacy plan revision and its task readable", async () => {
    const approvedPlan = {
      ...revision,
      state: "approved" as const,
      contentHash: "legacy-plan-hash",
      approvedAt: revision.createdAt,
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedPlan],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === approvedPlan.id
            ? { ...snapshot, revision: approvedPlan }
            : null,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.revisions).toContainEqual(approvedPlan);
    expect(detail.currentApprovedRevision?.revision.authoringStage).toBe(
      "plan",
    );
    expect(
      detail.currentApprovedRevision?.elements.find(
        (element) => element.element.kind === "task",
      )?.version.payload,
    ).toMatchObject({ kind: "task", title: "Build read routes" });
  });

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
    const sectionSnapshot: SpecRevisionSnapshot = {
      ...snapshot,
      elements: [
        ...snapshot.elements,
        {
          element: {
            id: "section-intent",
            specId: spec.id,
            kind: "section",
            number: null,
            parentElementId: null,
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: revision.id,
            elementId: "section-intent",
            position: 4,
            payload: {
              kind: "section",
              role: "intent_problem",
              title: "Problem",
              body: "Agents cannot address elements they cannot see.",
            },
            payloadHash: "section-hash",
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        },
      ],
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
        findWaiverById: (waiverId) => (waiverId === waiver.id ? waiver : null),
        getRevisionSnapshot: async (revisionId) =>
          revisionId === revision.id ? sectionSnapshot : null,
        getLinkedTickets,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/old-slug"),
      routeContext({ name: "demo", slug: "old-slug" }),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      spec: { id: spec.id, slug: "current-slug" },
      aliases: [{ slug: "old-slug" }],
      currentRevision: {
        revision: { id: revision.id },
        elements: expect.any(Array),
      },
      approvals: [approval],
      comments: [
        {
          id: comment.id,
          threadId: comment.thread_id,
          elementId: comment.element_id,
          handle: "R1",
          body: comment.body,
          blocking: false,
          resolution: "open",
        },
      ],
      questions: [
        {
          handle: "Q1",
          status: "open",
          provenance: { kind: "agent", conversationId: "conv-1" },
        },
      ],
      assumptions: [
        {
          handle: "A1",
          disposition: "rejected",
          proposedBy: { kind: "agent", conversationId: "conv-1" },
        },
      ],
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
            status: { status: "pending" },
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
    const detail = specDetailViewSchema.parse(body);
    expect(
      detail.currentRevision?.elements.map(({ element, handle }) => [
        element.id,
        handle,
      ]),
    ).toEqual([
      ["requirement-1", "R1"],
      ["criterion-1", "R1.1"],
      ["decision-1", "D1"],
      ["task-1", "T1"],
      ["section-intent", null],
    ]);
    expect(getLinkedTickets).toHaveBeenCalledWith(PROJECT_PATH, spec.id);
  });

  it("projects executions and gate admissions into the domain shape, keeping state and workflow linkage", async () => {
    const admission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "execution_start",
      basis: "notify_policy",
      approval_id: null,
      revision_id: revision.id,
      execution_id: "execution-1",
      actor_json: JSON.stringify({ kind: "agent", conversationId: "conv-1" }),
      created_at: revision.createdAt,
    };
    const running = execution({
      state: "definition_review",
      workflow_execution_id: null,
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: [],
        exclusionDispositions: [],
      }),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [running],
        findGateAdmissionsBySpecId: () => [admission],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const detail = specDetailViewSchema.parse(body);
    expect(detail.executions).toEqual([
      {
        id: "execution-1",
        specId: spec.id,
        revisionId: revision.id,
        revisionNumber: revision.number,
        // The immutable source and lane link make a parked run diagnosable.
        state: "definition_review",
        workflowSeedSource: {
          kind: "spec_delivery",
          specSlug: "native-sdd",
          candidateId: "launch-1",
        },
        workflowExecutionId: null,
        scope: {
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: [],
          exclusionDispositions: [],
        },
        sessionName: "session-1",
        deliveredAt: revision.createdAt,
        abandonedReason: null,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
        deliveryProjection: [],
      },
    ]);
    expect(detail.gateAdmissions).toEqual([
      {
        id: "admission-1",
        specId: spec.id,
        gate: "execution_start",
        basis: "notify_policy",
        approvalId: null,
        revisionId: revision.id,
        revisionNumber: revision.number,
        executionId: "execution-1",
        actor: { kind: "agent", conversationId: "conv-1" },
        createdAt: revision.createdAt,
      },
    ]);
  });

  it("reports an unparseable execution scope as absent rather than as an empty scope", async () => {
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [execution({ scope_json: "not json" })],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.executions[0]?.scope).toBeNull();
    expect(detail.executions[0]?.state).toBe("delivered");
  });

  it("projects per-criterion delivery outcomes without a modality checklist", async () => {
    const olderRevision: SpecRevision = {
      ...revision,
      id: "revision-0",
      number: 1,
      state: "approved",
      contentHash: "revision-0-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const pinnedRevision: SpecRevision = {
      ...revision,
      id: "revision-1",
      number: 2,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const criterion = (id: string, number: number, revisionId: string) => ({
      element: {
        id,
        specId: spec.id,
        kind: "criterion" as const,
        number,
        parentElementId: "requirement-1",
        createdAt: revision.createdAt,
      },
      version: {
        revisionId,
        elementId: id,
        position: number,
        payload: {
          kind: "criterion" as const,
          text: `Criterion ${number} holds`,
          validationStrategy: { kinds: ["test_run" as const] },
        },
        payloadHash: `${id}-hash`,
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    });
    const requirementFor = (revisionId: string) => ({
      ...snapshot.elements[0]!,
      version: { ...snapshot.elements[0]!.version, revisionId },
    });
    const pinnedSnapshot: SpecRevisionSnapshot = {
      revision: pinnedRevision,
      elements: [
        requirementFor(pinnedRevision.id),
        criterion("criterion-1", 1, pinnedRevision.id),
        criterion("criterion-2", 2, pinnedRevision.id),
        criterion("criterion-3", 3, pinnedRevision.id),
        criterion("criterion-4", 4, pinnedRevision.id),
        criterion("criterion-7", 7, pinnedRevision.id),
      ],
    };
    const olderSnapshot: SpecRevisionSnapshot = {
      revision: olderRevision,
      elements: [
        requirementFor(olderRevision.id),
        criterion("criterion-5", 5, olderRevision.id),
        criterion("criterion-6", 6, olderRevision.id),
        criterion("criterion-7", 7, olderRevision.id),
      ],
    };
    const deliveredExecution = execution({
      id: "execution-prior",
      revision_id: olderRevision.id,
      state: "delivered",
      scope_json: JSON.stringify({
        selectedTaskIds: [],
        selectedCriterionIds: ["criterion-5", "criterion-6", "criterion-7"],
        exclusionDispositions: [],
      }),
      created_at: "2026-07-17T00:00:00.000Z",
      delivered_at: "2026-07-17T12:00:00.000Z",
      workflow_execution_id: "workflow-execution-prior",
    });
    const runningExecution = execution({
      id: "execution-running",
      revision_id: pinnedRevision.id,
      state: "running",
      scope_json: JSON.stringify({
        selectedTaskIds: [],
        selectedCriterionIds: [
          "criterion-1",
          "criterion-2",
          "criterion-3",
          "criterion-4",
          "criterion-7",
        ],
        exclusionDispositions: [],
      }),
      created_at: "2026-07-18T00:00:00.000Z",
      delivered_at: null,
      workflow_execution_id: "workflow-execution-running",
    });
    const deliveryVerdict = (
      execution: SpecExecutionRow,
      criterionElementId: string,
    ): SpecDeliveryVerdictRow => ({
      id: `delivery-verdict-${execution.id}-${criterionElementId}`,
      spec_execution_id: execution.id,
      workflow_execution_id: execution.workflow_execution_id!,
      candidate_id: `candidate-${execution.id}`,
      candidate_hash: `sha256:${"a".repeat(64)}`,
      criterion_element_id: criterionElementId,
      satisfying_context_id: `context-${criterionElementId}`,
      verdict_at: revision.createdAt,
    });
    const verdict = (
      id: string,
      criterionElementId: string,
      evidenceIds: string[],
      staleAt: string | null,
    ): SpecProofVerdictRow => ({
      id,
      spec_id: spec.id,
      criterion_element_id: criterionElementId,
      revision_id: pinnedRevision.id,
      execution_id: runningExecution.id,
      verdict_kind: "deterministic_validator",
      evidence_ids_json: JSON.stringify(evidenceIds),
      verdict_at: revision.createdAt,
      stale_at: staleAt,
      stale_reason: staleAt === null ? null : "superseded",
    });
    const evidenceRow: SpecEvidenceRow = {
      id: "evidence-1",
      spec_id: spec.id,
      criterion_element_id: "criterion-1",
      revision_id: pinnedRevision.id,
      kind: "test_run",
      ref_json: JSON.stringify({
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-1",
        eventId: 7,
        contextId: "validation",
      }),
      evaluated_state_json: JSON.stringify({ relevantPaths: [] }),
      producer_json: JSON.stringify({ kind: "agent" }),
      execution_id: runningExecution.id,
      source_event_id: 7,
      created_at: revision.createdAt,
    };
    const olderWaiver: SpecWaiverRow = {
      id: "waiver-older",
      spec_id: spec.id,
      criterion_element_id: "criterion-5",
      revision_id: olderRevision.id,
      reason: "Alex accepted the bounded risk.",
      waived_at: revision.createdAt,
      stale: 0,
    };
    // Studio grants can be accepted during a run without rewriting its frozen
    // in-scope disposition, so the projection resolves the current waiver.
    const grantOnlyWaiver: SpecWaiverRow = {
      id: "waiver-grant-only",
      spec_id: spec.id,
      criterion_element_id: "criterion-2",
      revision_id: pinnedRevision.id,
      reason: "Granted in Studio but not applied to the run.",
      waived_at: revision.createdAt,
      stale: 0,
    };
    const dispositionRow = (
      executionId: string,
      criterionElementId: string,
      disposition: SpecCriterionDispositionRow["disposition"],
      overrides: Partial<SpecCriterionDispositionRow> = {},
    ): SpecCriterionDispositionRow => ({
      execution_id: executionId,
      criterion_element_id: criterionElementId,
      disposition,
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: revision.createdAt,
      updated_at: revision.createdAt,
      ...overrides,
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [olderRevision, pinnedRevision],
        getRevisionSnapshot: async (revisionId) => {
          if (revisionId === pinnedRevision.id) return pinnedSnapshot;
          if (revisionId === olderRevision.id) return olderSnapshot;
          return null;
        },
        findExecutionsBySpecId: () => [deliveredExecution, runningExecution],
        findCriterionDispositionsByExecution: (executionId) => {
          if (executionId === deliveredExecution.id) {
            return [
              dispositionRow(deliveredExecution.id, "criterion-5", "waived", {
                waiver_id: olderWaiver.id,
              }),
              dispositionRow(deliveredExecution.id, "criterion-6", "in_scope"),
              dispositionRow(deliveredExecution.id, "criterion-7", "in_scope", {
                delivered_by_execution_id: deliveredExecution.id,
              }),
            ];
          }
          if (executionId === runningExecution.id) {
            return [
              dispositionRow(runningExecution.id, "criterion-1", "in_scope"),
              dispositionRow(
                runningExecution.id,
                "criterion-7",
                "delivered_elsewhere",
                { delivered_by_execution_id: deliveredExecution.id },
              ),
            ];
          }
          return [];
        },
        findProofVerdictsByCriterionRevision: (criterionId, revisionId) => {
          if (revisionId !== pinnedRevision.id) return [];
          if (criterionId === "criterion-1") {
            return [
              verdict("verdict-fresh", "criterion-1", ["evidence-1"], null),
            ];
          }
          if (criterionId === "criterion-2") {
            return [
              verdict(
                "verdict-stale",
                "criterion-2",
                ["evidence-1"],
                revision.createdAt,
              ),
            ];
          }
          if (criterionId === "criterion-3") {
            return [
              verdict(
                "verdict-dangling",
                "criterion-3",
                ["evidence-gone"],
                null,
              ),
            ];
          }
          // criterion-4's only verdict lives on a different revision, so the
          // pinned-revision lookup returns nothing for it.
          return [];
        },
        findEvidenceByCriterionRevision: (criterionId, revisionId) =>
          criterionId === "criterion-1" && revisionId === pinnedRevision.id
            ? [evidenceRow]
            : [],
        findDeliveryVerdictsBySpecExecutionId: (executionId) => {
          if (executionId === runningExecution.id) {
            return [deliveryVerdict(runningExecution, "criterion-1")];
          }
          if (executionId === deliveredExecution.id) {
            return [
              deliveryVerdict(deliveredExecution, "criterion-6"),
              deliveryVerdict(deliveredExecution, "criterion-7"),
            ];
          }
          return [];
        },
        findExecutionBindingBySpecExecutionId: (executionId) => {
          const linkedExecution = [deliveredExecution, runningExecution].find(
            (candidate) => candidate.id === executionId,
          );
          if (
            linkedExecution?.workflow_execution_id === null ||
            linkedExecution === undefined
          ) {
            return null;
          }
          return {
            specExecutionId: linkedExecution.id,
            workflowExecutionId: linkedExecution.workflow_execution_id,
            binding: {
              schemaVersion: 2,
              candidateId: `candidate-${linkedExecution.id}`,
              candidateHash: `sha256:${"a".repeat(64)}`,
              pinnedRevisionId: linkedExecution.revision_id,
              dispositions: [],
              claims: [],
            },
            createdAt: revision.createdAt,
          };
        },
        findWaiverForCriterionRevision: (criterionId, revisionId) => {
          if (criterionId === "criterion-5" && revisionId === olderRevision.id)
            return olderWaiver;
          if (criterionId === "criterion-2" && revisionId === pinnedRevision.id)
            return grantOnlyWaiver;
          return null;
        },
        findWaiverById: (waiverId) => {
          if (waiverId === olderWaiver.id) return olderWaiver;
          if (waiverId === grantOnlyWaiver.id) return grantOnlyWaiver;
          return null;
        },
        findWaiversByRevision: (revisionId) =>
          revisionId === olderRevision.id ? [olderWaiver] : [],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    const byId = new Map(detail.executions.map((run) => [run.id, run]));
    expect(
      detail.executions
        .flatMap((run) => run.deliveryProjection)
        .every((projection) => !("guidanceKinds" in projection)),
    ).toBe(true);
    expect(
      byId
        .get(runningExecution.id)
        ?.deliveryProjection.map(
          ({ criterionElementId, handle, deliveryState, verdict }) => [
            criterionElementId,
            handle,
            deliveryState,
            verdict?.satisfying_context_id ?? null,
          ],
        ),
    ).toEqual([
      ["criterion-1", "R1.1", "verdict_recorded", "context-criterion-1"],
      ["criterion-2", "R1.2", "waived", null],
      ["criterion-3", "R1.3", "awaiting_outcome", null],
      ["criterion-4", "R1.4", "awaiting_outcome", null],
      ["criterion-7", "R1.7", "delivered_elsewhere", null],
    ]);
    // Waiver precedence beats the delivered state; delivered in-scope criteria
    // project as delivered.
    expect(
      byId
        .get(deliveredExecution.id)
        ?.deliveryProjection.map(({ criterionElementId, deliveryState }) => [
          criterionElementId,
          deliveryState,
        ]),
    ).toEqual([
      ["criterion-5", "waived"],
      ["criterion-6", "delivered"],
      ["criterion-7", "delivered"],
    ]);
    // The older pinned revision's waiver is visible to Studio even though the
    // proof snapshot is the newer approved revision.
    expect(detail.waivers.map((waiver) => waiver.id)).toContain(olderWaiver.id);
  });

  it("dedupes a persisted duplicate scope so one criterion cannot project as two rows", async () => {
    // Older writes could persist duplicate ids (the scope schema accepted
    // them); the read boundary canonicalizes, otherwise Studio counts two
    // projection rows against a Set-derived denominator of one ("2/1").
    const duplicatedScope = execution({
      state: "running",
      delivered_at: null,
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1", "task-1"],
        selectedCriterionIds: ["criterion-1", "criterion-1"],
        exclusionDispositions: [],
      }),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [duplicatedScope],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.executions[0]?.scope).toEqual({
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [],
    });
    expect(
      detail.executions[0]?.deliveryProjection.map(
        ({ criterionElementId, deliveryState }) => [
          criterionElementId,
          deliveryState,
        ],
      ),
    ).toEqual([["criterion-1", "awaiting_outcome"]]);
  });

  it("does not project a Studio verdict from a different candidate", async () => {
    const running = execution({
      state: "running",
      delivered_at: null,
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [],
      }),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [running],
        findCriterionDispositionsByExecution: () => [
          {
            execution_id: running.id,
            criterion_element_id: "criterion-1",
            disposition: "in_scope",
            waiver_id: null,
            delivered_by_execution_id: null,
            created_at: revision.createdAt,
            updated_at: revision.createdAt,
          },
        ],
        findDeliveryVerdictsBySpecExecutionId: () => [
          {
            id: "delivery-verdict-other-candidate",
            spec_execution_id: running.id,
            workflow_execution_id: running.workflow_execution_id!,
            candidate_id: "candidate-other",
            candidate_hash: `sha256:${"b".repeat(64)}`,
            criterion_element_id: "criterion-1",
            satisfying_context_id: "stable-claimant",
            verdict_at: revision.createdAt,
          },
        ],
        findExecutionBindingBySpecExecutionId: () => ({
          specExecutionId: running.id,
          workflowExecutionId: running.workflow_execution_id!,
          binding: {
            schemaVersion: 2,
            candidateId: "candidate-current",
            candidateHash: `sha256:${"a".repeat(64)}`,
            pinnedRevisionId: running.revision_id,
            dispositions: [],
            claims: [],
          },
          createdAt: revision.createdAt,
        }),
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.executions[0]?.deliveryProjection).toMatchObject([
      {
        criterionElementId: "criterion-1",
        deliveryState: "awaiting_outcome",
        verdict: null,
      },
    ]);
  });

  it("projects every live proposal with its supersession verdict and the snapshots its diff needs", async () => {
    // Ticket #50's shape: revision 3 was approved from revision 1's content,
    // forking past the still-proposed revision 2. The lineage head is
    // approved, so a surface keyed off the newest revision alone reports
    // nothing awaiting review while revision 2 sits stranded.
    const approvedBase: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const stranded: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: approvedBase.id,
      contentHash: "revision-2-hash",
      proposedAt: "2026-07-18T02:00:00.000Z",
    };
    const forkedPast: SpecRevision = {
      ...revision,
      id: "revision-3",
      number: 3,
      state: "approved",
      basedOnRevisionId: approvedBase.id,
      contentHash: "revision-3-hash",
      proposedAt: "2026-07-18T03:00:00.000Z",
      approvedAt: "2026-07-18T03:30:00.000Z",
    };
    const snapshotFor = (target: SpecRevision): SpecRevisionSnapshot => ({
      revision: target,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: target.id },
      })),
    });
    const snapshotsById = new Map(
      [approvedBase, stranded, forkedPast].map((target) => [
        target.id,
        snapshotFor(target),
      ]),
    );
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedBase, stranded, forkedPast],
        getRevisionSnapshot: async (revisionId) =>
          snapshotsById.get(revisionId) ?? null,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.currentRevision?.revision.id).toBe(forkedPast.id);
    expect(
      detail.liveProposals.map((entry) => [
        entry.revision.id,
        entry.supersededBy?.id ?? null,
        entry.snapshot.revision.id,
        entry.baseSnapshot?.revision.id ?? null,
      ]),
    ).toEqual([[stranded.id, forkedPast.id, stranded.id, approvedBase.id]]);
  });

  /**
   * The review surface exposes each proposal's disposition document read-only,
   * on the same projection entry that carries its supersession verdict — a
   * stranded proposal's notes are exactly what a human needs to decide whether
   * to dismiss it, so they cannot be reachable only for the current one.
   */
  it("exposes each live proposal's notes from its own propose event", async () => {
    const approvedBase: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const stranded: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      state: "proposed",
      basedOnRevisionId: approvedBase.id,
      contentHash: "revision-2-hash",
      proposedAt: "2026-07-18T02:00:00.000Z",
    };
    const forkedPast: SpecRevision = {
      ...revision,
      id: "revision-3",
      number: 3,
      state: "approved",
      basedOnRevisionId: approvedBase.id,
      contentHash: "revision-3-hash",
      proposedAt: "2026-07-18T03:00:00.000Z",
      approvedAt: "2026-07-18T03:30:00.000Z",
    };
    const snapshotsById = new Map(
      [approvedBase, stranded, forkedPast].map((target) => [
        target.id,
        {
          revision: target,
          elements: snapshot.elements.map((entry) => ({
            ...entry,
            version: { ...entry.version, revisionId: target.id },
          })),
        } satisfies SpecRevisionSnapshot,
      ]),
    );
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedBase, stranded, forkedPast],
        getRevisionSnapshot: async (revisionId) =>
          snapshotsById.get(revisionId) ?? null,
        findEventsBySpecId: () => [
          {
            id: 1,
            spec_id: spec.id,
            occurred_at: "2026-07-18T02:00:00.000Z",
            event_type: "spec-revision-changed",
            actor_json: JSON.stringify({
              kind: "agent",
              conversationId: "conversation-1",
            }),
            payload_json: JSON.stringify({
              kind: "proposed",
              revisionId: stranded.id,
              notes: "## Disposition\n\nRewrote R1 after the reviewer's F3.",
            }),
          },
        ],
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.liveProposals.map((entry) => entry.notes)).toEqual([
      "## Disposition\n\nRewrote R1 after the reviewer's F3.",
    ]);
  });

  it("answers the edit context a write needs without transferring the spec", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecEditContextGET(
      new Request("http://cc.test/api/specs/demo/current-slug/edit-context"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = specEditContextViewSchema.parse(await response.json());
    expect(body).toEqual({
      specId: spec.id,
      slug: spec.slug,
      name: spec.name,
      gatePolicy: spec.gatePolicy,
      currentRevision: {
        id: revision.id,
        number: revision.number,
        state: "draft",
        authoringStage: "plan",
      },
      latestApprovedRevision: null,
      element: null,
    });
    // The whole point of the read: none of the payloads a write never uses.
    expect(Object.keys(body)).not.toContain("elements");
    expect(Object.keys(body)).not.toContain("comments");
  });

  it("resolves the target element version so a write can supply baseElementVersion", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const byHandle = await handlers.getSpecEditContextGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/edit-context?element=R1",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const byId = await handlers.getSpecEditContextGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/edit-context?element=criterion-1",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(
      specEditContextViewSchema.parse(await byHandle.json()).element,
    ).toEqual({
      elementId: "requirement-1",
      handle: "R1",
      kind: "requirement",
      elementVersion: 1,
      position: 0,
    });
    expect(specEditContextViewSchema.parse(await byId.json()).element).toEqual({
      elementId: "criterion-1",
      handle: "R1.1",
      kind: "criterion",
      elementVersion: 1,
      position: 1,
    });
  });

  it("projects a v2-only delivered criterion as proven in the live outline", async () => {
    const delivered = execution();
    const deliveryVerdict: SpecDeliveryVerdictRow = {
      id: "delivery-verdict-current",
      spec_execution_id: delivered.id,
      workflow_execution_id: delivered.workflow_execution_id!,
      candidate_id: "candidate-current",
      candidate_hash: `sha256:${"a".repeat(64)}`,
      criterion_element_id: "criterion-1",
      satisfying_context_id: "stable-claimant",
      verdict_at: revision.createdAt,
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [delivered],
        findDeliveryVerdictsBySpecExecutionId: () => [deliveryVerdict],
        findExecutionBindingBySpecExecutionId: () => ({
          specExecutionId: delivered.id,
          workflowExecutionId: delivered.workflow_execution_id!,
          binding: {
            schemaVersion: 2,
            candidateId: deliveryVerdict.candidate_id,
            candidateHash: deliveryVerdict.candidate_hash,
            pinnedRevisionId: delivered.revision_id,
            dispositions: [],
            claims: [],
          },
          createdAt: revision.createdAt,
        }),
      }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = specShowOutlineViewSchema.parse(await response.json());
    expect(body.requirements[0]?.criteria[0]?.status.proof).toBe("proven");
  });

  it("reports the latest approved revision so an execution can pin it", async () => {
    const approved: SpecRevision = {
      ...revision,
      id: "revision-approved",
      number: 1,
      state: "approved",
      approvedAt: revision.createdAt,
    };
    const draft: SpecRevision = { ...revision, id: "revision-2", number: 2 };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approved, draft],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === draft.id ? { ...snapshot, revision: draft } : null,
      }),
    );

    const response = await handlers.getSpecEditContextGET(
      new Request("http://cc.test/api/specs/demo/current-slug/edit-context"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const body = specEditContextViewSchema.parse(await response.json());
    expect(body.currentRevision?.id).toBe(draft.id);
    expect(body.latestApprovedRevision).toEqual({
      id: approved.id,
      number: approved.number,
    });
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

  it("names the real handle when an element id is addressed as a handle", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/requirement-1",
      ),
      routeContext({
        name: "demo",
        slug: spec.slug,
        element: "requirement-1",
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("is an element id"),
      code: "invalid_handle",
      details: { handle: "requirement-1", elementHandle: "R1" },
    });
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
      comments: [
        { id: oldComment.id, revisionId: withdrawnRevision.id },
        { id: currentComment.id, revisionId: draftRevision.id },
      ],
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

  it("projects requirement proof and each task's graph work status", async () => {
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
        tasks: [{ elementId: "task-1", status: { status: "pending" } }],
      },
    });
  });

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
    // Carried-forward approvals leave nothing outstanding, and the
    // execution-scoped gates list nothing before a run exists.
    await expect(response.json()).resolves.toMatchObject({
      pendingApprovals: [],
    });
  });

  /**
   * An approval names the revision whose content a human read. Status must
   * keep asking for a subject whose only approval sits on a branch the current
   * revision does not descend from, even when both carry identical content.
   */
  it("keeps a subject pending when its only approval sits outside the current revision's lineage", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      id: "revision-approved",
      state: "approved",
      contentHash: "approved-hash",
      approvedAt: revision.createdAt,
    };
    const abandonedRevision: SpecRevision = {
      ...revision,
      id: "revision-abandoned",
      number: 2,
      state: "withdrawn",
      basedOnRevisionId: approvedRevision.id,
      contentHash: "abandoned-hash",
    };
    const proposedRevision: SpecRevision = {
      ...revision,
      id: "revision-proposed",
      number: 3,
      state: "proposed",
      // The requirements gate is the current stage's own gate here, so the
      // only question the assertion asks is whose approval satisfies it.
      authoringStage: "requirements",
      basedOnRevisionId: approvedRevision.id,
      contentHash: "proposed-hash",
      proposedAt: revision.createdAt,
    };
    const snapshotOf = (target: SpecRevision): SpecRevisionSnapshot => ({
      revision: target,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: target.id },
      })),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [
          approvedRevision,
          abandonedRevision,
          proposedRevision,
        ],
        getRevisionSnapshot: async (revisionId) =>
          snapshotOf(
            [approvedRevision, abandonedRevision, proposedRevision].find(
              (candidate) => candidate.id === revisionId,
            ) ?? revision,
          ),
        findApprovalsBySpecId: () => [
          {
            id: "approval-requirement-abandoned",
            spec_id: spec.id,
            subject_kind: "requirement",
            element_id: "requirement-1",
            revision_id: abandonedRevision.id,
            approver: "alex",
            granted_at: revision.createdAt,
            validity: "valid",
          },
        ],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      pendingApprovals: expect.arrayContaining([
        { gate: "requirements", subject: "R1", elementId: "requirement-1" },
      ]),
    });
  });

  it("lists the execution-scoped approvals exactly while a run can receive them", async () => {
    const parked = execution({
      state: "definition_review",
      workflow_execution_id: "workflow-execution-1",
      delivered_at: null,
    });
    const running = execution({
      state: "running",
      delivered_at: null,
    });
    const statusFor = async (rows: SpecExecutionRow[]) => {
      const handlers = createSpecRouteHandlers(
        createDeps({ findExecutionsBySpecId: () => rows }),
      );
      const response = await handlers.getSpecStatusGET(
        new Request("http://cc.test/api/specs/demo/current-slug/status"),
        routeContext({ name: "demo", slug: spec.slug }),
      );
      expect(response.status).toBe(200);
      const body = specStatusViewSchema.parse(await response.json());
      return body.pendingApprovals.filter((pending) =>
        ["execution_start", "delivery"].includes(pending.gate),
      );
    };

    // Parked awaiting definition approval: both human acts exist.
    await expect(statusFor([parked])).resolves.toEqual([
      { gate: "execution_start", subject: "execution_start", elementId: null },
      { gate: "delivery", subject: "delivery", elementId: null },
    ]);
    // Running: the start already happened; only delivery can be granted.
    await expect(statusFor([running])).resolves.toEqual([
      { gate: "delivery", subject: "delivery", elementId: null },
    ]);
    // No run at all: neither gate has anything a human could approve.
    await expect(statusFor([])).resolves.toEqual([]);
  });

  /**
   * The contradiction ticket #42 reported: status read subject approvals from
   * a consulted-filtered source and gate state from an admission-only source,
   * so it could answer "pending approvals: none" beside a pending gate with no
   * act named anywhere. Sign-off is the missing item, and it is its own.
   */
  it("names the outstanding revision sign-off once every consulted subject is approved", async () => {
    const proposed: SpecRevision = {
      ...revision,
      state: "proposed",
      proposedAt: "2026-07-18T01:00:00.000Z",
    };
    const approvals: SpecApprovalRow[] = [
      {
        id: "approval-requirement",
        spec_id: spec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: proposed.id,
        approver: "alex",
        validity: "valid",
        granted_at: "2026-07-18T02:00:00.000Z",
      },
      {
        id: "approval-decision",
        spec_id: spec.id,
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: proposed.id,
        approver: "alex",
        validity: "valid",
        granted_at: "2026-07-18T02:00:00.000Z",
      },
      {
        id: "approval-plan",
        spec_id: spec.id,
        subject_kind: "plan",
        element_id: null,
        revision_id: proposed.id,
        approver: "alex",
        validity: "valid",
        granted_at: "2026-07-18T02:00:00.000Z",
      },
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [proposed],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === proposed.id
            ? { ...snapshot, revision: proposed }
            : null,
        findApprovalsBySpecId: () => approvals,
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.pendingApprovals).toEqual([]);
    // Every consulted gate still reads pending: sign-off is never a side
    // effect of approving the last element.
    expect(
      status.gates
        .filter(
          (gate) =>
            gate.state === "pending" &&
            status.applicableGates.includes(gate.gate),
        )
        .map((gate) => gate.gate),
    ).toEqual(["requirements", "design", "plan"]);
    expect(status.revisionSignOff).toMatchObject({
      revisionId: proposed.id,
      revisionNumber: proposed.number,
      state: "ready",
      outstandingSubjectCount: 0,
      unmetConditions: [],
    });
    expect(status.nextAction?.kind).toBe("sign_off_revision");
    expect(status.pendingBlock?.signOff?.state).toBe("ready");
    expect(status.pendingBlock?.display).toContain("sign-off");
  });

  it("reads an earlier gate unchanged since the governance base as not required, with its admission as history", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      state: "approved",
      authoringStage: "requirements",
      contentHash: "revision-1-hash",
      approvedAt: revision.createdAt,
      externalDelivery: null,
    };
    const amendment: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: approvedRevision.id,
    };
    const priorAdmission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "requirements",
      basis: "human_approval",
      approval_id: "approval-1",
      revision_id: approvedRevision.id,
      execution_id: null,
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-07-18T02:00:00.000Z",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, amendment],
        // Identical element content on both revisions: the amendment changed
        // nothing the requirements gate governs.
        getRevisionSnapshot: async (revisionId) => ({
          revision: revisionId === amendment.id ? amendment : approvedRevision,
          elements: snapshot.elements,
        }),
        findGateAdmissionsBySpecId: () => [priorAdmission],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    const requirements = status.gates.find(
      (gate) => gate.gate === "requirements",
    );
    expect(requirements?.state).toBe("not_required");
    expect(requirements?.applicability).toEqual({
      reason: "unchanged_since_governance_base",
      governanceBaseRevisionId: approvedRevision.id,
    });
    expect(status.applicableGates).toEqual(["plan"]);
    // Requirement 24.13: the earlier admission is provenance, never current
    // satisfaction, so it stays out of `currentAdmissions` and out of `state`.
    expect(requirements?.currentAdmissions).toEqual([]);
    expect(requirements?.priorAdmissions).toEqual([
      {
        revisionId: approvedRevision.id,
        revisionNumber: 1,
        executionId: null,
        basis: "human_approval",
        actor: { kind: "human" },
        admittedAt: "2026-07-18T02:00:00.000Z",
      },
    ]);
  });

  /**
   * R12: the compiler reads executionLane to decide lane placement, so a plan
   * status that omits it hides the mapping from the author who has to audit it.
   */
  it("carries the authored execution lane into the plan status", async () => {
    const lanedSnapshot: SpecRevisionSnapshot = {
      revision,
      elements: snapshot.elements.map((row) =>
        row.element.id === "task-1" && row.version.payload.kind === "task"
          ? {
              ...row,
              version: {
                ...row.version,
                payload: {
                  ...row.version.payload,
                  executionLane: "read-surface",
                  touchedPaths: ["src/lib/specs"],
                },
              },
            }
          : row,
      ),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({ getRevisionSnapshot: async () => lanedSnapshot }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.taskPlan).toEqual([
      expect.objectContaining({
        handle: "T1",
        executionLane: "read-surface",
        touchedPaths: ["src/lib/specs"],
      }),
    ]);
  });

  /**
   * A criterion id a task covers but the current revision does not carry is
   * the visible signature of an amendment that forked past its own content
   * (ticket #42). Rendering it beside real handles and dropping it from both
   * sides of the coverage ratio is what made that incident invisible: the plan
   * reads as fully covered while a criterion it claims is not in the spec.
   */
  it("names the covered criterion ids the current revision does not carry", async () => {
    const forkedTaskSnapshot: SpecRevisionSnapshot = {
      revision,
      elements: snapshot.elements.map((row) =>
        row.element.id === "task-1" && row.version.payload.kind === "task"
          ? {
              ...row,
              version: {
                ...row.version,
                payload: {
                  ...row.version.payload,
                  coveredCriterionElementIds: [
                    "criterion-orphaned-2",
                    "criterion-1",
                    "criterion-orphaned-1",
                  ],
                },
              },
            }
          : row,
      ),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({ getRevisionSnapshot: async () => forkedTaskSnapshot }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.taskPlan).toEqual([
      expect.objectContaining({
        handle: "T1",
        // Only the ids this revision actually resolves are reported as
        // coverage, and none of them is an invented handle.
        criterionCoverage: ["R1.1"],
        unresolvedCriterionElementIds: [
          "criterion-orphaned-1",
          "criterion-orphaned-2",
        ],
      }),
    ]);
    // The ratio is over the criteria this revision carries, so the orphaned
    // ids inflate neither side of it.
    expect(status.coverage).toEqual({
      coveredCriteria: 1,
      totalCriteria: 1,
      percentage: 100,
    });
  });

  /**
   * A dependency on a task the amendment dropped has the same fork signature
   * as an orphaned criterion, and a raw id sitting in the handle-typed field
   * reads as ordering the compiler can honour.
   */
  it("names the depended-on task ids the current revision does not carry", async () => {
    const forkedTaskSnapshot: SpecRevisionSnapshot = {
      revision,
      elements: snapshot.elements.map((row) =>
        row.element.id === "task-1" && row.version.payload.kind === "task"
          ? {
              ...row,
              version: {
                ...row.version,
                payload: {
                  ...row.version.payload,
                  dependsOnTaskElementIds: [
                    "task-orphaned-2",
                    "task-orphaned-1",
                  ],
                },
              },
            }
          : row,
      ),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({ getRevisionSnapshot: async () => forkedTaskSnapshot }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.taskPlan).toEqual([
      expect.objectContaining({
        handle: "T1",
        dependsOn: [],
        unresolvedDependsOnTaskElementIds: [
          "task-orphaned-1",
          "task-orphaned-2",
        ],
      }),
    ]);
  });

  it("keeps a gate pending on the current revision while naming its earlier admission", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      approvedAt: revision.createdAt,
    };
    const amendment: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: approvedRevision.id,
    };
    const priorAdmission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "requirements",
      basis: "human_approval",
      approval_id: "approval-1",
      revision_id: approvedRevision.id,
      execution_id: null,
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-07-18T02:00:00.000Z",
    };
    const [requirementRow, ...otherRows] = snapshot.elements;
    if (requirementRow === undefined) {
      throw new Error("the fixture snapshot carries no elements");
    }
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, amendment],
        // The amendment restates the requirement, so the requirements gate is
        // consulted again and its earlier admission covers other content.
        getRevisionSnapshot: async (revisionId) =>
          revisionId === amendment.id
            ? { revision: amendment, elements: snapshot.elements }
            : {
                revision: approvedRevision,
                elements: [
                  {
                    element: requirementRow.element,
                    version: {
                      ...requirementRow.version,
                      payloadHash: "requirement-hash-v1",
                    },
                  },
                  ...otherRows,
                ],
              },
        findGateAdmissionsBySpecId: () => [priorAdmission],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const status = specStatusViewSchema.parse(await response.json());
    expect(status.gates.find((gate) => gate.gate === "requirements")).toEqual({
      gate: "requirements",
      dial: "gate",
      state: "pending",
      applicability: {
        reason: "changed_since_governance_base",
        governanceBaseRevisionId: approvedRevision.id,
      },
      currentAdmissions: [],
      priorAdmissions: [
        {
          revisionId: approvedRevision.id,
          revisionNumber: 1,
          executionId: null,
          basis: "human_approval",
          actor: { kind: "human" },
          admittedAt: "2026-07-18T02:00:00.000Z",
        },
      ],
    });
    // History must never be read as satisfaction: nothing here establishes
    // that revision 2 left the governed content unchanged.
    expect(status.gates.every((gate) => gate.state !== "admitted")).toBe(true);
  });

  it("attributes an execution-scoped gate's history to the run that was admitted", async () => {
    const priorExecution = execution({
      id: "execution-0",
      state: "abandoned",
      created_at: "2026-07-17T00:00:00.000Z",
    });
    const activeExecution = execution({ id: "execution-1", state: "running" });
    const priorAdmission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "execution_start",
      basis: "human_approval",
      approval_id: "approval-1",
      revision_id: revision.id,
      execution_id: priorExecution.id,
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-07-17T01:00:00.000Z",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [priorExecution, activeExecution],
        findGateAdmissionsBySpecId: () => [priorAdmission],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    const gate = status.gates.find(
      (candidate) => candidate.gate === "execution_start",
    );
    // The running run is past the position that could receive an
    // execution-start approval, so the gate asks for nothing now; the older
    // run's admission stays visible as history and admits nothing.
    expect(gate?.state).toBe("not_required");
    expect(gate?.currentAdmissions).toEqual([]);
    expect(gate?.priorAdmissions).toEqual([
      {
        revisionId: revision.id,
        revisionNumber: 1,
        executionId: priorExecution.id,
        basis: "human_approval",
        actor: { kind: "human" },
        admittedAt: "2026-07-17T01:00:00.000Z",
      },
    ]);
  });

  it("does not repeat the current revision's own admission as history", async () => {
    const admission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "requirements",
      basis: "notify_policy",
      approval_id: null,
      revision_id: revision.id,
      execution_id: null,
      actor_json: JSON.stringify({ kind: "system" }),
      created_at: "2026-07-18T02:00:00.000Z",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({ findGateAdmissionsBySpecId: () => [admission] }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.gates.find((gate) => gate.gate === "requirements")).toEqual({
      gate: "requirements",
      dial: "gate",
      state: "admitted",
      applicability: {
        reason: "changed_since_governance_base",
        governanceBaseRevisionId: null,
      },
      // The admission belongs to the revision being read, so it explains the
      // current state instead of standing beside it as history.
      currentAdmissions: [
        {
          revisionId: revision.id,
          revisionNumber: 1,
          executionId: null,
          basis: "notify_policy",
          // The stored provenance is not a shape the actor schema admits, and
          // one unreadable record degrades to null rather than failing a read.
          actor: null,
          admittedAt: "2026-07-18T02:00:00.000Z",
        },
      ],
      priorAdmissions: [],
    });
    expect(
      status.gates.find((gate) => gate.gate === "delivery")?.priorAdmissions,
    ).toEqual([]);
  });

  it("reports reconciled execution state on the status projection", async () => {
    const stale = execution({
      id: "execution-stale",
      state: "definition_review",
      workflow_execution_id: null,
      delivered_at: null,
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [stale],
        reconcileExecution: async (_projectPath, candidate) => ({
          execution: {
            ...candidate,
            state: "running",
            workflow_execution_id: "workflow-execution-reconciled",
          },
          workflowStatus: "running",
        }),
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.executions).toEqual([
      {
        id: "execution-stale",
        state: "running",
        workflowSeedSource: {
          kind: "spec_delivery",
          specSlug: "native-sdd",
          candidateId: "launch-1",
        },
        workflowExecutionId: "workflow-execution-reconciled",
        workflowStatus: "running",
      },
    ]);
  });

  it("does not project a saved-definition seed as a native SDD execution source", async () => {
    const historic = execution({
      workflow_seed_source_json: JSON.stringify({
        kind: "saved-definition",
        id: "workflow-definition-1",
        revision: 1,
        tier: "project",
      }),
    });
    const handlers = createSpecRouteHandlers(
      createDeps({ findExecutionsBySpecId: () => [historic] }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.executions[0]?.workflowSeedSource).toBeNull();
  });

  it("reports pending approvals only for the current authoring-stage review", async () => {
    const requirementsRevision: SpecRevision = {
      ...revision,
      authoringStage: "requirements",
      state: "proposed",
      proposedAt: revision.createdAt,
      contentHash: "requirements-review-hash",
    };
    const requirementsSnapshot: SpecRevisionSnapshot = {
      revision: requirementsRevision,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: requirementsRevision.id },
      })),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [requirementsRevision],
        getRevisionSnapshot: async () => requirementsSnapshot,
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.phase).toEqual({
      primary: "in_review",
      authoringStage: "requirements",
    });
    expect(body.pendingApprovals).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ]);
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
        deliveredCount: 0,
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
        findGateAdmissionsBySpecId: () => staleAdmissions,
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
    // The new run's definition has not linked its lane yet, so no one can
    // grant its execution start; delivery is grantable for any run that has
    // not ended. Neither reads admitted off the older run's rows.
    expect(
      staleBody.gates.find((gate) => gate.gate === "execution_start"),
    ).toMatchObject({ state: "not_required" });
    expect(
      staleBody.gates.find((gate) => gate.gate === "delivery"),
    ).toMatchObject({ state: "pending" });

    // An admission scoped to the current run reads admitted.
    const scopedHandlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [olderDelivered, newerActive],
        findGateAdmissionsBySpecId: () => [
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
        // The admission row carries the revision it was granted against — the
        // run's pinned revision, not the newer draft.
        findGateAdmissionsBySpecId: () => [startAdmission],
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

  it("reconciles callback-loss lifecycle state before projecting status", async () => {
    const approvedRevision = { ...revision, state: "approved" as const };
    const approvedSnapshot = { ...snapshot, revision: approvedRevision };
    const stored = execution({ state: "running", delivered_at: null });
    const reconciled = execution();
    const deliveredVerdict: SpecDeliveryVerdictRow = {
      id: "delivery-verdict-reconciled",
      spec_execution_id: reconciled.id,
      workflow_execution_id: reconciled.workflow_execution_id!,
      candidate_id: "candidate-reconciled",
      candidate_hash: `sha256:${"a".repeat(64)}`,
      criterion_element_id: "criterion-1",
      satisfying_context_id: "stable-claimant",
      verdict_at: revision.createdAt,
    };
    const reconcileExecution = vi.fn(async () => ({
      execution: reconciled,
      workflowStatus: null,
    }));
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
        findDeliveryVerdictsBySpecExecutionId: () => [deliveredVerdict],
        findExecutionBindingBySpecExecutionId: () => ({
          specExecutionId: reconciled.id,
          workflowExecutionId: reconciled.workflow_execution_id!,
          binding: {
            schemaVersion: 2,
            candidateId: deliveredVerdict.candidate_id,
            candidateHash: deliveredVerdict.candidate_hash,
            pinnedRevisionId: reconciled.revision_id,
            dispositions: [],
            claims: [],
          },
          createdAt: revision.createdAt,
        }),
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

  it("projects persisted evidence and verdicts onto an element read", async () => {
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
    const handlers = createSpecRouteHandlers(
      createDeps({
        findApprovalsBySpecId: () => [planApproval],
        findExecutionsBySpecId: () => [execution()],
        findEvidenceByCriterionRevision: () => [evidence],
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
  });

  it("returns the latest execution's persisted evidence for a criterion", async () => {
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
    const handlers = createSpecRouteHandlers(
      createDeps({
        findExecutionsBySpecId: () => [earlierExecution, laterExecution],
        findEvidenceByCriterionRevision: () => [laterEvidence],
      }),
    );

    const response = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/T1"),
      routeContext({ name: "demo", slug: spec.slug, element: "T1" }),
    );

    expect(response.status).toBe(200);
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

  it("searches every spec in the project and reports each hit's identity, phase, and preset", async () => {
    const otherSpec: Spec = {
      ...spec,
      id: "spec-2",
      slug: "other-slug",
      name: "Other spec",
      gatePolicy: { preset: "fast-path" },
    };
    const otherRevision: SpecRevision = {
      ...revision,
      id: "revision-2",
      specId: otherSpec.id,
      authoringStage: "requirements",
    };
    const otherSnapshot: SpecRevisionSnapshot = {
      revision: otherRevision,
      elements: [
        {
          element: {
            id: "requirement-2",
            specId: otherSpec.id,
            kind: "requirement",
            number: 1,
            parentElementId: null,
            createdAt: revision.createdAt,
          },
          version: {
            revisionId: otherRevision.id,
            elementId: "requirement-2",
            position: 0,
            payload: {
              kind: "requirement",
              statement: "The route resolves competing specs",
              priority: "must",
              risk: "low",
            },
            payloadHash: "requirement-2-hash",
            elementVersion: 1,
            createdAt: revision.createdAt,
            updatedAt: revision.createdAt,
          },
        },
      ],
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listSpecs: async () => [spec, otherSpec],
        listRevisions: async (specId) =>
          specId === otherSpec.id ? [otherRevision] : [revision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === otherRevision.id
            ? otherSnapshot
            : revisionId === revision.id
              ? snapshot
              : null,
      }),
    );

    const response = await handlers.searchProjectSpecsGET(
      new Request("http://cc.test/api/specs/demo/-/search?q=resolves"),
      routeContext({ name: "demo" }),
    );

    expect(response.status).toBe(200);
    const body = specProjectSearchViewSchema.parse(await response.json());
    expect(body.query).toBe("resolves");
    expect(
      body.results.map((hit) => [
        hit.slug,
        hit.name,
        hit.preset,
        hit.matchCount,
      ]),
    ).toEqual([
      [spec.slug, spec.name, "contract-bearing", 1],
      [otherSpec.slug, otherSpec.name, "fast-path", 1],
    ]);
    expect(body.results[1]?.phase).toEqual({
      primary: "draft",
      authoringStage: "requirements",
    });
    expect(body.results[1]?.matches).toEqual([
      {
        handle: "R1",
        kind: "requirement",
        elementId: "requirement-2",
        text: "The route resolves competing specs",
      },
    ]);
  });

  it("matches a spec by slug or name so a competing spec is findable before it has content", async () => {
    const handlers = createSpecRouteHandlers(createDeps());

    const response = await handlers.searchProjectSpecsGET(
      new Request("http://cc.test/api/specs/demo/-/search?q=current-slug"),
      routeContext({ name: "demo" }),
    );

    const body = specProjectSearchViewSchema.parse(await response.json());
    expect(body.results).toEqual([
      expect.objectContaining({
        slug: spec.slug,
        matchedName: true,
        matchCount: 0,
        matches: [],
      }),
    ]);
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
          delivery: {
            allWaived: false,
            deliveredCount: 0,
            provenCount: 0,
            totalInScope: 0,
          },
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

describe("spec comments route handler", () => {
  const openComment: SpecCommentRow = {
    id: "comment-1",
    spec_id: spec.id,
    thread_id: "thread-1",
    parent_comment_id: null,
    element_id: "requirement-1",
    anchor_json: JSON.stringify({
      sectionId: "sec-1",
      headingLabel: "Requirements",
      line: 1,
      charStart: 0,
      charEnd: 12,
      quote: "resolves renamed specs",
      prefix: "",
      suffix: "",
      docRevision: revision.id,
    }),
    revision_id: revision.id,
    body: "Should renames preserve aliases?",
    author_json: JSON.stringify({ kind: "human" }),
    blocking: 1,
    resolution: "open",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  };
  const resolvedComment: SpecCommentRow = {
    ...openComment,
    id: "comment-2",
    thread_id: "thread-2",
    body: "Typo in the statement.",
    blocking: 0,
    resolution: "resolved",
    created_at: "2026-08-12T00:30:00.000Z",
    updated_at: "2026-08-12T01:00:00.000Z",
  };
  const orphanComment: SpecCommentRow = {
    ...openComment,
    id: "comment-3",
    thread_id: "thread-3",
    element_id: "removed-element",
    body: "This element vanished after the comment landed.",
    blocking: 0,
    resolution: "open",
    created_at: "2026-08-12T02:00:00.000Z",
    updated_at: "2026-08-12T02:00:00.000Z",
  };

  function commentDeps() {
    return createDeps({
      findCommentsByRevision: (revisionId) =>
        revisionId === revision.id
          ? [openComment, resolvedComment, orphanComment]
          : [],
    });
  }

  it("returns every comment as a typed view with handles and counts", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const response = await handlers.getSpecCommentsGET(
      new Request("http://cc.test/api/specs/demo/current-slug/comments"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = specCommentsViewSchema.parse(await response.json());
    expect(body.specId).toBe(spec.id);
    expect(body.slug).toBe(spec.slug);
    expect(body.openCount).toBe(2);
    expect(body.openBlockingCount).toBe(1);
    expect(body.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-2",
      "comment-3",
    ]);
    expect(body.comments[0]).toMatchObject({
      handle: "R1",
      revisionNumber: revision.number,
      quote: "resolves renamed specs",
      author: { kind: "human" },
      blocking: true,
      resolution: "open",
      threadId: "thread-1",
    });
    // A comment on an element the current revision no longer carries is still
    // returned — with a null handle, not silently dropped.
    expect(body.comments[2]).toMatchObject({
      handle: null,
      elementId: "removed-element",
    });
  });

  it("filters to open comments without changing the spec-wide counts", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const response = await handlers.getSpecCommentsGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/comments?open=true",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const body = specCommentsViewSchema.parse(await response.json());
    expect(body.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-3",
    ]);
    expect(body.openCount).toBe(2);
    expect(body.openBlockingCount).toBe(1);
  });

  it("filters by element handle and by raw element id", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const byHandle = await handlers.getSpecCommentsGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/comments?element=R1",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const byId = await handlers.getSpecCommentsGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/comments?element=removed-element",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(
      specCommentsViewSchema
        .parse(await byHandle.json())
        .comments.map((comment) => comment.id),
    ).toEqual(["comment-1", "comment-2"]);
    expect(
      specCommentsViewSchema
        .parse(await byId.json())
        .comments.map((comment) => comment.id),
    ).toEqual(["comment-3"]);
  });

  it("counts open comments in status and reroutes nextAction at the review feedback", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const status = specStatusViewSchema.parse(await response.json());
    expect(status.openComments).toEqual({
      count: 2,
      blockingCount: 1,
      subjects: ["R1", "removed-element"],
    });
    // The seeded revision is a draft, so the agent acts next — and the action
    // it is pointed at leads with the feedback instead of a dead approval ask.
    expect(status.nextAction?.instruction).toContain(
      "cctl spec comments current-slug --open",
    );
  });

  it("projects detail-view comments out of their raw row shape", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.comments[0]).toMatchObject({
      handle: "R1",
      threadId: "thread-1",
      blocking: true,
      author: { kind: "human" },
      quote: "resolves renamed specs",
    });
    expect(Object.keys(detail.comments[0] ?? {})).not.toContain("anchor_json");
  });

  it("refuses an element filter that names nothing rather than answering empty", async () => {
    const handlers = createSpecRouteHandlers(commentDeps());

    const response = await handlers.getSpecCommentsGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/comments?element=R9",
      ),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(404);
  });
});
