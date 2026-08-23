import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import sourceExecution from "./artemis-bug-reporter-execution.json";

/**
 * Captured from Artemis / Bug reporter functionality / execution
 * 22707c00-b09b-4b24-ad24-e2f8b086262a when ticket #10 was filed.
 * Repeated agent prompt bodies and per-context charter copies are shortened,
 * and local worktree paths are replaced with fixture paths. The workflow
 * definition, launch document, and operational state are otherwise unchanged.
 */
export const artemisBugReporterExecution =
  graphWorkflowExecutionSchema.parse(sourceExecution);
