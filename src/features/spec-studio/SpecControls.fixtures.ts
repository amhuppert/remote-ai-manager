import { emptyApprovalLedger } from "@/lib/specs/approval-ledger";
import { remainingAuthoringSequence } from "@/lib/specs/authoring-sequence";
import type { SpecDetailView } from "@/lib/specs/queries";
import { toDiffRows } from "@/lib/specs/revision-diff-projections";
import { consultedAuthoringGates } from "@/lib/specs/authoring-gates";
import type { SpecAuthoringStage, SpecRevision } from "@/lib/specs/schemas";
import {
  specDetailViewSchema,
  specGateAdmissionViewSchema,
  type DraftReviewView,
  type SpecGateAdmissionView,
  type SpecRevisionSnapshotView,
} from "@/lib/specs/view-schemas";

export const SPEC_CONTROLS_FIXTURE_NOW = "2026-07-18T12:00:00.000Z";
const EMPTY_CITATION_HASH = "0".repeat(64);
const EMPTY_CITATION_DIFF = {
  baseCitationContractVersion: 2 as const,
  draftCitationContractVersion: 2 as const,
  baseCitations: [],
  draftCitations: [],
};

/**
 * A policy-basis gate admission (Notify/Off dial) as the detail response
 * carries it: no approval, no execution, nullable revision (R11.2 post-hoc
 * review rows must tolerate both). Parsed through the response schema so a
 * fixture that drifts from the payload Studio actually receives fails here
 * rather than agreeing with a stale consumer.
 */
export function policyAdmissionViewFixture(
  overrides: Partial<SpecGateAdmissionView> = {},
): SpecGateAdmissionView {
  return specGateAdmissionViewSchema.parse({
    id: "admission-notify-1",
    specId: "spec-1",
    gate: "requirements",
    basis: "notify_policy",
    approvalId: null,
    revisionId: "revision-1",
    revisionNumber: 1,
    actor: { kind: "agent", conversationId: "conversation-1" },
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    ...overrides,
  });
}

/**
 * The `subject_fingerprint_json` a content approval records: the element
 * payload hashes and citation digest the human approved. Studio never reads
 * inside it, so one well-formed value per subject is enough for a fixture.
 */
export function subjectFingerprintFixture(elementId: string | null): string {
  return JSON.stringify({
    elements:
      elementId === null
        ? []
        : [{ elementId, payloadHash: `${elementId}-hash` }],
    citationContractVersion: 2,
    citationCount: 0,
    citationSubhash: "a".repeat(64),
  });
}

/**
 * The draft-review projection the detail route computes, rebuilt over a
 * fixture's own revisions and snapshots: null unless a draft is open, its
 * lineage parent as the diff base, and its nearest approved ancestor as the
 * governance baseline.
 */
export function draftReviewFixture(
  revisions: readonly SpecRevision[],
  snapshots: readonly SpecRevisionSnapshotView[],
  {
    notes = null,
    reviewHash = "review-hash-1",
  }: { notes?: string | null; reviewHash?: string } = {},
): DraftReviewView | null {
  const draft = revisions.find((revision) => revision.state === "draft");
  if (draft === undefined) return null;
  const byRevisionId = new Map(
    snapshots.map((snapshot) => [snapshot.revision.id, snapshot]),
  );
  const snapshot = byRevisionId.get(draft.id);
  if (snapshot === undefined) {
    throw new Error(`Draft review fixture is missing ${draft.id}'s snapshot`);
  }
  let governanceBaseSnapshot: SpecRevisionSnapshotView | null = null;
  let ancestorId = draft.basedOnRevisionId;
  while (ancestorId !== null) {
    const ancestor = revisions.find((revision) => revision.id === ancestorId);
    if (ancestor === undefined) break;
    if (ancestor.state === "approved") {
      governanceBaseSnapshot = byRevisionId.get(ancestor.id) ?? null;
      break;
    }
    ancestorId = ancestor.basedOnRevisionId;
  }
  return {
    snapshot,
    baseSnapshot:
      draft.basedOnRevisionId === null
        ? null
        : (byRevisionId.get(draft.basedOnRevisionId) ?? null),
    governanceBaseSnapshot,
    notes,
    reviewHash,
  };
}

export function specControlsDetailFixture(): SpecDetailView {
  const revision = {
    id: "revision-1",
    specId: "spec-1",
    number: 1,
    state: "approved" as const,
    authoringStage: "plan" as const,
    basedOnRevisionId: null,
    contentHash: "revision-hash",
    proposedAt: SPEC_CONTROLS_FIXTURE_NOW,
    approvedAt: SPEC_CONTROLS_FIXTURE_NOW,
    citationContractVersion: 2 as const,
    citationVersion: 1,
    citationHash: EMPTY_CITATION_HASH,
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
  };
  const elements = [
    {
      element: {
        id: "requirement-1",
        specId: "spec-1",
        kind: "requirement" as const,
        number: 1,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "requirement-1",
        position: 0,
        payload: {
          kind: "requirement" as const,
          statement: "Every execution pins scope.",
          priority: "must" as const,
          risk: "high" as const,
        },
        payloadHash: "requirement-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      element: {
        id: "criterion-1",
        specId: "spec-1",
        kind: "criterion" as const,
        number: 1,
        parentElementId: "requirement-1",
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "criterion-1",
        position: 1,
        payload: {
          kind: "criterion" as const,
          text: "The selected task and criterion are pinned.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
        payloadHash: "criterion-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      element: {
        id: "task-1",
        specId: "spec-1",
        kind: "task" as const,
        number: 1,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: revision.id,
        elementId: "task-1",
        position: 2,
        payload: {
          kind: "task" as const,
          title: "Implement scope pinning",
          instructions: "Persist the exact scope.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
  ];

  return {
    spec: {
      id: "spec-1",
      projectPath: "/repos/command-center",
      slug: "native-sdd",
      name: "Native SDD",
      gatePolicy: { preset: "contract-bearing" },
      abandonedAt: null,
      abandonedReason: null,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
    aliases: [],
    revisions: [revision],
    attentionAuditEvents: [],
    // The fixture's one revision is approved, so no draft is open to review.
    draftReview: null,
    baseRevision: null,
    currentRevision: { revision, elements, assumptionCitations: [] },
    currentApprovedRevision: { revision, elements, assumptionCitations: [] },
    approvals: [],
    comments: [],
    linkedTickets: [],
    elementStatuses: { requirements: [] },
    status: {
      currentRevision: {
        id: revision.id,
        number: revision.number,
        state: revision.state,
        authoringStage: revision.authoringStage,
      },
      specId: "spec-1",
      slug: "native-sdd",
      imported: false,
      openComments: null,
      phase: { primary: "approved" },
      gates: [],
      // The fixture spec's current revision is approved, so no draft is open.
      authoringSequence: null,
      pendingApprovals: [],
      importCarriedApprovals: [],
      // Nothing is under review, so no gate is consulted and the ledger has
      // no subject to account for.
      approvalLedger: emptyApprovalLedger(),
      applicableGates: [],
      revisionSignOff: null,
      pendingBlock: null,
      nextAction: null,
      openQuestions: [],
      assumptions: [],
      taskPlan: [],
      // Nothing is open to author, so the fixture's draft lints clean.
      draftHealth: {
        revisionId: revision.id,
        total: 0,
        blocking: 0,
        counts: [],
        top: [],
      },
    },
    questions: [],
    assumptions: [],
    gateAdmissions: [],
    importRecord: null,
  };
}

export function denseSpecControlsDetailFixture(): SpecDetailView {
  const detail = specControlsDetailFixture();
  const snapshot = detail.currentApprovedRevision;
  if (snapshot === null) throw new Error("Approved fixture missing");
  const criterion = snapshot.elements.find(
    (entry) => entry.element.id === "criterion-1",
  );
  const task = snapshot.elements.find((entry) => entry.element.id === "task-1");
  if (
    criterion === undefined ||
    criterion.version.payload.kind !== "criterion" ||
    task === undefined ||
    task.version.payload.kind !== "task"
  ) {
    throw new Error("Dense execution fixture sources missing");
  }

  const criterionNumbers = [2, 3, 4];
  const additionalCriteria = criterionNumbers.map((number) => ({
    element: {
      ...criterion.element,
      id: `criterion-${number}`,
      number,
    },
    version: {
      ...criterion.version,
      elementId: `criterion-${number}`,
      position: number,
      payload: {
        ...criterion.version.payload,
        text: `Criterion ${number} is satisfied for the scoped delivery.`,
      },
      payloadHash: `criterion-${number}-hash`,
    },
  }));
  const taskTwo = {
    element: { ...task.element, id: "task-2", number: 2 },
    version: {
      ...task.version,
      elementId: "task-2",
      position: 6,
      payload: {
        ...task.version.payload,
        title: "Validate scoped delivery",
        coveredCriterionElementIds: criterionNumbers.map(
          (number) => `criterion-${number}`,
        ),
        dependsOnTaskElementIds: ["task-1"],
      },
      payloadHash: "task-2-hash",
    },
  };
  snapshot.elements.push(...additionalCriteria, taskTwo);

  return detail;
}

/**
 * A spec born by import and already delivered outside this system, with every
 * imported question answered and every imported assumption disposed in the
 * bundle. Its gates were crossed on the source document's word, so it carries
 * import-basis admissions and no approval rows at all: an import writes none,
 * and a fixture that invented one would let a surface pass a human sign-off
 * the import never performed.
 */
export function importedSpecDetailFixture(): SpecDetailView {
  const detail = specControlsDetailFixture();
  const snapshot = detail.currentApprovedRevision;
  if (snapshot === null) throw new Error("Approved fixture missing");
  detail.approvals = [];
  detail.gateAdmissions = [
    policyAdmissionViewFixture({
      id: "admission-import-requirements",
      gate: "requirements",
      basis: "import",
      approvalId: null,
      revisionId: snapshot.revision.id,
      actor: { kind: "agent", conversationId: "conversation-1" },
    }),
    policyAdmissionViewFixture({
      id: "admission-import-design",
      gate: "design",
      basis: "import",
      approvalId: null,
      revisionId: snapshot.revision.id,
      actor: { kind: "agent", conversationId: "conversation-1" },
    }),
  ];
  detail.importRecord = {
    occurredAt: SPEC_CONTROLS_FIXTURE_NOW,
    sourceLabel: "kiro:.kiro/specs/shipped-feature",
    counts: {
      sections: 1,
      requirements: 1,
      criteria: 1,
      decisions: 0,
      questions: 1,
      assumptions: 1,
    },
  };
  // The import writes the record and its answer in one transaction, so an
  // imported answer carries the import instant exactly.
  detail.questions = [
    {
      id: "question-1",
      number: 1,
      handle: "Q1",
      elementId: null,
      text: "Which retention window applies?",
      recordVersion: 1,
      status: "answered",
      answer: "Thirty days, per the source spec.",
      answeredAt: SPEC_CONTROLS_FIXTURE_NOW,
      withdrawnAt: null,
      provenance: { kind: "agent", conversationId: "conversation-1" },
      presentation: {
        state: "current",
        attentionActive: false,
        lastMutation: null,
        humanCapability: {
          kind: "answer",
          allowed: false,
          code: "terminal",
          blockingRevisionId: null,
          instruction: "This question has a terminal answer.",
        },
      },
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
  ];
  detail.assumptions = [
    {
      id: "assumption-1",
      number: 1,
      handle: "A1",
      elementId: null,
      text: "Retention defaults to 30 days.",
      recordVersion: 1,
      disposition: "confirmed",
      disposedAt: SPEC_CONTROLS_FIXTURE_NOW,
      withdrawnAt: null,
      proposedBy: { kind: "agent", conversationId: "conversation-1" },
      supersedesHandle: null,
      supersededByHandle: null,
      currentDraftCitations: null,
      presentation: {
        state: "current",
        attentionActive: false,
        lastMutation: null,
        humanCapability: {
          kind: "dispose",
          allowed: false,
          code: "terminal",
          blockingRevisionId: null,
          instruction: "This assumption is terminal.",
        },
      },
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
  ];
  detail.attentionAuditEvents = [
    {
      kind: "record",
      eventId: 1,
      occurredAt: SPEC_CONTROLS_FIXTURE_NOW,
      actor: { kind: "agent", conversationId: "conversation-1" },
      payload: {
        schemaVersion: 1,
        recordKind: "question",
        recordId: "question-1",
        recordNumber: 1,
        attentionId: "question-1",
        operation: "imported",
        active: false,
        before: null,
        after: {
          kind: "question",
          recordId: "question-1",
          number: 1,
          recordVersion: 1,
          text: "Which retention window applies?",
          elementId: null,
          provenance: { kind: "agent", conversationId: "conversation-1" },
          status: "answered",
          answer: "Thirty days, per the source spec.",
          answeredAt: SPEC_CONTROLS_FIXTURE_NOW,
          withdrawnAt: null,
          createdAt: SPEC_CONTROLS_FIXTURE_NOW,
          updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
        },
      },
    },
    {
      kind: "record",
      eventId: 2,
      occurredAt: SPEC_CONTROLS_FIXTURE_NOW,
      actor: { kind: "agent", conversationId: "conversation-1" },
      payload: {
        schemaVersion: 1,
        recordKind: "assumption",
        recordId: "assumption-1",
        recordNumber: 1,
        attentionId: "assumption-1",
        operation: "imported",
        active: false,
        before: null,
        after: {
          kind: "assumption",
          recordId: "assumption-1",
          number: 1,
          recordVersion: 1,
          text: "Retention defaults to 30 days.",
          elementId: null,
          proposedBy: { kind: "agent", conversationId: "conversation-1" },
          disposition: "confirmed",
          disposedAt: SPEC_CONTROLS_FIXTURE_NOW,
          withdrawnAt: null,
          supersedesAssumptionId: null,
          supersededByAssumptionId: null,
          createdAt: SPEC_CONTROLS_FIXTURE_NOW,
          updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
        },
      },
    },
  ];
  detail.status.imported = true;
  detail.status.phase = { primary: "approved" };
  return specDetailViewSchema.parse(detail);
}

/** The human sign-off on the amendment lands after the import committed. */
const AMENDMENT_APPROVED_AT = "2026-07-19T09:30:00.000Z";

/**
 * A spec born by import that a human later amended here: revision 1 crossed its
 * gates on the source document's word, revision 2 was authored natively and
 * signed off by a human. The spec-level `imported` bit stays true for the whole
 * lineage, so this is the shape that separates "this spec entered by import"
 * from "this revision was admitted by import" — a surface that reads the bit
 * instead of the revision's own admission credits the import with a human act.
 */
export function importedThenAmendedSpecDetailFixture(): SpecDetailView {
  const detail = importedSpecDetailFixture();
  const imported = detail.currentApprovedRevision;
  if (imported === null) throw new Error("Imported fixture missing");
  const amendment = {
    revision: {
      ...imported.revision,
      id: "revision-2",
      number: 2,
      // The amendment reopens design, the stage its content changes.
      authoringStage: "design" as const,
      basedOnRevisionId: imported.revision.id,
      contentHash: "revision-2-hash",
      proposedAt: AMENDMENT_APPROVED_AT,
      approvedAt: AMENDMENT_APPROVED_AT,
      createdAt: AMENDMENT_APPROVED_AT,
    },
    elements: imported.elements,
    assumptionCitations: imported.assumptionCitations,
  };
  detail.revisions = [imported.revision, amendment.revision];
  detail.baseRevision = imported;
  detail.currentRevision = amendment;
  detail.currentApprovedRevision = amendment;
  detail.approvals = [
    {
      id: "approval-design-2",
      spec_id: "spec-1",
      subject_kind: "revision",
      element_id: null,
      revision_id: amendment.revision.id,
      approver: "alex",
      granted_at: AMENDMENT_APPROVED_AT,
      validity: "valid",
      subject_fingerprint_json: null,
    },
  ];
  detail.gateAdmissions = [
    ...detail.gateAdmissions,
    policyAdmissionViewFixture({
      id: "admission-design-human",
      gate: "design",
      basis: "human_approval",
      approvalId: "approval-design-2",
      revisionId: amendment.revision.id,
      revisionNumber: amendment.revision.number,
      actor: { kind: "human" },
      createdAt: AMENDMENT_APPROVED_AT,
    }),
  ];
  detail.status.phase = { primary: "approved" };
  return specDetailViewSchema.parse(detail);
}

/**
 * The fixture spec with an open draft revision pinned at `pinnedStage`,
 * carrying the remaining-sequence projection the server computes under the
 * spec's *current* policy — so a consumer that echoes the stored sequence
 * instead of resolving the proposed one is visible.
 */
export function draftingSpecControlsDetailFixture(
  pinnedStage: SpecAuthoringStage,
): SpecDetailView {
  const detail = specControlsDetailFixture();
  const approved = detail.currentApprovedRevision;
  if (approved === null) throw new Error("Approved fixture missing");
  const draft = {
    revision: {
      ...approved.revision,
      id: "revision-2",
      number: 2,
      state: "draft" as const,
      authoringStage: pinnedStage,
      basedOnRevisionId: approved.revision.id,
      proposedAt: null,
      approvedAt: null,
    },
    elements: approved.elements,
    assumptionCitations: approved.assumptionCitations,
  };
  detail.revisions = [approved.revision, draft.revision];
  detail.draftReview = draftReviewFixture(detail.revisions, [approved, draft]);
  detail.baseRevision = approved;
  detail.currentRevision = draft;
  detail.status.phase = { primary: "draft" };
  detail.status.authoringSequence = remainingAuthoringSequence({
    policy: detail.spec.gatePolicy,
    revisionId: draft.revision.id,
    revisionNumber: draft.revision.number,
    pinnedStage,
    governanceConsultedGates: consultedAuthoringGates(
      pinnedStage,
      toDiffRows(approved),
      toDiffRows(draft),
      EMPTY_CITATION_DIFF,
    ),
  });
  return detail;
}
