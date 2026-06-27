import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { alignmentKeys } from "./query-keys";
import {
  alignmentVersionSchema,
  type ApproveDraftRequest,
  type RejectDraftRequest,
  type ResolveProposalsRequest,
  type RollbackRequest,
} from "./schemas";

const rejectResponseSchema = z.object({ ok: z.boolean() });
const resolveResponseSchema = z.object({
  approved: z.number().int(),
  rejected: z.number().int(),
});

function alignmentBasePath(projectName: string, sessionName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/alignment`;
}

export function useApproveCharterMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: ApproveDraftRequest) =>
      mutationFetch(
        `${alignmentBasePath(projectName, sessionName)}/charter/approve`,
        "alignment-charter-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
        alignmentVersionSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: alignmentKeys.state(projectName, sessionName),
      });
    },
  });
}

export function useRejectCharterMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: RejectDraftRequest) =>
      mutationFetch(
        `${alignmentBasePath(projectName, sessionName)}/charter/reject`,
        "alignment-charter-reject",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
        rejectResponseSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: alignmentKeys.state(projectName, sessionName),
      });
    },
  });
}

export function useResolveDecisionsMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: ResolveProposalsRequest) =>
      mutationFetch(
        `${alignmentBasePath(projectName, sessionName)}/decisions/resolve`,
        "alignment-decisions-resolve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
        resolveResponseSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: alignmentKeys.state(projectName, sessionName),
      });
    },
  });
}

export function useRollbackAlignmentMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: RollbackRequest) =>
      mutationFetch(
        `${alignmentBasePath(projectName, sessionName)}/rollback`,
        "alignment-rollback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
        alignmentVersionSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: alignmentKeys.state(projectName, sessionName),
      });
    },
  });
}
