import { createLogger } from "@/lib/logging";
import {
  graphWorkflowExecutionOriginSchema,
  type GraphWorkflowExecutionOrigin,
} from "@/lib/workflow-graph/spec-bridge";

import type { SpecExecutionRow } from "./schemas";

const logger = createLogger("specs.execution-seed-source");

/**
 * The launch origin a native-SDD execution row recorded, or null when the row
 * predates direct-authored launches or recorded something other than a spec
 * delivery. Only the `spec_delivery` origin is meaningful here: any other kind
 * in this column is a defect worth a warning, never a value to project.
 */
export function nativeSddSeedSourceSummary(
  execution: SpecExecutionRow,
): Extract<GraphWorkflowExecutionOrigin, { kind: "spec_delivery" }> | null {
  const raw = execution.workflow_seed_source_json ?? null;
  if (raw === null) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = graphWorkflowExecutionOriginSchema.safeParse(candidate);
  if (!parsed.success) return null;
  if (parsed.data.kind !== "spec_delivery") {
    logger.warn("specs.execution.non-spec-delivery-origin-refused", {
      specExecutionId: execution.id,
      specId: execution.spec_id,
      originKind: parsed.data.kind,
    });
    return null;
  }
  return parsed.data;
}
