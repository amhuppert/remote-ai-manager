import type { QueryClient } from "@tanstack/react-query";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import { commandsChangedEventSchema } from "./schemas";
import { commandKeys } from "./query-keys";

export function registerCommandSseReactions(
  es: SseEventTarget,
  deps: { queryClient: QueryClient },
): void {
  addSseListener(es, "commands-changed", commandsChangedEventSchema, () => {
    void deps.queryClient.invalidateQueries({ queryKey: commandKeys.all });
  });
}
