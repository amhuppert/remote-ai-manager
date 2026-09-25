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
import {
  createSpecsRepo,
  type SpecsRepo,
  type SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { authoringReviewProjection } from "./authoring-review-projection";
import { assumptionCitationSnapshot } from "./attention-records";
import { revisionReviewHash } from "./review-hash";
import { loadProposalState } from "./review-state";
import {
  createReviewService,
  type ReviewCommentInput,
  type ReviewService,
  type ReviewServiceDeps,
} from "./review-service";
import type { Spec, SpecElementPayload } from "./schemas";

const PROJECT_PATH = "/repos/native-sdd-review";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;
const COMMENT_ANCHOR = {
  sectionId: "requirements",
  headingLabel: "Requirements",
  line: 1,
  charStart: 0,
  charEnd: 25,
  quote: "Review gates are durable.",
  prefix: "",
  suffix: "",
  docRevision: "revision-content-hash",
};

let db: Db;
let specs: SpecsRepo;
let reviewRepo: SpecReviewRepo;
let linksRepo: ReturnType<typeof createSpecLinksRepo>;
let specEvents: ReturnType<typeof createSpecEventsRepo>;
let authoring: AuthoringService;
let reviewing: ReviewService;
let reviewDeps: ReviewServiceDeps;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  specs = createSpecsRepo(db, writeQueue);
  reviewRepo = createSpecReviewRepo(db);
  linksRepo = createSpecLinksRepo(db);
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
    links: linksRepo,
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
  reviewDeps = {
    ...deps,
    delivery: createSpecDeliveryRepo(db),
  };
  reviewing = createReviewService(reviewDeps);
});

afterEach(() => db.close());

/**
 * A plan-stage draft its author has asked to have reviewed. The review request
 * leaves it an editable draft; every human review act below lands on it.
 */
async function reviewableDraft(
  preset: "contract-bearing" | "fast-path" = "contract-bearing",
) {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: `review-${preset}`,
    name: `Review ${preset}`,
    gatePolicy: { preset: "contract-bearing" },
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
  db.prepare(
    "UPDATE spec_revisions SET authoring_stage = 'plan' WHERE id = ?",
  ).run(created.draft.id);
  for (const { elementId, ...element } of [
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
    await specs.createDraftElement({
      id: elementId,
      specId: created.spec.id,
      revisionId: created.draft.id,
      ...element,
      createdAt: "2026-07-18T14:00:00.250Z",
      updatedAt: "2026-07-18T14:00:00.250Z",
    });
  }
  if (preset !== "contract-bearing") {
    await specs.updateGatePolicy({
      specId: created.spec.id,
      gatePolicy: { preset },
      updatedAt: "2026-07-18T14:00:00.500Z",
    });
  }
  await expect(
    authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    }),
  ).resolves.toMatchObject({ ok: true, revision: { state: "draft" } });
  return {
    ...created,
    spec: { ...created.spec, gatePolicy: { preset } },
  };
}

/** The token a human review act echoes: the draft's content as read now. */
async function reviewHash(revisionId: string): Promise<string> {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) {
    throw new Error(`expected a snapshot for ${revisionId}`);
  }
  return revisionReviewHash(snapshot);
}

/** The authoring agent rewrites an existing element of the draft in place. */
async function agentEdits(
  specId: string,
  revisionId: string,
  elementId: string,
  payload: SpecElementPayload,
): Promise<void> {
  const current = await specs.findElementVersion(revisionId, elementId);
  if (current === null) throw new Error(`expected ${elementId} on the draft`);
  await authoring.upsertDraftElement({
    specId,
    revisionId,
    elementId,
    kind: payload.kind,
    payload,
    baseElementVersion: current.elementVersion,
    actor: AGENT,
  });
}

/**
 * The status projection composed exactly as the read routes compose it, over
 * whatever the service actually persisted — so an assertion here speaks for
 * what a surface renders about real rows rather than about a hand-built shape.
 */
async function projectionOf(spec: Spec, revisionId: string) {
  const snapshot = await specs.getRevisionSnapshot(revisionId);
  if (snapshot === null) {
    throw new Error(`expected a snapshot for ${revisionId}`);
  }
  const revisions = await specs.listRevisions(spec.id);
  return specs.transaction("test.projection", (repo) => {
    const loaded = loadProposalState(
      repo,
      reviewRepo,
      linksRepo,
      spec,
      snapshot,
    );
    return authoringReviewProjection({
      policy: spec.gatePolicy,
      snapshot,
      governanceBaseSnapshot: loaded.governanceBaseSnapshot,
      importBaselineRows: loaded.importBaselineRows,
      importBaselineCitationState: loaded.importBaselineCitationState,
      approvals: reviewRepo.findApprovalsBySpecId(spec.id),
      admissions: reviewRepo.findGateAdmissionsBySpecId(spec.id),
      currentExecution: null,
      revisionNumberById: new Map(
        revisions.map((candidate) => [candidate.id, candidate.number]),
      ),
      applies: loaded.approvalApplies,
      blockingThreads: loaded.reviewSnapshot.blockingThreads,
      signOffFindings: [],
    });
  });
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
        expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
      subjectKind: "requirement",
      elementId: "requirements-stage-r1",
      approver: "alex",
      actor: HUMAN,
    });

    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
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
    ).resolves.toMatchObject({ revision: { authoringStage: "design" } });
  });

  it("comments on and resolves a thread on the open draft without freezing it", async () => {
    const created = await reviewableDraft();
    const before = await specs.getRevisionSnapshot(created.draft.id);

    const comment = await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-1",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "Please make the refusal explicit.",
      blocking: true,
      actor: HUMAN,
    });
    expect(comment).toMatchObject({
      ok: true,
      value: {
        revision_id: created.draft.id,
        thread_id: "thread-1",
        blocking: 1,
        resolution: "open",
      },
    });
    const commented = await specs.getRevisionSnapshot(created.draft.id);
    expect(commented?.revision).toMatchObject({
      state: "draft",
      contentHash: null,
    });
    expect(commented?.elements).toEqual(before?.elements);

    const resolved = await reviewing.resolveThread({
      specId: created.spec.id,
      revisionId: created.draft.id,
      threadId: "thread-1",
      resolution: "resolved",
      actor: HUMAN,
    });
    expect(resolved.ok).toBe(true);
    expect(
      reviewRepo
        .findCommentsByRevision(created.draft.id)
        .map(({ thread_id, resolution }) => ({ thread_id, resolution })),
    ).toEqual([{ thread_id: "thread-1", resolution: "resolved" }]);
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
  });

  it("refuses non-root, invalid-anchor, and blank root comment payloads before persistence", async () => {
    const created = await reviewableDraft();
    const valid = {
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-root",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "Review this root.",
      blocking: false,
      actor: HUMAN,
    };
    const root = await reviewing.comment(valid);
    if (!root.ok) throw new Error("valid root fixture was refused");

    await expect(
      reviewing.comment({
        ...valid,
        parentCommentId: root.value.id,
      } as unknown as ReviewCommentInput),
    ).rejects.toThrow();
    await expect(
      reviewing.comment({
        ...valid,
        threadId: "thread-invalid-anchor",
        anchor: { opaque: true },
      } as unknown as ReviewCommentInput),
    ).rejects.toThrow();
    await expect(
      reviewing.comment({
        ...valid,
        threadId: "thread-blank",
        body: "   \n  ",
      }),
    ).rejects.toThrow();
    expect(
      reviewRepo
        .findCommentsByRevision(created.draft.id)
        .map((comment) => comment.id),
    ).toEqual([root.value.id]);
  });

  it("refuses a root comment when the open draft does not carry its element", async () => {
    const created = await reviewableDraft();

    const result = await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-missing",
      threadId: "thread-missing-element",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "This target is stale.",
      blocking: false,
      actor: HUMAN,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    expect(reviewRepo.findCommentsByRevision(created.draft.id)).toEqual([]);
  });

  it.each(["approved", "withdrawn", "abandoned"] as const)(
    "refuses a root comment on a %s target",
    async (targetState) => {
      const created = await reviewableDraft(
        targetState === "approved" ? "fast-path" : "contract-bearing",
      );
      const revisionId = created.draft.id;
      if (targetState === "approved") {
        await expect(
          reviewing.signOffRevision({
            specId: created.spec.id,
            revisionId,
            expectedReviewHash: await reviewHash(revisionId),
            approver: "alex",
            actor: HUMAN,
          }),
        ).resolves.toMatchObject({ ok: true });
      }
      if (targetState === "withdrawn") {
        await expect(
          reviewing.withdraw({
            specId: created.spec.id,
            revisionId,
            actor: HUMAN,
          }),
        ).resolves.toMatchObject({ ok: true, value: { state: "withdrawn" } });
      }
      if (targetState === "abandoned") {
        await specs.abandon({
          specId: created.spec.id,
          abandonedAt: "2026-07-18T14:30:00.000Z",
          reason: "No longer needed.",
          updatedAt: "2026-07-18T14:30:00.000Z",
        });
      }

      const result = await reviewing.comment({
        specId: created.spec.id,
        revisionId,
        elementId: "requirement-1",
        threadId: `thread-${targetState}`,
        parentCommentId: null,
        anchor: COMMENT_ANCHOR,
        body: "This target is not reviewable.",
        blocking: false,
        actor: HUMAN,
      });

      expect(result).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
      expect(reviewRepo.findCommentsByRevision(revisionId)).toEqual([]);
    },
  );

  it("rechecks draft state inside the transaction before admitting a root", async () => {
    const created = await reviewableDraft();
    const racedSpecs: SpecsRepo = {
      ...specs,
      async transaction<T>(
        label: string,
        operation: (repo: SpecsRepoTransaction) => T,
      ): Promise<T> {
        db.prepare(
          "UPDATE spec_revisions SET state = 'withdrawn' WHERE id = ?",
        ).run(created.draft.id);
        return specs.transaction(label, operation);
      },
    };
    const racedReviewing = createReviewService({
      ...reviewDeps,
      specs: racedSpecs,
    });

    const result = await racedReviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-race",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "The draft moved before this write.",
      blocking: false,
      actor: HUMAN,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(reviewRepo.findCommentsByRevision(created.draft.id)).toEqual([]);
  });

  /**
   * A human withdraw discards the open draft without opening a follow-up, so
   * the next amendment continues from the approved base and cannot carry what
   * the withdrawn revision held. That drop is terminal — refusing it would leave
   * no exit — so the amendment has to report it instead.
   */
  it("names the withdrawn revision an amendment leaves behind after a human withdraw", async () => {
    const created = await reviewableDraft("fast-path");
    await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    const withdrawnAmendment = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    await specs.createDraftElement({
      id: "requirement-withdrawn",
      specId: created.spec.id,
      revisionId: withdrawnAmendment.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 4,
      payload: {
        kind: "requirement",
        statement: "This statement never survives the withdrawal.",
        priority: "must",
        risk: "low",
      },
      createdAt: "2026-07-18T14:00:10.000Z",
      updatedAt: "2026-07-18T14:00:10.000Z",
    });
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: withdrawnAmendment.revision.id,
      actor: AGENT,
    });
    await expect(
      reviewing.withdraw({
        specId: created.spec.id,
        revisionId: withdrawnAmendment.revision.id,
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true, value: { state: "withdrawn" } });

    const reopened = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });

    expect(reopened.revision).toMatchObject({
      number: 3,
      state: "draft",
      basedOnRevisionId: created.draft.id,
    });
    expect(
      reopened.skippedWithdrawnRevisions.map(({ id, number }) => ({
        id,
        number,
      })),
    ).toEqual([{ id: withdrawnAmendment.revision.id, number: 2 }]);
    // The report names a real drop: the withdrawn revision's element is not
    // in the revision that continues the spec.
    expect(
      (await specs.getRevisionSnapshot(reopened.revision.id))?.elements.map(
        ({ element }) => element.id,
      ),
    ).not.toContain("requirement-withdrawn");
  });

  /**
   * The D3 incident. An amendment that changed a requirement was ended by an
   * older build's Request Changes, and the follow-up revision changed only a
   * decision. Against its immediate parent the follow-up shows no requirement
   * change, but against the nearest APPROVED ancestor the requirement is still
   * unadmitted — so the requirements gate still owes this revision an
   * admission, and sign-off must earn one.
   */
  it("keeps the requirements gate applicable when the requirement change arrived through a withdrawn ancestor", async () => {
    const created = await reviewableDraft();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });

    const amendment = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    const requirementVersion = await specs.findElementVersion(
      amendment.revision.id,
      "requirement-1",
    );
    await specs.updateDraftElement({
      revisionId: amendment.revision.id,
      elementId: "requirement-1",
      payload: {
        kind: "requirement",
        statement: "Review gates are durable across withdrawn attempts.",
        priority: "must",
        risk: "high",
      },
      expectedElementVersion: requirementVersion?.elementVersion ?? 1,
      updatedAt: "2026-07-18T14:00:11.000Z",
    });
    // The lineage an older build's Request Changes left behind, which
    // persisted specs still carry: the amendment withdrawn, and a design-stage
    // draft continuing from it rather than from the approved base.
    await specs.withdrawAuthoringRevision({
      revisionId: amendment.revision.id,
    });
    const followUp = await specs.createDraftFromBase({
      id: "revision-follow-up",
      specId: created.spec.id,
      baseRevisionId: amendment.revision.id,
      authoringStage: "design",
      createdAt: "2026-07-18T14:00:11.500Z",
    });
    expect(followUp.basedOnRevisionId).toBe(amendment.revision.id);

    const decisionVersion = await specs.findElementVersion(
      followUp.id,
      "decision-1",
    );
    await specs.updateDraftElement({
      revisionId: followUp.id,
      elementId: "decision-1",
      payload: {
        kind: "decision",
        title: "Transition owner",
        chosenApproach: "The server owns review transitions and their gates.",
        rejectedAlternatives: [],
        reason: "No prompt can bypass the gate.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      expectedElementVersion: decisionVersion?.elementVersion ?? 1,
      updatedAt: "2026-07-18T14:00:12.000Z",
    });
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: followUp.id,
      actor: AGENT,
    });
    await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: followUp.id,
      expectedReviewHash: await reviewHash(followUp.id),
      subjectKind: "decision",
      elementId: "decision-1",
      approver: "alex",
      actor: HUMAN,
    });

    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: followUp.id,
        expectedReviewHash: await reviewHash(followUp.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          `Requirement R1 needs a valid approval for ${followUp.id}.`,
        ],
      },
    });

    await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: followUp.id,
      expectedReviewHash: await reviewHash(followUp.id),
      subjectKind: "requirement",
      elementId: "requirement-1",
      approver: "alex",
      actor: HUMAN,
    });
    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: followUp.id,
        expectedReviewHash: await reviewHash(followUp.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(followUp.id)
        .map(({ gate }) => gate)
        .sort(),
    ).toEqual(["design", "requirements"]);

    // The read must agree: the requirements gate is satisfied BY THIS
    // revision's own admission. Reading it as pending with a rev-1 row filed
    // under history is what left the D3 spec unable to say who admitted it.
    const projection = await projectionOf(created.spec, followUp.id);
    const requirements = projection.gates.find(
      (gate) => gate.gate === "requirements",
    );
    expect(requirements?.state).toBe("admitted");
    expect(
      requirements?.currentAdmissions.map(({ revisionId }) => revisionId),
    ).toEqual([followUp.id]);
    expect(
      requirements?.priorAdmissions.map(({ revisionId }) => revisionId),
    ).toEqual([created.draft.id]);
    expect(projection.revisionSignOff?.state).toBe("signed_off");
  });

  /**
   * R11.5: the fast path's sign-off persists an approval row for every subject
   * in the same act, so a really-signed-off revision carries rows that look
   * exactly like per-subject grants a human made on it. Crediting each subject
   * to that reading would report an act nobody performed — nobody was asked per
   * subject — so the ledger must name the combined sign-off that settled them.
   * Read off the persisted rows, because a ledger asserted over hand-built ones
   * is what missed this.
   */
  it("reports the subjects a real fast-path sign-off settled as combined-act", async () => {
    const created = await reviewableDraft("fast-path");

    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });

    // The state the classifier has to read correctly: per-subject rows granted
    // on this very revision, written by the sign-off rather than by a human
    // approving each subject.
    expect(
      reviewRepo
        .findApprovalsBySpecId(created.spec.id)
        .filter(({ revision_id }) => revision_id === created.draft.id)
        .map(({ subject_kind }) => subject_kind)
        .sort(),
    ).toEqual(["decision", "plan", "requirement", "revision"]);

    const projection = await projectionOf(created.spec, created.draft.id);
    expect(
      projection.approvalLedger.subjects.map(
        ({ classification }) => classification,
      ),
    ).toEqual(["combined_act", "combined_act", "combined_act"]);
    expect(projection.approvalLedger).toMatchObject({
      satisfied: 3,
      combinedAct: 3,
      currentRevision: 0,
      carried: 0,
      importSettled: 0,
      pending: 0,
      governedBy: "combined_sign_off",
    });
  });

  /**
   * Approvals accumulate on a spec without bound while the revisions they name
   * do not, so the work of loading a draft's review state must grow with the
   * revisions involved rather than with the approval count.
   */
  it("reads each revision snapshot once however many approvals accumulate", async () => {
    const created = await reviewableDraft();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      subjects: [
        { subjectKind: "requirement", elementId: "requirement-1" },
        { subjectKind: "decision", elementId: "decision-1" },
        { subjectKind: "plan", elementId: null },
      ],
      approver: "alex",
      actor: HUMAN,
    });
    await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    // The measurement runs against an amendment, so the approvals it consults
    // name a revision other than the one already in hand.
    const amendment = await authoring.openAmendment({
      specId: created.spec.id,
      actor: AGENT,
    });
    await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: amendment.revision.id,
      actor: AGENT,
    });

    const snapshotReads = async (): Promise<string[]> => {
      const spec = await specs.findById(created.spec.id);
      const snapshot = await specs.getRevisionSnapshot(amendment.revision.id);
      if (spec === null || snapshot === null) throw new Error("no spec");
      return specs.transaction("test.count-snapshot-reads", (repo) => {
        const reads: string[] = [];
        const loaded = loadProposalState(
          {
            listRevisions: (specId) => repo.listRevisions(specId),
            getRevisionSnapshot: (revisionId) => {
              reads.push(revisionId);
              return repo.getRevisionSnapshot(revisionId);
            },
          },
          reviewRepo,
          linksRepo,
          spec,
          snapshot,
        );
        // The predicate loads lazily, so the measurement has to consult it for
        // every approval the way sign-off does.
        for (const approval of loaded.reviewSnapshot.approvals) {
          loaded.approvalApplies(approval);
        }
        return reads;
      });
    };

    const withThreeApprovals = await snapshotReads();
    const requirementApproval = reviewRepo
      .findApprovalsBySpecId(created.spec.id)
      .find(({ subject_kind }) => subject_kind === "requirement");
    if (requirementApproval === undefined) {
      throw new Error("expected the requirement approval");
    }
    for (let index = 0; index < 40; index += 1) {
      reviewRepo.saveApproval({
        ...requirementApproval,
        id: `approval-bulk-${index}`,
        granted_at: "2026-07-18T14:30:00.000Z",
      });
    }

    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toHaveLength(44);
    expect(await snapshotReads()).toEqual(withThreeApprovals);
    expect(new Set(withThreeApprovals).size).toBe(withThreeApprovals.length);
  });

  it("refuses sign-off for a blocking thread, a rejected attached assumption, and missing configured approvals", async () => {
    const created = await reviewableDraft();
    const missingApprovals = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    expect(missingApprovals).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });

    // The author keeps working on the same draft after the refusal.
    const reviewRevisionId = created.draft.id;
    const draft = await specs.findRevision(reviewRevisionId);
    if (draft === null) throw new Error("expected the open draft");
    const rejectedAssumptionRow = {
      id: "assumption-1",
      spec_id: created.spec.id,
      number: 1,
      element_id: "decision-1",
      text: "The gate is already enforced.",
      proposed_by_json: JSON.stringify(AGENT),
      record_version: 1,
      disposition: "rejected",
      disposed_at: "2026-07-18T14:20:00.000Z",
      withdrawn_at: null,
      supersedes_assumption_id: null,
      supersession_operation_id: null,
      supersession_request_hash: null,
      created_at: "2026-07-18T13:59:00.000Z",
      updated_at: "2026-07-18T14:20:00.000Z",
    } as const;
    reviewRepo.insertAssumption(rejectedAssumptionRow);
    await specs.mutateDraftCitation({
      operation: "cite",
      specId: created.spec.id,
      revisionId: reviewRevisionId,
      assumptionId: rejectedAssumptionRow.id,
      elementId: "decision-1",
      expectedCitationVersion: draft.citationVersion,
      snapshot: assumptionCitationSnapshot(
        rejectedAssumptionRow,
        "2026-07-18T14:20:00.000Z",
      ),
      updatedAt: "2026-07-18T14:20:00.000Z",
    });
    const rejectedAssumption = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: reviewRevisionId,
      expectedReviewHash: await reviewHash(reviewRevisionId),
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
      revisionId: reviewRevisionId,
      elementId: "requirement-1",
      threadId: "thread-blocking",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "Blocking",
      blocking: true,
      actor: HUMAN,
    });
    const blockingThread = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: reviewRevisionId,
      expectedReviewHash: await reviewHash(reviewRevisionId),
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
    const created = await reviewableDraft();
    const bulk = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
    expect(
      rows.every(
        ({ revision_id, subject_fingerprint_json }) =>
          revision_id === created.draft.id && subject_fingerprint_json !== null,
      ),
    ).toBe(true);

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
  });

  it("approves an item on the open draft with the draft's current review hash", async () => {
    const created = await reviewableDraft();

    const approved = await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      subjectKind: "requirement",
      elementId: "requirement-1",
      approver: "alex",
      actor: HUMAN,
    });

    expect(approved).toMatchObject({
      ok: true,
      value: {
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: created.draft.id,
        approver: "alex",
        validity: "valid",
      },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toHaveLength(1);
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
    const pending = (
      await projectionOf(created.spec, created.draft.id)
    ).pendingApprovals.map(({ elementId }) => elementId);
    expect(pending).toContain("decision-1");
    expect(pending).not.toContain("requirement-1");
  });

  it("refuses approvals and sign-off against a review hash the author's later edit made stale, writing nothing", async () => {
    // Fast path: sign-off needs no prior per-item approval, so the stale hash
    // is the only thing that can refuse it.
    const created = await reviewableDraft("fast-path");
    const readHash = await reviewHash(created.draft.id);
    await agentEdits(created.spec.id, created.draft.id, "task-1", {
      kind: "task",
      title: "Implement review service",
      instructions: "Implement and test the review service end to end.",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: ["decision-1"],
      coveredCriterionElementIds: ["criterion-1"],
      dependsOnTaskElementIds: [],
    });
    const eventsBefore = specEvents.findBySpecId(created.spec.id);

    const stale = { code: "stale_review" };
    await expect(
      reviewing.approveItem({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: readHash,
        subjectKind: "requirement",
        elementId: "requirement-1",
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: false, refusal: stale });
    await expect(
      reviewing.bulkApprove({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: readHash,
        subjects: [{ subjectKind: "decision", elementId: "decision-1" }],
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: false, refusal: stale });
    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: readHash,
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: false, refusal: stale });

    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect(reviewRepo.findGateAdmissionsByRevision(created.draft.id)).toEqual(
      [],
    );
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
      contentHash: null,
    });
    expect(specEvents.findBySpecId(created.spec.id)).toEqual(eventsBefore);

    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
  });

  it("returns an approved requirement to pending when the author edits its criterion, leaving unrelated approvals standing", async () => {
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug: "criterion-edit-review",
      name: "Criterion edit review",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: {
        elementId: "R1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement",
          statement: "Review gates are durable.",
          priority: "must",
          risk: "high",
        },
      },
      actor: AGENT,
    });
    for (const element of [
      {
        elementId: "R1-C1",
        kind: "criterion" as const,
        parentElementId: "R1",
        payload: {
          kind: "criterion" as const,
          text: "An unapproved sign-off is refused.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
      },
      {
        elementId: "R2",
        kind: "requirement" as const,
        parentElementId: null,
        payload: {
          kind: "requirement" as const,
          statement: "Review acts are audited.",
          priority: "must" as const,
          risk: "low" as const,
        },
      },
      {
        elementId: "R2-C1",
        kind: "criterion" as const,
        parentElementId: "R2",
        payload: {
          kind: "criterion" as const,
          text: "Every review act appends an event.",
          validationStrategy: { kinds: ["test_run" as const] },
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
    await expect(
      reviewing.bulkApprove({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
        subjects: [
          { subjectKind: "requirement", elementId: "R1" },
          { subjectKind: "requirement", elementId: "R2" },
        ],
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });
    const pendingOf = async () =>
      (await projectionOf(created.spec, created.draft.id)).pendingApprovals.map(
        ({ elementId }) => elementId,
      );
    expect(await pendingOf()).toEqual([]);

    await agentEdits(created.spec.id, created.draft.id, "R1-C1", {
      kind: "criterion",
      text: "An unapproved sign-off is refused with the missing subject named.",
      validationStrategy: { kinds: ["test_run"] },
    });

    expect(await pendingOf()).toEqual(["R1"]);
    // The rows themselves are untouched: what changed is the content they
    // were granted for.
    expect(
      reviewRepo
        .findApprovalsBySpecId(created.spec.id)
        .map(({ element_id, validity }) => ({ element_id, validity }))
        .sort((left, right) =>
          (left.element_id ?? "").localeCompare(right.element_id ?? ""),
        ),
    ).toEqual([
      { element_id: "R1", validity: "valid" },
      { element_id: "R2", validity: "valid" },
    ]);
    await expect(
      reviewing.signOffRevision({
        specId: created.spec.id,
        revisionId: created.draft.id,
        expectedReviewHash: await reviewHash(created.draft.id),
        approver: "alex",
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
  });

  it("freezes the draft at sign-off and treats a repeated sign-off as a durable no-op", async () => {
    const created = await reviewableDraft();
    expect(await specs.findRevision(created.draft.id)).toMatchObject({
      state: "draft",
      contentHash: null,
      approvedAt: null,
    });
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    if (!first.ok) throw new Error("expected initial sign-off");
    const frozen = await specs.findRevision(created.draft.id);
    expect(frozen).toMatchObject({
      state: "approved",
      contentHash: expect.any(String),
      approvedAt: expect.any(String),
    });
    expect(frozen?.proposedAt).toBe(frozen?.approvedAt);

    const before = {
      revision: await specs.findRevision(created.draft.id),
      approvals: reviewRepo.findApprovalsBySpecId(created.spec.id),
      admissions: reviewRepo.findGateAdmissionsByRevision(created.draft.id),
      events: specEvents.findBySpecId(created.spec.id),
    };
    const repeated = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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

  it("refuses bulk plan approval for a withdrawn plan and its design follow-up", async () => {
    const created = await reviewableDraft();
    await expect(
      reviewing.withdraw({
        specId: created.spec.id,
        revisionId: created.draft.id,
        actor: HUMAN,
      }),
    ).resolves.toMatchObject({ ok: true });
    const followUp = await specs.createDraftFromBase({
      id: "revision-design-follow-up",
      specId: created.spec.id,
      baseRevisionId: created.draft.id,
      authoringStage: "design",
      createdAt: "2026-07-18T14:10:00.000Z",
    });

    const withdrawnLegacyPlan = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      subjects: [{ subjectKind: "plan", elementId: null }],
      approver: "alex",
      actor: HUMAN,
    });
    expect(withdrawnLegacyPlan).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });

    const designFollowUp = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: followUp.id,
      expectedReviewHash: await reviewHash(followUp.id),
      subjects: [{ subjectKind: "plan", elementId: null }],
      approver: "alex",
      actor: HUMAN,
    });
    expect(designFollowUp).toMatchObject({
      ok: false,
      refusal: { code: "stage_blocked" },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
  });

  it("unapprove removes the recorded approval so the subject counts as outstanding again", async () => {
    const created = await reviewableDraft();
    const approved = await reviewing.approveItem({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft();
    const input = {
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft();
    await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    if (!first.ok || first.value.approval === null) {
      throw new Error("expected first human sign-off");
    }
    const firstApproval = structuredClone(first.value.approval);

    const { revision: amendment } = await authoring.openAmendment({
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
      expectedReviewHash: await reviewHash(amendment.id),
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

  it("finishes a policy-admitted draft as an agent with admissions and zero approval rows", async () => {
    const created = await reviewableDraft();
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
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft("fast-path");
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
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "alex",
      actor: HUMAN,
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });
  });

  it("signs off a fast-path revision as the combined approval without a separate fast-track act", async () => {
    const created = await reviewableDraft("fast-path");

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft("fast-path");
    const bulk = await reviewing.bulkApprove({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
      expectedReviewHash: await reviewHash(created.draft.id),
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
    const created = await reviewableDraft("fast-path");

    const signed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
      approver: "agent",
      actor: AGENT,
    });
    expect(signed).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(reviewRepo.findApprovalsBySpecId(created.spec.id)).toEqual([]);
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");
  });

  it("writes the fast-path combined approvals, sign-off, and admissions all-or-none", async () => {
    const created = await reviewableDraft("fast-path");
    await reviewing.comment({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: "requirement-1",
      threadId: "thread-1",
      parentCommentId: null,
      anchor: COMMENT_ANCHOR,
      body: "Still blocking",
      blocking: true,
      actor: HUMAN,
    });

    const failed = await reviewing.signOffRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      expectedReviewHash: await reviewHash(created.draft.id),
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
    expect((await specs.findRevision(created.draft.id))?.state).toBe("draft");

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
      expectedReviewHash: await reviewHash(created.draft.id),
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
