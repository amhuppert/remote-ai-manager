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
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";
import { SPEC_SHOW_STDOUT_BUDGET_BYTES } from "./read";

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

const lineageRevisions: SpecRevision[] = [
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
      revision: lineageRevisions[0]!,
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
      revision: lineageRevisions[1]!,
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
      revision: lineageRevisions[2]!,
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
    /** Pad each seeded question, to overflow the status stdout budget. */
    questionTextBytes?: number;
    /** Append this many tasks, to overflow the bounded plan-task section. */
    extraTaskCount?: number;
    /** Seed a handle-less section, the only content `spec section get` reads. */
    sections?: boolean;
    /** Append this many requirements, to overflow the bounded ledger rows. */
    extraRequirementCount?: number;
    /** Seed review comments on the current revision. */
    comments?: readonly SpecCommentRow[];
    /** Inflate one element past the known cctl stdout pipe ceiling. */
    largeBodyBytes?: number;
    /** Inflate display metadata without changing the canonical slug. */
    specNameBytes?: number;
    /** Return this canonical artifact from the export read boundary. */
    exportBundle?: CanonicalSpecBundle;
    /** Return this delivery-plan projection from the narrow plan read. */
    planView?: DeliveryPlanView;
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
  const seededSpec: Spec = {
    ...spec,
    ...(options.specNameBytes === undefined
      ? {}
      : { name: "n".repeat(options.specNameBytes) }),
    ...(options.preset === undefined
      ? {}
      : { gatePolicy: { preset: options.preset } }),
  };
  const contentSnapshot: SpecRevisionSnapshot =
    options.largeBodyBytes === undefined
      ? snapshot
      : {
          ...snapshot,
          elements: snapshot.elements.map((row) =>
            row.version.payload.kind === "requirement"
              ? {
                  ...row,
                  version: {
                    ...row.version,
                    payload: {
                      ...row.version.payload,
                      statement: "x".repeat(options.largeBodyBytes ?? 0),
                    },
                  },
                }
              : row,
          ),
        };
  const paddedSnapshot: SpecRevisionSnapshot =
    options.extraTaskCount === undefined
      ? contentSnapshot
      : {
          ...contentSnapshot,
          elements: [
            ...contentSnapshot.elements,
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
                    position: contentSnapshot.elements.length + index,
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
      const padding = "y".repeat(options.questionTextBytes ?? 0);
      return Array.from({ length: count }, (_unused, index) => ({
        ...question,
        id: `question-${index + 1}`,
        number: index + 1,
        text: `Open question ${index + 1}?${padding}`,
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
    async writeTextFile(filePath, content) {
      written.set(filePath, content);
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
    const result = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ planView: cleanPlan }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("propose: nothing refuses");
  });

  it("reports both sides of the ledger and the charter state on plan status", async () => {
    const result = await runCli(
      ["spec", "plan", "status", "native-sdd"],
      baseEnv,
      makeHost({ planView: cleanPlan }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      [
        "coverage: 2 of 3 selected criteria covered, 1 uncovered",
        "dispositions: in_scope 3, deferred 1",
        "charter: authored, 4 invariants, 6 sources",
      ].join("\n"),
    );
    expect(result.stdout).not.toContain("unresolved dispositions:");
  });

  it("names the plan.json authoring path and the preflight as the draft's next act", async () => {
    const result = await runCli(
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

  it("refuses a preview without a stage using only direct-plan next acts", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "plan", "preview", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "--stage draft or --stage proposed is required",
    );
    expect(result.stderr).toContain(
      "cctl spec plan preview native-sdd --stage draft",
    );
    expect(result.stderr).not.toMatch(
      /compiler|materializer|context pack|proofPlan|wiring|--seed-from/i,
    );
    expect(host.requests).toHaveLength(0);
  });

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
    expect(JSON.parse(shown.stdout).spec.slug).toBe("measures");
    expect(measured.exitCode).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/measures/outline",
      "/api/projects/demo/spec-measures",
    ]);
  });

  it("defaults to a bounded nested outline in text and JSON", async () => {
    const host = makeHost();
    const text = await runCli(["spec", "show", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "show", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("native-sdd\trevision 1\tdraft\tplan");
    expect(text.stdout).toContain("R1");
    expect(text.stdout).toContain("  R1.1");
    expect(text.stdout).toContain("next: cctl spec show native-sdd --rendered");
    expect(text.stdout).not.toContain('"revisions"');

    const envelope = JSON.parse(structured.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "spec show",
      view: "outline",
      storage: "inline",
      spec: { id: spec.id, slug: "native-sdd", name: "Native SDD" },
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
      disclosure: {
        next: "cctl spec show native-sdd --rendered",
      },
    });
    expect(envelope).not.toHaveProperty("revisions");
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/outline",
      "/api/specs/demo/native-sdd/outline",
    ]);
  });

  it("publishes outline section ids with the read that reaches one", async () => {
    const host = makeHost({ sections: true });
    const text = await runCli(["spec", "show", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "show", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode, text.stderr).toBe(0);
    // The element id is the whole point: without it in text mode the verb the
    // disclosure names cannot be run from what `spec show` printed.
    expect(text.stdout).toContain(
      "problem-section\tsection\tintent_problem\tProblem",
    );
    expect(text.stdout).toContain(
      "sections: 1 total, 1 returned, truncated=no, next: cctl spec section get native-sdd --id <element-id>",
    );

    expect(JSON.parse(structured.stdout).sections).toEqual([
      {
        elementId: "problem-section",
        role: "intent_problem",
        title: "Problem",
        position: 4,
        elementVersion: 2,
      },
    ]);
  });

  it("spills an outline whose exact identities exceed the stdout budget", async () => {
    const jsonHost = makeHost({ specNameBytes: 80 * 1024 });
    const structured = await runCli(
      ["spec", "show", "native-sdd", "--json"],
      baseEnv,
      jsonHost,
    );
    const receipt = JSON.parse(structured.stdout);

    expect(structured.exitCode).toBe(0);
    expect(Buffer.byteLength(structured.stdout, "utf8")).toBeLessThan(
      SPEC_SHOW_STDOUT_BUDGET_BYTES,
    );
    expect(receipt).toMatchObject({
      ok: true,
      command: "spec show",
      view: "outline",
      storage: "artifact",
      reason: "stdout_budget_exceeded",
      artifact: {
        path: expect.stringMatching(
          /^\.cc\/temp\/spec-outline-[a-f0-9]{12}\.json$/,
        ),
        format: "json",
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(receipt).not.toHaveProperty("spec");
    const artifact = jsonHost.written.get(receipt.artifact.path) ?? "";
    const inline = JSON.parse(artifact);
    expect(inline).toMatchObject({
      command: "spec show",
      view: "outline",
      storage: "inline",
      spec: { slug: "native-sdd" },
    });
    expect(inline.spec.name).toHaveLength(80 * 1024);
    expect(receipt.artifact.bytes).toBe(Buffer.byteLength(artifact, "utf8"));
    expect(receipt.artifact.sha256).toBe(
      `sha256:${createHash("sha256").update(artifact, "utf8").digest("hex")}`,
    );

    const textHost = makeHost({ specNameBytes: 80 * 1024 });
    const textResult = await runCli(
      ["spec", "show", "native-sdd"],
      baseEnv,
      textHost,
    );
    expect(textResult.exitCode).toBe(0);
    expect(Buffer.byteLength(textResult.stdout, "utf8")).toBeLessThan(
      SPEC_SHOW_STDOUT_BUDGET_BYTES,
    );
    expect(textResult.stdout).toContain("stdout budget exceeded");
    expect([...textHost.written.keys()]).toEqual([receipt.artifact.path]);
  });

  it("keeps summary as counts and JSON as serialization rather than depth", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "show", "native-sdd", "--summary", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "spec show",
      view: "summary",
      storage: "inline",
      spec: { slug: "native-sdd" },
      counts: { requirements: 1, criteria: 1, decisions: 0, tasks: 2 },
      delivery: { deliveredExternallyCount: 0 },
      disclosure: {
        requirements: { total: 1, returned: 0, truncated: true },
        criteria: { total: 1, returned: 0, truncated: true },
        decisions: { total: 0, returned: 0, truncated: false },
        tasks: { total: 2, returned: 0, truncated: true },
        next: "cctl spec show native-sdd",
      },
    });
    expect(envelope.delivery).not.toHaveProperty(
      "deliveredExternallyCriterionIds",
    );
    const summaryRequest = host.requests.at(0);
    expect(summaryRequest).toBeDefined();
    expect(new URL(summaryRequest?.url ?? "http://cc.invalid").pathname).toBe(
      "/api/specs/demo/native-sdd/summary",
    );

    const text = await runCli(
      ["spec", "show", "native-sdd", "--summary"],
      baseEnv,
      makeHost(),
    );
    expect(text.stdout).toContain(
      "requirements: 1 total, 0 returned, truncated=yes",
    );
    expect(text.stdout).toContain("next: cctl spec show native-sdd");
  });

  it("writes rendered and full reads to files and returns bounded receipts", async () => {
    const renderedHost = makeHost();
    const rendered = await runCli(
      ["spec", "show", "native-sdd", "--rendered", "--json"],
      baseEnv,
      renderedHost,
    );
    const renderedPath = ".cc/temp/native-sdd-revision-1.md";
    const renderedReceipt = JSON.parse(rendered.stdout);

    expect(rendered.exitCode).toBe(0);
    expect(renderedReceipt).toMatchObject({
      ok: true,
      command: "spec show",
      view: "rendered",
      storage: "artifact",
      revision: { role: "current", number: 1 },
      artifact: {
        path: renderedPath,
        format: "markdown",
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(renderedReceipt).not.toHaveProperty("spec");
    const renderedArtifact = renderedHost.written.get(renderedPath) ?? "";
    expect(renderedArtifact).toContain("### R1.1 — Acceptance criterion");
    expect(renderedReceipt.artifact.bytes).toBe(
      Buffer.byteLength(renderedArtifact, "utf8"),
    );
    expect(renderedReceipt.artifact.sha256).toBe(
      `sha256:${createHash("sha256").update(renderedArtifact, "utf8").digest("hex")}`,
    );
    expect(rendered.stdout).not.toContain("The spec can be read through cctl.");

    const fullHost = makeHost({ largeBodyBytes: 80 * 1024 });
    const full = await runCli(
      ["spec", "show", "native-sdd", "--full", "--json"],
      baseEnv,
      fullHost,
    );
    const fullPath = ".cc/temp/native-sdd-spec-detail.json";
    const fullReceipt = JSON.parse(full.stdout);
    const fullArtifact = fullHost.written.get(fullPath);

    expect(full.exitCode).toBe(0);
    expect(Buffer.byteLength(full.stdout, "utf8")).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(fullArtifact ?? "", "utf8")).toBeGreaterThan(
      64 * 1024,
    );
    expect(fullReceipt).toMatchObject({
      ok: true,
      command: "spec show",
      view: "full",
      storage: "artifact",
      artifact: { path: fullPath, format: "json" },
    });
    expect(fullReceipt.artifact.bytes).toBe(
      Buffer.byteLength(fullArtifact ?? "", "utf8"),
    );
    expect(fullReceipt.artifact.sha256).toBe(
      `sha256:${createHash("sha256")
        .update(fullArtifact ?? "", "utf8")
        .digest("hex")}`,
    );
    expect(
      specDetailViewSchema.parse(JSON.parse(fullArtifact ?? "{}")).spec.slug,
    ).toBe("native-sdd");
    expect(fullReceipt).not.toHaveProperty("currentRevision");
  });

  it("refuses conflicting show levels and an output path without a file-backed level", async () => {
    const host = makeHost();
    const conflicting = await runCli(
      ["spec", "show", "native-sdd", "--summary", "--full"],
      baseEnv,
      host,
    );
    const strayOut = await runCli(
      ["spec", "show", "native-sdd", "--out", "detail.json"],
      baseEnv,
      host,
    );

    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.stderr).toContain(
      "one of --summary, --rendered, or --full",
    );
    expect(strayOut.exitCode).toBe(2);
    expect(strayOut.stderr).toContain("--out requires --rendered or --full");
    expect(host.requests).toEqual([]);
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
    // Authored intent, labelled as intent: nothing compiles a task element, so
    // status must not read as a statement about how the run is laid out.
    expect(result.stdout).toContain("intended lane group: cli");
    expect(result.stdout).toContain("intended execution lane: cli-surface");
    expect(result.stdout).toContain(
      "intended touched paths: src/cli/commands/spec/read.contract.test.ts",
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
      "(no workflow lane): definition_review — the admitted one-off launch is awaiting restart recovery before its workflow lane is attached",
    );
    expect(text.stdout).toContain(
      "admitted one-off launch is awaiting restart recovery",
    );

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      executions: [
        {
          id: "execution-1",
          state: "definition_review",
          workflowSeedSource: {
            kind: "spec_delivery",
            specSlug: "native-sdd",
            candidateId: "launch-1",
          },
          workflowExecutionId: null,
          laneState: "not_launched",
          actsNext: "agent",
        },
      ],
    });
  });

  it("reports a workflow-review run whose lane is linked as parked for a human, not running", async () => {
    const host = makeHost({ executions: [workflowApprovalExecution] });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // Linking the lane is what parks the admitted launch for a human, so
    // linkage alone must never be reported as progress.
    expect(text.stdout).not.toMatch(/workflow lanes? running/);
    expect(text.stdout).toContain(
      "phase: executing (1 execution parked awaiting human approval of their workflow lane)",
    );
    expect(text.stdout).toContain(
      "workflow-execution-9: definition_review — parked awaiting human approval of workflow lane workflow-execution-9; approve it from the workflow surface",
    );

    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      executions: [
        {
          id: "execution-2",
          state: "definition_review",
          workflowSeedSource: {
            kind: "spec_delivery",
            specSlug: "native-sdd",
            candidateId: "launch-1",
          },
          workflowExecutionId: "workflow-execution-9",
          laneState: "awaiting_workflow_approval",
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
      "workflow-execution-3: running — workflow lane workflow-execution-3 completed; delivery lands when the session's delivering merge publishes",
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
      "workflow-execution-3: running — workflow lane workflow-execution-3 halted; resolve the halt from the workflow surface, then resume it",
    );
  });

  it("reads executions off the status projection without a second detail request", async () => {
    const host = makeHost({ executions: [workflowApprovalExecution] });
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

  it("accounts for both sides of the approval ledger and names the rule that carries it", async () => {
    const host = makeHost();
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    // Nothing is settled on a first draft, and the pending count alone is the
    // half that gets misread — the mechanism line says why anything ever
    // carries, printed exactly where the wrong inference happens.
    expect(text.stdout).toContain("approval subjects: 0 satisfied · 2 pending");
    expect(text.stdout).toContain(
      "carry rule: unchanged subject content under the same applicable gate",
    );
  });

  it("counts an ancestor-revision approval as carried, not as newly granted", async () => {
    const host = makeHost({ settled: "approval" });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    // R1 is unchanged since the approved predecessor a human read, so its
    // approval carries; R2 and the plan are what the amendment still owes.
    expect(text.stdout).toContain(
      "approval subjects: 1 satisfied (1 carried) · 2 pending",
    );
    expect(text.stdout).toContain(
      "pending subject approvals: 2 total, 2 shown",
    );
    expect(text.stdout).toContain("  requirements: R2");
    // Nothing was import-admitted here, so the section that would say so is
    // absent rather than printing an empty account.
    expect(text.stdout).not.toContain("import-carried subjects:");
  });

  /**
   * A collapsed dial asks for nothing per subject, so a bare "0 satisfied"
   * would read as "this spec governs nothing". The ledger names the act that
   * governs them instead — never a zero-count account, never "not applicable".
   */
  it("names the act that governs a collapsed gate's subjects before its sign-off", async () => {
    const host = makeHost({ preset: "fast-path" });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "approval subjects: 0 satisfied · 2 pending — governed by the combined sign-off, which is outstanding",
    );
    expect(text.stdout).toContain(
      "carry rule: unchanged subject content under the same applicable gate",
    );
  });

  it("names the subjects an import settled, which no human approved", async () => {
    const host = makeHost({ settled: "import" });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // Counted apart from the human approvals: absence from the pending list is
    // how a reader concludes "approved", and no human read this content.
    expect(text.stdout).toContain(
      "approval subjects: 1 satisfied (1 import-settled) · 2 pending",
    );
    expect(text.stdout).toContain("import-carried subjects: 1 total, 1 shown");
    expect(text.stdout).toContain("  requirements: R1");

    const envelope = JSON.parse(structured.stdout);
    expect(envelope.status.approvalLedger).toMatchObject({
      satisfied: 1,
      carried: 0,
      currentRevision: 0,
      importSettled: 1,
      combinedAct: 0,
      pending: 2,
      governedBy: "per_subject",
      carryRule: "unchanged subject content under the same applicable gate",
    });
    // The existing halves keep their exact meanings beside the ledger.
    expect(envelope.status.importCarriedApprovals).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
    ]);
    expect(envelope.disclosure.importCarriedApprovals).toEqual({
      total: 1,
      returned: 1,
      truncated: false,
    });
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
    // out of the reader's window; the omitted rows name the exact read that
    // returns them, so the cap is never a dead end.
    expect(text.stdout).toContain(
      "open questions: 14 total, 10 shown — rest: cctl spec status native-sdd --full",
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
    expect(text.stdout).toContain("assumptions: 1 total, 1 shown");
    expect(text.stdout).toContain("plan tasks: 2 total, 2 shown");
    expect(text.stdout).toContain(
      "pending subject approvals: 2 total, 2 shown",
    );
    // A section that dropped nothing names no follow-up: there is no rest.
    expect(text.stdout).not.toContain("assumptions: 1 total, 1 shown — rest");
  });

  /**
   * The ledger enumerates every consulted subject, so it is the largest section
   * status carries — and the only one the text tier never prints row by row. It
   * is bounded like the rest, but its counts are the account itself: truncating
   * those would understate what is settled, which is the misreading the ledger
   * exists to prevent.
   */
  it("bounds the ledger rows while its counts still account for every subject", async () => {
    const host = makeHost({ extraRequirementCount: 10 });
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(structured.exitCode).toBe(0);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.status.approvalLedger.subjects).toHaveLength(10);
    expect(envelope.status.approvalLedger).toMatchObject({
      satisfied: 0,
      pending: 12,
    });
    expect(envelope.disclosure.approvalLedgerSubjects).toEqual({
      total: 12,
      returned: 10,
      truncated: true,
      reveal: "cctl spec status native-sdd --full",
    });

    const full = await runCli(
      ["spec", "status", "native-sdd", "--json", "--full"],
      baseEnv,
      host,
    );
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout).status.approvalLedger.subjects).toHaveLength(
      12,
    );
  });

  it("names the outline read as the rest of a truncated plan-task section", async () => {
    const host = makeHost({ extraTaskCount: 10 });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "plan tasks: 12 total, 10 shown — rest: cctl spec show native-sdd",
    );
  });

  it("serializes the bounded sections and their omissions in --json", async () => {
    const host = makeHost({ questionCount: 14 });
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(structured.exitCode).toBe(0);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.command).toBe("spec status");
    expect(envelope.view).toBe("bounded");
    expect(envelope.storage).toBe("inline");
    // The structured view carries exactly the rows the text tier printed.
    expect(envelope.status.openQuestions).toHaveLength(10);
    expect(envelope.status.openQuestions[0].handle).toBe("Q1");
    expect(structured.stdout).not.toContain("Open question 11?");
    expect(envelope.disclosure.openQuestions).toEqual({
      total: 14,
      returned: 10,
      truncated: true,
      reveal: "cctl spec status native-sdd --full",
    });
    expect(envelope.disclosure.assumptions).toEqual({
      total: 1,
      returned: 1,
      truncated: false,
    });
    expect(envelope.disclosure.taskPlan).toEqual({
      total: 2,
      returned: 2,
      truncated: false,
    });
  });

  it("--full carries every row the bounded sections dropped", async () => {
    const host = makeHost({ questionCount: 14 });
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--full", "--json"],
      baseEnv,
      host,
    );
    const text = await runCli(
      ["spec", "status", "native-sdd", "--full"],
      baseEnv,
      host,
    );

    expect(structured.exitCode).toBe(0);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.view).toBe("full");
    expect(envelope.storage).toBe("inline");
    expect(envelope.status.openQuestions).toHaveLength(14);
    expect(envelope.disclosure).toBeUndefined();
    expect(text.stdout).toContain("open questions: 14 total, 14 shown");
    expect(text.stdout).toContain("Open question 14?");
    expect(host.written.size).toBe(0);
  });

  it("--full past the stdout budget writes the projection to an artifact", async () => {
    const host = makeHost({ questionCount: 14, questionTextBytes: 8_000 });
    const structured = await runCli(
      ["spec", "status", "native-sdd", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(structured.exitCode).toBe(0);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.view).toBe("full");
    expect(envelope.storage).toBe("artifact");
    expect(envelope.reason).toBe("stdout_budget_exceeded");
    expect(envelope.artifact.format).toBe("json");
    expect(envelope.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(structured.stdout).not.toContain("yyyy");

    const written = host.written.get(envelope.artifact.path);
    expect(written).toBeDefined();
    const document = JSON.parse(written ?? "");
    expect(document.status.openQuestions).toHaveLength(14);
  });

  it("reports open comments in status text and points at the comments verb", async () => {
    const host = makeHost({
      comments: [reviewComment, openReviewReply, resolvedReviewComment],
    });
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("open review threads: 1 (1 blocking) on R1");
    expect(text.stdout).toContain(
      "  read: cctl spec comments native-sdd --open",
    );
  });

  it("stays silent about comments in status when none are open", async () => {
    const host = makeHost();
    const text = await runCli(["spec", "status", "native-sdd"], baseEnv, host);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).not.toContain("open comments:");
  });

  it("reads review comments as typed rows and renders them for humans", async () => {
    const host = makeHost({
      comments: [reviewComment, openReviewReply, resolvedReviewComment],
    });
    const text = await runCli(
      ["spec", "comments", "native-sdd"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      "native-sdd  comments: 3 message rows shown, 1 open thread (2 open message rows, 1 blocking message row)",
    );
    expect(text.stdout).toContain("R1  open [blocking]  by human rev 1");
    expect(text.stdout).toContain("  > resolves renamed specs");
    expect(text.stdout).toContain("  Should renames preserve aliases?");

    const data = await runCli(
      ["spec", "comments", "native-sdd", "--json"],
      baseEnv,
      host,
    );
    expect(data.exitCode).toBe(0);
    const body = JSON.parse(data.stdout) as {
      ok: boolean;
      openCount: number;
      openBlockingCount: number;
      openThreadCount: number;
      openBlockingThreadCount: number;
      comments: Record<string, unknown>[];
    };
    expect(body.ok).toBe(true);
    expect(body.openCount).toBe(2);
    expect(body.openBlockingCount).toBe(1);
    expect(body.openThreadCount).toBe(1);
    expect(body.openBlockingThreadCount).toBe(1);
    expect(body.comments[0]).toMatchObject({
      handle: "R1",
      threadId: "thread-1",
      revisionNumber: 1,
      quote: "resolves renamed specs",
      author: { kind: "human" },
      blocking: true,
      resolution: "open",
    });
    // The raw persistence shape must not leak: no snake_case keys, no
    // JSON-encoded string columns, no 0/1 booleans.
    expect(Object.keys(body.comments[0] ?? {})).not.toContain("anchor_json");
    expect(Object.keys(body.comments[0] ?? {})).not.toContain("author_json");
  });

  it("narrows comments by open state and element at the route, not in the client", async () => {
    const host = makeHost({
      comments: [reviewComment, openReviewReply, resolvedReviewComment],
    });
    const open = await runCli(
      ["spec", "comments", "native-sdd", "--open", "--json"],
      baseEnv,
      host,
    );

    expect(open.exitCode).toBe(0);
    const openBody = JSON.parse(open.stdout) as {
      comments: { id: string }[];
      openCount: number;
      openThreadCount: number;
    };
    expect(openBody.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "comment-reply-1",
    ]);
    // Spec-wide counts survive filtering, so a narrowed read still reports
    // total outstanding feedback.
    expect(openBody.openCount).toBe(2);
    expect(openBody.openThreadCount).toBe(1);
    expect(new URL(host.requests[0]?.url ?? "").search).toBe("?open=true");

    const byElement = await runCli(
      ["spec", "comments", "native-sdd", "--element", "R1", "--json"],
      baseEnv,
      host,
    );
    expect(byElement.exitCode).toBe(0);
    expect(
      (JSON.parse(byElement.stdout) as { comments: { id: string }[] }).comments,
    ).toHaveLength(3);
  });

  it("refuses a typo'd element filter rather than answering with an empty list", async () => {
    const host = makeHost({ comments: [reviewComment] });
    const result = await runCli(
      ["spec", "comments", "native-sdd", "--element", "R9"],
      baseEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no comment references it");
  });

  it("hoists the element identity beside spec get's nested view", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "get", "native-sdd/R1", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    // The view nests the durable row (element.element.element.id); the
    // identity a script wants rides at the top of the envelope instead.
    expect(envelope.elementId).toBe("requirement-1");
    expect(envelope.kind).toBe("requirement");
    expect(envelope.elementVersion).toBe(1);
  });

  it("renders spec get as concise text by default", async () => {
    const host = makeHost();
    const content = await runCli(
      ["spec", "get", "native-sdd/R1"],
      baseEnv,
      host,
    );
    const question = await runCli(
      ["spec", "get", "native-sdd/Q1"],
      baseEnv,
      host,
    );

    expect(content.exitCode).toBe(0);
    expect(content.stdout).toContain("native-sdd/R1\trequirement\trevision 1");
    expect(content.stdout).toContain("Specs are durable product objects.");
    expect(content.stdout).toContain("priority: must");
    expect(content.stdout.trimStart()).not.toMatch(/^\{/u);
    expect(content.stdout).not.toContain('"specId"');

    expect(question.exitCode).toBe(0);
    expect(question.stdout).toContain("native-sdd/Q1\tquestion\topen");
    expect(question.stdout).toContain("Which export format is canonical?");
    expect(question.stdout.trimStart()).not.toMatch(/^\{/u);
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

  /**
   * The lineage draft dropped the task its two ancestors carried, so `T1` is
   * the one handle that resolves nowhere current and somewhere historical.
   */
  it("refuses a historical-only handle with its recovery command in text and JSON", async () => {
    const text = await runCli(
      ["spec", "get", "native-sdd/T1"],
      baseEnv,
      makeHost({ lineage: true }),
    );
    const structured = await runCli(
      ["spec", "get", "native-sdd/T1", "--json"],
      baseEnv,
      makeHost({ lineage: true }),
    );

    const recovery = "cctl spec get native-sdd/T1 --revision 2";
    expect(structured.exitCode).not.toBe(0);
    const envelope = JSON.parse(structured.stdout) as Record<string, unknown>;
    expect(envelope.error).toBe(
      "Spec element exists only in a historical revision",
    );
    expect(envelope.code).toBe("historical_only");
    const details = {
      handle: "T1",
      elementId: "lineage-task-1",
      lastRevisionId: "lineage-revision-2",
      lastRevisionNumber: 2,
      currentRevisionId: "lineage-revision-3",
      currentRevisionNumber: 3,
    };
    expect(envelope.details).toEqual(details);
    expect(envelope.instruction).toContain(recovery);

    expect(text.exitCode).not.toBe(0);
    expect(text.stderr).toContain(
      "Spec element exists only in a historical revision",
    );
    expect(text.stderr).toContain(recovery);
    // Text/JSON parity asserted over the whole details block rather than a
    // hand-picked subset: a fact the refusal gains cannot then be rendered in
    // one mode and silently dropped from the other.
    for (const [field, value] of Object.entries(details)) {
      expect(text.stderr).toContain(`  details.${field}: ${value}`);
    }
  });

  it("sends --revision as a number or an id by its digit shape", async () => {
    const byNumber = makeHost({ lineage: true });
    const byId = makeHost({ lineage: true });
    const numbered = await runCli(
      ["spec", "get", "native-sdd/T1", "--revision", "2", "--json"],
      baseEnv,
      byNumber,
    );
    const identified = await runCli(
      [
        "spec",
        "get",
        "native-sdd/T1",
        "--revision",
        "lineage-revision-2",
        "--json",
      ],
      baseEnv,
      byId,
    );

    expect(numbered.exitCode, numbered.stderr).toBe(0);
    expect(new URL(byNumber.requests[0]?.url ?? "").search).toBe(
      "?revisionNumber=2",
    );
    expect(identified.exitCode, identified.stderr).toBe(0);
    expect(new URL(byId.requests[0]?.url ?? "").search).toBe(
      "?revisionId=lineage-revision-2",
    );
    expect(JSON.parse(identified.stdout).element.revision.id).toBe(
      "lineage-revision-2",
    );
  });

  it("names the revision a historical read answered from in its header", async () => {
    const result = await runCli(
      ["spec", "get", "native-sdd/T1", "--revision", "2"],
      baseEnv,
      makeHost({ lineage: true }),
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("native-sdd/T1\ttask\trevision 2");
  });

  it("reads one section by element id in a named envelope and depth-complete text", async () => {
    const host = makeHost({ sections: true });
    const text = await runCli(
      ["spec", "section", "get", "native-sdd", "--id", "problem-section"],
      baseEnv,
      host,
    );

    expect(text.exitCode, text.stderr).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/sections/problem-section",
    );
    // The narrowest read is depth-complete: every field JSON carries appears as
    // a `path: value` line, so text mode changes representation, not depth.
    expect(text.stdout).toContain(
      "problem-section\tsection\tintent_problem\trevision 1",
    );
    for (const line of [
      "slug: native-sdd",
      "kind: section",
      // Sections have no handle at all; text says so rather than omitting it.
      "handle: none",
      "elementId: problem-section",
      "role: intent_problem",
      "title: Problem",
      "body: Sections had no narrow read.",
      "elementVersion: 2",
      "position: 4",
      "revision.number: 1",
      "revision.state: draft",
      "revision.authoringStage: plan",
    ]) {
      expect(text.stdout, line).toContain(line);
    }
    expect(text.stdout.trimStart()).not.toMatch(/^\{/u);
  });

  it("carries the section read under its own envelope payload", async () => {
    const result = await runCli(
      [
        "spec",
        "section",
        "get",
        "native-sdd",
        "--id",
        "problem-section",
        "--json",
      ],
      baseEnv,
      makeHost({ sections: true }),
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
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
  });

  it("requires --id and names the address it takes", async () => {
    const host = makeHost({ sections: true });
    const missing = await runCli(
      ["spec", "section", "get", "native-sdd"],
      baseEnv,
      host,
    );

    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain(
      "cctl spec section get <slug> --id <element-id>",
    );
    expect(host.requests).toHaveLength(0);
  });

  it("surfaces the server's non-section refusal with the read that fits", async () => {
    const result = await runCli(
      ["spec", "section", "get", "native-sdd", "--id", "requirement-1"],
      baseEnv,
      makeHost({ sections: true }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Spec element is not a section");
    expect(result.stderr).toContain("cctl spec get native-sdd/R1");
  });

  it("sends a section --revision as a number or an id by its digit shape", async () => {
    const byNumber = makeHost({ sections: true });
    const byId = makeHost({ sections: true });
    await runCli(
      [
        "spec",
        "section",
        "get",
        "native-sdd",
        "--id",
        "problem-section",
        "--revision",
        "1",
        "--json",
      ],
      baseEnv,
      byNumber,
    );
    await runCli(
      [
        "spec",
        "section",
        "get",
        "native-sdd",
        "--id",
        "problem-section",
        "--revision",
        revision.id,
        "--json",
      ],
      baseEnv,
      byId,
    );

    expect(new URL(byNumber.requests[0]?.url ?? "").search).toBe(
      "?revisionNumber=1",
    );
    expect(new URL(byId.requests[0]?.url ?? "").search).toBe(
      `?revisionId=${revision.id}`,
    );
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

      const result = await runCli(
        ["spec", "diff", "native-sdd"],
        baseEnv,
        driftedHost,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("failed this CLI's validation");
      expect(result.stderr).toContain("elements.0.classification");
      expect(result.stderr).not.toContain("same build as this CLI");
      expect(result.stderr).toContain("cctl doctor");
    });
    it("defaults to the pair Spec Studio diffs and classes it identically", async () => {
      const host = makeHost({ lineage: true });
      const shown = await runCli(
        [
          "spec",
          "show",
          "native-sdd",
          "--full",
          "--out",
          ".cc/temp/diff-parity-detail.json",
          "--json",
        ],
        baseEnv,
        host,
      );
      expect(shown.exitCode, `${shown.stderr}${shown.stdout}`).toBe(0);
      const detail = specDetailViewSchema.parse(
        JSON.parse(
          host.written.get(".cc/temp/diff-parity-detail.json") ?? "{}",
        ),
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

      const result = await runCli(
        ["spec", "verify", "native-sdd", "--against", against, "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        code: expectedCode,
        issues: [{ path: expectedPath }],
      });
      expect(host.requests).toHaveLength(0);
      expect(host.written.size).toBe(0);
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

      const result = await runCli(
        ["spec", "verify", "native-sdd", "--against", againstPath, "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        code: "integrity_mismatch",
        details: { against: againstPath },
        issues: [{ path: expectedPath }],
      });
      expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/api/specs/demo/native-sdd/verify",
        "/api/specs/demo/native-sdd/export",
      ]);
      expect(host.written.size).toBe(0);
      for (const body of [
        ...Object.values(currentValues),
        ...Object.values(againstValues),
      ]) {
        expect(result.stdout).not.toContain(body);
        expect(result.stderr).not.toContain(body);
      }
    },
  );

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
      instruction:
        "Inspect the reported revision mismatch and resolve it in the authoritative spec store, then export a fresh bundle and verify again.",
      details: { report: { ok: false } },
    });
    expect(result.stdout).not.toMatch(/restore|import/i);
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
      "/api/specs/demo/search/outline",
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
  ): CliHost & {
    written: Map<string, string>;
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
    const written = new Map<string, string>();
    const requests: RecordedRequest[] = [];
    return {
      written,
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

    // (4) The affected spec's pre-narrowing body is not valid format-4
    // content. Strict decode refuses it before live verification; re-exporting
    // is the supported way to produce a canonical artifact after migration.
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
    const requestsBeforeMismatch = host.requests.length;
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
      code: "integrity_mismatch",
      error: "canonical bundle failed strict format-4 verification",
      details: { against: "/tmp/affected-old.json" },
      issues: [
        {
          path: "bundle.manifest.revisions[0].elements[1].payload.validationStrategy.kinds[0]",
        },
      ],
    });
    expect(host.requests).toHaveLength(requestsBeforeMismatch);

    // (5) The unaffected spec's pre-migration content still matches at exit 0
    // when reconstructed in the current bundle format.
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
