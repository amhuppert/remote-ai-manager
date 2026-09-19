import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { migrations } from "./index";
import type { StateMigration } from "./types";

type Db = InstanceType<typeof Database>;

const MIGRATION_NAME = "0024-collab-lane-flow-agent-ids";
const SEP = String.fromCharCode(0);

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

async function runMigration(db: Db) {
  const migration = registered();
  await migration.up({
    name: migration.name,
    context: { db, configDir: null },
  });
}

function laneRow(workflowId: string, laneId: string, backend: string) {
  return {
    workflowId,
    laneId,
    backend,
    ref: `${backend}-ref-${workflowId}`,
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    metrics: {},
    lastUsedAt: "2026-08-01T00:00:00.000Z",
  };
}

function insertSession(
  db: Db,
  sessionName: string,
  lanes: Record<string, unknown>,
  envelopes: Record<string, unknown>,
) {
  db.prepare(
    "INSERT OR IGNORE INTO projects (root_path) VALUES ('/projects/example')",
  ).run();
  db.prepare(
    `INSERT INTO sessions (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at, workflow_lanes, workflow_envelopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "/projects/example",
    sessionName,
    `/worktrees/${sessionName}`,
    `csm/${sessionName}`,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    JSON.stringify(lanes),
    JSON.stringify(envelopes),
  );
}

function readLanes(db: Db, sessionName: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT workflow_lanes FROM sessions WHERE session_name = ?")
    .get(sessionName) as { workflow_lanes: string };
  return JSON.parse(row.workflow_lanes) as Record<string, unknown>;
}

describe("0024-collab-lane-flow-agent-ids", () => {
  it("re-keys user-origin collab lanes via primaryAgentBackend, preserving each lane's continuity ref", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;
    insertSession(
      opened.db,
      "sess-user",
      {
        [`wf-1${SEP}claude`]: laneRow("wf-1", "claude", "claude"),
        [`wf-1${SEP}codex`]: laneRow("wf-1", "codex", "codex"),
      },
      {
        "wf-1": {
          workflowId: "wf-1",
          workflowType: "collaboration",
          featureSnapshot: { mode: "asymmetric", primaryAgentBackend: "codex" },
        },
      },
    );

    await runMigration(opened.db);

    const lanes = readLanes(opened.db, "sess-user");
    expect(Object.keys(lanes).sort()).toEqual([
      `wf-1${SEP}agent_one`,
      `wf-1${SEP}agent_two`,
    ]);
    // Primary was codex, so the codex lane became agent_one and kept its ref.
    expect(lanes[`wf-1${SEP}agent_one`]).toMatchObject({
      laneId: "agent_one",
      backend: "codex",
      ref: "codex-ref-wf-1",
    });
    expect(lanes[`wf-1${SEP}agent_two`]).toMatchObject({
      laneId: "agent_two",
      backend: "claude",
      ref: "claude-ref-wf-1",
    });
  });

  it("re-keys workflow-origin collab lanes via resolvedConfig.secondAgent (agent_one = opposite)", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;
    insertSession(
      opened.db,
      "sess-wf",
      {
        [`wf-2${SEP}claude`]: laneRow("wf-2", "claude", "claude"),
        [`wf-2${SEP}codex`]: laneRow("wf-2", "codex", "codex"),
      },
      {
        "wf-2": {
          workflowId: "wf-2",
          workflowType: "collaboration",
          featureSnapshot: {
            origin: "workflow",
            resolvedConfig: {
              secondAgent: { value: { backend: "codex" }, source: "workflow" },
            },
          },
        },
      },
    );

    await runMigration(opened.db);

    const lanes = readLanes(opened.db, "sess-wf");
    expect(lanes[`wf-2${SEP}agent_one`]).toMatchObject({ backend: "claude" });
    expect(lanes[`wf-2${SEP}agent_two`]).toMatchObject({ backend: "codex" });
  });

  it("drops backend-named lanes with no owning collaboration envelope and leaves graph lanes untouched", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;
    const graphLaneKey = `wf-graph${SEP}context_validator:abc`;
    insertSession(
      opened.db,
      "sess-mixed",
      {
        [`wf-orphan${SEP}claude`]: laneRow("wf-orphan", "claude", "claude"),
        [graphLaneKey]: laneRow("wf-graph", "context_validator:abc", "codex"),
      },
      {},
    );

    await runMigration(opened.db);

    const lanes = readLanes(opened.db, "sess-mixed");
    expect(Object.keys(lanes)).toEqual([graphLaneKey]);
    expect(lanes[graphLaneKey]).toMatchObject({
      laneId: "context_validator:abc",
    });
  });

  it("replays idempotently, including over a partially migrated row", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;
    insertSession(
      opened.db,
      "sess-replay",
      {
        // Partial state: agent_one already written, legacy claude key remains.
        [`wf-3${SEP}agent_one`]: laneRow("wf-3", "agent_one", "claude"),
        [`wf-3${SEP}claude`]: laneRow("wf-3", "claude", "claude"),
        [`wf-3${SEP}codex`]: laneRow("wf-3", "codex", "codex"),
      },
      {
        "wf-3": {
          workflowId: "wf-3",
          featureSnapshot: { primaryAgentBackend: "claude" },
        },
      },
    );

    await runMigration(opened.db);
    const first = readLanes(opened.db, "sess-replay");
    await runMigration(opened.db);
    const second = readLanes(opened.db, "sess-replay");

    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      `wf-3${SEP}agent_one`,
      `wf-3${SEP}agent_two`,
    ]);
    // The pre-existing agent_one target won; the legacy duplicate was dropped.
    expect(first[`wf-3${SEP}agent_one`]).toMatchObject({
      laneId: "agent_one",
      backend: "claude",
    });
  });
});
