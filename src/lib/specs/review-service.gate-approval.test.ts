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
import { createReviewService, type ReviewService } from "./review-service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/gate-approval";
const SPEC_ID = "spec-gate-approval";
const APPROVED_REVISION_ID = "revision-approved";
const DRAFT_REVISION_ID = "revision-draft";
const EXECUTION_ID = "spec-execution-1";
const OTHER_SPEC_EXECUTION_ID = "spec-execution-other";
const NOW = "2026-07-18T16:00:00.000Z";

describe("ReviewService.grantGateApproval (delivery gate)", () => {
  let db: Db;
  let service: ReviewService;
  let reviewRepo: ReturnType<typeof createSpecReviewRepo>;
  let eventsRepo: ReturnType<typeof createSpecEventsRepo>;
  let published: SSEEvent[];

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    seed(db);
    published = [];
    let idSequence = 0;
    const writeQueue = createWriteQueue();
    reviewRepo = createSpecReviewRepo(db);
    eventsRepo = createSpecEventsRepo(db);
    service = createReviewService({
      specs: createSpecsRepo(db, writeQueue),
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
      newId: (prefix) => `${prefix}-${++idSequence}`,
      now: () => NOW,
    });
  });

  it("refuses an agent grant as a human act", async () => {
    const result = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(
      reviewRepo.hasValidHumanGateApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        executionId: EXECUTION_ID,
        gate: "delivery",
      }),
    ).toBe(false);
  });

  it("records the human delivery approval so the delivery gate admits the execution", async () => {
    const result = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(result.ok).toBe(true);
    expect(
      reviewRepo.hasValidHumanGateApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        executionId: EXECUTION_ID,
        gate: "delivery",
      }),
    ).toBe(true);
    const admissions = reviewRepo
      .findGateAdmissionsByRevision(APPROVED_REVISION_ID)
      .filter((admission) => admission.gate === "delivery");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      basis: "human_approval",
      execution_id: EXECUTION_ID,
    });
    expect(
      published.filter((event) => event.type === "spec-approval-changed"),
    ).toHaveLength(1);
    const durable = eventsRepo
      .findBySpecId(SPEC_ID)
      .filter((event) =>
        event.payload_json.includes('"kind":"delivery-approval-granted"'),
      );
    expect(durable).toHaveLength(1);
    expect(JSON.parse(durable[0]?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });
  });

  it("is idempotent for a repeated grant on the same execution and still reports the grant notice", async () => {
    const approvalGranted = vi.fn();
    let idemSequence = 0;
    const notifyingService = createReviewService({
      specs: createSpecsRepo(db, createWriteQueue()),
      review: reviewRepo,
      delivery: createSpecDeliveryRepo(db),
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      notifier: { approvalRequested: vi.fn(), approvalGranted },
      newId: (prefix) => `${prefix}-idem-${++idemSequence}`,
      now: () => NOW,
    });
    const first = await notifyingService.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });
    const second = await notifyingService.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(
      reviewRepo
        .findGateAdmissionsByRevision(APPROVED_REVISION_ID)
        .filter((admission) => admission.gate === "delivery"),
    ).toHaveLength(1);
    // The replayed grant re-reports the notice so a request re-opened after
    // the original grant still clears from Needs You (the notifier dedupes
    // per request, so nothing duplicates).
    expect(approvalGranted).toHaveBeenCalledTimes(2);
    expect(approvalGranted.mock.calls[1]?.[0]).toMatchObject({
      satisfiedGates: ["delivery"],
    });
  });

  it("records a human execution-start approval with its own admission and durable marker", async () => {
    const result = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "execution_start",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(result.ok).toBe(true);
    expect(
      reviewRepo.hasValidHumanGateApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        executionId: EXECUTION_ID,
        gate: "execution_start",
      }),
    ).toBe(true);
    const admissions =
      reviewRepo.findGateAdmissionsByRevision(APPROVED_REVISION_ID);
    expect(
      admissions.filter((admission) => admission.gate === "execution_start"),
    ).toHaveLength(1);
    expect(
      admissions.filter((admission) => admission.gate === "delivery"),
    ).toHaveLength(0);
    expect(
      admissions.find((admission) => admission.gate === "execution_start"),
    ).toMatchObject({
      basis: "human_approval",
      execution_id: EXECUTION_ID,
    });
    const durable = eventsRepo
      .findBySpecId(SPEC_ID)
      .filter((event) =>
        event.payload_json.includes(
          '"kind":"execution-start-approval-granted"',
        ),
      );
    expect(durable).toHaveLength(1);
    expect(JSON.parse(durable[0]?.actor_json ?? "{}")).toEqual({
      kind: "human",
    });
  });

  it("refuses an agent execution-start grant as a human act", async () => {
    const result = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "execution_start",
      approver: "operator",
      actor: { kind: "agent", conversationId: "conversation-1" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(
      reviewRepo.hasValidHumanGateApproval({
        specId: SPEC_ID,
        revisionId: APPROVED_REVISION_ID,
        executionId: EXECUTION_ID,
        gate: "execution_start",
      }),
    ).toBe(false);
  });

  it("refuses when the revision is not approved", async () => {
    const result = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: DRAFT_REVISION_ID,
      executionId: EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
  });

  it("refuses when the execution does not belong to the pinned revision", async () => {
    const missing = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: "spec-execution-unknown",
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });
    const mismatched = await service.grantGateApproval({
      specId: SPEC_ID,
      revisionId: APPROVED_REVISION_ID,
      executionId: OTHER_SPEC_EXECUTION_ID,
      gate: "delivery",
      approver: "operator",
      actor: { kind: "human" },
    });

    expect(missing).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    expect(mismatched).toMatchObject({
      ok: false,
      refusal: { code: "validation" },
    });
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
    "gate-approval",
    "Gate Approval",
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
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 2, 'draft', NULL, NULL, NULL, NULL, ?)`,
  ).run(DRAFT_REVISION_ID, SPEC_ID, NOW);
  insertExecution(db, EXECUTION_ID, APPROVED_REVISION_ID);
  insertExecution(db, OTHER_SPEC_EXECUTION_ID, DRAFT_REVISION_ID);
}

function insertExecution(db: Db, id: string, revisionId: string): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', 'workflow-definition-1', NULL, NULL,
       NULL, NULL, ?, ?)`,
  ).run(
    id,
    SPEC_ID,
    revisionId,
    '{"selectedTaskIds":[],"selectedCriterionIds":["criterion-1"],"exclusionDispositions":[]}',
    NOW,
    NOW,
  );
}
