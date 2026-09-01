import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  PINNED_REVISION_ID,
  SPEC_ID,
  maximalPlanDocument,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { migrations } from "./index";
import type { StateMigration } from "./types";

const MIGRATION_NAME = "0026-delivery-plan-launch-cutover";

let fixture: PersistenceFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function registered(): StateMigration {
  const migration = migrations.find((entry) => entry.name === MIGRATION_NAME);
  if (migration === undefined) {
    throw new Error(`the migration registry carries no ${MIGRATION_NAME}`);
  }
  return migration;
}

describe("0026-delivery-plan-launch-cutover", () => {
  it("makes pre-cutover documents explicit drafts and clears their proposal", async () => {
    fixture = createPersistenceFixture();
    seedDeliveryPlanParents(fixture.db);
    // 0026 ran against the pre-candidate snapshot shape. The current floor no
    // longer creates `plan_hash`, so the legacy table this migration rewrote
    // is rebuilt here rather than borrowed from today's schema.
    fixture.db.exec(`
      DROP TABLE IF EXISTS spec_delivery_plan_snapshots;
      CREATE TABLE spec_delivery_plan_snapshots (
        id                  TEXT PRIMARY KEY,
        attempt_id          TEXT NOT NULL,
        draft_revision      INTEGER NOT NULL CHECK (draft_revision > 0),
        plan_hash           TEXT NOT NULL,
        content_json        TEXT NOT NULL,
        pinned_revision_id  TEXT NOT NULL,
        proposed_at         TEXT NOT NULL,
        proposed_by_json    TEXT NOT NULL,
        UNIQUE (attempt_id, draft_revision),
        FOREIGN KEY (attempt_id) REFERENCES spec_delivery_plan_attempts(id)
          ON DELETE CASCADE
      );
    `);
    const legacyDocument = { binding: maximalPlanDocument().binding };
    const contentJson = JSON.stringify(legacyDocument);
    fixture.db
      .prepare(
        `INSERT INTO spec_delivery_plan_attempts (
           id, spec_id, pinned_revision_id, status, draft_revision,
           content_json, proposed_snapshot_id, approval_json, prelaunch_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'approved', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "attempt-legacy-launch",
        SPEC_ID,
        PINNED_REVISION_ID,
        contentJson,
        "snapshot-legacy-launch",
        '{"candidateId":"candidate-legacy"}',
        '{"candidate":{"candidateId":"candidate-legacy"}}',
        "2026-08-14T12:00:00.000Z",
        "2026-08-14T12:00:00.000Z",
      );
    fixture.db
      .prepare(
        `INSERT INTO spec_delivery_plan_snapshots (
           id, attempt_id, draft_revision, plan_hash, content_json,
           pinned_revision_id, proposed_at, proposed_by_json
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        "snapshot-legacy-launch",
        "attempt-legacy-launch",
        `sha256:${"a".repeat(64)}`,
        contentJson,
        PINNED_REVISION_ID,
        "2026-08-14T12:00:00.000Z",
        '{"kind":"system"}',
      );

    const migration = registered();
    await migration.up({
      name: migration.name,
      context: { db: fixture.db, configDir: null },
    });

    const attempt = fixture.db
      .prepare(
        `SELECT status, content_json, proposed_snapshot_id, approval_json,
                prelaunch_json
           FROM spec_delivery_plan_attempts
          WHERE id = ?`,
      )
      .get("attempt-legacy-launch") as {
      status: string;
      content_json: string;
      proposed_snapshot_id: string | null;
      approval_json: string | null;
      prelaunch_json: string | null;
    };
    expect(attempt.status).toBe("draft");
    expect(JSON.parse(attempt.content_json)).toHaveProperty("launch", null);
    expect(attempt.proposed_snapshot_id).toBeNull();
    expect(attempt.approval_json).toBeNull();
    expect(attempt.prelaunch_json).toBeNull();
    const snapshot = fixture.db
      .prepare(
        "SELECT content_json FROM spec_delivery_plan_snapshots WHERE id = ?",
      )
      .get("snapshot-legacy-launch") as { content_json: string };
    expect(JSON.parse(snapshot.content_json)).toHaveProperty("launch", null);
  });
});
