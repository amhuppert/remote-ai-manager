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
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import type { Notification } from "@/lib/notifications/schemas";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import {
  createEvidenceMutationRecorder,
  createEvidenceService,
  type EvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import { resolveCriterionBareHandle } from "./handles";

const PROJECT_PATH = "/repos/waiver-attention";
const PROJECT_NAME = "waiver-attention-project";
const SPEC_ID = "spec-waiver-attention";
const REVISION_ID = "revision-approved";
const CRITERION_ID = "criterion-1";
const NOW = "2026-07-19T12:00:00.000Z";

/**
 * R14.3 + R19.3: a routed waiver request must open an actionable Needs You
 * item through the same durable notification registry the gate approvals
 * use, and the human grant must clear it. This wires the production
 * composition shape (service-factory): the routed request notifies through
 * createSpecApprovalNotifier, the grant forwards through the evidence
 * service's waiver notifier port.
 */
describe("waiver request/grant attention pipeline (runtime wiring)", () => {
  let db: Db;
  let service: EvidenceService;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let pushed: Notification[];
  let attentionSequence: number;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    pushed = [];
    attentionSequence = 0;
    const writeQueue = createWriteQueue();
    const specs = createSpecsRepo(db, writeQueue);
    const deliveryRepo = createSpecDeliveryRepo(db);
    const eventsRepo = createSpecEventsRepo(db);
    const events = createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: (notification) => {
        pushed.push(notification);
      },
    });
    const notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(specId) {
        return notificationsRepo.findSpecNotificationsBySpecId(specId);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    const recorder = createEvidenceMutationRecorder({
      eventsRepo,
      events,
      findSpecById: (specId) => specs.findByIdInTransaction(specId),
      runInImmediateTransaction: (operation) =>
        db.transaction(operation).immediate(),
    });
    let waiverSequence = 0;
    service = createEvidenceService({
      repo: deliveryRepo,
      ingestExecutionEvidence: async () => undefined,
      recordMutation: recorder.recordMutation,
      runInImmediateTransaction: recorder.runInImmediateTransaction,
      nextId: (kind) => `${kind}-${++waiverSequence}`,
      now: () => NOW,
      getApprovedCriterion: async () => null,
      gitObjectExists: async () => false,
      workflowEventExists: async () => false,
      mergeValidationFactExists: async () => false,
      contentObjectExists: async () => false,
      humanActorExists: async () => false,
      isEvidenceFresh: async () => false,
      routeStrategyInadequacy: async () => undefined,
      // Mirrors the production route in service-factory: mint the attention
      // id, resolve identity, and open the durable Needs You request.
      async routeWaiverRequestToHuman(input) {
        const attentionId = `attention-${++attentionSequence}`;
        const spec = await specs.findById(input.specId);
        if (spec !== null) {
          const criterionHandle = await resolveCriterionBareHandle(
            (elementId) => specs.findElement(elementId),
            spec.slug,
            input.criterionElementId,
          );
          notifier.waiverRequested({
            specId: spec.id,
            specSlug: spec.slug,
            specName: spec.name,
            projectPath: spec.projectPath,
            criterionElementId: input.criterionElementId,
            criterionHandle,
            revisionId: input.revisionId,
            attentionId,
            reason: input.reason,
            occurredAt: NOW,
          });
        }
        return { attentionId };
      },
      async resolveCriterionHandle(specId, criterionElementId) {
        const spec = await specs.findById(specId);
        if (spec === null) return null;
        return resolveCriterionBareHandle(
          (elementId) => specs.findElement(elementId),
          spec.slug,
          criterionElementId,
        );
      },
      getTaskClaimContext: async () => null,
      async getCriterionVersion(revisionId, criterionElementId) {
        const snapshot = await specs.getRevisionSnapshot(revisionId);
        const criterion = snapshot?.elements.find(
          ({ element }) => element.id === criterionElementId,
        );
        return snapshot !== null &&
          snapshot !== undefined &&
          criterion !== undefined
          ? {
              specId: snapshot.revision.specId,
              revisionNumber: snapshot.revision.number,
              payloadHash: criterion.version.payloadHash,
            }
          : null;
      },
      wasCriterionDeliveredByMergedExecution: async () => false,
      waiverNotifier: notifier,
    });
  });

  afterEach(() => db.close());

  function specRows() {
    return notificationsRepo.findSpecNotificationsBySpecId(SPEC_ID);
  }

  async function requestWaiver() {
    return service.requestWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      source: { kind: "agent", conversationId: "conversation-1" },
      reason: "Legacy surface cannot be validated this release.",
    });
  }

  it("a routed waiver request opens an actionable Needs You item with a criterion deep link", async () => {
    const result = await requestWaiver();
    expect(result).toMatchObject({
      ok: true,
      value: { attentionId: "attention-1" },
    });

    const rows = specRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "spec-waiver-requested",
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      specSlug: "waiver-attention",
      specName: "Waiver Attention",
      gate: "delivery",
      gateRequestId: "attention-1",
      deepLinkId: "R1.1",
    });
    expect(pushed).toHaveLength(1);

    const outcomes = deriveNotificationOutcomes(rows, []);
    expect(outcomes.needsAction).toHaveLength(1);
    expect(outcomes.needsAction[0]).toMatchObject({
      kind: "spec",
      phase: "Waiver decision required",
      href: `/specs/${encodeURIComponent(PROJECT_NAME)}/waiver-attention?el=R1.1`,
      needsAction: { primary: { label: "Review", kind: "review" } },
    });
  });

  it("the human grant resolves the open waiver request so the Needs You item clears", async () => {
    await requestWaiver();

    const granted = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "Accepted residual risk for this release.",
    });
    expect(granted.ok).toBe(true);

    const rows = specRows();
    const resolved = rows.find((row) => row.type === "spec-attention-resolved");
    expect(resolved).toMatchObject({
      gate: "delivery",
      gateRequestId: "attention-1",
      deepLinkId: "R1.1",
    });
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);
  });

  it("a repeated grant does not duplicate the resolution row", async () => {
    await requestWaiver();

    // The first grant persists the waiver; replay the notifier-facing grant
    // by requesting again for the same criterion and granting a second time.
    const grant = () =>
      service.grantWaiver({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        actor: { kind: "human" },
        reason: "Accepted residual risk for this release.",
      });
    await grant();
    await grant();

    expect(
      specRows().filter((row) => row.type === "spec-attention-resolved"),
    ).toHaveLength(1);
  });

  it("both waiver requests for the same criterion clear on one grant", async () => {
    await requestWaiver();
    await requestWaiver();

    expect(
      specRows().filter((row) => row.type === "spec-waiver-requested"),
    ).toHaveLength(2);
    // Duplicate open requests for the same subject collapse to one item.
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );

    await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "Accepted residual risk for this release.",
    });

    const rows = specRows();
    expect(
      rows.filter((row) => row.type === "spec-attention-resolved"),
    ).toHaveLength(2);
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);
  });
});

function seed(db: Db): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "waiver-attention",
    "Waiver Attention",
    '{"preset":"contract-bearing"}',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, 'hash-1', ?, ?, ?)`,
  ).run(REVISION_ID, SPEC_ID, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, 'requirement', 1, NULL, ?)`,
  ).run("requirement-1", SPEC_ID, NOW);
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, 'criterion', 1, ?, ?)`,
  ).run(CRITERION_ID, SPEC_ID, "requirement-1", NOW);
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, 0, ?, 'criterion-hash-1', 1, ?, ?)`,
  ).run(
    REVISION_ID,
    CRITERION_ID,
    JSON.stringify({
      kind: "criterion",
      text: "The waived behavior is accepted by a human.",
      validationStrategy: { kinds: ["test_run"] },
    }),
    NOW,
    NOW,
  );
}
