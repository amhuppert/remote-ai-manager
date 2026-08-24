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
import type { SpecNotification } from "@/lib/notifications/schemas";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
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
import { createReviewService, type ReviewService } from "./review-service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/gate-scoped-requests";
const PROJECT_NAME = "gate-scoped-requests-project";
const SPEC_ID = "spec-gate-scoped";
const REVISION_ID = "revision-proposed";
const EXECUTION_ID = "spec-execution-1";
const REQUIREMENT_COUNT = 12;
const NOW = "2026-08-02T09:00:00.000Z";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;
const HUMAN = { kind: "human" } as const;

function requirementElementId(number: number): string {
  return `element-requirement-${number}`;
}

function requirementPayload(number: number) {
  return {
    kind: "requirement",
    statement: `Requirement ${number} states an obligation.`,
    priority: "must",
    risk: "low",
  } as const;
}

function requirementHandles(): string[] {
  return Array.from(
    { length: REQUIREMENT_COUNT },
    (_unused, index) => `R${index + 1}`,
  );
}

describe("gate-scoped approval requests", () => {
  let db: Db;
  let service: ReviewService;
  let eventsRepo: ReturnType<typeof createSpecEventsRepo>;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    let idSequence = 0;
    eventsRepo = createSpecEventsRepo(db);
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
      findSpecNotificationsBySpecId(specId) {
        return notificationsRepo.findSpecNotificationsBySpecId(specId);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    service = createReviewService({
      specs: createSpecsRepo(db, createWriteQueue()),
      review: createSpecReviewRepo(db),
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
    });
  });

  function specRows(): SpecNotification[] {
    return notificationsRepo.findSpecNotificationsBySpecId(SPEC_ID);
  }

  function openRequests(): SpecNotification[] {
    return specRows().filter((row) => row.type === "spec-approval-requested");
  }

  /** The notification row the queue renders for one durable ask. */
  function requestRowId(attentionId: string): string {
    const row = openRequests().find(
      (candidate) => candidate.gateRequestId === attentionId,
    );
    if (row === undefined) {
      throw new Error(`no request row for ${attentionId}`);
    }
    return row.id;
  }

  function requestGate(gate: "requirements" | "plan") {
    return service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate,
      actor: AGENT,
    });
  }

  function approveRequirement(number: number) {
    return service.approveItem({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      subjectKind: "requirement",
      elementId: requirementElementId(number),
      approver: "operator",
      actor: HUMAN,
    });
  }

  async function approveAllRequirements(): Promise<void> {
    for (let number = 1; number <= REQUIREMENT_COUNT; number += 1) {
      const approved = await approveRequirement(number);
      if (!approved.ok) throw new Error(`R${number} approval was refused`);
    }
  }

  it("opens one gate-scoped entry summarizing every outstanding subject", async () => {
    const result = await requestGate("requirements");

    if (!result.ok) throw new Error("the gate request was refused");
    expect(result.value).toMatchObject({
      gate: "requirements",
      scope: "gate",
      subject: "requirements",
      alreadyRequested: false,
      signOffOutstanding: true,
    });
    expect(result.value.outstandingSubjects).toEqual(requirementHandles());

    const rows = openRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gate: "requirements",
      gateRequestId: result.value.attentionId,
      deepLinkId: "requirements",
    });
    // The body has to say what the human is being asked for; a 12-subject gate
    // whose entry names no subject is a Needs You entry nobody can act on.
    expect(rows[0]?.message).toContain("12");
    expect(rows[0]?.message).toContain("R1");
    expect(rows[0]?.message).toContain("R12");
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );
  });

  it("keeps one stable entry as the outstanding count falls to zero", async () => {
    const first = await requestGate("requirements");
    if (!first.ok) throw new Error("the gate request was refused");
    const attentionId = first.value.attentionId;

    for (let number = 1; number < REQUIREMENT_COUNT; number += 1) {
      const approved = await approveRequirement(number);
      if (!approved.ok) throw new Error(`R${number} approval was refused`);
    }
    const withOneLeft = await requestGate("requirements");
    if (!withOneLeft.ok) throw new Error("the gate request was refused");
    // One outstanding subject must not silently retarget the ask at that
    // subject: the meaning of an omitted --subject cannot change as approvals
    // land, or the request identity moves under the human.
    expect(withOneLeft.value).toMatchObject({
      scope: "gate",
      subject: "requirements",
      attentionId,
      alreadyRequested: true,
    });
    expect(withOneLeft.value.outstandingSubjects).toEqual(["R12"]);

    const approvedLast = await approveRequirement(REQUIREMENT_COUNT);
    expect(approvedLast.ok).toBe(true);
    const withNoneLeft = await requestGate("requirements");
    if (!withNoneLeft.ok) throw new Error("the gate request was refused");
    expect(withNoneLeft.value).toMatchObject({
      scope: "gate",
      attentionId,
      alreadyRequested: true,
      signOffOutstanding: true,
    });
    expect(withNoneLeft.value.outstandingSubjects).toEqual([]);

    expect(openRequests()).toHaveLength(1);
    expect(
      eventsRepo
        .findBySpecId(SPEC_ID)
        .filter((event) => event.event_type === "spec-attention-changed"),
    ).toHaveLength(1);
  });

  it("stays open through the sign-off tail and clears exactly once on sign-off", async () => {
    const requested = await requestGate("requirements");
    if (!requested.ok) throw new Error("the gate request was refused");
    await approveAllRequirements();
    const planApproved = await service.bulkApprove({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      subjects: [{ subjectKind: "plan", elementId: null }],
      approver: "operator",
      actor: HUMAN,
    });
    expect(planApproved.ok).toBe(true);
    // Every subject is approved and only the sign-off is left: the gate holds
    // no admission, so its request is still the thing a human must answer.
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );

    const signedOff = await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      approver: "operator",
      actor: HUMAN,
    });
    expect(signedOff).toMatchObject({
      ok: true,
      value: { revision: { state: "approved" } },
    });

    const granted = specRows().filter(
      (row) => row.type === "spec-approval-granted",
    );
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      gate: "requirements",
      gateRequestId: requested.value.attentionId,
    });
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      0,
    );
  });

  it("does not let the plan ITEM approval clear a plan GATE request", async () => {
    const requested = await requestGate("plan");
    if (!requested.ok) throw new Error("the gate request was refused");
    expect(requested.value).toMatchObject({ scope: "gate", subject: "plan" });

    const planApproved = await service.bulkApprove({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      subjects: [{ subjectKind: "plan", elementId: null }],
      approver: "operator",
      actor: HUMAN,
    });
    expect(planApproved.ok).toBe(true);

    // The gate is admitted by the revision sign-off, never by approving the
    // plan item: clearing here would retire the entry that asks for sign-off.
    expect(
      specRows().filter((row) => row.type === "spec-approval-granted"),
    ).toHaveLength(0);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );

    await approveAllRequirements();
    const signedOff = await service.signOffRevision({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      approver: "operator",
      actor: HUMAN,
    });
    expect(signedOff.ok).toBe(true);
    expect(
      specRows().filter((row) => row.type === "spec-approval-granted"),
    ).toMatchObject([{ gateRequestId: requested.value.attentionId }]);
  });

  /**
   * The plan gate is where the item subject and the gate name are the same
   * word, so a queue that re-derives request identity from (spec, gate,
   * subject) shows one entry for two asks — and answering the item hides the
   * one still waiting on the sign-off.
   */
  it("surfaces the plan ITEM ask and the plan GATE ask as two Needs You entries", async () => {
    const item = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "plan",
      subject: "plan",
      actor: AGENT,
    });
    const gate = await requestGate("plan");
    if (!item.ok || !gate.ok) throw new Error("a request was refused");
    expect(item.value).toMatchObject({ scope: "item", subject: "plan" });
    expect(gate.value).toMatchObject({ scope: "gate", subject: "plan" });
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      2,
    );

    const planApproved = await service.bulkApprove({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      subjects: [{ subjectKind: "plan", elementId: null }],
      approver: "operator",
      actor: HUMAN,
    });
    expect(planApproved.ok).toBe(true);

    const remaining = deriveNotificationOutcomes(specRows(), []).needsAction;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(
      `notification:${requestRowId(gate.value.attentionId)}`,
    );
  });

  /**
   * A granted ask is answered, not permanently spent. Leaving it in request
   * identity makes a re-request dedupe onto an id the queue already resolved,
   * so the subject becomes outstanding again with nothing in the human's list.
   */
  it("re-opens the ask after a human unapproves the item that granted it", async () => {
    const first = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    if (!first.ok) throw new Error("the item request was refused");
    expect((await approveRequirement(1)).ok).toBe(true);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      0,
    );

    const unapproved = await service.unapproveItem({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      subjectKind: "requirement",
      elementId: requirementElementId(1),
      actor: HUMAN,
    });
    expect(unapproved.ok).toBe(true);

    const again = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    if (!again.ok) throw new Error("the second item request was refused");
    expect(again.value.alreadyRequested).toBe(false);
    expect(again.value.attentionId).not.toBe(first.value.attentionId);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );
  });

  it("keeps an explicit --subject request item-scoped, cleared only by its own item", async () => {
    const item = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    const gate = await requestGate("requirements");
    if (!item.ok || !gate.ok) throw new Error("a request was refused");
    // Two different asks: the item and the gate. They must not collapse onto
    // one attention id in either direction.
    expect(item.value).toMatchObject({ scope: "item", subject: "R1" });
    expect(gate.value.attentionId).not.toBe(item.value.attentionId);
    expect(openRequests()).toHaveLength(2);

    const approved = await approveRequirement(1);
    expect(approved.ok).toBe(true);

    const granted = specRows().filter(
      (row) => row.type === "spec-approval-granted",
    );
    expect(granted).toMatchObject([{ gateRequestId: item.value.attentionId }]);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      1,
    );
  });

  it("clears authoring requests for the revision Request Changes ended, never the run's", async () => {
    const authoring = await requestGate("requirements");
    const delivery = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "delivery",
      actor: AGENT,
    });
    if (!authoring.ok || !delivery.ok) throw new Error("a request was refused");

    const changes = await service.requestChanges({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      actor: HUMAN,
    });
    expect(changes.ok).toBe(true);

    const openIds = openRequestIds(specRows());
    expect(openIds).toEqual([delivery.value.attentionId]);
    expect(
      specRows().filter((row) => row.type === "spec-attention-resolved"),
    ).toMatchObject([{ gateRequestId: authoring.value.attentionId }]);
  });

  it("clears the withdrawn revision's authoring requests, never the run's", async () => {
    const authoring = await requestGate("requirements");
    const delivery = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "delivery",
      actor: AGENT,
    });
    if (!authoring.ok || !delivery.ok) throw new Error("a request was refused");

    const withdrawn = await service.withdraw({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      actor: HUMAN,
    });
    expect(withdrawn.ok).toBe(true);

    expect(openRequestIds(specRows())).toEqual([delivery.value.attentionId]);
    // A withdrawn revision is terminal, so its ask ends without an answer —
    // it is closed, not reported as granted.
    expect(
      specRows().filter((row) => row.type === "spec-approval-granted"),
    ).toHaveLength(0);
    expect(
      specRows().filter((row) => row.type === "spec-attention-resolved"),
    ).toMatchObject([{ gateRequestId: authoring.value.attentionId }]);
  });

  it("retires a pre-boundary scope-less request instead of colliding with a gate request", async () => {
    // A request recorded before request scope existed carries no scope, so it
    // cannot be told apart from a gate ask. It is retired, not reused.
    seedPreBoundaryRequest("R1");

    const result = await requestGate("requirements");

    if (!result.ok) throw new Error("the gate request was refused");
    expect(result.value.attentionId).not.toBe("attention-pre-boundary-R1");
    expect(result.value.alreadyRequested).toBe(false);
    expect(openRequestIds(specRows())).toEqual([result.value.attentionId]);
    // The legacy ask stays in history; it is retired durably, not deleted.
    const retired = eventsRepo
      .findBySpecId(SPEC_ID)
      .filter((event) =>
        event.payload_json.includes('"approval-request-retired"'),
      );
    expect(retired).toHaveLength(1);
    expect(retired[0]?.payload_json).toContain("attention-pre-boundary-R1");
  });

  /**
   * Retiring a pre-boundary ask is a boundary cost paid by the ask the scoped
   * one replaces — never by an ask about a different subject, which is still
   * work the human owes and would vanish from the queue unanswered.
   */
  it("retires only the pre-boundary request the new item ask replaces", async () => {
    seedPreBoundaryRequest("R1");
    seedPreBoundaryRequest("R2");
    seedPreBoundaryRequest("R3");

    const item = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    if (!item.ok) throw new Error("the item request was refused");
    expect([...openRequestIds(specRows())].sort()).toEqual(
      [
        "attention-pre-boundary-R2",
        "attention-pre-boundary-R3",
        item.value.attentionId,
      ].sort(),
    );
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      3,
    );
  });

  it("closes a pre-boundary request when the item it names is approved", async () => {
    seedPreBoundaryRequest("R1");

    expect((await approveRequirement(1)).ok).toBe(true);

    expect(openRequestIds(specRows())).toEqual([]);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      0,
    );
    // Answered, so it leaves request identity durably rather than lingering
    // until the revision ends.
    expect(
      eventsRepo
        .findBySpecId(SPEC_ID)
        .filter((event) =>
          event.payload_json.includes('"approval-request-retired"'),
        ),
    ).toHaveLength(1);
  });

  /** One approval request as it was recorded before requests carried a scope. */
  function seedPreBoundaryRequest(subject: string): void {
    const attentionId = `attention-pre-boundary-${subject}`;
    eventsRepo.append({
      spec_id: SPEC_ID,
      occurred_at: NOW,
      event_type: "spec-attention-changed",
      actor_json: JSON.stringify(AGENT),
      payload_json: JSON.stringify({
        kind: "approval-requested",
        attentionId,
        revisionId: REVISION_ID,
        gate: "requirements",
        subject,
        executionId: null,
        active: true,
      }),
    });
    notificationsRepo.createSpecNotification({
      type: "spec-approval-requested",
      title: "Requirements approval requested",
      message: `Gate Scoped: ${subject}`,
      projectName: PROJECT_NAME,
      sessionName: null,
      specId: SPEC_ID,
      specSlug: "gate-scoped",
      specName: "Gate Scoped",
      gate: "requirements",
      gateRequestId: attentionId,
      deepLinkId: subject,
      dedupeKey: `spec-approval-requested:${attentionId}`,
    });
  }
});

function openRequestIds(rows: readonly SpecNotification[]): string[] {
  const resolved = new Set(
    rows
      .filter(
        (row) =>
          row.type === "spec-approval-granted" ||
          row.type === "spec-attention-resolved",
      )
      .map((row) => row.gateRequestId),
  );
  return rows
    .filter(
      (row) =>
        row.type === "spec-approval-requested" &&
        !resolved.has(row.gateRequestId),
    )
    .map((row) => row.gateRequestId);
}

function seed(db: Db): void {
  const elements = Array.from({ length: REQUIREMENT_COUNT }, (_, index) => {
    const number = index + 1;
    return {
      elementId: requirementElementId(number),
      kind: "requirement" as const,
      number,
      parentElementId: null,
      position: number,
      payload: requirementPayload(number),
    };
  });
  const contentHash = computeSpecRevisionContentHashFromCanonical(
    "plan",
    elements,
  );
  const citationHash = computeSpecRevisionCitationHash(2, []);

  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "gate-scoped",
    "Gate Scoped",
    '{"preset":"contract-bearing"}',
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, citation_contract_version, citation_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'proposed', 'plan', NULL, ?, 2, ?, ?, NULL, ?)`,
  ).run(REVISION_ID, SPEC_ID, contentHash, citationHash, NOW, NOW);
  for (const element of elements) {
    db.prepare(
      `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
       VALUES (?, ?, 'requirement', ?, NULL, ?)`,
    ).run(element.elementId, SPEC_ID, element.number, NOW);
    db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      REVISION_ID,
      element.elementId,
      element.position,
      JSON.stringify(element.payload),
      computeSpecElementPayloadHash(element.payload),
      NOW,
      NOW,
    );
  }
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
    REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    NOW,
    NOW,
  );
}
