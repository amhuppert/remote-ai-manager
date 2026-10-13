/**
 * Run template SSE reactions, registered on the shared `/api/events`
 * EventSource by `NotificationListener`.
 *
 * Invalidation follows the changed template's tier: a global template is read
 * through every project, so every project's template reads go stale; a
 * project template is read through its own project only, so that project's
 * list and the template's own detail do.
 */
import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
// The resolver's project-path to project-name bridge, owned by the profile library's keys.
import { agentProfileProjectNameFromPath } from "@/lib/agent-profiles/query-keys";
import { runTemplateKeys } from "./query-keys";
import { runTemplateChangedEventSchema } from "./schemas";

export function registerRunTemplateSseReactions(
  es: EventSource,
  deps: { queryClient: QueryClient },
): void {
  const { queryClient } = deps;
  addSseListener(
    es,
    "run-template-changed",
    runTemplateChangedEventSchema,
    (event) => {
      const projectName =
        event.scope === "global"
          ? null
          : agentProfileProjectNameFromPath(event.projectPath);
      if (projectName === null) {
        // A global template, or a project path naming no project to key by: a
        // stale template is worse than a redundant refetch.
        void queryClient.invalidateQueries({ queryKey: runTemplateKeys.all });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: runTemplateKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: runTemplateKeys.detail(projectName, "project", event.id),
      });
    },
  );
}
