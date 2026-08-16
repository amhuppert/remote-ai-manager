import type Database from "better-sqlite3";
import { z } from "zod";

import {
  SpecExecutionBindingMismatchError,
  SpecExecutionBindingNotFoundError,
  specExecutionBindingSnapshotV2Schema,
  type LinkedSpecExecutionBindingV2,
  type SpecExecutionBindingExpectedIdentity,
  type SpecExecutionBindingReader,
  type SpecExecutionBindingSnapshotV2,
} from "@/lib/specs/execution-binding";
import { stableStringify } from "./serialization";
import { createSpecRepoHelpers } from "./spec-repo-helpers";

type Db = InstanceType<typeof Database>;

const storedSpecExecutionBindingRowSchema = z
  .object({
    spec_execution_id: z.string().trim().min(1),
    workflow_execution_id: z.string().trim().min(1),
    binding_json: z.string().min(1),
    created_at: z.string().min(1),
  })
  .strict();

type StoredSpecExecutionBindingRow = z.infer<
  typeof storedSpecExecutionBindingRowSchema
>;

export interface InsertSpecExecutionBindingInput {
  specExecutionId: string;
  workflowExecutionId: string;
  binding: SpecExecutionBindingSnapshotV2;
  createdAt: string;
}

export interface SpecExecutionBindingRepo extends SpecExecutionBindingReader {
  insert(input: InsertSpecExecutionBindingInput): LinkedSpecExecutionBindingV2;
  findBySpecExecutionId(
    specExecutionId: string,
  ): LinkedSpecExecutionBindingV2 | null;
}

const { parseRow, timed } = createSpecRepoHelpers(
  "state-store.spec-execution-binding",
);

function parseBindingJson(
  identifier: string,
  serialized: string,
): SpecExecutionBindingSnapshotV2 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    value = undefined;
  }
  return parseRow(
    specExecutionBindingSnapshotV2Schema,
    "spec_execution_binding",
    identifier,
    value,
  );
}

function projectRow(value: unknown): LinkedSpecExecutionBindingV2 | null {
  if (value === undefined) return null;
  const row = parseRow(
    storedSpecExecutionBindingRowSchema,
    "spec_execution_binding",
    "stored-row",
    value,
  );
  return {
    specExecutionId: row.spec_execution_id,
    workflowExecutionId: row.workflow_execution_id,
    binding: parseBindingJson(row.workflow_execution_id, row.binding_json),
    createdAt: row.created_at,
  };
}

function assertExpectedIdentity(
  linked: LinkedSpecExecutionBindingV2,
  expected: SpecExecutionBindingExpectedIdentity,
): void {
  const actual = {
    specExecutionId: linked.specExecutionId,
    candidateId: linked.binding.candidateId,
    candidateHash: linked.binding.candidateHash,
    pinnedRevisionId: linked.binding.pinnedRevisionId,
  };
  for (const field of [
    "specExecutionId",
    "candidateId",
    "candidateHash",
    "pinnedRevisionId",
  ] as const) {
    const expectedValue = expected[field];
    if (expectedValue !== undefined && actual[field] !== expectedValue) {
      throw new SpecExecutionBindingMismatchError(
        linked.workflowExecutionId,
        field,
      );
    }
  }
}

export function createSpecExecutionBindingRepo(
  db: Db,
): SpecExecutionBindingRepo {
  const insertStatement = db.prepare(
    `INSERT INTO spec_execution_bindings (
       spec_execution_id, workflow_execution_id, binding_json, created_at
     ) VALUES (
       @spec_execution_id, @workflow_execution_id, @binding_json, @created_at
     )`,
  );
  const findByWorkflowExecutionStatement = db.prepare(
    `SELECT spec_execution_id, workflow_execution_id, binding_json, created_at
       FROM spec_execution_bindings
      WHERE workflow_execution_id = ?
      LIMIT 1`,
  );
  const findBySpecExecutionStatement = db.prepare(
    `SELECT spec_execution_id, workflow_execution_id, binding_json, created_at
       FROM spec_execution_bindings
      WHERE spec_execution_id = ?
      LIMIT 1`,
  );
  const findDirectSpecExecutionStatement = db.prepare(
    `SELECT id
       FROM spec_executions
      WHERE workflow_execution_id = ?
        AND workflow_definition_id IS NULL
      LIMIT 1`,
  );

  function findByWorkflowExecutionId(
    workflowExecutionId: string,
  ): LinkedSpecExecutionBindingV2 | null {
    return timed(
      "find_by_workflow_execution",
      "spec_execution_binding",
      workflowExecutionId,
      () => {
        const linked = projectRow(
          findByWorkflowExecutionStatement.get(workflowExecutionId),
        );
        if (
          linked === null &&
          findDirectSpecExecutionStatement.get(workflowExecutionId) !==
            undefined
        ) {
          throw new SpecExecutionBindingNotFoundError(workflowExecutionId);
        }
        return linked;
      },
    );
  }

  return {
    insert(input) {
      return timed(
        "insert",
        "spec_execution_binding",
        input.workflowExecutionId,
        () => {
          const binding = specExecutionBindingSnapshotV2Schema.parse(
            input.binding,
          );
          const stored: StoredSpecExecutionBindingRow = {
            spec_execution_id: input.specExecutionId,
            workflow_execution_id: input.workflowExecutionId,
            binding_json: stableStringify(binding),
            created_at: input.createdAt,
          };
          insertStatement.run(
            storedSpecExecutionBindingRowSchema.parse(stored),
          );
          return {
            specExecutionId: input.specExecutionId,
            workflowExecutionId: input.workflowExecutionId,
            binding,
            createdAt: input.createdAt,
          };
        },
      );
    },
    findByWorkflowExecutionId,
    findBySpecExecutionId(specExecutionId) {
      return timed(
        "find_by_spec_execution",
        "spec_execution_binding",
        specExecutionId,
        () => projectRow(findBySpecExecutionStatement.get(specExecutionId)),
      );
    },
    requireByWorkflowExecutionId(workflowExecutionId, expected = {}) {
      const linked = findByWorkflowExecutionId(workflowExecutionId);
      if (linked === null) {
        throw new SpecExecutionBindingNotFoundError(workflowExecutionId);
      }
      assertExpectedIdentity(linked, expected);
      return linked;
    },
  };
}
