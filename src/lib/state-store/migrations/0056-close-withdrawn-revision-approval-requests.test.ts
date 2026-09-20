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
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { createSpecEventsRepo } from "../spec-events-repo";
import { migrations } from "./index";
import type { StateMigration } from "./types";

const MIGRATION_NAME = "0056-close-withdrawn-revision-approval-requests";
const WITHDRAWN_REVISION_ID = "revision-withdrawn-design";
const AT = "2026-09-20T15:42:00.000Z";

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

function seedWithdrawnDesignRevision(db: PersistenceFixture["db"]): void {
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, content_hash, created_at
     ) VALUES (?, ?, 3, 'withdrawn', 'design', ?, ?)`,
  ).run(WITHDRAWN_REVISION_ID, SPEC_ID, "sha256:withdrawn-design", AT);
}

function openRequest(
  db: PersistenceFixture["db"],
  input: {
    attentionId: string;
    gate: "design" | "requirements" | "delivery";
    revisionId: string;
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
      revisionId: input.revisionId,
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

function seedRepairScenario(db: PersistenceFixture["db"]): void {
  seedDeliveryPlanParents(db);
  seedWithdrawnDesignRevision(db);
  openRequest(db, {
    attentionId: "ask-withdrawn-design",
    gate: "design",
    revisionId: WITHDRAWN_REVISION_ID,
    executionId: null,
  });
  openRequest(db, {
    attentionId: "ask-approved-requirements",
    gate: "requirements",
    revisionId: PINNED_REVISION_ID,
    executionId: null,
  });
  openRequest(db, {
    attentionId: "ask-withdrawn-delivery",
    gate: "delivery",
    revisionId: WITHDRAWN_REVISION_ID,
    executionId: LAUNCHED_EXECUTION_ID,
  });
  openRequest(db, {
    attentionId: "ask-withdrawn-design-granted",
    gate: "design",
    revisionId: WITHDRAWN_REVISION_ID,
    executionId: null,
  });
  createNotificationsRepo(db).createSpecNotification({
    type: "spec-approval-granted",
    title: "Design approval granted",
    message: "Delivery plan: design",
    projectName: "delivery-plan",
    sessionName: null,
    specId: SPEC_ID,
    specSlug: "delivery-plan",
    specName: "Delivery plan",
    gate: "design",
    gateRequestId: "ask-withdrawn-design-granted",
    deepLinkId: "design",
    dedupeKey: "spec-approval-granted:ask-withdrawn-design-granted",
  });
}

describe(MIGRATION_NAME, () => {
  it("retires withdrawn-revision authoring requests and closes only their unanswered queue entries", async () => {
    fixture = createPersistenceFixture();
    const { db } = fixture;
    seedRepairScenario(db);

    await registered().up({
      name: MIGRATION_NAME,
      context: { db, configDir: null },
    });

    expect(
      createSpecEventsRepo(db)
        .listOpenApprovalRequests(SPEC_ID)
        .map((request) => request.attentionId),
    ).toEqual(["ask-approved-requirements", "ask-withdrawn-delivery"]);
    const rows =
      createNotificationsRepo(db).findSpecNotificationsBySpecId(SPEC_ID);
    const resolvedRows = db
      .prepare(
        `SELECT type, spec_gate, spec_gate_request_id, title, message, dedupe_key
           FROM notifications
          WHERE source = 'spec'
            AND type = 'spec-attention-resolved'
          ORDER BY id ASC`,
      )
      .all() as Array<{
      type: string;
      spec_gate: string;
      spec_gate_request_id: string;
      title: string;
      message: string;
      dedupe_key: string;
    }>;
    expect(resolvedRows).toEqual([
      {
        type: "spec-attention-resolved",
        spec_gate: "design",
        spec_gate_request_id: "ask-withdrawn-design",
        title: "Design request closed",
        message: "Delivery plan: the revision it asked about was withdrawn",
        dedupe_key: "spec-attention-resolved:ask-withdrawn-design",
      },
    ]);
    expect(
      deriveNotificationOutcomes(rows, [])
        .needsAction.map((item) => item.phase)
        .sort(),
    ).toEqual(["Delivery approval required", "Requirements approval required"]);
  });

  it("is idempotent across two migration replays", async () => {
    fixture = createPersistenceFixture();
    const { db } = fixture;
    seedDeliveryPlanParents(db);
    seedWithdrawnDesignRevision(db);
    openRequest(db, {
      attentionId: "ask-withdrawn-design",
      gate: "design",
      revisionId: WITHDRAWN_REVISION_ID,
      executionId: null,
    });
    const context = { db, configDir: null };

    await registered().up({ name: MIGRATION_NAME, context });
    await registered().up({ name: MIGRATION_NAME, context });

    const retirements = db
      .prepare(
        `SELECT COUNT(*) AS count FROM spec_events
          WHERE json_extract(payload_json, '$.kind') = 'approval-request-retired'
            AND json_extract(payload_json, '$.attentionId') = ?`,
      )
      .get("ask-withdrawn-design") as { count: number };
    expect(retirements.count).toBe(1);
    expect(
      createNotificationsRepo(db)
        .findSpecNotificationsBySpecId(SPEC_ID)
        .filter((row) => row.type === "spec-attention-resolved"),
    ).toHaveLength(1);
  });
});
