import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { installFetchFixture } from "@/test/fetch-fixture";

import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecCommentRow,
  SpecEventRow,
  SpecGateAdmissionRow,
  SpecLinkRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
} from "./schemas";
import {
  serializeSubjectFingerprint,
  subjectFingerprint,
  type ApprovalSubject,
} from "./approval-applicability";
import { lint } from "./lint";
import { specQueries } from "./queries";
import { revisionReviewHash } from "./review-hash";
import { toDiffCitations, toDiffRows } from "./revision-diff-projections";
import {
  createSpecRouteHandlers,
  SPEC_OUTLINE_CRITERIA_PER_REQUIREMENT_LIMIT,
  SPEC_OUTLINE_ROOT_LIMIT,
  type SpecRouteDeps,
} from "./route-handlers";
import {
  specCommentsViewSchema,
  specDetailViewSchema,
  specDiffViewSchema,
  specEditContextViewSchema,
  specSectionViewSchema,
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
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "a".repeat(64),
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
  assumptionCitations: [],
};

const question: SpecQuestionRow = {
  id: "question-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "Which aliases are supported?",
  provenance_json: JSON.stringify({ kind: "agent", conversationId: "conv-1" }),
  record_version: 1,
  status: "open",
  answer: null,
  answered_at: null,
  withdrawn_at: null,
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
  record_version: 1,
  disposition: "rejected",
  disposed_at: "2026-07-18T01:00:00.000Z",
  withdrawn_at: null,
  supersedes_assumption_id: null,
  supersession_operation_id: null,
  supersession_request_hash: null,
  created_at: revision.createdAt,
  updated_at: revision.createdAt,
};

function routeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

/**
 * The fingerprint an approval row records: the subject as the approving human
 * read it in `approved`. Computed by the production fingerprint, so these rows
 * apply or stop applying exactly as a written approval would.
 */
function fingerprintIn(
  approved: SpecRevisionSnapshot,
  subject: ApprovalSubject,
): string {
  const fingerprint = subjectFingerprint(toDiffRows(approved), subject, {
    citationContractVersion: approved.revision.citationContractVersion,
    citations: toDiffCitations(approved),
  });
  if (fingerprint === null) {
    throw new Error(
      `${subject.elementId ?? "the plan"} is not carried by ${approved.revision.id}`,
    );
  }
  return serializeSubjectFingerprint(fingerprint);
}

/**
 * The seeded draft at the last authoring stage, without the legacy task: a
 * plan-stage draft is read-only and consults no gate.
 */
const designDraft: SpecRevision = { ...revision, authoringStage: "design" };
const designElements = snapshot.elements.filter(
  ({ element }) => element.kind !== "task",
);
const designDraftSnapshot: SpecRevisionSnapshot = {
  revision: designDraft,
  elements: designElements,
  assumptionCitations: [],
};

const R1 = { subjectKind: "requirement", elementId: "requirement-1" } as const;
const D1 = { subjectKind: "decision", elementId: "decision-1" } as const;
const PLAN = { subjectKind: "plan", elementId: null } as const;

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
    exportSpec: async () => ({ markdownFiles: [], manifest: "{}\n" }),
    verifySpec: async () => ({
      ok: true,
      checkedRevisionIds: [],
      mismatches: [],
      consistencyFindings: [],
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
      phase: { primary: "draft" },
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
          },
          criteria: [
            {
              handle: "R1.1",
              elementId: "criterion-1",
              elementVersion: 1,
              validationKinds: ["test_run"],
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
        },
      ],
      disclosure: {
        requirements: { total: 1, returned: 1, truncated: false },
        criteria: { total: 1, returned: 1, truncated: false },
        decisions: { total: 1, returned: 1, truncated: false },
        tasks: { total: 1, returned: 1, truncated: false },
        sections: {
          total: 1,
          returned: 1,
          truncated: false,
          next: `cctl spec section get ${spec.slug} --id <element-id>`,
        },
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
      assumptionCitations: [],
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
        subject_fingerprint_json: fingerprintIn(approvedSnapshot, R1),
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
        subject_fingerprint_json: fingerprintIn(approvedSnapshot, D1),
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
        subject_fingerprint_json: fingerprintIn(snapshot, R1),
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
        subject_fingerprint_json: fingerprintIn(snapshot, D1),
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
      assumptionCitations: [],
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
      assumptionCitations: [],
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
    const statusResponse = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    expect(statusResponse.status).toBe(200);
    const detailBody: unknown = await response.json();
    const statusBody: unknown = await statusResponse.json();
    const detail = specDetailViewSchema.parse(detailBody);
    expect(detail.revisions).toContainEqual(approvedPlan);
    expect(detail.currentApprovedRevision?.revision.authoringStage).toBe(
      "plan",
    );
    expect(
      detail.currentApprovedRevision?.elements.find(
        (element) => element.element.kind === "task",
      )?.version.payload,
    ).toMatchObject({ kind: "task", title: "Build read routes" });
    expect(specStatusViewSchema.parse(statusBody).taskPlan).toEqual([
      expect.objectContaining({ handle: "T1", title: "Build read routes" }),
    ]);

    // Spec Studio loads the same responses through its query layer.
    const api = installFetchFixture();
    try {
      api.json("GET", `/api/specs/demo/${spec.slug}`, detailBody);
      api.json("GET", `/api/specs/demo/${spec.slug}/status`, statusBody);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const studioDetail = await client.fetchQuery(
        specQueries.detail("demo", spec.slug),
      );
      const studioStatus = await client.fetchQuery(
        specQueries.status("demo", spec.slug),
      );
      expect(studioDetail.status.taskPlan).toEqual([
        expect.objectContaining({ handle: "T1" }),
      ]);
      expect(studioStatus.taskPlan).toEqual([
        expect.objectContaining({ handle: "T1" }),
      ]);
    } finally {
      api.restore();
    }
  });

  /**
   * Revision 1 approved and revision 2 the open draft amending it: the shape a
   * human reviews while the author keeps editing, with R1 reworded in the draft
   * so the draft's review hash and its baseline's cannot coincide.
   */
  function withOpenAmendmentDraft(events: SpecEventRow[] = []) {
    const approvedBase: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const draft: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: approvedBase.id,
    };
    const approvedSnapshot: SpecRevisionSnapshot = {
      revision: approvedBase,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: approvedBase.id },
      })),
      assumptionCitations: [],
    };
    const draftSnapshot: SpecRevisionSnapshot = {
      revision: draft,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: {
          ...entry.version,
          revisionId: draft.id,
          ...(entry.element.id === "requirement-1"
            ? {
                payload: {
                  kind: "requirement" as const,
                  statement: "The route resolves renamed and retired specs",
                  priority: "must" as const,
                  risk: "medium" as const,
                },
                payloadHash: "reworded-requirement-hash",
                elementVersion: 2,
              }
            : {}),
        },
      })),
      assumptionCitations: [],
    };
    const snapshotsById = new Map([
      [approvedBase.id, approvedSnapshot],
      [draft.id, draftSnapshot],
    ]);
    return {
      approvedSnapshot,
      draftSnapshot,
      handlers: createSpecRouteHandlers(
        createDeps({
          listRevisions: async () => [approvedBase, draft],
          getRevisionSnapshot: async (revisionId) =>
            snapshotsById.get(revisionId) ?? null,
          findEventsBySpecId: () => events,
        }),
      ),
    };
  }

  it("returns the open draft for review with the hash a review act echoes", async () => {
    const { handlers, approvedSnapshot, draftSnapshot } =
      withOpenAmendmentDraft();

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.draftReview).toMatchObject({
      snapshot: { revision: { id: draftSnapshot.revision.id, state: "draft" } },
      baseSnapshot: { revision: { id: approvedSnapshot.revision.id } },
      governanceBaseSnapshot: {
        revision: { id: approvedSnapshot.revision.id },
      },
      notes: null,
      reviewHash: revisionReviewHash(draftSnapshot),
    });
    // The human reads the draft's own content, and the hash they echo names
    // that content rather than the baseline the diff is read against.
    expect(
      detail.draftReview?.snapshot.elements.find(
        ({ element }) => element.id === "requirement-1",
      )?.version.payload,
    ).toMatchObject({
      statement: "The route resolves renamed and retired specs",
    });
    expect(detail.draftReview?.reviewHash).not.toBe(
      revisionReviewHash(approvedSnapshot),
    );
  });

  it("reports no draft review once the current revision is approved", async () => {
    const approved: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approved],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === approved.id
            ? { ...snapshot, revision: approved }
            : null,
      }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.currentRevision?.revision.state).toBe("approved");
    expect(detail.draftReview).toBeNull();
  });

  /**
   * The author's disposition document rides the review request, read-only, on
   * the draft it describes. An author may ask for review again after further
   * edits; the reviewer reads the latest request's notes.
   */
  it("exposes the notes of the latest review request on the open draft", async () => {
    const reviewRequest = (id: number, notes: string): SpecEventRow => ({
      id,
      spec_id: spec.id,
      occurred_at: `2026-07-18T0${id}:00:00.000Z`,
      event_type: "spec-revision-changed",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: "conversation-1",
      }),
      payload_json: JSON.stringify({
        kind: "proposed",
        revisionId: "revision-2",
        notes,
      }),
    });
    const { handlers } = withOpenAmendmentDraft([
      reviewRequest(1, "## Disposition\n\nFirst pass."),
      reviewRequest(2, "## Disposition\n\nRewrote R1 after the reviewer's F3."),
    ]);

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.draftReview?.notes).toBe(
      "## Disposition\n\nRewrote R1 after the reviewer's F3.",
    );
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
        recordVersion: 1,
        status: "open",
        answer: null,
        answeredAt: null,
        withdrawnAt: null,
        provenance: { kind: "agent", conversationId: "conv-1" },
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: null,
          humanCapability: { kind: "answer", allowed: true },
        },
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
        recordVersion: 1,
        disposition: "rejected",
        disposedAt: "2026-07-18T01:00:00.000Z",
        withdrawnAt: null,
        proposedBy: { kind: "agent", conversationId: "conv-1" },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: {
          revisionId: revision.id,
          citationVersion: 1,
          citationHash: "a".repeat(64),
          citations: [],
        },
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction:
              "This assumption is terminal; correct it through supersession.",
          },
        },
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    });
  });

  it("projects typed attention audit events on the detail read", async () => {
    const auditEvent: SpecEventRow = {
      id: 12,
      spec_id: spec.id,
      occurred_at: revision.createdAt,
      event_type: "spec-review-record-mutated",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: "conv-1",
      }),
      payload_json: JSON.stringify({
        schemaVersion: 1,
        recordKind: "question",
        recordId: question.id,
        recordNumber: question.number,
        attentionId: question.id,
        operation: "opened",
        active: true,
        before: null,
        after: {
          kind: "question",
          recordId: question.id,
          number: question.number,
          recordVersion: question.record_version,
          text: question.text,
          elementId: question.element_id,
          provenance: { kind: "agent", conversationId: "conv-1" },
          status: question.status,
          answer: question.answer,
          answeredAt: question.answered_at,
          withdrawnAt: question.withdrawn_at,
          createdAt: question.created_at,
          updatedAt: question.updated_at,
        },
      }),
    };
    const handlers = createSpecRouteHandlers(
      createDeps({ findEventsBySpecId: () => [auditEvent] }),
    );

    const response = await handlers.getSpecGET(
      new Request("http://cc.test/api/specs/demo/current-slug"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const detail = specDetailViewSchema.parse(await response.json());
    expect(detail.attentionAuditEvents).toEqual([
      expect.objectContaining({
        kind: "record",
        eventId: auditEvent.id,
        actor: { kind: "agent", conversationId: "conv-1" },
        payload: expect.objectContaining({ operation: "opened" }),
      }),
    ]);
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

  /**
   * A spec whose revision 2 dropped the requirement revision 1 carried: the
   * only shape in which a handle resolves nowhere current but somewhere
   * historical.
   */
  function withRetiredRequirement() {
    const historicalRevision: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const currentRevision: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: historicalRevision.id,
    };
    const retiredRow = {
      element: {
        id: "requirement-2",
        specId: spec.id,
        kind: "requirement" as const,
        number: 2,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: historicalRevision.id,
        elementId: "requirement-2",
        position: 4,
        payload: {
          kind: "requirement" as const,
          statement: "The route falls back to older revisions",
          priority: "must" as const,
          risk: "low" as const,
        },
        payloadHash: "retired-requirement-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    };
    const snapshotsById = new Map<string, SpecRevisionSnapshot>([
      [
        historicalRevision.id,
        {
          revision: historicalRevision,
          elements: [...snapshot.elements, retiredRow],
          assumptionCitations: [],
        },
      ],
      [
        currentRevision.id,
        {
          revision: currentRevision,
          elements: snapshot.elements.map((row) => ({
            ...row,
            version: { ...row.version, revisionId: currentRevision.id },
          })),
          assumptionCitations: [],
        },
      ],
    ]);
    return {
      historicalRevision,
      currentRevision,
      handlers: createSpecRouteHandlers(
        createDeps({
          listRevisions: async () => [historicalRevision, currentRevision],
          getRevisionSnapshot: async (revisionId) =>
            snapshotsById.get(revisionId) ?? null,
        }),
      ),
    };
  }

  it("refuses a historical-only handle instead of answering from the older revision", async () => {
    const { handlers, historicalRevision, currentRevision } =
      withRetiredRequirement();

    const response = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/R2"),
      routeContext({ name: "demo", slug: spec.slug, element: "R2" }),
    );

    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Spec element exists only in a historical revision",
      code: "historical_only",
      details: {
        handle: "R2",
        elementId: "requirement-2",
        lastRevisionId: historicalRevision.id,
        lastRevisionNumber: 1,
        currentRevisionId: currentRevision.id,
        currentRevisionNumber: 2,
      },
      instruction:
        "Read the historical element with `cctl spec get current-slug/R2 --revision 1`. The current revision does not contain this handle.",
    });
    // The deleted fallback: the older revision's content is never the answer.
    expect(body).not.toHaveProperty("element");
    expect(body).not.toHaveProperty("revision");
  });

  it("selects a revision by number beside the existing id selector", async () => {
    const { handlers, historicalRevision } = withRetiredRequirement();

    const byNumber = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R2?revisionNumber=1",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R2" }),
    );
    expect(byNumber.status).toBe(200);
    await expect(byNumber.json()).resolves.toMatchObject({
      handle: "R2",
      revision: { id: historicalRevision.id, number: 1 },
      element: { element: { id: "requirement-2" } },
    });

    const byId = await handlers.getSpecElementGET(
      new Request(
        `http://cc.test/api/specs/demo/current-slug/elements/R2?revisionId=${historicalRevision.id}`,
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R2" }),
    );
    expect(byId.status).toBe(200);
    await expect(byId.json()).resolves.toMatchObject({
      revision: { id: historicalRevision.id },
    });
  });

  it("reports an unknown revision selector as a missing revision in either form", async () => {
    const { handlers } = withRetiredRequirement();

    const unknownNumber = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?revisionNumber=99",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );
    expect(unknownNumber.status).toBe(404);
    await expect(unknownNumber.json()).resolves.toEqual({
      error: "Spec revision not found",
    });

    const unknownId = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?revisionId=revision-missing",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );
    expect(unknownId.status).toBe(404);
    await expect(unknownId.json()).resolves.toEqual({
      error: "Spec revision not found",
    });
  });

  it("leaves Q/A resolution and reference state untouched by the historical refusal", async () => {
    const { handlers } = withRetiredRequirement();

    // Q/A records are spec-scoped, so they resolve before any revision scan
    // and never become a historical_only refusal.
    const questionResponse = await handlers.getSpecElementGET(
      new Request("http://cc.test/api/specs/demo/current-slug/elements/Q1"),
      routeContext({ name: "demo", slug: spec.slug, element: "Q1" }),
    );
    expect(questionResponse.status).toBe(200);
    await expect(questionResponse.json()).resolves.toMatchObject({
      kind: "question",
      handle: "Q1",
    });

    const referenceResponse = await handlers.getSpecElementGET(
      new Request(
        "http://cc.test/api/specs/demo/current-slug/elements/R1?observedRevision=1",
      ),
      routeContext({ name: "demo", slug: spec.slug, element: "R1" }),
    );
    expect(referenceResponse.status).toBe(200);
    await expect(referenceResponse.json()).resolves.toMatchObject({
      referenceState: {
        observedRevision: 1,
        observedPayloadHash: "requirement-hash",
        latestContainingRevision: 2,
        latestPayloadHash: "requirement-hash",
      },
    });
  });

  /**
   * A lineage whose revision 2 dropped one of the two sections revision 1
   * carried: sections have no handle, so element id is the only address, and
   * the retired one is the shape the historical refusal has to name.
   */
  function withSections() {
    const historicalRevision: SpecRevision = {
      ...revision,
      state: "approved",
      contentHash: "revision-1-hash",
      proposedAt: revision.createdAt,
      approvedAt: revision.createdAt,
    };
    const currentRevision: SpecRevision = {
      ...revision,
      id: "revision-2",
      number: 2,
      basedOnRevisionId: historicalRevision.id,
    };
    const sectionRow = {
      element: {
        id: "problem-section",
        specId: spec.id,
        kind: "section" as const,
        number: null,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: historicalRevision.id,
        elementId: "problem-section",
        position: 4,
        payload: {
          kind: "section" as const,
          role: "intent_problem" as const,
          title: "Problem",
          body: "Sections have no read path.",
        },
        payloadHash: "problem-section-hash",
        elementVersion: 3,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    };
    const retiredSectionRow = {
      ...sectionRow,
      element: { ...sectionRow.element, id: "retired-section" },
      version: {
        ...sectionRow.version,
        elementId: "retired-section",
        position: 5,
        payload: {
          ...sectionRow.version.payload,
          role: "context" as const,
          title: "Retired context",
        },
      },
    };
    const snapshotsById = new Map<string, SpecRevisionSnapshot>([
      [
        historicalRevision.id,
        {
          revision: historicalRevision,
          elements: [...snapshot.elements, sectionRow, retiredSectionRow],
          assumptionCitations: [],
        },
      ],
      [
        currentRevision.id,
        {
          revision: currentRevision,
          elements: [...snapshot.elements, sectionRow].map((row) => ({
            ...row,
            version: { ...row.version, revisionId: currentRevision.id },
          })),
          assumptionCitations: [],
        },
      ],
    ]);
    return {
      historicalRevision,
      currentRevision,
      handlers: createSpecRouteHandlers(
        createDeps({
          listRevisions: async () => [historicalRevision, currentRevision],
          getRevisionSnapshot: async (revisionId) =>
            snapshotsById.get(revisionId) ?? null,
        }),
      ),
    };
  }

  function sectionRequest(
    handlers: ReturnType<typeof createSpecRouteHandlers>,
    element: string,
    search = "",
  ) {
    return handlers.getSpecSectionGET(
      new Request(
        `http://cc.test/api/specs/demo/current-slug/sections/${element}${search}`,
      ),
      routeContext({ name: "demo", slug: spec.slug, element }),
    );
  }

  it("returns one current-revision section addressed by its element id", async () => {
    const { handlers, currentRevision } = withSections();

    const response = await sectionRequest(handlers, "problem-section");

    expect(response.status).toBe(200);
    const body = specSectionViewSchema.parse(await response.json());
    expect(body).toEqual({
      specId: spec.id,
      slug: spec.slug,
      kind: "section",
      // Literal null, not an echoed element id: sections are not addressable
      // by handle, so nothing downstream can invent one from this read.
      handle: null,
      elementId: "problem-section",
      role: "intent_problem",
      title: "Problem",
      body: "Sections have no read path.",
      elementVersion: 3,
      position: 4,
      revision: {
        id: currentRevision.id,
        number: 2,
        state: "draft",
        authoringStage: "plan",
      },
    });
  });

  it("refuses an element id that resolves to a non-section element", async () => {
    const { handlers } = withSections();

    const response = await sectionRequest(handlers, "requirement-1");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Spec element is not a section",
      code: "not_section",
      details: {
        elementId: "requirement-1",
        kind: "requirement",
        handle: "R1",
      },
      instruction:
        "Read this requirement with `cctl spec get current-slug/R1`.",
    });
  });

  it("names no handle for a non-section element that has none", async () => {
    const unnumbered = {
      element: {
        id: "unnumbered-task",
        specId: spec.id,
        kind: "task" as const,
        number: null,
        parentElementId: null,
        createdAt: revision.createdAt,
      },
      version: {
        revisionId: revision.id,
        elementId: "unnumbered-task",
        position: 6,
        payload: {
          kind: "task" as const,
          title: "Unnumbered",
          instructions: "No handle was ever allocated",
          tracedRequirementElementIds: [],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "unnumbered-task-hash",
        elementVersion: 1,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
      },
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        getRevisionSnapshot: async (revisionId) =>
          revisionId === revision.id
            ? { ...snapshot, elements: [...snapshot.elements, unnumbered] }
            : null,
      }),
    );

    const response = await sectionRequest(handlers, "unnumbered-task");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Spec element is not a section",
      code: "not_section",
      details: {
        elementId: "unnumbered-task",
        kind: "task",
        handle: null,
      },
      instruction:
        "This task has no allocated handle; read the whole revision with `cctl spec show current-slug --rendered`.",
    });
  });

  it("reports an unknown element id as a missing section", async () => {
    const { handlers } = withSections();

    const response = await sectionRequest(handlers, "no-such-section");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Spec section not found",
      code: "not_found",
      details: { elementId: "no-such-section" },
    });
  });

  it("refuses a historical-only section with a section-shaped recovery command", async () => {
    const { handlers, historicalRevision, currentRevision } = withSections();

    const response = await sectionRequest(handlers, "retired-section");

    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Spec element exists only in a historical revision",
      code: "historical_only",
      details: {
        handle: null,
        elementId: "retired-section",
        lastRevisionId: historicalRevision.id,
        lastRevisionNumber: 1,
        currentRevisionId: currentRevision.id,
        currentRevisionNumber: 2,
      },
      instruction:
        "Read the historical section with `cctl spec section get current-slug --id retired-section --revision 1`. The current revision does not contain this section.",
    });
    expect(body).not.toHaveProperty("body");
  });

  it("selects a section revision by number or id and refuses an unknown one", async () => {
    const { handlers, historicalRevision } = withSections();

    const byNumber = await sectionRequest(
      handlers,
      "retired-section",
      "?revisionNumber=1",
    );
    expect(byNumber.status).toBe(200);
    await expect(byNumber.json()).resolves.toMatchObject({
      elementId: "retired-section",
      title: "Retired context",
      revision: { id: historicalRevision.id, number: 1, state: "approved" },
    });

    const byId = await sectionRequest(
      handlers,
      "retired-section",
      `?revisionId=${historicalRevision.id}`,
    );
    expect(byId.status).toBe(200);
    await expect(byId.json()).resolves.toMatchObject({
      revision: { id: historicalRevision.id },
    });

    const unknown = await sectionRequest(
      handlers,
      "problem-section",
      "?revisionNumber=99",
    );
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      error: "Spec revision not found",
    });
  });

  it("lists the outline's sections with the read command that reaches one", async () => {
    const { handlers } = withSections();

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const body = specShowOutlineViewSchema.parse(await response.json());
    expect(body.sections).toEqual([
      {
        elementId: "problem-section",
        role: "intent_problem",
        title: "Problem",
        position: 4,
        elementVersion: 3,
      },
    ]);
    expect(body.disclosure.sections).toEqual({
      total: 1,
      returned: 1,
      truncated: false,
      next: "cctl spec section get current-slug --id <element-id>",
    });
  });

  it("bounds the outline's sections by the root limit", async () => {
    const sections = Array.from(
      { length: SPEC_OUTLINE_ROOT_LIMIT + 1 },
      (_unused, index) => ({
        element: {
          id: `section-${index + 1}`,
          specId: spec.id,
          kind: "section" as const,
          number: null,
          parentElementId: null,
          createdAt: revision.createdAt,
        },
        version: {
          revisionId: revision.id,
          elementId: `section-${index + 1}`,
          position: snapshot.elements.length + index,
          payload: {
            kind: "section" as const,
            role: "design_narrative" as const,
            title: `Section ${index + 1}`,
            body: "Bounded",
          },
          payloadHash: `section-hash-${index + 1}`,
          elementVersion: 1,
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
        },
      }),
    );
    const handlers = createSpecRouteHandlers(
      createDeps({
        getRevisionSnapshot: async (revisionId) =>
          revisionId === revision.id
            ? { ...snapshot, elements: [...snapshot.elements, ...sections] }
            : null,
      }),
    );

    const response = await handlers.getSpecOutlineGET(
      new Request("http://cc.test/api/specs/demo/current-slug/outline"),
      routeContext({ name: "demo", slug: spec.slug }),
    );
    const body = specShowOutlineViewSchema.parse(await response.json());

    expect(body.sections).toHaveLength(SPEC_OUTLINE_ROOT_LIMIT);
    expect(body.disclosure.sections).toMatchObject({
      total: SPEC_OUTLINE_ROOT_LIMIT + 1,
      returned: SPEC_OUTLINE_ROOT_LIMIT,
      truncated: true,
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
      assumptionCitations: [],
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

  it("does not request approval again for unchanged carried-forward elements", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      id: "revision-approved",
      state: "approved",
      contentHash: "approved-hash",
      approvedAt: revision.createdAt,
    };
    const draftRevision: SpecRevision = {
      ...revision,
      id: "revision-draft",
      number: 2,
      basedOnRevisionId: approvedRevision.id,
    };
    const snapshotOf = (target: SpecRevision): SpecRevisionSnapshot => ({
      revision: target,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: target.id },
      })),
      assumptionCitations: [],
    });
    const approvedSnapshot = snapshotOf(approvedRevision);
    const draftSnapshot = snapshotOf(draftRevision);
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
        subject_fingerprint_json: fingerprintIn(approvedSnapshot, R1),
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
        subject_fingerprint_json: fingerprintIn(approvedSnapshot, D1),
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
        subject_fingerprint_json: fingerprintIn(approvedSnapshot, PLAN),
      },
    ];
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [approvedRevision, draftRevision],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === draftRevision.id
            ? draftSnapshot
            : revisionId === approvedRevision.id
              ? approvedSnapshot
              : null,
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
    const draftRevision: SpecRevision = {
      ...revision,
      id: "revision-draft",
      number: 3,
      // The requirements gate is the current stage's own gate here, so the
      // only question the assertion asks is whose approval satisfies it.
      authoringStage: "requirements",
      basedOnRevisionId: approvedRevision.id,
    };
    const snapshotOf = (target: SpecRevision): SpecRevisionSnapshot => ({
      revision: target,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: target.id },
      })),
      assumptionCitations: [],
    });
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [
          approvedRevision,
          abandonedRevision,
          draftRevision,
        ],
        getRevisionSnapshot: async (revisionId) =>
          snapshotOf(
            [approvedRevision, abandonedRevision, draftRevision].find(
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
            // The fingerprint matches the current draft's R1, so lineage is
            // the only thing that can keep this approval from applying.
            subject_fingerprint_json: fingerprintIn(
              snapshotOf(abandonedRevision),
              R1,
            ),
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

  /** Every consulted subject of the seeded draft, approved as it reads now. */
  const everySubjectApproved: SpecApprovalRow[] = [
    {
      id: "approval-requirement",
      spec_id: spec.id,
      subject_kind: "requirement",
      element_id: "requirement-1",
      revision_id: revision.id,
      approver: "alex",
      validity: "valid",
      granted_at: "2026-07-18T02:00:00.000Z",
      subject_fingerprint_json: fingerprintIn(designDraftSnapshot, R1),
    },
    {
      id: "approval-decision",
      spec_id: spec.id,
      subject_kind: "decision",
      element_id: "decision-1",
      revision_id: revision.id,
      approver: "alex",
      validity: "valid",
      granted_at: "2026-07-18T02:00:00.000Z",
      subject_fingerprint_json: fingerprintIn(designDraftSnapshot, D1),
    },
  ];

  /**
   * The contradiction ticket #42 reported: status read subject approvals from
   * a consulted-filtered source and gate state from an admission-only source,
   * so it could answer "pending approvals: none" beside a pending gate with no
   * act named anywhere. Sign-off is the missing item, and it is its own.
   */
  it("names the outstanding revision sign-off once every consulted subject is approved", async () => {
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [designDraft],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === designDraft.id ? designDraftSnapshot : null,
        findApprovalsBySpecId: () => everySubjectApproved,
        // A clean draft: lint cannot be what holds the sign-off.
        lintDraft: async () => [],
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
    ).toEqual(["requirements", "design"]);
    expect(status.revisionSignOff).toMatchObject({
      revisionId: revision.id,
      revisionNumber: revision.number,
      state: "ready",
      outstandingSubjectCount: 0,
      unmetConditions: [],
    });
    expect(status.nextAction?.kind).toBe("sign_off_revision");
    expect(status.pendingBlock?.signOff?.state).toBe("ready");
    expect(status.pendingBlock?.display).toContain("sign-off");
  });

  /**
   * Sign-off freezes the draft, so it owes every blocking lint finding — the
   * ones that also stop a review request, not only the sign-off tier. Status
   * must say so rather than offer a sign-off the act would refuse.
   */
  it("keeps the sign-off blocked on a propose-blocking lint finding once every subject is approved", async () => {
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [designDraft],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === designDraft.id ? designDraftSnapshot : null,
        findApprovalsBySpecId: () => everySubjectApproved,
        lintDraft: async () => [
          {
            ruleId: "uncovered_criterion",
            severity: "blocks_propose",
            elementHandle: "R1.1",
            message: "R1.1 must be covered",
          },
        ],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    const status = specStatusViewSchema.parse(await response.json());
    expect(status.pendingApprovals).toEqual([]);
    expect(status.revisionSignOff).toMatchObject({
      revisionId: revision.id,
      state: "blocked",
      unmetConditions: ["R1.1 must be covered"],
    });
    expect(status.nextAction).toMatchObject({
      kind: "resolve_conditions",
      actsNext: "agent",
    });
  });

  it("reads an earlier gate unchanged since the governance base as not required, with its admission as history", async () => {
    const approvedRevision: SpecRevision = {
      ...revision,
      state: "approved",
      authoringStage: "requirements",
      contentHash: "revision-1-hash",
      approvedAt: revision.createdAt,
    };
    const amendment: SpecRevision = {
      ...designDraft,
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
          elements: designElements,
          assumptionCitations: [],
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
    expect(status.applicableGates).toEqual(["design"]);
    // Requirement 24.13: the earlier admission is provenance, never current
    // satisfaction, so it stays out of `currentAdmissions` and out of `state`.
    expect(requirements?.currentAdmissions).toEqual([]);
    expect(requirements?.priorAdmissions).toEqual([
      {
        revisionId: approvedRevision.id,
        revisionNumber: 1,
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
      assumptionCitations: [],
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
   * A dependency on a task the amendment dropped is the visible signature of
   * an amendment that forked past its own content (ticket #42), and a raw id
   * sitting in the handle-typed field reads as a dependency that resolves.
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
      assumptionCitations: [],
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
      ...designDraft,
      state: "approved",
      contentHash: "revision-1-hash",
      approvedAt: revision.createdAt,
    };
    const amendment: SpecRevision = {
      ...designDraft,
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
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-07-18T02:00:00.000Z",
    };
    const [requirementRow, ...otherRows] = designElements;
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
            ? {
                revision: amendment,
                elements: designElements,
                assumptionCitations: [],
              }
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
                assumptionCitations: [],
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

  it("does not repeat the current revision's own admission as history", async () => {
    const admission: SpecGateAdmissionRow = {
      id: "admission-1",
      spec_id: spec.id,
      gate: "requirements",
      basis: "notify_policy",
      approval_id: null,
      revision_id: revision.id,
      actor_json: JSON.stringify({ kind: "system" }),
      created_at: "2026-07-18T02:00:00.000Z",
    };
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [designDraft],
        getRevisionSnapshot: async (revisionId) =>
          revisionId === designDraft.id ? designDraftSnapshot : null,
        findGateAdmissionsBySpecId: () => [admission],
      }),
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
          basis: "notify_policy",
          // The stored provenance is not a shape the actor schema admits, and
          // one unreadable record degrades to null rather than failing a read.
          actor: null,
          admittedAt: "2026-07-18T02:00:00.000Z",
        },
      ],
      priorAdmissions: [],
    });
  });

  it("reports pending approvals only for the current authoring-stage review", async () => {
    const requirementsRevision: SpecRevision = {
      ...revision,
      authoringStage: "requirements",
    };
    const requirementsSnapshot: SpecRevisionSnapshot = {
      revision: requirementsRevision,
      elements: snapshot.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: requirementsRevision.id },
      })),
      assumptionCitations: [],
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
    // The draft is reviewed in place: there is no separate review phase.
    expect(body.phase).toEqual({
      primary: "draft",
      authoringStage: "requirements",
    });
    expect(body.pendingApprovals).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ]);
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
      assumptionCitations: [],
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
      assumptionCitations: [],
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
      assumptionCitations: [],
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
          linkedWork: {
            tickets: 1,
            conversations: 1,
            sessions: 0,
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
  const openReplyOne: SpecCommentRow = {
    ...openComment,
    id: "comment-reply-1",
    parent_comment_id: openComment.id,
    body: "The alias should survive the rename.",
    blocking: 0,
    created_at: "2026-08-12T00:10:00.000Z",
    updated_at: "2026-08-12T00:10:00.000Z",
  };
  const openReplyTwo: SpecCommentRow = {
    ...openReplyOne,
    id: "comment-reply-2",
    body: "The exported bundle should preserve it too.",
    created_at: "2026-08-12T00:20:00.000Z",
    updated_at: "2026-08-12T00:20:00.000Z",
  };
  const orphanComment: SpecCommentRow = {
    ...openComment,
    id: "comment-3",
    thread_id: "thread-3",
    element_id: "removed-element",
    body: "This element vanished after the comment landed.",
    blocking: 1,
    resolution: "open",
    created_at: "2026-08-12T02:00:00.000Z",
    updated_at: "2026-08-12T02:00:00.000Z",
  };

  function commentDeps() {
    return createDeps({
      findCommentsByRevision: (revisionId) =>
        revisionId === revision.id
          ? [
              openComment,
              resolvedComment,
              openReplyTwo,
              orphanComment,
              openReplyOne,
            ]
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
    expect(body.openCount).toBe(4);
    expect(body.openBlockingCount).toBe(2);
    expect(body.openThreadCount).toBe(2);
    expect(body.openBlockingThreadCount).toBe(2);
    expect(body.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-reply-1",
      "comment-reply-2",
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
    expect(body.comments[4]).toMatchObject({
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
      "comment-reply-1",
      "comment-reply-2",
      "comment-3",
    ]);
    expect(body.openCount).toBe(4);
    expect(body.openBlockingCount).toBe(2);
    expect(body.openThreadCount).toBe(2);
    expect(body.openBlockingThreadCount).toBe(2);
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
    ).toEqual(["comment-1", "comment-reply-1", "comment-reply-2", "comment-2"]);
    expect(
      specCommentsViewSchema
        .parse(await byId.json())
        .comments.map((comment) => comment.id),
    ).toEqual(["comment-3"]);
    const byHandleView = specCommentsViewSchema.parse(
      await handlers
        .getSpecCommentsGET(
          new Request(
            "http://cc.test/api/specs/demo/current-slug/comments?element=R1",
          ),
          routeContext({ name: "demo", slug: spec.slug }),
        )
        .then((response) => response.json()),
    );
    expect(byHandleView).toMatchObject({
      openCount: 4,
      openBlockingCount: 2,
      openThreadCount: 2,
      openBlockingThreadCount: 2,
    });
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
      count: 4,
      blockingCount: 2,
      openThreadCount: 2,
      openBlockingThreadCount: 2,
      subjects: ["R1", "removed-element"],
    });
    // The seeded revision is a draft, so the agent acts next — and the action
    // it is pointed at leads with the feedback instead of a dead approval ask.
    expect(status.nextAction?.instruction).toContain(
      "cctl spec comments current-slug --open",
    );
  });

  it("projects spec-wide status counts with canonical lifecycle and blocking semantics", async () => {
    const historicalRevision: SpecRevision = {
      ...revision,
      id: "revision-historical",
      number: 1,
      state: "withdrawn",
    };
    const currentRevision: SpecRevision = {
      ...revision,
      id: "revision-current",
      number: 2,
      basedOnRevisionId: historicalRevision.id,
    };
    const snapshotFor = (candidate: SpecRevision): SpecRevisionSnapshot => ({
      revision: candidate,
      elements: snapshot.elements.map((row) => ({
        ...row,
        version: { ...row.version, revisionId: candidate.id },
      })),
      assumptionCitations: [],
    });
    const historicalOpen: SpecCommentRow = {
      ...openComment,
      id: "comment-historical",
      thread_id: "thread-historical",
      element_id: "removed-element",
      revision_id: historicalRevision.id,
      blocking: 0,
      created_at: "2026-08-11T23:00:00.000Z",
      updated_at: "2026-08-11T23:00:00.000Z",
    };
    const currentSettledBlockingRoot: SpecCommentRow = {
      ...openComment,
      id: "comment-current-root",
      thread_id: "thread-current",
      revision_id: currentRevision.id,
      resolution: "resolved",
    };
    const currentOpenReply: SpecCommentRow = {
      ...currentSettledBlockingRoot,
      id: "comment-current-reply",
      parent_comment_id: currentSettledBlockingRoot.id,
      body: "This reply keeps the thread open.",
      blocking: 0,
      resolution: "open",
      created_at: "2026-08-12T00:10:00.000Z",
      updated_at: "2026-08-12T00:10:00.000Z",
    };
    const snapshots = new Map(
      [historicalRevision, currentRevision].map((candidate) => [
        candidate.id,
        snapshotFor(candidate),
      ]),
    );
    const handlers = createSpecRouteHandlers(
      createDeps({
        listRevisions: async () => [historicalRevision, currentRevision],
        getRevisionSnapshot: async (revisionId) =>
          snapshots.get(revisionId) ?? null,
        findCommentsByRevision: (revisionId) =>
          revisionId === historicalRevision.id
            ? [historicalOpen]
            : revisionId === currentRevision.id
              ? [currentSettledBlockingRoot, currentOpenReply]
              : [],
      }),
    );

    const response = await handlers.getSpecStatusGET(
      new Request("http://cc.test/api/specs/demo/current-slug/status"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    const status = specStatusViewSchema.parse(await response.json());
    expect(status.openComments).toEqual({
      count: 2,
      blockingCount: 0,
      openThreadCount: 2,
      openBlockingThreadCount: 1,
      subjects: ["removed-element", "R1"],
    });
    expect(status.revisionSignOff?.unmetConditions).toContain(
      "Blocking thread thread-current is unresolved.",
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

describe("spec diff route handler", () => {
  const approvedBase: SpecRevision = {
    ...revision,
    id: "base-revision",
    state: "approved",
    authoringStage: "requirements",
    approvedAt: "2026-07-18T01:00:00.000Z",
  };
  const draftAmendment: SpecRevision = {
    ...revision,
    id: "amendment-revision",
    number: 2,
    authoringStage: "design",
    basedOnRevisionId: approvedBase.id,
  };
  const requirementRow = {
    element: {
      id: "requirement-1",
      specId: spec.id,
      kind: "requirement" as const,
      number: 1,
      parentElementId: null,
      createdAt: revision.createdAt,
    },
    version: {
      revisionId: approvedBase.id,
      elementId: "requirement-1",
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "The route resolves renamed specs",
        priority: "must" as const,
        risk: "medium" as const,
      },
      payloadHash: "requirement-hash",
      elementVersion: 1,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    },
  };
  const addedDecisionRow = {
    element: {
      id: "decision-new",
      specId: spec.id,
      kind: "decision" as const,
      number: 1,
      parentElementId: null,
      createdAt: revision.createdAt,
    },
    version: {
      revisionId: draftAmendment.id,
      elementId: "decision-new",
      position: 1,
      payload: {
        kind: "decision" as const,
        title: "Adopt agent write modes",
        chosenApproach: "Write modes gate agent edits",
        rejectedAlternatives: [],
        reason: "Citation-bearing decisions are the amendment shape",
        tracedRequirementElementIds: ["requirement-1"],
      },
      payloadHash: "decision-new-hash",
      elementVersion: 1,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    },
  };
  const citationSnapshot = {
    schemaVersion: 1 as const,
    captureKind: "native" as const,
    capturedAt: "2026-07-19T00:00:00.000Z",
    assumptionId: assumption.id,
    number: 1,
    recordVersion: 1,
    text: assumption.text,
    elementId: "requirement-1",
    proposedBy: { kind: "agent" as const, conversationId: "conv-1" },
    disposition: "confirmed" as const,
    disposedAt: "2026-07-19T00:00:00.000Z",
    withdrawnAt: null,
    supersedesAssumptionId: null,
    createdAt: revision.createdAt,
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const citationOn = (elementId: string) => ({
    revisionId: draftAmendment.id,
    specId: spec.id,
    elementId,
    assumptionId: assumption.id,
    snapshot: citationSnapshot,
    createdAt: revision.createdAt,
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  const baseSnapshot: SpecRevisionSnapshot = {
    revision: approvedBase,
    elements: [requirementRow],
    assumptionCitations: [],
  };
  const amendmentSnapshot: SpecRevisionSnapshot = {
    revision: draftAmendment,
    elements: [requirementRow, addedDecisionRow],
    assumptionCitations: [
      citationOn("decision-new"),
      citationOn("requirement-1"),
    ],
  };
  const diffDeps = () =>
    createDeps({
      listRevisions: async () => [approvedBase, draftAmendment],
      getRevisionSnapshot: async (revisionId) =>
        revisionId === approvedBase.id
          ? baseSnapshot
          : revisionId === draftAmendment.id
            ? amendmentSnapshot
            : null,
    });

  it("classifies citation-bearing elements within the four-value diff vocabulary", async () => {
    const handlers = createSpecRouteHandlers(diffDeps());

    const response = await handlers.getSpecDiffGET(
      new Request("http://cc.test/api/specs/demo/current-slug/diff"),
      routeContext({ name: "demo", slug: spec.slug }),
    );

    expect(response.status).toBe(200);
    // The CLI's own strict schema is the contract that broke: citation-change
    // kinds leaked into `classification` and every reader refused the body.
    const parsed = specDiffViewSchema.safeParse(await response.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.baseline).toBe("review");
    expect(parsed.data.from).toMatchObject({ revisionId: approvedBase.id });
    expect(parsed.data.to).toMatchObject({ revisionId: draftAmendment.id });
    const byId = new Map(
      parsed.data.elements.map((element) => [element.elementId, element]),
    );
    // Payload unchanged, citation added: the engine's classification (modified)
    // is the answer, and the citation change is the story the summary tells.
    expect(byId.get("requirement-1")).toMatchObject({
      classification: "modified",
      directlyChanged: true,
      summary: "Added assumption A1 citation to requirement-1.",
    });
    // Added element with a citation: the citation change must not overwrite
    // the addition — both facts belong to the one element row.
    expect(byId.get("decision-new")).toMatchObject({
      classification: "added",
      directlyChanged: true,
    });
    expect(byId.get("decision-new")?.summary).toContain(
      "Added decision: Adopt agent write modes",
    );
    expect(byId.get("decision-new")?.summary).toContain(
      "Added assumption A1 citation to decision-new.",
    );
  });
});
