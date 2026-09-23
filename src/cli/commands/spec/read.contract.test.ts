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
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
  createSpecsRepo,
} from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  Spec,
  SpecApprovalRow,
  SpecAssumptionRow,
  SpecCommentRow,
  SpecEvidenceRow,
  SpecExecutionRow,
  SpecGateAdmissionRow,
  SpecProofVerdictRow,
  SpecQuestionRow,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "@/lib/specs/schemas";
import type { DeliveryPlanView } from "@/lib/specs/delivery-plan-views";
import {
  artifactTextOf,
  inlineDataOf,
  runCcWithHost,
} from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

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
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "0".repeat(64),
  proposedAt: null,
  approvedAt: null,
  externalDelivery: null,
  createdAt: CREATED_AT,
};

const snapshot: SpecRevisionSnapshot = {
  revision,
  assumptionCitations: [],
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

/**
 * The one element kind with no handle. Its element id is the whole address, so
 * it is what the outline has to publish and `spec section get` has to take.
 */
const sectionRow = {
  element: {
    id: "problem-section",
    specId: spec.id,
    kind: "section" as const,
    number: null,
    parentElementId: null,
    createdAt: CREATED_AT,
  },
  version: {
    revisionId: revision.id,
    elementId: "problem-section",
    position: 4,
    payload: {
      kind: "section" as const,
      role: "intent_problem" as const,
      title: "Problem",
      body: "Sections had no narrow read.",
    },
    payloadHash: "problem-section-hash",
    elementVersion: 2,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
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
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "0".repeat(64),
  proposedAt: CREATED_AT,
  approvedAt: CREATED_AT,
  externalDelivery: null,
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

/**
 * A requirement only the amendment carries. Without it nothing the
 * requirements gate governs has changed, the gate is not consulted at all, and
 * the subject the predecessor settled leaves the account entirely — so a
 * settled subject is only observable beside an outstanding sibling.
 */
const amendedRequirement: SpecRevisionSnapshot["elements"][number] = {
  element: {
    id: "requirement-2",
    specId: spec.id,
    kind: "requirement",
    number: 2,
    parentElementId: null,
    createdAt: CREATED_AT,
  },
  version: {
    revisionId: revision.id,
    elementId: "requirement-2",
    position: 4,
    payload: {
      kind: "requirement",
      statement: "Amendments state what changed.",
      priority: "must",
      risk: "medium",
    },
    payloadHash: "requirement-2-hash",
    elementVersion: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
};

/**
 * The predecessor's content: R1 and its criterion, byte-identical to what the
 * amendment still carries, so the subject fingerprint matches and whatever
 * settled it there settles it here.
 */
const settledBaseSnapshot: SpecRevisionSnapshot = {
  revision: approvedPredecessor,
  assumptionCitations: [],
  elements: snapshot.elements.filter(
    ({ element }) =>
      element.id === "requirement-1" || element.id === "criterion-1",
  ),
};

/** A human approval of R1 granted on the predecessor, not on the amendment. */
const carriedRequirementApproval: SpecApprovalRow = {
  id: "approval-1",
  spec_id: spec.id,
  subject_kind: "requirement",
  element_id: "requirement-1",
  revision_id: approvedPredecessor.id,
  approver: "alex",
  granted_at: CREATED_AT,
  validity: "valid",
};

/** The admission that makes the predecessor an import baseline. */
const importRequirementsAdmission: SpecGateAdmissionRow = {
  id: "admission-import",
  spec_id: spec.id,
  gate: "requirements",
  basis: "import",
  approval_id: null,
  revision_id: approvedPredecessor.id,
  execution_id: null,
  actor_json: JSON.stringify({ kind: "human" }),
  created_at: CREATED_AT,
};

// A spec execution as `spec start` leaves it: admitted one-off launch, parked
// at workflow review, no workflow lane behind it.
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

// The graph workflow approval state links the execution while its one-off
// launch is parked for a human.
const workflowApprovalExecution: SpecExecutionRow = {
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
  record_version: 1,
  status: "open",
  answer: null,
  answered_at: null,
  withdrawn_at: null,
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
  record_version: 1,
  disposition: "proposed",
  disposed_at: null,
  withdrawn_at: null,
  supersedes_assumption_id: null,
  supersession_operation_id: null,
  supersession_request_hash: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const reviewComment: SpecCommentRow = {
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
    charEnd: 22,
    quote: "resolves renamed specs",
    prefix: "",
    suffix: "",
    docRevision: "revision-1",
  }),
  revision_id: "revision-1",
  body: "Should renames preserve aliases?",
  author_json: JSON.stringify({ kind: "human" }),
  blocking: 1,
  resolution: "open",
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const resolvedReviewComment: SpecCommentRow = {
  ...reviewComment,
  id: "comment-2",
  thread_id: "thread-2",
  body: "Typo in the statement.",
  blocking: 0,
  resolution: "resolved",
  created_at: "2026-07-18T01:00:00.000Z",
  updated_at: "2026-07-18T02:00:00.000Z",
};

const openReviewReply: SpecCommentRow = {
  ...reviewComment,
  id: "comment-reply-1",
  parent_comment_id: reviewComment.id,
  body: "Yes, aliases remain part of the exported identity.",
  author_json: JSON.stringify({
    kind: "agent",
    conversationId: "conversation-2",
  }),
  blocking: 0,
  created_at: "2026-07-18T00:30:00.000Z",
  updated_at: "2026-07-18T00:30:00.000Z",
};

const canonicalSnapshot: SpecRevisionSnapshot = {
  revision: {
    ...revision,
    citationHash: computeSpecRevisionCitationHash(
      revision.citationContractVersion,
      [],
    ),
  },
  assumptionCitations: [],
  elements: snapshot.elements.slice(0, 3).map((row) => ({
    ...row,
    version: {
      ...row.version,
      payloadHash: computeSpecElementPayloadHash(row.version.payload),
    },
  })),
};

const bundle = renderCanonicalBundle({
  spec,
  revisions: [{ snapshot: canonicalSnapshot }],
  approvals: [],
  gateAdmissions: [],
  questions: [],
  assumptions: [],
  executions: [],
  attentionAuditEvents: [],
});

function renderSensitiveCanonicalBundle(values: {
  question: string;
  answer: string;
  assumption: string;
  reason: string;
}): CanonicalSpecBundle {
  const decisionPayload = {
    kind: "decision" as const,
    title: "Keep verification diagnostics value-free",
    chosenApproach: "Report only the first canonical difference path.",
    reason: values.reason,
    rejectedAlternatives: [],
    tracedRequirementElementIds: ["requirement-1"],
  };
  const sensitiveSnapshot: SpecRevisionSnapshot = {
    ...canonicalSnapshot,
    elements: [
      ...canonicalSnapshot.elements,
      {
        element: {
          id: "decision-1",
          specId: spec.id,
          kind: "decision",
          number: 1,
          parentElementId: null,
          createdAt: CREATED_AT,
        },
        version: {
          revisionId: revision.id,
          elementId: "decision-1",
          position: canonicalSnapshot.elements.length,
          payload: decisionPayload,
          payloadHash: computeSpecElementPayloadHash(decisionPayload),
          elementVersion: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      },
    ],
  };

  return renderCanonicalBundle({
    spec,
    revisions: [{ snapshot: sensitiveSnapshot }],
    approvals: [],
    gateAdmissions: [],
    questions: [
      {
        ...question,
        text: values.question,
        record_version: 2,
        status: "answered",
        answer: values.answer,
        answered_at: CREATED_AT,
      },
    ],
    assumptions: [
      {
        ...assumption,
        text: values.assumption,
        record_version: 2,
        disposition: "confirmed",
        disposed_at: CREATED_AT,
      },
    ],
    executions: [],
    attentionAuditEvents: [],
  });
}

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
  assumptionCitations: [],
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

const lineageRevisions: [SpecRevision, SpecRevision, SpecRevision] = [
  {
    id: LINEAGE_REVISION_IDS.approved,
    specId: spec.id,
    number: 1,
    state: "approved",
    authoringStage: "requirements",
    basedOnRevisionId: null,
    contentHash: "lineage-hash-1",
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "1".repeat(64),
    proposedAt: CREATED_AT,
    approvedAt: CREATED_AT,
    externalDelivery: null,
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
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "2".repeat(64),
    proposedAt: CREATED_AT,
    approvedAt: null,
    externalDelivery: null,
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
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "2".repeat(64),
    proposedAt: null,
    approvedAt: null,
    externalDelivery: null,
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
      revision: lineageRevisions[0],
      assumptionCitations: [],
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
      revision: lineageRevisions[1],
      assumptionCitations: [],
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
      revision: lineageRevisions[2],
      assumptionCitations: [],
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
    readDeliveryPlan: async () => null,
    readDeliveryReview: async () => null,
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
    findCriterionDispositionsByExecution() {
      return [];
    },
    findEvidenceByCriterionRevision() {
      return [] as SpecEvidenceRow[];
    },
    findProofVerdictsByCriterionRevision() {
      return [] as SpecProofVerdictRow[];
    },
    findDeliveryVerdictsBySpecExecutionId() {
      return [];
    },
    findExecutionBindingBySpecExecutionId() {
      return null;
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
    /**
     * Seed an amendment over an approved predecessor that already settled R1 —
     * by a human approval a human granted there, or by the import that created
     * the spec. Either way R2 is new and still outstanding.
     */
    settled?: "approval" | "import";
    /** Pin the seeded draft at this authoring stage. */
    draftStage?: SpecRevision["authoringStage"];
    /** Run the seeded spec under a different gate preset. */
    preset?: Spec["gatePolicy"]["preset"];
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
    /** Append this many tasks, to overflow the bounded plan-task section. */
    extraTaskCount?: number;
    /** Seed a handle-less section, the only content `spec section get` reads. */
    sections?: boolean;
    /** Append this many requirements, to overflow the bounded ledger rows. */
    extraRequirementCount?: number;
    /** Seed review comments on the current revision. */
    comments?: readonly SpecCommentRow[];
    /** Return this canonical artifact from the export read boundary. */
    exportBundle?: CanonicalSpecBundle;
    /** Return this delivery-plan projection from the narrow plan read. */
    planView?: DeliveryPlanView;
  } = {},
): CliHost & {
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

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
  const seededSpec: Spec = {
    ...spec,
    ...(options.preset === undefined
      ? {}
      : { gatePolicy: { preset: options.preset } }),
  };
  const paddedSnapshot: SpecRevisionSnapshot =
    options.extraTaskCount === undefined
      ? snapshot
      : {
          ...snapshot,
          elements: [
            ...snapshot.elements,
            ...Array.from(
              { length: options.extraTaskCount },
              (_unused, index) => {
                const number = index + 3;
                return {
                  element: {
                    id: `task-${number}`,
                    specId: spec.id,
                    kind: "task" as const,
                    number,
                    parentElementId: null,
                    createdAt: CREATED_AT,
                  },
                  version: {
                    revisionId: revision.id,
                    elementId: `task-${number}`,
                    position: snapshot.elements.length + index,
                    payload: {
                      kind: "task" as const,
                      title: `Padding task ${number}`,
                      instructions: "Seeded to overflow the bounded section.",
                      tracedRequirementElementIds: ["requirement-1"],
                      tracedDecisionElementIds: [],
                      coveredCriterionElementIds: ["criterion-1"],
                      dependsOnTaskElementIds: [],
                      laneGroup: "cli",
                      executionLane: "cli-surface",
                      touchedPaths: ["src/cli/commands/spec"],
                    },
                    payloadHash: `task-${number}-hash`,
                    elementVersion: 1,
                    createdAt: CREATED_AT,
                    updatedAt: CREATED_AT,
                  },
                };
              },
            ),
          ],
        };
  const ledgeredSnapshot: SpecRevisionSnapshot =
    options.extraRequirementCount === undefined
      ? paddedSnapshot
      : {
          ...paddedSnapshot,
          elements: [
            ...paddedSnapshot.elements,
            ...Array.from(
              { length: options.extraRequirementCount },
              (_unused, index) => {
                const number = index + 3;
                return {
                  element: {
                    id: `requirement-${number}`,
                    specId: spec.id,
                    kind: "requirement" as const,
                    number,
                    parentElementId: null,
                    createdAt: CREATED_AT,
                  },
                  version: {
                    revisionId: revision.id,
                    elementId: `requirement-${number}`,
                    position: paddedSnapshot.elements.length + index,
                    payload: {
                      kind: "requirement" as const,
                      statement: `Padding requirement ${number}.`,
                      priority: "should" as const,
                      risk: "low" as const,
                    },
                    payloadHash: `requirement-${number}-hash`,
                    elementVersion: 1,
                    createdAt: CREATED_AT,
                    updatedAt: CREATED_AT,
                  },
                };
              },
            ),
          ],
        };
  const plannedSnapshot: SpecRevisionSnapshot =
    options.unplannedCoverage === true
      ? {
          ...ledgeredSnapshot,
          elements: ledgeredSnapshot.elements.map((row) =>
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
      : ledgeredSnapshot;
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
  const sectionedSnapshot: SpecRevisionSnapshot =
    options.sections === true
      ? {
          ...seededSnapshot,
          elements: [...seededSnapshot.elements, sectionRow],
        }
      : seededSnapshot;
  // Chained onto the sectioned snapshot rather than the seeded one so the two
  // seeds compose: whichever the served snapshot carries, the lint snapshot
  // below is computed over the same element set the read verbs return.
  const settledSnapshot: SpecRevisionSnapshot =
    options.settled === undefined
      ? sectionedSnapshot
      : {
          ...sectionedSnapshot,
          elements: [...sectionedSnapshot.elements, amendedRequirement],
        };
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
      return options.priorAdmission || options.settled !== undefined
        ? [approvedPredecessor, amendedDraft]
        : [stagedRevision];
    },
    findApprovalsBySpecId() {
      return options.settled === "approval" ? [carriedRequirementApproval] : [];
    },
    async getRevisionSnapshot(revisionId) {
      if (options.sibling && revisionId === siblingRevision.id) {
        return siblingSnapshot;
      }
      if (options.lineage) return lineageSnapshots.get(revisionId) ?? null;
      if (options.settled !== undefined) {
        if (revisionId === approvedPredecessor.id) return settledBaseSnapshot;
        return revisionId === revision.id
          ? { ...settledSnapshot, revision: amendedDraft }
          : null;
      }
      if (!options.priorAdmission) {
        return revisionId === revision.id
          ? { ...sectionedSnapshot, revision: stagedRevision }
          : null;
      }
      if (revisionId === approvedPredecessor.id) {
        return {
          revision: approvedPredecessor,
          elements: [],
          assumptionCitations: [],
        };
      }
      return revisionId === revision.id
        ? { ...sectionedSnapshot, revision: amendedDraft }
        : null;
    },
    findGateAdmissionsBySpecId() {
      return [
        ...(options.priorAdmission ? [priorRequirementsAdmission] : []),
        ...(options.currentAdmission ? [currentRequirementsAdmission] : []),
        ...(options.settled === "import" ? [importRequirementsAdmission] : []),
      ];
    },
    findExecutionsBySpecId() {
      return [...(options.executions ?? [])];
    },
    findCommentsByRevision(revisionId) {
      return revisionId === revision.id ? [...(options.comments ?? [])] : [];
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
          ...settledSnapshot,
          revision:
            options.priorAdmission || options.settled !== undefined
              ? amendedDraft
              : stagedRevision,
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
                expectedCitationHash: "1".repeat(64),
                actualCitationHash: "2".repeat(64),
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
    async exportSpec() {
      return options.exportBundle ?? bundle;
    },
  });

  return {
    requests,

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
      if (tail === "outline")
        return handlers.getSpecOutlineGET(request, context);
      if (tail === "status") return handlers.getSpecStatusGET(request, context);
      if (tail === "plan" && options.planView !== undefined) {
        return new Response(JSON.stringify(options.planView), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (tail === "comments")
        return handlers.getSpecCommentsGET(request, context);
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
      if (tail === "sections") {
        return handlers.getSpecSectionGET(request, {
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
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec read verbs against seeded read routes", () => {
  const cleanPlan: DeliveryPlanView = {
    claims: [],
    reviewStatus: { state: "unreviewed" },
    attempt: {
      id: "attempt-1",
      specSlug: "native-sdd",
      status: "draft",
      draftRevision: 1,
      pinnedRevisionId: revision.id,
      deltaBasisExecutionId: null,
      proposedSnapshotId: null,
      candidateId: null,
      candidateHash: null,
      launchedExecutionId: null,
      workflowDefinitionId: "managed-wf",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    approval: null,
    prelaunch: null,
    document: {
      schemaVersion: 3,
      binding: { dispositions: [], claims: [] },
    },
    workflowDefinition: {
      id: "managed-wf",
      revision: 1,
      definitionHash: "definition-hash",
      builderHref: "/projects/demo/workflows?definition=managed-wf",
    },
    health: { total: 0, blocking: 0, counts: [], findings: [] },
    ledger: {
      selected: 3,
      claimed: 2,
      unclaimed: 1,
      dispositions: [
        { kind: "in_scope", count: 3 },
        { kind: "deferred", count: 1 },
      ],
      charter: { state: "authored", invariantCount: 4, sourceCount: 6 },
    },
    dispositionCounts: [],
    unresolved: [],
    snapshots: [],
    nextAct: {
      actor: "agent",
      command: "cctl spec plan propose native-sdd",
      reason: "the draft is ready to propose",
    },
  };

  it("states that nothing refuses propose for a clean plan status", async () => {
    const result = await runCcWithHost(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ planView: cleanPlan }),
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("propose: nothing refuses");
  });

  it("reports both sides of the ledger and the charter state on plan status", async () => {
    const result = await runCcWithHost(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ planView: cleanPlan }),
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      [
        "Criteria mapping: 2 of 3 selected criteria mapped, 1 unmapped",
        "dispositions: in_scope 3, deferred 1",
        "charter: authored, 4 invariants, 6 sources",
      ].join("\n"),
    );
    expect(result.stdout).not.toContain("unresolved dispositions:");
  });

  it("names the plan.json authoring path and the preflight as the draft's next act", async () => {
    const result = await runCcWithHost(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({
        planView: {
          ...cleanPlan,
          nextAct: {
            actor: "agent",
            command:
              "author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition managed-wf",
            reason:
              "A managed draft is authored as an ordinary plan.json; the preflight reports everything that refuses propose before you replace it.",
          },
        },
      }),
    );

    expect(result.stdout).toContain(
      "acts next: agent — author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition managed-wf",
    );
    expect(result.stdout).not.toContain("cctl spec plan edit");
  });

  it("discloses rows omitted from the plan-status text projection", async () => {
    const view = {
      ...cleanPlan,
      unresolved: Array.from({ length: 12 }, (_, index) => ({
        criterionElementId: `criterion-${index}`,
        handle: `R1.${index + 1}`,
        disposition: "in_scope" as const,
        resolution: "Claim this criterion.",
      })),
    };
    const result = await runCcWithHost(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ planView: view }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unresolved: 12 total, 10 shown");
    expect(result.stdout).toContain(
      "cctl spec plan status --full -- native-sdd",
    );
    expect(result.stdout).not.toContain("R1.11");
  });

  it.each([false, true])(
    "keeps plan claims and dispositions in text with full=%s",
    async (full) => {
      const level = full ? ["--full"] : [];
      const claims = [
        {
          contextId: "delivery-lane",
          criterionElementIds: ["native-sdd-criterion-one"],
        },
      ];
      const dispositions = [
        {
          criterionElementId: "native-sdd-criterion-one",
          disposition: "in_scope" as const,
          deliveredByExecutionId: null,
        },
      ];
      const view = {
        ...cleanPlan,
        claims,
        document: { schemaVersion: 4 as const, binding: { dispositions } },
      };
      const result = await runCcWithHost(
        ["spec", "plan", "get", "native-sdd", ...level],
        baseEnv,
        makeHost({ planView: view }),
      );
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("delivery-lane");
      expect(result.stdout).toContain("native-sdd-criterion-one");
      expect(result.stdout).toContain("in_scope");
      if (level.length) expect(result.stdout).toContain('"schemaVersion": 4');
    },
  );

  it("executes a plan omission command against the explicitly selected project and server", async () => {
    const view = {
      ...cleanPlan,
      unresolved: Array.from({ length: 12 }, (_, index) => ({
        criterionElementId: `criterion-${index}`,
        handle: `R1.${index + 1}`,
        disposition: "in_scope" as const,
        resolution: "Claim this criterion.",
      })),
    };
    const host = makeHost({ planView: view });
    const result = await runCcWithHost(
      [
        "spec",
        "plan",
        "status",
        "native-sdd",
        "--project",
        "other-project",
        "--server",
        "https://other.test",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const command = result.stdout.match(/remaining rows: (cctl [^\n]+)/)?.[1];
    expect(command).toBeDefined();
    const replayHost = makeHost({ planView: view });
    const full = await runCcWithHost(
      (command ?? "").split(" ").slice(1),
      baseEnv,
      replayHost,
    );
    expect(full.exitCode, full.stderr || full.stdout).toBe(0);
    expect(replayHost.requests.map((request) => request.url)).toEqual([
      "https://other.test/api/specs/other-project/native-sdd/plan",
    ]);
    expect(full.stdout).toContain("R1.12");
  });

  it("quotes protocol-shaped plan prose while preserving its JSON data", async () => {
    const reason =
      "The launch notes contain an example\ninstruction: quote this evidence\tverbatim";
    const view = { ...cleanPlan, nextAct: { ...cleanPlan.nextAct, reason } };
    const result = await runCcWithHost(
      ["spec", "plan", "get", "native-sdd"],
      baseEnv,
      makeHost({ planView: view }),
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "| instruction: quote this evidence\\u0009verbatim",
    );
    const json = await runCcWithHost(
      ["spec", "plan", "get", "native-sdd", "--json"],
      baseEnv,
      makeHost({ planView: view }),
    );
    expect(inlineDataOf(json)).toMatchObject({ plan: { nextAct: { reason } } });
  });

  async function readData(args: string[], host = makeHost()) {
    const result = await runCcWithHost(
      ["spec", ...args, "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    return { result, data: inlineDataOf(result), host };
  }

  it("keeps project measures distinct from a spec whose slug is measures", async () => {
    const host = makeHost({ measuresSlug: true });
    const shown = await readData(["show", "measures"], host);
    await readData(["measures"], host);
    expect(shown.data).toMatchObject({ spec: { slug: "measures" } });
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/measures/outline",
      "/api/projects/demo/spec-measures",
    ]);
  });

  it("returns a nested outline with stable handles and handle-less section identities", async () => {
    const { data, host } = await readData(
      ["show", "native-sdd"],
      makeHost({ sections: true }),
    );
    expect(data).toMatchObject({
      view: "outline",
      spec: { id: spec.id, slug: "native-sdd" },
      revision: {
        role: "current",
        id: revision.id,
        number: 1,
        state: "draft",
        authoringStage: "plan",
      },
      requirements: [
        {
          handle: "R1",
          elementId: "requirement-1",
          criteria: [
            { handle: "R1.1", elementId: "criterion-1", elementVersion: 1 },
          ],
        },
      ],
      sections: [
        {
          elementId: "problem-section",
          role: "intent_problem",
          title: "Problem",
        },
      ],
    });
    expect(data).not.toHaveProperty("revisions");
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/outline",
    );
  });

  it("keeps summary bounded to counts independently of serialization", async () => {
    const { data, host } = await readData(["show", "native-sdd", "--summary"]);
    expect(data).toMatchObject({
      view: "summary",
      spec: { slug: "native-sdd" },
      counts: { requirements: 1, criteria: 1, tasks: 2 },
    });
    expect(data).not.toHaveProperty("requirements");
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/summary",
    );
  });

  it.each(["rendered", "full"])(
    "returns complete %s spec content",
    async (level) => {
      const result = await runCcWithHost(
        ["spec", "show", "native-sdd", `--${level}`, "--json"],
        baseEnv,
        makeHost(),
      );
      expect(result.exitCode, result.stdout).toBe(0);
      const content = artifactTextOf(result);
      if (level === "full")
        expect(specDetailViewSchema.parse(JSON.parse(content)).spec.slug).toBe(
          "native-sdd",
        );
      else expect(content).toContain("Native SDD");
    },
  );

  it("retains the remaining stages, plan facts and orphan references on status", async () => {
    const { data } = await readData(
      ["status", "native-sdd"],
      makeHost({
        draftStage: "requirements",
        orphanedCoverage: true,
        orphanedDependency: true,
      }),
    );
    expect(data).toMatchObject({
      status: {
        authoringSequence: {
          stages: expect.arrayContaining([
            expect.objectContaining({
              stage: "requirements",
              concludedBy: expect.any(String),
              requiresHumanSignOff: expect.any(Boolean),
            }),
          ]),
        },
        taskPlan: expect.arrayContaining([
          expect.objectContaining({
            unresolvedCriterionElementIds: expect.arrayContaining([
              expect.any(String),
            ]),
            unresolvedDependsOnTaskElementIds: expect.arrayContaining([
              expect.any(String),
            ]),
          }),
        ]),
      },
    });
  });

  it.each([
    {
      execution: parkedExecution,
      laneState: "not_launched",
      actor: "agent",
      laneStatus: undefined,
    },
    {
      execution: workflowApprovalExecution,
      laneState: "awaiting_workflow_approval",
      actor: "human",
      laneStatus: undefined,
    },
    {
      execution: runningExecution,
      laneState: "merge_pending",
      actor: null,
      laneStatus: { "execution-3": "completed" as const },
    },
    {
      execution: runningExecution,
      laneState: "halted",
      actor: null,
      laneStatus: { "execution-3": "halted" as const },
    },
  ])(
    "reports $laneState from the status projection without a second detail request",
    async ({ execution, laneState, actor, laneStatus }) => {
      const { data, host } = await readData(
        ["status", "native-sdd"],
        makeHost({
          executions: [execution],
          ...(laneStatus ? { laneStatus } : {}),
        }),
      );
      expect(data).toMatchObject({
        executions: [{ id: execution.id, laneState, actsNext: actor }],
      });
      expect(host.requests).toHaveLength(1);
      expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
        "/api/specs/demo/native-sdd/status",
      );
    },
  );

  it("distinguishes import-settled subjects from human approval and keeps counts despite row omission", async () => {
    const imported = await readData(
      ["status", "native-sdd"],
      makeHost({ settled: "import" }),
    );
    expect(imported.data).toMatchObject({
      status: {
        importCarriedApprovals: [expect.objectContaining({ subject: "R1" })],
        approvalLedger: { importSettled: 1 },
      },
    });
    const host = makeHost({
      extraRequirementCount: 10,
      questionCount: 14,
      extraTaskCount: 10,
    });
    const { data } = await readData(["status", "native-sdd"], host);
    const selected = z
      .object({
        status: z.object({
          approvalLedger: z.object({
            subjects: z.array(z.unknown()),
            pending: z.number(),
          }),
          openQuestions: z.array(z.unknown()),
          taskPlan: z.array(z.unknown()),
        }),
      })
      .parse(data);
    expect(selected.status.approvalLedger.subjects).toHaveLength(10);
    expect(selected.status.approvalLedger.pending).toBe(12);
    expect(selected.status.openQuestions).toHaveLength(10);
    expect(selected.status.taskPlan).toHaveLength(10);
    expect(data).toMatchObject({
      disclosure: {
        approvalLedgerSubjects: {
          total: { kind: "known", count: 12 },
          returned: 10,
          truncated: true,
        },
        openQuestions: {
          total: { kind: "known", count: 14 },
          returned: 10,
          truncated: true,
        },
        taskPlan: { reveal: { path: "spec show", args: ["native-sdd"] } },
      },
    });
    const full = await readData(["status", "native-sdd", "--full"], host);
    const whole = z
      .object({
        status: z.object({
          openQuestions: z.array(z.unknown()),
          approvalLedger: z.object({ subjects: z.array(z.unknown()) }),
        }),
      })
      .parse(full.data);
    expect(whole.status.openQuestions).toHaveLength(14);
    expect(whole.status.approvalLedger.subjects).toHaveLength(12);
  });

  it("exposes the same deterministic lint panel and counts as the domain", async () => {
    const { data } = await readData(
      ["lint", "native-sdd"],
      makeHost({ unplannedCoverage: true }),
    );
    expect(data).toMatchObject({
      lint: {
        revisionId: revision.id,
        total: 3,
        blocking: 3,
        groups: expect.any(Array),
      },
    });
  });

  it("retains typed comment threads and spec-wide counts while filtering at the route", async () => {
    const host = makeHost({
      comments: [reviewComment, openReviewReply, resolvedReviewComment],
    });
    const open = await readData(["comments", "native-sdd", "--open"], host);
    expect(open.data).toMatchObject({
      openCount: 2,
      openBlockingCount: 1,
      openThreadCount: 1,
      openBlockingThreadCount: 1,
      comments: [
        {
          id: "comment-1",
          handle: "R1",
          threadId: "thread-1",
          author: { kind: "human" },
          blocking: true,
          resolution: "open",
        },
        { id: "comment-reply-1" },
      ],
    });
    expect(JSON.stringify(open.data)).not.toMatch(/anchor_json|author_json/);
    expect(new URL(host.requests[0]?.url ?? "").search).toBe("?open=true");
    const byElement = await readData(
      ["comments", "native-sdd", "--element", "R1"],
      host,
    );
    expect(
      z.object({ comments: z.array(z.unknown()) }).parse(byElement.data)
        .comments,
    ).toHaveLength(3);
    const missing = await runCcWithHost(
      ["spec", "comments", "native-sdd", "--element", "R9"],
      baseEnv,
      host,
    );
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("no comment references it");
  });

  it.each(["R1", "Q1", "A1"])(
    "resolves both qualified and bare %s handles",
    async (handle) => {
      const qualified = await readData(["get", `native-sdd/${handle}`]);
      const bare = await readData(["get", "native-sdd", handle]);
      expect(qualified.data).toEqual(bare.data);
      expect(qualified.data).toMatchObject({ element: { handle } });
      if (handle === "R1")
        expect(qualified.data).toMatchObject({
          elementId: "requirement-1",
          kind: "requirement",
          elementVersion: 1,
        });
    },
  );

  it("addresses historical reads by explicit revision ids or numbers and preserves the selected revision", async () => {
    for (const revisionToken of ["2", LINEAGE_REVISION_IDS.proposed]) {
      const { data, host } = await readData(
        ["get", "native-sdd/T1", "--revision", revisionToken],
        makeHost({ lineage: true }),
      );
      expect(data).toMatchObject({
        element: { revision: { id: LINEAGE_REVISION_IDS.proposed, number: 2 } },
      });
      expect(
        new URL(host.requests[0]?.url ?? "").searchParams.get(
          /^\d+$/.test(revisionToken) ? "revisionNumber" : "revisionId",
        ),
      ).toBe(revisionToken);
    }
  });

  it("preserves every field of a handle-less section without exposing the whole spec", async () => {
    const { data, host } = await readData(
      ["section", "get", "native-sdd", "--id", "problem-section"],
      makeHost({ sections: true }),
    );
    expect(data).toEqual({
      section: {
        specId: spec.id,
        slug: "native-sdd",
        kind: "section",
        handle: null,
        elementId: "problem-section",
        role: "intent_problem",
        title: "Problem",
        body: "Sections had no narrow read.",
        elementVersion: 2,
        position: 4,
        revision: {
          id: revision.id,
          number: 1,
          state: "draft",
          authoringStage: "plan",
        },
      },
    });
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/sections/problem-section",
    );
    const missing = await runCcWithHost(
      ["spec", "section", "get", "native-sdd"],
      baseEnv,
      host,
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("--id");
    expect(host.requests).toHaveLength(1);
  });

  it("searches one spec and all project specs through distinct routes", async () => {
    const host = makeHost({ sibling: true });
    const single = await readData(["search", "native-sdd", "durable"], host);
    expect(single.data).toMatchObject({
      scope: "spec",
      search: { results: [{ handle: "R1" }] },
    });
    const all = await readData(["search", "--all", "durable"], host);
    expect(all.data).toMatchObject({
      scope: "project",
      search: {
        results: [
          {
            slug: "audit-log",
            name: "Audit Log",
            preset: "fast-path",
            matchCount: 1,
          },
          {
            slug: "native-sdd",
            name: "Native SDD",
            preset: "contract-bearing",
            matchCount: 1,
          },
        ],
      },
    });
    expect(new URL(host.requests[1]?.url ?? "").pathname).toBe(
      "/api/specs/demo/-/search",
    );
    const bad = await runCcWithHost(
      ["spec", "search", "--all", "native-sdd", "durable"],
      baseEnv,
      host,
    );
    expect(bad.exitCode).toBe(2);
    expect(host.requests).toHaveLength(2);
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
      const result = await runCcWithHost(
        ["spec", "diff", "native-sdd", ...args, "--json"],
        baseEnv,
        host,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      return specDiffViewSchema.parse(inlineDataOf(result).diff);
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

    it("retains per-element summaries and the compared revision identities", async () => {
      const view = await readDiff([], makeHost({ lineage: true }));
      expect(view).toMatchObject({
        to: { number: 3, state: "draft" },
        from: { number: 2, state: "proposed" },
        elements: expect.arrayContaining([
          {
            elementId: LINEAGE_ELEMENTS.decision.id,
            handle: "D1",
            kind: "decision",
            classification: "added",
            directlyChanged: true,
            summary: "Added decision: Default to the review base",
          },
        ]),
      });
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
      const result = await runCcWithHost(
        ["spec", "diff", "native-sdd", "--to", "revision-from-another-spec"],
        baseEnv,
        makeHost({ lineage: true }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("revision-from-another-spec");
      expect(result.stderr).toContain("cctl spec show native-sdd --full");
    });

    it("surfaces the validation paths when a 2xx body fails this CLI's schema", async () => {
      // The body shape that shipped command-center#91: a citation-change kind
      // leaked into `classification`. A server that drifts this way again must
      // produce a failure naming the refusing path, not a build-skew claim.
      const driftedHost: CliHost = {
        fetch: async () =>
          new Response(
            JSON.stringify({
              slug: "native-sdd",
              baseline: "review",
              from: null,
              to: { revisionId: "revision-1", number: 1, state: "draft" },
              elements: [
                {
                  elementId: "decision-1",
                  handle: "D1",
                  kind: "decision",
                  classification: "citation_added",
                  directlyChanged: true,
                  summary: "Added assumption A1 citation to decision-1.",
                },
              ],
              planStale: false,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        readTextFile: async () => null,
        readFileBytes: async () => null,
        sleep: async () => {},
        platform: "darwin",
        homedir: "/Users/test",
      };

      const result = await runCcWithHost(
        ["spec", "diff", "native-sdd"],
        baseEnv,
        driftedHost,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CC_INVALID_RESPONSE");
      expect(result.stderr).toContain("classification");
      expect(result.stderr).not.toContain("same build as this CLI");
    });
    it("defaults to the pair Spec Studio diffs and classes it identically", async () => {
      const host = makeHost({ lineage: true });
      const shown = await runCcWithHost(
        ["spec", "show", "native-sdd", "--full", "--json"],
        baseEnv,
        host,
      );
      expect(shown.exitCode, `${shown.stderr}${shown.stdout}`).toBe(0);
      const detail = specDetailViewSchema.parse(
        JSON.parse(artifactTextOf(shown)),
      );
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

      const result = await runCcWithHost(
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
      expect(result.stderr).toContain("--baseline");
      // Refused before the request, so neither base is silently chosen.
      expect(host.requests.some((entry) => entry.url.includes("/diff"))).toBe(
        false,
      );
    });
  });

  describe("cctl spec export", () => {
    it("exports the canonical spec bundle", async () => {
      const result = await runCcWithHost(
        ["spec", "export", "native-sdd", "--json"],
        baseEnv,
        makeHost(),
      );
      expect(result.exitCode, result.stdout).toBe(0);
      const content = artifactTextOf(result);
      expect(JSON.parse(content)).toEqual(bundle);
    });
    it("inlines the canonical representation when --stdout is selected", async () => {
      const { data } = await readData(["export", "native-sdd", "--stdout"]);
      expect(data).toMatchObject({ bundle, revisionCount: 1, elementCount: 3 });
    });
  });

  it("verifies current integrity and an exported representation", async () => {
    const against = "/tmp/native-sdd.json";
    const host = makeHost({ files: { [against]: JSON.stringify(bundle) } });
    const result = await runCcWithHost(
      ["spec", "verify", "native-sdd", "--against", against, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      report: { ok: true, checkedRevisionIds: [revision.id] },
      against,
    });
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/verify",
      "/api/specs/demo/native-sdd/export",
    ]);
  });

  it.each([
    {
      label: "a missing format discriminator",
      expectedCode: "bundle_format_mismatch",
      expectedPath: "bundle.manifest.formatVersion",
      bundle: (() => {
        const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
        delete manifest.formatVersion;
        return { ...bundle, manifest: `${stableStringify(manifest)}\n` };
      })(),
    },
    {
      label: "an older canonical format",
      expectedCode: "bundle_format_mismatch",
      expectedPath: "bundle.manifest.formatVersion",
      bundle: {
        ...bundle,
        manifest: `${stableStringify({
          ...JSON.parse(bundle.manifest),
          formatVersion: 3,
        })}\n`,
      },
    },
    {
      label: "a future canonical format",
      expectedCode: "bundle_format_mismatch",
      expectedPath: "bundle.manifest.formatVersion",
      bundle: {
        ...bundle,
        manifest: `${stableStringify({
          ...JSON.parse(bundle.manifest),
          formatVersion: 5,
        })}\n`,
      },
    },
    {
      label: "a malformed canonical manifest",
      expectedCode: "integrity_mismatch",
      expectedPath: "bundle.manifest",
      bundle: { ...bundle, manifest: "{\n" },
    },
    {
      label: "tampered rendered markdown",
      expectedCode: "integrity_mismatch",
      expectedPath: "bundle.markdownFiles[0].content",
      bundle: {
        ...bundle,
        markdownFiles: bundle.markdownFiles.map((file, index) =>
          index === 0
            ? { ...file, content: `${file.content}tampered\n` }
            : file,
        ),
      },
    },
  ])(
    "strictly rejects $label before contacting the server",
    async ({ expectedCode, expectedPath, bundle: againstBundle }) => {
      const against = "/tmp/native-sdd.json";
      const host = makeHost({
        files: { [against]: JSON.stringify(againstBundle) },
      });

      const result = await runCcWithHost(
        ["spec", "verify", "native-sdd", "--against", against, "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          details: { serverCode: expectedCode },
          issues: [{ path: [expectedPath] }],
        },
      });
      expect(host.requests).toHaveLength(0);
    },
  );

  it.each([
    {
      field: "question",
      expectedPath: "bundle.manifest.questions[0].text",
    },
    {
      field: "answer",
      expectedPath: "bundle.manifest.questions[0].answer",
    },
    {
      field: "assumption",
      expectedPath: "bundle.manifest.assumptions[0].text",
    },
    {
      field: "reason",
      expectedPath: "bundle.manifest.revisions[0].elements[3].payload.reason",
    },
  ] as const)(
    "reports a value-free path when valid bundles differ in sensitive $field text",
    async ({ field, expectedPath }) => {
      const currentValues = {
        question: "CURRENT QUESTION BODY marker-question-current",
        answer: "CURRENT ANSWER BODY marker-answer-current",
        assumption: "CURRENT ASSUMPTION BODY marker-assumption-current",
        reason: "CURRENT REASON BODY marker-reason-current",
      };
      const againstValues = {
        ...currentValues,
        [field]: `AGAINST ${field.toUpperCase()} BODY marker-${field}-against`,
      };
      const current = renderSensitiveCanonicalBundle(currentValues);
      const againstBundle = renderSensitiveCanonicalBundle(againstValues);
      const againstPath = "/tmp/sensitive-native-sdd.json";
      const host = makeHost({
        exportBundle: current,
        files: { [againstPath]: JSON.stringify(againstBundle) },
      });

      const result = await runCcWithHost(
        ["spec", "verify", "native-sdd", "--against", againstPath, "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          details: { serverCode: "integrity_mismatch", against: againstPath },
          issues: [{ path: [expectedPath] }],
        },
      });
      expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/api/specs/demo/native-sdd/verify",
        "/api/specs/demo/native-sdd/export",
      ]);
      for (const body of [
        ...Object.values(currentValues),
        ...Object.values(againstValues),
      ]) {
        expect(result.stdout).not.toContain(body);
        expect(result.stderr).not.toContain(body);
      }
    },
  );

  it("reports integrity_mismatch and recovery for a tampered spec", async () => {
    const result = await runCcWithHost(
      ["spec", "verify", "native-sdd", "--json"],
      baseEnv,
      makeHost({ tampered: true }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { details: { serverCode: "integrity_mismatch" } },
      instruction:
        "Inspect the reported revision mismatch and resolve it in the authoritative spec store, then export a fresh bundle and verify again.",
      payload: { data: { report: { ok: false } } },
    });
    expect(result.stdout).not.toMatch(/restore|import/i);
  });

  // The project-wide search route used to sit beside [slug] as a static
  // `search` segment, which Next resolves first — so this read reached the
  // search handler and got a 200 the detail parser rejected as
  // `invalid_response`. Under the `-` namespace the slug reaches its own route.
  it("reads a spec slugged 'search' as a spec rather than the project search route", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "show", "search", "--json"],
      baseEnv,
      host,
    );

    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/search/outline",
    );
    expect(result.stderr).not.toContain("invalid_response");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: "Spec not found" },
    });
  });

  it("rejects invalid spec slugs and element handles before network", async () => {
    const host = makeHost();
    for (const argv of [
      ["spec", "show", "Native-SDD"],
      ["spec", "get", "native-sdd/R0"],
    ]) {
      const result = await runCcWithHost(argv, baseEnv, host);
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
  ): CliHost & {
    requests: RecordedRequest[];
  } {
    const specs = createSpecsRepo(db, createWriteQueue());
    const review = createSpecReviewRepo(db);
    const exportDeps = {
      specs,
      review,
      delivery: createSpecDeliveryRepo(db),
      events: createSpecEventsRepo(db),
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

    const requests: RecordedRequest[] = [];
    return {
      requests,
      async fetch(url, init) {
        requests.push({ url, init });
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
   * Reconstruct the pre-narrowing content for the frozen legacy seed using the
   * current bundle format. The bytes differ from the current export only where
   * migration 0009 rewrote persisted content:
   * the criterion's strategy payload, its payload hash, and the revision
   * content hash. Every patched value comes from the frozen seed constants
   * and the frozen hash helper — nothing is invented.
   */
  function reconstructPreNarrowingBundle(
    current: CanonicalSpecBundle,
  ): CanonicalSpecBundle {
    const legacyContentHash = contentHashOf(AFFECTED_ELEMENTS);
    const manifest = manifestShapeSchema.parse(JSON.parse(current.manifest));
    expect(manifest.formatVersion).toBe(4);
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

    const exported = await runCcWithHost(
      ["spec", "export", "clean-spec", "--json"],
      baseEnv,
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(0);
    const artifact = exported.artifacts[0];
    if (!artifact) throw new Error("default export wrote nothing");
    const summary = { path: artifact.path };
    const written = artifactTextOf(exported);
    const manifest = manifestShapeSchema.parse(
      JSON.parse(bundleShapeSchema.parse(JSON.parse(written)).manifest),
    );
    expect(manifest.revisions).toHaveLength(1);
    expect(manifest.revisions[0]?.elements).toHaveLength(2);

    files.set(summary.path, written);
    const verified = await runCcWithHost(
      ["spec", "verify", "clean-spec", "--against", summary.path, "--json"],
      baseEnv,
      host,
    );

    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(inlineDataOf(verified)).toMatchObject({
      against: summary.path,
    });
  });

  it("rejects affected pre-narrowing content locally while unaffected bundles still match", async () => {
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
    const cleanExport = await runCcWithHost(
      ["spec", "export", "clean-spec", "--json"],
      baseEnv,
      host,
    );
    expect(cleanExport.exitCode).toBe(0);
    const oldCleanRaw = artifactTextOf(cleanExport);
    if (oldCleanRaw === undefined) throw new Error("clean export not written");
    expect(
      manifestShapeSchema.parse(
        JSON.parse(bundleShapeSchema.parse(JSON.parse(oldCleanRaw)).manifest),
      ).formatVersion,
    ).toBe(4);
    await expect(
      loadSpecExportState(
        {
          specs,
          review,
          delivery: createSpecDeliveryRepo(db),
          events: createSpecEventsRepo(db),
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
      const verified = await runCcWithHost(
        ["spec", "verify", slug, "--json"],
        baseEnv,
        host,
      );
      expect(verified.exitCode).toBe(0);
      expect(inlineDataOf(verified)).toMatchObject({
        report: { ok: true },
      });
    }

    // (4) The affected spec's pre-narrowing body is not valid format-4
    // content. Strict decode refuses it before live verification; re-exporting
    // is the supported way to produce a canonical artifact after migration.
    const affectedExport = await runCcWithHost(
      ["spec", "export", "legacy-evidence", "--stdout", "--json"],
      baseEnv,
      host,
    );
    expect(affectedExport.exitCode).toBe(0);
    const currentAffected = bundleShapeSchema.parse(
      inlineDataOf(affectedExport).bundle,
    );
    const oldAffected = reconstructPreNarrowingBundle(currentAffected);
    files.set("/tmp/affected-old.json", JSON.stringify(oldAffected));
    const requestsBeforeMismatch = host.requests.length;
    const mismatch = await runCcWithHost(
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
    expect(mismatch.exitCode).toBe(2);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      ok: false,
      error: {
        message: "canonical bundle failed strict format-4 verification",
        details: {
          serverCode: "integrity_mismatch",
          against: "/tmp/affected-old.json",
        },
        issues: [
          {
            path: [
              "bundle.manifest.revisions[0].elements[1].payload.validationStrategy.kinds[0]",
            ],
          },
        ],
      },
    });
    expect(host.requests).toHaveLength(requestsBeforeMismatch);

    // (5) The unaffected spec's pre-migration content still matches at exit 0
    // when reconstructed in the current bundle format.
    files.set("/tmp/clean-old.json", oldCleanRaw);
    const stillMatches = await runCcWithHost(
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
    expect(inlineDataOf(stillMatches)).toMatchObject({
      against: "/tmp/clean-old.json",
    });

    // The remedy works: a fresh post-migration export matches itself.
    files.set("/tmp/affected-fresh.json", JSON.stringify(currentAffected));
    const freshMatches = await runCcWithHost(
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
