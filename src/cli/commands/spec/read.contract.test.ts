import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSpecRouteHandlers,
  type SpecRouteDeps,
} from "@/lib/specs/route-handlers";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
  type CanonicalSpecBundle,
} from "@/lib/specs/export";
import { lint } from "@/lib/specs/lint";
import { computeSpecMeasuresReport } from "@/lib/specs/measures";
import { diffRevisions } from "@/lib/specs/revision-diff";
import { toDiffRows, toLintSnapshot } from "@/lib/specs/review-state";
import {
  specDetailViewSchema,
  specDiffViewSchema,
} from "@/lib/specs/view-schemas";
import { narrowEvidenceKinds } from "@/lib/state-store/migrations/0009-narrow-evidence-kinds";
import { stableStringify } from "@/lib/state-store/serialization";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecProofVerdictRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "@/lib/specs/schemas";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const PROJECT_PATH = "/repos/demo";
const CREATED_AT = "2026-07-18T00:00:00.000Z";

const spec: Spec = {
  id: "spec-1",
  projectPath: PROJECT_PATH,
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
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
  createdAt: CREATED_AT,
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
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Specs are durable product objects.",
          priority: "must",
          risk: "high",
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: spec.id,
        kind: "criterion",
        number: 1,
        parentElementId: "requirement-1",
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion",
          text: "The spec can be read through cctl.",
          validationStrategy: { kinds: ["test_run"] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "task-1",
        specId: spec.id,
        kind: "task",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 2,
        payload: {
          kind: "task",
          title: "Build the CLI reads",
          instructions: "Expose every approved read verb.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
          laneGroup: "cli",
          executionLane: "cli-surface",
          touchedPaths: ["src/cli/commands/spec"],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    {
      element: {
        id: "task-2",
        specId: spec.id,
        kind: "task",
        number: 2,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-2",
        position: 3,
        payload: {
          kind: "task",
          title: "Verify the CLI reads",
          instructions: "Exercise every graph fact through the read contract.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: ["task-1"],
          laneGroup: "cli",
          executionLane: "cli-surface",
          touchedPaths: ["src/cli/commands/spec/read.contract.test.ts"],
        },
        payloadHash: "task-2-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
  ],
};

// The amendment's own requirements admission, so a reader can tell who
// admitted the revision being read from who admitted an earlier one.
const currentRequirementsAdmission: SpecGateAdmissionRow = {
  id: "admission-2",
  spec_id: spec.id,
  gate: "requirements",
  basis: "human_approval",
  approval_id: null,
  revision_id: "revision-1",
  execution_id: null,
  actor_json: JSON.stringify({ kind: "human" }),
  created_at: CREATED_AT,
};

// An approved predecessor whose requirements gate was admitted, so the draft
// amendment above it can be shown as pending while its history stays visible.
const approvedPredecessor: SpecRevision = {
  id: "revision-0",
  specId: spec.id,
  number: 1,
  state: "approved",
  authoringStage: "requirements",
  basedOnRevisionId: null,
  contentHash: "approved-hash",
  proposedAt: CREATED_AT,
  approvedAt: CREATED_AT,
  createdAt: CREATED_AT,
};

const priorRequirementsAdmission: SpecGateAdmissionRow = {
  id: "admission-1",
  spec_id: spec.id,
  gate: "requirements",
  basis: "human_approval",
  approval_id: null,
  revision_id: approvedPredecessor.id,
  execution_id: null,
  actor_json: JSON.stringify({ kind: "human" }),
  created_at: CREATED_AT,
};

// A spec execution as `spec start` leaves it: compiled definition, parked at
// definition review, no workflow lane behind it.
const parkedExecution: SpecExecutionRow = {
  id: "execution-1",
  spec_id: spec.id,
  revision_id: revision.id,
  scope_json: JSON.stringify({
    selectedTaskIds: ["task-1"],
    selectedCriterionIds: ["criterion-1"],
    exclusionDispositions: [],
  }),
  state: "definition_review",
  execution_start_dial: "gate",
  workflow_definition_id: "workflow-def-1",
  workflow_definition_revision: 1,
  workflow_execution_id: null,
  session_name: "feature-session",
  delivered_at: null,
  abandoned_reason: null,
  cleanup_phase: null,
  linked_workflow_execution_id: null,
  cleanup_last_error: null,
  cleanup_last_error_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

// The state `awaitingDefinitionApproval` leaves behind: the workflow execution
// is linked precisely because the compiled definition is parked for a human.
const definitionApprovalExecution: SpecExecutionRow = {
  ...parkedExecution,
  id: "execution-2",
  workflow_execution_id: "workflow-execution-9",
};

const runningExecution: SpecExecutionRow = {
  ...parkedExecution,
  id: "execution-3",
  state: "running",
  workflow_execution_id: "workflow-execution-3",
};

const question: SpecQuestionRow = {
  id: "question-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "Which export format is canonical?",
  provenance_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  status: "open",
  answer: null,
  answered_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const assumption: SpecAssumptionRow = {
  id: "assumption-1",
  spec_id: spec.id,
  number: 1,
  element_id: "requirement-1",
  text: "SQLite remains authoritative.",
  proposed_by_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-1",
  }),
  disposition: "proposed",
  disposed_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const bundle = {
  markdownFiles: [
    {
      path: "revisions/0001-draft.md",
      content: "# Native SDD\n\n- Revision: 1\n",
    },
  ],
  // The manifest the export renderer produces, cut down to the revisions and
  // elements the CLI's export summary counts.
  manifest: `${JSON.stringify({
    formatVersion: 2,
    spec: { slug: "native-sdd" },
    revisions: [
      {
        id: revision.id,
        elements: [
          { id: "requirement-1" },
          { id: "criterion-1" },
          { id: "task-1" },
        ],
      },
    ],
  })}\n`,
};

// A second spec in the same project, under a different preset, so a
// project-wide search has more than one spec to reconcile and the per-hit
// preset cannot be read off the first spec by accident.
const siblingSpec: Spec = {
  ...spec,
  id: "spec-2",
  slug: "audit-log",
  name: "Audit Log",
  gatePolicy: { preset: "fast-path" },
};

const siblingRevision: SpecRevision = {
  ...revision,
  id: "revision-2",
  specId: siblingSpec.id,
};

const siblingSnapshot: SpecRevisionSnapshot = {
  revision: siblingRevision,
  elements: [
    {
      element: {
        id: "requirement-2",
        specId: siblingSpec.id,
        kind: "requirement",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: siblingRevision.id,
        elementId: "requirement-2",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Durable audit entries survive a restart.",
          priority: "must",
          risk: "medium",
        },
        payloadHash: "requirement-2-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
  ],
};

/**
 * A three-revision lineage for the diff verb: an approved base, a proposal
 * above it, and a draft above that. The draft's immediate review base (the
 * proposal) and its governance base (the approved ancestor) disagree about the
 * criterion, so a diff that silently swapped one base for the other shows up as
 * a different class rather than as identical output.
 */
const LINEAGE_REVISION_IDS = {
  approved: "lineage-revision-1",
  proposed: "lineage-revision-2",
  draft: "lineage-revision-3",
} as const;

const lineageRevisions: SpecRevision[] = [
  {
    id: LINEAGE_REVISION_IDS.approved,
    specId: spec.id,
    number: 1,
    state: "approved",
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: "lineage-hash-1",
    proposedAt: CREATED_AT,
    approvedAt: CREATED_AT,
    createdAt: CREATED_AT,
  },
  {
    id: LINEAGE_REVISION_IDS.proposed,
    specId: spec.id,
    number: 2,
    state: "proposed",
    authoringStage: "design",
    basedOnRevisionId: LINEAGE_REVISION_IDS.approved,
    contentHash: "lineage-hash-2",
    proposedAt: CREATED_AT,
    approvedAt: null,
    createdAt: CREATED_AT,
  },
  {
    id: LINEAGE_REVISION_IDS.draft,
    specId: spec.id,
    number: 3,
    state: "draft",
    authoringStage: "plan",
    basedOnRevisionId: LINEAGE_REVISION_IDS.proposed,
    contentHash: null,
    proposedAt: null,
    approvedAt: null,
    createdAt: CREATED_AT,
  },
];

const LINEAGE_ELEMENTS = {
  requirement: {
    id: "lineage-requirement-1",
    specId: spec.id,
    kind: "requirement" as const,
    number: 1,
    parentElementId: null,
    createdAt: CREATED_AT,
  },
  criterion: {
    id: "lineage-criterion-1",
    specId: spec.id,
    kind: "criterion" as const,
    number: 1,
    parentElementId: "lineage-requirement-1",
    createdAt: CREATED_AT,
  },
  task: {
    id: "lineage-task-1",
    specId: spec.id,
    kind: "task" as const,
    number: 1,
    parentElementId: null,
    createdAt: CREATED_AT,
  },
  decision: {
    id: "lineage-decision-1",
    specId: spec.id,
    kind: "decision" as const,
    number: 1,
    parentElementId: null,
    createdAt: CREATED_AT,
  },
};

function lineageRow(
  revisionId: string,
  element: SpecRevisionSnapshot["elements"][number]["element"],
  position: number,
  payload: SpecRevisionSnapshot["elements"][number]["version"]["payload"],
  payloadHash: string,
): SpecRevisionSnapshot["elements"][number] {
  return {
    element,
    version: {
      revisionId,
      elementId: element.id,
      position,
      payload,
      payloadHash,
      elementVersion: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
}

const LINEAGE_REQUIREMENT_PAYLOAD = {
  kind: "requirement" as const,
  statement: "Reviewers can read a changelog before hunting.",
  priority: "must" as const,
  risk: "high" as const,
};

const LINEAGE_TASK_PAYLOAD = {
  kind: "task" as const,
  title: "Build the diff verb",
  instructions: "Expose the semantic diff engine through cctl.",
  tracedRequirementElementIds: [LINEAGE_ELEMENTS.requirement.id],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: [LINEAGE_ELEMENTS.criterion.id],
  dependsOnTaskElementIds: [],
};

function lineageCriterionPayload(text: string) {
  return {
    kind: "criterion" as const,
    text,
    validationStrategy: { kinds: ["test_run" as const] },
  };
}

const lineageSnapshots = new Map<string, SpecRevisionSnapshot>([
  [
    LINEAGE_REVISION_IDS.approved,
    {
      revision: lineageRevisions[0]!,
      elements: [
        lineageRow(
          LINEAGE_REVISION_IDS.approved,
          LINEAGE_ELEMENTS.requirement,
          0,
          LINEAGE_REQUIREMENT_PAYLOAD,
          "lineage-requirement-hash",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.approved,
          LINEAGE_ELEMENTS.criterion,
          1,
          lineageCriterionPayload("The changelog names every closure."),
          "lineage-criterion-hash-a",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.approved,
          LINEAGE_ELEMENTS.task,
          2,
          LINEAGE_TASK_PAYLOAD,
          "lineage-task-hash",
        ),
      ],
    },
  ],
  [
    LINEAGE_REVISION_IDS.proposed,
    {
      revision: lineageRevisions[1]!,
      elements: [
        lineageRow(
          LINEAGE_REVISION_IDS.proposed,
          LINEAGE_ELEMENTS.requirement,
          0,
          LINEAGE_REQUIREMENT_PAYLOAD,
          "lineage-requirement-hash",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.proposed,
          LINEAGE_ELEMENTS.criterion,
          1,
          lineageCriterionPayload(
            "The changelog names every closure verbatim.",
          ),
          "lineage-criterion-hash-b",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.proposed,
          LINEAGE_ELEMENTS.task,
          2,
          LINEAGE_TASK_PAYLOAD,
          "lineage-task-hash",
        ),
      ],
    },
  ],
  [
    LINEAGE_REVISION_IDS.draft,
    {
      revision: lineageRevisions[2]!,
      elements: [
        lineageRow(
          LINEAGE_REVISION_IDS.draft,
          LINEAGE_ELEMENTS.requirement,
          0,
          LINEAGE_REQUIREMENT_PAYLOAD,
          "lineage-requirement-hash",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.draft,
          LINEAGE_ELEMENTS.criterion,
          1,
          lineageCriterionPayload(
            "The changelog names every closure verbatim.",
          ),
          "lineage-criterion-hash-b",
        ),
        lineageRow(
          LINEAGE_REVISION_IDS.draft,
          LINEAGE_ELEMENTS.decision,
          2,
          {
            kind: "decision" as const,
            title: "Default to the review base",
            chosenApproach: "Diff the proposal against basedOnRevisionId.",
            reason: "Studio's review cards already diff that pair.",
            rejectedAlternatives: [],
            tracedRequirementElementIds: [LINEAGE_ELEMENTS.requirement.id],
          },
          "lineage-decision-hash",
        ),
      ],
    },
  ],
]);

function createDeps(): SpecRouteDeps {
  return {
    async resolveProjectPath(name) {
      return name === "demo" ? PROJECT_PATH : null;
    },
    async listSpecs() {
      return [spec];
    },
    async resolveSpec(_projectPath, slug) {
      return slug === spec.slug ? spec : null;
    },
    async listAliases() {
      return [];
    },
    async listRevisions() {
      return [revision];
    },
    async getRevisionSnapshot(revisionId) {
      return revisionId === revision.id ? snapshot : null;
    },
    async lintDraft() {
      return [];
    },
    findApprovalsBySpecId() {
      return [] as SpecApprovalRow[];
    },
    findCommentsByRevision() {
      return [];
    },
    findEventsBySpecId() {
      return [];
    },
    findGateAdmissionsBySpecId() {
      return [] as SpecGateAdmissionRow[];
    },
    findLinksBySpecId() {
      return [];
    },
    async getLinkedTickets() {
      return [];
    },
    findQuestionsBySpecId() {
      return [question];
    },
    findAssumptionsBySpecId() {
      return [assumption];
    },
    findExecutionsBySpecId() {
      return [] as SpecExecutionRow[];
    },
    findTaskClaimsBySpecId() {
      return [];
    },
    findWorkflowEventsByExecution() {
      return [];
    },
    async reconcileExecution(_projectPath, execution) {
      // Mirrors production: a linked lane parked at definition review reports
      // the workflow's pre-start status; an unlinked run has no lane at all.
      return {
        execution,
        workflowStatus:
          execution.workflow_execution_id === null
            ? null
            : execution.state === "definition_review"
              ? ("pending" as const)
              : ("running" as const),
      };
    },
    async ingestExecutionEvidenceBestEffort() {},
    findCriterionDispositionsByExecution() {
      return [];
    },
    findEvidenceByCriterionRevision() {
      return [] as SpecEvidenceRow[];
    },
    findProofVerdictsByCriterionRevision() {
      return [] as SpecProofVerdictRow[];
    },
    findWaiverForCriterionRevision() {
      return null;
    },
    findWaiverById() {
      return null;
    },
    findWaiversByRevision() {
      return [] as SpecWaiverRow[];
    },
    async exportSpec() {
      return bundle;
    },
    async verifySpec() {
      return {
        ok: true,
        checkedRevisionIds: [revision.id],
        mismatches: [],
        consistencyFindings: [],
      };
    },
    async measureProject() {
      return computeSpecMeasuresReport([], []);
    },
  };
}

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function makeHost(
  options: {
    files?: Record<string, string>;
    tampered?: boolean;
    measuresSlug?: boolean;
    /** Seed an approved predecessor whose requirements gate was admitted. */
    priorAdmission?: boolean;
    /** Also admit the requirements gate on the amendment being read. */
    currentAdmission?: boolean;
    executions?: readonly SpecExecutionRow[];
    /** Workflow lane status the reconcile read reports, keyed by execution. */
    laneStatus?: Record<
      string,
      "pending" | "running" | "paused" | "completed" | "halted" | "aborted"
    >;
    /** Seed a second spec so project-wide search spans more than one. */
    sibling?: boolean;
    /** Pin the seeded draft at this authoring stage. */
    draftStage?: SpecRevision["authoringStage"];
    /**
     * Point the seeded plan at a criterion id the revision does not carry —
     * the shape an amendment that forked past its own content leaves behind.
     */
    orphanedCoverage?: boolean;
    /** Point the seeded plan at a depended-on task id the revision lost. */
    orphanedDependency?: boolean;
    /**
     * Seed the approved -> proposed -> draft lineage the diff verb reads, so
     * the immediate review base and the governance base are different rows.
     */
    lineage?: boolean;
    /**
     * Strip every task's criterion coverage, which leaves the draft with both
     * halves of the plan-stage lint: a criterion no task covers, and tasks
     * that cover no criterion.
     */
    unplannedCoverage?: boolean;
    /** Seed this many open questions, to overflow the bounded status section. */
    questionCount?: number;
  } = {},
): CliHost & {
  requests: RecordedRequest[];
  written: Map<string, string>;
} {
  const requests: RecordedRequest[] = [];
  const written = new Map<string, string>();
  const baseDeps = createDeps();
  const amendedDraft: SpecRevision = {
    ...revision,
    number: 2,
    basedOnRevisionId: approvedPredecessor.id,
  };
  const stagedRevision: SpecRevision = {
    ...revision,
    ...(options.draftStage === undefined
      ? {}
      : { authoringStage: options.draftStage }),
  };
  const seededSpec = spec;
  const plannedSnapshot: SpecRevisionSnapshot =
    options.unplannedCoverage === true
      ? {
          ...snapshot,
          elements: snapshot.elements.map((row) =>
            row.version.payload.kind === "task"
              ? {
                  ...row,
                  version: {
                    ...row.version,
                    payload: {
                      ...row.version.payload,
                      coveredCriterionElementIds: [],
                    },
                  },
                }
              : row,
          ),
        }
      : snapshot;
  const seededSnapshot: SpecRevisionSnapshot =
    options.orphanedCoverage === true || options.orphanedDependency === true
      ? {
          ...plannedSnapshot,
          elements: plannedSnapshot.elements.map((row) =>
            row.element.id === "task-2" && row.version.payload.kind === "task"
              ? {
                  ...row,
                  version: {
                    ...row.version,
                    payload: {
                      ...row.version.payload,
                      ...(options.orphanedCoverage === true
                        ? {
                            coveredCriterionElementIds: [
                              ...row.version.payload.coveredCriterionElementIds,
                              "criterion-dropped-by-amendment",
                            ],
                          }
                        : {}),
                      ...(options.orphanedDependency === true
                        ? {
                            dependsOnTaskElementIds: [
                              ...row.version.payload.dependsOnTaskElementIds,
                              "task-dropped-by-amendment",
                            ],
                          }
                        : {}),
                    },
                  },
                }
              : row,
          ),
        }
      : plannedSnapshot;
  const handlers = createSpecRouteHandlers({
    ...baseDeps,
    async listSpecs() {
      return options.sibling ? [seededSpec, siblingSpec] : [seededSpec];
    },
    async resolveSpec(_projectPath, slug) {
      if (options.measuresSlug && slug === "measures") {
        return { ...seededSpec, slug: "measures" };
      }
      if (options.sibling && slug === siblingSpec.slug) return siblingSpec;
      return slug === seededSpec.slug ? seededSpec : null;
    },
    async listRevisions(specId) {
      if (options.sibling && specId === siblingSpec.id) {
        return [siblingRevision];
      }
      if (options.lineage) return lineageRevisions;
      return options.priorAdmission
        ? [approvedPredecessor, amendedDraft]
        : [stagedRevision];
    },
    async getRevisionSnapshot(revisionId) {
      if (options.sibling && revisionId === siblingRevision.id) {
        return siblingSnapshot;
      }
      if (options.lineage) return lineageSnapshots.get(revisionId) ?? null;
      if (!options.priorAdmission) {
        return revisionId === revision.id
          ? { ...seededSnapshot, revision: stagedRevision }
          : null;
      }
      if (revisionId === approvedPredecessor.id) {
        return { revision: approvedPredecessor, elements: [] };
      }
      return revisionId === revision.id
        ? { ...seededSnapshot, revision: amendedDraft }
        : null;
    },
    findGateAdmissionsBySpecId() {
      return [
        ...(options.priorAdmission ? [priorRequirementsAdmission] : []),
        ...(options.currentAdmission ? [currentRequirementsAdmission] : []),
      ];
    },
    findExecutionsBySpecId() {
      return [...(options.executions ?? [])];
    },
    findQuestionsBySpecId() {
      const count = options.questionCount;
      if (count === undefined) return [question];
      return Array.from({ length: count }, (_unused, index) => ({
        ...question,
        id: `question-${index + 1}`,
        number: index + 1,
        text: `Open question ${index + 1}?`,
      }));
    },
    // The real deterministic lint over the seeded revision, not a stub: the
    // findings the verb prints and the tier counts have to be the ones
    // production computes, or neither surface proves anything.
    async lintDraft(_specId, lintedRevisionId) {
      if (lintedRevisionId !== revision.id) return [];
      return lint(
        toLintSnapshot(seededSpec, {
          ...seededSnapshot,
          revision: options.priorAdmission ? amendedDraft : stagedRevision,
        }),
        {},
      );
    },
    async reconcileExecution(_projectPath, execution) {
      const base = await baseDeps.reconcileExecution(_projectPath, execution);
      const override = options.laneStatus?.[execution.id];
      return override === undefined
        ? base
        : { ...base, workflowStatus: override };
    },
    async verifySpec() {
      return options.tampered
        ? {
            ok: false,
            checkedRevisionIds: [revision.id],
            mismatches: [
              {
                revisionId: revision.id,
                expectedContentHash: "expected-hash",
                actualContentHash: "tampered-hash",
                mismatchedElementIds: ["requirement-1"],
              },
            ],
            consistencyFindings: [],
          }
        : {
            ok: true,
            checkedRevisionIds: [revision.id],
            mismatches: [],
            consistencyFindings: [],
          };
    },
  });

  return {
    requests,
    written,
    async fetch(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const name = decodeURIComponent(segments[2] ?? "");
      if (segments[1] === "projects" && segments[3] === "spec-measures") {
        return handlers.getSpecMeasuresGET(new Request(url), {
          params: Promise.resolve({ name }),
        });
      }
      const slug = decodeURIComponent(segments[3] ?? "");
      const tail = segments[4];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
      });
      const context = { params: Promise.resolve({ name, slug }) };

      if (slug === "") return handlers.listSpecsGET(request, context);
      // Project-scoped reads sit under the `-` namespace. A static sibling of
      // [slug] would win over it and make a spec of that same slug unreachable;
      // `-` is not a legal slug, so nothing can collide with it.
      if (slug === "-" && tail === "search") {
        return handlers.searchProjectSpecsGET(request, {
          params: Promise.resolve({ name }),
        });
      }
      if (tail === "summary")
        return handlers.getSpecSummaryGET(request, context);
      if (tail === "status") return handlers.getSpecStatusGET(request, context);
      if (tail === "lint") return handlers.getSpecLintGET(request, context);
      if (tail === "elements") {
        return handlers.getSpecElementGET(request, {
          params: Promise.resolve({
            name,
            slug,
            element: decodeURIComponent(segments[5] ?? ""),
          }),
        });
      }
      if (tail === "search") return handlers.searchSpecGET(request, context);
      if (tail === "diff") return handlers.getSpecDiffGET(request, context);
      if (tail === "export") return handlers.getSpecExportGET(request, context);
      if (tail === "verify") return handlers.getSpecVerifyGET(request, context);
      return handlers.getSpecGET(request, context);
    },
    async readTextFile(filePath) {
      return options.files?.[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile(filePath, content) {
      written.set(filePath, content);
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec read verbs against seeded read routes", () => {
  it("keeps the measures project endpoint distinct from a legal measures spec slug", async () => {
    const host = makeHost({ measuresSlug: true });
    const shown = await runCli(
      ["spec", "show", "measures", "--json"],
      baseEnv,
      host,
    );
    const measured = await runCli(
      ["spec", "measures", "--json"],
      baseEnv,
      host,
    );

    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout).spec.spec.slug).toBe("measures");
    expect(measured.exitCode).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/measures",
      "/api/projects/demo/spec-measures",
    ]);
  });

  it("renders every remaining active authoring stage and its concluding gate", async () => {
    const host = makeHost({ draftStage: "requirements" });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    // The stages this spec still walks must be readable here rather than
    // inferred from transitions.ts.
    expect(text.stdout).toContain(
      "remaining authoring stages (draft revision 1 pinned at requirements):",
    );
    expect(text.stdout).toContain(
      "  requirements: dial gate — concluded by propose, human sign-off required",
    );
    expect(text.stdout).toContain(
      "  design: dial gate — concluded by propose, human sign-off required",
    );
    expect(text.stdout).toContain(
      "  next: cctl spec propose native-sdd — human sign-off required; gates consulted: requirements (gate)",
    );
  });

  it("renders plan graph facts in status text", async () => {
    const result = await runCli(
      ["spec", "status", "native-sdd"],
      baseEnv,
      makeHost(),
    );

    expect(result.stdout).toContain("plan tasks:");
    expect(result.stdout).toContain(
      "authoring stage: plan (concluding gate: plan)",
    );
    expect(result.stdout).toContain("T2: Verify the CLI reads");
    expect(result.stdout).toContain("dependencies: T1");
    expect(result.stdout).toContain("lane group: cli");
    expect(result.stdout).toContain("execution lane: cli-surface");
    expect(result.stdout).toContain(
      "touched surfaces: src/cli/commands/spec/read.contract.test.ts",
    );
    expect(result.stdout).toContain("criterion coverage: R1.1");
    // Nothing is unresolvable here, so status must not carry a line about it.
    expect(result.stdout).not.toContain("unresolved criterion ids");
    expect(result.stdout).not.toContain("unresolved dependency ids");
  });

  /**
   * Raw ids for content an amendment dropped cannot enter handle-shaped task
   * fields or make the current revision's ordering and coverage look complete.
   */
  it("keeps orphaned plan references out of handle-shaped status fields", async () => {
    const host = makeHost({
      orphanedCoverage: true,
      orphanedDependency: true,
    });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("unresolved dependency ids:");
    expect(text.stdout).toContain(
      "task-dropped-by-amendment (not in the current revision; excluded from ordering)",
    );
    expect(text.stdout).toContain("unresolved criterion ids:");
    expect(text.stdout).toContain(
      "criterion-dropped-by-amendment (not in the current revision; excluded from coverage)",
    );
    // The ratio says which criteria it counted, so a reader cannot take it for
    // coverage of everything the plan claims.
    expect(text.stdout).toContain("coverage: 1/1 current-revision criteria");
    // The raw id never enters the handle-shaped field.
    expect(text.stdout).not.toContain(
      "criterion coverage: R1.1, criterion-dropped-by-amendment",
    );
    expect(text.stdout).not.toContain(
      "dependencies: T1, task-dropped-by-amendment",
    );
  });

  it("qualifies an executing phase whose executions have launched no workflow lane", async () => {
    const host = makeHost({ executions: [parkedExecution] });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "phase: executing (1 execution parked with no workflow lane launched)",
    );
    // The park is its own line, not something to infer from the gate block.
    expect(text.stdout).toContain(
      "execution-1: definition_review — no workflow lane launched",
    );
    expect(text.stdout).toContain("cctl workflow start workflow-def-1");

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      executions: [
        {
          id: "execution-1",
          state: "definition_review",
          workflowDefinitionId: "workflow-def-1",
          workflowExecutionId: null,
          laneState: "not_launched",
          actsNext: "agent",
        },
      ],
    });
  });

  it("reports a definition-review run whose lane is linked as parked for a human, not running", async () => {
    const host = makeHost({ executions: [definitionApprovalExecution] });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // Linking the lane is what parks the compiled definition for a human, so
    // linkage alone must never be reported as progress.
    expect(text.stdout).not.toMatch(/workflow lanes? running/);
    expect(text.stdout).toContain(
      "phase: executing (1 execution parked awaiting human approval of the compiled definition)",
    );
    expect(text.stdout).toContain(
      "execution-2: definition_review — parked awaiting human approval of the compiled definition (workflow lane workflow-execution-9 is not running); next: a human approves it in Spec Studio",
    );

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      executions: [
        {
          id: "execution-2",
          state: "definition_review",
          workflowDefinitionId: "workflow-def-1",
          workflowExecutionId: "workflow-execution-9",
          laneState: "awaiting_definition_approval",
          actsNext: "human",
        },
      ],
    });
  });

  it("reports a running execution whose workflow lane completed as awaiting the delivering merge", async () => {
    const host = makeHost({
      executions: [runningExecution],
      laneStatus: { "execution-3": "completed" },
    });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // The lane finished; calling it running hides that only the session's
    // delivering merge remains.
    expect(text.stdout).not.toMatch(/workflow lanes? running/);
    expect(text.stdout).toContain(
      "phase: executing (1 workflow lane completed awaiting the delivering merge)",
    );
    expect(text.stdout).toContain(
      "execution-3: running — workflow lane workflow-execution-3 completed; delivery lands when the session's delivering merge publishes",
    );

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      executions: [
        {
          id: "execution-3",
          state: "running",
          workflowStatus: "completed",
          laneState: "merge_pending",
        },
      ],
    });
  });

  it("reports a halted workflow lane as needing attention, not running", async () => {
    const host = makeHost({
      executions: [runningExecution],
      laneStatus: { "execution-3": "halted" },
    });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).not.toMatch(/workflow lanes? running/);
    expect(text.stdout).toContain(
      "phase: executing (1 workflow lane halted awaiting attention)",
    );
    expect(text.stdout).toContain(
      "execution-3: running — workflow lane workflow-execution-3 halted; resolve the halt from the workflow surface, then resume it",
    );
  });

  it("reads executions off the status projection without a second detail request", async () => {
    const host = makeHost({ executions: [definitionApprovalExecution] });
    const result = await runCli(
      ["spec", "status", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/status",
    ]);
  });

  it("reads a gate as pending on the current revision and its earlier admission as history", async () => {
    const host = makeHost({ priorAdmission: true });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "requirements: pending on current revision (gate) — consulted: changed since revision revision-0",
    );
    expect(text.stdout).toContain(
      "    history: admitted on rev 1 by human (basis human_approval)",
    );
    // A prior revision's admission must never read as today's gate state.
    expect(text.stdout).not.toMatch(/requirements: admitted/);
  });

  it("separates the admission that satisfies the current revision from its history", async () => {
    const host = makeHost({ priorAdmission: true, currentAdmission: true });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    // Only the current-revision row explains today's state; the earlier one
    // stays labelled history, with its provenance intact (R24.13).
    expect(text.stdout).toContain(
      "requirements: admitted (gate) — consulted: changed since revision revision-0",
    );
    expect(text.stdout).toContain(
      "    admitted on rev 2 by human (basis human_approval)",
    );
    expect(text.stdout).toContain(
      "    history: admitted on rev 1 by human (basis human_approval)",
    );
  });

  it("prints the whole lint panel grouped by severity, flagging what would block propose", async () => {
    const host = makeHost({ unplannedCoverage: true });
    const text = await runCli(["spec", "lint", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "lint", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // Both halves of the plan-stage lint are readable from the verb itself,
    // before anything is proposed: an author no longer has to trip the propose
    // refusal to learn what the draft owes.
    expect(text.stdout).toContain("R1.1 has no covering task.");
    expect(text.stdout).toContain("T1 covers no acceptance criterion.");
    expect(text.stdout).toContain("T2 covers no acceptance criterion.");
    // Grouped by severity, and the blocking group says what it blocks rather
    // than leaving the caller to decode the severity token.
    expect(text.stdout).toContain("Blocks propose (3) — would block propose:");
    expect(text.stdout).toContain("lint: 3 findings, 3 blocking");

    const envelope = JSON.parse(structured.stdout) as {
      ok: boolean;
      lint: {
        revisionId: string;
        blocking: number;
        total: number;
        counts: Array<{ severity: string; count: number }>;
        groups: Array<{ severity: string; findings: unknown[] }>;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.lint.revisionId).toBe(revision.id);
    expect(envelope.lint.total).toBe(3);
    expect(envelope.lint.blocking).toBe(3);
    expect(envelope.lint.counts).toEqual([
      { severity: "blocks_propose", count: 3 },
    ]);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/lint",
      "/api/specs/demo/native-sdd/lint",
    ]);
  });

  it("summarises lint findings in status and points at the verb for the rest", async () => {
    const host = makeHost({ unplannedCoverage: true });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("lint findings: 3 total, 3 blocking");
    expect(text.stdout).toContain("  blocks_propose: 3");
    expect(text.stdout).toContain("  R1.1: R1.1 has no covering task.");
    expect(text.stdout).toContain("  full panel: cctl spec lint native-sdd");
    // The tier rides the status route's own lint read — status stays one call.
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/status",
    ]);
  });

  it("bounds each enumerated status section and reports what it left out", async () => {
    const host = makeHost({ questionCount: 14 });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    // A spec with a long tail of questions must not push the rest of status
    // out of the reader's window; the omission is stated, not silent.
    expect(text.stdout).toContain(
      "open questions: 14 total, 10 shown, 4 omitted",
    );
    expect(text.stdout).toContain("  Q1: Open question 1?");
    expect(text.stdout).toContain("  Q10: Open question 10?");
    expect(text.stdout).not.toContain("Open question 11?");
    // Sections that fit still state their counts, so the shape never changes
    // between a bounded and an unbounded read.
    // A clean draft still names the verb: the pointer is how a reader learns
    // the full panel exists, which is exactly the reader who has not seen one.
    expect(text.stdout).toContain("lint findings: 0 total, 0 blocking");
    expect(text.stdout).toContain("  full panel: cctl spec lint native-sdd");
    expect(text.stdout).toContain("assumptions: 1 total, 1 shown, 0 omitted");
    expect(text.stdout).toContain("plan tasks: 2 total, 2 shown, 0 omitted");
    expect(text.stdout).toContain(
      "pending subject approvals: 2 total, 2 shown, 0 omitted",
    );
  });

  it("gets question and assumption handles as typed views", async () => {
    const host = makeHost();
    const questionResult = await runCli(
      ["spec", "get", "native-sdd/Q1", "--json"],
      baseEnv,
      host,
    );
    const assumptionResult = await runCli(
      ["spec", "get", "native-sdd", "A1", "--json"],
      baseEnv,
      host,
    );

    expect(questionResult.exitCode).toBe(0);
    expect(JSON.parse(questionResult.stdout).element).toMatchObject({
      kind: "question",
      handle: "Q1",
      question: {
        handle: "Q1",
        text: "Which export format is canonical?",
        status: "open",
        elementId: "requirement-1",
      },
    });
    expect(assumptionResult.exitCode).toBe(0);
    expect(JSON.parse(assumptionResult.stdout).element).toMatchObject({
      kind: "assumption",
      handle: "A1",
      assumption: {
        handle: "A1",
        text: "SQLite remains authoritative.",
        disposition: "proposed",
      },
    });
  });

  it("gets qualified and bare element handles", async () => {
    const host = makeHost();
    const qualified = await runCli(
      ["spec", "get", "native-sdd/R1", "--json"],
      baseEnv,
      host,
    );
    const bare = await runCli(
      ["spec", "get", "native-sdd", "R1", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(qualified.stdout).element.handle).toBe("R1");
    expect(JSON.parse(bare.stdout).element.handle).toBe("R1");
  });

  it("searches requirement text", async () => {
    const result = await runCli(
      ["spec", "search", "native-sdd", "durable", "--json"],
      baseEnv,
      makeHost(),
    );

    expect(JSON.parse(result.stdout).search.results).toEqual([
      expect.objectContaining({ handle: "R1", kind: "requirement" }),
    ]);
    expect(JSON.parse(result.stdout).scope).toBe("spec");
  });

  it("reports slug, title, phase, preset, and a match summary per hit in text", async () => {
    const result = await runCli(
      ["spec", "search", "--all", "durable"],
      baseEnv,
      makeHost({ sibling: true }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "audit-log\tdraft\tfast-path\t1 element match\tAudit Log",
    );
    expect(result.stdout).toContain(
      "native-sdd\tdraft\tcontract-bearing\t1 element match\tNative SDD",
    );
    expect(result.stdout).toContain(
      "  R1\trequirement\tSpecs are durable product objects.",
    );
  });

  it("searches every spec in the project under --all", async () => {
    const host = makeHost({ sibling: true });
    const result = await runCli(
      ["spec", "search", "--all", "durable", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    // Namespaced under `-` so the route cannot shadow a spec slugged "search".
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/-/search",
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.scope).toBe("project");
    expect(envelope.search.results).toEqual([
      expect.objectContaining({
        slug: "audit-log",
        name: "Audit Log",
        preset: "fast-path",
        matchCount: 1,
      }),
      expect.objectContaining({
        slug: "native-sdd",
        name: "Native SDD",
        preset: "contract-bearing",
        matchCount: 1,
      }),
    ]);
  });

  it("refuses --all with a slug, naming both search shapes", async () => {
    const result = await runCli(
      ["spec", "search", "--all", "native-sdd", "durable"],
      baseEnv,
      makeHost({ sibling: true }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cctl spec search --all <query>");
    expect(result.stderr).toContain("cctl spec search <slug> <query>");
  });

  /**
   * The reviewer-facing changelog. Its default pair is not a free choice: Spec
   * Studio's review cards diff the current revision against `basedOnRevisionId`,
   * so a CLI that defaulted to the governance base would classify the same
   * review differently from the surface a human signs off on.
   */
  describe("cctl spec diff", () => {
    async function readDiff(
      args: string[],
      host: CliHost,
    ): Promise<z.infer<typeof specDiffViewSchema>> {
      const result = await runCli(
        ["spec", "diff", "native-sdd", ...args, "--json"],
        baseEnv,
        host,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      return specDiffViewSchema.parse(JSON.parse(result.stdout).diff);
    }

    interface ElementClass {
      classification: string;
      summary: string | null;
    }

    function classesByElement(
      view: z.infer<typeof specDiffViewSchema>,
    ): Record<string, ElementClass> {
      return Object.fromEntries(
        view.elements.map((element) => [
          element.elementId,
          { classification: element.classification, summary: element.summary },
        ]),
      );
    }

    it("prints per-element summaries and the compared pair in human output", async () => {
      const result = await runCli(
        ["spec", "diff", "native-sdd"],
        baseEnv,
        makeHost({ lineage: true }),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("revision 3 (draft)");
      expect(result.stdout).toContain("revision 2 (proposed)");
      expect(result.stdout).toContain(
        "added\tD1\tAdded decision: Default to the review base",
      );
      expect(result.stdout).toContain(
        "removed\tT1\tRemoved task: Build the diff verb",
      );
      expect(result.stdout).toContain("unchanged\tR1.1");
    });

    it("refuses conflicting bases at the route, not only at the CLI", async () => {
      const host = makeHost({ lineage: true });

      const response = await host.fetch(
        `http://cc.test/api/specs/demo/native-sdd/diff?baseline=governance&from=${LINEAGE_REVISION_IDS.approved}`,
        { method: "GET", headers: {} },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "conflicting_baseline",
      });
    });

    it("refuses a revision id that is not part of this spec, naming the flag", async () => {
      const result = await runCli(
        ["spec", "diff", "native-sdd", "--to", "revision-from-another-spec"],
        baseEnv,
        makeHost({ lineage: true }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("revision-from-another-spec");
      expect(result.stderr).toContain("cctl spec show native-sdd");
    });
    it("defaults to the pair Spec Studio diffs and classes it identically", async () => {
      const host = makeHost({ lineage: true });
      const shown = await runCli(
        ["spec", "show", "native-sdd", "--json"],
        baseEnv,
        host,
      );
      expect(shown.exitCode, `${shown.stderr}${shown.stdout}`).toBe(0);
      const detail = specDetailViewSchema.parse(JSON.parse(shown.stdout).spec);
      const current = detail.currentRevision;
      if (current === null) throw new Error("no current revision");
      // Exactly what SpecReviewMode computes from the detail view it renders.
      const studio = diffRevisions(
        detail.baseRevision === null ? [] : toDiffRows(detail.baseRevision),
        toDiffRows(current),
      );
      const studioClasses: Record<string, ElementClass> = Object.fromEntries([
        ...studio.changeList.map((change): [string, ElementClass] => [
          change.elementId,
          { classification: change.change, summary: change.summary },
        ]),
        ...studio.classifications
          .filter((entry) => entry.classification === "unchanged")
          .map((entry): [string, ElementClass] => [
            entry.elementId,
            { classification: "unchanged", summary: null },
          ]),
      ]);

      const view = await readDiff([], host);

      expect(view.to.revisionId).toBe(current.revision.id);
      expect(view.from?.revisionId).toBe(detail.baseRevision?.revision.id);
      expect(view.baseline).toBe("review");
      expect(classesByElement(view)).toEqual(studioClasses);
      // Not vacuous: the seeded pair carries one of every class.
      expect(
        new Set(
          Object.values(studioClasses).map((entry) => entry.classification),
        ),
      ).toEqual(new Set(["added", "removed", "unchanged"]));
    });

    it("switches the base to the nearest approved ancestor only under --baseline governance", async () => {
      const host = makeHost({ lineage: true });

      const review = await readDiff([], host);
      const governance = await readDiff(["--baseline", "governance"], host);

      expect(review.from?.revisionId).toBe(LINEAGE_REVISION_IDS.proposed);
      expect(classesByElement(review)[LINEAGE_ELEMENTS.criterion.id]).toEqual({
        classification: "unchanged",
        summary: null,
      });
      expect(governance.baseline).toBe("governance");
      expect(governance.from?.revisionId).toBe(LINEAGE_REVISION_IDS.approved);
      expect(
        classesByElement(governance)[LINEAGE_ELEMENTS.criterion.id],
      ).toMatchObject({ classification: "modified" });
      // The criterion's change propagates to its requirement, which is itself
      // byte-identical — the engine's rule, reported rather than re-derived.
      expect(
        governance.elements.find(
          (element) => element.elementId === LINEAGE_ELEMENTS.requirement.id,
        ),
      ).toMatchObject({ classification: "modified", directlyChanged: false });
    });

    it("compares explicit revision ids for draft, proposed, and approved targets", async () => {
      const host = makeHost({ lineage: true });

      const toProposed = await readDiff(
        [
          "--from",
          LINEAGE_REVISION_IDS.approved,
          "--to",
          LINEAGE_REVISION_IDS.proposed,
        ],
        host,
      );
      const toApproved = await readDiff(
        ["--to", LINEAGE_REVISION_IDS.approved],
        host,
      );
      const fromApprovedToDraft = await readDiff(
        ["--from", LINEAGE_REVISION_IDS.approved],
        host,
      );

      expect(toProposed.baseline).toBe("explicit");
      expect(toProposed.to.state).toBe("proposed");
      expect(
        classesByElement(toProposed)[LINEAGE_ELEMENTS.criterion.id],
      ).toMatchObject({ classification: "modified" });
      // The root of the lineage has no base at all, so everything it carries
      // is added rather than silently compared against nothing.
      expect(toApproved.from).toBeNull();
      expect(toApproved.to.state).toBe("approved");
      expect(
        new Set(toApproved.elements.map((element) => element.classification)),
      ).toEqual(new Set(["added"]));
      expect(fromApprovedToDraft.to.state).toBe("draft");
      expect(fromApprovedToDraft.from?.revisionId).toBe(
        LINEAGE_REVISION_IDS.approved,
      );
    });

    it("refuses --from with --baseline governance, naming both bases", async () => {
      const host = makeHost({ lineage: true });

      const result = await runCli(
        [
          "spec",
          "diff",
          "native-sdd",
          "--baseline",
          "governance",
          "--from",
          LINEAGE_REVISION_IDS.approved,
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--from");
      expect(result.stderr).toContain("--baseline governance");
      // Refused before the request, so neither base is silently chosen.
      expect(host.requests.some((entry) => entry.url.includes("/diff"))).toBe(
        false,
      );
    });
  });

  /**
   * The default changed on 2026-08-07 (approved compatibility break): a bundle
   * large enough to be worth exporting was never worth pasting into a
   * transcript, so the file is the product and stdout carries only the manifest
   * a reader checks it by.
   */
  describe("cctl spec export", () => {
    const DERIVED_PATH = ".cc/temp/native-sdd-spec-bundle.json";
    const exportSummarySchema = z
      .object({
        ok: z.literal(true),
        path: z.string(),
        revisionCount: z.number(),
        elementCount: z.number(),
        contentHash: z.string(),
      })
      .strict();

    it("writes the bundle to the derived default path", async () => {
      const host = makeHost();

      const result = await runCli(
        ["spec", "export", "native-sdd"],
        baseEnv,
        host,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const written = host.written.get(DERIVED_PATH);
      if (written === undefined) throw new Error("no bundle written");
      expect(JSON.parse(written)).toEqual(bundle);
      expect(result.stdout).toContain(DERIVED_PATH);
    });

    it("writes --out when given and reports that path instead", async () => {
      const host = makeHost();

      const result = await runCli(
        [
          "spec",
          "export",
          "native-sdd",
          "--out",
          "/tmp/native-sdd.json",
          "--json",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const summary = exportSummarySchema.parse(JSON.parse(result.stdout));
      expect(summary).toMatchObject({
        ok: true,
        path: "/tmp/native-sdd.json",
        revisionCount: 1,
        elementCount: 3,
      });
      expect(summary.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(host.written.has(DERIVED_PATH)).toBe(false);
      expect(
        JSON.parse(host.written.get("/tmp/native-sdd.json") ?? "null"),
      ).toEqual(bundle);
    });

    it("inlines the bundle only under --stdout, writing no file", async () => {
      const host = makeHost();

      const result = await runCli(
        ["spec", "export", "native-sdd", "--stdout", "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, bundle });
      expect(host.written.size).toBe(0);
    });

    it("refuses --stdout with --out, naming both destinations", async () => {
      const result = await runCli(
        ["spec", "export", "native-sdd", "--stdout", "--out", "/tmp/x.json"],
        baseEnv,
        makeHost(),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--stdout");
      expect(result.stderr).toContain("--out");
    });
  });

  it("verifies current integrity and an exported representation", async () => {
    const against = "/tmp/native-sdd.json";
    const host = makeHost({ files: { [against]: JSON.stringify(bundle) } });
    const result = await runCli(
      ["spec", "verify", "native-sdd", "--against", against, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      report: { ok: true, checkedRevisionIds: [revision.id] },
      against,
    });
  });

  it("exits 1 with integrity_mismatch for a tampered spec", async () => {
    const result = await runCli(
      ["spec", "verify", "native-sdd", "--json"],
      baseEnv,
      makeHost({ tampered: true }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
      details: { report: { ok: false } },
    });
  });

  // The project-wide search route used to sit beside [slug] as a static
  // `search` segment, which Next resolves first — so this read reached the
  // search handler and got a 200 the detail parser rejected as
  // `invalid_response`. Under the `-` namespace the slug reaches its own route.
  it("reads a spec slugged 'search' as a spec rather than the project search route", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "show", "search", "--json"],
      baseEnv,
      host,
    );

    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/search",
    );
    expect(result.stderr).not.toContain("invalid_response");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Spec not found",
    });
  });

  it("rejects malformed slugs, handles, and --against files before network", async () => {
    const host = makeHost({ files: { "/tmp/bad.json": "not json" } });
    for (const argv of [
      ["spec", "show", "Native-SDD"],
      ["spec", "get", "native-sdd/R0"],
      ["spec", "verify", "native-sdd", "--against", "/tmp/bad.json"],
    ]) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
    }
    expect(host.requests).toHaveLength(0);
  });
});

/**
 * The export -> migrate -> verify contract, persistence-backed (design.md §6):
 * a real pre-narrowing SQLite world, the real 0009 migration, and the real
 * export/verify boundary behind the real routes — not simulated bundles. The
 * frozen legacy seed below matches what an old build persisted; the current
 * build's strict read path cannot load it, which is pinned explicitly and is
 * why the affected spec's OLD bundle is reconstructed from the frozen seed
 * values rather than exported live.
 */
describe("cctl spec verify --against across migration 0009", () => {
  const LEGACY_PROJECT = "/repos/legacy-cli";
  const AFFECTED_SPEC_ID = "spec-affected-cli";
  const CLEAN_SPEC_ID = "spec-clean-cli";
  const AFFECTED_REVISION_ID = "revision-affected-cli";
  const CLEAN_REVISION_ID = "revision-clean-cli";
  const AT = "2026-07-01T00:00:00.000Z";
  const NOTE_MARKER =
    "[migration 0009] Evidence kinds screenshot could not machine-prove this criterion after the vocabulary narrowed; a validator verdict is now required.";

  const LEGACY_CRITERION_PAYLOAD = {
    kind: "criterion",
    text: "The exported bundle stays canonical.",
    validationStrategy: { kinds: ["screenshot"] },
  };

  interface LegacyElement {
    id: string;
    kind: "requirement" | "criterion";
    number: number;
    parentElementId: string | null;
    position: number;
    payload: Record<string, unknown>;
  }

  const AFFECTED_ELEMENTS: LegacyElement[] = [
    {
      id: "requirement-affected",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Legacy strategies narrow without losing integrity.",
        priority: "must",
        risk: "medium",
      },
    },
    {
      id: "criterion-affected",
      kind: "criterion",
      number: 1,
      parentElementId: "requirement-affected",
      position: 1,
      payload: LEGACY_CRITERION_PAYLOAD,
    },
  ];

  const CLEAN_ELEMENTS: LegacyElement[] = [
    {
      id: "requirement-clean",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Untouched specs keep matching their old bundles.",
        priority: "must",
        risk: "low",
      },
    },
    {
      id: "criterion-clean",
      kind: "criterion",
      number: 1,
      parentElementId: "requirement-clean",
      position: 1,
      payload: {
        kind: "criterion",
        text: "The clean bundle round-trips.",
        validationStrategy: { kinds: ["test_run"] },
      },
    },
  ];

  function sha256(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
  }

  function contentHashOf(elements: readonly LegacyElement[]): string {
    return sha256({
      authoringStage: "plan",
      elements: elements.map((element) => ({
        elementId: element.id,
        kind: element.kind,
        number: element.number,
        parentElementId: element.parentElementId,
        position: element.position,
        payload: element.payload,
      })),
    });
  }

  type Db = ReturnType<typeof _createTestDb>;
  const openDbs: Db[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  function seedLegacyCliWorld(): Db {
    const db = _createTestDb({ inMemory: true });
    openDbs.push(db);
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
      LEGACY_PROJECT,
    );
    const insertSpec = db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json,
         abandoned_at, abandoned_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '{"preset":"contract-bearing"}', NULL, NULL, ?, ?)`,
    );
    insertSpec.run(
      AFFECTED_SPEC_ID,
      LEGACY_PROJECT,
      "legacy-evidence",
      "Legacy evidence",
      AT,
      AT,
    );
    insertSpec.run(
      CLEAN_SPEC_ID,
      LEGACY_PROJECT,
      "clean-spec",
      "Clean spec",
      AT,
      AT,
    );
    const insertRevision = db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, authoring_stage, based_on_revision_id,
         content_hash, proposed_at, approved_at, created_at
       ) VALUES (?, ?, 1, 'approved', 'plan', NULL, ?, ?, ?, ?)`,
    );
    insertRevision.run(
      AFFECTED_REVISION_ID,
      AFFECTED_SPEC_ID,
      contentHashOf(AFFECTED_ELEMENTS),
      AT,
      AT,
      AT,
    );
    insertRevision.run(
      CLEAN_REVISION_ID,
      CLEAN_SPEC_ID,
      contentHashOf(CLEAN_ELEMENTS),
      AT,
      AT,
      AT,
    );
    const insertElement = db.prepare(
      `INSERT INTO spec_elements (
         id, spec_id, kind, number, parent_element_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const [specId, revisionId, elements] of [
      [AFFECTED_SPEC_ID, AFFECTED_REVISION_ID, AFFECTED_ELEMENTS],
      [CLEAN_SPEC_ID, CLEAN_REVISION_ID, CLEAN_ELEMENTS],
    ] as const) {
      for (const element of elements) {
        insertElement.run(
          element.id,
          specId,
          element.kind,
          element.number,
          element.parentElementId,
          AT,
        );
        insertVersion.run(
          revisionId,
          element.id,
          element.position,
          stableStringify(element.payload),
          sha256(element.payload),
          AT,
          AT,
        );
      }
    }
    return db;
  }

  function makePersistenceHost(
    db: Db,
    files: Map<string, string>,
  ): CliHost & { written: Map<string, string> } {
    const specs = createSpecsRepo(db, createWriteQueue());
    const review = createSpecReviewRepo(db);
    const exportDeps = {
      specs,
      review,
      delivery: createSpecDeliveryRepo(db),
      // The legacy bundle fixture launches no workflows; verification still
      // reads through the seam so its answer comes from the same shape.
      async observeLinkedWorkflow() {
        return { kind: "missing" as const };
      },
    };
    const handlers = createSpecRouteHandlers({
      ...createDeps(),
      async resolveProjectPath(name) {
        return name === "demo" ? LEGACY_PROJECT : null;
      },
      listSpecs: () => specs.listByProject(LEGACY_PROJECT),
      async resolveSpec(_projectPath, slug) {
        const all = await specs.listByProject(LEGACY_PROJECT);
        return all.find((candidate) => candidate.slug === slug) ?? null;
      },
      async exportSpec(specId) {
        return renderCanonicalBundle(
          await loadSpecExportState(exportDeps, specId),
        );
      },
      async verifySpec(specId) {
        return verifyExportState(await loadSpecExportState(exportDeps, specId));
      },
    });
    const written = new Map<string, string>();
    return {
      written,
      async fetch(url, init) {
        const segments = new URL(url).pathname.split("/").filter(Boolean);
        const name = decodeURIComponent(segments[2] ?? "");
        const slug = decodeURIComponent(segments[3] ?? "");
        const tail = segments[4];
        const request = new Request(url, {
          method: init.method,
          headers: init.headers,
        });
        const context = { params: Promise.resolve({ name, slug }) };
        if (tail === "export") {
          return handlers.getSpecExportGET(request, context);
        }
        if (tail === "verify") {
          return handlers.getSpecVerifyGET(request, context);
        }
        throw new Error(`unexpected route in migration contract test: ${url}`);
      },
      async readTextFile(filePath) {
        return files.get(filePath) ?? null;
      },
      async readFileBytes() {
        return null;
      },
      async writeTextFile(filePath, content) {
        written.set(filePath, content);
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  }

  const bundleShapeSchema = z
    .object({
      markdownFiles: z.array(
        z.object({ path: z.string(), content: z.string() }).strict(),
      ),
      manifest: z.string(),
    })
    .strict();

  const manifestShapeSchema = z
    .object({
      formatVersion: z.number(),
      revisions: z.array(
        z
          .object({
            contentHash: z.string().nullable(),
            elements: z.array(
              z.object({ id: z.string(), payloadHash: z.string() }).loose(),
            ),
          })
          .loose(),
      ),
    })
    .loose();

  /**
   * Reconstruct the bundle an old build exported for the frozen legacy seed.
   * The bundle FORMAT is unchanged by the migration (formatVersion stays 2 —
   * the content changed, not the manifest shape), so the old bytes differ from
   * the current export only where migration 0009 rewrote persisted content:
   * the criterion's strategy payload, its payload hash, and the revision
   * content hash. Every patched value comes from the frozen seed constants
   * and the frozen hash helper — nothing is invented.
   */
  function reconstructPreNarrowingBundle(
    current: CanonicalSpecBundle,
  ): CanonicalSpecBundle {
    const legacyContentHash = contentHashOf(AFFECTED_ELEMENTS);
    const manifest = manifestShapeSchema.parse(JSON.parse(current.manifest));
    expect(manifest.formatVersion).toBe(2);
    const revision = manifest.revisions[0];
    if (revision === undefined) throw new Error("manifest revision missing");
    const migratedContentHash = revision.contentHash;
    if (migratedContentHash === null) throw new Error("content hash missing");
    revision.contentHash = legacyContentHash;
    const criterionEntry = revision.elements.find(
      (element) => element.id === "criterion-affected",
    );
    if (criterionEntry === undefined) throw new Error("criterion missing");
    criterionEntry["payload"] = LEGACY_CRITERION_PAYLOAD;
    criterionEntry.payloadHash = sha256(LEGACY_CRITERION_PAYLOAD);

    const markdownFiles = current.markdownFiles.map((file) => {
      expect(file.content).toContain(
        `Validation strategy: validator_verdict\n\n${NOTE_MARKER}`,
      );
      expect(file.content).toContain(`- Content hash: ${migratedContentHash}`);
      const content = file.content
        .replace(
          `Validation strategy: validator_verdict\n\n${NOTE_MARKER}`,
          "Validation strategy: screenshot",
        )
        .replace(
          `- Content hash: ${migratedContentHash}`,
          `- Content hash: ${legacyContentHash}`,
        );
      expect(content).not.toContain(NOTE_MARKER);
      return { ...file, content };
    });
    return { markdownFiles, manifest: `${stableStringify(manifest)}\n` };
  }

  /**
   * The 2026-08-07 default flip moved the bundle from stdout into a file. The
   * bundle format did not move with it: a file this default writes has to be
   * the same bytes `verify --against` already accepts, or every stored export
   * would read as a mismatch on the next CC build.
   */
  it("accepts the bundle the default export writes, unchanged, at verify --against", async () => {
    const db = seedLegacyCliWorld();
    const files = new Map<string, string>();
    const host = makePersistenceHost(db, files);

    const exported = await runCli(
      ["spec", "export", "clean-spec", "--json"],
      baseEnv,
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(0);
    const summary = z
      .object({
        path: z.string(),
        revisionCount: z.number(),
        elementCount: z.number(),
        contentHash: z.string(),
      })
      .loose()
      .parse(JSON.parse(exported.stdout));
    expect(summary.path).toBe(".cc/temp/clean-spec-spec-bundle.json");
    const written = host.written.get(summary.path);
    if (written === undefined) throw new Error("default export wrote nothing");
    expect(summary.contentHash).toBe(
      `sha256:${createHash("sha256").update(written, "utf-8").digest("hex")}`,
    );
    const manifest = manifestShapeSchema.parse(
      JSON.parse(bundleShapeSchema.parse(JSON.parse(written)).manifest),
    );
    expect(summary.revisionCount).toBe(manifest.revisions.length);
    expect(summary.elementCount).toBe(
      manifest.revisions.reduce(
        (total, revisionEntry) => total + revisionEntry.elements.length,
        0,
      ),
    );

    files.set(summary.path, written);
    const verified = await runCli(
      ["spec", "verify", "clean-spec", "--against", summary.path, "--json"],
      baseEnv,
      host,
    );

    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      against: summary.path,
    });
  });

  it("proves affected old bundles mismatch at exit 1 while unaffected old bundles still match", async () => {
    const db = seedLegacyCliWorld();
    const files = new Map<string, string>();
    const host = makePersistenceHost(db, files);
    const specs = createSpecsRepo(db, createWriteQueue());
    const review = createSpecReviewRepo(db);

    // (1) Export the old bundles. The unaffected spec exports through the
    // real boundary; the affected spec CANNOT — the strict read path refuses
    // pre-narrowing rows, so a current build can never re-render the old
    // bytes. That refusal is the reason its old bundle is reconstructed from
    // the frozen seed after migration.
    const cleanExport = await runCli(
      [
        "spec",
        "export",
        "clean-spec",
        "--out",
        "/tmp/clean-old.json",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(cleanExport.exitCode).toBe(0);
    const oldCleanRaw = host.written.get("/tmp/clean-old.json");
    if (oldCleanRaw === undefined) throw new Error("clean export not written");
    expect(
      manifestShapeSchema.parse(
        JSON.parse(bundleShapeSchema.parse(JSON.parse(oldCleanRaw)).manifest),
      ).formatVersion,
    ).toBe(2);
    await expect(
      loadSpecExportState(
        {
          specs,
          review,
          delivery: createSpecDeliveryRepo(db),
          async observeLinkedWorkflow() {
            return { kind: "missing" as const };
          },
        },
        AFFECTED_SPEC_ID,
      ),
    ).rejects.toThrow();

    // (2) Migrate the persisted state for real.
    await narrowEvidenceKinds.up({
      name: narrowEvidenceKinds.name,
      context: { db, configDir: null },
    });

    // (3) Plain integrity passes post-migration: hashes were recomputed
    // consistently with the rewritten payloads.
    for (const slug of ["legacy-evidence", "clean-spec"]) {
      const verified = await runCli(
        ["spec", "verify", slug, "--json"],
        baseEnv,
        host,
      );
      expect(verified.exitCode).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({
        ok: true,
        report: { ok: true },
      });
    }

    // (4) The affected spec's pre-narrowing bundle mismatches at exit 1: the
    // canonical content genuinely changed under the approved vocabulary
    // migration, and the remedy is re-exporting.
    const affectedExport = await runCli(
      ["spec", "export", "legacy-evidence", "--stdout", "--json"],
      baseEnv,
      host,
    );
    expect(affectedExport.exitCode).toBe(0);
    const currentAffected = bundleShapeSchema.parse(
      JSON.parse(affectedExport.stdout).bundle,
    );
    const oldAffected = reconstructPreNarrowingBundle(currentAffected);
    files.set("/tmp/affected-old.json", JSON.stringify(oldAffected));
    const mismatch = await runCli(
      [
        "spec",
        "verify",
        "legacy-evidence",
        "--against",
        "/tmp/affected-old.json",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(mismatch.exitCode).toBe(1);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      ok: false,
      error: "spec legacy-evidence differs from /tmp/affected-old.json",
      details: { against: "/tmp/affected-old.json" },
    });

    // (5) The unaffected spec's genuinely-old bundle still matches at exit 0
    // — no formatVersion bump falsely invalidates untouched specs.
    files.set("/tmp/clean-old.json", oldCleanRaw);
    const stillMatches = await runCli(
      [
        "spec",
        "verify",
        "clean-spec",
        "--against",
        "/tmp/clean-old.json",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(stillMatches.exitCode).toBe(0);
    expect(JSON.parse(stillMatches.stdout)).toMatchObject({
      ok: true,
      against: "/tmp/clean-old.json",
    });

    // The remedy works: a fresh post-migration export matches itself.
    files.set("/tmp/affected-fresh.json", JSON.stringify(currentAffected));
    const freshMatches = await runCli(
      [
        "spec",
        "verify",
        "legacy-evidence",
        "--against",
        "/tmp/affected-fresh.json",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(freshMatches.exitCode).toBe(0);
  });
});
