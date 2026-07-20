import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { deriveNotificationOutcomes } from "@/components/session/sidebar/active-work-adapters";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import type { Notification } from "@/lib/notifications/schemas";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createSpecEventsPublisher } from "./events";
import { createReviewService, type ReviewService } from "./review-service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/review-notifications";
const PROJECT_NAME = "review-notifications-project";
const SPEC_ID = "spec-review-notifications";
const APPROVED_REVISION_ID = "revision-approved";
const EXECUTION_ID = "spec-execution-1";
const PROPOSED_REVISION_ID = "revision-proposed";
const REQUIREMENT_ELEMENT_ID = "element-requirement-1";
const NOW = "2026-07-19T09:00:00.000Z";

describe("ReviewService spec approval notifications (runtime wiring)", () => {
  let db: Db;
  let service: ReviewService;
  let notifier: ReturnType<typeof createSpecApprovalNotifier>;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let reviewRepo: ReturnType<typeof createSpecReviewRepo>;
  let pushed: Notification[];

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    pushed = [];
    let idSequence = 0;
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: (notification) => {
        pushed.push(notification);
      },
    });
    notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(specId) {
        return notificationsRepo.findSpecNotificationsBySpecId(specId);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    reviewRepo = createSpecReviewRepo(db);
    service = createReviewService({
      specs: createSpecsRepo(db, writeQueue),
      review: reviewRepo,
      delivery: createSpecDeliveryRepo(db),
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      notifier,
      policyNotifier: notifier,
      newId: (prefix) => `${prefix}-${++idSequence}`,
      now: () => NOW,
    });
  });

  function specRows() {
    return notificationsRepo.findSpecNotificationsBySpecId(SPEC_ID);
  }

  it("requestApproval creates a spec-approval-requested notification that surfaces as a Needs You item", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "T1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("request was refused");
    const rows = specRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "spec-approval-requested",
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      specSlug: "review-notifications",
      specName: "Review Notifications",
      gate: "delivery",
      gateRequestId: result.value.attentionId,
      deepLinkId: "T1",
    });
    expect(pushed).toHaveLength(1);

    const outcomes = deriveNotificationOutcomes(rows, []);
    expect(outcomes.needsAction).toHaveLength(1);
    expect(outcomes.needsAction[0]).toMatchObject({
      kind: "spec",
      phase: "Delivery approval required",
    });
  });

  it("grantGateApproval creates the matching spec-approval-granted row so the Needs You item clears", async () => {
    const requested = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "T1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });
    if (!requested.ok) throw new Error("request was refused");

    const granted = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(granted.ok).toBe(true);
    const rows = specRows();
    expect(rows).toHaveLength(2);
    const grantedRow = rows.find((row) => row.type === "spec-approval-granted");
    expect(grantedRow).toMatchObject({
      gate: "delivery",
      gateRequestId: requested.value.attentionId,
      deepLinkId: "T1",
    });
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);
  });

  it("the execution-start gate cycle surfaces in Needs You and clears on the human grant", async () => {
    const requested = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });
    if (!requested.ok) throw new Error("request was refused");

    const openOutcomes = deriveNotificationOutcomes(specRows(), []);
    expect(openOutcomes.needsAction).toHaveLength(1);
    expect(openOutcomes.needsAction[0]).toMatchObject({
      kind: "spec",
      phase: "Execution start approval required",
    });

    const granted = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "execution_start",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(granted.ok).toBe(true);
    const rows = specRows();
    expect(
      rows.find((row) => row.type === "spec-approval-granted"),
    ).toMatchObject({
      gate: "execution_start",
      gateRequestId: requested.value.attentionId,
    });
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);
  });

  it("approving the exact requested element clears its Needs You request even though the request stored the handle", async () => {
    seedProposedRequirement(db);
    const requested = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: PROPOSED_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });
    if (!requested.ok) throw new Error("request was refused");

    const approved = await service.approveItem({
      specId: SPEC_ID,
      revisionId: PROPOSED_REVISION_ID,
      subjectKind: "requirement",
      elementId: REQUIREMENT_ELEMENT_ID,
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(approved.ok).toBe(true);
    const grantedRow = specRows().find(
      (row) => row.type === "spec-approval-granted",
    );
    expect(grantedRow).toMatchObject({
      gateRequestId: requested.value.attentionId,
      deepLinkId: "R1",
    });
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      0,
    );
  });

  it("a repeated grant does not duplicate the granted notification", async () => {
    const requested = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "T1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });
    if (!requested.ok) throw new Error("request was refused");
    const grant = () =>
      service.grantGateApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        executionId: EXECUTION_ID,
        gate: "delivery",
        approver: "operator",
        actor: { kind: "human" },
      });
    await grant();
    await grant();

    expect(
      specRows().filter((row) => row.type === "spec-approval-granted"),
    ).toHaveLength(1);
  });

  it("a refused request creates no notification row", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: "revision-unknown",
      gate: "delivery",
      subject: "T1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });

    expect(result.ok).toBe(false);
    expect(specRows()).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it("11.2 a sign-off after the dials were loosened to Notify fires one post-hoc notice per admission it inserts", async () => {
    seedProposedRequirement(db);
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"exploratory"}',
      SPEC_ID,
    );
    // A propose-time admission already exists for the requirements gate: the
    // sign-off must not duplicate its row or its notice.
    reviewRepo.insertGateAdmission({
      id: "admission-propose-requirements",
      spec_id: SPEC_ID,
      gate: "requirements",
      basis: "notify_policy",
      approval_id: null,
      revision_id: PROPOSED_REVISION_ID,
      execution_id: null,
      actor_json: '{"kind":"agent","conversationId":"conversation-1"}',
      created_at: NOW,
    });

    const signed = await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: PROPOSED_REVISION_ID,
      approver: "operator",
      actor: { kind: "human" },
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const rows = specRows();
    expect(rows.every((row) => row.type === "spec-policy-admitted")).toBe(true);
    expect(rows.map((row) => row.gate).sort()).toEqual(["design", "plan"]);
    const insertedAdmissionIds = reviewRepo
      .findGateAdmissionsByRevision(PROPOSED_REVISION_ID)
      .filter(
        (admission) =>
          admission.basis === "notify_policy" &&
          admission.id !== "admission-propose-requirements",
      )
      .map((admission) => admission.id);
    expect(new Set(rows.map((row) => row.gateRequestId))).toEqual(
      new Set(insertedAdmissionIds),
    );
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);

    // Signing off the already-approved revision is a no-op: no new notices.
    await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: PROPOSED_REVISION_ID,
      approver: "operator",
      actor: { kind: "human" },
    });
    expect(specRows()).toHaveLength(2);
  });

  it("11.2 policyAdmitted notifies the human post hoc without opening a Needs You item, once per admission", () => {
    const notice = {
      specId: SPEC_ID,
      specSlug: "review-notifications",
      specName: "Review Notifications",
      projectPath: PROJECT_PATH,
      gate: "execution_start" as const,
      basis: "notify_policy" as const,
      admissionId: "admission-notify-1",
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      occurredAt: NOW,
    };

    notifier.policyAdmitted(notice);
    notifier.policyAdmitted(notice);

    const rows = specRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "spec-policy-admitted",
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      specSlug: "review-notifications",
      specName: "Review Notifications",
      gate: "execution_start",
      gateRequestId: "admission-notify-1",
    });
    expect(pushed).toHaveLength(1);

    const outcomes = deriveNotificationOutcomes(rows, []);
    expect(outcomes.needsAction).toHaveLength(0);
    expect(outcomes.attention).toHaveLength(0);
  });
});

function seedProposedRequirement(db: Db): void {
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 2, 'proposed', NULL, 'hash-2', ?, NULL, ?)`,
  ).run(PROPOSED_REVISION_ID, SPEC_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, 'requirement', 1, NULL, ?)`,
  ).run(REQUIREMENT_ELEMENT_ID, SPEC_ID, NOW);
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, 0, ?, 'payload-hash-1', 1, ?, ?)`,
  ).run(
    PROPOSED_REVISION_ID,
    REQUIREMENT_ELEMENT_ID,
    JSON.stringify({
      kind: "requirement",
      statement: "The system persists approvals durably.",
      priority: "must",
      risk: "medium",
    }),
    NOW,
    NOW,
  );
}

function seed(db: Db): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "review-notifications",
    "Review Notifications",
    '{"preset":"contract-bearing"}',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, 'hash-1', ?, ?, ?)`,
  ).run(APPROVED_REVISION_ID, SPEC_ID, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
       NULL, NULL, ?, ?)`,
  ).run(
    EXECUTION_ID,
    SPEC_ID,
    APPROVED_REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":["criterion-1"],"exclusionDispositions":[]}',
    NOW,
    NOW,
  );
}
