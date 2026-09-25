import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createSpecEventsRepo,
  type SpecEventsRepo,
} from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import {
  createSpecReviewRepo,
  type SpecReviewRepo,
} from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type ApprovalRequestPort,
  type AuthoringService,
} from "./authoring-service";
import {
  serializeSubjectFingerprint,
  subjectFingerprint,
  type ApprovalSubject,
} from "./approval-applicability";
import { assumptionCitationSnapshot } from "./attention-records";
import { createSpecEventsPublisher } from "./events";
import type { ApprovalRequestReceipt, ReviewResult } from "./review-service";
import { toDiffCitations, toDiffRows } from "./revision-diff-projections";
import type { SpecGate } from "./schemas";
import {
  PROPOSAL_NOTES_MAX_CHARACTERS,
  oversizedProposalNotesRefusal,
  proposalNotes,
} from "./proposal-notes";

const PROJECT_PATH = "/repos/native-sdd-propose";
const ACTOR = { kind: "agent", conversationId: "conversation-1" } as const;

let db: Db;
let specs: SpecsRepo;
let review: SpecReviewRepo;
let events: SpecEventsRepo;
let service: AuthoringService;
let idSequence: number;
let timeSequence: number;
let approvalRequestCalls: Parameters<
  ApprovalRequestPort["requestApproval"]
>[0][];
let approvalRequestResponder: ApprovalRequestPort["requestApproval"];

/** The shape the review service answers a durably filed gate ask with. */
function filedReceipt(
  gate: SpecGate,
  revisionId: string,
  fields: Partial<ApprovalRequestReceipt> = {},
): ReviewResult<ApprovalRequestReceipt> {
  return {
    ok: true,
    value: {
      revisionId,
      gate,
      subject: gate,
      scope: "gate",
      attentionId: `attention-${gate}`,
      alreadyRequested: false,
      elementId: null,
      outstandingSubjects: [],
      signOffOutstanding: true,
      deliveryOutcome: "delivered",
      ...fields,
    },
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  review = createSpecReviewRepo(db);
  const eventRows = createSpecEventsRepo(db);
  events = eventRows;
  idSequence = 0;
  timeSequence = 0;
  approvalRequestCalls = [];
  approvalRequestResponder = (input) =>
    Promise.resolve(filedReceipt(input.gate, input.revisionId));
  service = createAuthoringService({
    attention: eventRows,
    specs,
    review,
    links: createSpecLinksRepo(db),
    approvalRequests: {
      requestApproval(input) {
        approvalRequestCalls.push(input);
        return approvalRequestResponder(input);
      },
    },
    events: createSpecEventsPublisher({
      appendInTransaction: eventRows.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-18T13:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => db.close());

async function createSpec(
  preset: "contract-bearing" | "exploratory" | "fast-path",
  statement = "The transition is server-enforced.",
) {
  // The first requirement travels inside the create call — the durable spec
  // is born from its first draft save.
  const created = await service.createSpec({
    projectPath: PROJECT_PATH,
    slug: `spec-${preset}`,
    name: `Spec ${preset}`,
    gatePolicy: { preset: "contract-bearing" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement,
        priority: "must",
        risk: "high",
      },
    },
    actor: ACTOR,
  });
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
  ).run(created.draft.id);
  await specs.updateGatePolicy({
    specId: created.spec.id,
    gatePolicy: { preset },
    updatedAt: "2026-07-18T13:00:00.500Z",
  });
  return created;
}

/** The fingerprint the review service records for a content approval. */
async function serializedFingerprint(
  revisionId: string,
  subject: ApprovalSubject,
): Promise<string> {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) throw new Error(`missing snapshot ${revisionId}`);
  const fingerprint = subjectFingerprint(toDiffRows(snapshot), subject, {
    citationContractVersion: snapshot.revision.citationContractVersion,
    citations: toDiffCitations(snapshot),
  });
  if (fingerprint === null) {
    throw new Error(`revision ${revisionId} does not carry the subject`);
  }
  return serializeSubjectFingerprint(fingerprint);
}

async function addCleanContent(specId: string, revisionId: string) {
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
  ).run(revisionId);
  await service.upsertDraftElement({
    specId,
    revisionId,
    elementId: "criterion-1",
    kind: "criterion",
    parentElementId: "requirement-1",
    position: 1,
    payload: {
      kind: "criterion",
      text: "An invalid transition is refused.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: ACTOR,
  });
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
  ).run(revisionId);
  await service.upsertDraftElement({
    specId,
    revisionId,
    elementId: "task-1",
    kind: "task",
    parentElementId: null,
    position: 2,
    payload: {
      kind: "task",
      title: "Implement transition",
      instructions: "Implement the server predicate.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-1"],
      dependsOnTaskElementIds: [],
    },
    baseElementVersion: null,
    actor: ACTOR,
  });
}

/** The durable review-request and absorbed sign-off events of a spec. */
function proposeEvents(specId: string) {
  return events
    .findBySpecId(specId)
    .filter((row) => row.event_type === "spec-revision-changed")
    .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
    .filter(
      (payload) => payload.kind === "proposed" || payload.kind === "approved",
    );
}

function admissionCount(): unknown {
  return db.prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions").get();
}

describe("AuthoringService propose transaction", () => {
  /**
   * Propose is the author's review request. Under a Gate dial a human act
   * follows it, so it freezes nothing: the human approves and signs off the
   * same draft the author can keep editing.
   */
  it("records a review request under a Gate dial and leaves the revision an editable draft", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    const notes = "## Ready for review\n\nR1 and its plan are complete.";

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
      notes,
    });

    expect(result).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: { id: created.draft.id, state: "draft", contentHash: null },
    });
    if (!result.ok) throw new Error("expected successful proposal");
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
      contentHash: null,
      approvedAt: null,
    });
    expect(proposeEvents(created.spec.id)).toEqual([
      { kind: "proposed", revisionId: created.draft.id, notes },
    ]);
    expect(approvalRequestCalls.map(({ gate }) => gate)).toEqual([
      "requirements",
      "plan",
    ]);
    expect(result.approvalRequests.map(({ outcome }) => outcome)).toEqual([
      "filed",
      "filed",
    ]);
    expect(admissionCount()).toEqual({ count: 0 });
    expect(result.diff.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elementId: "requirement-1",
          classification: "added",
        }),
        expect.objectContaining({
          elementId: "criterion-1",
          classification: "added",
        }),
        expect.objectContaining({
          elementId: "task-1",
          classification: "added",
        }),
      ]),
    );
  });

  /**
   * Review runs on the open draft, so asking for it must not cost the author
   * the ability to repair what the reviewer finds.
   */
  it("keeps the draft writable after a review request", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    const proposed = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });
    expect(proposed.ok).toBe(true);

    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-1",
      kind: "task",
      parentElementId: null,
      position: 2,
      payload: {
        kind: "task",
        title: "Implement transition",
        instructions: "Implement the server predicate and its refusal.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
      baseElementVersion: 1,
      actor: ACTOR,
    });

    const snapshot = await specs.getRevisionSnapshot(created.draft.id);
    expect(snapshot?.revision).toMatchObject({
      id: created.draft.id,
      state: "draft",
    });
    expect(
      snapshot?.elements.find(({ element }) => element.id === "task-1")?.version
        .payload,
    ).toMatchObject({
      instructions: "Implement the server predicate and its refusal.",
    });
  });

  /**
   * The receipt carries the server's post-transition projection because a
   * blocker derived from the revision's authoring stage alone names the wrong
   * gate whenever an earlier stage is also consulted, and cannot name the
   * subject a request needs.
   */
  it("embeds the post-transition pending block naming every consulted gate and its outstanding subjects", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    // The draft is pinned at the plan stage, but its requirement is new since
    // the governance baseline, so requirements is consulted too — and it is
    // what a human acts on first.
    expect(result.pendingBlock?.gates).toEqual([
      {
        gate: "requirements",
        dial: "gate",
        state: "pending",
        applicability: {
          reason: "changed_since_governance_base",
          governanceBaseRevisionId: null,
        },
        subjects: ["R1"],
        // A natively authored spec carries no import admission, so nothing is
        // settled by anything other than a human act.
        importCarriedSubjects: [],
      },
      {
        gate: "plan",
        dial: "gate",
        state: "pending",
        applicability: {
          reason: "current_stage",
          governanceBaseRevisionId: null,
        },
        subjects: ["plan"],
        importCarriedSubjects: [],
      },
    ]);
    expect(result.pendingBlock?.outstandingSubjects).toEqual([
      { gate: "requirements", subject: "R1", elementId: "requirement-1" },
      { gate: "plan", subject: "plan", elementId: null },
    ]);
    expect(result.pendingBlock?.signOff).toMatchObject({
      revisionId: created.draft.id,
      state: "blocked",
      outstandingSubjectCount: 2,
    });
    // A human owes the outstanding approvals, so the block names the same
    // actor as the next action even though sign-off is not yet possible.
    expect(result.pendingBlock?.actsNext).toBe("human");
    // The subject a request needs is in the block, so the caller never has to
    // guess it from the stage.
    expect(result.pendingBlock?.instruction).toContain("R1");
    expect(result.nextAction).toMatchObject({
      kind: "approve_subject",
      actsNext: "human",
      gate: "requirements",
      subject: "R1",
    });
  });

  /**
   * R11.5: the combined dial makes the sign-off itself the approval of every
   * item. A receipt that lists the items as outstanding subjects points the
   * caller at `request-approval` for an act the policy collapsed, and at the
   * same time reports the revision ready to sign off.
   */
  it("names the sign-off rather than per-item approvals under the combined dial", async () => {
    const created = await createSpec("fast-path");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.pendingBlock?.outstandingSubjects).toEqual([]);
    expect(result.pendingBlock?.signOff).toMatchObject({
      state: "ready",
      unmetConditions: [],
    });
    expect(result.pendingBlock?.actsNext).toBe("human");
    expect(result.nextAction).toMatchObject({
      kind: "sign_off_revision",
      actsNext: "human",
      gate: null,
      subject: null,
    });
  });

  it("carries sign-off conditions that no subject approval can clear", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    const rejectedAssumptionRow = {
      id: "assumption-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: "requirement-1",
      text: "The baseline never moves.",
      proposed_by_json: JSON.stringify(ACTOR),
      record_version: 1,
      disposition: "rejected",
      disposed_at: "2026-07-18T13:00:00.900Z",
      withdrawn_at: null,
      supersedes_assumption_id: null,
      supersession_operation_id: null,
      supersession_request_hash: null,
      created_at: "2026-07-18T13:00:00.900Z",
      updated_at: "2026-07-18T13:00:00.900Z",
    } as const;
    review.insertAssumption(rejectedAssumptionRow);
    await specs.mutateDraftCitation({
      operation: "cite",
      specId: created.spec.id,
      revisionId: created.draft.id,
      assumptionId: rejectedAssumptionRow.id,
      elementId: "requirement-1",
      expectedCitationVersion: created.draft.citationVersion,
      snapshot: assumptionCitationSnapshot(
        rejectedAssumptionRow,
        "2026-07-18T13:00:00.900Z",
      ),
      updatedAt: "2026-07-18T13:00:00.900Z",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.pendingBlock?.unmetConditions).toContain(
      "A1 was rejected but R1 still cites it.",
    );
  });

  it("returns exactly the panel findings and leaves a lint-refused revision Draft", async () => {
    const created = await createSpec("contract-bearing", "Incomplete.");
    review.insertQuestion({
      id: "question-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: null,
      text: "Which advisory remains open?",
      provenance_json: JSON.stringify(ACTOR),
      record_version: 1,
      status: "open",
      answer: null,
      answered_at: null,
      withdrawn_at: null,
      created_at: "2026-07-18T13:10:00.000Z",
      updated_at: "2026-07-18T13:10:00.000Z",
    });
    const panel = await service.lintDraft(created.spec.id, created.draft.id);
    expect(panel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "blocks_propose" }),
        expect.objectContaining({ severity: "advisory" }),
      ]),
    );

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "lint_blocked",
        findings: panel,
      }),
    });
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
    expect(
      (await specs.findRevision(created.draft.id))?.contentHash,
    ).toBeNull();
  });

  it("refuses a plan containing a task that covers no criterion", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "task-2",
      kind: "task",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task",
        title: "Prepare implementation",
        instructions: "Prepare the implementation surface.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });

    const panel = await service.lintDraft(created.spec.id, created.draft.id);
    expect(panel).toContainEqual({
      ruleId: "9.3.task-without-criterion",
      severity: "blocks_propose",
      elementHandle: "T2",
      message: "T2 covers no acceptance criterion.",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "lint_blocked",
        findings: panel,
      }),
    });
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
  });

  it("absorbs all Notify/Off propose gates into policy sign-off with admissions and zero approvals", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toMatchObject({
      ok: true,
      absorbedSignOff: true,
      revision: { state: "approved" },
    });
    // No human act follows, so the review request is the freeze itself.
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "approved",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvedAt: expect.any(String),
    });
    expect(await specs.verifyRevision(created.draft.id)).toMatchObject({
      ok: true,
    });
    expect(proposeEvents(created.spec.id)).toEqual([
      expect.objectContaining({
        kind: "approved",
        revisionId: created.draft.id,
      }),
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_approvals").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "SELECT gate, basis FROM spec_gate_admissions ORDER BY gate ASC",
        )
        .all(),
    ).toEqual([
      { gate: "plan", basis: "notify_policy" },
      { gate: "requirements", basis: "notify_policy" },
    ]);
  });

  /**
   * The absorbed sign-off freezes the draft, so its preconditions are the
   * sign-off's. When they fail the review request writes nothing at all: an
   * admission recorded for a revision that never froze would claim a gate
   * passed that did not.
   */
  it("writes nothing when the absorbed sign-off's preconditions fail", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);
    review.saveComment({
      id: "comment-1",
      spec_id: created.spec.id,
      thread_id: "thread-1",
      parent_comment_id: null,
      element_id: "requirement-1",
      anchor_json: "{}",
      revision_id: created.draft.id,
      body: "Resolve this before sign-off.",
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 1,
      resolution: "open",
      created_at: "2026-07-18T13:20:00.000Z",
      updated_at: "2026-07-18T13:20:00.000Z",
    });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "gate_blocked",
        unmetConditions: ["Blocking thread thread-1 is unresolved."],
      }),
    });
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
      contentHash: null,
      approvedAt: null,
    });
    expect(admissionCount()).toEqual({ count: 0 });
    expect(proposeEvents(created.spec.id)).toEqual([]);
  });

  /**
   * A draft is edited in place while it is reviewed, so whether an approval
   * still counts is decided at read time from the fingerprint it recorded.
   * The review request therefore rewrites no approval row and publishes no
   * validity change.
   */
  it("leaves every approval row as granted when a changed amendment is proposed", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(created.draft.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "decision-1",
      kind: "decision",
      parentElementId: null,
      position: 3,
      payload: {
        kind: "decision",
        title: "Transition ownership",
        chosenApproach: "The server owns transitions.",
        rejectedAlternatives: [],
        reason: "The gate cannot depend on prompt etiquette.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
    ).run(created.draft.id);
    const initial = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });
    if (!initial.ok) throw new Error("initial revision should be approved");

    for (const approval of [
      {
        id: "approval-requirement",
        subject_kind: "requirement" as const,
        element_id: "requirement-1",
      },
      {
        id: "approval-decision",
        subject_kind: "decision" as const,
        element_id: "decision-1",
      },
      {
        id: "approval-plan",
        subject_kind: "plan" as const,
        element_id: null,
      },
    ]) {
      review.saveApproval({
        ...approval,
        spec_id: created.spec.id,
        revision_id: created.draft.id,
        subject_fingerprint_json: await serializedFingerprint(
          created.draft.id,
          {
            subjectKind: approval.subject_kind,
            elementId: approval.element_id,
          },
        ),
        approver: "alex",
        granted_at: "2026-07-18T13:30:00.000Z",
        validity: "valid",
      });
    }

    const { revision: amendment } = await service.openAmendment({
      specId: created.spec.id,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'requirements' WHERE id = ?",
    ).run(amendment.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "The transition and refusal are server-enforced.",
        priority: "must",
        risk: "high",
      },
      baseElementVersion: 1,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
    ).run(amendment.id);
    await service.removeDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "decision-1",
      baseElementVersion: 1,
      actor: ACTOR,
    });
    db.prepare(
      "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
    ).run(amendment.id);
    await service.upsertDraftElement({
      specId: created.spec.id,
      revisionId: amendment.id,
      elementId: "task-1",
      kind: "task",
      parentElementId: null,
      position: 2,
      payload: {
        kind: "task",
        title: "Implement transition",
        instructions: "Implement the server predicate.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
      baseElementVersion: null,
      reintroduceHistorical: true,
      actor: ACTOR,
    });

    const proposed = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      actor: ACTOR,
    });
    expect(proposed.ok).toBe(true);
    expect(
      review
        .findApprovalsBySpecId(created.spec.id)
        .map(({ id, validity }) => ({ id, validity })),
    ).toEqual([
      { id: "approval-decision", validity: "valid" },
      { id: "approval-plan", validity: "valid" },
      { id: "approval-requirement", validity: "valid" },
    ]);
    expect(
      events
        .findBySpecId(created.spec.id)
        .filter((row) => row.event_type === "spec-approval-changed"),
    ).toEqual([]);
  });

  /**
   * The author may ask again after repairing what a reviewer found; each ask
   * is recorded and the draft stays the one under review.
   */
  it("accepts a repeated review request on the same draft", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    const repeated = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(repeated).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: { id: created.draft.id, state: "draft" },
    });
    expect(proposeEvents(created.spec.id)).toEqual([
      { kind: "proposed", revisionId: created.draft.id },
      { kind: "proposed", revisionId: created.draft.id },
    ]);
  });

  it("refuses proposing a revision that is already approved", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);
    const absorbed = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });
    expect(absorbed).toMatchObject({ ok: true, absorbedSignOff: true });

    const repeated = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(repeated).toEqual({
      ok: false,
      refusal: expect.objectContaining({ code: "gate_blocked" }),
    });
    expect(proposeEvents(created.spec.id)).toHaveLength(1);
  });
});

/**
 * The author's disposition document (design §8). Review converges when the
 * reviewer can read what the round claims to have changed and closed before
 * re-deriving it from the diff, so the document is persisted with the
 * transition it describes rather than posted beside it.
 */
describe("AuthoringService propose notes", () => {
  const NOTES = "## Disposition\n\nClosed F3 by rebinding the loop exit.";

  it("persists the notes on the durable propose event in the propose transaction", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
      notes: NOTES,
    });

    expect(result.ok).toBe(true);
    expect(proposeEvents(created.spec.id)).toEqual([
      { kind: "proposed", revisionId: created.draft.id, notes: NOTES },
    ]);
    expect(
      proposalNotes(events.findBySpecId(created.spec.id), created.draft.id),
    ).toBe(NOTES);
  });

  /**
   * A propose that carries no notes must keep writing exactly the payload it
   * wrote before this field existed — a `notes: null` key would make every
   * legacy row look different from every new one for no reader's benefit.
   */
  it("writes the pre-existing payload shape when no notes are supplied", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    expect(proposeEvents(created.spec.id)).toEqual([
      { kind: "proposed", revisionId: created.draft.id },
    ]);
    expect(
      proposalNotes(events.findBySpecId(created.spec.id), created.draft.id),
    ).toBeNull();
  });

  it("keeps the notes on a propose that absorbed the sign-off", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
      notes: NOTES,
    });

    expect(result).toMatchObject({ ok: true, absorbedSignOff: true });
    expect(
      proposalNotes(events.findBySpecId(created.spec.id), created.draft.id),
    ).toBe(NOTES);
  });

  it("refuses an over-cap document naming the cap and proposes nothing", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    const oversized = "x".repeat(PROPOSAL_NOTES_MAX_CHARACTERS + 1);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
      notes: oversized,
    });

    expect(result).toEqual({
      ok: false,
      refusal: oversizedProposalNotesRefusal(oversized),
    });
    // No propose event, and the revision is still editable: the refusal costs
    // the author nothing but the resend.
    expect(proposeEvents(created.spec.id)).toEqual([]);
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
      contentHash: null,
    });
  });

  it("admits a document exactly at the cap", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    const atCap = "x".repeat(PROPOSAL_NOTES_MAX_CHARACTERS);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
      notes: atCap,
    });

    expect(result.ok).toBe(true);
    expect(
      proposalNotes(events.findBySpecId(created.spec.id), created.draft.id),
    ).toBe(atCap);
  });
});

/**
 * R10.13: the ask a proposal owes a human is filed by the server that froze
 * the revision, not by whichever client happened to call propose. The
 * coordinator runs after the commit, so no filing outcome can roll the
 * proposal back — the receipt reports what it did instead.
 */
describe("propose approval-request coordinator", () => {
  it("files one gate-scoped ask per gate the proposal leaves pending", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    // The plan-stage draft authors a new requirement, so requirements is
    // consulted alongside plan and each pending gate owes its own ask.
    expect(approvalRequestCalls).toEqual([
      {
        specId: created.spec.id,
        revisionId: created.draft.id,
        gate: "requirements",
        actor: ACTOR,
      },
      {
        specId: created.spec.id,
        revisionId: created.draft.id,
        gate: "plan",
        actor: ACTOR,
      },
    ]);
    expect(result.approvalRequests).toEqual([
      {
        gate: "requirements",
        outcome: "filed",
        attentionId: "attention-requirements",
      },
      { gate: "plan", outcome: "filed", attentionId: "attention-plan" },
    ]);
  });

  /**
   * Coordinator-level mapping only: what the receipt says when the request
   * verb answers that the identity it was handed is already open. Which
   * lifecycle actually produces that answer is proven against the real service
   * in propose-approval-requests.lifecycle.test.ts.
   */
  it("maps an already-requested receipt to already-filed carrying the port's attention id", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    approvalRequestResponder = (input) =>
      Promise.resolve(
        filedReceipt(input.gate, input.revisionId, {
          alreadyRequested: true,
          attentionId: "attention-stable",
        }),
      );

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.approvalRequests).toEqual([
      {
        gate: "requirements",
        outcome: "already-filed",
        attentionId: "attention-stable",
      },
      {
        gate: "plan",
        outcome: "already-filed",
        attentionId: "attention-stable",
      },
    ]);
  });

  /**
   * R11.5: the combined dial makes the one sign-off the approval of every
   * item, so a per-gate ask would open three Needs You rows for a single
   * human act that none of them names.
   */
  it("files nothing when the policy collapses the approvals into one sign-off", async () => {
    const created = await createSpec("fast-path");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(approvalRequestCalls).toEqual([]);
    expect(result.approvalRequests).toEqual([
      { gate: "requirements", outcome: "not-needed", attentionId: null },
      { gate: "plan", outcome: "not-needed", attentionId: null },
    ]);
  });

  it("files nothing when the propose absorbed its own sign-off", async () => {
    const created = await createSpec("exploratory");
    await addCleanContent(created.spec.id, created.draft.id);

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.absorbedSignOff).toBe(true);
    expect(approvalRequestCalls).toEqual([]);
    // The revision froze in the same act, so no gate is left to ask about.
    expect(result.approvalRequests).toEqual([]);
  });

  it("reports not-needed when the gate refuses the ask as already satisfied", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    approvalRequestResponder = () =>
      Promise.resolve({
        ok: false,
        refusal: {
          code: "already_satisfied",
          unmetConditions: ["The gate is already admitted for this revision."],
          instruction: "Read the spec status; this gate is no longer blocking.",
        },
      });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.approvalRequests).toEqual([
      { gate: "requirements", outcome: "not-needed", attentionId: null },
      { gate: "plan", outcome: "not-needed", attentionId: null },
    ]);
  });

  it("reports delivery-uncertain when the durable ask committed but its notice did not", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    approvalRequestResponder = (input) =>
      Promise.resolve(
        filedReceipt(input.gate, input.revisionId, {
          deliveryOutcome: "delivery-uncertain",
        }),
      );

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.approvalRequests).toEqual([
      {
        gate: "requirements",
        outcome: "delivery-uncertain",
        attentionId: "attention-requirements",
      },
      {
        gate: "plan",
        outcome: "delivery-uncertain",
        attentionId: "attention-plan",
      },
    ]);
  });

  it("keeps the proposal successful and reports not-filed when the filing itself fails", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    approvalRequestResponder = () =>
      Promise.reject(new Error("attention store unavailable"));

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.revision.state).toBe("draft");
    expect(result.approvalRequests).toEqual([
      { gate: "requirements", outcome: "not-filed", attentionId: null },
      { gate: "plan", outcome: "not-filed", attentionId: null },
    ]);
    // The review request is durable whatever the coordinator managed.
    expect(proposeEvents(created.spec.id)).toEqual([
      { kind: "proposed", revisionId: created.draft.id },
    ]);
  });

  it("reports not-filed when the request is refused for any other reason", async () => {
    const created = await createSpec("contract-bearing");
    await addCleanContent(created.spec.id, created.draft.id);
    approvalRequestResponder = () =>
      Promise.resolve({
        ok: false,
        refusal: {
          code: "stale_revision",
          unmetConditions: ["Another revision is current."],
          instruction: "Request approval for the current revision.",
        },
      });

    const result = await service.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: ACTOR,
    });

    if (!result.ok) throw new Error("expected successful proposal");
    expect(result.approvalRequests).toEqual([
      { gate: "requirements", outcome: "not-filed", attentionId: null },
      { gate: "plan", outcome: "not-filed", attentionId: null },
    ]);
  });
});
