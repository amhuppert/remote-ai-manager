import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  spawnResultSchema,
  type SpawnProposal,
  type SpawnResult,
} from "./schemas";

/**
 * Submit a (possibly edited) validated spawn proposal for deterministic
 * creation. The submitted body is exactly what the user reviewed/edited in the
 * card; the route re-validates and returns the batch outcome.
 */
export function useSpawnSessions(
  projectName: string,
  conversationId: string,
): UseMutationResult<SpawnResult, Error, SpawnProposal> {
  return useMutation({
    mutationFn: (proposal: SpawnProposal) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/spawn`,
        "spawn-sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proposal),
        },
        spawnResultSchema,
      ),
  });
}
