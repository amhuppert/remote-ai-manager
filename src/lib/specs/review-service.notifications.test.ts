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
import type { SpecElementPayload } from "@/lib/specs/schemas";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  computeSpecElementPayloadHash,
  computeSpecRevisionCitationHash,
  computeSpecRevisionContentHashFromCanonical,
  createSpecsRepo,
} from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createSpecEventsPublisher } from "./events";
import { revisionReviewHash } from "./review-hash";
import {
  createReviewService,
  type ReviewService,
  type ReviewServiceDeps,
} from "./review-service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/review-notifications";
const PROJECT_NAME = "review-notifications-project";
const SPEC_ID = "spec-review-notifications";
const APPROVED_REVISION_ID = "revision-approved";
const EXECUTION_ID = "spec-execution-1";
const DRAFT_REVISION_ID = "revision-draft";
const REQUIREMENT_ELEMENT_ID = "element-requirement-1";
const TASK_ELEMENT_ID = "element-task-1";
const CRITERION_ELEMENT_ID = "element-criterion-1";
const DRAFT_TASK_ELEMENT_ID = "element-task-2";
const NOW = "2026-07-19T09:00:00.000Z";

const requirementPayload: Extract<SpecElementPayload, { kind: "requirement" }> =
  {
    kind: "requirement",
    statement: "The system persists approvals durably.",
    priority: "must",
    risk: "medium",
  };

const taskPayload: Extract<SpecElementPayload, { kind: "task" }> = {
  kind: "task",
  title: "Deliver the approval cycle",
  instructions: "Close the request when the human grants the gate.",
  tracedRequirementElementIds: [],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: [],
  dependsOnTaskElementIds: [],
};

describe("ReviewService spec approval notifications (runtime wiring)", () => {
  let db: Db;
  let service: ReviewService;
  let serviceDeps: ReviewServiceDeps;
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
    serviceDeps = {
      specs: createSpecsRepo(db, writeQueue),
      review: reviewRepo,
      delivery: createSpecDeliveryRepo(db),
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      attention: eventsRepo,
      notifier,
      policyNotifier: notifier,
      newId: (prefix) => `${prefix}-${++idSequence}`,
      now: () => NOW,
    };
    service = createReviewService(serviceDeps);
  });

  function specRows() {
    return notificationsRepo.findSpecNotificationsBySpecId(SPEC_ID);
  }

  async function reviewHash(revisionId: string): Promise<string> {
    const snapshot = await serviceDeps.specs.getRevisionSnapshot(revisionId);
    if (snapshot === null) throw new Error(`revision ${revisionId} missing`);
    return revisionReviewHash(snapshot);
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

  it("a delivery-gate request lands a Needs You row deep-linked to the delivery approval surface", async () => {
    // The gate auto-fire and `cctl spec request-approval --gate delivery`
    // both default the subject to the gate name; the persisted deepLinkId is
    // what Active Work turns into the Studio `?el=delivery` link.
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: { kind: "agent", conversationId: "workflow:workflow-exec-1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("request was refused");
    const rows = specRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "spec-approval-requested",
      gate: "delivery",
      gateRequestId: result.value.attentionId,
      deepLinkId: "delivery",
    });
  });

  it("a second refusal-driven request keeps one durable requested row and one push", async () => {
    // Every delivery-gate refusal re-requests approval; the retry path
    // re-invokes the notifier ON PURPOSE (crash recovery below), so duplicate
    // suppression must live in the durable notification layer. This proves it
    // end-to-end through the real notifications service: two successful
    // requests, one spec-approval-requested row, one push.
    const request = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        actor: { kind: "agent", conversationId: "workflow:workflow-exec-1" },
      });

    const first = await request();
    const second = await request();

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({
      ok: true,
      value: { alreadyRequested: true },
    });
    const rows = specRows();
    expect(
      rows.filter((row) => row.type === "spec-approval-requested"),
    ).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(1);
  });

  it("recovers the Needs You row on retry when the notifier crashed after the request committed", async () => {
    let remainingFailures = 1;
    const failOnce: typeof notifier = {
      ...notifier,
      approvalRequested(notice) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("notification pipeline down");
        }
        notifier.approvalRequested(notice);
      },
    };
    const flaky = createReviewService({ ...serviceDeps, notifier: failOnce });
    const request = () =>
      flaky.requestApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        actor: { kind: "agent", conversationId: "workflow:workflow-exec-1" },
      });

    // The durable request commits before the notifier runs, so the first
    // attempt succeeds as an ask and leaves no Needs You row behind — the
    // receipt names that gap rather than reporting the whole act as failed.
    const first = await request();
    expect(first).toMatchObject({
      ok: true,
      value: { alreadyRequested: false, deliveryOutcome: "delivery-uncertain" },
    });
    expect(specRows()).toHaveLength(0);

    // The retry short-circuits on the existing durable request but still
    // re-invokes the notifier, which lands the missing row exactly once.
    const retried = await request();
    expect(retried).toMatchObject({
      ok: true,
      value: { alreadyRequested: true, deliveryOutcome: "delivered" },
    });
    const rows = specRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "spec-approval-requested",
      gate: "delivery",
      deepLinkId: "delivery",
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
    // The request fires when the compiled definition parks for a human, so
    // the run sits at definition review with its lane linked — a running run
    // has nothing left for execution_start and would be refused.
    db.prepare(
      "UPDATE spec_executions SET state = 'definition_review', workflow_execution_id = 'workflow-execution-1' WHERE id = ?",
    ).run(EXECUTION_ID);
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
    seedDraftRequirement(db);
    const requested = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });
    if (!requested.ok) throw new Error("request was refused");

    const approved = await service.approveItem({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      subjectKind: "requirement",
      elementId: REQUIREMENT_ELEMENT_ID,
      approver: "operator",
      expectedReviewHash: await reviewHash(DRAFT_REVISION_ID),
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
    seedDraftRequirement(db);
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"exploratory"}',
      SPEC_ID,
    );

    const signed = await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      approver: "operator",
      expectedReviewHash: await reviewHash(DRAFT_REVISION_ID),
      actor: { kind: "human" },
    });
    expect(signed).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" }, approval: null },
    });

    const rows = specRows();
    expect(rows.every((row) => row.type === "spec-policy-admitted")).toBe(true);
    const admissions =
      reviewRepo.findGateAdmissionsByRevision(DRAFT_REVISION_ID);
    expect(admissions.map((admission) => admission.basis)).toEqual(
      admissions.map(() => "notify_policy"),
    );
    expect(admissions.map((admission) => admission.gate).sort()).toEqual([
      "plan",
      "requirements",
    ]);
    expect(rows.map((row) => row.gate).sort()).toEqual([
      "plan",
      "requirements",
    ]);
    expect(new Set(rows.map((row) => row.gateRequestId))).toEqual(
      new Set(admissions.map((admission) => admission.id)),
    );
    expect(deriveNotificationOutcomes(rows, []).needsAction).toHaveLength(0);

    // Signing off the already-approved revision is a no-op: no new notices.
    await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      approver: "operator",
      expectedReviewHash: await reviewHash(DRAFT_REVISION_ID),
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

/**
 * An open draft carrying a lint-clean plan — a requirement, its criterion, and
 * a task covering it — so a human can sign it off without further authoring.
 */
function seedDraftRequirement(db: Db): void {
  const citationHash = computeSpecRevisionCitationHash(2, []);

  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       citation_contract_version, citation_hash, proposed_at, approved_at,
       created_at
     ) VALUES (?, ?, 2, 'draft', NULL, NULL, 2, ?, NULL, NULL, ?)`,
  ).run(DRAFT_REVISION_ID, SPEC_ID, citationHash, NOW);
  const elements: {
    id: string;
    number: number;
    parentElementId: string | null;
    payload: SpecElementPayload;
  }[] = [
    {
      id: REQUIREMENT_ELEMENT_ID,
      number: 1,
      parentElementId: null,
      payload: requirementPayload,
    },
    {
      id: CRITERION_ELEMENT_ID,
      number: 1,
      parentElementId: REQUIREMENT_ELEMENT_ID,
      payload: {
        kind: "criterion",
        text: "A granted approval survives a restart.",
        validationStrategy: { kinds: ["test_run"] },
      },
    },
    {
      id: DRAFT_TASK_ELEMENT_ID,
      number: 2,
      parentElementId: null,
      payload: {
        ...taskPayload,
        tracedRequirementElementIds: [REQUIREMENT_ELEMENT_ID],
        coveredCriterionElementIds: [CRITERION_ELEMENT_ID],
      },
    },
  ];
  for (const [position, element] of elements.entries()) {
    db.prepare(
      `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      element.id,
      SPEC_ID,
      element.payload.kind,
      element.number,
      element.parentElementId,
      NOW,
    );
    db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      DRAFT_REVISION_ID,
      element.id,
      position,
      JSON.stringify(element.payload),
      computeSpecElementPayloadHash(element.payload),
      NOW,
      NOW,
    );
  }
}

function seed(db: Db): void {
  const contentHash = computeSpecRevisionContentHashFromCanonical("plan", [
    {
      elementId: TASK_ELEMENT_ID,
      kind: "task",
      number: 1,
      parentElementId: null,
      position: 0,
      payload: taskPayload,
    },
  ]);
  const citationHash = computeSpecRevisionCitationHash(2, []);

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
       citation_contract_version, citation_hash, proposed_at, approved_at,
       created_at
     ) VALUES (?, ?, 1, 'approved', NULL, ?, 2, ?, ?, ?, ?)`,
  ).run(
    APPROVED_REVISION_ID,
    SPEC_ID,
    contentHash,
    citationHash,
    NOW,
    NOW,
    NOW,
  );
  // The delivery requests below name T1, so the approved revision the run pins
  // has to actually contain it.
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, 'task', 1, NULL, ?)`,
  ).run(TASK_ELEMENT_ID, SPEC_ID, NOW);
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, 0, ?, ?, 1, ?, ?)`,
  ).run(
    APPROVED_REVISION_ID,
    TASK_ELEMENT_ID,
    JSON.stringify(taskPayload),
    computeSpecElementPayloadHash(taskPayload),
    NOW,
    NOW,
  );
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
