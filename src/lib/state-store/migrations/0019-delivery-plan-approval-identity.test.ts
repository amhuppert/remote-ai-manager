import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import Database from "better-sqlite3";
import { deliveryPlanApprovalSchema } from "@/lib/specs/delivery-plan";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  PINNED_REVISION_ID,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "../spec-delivery-plan-test-fixture";
import { deliveryPlanApprovalIdentity } from "./0019-delivery-plan-approval-identity";

type Db = InstanceType<typeof Database>;

let rawDb: Db | null = null;
let fixture: PersistenceFixture | null = null;

afterEach(() => {
  rawDb?.close();
  rawDb = null;
  fixture?.close();
  fixture = null;
});

async function runMigration(db: Db): Promise<void> {
  await deliveryPlanApprovalIdentity.up({
    name: deliveryPlanApprovalIdentity.name,
    context: { db, configDir: null },
  });
}

const LEGACY_APPROVAL = JSON.stringify({
  snapshotId: "snapshot-1",
  planHash: `sha256:${"a".repeat(64)}`,
  approvedAt: "2026-08-07T11:00:00.000Z",
  approvedBy: { kind: "human" },
});

const CURRENT_APPROVAL = JSON.stringify({
  snapshotId: "snapshot-2",
  candidateId: "candidate-2",
  planHash: `sha256:${"b".repeat(64)}`,
  compiledDefinitionHash: `sha256:${"c".repeat(64)}`,
  approvedAt: "2026-08-07T12:00:00.000Z",
  approvedBy: { kind: "human" },
});

function seedAttempts(db: Db): void {
  db.exec(`
    CREATE TABLE spec_delivery_plan_attempts (
      id                        TEXT PRIMARY KEY,
      spec_id                   TEXT NOT NULL,
      pinned_revision_id        TEXT NOT NULL,
      delta_basis_execution_id  TEXT,
      status                    TEXT NOT NULL,
      draft_revision            INTEGER NOT NULL,
      content_json              TEXT NOT NULL,
      proposed_snapshot_id      TEXT,
      approval_json             TEXT,
      prelaunch_json            TEXT,
      launched_execution_id     TEXT,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );
    CREATE TABLE spec_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id      TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      actor_json   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, 'revision-1', NULL, ?, 1, '{}', 'snapshot-1', ?, NULL, ?,
       '2026-08-07T09:00:00.000Z', '2026-08-07T09:00:00.000Z')`,
  );
  insert.run("attempt-approved", "spec-1", "approved", LEGACY_APPROVAL, null);
  insert.run("attempt-parked", "spec-1", "parked", LEGACY_APPROVAL, null);
  insert.run(
    "attempt-launched",
    "spec-2",
    "launched",
    LEGACY_APPROVAL,
    "execution-1",
  );
  insert.run("attempt-current", "spec-3", "approved", CURRENT_APPROVAL, null);
  insert.run("attempt-draft", "spec-3", "draft", null, null);
}

function attempt(
  db: Db,
  id: string,
): { status: string; approval_json: string | null } {
  return db
    .prepare(
      "SELECT status, approval_json FROM spec_delivery_plan_attempts WHERE id = ?",
    )
    .get(id) as { status: string; approval_json: string | null };
}

describe("0019-delivery-plan-approval-identity", () => {
  it("returns an approved legacy attempt to proposed, so its refusal names the sign-off", async () => {
    rawDb = new Database(":memory:");
    seedAttempts(rawDb);
    // Red without the migration: the read path parses strictly and a legacy
    // approval throws rather than naming the act that repairs it.
    expect(() =>
      deliveryPlanApprovalSchema.parse(JSON.parse(LEGACY_APPROVAL)),
    ).toThrow();

    await runMigration(rawDb);

    expect(attempt(rawDb, "attempt-approved")).toEqual({
      status: "proposed",
      approval_json: null,
    });
    expect(attempt(rawDb, "attempt-parked")).toEqual({
      status: "proposed",
      approval_json: null,
    });
  });

  it("keeps a launched attempt launched while clearing the approval it can no longer name", async () => {
    rawDb = new Database(":memory:");
    seedAttempts(rawDb);

    await runMigration(rawDb);

    // The run already happened; the approval is history, not permission.
    expect(attempt(rawDb, "attempt-launched")).toEqual({
      status: "launched",
      approval_json: null,
    });
  });

  it("leaves an approval that already carries the candidate identity untouched", async () => {
    rawDb = new Database(":memory:");
    seedAttempts(rawDb);

    await runMigration(rawDb);

    const row = attempt(rawDb, "attempt-current");
    expect(row.status).toBe("approved");
    expect(() =>
      deliveryPlanApprovalSchema.parse(JSON.parse(row.approval_json ?? "null")),
    ).not.toThrow();
    expect(attempt(rawDb, "attempt-draft")).toEqual({
      status: "draft",
      approval_json: null,
    });
  });

  it("audits every invalidation and converges on replay", async () => {
    rawDb = new Database(":memory:");
    seedAttempts(rawDb);

    await runMigration(rawDb);
    await runMigration(rawDb);

    const events = rawDb
      .prepare(
        "SELECT spec_id, payload_json FROM spec_events WHERE event_type = 'spec-approval-changed'",
      )
      .all() as Array<{ spec_id: string; payload_json: string }>;
    // Shape-keyed, so the replay finds nothing left to invalidate and writes
    // no second trace for the same attempt.
    expect(events).toHaveLength(3);
    expect(
      events.map(
        (event) =>
          (JSON.parse(event.payload_json) as { attemptId: string }).attemptId,
      ),
    ).toEqual(
      expect.arrayContaining([
        "attempt-approved",
        "attempt-parked",
        "attempt-launched",
      ]),
    );
    expect(
      JSON.parse(events[0]?.payload_json ?? "{}") as { kind?: string },
    ).toMatchObject({ kind: "delivery-plan-approval-invalidated" });
  });

  it("invalidates and audits against the production schema, foreign keys and all", async () => {
    // The hand-rolled table above cannot catch a column or FK mismatch in the
    // audit insert; this case runs the migration on the real floor DDL.
    fixture = createPersistenceFixture();
    const db = fixture.db;
    seedDeliveryPlanParents(db);
    db.prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
         draft_revision, content_json, proposed_snapshot_id, approval_json,
         prelaunch_json, launched_execution_id, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'approved', 1, '{}', 'snapshot-1', ?, NULL,
         NULL, '2026-08-07T09:00:00.000Z', '2026-08-07T09:00:00.000Z')`,
    ).run("attempt-real", SPEC_ID, PINNED_REVISION_ID, LEGACY_APPROVAL);

    await runMigration(db);

    expect(attempt(db, "attempt-real")).toEqual({
      status: "proposed",
      approval_json: null,
    });
    const trace = db
      .prepare(
        "SELECT spec_id, payload_json FROM spec_events WHERE event_type = 'spec-approval-changed'",
      )
      .get() as { spec_id: string; payload_json: string } | undefined;
    expect(trace?.spec_id).toBe(SPEC_ID);
    expect(JSON.parse(trace?.payload_json ?? "{}")).toMatchObject({
      kind: "delivery-plan-approval-invalidated",
      attemptId: "attempt-real",
      previousStatus: "approved",
    });
  });

  it("leaves a database that predates the attempts table alone", async () => {
    rawDb = new Database(":memory:");

    await runMigration(rawDb);

    expect(
      (
        rawDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'",
          )
          .all() as Array<{ name: string }>
      ).length,
    ).toBe(0);
  });
});
