import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";

import { canonicalDeliveryPlanEnvelopeBytes } from "@/lib/specs/delivery-plan";
import {
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  PINNED_REVISION_ID,
  seedDeliveryPlanParents,
  SPEC_ID,
} from "./spec-delivery-plan-test-fixture";
import type { SpecDeliveryPlanRepo } from "./spec-delivery-plan-repo";
import { _createTestDb } from "./state-db";

type Db = InstanceType<typeof Database>;

let db: Db;
let plans: SpecDeliveryPlanRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
  plans = createDeliveryPlanTestRepos(db).plans;
});

afterEach(() => db.close());

function openPendingAttempt() {
  const document = maximalPlanDocument();
  document.binding.dispositions = [
    {
      criterionElementId: "criterion-one",
      disposition: "pending_reaffirmation",
      deliveredByExecutionId: "execution-one",
    },
    {
      criterionElementId: "criterion-two",
      disposition: "pending_reaffirmation",
      deliveredByExecutionId: "execution-two",
    },
    {
      criterionElementId: "criterion-three",
      disposition: "in_scope",
      deliveredByExecutionId: null,
    },
  ];
  return plans.open({
    attempt: {
      id: "attempt-reaffirm-batch",
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(document),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      workflow_definition_id: "definition-reaffirm-batch",
      created_at: "2026-08-31T10:00:00.000Z",
      updated_at: "2026-08-31T10:00:00.000Z",
    },
    occurredAt: "2026-08-31T10:00:00.000Z",
    actor: { kind: "human" },
  });
}

describe("delivery-plan batch reaffirmation", () => {
  it("reaffirms every target atomically with one revision increment and one event", () => {
    const opened = openPendingAttempt();

    const updated = plans.reaffirmDraftBatch({
      attemptId: opened.id,
      expectedDraftRevision: 1,
      criterionElementIds: ["criterion-one", "criterion-two"],
      reaffirmedAt: "2026-08-31T10:01:00.000Z",
      actor: { kind: "human" },
    });

    expect(updated.draft_revision).toBe(2);
    expect(JSON.parse(updated.content_json).binding.dispositions).toEqual([
      expect.objectContaining({
        criterionElementId: "criterion-one",
        disposition: "reaffirmed",
      }),
      expect.objectContaining({
        criterionElementId: "criterion-two",
        disposition: "reaffirmed",
      }),
      expect.objectContaining({
        criterionElementId: "criterion-three",
        disposition: "in_scope",
      }),
    ]);
    const events = db
      .prepare(
        "SELECT event_type, payload_json FROM spec_events WHERE spec_id = ? ORDER BY id",
      )
      .all(SPEC_ID) as Array<{ event_type: string; payload_json: string }>;
    expect(
      events.filter((event) => event.event_type.includes("reaffirm")),
    ).toEqual([
      {
        event_type: "spec-delivery-plan-reaffirmed",
        payload_json: JSON.stringify({
          attemptId: "attempt-reaffirm-batch",
          criterionElementIds: ["criterion-one", "criterion-two"],
          draftRevision: 2,
        }),
      },
    ]);
  });

  it("leaves the draft unchanged when any target is not pending", () => {
    const opened = openPendingAttempt();

    expect(() =>
      plans.reaffirmDraftBatch({
        attemptId: opened.id,
        expectedDraftRevision: 1,
        criterionElementIds: ["criterion-one", "criterion-three"],
        reaffirmedAt: "2026-08-31T10:01:00.000Z",
        actor: { kind: "human" },
      }),
    ).toThrow(/criterion-three/);

    expect(plans.findAttemptById(opened.id)).toEqual(opened);
  });
});
