import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { projectKeys } from "@/lib/projects/query-keys";

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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.list(),
      });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.list(),
      });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
    },
  });
}
