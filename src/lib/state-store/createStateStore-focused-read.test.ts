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
import { _createTestDb } from "./state-db";
import { createProjectsRepo } from "./projects-repo";
import { createSessionsRepo } from "./sessions-repo";
import { createConversationsRepo } from "./conversations-repo";
import { createReferenceDocumentsRepo } from "./reference-documents-repo";
import { createStateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import type { StateAggregate } from "./state-aggregate";
import { createConversationService } from "../conversations/service";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

type Db = InstanceType<typeof Database>;

let db: Db;

interface RunRecord {
  sql: string;
}

/**
 * Wrap the db's `prepare` so every `run()` records its SQL. MUST be installed
 * before the repos prepare their statements (including the focused per-column
 * UPDATE statements, which are prepared lazily on first use) so those
 * statements get the wrapped `run`.
 */
function patchPrepareToTrack(database: Db, runs: RunRecord[]): void {
  const origPrepare = database.prepare.bind(database) as (
    sql: string,
  ) => ReturnType<typeof database.prepare>;
  (database as unknown as { prepare: (sql: string) => unknown }).prepare = (
    sql: string,
  ) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt) as (
      ...args: unknown[]
    ) => ReturnType<typeof stmt.run>;
    (stmt as unknown as { run: (...args: unknown[]) => unknown }).run = (
      ...args: unknown[]
    ) => {
      runs.push({ sql });
      return origRun(...args);
    };
    return stmt;
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
});

afterEach(() => {
  db.close();
});

describe("createStateStore — focused read DI guard", () => {
  it("getConversation pulls from the conversations repo without invoking aggregate.readAll/diffAndCommit", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        summary: "hello",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "spyAggregate.readAll must NOT be called from getConversation focused-read path",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "spyAggregate.diffAndCommit must NOT be called from getConversation focused-read path",
        );
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const found = await store.getConversation("/proj-a", "alpha", "conv-1");

    expect(found).not.toBeNull();
    expect(found?.id).toBe("conv-1");
    expect(found?.summary).toBe("hello");
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("getSessionConversations also bypasses the aggregate", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("readAll must not be called");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("diffAndCommit must not be called");
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const list = await store.getSessionConversations("/proj-a", "alpha");
    expect(list).toHaveLength(1);
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("createSessionConversation inserts via the conversations repo without invoking aggregate.readAll/diffAndCommit, numbers by existing count, and touches the session", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    // One pre-existing conversation so the next sequence number is 2.
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "readAll must NOT be called from createSessionConversation",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "diffAndCommit must NOT be called from createSessionConversation",
        );
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const created = await store.createSessionConversation(
      "/proj-a",
      "alpha",
      (sequenceNumber) =>
        conversationStateSchema.parse({
          id: "conv-2",
          name: `alpha ${sequenceNumber}`,
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-02-02T00:00:00Z",
          lastActivityAt: "2026-02-02T00:00:00Z",
        }),
    );

    // Numbered by existing count (1) + 1, never touching the aggregate.
    expect(created.name).toBe("alpha 2");
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();

    // Persisted through the real repo and visible on reload.
    const reloaded = createConversationsRepo(db).findByKey(
      "/proj-a",
      "alpha",
      "conv-2",
    );
    expect(reloaded?.name).toBe("alpha 2");

    // upsertWithSessionTouch moved the session's lastActivityAt to the new conv's.
    const session = createSessionsRepo(db).findByKey("/proj-a", "alpha");
    expect(session?.lastActivityAt).toBe("2026-02-02T00:00:00Z");
  });

  it("createSessionConversation throws when the session does not exist", async () => {
    createProjectsRepo(db).upsert({ rootPath: "/proj-a" });

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("readAll must not be called");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("diffAndCommit must not be called");
      }),
    };
    const store = createStateStore({ db, aggregate: spyAggregate });

    await expect(
      store.createSessionConversation("/proj-a", "missing", (n) =>
        conversationStateSchema.parse({
          id: "conv-x",
          name: `missing ${n}`,
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-02-02T00:00:00Z",
          lastActivityAt: "2026-02-02T00:00:00Z",
        }),
      ),
    ).rejects.toThrow(/Session "missing" not found/);
  });

  it("conversations.ts getConversation routes through focused accessor — never invokes aggregate.readAll/diffAndCommit", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        summary: "from-conv-service",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("aggregate.readAll must not be reached");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("aggregate.diffAndCommit must not be reached");
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const conversationService = createConversationService({
      mutateSession: store.mutateSession,
      createSessionConversation: store.createSessionConversation,
      getSession: store.getSession,
      getConversation: store.getConversation,
      getSessionConversations: store.getSessionConversations,
      setConversationPendingPromptText: store.setConversationPendingPromptText,
    });

    const found = await conversationService.getConversation(
      "/proj-a",
      "alpha",
      "conv-1",
    );

    expect(found?.id).toBe("conv-1");
    expect(found?.summary).toBe("from-conv-service");
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();

    const list = await conversationService.getSessionConversations(
      "/proj-a",
      "alpha",
    );
    expect(list).toHaveLength(1);
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("getProjectMcpOverrides bypasses aggregate.readAll/diffAndCommit and returns the project's mcpOverrides", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({
      rootPath: "/proj-a",
      mcpOverrides: {
        servers: {
          "my-server": { enabled: false },
        },
      },
    });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "spyAggregate.readAll must NOT be called from getProjectMcpOverrides focused-read path",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "spyAggregate.diffAndCommit must NOT be called from getProjectMcpOverrides focused-read path",
        );
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const overrides = await store.getProjectMcpOverrides("/proj-a");
    expect(overrides).toEqual({
      servers: {
        "my-server": { enabled: false },
      },
    });
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("spawn tag/back-link setters + getSpawnedSessionStatuses bypass the aggregate", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "alpha-conv",
        transcriptPath: null,
        status: "running",
        promptCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "aggregate.readAll must not be reached on the spawn path",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "aggregate.diffAndCommit must not be reached on the spawn path",
        );
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    // createProjectConversation + the two focused spawn setters are cold-path
    // single-row writes (Pattern 2) — never the whole-state mutate*.
    await store.createProjectConversation(
      "/proj-a",
      conversationStateSchema.parse({
        id: "plc-1",
        scope: "project",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        open: true,
      }),
    );
    await store.setSessionSpawnedFrom("/proj-a", "alpha", {
      source: "chat",
      projectName: "proj-a",
      conversationId: "plc-1",
    });
    await store.addPlcSpawnedSessionIds("/proj-a", "plc-1", ["alpha"]);

    const statuses = await store.getSpawnedSessionStatuses("/proj-a", "plc-1");
    expect(statuses.map((s) => s.sessionName)).toEqual(["alpha"]);
    expect(statuses[0]?.derivedStatus).toBe("running");
    expect(statuses[0]?.spawnedFrom?.source).toBe("chat");

    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("getProjectMcpOverrides returns undefined for missing project", async () => {
    createProjectsRepo(db);
    createSessionsRepo(db);
    createConversationsRepo(db);

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("readAll must not be called");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("diffAndCommit must not be called");
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const overrides = await store.getProjectMcpOverrides("/missing-project");
    expect(overrides).toBeUndefined();
  });

  it("getConversationById resolves identity by id alone without invoking the aggregate", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    projects.upsert({ rootPath: "/proj-b" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    sessions.upsert(
      "/proj-b",
      sessionStateSchema.parse({
        sessionName: "beta",
        worktreePath: "/wt/beta",
        branchName: "csm/beta",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        archived: true,
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-b",
      "beta",
      conversationStateSchema.parse({
        id: "conv-2",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        archived: true,
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "spyAggregate.readAll must NOT be called from getConversationById focused-read path",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "spyAggregate.diffAndCommit must NOT be called from getConversationById focused-read path",
        );
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    const found = await store.getConversationById("conv-2");
    expect(found).toMatchObject({
      projectPath: "/proj-b",
      sessionName: "beta",
      worktreePath: "/wt/beta",
    });
    expect(found?.conversation.id).toBe("conv-2");
    expect(found?.conversation.archived).toBe(true);

    expect(await store.getConversationById("missing")).toBeNull();
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("getConversationById does not resolve project-scoped conversations", async () => {
    const projects = createProjectsRepo(db);
    createSessionsRepo(db);
    createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("readAll must not be called");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("diffAndCommit must not be called");
      }),
    };

    const store = createStateStore({ db, aggregate: spyAggregate });

    await store.createProjectConversation(
      "/proj-a",
      conversationStateSchema.parse({
        id: "plc-1",
        scope: "project",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        open: true,
      }),
    );

    expect(await store.getConversationById("plc-1")).toBeNull();
  });

  it("mutateConversation persists a single-row change without invoking aggregate.readAll/diffAndCommit", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        summary: "before",
      }),
    );

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error(
          "spyAggregate.readAll must NOT be called from mutateConversation focused path",
        );
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error(
          "spyAggregate.diffAndCommit must NOT be called from mutateConversation focused path",
        );
      }),
    };

    const store = createStateStore({
      db,
      aggregate: spyAggregate,
      writeQueue: createWriteQueue(),
    });

    await store.mutateConversation(
      "/proj-a",
      "alpha",
      "conv-1",
      "focused.update",
      (c) => {
        c.summary = "after";
      },
    );

    const found = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(found?.summary).toBe("after");
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("mutateConversation writes only the changed column and never re-serializes co-located blobs", async () => {
    const runRecords: RunRecord[] = [];
    patchPrepareToTrack(db, runRecords);

    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    // A large machine_snapshot whose persisted bytes must survive a scalar
    // mutate untouched (and never be re-serialized into the UPDATE).
    const bigSnapshot = {
      state: "running",
      context: {
        history: Array.from({ length: 500 }, (_, i) => ({
          index: i,
          note: `event-${i}-`.repeat(8),
        })),
      },
    };
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        machineSnapshot: bigSnapshot,
      }),
    );

    const beforeBytes = (
      db
        .prepare("SELECT machine_snapshot FROM conversations WHERE id = ?")
        .get("conv-1") as { machine_snapshot: string }
    ).machine_snapshot;
    expect(beforeBytes.length).toBeGreaterThan(1000);

    const store = createStateStore({
      db,
      aggregate: {
        readAll: vi.fn(() => {
          throw new Error("readAll must not be called");
        }),
        diffAndCommit: vi.fn(() => {
          throw new Error("diffAndCommit must not be called");
        }),
      },
      writeQueue: createWriteQueue(),
    });

    runRecords.length = 0;
    await store.mutateConversation(
      "/proj-a",
      "alpha",
      "conv-1",
      "focused.status",
      (c) => {
        c.status = "running";
      },
    );

    const updateRecord = runRecords.find((r) =>
      /UPDATE conversations SET/.test(r.sql),
    );
    expect(updateRecord, "a focused UPDATE must have run").toBeDefined();
    const updateSql = updateRecord!.sql;
    expect(updateSql).toMatch(/\bstatus\b/);
    expect(updateSql).toMatch(/\blast_activity_at\b/);
    expect(updateSql).not.toMatch(/machine_snapshot/);
    expect(updateSql).not.toMatch(/pending_queue/);
    expect(updateSql).not.toMatch(/mcp_runtime/);
    expect(updateSql).not.toMatch(/agent_capabilities_runtime/);

    const afterBytes = (
      db
        .prepare("SELECT machine_snapshot FROM conversations WHERE id = ?")
        .get("conv-1") as { machine_snapshot: string }
    ).machine_snapshot;
    expect(afterBytes).toBe(beforeBytes);

    const reloaded = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(reloaded?.status).toBe("running");
    expect(reloaded?.machineSnapshot).toEqual(bigSnapshot);
  });

  it("mutateConversation returns a non-frozen value the caller can mutate", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        pendingQueue: [
          {
            id: "m1",
            content: [{ type: "text", text: "hi" }],
            status: "pending",
            enqueuedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            deliveryStartedAt: null,
            deliveredAt: null,
            cancelledAt: null,
            failedAt: null,
            deliveryAttemptId: null,
            attemptCount: 0,
            error: null,
          },
        ],
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    // Mirror the message-queue family: the mutator builds a new entry, assigns
    // it into the draft's pendingQueue, and returns that same entry reference.
    // The returned value must be mutable by the caller (not Immer-frozen).
    const claimed = await store.mutateConversation(
      "/proj-a",
      "alpha",
      "conv-1",
      "focused.claim",
      (c) => {
        const entry: PendingQueuedMessage = {
          ...c.pendingQueue[0]!,
          status: "delivering",
        };
        c.pendingQueue = [entry];
        return entry;
      },
    );

    expect(() => {
      claimed.status = "delivered";
    }).not.toThrow();
    expect(claimed.status).toBe("delivered");
  });

  it("mutateSession writes only the changed session column (no auto-restamp), never re-serializing the workflow_lanes blob, and never touches the aggregate", async () => {
    const runRecords: RunRecord[] = [];
    patchPrepareToTrack(db, runRecords);

    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });

    // A large workflow_lanes blob whose persisted bytes must survive a scalar
    // session mutate untouched (and never be re-serialized into the UPDATE).
    const bigLanes = buildBigLanes();
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        targetBranch: "before",
        workflowLanes: bigLanes,
      }),
    );

    const beforeBytes = (
      db
        .prepare(
          "SELECT workflow_lanes FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get("/proj-a", "alpha") as { workflow_lanes: string }
    ).workflow_lanes;
    expect(beforeBytes.length).toBeGreaterThan(1000);

    const spyAggregate: StateAggregate = {
      readAll: vi.fn(() => {
        throw new Error("readAll must not be called");
      }),
      diffAndCommit: vi.fn(() => {
        throw new Error("diffAndCommit must not be called");
      }),
    };

    const store = createStateStore({
      db,
      aggregate: spyAggregate,
      writeQueue: createWriteQueue(),
    });

    runRecords.length = 0;
    await store.mutateSession(
      "/proj-a",
      "alpha",
      "set-target-branch",
      (session) => {
        session.targetBranch = "after";
      },
    );

    const updateRecord = runRecords.find((r) =>
      /UPDATE sessions SET/.test(r.sql),
    );
    expect(updateRecord, "a focused UPDATE must have run").toBeDefined();
    const updateSql = updateRecord!.sql;
    expect(updateSql).toMatch(/\btarget_branch\b/);
    // The mutator only changed `targetBranch`; a config toggle must not bump
    // session activity, so last_activity_at is absent from the UPDATE.
    expect(updateSql).not.toMatch(/last_activity_at/);
    expect(updateSql).not.toMatch(/graph_workflow_execution/);
    expect(updateSql).not.toMatch(/workflow_lanes/);
    expect(updateSql).not.toMatch(/workflow_envelopes/);
    expect(updateSql).not.toMatch(/mcp_overrides/);

    const afterBytes = (
      db
        .prepare(
          "SELECT workflow_lanes FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get("/proj-a", "alpha") as { workflow_lanes: string }
    ).workflow_lanes;
    expect(afterBytes).toBe(beforeBytes);

    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.targetBranch).toBe("after");
    expect(reloaded?.workflowLanes).toEqual(bigLanes);
    expect(spyAggregate.readAll).not.toHaveBeenCalled();
    expect(spyAggregate.diffAndCommit).not.toHaveBeenCalled();
  });

  it("mutateSession edits a child conversation through the mutator and persists it without rewriting the session blob columns", async () => {
    const runRecords: RunRecord[] = [];
    patchPrepareToTrack(db, runRecords);

    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    const bigLanes = buildBigLanes();
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        workflowLanes: bigLanes,
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        name: "old name",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    runRecords.length = 0;
    await store.mutateSession("/proj-a", "alpha", "rename-child", (session) => {
      const conv = session.conversations.find((c) => c.id === "conv-1")!;
      conv.name = "new name";
    });

    const convUpdate = runRecords.find((r) =>
      /UPDATE conversations SET/.test(r.sql),
    );
    expect(convUpdate, "child conversation UPDATE must have run").toBeDefined();
    expect(convUpdate!.sql).toMatch(/\bname\b/);

    // No session-column UPDATE (only the child changed) → no blob rewrite and no
    // session last_activity_at restamp (matching the prior whole-tree diff).
    const sessionUpdate = runRecords.find((r) =>
      /UPDATE sessions SET/.test(r.sql),
    );
    expect(sessionUpdate).toBeUndefined();

    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.conversations.find((c) => c.id === "conv-1")?.name).toBe(
      "new name",
    );
    expect(reloaded?.workflowLanes).toEqual(bigLanes);
    expect(reloaded?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
  });

  it("mutateSession adds a child conversation pushed by the mutator", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    await store.mutateSession("/proj-a", "alpha", "add-child", (session) => {
      session.conversations.push(
        conversationStateSchema.parse({
          id: "conv-new",
          name: "forked",
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-02-02T00:00:00Z",
          lastActivityAt: "2026-02-02T00:00:00Z",
        }),
      );
    });

    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.conversations.map((c) => c.id)).toEqual(["conv-new"]);
    expect(
      createConversationsRepo(db).findByKey("/proj-a", "alpha", "conv-new")
        ?.name,
    ).toBe("forked");
  });

  it("mutateSession edits one child conversation and adds another in the same mutate (finalizeInitialization shape)", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "init",
        role: "initialization",
        transcriptPath: null,
        status: "idle",
        promptCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        archived: false,
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    await store.mutateSession("/proj-a", "alpha", "finalize", (session) => {
      const init = session.conversations.find(
        (c) => c.role === "initialization",
      )!;
      init.archived = true;
      session.conversations.push(
        conversationStateSchema.parse({
          id: "fresh",
          name: "alpha 2",
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-02-02T00:00:00Z",
          lastActivityAt: "2026-02-02T00:00:00Z",
        }),
      );
    });

    const reloadedConvs = createConversationsRepo(db).findBySession(
      "/proj-a",
      "alpha",
    );
    expect(reloadedConvs.find((c) => c.id === "init")?.archived).toBe(true);
    expect(reloadedConvs.find((c) => c.id === "fresh")?.name).toBe("alpha 2");
  });

  it("mutateSession removes a child reference document spliced by the mutator", async () => {
    const runRecords: RunRecord[] = [];
    patchPrepareToTrack(db, runRecords);

    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const referenceDocuments = createReferenceDocumentsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
    referenceDocuments.upsert("/proj-a", "alpha", {
      id: "doc-1",
      filePath: "/docs/a.md",
      description: "doc a",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    runRecords.length = 0;
    const removed = await store.mutateSession(
      "/proj-a",
      "alpha",
      "remove-doc",
      (session) => {
        const index = session.referenceDocuments.findIndex(
          (d) => d.id === "doc-1",
        );
        const target = session.referenceDocuments[index]!;
        const snapshot = { ...target };
        session.referenceDocuments.splice(index, 1);
        return snapshot;
      },
    );

    expect(removed?.id).toBe("doc-1");
    const deleteRecord = runRecords.find((r) =>
      /DELETE FROM reference_documents/.test(r.sql),
    );
    expect(
      deleteRecord,
      "a reference-document DELETE must have run",
    ).toBeDefined();

    expect(createReferenceDocumentsRepo(db).findById("doc-1")).toBeNull();
    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.referenceDocuments).toEqual([]);
  });

  it("mutateSession supports an async mutator (agent-capabilities patchSession shape)", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    const result = await store.mutateSession(
      "/proj-a",
      "alpha",
      "async-patch",
      async (session) => {
        // Suspend across an await to prove the Immer draft survives (createDraft/
        // finishDraft, not produce, which would revoke the proxy mid-await).
        await Promise.resolve();
        session.targetBranch = "async-set";
        return "ok" as const;
      },
    );

    expect(result).toBe("ok");
    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.targetBranch).toBe("async-set");
  });

  it("mutateSession rolls back every write when the mutator throws mid-way", async () => {
    const projects = createProjectsRepo(db);
    const sessions = createSessionsRepo(db);
    const conversations = createConversationsRepo(db);

    projects.upsert({ rootPath: "/proj-a" });
    sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        targetBranch: "original",
      }),
    );
    conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-1",
        name: "original-name",
        transcriptPath: null,
        status: "idle",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );

    const store = createStateStore({ db, writeQueue: createWriteQueue() });

    await expect(
      store.mutateSession("/proj-a", "alpha", "throwing", (session) => {
        session.targetBranch = "should-not-persist";
        const conv = session.conversations.find((c) => c.id === "conv-1")!;
        conv.name = "should-not-persist";
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.targetBranch).toBe("original");
    expect(reloaded?.conversations.find((c) => c.id === "conv-1")?.name).toBe(
      "original-name",
    );
  });
});

/**
 * Build a large, opaque workflow_lanes map whose serialized bytes exceed 1KB,
 * so a scalar session mutate can prove that co-located blob column is neither
 * re-serialized into the focused UPDATE nor altered on disk. `workflowLanes` is
 * an opaque `z.record(z.string(), z.unknown())` on the session schema, so an
 * arbitrarily-shaped record round-trips without a primitive-layer parse.
 */
function buildBigLanes(): Record<string, unknown> {
  const lanes: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) {
    lanes[`lane-${i}`] = {
      engine: "noop",
      note: `lane ${i} ${"detail-".repeat(8)}`,
      steps: Array.from({ length: 4 }, (_, j) => ({
        index: j,
        label: `step-${j}-`.repeat(4),
      })),
    };
  }
  return lanes;
}
