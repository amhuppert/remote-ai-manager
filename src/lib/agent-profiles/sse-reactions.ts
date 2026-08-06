/**
 * Agent-profile library SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 *
 * Invalidation follows the event's scope, which is the changed record's tier:
 * a global-tier record is reachable from every project, so every library query
 * goes stale; a project-tier record is reachable from one, so only that
 * project's do.
 */

import type { QueryClient } from "@tanstack/react-query";

import { addSseListener } from "@/lib/api/sse";

import {
  agentProfileKeys,
  agentProfileProjectNameFromPath,
} from "./query-keys";
import { agentProfileLibraryChangedEventSchema } from "./schemas";

export interface AgentProfileSseReactionDeps {
  queryClient: QueryClient;
}

export function registerAgentProfileSseReactions(
  es: EventSource,
  deps: AgentProfileSseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(
    es,
    "agent-profile-library-changed",
    agentProfileLibraryChangedEventSchema,
    (event) => {
      if (event.scope === "global") {
        void queryClient.invalidateQueries({ queryKey: agentProfileKeys.all });
        return;
      }

      const projectName = agentProfileProjectNameFromPath(event.projectPath);
      if (projectName === null) {
        // The path named no project we can key by. Over-invalidating costs a
        // refetch; under-invalidating leaves a library the user just edited
        // showing its old contents.
        void queryClient.invalidateQueries({ queryKey: agentProfileKeys.all });
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: agentProfileKeys.projectList(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: agentProfileKeys.projectScope(projectName),
      });
    },
  );
}
