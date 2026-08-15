import type Database from "better-sqlite3";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import { createLogger } from "@/lib/logging";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import { PersistenceError } from "../shared/errors";
import {
  decodeGraphWorkflowExecution,
  type GraphWorkflowExecutionMigration,
} from "./graph-workflow-execution-codec";
import { stableStringify } from "./serialization";
import { getErrorMessage } from "@/lib/shared/errors";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-executions");
const parallelLogger = createLogger("graph-workflow-parallel");

/**
 * Heavy, near-static fields of a {@link GraphWorkflowExecution} — the working
 * definition and charter plus the execution's identity and the seed-time audit
 * snapshot (`boundInputs`, `launchedTier`, `ownerConversationId`, `origin`,
 * `launchDocument`, `liveSessionReadOnlyPinned`). Written to `definition_json`
 * only when its content hash changes (the definition rarely mutates after a
 * workflow starts; every field listed here besides `workingDefinition` and
 * `charter` is fixed at seed and never mutates — which is what makes the
 * launch document immutable in practice, not merely by convention).
 */
export const DEFINITION_TIER_KEYS = [
  "id",
  "origin",
  "seedDefinitionId",
  "seedDefinitionRevision",
  "launchDocument",
  "liveSessionReadOnlyPinned",
  "boundInputs",
  "launchedTier",
  "ownerConversationId",
  "startedAt",
  "workingDefinition",
  "charter",
] as const satisfies readonly (keyof GraphWorkflowExecution)[];

/**
 * Hot, frequently-mutated control state of a {@link GraphWorkflowExecution} —
 * everything that ticks per iteration. Written to `runtime_json` on every
 * `setActive`.
 */
export const RUNTIME_TIER_KEYS = [
  "status",
  "abandonment",
  "definitionApproval",
  "definitionApprovalClaim",
  "liveRevision",
  "executionStateRevision",
  "structuralRevision",
  "charterAmendments",
  "planRepairRounds",
  "loopControlAmendments",
  "loopEpoch",
  "activeContextIds",
  "contextStates",
  "taskStates",
  "contextOutputs",
  "routeControlRevisions",
  "routeSettlements",
  "expansionReceipts",
  "loopStates",
  "sharedDocuments",
  "advisoryIndex",
  "laneStates",
  "executionLanes",
  "laneReservations",
  "joins",
  "machineSnapshot",
  "completedAt",
  "haltReason",
  "pendingHaltReason",
  "secondaryHaltReasons",
  "pendingCollaborations",
  "collaborationContinuations",
  "pendingMergeRetry",
] as const satisfies readonly (keyof GraphWorkflowExecution)[];

interface ExecutionProjections {
  executionId: string;
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  startedAt: string;
  status: string;
  completedAt: string | null;
  /**
   * The lease as SQL sees it (D7 decision D15): 1 when this run still owns the
   * session's execution slot. Derived here from the whole record rather than
   * accepted from a caller, so a writer cannot forget it and it cannot drift
   * from the classifier's verdict.
   */
  leaseHeld: 0 | 1;
}

interface SplitExecution {
  definitionJson: string;
  runtimeJson: string;
  projections: ExecutionProjections;
}

/**
 * Partition a validated execution into its definition and runtime tiers plus the
 * denormalized projection columns. Every top-level execution key is assigned to
 * exactly one tier (enforced by the split-symmetry contract test) so a merge of
 * the two tiers reconstructs the whole execution losslessly.
 */
export function splitExecution(
  execution: GraphWorkflowExecution,
): SplitExecution {
  const definitionTier: Record<string, unknown> = {};
  for (const key of DEFINITION_TIER_KEYS) {
    definitionTier[key] = execution[key];
  }
  const runtimeTier: Record<string, unknown> = {};
  for (const key of RUNTIME_TIER_KEYS) {
    runtimeTier[key] = execution[key];
  }
  return {
    definitionJson: stableStringify(definitionTier),
    runtimeJson: stableStringify(runtimeTier),
    projections: {
      executionId: execution.id,
      seedDefinitionId: execution.seedDefinitionId,
      seedDefinitionRevision: execution.seedDefinitionRevision,
      startedAt: execution.startedAt,
      status: execution.status,
      completedAt: execution.completedAt,
      leaseHeld: holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
        ? 1
        : 0,
    },
  };
}

interface ActiveStorageRow {
  definition_json: string;
  runtime_json: string;
}

interface ListStorageRow extends ActiveStorageRow {
  project_path: string;
  session_name: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function isActiveRow(value: unknown): value is ActiveStorageRow {
  const row = asRecord(value);
  if (row === null) return false;
  return (
    typeof row.definition_json === "string" &&
    typeof row.runtime_json === "string"
  );
}

function isListRow(value: unknown): value is ListStorageRow {
  const row = asRecord(value);
  if (row === null) return false;
  return (
    typeof row.definition_json === "string" &&
    typeof row.runtime_json === "string" &&
    typeof row.project_path === "string" &&
    typeof row.session_name === "string"
  );
}

/**
 * Deferred like every other line this repository emits, because the branch is
 * reachable from inside the lease reservation: a row can go malformed between
 * the advisory read and the authoritative one, and the authoritative read runs
 * under `BEGIN IMMEDIATE`. A corrupt row would otherwise make every launch write
 * to the log file while holding SQLite's write lock. Nothing is lost — a section
 * that throws never receives its `flush`, so the line is released with the
 * orphans once the section has unwound.
 */
function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  emitOrDeferRepositoryLog(() =>
    logger.error(
      "state-store.graph-workflow-executions.schema_validation_failure",
      {
        identifier,
        issues,
      },
    ),
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "graph_workflow_execution",
    identifier,
    issues,
  });
}

/**
 * Merge a stored definition/runtime tier pair back into one
 * {@link GraphWorkflowExecution} candidate. The merged record runs through the
 * shared {@link decodeGraphWorkflowExecution} (legacy-upgrade + schema
 * validation), so the merge path and the vestigial sessions-column path share
 * one validation rule. Returns the decoded value plus an optional
 * `migration` describing a legacy upgrade the caller should persist.
 */
function mergeRow(
  identifier: string,
  row: ActiveStorageRow,
): {
  value: GraphWorkflowExecution;
  migration: GraphWorkflowExecutionMigration | null;
} {
  let definition: unknown;
  let runtime: unknown;
  try {
    definition = JSON.parse(row.definition_json);
  } catch (err) {
    return logAndThrowValidationFailure(identifier, [
      {
        code: "invalid_json",
        path: ["definition_json"],
        message: getErrorMessage(err),
      },
    ]);
  }
  try {
    runtime = JSON.parse(row.runtime_json);
  } catch (err) {
    return logAndThrowValidationFailure(identifier, [
      {
        code: "invalid_json",
        path: ["runtime_json"],
        message: getErrorMessage(err),
      },
    ]);
  }
  if (
    typeof definition !== "object" ||
    definition === null ||
    typeof runtime !== "object" ||
    runtime === null
  ) {
    return logAndThrowValidationFailure(identifier, [
      {
        code: "invalid_tier_shape",
        path: [],
        message: "tier blob is not an object",
      },
    ]);
  }
  const candidate = {
    ...(definition as Record<string, unknown>),
    ...(runtime as Record<string, unknown>),
  };
  const decoded = decodeGraphWorkflowExecution(candidate);
  if (!decoded.ok) {
    return logAndThrowValidationFailure(identifier, decoded.issues);
  }
  if (decoded.value === null) {
    return logAndThrowValidationFailure(identifier, [
      {
        code: "null_execution",
        path: [],
        message: "merged tiers decoded to null",
      },
    ]);
  }
  return { value: decoded.value, migration: decoded.migration };
}

function key(projectPath: string, sessionName: string): string {
  return `${projectPath}\u0000${sessionName}`;
}

export interface GraphWorkflowExecutionsRepo {
  /** Read the merged active execution (definition ⊕ runtime) or null. */
  getActive(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution | null;
  /**
   * `getActive` with this connection's caches for the key dropped first, so the
   * answer comes from SQLite rather than from what this process last saw.
   *
   * The lease CAS is the caller this exists for. Every cache here is invalidated
   * only by writes made through THIS connection, while the lease is a claim
   * about the database that another process can change at any moment: the
   * ordinary advisory read a launch performs first caches "no incumbent", and a
   * CAS that then trusts that cache takes the write lock, never looks, and
   * overwrites whoever committed in between. `BEGIN IMMEDIATE` makes the read
   * that happens here authoritative; not reading is what breaks it.
   *
   * The definition-tier hash is dropped with it. That cache decides whether
   * `setActive` may skip rewriting `definition_json`, and it describes a row
   * this connection no longer owns — a stale hit would leave the previous
   * winner's definition under the new execution's runtime.
   */
  getActiveAuthoritative(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution | null;
  /**
   * Upsert (or, with `execution === null`, delete) the one active execution for
   * a session. `runtime_json` + projection columns are written on every call;
   * `definition_json` is rewritten only when its content hash differs from the
   * last write for this session (cached per repo instance). Returns whether a
   * row was written, updated, or deleted.
   */
  setActive(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution | null,
    updatedAt: string,
  ): boolean;
  /**
   * Every active execution across all sessions, keyed by
   * `${projectPath}\u0000${sessionName}` (NUL-separated), for the active-conversations feed.
   */
  listActive(): Map<string, GraphWorkflowExecution>;
  /**
   * Invalidate the parsed-execution cache after a row was removed out-of-band —
   * an FK `ON DELETE CASCADE` from a session/project delete drops the row at the
   * SQL layer without routing through this repo's own `setActive(null)`. Bumps
   * the version so the next `getActive` re-reads from SQLite instead of serving
   * a stale parsed execution.
   */
  invalidateCache(): void;
  /** Monotonic version bumped on every write, for parsed-row cache invalidation. */
  readonly cacheVersion: number;
}

export function createGraphWorkflowExecutionsRepo(
  db: Db,
): GraphWorkflowExecutionsRepo {
  const getStmt = db.prepare(
    `SELECT definition_json, runtime_json
       FROM graph_workflow_executions
      WHERE project_path = ? AND session_name = ?
      LIMIT 1`,
  );
  const listStmt = db.prepare(
    `SELECT project_path, session_name, definition_json, runtime_json
       FROM graph_workflow_executions`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at, lease_held
     ) VALUES (
       @project_path, @session_name, @execution_id, @seed_definition_id,
       @seed_definition_revision, @started_at, @status, @completed_at,
       @definition_json, @runtime_json, @updated_at, @lease_held
     )
     ON CONFLICT(project_path, session_name) DO UPDATE SET
       execution_id             = excluded.execution_id,
       seed_definition_id       = excluded.seed_definition_id,
       seed_definition_revision = excluded.seed_definition_revision,
       started_at               = excluded.started_at,
       status                   = excluded.status,
       completed_at             = excluded.completed_at,
       definition_json          = excluded.definition_json,
       runtime_json             = excluded.runtime_json,
       updated_at               = excluded.updated_at,
       lease_held               = excluded.lease_held`,
  );
  // Status, halt reason, and abandonment all live in the runtime tier, so the
  // lease almost always changes on THIS path — a projection written only by the
  // full upsert would leave a finished run looking ambient-active until its
  // definition happened to change.
  const runtimeUpdateStmt = db.prepare(
    `UPDATE graph_workflow_executions
        SET runtime_json = @runtime_json,
            status       = @status,
            completed_at = @completed_at,
            updated_at   = @updated_at,
            lease_held   = @lease_held
      WHERE project_path = @project_path AND session_name = @session_name`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM graph_workflow_executions
      WHERE project_path = ? AND session_name = ?`,
  );

  /** Last-written definition-tier hash per session key (cold after restart). */
  const definitionHashCache = new Map<string, string>();
  let cacheVersion = 0;

  let parsedVersion = -1;
  const parsedByKey = new Map<string, GraphWorkflowExecution | null>();

  function invalidate(): void {
    cacheVersion += 1;
  }

  function ensureParsedFresh(): void {
    if (parsedVersion === cacheVersion) return;
    parsedByKey.clear();
    parsedVersion = cacheVersion;
  }

  function timed<T>(
    op: string,
    identifier: { projectPath?: string; sessionName?: string },
    fn: () => T,
  ): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const durationMs = +(performance.now() - start).toFixed(3);
      const payload: Record<string, unknown> = { durationMs };
      if (identifier.projectPath !== undefined) {
        payload.projectPath = identifier.projectPath;
      }
      if (identifier.sessionName !== undefined) {
        payload.sessionName = identifier.sessionName;
      }
      emitOrDeferRepositoryLog(() =>
        logger.info(
          `state-store.graph-workflow-executions.${op}.timing`,
          payload,
        ),
      );
    }
  }

  /**
   * A READ, and nothing else: a legacy row is upgraded in memory and handed
   * back, never written back.
   *
   * Read-repair used to persist that upgrade here, which made every reader a
   * writer. The launch path is where that becomes a defect rather than a
   * curiosity. A launch reads the incumbent twice — the manager's advisory
   * guard, then the authoritative CAS — and D7 requires the reservation to be
   * the launch's FIRST mutation of any kind (`reserve-before-side-effects`), so
   * that a refused launch leaves no persisted record at all (R5.2) and a
   * lease-free incumbent is relocated to History by the transaction that
   * installs its successor rather than by whoever happened to read it first
   * (R3.3, R3.4). Across processes the repair is worse than redundant: it
   * rewrites the row from a snapshot taken before another connection's winner
   * existed, so a read could undo an admission.
   *
   * Nothing is lost by deferring it. The upgrade is a pure function of the
   * stored bytes, so every reader sees the same record whether or not it was
   * rewritten, and the next ordinary `setActive` persists the upgraded shape.
   */
  function readActive(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution | null {
    const cacheKey = key(projectPath, sessionName);
    ensureParsedFresh();
    const cached = parsedByKey.get(cacheKey);
    if (cached !== undefined) return cached;

    const row: unknown = getStmt.get(projectPath, sessionName);
    if (row === undefined) {
      parsedByKey.set(cacheKey, null);
      return null;
    }
    if (!isActiveRow(row)) {
      return logAndThrowValidationFailure(`${projectPath}::${sessionName}`, [
        {
          code: "invalid_row_shape",
          path: [],
          message: "unexpected row shape",
        },
      ]);
    }
    const merged = mergeRow(`${projectPath}::${sessionName}`, row);
    if (merged.migration !== null) {
      // Emitted from the cached read only. `listActive` re-merges every row on
      // every call (the feed polls it), so logging there would repeat a line
      // per legacy row per poll for as long as the row stays unwritten.
      emitOrDeferRepositoryLog(() =>
        parallelLogger.info("graph-workflow.parallel.legacy_migrated", {
          projectPath,
          sessionName,
          executionId: merged.migration?.executionId,
          repairedFields: merged.migration?.repairedFields,
          persisted: false,
        }),
      );
    }
    parsedByKey.set(cacheKey, merged.value);
    return merged.value;
  }

  function writeFull(
    projectPath: string,
    sessionName: string,
    split: SplitExecution,
    updatedAt: string,
  ): void {
    const executionId = split.projections.executionId;
    checkRowColumnSize({
      logger,
      table: "graph_workflow_executions",
      column: "definition_json",
      id: executionId,
      value: split.definitionJson,
    });
    checkRowColumnSize({
      logger,
      table: "graph_workflow_executions",
      column: "runtime_json",
      id: executionId,
      value: split.runtimeJson,
    });
    upsertStmt.run({
      project_path: projectPath,
      session_name: sessionName,
      execution_id: split.projections.executionId,
      seed_definition_id: split.projections.seedDefinitionId,
      seed_definition_revision: split.projections.seedDefinitionRevision,
      started_at: split.projections.startedAt,
      status: split.projections.status,
      completed_at: split.projections.completedAt,
      definition_json: split.definitionJson,
      runtime_json: split.runtimeJson,
      updated_at: updatedAt,
      lease_held: split.projections.leaseHeld,
    });
    definitionHashCache.set(
      key(projectPath, sessionName),
      split.definitionJson,
    );
  }

  return {
    getActive(projectPath, sessionName) {
      return timed("getActive", { projectPath, sessionName }, () =>
        readActive(projectPath, sessionName),
      );
    },
    getActiveAuthoritative(projectPath, sessionName) {
      return timed(
        "getActiveAuthoritative",
        { projectPath, sessionName },
        () => {
          const cacheKey = key(projectPath, sessionName);
          ensureParsedFresh();
          parsedByKey.delete(cacheKey);
          definitionHashCache.delete(cacheKey);
          return readActive(projectPath, sessionName);
        },
      );
    },
    setActive(projectPath, sessionName, execution, updatedAt) {
      return timed("setActive", { projectPath, sessionName }, () => {
        const cacheKey = key(projectPath, sessionName);
        if (execution === null) {
          const result = deleteStmt.run(projectPath, sessionName);
          definitionHashCache.delete(cacheKey);
          invalidate();
          return result.changes > 0;
        }
        const validated = graphWorkflowExecutionSchema.parse(execution);
        const split = splitExecution(validated);
        const lastHash = definitionHashCache.get(cacheKey);
        if (lastHash === split.definitionJson) {
          checkRowColumnSize({
            logger,
            table: "graph_workflow_executions",
            column: "runtime_json",
            id: split.projections.executionId,
            value: split.runtimeJson,
          });
          const result = runtimeUpdateStmt.run({
            project_path: projectPath,
            session_name: sessionName,
            runtime_json: split.runtimeJson,
            status: split.projections.status,
            completed_at: split.projections.completedAt,
            updated_at: updatedAt,
            lease_held: split.projections.leaseHeld,
          });
          // The hash cache said the definition was unchanged, but the row is
          // gone (cache/row drift — e.g. an out-of-band delete after the cache
          // was warmed). A runtime-only UPDATE that matched zero rows would
          // silently leave the execution absent while events get appended for
          // its id, orphaning the event log. Fall back to a full upsert so the
          // row is recreated.
          if (result.changes === 0) {
            writeFull(projectPath, sessionName, split, updatedAt);
          }
          invalidate();
          return true;
        }
        writeFull(projectPath, sessionName, split, updatedAt);
        invalidate();
        return true;
      });
    },
    listActive() {
      return timed("listActive", {}, () => {
        const rows = listStmt.all() as unknown[];
        const result = new Map<string, GraphWorkflowExecution>();
        for (const row of rows) {
          if (!isListRow(row)) {
            return logAndThrowValidationFailure("<list>", [
              {
                code: "invalid_row_shape",
                path: [],
                message: "unexpected row shape",
              },
            ]);
          }
          const identifier = `${row.project_path}::${row.session_name}`;
          // Upgraded in memory like every other read: the feed calls this on a
          // poll, and a launch admitted between two polls must not find its row
          // overwritten by an enumeration carrying a pre-launch snapshot.
          const merged = mergeRow(identifier, row);
          result.set(key(row.project_path, row.session_name), merged.value);
        }
        return result;
      });
    },
    invalidateCache() {
      invalidate();
    },
    get cacheVersion() {
      return cacheVersion;
    },
  };
}
