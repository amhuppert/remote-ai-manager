/**
 * Run mutations: a person steers a run and decides its approvals from the
 * page. The outcome is the engine's to decide (a pause drains admitted work,
 * a resume may be refused), so each control shows `isPending` where the person
 * acted and the run's caches are refreshed on settle; the run-changed event
 * refreshes them again once the engine moves.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { refreshRun } from "./cache";
import {
  runControlResponseSchema,
  runDecisionResponseSchema,
  type RunControlRequest,
  type RunDecisionRequest,
} from "./schemas";

function runUrl(projectName: string, sessionName: string, runId: string) {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/runs/${encodeURIComponent(runId)}`;
}

function useRefreshRun(
  projectName: string,
  sessionName: string,
  runId: string,
) {
  const queryClient = useQueryClient();
  return () => refreshRun(queryClient, { projectName, sessionName, runId });
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Pause, resume (with halt dispositions), cancel or retry a lane, as a person. */
export function useRunControlMutation(
  projectName: string,
  sessionName: string,
  runId: string,
) {
  const refresh = useRefreshRun(projectName, sessionName, runId);
  return useMutation({
    mutationFn: (control: RunControlRequest) =>
      mutationFetch(
        `${runUrl(projectName, sessionName, runId)}/control`,
        "runs.control",
        json(control),
        runControlResponseSchema,
      ),
    onSettled: refresh,
  });
}

/** Approve or send back a result awaiting a person's decision. */
export function useRunDecisionMutation(
  projectName: string,
  sessionName: string,
  runId: string,
) {
  const refresh = useRefreshRun(projectName, sessionName, runId);
  return useMutation({
    mutationFn: (decision: RunDecisionRequest) =>
      mutationFetch(
        `${runUrl(projectName, sessionName, runId)}/decide`,
        "runs.decide",
        json(decision),
        runDecisionResponseSchema,
      ),
    onSettled: refresh,
  });
}
