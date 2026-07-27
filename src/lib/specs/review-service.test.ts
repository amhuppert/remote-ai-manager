import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
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
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createReviewService, type ReviewService } from "./review-service";

const PROJECT_PATH = "/repos/native-sdd-review";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let specEvents: ReturnType<typeof createSpecEventsRepo>;
let authoring: AuthoringService;
let reviewing: ReviewService;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  reviewRepo = createSpecReviewRepo(db);
  specEvents = createSpecEventsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: specEvents.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  idSequence = 0;
  timeSequence = 0;
  const deps = {
    specs,
    review: reviewRepo,
    links: createSpecLinksRepo(db),
    events,
    attention: specEvents,
    newId(prefix: string) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-18T14:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  reviewing = createReviewService({
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  });
});

afterEach(() => db.close());

async function proposedSpec(
  preset: "contract-bearing" | "fast-path" = "contract-bearing",
) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: `review-${preset}`,
    name: `Review ${preset}`,
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "Review gates are durable.",
        priority: "must" as const,
        risk: "high" as const,
      },
    },
    actor: AGENT,
  });
  for (const element of [
    {
      elementId: "criterion-1",
      kind: "criterion" as const,
      parentElementId: "requirement-1",
      position: 1,
      payload: {
        kind: "criterion" as const,
        text: "An unapproved sign-off is refused.",
        validationStrategy: { kinds: ["test_run" as const] },
      },
    },
    {
      elementId: "decision-1",
      kind: "decision" as const,
      parentElementId: null,
      position: 2,
      payload: {
        kind: "decision" as const,
        title: "Transition owner",
        chosenApproach: "The server owns review transitions.",
        rejectedAlternatives: [],
        reason: "No prompt can bypass the gate.",
        tracedRequirementElementIds: ["requirement-1"],
      },
    },
    {
      elementId: "task-1",
      kind: "task" as const,
      parentElementId: null,
      position: 3,
      payload: {
        kind: "task" as const,
        title: "Implement review service",
        instructions: "Implement and test the review service.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: ["decision-1"],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
    },
  ]) {
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      ...element,
      baseElementVersion: null,
      actor: AGENT,
    });
  }
  if (preset !== "fast-path") {
    await specs.updateGatePolicy({
      specId: created.spec.id,
      gatePolicy: { preset },
      updatedAt: "2026-07-18T14:00:00.500Z",
    });
  }
  await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: created.draft.id,
    actor: AGENT,
  });
  return created;
}

describe("ReviewService", () => {
  it("signs off a requirements-stage revision without plan approval and records only its concluding gate", async () => {
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug: "requirements-stage-review",
      name: "Requirements-stage review",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: {
        elementId: "requirements-stage-r1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Requirements are reviewed before design.",
          priority: "must",
          risk: "high",
        },
      },
      actor: AGENT,
    });
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirements-stage-c1",
      kind: "criterion",
      parentElementId: "requirements-stage-r1",
      position: 1,
      payload: {
        kind: "criterion",
        text: "The first review does not require a plan approval.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    await expect(
      authoring.proposeRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        actor: AGENT,
      }),
    ).resolves.toMatchObject({ ok: true, absorbedSignOff: false });
    await expect(
      reviewing.bulkApprove({
        specId: created.spec.id,
        revisionId: created.draft.id,
        subjects: [{ subjectKind: "plan", elementId: null }],
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "stage_blocked" },
    });
    await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirements-stage-r1",
      approver: "alex",
      actor: HUMAN,
    });

    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        revision: { state: "approved", authoringStage: "requirements" },
      },
    });
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(created.draft.id)
        .map(({ gate, basis }) => ({ gate, basis })),
    ).toEqual([{ gate: "requirements", basis: "human_approval" }]);

    await expect(
      authoring.openAmendment({ specId: created.spec.id, actor: AGENT }),
    ).resolves.toMatchObject({ authoringStage: "design" });
  });

  it("comments without unfreezing and request-changes preserves the withdrawn snapshot while opening a based-on draft", async () => {
    const created = await proposedSpec();
    const before = await specs.getRevisionSnapshot(created.draft.id);

    const comment = await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-1",
      parentCommentId: null,
      anchor: { quote: "Review gates are durable." },
      body: "Please make the refusal explicit.",
      blocking: true,
      actor: HUMAN,
    });
    expect(comment.ok).toBe(true);
    expect((await specs.findRevision(created.draft.id))?.state).toBe(
      "proposed",
    );

    const result = await reviewing.requestChanges({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: HUMAN,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        withdrawn: { id: created.draft.id, state: "withdrawn" },
        draft: {
          state: "draft",
          basedOnRevisionId: created.draft.id,
          authoringStage: created.draft.authoringStage,
        },
      },
    });
    const after = await specs.getRevisionSnapshot(created.draft.id);
    expect(after?.revision.contentHash).toBe(before?.revision.contentHash);
    expect(after?.elements).toEqual(before?.elements);
  });

  it("refuses sign-off for a blocking thread, a rejected attached assumption, and missing configured approvals", async () => {
    const created = await proposedSpec();
    const missingApprovals = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(missingApprovals).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });

    reviewRepo.saveAssumption({
      id: "assumption-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: "decision-1",
      text: "The gate is already enforced.",
      proposed_by_json: JSON.stringify(AGENT),
      disposition: "rejected",
      disposed_at: "2026-07-18T14:20:00.000Z",
      created_at: "2026-07-18T13:59:00.000Z",
      updated_at: "2026-07-18T14:20:00.000Z",
    });
    const rejectedAssumption = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(rejectedAssumption).toMatchObject({
      ok: false,
      refusal: {
        code: "lint_blocked",
        findings: [
          expect.objectContaining({ ruleId: "9.8.rejected-cited-assumption" }),
        ],
      },
    });

    await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-blocking",
      parentCommentId: null,
      anchor: {},
      body: "Blocking",
      blocking: true,
      actor: HUMAN,
    });
    const blockingThread = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(blockingThread).toMatchObject({
      ok: false,
      refusal: {
        unmetConditions: expect.arrayContaining([
          "Blocking thread thread-blocking is unresolved.",
        ]),
      },
    });
  });

  it("bulk approval persists the same durable per-subject rows and permits sign-off", async () => {
    const created = await proposedSpec();
    const bulk = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    expect(bulk.ok).toBe(true);
    const rows = reviewRepo.findApprovalsBySpecId(created.spec.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(({ granted_at }) => granted_at)).size).toBe(1);
    expect(rows.every(({ validity }) => validity === "valid")).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
  });

  it("treats repeated sign-off of an approved revision as a durable no-op", async () => {
    const created = await proposedSpec();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    const first = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    if (!first.ok) throw new Error("expected initial sign-off");

    const before = {
      revision: await specs.findRevision(created.draft.id),
      approvals: reviewRepo.findApprovalsBySpecId(created.spec.id),
      admissions: reviewRepo.findGateAdmissionsByRevision(created.draft.id),
      events: specEvents.findBySpecId(created.spec.id),
    };
    const repeated = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "must-not-replace-alex",
      actor: AGENT,
    });

    expect(repeated).toEqual(first);
    expect(await specs.findRevision(created.draft.id)).toEqual(before.revision);
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual(
      before.approvals,
    );
    expect(reviewRepo.findGateAdmissionsByRevision(created.draft.id)).toEqual(
      before.admissions,
    );
    expect(specEvents.findBySpecId(created.spec.id)).toEqual(before.events);
  });

  it("refuses bulk plan approval for draft and withdrawn revisions", async () => {
    const created = await proposedSpec();
    const requested = await reviewing.requestChanges({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: HUMAN,
    });
    if (!requested.ok) throw new Error("expected requested changes");

    for (const revisionId of [created.draft.id, requested.value.draft.id]) {
      const result = await reviewing.bulkApprove({
        specId: created.spec.id,
        revisionId,
        subjects: [{ subjectKind: "plan", elementId: null }],
        approver: "alex",
        actor: HUMAN,
      });
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    }
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
  });

  it("unapprove removes the recorded approval so the subject counts as outstanding again", async () => {
    const created = await proposedSpec();
    const approved = await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      approver: "alex",
      actor: HUMAN,
    });
    expect(approved.ok).toBe(true);

    const agentAttempt = await reviewing.unapproveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      actor: AGENT,
    });
    expect(agentAttempt).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });

    const noApproval = await reviewing.unapproveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "decision",
      elementId: "decision-1",
      actor: HUMAN,
    });
    expect(noApproval).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });

    const result = await reviewing.unapproveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      actor: HUMAN,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { element_id: "requirement-1" },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);

    const reapproved = await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      approver: "alex",
      actor: HUMAN,
    });
    expect(reapproved).toMatchObject({
      ok: true,
      value: { validity: "valid" },
    });
  });

  it("refuses unapprove once the revision is signed off", async () => {
    const created = await proposedSpec();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed.ok).toBe(true);

    const afterSignOff = await reviewing.unapproveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement",
      elementId: "requirement-1",
      actor: HUMAN,
    });
    expect(afterSignOff).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(
      reviewRepo
        .findApprovalsBySpecId(created.spec.id)
        .filter(({ subject_kind }) => subject_kind === "requirement"),
    ).toHaveLength(1);
  });

  it("refreshes an item re-approval instead of duplicating its durable subject", async () => {
    const created = await proposedSpec();
    const input = {
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjectKind: "requirement" as const,
      elementId: "requirement-1",
      approver: "alex",
      actor: HUMAN,
    };
    const first = await reviewing.approveItem(input);
    const second = await reviewing.approveItem(input);
    expect(first.ok && second.ok && second.value.id).toBe(
      first.ok ? first.value.id : "",
    );
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toHaveLength(1);
  });

  it("preserves prior revision sign-off approvals when a later revision is signed off", async () => {
    const created = await proposedSpec();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    const first = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    if (!first.ok || first.value.approval === null) {
      throw new Error("expected first human sign-off");
    }
    const firstApproval = structuredClone(first.value.approval);

    const amendment = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      actor: AGENT,
    });
    const second = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: amendment.id,
      approver: "alex-secondary",
      actor: HUMAN,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const revisionApprovals = reviewRepo
      .findApprovalsBySpecId(created.spec.id)
      .filter(({ subject_kind }) => subject_kind === "revision");
    expect(revisionApprovals).toHaveLength(2);
    expect(revisionApprovals[0]).toEqual(firstApproval);
    expect(revisionApprovals[1]).toMatchObject({
      revision_id: amendment.id,
      approver: "alex-secondary",
    });
    for (const approval of revisionApprovals) {
      expect(
        reviewRepo
          .findGateAdmissionsByRevision(approval.revision_id)
          .every(({ approval_id }) => approval_id === approval.id),
      ).toBe(true);
    }
  });

  it("finishes a policy-admitted proposed revision as an agent with admissions and zero approval rows", async () => {
    const created = await proposedSpec();
    const policy = await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
      actor: HUMAN,
    });
    expect(policy.ok).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "policy",
      actor: AGENT,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" }, approval: null },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(created.draft.id)
        .map(({ gate, basis, approval_id }) => ({ gate, basis, approval_id })),
    ).toEqual([
      { gate: "requirements", basis: "notify_policy", approval_id: null },
      { gate: "design", basis: "notify_policy", approval_id: null },
      { gate: "plan", basis: "notify_policy", approval_id: null },
    ]);
  });

  it("allows ordinary per-gate approval when fast-path policy has a partial override", async () => {
    const created = await proposedSpec("fast-path");
    await reviewing.changePolicy({
      specId: created.spec.id,
      proposedPolicy: {
        preset: "fast-path",
        overrides: { requirements: "gate" },
      },
      hardConfirmed: true,
      actor: HUMAN,
    });
    const bulk = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    expect(bulk.ok).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
  });

  it("signs off a fast-path revision as the combined approval without a separate fast-track act", async () => {
    const created = await proposedSpec("fast-path");

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const approvals = reviewRepo.findApprovalsBySpecId(created.spec.id);
    expect(
      approvals.map(({ subject_kind, element_id }) => ({
        subject_kind,
        element_id,
      })),
    ).toEqual(
      expect.arrayContaining([
        { subject_kind: "requirement", element_id: "requirement-1" },
        { subject_kind: "decision", element_id: "decision-1" },
        { subject_kind: "plan", element_id: null },
        { subject_kind: "revision", element_id: null },
      ]),
    );
    expect(approvals).toHaveLength(4);

    const revisionApproval = approvals.find(
      (approval) => approval.subject_kind === "revision",
    )!;
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(created.draft.id)
        .map(({ gate, basis, approval_id }) => ({ gate, basis, approval_id })),
    ).toEqual([
      {
        gate: "requirements",
        basis: "human_approval",
        approval_id: revisionApproval.id,
      },
      {
        gate: "design",
        basis: "human_approval",
        approval_id: revisionApproval.id,
      },
      {
        gate: "plan",
        basis: "human_approval",
        approval_id: revisionApproval.id,
      },
    ]);
  });

  it("signs off a fast-path revision after per-item approvals without duplicate approval rows", async () => {
    const created = await proposedSpec("fast-path");
    const bulk = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    expect(bulk.ok).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toHaveLength(4);
  });

  it("refuses a fast-path sign-off by an agent", async () => {
    const created = await proposedSpec("fast-path");

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "agent",
      actor: AGENT,
    });
    expect(signed).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect((await specs.findRevision(created.draft.id))?.state).toBe(
      "proposed",
    );
  });

  it("writes the fast-path combined approvals, sign-off, and admissions all-or-none", async () => {
    const created = await proposedSpec("fast-path");
    await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-1",
      parentCommentId: null,
      anchor: {},
      body: "Still blocking",
      blocking: true,
      actor: HUMAN,
    });

    const failed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(failed).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect(reviewRepo.findGateAdmissionsByRevision(created.draft.id)).toEqual(
      [],
    );
    expect((await specs.findRevision(created.draft.id))?.state).toBe(
      "proposed",
    );

    const resolved = await reviewing.resolveThread({
      specId: created.spec.id,
      revisionId: created.draft.id,
      threadId: "thread-1",
      resolution: "resolved",
      actor: HUMAN,
    });
    expect(resolved.ok).toBe(true);
    const succeeded = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      approver: "alex",
      actor: HUMAN,
    });
    expect(succeeded).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toHaveLength(4);
    expect(
      reviewRepo.findGateAdmissionsByRevision(created.draft.id),
    ).toHaveLength(3);
  });
});
