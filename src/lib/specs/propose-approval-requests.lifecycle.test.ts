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
  let eventsRepo: SpecEventsRepo;
  let notificationsRepo: NotificationsRepo;
  let authoring: AuthoringService;
  let review: ReviewService;
  let specId: string;
  let firstRevisionId: string;

  beforeEach(async () => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    const specs = createSpecsRepo(db, createWriteQueue());
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
    // consulted on either side of the Request Changes.
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

  async function proposeAndReadTheGateAsk(revisionId: string) {
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
    const [ask, ...rest] = result.approvalRequests;
    if (ask === undefined || rest.length > 0) {
      throw new Error(
        `expected one consulted gate, got ${JSON.stringify(result.approvalRequests)}`,
      );
    }
    return ask;
  }

  /**
   * Request Changes is not an idempotent re-file: it ends the reviewed
   * revision and opens a new one, so the identity the next propose files under
   * is a different one and the human gets a new entry rather than a silently
   * reused old id.
   */
  it("files a new ask under the revision Request Changes opened, retiring the old one", async () => {
    const first = await proposeAndReadTheGateAsk(firstRevisionId);
    expect(first).toMatchObject({ gate: "requirements", outcome: "filed" });
    const firstAttentionId = first.attentionId;
    expect(firstAttentionId).not.toBeNull();

    // A run's ask is answered by the run, not by the revision's review, so it
    // must survive the same Request Changes that retires the authoring ask.
    seedRunningExecution(firstRevisionId);
    const runAsk = await review.requestApproval({
      specId,
      revisionId: firstRevisionId,
      gate: "delivery",
      actor: AGENT,
    });
    if (!runAsk.ok) throw new Error("the run's request was refused");

    const changes = await review.requestChanges({
      specId,
      revisionId: firstRevisionId,
      actor: HUMAN,
    });
    if (!changes.ok) throw new Error("Request Changes was refused");
    expect(changes.value.withdrawn).toMatchObject({
      id: firstRevisionId,
      state: "withdrawn",
    });
    expect(changes.value.draft.id).not.toBe(firstRevisionId);
    expect(openAuthoringRequests()).toEqual([]);

    const second = await proposeAndReadTheGateAsk(changes.value.draft.id);
    expect(second).toMatchObject({ gate: "requirements", outcome: "filed" });
    expect(second.attentionId).not.toBe(firstAttentionId);
    expect(openAuthoringRequests()).toEqual([
      {
        attentionId: second.attentionId,
        revisionId: changes.value.draft.id,
        gate: "requirements",
        scope: "gate",
        subject: "requirements",
        executionId: null,
      },
    ]);
    expect(openRunRequestIds()).toEqual([runAsk.value.attentionId]);
  });

  /**
   * Returning to Requirements ends the Design revision the same way Request
   * Changes ends a reviewed one, so the ask the design proposal filed must end
   * with it: the human otherwise keeps a "Design approval required" entry for
   * a revision no later sign-off can answer (command-center#152).
   */
  it("retires the design ask and closes its queue entry when the proposed design returns to Requirements", async () => {
    const requirementsAsk = await proposeAndReadTheGateAsk(firstRevisionId);
    expect(requirementsAsk).toMatchObject({
      gate: "requirements",
      outcome: "filed",
    });
    const signedOff = await review.approveRemainingAndSignOff({
      specId,
      revisionId: firstRevisionId,
      approver: "alex",
      actor: HUMAN,
    });
    if (!signedOff.ok) {
      throw new Error(
        `requirements sign-off refused: ${signedOff.refusal.unmetConditions.join(" ")}`,
      );
    }
    const { revision: design } = await authoring.openAmendment({
      specId,
      actor: AGENT,
    });
    expect(design.authoringStage).toBe("design");
    await authoring.upsertDraftElement({
      specId,
      revisionId: design.id,
      elementId: "decision-1",
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
    const proposed = await authoring.proposeRevision({
      specId,
      revisionId: design.id,
      actor: AGENT,
    });
    if (!proposed.ok) {
      throw new Error(
        `design proposal refused: ${proposed.refusal.unmetConditions.join(" ")}`,
      );
    }
    const designAsk = proposed.approvalRequests.find(
      (ask) => ask.gate === "design",
    );
    expect(designAsk).toMatchObject({ outcome: "filed" });
    const designAttentionId = designAsk?.attentionId ?? null;
    if (designAttentionId === null) throw new Error("no design ask filed");
    expect(openAuthoringRequests().map((ask) => ask.attentionId)).toEqual([
      designAttentionId,
    ]);

    const returned = await authoring.returnToRequirements({
      specId,
      expectedRevisionId: design.id,
      reason: "The requirements need another pass first.",
      actor: AGENT,
    });

    expect(returned.withdrawnRevision).toMatchObject({
      id: design.id,
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
    const filed = await proposeAndReadTheGateAsk(firstRevisionId);

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
