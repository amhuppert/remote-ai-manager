import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { z } from "zod";
import { _createTestDb } from "./state-db";
import {
  createConversationMachineSnapshotsRepo,
  type ConversationMachineSnapshotsRepo,
} from "./conversation-machine-snapshots-repo";
import {
  createConversationsRepo,
  type ConversationsRepo,
} from "./conversations-repo";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "./project-conversations-repo";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess-1";

let db: Db;
const openDbs: Db[] = [];

function freshDb(): Db {
  const created = _createTestDb({ inMemory: true });
  openDbs.push(created);
  return created;
}

function seedProject(): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
}

function seedSession(): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function baseConversation(id: string) {
  return conversationStateSchema.parse({
    id,
    scope: "session",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  });
}

/**
 * The sidecar upsert is parent-conditional (inserts only while the owning
 * conversation exists), so the point-operation contracts below must first create
 * the owning parent row. These minimal raw inserts stand in for that parent.
 */
function seedSessionConversationRow(id: string): void {
  db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, status, created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    PROJECT_PATH,
    SESSION_NAME,
    "awaiting",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

function seedProjectConversationRow(id: string): void {
  db.prepare(
    `INSERT INTO project_conversations (
       id, project_path, status, created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    PROJECT_PATH,
    "awaiting",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

beforeEach(() => {
  db = freshDb();
  seedProject();
  seedSession();
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

/**
 * The sidecar stores the resume-token projection as one opaque JSON blob
 * (`snapshot_json`); the repo does not map its interior to columns. The maximal
 * round-trip therefore proves the four sidecar columns (owner, conversation_id,
 * snapshot_json, updated_at) survive, exercising a representative nested snapshot
 * so JSON fidelity through the blob column is covered too.
 */
const sidecarRecordSchema = z.object({
  owner: z.enum(["session", "project"]),
  conversationId: z.string(),
  snapshot: z.object({
    status: z.string(),
    value: z.object({ executing: z.string() }),
    context: z.object({
      _schemaVersion: z.number(),
      conversationId: z.string(),
      backendRef: z.object({ backend: z.string(), ref: z.string() }),
      totals: z.object({
        totalCostUsd: z.number(),
        totalTurns: z.number(),
      }),
      pendingQuestionIds: z.array(z.string()),
    }),
  }),
  updatedAt: z.string(),
});

describe("conversation_machine_snapshots repo", () => {
  it("round-trips every sidecar column through the real SQLite boundary", async () => {
    const repo = createConversationMachineSnapshotsRepo(db);
    seedSessionConversationRow("conv-max");
    await assertRoundTripDurability({
      label: "conversation_machine_snapshots row",
      schema: sidecarRecordSchema,
      buildMaximalFixture: () => ({
        owner: "session" as const,
        conversationId: "conv-max",
        snapshot: {
          status: "active",
          value: { executing: "conversationTurn" },
          context: {
            _schemaVersion: 1,
            conversationId: "conv-max",
            backendRef: { backend: "claude", ref: "sess-abc" },
            totals: { totalCostUsd: 1.25, totalTurns: 3 },
            pendingQuestionIds: ["q1"],
          },
        },
        updatedAt: "2026-01-02T03:04:05.000Z",
      }),
      persist: (fixture) => {
        repo.upsert(
          fixture.owner,
          fixture.conversationId,
          fixture.snapshot,
          fixture.updatedAt,
        );
        return fixture;
      },
      reload: (expected) => {
        const record = repo.get(expected.owner, expected.conversationId);
        if (record === null) return null;
        return {
          owner: record.owner,
          conversationId: record.conversationId,
          snapshot: expected.snapshot,
          updatedAt: record.updatedAt,
        };
      },
    });
  });

  it("reloads the exact snapshot payload it stored", () => {
    const repo = createConversationMachineSnapshotsRepo(db);
    seedProjectConversationRow("conv-p");
    const snapshot = { value: "idle", context: { nested: [1, 2, 3] } };
    repo.upsert("project", "conv-p", snapshot, "2026-01-02T00:00:00Z");

    const record = repo.get("project", "conv-p");
    expect(record).not.toBeNull();
    expect(record?.snapshot).toEqual(snapshot);
    expect(record?.owner).toBe("project");
    expect(record?.updatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("scopes rows by owner: same conversation id under both owners is independent", () => {
    const repo = createConversationMachineSnapshotsRepo(db);
    seedSessionConversationRow("shared-id");
    seedProjectConversationRow("shared-id");
    repo.upsert("session", "shared-id", { v: "session" }, "t1");
    repo.upsert("project", "shared-id", { v: "project" }, "t2");

    expect(repo.get("session", "shared-id")?.snapshot).toEqual({
      v: "session",
    });
    expect(repo.get("project", "shared-id")?.snapshot).toEqual({
      v: "project",
    });
  });

  it("returns null for a missing row", () => {
    const repo = createConversationMachineSnapshotsRepo(db);
    expect(repo.get("session", "nope")).toBeNull();
  });
});

describe("sidecar orphan cleanup on parent delete", () => {
  function sidecarRowCount(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_machine_snapshots`)
      .get() as { n: number };
    return row.n;
  }

  it("deleting a session conversation removes its sidecar row", () => {
    const conversations: ConversationsRepo = createConversationsRepo(db);
    const sidecar: ConversationMachineSnapshotsRepo =
      createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("conv-s"),
    );
    sidecar.upsert("session", "conv-s", { value: "idle" }, "t");
    expect(sidecarRowCount()).toBe(1);

    conversations.delete("conv-s");

    expect(sidecar.get("session", "conv-s")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("deleting a project conversation removes its sidecar row", () => {
    const projectConversations: ProjectConversationsRepo =
      createProjectConversationsRepo(db);
    const sidecar: ConversationMachineSnapshotsRepo =
      createConversationMachineSnapshotsRepo(db);

    projectConversations.upsert(PROJECT_PATH, {
      ...baseConversation("conv-p"),
      scope: "project",
    });
    sidecar.upsert("project", "conv-p", { value: "idle" }, "t");
    expect(sidecarRowCount()).toBe(1);

    projectConversations.delete("conv-p");

    expect(sidecar.get("project", "conv-p")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("a session-conversation delete leaves a same-id project sidecar row intact", () => {
    const conversations = createConversationsRepo(db);
    const projectConversations = createProjectConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("shared"),
    );
    projectConversations.upsert(PROJECT_PATH, {
      ...baseConversation("shared"),
      scope: "project",
    });
    sidecar.upsert("session", "shared", { v: "s" }, "t");
    sidecar.upsert("project", "shared", { v: "p" }, "t");

    conversations.delete("shared");

    expect(sidecar.get("session", "shared")).toBeNull();
    expect(sidecar.get("project", "shared")?.snapshot).toEqual({ v: "p" });
  });
});

/**
 * The sidecar has no foreign key of its own (its `owner` discriminator ties one
 * table to two possible parents, which a single FK cannot express), so cleanup
 * on the FK CASCADE paths — deleting a *session* removes its conversations, and
 * deleting a *project* removes both its sessions' conversations and its project
 * conversations — must be DB-enforced by AFTER DELETE triggers on the parent
 * tables. These contracts exercise the real SQLite cascade, not the repo
 * `.delete` methods, so they prove the trigger fires when the parent row dies by
 * cascade rather than by a direct conversation delete.
 */
describe("sidecar orphan cleanup on parent CASCADE delete", () => {
  function sidecarRowCount(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_machine_snapshots`)
      .get() as { n: number };
    return row.n;
  }

  it("deleting a session cascades to its conversation and removes the sidecar row", () => {
    const conversations = createConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("conv-s"),
    );
    sidecar.upsert("session", "conv-s", { value: "idle" }, "t");
    expect(sidecarRowCount()).toBe(1);

    // Delete the parent SESSION directly — FK CASCADE removes the conversation
    // row without ever calling conversations.delete().
    db.prepare(
      `DELETE FROM sessions WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, SESSION_NAME);

    expect(sidecar.get("session", "conv-s")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("deleting a project cascades to both parents and removes every sidecar row", () => {
    const conversations = createConversationsRepo(db);
    const projectConversations = createProjectConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("conv-s"),
    );
    projectConversations.upsert(PROJECT_PATH, {
      ...baseConversation("conv-p"),
      scope: "project",
    });
    sidecar.upsert("session", "conv-s", { value: "idle" }, "t");
    sidecar.upsert("project", "conv-p", { value: "idle" }, "t");
    expect(sidecarRowCount()).toBe(2);

    // Delete the PROJECT directly — FK CASCADE removes the session (→ its
    // conversation) and the project conversation, firing both triggers.
    db.prepare(`DELETE FROM projects WHERE root_path = ?`).run(PROJECT_PATH);

    expect(sidecar.get("session", "conv-s")).toBeNull();
    expect(sidecar.get("project", "conv-p")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });
});

/**
 * `persistConversationSnapshot` debounces, so a snapshot write can fire AFTER the
 * conversation was deleted (the timer outlives the parent). The upsert is
 * parent-conditional to fence that race: it inserts only while the owning parent
 * row still exists, so a late write cannot resurrect an orphan the delete trigger
 * already cleaned up.
 */
describe("sidecar upsert is parent-conditional (delayed-write fence)", () => {
  function sidecarRowCount(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_machine_snapshots`)
      .get() as { n: number };
    return row.n;
  }

  it("a late session-owner write after the parent is deleted does not recreate the sidecar", () => {
    const conversations = createConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("conv-race"),
    );
    sidecar.upsert("session", "conv-race", { value: "a" }, "t1");
    conversations.delete("conv-race");
    expect(sidecar.get("session", "conv-race")).toBeNull();

    // The debounced write lands after the delete — must NOT resurrect the row.
    sidecar.upsert("session", "conv-race", { value: "b" }, "t2");

    expect(sidecar.get("session", "conv-race")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("a late project-owner write after the parent is deleted does not recreate the sidecar", () => {
    const projectConversations = createProjectConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    projectConversations.upsert(PROJECT_PATH, {
      ...baseConversation("pconv-race"),
      scope: "project",
    });
    sidecar.upsert("project", "pconv-race", { value: "a" }, "t1");
    projectConversations.delete("pconv-race");
    expect(sidecar.get("project", "pconv-race")).toBeNull();

    sidecar.upsert("project", "pconv-race", { value: "b" }, "t2");

    expect(sidecar.get("project", "pconv-race")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("never inserts a snapshot for a conversation id that has no parent row", () => {
    const sidecar = createConversationMachineSnapshotsRepo(db);

    // No conversations / project_conversations row was ever created for this id.
    sidecar.upsert("session", "ghost", { value: "x" }, "t");

    expect(sidecar.get("session", "ghost")).toBeNull();
    expect(sidecarRowCount()).toBe(0);
  });

  it("updates an existing sidecar row while its parent is alive", () => {
    const conversations = createConversationsRepo(db);
    const sidecar = createConversationMachineSnapshotsRepo(db);

    conversations.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      baseConversation("conv-live"),
    );
    sidecar.upsert("session", "conv-live", { value: "first" }, "t1");
    sidecar.upsert("session", "conv-live", { value: "second" }, "t2");

    expect(sidecar.get("session", "conv-live")?.snapshot).toEqual({
      value: "second",
    });
    expect(sidecar.get("session", "conv-live")?.updatedAt).toBe("t2");
  });
});

/**
 * The resume-token projection should keep snapshot_json a few KB; a token that
 * crosses the 256 KiB row-size threshold means a large blob leaked back onto it.
 * The sidecar upsert derives that finding during the write and emits the warn
 * AFTER the critical section — never inline, so no filesystem I/O runs while the
 * write queue / SQLite transaction is held.
 */
describe("sidecar row-size telemetry", () => {
  function captureWarns() {
    const warns: Array<{ message: string; fields: Record<string, unknown> }> =
      [];
    return {
      warns,
      logger: {
        warn(message: string, fields?: Record<string, unknown>) {
          warns.push({ message, fields: fields ?? {} });
        },
        error() {},
      },
    };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("warns state-store.row_size.exceeded (after commit) for an oversized snapshot", async () => {
    const { warns, logger } = captureWarns();
    seedSessionConversationRow("conv-big");
    const repo = createConversationMachineSnapshotsRepo(db, logger);

    repo.upsert("session", "conv-big", { value: "x".repeat(300_000) }, "t");

    // Not emitted inside the upsert (the write-queue / transaction critical
    // section) — only after it.
    expect(warns).toEqual([]);
    await flush();

    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toBe("state-store.row_size.exceeded");
    expect(warns[0]?.fields).toMatchObject({
      table: "conversation_machine_snapshots",
      column: "snapshot_json",
      id: "conv-big",
    });
  });

  it("does not warn for a small snapshot", async () => {
    const { warns, logger } = captureWarns();
    seedSessionConversationRow("conv-small");
    const repo = createConversationMachineSnapshotsRepo(db, logger);

    repo.upsert("session", "conv-small", { value: "idle" }, "t");
    await flush();

    expect(warns).toEqual([]);
  });
});
