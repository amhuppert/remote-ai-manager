import {
  backendExecutionRefusal,
  backendExecutionRefusalIn,
  type ExecutionCatalogEntry,
} from "@/lib/agent-backends/execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";

const taskRequirements = {
  facet: "tasks",
  operation: "workflow-assignment",
  executionClass: "governed-execution",
  executionProfile: "standard",
} as const;

export function workflowBackendRefusal(
  entry: ExecutionCatalogEntry,
): string | null {
  return (
    (
      backendExecutionRefusal(entry, taskRequirements) ??
      backendExecutionRefusal(entry, {
        facet: "conversation",
        operation: "workflow-assignment",
        executionClass: "governed-execution",
      })
    )?.message ?? null
  );
}

export function workflowBackendRefusalIn(
  entries: readonly ExecutionCatalogEntry[],
  backend: AgentBackendId,
): string | null {
  const entry = entries.find((candidate) => candidate.id === backend);
  return entry
    ? workflowBackendRefusal(entry)
    : backendExecutionRefusalIn(entries, backend, taskRequirements)!.message;
}
