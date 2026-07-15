/**
 * Agent-capability SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import {
  agentCapabilitiesDiscoveryUpdatedEventSchema,
  agentCapabilitiesUpdatedEventSchema,
} from "@/lib/agent-capabilities/schemas";
import { computeAgentCapabilityInvalidations } from "@/lib/agent-capabilities/sse-invalidation";

export interface AgentCapabilitySseReactionDeps {
  queryClient: QueryClient;
}

interface CapabilityEventIdentifiers {
  level: "global" | "project" | "session" | "conversation";
  projectName?: string;
  conversationScope?: "session" | "project";
  sessionName?: string;
  conversationId?: string;
  cascadeKind:
    | "claude-skills"
    | "claude-plugins"
    | "claude-agents"
    | "codex-skills"
    | "codex-plugins";
}

function invalidateAgentCapabilityViews(
  queryClient: QueryClient,
  data: CapabilityEventIdentifiers,
): void {
  const invalidations = computeAgentCapabilityInvalidations({
    level: data.level,
    cascadeKind: data.cascadeKind,
    ...(data.projectName !== undefined && {
      projectName: data.projectName,
    }),
    ...(data.conversationScope !== undefined && {
      conversationScope: data.conversationScope,
    }),
    ...(data.sessionName !== undefined && {
      sessionName: data.sessionName,
    }),
    ...(data.conversationId !== undefined && {
      conversationId: data.conversationId,
    }),
  });
  for (const matcher of invalidations) {
    void queryClient.invalidateQueries({ queryKey: matcher.queryKey });
  }
}

export function registerAgentCapabilitySseReactions(
  es: EventSource,
  deps: AgentCapabilitySseReactionDeps,
): void {
  addSseListener(
    es,
    "agent-capabilities-updated",
    agentCapabilitiesUpdatedEventSchema,
    (data) => invalidateAgentCapabilityViews(deps.queryClient, data),
  );

  addSseListener(
    es,
    "agent-capabilities-discovery-updated",
    agentCapabilitiesDiscoveryUpdatedEventSchema,
    (data) => invalidateAgentCapabilityViews(deps.queryClient, data),
  );
}
