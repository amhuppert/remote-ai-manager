import { emptyApprovalLedger } from "@/lib/specs/approval-ledger";
import { remainingAuthoringSequence } from "@/lib/specs/authoring-sequence";
import { liveProposalProjection } from "@/lib/specs/proposal-integrity";
import type { SpecDetailView } from "@/lib/specs/queries";
import { toDiffRows } from "@/lib/specs/revision-diff-projections";
import { consultedAuthoringGates } from "@/lib/specs/authoring-gates";
import type { SpecAuthoringStage, SpecRevision } from "@/lib/specs/schemas";
import {
  specDetailViewSchema,
  specExecutionViewSchema,
  specGateAdmissionViewSchema,
  type LiveProposalView,
  type SpecExecutionView,
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

/** The dense fixture's prior delivered run predates the current run. */
const PRIOR_RUN_CREATED_AT = "2026-07-17T09:00:00.000Z";
const PRIOR_RUN_DELIVERED_AT = "2026-07-17T18:00:00.000Z";

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
    executionId: null,
    actor: { kind: "agent", conversationId: "conversation-1" },
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    ...overrides,
  });
}

/**
 * A run in the shape the detail response carries it — scope already parsed,
 * revision number alongside the revision id. Parsed through the response
 * schema for the same reason `policyAdmissionViewFixture` is.
 */
export function executionViewFixture(
  overrides: Partial<SpecExecutionView> = {},
): SpecExecutionView {
  return specExecutionViewSchema.parse({
    id: "execution-1",
    specId: "spec-1",
    revisionId: "revision-1",
    revisionNumber: 1,
    state: "running",
    workflowSeedSource: {
      kind: "spec_delivery",
      specSlug: "spec-1",
      candidateId: "launch-1",
    },
    workflowExecutionId: null,
    scope: {
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [],
    },
    sessionName: "native-sdd-run",
    deliveredAt: null,
    abandonedReason: null,
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    deliveryProjection: [
      {
        criterionElementId: "criterion-1",
        handle: "R1.1",
        deliveryState: "awaiting_outcome",
        verdict: null,
      },
    ],
    ...overrides,
  });
}

/**
 * The live-proposals projection the detail route computes, rebuilt over a
 * fixture's own revisions and snapshots.
 *
 * It calls the shared predicate rather than restating "which proposal is
 * stranded" in fixture code: a fixture that could disagree with the server
 * would let a surface pass its test while showing the operator a review state
 * the lineage does not support (#50).
 */
export function liveProposalsFixture(
  revisions: readonly SpecRevision[],
  snapshots: readonly SpecRevisionSnapshotView[],
  /** The disposition document each proposal was proposed with, by revision id. */
  notesByRevisionId: Readonly<Record<string, string>> = {},
): LiveProposalView[] {
  const byRevisionId = new Map(
    snapshots.map((snapshot) => [snapshot.revision.id, snapshot]),
  );
  return liveProposalProjection(revisions).flatMap((entry) => {
    const snapshot = byRevisionId.get(entry.revision.id);
    if (snapshot === undefined) return [];
    return [
      {
        revision: entry.revision,
        supersededBy: entry.supersededBy,
        snapshot,
        baseSnapshot:
          entry.revision.basedOnRevisionId === null
            ? null
            : (byRevisionId.get(entry.revision.basedOnRevisionId) ?? null),
        governanceBaseSnapshot: (() => {
          let revisionId = entry.revision.basedOnRevisionId;
          while (revisionId !== null) {
            const candidate = revisions.find(
              (revision) => revision.id === revisionId,
            );
            if (candidate === undefined) return null;
            if (candidate.state === "approved") {
              return byRevisionId.get(candidate.id) ?? null;
            }
            revisionId = candidate.basedOnRevisionId;
          }
          return null;
        })(),
        notes: notesByRevisionId[entry.revision.id] ?? null,
      },
    ];
  });
}

/**
 * Ticket #50's live shape: revision 3 was approved from revision 1's content,
 * forking past the still-proposed revision 2. The lineage head is approved, so
 * a surface keyed off the newest revision reports nothing awaiting review
 * while revision 2 sits with no reachable act.
 */
export function strandedProposalDetailFixture(): SpecDetailView {
  const base = specControlsDetailFixture();
  const approved = base.revisions[0];
  const elements = base.currentRevision?.elements;
  if (approved === undefined || elements === undefined) {
    throw new Error("Stranded fixture is missing its revision snapshot");
  }
  const stranded: SpecRevision = {
    ...approved,
    id: "revision-2",
    number: 2,
    state: "proposed",
    authoringStage: "requirements",
    basedOnRevisionId: approved.id,
    approvedAt: null,
  };
  const forkedPast: SpecRevision = {
    ...approved,
    id: "revision-3",
    number: 3,
    state: "approved",
    basedOnRevisionId: approved.id,
  };
  const revisions = [approved, stranded, forkedPast];
  return {
    ...base,
    revisions,
    liveProposals: liveProposalsFixture(revisions, [
      { revision: approved, elements, assumptionCitations: [] },
      { revision: stranded, elements, assumptionCitations: [] },
      { revision: forkedPast, elements, assumptionCitations: [] },
    ]),
    baseRevision: { revision: approved, elements, assumptionCitations: [] },
    currentRevision: {
      revision: forkedPast,
      elements,
      assumptionCitations: [],
    },
    currentApprovedRevision: {
      revision: forkedPast,
      elements,
      assumptionCitations: [],
    },
    executionRevisionSnapshots: [],
  };
}

export function specControlsDetailFixture(
  executionState: "none" | "definition_review" | "running" = "none",
): SpecDetailView {
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
    externalDelivery: null,
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
  const executions =
    executionState === "none"
      ? []
      : [
          executionViewFixture({
            revisionId: revision.id,
            revisionNumber: revision.number,
            state: executionState,
          }),
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
    // The fixture's one revision is approved, so nothing is under review.
    liveProposals: [],
    baseRevision: null,
    currentRevision: { revision, elements, assumptionCitations: [] },
    currentApprovedRevision: { revision, elements, assumptionCitations: [] },
    executionRevisionSnapshots: [
      { revision, elements, assumptionCitations: [] },
    ],
    approvals: [],
    comments: [],
    linkedTickets: [],
    elementStatuses: { requirements: [], tasks: [] },
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
      phase: { primary: executionState === "none" ? "approved" : "executing" },
      executions: executions.map((execution) => ({
        id: execution.id,
        state: execution.state,
        workflowSeedSource: execution.workflowSeedSource,
        workflowExecutionId: execution.workflowExecutionId,
        workflowStatus:
          execution.workflowExecutionId === null
            ? null
            : execution.state === "running"
              ? ("running" as const)
              : ("pending" as const),
      })),
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
      coverage: { coveredCriteria: 1, totalCriteria: 1, percentage: 100 },
      delivery: {
        allWaived: false,
        deliveredCount: 0,
        provenCount: 0,
        deliveredExternallyCriterionIds: [],
        totalInScope: 1,
      },
    },
    questions: [],
    assumptions: [],
    executions,
    criterionDispositions:
      executionState === "none"
        ? []
        : [
            {
              execution_id: "execution-1",
              criterion_element_id: "criterion-1",
              disposition: "in_scope",
              waiver_id: null,
              delivered_by_execution_id: null,
              created_at: SPEC_CONTROLS_FIXTURE_NOW,
              updated_at: SPEC_CONTROLS_FIXTURE_NOW,
            },
          ],
    waivers: [],
    gateAdmissions: [],
    importRecord: null,
  };
}

export function denseSpecControlsDetailFixture(
  executionState: "none" | "definition_review" | "running",
): SpecDetailView {
  const detail = specControlsDetailFixture(executionState);
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

  const criterionNumbers = executionState === "none" ? [2] : [2, 3, 4];
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
  detail.status.coverage = {
    coveredCriteria: criterionNumbers.length + 1,
    totalCriteria: criterionNumbers.length + 1,
    percentage: 100,
  };

  if (executionState === "none") return detail;
  const execution = detail.executions[0];
  const sourceDisposition = detail.criterionDispositions[0];
  if (execution === undefined || sourceDisposition === undefined) {
    throw new Error("Execution fixture missing");
  }
  execution.scope = {
    selectedTaskIds: ["task-1", "task-2"],
    selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-4"],
    exclusionDispositions: [
      { criterionId: "criterion-3", disposition: "deferred" },
    ],
  };
  // One populated row per delivery state the running merge gate can host:
  // a graph verdict, a human waiver, and a validated external delivery.
  execution.deliveryProjection = [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      deliveryState: "verdict_recorded",
      verdict: null,
    },
    {
      criterionElementId: "criterion-2",
      handle: "R1.2",
      deliveryState: "waived",
      verdict: null,
    },
    {
      criterionElementId: "criterion-4",
      handle: "R1.4",
      deliveryState: "delivered_elsewhere",
      verdict: null,
    },
  ];
  detail.criterionDispositions = [
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-1",
      disposition: "in_scope",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-2",
      disposition: "waived",
      waiver_id: "waiver-2",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-3",
      disposition: "deferred",
    },
    {
      ...sourceDisposition,
      criterion_element_id: "criterion-4",
      disposition: "delivered_elsewhere",
      delivered_by_execution_id: "execution-prior",
    },
    // The prior run's own self-delivery disposition: the gate's prior-run
    // rule (`isEarlierMergedDelivery`) requires the earlier execution to have
    // marked the criterion delivered by itself, so the current run's
    // delivered_elsewhere row is only production-reachable with this row
    // alongside it.
    {
      ...sourceDisposition,
      execution_id: "execution-prior",
      criterion_element_id: "criterion-4",
      disposition: "in_scope",
      delivered_by_execution_id: "execution-prior",
      created_at: PRIOR_RUN_CREATED_AT,
      updated_at: PRIOR_RUN_DELIVERED_AT,
    },
  ];
  detail.waivers = [
    {
      id: "waiver-2",
      spec_id: detail.spec.id,
      criterion_element_id: "criterion-2",
      revision_id: snapshot.revision.id,
      reason: "Equivalent proof accepted by Alex.",
      waived_at: SPEC_CONTROLS_FIXTURE_NOW,
      stale: 0,
    },
  ];
  detail.executions.push(
    executionViewFixture({
      ...execution,
      id: "execution-prior",
      state: "delivered",
      scope: {
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-4"],
        exclusionDispositions: [],
      },
      // Strictly earlier than the current run: `isEarlierMergedDelivery`
      // rejects a "prior" run created at — or delivered after — the current
      // run's creation, so identical timestamps encode an impossible state.
      createdAt: PRIOR_RUN_CREATED_AT,
      updatedAt: PRIOR_RUN_DELIVERED_AT,
      deliveredAt: PRIOR_RUN_DELIVERED_AT,
      deliveryProjection: [
        {
          criterionElementId: "criterion-4",
          handle: "R1.4",
          deliveryState: "delivered",
          verdict: null,
        },
      ],
    }),
  );
  detail.status.delivery = {
    allWaived: false,
    deliveredCount: 1,
    provenCount: 1,
    deliveredExternallyCriterionIds: [],
    totalInScope: 3,
  };
  return detail;
}

/**
 * Delivery already approved by a human while graph outcomes are still pending. The
 * admission is complete — a real approval id and the human actor — because
 * production's human grant always persists both; a basis-only mutation is a
 * state the live route cannot emit. Lives here (not in a story file) and is
 * re-parsed through the full response schema so the fixture tests guard it.
 */
export function approvedAwaitingProofSpecControlsDetailFixture(): SpecDetailView {
  const detail = denseSpecControlsDetailFixture("running");
  const run = detail.executions[0];
  if (run === undefined) throw new Error("Running execution fixture missing");
  run.deliveryProjection = [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      deliveryState: "verdict_recorded",
      verdict: null,
    },
    {
      criterionElementId: "criterion-2",
      handle: "R1.2",
      deliveryState: "awaiting_outcome",
      verdict: null,
    },
    {
      criterionElementId: "criterion-4",
      handle: "R1.4",
      deliveryState: "awaiting_outcome",
      verdict: null,
    },
  ];
  // The human kept every current-run criterion in scope; the prior run's own
  // self-delivery disposition survives untouched, as it would in production.
  detail.criterionDispositions = detail.criterionDispositions.map((row) =>
    row.execution_id === run.id
      ? {
          ...row,
          disposition: "in_scope" as const,
          waiver_id: null,
          delivered_by_execution_id: null,
        }
      : row,
  );
  detail.waivers = [];
  detail.gateAdmissions = [
    policyAdmissionViewFixture({
      id: "admission-delivery-1",
      gate: "delivery",
      basis: "human_approval",
      approvalId: "approval-delivery-1",
      executionId: run.id,
      actor: { kind: "human" },
    }),
  ];
  return specDetailViewSchema.parse(detail);
}

/**
 * A spec born by import and already delivered outside this system, with every
 * imported question answered and every imported assumption disposed in the
 * bundle. Its gates were crossed on the source document's word, so it carries
 * import-basis admissions and no approval rows at all: an import writes none,
 * and a fixture that invented one would let a surface pass a human sign-off
 * the import never performed.
 */
export function importedDeliveredSpecDetailFixture(): SpecDetailView {
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
  detail.status.phase = { primary: "delivered" };
  detail.status.delivery = {
    allWaived: false,
    deliveredCount: 1,
    provenCount: 0,
    deliveredExternallyCriterionIds: ["criterion-1"],
    totalInScope: 1,
  };
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
  const detail = importedDeliveredSpecDetailFixture();
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
  detail.executionRevisionSnapshots = [amendment];
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
      externalDelivery: null,
    },
    elements: approved.elements,
    assumptionCitations: approved.assumptionCitations,
  };
  detail.revisions = [approved.revision, draft.revision];
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
