#!/usr/bin/env bun
/**
 * Read-only audit extractor for graph workflow executions.
 *
 * Pulls one execution's full story out of `command-center.db` and the
 * per-execution `workflow-logs/` directory, then prints a bounded
 * friction/cost/time report (markdown by default, `--json` for the raw
 * structure). Companion skill: `.claude/skills/graph-workflow-audit/`.
 *
 * Usage:
 *   bun run workflow:audit -- --list
 *   bun run workflow:audit -- --execution <executionId>
 *   bun run workflow:audit -- --project /abs/path --session my-session
 *   bun run workflow:audit -- --execution <id> --json
 *   bun run workflow:audit -- --config-dir <cfg>/archive/graph-workflows \
 *     --db <cfg>/archive/graph-workflows/command-center.db.backup --list
 *
 * The database is opened with `readonly: true` on purpose: this tool must be
 * safe to point at the live instance's config dir while the server runs.
 * Never open it through the state-store (`getStateDb`) — that path executes
 * schema-floor DDL on connect, which writes to the live DB.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Database as BunDatabase } from "bun:sqlite";
import { resolveConfigDirFrom } from "../../src/lib/config/config-dir";
import {
  buildAuditReport,
  parseAuditEvent,
  parseExecutionProjection,
  parseGitNumstat,
  parseJsonlLine,
  renderMarkdown,
  scanTranscriptText,
  type AuditConversationRow,
  type AuditEvent,
  type AuditExecution,
  type AuditInput,
  type ContextLogs,
  type JsonlRecord,
  type RuntimeAdmissionEvent,
} from "./core";

/**
 * Structural driver interface satisfied by both better-sqlite3 (tests, node)
 * and bun:sqlite (the CLI path — Bun cannot load better-sqlite3's native
 * addon). Only the read surface the loader needs.
 */
export interface AuditDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface AuditCliOptions {
  execution?: string;
  project?: string;
  session?: string;
  configDir?: string;
  db?: string;
  json: boolean;
  list: boolean;
}

export function parseAuditCliArgs(argv: string[]): AuditCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      execution: { type: "string" },
      project: { type: "string" },
      session: { type: "string" },
      "config-dir": { type: "string" },
      db: { type: "string" },
      json: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    execution: values.execution,
    project: values.project,
    session: values.session,
    configDir: values["config-dir"],
    db: values.db,
    json: values.json === true,
    list: values.list === true,
  };
}

/**
 * Where to open a WAL-mode database read-only. A read-only connection can use
 * an existing `-shm` index and `-wal` log but cannot create them, so without
 * both the file is opened immutable. That is complete only while no log is
 * pending, so a pending log without its index is refused rather than ignored.
 */
export function readonlyDatabaseLocation(
  dbPath: string,
  probe: { exists(filePath: string): boolean; size(filePath: string): number },
): { ok: true; location: string } | { ok: false; reason: string } {
  const wal = `${dbPath}-wal`;
  if (probe.exists(`${dbPath}-shm`) && probe.exists(wal)) {
    return { ok: true, location: dbPath };
  }
  if (probe.exists(wal) && probe.size(wal) > 0) {
    return {
      ok: false,
      reason: `${wal} holds writes not yet merged into the database, and its index is gone; start Command Center once, stop it, then rerun`,
    };
  }
  return { ok: true, location: `${pathToFileURL(dbPath).href}?immutable=1` };
}

/** Opens a database read-only under bun, the CLI's runtime. */
export async function openReadonlyDatabase(
  dbPath: string,
): Promise<{ ok: true; db: BunDatabase } | { ok: false; reason: string }> {
  if (!existsSync(dbPath))
    return { ok: false, reason: `no database at ${dbPath}` };
  const location = readonlyDatabaseLocation(dbPath, {
    exists: existsSync,
    size: (filePath) => statSync(filePath).size,
  });
  if (!location.ok) return location;
  // better-sqlite3's native addon cannot load under bun, which ships its own
  // sqlite driver instead.
  const { Database } = await import("bun:sqlite");
  return { ok: true, db: new Database(location.location, { readonly: true }) };
}

export interface ExecutionListRow {
  executionId: string;
  source: "active" | "archived";
  projectPath: string;
  sessionName: string;
  status: string;
  startedAt: string;
}

export function listExecutions(db: AuditDb): ExecutionListRow[] {
  const active = db
    .prepare(
      `SELECT execution_id, project_path, session_name, status, started_at
       FROM graph_workflow_executions`,
    )
    .all() as Array<{
    execution_id: string;
    project_path: string;
    session_name: string;
    status: string;
    started_at: string;
  }>;
  const archived = db
    .prepare(
      `SELECT execution_id, project_path, session_name, status, started_at
       FROM graph_workflow_archived_executions`,
    )
    .all() as Array<{
    execution_id: string;
    project_path: string;
    session_name: string;
    status: string;
    started_at: string;
  }>;
  const rows: ExecutionListRow[] = [
    ...active.map((row) => ({
      executionId: row.execution_id,
      source: "active" as const,
      projectPath: row.project_path,
      sessionName: row.session_name,
      status: row.status,
      startedAt: row.started_at,
    })),
    ...archived.map((row) => ({
      executionId: row.execution_id,
      source: "archived" as const,
      projectPath: row.project_path,
      sessionName: row.session_name,
      status: row.status,
      startedAt: row.started_at,
    })),
  ];
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface RawExecutionHit {
  source: "active" | "archived";
  raw: Record<string, unknown>;
  projectPath: string | null;
}

function parseJsonRecord(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Normalizes a `.get()` result into a row or a miss. The two drivers behind
 * `AuditDb` disagree on how they report "no rows": better-sqlite3 returns
 * `undefined`, bun:sqlite (the CLI driver) returns `null`. Anything that is not
 * an object is a miss.
 */
function firstRow(result: unknown): Record<string, unknown> | null {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
}

function textColumn(
  row: Record<string, unknown>,
  column: string,
): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function findExecutionRaw(
  db: AuditDb,
  selector: {
    executionId?: string;
    projectPath?: string;
    sessionName?: string;
  },
): RawExecutionHit | null {
  const { executionId, projectPath, sessionName } = selector;

  const activeQuery =
    executionId !== undefined
      ? db
          .prepare(
            `SELECT definition_json, runtime_json, project_path FROM graph_workflow_executions
             WHERE execution_id = ?`,
          )
          .get(executionId)
      : projectPath !== undefined && sessionName !== undefined
        ? db
            .prepare(
              `SELECT definition_json, runtime_json, project_path FROM graph_workflow_executions
               WHERE project_path = ? AND session_name = ?`,
            )
            .get(projectPath, sessionName)
        : undefined;
  const activeRow = firstRow(activeQuery);
  if (activeRow !== null) {
    const definition = parseJsonRecord(activeRow.definition_json);
    const runtime = parseJsonRecord(activeRow.runtime_json);
    if (definition !== null && runtime !== null) {
      return {
        source: "active",
        raw: { ...definition, ...runtime },
        projectPath: textColumn(activeRow, "project_path"),
      };
    }
  }

  const archivedQuery =
    executionId !== undefined
      ? db
          .prepare(
            `SELECT execution_json, project_path FROM graph_workflow_archived_executions
             WHERE execution_id = ?`,
          )
          .get(executionId)
      : projectPath !== undefined && sessionName !== undefined
        ? db
            .prepare(
              `SELECT execution_json, project_path FROM graph_workflow_archived_executions
               WHERE project_path = ? AND session_name = ?
               ORDER BY archived_at DESC LIMIT 1`,
            )
            .get(projectPath, sessionName)
        : undefined;
  const archivedRow = firstRow(archivedQuery);
  if (archivedRow !== null) {
    const raw = parseJsonRecord(archivedRow.execution_json);
    if (raw !== null) {
      return {
        source: "archived",
        raw,
        projectPath: textColumn(archivedRow, "project_path"),
      };
    }
  }
  return null;
}

function loadEvents(db: AuditDb, executionId: string): AuditEvent[] {
  const rows = db
    .prepare(
      `SELECT occurred_at, pre_reset, event_json FROM graph_workflow_events
       WHERE execution_id = ? ORDER BY id ASC`,
    )
    .all(executionId) as Array<{
    occurred_at: string;
    pre_reset: number;
    event_json: string;
  }>;
  const events: AuditEvent[] = [];
  for (const row of rows) {
    const payload = parseJsonRecord(row.event_json);
    if (payload === null) continue;
    const event = parseAuditEvent({
      occurredAt: row.occurred_at,
      preReset: row.pre_reset !== 0,
      payload,
    });
    if (event !== null) events.push(event);
  }
  return events;
}

/** Fields naming a conversation that worked in the run. */
const PARTICIPANT_KEYS = new Set([
  "conversationId",
  "workflowConversationId",
  "lastConversationId",
  "initiatorConversationId",
]);
/** Fields naming a conversation that launched or received the run. */
const PROVENANCE_KEYS = new Set([
  "ownerConversationId",
  "originConversationId",
]);
/**
 * Agent, author and launch data: a `conversationId` inside is the
 * application's own value, not a reference to a CC conversation.
 */
const PAYLOAD_KEYS = new Set([
  "boundInputs",
  "charter",
  "contextOutputs",
  "launchDocument",
  "machineSnapshot",
  "outputCandidate",
  "payload",
  "pendingActions",
  "rejectedOutput",
  "reviewedCandidate",
  "reviewedOutput",
  "sharedDocuments",
  "structuredOutput",
  "value",
  "workingDefinition",
]);

export interface ConversationReferences {
  /** Lane, task, validator, approval and question conversations. */
  participants: string[];
  /** The owner, a result's origin and an abandoning actor. */
  provenance: string[];
}

/**
 * The conversations a run's stored records name, in any of the shapes its
 * writers used (task, lane, session-ref, approval and log fields, and the
 * `ref` of a conversation-kind review artifact), at any depth outside payload
 * data: validation specialists nest theirs.
 */
export function collectConversationReferences(
  sources: unknown[],
): ConversationReferences {
  const participants = new Set<string>();
  const provenance = new Set<string>();
  const visit = (value: unknown, asProvenance: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, asProvenance);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const add = (id: unknown, isProvenance: boolean) => {
      if (typeof id !== "string" || id.length === 0) return;
      (isProvenance ? provenance : participants).add(id);
    };
    for (const [key, field] of Object.entries(record)) {
      if (PAYLOAD_KEYS.has(key)) continue;
      if (PROVENANCE_KEYS.has(key)) add(field, true);
      else if (PARTICIPANT_KEYS.has(key)) add(field, asProvenance);
      else visit(field, asProvenance || key === "abandonment");
    }
    if (record.kind === "conversation") add(record.ref, asProvenance);
  };
  for (const source of sources) visit(source, false);
  return {
    participants: [...participants].sort(),
    provenance: [...provenance].filter((id) => !participants.has(id)).sort(),
  };
}

function loadConversations(
  db: AuditDb,
  ids: string[],
  transcriptsDir: string | null,
): AuditConversationRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, role, total_cost_usd, total_duration_ms, total_turns,
              context_tokens, context_window_max, transcript_path
       FROM conversations WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    role: string | null;
    total_cost_usd: number | null;
    total_duration_ms: number | null;
    total_turns: number | null;
    context_tokens: number | null;
    context_window_max: number | null;
    transcript_path: string | null;
  }>;
  return rows.map((row) => {
    // The given directory wins over the stored absolute path, which names the
    // live config directory: an archive must read its own copies.
    const transcriptPath =
      transcriptsDir !== null
        ? path.join(transcriptsDir, `${row.id}.jsonl`)
        : row.transcript_path;
    return {
      id: row.id,
      role: row.role,
      totalCostUsd: row.total_cost_usd,
      totalDurationMs: row.total_duration_ms,
      totalTurns: row.total_turns,
      contextTokens: row.context_tokens,
      contextWindowMax: row.context_window_max,
      transcriptPath,
      transcriptScan: readTranscriptScan(transcriptPath),
    };
  });
}

function readTranscriptScan(
  transcriptPath: string | null,
): AuditConversationRow["transcriptScan"] {
  if (transcriptPath === null || !existsSync(transcriptPath)) return null;
  try {
    return scanTranscriptText(readFileSync(transcriptPath, "utf8"));
  } catch {
    return null;
  }
}

export interface GitRunner {
  /** Runs git with the given args in cwd; null on any failure. */
  runGit(args: string[], cwd: string): string | null;
}

/**
 * Locates the execution's final_publish join commit (the join id is embedded
 * in the commit subject) and returns its diffstat. Best-effort: any git or
 * lookup failure yields null rather than failing the audit.
 */
export function resolveFinalPublish(
  execution: AuditExecution,
  projectPath: string | null,
  git: GitRunner,
): AuditInput["finalPublish"] {
  if (projectPath === null) return null;
  const joinId = Object.entries(execution.joins).find(
    ([, join]) => join.kind === "final_publish" && join.status === "succeeded",
  )?.[0];
  if (joinId === undefined) return null;
  const sha = git
    .runGit(
      ["log", "--all", "-n", "1", "--format=%H", `--grep=${joinId}`],
      projectPath,
    )
    ?.trim();
  if (sha === undefined || sha.length === 0) return null;
  const numstat = git.runGit(
    ["show", "--numstat", "--format=", sha],
    projectPath,
  );
  if (numstat === null) return null;
  const files = parseGitNumstat(numstat);
  if (files.length === 0) return null;
  return { commitSha: sha, files };
}

function readJsonlFile(filePath: string): ContextLogs["iterations"] {
  if (!existsSync(filePath)) return [];
  const records: ContextLogs["iterations"] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const record = parseJsonlLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

function collectValidatorResponses(
  dir: string,
  filePrefix: string,
  into: ContextLogs["validatorResponses"],
): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const parsed = parseJsonRecord(readFileSync(path.join(dir, file), "utf8"));
    const parsePath = parsed?.parsePath;
    into.push({
      file: `${filePrefix}${file}`,
      parsePath: typeof parsePath === "string" ? parsePath : null,
    });
  }
}

function loadContextLogs(
  executionLogsDir: string,
): Record<string, ContextLogs> {
  const contextsDir = path.join(executionLogsDir, "contexts");
  if (!existsSync(contextsDir)) return {};
  const logs: Record<string, ContextLogs> = {};
  for (const entry of readdirSync(contextsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contextDir = path.join(contextsDir, entry.name);
    const validatorResponses: ContextLogs["validatorResponses"] = [];
    // Two locations, because a context validated by a cohort writes one
    // response per assignment under `validators/<assignmentId>/`, while
    // `prompts/` holds the pre-cohort layout that archived runs still carry.
    // The recorded `file` keeps the assignment prefix so an audit can tell
    // which specialist a fallback parse came from.
    collectValidatorResponses(
      path.join(contextDir, "prompts"),
      "",
      validatorResponses,
    );
    const validatorsDir = path.join(contextDir, "validators");
    if (existsSync(validatorsDir)) {
      for (const assignment of readdirSync(validatorsDir, {
        withFileTypes: true,
      })) {
        if (!assignment.isDirectory()) continue;
        collectValidatorResponses(
          path.join(validatorsDir, assignment.name),
          `validators/${assignment.name}/`,
          validatorResponses,
        );
      }
    }
    logs[entry.name] = {
      iterations: readJsonlFile(path.join(contextDir, "iterations.jsonl")),
      tasks: readJsonlFile(path.join(contextDir, "tasks.jsonl")),
      validation: readJsonlFile(path.join(contextDir, "validation.jsonl")),
      validatorResponses,
    };
  }
  return logs;
}

/** Stream literal LF records: Node readline also splits valid JSON strings at U+2028/U+2029. */
function* readLogLines(filePath: string): Generator<string> {
  const fd = openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  try {
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      remainder += decoder.write(buffer.subarray(0, bytes));
      let newline: number;
      while ((newline = remainder.indexOf("\n")) >= 0) {
        yield remainder.slice(0, newline);
        remainder = remainder.slice(newline + 1);
      }
    }
    remainder += decoder.end();
    if (remainder.length > 0) yield remainder;
  } finally {
    closeSync(fd);
  }
}

function loadRuntimeAdmissionEvents(
  filePath: string | undefined,
  execution: AuditExecution,
  conversationIds: Set<string>,
): RuntimeAdmissionEvent[] {
  if (filePath === undefined || !existsSync(filePath)) return [];
  const events: RuntimeAdmissionEvent[] = [];
  const started = Date.parse(execution.startedAt);
  const completed =
    execution.completedAt === null
      ? Infinity
      : Date.parse(execution.completedAt);
  for (const line of readLogLines(filePath)) {
    if (!line.includes(execution.id)) continue;
    if (
      !line.includes("graph-workflow.advisory_response.turn_started") &&
      !line.includes("conversation-manager.turn_admitted")
    )
      continue;
    const record = parseJsonRecord(line);
    if (record === null || record.action !== `workflow:${execution.id}`)
      continue;
    const kind =
      record.message === "graph-workflow.advisory_response.turn_started"
        ? "advisory_requested"
        : record.message === "conversation-manager.turn_admitted"
          ? "admitted"
          : null;
    const timestamp = textColumn(record, "timestamp");
    const traceId = textColumn(record, "traceId");
    const conversationId = textColumn(record, "conversationId");
    if (
      kind === null ||
      timestamp === null ||
      traceId === null ||
      conversationId === null ||
      !conversationIds.has(conversationId)
    )
      continue;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || at < started || at > completed) continue;
    events.push({
      kind,
      timestamp,
      traceId,
      conversationId,
      contextId: textColumn(record, "contextId"),
    });
  }
  return events;
}

export interface LoadDeps {
  runtimeLogPath?: string;
  db: AuditDb;
  logsBaseDir: string;
  transcriptsDir: string | null;
  /** Optional git runner enabling final-publish diffstat resolution. */
  runGit?(args: string[], cwd: string): string | null;
}

/** A run's event log and `workflow-logs/<executionId>/` records. */
export interface ExecutionLogs {
  events: AuditEvent[];
  contextLogs: Record<string, ContextLogs>;
  lifecycle: JsonlRecord[];
  decisions: JsonlRecord[];
  workflowLogsDir: string | null;
}

export function loadExecutionLogs(
  db: AuditDb,
  logsBaseDir: string,
  executionId: string,
): ExecutionLogs {
  const executionLogsDir = path.join(logsBaseDir, executionId);
  const logsDirExists = existsSync(executionLogsDir);
  return {
    events: loadEvents(db, executionId),
    contextLogs: logsDirExists ? loadContextLogs(executionLogsDir) : {},
    lifecycle: logsDirExists
      ? readJsonlFile(path.join(executionLogsDir, "lifecycle.jsonl"))
      : [],
    decisions: logsDirExists
      ? readJsonlFile(path.join(executionLogsDir, "decisions.jsonl"))
      : [],
    workflowLogsDir: logsDirExists ? executionLogsDir : null,
  };
}

/** The conversations a run names across its record, events and logs. */
export function namedConversations(
  record: Record<string, unknown> | null,
  logs: ExecutionLogs,
): ConversationReferences {
  const logRecords = [
    ...logs.lifecycle,
    ...logs.decisions,
    ...Object.values(logs.contextLogs).flatMap((context) => [
      ...context.iterations,
      ...context.tasks,
      ...context.validation,
    ]),
  ];
  return collectConversationReferences([
    record,
    ...logs.events.map((event) => event.fields),
    ...logRecords.map((entry) => entry.fields),
  ]);
}

/** A run's stored record by id; null when absent or not readable JSON. */
export function readExecutionRecord(
  db: AuditDb,
  executionId: string,
): RawExecutionHit | null {
  return findExecutionRaw(db, { executionId });
}

export function loadAuditInput(
  deps: LoadDeps,
  selector: {
    executionId?: string;
    projectPath?: string;
    sessionName?: string;
  },
): AuditInput | null {
  const hit = findExecutionRaw(deps.db, selector);
  if (hit === null) return null;
  const parsed = parseExecutionProjection(hit.raw);
  if (!parsed.ok) {
    throw new Error(`stored execution failed to parse: ${parsed.error}`);
  }
  const execution = parsed.execution;
  const logs = loadExecutionLogs(deps.db, deps.logsBaseDir, execution.id);
  // Cost and timing cover the run's participants; the conversation that
  // launched it carries its own, unrelated history.
  const conversations = loadConversations(
    deps.db,
    namedConversations(hit.raw, logs).participants,
    deps.transcriptsDir,
  );
  const runGit = deps.runGit;
  return {
    source: hit.source,
    execution,
    events: logs.events,
    conversations,
    contextLogs: logs.contextLogs,
    runtimeAdmissionEvents: loadRuntimeAdmissionEvents(
      deps.runtimeLogPath,
      execution,
      new Set(conversations.map((conversation) => conversation.id)),
    ),
    lifecycle: logs.lifecycle,
    decisions: logs.decisions,
    paths: {
      workflowLogsDir: logs.workflowLogsDir,
      transcriptsDir: deps.transcriptsDir,
    },
    finalPublish:
      runGit !== undefined
        ? resolveFinalPublish(execution, hit.projectPath, {
            runGit: (args, cwd) => runGit(args, cwd),
          })
        : null,
  };
}

if (import.meta.main) {
  let options: AuditCliOptions;
  try {
    options = parseAuditCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `workflow-audit: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const configDir =
    options.configDir ??
    resolveConfigDirFrom(process.env, {
      platform: process.platform,
      homedir: homedir(),
    });
  const opened = await openReadonlyDatabase(
    options.db ?? path.join(configDir, "command-center.db"),
  );
  if (!opened.ok) {
    console.error(`workflow-audit: ${opened.reason}`);
    process.exit(1);
  }
  const db = opened.db;
  try {
    if (options.list) {
      for (const row of listExecutions(db)) {
        console.log(
          `${row.startedAt}  ${row.executionId}  ${row.status.padEnd(9)}  ${row.source.padEnd(8)}  ${row.projectPath} :: ${row.sessionName}`,
        );
      }
      process.exit(0);
    }
    if (
      options.execution === undefined &&
      (options.project === undefined || options.session === undefined)
    ) {
      console.error(
        "workflow-audit: pass --execution <id>, or --project <path> --session <name>, or --list",
      );
      process.exit(2);
    }
    const input = loadAuditInput(
      {
        db,
        logsBaseDir: path.join(configDir, "workflow-logs"),
        runtimeLogPath: path.join(configDir, "logs", "global.log"),
        transcriptsDir: path.join(configDir, "transcripts"),
        runGit: (args, cwd) => {
          const result = spawnSync("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            timeout: 15_000,
          });
          return result.status === 0 ? result.stdout : null;
        },
      },
      {
        executionId: options.execution,
        projectPath: options.project,
        sessionName: options.session,
      },
    );
    if (input === null) {
      console.error(
        "workflow-audit: no execution matched the selector (try --list)",
      );
      process.exit(1);
    }
    const report = buildAuditReport(input);
    console.log(
      options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report),
    );
  } finally {
    db.close();
  }
}
