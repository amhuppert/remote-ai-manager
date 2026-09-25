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
import { revisionReviewHash } from "./review-hash";
import { createReviewService, type ReviewService } from "./review-service";
import type { SpecGatePreset } from "./schemas";

const PROJECT_PATH = "/repos/combined-sign-off";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let authoring: AuthoringService;
let reviewing: ReviewService;
let idSequence: number;
let timeSequence: number;

/** The review service, rebuilt over a review repo the test may decorate. */
let buildReviewService: (review: SpecReviewRepo) => ReviewService;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  reviewRepo = createSpecReviewRepo(db);
  idSequence = 0;
  timeSequence = 0;
  const specEvents = createSpecEventsRepo(db);
  const deps = {
    specs,
    review: reviewRepo,
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: specEvents.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    attention: specEvents,
    newId(prefix: string) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-08-08T09:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  };
  authoring = createAuthoringService(deps);
  buildReviewService = (review) =>
    createReviewService({
      ...deps,
      review,
      delivery: createSpecDeliveryRepo(db),
    });
  reviewing = buildReviewService(reviewRepo);
});

afterEach(() => db.close());

/**
 * A design-stage draft under review, carrying an approved requirement and two
 * new decisions.
 */
async function reviewableDraft(
  preset: SpecGatePreset,
  slug = `spec-${preset}`,
) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug,
    name: `Combined sign-off ${slug}`,
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: `${slug}-requirement-1`,
      kind: "requirement" as const,
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement" as const,
        statement: "Approval and sign-off land as one act.",
        priority: "must" as const,
        risk: "high" as const,
      },
    },
    actor: AGENT,
  });
  await authoring.upsertDraftElement({
    specId: created.spec.id,
    revisionId: created.draft.id,
    elementId: `${slug}-criterion-1`,
    kind: "criterion",
    parentElementId: `${slug}-requirement-1`,
    position: 1,
    payload: {
      kind: "criterion",
      text: "A faulted write leaves nothing applied.",
      validationStrategy: { kinds: ["test_run"] },
    },
    baseElementVersion: null,
    actor: AGENT,
  });
  await specs.approveRevision({
    revisionId: created.draft.id,
    approvedAt: "2026-08-08T08:58:01.000Z",
  });
  const design = await authoring.openAmendment({
    specId: created.spec.id,
    actor: AGENT,
  });
  if (preset !== "fast-path") {
    await specs.updateGatePolicy({
      specId: created.spec.id,
      gatePolicy: { preset },
      updatedAt: "2026-08-08T08:59:59.000Z",
    });
  }
  for (const index of [1, 2]) {
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: design.revision.id,
      elementId: `${slug}-decision-${index}`,
      kind: "decision",
      parentElementId: null,
      position: index + 1,
      payload: {
        kind: "decision",
        title: `Transactional act ${index}`,
        chosenApproach: "The server writes approvals and sign-off together.",
        rejectedAlternatives: [],
        reason: "Two round trips can half-apply.",
        tracedRequirementElementIds: [`${slug}-requirement-1`],
      },
      baseElementVersion: null,
      actor: AGENT,
    });
  }
  const proposed = await authoring.proposeRevision({
    specId: created.spec.id,
    revisionId: design.revision.id,
    actor: AGENT,
  });
  if (!proposed.ok) throw new Error("the fixture propose was refused");
  expect(proposed.revision.state).toBe("draft");
  return { specId: created.spec.id, revisionId: design.revision.id, slug };
}

/** The token a human review act echoes: the draft's content as read now. */
async function reviewHash(revisionId: string): Promise<string> {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) throw new Error(`revision ${revisionId} is gone`);
  return revisionReviewHash(snapshot);
}

function subjectRows(specId: string) {
  return reviewRepo
    .findApprovalsBySpecId(specId)
    .map(({ subject_kind, element_id }) => ({ subject_kind, element_id }))
    .sort((left, right) =>
      `${left.subject_kind}:${left.element_id}`.localeCompare(
        `${right.subject_kind}:${right.element_id}`,
      ),
    );
}

async function stateOf(revisionId: string) {
  const revision = await specs.findRevision(revisionId);
  if (revision === null) throw new Error(`revision ${revisionId} is gone`);
  return revision.state;
}

describe("approveRemainingAndSignOff", () => {
  it("writes every remaining subject approval and the sign-off in one act", async () => {
    const { specId, revisionId } = await reviewableDraft("contract-bearing");

    const result = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      expectedReviewHash: await reviewHash(revisionId),
      approver: "alex",
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the combined act to commit");
    expect(result.value.revision.state).toBe("approved");
    // Granular per-subject rows are preserved, not collapsed into the sign-off.
    expect(subjectRows(specId)).toEqual([
      {
        subject_kind: "decision",
        element_id: "spec-contract-bearing-decision-1",
      },
      {
        subject_kind: "decision",
        element_id: "spec-contract-bearing-decision-2",
      },
      { subject_kind: "revision", element_id: null },
    ]);
    expect(
      result.value.subjectApprovals.map((row) => row.subject_kind).sort(),
    ).toEqual(["decision", "decision"]);
  });

  it("leaves nothing applied when a write faults between the subject approvals", async () => {
    const { specId, revisionId } = await reviewableDraft("contract-bearing");
    let writes = 0;
    const faulted = buildReviewService({
      ...reviewRepo,
      saveApproval(row) {
        writes += 1;
        if (writes > 1) throw new Error("fault injected between approvals");
        reviewRepo.saveApproval(row);
      },
    });

    await expect(
      faulted.approveRemainingAndSignOff({
        specId,
        revisionId,
        expectedReviewHash: await reviewHash(revisionId),
        approver: "alex",
        actor: HUMAN,
      }),
    ).rejects.toThrow("fault injected between approvals");

    // At least two subjects were outstanding and the first write landed inside
    // the transaction, so a non-atomic act would leave that row behind.
    expect(writes).toBeGreaterThan(1);
    expect(reviewRepo.findApprovalsBySpecId(specId)).toEqual([]);
    expect(await stateOf(revisionId)).toBe("draft");
  });

  it("refuses a review hash the author's later edit made stale, writing zero approvals and no sign-off", async () => {
    const { specId, revisionId, slug } =
      await reviewableDraft("contract-bearing");
    const readHash = await reviewHash(revisionId);
    const decision = await specs.findElementVersion(
      revisionId,
      `${slug}-decision-2`,
    );
    if (decision === null) throw new Error("expected the second decision");
    await authoring.upsertDraftElement({
      specId,
      revisionId,
      elementId: `${slug}-decision-2`,
      kind: "decision",
      payload: {
        kind: "decision",
        title: "Transactional act 2",
        chosenApproach: "The server writes approvals, then signs off.",
        rejectedAlternatives: [],
        reason: "Two round trips can half-apply.",
        tracedRequirementElementIds: [`${slug}-requirement-1`],
      },
      baseElementVersion: decision.elementVersion,
      actor: AGENT,
    });

    const result = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      expectedReviewHash: readHash,
      approver: "alex",
      actor: HUMAN,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "stale_review" },
    });
    expect(reviewRepo.findApprovalsBySpecId(specId)).toEqual([]);
    expect(reviewRepo.findGateAdmissionsByRevision(revisionId)).toEqual([]);
    expect(await stateOf(revisionId)).toBe("draft");
  });

  it("produces the identical durable outcome exactly once under the combined dial", async () => {
    const { specId, revisionId } = await reviewableDraft("fast-path");

    const result = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      expectedReviewHash: await reviewHash(revisionId),
      approver: "alex",
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    // The same rows plain `signOffRevision` writes under this dial — the
    // approve-remaining pass adds no second copy of a subject sign-off absorbs.
    const afterFirst = subjectRows(specId);
    expect(afterFirst).toEqual([
      { subject_kind: "decision", element_id: "spec-fast-path-decision-1" },
      {
        subject_kind: "decision",
        element_id: "spec-fast-path-decision-2",
      },
      {
        subject_kind: "requirement",
        element_id: "spec-fast-path-requirement-1",
      },
      { subject_kind: "revision", element_id: null },
    ]);

    const again = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      expectedReviewHash: await reviewHash(revisionId),
      approver: "alex",
      actor: HUMAN,
    });

    expect(again.ok).toBe(true);
    expect(subjectRows(specId)).toEqual(afterFirst);
  });

  it("refuses an agent caller before any approval is written", async () => {
    const { specId, revisionId } = await reviewableDraft("contract-bearing");

    const result = await reviewing.approveRemainingAndSignOff({
      specId,
      revisionId,
      expectedReviewHash: await reviewHash(revisionId),
      approver: "agent",
      actor: AGENT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the combined act to refuse");
    expect(result.refusal.code).toBe("human_act_required");
    expect(reviewRepo.findApprovalsBySpecId(specId)).toEqual([]);
    expect(await stateOf(revisionId)).toBe("draft");
  });
});
