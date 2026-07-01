import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { z } from "zod";
import { mutationFetch } from "@/lib/api/fetcher";
import { projectKeys } from "@/lib/projects/query-keys";
import type {
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
} from "@/lib/projects/schemas";

type DiscoveredProject = z.infer<typeof discoveredProjectSchema>;
type ProjectPreferences = z.infer<typeof projectPreferencesResponseSchema>;

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

  return useMutation({
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
    onMutate: async ({ projectName, archived }) => {
      const context = await snapshotProjectCaches(queryClient);
      if (context.previousPreferences) {
        queryClient.setQueryData<ProjectPreferences>(
          projectKeys.preferences(),
          {
            ...context.previousPreferences,
            archived: withMembership(
              context.previousPreferences.archived,
              projectName,
              archived,
            ),
          },
        );
      }
      return context;
    },
    onError: (_err, _vars, context) => {
      rollbackProjectCaches(queryClient, context);
    },
    onSettled: () => {
      invalidateProjectCaches(queryClient);
    },
  });
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
      ),
    onMutate: async ({ projectName }) => {
      const context = await snapshotProjectCaches(queryClient);
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
      return context;
    },
    onError: (_err, _vars, context) => {
      rollbackProjectCaches(queryClient, context);
    },
    onSettled: () => {
      invalidateProjectCaches(queryClient);
    },
  });
}

export function usePinProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
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
    onMutate: async ({ projectName, pinned }) => {
      await queryClient.cancelQueries({
        queryKey: projectKeys.preferences(),
      });
      const previousPreferences = queryClient.getQueryData<ProjectPreferences>(
        projectKeys.preferences(),
      );
      if (previousPreferences) {
        queryClient.setQueryData<ProjectPreferences>(
          projectKeys.preferences(),
          {
            ...previousPreferences,
            pinned: withMembership(
              previousPreferences.pinned,
              projectName,
              pinned,
            ),
          },
        );
      }
      return { previousPreferences };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPreferences) {
        queryClient.setQueryData(
          projectKeys.preferences(),
          context.previousPreferences,
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
    },
  });
}
