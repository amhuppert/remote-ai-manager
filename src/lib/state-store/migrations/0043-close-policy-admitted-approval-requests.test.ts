import { afterEach, describe, expect, it, vi } from "vitest";

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
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  EARLIER_EXECUTION_ID,
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { createSpecEventsRepo } from "../spec-events-repo";
import { migrations } from "./index";
import type { StateMigration } from "./types";

const MIGRATION_NAME = "0043-close-policy-admitted-approval-requests";
const AT = "2026-09-04T20:39:08.000Z";

let fixture: PersistenceFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function registered(): StateMigration {
  const migration = migrations.find((entry) => entry.name === MIGRATION_NAME);
  if (migration === undefined)
    throw new Error(`missing migration ${MIGRATION_NAME}`);
  return migration;
}

function openRequest(
  db: PersistenceFixture["db"],
  input: {
    attentionId: string;
    gate: "execution_start" | "delivery" | "requirements";
    executionId: string | null;
  },
): void {
  createSpecEventsRepo(db).append({
    spec_id: SPEC_ID,
    occurred_at: AT,
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
  createNotificationsRepo(db).createSpecNotification({
    type: "spec-approval-requested",
    title: `${input.gate} approval requested`,
    message: `Delivery plan: ${input.gate}`,
    projectName: "delivery-plan",
    sessionName: null,
    specId: SPEC_ID,
    specSlug: "delivery-plan",
    specName: "Delivery plan",
    gate: input.gate,
    gateRequestId: input.attentionId,
    deepLinkId: input.gate,
    dedupeKey: `spec-approval-requested:${input.attentionId}`,
  });
}

function admission(
  db: PersistenceFixture["db"],
  input: {
    id: string;
    gate: "execution_start" | "delivery";
    basis: "notify_policy" | "off_policy" | "human_approval";
    executionId: string;
  },
): void {
  db.prepare(
    `INSERT INTO spec_gate_admissions (
       id, spec_id, gate, basis, approval_id, revision_id, execution_id,
       actor_json, created_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    input.id,
    SPEC_ID,
    input.gate,
    input.basis,
    PINNED_REVISION_ID,
    input.executionId,
    JSON.stringify({ kind: "system" }),
    AT,
  );
}

describe(MIGRATION_NAME, () => {
  it("retires the requests a policy admission answered and closes only their queue entries", async () => {
    fixture = createPersistenceFixture();
    const { db } = fixture;
    seedDeliveryPlanParents(db);
    // The #108 shape: a delivery ask filed for a run the Notify dial then
    // admitted. Beside it, the asks nothing answered — another run's delivery
    // ask, an execution-start ask a human grant admitted (the grant path
    // owns that one), and an authoring ask with no run at all.
    openRequest(db, {
      attentionId: "ask-delivery-admitted",
      gate: "delivery",
      executionId: EARLIER_EXECUTION_ID,
    });
    openRequest(db, {
      attentionId: "ask-delivery-other-run",
      gate: "delivery",
      executionId: LAUNCHED_EXECUTION_ID,
    });
    openRequest(db, {
      attentionId: "ask-start-human",
      gate: "execution_start",
      executionId: LAUNCHED_EXECUTION_ID,
    });
    openRequest(db, {
      attentionId: "ask-requirements",
      gate: "requirements",
      executionId: null,
    });
    admission(db, {
      id: "admission-delivery-notify",
      gate: "delivery",
      basis: "notify_policy",
      executionId: EARLIER_EXECUTION_ID,
    });
    admission(db, {
      id: "admission-start-human",
      gate: "execution_start",
      basis: "human_approval",
      executionId: LAUNCHED_EXECUTION_ID,
    });

    await registered().up({
      name: MIGRATION_NAME,
      context: { db, configDir: null },
    });

    expect(
      createSpecEventsRepo(db)
        .listOpenApprovalRequests(SPEC_ID)
        .map((request) => request.attentionId),
    ).toEqual([
      "ask-delivery-other-run",
      "ask-start-human",
      "ask-requirements",
    ]);
    const rows =
      createNotificationsRepo(db).findSpecNotificationsBySpecId(SPEC_ID);
    expect(
      rows.filter((row) => row.type === "spec-attention-resolved"),
    ).toEqual([
      expect.objectContaining({
        gate: "delivery",
        gateRequestId: "ask-delivery-admitted",
        title: "Delivery request closed",
        message:
          "Delivery plan: the delivery gate admitted the run under Notify",
      }),
    ]);
    // What the topbar's Needs You badge derives from the same rows.
    expect(
      deriveNotificationOutcomes(rows, [])
        .needsAction.map((item) => item.phase)
        .sort(),
    ).toEqual([
      "Delivery approval required",
      "Execution start approval required",
      "Requirements approval required",
    ]);
  });

  it("is idempotent across replays", async () => {
    fixture = createPersistenceFixture();
    const { db } = fixture;
    seedDeliveryPlanParents(db);
    openRequest(db, {
      attentionId: "ask-delivery-admitted",
      gate: "delivery",
      executionId: EARLIER_EXECUTION_ID,
    });
    admission(db, {
      id: "admission-delivery-notify",
      gate: "delivery",
      basis: "notify_policy",
      executionId: EARLIER_EXECUTION_ID,
    });
    const context = { db, configDir: null };

    await registered().up({ name: MIGRATION_NAME, context });
    await registered().up({ name: MIGRATION_NAME, context });

    const retirements = db
      .prepare(
        `SELECT COUNT(*) AS count FROM spec_events
          WHERE json_extract(payload_json, '$.kind') = 'approval-request-retired'`,
      )
      .get() as { count: number };
    expect(retirements.count).toBe(1);
    expect(
      createNotificationsRepo(db)
        .findSpecNotificationsBySpecId(SPEC_ID)
        .filter((row) => row.type === "spec-attention-resolved"),
    ).toHaveLength(1);
  });

  it("leaves a request alone once its queue entry was already answered", async () => {
    fixture = createPersistenceFixture();
    const { db } = fixture;
    seedDeliveryPlanParents(db);
    openRequest(db, {
      attentionId: "ask-delivery-granted",
      gate: "delivery",
      executionId: EARLIER_EXECUTION_ID,
    });
    createNotificationsRepo(db).createSpecNotification({
      type: "spec-approval-granted",
      title: "Delivery approval granted",
      message: "Delivery plan: delivery",
      projectName: "delivery-plan",
      sessionName: null,
      specId: SPEC_ID,
      specSlug: "delivery-plan",
      specName: "Delivery plan",
      gate: "delivery",
      gateRequestId: "ask-delivery-granted",
      deepLinkId: "delivery",
      dedupeKey: "spec-approval-granted:ask-delivery-granted",
    });
    admission(db, {
      id: "admission-delivery-notify",
      gate: "delivery",
      basis: "notify_policy",
      executionId: EARLIER_EXECUTION_ID,
    });

    await registered().up({
      name: MIGRATION_NAME,
      context: { db, configDir: null },
    });

    expect(
      createNotificationsRepo(db)
        .findSpecNotificationsBySpecId(SPEC_ID)
        .filter((row) => row.type === "spec-attention-resolved"),
    ).toEqual([]);
  });
});
