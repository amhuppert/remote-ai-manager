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
 *
 * The database is opened with `readonly: true` on purpose: this tool must be
 * safe to point at the live instance's config dir while the server runs.
 * Never open it through the state-store (`getStateDb`) — that path executes
 * schema-floor DDL on connect, which writes to the live DB.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
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
    json: values.json === true,
    list: values.list === true,
  };
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

interface RawExecutionHit {
  source: "active" | "archived";
  raw: Record<string, unknown>;
  projectPath: string | null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
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
  const activeRow = activeQuery as
    | { definition_json: string; runtime_json: string; project_path: string }
    | undefined;
  if (activeRow !== undefined) {
    const definition = parseJsonRecord(activeRow.definition_json);
    const runtime = parseJsonRecord(activeRow.runtime_json);
    if (definition !== null && runtime !== null) {
      return {
        source: "active",
        raw: { ...definition, ...runtime },
        projectPath: activeRow.project_path,
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
  const archivedRow = archivedQuery as
    | { execution_json: string; project_path: string }
    | undefined;
  if (archivedRow !== undefined) {
    const raw = parseJsonRecord(archivedRow.execution_json);
    if (raw !== null) {
      return {
        source: "archived",
        raw,
        projectPath: archivedRow.project_path,
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

function collectConversationIds(
  execution: AuditInput["execution"],
  events: AuditEvent[],
): string[] {
  const ids = new Set<string>();
  for (const task of Object.values(execution.taskStates)) {
    if (task.lastConversationId !== null) ids.add(task.lastConversationId);
  }
  for (const lanes of Object.values(execution.laneStates)) {
    for (const lane of Object.values(lanes)) {
      const fromRef = lane.sessionRef?.conversationId;
      if (typeof fromRef === "string" && fromRef.length > 0) ids.add(fromRef);
      if (lane.workflowConversationId !== null) {
        ids.add(lane.workflowConversationId);
      }
    }
  }
  for (const event of events) {
    const direct = event.fields.conversationId;
    if (typeof direct === "string" && direct.length > 0) ids.add(direct);
    const sessionRef = event.fields.sessionRef;
    if (
      typeof sessionRef === "object" &&
      sessionRef !== null &&
      !Array.isArray(sessionRef)
    ) {
      const nested = (sessionRef as Record<string, unknown>).conversationId;
      if (typeof nested === "string" && nested.length > 0) ids.add(nested);
    }
  }
  return [...ids];
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
    const transcriptPath =
      row.transcript_path ??
      (transcriptsDir !== null
        ? path.join(transcriptsDir, `${row.id}.jsonl`)
        : null);
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
    const promptsDir = path.join(contextDir, "prompts");
    if (existsSync(promptsDir)) {
      for (const file of readdirSync(promptsDir).sort()) {
        if (!file.endsWith(".json")) continue;
        const parsed = parseJsonRecord(
          readFileSync(path.join(promptsDir, file), "utf8"),
        );
        const parsePath = parsed?.parsePath;
        validatorResponses.push({
          file,
          parsePath: typeof parsePath === "string" ? parsePath : null,
        });
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

export interface LoadDeps {
  db: AuditDb;
  logsBaseDir: string;
  transcriptsDir: string | null;
  /** Optional git runner enabling final-publish diffstat resolution. */
  runGit?(args: string[], cwd: string): string | null;
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
  const events = loadEvents(deps.db, execution.id);
  const conversations = loadConversations(
    deps.db,
    collectConversationIds(execution, events),
    deps.transcriptsDir,
  );
  const executionLogsDir = path.join(deps.logsBaseDir, execution.id);
  const logsDirExists = existsSync(executionLogsDir);
  const runGit = deps.runGit;
  return {
    source: hit.source,
    execution,
    events,
    conversations,
    contextLogs: logsDirExists ? loadContextLogs(executionLogsDir) : {},
    lifecycle: logsDirExists
      ? readJsonlFile(path.join(executionLogsDir, "lifecycle.jsonl"))
      : [],
    decisions: logsDirExists
      ? readJsonlFile(path.join(executionLogsDir, "decisions.jsonl"))
      : [],
    paths: {
      workflowLogsDir: logsDirExists ? executionLogsDir : null,
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
  const dbPath = path.join(configDir, "command-center.db");
  if (!existsSync(dbPath)) {
    console.error(`workflow-audit: no database at ${dbPath}`);
    process.exit(1);
  }
  // The CLI runs under bun (see package.json), where better-sqlite3's native
  // addon cannot load; bun ships its own sqlite driver instead.
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
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
