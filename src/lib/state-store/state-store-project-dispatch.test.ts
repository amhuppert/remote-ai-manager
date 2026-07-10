import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createStateStore } from "./store";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "./project-conversations-repo";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";

type Db = InstanceType<typeof Database>;

const SENTINEL = PROJECT_CONVERSATION_SESSION_SENTINEL;

function makeProjectConversation(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: "project",
    name: overrides.name ?? null,
    transcriptPath: null,
    status: overrides.status ?? "new",
    promptCount: overrides.promptCount ?? 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: overrides.archived ?? false,
    open: overrides.open ?? true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
  };
}

function sessionRowCount(db: Db): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as { n: number }
  ).n;
}

describe("state-store scope dispatch", () => {
  let db: Db;
  let projectRepo: ProjectConversationsRepo;
  let store: ReturnType<typeof createStateStore>;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo')`).run();
    projectRepo = createProjectConversationsRepo(db);
    projectRepo.upsert("/repo", makeProjectConversation({ id: "c1" }));
    store = createStateStore({
      db,
      repos: { projectConversations: projectRepo },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("reads a sentinel-addressed conversation from the project repo", async () => {
    const found = await store.getConversation("/repo", SENTINEL, "c1");
    expect(found?.scope).toBe("project");
    expect(found?.id).toBe("c1");
    // No session conversation row was created by the sentinel read.
    expect(sessionRowCount(db)).toBe(0);
  });

  it("mutateConversation on the sentinel writes the project repo and stamps lastActivityAt", async () => {
    await store.mutateConversation(
      "/repo",
      SENTINEL,
      "c1",
      "test-mutate",
      (c) => {
        c.status = "running";
      },
    );
    const found = await store.getConversation("/repo", SENTINEL, "c1");
    expect(found?.status).toBe("running");
    expect(found?.lastActivityAt).not.toBe("2025-01-01T00:00:00.000Z");
    expect(sessionRowCount(db)).toBe(0);
  });

  it("setConversationPendingPromptText on the sentinel hits the project repo", async () => {
    await store.setConversationPendingPromptText("/repo", SENTINEL, "c1", "hi");
    const found = await store.getConversation("/repo", SENTINEL, "c1");
    expect(found?.pendingPromptText).toBe("hi");
    expect(sessionRowCount(db)).toBe(0);
  });

  it("focused project setters update a single column without stamping lastActivityAt", async () => {
    await store.setProjectConversationOpen("/repo", "c1", false);
    const afterOpen = await store.getProjectConversation("/repo", "c1");
    expect(afterOpen?.open).toBe(false);
    expect(afterOpen?.lastActivityAt).toBe("2025-01-01T00:00:00.000Z");

    await store.setProjectConversationArchived("/repo", "c1", true);
    expect((await store.getProjectConversation("/repo", "c1"))?.archived).toBe(
      true,
    );
  });

  it("listAllProjectConversations and getProjectConversations expose the records", async () => {
    projectRepo.upsert("/repo", makeProjectConversation({ id: "c2" }));
    const all = await store.listAllProjectConversations();
    expect(all.map((e) => e.conversation.id).sort()).toEqual(["c1", "c2"]);
    const byProject = await store.getProjectConversations("/repo");
    expect(byProject.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("a non-sentinel getConversation uses the session path (returns null, not the project record)", async () => {
    const found = await store.getConversation("/repo", "real-session", "c1");
    expect(found).toBeNull();
  });

  it("throws when mutating a missing project conversation", async () => {
    await expect(
      store.mutateConversation("/repo", SENTINEL, "missing", "x", () => {}),
    ).rejects.toThrow(/not found/);
  });
});

describe("createProjectConversation for a project with no prior state row", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
  });

  afterEach(() => {
    db.close();
  });

  it("auto-creates the projects row so the FK insert succeeds", async () => {
    // A freshly-configured repo has no projects/session/pin/archive state, so
    // there is no `projects` row yet — the FK from project_conversations must
    // not fail.
    const store = createStateStore({ db });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM projects`).get()).toEqual({
      n: 0,
    });

    await store.createProjectConversation(
      "/fresh-repo",
      makeProjectConversation({ id: "first" }),
    );

    const found = await store.getProjectConversation("/fresh-repo", "first");
    expect(found?.id).toBe("first");
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number })
        .n,
    ).toBe(1);
  });
});
