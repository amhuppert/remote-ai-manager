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

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import {
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecEventsPublisher } from "./events";
import {
  recordPolicyGateAdmissionInTransaction,
  type PolicyAdmissionDeps,
} from "./policy-admissions";
import type { Spec, SpecExecutionRow } from "./schemas";

type Db = InstanceType<typeof Database>;

const NOW = "2026-09-04T20:56:39.000Z";

let db: Db;

const spec: Spec = {
  id: SPEC_ID,
  projectPath: PROJECT_PATH,
  slug: "delivery-plan",
  name: "Delivery plan",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function openRequest(input: {
  attentionId: string;
  gate: "execution_start" | "delivery";
  executionId: string | null;
}): void {
  createSpecEventsRepo(db).append({
    spec_id: SPEC_ID,
    occurred_at: NOW,
    event_type: "spec-attention-changed",
    actor_json: JSON.stringify({ kind: "agent", conversationId: "c-1" }),
    payload_json: JSON.stringify({
      kind: "approval-requested",
      attentionId: input.attentionId,
      revisionId: PINNED_REVISION_ID,
      gate: input.gate,
      scope: "gate",
      subject: input.gate,
      executionId: input.executionId,
      active: true,
    }),
  });
}

function deps(): PolicyAdmissionDeps {
  const eventsRepo = createSpecEventsRepo(db);
  let sequence = 0;
  return {
    reviewRepo: createSpecReviewRepo(db),
    attention: eventsRepo,
    events: createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newAdmissionId: () => `admission-${++sequence}`,
    now: () => NOW,
  };
}

function launchedExecution(): SpecExecutionRow {
  const row = createSpecDeliveryRepo(db).findExecutionById(
    LAUNCHED_EXECUTION_ID,
  );
  if (row === null) throw new Error("launched execution not seeded");
  return row;
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
});

afterEach(() => {
  db.close();
});

describe("recordPolicyGateAdmissionInTransaction", () => {
  it("answers the run's open asks at the admitted gate, including one filed before run identity, and no other", () => {
    openRequest({
      attentionId: "ask-start-this-run",
      gate: "execution_start",
      executionId: LAUNCHED_EXECUTION_ID,
    });
    openRequest({
      attentionId: "ask-start-legacy",
      gate: "execution_start",
      executionId: null,
    });
    openRequest({
      attentionId: "ask-delivery-this-run",
      gate: "delivery",
      executionId: LAUNCHED_EXECUTION_ID,
    });
    const admissionDeps = deps();

    const recorded = db
      .transaction(() =>
        recordPolicyGateAdmissionInTransaction(admissionDeps, {
          spec,
          gate: "execution_start",
          execution: launchedExecution(),
          frozenDial: "notify",
        }),
      )
      .immediate();

    expect(recorded).toMatchObject({
      basis: "notify_policy",
      requestsClosed: {
        specId: SPEC_ID,
        attentionIds: ["ask-start-this-run", "ask-start-legacy"],
        reason: "the execution start gate admitted the run under Notify",
        occurredAt: NOW,
      },
    });
    // The admission event leads; every retirement rides the same transaction.
    expect(recorded?.prepared.map((event) => event.sseEvent.kind)).toEqual([
      "execution-start-policy-admitted",
      "approval-request-retired",
      "approval-request-retired",
    ]);
    expect(
      createSpecEventsRepo(db)
        .listOpenApprovalRequests(SPEC_ID)
        .map((request) => request.attentionId),
    ).toEqual(["ask-delivery-this-run"]);
  });

  it("reports nothing to close when the run had no open ask at the gate", () => {
    const recorded = db
      .transaction(() =>
        recordPolicyGateAdmissionInTransaction(deps(), {
          spec,
          gate: "delivery",
          execution: launchedExecution(),
          frozenDial: "off",
        }),
      )
      .immediate();

    expect(recorded).toMatchObject({
      basis: "off_policy",
      notice: null,
      requestsClosed: null,
    });
    expect(recorded?.prepared).toHaveLength(1);
  });
});
