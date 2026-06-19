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
import { createStateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import type { StateAggregate } from "./state-aggregate";
import { createConversationService } from "../conversations/service";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

type Db = InstanceType<typeof Database>;

let db: Db;

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
});
