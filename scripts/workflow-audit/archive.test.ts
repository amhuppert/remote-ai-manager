import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { _createTestDb } from "../../src/lib/state-store/state-db";
import {
  ARCHIVE_REF_PREFIX,
  ARCHIVE_SUBDIR,
  AGENT_RUN_RECORDS_FILE,
  MANIFEST_FILE,
  PENDING_SUFFIX,
  SNAPSHOT_FILE,
  exportGraphWorkflowArchive,
  runGitCommand,
  verifyGraphWorkflowArchive,
  type ArchiveExportDeps,
} from "./archive";
import { buildAuditReport } from "./core";
import { loadAuditInput } from "./run";

type Db = InstanceType<typeof Database>;

const SESSION_NAME = "feature-x";
const EXECUTION_ID = "exec-1";
const LANE_BRANCH = "cc/feature-x-lane-a";
const SCRIPT_LOG = "check-20261001T110000Z-run-1.log";
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let root: string;
let configDir: string;
let repo: string;
let laneWorktree: string;
let laneSha: string;
let publishSha: string;
let db: Db;

interface ManifestLane {
  laneId: string;
  kind: string;
  refs: Array<{ ref: string; commit: string }>;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commitFile(cwd: string, file: string, message: string): string {
  writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function archiveDir(): string {
  return path.join(configDir, ARCHIVE_SUBDIR);
}

function laneRef(laneId: string, commit: string): string {
  return `${ARCHIVE_REF_PREFIX}/${EXECUTION_ID}/${laneId}/${commit}`;
}

function readManifest(): {
  database: { tables: Record<string, number> };
  executions: Array<{
    executionId: string;
    conversations: string[];
    transcripts: string[];
    lanes: ManifestLane[];
  }>;
  files: Record<string, { sha256: string; bytes: number }>;
  gaps: Array<{
    executionId: string | null;
    kind: string;
    subject: string;
    reason: string;
  }>;
} {
  return JSON.parse(
    readFileSync(path.join(archiveDir(), MANIFEST_FILE), "utf8"),
  );
}

function manifestLane(laneId: string): ManifestLane | undefined {
  return readManifest()
    .executions.find((entry) => entry.executionId === EXECUTION_ID)
    ?.lanes.find((lane) => lane.laneId === laneId);
}

function deps(overrides: Partial<ArchiveExportDeps> = {}): ArchiveExportDeps {
  return {
    source: db,
    configDir,
    openSnapshot: (filePath) => new Database(filePath, { readonly: true }),
    runGit: runGitCommand,
    isProcessAlive: () => false,
    now: () => new Date("2026-10-11T12:00:00.000Z"),
    ...overrides,
  };
}

function writeFile(relativePath: string, content: string | Buffer): void {
  const filePath = path.join(configDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writeScriptLog(worktree: string, name: string): void {
  const dir = path.join(worktree, ".cc", "workflow", EXECUTION_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `script output in ${worktree}\n`);
}

function patchRuntime(fields: Record<string, unknown>): void {
  const row = db
    .prepare(
      `SELECT runtime_json FROM graph_workflow_executions WHERE execution_id = ?`,
    )
    .get(EXECUTION_ID) as { runtime_json: string };
  const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
  db.prepare(
    `UPDATE graph_workflow_executions SET runtime_json = ? WHERE execution_id = ?`,
  ).run(JSON.stringify({ ...runtime, ...fields }), EXECUTION_ID);
}

/**
 * The project checkout is the session's worktree on `main`; the lane has its
 * own worktree and branch. `.cc/` is ignored, as in a real project, so script
 * logs do not make a worktree dirty.
 */
function seedRepository(): void {
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, ".gitignore"), ".cc/\n");
  git(repo, "add", ".gitignore");
  commitFile(repo, "README.md", "base");
  publishSha = commitFile(repo, "published.txt", "final publish");
  commitFile(repo, "later.txt", "later session work");
  laneWorktree = path.join(root, "repo-lane-a");
  git(repo, "worktree", "add", "-b", LANE_BRANCH, laneWorktree);
  laneSha = commitFile(laneWorktree, "lane.txt", "lane work");
  writeScriptLog(laneWorktree, SCRIPT_LOG);
  writeScriptLog(repo, "typecheck-20261001T120000Z-run-2.log");
  // The session's own uncommitted work is not the run's.
  writeFileSync(path.join(repo, "scratch.txt"), "session draft\n");
}

function seedDatabase(): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(repo);
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name,
        created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    repo,
    SESSION_NAME,
    repo,
    "main",
    "2026-10-01T00:00:00Z",
    "2026-10-02T00:00:00Z",
  );
  // A one-off run: no seed definition.
  const definition = {
    id: EXECUTION_ID,
    seedDefinitionId: null,
    seedDefinitionRevision: null,
    startedAt: "2026-10-01T10:00:00.000Z",
    workingDefinition: {
      executionContexts: [{ id: "impl", title: "Implement" }],
    },
  };
  const runtime = {
    status: "halted",
    ownerConversationId: "conv-owner",
    // A captured output that names a conversation outside CC.
    contextOutputs: {
      impl: { value: { conversationId: "external-chat-123" } },
    },
    taskStates: {
      t1: { taskId: "t1", contextId: "impl", lastConversationId: "conv-1" },
    },
    executionLanes: {
      "lane-a": {
        laneId: "lane-a",
        kind: "worktree",
        status: "halted",
        worktreePath: laneWorktree,
        branchName: LANE_BRANCH,
        commitSnapshots: [
          { contextId: "impl", sha: laneSha, committedAt: "2026-10-01T11:00Z" },
        ],
      },
      __session__: {
        laneId: "__session__",
        kind: "session",
        status: "merged",
        worktreePath: repo,
        branchName: "main",
        commitSnapshots: [
          {
            contextId: "impl",
            sha: publishSha,
            committedAt: "2026-10-01T12:00Z",
          },
        ],
      },
    },
  };
  db.prepare(
    `INSERT INTO graph_workflow_executions
       (project_path, session_name, execution_id, started_at, status,
        definition_json, runtime_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repo,
    SESSION_NAME,
    EXECUTION_ID,
    "2026-10-01T10:00:00.000Z",
    "halted",
    JSON.stringify(definition),
    JSON.stringify(runtime),
    "2026-10-01T12:00:00.000Z",
  );
  // The validator writer's shapes: the replaced validator (`conv-old`) is
  // named only inside a specialist entry of this event.
  insertEvent(EXECUTION_ID, {
    type: "graph-workflow-validation-result",
    executionId: EXECUTION_ID,
    contextId: "impl",
    pass: false,
    sessionRef: {
      backend: "claude",
      ref: "conv-2",
      lane: "context_validator",
      assignmentId: "reviewer",
      workflowConversationId: "conv-2",
    },
    reviewArtifact: { backend: "claude", kind: "conversation", ref: "conv-2" },
    specialists: [{ sessionRef: { workflowConversationId: "conv-old" } }],
  });
  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, project_path, session_name, status, created_at, last_activity_at,
        total_cost_usd, transcript_path)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
  );
  // The stored path names a config directory the archive must never read.
  insertConversation.run(
    "conv-1",
    repo,
    SESSION_NAME,
    "2026-10-01T10:00:00Z",
    "2026-10-01T11:00:00Z",
    2,
    "/live/cc/transcripts/conv-1.jsonl",
  );
  insertConversation.run(
    "conv-2",
    repo,
    SESSION_NAME,
    "2026-10-01T11:00:00Z",
    "2026-10-01T11:30:00Z",
    1,
    null,
  );
  db.prepare(
    `INSERT INTO agent_run_records
       (run_id, backend, project_name, session_name, status, started_at)
     VALUES ('run-1', 'codex', 'repo', ?, 'completed', '2026-10-01T09:00:00Z')`,
  ).run(SESSION_NAME);
}

function insertEvent(
  executionId: string,
  event: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO graph_workflow_events
       (project_path, session_name, execution_id, occurred_at, event_type,
        context_id, pre_reset, event_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    repo,
    SESSION_NAME,
    executionId,
    "2026-10-01T11:30:00.000Z",
    String(event.type),
    "impl",
    JSON.stringify(event),
  );
}

function seedConfigFiles(): void {
  writeFile(
    `workflow-logs/${EXECUTION_ID}/contexts/impl/iterations.jsonl`,
    [
      JSON.stringify({
        timestamp: "2026-10-01T10:00:05Z",
        event: "iteration.started",
        iterationNumber: 1,
      }),
      // An earlier conversation of the context, named only in its log.
      JSON.stringify({
        timestamp: "2026-10-01T10:00:06Z",
        event: "iteration.conversation_resolved",
        conversationId: "conv-iter",
      }),
    ].join("\n"),
  );
  writeFile(`workflow-docs/${EXECUTION_ID}/notes.md`, "legacy layout\n");
  writeFile("workflow-docs/objects/ab/abcdef", "content-addressed\n");
  writeFile("workflows/project-x/def-1.json", '{"id":"def-1"}\n');
  writeFile(
    "transcripts/conv-1.jsonl",
    [
      JSON.stringify({
        type: "user",
        content: [
          {
            type: "image_ref",
            imagePath: "/live/cc/transcripts/images/conv-1/1.png",
            mediaType: "image/png",
          },
        ],
      }),
      JSON.stringify({
        type: "result",
        raw: { total_cost_usd: 2, num_turns: 3, session_id: "s1" },
      }),
    ].join("\n"),
  );
  writeFile("transcripts/images/conv-1/1.png", IMAGE_BYTES);
  writeFile("transcripts/conv-old.jsonl", "{}\n");
  writeFile("transcripts/conv-iter.jsonl", "{}\n");
  writeFile("transcripts/conv-owner.jsonl", "{}\n");
  // An unrelated conversation's transcript stays out of the archive.
  writeFile("transcripts/conv-unrelated.jsonl", "{}\n");
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "wf-archive-test-"));
  configDir = path.join(root, "cc");
  mkdirSync(configDir);
  seedRepository();
  db = _createTestDb({ inMemory: true });
  seedDatabase();
  seedConfigFiles();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("exportGraphWorkflowArchive", () => {
  it("archives the database, workflow files, the transcripts and images the runs name, and script logs left in worktrees", () => {
    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(true);
    for (const relativePath of [
      SNAPSHOT_FILE,
      `workflow-logs/${EXECUTION_ID}/contexts/impl/iterations.jsonl`,
      `workflow-docs/${EXECUTION_ID}/notes.md`,
      "workflow-docs/objects/ab/abcdef",
      "workflows/project-x/def-1.json",
      "transcripts/conv-1.jsonl",
      "transcripts/conv-old.jsonl",
      "transcripts/conv-iter.jsonl",
      "transcripts/images/conv-1/1.png",
      `worktree-logs/${EXECUTION_ID}/lane-a/${SCRIPT_LOG}`,
      `worktree-logs/${EXECUTION_ID}/__session__/typecheck-20261001T120000Z-run-2.log`,
    ]) {
      expect(existsSync(path.join(archiveDir(), relativePath))).toBe(true);
    }
    expect(
      existsSync(path.join(archiveDir(), "transcripts/conv-unrelated.jsonl")),
    ).toBe(false);

    const manifest = readManifest();
    expect(manifest.files["transcripts/conv-1.jsonl"]?.sha256).toBe(
      sha256(path.join(configDir, "transcripts/conv-1.jsonl")),
    );
    expect(manifest.files[SNAPSHOT_FILE]).toBeDefined();
    expect(manifest.database.tables).toMatchObject({
      graph_workflow_executions: 1,
      graph_workflow_events: 1,
      graph_plan_reviews: 0,
      agent_run_records: 1,
    });
    const execution = manifest.executions.find(
      (entry) => entry.executionId === EXECUTION_ID,
    );
    expect(execution?.conversations).toEqual([
      "conv-1",
      "conv-2",
      "conv-iter",
      "conv-old",
      "conv-owner",
    ]);
    expect(execution?.transcripts).toEqual([
      "conv-1",
      "conv-iter",
      "conv-old",
      "conv-owner",
    ]);
    expect(manifest.gaps).toEqual([
      expect.objectContaining({
        executionId: EXECUTION_ID,
        kind: "transcript",
        subject: "conv-2",
      }),
    ]);
  });

  it("is read back by the audit extractor from the archive alone", () => {
    exportGraphWorkflowArchive(deps());
    rmSync(path.join(configDir, "transcripts"), { recursive: true });
    rmSync(path.join(configDir, "workflow-logs"), { recursive: true });

    const snapshot = new Database(path.join(archiveDir(), SNAPSHOT_FILE), {
      readonly: true,
    });
    try {
      const input = loadAuditInput(
        {
          db: snapshot,
          logsBaseDir: path.join(archiveDir(), "workflow-logs"),
          transcriptsDir: path.join(archiveDir(), "transcripts"),
        },
        { executionId: EXECUTION_ID },
      );
      expect(input).not.toBeNull();
      if (input === null) return;
      const conversation = input.conversations.find((c) => c.id === "conv-1");
      expect(conversation?.transcriptScan?.costUsd).toBeCloseTo(2);
      expect(input.contextLogs.impl?.iterations).toHaveLength(2);
      expect(buildAuditReport(input).overview.executionId).toBe(EXECUTION_ID);
    } finally {
      snapshot.close();
    }
  });

  it("exports the agent run records as their own file", () => {
    exportGraphWorkflowArchive(deps());

    const lines = readFileSync(
      path.join(archiveDir(), AGENT_RUN_RECORDS_FILE),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ run_id: "run-1", backend: "codex" }),
    ]);
  });

  it("keeps a lane's commits under one archive ref per commit", () => {
    exportGraphWorkflowArchive(deps());

    expect(git(repo, "rev-parse", laneRef("lane-a", laneSha))).toBe(laneSha);
    expect(manifestLane("lane-a")).toMatchObject({
      kind: "worktree",
      refs: [{ ref: laneRef("lane-a", laneSha), commit: laneSha }],
    });
  });

  it("refs the session lane only at the commits the run recorded, and leaves the session's own work alone", () => {
    exportGraphWorkflowArchive(deps());

    expect(manifestLane("__session__")).toMatchObject({
      kind: "session",
      refs: [{ ref: laneRef("__session__", publishSha), commit: publishSha }],
    });
    expect(readManifest().gaps.map((gap) => gap.kind)).not.toContain(
      "worktree",
    );
  });

  it("keeps both a branch tip and a recorded commit the tip does not contain", () => {
    // The branch was deleted and the same lane name reused from `main`.
    git(repo, "worktree", "remove", "--force", laneWorktree);
    git(repo, "branch", "-D", LANE_BRANCH);
    git(repo, "worktree", "add", "-b", LANE_BRANCH, laneWorktree);
    const reusedTip = commitFile(laneWorktree, "other.txt", "another run");

    exportGraphWorkflowArchive(deps());

    expect(
      manifestLane("lane-a")
        ?.refs.map((entry) => entry.commit)
        .sort(),
    ).toEqual([laneSha, reusedTip].sort());
    expect(git(repo, "rev-parse", laneRef("lane-a", laneSha))).toBe(laneSha);
  });

  it("archives a lane whose branch is gone from its recorded commit, while the object survives", () => {
    git(repo, "worktree", "remove", "--force", laneWorktree);
    git(repo, "branch", "-D", LANE_BRANCH);

    exportGraphWorkflowArchive(deps());

    expect(manifestLane("lane-a")?.refs).toEqual([
      { ref: laneRef("lane-a", laneSha), commit: laneSha },
    ]);
  });

  it("keeps the refs an earlier export wrote once the lane branch is gone, with no gap", () => {
    // The branch moved past the last recorded commit before the first export.
    const tip = commitFile(laneWorktree, "more.txt", "unrecorded lane work");
    exportGraphWorkflowArchive(deps());
    git(repo, "worktree", "remove", "--force", laneWorktree);
    git(repo, "branch", "-D", LANE_BRANCH);

    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(true);
    expect(manifestLane("lane-a")?.refs.map((entry) => entry.commit)).toContain(
      tip,
    );
    expect(readManifest().gaps.map((gap) => gap.kind)).not.toContain("lane");
  });

  it("archives a context a run isolated on its own branch before lanes existed", () => {
    patchRuntime({
      executionLanes: {},
      contextStates: {
        impl: {
          status: "halted",
          isolation: "worktree",
          worktreePath: laneWorktree,
          branchName: LANE_BRANCH,
        },
        review: {
          status: "completed",
          isolation: "session",
          branchName: "main",
        },
      },
    });

    exportGraphWorkflowArchive(deps());

    const lanes = readManifest().executions[0]?.lanes ?? [];
    expect(lanes.map((lane) => lane.laneId)).toEqual(["context-impl"]);
    expect(lanes[0]?.refs).toEqual([
      {
        ref: `${ARCHIVE_REF_PREFIX}/${EXECUTION_ID}/context-impl/${laneSha}`,
        commit: laneSha,
      },
    ]);
  });

  it("records uncommitted lane work and a missing repository as gaps, and archives the rest", () => {
    writeFileSync(path.join(laneWorktree, "draft.txt"), "uncommitted\n");

    exportGraphWorkflowArchive(deps());
    expect(readManifest().gaps).toContainEqual(
      expect.objectContaining({ kind: "worktree", subject: laneWorktree }),
    );

    rmSync(repo, { recursive: true, force: true });
    rmSync(laneWorktree, { recursive: true, force: true });
    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(true);
    expect(readManifest().gaps).toContainEqual(
      expect.objectContaining({
        executionId: EXECUTION_ID,
        kind: "repository",
        subject: repo,
      }),
    );
    expect(
      existsSync(path.join(archiveDir(), "transcripts/conv-1.jsonl")),
    ).toBe(true);
  });

  it("records a run whose stored record cannot be read as a gap, and still archives what its events name", () => {
    db.prepare(
      `INSERT INTO graph_workflow_archived_executions
         (project_path, session_name, execution_id, archived_at, status,
          started_at, execution_json)
       VALUES (?, ?, 'exec-broken', '2026-09-01T00:00Z', 'failed',
               '2026-09-01T00:00Z', 'not json')`,
    ).run(repo, SESSION_NAME);
    insertEvent("exec-broken", {
      type: "graph-workflow-iteration-started",
      conversationId: "conv-broken",
    });
    writeFile("transcripts/conv-broken.jsonl", "{}\n");

    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(true);
    const manifest = readManifest();
    expect(manifest.gaps).toContainEqual(
      expect.objectContaining({
        executionId: "exec-broken",
        kind: "execution",
      }),
    );
    expect(
      manifest.executions.find((entry) => entry.executionId === "exec-broken")
        ?.transcripts,
    ).toEqual(["conv-broken"]);
    expect(verify()).toEqual([]);
  });

  it("reruns idempotently, keeping copies and conversations whose source has since gone", () => {
    exportGraphWorkflowArchive(deps());
    const first = readManifest();
    rmSync(path.join(configDir, "transcripts"), { recursive: true });
    rmSync(path.join(configDir, "workflow-logs"), { recursive: true });
    git(repo, "worktree", "remove", "--force", laneWorktree);

    const result = exportGraphWorkflowArchive(
      deps({ now: () => new Date("2026-10-12T08:00:00.000Z") }),
    );

    expect(result.ok).toBe(true);
    const second = readManifest();
    const withoutSnapshot = (files: typeof first.files) =>
      Object.fromEntries(
        Object.entries(files).filter(([file]) => file !== SNAPSHOT_FILE),
      );
    expect(withoutSnapshot(second.files)).toEqual(withoutSnapshot(first.files));
    expect(second.gaps).toEqual(first.gaps);
    expect(second.executions).toEqual(first.executions);
    expect(
      readdirSync(archiveDir()).filter((name) => name.endsWith(PENDING_SUFFIX)),
    ).toEqual([]);
  });

  it("refuses a rerun that would drop a run the archive holds, and keeps the earlier snapshot", () => {
    exportGraphWorkflowArchive(deps());
    const snapshotHash = sha256(path.join(archiveDir(), SNAPSHOT_FILE));
    db.prepare(`DELETE FROM sessions WHERE session_name = ?`).run(SESSION_NAME);

    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(EXECUTION_ID);
    expect(sha256(path.join(archiveDir(), SNAPSHOT_FILE))).toBe(snapshotHash);
    expect(
      readdirSync(archiveDir()).filter((name) => name.endsWith(PENDING_SUFFIX)),
    ).toEqual([]);
  });

  it("refuses a rerun that would drop a conversation row the archive holds", () => {
    exportGraphWorkflowArchive(deps());
    db.prepare(`DELETE FROM conversations WHERE id = 'conv-1'`).run();

    const result = exportGraphWorkflowArchive(deps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("conv-1");
  });

  it("refuses while a Command Center server holds the data directory", () => {
    db.exec(`CREATE TABLE IF NOT EXISTS graph_workflow_runtime_owner (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      pid INTEGER NOT NULL,
      token TEXT NOT NULL
    )`);
    db.prepare(
      `INSERT INTO graph_workflow_runtime_owner (singleton, pid, token)
       VALUES (1, 4242, 'token')`,
    ).run();

    const result = exportGraphWorkflowArchive(
      deps({ isProcessAlive: (pid) => pid === 4242 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("4242");
    expect(existsSync(archiveDir())).toBe(false);
  });
});

function verify(): string[] {
  return verifyGraphWorkflowArchive({
    archiveDir: archiveDir(),
    openSnapshot: (filePath) => new Database(filePath, { readonly: true }),
    runGit: runGitCommand,
  });
}

describe("verifyGraphWorkflowArchive", () => {
  it("passes an intact archive", () => {
    exportGraphWorkflowArchive(deps());

    expect(verify()).toEqual([]);
  });

  it("names a changed file and a moved archive ref", () => {
    exportGraphWorkflowArchive(deps());
    const iterations = `workflow-logs/${EXECUTION_ID}/contexts/impl/iterations.jsonl`;
    writeFileSync(path.join(archiveDir(), iterations), "edited\n");
    git(repo, "update-ref", laneRef("lane-a", laneSha), "main");

    const problems = verify();

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(iterations),
        expect.stringContaining(laneRef("lane-a", laneSha)),
      ]),
    );
  });
});
