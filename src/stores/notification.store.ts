import { useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { BackgroundJob, JobStatusEvent } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationState {
  jobs: Map<string, BackgroundJob>;
  toastQueue: JobStatusEvent[];
}

interface NotificationActions {
  addOrUpdateJob: (event: JobStatusEvent) => void;
  dismissToast: () => void;
}

type NotificationStore = NotificationState & NotificationActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useNotificationStore = create<NotificationStore>()(
  immer((set) => ({
    jobs: new Map<string, BackgroundJob>(),
    toastQueue: [],

    addOrUpdateJob: (event: JobStatusEvent) =>
      set((state) => {
        const now = new Date().toISOString();
        const existing = state.jobs.get(event.jobId);

        const job: BackgroundJob = {
          jobId: event.jobId,
          jobType: event.jobType,
          status: event.status,
          projectName: event.projectName,
          sessionName: event.sessionName,
          branchName: event.branchName,
          startedAt: existing?.startedAt ?? now,
          completedAt:
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "conflicts"
              ? now
              : existing?.completedAt,
          mergeHash: event.mergeHash ?? existing?.mergeHash,
          commitHash: event.commitHash ?? existing?.commitHash,
          conflictCount: event.conflictCount ?? existing?.conflictCount,
          conflictFiles: event.conflictFiles ?? existing?.conflictFiles,
          errorMessage: event.errorMessage ?? existing?.errorMessage,
        };

        state.jobs.set(event.jobId, job);

        // Push terminal events to the toast queue
        if (
          event.status === "completed" ||
          event.status === "failed" ||
          event.status === "conflicts"
        ) {
          state.toastQueue.push(event);
        }
      }),

    dismissToast: () =>
      set((state) => {
        state.toastQueue.shift();
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useNotificationJobs = () => useNotificationStore((s) => s.jobs);
export const useNotificationToastQueue = () =>
  useNotificationStore((s) => s.toastQueue);
export const useActiveJobs = () => {
  const jobs = useNotificationStore((s) => s.jobs);
  return useMemo(
    () =>
      Array.from(jobs.values()).filter(
        (j) => j.status === "running" || j.status === "conflicts",
      ),
    [jobs],
  );
};
export const useJobsBySession = (projectName: string, sessionName: string) => {
  const jobs = useNotificationStore((s) => s.jobs);
  return useMemo(
    () =>
      Array.from(jobs.values()).filter(
        (j) => j.projectName === projectName && j.sessionName === sessionName,
      ),
    [jobs, projectName, sessionName],
  );
};

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useAddOrUpdateJob = () =>
  useNotificationStore((s) => s.addOrUpdateJob);
export const useDismissToast = () =>
  useNotificationStore((s) => s.dismissToast);
