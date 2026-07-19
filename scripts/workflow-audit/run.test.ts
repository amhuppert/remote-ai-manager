import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { _createTestDb } from "../../src/lib/state-store/state-db";
import { buildAuditReport } from "./core";
import {
  listExecutions,
  loadAuditInput,
  parseAuditCliArgs,
  resolveFinalPublish,
} from "./run";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo/example";
const SESSION_NAME = "feature-x";
const ACTIVE_ID = "exec-active";
const ARCHIVED_ID = "exec-archived";

let db: Db;
let logsBaseDir: string;

function seed(): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name,
        created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    "/wt/feature-x",
    "csm/feature-x",
    "2026-07-01T00:00:00Z",
    "2026-07-04T12:00:00Z",
  );

  const definitionTier = {
    id: ACTIVE_ID,
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 3,
    startedAt: "2026-07-04T10:00:00.000Z",
    workingDefinition: {
      executionContexts: [{ id: "impl", title: "Implement" }],
    },
    charter: { mission: "x" },
  };
  const runtimeTier = {
    status: "completed",
    completedAt: "2026-07-04T12:00:00.000Z",
    contextStates: {
      impl: {
        status: "completed",
        totalTaskCount: 1,
        completedTaskCount: 1,
        iterationCount: 1,
      },
    },
    taskStates: {
      t1: {
        taskId: "t1",
        contextId: "impl",
        status: "completed",
        lastConversationId: "conv-1",
      },
    },
    laneStates: {},
    joins: {
      "join-publish": {
        joinId: "join-publish",
        kind: "final_publish",
        status: "succeeded",
        sourceLaneIds: ["impl"],
        conflicts: null,
      },
    },
  };
  db.prepare(
    `INSERT INTO graph_workflow_executions
       (project_path, session_name, execution_id, seed_definition_id,
        seed_definition_revision, started_at, status, completed_at,
        definition_json, runtime_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    ACTIVE_ID,
    "def-1",
    3,
    "2026-07-04T10:00:00.000Z",
    "completed",
    "2026-07-04T12:00:00.000Z",
    JSON.stringify(definitionTier),
    JSON.stringify(runtimeTier),
    "2026-07-04T12:00:00.000Z",
  );

  db.prepare(
    `INSERT INTO graph_workflow_archived_executions
       (project_path, session_name, execution_id, archived_at, status,
        started_at, completed_at, execution_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    ARCHIVED_ID,
    "2026-07-03T09:00:00.000Z",
    "halted",
    "2026-07-03T08:00:00.000Z",
    null,
    JSON.stringify({
      id: ARCHIVED_ID,
      seedDefinitionId: "def-0",
      seedDefinitionRevision: 1,
      startedAt: "2026-07-03T08:00:00.000Z",
      status: "halted",
      haltReason: { type: "recovery_error", message: "boom" },
    }),
  );

  const validationEvent = {
    type: "graph-workflow-validation-result",
    executionId: ACTIVE_ID,
    contextId: "impl",
    validatorType: "context",
    pass: true,
    summary: "ok",
    reopenTaskIds: [],
    issues: [],
    sessionRef: {
      engine: "claude",
      lane: "context_validator",
      conversationId: "conv-2",
    },
  };
  db.prepare(
    `INSERT INTO graph_workflow_events
       (project_path, session_name, execution_id, occurred_at, event_type,
        context_id, pre_reset, event_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    ACTIVE_ID,
    "2026-07-04T11:00:00.000Z",
    validationEvent.type,
    "impl",
    JSON.stringify(validationEvent),
  );

  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, project_path, session_name, status, created_at, last_activity_at,
        total_cost_usd, total_turns, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertConversation.run(
    "conv-1",
    PROJECT_PATH,
    SESSION_NAME,
    "completed",
    "2026-07-04T10:00:00Z",
    "2026-07-04T11:00:00Z",
    3.5,
    12,
    "/transcripts/conv-1.jsonl",
  );
  insertConversation.run(
    "conv-2",
    PROJECT_PATH,
    SESSION_NAME,
    "completed",
    "2026-07-04T11:00:00Z",
    "2026-07-04T11:30:00Z",
    1.25,
    3,
    null,
  );

  const contextDir = path.join(logsBaseDir, ACTIVE_ID, "contexts", "impl");
  mkdirSync(path.join(contextDir, "prompts"), { recursive: true });
  writeFileSync(
    path.join(contextDir, "iterations.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-04T10:00:05.000Z",
        event: "iteration.started",
        iterationNumber: 1,
      }),
      "this line is garbage",
      JSON.stringify({
        timestamp: "2026-07-04T10:40:00.000Z",
        event: "iteration.completed",
        iterationNumber: 1,
      }),
    ].join("\n"),
  );
  writeFileSync(
    path.join(contextDir, "prompts", "1.json"),
    JSON.stringify({ raw: "x", parsed: {}, parsePath: "structured_output" }),
  );
  writeFileSync(
    path.join(contextDir, "prompts", "2.json"),
    JSON.stringify({ raw: "y", parsed: {}, parsePath: "raw_json" }),
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  logsBaseDir = mkdtempSync(path.join(tmpdir(), "wf-audit-test-"));
  seed();
});

afterEach(() => {
  db.close();
  rmSync(logsBaseDir, { recursive: true, force: true });
});

describe("parseAuditCliArgs", () => {
  it("parses selector and output flags", () => {
    const options = parseAuditCliArgs([
      "--execution",
      "abc",
      "--json",
      "--config-dir",
      "/cfg",
    ]);
    expect(options.execution).toBe("abc");
    expect(options.json).toBe(true);
    expect(options.configDir).toBe("/cfg");
    expect(options.list).toBe(false);
  });

  it("rejects unknown flags", () => {
    expect(() => parseAuditCliArgs(["--bogus"])).toThrow();
  });
});

describe("loadAuditInput", () => {
  it("loads an active execution by id with events, conversations, and logs", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: "/transcripts" },
      { executionId: ACTIVE_ID },
    );
    expect(input).not.toBeNull();
    if (input === null) return;
    expect(input.source).toBe("active");
    expect(input.execution.id).toBe(ACTIVE_ID);
    expect(input.execution.status).toBe("completed");
    expect(input.events).toHaveLength(1);
    expect(input.events[0]?.type).toBe("graph-workflow-validation-result");

    const ids = input.conversations.map((c) => c.id).sort();
    expect(ids).toEqual(["conv-1", "conv-2"]);
    const conv2 = input.conversations.find((c) => c.id === "conv-2");
    expect(conv2?.transcriptPath).toBe("/transcripts/conv-2.jsonl");

    const implLogs = input.contextLogs.impl;
    expect(implLogs?.iterations).toHaveLength(2);
    expect(implLogs?.validatorResponses).toEqual([
      { file: "1.json", parsePath: "structured_output" },
      { file: "2.json", parsePath: "raw_json" },
    ]);
    expect(input.paths.workflowLogsDir).toBe(path.join(logsBaseDir, ACTIVE_ID));
  });

  it("falls back to the archived table by execution id", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ARCHIVED_ID },
    );
    expect(input).not.toBeNull();
    expect(input?.source).toBe("archived");
    expect(input?.execution.haltReason?.type).toBe("recovery_error");
    expect(input?.paths.workflowLogsDir).toBeNull();
  });

  it("resolves the active execution for a project/session selector", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { projectPath: PROJECT_PATH, sessionName: SESSION_NAME },
    );
    expect(input?.execution.id).toBe(ACTIVE_ID);
  });

  it("returns null for an unknown execution", () => {
    expect(
      loadAuditInput(
        { db, logsBaseDir, transcriptsDir: null },
        { executionId: "nope" },
      ),
    ).toBeNull();
  });

  it("loads execution-level lifecycle and decision records", () => {
    const executionDir = path.join(logsBaseDir, ACTIVE_ID);
    writeFileSync(
      path.join(executionDir, "lifecycle.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-04T10:50:00.000Z",
          event: "execution.halted",
          haltReason: { type: "join_failure", contextId: "impl" },
        }),
        JSON.stringify({
          timestamp: "2026-07-04T11:05:00.000Z",
          event: "execution.resumed",
          previousStatus: "halted",
        }),
      ].join("\n"),
    );
    writeFileSync(
      path.join(executionDir, "decisions.jsonl"),
      JSON.stringify({
        timestamp: "2026-07-04T10:30:00.000Z",
        event: "rotation.scheduled",
        contextId: "impl",
        reason: "context_over_limit",
      }),
    );
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ACTIVE_ID },
    );
    expect(input?.lifecycle).toHaveLength(2);
    expect(input?.lifecycle?.[0]?.event).toBe("execution.halted");
    expect(input?.decisions).toHaveLength(1);
    expect(input?.decisions?.[0]?.fields.contextId).toBe("impl");

    const report = buildAuditReport(input!);
    expect(report.time.haltRecoveries).toHaveLength(1);
    expect(report.time.operatorRecoveryWaitMsTotal).toBe(15 * 60 * 1000);
  });

  it("feeds buildAuditReport end to end", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: "/transcripts" },
      { executionId: ACTIVE_ID },
    );
    expect(input).not.toBeNull();
    if (input === null) return;
    const report = buildAuditReport(input);
    expect(report.overview.executionId).toBe(ACTIVE_ID);
    expect(report.cost.totalUsd).toBeCloseTo(4.75);
    const impl = report.contexts.find((c) => c.contextId === "impl");
    expect(impl?.iterations).toHaveLength(1);
    expect(impl?.parseFallbacks).toEqual([
      { file: "2.json", parsePath: "raw_json" },
    ]);
  });
});

describe("transcript scanning in the loader", () => {
  it("scans readable transcripts into transcriptScan and skips missing files", () => {
    const transcriptPath = path.join(logsBaseDir, "conv-1.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "result",
          raw: { total_cost_usd: 1.5, num_turns: 4, session_id: "s1" },
        }),
        JSON.stringify({
          type: "result",
          raw: { total_cost_usd: 2.25, num_turns: 3, session_id: "s1" },
        }),
      ].join("\n"),
    );
    db.prepare(`UPDATE conversations SET transcript_path = ? WHERE id = ?`).run(
      transcriptPath,
      "conv-1",
    );

    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ACTIVE_ID },
    );
    expect(input).not.toBeNull();
    if (input === null) return;
    const conv1 = input.conversations.find((c) => c.id === "conv-1");
    expect(conv1?.transcriptScan?.costUsd).toBeCloseTo(2.25);
    expect(conv1?.transcriptScan?.apiTurns).toBe(7);
    const conv2 = input.conversations.find((c) => c.id === "conv-2");
    expect(conv2?.transcriptScan ?? null).toBeNull();
  });
});

describe("resolveFinalPublish", () => {
  it("resolves the final_publish join commit and parses its numstat", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ACTIVE_ID },
    );
    expect(input).not.toBeNull();
    if (input === null) return;

    const gitCalls: string[][] = [];
    const runGit = (args: string[]): string | null => {
      gitCalls.push(args);
      if (args[0] === "log") return "abc123def456\n";
      if (args[0] === "show") return "10\t2\tsrc/a.ts\n5\t0\t.cc/x.log\n";
      return null;
    };
    const publish = resolveFinalPublish(input.execution, "/repo/example", {
      runGit,
    });
    expect(publish).toEqual({
      commitSha: "abc123def456",
      files: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: ".cc/x.log", additions: 5, deletions: 0 },
      ],
    });
    expect(gitCalls[0]).toContain("--grep=join-publish");
  });

  it("returns null when no final_publish join succeeded or git fails", () => {
    const input = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ARCHIVED_ID },
    );
    expect(input).not.toBeNull();
    if (input === null) return;
    // The archived execution has no joins at all.
    expect(
      resolveFinalPublish(input.execution, "/repo/example", {
        runGit: () => "never-called",
      }),
    ).toBeNull();

    const active = loadAuditInput(
      { db, logsBaseDir, transcriptsDir: null },
      { executionId: ACTIVE_ID },
    );
    if (active === null) return;
    expect(
      resolveFinalPublish(active.execution, "/repo/example", {
        runGit: () => null,
      }),
    ).toBeNull();
  });

  it("is wired into loadAuditInput when a runGit dep is provided", () => {
    const input = loadAuditInput(
      {
        db,
        logsBaseDir,
        transcriptsDir: null,
        runGit: (args) =>
          args[0] === "log" ? "fedcba98\n" : "1\t0\tsrc/b.ts\n",
      },
      { executionId: ACTIVE_ID },
    );
    expect(input?.finalPublish).toEqual({
      commitSha: "fedcba98",
      files: [{ path: "src/b.ts", additions: 1, deletions: 0 }],
    });
  });
});

describe("listExecutions", () => {
  it("lists active and archived executions, newest first", () => {
    const rows = listExecutions(db);
    expect(rows.map((r) => r.executionId)).toEqual([ACTIVE_ID, ARCHIVED_ID]);
    expect(rows[0]?.source).toBe("active");
    expect(rows[1]?.source).toBe("archived");
    expect(rows[1]?.status).toBe("halted");
  });
});
