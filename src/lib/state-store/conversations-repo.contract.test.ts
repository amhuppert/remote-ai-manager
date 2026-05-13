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
import { conversationStateSchema } from "../schemas";
import type { ConversationState } from "@/types";

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
