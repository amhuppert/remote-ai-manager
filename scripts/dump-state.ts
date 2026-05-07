#!/usr/bin/env bun
/**
 * Read-only CLI dump of the consolidated `command-center.db` SQLite store.
 *
 * Usage:
 *   bun scripts/dump-state.ts                       # default summary
 *   bun scripts/dump-state.ts --project /path       # one project
 *   bun scripts/dump-state.ts --project P --session S
 *   bun scripts/dump-state.ts --conversation <id>
 *   bun scripts/dump-state.ts --json                # raw row JSON
 *
 * Safe to run while the dev server is running — WAL allows concurrent readers,
 * the script never writes.
 */

import { parseArgs } from "node:util";
import type Database from "better-sqlite3";
import { getStateDb } from "../src/lib/state-store/state-store";

type Db = InstanceType<typeof Database>;

export interface DumpStateOptions {
  project?: string;
  session?: string;
  conversation?: string;
  json?: boolean;
}

export interface DumpStateDeps {
  db: Db;
  out: (line: string) => void;
}

const RECENT_SESSION_LIMIT = 10;

interface ProjectRowSummary {
  rootPath: string;
  archived: number;
  pinned: number;
  pinOrder: number | null;
  sessionCount: number;
}

interface SessionRowSummary {
  projectPath: string;
  sessionName: string;
  lastActivityAt: string;
  archived: number;
  finished: number;
}

interface MigrationRow {
  version: number;
  description: string;
  appliedAt: string;
}

export function parseDumpStateArgs(argv: string[]): DumpStateOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      session: { type: "string" },
      conversation: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    project: values.project,
    session: values.session,
    conversation: values.conversation,
    json: values.json === true,
  };
}

export function runDumpState(
  deps: DumpStateDeps,
  options: DumpStateOptions,
): void {
  if (options.conversation !== undefined) {
    dumpConversation(deps, options.conversation, options.json === true);
    return;
  }

  if (options.project !== undefined && options.session !== undefined) {
    dumpSession(deps, options.project, options.session, options.json === true);
    return;
  }

  if (options.project !== undefined) {
    dumpProject(deps, options.project, options.json === true);
    return;
  }

  dumpDefault(deps, options.json === true);
}

function dumpDefault(deps: DumpStateDeps, json: boolean): void {
  if (json) {
    const projects = deps.db
      .prepare(`SELECT * FROM projects ORDER BY root_path ASC`)
      .all() as Record<string, unknown>[];
    const sessions = deps.db
      .prepare(
        `SELECT * FROM sessions
         ORDER BY last_activity_at DESC, session_name ASC
         LIMIT ?`,
      )
      .all(RECENT_SESSION_LIMIT) as Record<string, unknown>[];
    const jobRecords = deps.db
      .prepare(`SELECT * FROM job_records ORDER BY started_at DESC, job_id ASC`)
      .all() as Record<string, unknown>[];
    const schemaMigrations = deps.db
      .prepare(`SELECT * FROM schema_migrations ORDER BY version ASC`)
      .all() as Record<string, unknown>[];
    deps.out(
      JSON.stringify(
        {
          projects,
          sessions,
          job_records: jobRecords,
          schema_migrations: schemaMigrations,
        },
        null,
        2,
      ),
    );
    return;
  }

  emitProjectsSection(deps, listProjectSummaries(deps.db));
  emitRecentActivitySection(
    deps,
    listRecentSessions(deps.db, RECENT_SESSION_LIMIT),
  );
  emitJobsSection(deps, countJobsByStatus(deps.db));
  emitMigrationsSection(deps, listSchemaMigrations(deps.db));
}

function dumpProject(
  deps: DumpStateDeps,
  projectPath: string,
  json: boolean,
): void {
  const project = deps.db
    .prepare(`SELECT * FROM projects WHERE root_path = ?`)
    .get(projectPath) as Record<string, unknown> | undefined;
  const sessions = deps.db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_path = ?
       ORDER BY last_activity_at DESC, session_name ASC`,
    )
    .all(projectPath) as Record<string, unknown>[];
  const conversations = deps.db
    .prepare(
      `SELECT * FROM conversations
       WHERE project_path = ?
       ORDER BY last_activity_at DESC, id ASC`,
    )
    .all(projectPath) as Record<string, unknown>[];
  const referenceDocuments = deps.db
    .prepare(
      `SELECT * FROM reference_documents
       WHERE project_path = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(projectPath) as Record<string, unknown>[];
  const roadmapItems = deps.db
    .prepare(
      `SELECT * FROM roadmap_items
       WHERE project_path = ?
       ORDER BY sort_order ASC, created_at ASC, id ASC`,
    )
    .all(projectPath) as Record<string, unknown>[];

  if (json) {
    deps.out(
      JSON.stringify(
        {
          project: project ?? null,
          sessions,
          conversations,
          referenceDocuments,
          roadmapItems,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (project === undefined) {
    deps.out(`No project found at root_path = ${projectPath}`);
    return;
  }

  deps.out(`Project: ${projectPath}`);
  deps.out(`  archived=${project["archived"] === 1 ? "yes" : "no"}`);
  deps.out(`  pinned=${project["pinned"] === 1 ? "yes" : "no"}`);
  deps.out("");

  deps.out(`Sessions (${sessions.length}):`);
  for (const s of sessions) {
    deps.out(
      `  ${asString(s["session_name"])}  last_activity=${asString(s["last_activity_at"])}  archived=${s["archived"] === 1 ? "y" : "n"}  finished=${s["finished"] === 1 ? "y" : "n"}`,
    );
  }
  deps.out("");

  deps.out(`Conversations (${conversations.length}):`);
  for (const c of conversations) {
    deps.out(
      `  ${asString(c["id"])}  session=${asString(c["session_name"])}  status=${asString(c["status"])}  last_activity=${asString(c["last_activity_at"])}`,
    );
  }
  deps.out("");

  deps.out(`Reference documents (${referenceDocuments.length}):`);
  for (const r of referenceDocuments) {
    deps.out(
      `  ${asString(r["id"])}  session=${asString(r["session_name"])}  path=${asString(r["file_path"])}`,
    );
  }
  deps.out("");

  deps.out(`Roadmap items (${roadmapItems.length}):`);
  for (const r of roadmapItems) {
    deps.out(
      `  ${asString(r["id"])}  type=${asString(r["type"])}  status=${asString(r["status"])}  title=${asString(r["title"])}`,
    );
  }
}

function dumpSession(
  deps: DumpStateDeps,
  projectPath: string,
  sessionName: string,
  json: boolean,
): void {
  const session = deps.db
    .prepare(
      `SELECT * FROM sessions WHERE project_path = ? AND session_name = ?`,
    )
    .get(projectPath, sessionName) as Record<string, unknown> | undefined;
  const conversations = deps.db
    .prepare(
      `SELECT * FROM conversations
       WHERE project_path = ? AND session_name = ?
       ORDER BY last_activity_at DESC, id ASC`,
    )
    .all(projectPath, sessionName) as Record<string, unknown>[];
  const referenceDocuments = deps.db
    .prepare(
      `SELECT * FROM reference_documents
       WHERE project_path = ? AND session_name = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(projectPath, sessionName) as Record<string, unknown>[];

  if (json) {
    deps.out(
      JSON.stringify(
        { session: session ?? null, conversations, referenceDocuments },
        null,
        2,
      ),
    );
    return;
  }

  if (session === undefined) {
    deps.out(
      `No session found for project=${projectPath} session=${sessionName}`,
    );
    return;
  }

  deps.out(`Session: ${sessionName}  (project=${projectPath})`);
  deps.out(`  worktree=${asString(session["worktree_path"])}`);
  deps.out(`  branch=${asString(session["branch_name"])}`);
  deps.out(`  created_at=${asString(session["created_at"])}`);
  deps.out(`  last_activity_at=${asString(session["last_activity_at"])}`);
  deps.out(
    `  archived=${session["archived"] === 1 ? "yes" : "no"}  finished=${session["finished"] === 1 ? "yes" : "no"}`,
  );
  deps.out("");

  deps.out(`Conversations (${conversations.length}):`);
  for (const c of conversations) {
    deps.out(
      `  ${asString(c["id"])}  status=${asString(c["status"])}  prompts=${asNumber(c["prompt_count"])}  last_activity=${asString(c["last_activity_at"])}`,
    );
  }
  deps.out("");

  deps.out(`Reference documents (${referenceDocuments.length}):`);
  for (const r of referenceDocuments) {
    deps.out(
      `  ${asString(r["id"])}  path=${asString(r["file_path"])}  description=${asString(r["description"])}`,
    );
  }
}

function dumpConversation(
  deps: DumpStateDeps,
  conversationId: string,
  json: boolean,
): void {
  const row = deps.db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    if (json) {
      deps.out(JSON.stringify(null));
    } else {
      deps.out(`No conversation found with id = ${conversationId}`);
    }
    return;
  }

  if (json) {
    deps.out(JSON.stringify(row, null, 2));
    return;
  }

  deps.out(`Conversation: ${conversationId}`);
  for (const [key, value] of Object.entries(row)) {
    deps.out(`  ${key} = ${formatScalar(value)}`);
  }
}

function listProjectSummaries(db: Db): ProjectRowSummary[] {
  const rows = db
    .prepare(
      `SELECT
         p.root_path     AS root_path,
         p.archived      AS archived,
         p.pinned        AS pinned,
         p.pin_order     AS pin_order,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_path = p.root_path) AS session_count
       FROM projects p
       ORDER BY p.pinned DESC, p.pin_order IS NULL, p.pin_order ASC, p.root_path ASC`,
    )
    .all() as Array<{
    root_path: string;
    archived: number;
    pinned: number;
    pin_order: number | null;
    session_count: number;
  }>;
  return rows.map((r) => ({
    rootPath: r.root_path,
    archived: r.archived,
    pinned: r.pinned,
    pinOrder: r.pin_order,
    sessionCount: r.session_count,
  }));
}

function listRecentSessions(db: Db, limit: number): SessionRowSummary[] {
  const rows = db
    .prepare(
      `SELECT project_path, session_name, last_activity_at, archived, finished
       FROM sessions
       ORDER BY last_activity_at DESC, session_name ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    project_path: string;
    session_name: string;
    last_activity_at: string;
    archived: number;
    finished: number;
  }>;
  return rows.map((r) => ({
    projectPath: r.project_path,
    sessionName: r.session_name,
    lastActivityAt: r.last_activity_at,
    archived: r.archived,
    finished: r.finished,
  }));
}

function countJobsByStatus(db: Db): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM job_records GROUP BY status ORDER BY status ASC`,
    )
    .all() as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

function listSchemaMigrations(db: Db): MigrationRow[] {
  const rows = db
    .prepare(
      `SELECT version, description, applied_at
       FROM schema_migrations
       ORDER BY version ASC`,
    )
    .all() as Array<{
    version: number;
    description: string;
    applied_at: string;
  }>;
  return rows.map((r) => ({
    version: r.version,
    description: r.description,
    appliedAt: r.applied_at,
  }));
}

function emitProjectsSection(
  deps: DumpStateDeps,
  projects: ProjectRowSummary[],
): void {
  deps.out(`Projects (${projects.length}):`);
  if (projects.length === 0) {
    deps.out("  (none)");
  }
  for (const p of projects) {
    const flags: string[] = [];
    if (p.archived === 1) flags.push("archived");
    if (p.pinned === 1) flags.push("pinned");
    const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    deps.out(`  ${p.rootPath}  sessions: ${p.sessionCount}${suffix}`);
  }
  deps.out("");
}

function emitRecentActivitySection(
  deps: DumpStateDeps,
  sessions: SessionRowSummary[],
): void {
  deps.out(`Recent activity (last ${RECENT_SESSION_LIMIT} sessions):`);
  if (sessions.length === 0) {
    deps.out("  (none)");
  }
  for (const s of sessions) {
    deps.out(`  ${s.lastActivityAt}  ${s.sessionName}  (${s.projectPath})`);
  }
  deps.out("");
}

function emitJobsSection(
  deps: DumpStateDeps,
  jobsByStatus: Record<string, number>,
): void {
  const entries = Object.entries(jobsByStatus);
  deps.out("Jobs by status:");
  if (entries.length === 0) {
    deps.out("  (none)");
  }
  for (const [status, count] of entries) {
    deps.out(`  ${status}: ${count}`);
  }
  deps.out("");
}

function emitMigrationsSection(
  deps: DumpStateDeps,
  rows: MigrationRow[],
): void {
  deps.out("Schema migrations:");
  if (rows.length === 0) {
    deps.out("  (none)");
  }
  for (const r of rows) {
    deps.out(`  ${r.version}  ${r.appliedAt}  ${r.description}`);
  }
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return 0;
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let options: DumpStateOptions;
  try {
    options = parseDumpStateArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`dump-state: ${message}`);
    process.exit(2);
  }
  const db = getStateDb();
  runDumpState(
    {
      db,
      out: (line) => {
        console.log(line);
      },
    },
    options,
  );
}
