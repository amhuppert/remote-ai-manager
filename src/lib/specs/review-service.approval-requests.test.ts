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
import type { SSEEvent } from "@/lib/api/sse-events";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { createSpecEventsPublisher } from "./events";
import {
  createReviewService,
  type ReviewService,
  type SpecApprovalRequestNotice,
} from "./review-service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/approval-requests";
const SPEC_ID = "spec-approval-requests";
const DRAFT_REVISION_ID = "revision-draft";
const APPROVED_REVISION_ID = "revision-approved";
const REQUIREMENT_ELEMENT_ID = "element-requirement-1";
const DECISION_ELEMENT_ID = "element-decision-1";
const EXECUTION_ID = "spec-execution-1";
const SECOND_EXECUTION_ID = "spec-execution-2";
const NOW = "2026-07-25T09:00:00.000Z";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;

describe("ReviewService.requestApproval validation", () => {
  let db: Db;
  let service: ReviewService;
  let eventsRepo: ReturnType<typeof createSpecEventsRepo>;
  let reviewRepo: ReturnType<typeof createSpecReviewRepo>;
  let published: SSEEvent[];
  let requested: SpecApprovalRequestNotice[];

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    published = [];
    requested = [];
    let idSequence = 0;
    reviewRepo = createSpecReviewRepo(db);
    eventsRepo = createSpecEventsRepo(db);
    service = createReviewService({
      specs: createSpecsRepo(db, createWriteQueue()),
      review: reviewRepo,
      delivery: createSpecDeliveryRepo(db),
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish(event) {
          published.push(event);
          return { delivered: true };
        },
      }),
      attention: eventsRepo,
      notifier: {
        approvalRequested(notice) {
          requested.push(notice);
        },
        approvalGranted() {},
      },
      newId: (prefix) => `${prefix}-${++idSequence}`,
      now: () => NOW,
    });
  });

  function attentionEvents() {
    return eventsRepo
      .findBySpecId(SPEC_ID)
      .filter((event) => event.event_type === "spec-attention-changed");
  }

  it("issues the request for an outstanding element approval", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "requirements", subject: "R1" },
    });
    expect(attentionEvents()).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  it("returns the existing request instead of a second Needs You entry", async () => {
    const first = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });
    const second = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    if (!first.ok || !second.ok) throw new Error("request was refused");
    expect(second.value.attentionId).toBe(first.value.attentionId);
    expect(second.value.alreadyRequested).toBe(true);
    expect(first.value.alreadyRequested).toBe(false);
    expect(attentionEvents()).toHaveLength(1);
    // The repeat re-invokes the notifier as an idempotent ensure (it dedupes
    // on the stable attention id), so a notifier crash on the first attempt
    // can never permanently lose the Needs You row.
    expect(requested).toHaveLength(2);
    expect(new Set(requested.map((notice) => notice.gateRequestId)).size).toBe(
      1,
    );
  });

  it("converges the gate's pinned-revision ask and the CLI's latest-revision ask on one durable request", async () => {
    // The delivery gate auto-fire names the run's pinned revision while the
    // CLI resolves the latest one; with an open amendment those differ. A
    // per-run gate's identity is (spec, gate, subject, execution), so both
    // asks must land on the same durable request and attention id.
    const fromCli = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });
    const fromGate = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    if (!fromCli.ok || !fromGate.ok) throw new Error("request was refused");
    expect(fromGate.value.attentionId).toBe(fromCli.value.attentionId);
    expect(fromGate.value.alreadyRequested).toBe(true);
    expect(fromCli.value.alreadyRequested).toBe(false);
    const events = attentionEvents();
    expect(events).toHaveLength(1);
    // The durable identity is canonicalized to the revision the run pinned —
    // the only revision this run can ever be approved against.
    const payload: unknown = JSON.parse(events[0]?.payload_json ?? "null");
    expect(payload).toMatchObject({
      kind: "approval-requested",
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      executionId: EXECUTION_ID,
    });
    expect(fromCli.value.revisionId).toBe(APPROVED_REVISION_ID);
  });

  it("recognizes a pre-fix execution-scoped request persisted under a non-pinned revision", async () => {
    // Rows persisted before revision canonicalization can carry the latest
    // revision in their payload; the execution id alone identifies the ask.
    eventsRepo.append({
      spec_id: SPEC_ID,
      occurred_at: NOW,
      event_type: "spec-attention-changed",
      actor_json: JSON.stringify(AGENT),
      payload_json: JSON.stringify({
        kind: "approval-requested",
        attentionId: "attention-pre-fix",
        revisionId: DRAFT_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        executionId: EXECUTION_ID,
        active: true,
      }),
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    if (!result.ok) throw new Error("request was refused");
    expect(result.value.attentionId).toBe("attention-pre-fix");
    expect(result.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
  });

  it("asks again for the next run at an execution-scoped gate, and only once per run", async () => {
    const requestDelivery = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "delivery",
        subject: "delivery",
        actor: AGENT,
      });

    const firstRun = await requestDelivery();
    const firstRunRepeat = await requestDelivery();
    if (!firstRun.ok || !firstRunRepeat.ok) {
      throw new Error("request was refused");
    }
    expect(firstRunRepeat.value.attentionId).toBe(firstRun.value.attentionId);
    expect(firstRunRepeat.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
    // Repeat notices reuse the run's attention id (idempotent ensure).
    expect(requested.map((notice) => notice.gateRequestId)).toEqual([
      firstRun.value.attentionId,
      firstRun.value.attentionId,
    ]);

    startSecondRun(db);

    const secondRun = await requestDelivery();
    if (!secondRun.ok) throw new Error("request was refused");
    expect(secondRun.value.alreadyRequested).toBe(false);
    expect(secondRun.value.attentionId).not.toBe(firstRun.value.attentionId);
    expect(attentionEvents()).toHaveLength(2);
    expect(requested).toHaveLength(3);
  });

  it("keeps a revision-scoped request idempotent across runs, which do not scope it", async () => {
    const requestRequirements = () =>
      service.requestApproval({
        specId: SPEC_ID,
        revisionId: DRAFT_REVISION_ID,
        gate: "requirements",
        subject: "R1",
        actor: AGENT,
      });

    const first = await requestRequirements();
    startSecondRun(db);
    const second = await requestRequirements();

    if (!first.ok || !second.ok) throw new Error("request was refused");
    expect(second.value.attentionId).toBe(first.value.attentionId);
    expect(second.value.alreadyRequested).toBe(true);
    expect(attentionEvents()).toHaveLength(1);
    expect(new Set(requested.map((notice) => notice.gateRequestId)).size).toBe(
      1,
    );
  });

  it("refuses a request that names a revision other than the current one", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "stale_revision" },
    });
    expect(attentionEvents()).toHaveLength(0);
    expect(requested).toHaveLength(0);
  });

  it("refuses a gate the policy does not gate on", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"requirements":"notify"}}',
      SPEC_ID,
    );

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses a gate the draft has not reached yet", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "plan",
      subject: "plan",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("resolves an omitted subject to the gate's single outstanding subject", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "requirements", subject: "R1" },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("refuses an omitted subject when several subjects are outstanding, listing them", async () => {
    insertElement(db, "element-requirement-2", "requirement", 2, null);
    insertVersion(db, DRAFT_REVISION_ID, "element-requirement-2", 2, {
      kind: "requirement",
      statement: "A second outstanding requirement.",
      priority: "must",
      risk: "low",
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "invalid_subject" },
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.instruction).toContain("R1");
    expect(result.refusal.instruction).toContain("R2");
    expect(attentionEvents()).toHaveLength(0);
  });

  it("resolves an omitted subject at an execution gate to the gate itself", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "delivery", subject: "delivery" },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("refuses a delivery request while no run exists to approve", async () => {
    db.prepare("DELETE FROM spec_executions WHERE id = ?").run(EXECUTION_ID);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses an execution-start request while no run awaits definition approval", async () => {
    // The seeded run is already running: its start either happened or was
    // policy-admitted, so there is no definition left for a human to approve.
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_not_applicable" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("issues the execution-start request for a run parked with its lane linked", async () => {
    db.prepare(
      "UPDATE spec_executions SET state = 'definition_review', workflow_execution_id = 'workflow-execution-1' WHERE id = ?",
    ).run(EXECUTION_ID);

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "execution_start", subject: "execution_start" },
    });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("issues the frozen execution-start request after the live dial changes to Notify", async () => {
    db.prepare(
      "UPDATE spec_executions SET state = 'definition_review', workflow_execution_id = 'workflow-execution-1' WHERE id = ?",
    ).run(EXECUTION_ID);
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"execution_start":"notify"}}',
      SPEC_ID,
    );

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      gate: "execution_start",
      subject: "execution_start",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { gate: "execution_start", subject: "execution_start" },
    });
    expect(attentionEvents()).toHaveLength(1);
    expect(requested).toHaveLength(1);
  });

  it("refuses a subject that is not outstanding at the named gate", async () => {
    const unknown = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R9",
      actor: AGENT,
    });
    const wrongGate = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "D1",
      actor: AGENT,
    });

    expect(unknown).toMatchObject({
      ok: false,
      refusal: { code: "invalid_subject" },
    });
    expect(wrongGate).toMatchObject({
      ok: false,
      refusal: { code: "invalid_subject" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses a request for an approval that is already granted", async () => {
    reviewRepo.saveApproval({
      id: "approval-requirement-1",
      spec_id: SPEC_ID,
      subject_kind: "requirement",
      element_id: REQUIREMENT_ELEMENT_ID,
      revision_id: DRAFT_REVISION_ID,
      approver: "operator",
      granted_at: NOW,
      validity: "valid",
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("refuses a delivery request while the gate is already admitted for the run", async () => {
    reviewRepo.insertGateAdmission({
      id: "admission-delivery-1",
      spec_id: SPEC_ID,
      gate: "delivery",
      basis: "human_approval",
      approval_id: null,
      revision_id: APPROVED_REVISION_ID,
      execution_id: EXECUTION_ID,
      actor_json: '{"kind":"human"}',
      created_at: NOW,
    });

    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "already_satisfied" },
    });
    expect(attentionEvents()).toHaveLength(0);
  });

  it("still issues the delivery request while the run holds no admission", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "delivery",
      subject: "delivery",
      actor: AGENT,
    });

    expect(result).toMatchObject({ ok: true, value: { gate: "delivery" } });
    expect(attentionEvents()).toHaveLength(1);
  });

  it("names the spec, not approval authority: the receipt never records an admission", async () => {
    const result = await service.requestApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      gate: "requirements",
      subject: "R1",
      actor: AGENT,
    });

    expect(result.ok).toBe(true);
    expect(reviewRepo.findGateAdmissionsBySpecId(SPEC_ID)).toHaveLength(0);
    expect(reviewRepo.findApprovalsBySpecId(SPEC_ID)).toHaveLength(0);
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
    "approval-requests",
    "Approval Requests",
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
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, 2, 'draft', 'requirements', ?, NULL, NULL, NULL, ?)`,
  ).run(DRAFT_REVISION_ID, SPEC_ID, APPROVED_REVISION_ID, NOW);
  insertElement(db, REQUIREMENT_ELEMENT_ID, "requirement", 1, null);
  insertVersion(db, APPROVED_REVISION_ID, REQUIREMENT_ELEMENT_ID, 0, {
    kind: "requirement",
    statement: "The surface refuses a request it cannot satisfy.",
    priority: "must",
    risk: "high",
  });
  insertVersion(db, DRAFT_REVISION_ID, REQUIREMENT_ELEMENT_ID, 0, {
    kind: "requirement",
    statement: "The surface refuses a request it cannot satisfy, restated.",
    priority: "must",
    risk: "high",
  });
  insertElement(db, DECISION_ELEMENT_ID, "decision", 1, null);
  insertVersion(db, DRAFT_REVISION_ID, DECISION_ELEMENT_ID, 1, {
    kind: "decision",
    title: "Validate before notifying",
    chosenApproach: "Derive the requestable set from the status projection.",
    rejectedAlternatives: [],
    reason: "A duplicate Needs You entry teaches agents to distrust the queue.",
    tracedRequirementElementIds: [],
  });
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
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    NOW,
    NOW,
  );
}

/**
 * The seeded run ends and a fresh one starts against the same approved
 * revision — the shape that made a per-run gate look already-requested.
 */
function startSecondRun(db: Db): void {
  db.prepare("UPDATE spec_executions SET state = 'delivered' WHERE id = ?").run(
    EXECUTION_ID,
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
       NULL, NULL, ?, ?)`,
  ).run(
    SECOND_EXECUTION_ID,
    SPEC_ID,
    APPROVED_REVISION_ID,
    '{"selectedTaskIds":[],"selectedCriterionIds":[],"exclusionDispositions":[]}',
    "2026-07-25T10:00:00.000Z",
    "2026-07-25T10:00:00.000Z",
  );
}

function insertElement(
  db: Db,
  id: string,
  kind: string,
  number: number,
  parentElementId: string | null,
): void {
  db.prepare(
    `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, SPEC_ID, kind, number, parentElementId, NOW);
}

function insertVersion(
  db: Db,
  revisionId: string,
  elementId: string,
  position: number,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    revisionId,
    elementId,
    position,
    JSON.stringify(payload),
    `hash-${revisionId}-${elementId}`,
    NOW,
    NOW,
  );
}
