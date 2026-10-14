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

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Pause, resume (with halt dispositions), cancel or retry a lane, as a
 * person. The run travels with each request, so one sent for a run stays
 * that run's however the page's selection moves before it settles.
 */
export function useRunControlMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["runs", projectName, sessionName, "control"],
    mutationFn: ({
      runId,
      control,
    }: {
      runId: string;
      control: RunControlRequest;
    }) =>
      mutationFetch(
        `${runUrl(projectName, sessionName, runId)}/control`,
        "runs.control",
        json(control),
        runControlResponseSchema,
      ),
    onSettled: (_data, _error, { runId }) =>
      refreshRun(queryClient, { projectName, sessionName, runId }),
  });
}

/** Approve or send back a result awaiting a person's decision. */
export function useRunDecisionMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["runs", projectName, sessionName, "decide"],
    mutationFn: ({
      runId,
      decision,
    }: {
      runId: string;
      decision: RunDecisionRequest;
    }) =>
      mutationFetch(
        `${runUrl(projectName, sessionName, runId)}/decide`,
        "runs.decide",
        json(decision),
        runDecisionResponseSchema,
      ),
    onSettled: (_data, _error, { runId }) =>
      refreshRun(queryClient, { projectName, sessionName, runId }),
  });
}
