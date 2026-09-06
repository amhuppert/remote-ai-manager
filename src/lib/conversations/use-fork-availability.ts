"use client";

import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { backendForkRefusalIn } from "@/lib/agent-backends/fork-admission";
import type { BackendAdmissionRefusal } from "@/lib/agent-backends/execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "./schemas";

export function useForkAvailability(
  conversation:
    | Pick<ConversationState, "backendRef" | "forkedFrom" | "agentBackend">
    | undefined,
  backend: AgentBackendId,
): BackendAdmissionRefusal | null {
  const catalog = useBackendCatalogQuery();
  const sourceBackend =
    conversation?.backendRef?.backend ??
    conversation?.forkedFrom?.sourceBackendRef?.backend ??
    conversation?.agentBackend ??
    backend;
  return backendForkRefusalIn(
    conversation && catalog.isFetched && !catalog.isError ? catalog.data : [],
    sourceBackend,
    1,
    "assistant",
  );
}
