import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

import { computeCharterHash } from "./charter/render";
import { createWorkflowCharterService } from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowStorageService } from "./storage";
import { createWorkflowDefinition } from "./test-fixtures";
import {
  LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
  LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
  LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
  _createTestDbAtPath,
} from "@/lib/state-store/state-db";

/**
 * Charter lifecycle INTEGRATION suite (task 5.3).
 *
 * The observables are exercised end-to-end through the REAL services with DI
 * seams only (no `vi.mock` of internal modules):
 *
 * - Migration: the real `runLegacyWorkflowPurgeMigration` (invoked by
 *   `openStateDb`) over a real temp-path SQLite DB nulls embedded executions and
 *   empties the workflow store as observed through the real storage service,
 *   then makes no further change on re-run (3.2, 3.3, 3.4).
 * - Observability: the real execution-repository seed path with a real charter
 *   service + real event publisher (capturing broadcast) records and broadcasts
 *   a charter-registered event carrying the charter hash (7.1, 7.3).
 *
 * Charter acceptance (create/replace rejecting a charter-less or invalid-charter
 * definition) is now enforced at the plan-validation layer and covered by
 * `plan-validation.test.ts`.
 */

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo/example";

function newTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Migration: real openStateDb purge observed through the real storage service.
// ---------------------------------------------------------------------------

function seedWorkflowDefinitionFile(configDir: string, id: string): string {
  const projectKey = Buffer.from(PROJECT_PATH).toString("base64url");
  const projectDir = path.join(configDir, "workflows", projectKey);
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify({ id, name: "legacy" }), "utf-8");
  return filePath;
}

function insertProject(db: Db, rootPath: string): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(rootPath);
}

function insertSession(
  db: Db,
  opts: { sessionName: string; execution: string | null; history: string },
): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at,
       graph_workflow_execution, graph_workflow_execution_history
     ) VALUES (
       @project_path, @session_name, @worktree_path, @branch_name,
       @created_at, @last_activity_at,
       @graph_workflow_execution, @graph_workflow_execution_history
     )`,
  ).run({
    project_path: PROJECT_PATH,
    session_name: opts.sessionName,
    worktree_path: `/wt/${opts.sessionName}`,
    branch_name: `csm/${opts.sessionName}`,
    created_at: "2025-01-01T00:00:00.000Z",
    last_activity_at: "2025-01-01T00:00:00.000Z",
    graph_workflow_execution: opts.execution,
    graph_workflow_execution_history: opts.history,
  });
}

function readExecution(db: Db, sessionName: string): string | null {
  const row = db
    .prepare(
      `SELECT graph_workflow_execution AS execution
         FROM sessions WHERE session_name = ?`,
    )
    .get(sessionName) as { execution: string | null };
  return row.execution;
}

function markerCount(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM applied_data_migrations WHERE id = ?`)
    .get(LEGACY_WORKFLOW_PURGE_MIGRATION_ID) as { n: number };
  return row.n;
}

describe("charter lifecycle integration — Migration", () => {
  const openDbs: Db[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  function open(dbPath: string): Db {
    const db = _createTestDbAtPath(dbPath);
    openDbs.push(db);
    return db;
  }

  it("empties the workflow store and nulls embedded executions, then is a no-op on re-run", async () => {
    const configDir = newTempDir("cc-charter-migrate-");
    const dbPath = path.join(configDir, "command-center.db");
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => configDir,
    });

    // Bootstrap the schema, then seed legacy state and clear the marker so the
    // NEXT open re-runs the purge against the just-seeded charter-less data.
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-a",
      execution: JSON.stringify({ executionId: "exec-a", status: "running" }),
      history: JSON.stringify([{ executionId: "exec-a" }]),
    });
    bootstrap
      .prepare("DELETE FROM applied_data_migrations WHERE id IN (?, ?)")
      .run(
        LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
        LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
      );
    rmSync(path.join(configDir, LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME), {
      recursive: true,
      force: true,
    });
    bootstrap.close();
    openDbs.pop();

    const legacyDefFile = seedWorkflowDefinitionFile(configDir, "wf-legacy");
    // Precondition: a legacy definition file exists on disk before migration.
    expect(existsSync(legacyDefFile)).toBe(true);

    // Reopen: the migration runs inside openStateDb.
    const migrated = open(dbPath);

    // Observed through the REAL storage service: the workflow store is empty
    // after the purge durably captures and cleans the legacy directory.
    expect(existsSync(legacyDefFile)).toBe(false);
    expect(
      await storage.list({ kind: "project", projectPath: PROJECT_PATH }),
    ).toEqual([]);
    expect(readExecution(migrated, "legacy-a")).toBeNull();
    expect(markerCount(migrated)).toBe(1);

    // Seed NEW, valid (charter-bearing) state AFTER the migration.
    const freshExecution = JSON.stringify({
      executionId: "exec-new",
      status: "running",
      charter: makeTestCharter(),
    });
    migrated
      .prepare(
        `UPDATE sessions SET graph_workflow_execution = ?
           WHERE session_name = 'legacy-a'`,
      )
      .run(freshExecution);
    migrated.close();
    openDbs.pop();

    // Persist a NEW charter-bearing definition through the real storage service
    // (a valid record, unlike the legacy stub) so list() can surface it.
    const freshRecord = await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      {
        name: "Post-migration workflow",
        description: null,
        definition: createWorkflowDefinition(),
        layout: {
          workflowId: "x",
          contextPositions: {},
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      },
    );

    // Reopen again: the purge is recorded, so it must NOT touch the new state.
    const reopened = open(dbPath);
    expect(readExecution(reopened, "legacy-a")).toBe(freshExecution);
    const survivors = await storage.list({
      kind: "project",
      projectPath: PROJECT_PATH,
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(freshRecord.id);
    expect(markerCount(reopened)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Observability: real seed path records + broadcasts charter-registered.
// ---------------------------------------------------------------------------

const WORKTREE_PATH = "/repo/.worktrees/session-1";

function makeSession(): SessionState {
  return {
    worktreePath: WORKTREE_PATH,
    graphWorkflowExecution: null,
  } as unknown as SessionState;
}

/**
 * Real execution repository whose seed path runs the real charter service and
 * real event publisher; the only seams are a capturing broadcast and an
 * in-memory fs writer so no disk is touched.
 */
function setupObservability() {
  const sessions = new Map<string, SessionState>();
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];

  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      broadcasts.push(event);
    },
  });
  const charterService = createWorkflowCharterService({
    writeFile: async () => {},
    ensureDir: async () => {},
    publishCharterRegistered: eventPublisher.publishCharterRegistered,
  });

  const repo = createGraphWorkflowExecutionRepository({
    async getSession(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      return session;
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      return session.graphWorkflowExecution;
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      _label,
      mutate,
    ) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      const { execution, events, pushes } = await mutate(
        session.graphWorkflowExecution,
      );
      session.graphWorkflowExecution = execution;
      appendedEvents.push(...events);
      // Mirror the production seam: commit the rows and hand the committed
      // delivery back; the repository performs delivery post-commit.
      return { execution, delivery: { events, pushes: pushes ?? [] } };
    },
    async archiveActiveGraphWorkflowExecution(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      const session = sessions.get(key);
      if (session) session.graphWorkflowExecution = null;
    },
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    eventPublisher,
    charterService,
    readConfig: async () => ({}) as GlobalConfig,
  });

  return { repo, sessions, broadcasts, appendedEvents };
}

describe("charter lifecycle integration — Observability", () => {
  it("broadcasts and records a charter-registered event carrying the charter hash on seed", async () => {
    const charter = makeTestCharter({ mission: "Observe my registration" });
    const definition: WorkflowSemanticDefinition = createWorkflowDefinition({
      charter,
    });
    const { repo, sessions, broadcasts, appendedEvents } = setupObservability();

    await repo.create("/repo", "session-1", {
      definition,
      definitionId: "wf-1",
      definitionRevision: 3,
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    // 7.3: broadcast in real time to connected clients.
    const broadcast = broadcasts.find(
      (event) => event.type === "graph-workflow-charter-registered",
    );
    expect(broadcast).toBeDefined();
    expect(broadcast).toMatchObject({
      executionId: "exec-1",
      definitionId: "wf-1",
      definitionRevision: 3,
      charterHash: computeCharterHash(charter),
    });

    // 7.1: recorded in the execution audit log (the persisted history).
    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored).not.toBeNull();
    expect(stored?.charter).toEqual(charter);
    const recorded = appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-charter-registered",
    );
    expect(recorded).toBeDefined();
    expect(recorded?.event).toMatchObject({
      charterHash: computeCharterHash(charter),
    });
  });
});
