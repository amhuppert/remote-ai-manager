import type { BackendCatalogEntry } from "@/lib/agent-backends/catalog";
import {
  backendExecutionRefusal,
  backendExecutionRefusalIn,
} from "@/lib/agent-backends/execution-admission";
import { collaborationAgentRefusal } from "@/lib/workflows/collaboration/types";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  builtInCommandNameSchema,
  type CommandAvailability,
  type CommandItem,
} from "./schemas";
import { BUILT_IN_COMMAND_EXECUTION } from "./built-in-commands";

export function commandAvailability(
  entry: BackendCatalogEntry,
  command: string,
): CommandAvailability {
  const parsed = builtInCommandNameSchema.safeParse(command);
  if (!parsed.success) return { status: "available" };
  const contract = BUILT_IN_COMMAND_EXECUTION[parsed.data];
  for (const requirement of contract.required) {
    const refusal = backendExecutionRefusal(entry, requirement);
    if (refusal) return { status: "unavailable", refusal };
  }
  if (command === "/collab") {
    const message = collaborationAgentRefusal(entry.id);
    if (message)
      return {
        status: "unavailable",
        refusal: {
          backend: entry.id,
          operation: "collaboration",
          code: "backend-role-unsupported",
          message,
        },
      };
  }
  const stages = contract.stages.flatMap(({ stage, requirements }) => {
    const refusal = requirements
      .map((requirement) => backendExecutionRefusal(entry, requirement))
      .find((candidate) => candidate !== null);
    return refusal ? [{ stage, refusal }] : [];
  });
  if (stages.length) return { status: "degraded", stages };
  return { status: "available" };
}

export function applyCommandAvailability(
  items: readonly CommandItem[],
  entries: readonly BackendCatalogEntry[],
  backend: AgentBackendId,
): CommandItem[] {
  const entry = entries.find((candidate) => candidate.id === backend);
  return items.map((item) => {
    if (!builtInCommandNameSchema.safeParse(item.name).success) return item;
    const missing = backendExecutionRefusalIn(entries, backend, {
      facet: "conversation",
      executionClass: "ordinary-conversation",
      operation: item.name,
    });
    const availability: CommandAvailability = entry
      ? commandAvailability(entry, item.name)
      : { status: "unavailable", refusal: missing! };
    const description =
      availability.status === "unavailable"
        ? availability.refusal.message
        : availability.status === "degraded"
          ? `${item.name === "/commit" ? "Commit changes" : item.name === "/merge" ? "Merge session changes" : "Rebase the session branch"}. Unavailable: ${availability.stages.map(({ stage }) => stage.replaceAll("-", " ")).join(", ")}.`
          : item.description;
    return { ...item, availability, description };
  });
}
