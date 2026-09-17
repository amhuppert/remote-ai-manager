import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { createProductionSpecWorkflowComposition } from "@/lib/specs/production-workflow-composition";
import type { WorkflowComposition } from "./production-contracts";

/** One concrete composition shared by the graph and background-job hosts. */
export function getProductionWorkflowComposition(): WorkflowComposition {
  return getGlobalSingleton(
    "__cc_workflow_composition",
    createProductionSpecWorkflowComposition,
  );
}
