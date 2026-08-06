import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  validationRunRecordSchema,
  type ValidationRunRecord,
} from "@/lib/validation/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.validation-runs");

/**
 * Ledger repository for validation runs (design: validation-concurrency §4,
 * §12). Rows are operational ownership state for crash recovery first and the
 * durable per-run timing record after: terminal transitions are one-way, and
 * there is deliberately NO delete mutation — terminal rows are retained.
 *
 * Admission POLICY (weighted FIFO, capacity math) belongs to the scheduler
 * service; this repository only provides the focused mutations and
 * reconciliation queries the scheduler composes inside short transactions.
 */
export interface ValidationRunsRepo {
  /** Insert a freshly submitted (queued) run row. */
  submit(record: ValidationRunRecord): void;
  findById(runId: string): ValidationRunRecord | null;
  /** Next strict-FIFO queue position (max existing order + 1, starting at 0). */
  nextQueueOrder(): number;
  /** Queued rows in strict FIFO order. */
  findQueued(): ValidationRunRecord[];
  findRunning(): ValidationRunRecord[];
  /**
   * Every non-terminal row (queued + running) in queue order — the post-crash
   * reconciliation set: admission stays closed until recovery terminates
   * owned process groups and marks these rows interrupted.
   */
  findStaleActive(): ValidationRunRecord[];
  /** FIFO claim: queued → running. False when the row is not queued. */
  admit(runId: string): boolean;
  /** Process spawn recorded on an admitted (running) row. */
  markStarted(
    runId: string,
    fields: {
      startedAt: string;
      queueMs: number;
      processGroupPid: number | null;
    },
  ): boolean;
  /**
   * Extend the lease — only for the exact token holder, so read-only status
   * polling by other agents can never keep abandoned work alive.
   */
  renewLease(runId: string, leaseToken: string, expiresAt: string): boolean;
  markPassed(
    runId: string,
    fields: { finishedAt: string; execMs: number; exitCode: number },
  ): boolean;
  /** `exitCode: null` models a spawn error terminal path. */
  markFailed(
    runId: string,
    fields: {
      finishedAt: string;
      execMs: number | null;
      exitCode: number | null;
    },
  ): boolean;
  markTimedOut(
    runId: string,
    fields: {
      finishedAt: string;
      execMs: number;
      exitCode: number | null;
    },
  ): boolean;
  /** Cancellation of a queued (execMs null) or running row. */
  markCancelled(
    runId: string,
    fields: { finishedAt: string; execMs: number | null },
  ): boolean;
  /**
   * Recovery verdict for runs orphaned by an unclean server death. For rows
   * that had started, execMs is derived as startedAt → finishedAt (spawn to
   * confirmed group death, §12); never-started rows keep execMs null.
   */
  markInterrupted(runId: string, fields: { finishedAt: string }): boolean;
  /**
   * Terminal verdict for a queued row made unrunnable by a limit lowering:
   * a configuration error (never a cancellation), so the durable ledger
   * matches the cost_exceeds_limit result reported to the submitter.
   */
  markCostExceedsLimit(runId: string, fields: { finishedAt: string }): boolean;
}

const validationRunTableRowSchema = registerTrustedSchema(
  z.object({
    run_id: z.string(),
    source: z.string(),
    command_name: z.string(),
    cost: z.number().int(),
    queue_order: z.number().int(),
    status: z.string(),
    nonce: z.string(),
    lease_token: z.string().nullable(),
    lease_expires_at: z.string().nullable(),
    process_group_pid: z.number().int().nullable(),
    project_path: z.string(),
    worktree_path: z.string(),
    session_name: z.string().nullable(),
    conversation_id: z.string().nullable(),
    workflow_execution_id: z.string().nullable(),
    workflow_context_id: z.string().nullable(),
    workflow_role: z.string().nullable(),
    submitted_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    queue_ms: z.number().int().nullable(),
    exec_ms: z.number().int().nullable(),
    scoped: z.number().int(),
    scoped_path_count: z.number().int(),
    exit_code: z.number().int().nullable(),
    timed_out: z.number().int(),
  }),
  "validationRunTableRowSchema",
);
type ValidationRunTableRow = z.infer<typeof validationRunTableRowSchema>;

interface SqlBindRow {
  run_id: string;
  source: string;
  command_name: string;
  cost: number;
  queue_order: number;
  status: string;
  nonce: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  process_group_pid: number | null;
  project_path: string;
  worktree_path: string;
  session_name: string | null;
  conversation_id: string | null;
  workflow_execution_id: string | null;
  workflow_context_id: string | null;
  workflow_role: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_ms: number | null;
  exec_ms: number | null;
  scoped: number;
  scoped_path_count: number;
  exit_code: number | null;
  timed_out: number;
}

function recordToSqlBind(record: ValidationRunRecord): SqlBindRow {
  return {
    run_id: record.runId,
    source: record.source,
    command_name: record.commandName,
    cost: record.cost,
    queue_order: record.queueOrder,
    status: record.status,
    nonce: record.nonce,
    lease_token: record.leaseToken,
    lease_expires_at: record.leaseExpiresAt,
    process_group_pid: record.processGroupPid,
    project_path: record.projectPath,
    worktree_path: record.worktreePath,
    session_name: record.sessionName,
    conversation_id: record.conversationId,
    workflow_execution_id: record.workflowExecutionId,
    workflow_context_id: record.workflowContextId,
    workflow_role: record.workflowRole,
    submitted_at: record.submittedAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    queue_ms: record.queueMs,
    exec_ms: record.execMs,
    scoped: record.scoped ? 1 : 0,
    scoped_path_count: record.scopedPathCount,
    exit_code: record.exitCode,
    timed_out: record.timedOut ? 1 : 0,
  };
}

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.validation-runs.schema_validation_failure", {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "validation_run",
    identifier,
    issues,
  });
}

function rowToDomain(rawRow: unknown): ValidationRunRecord {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { run_id?: unknown }).run_id === "string"
      ? (rawRow as { run_id: string }).run_id
      : "<unknown>";

  const row: ValidationRunTableRow = parseTrusted(
    validationRunTableRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure(fallbackId, issues),
  );

  const candidate = {
    runId: row.run_id,
    source: row.source,
    commandName: row.command_name,
    cost: row.cost,
    queueOrder: row.queue_order,
    status: row.status,
    nonce: row.nonce,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    processGroupPid: row.process_group_pid,
    projectPath: row.project_path,
    worktreePath: row.worktree_path,
    sessionName: row.session_name,
    conversationId: row.conversation_id,
    workflowExecutionId: row.workflow_execution_id,
    workflowContextId: row.workflow_context_id,
    workflowRole: row.workflow_role,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    queueMs: row.queue_ms,
    execMs: row.exec_ms,
    scoped: row.scoped === 1,
    scopedPathCount: row.scoped_path_count,
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
  };

  return parseTrusted(validationRunRecordSchema, candidate, (issues) =>
    logAndThrowValidationFailure(row.run_id, issues),
  );
}

export function createValidationRunsRepo(db: Db): ValidationRunsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO validation_runs (
       run_id, source, command_name, cost, queue_order, status, nonce,
       lease_token, lease_expires_at, process_group_pid,
       project_path, worktree_path, session_name, conversation_id,
       workflow_execution_id, workflow_context_id, workflow_role,
       submitted_at, started_at, finished_at, queue_ms, exec_ms,
       scoped, scoped_path_count, exit_code, timed_out
     ) VALUES (
       @run_id, @source, @command_name, @cost, @queue_order, @status, @nonce,
       @lease_token, @lease_expires_at, @process_group_pid,
       @project_path, @worktree_path, @session_name, @conversation_id,
       @workflow_execution_id, @workflow_context_id, @workflow_role,
       @submitted_at, @started_at, @finished_at, @queue_ms, @exec_ms,
       @scoped, @scoped_path_count, @exit_code, @timed_out
     )`,
  );
  const findByIdStmt = db.prepare(
    `SELECT * FROM validation_runs WHERE run_id = ?`,
  );
  const nextQueueOrderStmt = db.prepare(
    `SELECT COALESCE(MAX(queue_order), -1) + 1 AS next FROM validation_runs`,
  );
  const findByStatusStmt = db.prepare(
    `SELECT * FROM validation_runs WHERE status = ? ORDER BY queue_order ASC`,
  );
  const findActiveStmt = db.prepare(
    `SELECT * FROM validation_runs
     WHERE status IN ('queued', 'running')
     ORDER BY queue_order ASC`,
  );
  const admitStmt = db.prepare(
    `UPDATE validation_runs SET status = 'running'
     WHERE run_id = ? AND status = 'queued'`,
  );
  const markStartedStmt = db.prepare(
    `UPDATE validation_runs
     SET started_at = @started_at,
         queue_ms = @queue_ms,
         process_group_pid = @process_group_pid
     WHERE run_id = @run_id AND status = 'running'`,
  );
  const renewLeaseStmt = db.prepare(
    `UPDATE validation_runs SET lease_expires_at = @expires_at
     WHERE run_id = @run_id
       AND lease_token = @lease_token
       AND status IN ('queued', 'running')`,
  );
  // Terminal transitions guard on non-terminal status, making terminal rows
  // immutable: a raced second transition changes nothing and returns false.
  const markTerminalStmt = db.prepare(
    `UPDATE validation_runs
     SET status = @status,
         finished_at = @finished_at,
         exec_ms = @exec_ms,
         exit_code = @exit_code,
         timed_out = @timed_out
     WHERE run_id = @run_id AND status IN ('queued', 'running')`,
  );
  // Interrupted execMs is derived in-statement so recovery cannot lose the
  // timing record for a started run (§12): startedAt → finishedAt is spawn to
  // confirmed group death, since orphaned groups run until recovery kills
  // them. MAX(0, …) keeps clock skew from producing a negative duration.
  // Guarded to queued rows only: lowering the limit never disturbs running
  // work, so this transition arriving for a running row is a caller bug and
  // must change nothing.
  const markCostExceedsLimitStmt = db.prepare(
    `UPDATE validation_runs
     SET status = 'cost_exceeds_limit',
         finished_at = @finished_at,
         exec_ms = NULL,
         exit_code = NULL,
         timed_out = 0
     WHERE run_id = @run_id AND status = 'queued'`,
  );
  const markInterruptedStmt = db.prepare(
    `UPDATE validation_runs
     SET status = 'interrupted',
         finished_at = @finished_at,
         exec_ms = CASE
           WHEN started_at IS NULL THEN NULL
           ELSE MAX(0, CAST(ROUND(
             (julianday(@finished_at) - julianday(started_at)) * 86400000.0
           ) AS INTEGER))
         END,
         exit_code = NULL,
         timed_out = 0
     WHERE run_id = @run_id AND status IN ('queued', 'running')`,
  );

  function markTerminal(
    runId: string,
    status: "passed" | "failed" | "timed_out" | "cancelled" | "interrupted",
    fields: {
      finishedAt: string;
      execMs: number | null;
      exitCode: number | null;
      timedOut: boolean;
    },
  ): boolean {
    const result = markTerminalStmt.run({
      run_id: runId,
      status,
      finished_at: fields.finishedAt,
      exec_ms: fields.execMs,
      exit_code: fields.exitCode,
      timed_out: fields.timedOut ? 1 : 0,
    });
    logger.info("state-store.validation-runs.terminal", {
      runId,
      status,
      changed: result.changes > 0,
    });
    return result.changes > 0;
  }

  return {
    submit(record) {
      const validated = validationRunRecordSchema.parse(record);
      insertStmt.run(recordToSqlBind(validated));
      logger.info("state-store.validation-runs.submit", {
        runId: validated.runId,
        source: validated.source,
        commandName: validated.commandName,
        cost: validated.cost,
        queueOrder: validated.queueOrder,
      });
    },
    findById(runId) {
      const row: unknown = findByIdStmt.get(runId);
      if (row === undefined) return null;
      return rowToDomain(row);
    },
    nextQueueOrder() {
      const row = nextQueueOrderStmt.get() as { next: number };
      return row.next;
    },
    findQueued() {
      return (findByStatusStmt.all("queued") as unknown[]).map(rowToDomain);
    },
    findRunning() {
      return (findByStatusStmt.all("running") as unknown[]).map(rowToDomain);
    },
    findStaleActive() {
      return (findActiveStmt.all() as unknown[]).map(rowToDomain);
    },
    admit(runId) {
      return admitStmt.run(runId).changes > 0;
    },
    markStarted(runId, fields) {
      const result = markStartedStmt.run({
        run_id: runId,
        started_at: fields.startedAt,
        queue_ms: fields.queueMs,
        process_group_pid: fields.processGroupPid,
      });
      return result.changes > 0;
    },
    renewLease(runId, leaseToken, expiresAt) {
      const result = renewLeaseStmt.run({
        run_id: runId,
        lease_token: leaseToken,
        expires_at: expiresAt,
      });
      return result.changes > 0;
    },
    markPassed(runId, fields) {
      return markTerminal(runId, "passed", { ...fields, timedOut: false });
    },
    markFailed(runId, fields) {
      return markTerminal(runId, "failed", { ...fields, timedOut: false });
    },
    markTimedOut(runId, fields) {
      return markTerminal(runId, "timed_out", { ...fields, timedOut: true });
    },
    markCancelled(runId, fields) {
      return markTerminal(runId, "cancelled", {
        ...fields,
        exitCode: null,
        timedOut: false,
      });
    },
    markCostExceedsLimit(runId, fields) {
      const result = markCostExceedsLimitStmt.run({
        run_id: runId,
        finished_at: fields.finishedAt,
      });
      logger.info("state-store.validation-runs.terminal", {
        runId,
        status: "cost_exceeds_limit",
        changed: result.changes > 0,
      });
      return result.changes > 0;
    },
    markInterrupted(runId, fields) {
      const result = markInterruptedStmt.run({
        run_id: runId,
        finished_at: fields.finishedAt,
      });
      logger.info("state-store.validation-runs.terminal", {
        runId,
        status: "interrupted",
        changed: result.changes > 0,
      });
      return result.changes > 0;
    },
  };
}
