import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { _createTestDb, _createTestDbAtPath } from "./state-db";
import { createProjectsRepo, type ProjectsRepo } from "./projects-repo";
import { createStateStore, type StateStore } from "./store";
import { createWriteQueue } from "./write-queue";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { managerStateSchema } from "@/lib/projects/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
type Db = InstanceType<typeof Database>;

let db: Db;
let store: StateStore;

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "alpha",
    worktreePath: "/wt/alpha",
    branchName: "csm/alpha",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: "conv-1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  store = createStateStore({ db, writeQueue: createWriteQueue() });
});

afterEach(() => {
  db.close();
});

describe("createStateStore lifecycle", () => {
  it("returns the same StateStore surface for an empty DB: empty projects, empty archive/pin sets", async () => {
    const state = await store.readState();
    expect(managerStateSchema.parse(state)).toEqual(state);
    expect(state.projects).toEqual({});
    expect(state.archivedProjects).toEqual([]);
    expect(state.pinnedProjects).toEqual([]);

    expect(await store.getArchivedProjects()).toEqual(new Set());
    expect(await store.getPinnedProjects()).toEqual(new Set());
  });
});

describe("getOrCreateProject", () => {
  it("creates a project on first call and returns the same project on subsequent calls", async () => {
    const created = await store.getOrCreateProject("/proj-a");
    expect(created.rootPath).toBe("/proj-a");

    const second = await store.getOrCreateProject("/proj-a");
    expect(second.rootPath).toBe("/proj-a");
  });
});

describe("mutateSession", () => {
  it("mutates the target session and persists the change", async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      state.projects["/proj-a"]!.sessions["alpha"] = makeSession();
    });

    await store.mutateSession(
      "/proj-a",
      "alpha",
      "set-objective",
      (session) => {
        session.objective = "ship it";
      },
    );

    const reloaded = await store.getSession("/proj-a", "alpha");
    expect(reloaded?.objective).toBe("ship it");
  });

  it("throws when the session does not exist", async () => {
    await store.getOrCreateProject("/proj-a");
    await expect(
      store.mutateSession("/proj-a", "missing", "x", () => {}),
    ).rejects.toThrow(/Session "missing" not found/);
  });

  it("mutates only the target session and leaves a sibling session untouched", async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      state.projects["/proj-a"]!.sessions["alpha"] = makeSession({
        sessionName: "alpha",
        objective: "alpha-objective",
      });
      state.projects["/proj-a"]!.sessions["beta"] = makeSession({
        sessionName: "beta",
        worktreePath: "/wt/beta",
        branchName: "csm/beta",
        objective: "beta-objective",
      });
    });

    await store.mutateSession(
      "/proj-a",
      "alpha",
      "set-alpha-objective",
      (session) => {
        session.objective = "alpha-updated";
      },
    );

    const alpha = await store.getSession("/proj-a", "alpha");
    expect(alpha?.objective).toBe("alpha-updated");

    // The focused path loads only the target session, so a sibling can never be
    // reached or rewritten by the mutator.
    const beta = await store.getSession("/proj-a", "beta");
    expect(beta?.objective).toBe("beta-objective");
    expect(beta?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("setConversationPendingPromptText focused write", () => {
  beforeEach(async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      const session = makeSession();
      session.conversations.push(makeConversation({ id: "conv-1" }));
      state.projects["/proj-a"]!.sessions["alpha"] = session;
    });
  });

  it("persists a string value without invoking the whole-state aggregate", async () => {
    const aggregateSpy = vi.spyOn(managerStateSchema, "parse");
    aggregateSpy.mockClear();

    await store.setConversationPendingPromptText(
      "/proj-a",
      "alpha",
      "conv-1",
      "draft text",
    );

    expect(aggregateSpy).not.toHaveBeenCalled();
    aggregateSpy.mockRestore();

    const after = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(after?.pendingPromptText).toBe("draft text");
  });

  it("clears the column when given null", async () => {
    await store.setConversationPendingPromptText(
      "/proj-a",
      "alpha",
      "conv-1",
      "draft",
    );
    await store.setConversationPendingPromptText(
      "/proj-a",
      "alpha",
      "conv-1",
      null,
    );

    const after = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(after?.pendingPromptText).toBeNull();
  });

  it("throws when the conversation does not exist", async () => {
    await expect(
      store.setConversationPendingPromptText(
        "/proj-a",
        "alpha",
        "missing",
        "x",
      ),
    ).rejects.toThrow(/missing/);
  });
});

describe("mutateConversation", () => {
  beforeEach(async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      const session = makeSession();
      session.conversations.push(makeConversation({ id: "conv-1" }));
      state.projects["/proj-a"]!.sessions["alpha"] = session;
    });
  });

  it("mutates a conversation in the target session and bumps lastActivityAt on both", async () => {
    const before = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(before?.summary).toBeNull();

    await store.mutateConversation(
      "/proj-a",
      "alpha",
      "conv-1",
      "set-summary",
      (conv) => {
        conv.summary = "summarized";
      },
    );

    const after = await store.getConversation("/proj-a", "alpha", "conv-1");
    expect(after?.summary).toBe("summarized");
    expect(after?.lastActivityAt).not.toBe("2026-01-01T00:00:00Z");

    const session = await store.getSession("/proj-a", "alpha");
    expect(session?.lastActivityAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("returns the mutator's result", async () => {
    const result = await store.mutateConversation(
      "/proj-a",
      "alpha",
      "conv-1",
      "read-prompt-count",
      (conv) => conv.promptCount,
    );
    expect(result).toBe(0);
  });

  it("throws when the conversation does not exist", async () => {
    await expect(
      store.mutateConversation("/proj-a", "alpha", "missing", "set-x", (c) => {
        c.summary = "x";
      }),
    ).rejects.toThrow(/missing/);
  });
});

describe("read accessors", () => {
  it("getConversation returns null when missing", async () => {
    expect(
      await store.getConversation("/proj-a", "alpha", "conv-1"),
    ).toBeNull();
  });

  it("getSessionConversations returns conversations seeded for the session", async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      const session = makeSession();
      session.conversations.push(makeConversation({ id: "c-1" }));
      session.conversations.push(makeConversation({ id: "c-2" }));
      state.projects["/proj-a"]!.sessions["alpha"] = session;
    });

    const list = await store.getSessionConversations("/proj-a", "alpha");
    expect(list.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
  });

  it("getProjectSessions returns the sessions for the project", async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      state.projects["/proj-a"]!.sessions["alpha"] = makeSession();
      state.projects["/proj-a"]!.sessions["beta"] = makeSession({
        sessionName: "beta",
        worktreePath: "/wt/beta",
        branchName: "csm/beta",
      });
    });

    const list = await store.getProjectSessions("/proj-a");
    expect(list.map((s) => s.sessionName).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("setProjectArchived / setProjectPinned atomicity (R2)", () => {
  function makeFailingProjectsRepo(
    base: ProjectsRepo,
    failOn: "setArchived" | "setPinned",
  ): ProjectsRepo {
    return {
      ...base,
      findByRootPath: (rootPath) => base.findByRootPath(rootPath),
      listAll: () => base.listAll(),
      listArchived: () => base.listArchived(),
      listPinned: () => base.listPinned(),
      upsert: (project) => base.upsert(project),
      reorderPinned: (orderedRootPaths) => base.reorderPinned(orderedRootPaths),
      delete: (rootPath) => base.delete(rootPath),
      setArchived: (rootPath, value) => {
        if (failOn === "setArchived") {
          throw new Error("simulated setArchived failure mid-transaction");
        }
        base.setArchived(rootPath, value);
      },
      setPinned: (rootPath, value) => {
        if (failOn === "setPinned") {
          throw new Error("simulated setPinned failure mid-transaction");
        }
        base.setPinned(rootPath, value);
      },
    };
  }

  function projectExists(database: Db, rootPath: string): boolean {
    const row = database
      .prepare("SELECT 1 AS hit FROM projects WHERE root_path = ?")
      .get(rootPath);
    return row !== undefined;
  }

  it("rolls back the auto-upsert when setArchived fails so no orphaned project row remains", async () => {
    const failingProjects = makeFailingProjectsRepo(
      createProjectsRepo(db),
      "setArchived",
    );
    const atomicStore = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { projects: failingProjects },
    });

    expect(projectExists(db, "/p/missing")).toBe(false);

    await expect(
      atomicStore.setProjectArchived("/p/missing", true),
    ).rejects.toThrow(/simulated setArchived/i);

    expect(projectExists(db, "/p/missing")).toBe(false);
  });

  it("rolls back the auto-upsert when setPinned fails so no orphaned project row remains", async () => {
    const failingProjects = makeFailingProjectsRepo(
      createProjectsRepo(db),
      "setPinned",
    );
    const atomicStore = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { projects: failingProjects },
    });

    expect(projectExists(db, "/p/missing")).toBe(false);

    await expect(
      atomicStore.setProjectPinned("/p/missing", true),
    ).rejects.toThrow(/simulated setPinned/i);

    expect(projectExists(db, "/p/missing")).toBe(false);
  });
});

describe("mutateState clone-and-validate", () => {
  beforeEach(async () => {
    await store.getOrCreateProject("/proj-a");
    await store.mutateState("seed", (state) => {
      state.projects["/proj-a"]!.sessions["alpha"] = makeSession();
    });
  });

  it("skips all whole-state validation under NODE_ENV=production (both cloneAndValidate and diffAndCommit)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const parseSpy = vi.spyOn(managerStateSchema, "parse");
    try {
      await store.mutateState("noop", () => {
        // no-op mutation
      });
      // Both the snapshot-clone validation and the diffAndCommit validation
      // are gated to non-production; in production neither runs.
      expect(parseSpy).toHaveBeenCalledTimes(0);
    } finally {
      parseSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("runs the snapshot-clone validation outside production (cloneAndValidate + diffAndCommit)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const parseSpy = vi.spyOn(managerStateSchema, "parse");
    try {
      await store.mutateState("noop", () => {
        // no-op mutation
      });
      expect(parseSpy).toHaveBeenCalledTimes(2);
    } finally {
      parseSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("state.read.timing log threshold", () => {
  beforeEach(() => {
    logger.info.mockClear();
  });

  it("does not log state.read.timing for sub-threshold reads", async () => {
    await store.getArchivedProjects();
    const timingCalls = logger.info.mock.calls.filter(
      (call) => call[0] === "state.read.timing",
    );
    expect(timingCalls).toEqual([]);
  });

  it("logs state.read.timing when the read exceeds the threshold", async () => {
    const realPerfNow = performance.now.bind(performance);
    let first = true;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      if (first) {
        first = false;
        return 0;
      }
      return 100;
    });
    try {
      await store.getArchivedProjects();
      const timingCalls = logger.info.mock.calls.filter(
        (call) => call[0] === "state.read.timing",
      );
      expect(timingCalls).toHaveLength(1);
      const payload = timingCalls[0]![1] as {
        accessor: string;
        totalMs: number;
      };
      expect(payload.accessor).toBe("getArchivedProjects");
      expect(payload.totalMs).toBe(100);
    } finally {
      nowSpy.mockRestore();
      void realPerfNow;
    }
  });
});

describe("empty-store first-boot (R8.3)", () => {
  it("opens cleanly against a fresh empty config dir without any JSON import", async () => {
    const tmpConfigDir = mkdtempSync(path.join(os.tmpdir(), "cc-empty-boot-"));
    const dbPath = path.join(tmpConfigDir, "command-center.db");

    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(tmpConfigDir)).toEqual([]);

    const freshDb = _createTestDbAtPath(dbPath);
    try {
      const freshStore = createStateStore({
        db: freshDb,
        writeQueue: createWriteQueue(),
      });

      const state = await freshStore.readState();
      expect(managerStateSchema.parse(state)).toEqual(state);
      expect(state.projects).toEqual({});
      expect(state.archivedProjects).toEqual([]);
      expect(state.pinnedProjects).toEqual([]);

      const dirEntries = readdirSync(tmpConfigDir).sort();
      expect(dirEntries).not.toContain("state.json");
      expect(
        dirEntries.some((entry) => entry.startsWith("command-center.db")),
      ).toBe(true);
    } finally {
      freshDb.close();
    }
  });
});
