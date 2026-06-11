import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { useAddOrUpdateJob } from "@/stores/notification.store";
import { jobDispatchResponseSchema } from "@/lib/jobs/schemas";
import { mutationFetch } from "@/lib/api/fetcher";

export { ApiCallError } from "@/lib/api/errors";

export function useLandPreparedMergeMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge/land`,
        "land-prepared-merge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useDiscardPreparedMergeMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge/discard`,
        "discard-prepared-merge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useResolveConflictsMutation(
  projectName: string,
  sessionName: string,
) {
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: (
      decisions: Array<{
        file: string;
        decision: string;
        feedback?: string;
      }>,
    ) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/resolve-conflicts`,
        "resolve-conflicts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisions }),
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
    },
  });
}
