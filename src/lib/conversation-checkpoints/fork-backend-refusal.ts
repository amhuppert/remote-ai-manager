import type { BackendCatalogEntry } from "@/lib/agent-backends/catalog";
import { backendExecutionRefusal } from "@/lib/agent-backends/execution-admission";

export function checkpointForkBackendRefusal(
  entry: BackendCatalogEntry,
): string | null {
  return (
    backendExecutionRefusal(entry, {
      facet: "conversation",
      executionClass: "ordinary-conversation",
      operation: "checkpoint-fork",
    })?.message ??
    (entry.capabilities?.checkpointFork
      ? null
      : "Checkpoint forks are unavailable for this backend.")
  );
}
