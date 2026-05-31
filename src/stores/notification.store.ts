import { useMemo } from "react";
import { enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { BackgroundJob, JobStatusEvent } from "@/lib/jobs/schemas";
import type { Notification } from "@/lib/notifications/schemas";
enableMapSet();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InputNeededItem {
  projectName: string;
  sessionName: string;
  conversationId: string;
}

export interface PromptErrorItem {
  projectName: string;
  sessionName: string;
  conversationId: string;
  error: string;
}

interface NotificationState {
  /** Running jobs only — removed on terminal state */
  jobs: Map<string, BackgroundJob>;
  /** Toast queue fed exclusively by notification-created SSE events */
  toastQueue: Notification[];
  /** Toast queue for "waiting for input" conversation events */
  inputToastQueue: InputNeededItem[];
  /** Toast queue for prompt execution errors */
  promptErrorQueue: PromptErrorItem[];
}

interface NotificationActions {
  addOrUpdateJob: (event: JobStatusEvent) => void;
  /** Replace the jobs map with the server's authoritative list of active jobs.
   *  Removes stale client-side "running" entries missed by SSE. */
  reconcileJobs: (serverJobs: BackgroundJob[]) => void;
  enqueueToast: (notification: Notification) => void;
  dismissToast: () => void;
  enqueueInputToast: (item: InputNeededItem) => void;
  dismissInputToast: () => void;
  enqueuePromptErrorToast: (item: PromptErrorItem) => void;
  dismissPromptErrorToast: () => void;
}

type NotificationStore = NotificationState & NotificationActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useNotificationStore = create<NotificationStore>()(
  immer((set) => ({
    jobs: new Map<string, BackgroundJob>(),
    toastQueue: [],
    inputToastQueue: [],
    promptErrorQueue: [],

    addOrUpdateJob: (event: JobStatusEvent) =>
      set((state) => {
        // A session can only have one merge operation at a time (single-flight
        // lock). When a new merge jobId shows up for a session, drop any prior
        // merge job in the same session — including a stale ready-to-land —
        // so Land/Discard don't leave the parked entry visible in the topbar.
        if (event.jobType === "merge") {
          for (const [id, j] of state.jobs) {
            if (
              j.jobType === "merge" &&
              j.projectName === event.projectName &&
              j.sessionName === event.sessionName &&
              id !== event.jobId
            ) {
              state.jobs.delete(id);
            }
          }
        }

        const isTerminalNonActionable =
          event.status === "completed" ||
          event.status === "failed" ||
          event.status === "conflicts" ||
          event.status === "discarded";

        if (isTerminalNonActionable) {
          // Terminal non-actionable: remove from running jobs map.
          // Toast display is handled by notification-created events, not here.
          state.jobs.delete(event.jobId);
          return;
        }

        // Running or ready-to-land (actionable terminal): upsert into jobs map
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
          phase: event.phase,
          preparedSha: event.preparedSha,
          parkedRef: event.parkedRef,
          refreshWarning: event.refreshWarning,
        };

        state.jobs.set(event.jobId, job);
      }),

    reconcileJobs: (serverJobs: BackgroundJob[]) =>
      set((state) => {
        const serverMap = new Map(serverJobs.map((j) => [j.jobId, j]));
        // Replace the entire jobs map with server-authoritative data
        state.jobs.clear();
        for (const [id, job] of serverMap) {
          if (job.status === "running" || job.status === "ready-to-land") {
            state.jobs.set(id, job);
          }
        }
      }),

    enqueueToast: (notification: Notification) =>
      set((state) => {
        state.toastQueue.push(notification);
      }),

    dismissToast: () =>
      set((state) => {
        state.toastQueue.shift();
      }),

    enqueueInputToast: (item: InputNeededItem) =>
      set((state) => {
        state.inputToastQueue.push(item);
      }),

    dismissInputToast: () =>
      set((state) => {
        state.inputToastQueue.shift();
      }),

    enqueuePromptErrorToast: (item: PromptErrorItem) =>
      set((state) => {
        state.promptErrorQueue.push(item);
      }),

    dismissPromptErrorToast: () =>
      set((state) => {
        state.promptErrorQueue.shift();
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
        (j) =>
          j.status === "running" ||
          j.status === "conflicts" ||
          j.status === "ready-to-land",
      ),
    [jobs],
  );
};

export const useJobsBySession = (projectName: string, sessionName: string) => {
  const jobs = useNotificationStore((s) => s.jobs);
  return useMemo(
    () =>
      Array.from(jobs.values()).filter(
        (j) =>
          j.projectName === projectName &&
          j.sessionName === sessionName &&
          (j.status === "running" ||
            j.status === "conflicts" ||
            j.status === "ready-to-land"),
      ),
    [jobs, projectName, sessionName],
  );
};

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useAddOrUpdateJob = () =>
  useNotificationStore((s) => s.addOrUpdateJob);
export const useReconcileJobs = () =>
  useNotificationStore((s) => s.reconcileJobs);
export const useEnqueueToast = () =>
  useNotificationStore((s) => s.enqueueToast);
export const useDismissToast = () =>
  useNotificationStore((s) => s.dismissToast);
export const useEnqueueInputToast = () =>
  useNotificationStore((s) => s.enqueueInputToast);
export const useDismissInputToast = () =>
  useNotificationStore((s) => s.dismissInputToast);
export const useInputToastQueue = () =>
  useNotificationStore((s) => s.inputToastQueue);
export const useEnqueuePromptErrorToast = () =>
  useNotificationStore((s) => s.enqueuePromptErrorToast);
export const useDismissPromptErrorToast = () =>
  useNotificationStore((s) => s.dismissPromptErrorToast);
export const usePromptErrorQueue = () =>
  useNotificationStore((s) => s.promptErrorQueue);
