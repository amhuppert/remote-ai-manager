import type Database from "better-sqlite3";
import { z } from "zod";
import {
  workspaceBindingRecordSchema,
  workspaceOperationRecordSchema,
  type WorkspaceBindingRecord,
  type WorkspaceOperationRecord,
} from "@/lib/workspace/schemas";

type Db = InstanceType<typeof Database>;

const bindingRowSchema = z.object({
  binding_id: z.string(),
  request_json: z.string(),
  state: z.string(),
  baseline: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const operationRowSchema = z.object({
  cause: z.string(),
  binding_id: z.string(),
  requester_kind: z.string(),
  requester_id: z.string(),
  request_json: z.string(),
  permit_controller_id: z.string().nullable(),
  permit_generation: z.number().int().nullable(),
  state: z.string(),
  outcome_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const BINDING_COLUMNS =
  "binding_id, request_json, state, baseline, created_at, updated_at";
const OPERATION_COLUMNS = `cause, binding_id, requester_kind, requester_id, request_json,
  permit_controller_id, permit_generation, state, outcome_json, created_at, updated_at`;

function bindingFromRow(raw: unknown): WorkspaceBindingRecord {
  const row = bindingRowSchema.parse(raw);
  return workspaceBindingRecordSchema.parse({
    bindingId: row.binding_id,
    request: JSON.parse(row.request_json),
    state: row.state,
    baseline: row.baseline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function operationFromRow(raw: unknown): WorkspaceOperationRecord {
  const row = operationRowSchema.parse(raw);
  return workspaceOperationRecordSchema.parse({
    cause: row.cause,
    bindingId: row.binding_id,
    requester: { kind: row.requester_kind, id: row.requester_id },
    request: JSON.parse(row.request_json),
    permit:
      row.permit_controller_id === null || row.permit_generation === null
        ? null
        : {
            controllerId: row.permit_controller_id,
            generation: row.permit_generation,
          },
    state: row.state,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Sole writer of Workspace's binding and operation journal tables. */
export interface WorkspaceRepo {
  insertBindingIfAbsent(record: WorkspaceBindingRecord): void;
  getBinding(bindingId: string): WorkspaceBindingRecord | null;
  listBindings(
    worktreePath: string,
    state: WorkspaceBindingRecord["state"],
  ): WorkspaceBindingRecord[];
  setBindingState(
    bindingId: string,
    change: {
      state: WorkspaceBindingRecord["state"];
      baseline: string | null;
      updatedAt: string;
    },
  ): void;
  insertOperationIfAbsent(record: WorkspaceOperationRecord): void;
  getOperation(cause: string): WorkspaceOperationRecord | null;
  listOperations(
    state: WorkspaceOperationRecord["state"],
  ): WorkspaceOperationRecord[];
  updateOperation(
    cause: string,
    change: Partial<
      Pick<WorkspaceOperationRecord, "state" | "outcome" | "permit">
    > & { updatedAt: string },
  ): void;
  deleteOperation(cause: string): void;
}

export function createWorkspaceRepo(db: Db): WorkspaceRepo {
  const insertBinding = db.prepare(
    `INSERT OR IGNORE INTO workspace_bindings (binding_id, worktree_path, request_json, state, baseline, created_at, updated_at)
     VALUES (@bindingId, @worktreePath, @requestJson, @state, @baseline, @createdAt, @updatedAt)`,
  );
  const getBinding = db.prepare(
    `SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE binding_id = ?`,
  );
  const listBindings = db.prepare(
    `SELECT ${BINDING_COLUMNS} FROM workspace_bindings WHERE worktree_path = ? AND state = ? ORDER BY created_at, rowid`,
  );
  const setBindingState = db.prepare(
    `UPDATE workspace_bindings SET state = @state, baseline = @baseline, updated_at = @updatedAt WHERE binding_id = @bindingId`,
  );
  const insertOperation = db.prepare(
    `INSERT OR IGNORE INTO workspace_operations (${OPERATION_COLUMNS})
     VALUES (@cause, @bindingId, @requesterKind, @requesterId, @requestJson, @permitControllerId,
             @permitGeneration, @state, @outcomeJson, @createdAt, @updatedAt)`,
  );
  const getOperation = db.prepare(
    `SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE cause = ?`,
  );
  const listOperations = db.prepare(
    `SELECT ${OPERATION_COLUMNS} FROM workspace_operations WHERE state = ? ORDER BY created_at, rowid`,
  );
  const deleteOperation = db.prepare(
    `DELETE FROM workspace_operations WHERE cause = ?`,
  );
  const updateOperation = db.prepare(
    `UPDATE workspace_operations
        SET state = @state, outcome_json = @outcomeJson, permit_controller_id = @permitControllerId,
            permit_generation = @permitGeneration, updated_at = @updatedAt
      WHERE cause = @cause`,
  );
  return {
    insertBindingIfAbsent(record) {
      const parsed = workspaceBindingRecordSchema.parse(record);
      insertBinding.run({
        bindingId: parsed.bindingId,
        worktreePath: parsed.request.worktreePath,
        requestJson: JSON.stringify(parsed.request),
        state: parsed.state,
        baseline: parsed.baseline,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    },
    getBinding(bindingId) {
      const raw: unknown = getBinding.get(bindingId);
      return raw === undefined ? null : bindingFromRow(raw);
    },
    listBindings(worktreePath, state) {
      return listBindings.all(worktreePath, state).map(bindingFromRow);
    },
    setBindingState(bindingId, change) {
      setBindingState.run({ bindingId, ...change });
    },
    insertOperationIfAbsent(record) {
      const parsed = workspaceOperationRecordSchema.parse(record);
      insertOperation.run({
        cause: parsed.cause,
        bindingId: parsed.bindingId,
        requesterKind: parsed.requester.kind,
        requesterId: parsed.requester.id,
        requestJson: JSON.stringify(parsed.request),
        permitControllerId: parsed.permit?.controllerId ?? null,
        permitGeneration: parsed.permit?.generation ?? null,
        state: parsed.state,
        outcomeJson:
          parsed.outcome === null || parsed.outcome === undefined
            ? null
            : JSON.stringify(parsed.outcome),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      });
    },
    getOperation(cause) {
      const raw: unknown = getOperation.get(cause);
      return raw === undefined ? null : operationFromRow(raw);
    },
    listOperations(state) {
      return listOperations.all(state).map(operationFromRow);
    },
    updateOperation(cause, change) {
      const current = this.getOperation(cause);
      if (current === null)
        throw new Error(`Unknown workspace operation ${cause}`);
      const next = { ...current, ...change };
      updateOperation.run({
        cause,
        state: next.state,
        outcomeJson:
          next.outcome === null || next.outcome === undefined
            ? null
            : JSON.stringify(next.outcome),
        permitControllerId: next.permit?.controllerId ?? null,
        permitGeneration: next.permit?.generation ?? null,
        updatedAt: change.updatedAt,
      });
    },
    deleteOperation(cause) {
      deleteOperation.run(cause);
    },
  };
}
