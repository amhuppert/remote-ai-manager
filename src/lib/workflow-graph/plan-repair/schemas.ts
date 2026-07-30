/**
 * Plan-repair verdict + restricted operation validation (docs/design/cc-cli/08).
 *
 * The repair agent's output is UNTRUSTED input. Its `operations` are re-parsed
 * against the full live-edit union (no shape drift) and then filtered through
 * the plan/controls split: the agent may change the plan (charter, context
 * prose/AC, budgets, tasks) but never the controls (validators, gates,
 * mutability, its own policy). Violations reject the batch — fail closed.
 */

import { z } from "zod";
import {
  workflowLiveEditOperationSchema,
  type WorkflowLiveEditOperation,
} from "@/lib/workflows/edit-schemas";

// The verdict the repair agent must return (structured-output enforced).
export const planRepairVerdictSchema = z.object({
  planningDefect: z.boolean(),
  diagnosis: z.string().min(1),
  // `type` is required HERE (not just at the allowlist) so the backend's
  // native structured output forces well-shaped ops out of the model —
  // the first live proof produced typeless operations under a fully loose
  // schema. Each entry is still re-parsed by `validatePlanRepairOperations`
  // against the real op union.
  operations: z.array(z.looseObject({ type: z.string().min(1) })).default([]),
});
export type PlanRepairVerdict = z.infer<typeof planRepairVerdictSchema>;

export const PLAN_REPAIR_VERDICT_JSON_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(planRepairVerdictSchema, { io: "input" }) as Record<
    string,
    unknown
  >;

/** Op types the repair agent may emit — plan artifacts only (F3). */
const ALLOWED_PLAN_REPAIR_OP_TYPES = new Set([
  "amend-charter",
  "update-context",
  "add-task",
  "update-task",
  "remove-task",
  "reorder-tasks",
]);

/**
 * `update-context` fields the repair agent may NOT touch. These parse fine on
 * the shared op schema (they are legitimate live-edit fields for humans), so
 * presence is checked explicitly after the parse.
 */
const UPDATE_CONTEXT_CONTROL_BLOCKS = [
  "implementer",
  "contextValidator",
  "scriptValidator",
  "humanApprovalGate",
  "askUserQuestions",
  "mutability",
  "collaboration",
  "planRepair",
] as const;

export interface PlanRepairOperationIssue {
  index: number;
  message: string;
}

export type ValidatePlanRepairOperationsResult =
  | { ok: true; operations: WorkflowLiveEditOperation[] }
  | { ok: false; issues: PlanRepairOperationIssue[] };

export function validatePlanRepairOperations(
  raw: unknown,
): ValidatePlanRepairOperationsResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{ index: 0, message: "operations must be an array" }],
    };
  }

  const issues: PlanRepairOperationIssue[] = [];
  const operations: WorkflowLiveEditOperation[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index];
    const type =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Record<string, unknown>)["type"]
        : undefined;

    if (typeof type !== "string" || !ALLOWED_PLAN_REPAIR_OP_TYPES.has(type)) {
      issues.push({
        index,
        message: `operation type "${String(type)}" is not permitted for plan repair (allowed: ${[...ALLOWED_PLAN_REPAIR_OP_TYPES].join(", ")})`,
      });
      continue;
    }

    const parsed = workflowLiveEditOperationSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push({
        index,
        message: `invalid ${type} operation: ${parsed.error.issues[0]?.message ?? "schema violation"}`,
      });
      continue;
    }

    if (parsed.data.type === "update-context") {
      const touched = UPDATE_CONTEXT_CONTROL_BLOCKS.filter(
        (block) =>
          (parsed.data as unknown as Record<string, unknown>)[block] !==
          undefined,
      );
      if (touched.length > 0) {
        issues.push({
          index,
          message: `update-context may not touch control block(s) ${touched.join(", ")} — plan repair edits plan artifacts only`,
        });
        continue;
      }
    }

    operations.push(parsed.data);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  if (operations.length === 0) {
    return {
      ok: false,
      issues: [{ index: 0, message: "operations must not be empty" }],
    };
  }
  return { ok: true, operations };
}
