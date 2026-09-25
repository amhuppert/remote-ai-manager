import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { deriveNotificationOutcomes } from "@/components/session/sidebar/active-work-adapters";
import {
  createNotificationsRepo,
  type NotificationsRepo,
} from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import {
  createSpecEventsRepo,
  type OpenApprovalRequest,
  type SpecEventsRepo,
} from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createReviewService, type ReviewService } from "./review-service";
import { revisionReviewHash } from "./review-hash";
import type { SpecGate } from "./schemas";

const PROJECT_PATH = "/repos/propose-request-changes";
const PROJECT_NAME = "propose-request-changes-project";
const SLUG = "re-proposed";
const EXECUTION_ID = "spec-execution-1";
const NOW = "2026-08-24T09:00:00.000Z";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

/**
 * The propose coordinator against the real `requestApproval` service rather
 * than an injected port, because the question these cases answer — which
 * durable request identity a re-propose lands on — is decided by the review
 * service and the revision lifecycle together, and a fake port cannot be wrong
 * about it in the same way production can.
 */
describe("propose approval requests across the real revision lifecycle", () => {
  let db: Db;
  let specs: ReturnType<typeof createSpecsRepo>;
  let eventsRepo: SpecEventsRepo;
  let notificationsRepo: NotificationsRepo;
  let authoring: AuthoringService;
  let review: ReviewService;
  let specId: string;
  let firstRevisionId: string;

  beforeEach(async () => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    specs = createSpecsRepo(db, createWriteQueue());
    const reviewRepo = createSpecReviewRepo(db);
    const linksRepo = createSpecLinksRepo(db);
    const deliveryRepo = createSpecDeliveryRepo(db);
    eventsRepo = createSpecEventsRepo(db);
    const events = createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: () => {},
    });
    const notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(id) {
        return notificationsRepo.findSpecNotificationsBySpecId(id);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    review = createReviewService({
      specs,
      review: reviewRepo,
      delivery: deliveryRepo,
      links: linksRepo,
      events,
      attention: eventsRepo,
      notifier,
      policyNotifier: notifier,
    });
    // The service factory's composition: authoring files through the review
    // service's own request verb, so a propose here leaves the durable asks a
    // production propose leaves.
    authoring = createAuthoringService({
      specs,
      review: reviewRepo,
      links: linksRepo,
      events,
      waivers: deliveryRepo,
      attention: eventsRepo,
      policyNotifier: notifier,
      notifier,
      approvalRequests: {
        requestApproval: (input) => review.requestApproval(input),
      },
    });

    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug: SLUG,
      name: "Re Proposed",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: {
        elementId: "requirement-1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement",
          statement: "The transition is server-enforced.",
          priority: "must",
          risk: "high",
        },
      },
      actor: AGENT,
    });
    specId = created.spec.id;
    firstRevisionId = created.draft.id;
    // A requirement with no criterion is an empty spec to the lint, and the
    // draft stays at the requirements stage so exactly one authoring gate is
    // consulted when it asks for review.
    await authoring.upsertDraftElement({
      specId,
      revisionId: firstRevisionId,
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
      actor: AGENT,
    });
  });

  afterEach(() => db.close());

  /** The asks a revision owes a human, apart from the ones a run owes. */
  function openAuthoringRequests(): OpenApprovalRequest[] {
    return eventsRepo
      .listOpenApprovalRequests(specId)
      .filter((request) => request.executionId === null);
  }

  function openRunRequestIds(): string[] {
    return eventsRepo
      .listOpenApprovalRequests(specId)
      .filter((request) => request.executionId !== null)
      .map((request) => request.attentionId);
  }

  function seedRunningExecution(revisionId: string): void {
    db.prepare(
      `INSERT INTO spec_executions (
         id, spec_id, revision_id, scope_json, state, workflow_definition_id,
         workflow_execution_id, session_name, delivered_at, abandoned_reason,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
         NULL, NULL, ?, ?)`,
    ).run(
      EXECUTION_ID,
      specId,
      revisionId,
      '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
      NOW,
      NOW,
    );
  }

  /** The ask a review request filed for `gate`, which must be consulted. */
  async function proposeAndReadTheAsk(
    revisionId: string,
    gate: SpecGate = "requirements",
  ) {
    const result = await authoring.proposeRevision({
      specId,
      revisionId,
      actor: AGENT,
    });
    if (!result.ok) {
      throw new Error(
        `expected a successful proposal: ${result.refusal.unmetConditions.join(" ")}`,
      );
    }
    const ask = result.approvalRequests.find(
      (candidate) => candidate.gate === gate,
    );
    if (ask === undefined) {
      throw new Error(
        `expected the ${gate} gate to be consulted, got ${JSON.stringify(result.approvalRequests)}`,
      );
    }
    return ask;
  }

  async function reviewHash(revisionId: string): Promise<string> {
    const snapshot = await specs.getRevisionSnapshot(revisionId);
    if (snapshot === null) throw new Error(`no snapshot for ${revisionId}`);
    return revisionReviewHash(snapshot);
  }

  /** Requirements reviewed and signed off, so amendments have a base. */
  async function signOffRequirements(): Promise<void> {
    const requirementsAsk = await proposeAndReadTheAsk(firstRevisionId);
    expect(requirementsAsk).toMatchObject({
      gate: "requirements",
      outcome: "filed",
    });
    const signedOff = await review.approveRemainingAndSignOff({
      specId,
      revisionId: firstRevisionId,
      approver: "alex",
      actor: HUMAN,
      expectedReviewHash: await reviewHash(firstRevisionId),
    });
    if (!signedOff.ok) {
      throw new Error(
        `requirements sign-off refused: ${signedOff.refusal.unmetConditions.join(" ")}`,
      );
    }
  }

  /** Opens the Design amendment and authors one decision on it. */
  async function openDesignDraft(decisionElementId: string): Promise<string> {
    const { revision: design } = await authoring.openAmendment({
      specId,
      actor: AGENT,
    });
    expect(design.authoringStage).toBe("design");
    await authoring.upsertDraftElement({
      specId,
      revisionId: design.id,
      elementId: decisionElementId,
      kind: "decision",
      parentElementId: null,
      position: 2,
      payload: {
        kind: "decision",
        title: "Refuse at the server",
        chosenApproach: "The transition guard lives in the write service.",
        rejectedAlternatives: [],
        reason: "Clients cannot be trusted to sequence the stages.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    return design.id;
  }

  /**
   * The author keeps editing the draft under review, and each edit may be
   * followed by another review request. The ask belongs to the draft, not to
   * one version of its content, so the human keeps one entry rather than one
   * per request.
   */
  it("lands a review request after further edits on the ask already in the queue", async () => {
    const first = await proposeAndReadTheAsk(firstRevisionId);
    expect(first).toMatchObject({ gate: "requirements", outcome: "filed" });

    await authoring.upsertDraftElement({
      specId,
      revisionId: firstRevisionId,
      elementId: "criterion-2",
      kind: "criterion",
      parentElementId: "requirement-1",
      position: 2,
      payload: {
        kind: "criterion",
        text: "A refused transition leaves the stage unchanged.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor: AGENT,
    });
    const second = await proposeAndReadTheAsk(firstRevisionId);

    expect(second).toMatchObject({
      gate: "requirements",
      outcome: "already-filed",
      attentionId: first.attentionId,
    });
    expect(openAuthoringRequests()).toEqual([
      {
        attentionId: first.attentionId,
        revisionId: firstRevisionId,
        gate: "requirements",
        scope: "gate",
        subject: "requirements",
        executionId: null,
      },
    ]);
    const revision = await specs.getRevisionSnapshot(firstRevisionId);
    expect(revision?.revision.state).toBe("draft");
  });

  /**
   * The ask was filed while the policy wanted a human. Once the policy lets
   * the author's propose freeze the draft, nobody is left to answer it, so the
   * freeze retires it and its queue entry rather than leaving a Needs You row
   * for a revision that is already approved.
   */
  it("retires the ask when a later Notify propose freezes the draft", async () => {
    const ask = await proposeAndReadTheAsk(firstRevisionId);
    expect(ask).toMatchObject({ gate: "requirements", outcome: "filed" });
    await specs.updateGatePolicy({
      specId,
      gatePolicy: { preset: "exploratory" },
      updatedAt: NOW,
    });

    const frozen = await authoring.proposeRevision({
      specId,
      revisionId: firstRevisionId,
      actor: AGENT,
    });

    expect(frozen).toMatchObject({
      ok: true,
      absorbedSignOff: true,
      revision: { state: "approved" },
    });
    expect(openAuthoringRequests()).toEqual([]);
    expect(
      notificationsRepo
        .findSpecNotificationsBySpecId(specId)
        .filter((row) => row.gateRequestId === ask.attentionId)
        .map((row) => row.type)
        .sort(),
    ).toEqual(["spec-approval-requested", "spec-attention-resolved"]);
  });

  /**
   * Withdrawing the draft under review ends it, so the next draft is a
   * different identity: the next review request files a new entry rather than
   * silently reusing the retired one. A run's ask is answered by the run, not
   * by the revision's review, so it survives the same withdrawal.
   */
  it("files a new ask under the draft opened after a withdrawal, retiring the old ask but never the run's", async () => {
    await signOffRequirements();
    const withdrawnDraftId = await openDesignDraft("decision-1");
    const first = await proposeAndReadTheAsk(withdrawnDraftId, "design");
    expect(first).toMatchObject({ outcome: "filed" });
    const firstAttentionId = first.attentionId;
    expect(firstAttentionId).not.toBeNull();

    seedRunningExecution(firstRevisionId);
    const runAsk = await review.requestApproval({
      specId,
      revisionId: firstRevisionId,
      gate: "delivery",
      actor: AGENT,
    });
    if (!runAsk.ok) throw new Error("the run's request was refused");

    const withdrawn = await review.withdraw({
      specId,
      revisionId: withdrawnDraftId,
      actor: HUMAN,
    });
    if (!withdrawn.ok) throw new Error("the withdrawal was refused");
    expect(withdrawn.value).toMatchObject({
      id: withdrawnDraftId,
      state: "withdrawn",
    });
    expect(openAuthoringRequests()).toEqual([]);

    const nextDraftId = await openDesignDraft("decision-2");
    expect(nextDraftId).not.toBe(withdrawnDraftId);
    const second = await proposeAndReadTheAsk(nextDraftId, "design");
    expect(second).toMatchObject({ gate: "design", outcome: "filed" });
    expect(second.attentionId).not.toBe(firstAttentionId);
    expect(openAuthoringRequests()).toEqual([
      {
        attentionId: second.attentionId,
        revisionId: nextDraftId,
        gate: "design",
        scope: "gate",
        subject: "design",
        executionId: null,
      },
    ]);
    expect(openRunRequestIds()).toEqual([runAsk.value.attentionId]);
  });

  /**
   * Returning to Requirements ends the Design revision the same way a
   * withdrawal does, so the ask the design review request filed must end with
   * it: the human otherwise keeps a "Design approval required" entry for a
   * revision no later sign-off can answer (command-center#152).
   */
  it("retires the design ask and closes its queue entry when the design draft returns to Requirements", async () => {
    await signOffRequirements();
    const designId = await openDesignDraft("decision-1");
    const designAsk = await proposeAndReadTheAsk(designId, "design");
    expect(designAsk).toMatchObject({ outcome: "filed" });
    const designAttentionId = designAsk.attentionId;
    if (designAttentionId === null) throw new Error("no design ask filed");
    expect(openAuthoringRequests().map((ask) => ask.attentionId)).toEqual([
      designAttentionId,
    ]);

    const returned = await authoring.returnToRequirements({
      specId,
      expectedRevisionId: designId,
      reason: "The requirements need another pass first.",
      actor: AGENT,
    });

    expect(returned.withdrawnRevision).toMatchObject({
      id: designId,
      state: "withdrawn",
    });
    expect(openAuthoringRequests()).toEqual([]);
    const rows = notificationsRepo.findSpecNotificationsBySpecId(specId);
    expect(
      rows.filter((row) => row.type === "spec-attention-resolved"),
    ).toEqual([
      expect.objectContaining({
        gate: "design",
        gateRequestId: designAttentionId,
        title: "Design request closed",
        message:
          "Re Proposed: the revision it asked about was returned to Requirements",
      }),
    ]);
    // What the topbar's Needs You badge derives from the same rows.
    expect(
      deriveNotificationOutcomes(rows, []).needsAction.map(
        (item) => item.phase,
      ),
    ).toEqual([]);
  });

  /**
   * The identity that does dedupe: the same (spec, revision, gate, gate-scope)
   * while its request is still open. Re-filing it answers with the id already
   * in the human's queue instead of opening a second row for one ask.
   */
  it("answers a re-file of the still-open gate identity with its own attention id", async () => {
    const filed = await proposeAndReadTheAsk(firstRevisionId);

    const refiled = await review.requestApproval({
      specId,
      revisionId: firstRevisionId,
      gate: "requirements",
      actor: AGENT,
    });

    if (!refiled.ok) throw new Error("the re-filed request was refused");
    expect(refiled.value).toMatchObject({
      scope: "gate",
      alreadyRequested: true,
      attentionId: filed.attentionId,
    });
    expect(openAuthoringRequests()).toHaveLength(1);
  });
});
