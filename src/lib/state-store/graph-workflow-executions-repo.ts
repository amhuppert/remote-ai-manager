import type Database from "better-sqlite3";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import { createLogger } from "@/lib/logging";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import { STRUCTURAL_REVISION_KEYS } from "@/lib/workflow-graph/structural-revision";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import { PersistenceError } from "../shared/errors";
import { decodeGraphWorkflowExecution } from "./graph-workflow-execution-codec";
import { stableStringify } from "./serialization";
import { getErrorMessage } from "@/lib/shared/errors";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.graph-workflow-executions");

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

type DefinitionTierKey = (typeof DEFINITION_TIER_KEYS)[number];
type RuntimeTierKey = (typeof RUNTIME_TIER_KEYS)[number];

/** The half of an execution a definition-clean tick reads, validates, and writes. */
type RuntimeTier = Pick<GraphWorkflowExecution, RuntimeTierKey>;

/**
 * {@link DEFINITION_TIER_KEYS} in the shape Zod's `omit` takes. Annotated with
 * the mapped type rather than assembled from the array so the compiler rejects a
 * tier key that is added to one and forgotten in the other.
 */
const DEFINITION_TIER_MASK: { [K in DefinitionTierKey]: true } = {
  id: true,
  origin: true,
  seedDefinitionId: true,
  seedDefinitionRevision: true,
  launchDocument: true,
  liveSessionReadOnlyPinned: true,
  boundInputs: true,
  launchedTier: true,
  ownerConversationId: true,
  startedAt: true,
  workingDefinition: true,
  charter: true,
};

/**
 * The execution schema minus the definition tier, for the tick that has already
 * proven its definition did not move: parsing the whole record would re-validate
 * the graph — the larger half of the row — against bytes this connection wrote
 * and validated itself, on every scheduler iteration.
 */
const runtimeTierSchema =
  graphWorkflowExecutionSchema.omit(DEFINITION_TIER_MASK);

interface RuntimeProjections {
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

interface ExecutionProjections extends RuntimeProjections {
  executionId: string;
  seedDefinitionId: string | null;
  seedDefinitionRevision: number | null;
  startedAt: string;
}

interface SplitExecution {
  definitionJson: string;
  runtimeJson: string;
  projections: ExecutionProjections;
}

/**
 * What a connection last wrote into `definition_json`, and the identity of the
 * execution state those bytes came from.
 *
 * `structuralRevision` is the dirty signal, and it works because it is DERIVED
 * rather than declared: `nextStructuralRevision` advances it whenever a
 * structural key actually moved, whoever moved it and whether or not they knew
 * the fence exists. So an execution presenting this id with this revision
 * presents a definition tier byte-identical to `definitionJson`, and the
 * expensive half of the write — validating and serializing the graph — can be
 * skipped outright rather than paid for and then discarded.
 */
interface DefinitionWrite {
  readonly executionId: string;
  readonly structuralRevision: number;
  readonly definitionJson: string;
  /** Values of {@link REVISION_BLIND_DEFINITION_KEYS}, positionally. */
  readonly revisionBlindValues: readonly unknown[];
}

/**
 * Definition-tier keys `structuralRevision` says nothing about. The revision is
 * derived from four graph keys (`STRUCTURAL_REVISION_KEYS`); the definition tier
 * holds twelve, and the difference is launch provenance — so a skip gated on the
 * revision alone would drop a write to any of these on the floor, durably and
 * with nothing able to detect it.
 *
 * Derived by subtraction rather than listed, so a key added to
 * {@link DEFINITION_TIER_KEYS} is fenced by default. Two are excluded, each
 * because something cheaper already covers it:
 *
 *  - `id` — `setActive` compares it directly, since a session slot can be reused
 *    by a different execution whose revision happens to match.
 *  - `launchDocument` — the immutable seed snapshot, and the only large value
 *    here (it carries its own copy of the definition). Comparing it would cost
 *    what serializing the tier costs, which is the whole expense being avoided.
 *    A launch document only ever arrives with the execution that owns it, and
 *    that execution's identity is fenced by `id` above and its provenance by
 *    `seedDefinitionId`/`seedDefinitionRevision` below.
 */
const REVISION_BLIND_DEFINITION_KEYS = ((): readonly DefinitionTierKey[] => {
  const covered: ReadonlySet<string> = new Set<string>([
    ...STRUCTURAL_REVISION_KEYS,
    "id",
    "launchDocument",
  ]);
  return DEFINITION_TIER_KEYS.filter((key) => !covered.has(key));
})();

function revisionBlindValues(
  execution: GraphWorkflowExecution,
): readonly unknown[] {
  return REVISION_BLIND_DEFINITION_KEYS.map((key) => execution[key]);
}

/**
 * Whether every revision-blind key still holds the value last written. These are
 * the small, near-scalar provenance fields, so comparing them by value is cheap
 * and — unlike reference identity — survives the fresh parse every commit
 * produces. Nothing here walks `workingDefinition`, which is what makes the skip
 * worth having.
 */
function revisionBlindValuesUnchanged(
  previous: readonly unknown[],
  execution: GraphWorkflowExecution,
): boolean {
  return REVISION_BLIND_DEFINITION_KEYS.every((key, index) =>
    deepEqualJson(previous[index], execution[key]),
  );
}

function serializeRuntimeTier(source: RuntimeTier): string {
  const runtimeTier: Record<string, unknown> = {};
  for (const key of RUNTIME_TIER_KEYS) {
    runtimeTier[key] = source[key];
  }
  return stableStringify(runtimeTier);
}

function projectRuntime(source: RuntimeTier): RuntimeProjections {
  return {
    status: source.status,
    completedAt: source.completedAt,
    leaseHeld: holdsExecutionLease(
      source.status,
      source.haltReason,
      source.abandonment,
    )
      ? 1
      : 0,
  };
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
  return {
    definitionJson: stableStringify(definitionTier),
    runtimeJson: serializeRuntimeTier(execution),
    projections: {
      executionId: execution.id,
      seedDefinitionId: execution.seedDefinitionId,
      seedDefinitionRevision: execution.seedDefinitionRevision,
      startedAt: execution.startedAt,
      ...projectRuntime(execution),
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

/** Merge and validate a stored definition/runtime tier pair. */
function mergeRow(
  identifier: string,
  row: ActiveStorageRow,
): GraphWorkflowExecution {
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
  return decoded.value;
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
  /** Read an active execution by its globally unique execution id. */
  findByExecutionId(executionId: string): GraphWorkflowExecution | null;
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
   * The last definition write is dropped with it. That record decides whether
   * `setActive` may skip reading `definition_json`'s source at all, and it
   * describes a row this connection no longer owns — a stale hit would leave the
   * previous winner's definition under the new execution's runtime.
   */
  getActiveAuthoritative(
    projectPath: string,
    sessionName: string,
  ): GraphWorkflowExecution | null;
  /**
   * Upsert (or, with `execution === null`, delete) the one active execution for
   * a session. `runtime_json` + projection columns are written on every call;
   * the definition tier is validated, serialized, and written only when this
   * repo instance cannot prove it is unchanged since its own last write for the
   * session. Returns whether a row was written, updated, or deleted.
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
  const findByExecutionIdStmt = db.prepare(
    `SELECT project_path, session_name, definition_json, runtime_json
       FROM graph_workflow_executions
      WHERE execution_id = ?
      LIMIT 1`,
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

  /** This connection's last definition write per session key (cold after restart). */
  const lastDefinitionWrite = new Map<string, DefinitionWrite>();
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
    identifier: {
      projectPath?: string;
      sessionName?: string;
      executionId?: string;
    },
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
      if (identifier.executionId !== undefined) {
        payload.executionId = identifier.executionId;
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
    parsedByKey.set(cacheKey, merged);
    return merged;
  }

  /**
   * Write `runtime_json` and the projection columns for a row this connection
   * has already written the definition of. Returns false when no row matched —
   * the row is gone (an out-of-band delete after the last write), and the caller
   * must recreate it, or the execution would be absent while events keep being
   * appended for its id.
   */
  function writeRuntimeOnly(
    projectPath: string,
    sessionName: string,
    executionId: string,
    runtime: RuntimeTier,
    updatedAt: string,
  ): boolean {
    const runtimeJson = serializeRuntimeTier(runtime);
    checkRowColumnSize({
      logger,
      table: "graph_workflow_executions",
      column: "runtime_json",
      id: executionId,
      value: runtimeJson,
    });
    const projections = projectRuntime(runtime);
    const result = runtimeUpdateStmt.run({
      project_path: projectPath,
      session_name: sessionName,
      runtime_json: runtimeJson,
      status: projections.status,
      completed_at: projections.completedAt,
      updated_at: updatedAt,
      lease_held: projections.leaseHeld,
    });
    return result.changes > 0;
  }

  function writeFull(
    projectPath: string,
    sessionName: string,
    split: SplitExecution,
    execution: GraphWorkflowExecution,
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
    lastDefinitionWrite.set(key(projectPath, sessionName), {
      executionId,
      structuralRevision: execution.structuralRevision,
      definitionJson: split.definitionJson,
      revisionBlindValues: revisionBlindValues(execution),
    });
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
          lastDefinitionWrite.delete(cacheKey);
          return readActive(projectPath, sessionName);
        },
      );
    },
    findByExecutionId(executionId) {
      return timed("findByExecutionId", { executionId }, () => {
        const row: unknown = findByExecutionIdStmt.get(executionId);
        if (row === undefined) return null;
        if (!isListRow(row)) {
          return logAndThrowValidationFailure(executionId, [
            {
              code: "invalid_row_shape",
              path: [],
              message: "unexpected row shape",
            },
          ]);
        }
        const merged = mergeRow(
          `${row.project_path}::${row.session_name}`,
          row,
        );
        return merged;
      });
    },
    setActive(projectPath, sessionName, execution, updatedAt) {
      return timed("setActive", { projectPath, sessionName }, () => {
        const cacheKey = key(projectPath, sessionName);
        if (execution === null) {
          const result = deleteStmt.run(projectPath, sessionName);
          lastDefinitionWrite.delete(cacheKey);
          invalidate();
          return result.changes > 0;
        }
        const lastWrite = lastDefinitionWrite.get(cacheKey);
        // The scheduler's ordinary tick: same execution, definition provably
        // where this connection left it — the revision covers the graph keys and
        // the blind-value check covers the launch provenance it does not.
        // Nothing below the runtime tier is read, parsed, or serialized. A
        // zero-row UPDATE means the row went away out-of-band, so the full write
        // below recreates it — an execution silently absent while events keep
        // being appended for its id would orphan the event log.
        if (
          lastWrite !== undefined &&
          lastWrite.executionId === execution.id &&
          lastWrite.structuralRevision === execution.structuralRevision &&
          revisionBlindValuesUnchanged(lastWrite.revisionBlindValues, execution)
        ) {
          const runtime = runtimeTierSchema.parse(execution);
          if (
            writeRuntimeOnly(
              projectPath,
              sessionName,
              lastWrite.executionId,
              runtime,
              updatedAt,
            )
          ) {
            invalidate();
            return true;
          }
        }
        const validated = graphWorkflowExecutionSchema.parse(execution);
        const split = splitExecution(validated);
        // A structural key moved without changing the definition tier —
        // `routeControlRevisions` and `charterAmendments` advance the revision
        // from the runtime tier — so the stored definition bytes still stand.
        if (
          lastWrite !== undefined &&
          lastWrite.definitionJson === split.definitionJson
        ) {
          if (
            writeRuntimeOnly(
              projectPath,
              sessionName,
              split.projections.executionId,
              validated,
              updatedAt,
            )
          ) {
            lastDefinitionWrite.set(cacheKey, {
              ...lastWrite,
              structuralRevision: validated.structuralRevision,
              revisionBlindValues: revisionBlindValues(validated),
            });
            invalidate();
            return true;
          }
        }
        writeFull(projectPath, sessionName, split, validated, updatedAt);
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
          // Validation stays read-only: the feed calls this on a
          // poll, and a launch admitted between two polls must not find its row
          // overwritten by an enumeration carrying a pre-launch snapshot.
          const merged = mergeRow(identifier, row);
          result.set(key(row.project_path, row.session_name), merged);
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
