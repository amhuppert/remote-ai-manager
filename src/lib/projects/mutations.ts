import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { projectKeys } from "@/lib/projects/query-keys";
import type {
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
} from "@/lib/projects/schemas";
import {
  removeProjectTicketsOptimistically,
  resetDeletedProjectTicketCaches,
  restoreProjectTicketLists,
} from "@/lib/tickets/cache-lifecycle";
import { rememberAuthoritativeTicketDeletion } from "@/lib/tickets/event-version";
import { scheduleTicketCacheInvalidation } from "@/lib/tickets/mutation-coordinator";
import { ticketKeys } from "@/lib/tickets/query-keys";

type DiscoveredProject = z.infer<typeof discoveredProjectSchema>;
type ProjectPreferences = z.infer<typeof projectPreferencesResponseSchema>;

const deleteProjectResponseSchema = z.object({
  success: z.literal(true),
  sessionsRemoved: z.number().int().nonnegative(),
  deletedTicketNumbers: z.array(z.number().int().positive()),
});

function withMembership(
  names: readonly string[],
  name: string,
  member: boolean,
): string[] {
  const without = names.filter((n) => n !== name);
  return member ? [...without, name] : without;
}

async function snapshotProjectCaches(queryClient: QueryClient) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: projectKeys.list() }),
    queryClient.cancelQueries({ queryKey: projectKeys.preferences() }),
  ]);
  return {
    previousList: queryClient.getQueryData<DiscoveredProject[]>(
      projectKeys.list(),
    ),
    previousPreferences: queryClient.getQueryData<ProjectPreferences>(
      projectKeys.preferences(),
    ),
  };
}

type ProjectCachesSnapshot = Awaited<ReturnType<typeof snapshotProjectCaches>>;

function rollbackProjectCaches(
  queryClient: QueryClient,
  context: ProjectCachesSnapshot | undefined,
) {
  if (context?.previousList) {
    queryClient.setQueryData(projectKeys.list(), context.previousList);
  }
  if (context?.previousPreferences) {
    queryClient.setQueryData(
      projectKeys.preferences(),
      context.previousPreferences,
    );
  }
}

function invalidateProjectCaches(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
  void queryClient.invalidateQueries({ queryKey: projectKeys.preferences() });
}

export function useArchiveProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        projectName,
        archived,
      }: {
        projectName: string;
        archived: boolean;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/archive`,
          "archive-project",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived }),
          },
        ),
      updates: [
        // The project list carries no optimistic write for archive; it is
        // snapshotted/restored and reconciled by invalidation alone.
        cacheUpdate<
          { projectName: string; archived: boolean },
          DiscoveredProject[]
        >({
          key: () => projectKeys.list(),
          update: () => undefined,
        }),
        cacheUpdate<
          { projectName: string; archived: boolean },
          ProjectPreferences
        >({
          key: () => projectKeys.preferences(),
          update: (old, vars) =>
            old
              ? {
                  ...old,
                  archived: withMembership(
                    old.archived,
                    vars.projectName,
                    vars.archived,
                  ),
                }
              : undefined,
        }),
      ],
    }),
  );
}

export function useDeleteProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      projectPath,
    }: {
      projectName: string;
      projectPath: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}?projectPath=${encodeURIComponent(projectPath)}`,
        "delete-project",
        { method: "DELETE" },
        deleteProjectResponseSchema,
      ),
    onMutate: async ({ projectName }) => {
      const context = await snapshotProjectCaches(queryClient);
      await queryClient.cancelQueries({ queryKey: ticketKeys.lists() });
      const previousTicketLists = removeProjectTicketsOptimistically(
        queryClient,
        projectName,
      );
      if (context.previousList) {
        queryClient.setQueryData<DiscoveredProject[]>(
          projectKeys.list(),
          context.previousList.filter((p) => p.name !== projectName),
        );
      }
      if (context.previousPreferences) {
        queryClient.setQueryData<ProjectPreferences>(
          projectKeys.preferences(),
          {
            archived: withMembership(
              context.previousPreferences.archived,
              projectName,
              false,
            ),
            pinned: withMembership(
              context.previousPreferences.pinned,
              projectName,
              false,
            ),
          },
        );
      }
      return { ...context, previousTicketLists };
    },
    onError: (_err, _vars, context) => {
      rollbackProjectCaches(queryClient, context);
      restoreProjectTicketLists(queryClient, context?.previousTicketLists);
    },
    onSuccess: (data, { projectName }) => {
      for (const number of data.deletedTicketNumbers) {
        rememberAuthoritativeTicketDeletion(queryClient, projectName, number);
      }
      resetDeletedProjectTicketCaches(queryClient, projectName);
    },
    onSettled: () => {
      invalidateProjectCaches(queryClient);
      scheduleTicketCacheInvalidation(queryClient, { includeLists: true });
    },
  });
}

export function usePinProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        projectName,
        pinned,
      }: {
        projectName: string;
        pinned: boolean;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/pin`,
          "pin-project",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinned }),
          },
        ),
      updates: [
        cacheUpdate<
          { projectName: string; pinned: boolean },
          ProjectPreferences
        >({
          key: () => projectKeys.preferences(),
          update: (old, vars) =>
            old
              ? {
                  ...old,
                  pinned: withMembership(
                    old.pinned,
                    vars.projectName,
                    vars.pinned,
                  ),
                }
              : undefined,
        }),
      ],
    }),
  );
}
