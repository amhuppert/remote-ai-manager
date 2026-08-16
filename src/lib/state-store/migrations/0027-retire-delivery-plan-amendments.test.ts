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
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { migrations } from "./index";
import type { StateMigration } from "./types";

const MIGRATION_NAME = "0027-retire-delivery-plan-amendments";
const PROJECT_PATH = "/repos/cc";
const SESSION_NAME = "spec-run";

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

describe("0027-retire-delivery-plan-amendments", () => {
  it("purges retired delivery-plan amendment events without touching ordinary graph events", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const insert = fixture.db.prepare(
      `INSERT INTO graph_workflow_events (
         project_path, session_name, execution_id, occurred_at,
         event_type, context_id, pre_reset, event_json
       ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
    );
    insert.run(
      PROJECT_PATH,
      SESSION_NAME,
      "execution-1",
      "2026-08-14T22:00:00.000Z",
      "graph-workflow-execution-amended",
      JSON.stringify({ type: "graph-workflow-execution-amended" }),
    );
    insert.run(
      PROJECT_PATH,
      SESSION_NAME,
      "execution-1",
      "2026-08-14T22:01:00.000Z",
      "graph-workflow-live-edit-applied",
      JSON.stringify({ type: "graph-workflow-live-edit-applied" }),
    );

    await registered().up({
      name: MIGRATION_NAME,
      context: { db: fixture.db, configDir: null },
    });

    const rows = fixture.db
      .prepare("SELECT event_type FROM graph_workflow_events ORDER BY id ASC")
      .all() as Array<{ event_type: string }>;
    expect(rows).toEqual([{ event_type: "graph-workflow-live-edit-applied" }]);
  });
});
