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
import {
  canonicalConversationRow,
  createConversationsRepo,
  type ConversationsRepo,
} from "./conversations-repo";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: ConversationsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function insertParentSession(
  projectPath: string,
  sessionName: string,
  lastActivityAt = "2026-01-01T00:00:00Z",
): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    projectPath,
  );
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name,
        created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    projectPath,
    sessionName,
    `/wt/${sessionName}`,
    `csm/${sessionName}`,
    "2026-01-01T00:00:00Z",
    lastActivityAt,
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  insertParentSession(PROJECT_PATH, SESSION_NAME);
  repo = createConversationsRepo(db);
});

afterEach(() => {
  db.close();
});

function makeMinimalConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: "c1",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makeFullConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: "c-full",
    name: "Full convo",
    transcriptPath: "/tmp/transcripts/c-full.jsonl",
    status: "running",
    promptCount: 17,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-02-15T08:09:10Z",
    source: "imported",
    summary: "Did a thing",
    archived: true,
    totalCostUsd: 1.23,
    totalDurationMs: 4567,
    totalTurns: 9,
    pendingQuestionId: "q-1",
    pendingQuestions: [
      {
        question: "Continue?",
        options: [{ label: "yes" }, { label: "no" }],
        multiSelect: false,
      },
    ],
    pendingPromptText: "draft prompt text that should round-trip",
    forkedFrom: {
      sourceConversationId: "parent-conv",
      messageIndex: 4,
      sourceBackend: "claude",
      sourceBackendRef: { backend: "claude", sessionId: "src-sess" },
      forkLocator: "msg-4",
      forkMode: "native",
    },
    role: "iteration",
    contextTokens: 12_000,
    contextWindowMax: 200_000,
    debugMode: {
      active: true,
      recording: true,
      logFilePath: "/tmp/debug.log",
      enteredAt: "2026-01-15T00:00:00Z",
      hypotheses: [{ id: "h1", description: "race condition" }],
      instructionsDelivered: true,
      phase: "analyzing_evidence",
    },
    machineSnapshot: { state: "idle", context: { foo: 42 } },
    agentBackend: "codex",
    backendRef: { backend: "codex", threadId: "thr-1" },
    mcpOverrides: {
      servers: {
        stripe: { enabled: true, tools: { charge: { enabled: false } } },
      },
    },
    mcpRuntime: {
      lastAppliedConfigHash: "hash-a",
      pendingConfigHash: "hash-b",
      pendingServerKeys: ["stripe"],
      lastApplyDisposition: "applied_now",
    },
    ...overrides,
  });
}

describe("conversations-repo round-trip contract", () => {
  it("upsert + findById round-trips a minimal fixture", () => {
    const fixture = makeMinimalConversation();
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const out = repo.findById(fixture.id);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out.id).toBe(fixture.id);
    expect(out.name).toBeNull();
    expect(out.transcriptPath).toBeNull();
    expect(out.summary).toBeNull();
    expect(out.archived).toBe(false);
    expect(out.totalCostUsd).toBeNull();
    expect(out.pendingQuestions).toBeNull();
    expect(out.forkedFrom).toBeNull();
    expect(out.role).toBeNull();
    expect(out.debugMode).toBeNull();
    expect(out.machineSnapshot).toBeNull();
    expect(out.backendRef).toBeNull();
    expect(out.mcpOverrides).toBeUndefined();
    expect(out.mcpRuntime).toBeUndefined();
    expect(out.agentBackend).toBe("claude");

    expect(conversationStateSchema.parse(out)).toEqual(fixture);
  });

  it("upsert + findById round-trips a fully populated fixture (every field set, JSON sub-trees included)", () => {
    const fixture = makeFullConversation();
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const out = repo.findById(fixture.id);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out).toEqual(fixture);
    expect(conversationStateSchema.parse(out)).toEqual(fixture);
  });

  it("findBySession returns conversations belonging to a session, sorted by createdAt", () => {
    insertParentSession(PROJECT_PATH, "other");
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "a",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "b",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    repo.upsert(
      PROJECT_PATH,
      "other",
      makeMinimalConversation({
        id: "x",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );

    const result = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(result.map((c) => c.id)).toEqual(["a", "b"]);
    expect(repo.findBySession(PROJECT_PATH, "other").map((c) => c.id)).toEqual([
      "x",
    ]);
  });

  it("upsert ON CONFLICT(id) updates existing row in place (no delete-then-insert)", () => {
    const original = makeMinimalConversation({ summary: "v1" });
    repo.upsert(PROJECT_PATH, SESSION_NAME, original);

    const updated = makeMinimalConversation({
      summary: "v2",
      promptCount: 3,
    });
    repo.upsert(PROJECT_PATH, SESSION_NAME, updated);

    const out = repo.findById(original.id);
    expect(out?.summary).toBe("v2");
    expect(out?.promptCount).toBe(3);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = ?")
        .get(original.id) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("delete removes only the targeted conversation", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "a" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "b" }),
    );

    repo.delete("a");
    expect(repo.findById("a")).toBeNull();
    expect(repo.findById("b")).not.toBeNull();
  });

  it("unread defaults to false on insert and round-trips when set true", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "default" }),
    );
    expect(repo.findById("default")?.unread).toBe(false);

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "unread", unread: true }),
    );
    expect(repo.findById("unread")?.unread).toBe(true);

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "unread", unread: false }),
    );
    expect(repo.findById("unread")?.unread).toBe(false);
  });
});

describe("conversations-repo findListItemsForProject projection", () => {
  it("returns rows with only the slim columns (no JSON or heavy fields)", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({
        id: "c-heavy",
        status: "running",
        promptCount: 5,
        lastActivityAt: "2026-03-15T00:00:00Z",
      }),
    );

    const rows = repo.findListItemsForProject(PROJECT_PATH);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["id", "lastActivityAt", "promptCount", "sessionName", "status"].sort(),
    );
    expect(row.id).toBe("c-heavy");
    expect(row.sessionName).toBe(SESSION_NAME);
    expect(row.status).toBe("running");
    expect(row.promptCount).toBe(5);
    expect(row.lastActivityAt).toBe("2026-03-15T00:00:00Z");
  });

  it("scopes to the requested projectPath", () => {
    insertParentSession("/p-other", "s-other");
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "in-scope" }),
    );
    repo.upsert(
      "/p-other",
      "s-other",
      makeMinimalConversation({ id: "out-of-scope" }),
    );

    const rows = repo.findListItemsForProject(PROJECT_PATH);
    expect(rows.map((r) => r.id)).toEqual(["in-scope"]);
  });
});

describe("conversations-repo upsertWithSessionTouch atomicity", () => {
  it("commits both the conversation upsert and parent session.last_activity_at update in one transaction (success)", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c1", summary: "v1" }),
    );

    const mutated = makeMinimalConversation({ id: "c1", summary: "v2" });
    const newLastActivity = "2026-04-04T04:04:04Z";
    repo.upsertWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      mutated,
      newLastActivity,
    );

    expect(repo.findById("c1")?.summary).toBe("v2");
    const session = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
    expect(session.last_activity_at).toBe(newLastActivity);
  });

  it("rolls back BOTH the conversation upsert and the session UPDATE if an exception occurs inside the transaction", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c1", summary: "original" }),
    );
    const beforeSession = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
    const beforeLastActivity = beforeSession.last_activity_at;

    db.exec(`
      CREATE TRIGGER abort_session_update
      BEFORE UPDATE ON sessions
      WHEN NEW.last_activity_at = '__rollback_marker__'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END
    `);

    try {
      const mutated = makeMinimalConversation({
        id: "c1",
        summary: "mutated_should_not_persist",
      });
      expect(() =>
        repo.upsertWithSessionTouch(
          PROJECT_PATH,
          SESSION_NAME,
          mutated,
          "__rollback_marker__",
        ),
      ).toThrow();

      const afterConv = repo.findById("c1");
      expect(afterConv?.summary).toBe("original");

      const afterSession = db
        .prepare(
          "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
      expect(afterSession.last_activity_at).toBe(beforeLastActivity);
    } finally {
      db.exec("DROP TRIGGER abort_session_update");
    }
  });
});

describe("canonicalConversationRow", () => {
  it("returns the same string for two ConversationState values that are deep-equal post-Zod-parse", () => {
    const a = makeFullConversation();
    const b = makeFullConversation();
    expect(canonicalConversationRow(PROJECT_PATH, SESSION_NAME, a)).toBe(
      canonicalConversationRow(PROJECT_PATH, SESSION_NAME, b),
    );
  });

  it("is insensitive to mcpOverrides.servers key insertion order", () => {
    const a = makeMinimalConversation({
      mcpOverrides: {
        servers: { alpha: { enabled: true }, beta: { enabled: false } },
      },
    });
    const b = makeMinimalConversation({
      mcpOverrides: {
        servers: { beta: { enabled: false }, alpha: { enabled: true } },
      },
    });
    expect(canonicalConversationRow(PROJECT_PATH, SESSION_NAME, a)).toBe(
      canonicalConversationRow(PROJECT_PATH, SESSION_NAME, b),
    );
  });

  it("differs when any field differs", () => {
    const base = makeMinimalConversation();
    expect(canonicalConversationRow(PROJECT_PATH, SESSION_NAME, base)).not.toBe(
      canonicalConversationRow(
        PROJECT_PATH,
        SESSION_NAME,
        makeMinimalConversation({ summary: "x" }),
      ),
    );
    expect(canonicalConversationRow(PROJECT_PATH, SESSION_NAME, base)).not.toBe(
      canonicalConversationRow("/p2", SESSION_NAME, base),
    );
    expect(canonicalConversationRow(PROJECT_PATH, SESSION_NAME, base)).not.toBe(
      canonicalConversationRow(
        PROJECT_PATH,
        SESSION_NAME,
        makeMinimalConversation({ archived: true }),
      ),
    );
  });
});

describe("conversations-repo setPendingPromptText focused write", () => {
  it("sets pending_prompt_text on the targeted row without touching siblings", () => {
    insertParentSession(PROJECT_PATH, "other-session");
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "target", pendingPromptText: null }),
    );
    repo.upsert(
      PROJECT_PATH,
      "other-session",
      makeMinimalConversation({
        id: "sibling",
        pendingPromptText: "do not touch",
      }),
    );

    const result = repo.setPendingPromptText(
      PROJECT_PATH,
      SESSION_NAME,
      "target",
      "drafted text",
    );
    expect(result).toBe(true);

    expect(repo.findById("target")?.pendingPromptText).toBe("drafted text");
    expect(repo.findById("sibling")?.pendingPromptText).toBe("do not touch");
  });

  it("clears the column when given null", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c1", pendingPromptText: "to-clear" }),
    );

    expect(
      repo.setPendingPromptText(PROJECT_PATH, SESSION_NAME, "c1", null),
    ).toBe(true);
    expect(repo.findById("c1")?.pendingPromptText).toBeNull();
  });

  it("returns false when the conversation does not exist (no row updated)", () => {
    expect(
      repo.setPendingPromptText(PROJECT_PATH, SESSION_NAME, "missing", "x"),
    ).toBe(false);
  });

  it("requires the projectPath and sessionName to match the row's key", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c1", pendingPromptText: "untouched" }),
    );

    expect(
      repo.setPendingPromptText("/wrong-project", SESSION_NAME, "c1", "x"),
    ).toBe(false);
    expect(
      repo.setPendingPromptText(PROJECT_PATH, "wrong-session", "c1", "x"),
    ).toBe(false);
    expect(repo.findById("c1")?.pendingPromptText).toBe("untouched");
  });
});

describe("conversations-repo findAll caching", () => {
  it("returns identical references for unchanged rows across calls (cache hit)", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-a" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-b" }),
    );

    const first = repo.findAll();
    const second = repo.findAll();

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i += 1) {
      const a = first[i];
      const b = second[i];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Reference equality proves the cached parsed value was returned, not re-parsed.
      expect(b!.conversation).toBe(a!.conversation);
    }
  });

  it("returns a new reference for a row after upsert mutates it", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-changed", promptCount: 1 }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-stable" }),
    );

    const first = repo.findAll();
    const firstChanged = first.find((r) => r.conversation.id === "c-changed");
    const firstStable = first.find((r) => r.conversation.id === "c-stable");
    expect(firstChanged).toBeDefined();
    expect(firstStable).toBeDefined();

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-changed", promptCount: 99 }),
    );

    const second = repo.findAll();
    const secondChanged = second.find((r) => r.conversation.id === "c-changed");
    const secondStable = second.find((r) => r.conversation.id === "c-stable");
    expect(secondChanged?.conversation.promptCount).toBe(99);
    expect(secondChanged?.conversation).not.toBe(firstChanged!.conversation);
    expect(secondStable?.conversation).toBe(firstStable!.conversation);
  });

  it("returns a new reference after setPendingPromptText mutates a row", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-pp", pendingPromptText: null }),
    );

    const first = repo.findAll();
    const firstEntry = first.find((r) => r.conversation.id === "c-pp");
    expect(firstEntry).toBeDefined();

    repo.setPendingPromptText(PROJECT_PATH, SESSION_NAME, "c-pp", "typed");

    const second = repo.findAll();
    const secondEntry = second.find((r) => r.conversation.id === "c-pp");
    expect(secondEntry?.conversation.pendingPromptText).toBe("typed");
    expect(secondEntry?.conversation).not.toBe(firstEntry!.conversation);
  });

  it("returns the same array reference across calls when no writes occurred", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-a" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-b" }),
    );

    const first = repo.findAll();
    const second = repo.findAll();

    expect(second).toBe(first);
  });

  it("invalidates the array cache after upsert", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-x" }),
    );

    const first = repo.findAll();

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-x", promptCount: 5 }),
    );

    const second = repo.findAll();
    expect(second).not.toBe(first);
    expect(
      second.find((r) => r.conversation.id === "c-x")?.conversation.promptCount,
    ).toBe(5);
  });

  it("invalidates the array cache after setPendingPromptText", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-pp2", pendingPromptText: null }),
    );

    const first = repo.findAll();
    repo.setPendingPromptText(PROJECT_PATH, SESSION_NAME, "c-pp2", "drafted");
    const second = repo.findAll();

    expect(second).not.toBe(first);
    expect(
      second.find((r) => r.conversation.id === "c-pp2")?.conversation
        .pendingPromptText,
    ).toBe("drafted");
  });

  it("drops cache entries when their underlying row is deleted", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-keep" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-drop" }),
    );

    const first = repo.findAll();
    expect(first.map((r) => r.conversation.id).sort()).toEqual([
      "c-drop",
      "c-keep",
    ]);

    repo.delete("c-drop");

    const second = repo.findAll();
    expect(second.map((r) => r.conversation.id)).toEqual(["c-keep"]);

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-drop" }),
    );

    const third = repo.findAll();
    const thirdDrop = third.find((r) => r.conversation.id === "c-drop");
    const firstDrop = first.find((r) => r.conversation.id === "c-drop");
    // Re-inserted row is parsed fresh, not served from stale cache.
    expect(thirdDrop?.conversation).not.toBe(firstDrop!.conversation);
  });
});
