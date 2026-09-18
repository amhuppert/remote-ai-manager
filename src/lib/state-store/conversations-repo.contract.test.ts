import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
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
import { diffChangedConversationColumns } from "./conversation-row-codec";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
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
    // The legacy encoding a pre-feature row reloads with.
    profileSnapshot: null,
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
    // The legacy encoding a pre-feature row reloads with.
    profileSnapshot: null,
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
        id: "q-1-item",
        question: "Continue?",
        context: "short context with `code`",
        options: [
          { label: "yes", recommended: true },
          { label: "no", recommended: false },
        ],
        multiSelect: false,
        required: false,
        allowNote: false,
      },
    ],
    pendingPromptText: "draft prompt text that should round-trip",
    forkedFrom: {
      sourceConversationId: "parent-conv",
      messageIndex: 4,
      sourceBackend: "claude",
      sourceBackendRef: { backend: "claude", ref: "src-sess" },
      forkLocator: "msg-4",
      forkMode: "native",
      syntheticSeed: "User: durable anchored context",
      syntheticSeedAcceptedRef: { backend: "cursor", ref: "agent-seeded" },
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
      cleanupVerificationAttempt: 2,
    },
    agentBackend: "codex",
    backendRef: { backend: "codex", ref: "thr-1" },
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

describe("conversations-repo updateChangedColumnsWithSessionTouch", () => {
  const ALL_COLUMNS = [
    "name",
    "name_origin",
    "transcript_path",
    "status",
    "prompt_count",
    "created_at",
    "last_activity_at",
    "source",
    "summary",
    "archived",
    "total_cost_usd",
    "total_duration_ms",
    "total_turns",
    "pending_question_id",
    "pending_questions",
    "pending_prompt_text",
    "forked_from",
    "role",
    "context_tokens",
    "context_window_max",
    "debug_mode",
    "machine_snapshot",
    "agent_backend",
    "backend_ref",
    "mcp_overrides",
    "mcp_runtime",
    "agent_capability_overrides",
    "agent_capabilities_runtime",
    "unread",
    "pending_queue",
  ] as const;

  function readRow(id: string): Record<string, unknown> {
    return db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Record<string, unknown>;
  }

  it("commits the changed columns and parent session.last_activity_at in one transaction (success)", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1" }),
    );

    const base = repo.findById("c-full")!;
    const next = { ...base, summary: "v2" };
    const changed = diffChangedConversationColumns(base, next);
    expect(Object.keys(changed)).toEqual(["summary"]);

    const newLastActivity = "2026-04-04T04:04:04Z";
    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      newLastActivity,
    );

    expect(repo.findById("c-full")?.summary).toBe("v2");
    expect(repo.findById("c-full")?.lastActivityAt).toBe(newLastActivity);
    const session = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
    expect(session.last_activity_at).toBe(newLastActivity);
  });

  it("leaves every non-changed column byte-identical to the full-upsert baseline across a sequence of single-column writes", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full" }),
    );
    const baseline = readRow("c-full");

    // A sequence of scalar/JSON single-field mutations, each applied via the
    // focused per-column path. After each, only the targeted column (plus
    // last_activity_at) may differ from the prior row state.
    const steps: Array<{
      apply: (c: ConversationState) => ConversationState;
      column: string;
    }> = [
      { apply: (c) => ({ ...c, status: "awaiting" }), column: "status" },
      { apply: (c) => ({ ...c, unread: true }), column: "unread" },
      { apply: (c) => ({ ...c, summary: "changed" }), column: "summary" },
      {
        apply: (c) => ({ ...c, pendingQueue: [] }),
        column: "pending_queue",
      },
    ];

    let prevRow = baseline;
    let activity = 0;
    for (const step of steps) {
      const before = repo.findById("c-full")!;
      const after = step.apply(before);
      const changed = diffChangedConversationColumns(before, after);
      expect(Object.keys(changed)).toEqual([step.column]);

      activity += 1;
      const lastActivityAt = `2026-05-0${activity}T00:00:00Z`;
      repo.updateChangedColumnsWithSessionTouch(
        PROJECT_PATH,
        SESSION_NAME,
        "c-full",
        changed,
        lastActivityAt,
      );

      const newRow = readRow("c-full");
      for (const col of ALL_COLUMNS) {
        if (col === step.column || col === "last_activity_at") continue;
        expect(newRow[col], `column ${col} must be unchanged`).toBe(
          prevRow[col],
        );
      }
      expect(newRow.last_activity_at).toBe(lastActivityAt);
      prevRow = newRow;
    }

    // The big blob columns the focused path must never have re-written stay
    // byte-identical to the very first full-upsert baseline.
    for (const blob of [
      "machine_snapshot",
      "mcp_overrides",
      "mcp_runtime",
      "debug_mode",
      "forked_from",
      "backend_ref",
    ]) {
      expect(readRow("c-full")[blob]).toBe(baseline[blob]);
    }
  });

  it("writes only the named JSON column and never re-serializes co-located blobs", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full" }),
    );
    const baselineMachine = readRow("c-full").machine_snapshot;

    const before = repo.findById("c-full")!;
    const after = {
      ...before,
      pendingQuestions: [
        {
          id: "q-new",
          question: "Proceed?",
          context: "ctx",
          options: [{ label: "ok", recommended: true }],
          multiSelect: false,
          required: false,
          allowNote: false,
        },
      ],
    };
    const changed = diffChangedConversationColumns(before, after);
    expect(Object.keys(changed)).toEqual(["pending_questions"]);

    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      "2026-06-01T00:00:00Z",
    );

    expect(readRow("c-full").machine_snapshot).toBe(baselineMachine);
    expect(repo.findById("c-full")?.pendingQuestions?.[0]?.id).toBe("q-new");
  });

  it("writes both columns when two fields change", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1", promptCount: 1 }),
    );
    const before = repo.findById("c-full")!;
    const after = { ...before, summary: "v2", promptCount: 2 };
    const changed = diffChangedConversationColumns(before, after);
    expect(Object.keys(changed).sort()).toEqual(["prompt_count", "summary"]);

    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      "2026-06-02T00:00:00Z",
    );

    const reloaded = repo.findById("c-full")!;
    expect(reloaded.summary).toBe("v2");
    expect(reloaded.promptCount).toBe(2);
  });

  it("with no changed columns still updates last_activity_at on both row and session", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full" }),
    );
    const before = repo.findById("c-full")!;
    // Reference-identical mutation: nothing changed.
    const changed = diffChangedConversationColumns(before, { ...before });
    expect(Object.keys(changed)).toEqual([]);

    const newLastActivity = "2026-06-03T00:00:00Z";
    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      newLastActivity,
    );

    expect(repo.findById("c-full")?.lastActivityAt).toBe(newLastActivity);
    const session = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
    expect(session.last_activity_at).toBe(newLastActivity);
  });

  it("bumps the findAll cache version so a stale parsed row is not served", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1" }),
    );
    expect(
      repo.findAll().find((r) => r.conversation.id === "c-full")?.conversation
        .summary,
    ).toBe("v1");

    const before = repo.findById("c-full")!;
    const changed = diffChangedConversationColumns(before, {
      ...before,
      summary: "v2",
    });
    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      "2026-06-04T00:00:00Z",
    );

    expect(
      repo.findAll().find((r) => r.conversation.id === "c-full")?.conversation
        .summary,
    ).toBe("v2");
  });

  it("round-trips a full fixture's durability after a focused per-column write", () => {
    const fixture = makeFullConversation({ id: "c-full" });
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const before = repo.findById("c-full")!;
    const changed = diffChangedConversationColumns(before, {
      ...before,
      status: "awaiting",
    });
    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-full",
      changed,
      "2026-06-05T00:00:00Z",
    );

    const reloaded = repo.findById("c-full")!;
    // Every other persisted field of the maximal fixture survived the focused
    // write untouched.
    expect(reloaded).toEqual({
      ...fixture,
      status: "awaiting",
      lastActivityAt: "2026-06-05T00:00:00Z",
    });
  });

  it("rolls back BOTH the column update and the session UPDATE if the transaction aborts", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "original" }),
    );
    const beforeSession = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };

    db.exec(`
      CREATE TRIGGER abort_session_update_cols
      BEFORE UPDATE ON sessions
      WHEN NEW.last_activity_at = '__rollback_marker__'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END
    `);

    try {
      const before = repo.findById("c-full")!;
      const changed = diffChangedConversationColumns(before, {
        ...before,
        summary: "should_not_persist",
      });
      expect(() =>
        repo.updateChangedColumnsWithSessionTouch(
          PROJECT_PATH,
          SESSION_NAME,
          "c-full",
          changed,
          "__rollback_marker__",
        ),
      ).toThrow();

      expect(repo.findById("c-full")?.summary).toBe("original");
      const afterSession = db
        .prepare(
          "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
      expect(afterSession.last_activity_at).toBe(
        beforeSession.last_activity_at,
      );
    } finally {
      db.exec("DROP TRIGGER abort_session_update_cols");
    }
  });
});

describe("conversations-repo updateChangedColumns (no session/activity touch)", () => {
  function readRow(id: string): Record<string, unknown> {
    return db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Record<string, unknown>;
  }

  it("writes only the changed column WITHOUT touching last_activity_at or the session", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1" }),
    );
    const baselineConvActivity = readRow("c-full").last_activity_at;
    const baselineSessionActivity = (
      db
        .prepare(
          "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string }
    ).last_activity_at;

    const before = repo.findById("c-full")!;
    const changed = diffChangedConversationColumns(before, {
      ...before,
      summary: "v2",
    });
    expect(Object.keys(changed)).toEqual(["summary"]);

    repo.updateChangedColumns(PROJECT_PATH, SESSION_NAME, "c-full", changed);

    expect(repo.findById("c-full")?.summary).toBe("v2");
    // Neither the conversation's own activity nor the session's was restamped.
    expect(readRow("c-full").last_activity_at).toBe(baselineConvActivity);
    const sessionAfter = db
      .prepare(
        "SELECT last_activity_at FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .get(PROJECT_PATH, SESSION_NAME) as { last_activity_at: string };
    expect(sessionAfter.last_activity_at).toBe(baselineSessionActivity);
  });

  it("is a no-op when no columns changed", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1" }),
    );
    const baseline = readRow("c-full");

    repo.updateChangedColumns(PROJECT_PATH, SESSION_NAME, "c-full", {});

    expect(readRow("c-full")).toEqual(baseline);
  });

  it("bumps the findAll cache version so a stale parsed row is not served", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-full", summary: "v1" }),
    );
    expect(
      repo.findAll().find((r) => r.conversation.id === "c-full")?.conversation
        .summary,
    ).toBe("v1");

    const before = repo.findById("c-full")!;
    const changed = diffChangedConversationColumns(before, {
      ...before,
      summary: "v2",
    });
    repo.updateChangedColumns(PROJECT_PATH, SESSION_NAME, "c-full", changed);

    expect(
      repo.findAll().find((r) => r.conversation.id === "c-full")?.conversation
        .summary,
    ).toBe("v2");
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

/**
 * Wrap `db.prepare` so every `Statement.all()` execution whose source SQL
 * matches a predicate is counted, proving the cache short-circuits BEFORE the
 * raw SQLite fetch (PERFORMANCE.md §50-62, "short-circuit before raw fetch"),
 * not merely before the Zod parse.
 */
function countingAllStmtDb(
  target: Db,
  sqlMatches: (sql: string) => boolean,
): { count: number } {
  const counter = { count: 0 };
  const realPrepare = target.prepare.bind(target);
  target.prepare = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!sqlMatches(sql)) return stmt;
    const realAll = stmt.all.bind(stmt);
    stmt.all = ((...args: unknown[]) => {
      counter.count += 1;
      return realAll(...args);
    }) as typeof stmt.all;
    return stmt;
  }) as typeof target.prepare;
  return counter;
}

describe("conversations-repo findAll SQL short-circuit (F9)", () => {
  it("does NOT execute the findAll statement on a warm-version cache hit", () => {
    const local = _createTestDb({ inMemory: true });
    local
      .prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`)
      .run(PROJECT_PATH);
    local
      .prepare(
        `INSERT INTO sessions
           (project_path, session_name, worktree_path, branch_name,
            created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        SESSION_NAME,
        `/wt/${SESSION_NAME}`,
        `csm/${SESSION_NAME}`,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    const counter = countingAllStmtDb(local, (sql) =>
      /FROM conversations[\s\S]*ORDER BY project_path ASC, session_name ASC/.test(
        sql,
      ),
    );
    const localRepo = createConversationsRepo(local);
    localRepo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-a" }),
    );
    localRepo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-b" }),
    );

    localRepo.findAll();
    expect(counter.count).toBe(1);

    // Warm hit: version unchanged, so no SQL fetch may run.
    localRepo.findAll();
    expect(counter.count).toBe(1);

    // A mutation bumps the version; the next findAll re-fetches once.
    localRepo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-a", summary: "moved" }),
    );
    localRepo.findAll();
    expect(counter.count).toBe(2);

    local.close();
  });
});

describe("conversations-repo findBySession caching", () => {
  it("returns identical conversation references for unchanged rows across calls (cache hit)", () => {
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

    const first = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    const second = repo.findBySession(PROJECT_PATH, SESSION_NAME);

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i += 1) {
      // Reference equality proves the parsed conversation was reused from the
      // cache, not re-parsed (the whole point of the findBySession cache).
      expect(second[i]).toBe(first[i]);
    }
  });

  it("returns a fresh array each call so in-place sort/push by callers is safe", () => {
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

    const first = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    const second = repo.findBySession(PROJECT_PATH, SESSION_NAME);

    // The array container must NOT be shared: getSessionConversations sorts the
    // result in place, so a shared array would corrupt the cache on first sort.
    expect(second).not.toBe(first);
    first.reverse();
    expect(
      repo.findBySession(PROJECT_PATH, SESSION_NAME).map((c) => c.id),
    ).toEqual(["c-a", "c-b"]);
  });

  it("re-parses only the changed conversation after upsert; siblings keep their reference", () => {
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

    const first = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    const firstChanged = first.find((c) => c.id === "c-changed");
    const firstStable = first.find((c) => c.id === "c-stable");
    expect(firstChanged).toBeDefined();
    expect(firstStable).toBeDefined();

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-changed", promptCount: 99 }),
    );

    const second = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    const secondChanged = second.find((c) => c.id === "c-changed");
    const secondStable = second.find((c) => c.id === "c-stable");
    expect(secondChanged?.promptCount).toBe(99);
    expect(secondChanged).not.toBe(firstChanged);
    expect(secondStable).toBe(firstStable);
  });

  it("does not re-parse this session's conversations when another session is written", () => {
    insertParentSession(PROJECT_PATH, "other");
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeFullConversation({ id: "c-a" }),
    );

    const first = repo.findBySession(PROJECT_PATH, SESSION_NAME);

    // A write to a DIFFERENT session bumps the global cacheVersion, but must not
    // force this session's rows to be re-parsed.
    repo.upsert(PROJECT_PATH, "other", makeMinimalConversation({ id: "c-x" }));

    const second = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(second).toHaveLength(1);
    expect(second[0]).toBe(first[0]);
  });

  it("reflects an upsert with correct content (no stale cache)", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-u", summary: "v1" }),
    );
    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)[0]?.summary).toBe(
      "v1",
    );

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-u", summary: "v2" }),
    );
    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)[0]?.summary).toBe(
      "v2",
    );
  });

  it("reflects a delete (dropped row no longer returned)", () => {
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
    expect(
      repo
        .findBySession(PROJECT_PATH, SESSION_NAME)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c-drop", "c-keep"]);

    repo.delete("c-drop");

    expect(
      repo.findBySession(PROJECT_PATH, SESSION_NAME).map((c) => c.id),
    ).toEqual(["c-keep"]);
  });
});

/**
 * Build a conversation with EVERY introspectable persisted key path populated
 * to a distinctive non-default value, so the schema-driven durability harness
 * can prove no field is dropped on write or reset to its default on read.
 *
 * Every scalar is non-default, every optional/nullable field is present and
 * non-null, every array has a fully-populated representative element, and every
 * record (mcpOverrides.servers, the capability cascades, the runtime cascade
 * maps) has at least one entry whose nested optional fields are all populated.
 */
function buildMaximalConversation(): ConversationState {
  return conversationStateSchema.parse({
    checkpointFork: checkpointForkOriginFixture({
      submission: { backend: "codex", at: "2026-09-12T12:00:00Z" },
    }),
    id: "c-maximal",
    name: "Maximal conversation",
    nameOrigin: "auto",
    transcriptPath: "/tmp/transcripts/c-maximal.jsonl",
    status: "running",
    promptCount: 42,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-02-15T08:09:10Z",
    source: "imported",
    summary: "A maximal durability fixture",
    archived: true,
    totalCostUsd: 12.34,
    totalDurationMs: 56_789,
    totalTurns: 11,
    pendingQuestionId: "q-maximal",
    pendingQuestions: [
      {
        // Non-default required/allowNote and a recommended first option so the
        // durability backstop (which descends into options[0] and rejects
        // schema-default values) actually exercises the grown schema.
        id: "q-maximal-item",
        question: "Continue with the maximal plan?",
        header: "Plan confirmation",
        context:
          "Implications: this **proceeds** with the `maximal` plan.\n- ships sooner\n- less review",
        options: [
          {
            label: "yes",
            description: "proceed as planned",
            recommended: true,
            tradeoff: { pro: "ships now", con: "less review headroom" },
          },
          { label: "no", description: "abort the plan", recommended: false },
        ],
        multiSelect: true,
        required: false,
        allowNote: false,
      },
    ],
    pendingPromptText: "draft prompt text that should round-trip verbatim",
    unread: true,
    forkedFrom: {
      sourceConversationId: "parent-conv",
      messageIndex: 7,
      sourceBackend: "codex",
      sourceBackendRef: { backend: "codex", ref: "src-thread" },
      forkLocator: "msg-7",
      forkMode: "synthetic",
      // Non-default so the column is proven durable. The combination is not a
      // real fork state — a maximal fixture is a shape, not a scenario.
      forkPending: true,
      syntheticSeed: "User: durable fork context",
      syntheticSeedAcceptedRef: { backend: "cursor", ref: "agent-seeded" },
    },
    role: "validator",
    // activeTurnSource is intentionally omitted here (see fieldPolicies):
    // it is transient runtime state with no persistence column.
    contextTokens: 12_345,
    contextWindowMax: 200_000,
    debugMode: {
      active: true,
      debugSessionId: "debug-session-c-maximal",
      recording: true,
      logFilePath: "/tmp/debug/c-maximal.log",
      enteredAt: "2026-01-15T00:00:00Z",
      hypotheses: [
        {
          id: "h1",
          description: "suspected race condition",
          instrumentationPlan: "add timing probes around the lock acquisition",
        },
      ],
      reproductionSteps: ["run the prompt twice in quick succession"],
      fixSummary: "serialized the write queue",
      verificationSteps: ["confirm no duplicate rows after concurrent upserts"],
      instructionsDelivered: true,
      phase: "awaiting_verification",
      lastTurnFailed: true,
      cleanupVerificationAttempt: 2,
    },
    agentBackend: "codex",
    backendRef: { backend: "codex", ref: "thread-maximal" },
    mcpOverrides: {
      servers: {
        stripe: {
          enabled: true,
          tools: {
            charge: { enabled: false },
          },
        },
      },
    },
    mcpRuntime: {
      lastAppliedConfigHash: "hash-applied",
      pendingConfigHash: "hash-pending",
      pendingServerKeys: ["stripe"],
      lastApplyDisposition: "deferred_to_next_turn",
      lastApplyError: "transport handshake timed out",
    },
    agentCapabilityOverrides: {
      cascades: {
        "codex-skills": {
          items: {
            "review-pr": { enabled: false },
          },
        },
      },
    },
    agentCapabilitiesRuntime: {
      cascades: {
        "codex-skills": {
          appliedHash: "cap-applied",
          pendingHash: "cap-pending",
          pendingItemIds: ["review-pr"],
          lastApplyStatus: "staged-next-turn",
          lastApplyError: "discovery refresh required",
        },
      },
    },
    pendingQueue: [
      {
        id: "q-maximal",
        content: [
          { type: "text", text: "queued follow-up that should round-trip" },
          {
            type: "document_feedback",
            items: [
              {
                docPath: ".kiro/specs/x/design.md",
                path: ".kiro/specs/x/design.md",
                headingLabel: "Prompt pipeline extension",
                line: 42,
                quote: "the exact quoted passage that must round-trip",
                note: "queued feedback note that must round-trip",
              },
            ],
          },
          {
            type: "notepad_feedback",
            notepadId: "np-maximal",
            notepadName: "Release plan that must round-trip",
            notepadRefXml:
              '<notepad-ref notepad-id="np-maximal" name="Release plan that must round-trip" scope="global" read-command="cctl notepad get np-maximal" />',
            items: [
              {
                commentId: "npc-maximal",
                location: "§ Rollout · L12",
                quote: "the exact notepad passage that must round-trip",
                body: "dispatched comment body that must round-trip",
              },
            ],
          },
        ],
        status: "delivering",
        enqueuedAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:05:00Z",
        deliveryStartedAt: "2026-03-01T00:04:00Z",
        deliveredAt: "2026-03-01T00:06:00Z",
        cancelledAt: "2026-03-01T00:07:00Z",
        failedAt: "2026-03-01T00:08:00Z",
        deliveryAttemptId: "attempt-maximal",
        attemptCount: 3,
        error: "transient delivery error that should round-trip",
        metadata: {
          kind: "question_answers",
          questionBatchId: "q_maximal",
        },
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    ],
    lastSeenAlignmentVersion: 7,
    pendingAgentNotices: [
      "agent notice that must round-trip (lost background tasks)",
    ],
    profileSnapshot: {
      tier: "global",
      id: "maximal-profile",
      name: "Maximal profile",
      revision: 4,
      sourceContentHash: `sha256:${"1".repeat(64)}`,
      instructions:
        "Private profile instructions that must round-trip verbatim",
      renderedInstructionBlock:
        "<agent-profile>\nPrivate profile instructions that must round-trip verbatim\n</agent-profile>",
      resolvedInstructionHash: `sha256:${"2".repeat(64)}`,
    },
    profileLockedAt: "2026-02-01T09:00:00.000Z",
    owner: {
      kind: "collaboration",
      workflowId: "wf-maximal",
      attemptEpoch: 3,
    },
    turnGeneration: 11,
  });
}

describe("conversations-repo durability contract", () => {
  it("round-trips every persisted conversation key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "conversations",
      schema: conversationStateSchema,
      buildMaximalFixture: buildMaximalConversation,
      persist: (fixture) => {
        repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);
        return fixture;
      },
      reload: (expected) =>
        repo.findByKey(PROJECT_PATH, SESSION_NAME, expected.id),
      fieldPolicies: {
        // `activeTurnSource` is derived from the in-flight XState conversation
        // machine's `activeTurn` (see deriveActiveTurnSource in
        // workflows/conversation/manager.ts). It is transient turn state with
        // no `active_turn_source` column: it is never written and is correctly
        // reset to null on reload. Not a serialization gap — genuinely durable
        // state never includes it.
        activeTurnSource: "not-persisted",
        // The `conversations` table holds session conversations exclusively and
        // has no `scope` column; `scope` is always re-derived as the schema
        // default "session" on read (project conversations live in
        // `project_conversations`). Genuinely not persisted here.
        scope: "not-persisted",
        // `open` and `spawnedSessionIds` are PLC-only fields: session
        // conversations have no such concept and the `conversations` table has
        // no column for either (they live on `project_conversations`). Never
        // written here, correctly absent on reload.
        open: "not-persisted",
        spawnedSessionIds: "not-persisted",
        // Also PLC-only: only the project create-and-send entry creates a
        // conversation whose requesting client cannot name it yet, so only
        // `project_conversations` carries the creating submission's token. A
        // session conversation exists before any prompt targets it.
        creationRequestId: "not-persisted",
      },
    });
  });
});

describe("conversations-repo backend-ref canonical encoding (raw bytes)", () => {
  // The on-disk shape is canonical `{backend, ref}` — no mirrored
  // sessionId/threadId key. The ref-shape cutover bumps KNOWN_SCHEMA_VERSION,
  // so an older build sharing CC_CONFIG_DIR is refused on open rather than
  // expected to parse a legacy handle out of backend_ref /
  // forked_from.sourceBackendRef.
  function rawColumns(id: string): {
    backend_ref: string | null;
    forked_from: string | null;
  } {
    return db
      .prepare(
        `SELECT backend_ref, forked_from FROM conversations WHERE id = ?`,
      )
      .get(id) as { backend_ref: string | null; forked_from: string | null };
  }

  it("persists a codex backendRef as canonical bytes with no mirrored threadId", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "c-canon-codex",
        agentBackend: "codex",
        backendRef: { backend: "codex", ref: "thr-canon" },
      }),
    );

    const raw = rawColumns("c-canon-codex");
    expect(raw.backend_ref).not.toBeNull();
    expect(JSON.parse(raw.backend_ref!)).toEqual({
      backend: "codex",
      ref: "thr-canon",
    });
  });

  it("persists a claude backendRef as canonical bytes with no mirrored sessionId", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "c-canon-claude",
        backendRef: { backend: "claude", ref: "sess-canon" },
      }),
    );

    const raw = rawColumns("c-canon-claude");
    expect(JSON.parse(raw.backend_ref!)).toEqual({
      backend: "claude",
      ref: "sess-canon",
    });
  });

  it("persists forkedFrom.sourceBackendRef as canonical bytes", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "c-canon-fork",
        forkedFrom: {
          sourceConversationId: "parent-conv",
          messageIndex: 2,
          sourceBackend: "claude",
          sourceBackendRef: { backend: "claude", ref: "src-canon" },
          forkLocator: "msg-2",
          forkMode: "native",
          forkPending: false,
        },
      }),
    );

    const raw = rawColumns("c-canon-fork");
    expect(raw.forked_from).not.toBeNull();
    const forkedFrom = JSON.parse(raw.forked_from!) as {
      sourceBackendRef: unknown;
    };
    expect(forkedFrom.sourceBackendRef).toEqual({
      backend: "claude",
      ref: "src-canon",
    });
  });

  it("writes canonical bytes through the focused per-column update path too", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-canon-diff" }),
    );
    const before = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-canon-diff")!;
    const after: ConversationState = {
      ...before,
      backendRef: { backend: "codex", ref: "thr-diff" },
    };
    const changed = diffChangedConversationColumns(before, after);
    expect(Object.keys(changed)).toEqual(["backend_ref"]);

    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-canon-diff",
      changed,
      "2026-06-04T00:00:00Z",
    );

    const raw = rawColumns("c-canon-diff");
    expect(JSON.parse(raw.backend_ref!)).toEqual({
      backend: "codex",
      ref: "thr-diff",
    });
  });

  it("quarantines a noncanonical backend_ref without dropping its conversation", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-legacy-writer" }),
    );
    db.prepare(`UPDATE conversations SET backend_ref = ? WHERE id = ?`).run(
      JSON.stringify({ backend: "codex", threadId: "thr-old-build" }),
      "c-legacy-writer",
    );

    const loaded = repo.findByKey(
      PROJECT_PATH,
      SESSION_NAME,
      "c-legacy-writer",
    );
    expect(loaded?.id).toBe("c-legacy-writer");
    expect(loaded?.backendRef).toBeNull();
  });
});

describe("conversations-repo forward quarantine of unparseable ref columns", () => {
  it("degrades an unparseable backend_ref to null and keeps the rest of the row", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-quarantine-ref", summary: null }),
    );
    db.prepare(
      `UPDATE conversations SET backend_ref = ?, summary = ? WHERE id = ?`,
    ).run(
      JSON.stringify({ backend: "claude", futureShape: { nested: true } }),
      "still readable",
      "c-quarantine-ref",
    );

    const loaded = repo.findByKey(
      PROJECT_PATH,
      SESSION_NAME,
      "c-quarantine-ref",
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.backendRef).toBeNull();
    expect(loaded?.summary).toBe("still readable");
  });

  it("degrades an unparseable forked_from to null and keeps the rest of the row", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-quarantine-fork" }),
    );
    db.prepare(`UPDATE conversations SET forked_from = ? WHERE id = ?`).run(
      JSON.stringify({ sourceConversationId: 42 }),
      "c-quarantine-fork",
    );

    const loaded = repo.findByKey(
      PROJECT_PATH,
      SESSION_NAME,
      "c-quarantine-fork",
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.forkedFrom).toBeNull();
  });

  it("still lists every sibling conversation when one row has a bad backend_ref", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "c-good",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({
        id: "c-bad",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    db.prepare(`UPDATE conversations SET backend_ref = ? WHERE id = ?`).run(
      "not-json",
      "c-bad",
    );

    const listed = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(listed.map((c) => c.id)).toEqual(["c-good", "c-bad"]);
    expect(listed[1]?.backendRef).toBeNull();
  });
});

describe("conversations-repo pendingQueue durability", () => {
  it("round-trips a pending queued message through upsert/findByKey", () => {
    const entry = {
      id: "q1",
      content: [{ type: "text" as const, text: "queued follow-up" }],
      status: "pending" as const,
      enqueuedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deliveryStartedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      deliveryAttemptId: null,
      attemptCount: 0,
      error: null,
      metadata: null,
    };

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-queue", pendingQueue: [entry] }),
    );

    const loaded = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-queue");
    expect(loaded?.pendingQueue.map((e) => e.id)).toEqual(["q1"]);
  });
});

describe("conversations-repo lastSeenAlignmentVersion durability", () => {
  it("round-trips a non-null seen-version through upsert/findByKey", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-seen", lastSeenAlignmentVersion: 3 }),
    );

    const loaded = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-seen");
    expect(loaded?.lastSeenAlignmentVersion).toBe(3);
  });

  it("preserves the null default for a conversation that has seen no charter", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-unseen" }),
    );

    const loaded = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-unseen");
    expect(loaded?.lastSeenAlignmentVersion).toBeNull();
  });

  it("advances the seen-version through the focused per-column update path", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeMinimalConversation({ id: "c-advance", lastSeenAlignmentVersion: 1 }),
    );
    const before = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-advance")!;
    const after = { ...before, lastSeenAlignmentVersion: 2 };
    const changed = diffChangedConversationColumns(before, after);
    expect(Object.keys(changed)).toEqual(["last_seen_alignment_version"]);

    repo.updateChangedColumnsWithSessionTouch(
      PROJECT_PATH,
      SESSION_NAME,
      "c-advance",
      changed,
      "2026-06-04T00:00:00Z",
    );

    const reloaded = repo.findByKey(PROJECT_PATH, SESSION_NAME, "c-advance");
    expect(reloaded?.lastSeenAlignmentVersion).toBe(2);
  });
});

describe("conversations-repo profile snapshot durability", () => {
  it("reloads the full private snapshot from SQLite byte-for-byte", () => {
    const fixture = buildMaximalConversation();
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const out = repo.findByKey(PROJECT_PATH, SESSION_NAME, fixture.id);
    expect(out?.profileSnapshot).toEqual(fixture.profileSnapshot);
    expect(out?.profileSnapshot?.renderedInstructionBlock).toBe(
      fixture.profileSnapshot?.renderedInstructionBlock,
    );
    expect(out?.profileLockedAt).toBe(fixture.profileLockedAt);
  });

  it("reloads the no-op default's snapshot as a record, not as an absence", () => {
    // The no-op default is the common case, and its stored block is the empty
    // string. Reloading it must yield a full snapshot — an empty block that
    // decoded as "no profile" would erase the conversation's provenance and
    // make its header lie about which agent it is running.
    const fixture = makeMinimalConversation({
      id: "c-noop-profile",
      profileSnapshot: NO_OP_SNAPSHOT_FIXTURE,
      profileLockedAt: "2026-02-01T09:00:00.000Z",
    });
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const out = repo.findByKey(PROJECT_PATH, SESSION_NAME, fixture.id);

    expect(out?.profileSnapshot).not.toBeNull();
    expect(out?.profileSnapshot?.instructions).toBe("");
    expect(out?.profileSnapshot?.renderedInstructionBlock).toBe("");
    expect(out?.profileSnapshot?.sourceContentHash).toBe(
      computeContentHash(""),
    );
    expect(out?.profileSnapshot?.resolvedInstructionHash).toBe(
      computeContentHash(""),
    );
    // The identity every read surface renders from.
    expect(out?.profileSnapshot?.tier).toBe("builtin");
    expect(out?.profileSnapshot?.id).toBe(STANDARD_AGENT_PROFILE_ID);
    expect(out?.profileSnapshot?.name).toBe("Standard Agent");
    expect(out?.profileLockedAt).toBe("2026-02-01T09:00:00.000Z");
  });

  it("reloads a pre-feature row (null columns) as the legacy no-profile shape", () => {
    // The row a conversation created before this feature leaves behind: both
    // columns absent from the INSERT, i.e. NULL on disk, with no backfill.
    const legacy = makeMinimalConversation({ id: "legacy-session-conv" });
    repo.upsert(PROJECT_PATH, SESSION_NAME, legacy);
    db.prepare(
      `UPDATE conversations
       SET profile_snapshot = NULL, profile_locked_at = NULL
       WHERE id = ?`,
    ).run(legacy.id);

    const out = repo.findByKey(PROJECT_PATH, SESSION_NAME, legacy.id);
    expect(out).not.toBeNull();
    expect(out?.profileSnapshot).toBeNull();
    expect(out?.profileLockedAt).toBeNull();
  });
});

it("round trips a checkpoint fork without related work", () => {
  const conversation = buildMaximalConversation();
  conversation.checkpointFork = checkpointForkOriginFixture({
    relatedWork: null,
  });
  repo.upsert(PROJECT_PATH, SESSION_NAME, conversation);
  expect(
    repo.findByKey(PROJECT_PATH, SESSION_NAME, conversation.id)?.checkpointFork,
  ).toEqual(conversation.checkpointFork);
});
