import { normalizeRawDefinitionEdgeIds } from "@/lib/workflow-graph/edge-identity";
import { floorRawExecutionOrigin } from "@/lib/workflow-graph/execution-origin";
import { migrateRawExecutionPlacement } from "@/lib/workflow-graph/placement-migration";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

export type GraphWorkflowExecutionDecodeResult =
  | {
      ok: true;
      value: GraphWorkflowExecution | null;
    }
  | { ok: false; issues: unknown };

/** Validate a stored execution after applying the remaining field floors. */
export function decodeGraphWorkflowExecution(
  candidate: unknown,
): GraphWorkflowExecutionDecodeResult {
  if (candidate === null) return { ok: true, value: null };

  // The inflate boundary for a stored execution (D4 decision D2): edge ids are
  // required unique for new authoring, so a workingDefinition written before
  // that rule is repaired deterministically here rather than refused. Runs
  // before the parse because the parse already requires `id`.
  //
  // Lane placement (D5 decision D13) is repaired at the same point and for the
  // same reason: it is required on the resolved context, so an execution seeded
  // before it existed would be unreadable. This is the boundary for BOTH the
  // active and the archived tier, so a pre-placement archive stays readable and
  // a resumed pre-placement run continues under migrated placement.
  //
  // Origin (D7 decision D2) is floored at the same boundary and for the same
  // reason: it is required on the domain record so every consumer can branch on
  // it unconditionally, and a row written before it existed carries the seed
  // fields the template origin is derived from.
  if (typeof candidate === "object" && candidate !== null) {
    normalizeRawDefinitionEdgeIds(
      (candidate as { workingDefinition?: unknown }).workingDefinition,
    );
    migrateRawExecutionPlacement(candidate);
    floorRawExecutionOrigin(candidate);
  }

  const parseResult = graphWorkflowExecutionSchema
    .nullable()
    .safeParse(candidate);
  if (!parseResult.success) {
    return { ok: false, issues: parseResult.error.issues };
  }
  return { ok: true, value: parseResult.data };
}
