#!/usr/bin/env bun
/**
 * Graph workflow archive: a config-directory-shaped copy of everything the old
 * graph engine stored, taken before its tables and files are deleted.
 *
 * `<configDir>/archive/graph-workflows/` holds a snapshot of the database
 * (named so Command Center never opens it), `workflow-logs/`, `workflow-docs/`
 * and `workflows/` as they were, the transcripts and images the runs name, the
 * script-validation logs left in session and lane worktrees
 * (`worktree-logs/<executionId>/<laneId>/`, the session's under
 * `__session__`), the agent run records as JSONL, and a manifest of hashes,
 * row counts, gaps and known limits. Each lane commit is kept in its project
 * repository under `refs/cc-archive/graph-workflows/<executionId>/<laneId>/<sha>`,
 * which survives branch and worktree deletion. Something the archive cannot
 * hold (a missing repository, transcript or image, uncommitted lane work) is
 * recorded as a gap with its reason, never a refusal.
 *
 * The audit extractor reads the archive unchanged:
 *   bun run workflow:audit -- --config-dir <archive> \
 *     --db <archive>/command-center.db.backup --execution <id>
 *
 * Usage (with the server stopped):
 *   bun run workflow:archive                         # export, then verify
 *   bun run workflow:archive -- --verify             # verify only
 *   bun run workflow:archive -- --config-dir <dir>
 *
 * Reruns copy what changed and never delete from the archive or its refs, so a
 * file whose source has gone since keeps its copy and the manifest keeps
 * listing it. A rerun refuses when the database has lost a run or conversation
 * the earlier export holds: replacing the snapshot would drop it.
 *
 * An interrupted export can leave files, refs and the snapshot ahead of the
 * manifest; the verifier then fails and a rerun repairs it. Delete nothing at
 * the source until an export has verified.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { resolveConfigDirFrom } from "../../src/lib/config/config-dir";
import { isProcessAlive } from "../../src/lib/shared/process-liveness";
import {
  buildAuditReport,
  parseExecutionProjection,
  renderMarkdown,
} from "./core";
import {
  listExecutions,
  loadAuditInput,
  loadExecutionLogs,
  namedConversations,
  openReadonlyDatabase,
  readExecutionRecord,
  type AuditDb,
  type ExecutionListRow,
} from "./run";

export const ARCHIVE_SUBDIR = path.join("archive", "graph-workflows");
export const SNAPSHOT_FILE = "command-center.db.backup";
export const MANIFEST_FILE = "manifest.json";
export const AGENT_RUN_RECORDS_FILE = "agent-run-records.jsonl";
export const ARCHIVE_REF_PREFIX = "refs/cc-archive/graph-workflows";
export const PENDING_SUFFIX = ".cc-archive-pending";

const ARCHIVE_FORMAT = "cc-graph-workflow-archive/1";
const COPIED_DIRECTORIES = ["workflow-logs", "workflow-docs", "workflows"];
const COUNTED_TABLES = [
  "graph_workflow_executions",
  "graph_workflow_archived_executions",
  "graph_workflow_events",
  "graph_workflow_result_deliveries",
  "graph_workflow_pending_artifacts",
  "graph_workflow_coverage_cutover_backups",
  "graph_plan_reviews",
  "agent_run_records",
];
const IMAGES_DIR = path.join("transcripts", "images");
const WORKTREE_LOGS_DIR = "worktree-logs";
const SCRIPT_LOGS_DIR = path.join(".cc", "workflow");
const SESSION_LANE_ID = "__session__";
const ARCHIVE_LIMITS = [
  "Lane commits are kept by refs in each project's repository; reaching them needs that repository.",
  "Uncommitted lane work is not archived; each dirty lane worktree is a gap.",
  "Intermediate live-edit revisions of a run's definition were never stored; the snapshot holds the launch document and the last working definition.",
  "Runtime admission timings come from logs/global.log, which is not archived.",
];

const gapSchema = z.object({
  executionId: z.string().nullable(),
  kind: z.enum([
    "execution",
    "transcript",
    "image",
    "repository",
    "lane",
    "worktree",
    "file",
  ]),
  subject: z.string(),
  reason: z.string(),
});
export type ArchiveGap = z.infer<typeof gapSchema>;

const laneSchema = z.object({
  laneId: z.string(),
  // A session lane is the session's own worktree and branch, not the run's.
  kind: z.enum(["worktree", "session"]),
  status: z.string(),
  branchName: z.string(),
  worktreePath: z.string().nullable(),
  refs: z.array(z.object({ ref: z.string(), commit: z.string() })),
});
type ArchivedLane = z.infer<typeof laneSchema>;

const executionSchema = z.object({
  executionId: z.string(),
  tier: z.enum(["active", "archived"]),
  projectPath: z.string(),
  sessionName: z.string(),
  status: z.string(),
  startedAt: z.string(),
  events: z.number(),
  conversations: z.array(z.string()),
  conversationRows: z.array(z.string()),
  transcripts: z.array(z.string()),
  lanes: z.array(laneSchema),
});
type ArchivedExecution = z.infer<typeof executionSchema>;

const manifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  exportedAt: z.string(),
  sourceConfigDir: z.string(),
  database: z.object({
    file: z.string(),
    tables: z.record(z.string(), z.number()),
  }),
  executions: z.array(executionSchema),
  files: z.record(
    z.string(),
    z.object({ sha256: z.string(), bytes: z.number() }),
  ),
  gaps: z.array(gapSchema),
  limits: z.array(z.string()),
});
export type ArchiveManifest = z.infer<typeof manifestSchema>;

export interface ArchiveSourceDb extends AuditDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export type ArchiveSnapshotDb = AuditDb & { close(): void };

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

export interface ArchiveExportDeps {
  source: ArchiveSourceDb;
  configDir: string;
  openSnapshot(filePath: string): ArchiveSnapshotDb;
  runGit(args: string[], cwd: string): GitResult;
  isProcessAlive(pid: number): boolean;
  now(): Date;
}

export type ArchiveExportResult =
  | { ok: true; archiveDir: string; manifest: ArchiveManifest }
  | { ok: false; reason: string };

export function runGitCommand(args: string[], cwd: string): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `git exited with ${result.status}`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

function rowObject(result: unknown): Record<string, unknown> | null {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
}

function tableExists(db: AuditDb, table: string): boolean {
  return (
    rowObject(
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table),
    ) !== null
  );
}

function countRows(db: AuditDb, sql: string, ...params: unknown[]): number {
  const count = rowObject(db.prepare(sql).get(...params))?.n;
  return typeof count === "number" ? count : 0;
}

function sourceRefusal(deps: ArchiveExportDeps): string | null {
  if (!tableExists(deps.source, "graph_workflow_executions")) {
    return "the database has no graph workflow tables, so there is nothing to archive; an existing archive is kept";
  }
  if (!tableExists(deps.source, "graph_workflow_runtime_owner")) return null;
  const pid = rowObject(
    deps.source
      .prepare(
        "SELECT pid FROM graph_workflow_runtime_owner WHERE singleton = 1",
      )
      .get(),
  )?.pid;
  if (typeof pid === "number" && deps.isProcessAlive(pid)) {
    return `a Command Center server (pid ${pid}) holds this data directory; stop it and rerun`;
  }
  return null;
}

function fileSha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(filePath, "r");
  try {
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function isFile(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function writeAtomically(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const pending = `${filePath}${PENDING_SUFFIX}`;
  writeFileSync(pending, content);
  renameSync(pending, filePath);
}

/** Copies when the archive lacks the file or holds different bytes. */
function copyIfChanged(source: string, destination: string): void {
  if (
    isFile(destination) &&
    statSync(destination).size === statSync(source).size &&
    fileSha256(destination) === fileSha256(source)
  ) {
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const pending = `${destination}${PENDING_SUFFIX}`;
  copyFileSync(source, pending);
  renameSync(pending, destination);
}

/** "kept" when the source has gone but an earlier export holds the copy. */
function archiveFile(
  source: string,
  destination: string,
): "copied" | "kept" | "missing" {
  if (isFile(source)) {
    copyIfChanged(source, destination);
    return "copied";
  }
  return isFile(destination) ? "kept" : "missing";
}

function mirrorDirectory(
  source: string,
  destination: string,
  relative: string,
  gaps: ArchiveGap[],
): void {
  if (!existsSync(source)) return;
  const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const label = path.join(relative, entry.name);
    if (entry.isDirectory()) mirrorDirectory(from, to, label, gaps);
    else if (entry.isFile()) copyIfChanged(from, to);
    else {
      gaps.push({
        executionId: null,
        kind: "file",
        subject: label,
        reason: "not a regular file; not copied",
      });
    }
  }
}

function hashArchiveFiles(archiveDir: string): ArchiveManifest["files"] {
  const files: ArchiveManifest["files"] = {};
  const walk = (dir: string, relative: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const label = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, label);
        continue;
      }
      if (label === MANIFEST_FILE || entry.name.endsWith(PENDING_SUFFIX)) {
        continue;
      }
      files[label] = { sha256: fileSha256(full), bytes: statSync(full).size };
    }
  };
  walk(archiveDir, "");
  return files;
}

/**
 * The path below `transcripts/images/` an image reference names. References
 * are absolute paths into the config directory that wrote them, so the copy
 * resolves them against the directory being archived, never as stored.
 */
function imageRelativePath(imagePath: string): string | null {
  const marker = `${path.sep}${IMAGES_DIR}${path.sep}`;
  const at = imagePath.lastIndexOf(marker);
  if (at < 0) return null;
  const relative = imagePath.slice(at + marker.length);
  const segments = relative.split(path.sep);
  return segments.some((segment) => segment === "" || segment === "..")
    ? null
    : relative;
}

function referencedImages(transcriptPath: string): string[] {
  const images = new Set<string>();
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.includes('"image_ref"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rowObject(entry)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const fields = rowObject(block);
      if (
        fields?.type === "image_ref" &&
        typeof fields.imagePath === "string"
      ) {
        images.add(fields.imagePath);
      }
    }
  }
  return [...images].sort();
}

function textField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** An id used as one path or ref component. */
function isNameComponent(id: string): boolean {
  return id.length > 0 && !id.includes(path.sep) && id !== "." && id !== "..";
}

interface LaneCandidate {
  laneId: string;
  kind: ArchivedLane["kind"];
  status: string;
  branchName: string;
  worktreePath: string | null;
  recordedCommits: string[];
}

/**
 * Lanes from the stored record, read directly so an archive never depends on
 * the audit report's projection: `executionLanes`, plus each context a run
 * that predates them isolated on its own branch, as `context-<contextId>`.
 */
function storedLanes(record: Record<string, unknown>): LaneCandidate[] {
  const lanes: LaneCandidate[] = [];
  const branches = new Set<string>();
  for (const [laneId, value] of Object.entries(
    rowObject(record.executionLanes) ?? {},
  )) {
    const lane = rowObject(value);
    const branchName = textField(lane, "branchName");
    if (lane === null || branchName === null) continue;
    branches.add(branchName);
    const snapshots = Array.isArray(lane.commitSnapshots)
      ? lane.commitSnapshots
      : [];
    lanes.push({
      laneId,
      kind: lane.kind === "session" ? "session" : "worktree",
      status: textField(lane, "status") ?? "unknown",
      branchName,
      worktreePath: textField(lane, "worktreePath"),
      recordedCommits: snapshots.flatMap((snapshot) => {
        const sha = textField(rowObject(snapshot), "sha");
        return sha === null ? [] : [sha];
      }),
    });
  }
  for (const [contextId, value] of Object.entries(
    rowObject(record.contextStates) ?? {},
  )) {
    const context = rowObject(value);
    const branchName = textField(context, "branchName");
    if (
      context === null ||
      branchName === null ||
      context.isolation === "session" ||
      branches.has(branchName)
    ) {
      continue;
    }
    branches.add(branchName);
    lanes.push({
      laneId: `context-${contextId}`,
      kind: "worktree",
      status: textField(context, "status") ?? "unknown",
      branchName,
      worktreePath: textField(context, "worktreePath"),
      recordedCommits: [],
    });
  }
  return lanes.sort((a, b) => a.laneId.localeCompare(b.laneId));
}

function gitOutput(result: GitResult): string | null {
  if (!result.ok) return null;
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
}

function archivedRefs(
  prefix: string,
  repository: string,
  runGit: ArchiveExportDeps["runGit"],
): ArchivedLane["refs"] {
  const listing = gitOutput(
    runGit(
      ["for-each-ref", "--format=%(objectname) %(refname)", `${prefix}/`],
      repository,
    ),
  );
  if (listing === null) return [];
  return listing
    .split("\n")
    .map((line) => {
      const [commit = "", ref = ""] = line.split(" ");
      return { ref, commit };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * One ref per commit, named by it, so a ref never moves and nothing the run
 * left can be displaced: the branch tip of a run lane, and the last recorded
 * commit that survives unless the tip contains it. A session lane is the
 * session's own branch, so only the commits the run recorded on it are kept.
 * Refs an earlier export wrote stay listed after their branch is gone.
 */
function archiveLane(
  executionId: string,
  repository: string,
  lane: LaneCandidate,
  runGit: ArchiveExportDeps["runGit"],
  gaps: ArchiveGap[],
): ArchivedLane {
  const gap = (kind: "lane" | "worktree", subject: string, reason: string) =>
    gaps.push({ executionId, kind, subject, reason });
  if (
    lane.kind === "worktree" &&
    lane.worktreePath !== null &&
    existsSync(lane.worktreePath)
  ) {
    const status = runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      lane.worktreePath,
    );
    if (!status.ok) {
      gap("worktree", lane.worktreePath, `status unreadable: ${status.error}`);
    } else if (status.stdout.trim().length > 0) {
      const paths = status.stdout.trim().split("\n").length;
      gap(
        "worktree",
        lane.worktreePath,
        `${paths} uncommitted path(s) are not archived`,
      );
    }
  }

  const tip =
    lane.kind === "worktree"
      ? gitOutput(
          runGit(
            [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${lane.branchName}^{commit}`,
            ],
            repository,
          ),
        )
      : null;
  const recorded =
    [...lane.recordedCommits]
      .reverse()
      .find(
        (sha) => runGit(["cat-file", "-e", `${sha}^{commit}`], repository).ok,
      ) ?? null;
  const commits = [tip, recorded].filter(
    (commit, index, all): commit is string =>
      commit !== null && all.indexOf(commit) === index,
  );
  const kept =
    tip !== null &&
    recorded !== null &&
    commits.length === 2 &&
    runGit(["merge-base", "--is-ancestor", recorded, tip], repository).ok
      ? [tip]
      : commits;

  const prefix = `${ARCHIVE_REF_PREFIX}/${executionId}/${lane.laneId}`;
  for (const commit of kept) {
    const written = runGit(
      ["update-ref", `${prefix}/${commit}`, commit],
      repository,
    );
    if (!written.ok) {
      gap(
        "lane",
        lane.laneId,
        `ref for ${commit} not written: ${written.error}`,
      );
    }
  }
  const refs = archivedRefs(prefix, repository, runGit);
  if (
    refs.length === 0 &&
    (lane.kind === "worktree" || lane.recordedCommits.length > 0)
  ) {
    gap(
      "lane",
      lane.laneId,
      lane.kind === "worktree"
        ? `branch ${lane.branchName} is gone and no commit it recorded survives`
        : "no commit it recorded survives",
    );
  }
  return {
    laneId: lane.laneId,
    kind: lane.kind,
    status: lane.status,
    branchName: lane.branchName,
    worktreePath: lane.worktreePath,
    refs,
  };
}

function archiveLanes(
  executionId: string,
  repository: string,
  lanes: LaneCandidate[],
  runGit: ArchiveExportDeps["runGit"],
  gaps: ArchiveGap[],
): ArchivedLane[] {
  if (lanes.length === 0) return [];
  const archivable = lanes.filter((lane) => isNameComponent(lane.laneId));
  for (const lane of lanes) {
    if (archivable.includes(lane)) continue;
    gaps.push({
      executionId,
      kind: "lane",
      subject: lane.laneId,
      reason: "the lane id is not a ref name component",
    });
  }
  const probe = existsSync(repository)
    ? runGit(["rev-parse", "--git-dir"], repository)
    : ({ ok: false, error: "the directory does not exist" } as const);
  if (!probe.ok) {
    gaps.push({
      executionId,
      kind: "repository",
      subject: repository,
      reason: `not a readable git repository (${probe.error}); ${archivable.length} lane(s) not archived`,
    });
    return archivable.map((lane) => ({
      laneId: lane.laneId,
      kind: lane.kind,
      status: lane.status,
      branchName: lane.branchName,
      worktreePath: lane.worktreePath,
      refs: [],
    }));
  }
  return archivable.map((lane) =>
    archiveLane(executionId, repository, lane, runGit, gaps),
  );
}

/**
 * Script validators write their command output to `.cc/workflow/<executionId>/`
 * inside the worktree they validated, which `.cc/` keeps out of git.
 */
function archiveScriptLogs(
  executionId: string,
  sessionWorktree: string | null,
  lanes: LaneCandidate[],
  archiveDir: string,
  gaps: ArchiveGap[],
): void {
  const worktrees: Array<[string, string]> = [
    ...(sessionWorktree === null
      ? []
      : [[SESSION_LANE_ID, sessionWorktree] as [string, string]]),
    ...lanes.flatMap(
      (lane): Array<[string, string]> =>
        lane.kind === "worktree" &&
        lane.worktreePath !== null &&
        isNameComponent(lane.laneId)
          ? [[lane.laneId, lane.worktreePath]]
          : [],
    ),
  ];
  for (const [label, worktree] of worktrees) {
    const relative = path.join(WORKTREE_LOGS_DIR, executionId, label);
    mirrorDirectory(
      path.join(worktree, SCRIPT_LOGS_DIR, executionId),
      path.join(archiveDir, relative),
      relative,
      gaps,
    );
  }
}

function archiveTranscripts(
  executionId: string,
  conversationIds: string[],
  configDir: string,
  archiveDir: string,
  gaps: ArchiveGap[],
): string[] {
  const archived: string[] = [];
  for (const id of conversationIds) {
    if (!isNameComponent(id)) {
      gaps.push({
        executionId,
        kind: "transcript",
        subject: id,
        reason: "the conversation id is not a file name",
      });
      continue;
    }
    const relative = path.join("transcripts", `${id}.jsonl`);
    const destination = path.join(archiveDir, relative);
    if (
      archiveFile(path.join(configDir, relative), destination) === "missing"
    ) {
      gaps.push({
        executionId,
        kind: "transcript",
        subject: id,
        reason: `no transcript at ${relative}`,
      });
      continue;
    }
    archived.push(id);
    for (const imagePath of referencedImages(destination)) {
      const imageRelative = imageRelativePath(imagePath);
      const outcome =
        imageRelative === null
          ? "missing"
          : archiveFile(
              path.join(configDir, IMAGES_DIR, imageRelative),
              path.join(archiveDir, IMAGES_DIR, imageRelative),
            );
      if (outcome === "missing") {
        gaps.push({
          executionId,
          kind: "image",
          subject: imagePath,
          reason:
            imageRelative === null
              ? `conversation ${id} names an image outside ${IMAGES_DIR}`
              : `conversation ${id} names an image that is gone`,
        });
      }
    }
  }
  return archived;
}

/**
 * Discovery reads the stored record, events and the archived logs directly,
 * never the audit report's projection, and keeps every conversation an earlier
 * export listed: a run's evidence is archived even when its report cannot be
 * built, and a rerun forgets nothing whose source has since gone.
 */
function archiveExecution(
  deps: ArchiveExportDeps,
  snapshot: ArchiveSnapshotDb,
  archiveDir: string,
  row: ExecutionListRow,
  previous: ArchivedExecution | undefined,
  gaps: ArchiveGap[],
): ArchivedExecution {
  const unreadable = (reason: string) =>
    gaps.push({
      executionId: row.executionId,
      kind: "execution",
      subject: row.executionId,
      reason: `${reason}; its rows are in the snapshot and its evidence was archived`,
    });
  const record = readExecutionRecord(snapshot, row.executionId)?.raw ?? null;
  if (record === null) {
    unreadable("the stored record is not readable JSON");
  } else {
    const parsed = parseExecutionProjection(record);
    if (!parsed.ok) {
      unreadable(
        `the audit report cannot read the stored record (${parsed.error.slice(0, 300)})`,
      );
    }
  }
  const logs = loadExecutionLogs(
    snapshot,
    path.join(archiveDir, "workflow-logs"),
    row.executionId,
  );
  const named = namedConversations(record, logs);
  const conversations = [
    ...new Set([
      ...named.participants,
      ...named.provenance,
      ...(previous?.conversations ?? []),
    ]),
  ].sort();
  const lanes = record === null ? [] : storedLanes(record);
  const sessionWorktree = textField(
    rowObject(
      snapshot
        .prepare(
          "SELECT worktree_path FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get(row.projectPath, row.sessionName),
    ),
    "worktree_path",
  );
  archiveScriptLogs(row.executionId, sessionWorktree, lanes, archiveDir, gaps);
  return {
    executionId: row.executionId,
    tier: row.source,
    projectPath: row.projectPath,
    sessionName: row.sessionName,
    status: row.status,
    startedAt: row.startedAt,
    events: countRows(
      snapshot,
      "SELECT COUNT(*) AS n FROM graph_workflow_events WHERE execution_id = ?",
      row.executionId,
    ),
    conversations,
    conversationRows: conversations.filter(
      (id) =>
        countRows(
          snapshot,
          "SELECT COUNT(*) AS n FROM conversations WHERE id = ?",
          id,
        ) > 0,
    ),
    transcripts: archiveTranscripts(
      row.executionId,
      conversations,
      deps.configDir,
      archiveDir,
      gaps,
    ),
    lanes: archiveLanes(
      row.executionId,
      row.projectPath,
      lanes,
      deps.runGit,
      gaps,
    ),
  };
}

/** Active rows first: the extractor resolves an id from the active table first. */
function archivedRuns(snapshot: AuditDb): ExecutionListRow[] {
  const rows = listExecutions(snapshot);
  const seen = new Set<string>();
  const runs: ExecutionListRow[] = [];
  for (const row of [
    ...rows.filter((r) => r.source === "active"),
    ...rows.filter((r) => r.source === "archived"),
  ]) {
    if (seen.has(row.executionId)) continue;
    seen.add(row.executionId);
    runs.push(row);
  }
  const order = new Map(rows.map((row, index) => [row, index]));
  return runs.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function readPreviousManifest(
  archiveDir: string,
):
  | { ok: true; manifest: ArchiveManifest | null }
  | { ok: false; reason: string } {
  const manifestPath = path.join(archiveDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { ok: true, manifest: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    parsed = null;
  }
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return {
      ok: false,
      reason: `${manifestPath} is not a manifest this exporter wrote; move ${archiveDir} aside to start a new archive`,
    };
  }
  return { ok: true, manifest: manifest.data };
}

function listed(ids: string[]): string {
  const shown = ids.slice(0, 10).join(", ");
  return ids.length > 10 ? `${shown}, and ${ids.length - 10} more` : shown;
}

function droppedSincePreviousExport(
  previous: ArchiveManifest,
  snapshot: AuditDb,
  runs: ExecutionListRow[],
  archiveDir: string,
): string | null {
  const present = new Set(runs.map((run) => run.executionId));
  const runsGone = previous.executions
    .map((entry) => entry.executionId)
    .filter((id) => !present.has(id));
  const conversationsGone = previous.executions
    .flatMap((entry) => entry.conversationRows)
    .filter(
      (id) =>
        countRows(
          snapshot,
          "SELECT COUNT(*) AS n FROM conversations WHERE id = ?",
          id,
        ) === 0,
    );
  if (runsGone.length === 0 && conversationsGone.length === 0) return null;
  const lost = [
    runsGone.length > 0 ? `runs ${listed(runsGone)}` : null,
    conversationsGone.length > 0
      ? `conversations ${listed([...new Set(conversationsGone)])}`
      : null,
  ].filter((part) => part !== null);
  return `the earlier export holds ${lost.join(" and ")}, which the database no longer has; a new snapshot would drop them. Keep this archive, or move ${archiveDir} aside to start a new one`;
}

function exportAgentRunRecords(snapshot: AuditDb, archiveDir: string): void {
  if (!tableExists(snapshot, "agent_run_records")) return;
  const rows = snapshot
    .prepare("SELECT * FROM agent_run_records ORDER BY started_at, run_id")
    .all();
  writeAtomically(
    path.join(archiveDir, AGENT_RUN_RECORDS_FILE),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
}

function countTables(snapshot: AuditDb): Record<string, number> {
  const tables: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    if (!tableExists(snapshot, table)) continue;
    tables[table] = countRows(snapshot, `SELECT COUNT(*) AS n FROM ${table}`);
  }
  return tables;
}

export function exportGraphWorkflowArchive(
  deps: ArchiveExportDeps,
): ArchiveExportResult {
  const refusal = sourceRefusal(deps);
  if (refusal !== null) return { ok: false, reason: refusal };
  const archiveDir = path.join(deps.configDir, ARCHIVE_SUBDIR);
  const previous = readPreviousManifest(archiveDir);
  if (!previous.ok) return previous;

  mkdirSync(archiveDir, { recursive: true });
  const snapshotPath = path.join(archiveDir, SNAPSHOT_FILE);
  const pendingSnapshot = `${snapshotPath}${PENDING_SUFFIX}`;
  rmSync(pendingSnapshot, { force: true });
  deps.source.prepare("VACUUM INTO ?").run(pendingSnapshot);

  const snapshot = deps.openSnapshot(pendingSnapshot);
  let body: Omit<ArchiveManifest, "files"> | { refusal: string };
  try {
    const runs = archivedRuns(snapshot);
    const dropped =
      previous.manifest === null
        ? null
        : droppedSincePreviousExport(
            previous.manifest,
            snapshot,
            runs,
            archiveDir,
          );
    if (dropped !== null) {
      body = { refusal: dropped };
    } else {
      const gaps: ArchiveGap[] = [];
      for (const directory of COPIED_DIRECTORIES) {
        mirrorDirectory(
          path.join(deps.configDir, directory),
          path.join(archiveDir, directory),
          directory,
          gaps,
        );
      }
      const executions = runs.map((row) =>
        archiveExecution(
          deps,
          snapshot,
          archiveDir,
          row,
          previous.manifest?.executions.find(
            (entry) => entry.executionId === row.executionId,
          ),
          gaps,
        ),
      );
      exportAgentRunRecords(snapshot, archiveDir);
      body = {
        format: ARCHIVE_FORMAT,
        exportedAt: deps.now().toISOString(),
        sourceConfigDir: deps.configDir,
        database: { file: SNAPSHOT_FILE, tables: countTables(snapshot) },
        executions,
        gaps,
        limits: ARCHIVE_LIMITS,
      };
    }
  } finally {
    snapshot.close();
  }
  if ("refusal" in body) {
    rmSync(pendingSnapshot, { force: true });
    return { ok: false, reason: body.refusal };
  }
  renameSync(pendingSnapshot, snapshotPath);
  const manifest: ArchiveManifest = {
    ...body,
    files: hashArchiveFiles(archiveDir),
  };
  writeAtomically(
    path.join(archiveDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { ok: true, archiveDir, manifest };
}

/**
 * Checks the archive against its own manifest: every file's hash (the
 * snapshot's included), every run without an execution gap rendered by the
 * audit extractor from the archive alone, and every archive ref in a
 * repository still present.
 */
export function verifyGraphWorkflowArchive(deps: {
  archiveDir: string;
  openSnapshot(filePath: string): ArchiveSnapshotDb;
  runGit(args: string[], cwd: string): GitResult;
}): string[] {
  const previous = readPreviousManifest(deps.archiveDir);
  if (!previous.ok) return [previous.reason];
  const manifest = previous.manifest;
  if (manifest === null) {
    return [`no ${MANIFEST_FILE} in ${deps.archiveDir}`];
  }
  const problems: string[] = [];
  for (const [file, expected] of Object.entries(manifest.files)) {
    const full = path.join(deps.archiveDir, file);
    if (!isFile(full)) problems.push(`${file}: missing`);
    else if (fileSha256(full) !== expected.sha256) {
      problems.push(`${file}: content differs from the manifest`);
    }
  }

  const snapshotPath = path.join(deps.archiveDir, manifest.database.file);
  if (isFile(snapshotPath)) {
    const snapshot = deps.openSnapshot(snapshotPath);
    try {
      const unreadable = new Set(
        manifest.gaps
          .filter((gap) => gap.kind === "execution")
          .map((gap) => gap.executionId),
      );
      for (const entry of manifest.executions) {
        if (unreadable.has(entry.executionId)) continue;
        try {
          const input = loadAuditInput(
            {
              db: snapshot,
              logsBaseDir: path.join(deps.archiveDir, "workflow-logs"),
              transcriptsDir: path.join(deps.archiveDir, "transcripts"),
            },
            { executionId: entry.executionId },
          );
          if (input === null) {
            problems.push(`${entry.executionId}: not in the snapshot`);
          } else {
            renderMarkdown(buildAuditReport(input));
          }
        } catch (error) {
          problems.push(
            `${entry.executionId}: the audit report fails (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    } finally {
      snapshot.close();
    }
  }

  for (const entry of manifest.executions) {
    if (!existsSync(entry.projectPath)) continue;
    for (const { ref, commit } of entry.lanes.flatMap((lane) => lane.refs)) {
      const actual = gitOutput(
        deps.runGit(
          ["rev-parse", "--verify", "--quiet", ref],
          entry.projectPath,
        ),
      );
      if (actual !== commit) {
        problems.push(
          `${ref} in ${entry.projectPath}: ${actual === null ? "missing" : `points at ${actual}`}, archived ${commit}`,
        );
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  let values: { "config-dir"?: string; verify?: boolean };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "config-dir": { type: "string" },
        verify: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(
      `workflow-archive: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  const configDir =
    values["config-dir"] ??
    resolveConfigDirFrom(process.env, {
      platform: process.platform,
      homedir: homedir(),
    });
  const archiveDir = path.join(configDir, ARCHIVE_SUBDIR);
  const { Database } = await import("bun:sqlite");
  const openSnapshot = (filePath: string) =>
    new Database(filePath, { readonly: true });

  if (values.verify !== true) {
    const opened = await openReadonlyDatabase(
      path.join(configDir, "command-center.db"),
    );
    if (!opened.ok) {
      console.error(`workflow-archive: ${opened.reason}`);
      process.exit(1);
    }
    let result: ArchiveExportResult;
    try {
      result = exportGraphWorkflowArchive({
        source: opened.db,
        configDir,
        openSnapshot,
        runGit: runGitCommand,
        isProcessAlive,
        now: () => new Date(),
      });
    } finally {
      opened.db.close();
    }
    if (!result.ok) {
      console.error(`workflow-archive: refused: ${result.reason}`);
      process.exit(1);
    }
    const { manifest } = result;
    const refs = manifest.executions.flatMap((entry) =>
      entry.lanes.flatMap((lane) => lane.refs),
    ).length;
    console.log(`Archived to ${archiveDir}`);
    console.log(
      `  ${manifest.executions.length} run(s), ${Object.keys(manifest.files).length} file(s), ${refs} archive ref(s)`,
    );
    console.log(`  rows: ${JSON.stringify(manifest.database.tables)}`);
    console.log(`  ${manifest.gaps.length} gap(s)`);
    for (const gap of manifest.gaps) {
      console.log(
        `    ${gap.kind}  ${gap.executionId ?? "-"}  ${gap.subject}: ${gap.reason}`,
      );
    }
  }

  const problems = verifyGraphWorkflowArchive({
    archiveDir,
    openSnapshot,
    runGit: runGitCommand,
  });
  if (problems.length > 0) {
    console.error(
      `workflow-archive: verification found ${problems.length} problem(s)`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    "Verified: every file and archive ref matches the manifest, and every readable run renders from the archive.",
  );
}
