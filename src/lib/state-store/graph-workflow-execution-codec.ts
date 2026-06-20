import {
  migrateLegacyExecution,
  needsLegacyMigration,
} from "@/lib/workflow-graph/migrate-legacy-execution";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import { getErrorMessage } from "../shared/errors";
import { stableStringify } from "./serialization";

/**
 * A legacy-shaped execution that was upgraded on read. `upgradedJson` is the
 * canonical re-serialization of the upgraded value, ready to be written back so
 * the next read skips the upgrade; `executionId`/`repairedFields` describe what
 * changed for structured logging.
 */
export interface GraphWorkflowExecutionMigration {
  upgradedJson: string;
  executionId: string | null;
  repairedFields: string[];
}

export type GraphWorkflowExecutionDecodeResult =
  | {
      ok: true;
      value: GraphWorkflowExecution | null;
      migration: GraphWorkflowExecutionMigration | null;
    }
  | { ok: false; issues: unknown };

/**
 * Shared legacy-upgrade + schema-validation step for a parsed
 * {@link GraphWorkflowExecution} candidate. Consumed by both the vestigial
 * `sessions.graph_workflow_execution` column path and the
 * `graph_workflow_executions` definition/runtime tier-merge path, so the
 * legacy-migration and validation rules live in exactly one place.
 *
 * `candidate` is the already-`JSON.parse`d value (or `null`). A legacy-shaped
 * value is upgraded via {@link migrateLegacyExecution}; the upgraded canonical
 * JSON is surfaced as `migration.upgradedJson` so the caller can rewrite the
 * stored blob in place. Returns `ok: false` with structured issues on a parse
 * or legacy-migration failure.
 */
export function decodeGraphWorkflowExecution(
  candidate: unknown,
): GraphWorkflowExecutionDecodeResult {
  if (candidate === null) return { ok: true, value: null, migration: null };

  let upgraded: unknown = candidate;
  let migrationMeta: {
    executionId: string | null;
    repairedFields: string[];
  } | null = null;
  if (needsLegacyMigration(candidate)) {
    try {
      const result = migrateLegacyExecution(candidate);
      upgraded = result.upgradedRecord;
      migrationMeta = {
        executionId: result.executionId,
        repairedFields: result.repairedFields,
      };
    } catch (err) {
      return {
        ok: false,
        issues: [
          {
            code: "legacy_migration_failed",
            path: ["graphWorkflowExecution"],
            message: getErrorMessage(err),
          },
        ],
      };
    }
  }

  const parseResult = graphWorkflowExecutionSchema.nullable().safeParse(upgraded);
  if (!parseResult.success) {
    return { ok: false, issues: parseResult.error.issues };
  }
  if (parseResult.data === null) {
    return { ok: true, value: null, migration: null };
  }
  if (migrationMeta === null) {
    return { ok: true, value: parseResult.data, migration: null };
  }
  return {
    ok: true,
    value: parseResult.data,
    migration: {
      upgradedJson: stableStringify(parseResult.data),
      executionId: migrationMeta.executionId,
      repairedFields: migrationMeta.repairedFields,
    },
  };
}
