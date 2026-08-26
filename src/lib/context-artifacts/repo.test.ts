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
import { _createTestDb } from "@/lib/state-store/state-db";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/projects/alpha";
const SESSION_NAME = "csm-session-a";

function buildEnvelope(
  overrides: Partial<CompactionEnvelope> = {},
): CompactionEnvelope {
  return {
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "alpha",
      sessionName: SESSION_NAME,
      conversationId: "conv-1",
      coveredStartSeq: 0,
      coveredEndSeq: 41,
      messageCount: 12,
      sourceHash: "hash-abc",
    },
    agentBrief: "Implemented the widget; tests green.",
    currentState: {
      status: "implementation_in_progress",
      latestUserGoal: "Ship the widget",
      nextBestActions: ["run the suite"],
    },
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
    omissions: { reasoningOmitted: false, largeToolOutputsElided: 0 },
    extras: {},
    ...overrides,
  };
}

function buildRow(
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  return {
    id: "artifact-1",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: "conv-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 41,
    sourceHash: "hash-abc",
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "max" },
    },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "p1",
    normalizerVersion: "n1",
    createdBy: "user",
    createdByConversationId: null,
    payload: buildEnvelope(),
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}

function buildMessageRow(
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  return buildRow({
    id: "artifact-msg-1",
    kind: "message_compaction",
    messageId: "msg-7",
    messageIndex: 7,
    payload: buildEnvelope({ kind: "message_compaction" }),
    ...overrides,
  });
}

function countRows(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM context_artifacts`)
    .get() as { n: number };
  return row.n;
}

let db: Db;
let repo: ContextArtifactsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  repo = createContextArtifactsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("upsert + findById", () => {
  it("round-trips a full row including the parsed payload", () => {
    const row = buildRow();
    repo.upsert(row);
    expect(repo.findById(row.id)).toEqual(row);
  });

  it("round-trips a pending row with a null payload", () => {
    const row = buildRow({ id: "pending-1", status: "pending", payload: null });
    repo.upsert(row);
    expect(repo.findById("pending-1")).toEqual(row);
  });

  it("returns null for an unknown id", () => {
    expect(repo.findById("nope")).toBeNull();
  });

  it("updates in place when the same id is upserted again", () => {
    repo.upsert(buildRow({ status: "pending", payload: null }));
    const updated = buildRow({ status: "complete" });
    repo.upsert(updated);
    expect(countRows(db)).toBe(1);
    expect(repo.findById(updated.id)).toEqual(updated);
  });
});

describe("conversation_compaction partial-unique upsert", () => {
  it("replaces the existing row for the same conversation even with a new id", () => {
    repo.upsert(buildRow({ id: "gen-1" }));
    const regenerated = buildRow({
      id: "gen-2",
      coveredEndSeq: 99,
      updatedAt: "2026-07-05T11:00:00.000Z",
    });
    repo.upsert(regenerated);

    expect(countRows(db)).toBe(1);
    expect(repo.findById("gen-1")).toBeNull();
    expect(repo.findById("gen-2")).toEqual(regenerated);
  });

  it("inserts separate rows for different conversations", () => {
    repo.upsert(buildRow({ id: "a", conversationId: "conv-1" }));
    repo.upsert(buildRow({ id: "b", conversationId: "conv-2" }));
    expect(countRows(db)).toBe(2);
  });
});

describe("message_compaction partial-unique upsert", () => {
  it("replaces the existing row for the same (conversation, messageIndex)", () => {
    repo.upsert(buildMessageRow({ id: "m1" }));
    const regenerated = buildMessageRow({ id: "m2", sourceHash: "hash-2" });
    repo.upsert(regenerated);

    expect(countRows(db)).toBe(1);
    expect(repo.findById("m1")).toBeNull();
    expect(repo.findById("m2")).toEqual(regenerated);
  });

  it("inserts separate rows for different message indexes in one conversation", () => {
    repo.upsert(buildMessageRow({ id: "m1", messageIndex: 3 }));
    repo.upsert(buildMessageRow({ id: "m2", messageIndex: 4 }));
    expect(countRows(db)).toBe(2);
  });

  it("keeps rows for the same message index across different conversations", () => {
    repo.upsert(buildMessageRow({ id: "m1", conversationId: "conv-1" }));
    repo.upsert(buildMessageRow({ id: "m2", conversationId: "conv-2" }));
    expect(countRows(db)).toBe(2);
  });

  it("does not cross-fire with the conversation_compaction index", () => {
    repo.upsert(buildRow({ id: "conv-artifact" }));
    repo.upsert(buildMessageRow({ id: "msg-artifact" }));
    expect(countRows(db)).toBe(2);
    expect(repo.findById("conv-artifact")).not.toBeNull();
    expect(repo.findById("msg-artifact")).not.toBeNull();
  });
});

describe("finders", () => {
  it("findByConversation returns the conversation artifact then messages by index", () => {
    repo.upsert(buildMessageRow({ id: "m9", messageIndex: 9, messageId: "e" }));
    repo.upsert(buildRow({ id: "conv-artifact" }));
    repo.upsert(buildMessageRow({ id: "m2", messageIndex: 2, messageId: "b" }));
    repo.upsert(buildRow({ id: "other", conversationId: "conv-other" }));

    const found = repo.findByConversation("conv-1");
    expect(found.map((r) => r.id)).toEqual(["conv-artifact", "m2", "m9"]);
  });

  it("findMessageArtifact returns only the matching message artifact", () => {
    repo.upsert(buildRow({ id: "conv-artifact" }));
    repo.upsert(buildMessageRow({ id: "m7", messageIndex: 7 }));

    expect(repo.findMessageArtifact("conv-1", 7)?.id).toBe("m7");
    expect(repo.findMessageArtifact("conv-1", 8)).toBeNull();
    expect(repo.findMessageArtifact("conv-other", 7)).toBeNull();
  });

  it("findByConversationIds batches across ids and returns [] for empty input", () => {
    repo.upsert(buildRow({ id: "a", conversationId: "conv-1" }));
    repo.upsert(buildRow({ id: "b", conversationId: "conv-2" }));
    repo.upsert(buildRow({ id: "c", conversationId: "conv-3" }));

    expect(repo.findByConversationIds([])).toEqual([]);
    const found = repo.findByConversationIds(["conv-1", "conv-3", "conv-x"]);
    expect(found.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("findByScope narrows by session and includes NULL-session rows project-wide", () => {
    repo.upsert(buildRow({ id: "s1" }));
    repo.upsert(
      buildRow({
        id: "s2",
        conversationId: "conv-2",
        sessionName: "other-session",
      }),
    );
    repo.upsert(
      buildRow({
        id: "p1",
        conversationId: "conv-3",
        scope: "project",
        sessionName: null,
      }),
    );
    repo.upsert(
      buildRow({
        id: "elsewhere",
        conversationId: "conv-4",
        projectPath: "/projects/beta",
      }),
    );

    const projectWide = repo.findByScope(PROJECT_PATH);
    expect(projectWide.map((r) => r.id).sort()).toEqual(["p1", "s1", "s2"]);

    const oneSession = repo.findByScope(PROJECT_PATH, SESSION_NAME);
    expect(oneSession.map((r) => r.id)).toEqual(["s1"]);
  });
});

describe("deletes", () => {
  it("deleteByConversation removes only that conversation's artifacts and reports the count", () => {
    repo.upsert(buildRow({ id: "a" }));
    repo.upsert(buildMessageRow({ id: "m" }));
    repo.upsert(buildRow({ id: "other", conversationId: "conv-other" }));

    expect(repo.deleteByConversation("conv-1")).toBe(2);
    expect(countRows(db)).toBe(1);
    expect(repo.findById("other")).not.toBeNull();
  });

  it("deleteByScope with a session removes only that session's rows", () => {
    repo.upsert(buildRow({ id: "s1" }));
    repo.upsert(
      buildRow({
        id: "s2",
        conversationId: "conv-2",
        sessionName: "other-session",
      }),
    );

    expect(repo.deleteByScope(PROJECT_PATH, SESSION_NAME)).toBe(1);
    expect(repo.findById("s1")).toBeNull();
    expect(repo.findById("s2")).not.toBeNull();
  });

  it("deleteByScope without a session removes every row for the project", () => {
    repo.upsert(buildRow({ id: "s1" }));
    repo.upsert(
      buildRow({
        id: "p1",
        conversationId: "conv-3",
        scope: "project",
        sessionName: null,
      }),
    );
    repo.upsert(
      buildRow({
        id: "elsewhere",
        conversationId: "conv-4",
        projectPath: "/projects/beta",
      }),
    );

    expect(repo.deleteByScope(PROJECT_PATH)).toBe(2);
    expect(countRows(db)).toBe(1);
    expect(repo.findById("elsewhere")).not.toBeNull();
  });
});

describe("failPendingRuns", () => {
  it("marks every pending row failed with the given error and leaves other rows untouched", () => {
    repo.upsert(
      buildRow({
        id: "pending-a",
        conversationId: "conv-a",
        status: "pending",
        payload: null,
      }),
    );
    repo.upsert(
      buildMessageRow({
        id: "pending-b",
        conversationId: "conv-b",
        status: "pending",
        payload: null,
      }),
    );
    repo.upsert(buildRow({ id: "complete-c", conversationId: "conv-c" }));
    repo.upsert(
      buildRow({
        id: "failed-d",
        conversationId: "conv-d",
        status: "failed",
        error: "boom",
        payload: null,
      }),
    );

    const swept = repo.failPendingRuns(
      "interrupted by server restart",
      "2026-07-05T11:00:00.000Z",
    );

    expect(swept).toBe(2);
    expect(repo.findById("pending-a")).toMatchObject({
      status: "failed",
      error: "interrupted by server restart",
      updatedAt: "2026-07-05T11:00:00.000Z",
    });
    expect(repo.findById("pending-b")).toMatchObject({
      status: "failed",
      error: "interrupted by server restart",
    });
    expect(repo.findById("complete-c")).toMatchObject({
      status: "complete",
      error: null,
      updatedAt: "2026-07-05T10:00:00.000Z",
    });
    expect(repo.findById("failed-d")).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("returns 0 when no rows are pending", () => {
    repo.upsert(buildRow());
    expect(
      repo.failPendingRuns(
        "interrupted by server restart",
        "2026-07-05T11:00:00.000Z",
      ),
    ).toBe(0);
  });
});

describe("updateChangedColumns", () => {
  it("writes only the provided fields and returns true on change", () => {
    const row = buildRow({ status: "pending", payload: null });
    repo.upsert(row);

    const payload = buildEnvelope({ agentBrief: "Regenerated brief." });
    const changed = repo.updateChangedColumns(row.id, {
      status: "complete",
      payload,
      updatedAt: "2026-07-05T12:00:00.000Z",
    });

    expect(changed).toBe(true);
    expect(repo.findById(row.id)).toEqual({
      ...row,
      status: "complete",
      payload,
      updatedAt: "2026-07-05T12:00:00.000Z",
    });
  });

  it("sets nullable fields to null explicitly", () => {
    repo.upsert(buildRow({ status: "failed", error: "boom", payload: null }));
    const changed = repo.updateChangedColumns("artifact-1", {
      status: "pending",
      error: null,
    });
    expect(changed).toBe(true);
    const found = repo.findById("artifact-1");
    expect(found?.status).toBe("pending");
    expect(found?.error).toBeNull();
  });

  it("returns false for an unknown id or an empty patch", () => {
    repo.upsert(buildRow());
    expect(repo.updateChangedColumns("missing", { status: "failed" })).toBe(
      false,
    );
    expect(repo.updateChangedColumns("artifact-1", {})).toBe(false);
  });
});

describe("corrupt payload handling", () => {
  it("surfaces a failed-shaped row instead of throwing when payload_json is invalid", () => {
    const row = buildRow();
    repo.upsert(row);
    db.prepare(
      `UPDATE context_artifacts SET payload_json = ? WHERE id = ?`,
    ).run(`{"schemaVersion":`, row.id);

    const found = repo.findById(row.id);
    expect(found).not.toBeNull();
    expect(found?.status).toBe("failed");
    expect(found?.payload).toBeNull();
    expect(found?.error).toContain("payload_json");
  });

  it("surfaces a failed-shaped row when payload_json fails envelope validation", () => {
    const row = buildRow();
    repo.upsert(row);
    db.prepare(
      `UPDATE context_artifacts SET payload_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ schemaVersion: 99 }), row.id);

    const found = repo.findById(row.id);
    expect(found?.status).toBe("failed");
    expect(found?.payload).toBeNull();
  });
});
