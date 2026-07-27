import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";

import {
  registerPendingSpecOverlay,
  releasePendingSpecOverlay,
  type PendingSpecOverlayRegistration,
} from "./pending-overlay";
import { specKeys } from "./query-keys";
import { replayDeferredSpecEvents } from "./sse-reducer";
import {
  specRevisionSchema,
  specSchema,
  type SpecSseEventType,
} from "./schemas";

export const authoringSpecResultSchema = z
  .object({
    spec: specSchema,
    draft: specRevisionSchema,
    reused: z.boolean(),
  })
  .strict();
export type AuthoringSpecResultView = z.infer<typeof authoringSpecResultSchema>;

export const SPEC_PROJECT_ACTIONS = [
  "create",
  "promote-conversation",
  "graduate-ticket",
] as const;
export type SpecProjectAction = (typeof SPEC_PROJECT_ACTIONS)[number];

export const SPEC_ACTIONS = [
  "draft-upsert",
  "draft-reorder",
  "draft-remove",
  "open-amendment",
  "propose",
  "comment",
  "resolve-thread",
  "request-changes",
  "approve-item",
  "unapprove-item",
  "sign-off",
  "grant-gate-approval",
  "approve-execution-start",
  "withdraw",
  "bulk-approve",
  "open-question",
  "answer-question",
  "propose-assumption",
  "dispose-assumption",
  "change-policy",
  "claim-task-complete",
  "reopen-claim",
  "request-waiver",
  "grant-waiver",
  "mark-waiver-stale",
  "set-disposition",
  "start-execution",
  "abandon-execution",
  "abandon-spec",
  "rename",
  "capture-scope-amendment",
  "materialize-tasks",
  "link-ticket",
  "verify",
] as const;
export type SpecAction = (typeof SPEC_ACTIONS)[number];

export const specMutationPaths = {
  projectAction(projectName: string, action: SpecProjectAction): string {
    return `/api/specs/${encodeURIComponent(projectName)}/actions/${action}`;
  },
  specAction(projectName: string, slug: string, action: SpecAction): string {
    return `/api/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}/actions/${action}`;
  },
} as const;

function postJson<TBody>(body: TBody): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function useSpecProjectActionMutation<TBody, TResult>(
  projectName: string,
  action: SpecProjectAction,
  responseSchema: z.ZodType<TResult>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: TBody) =>
      mutationFetch(
        specMutationPaths.projectAction(projectName, action),
        `spec-${action}`,
        postJson(body),
        responseSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: specKeys.list(projectName),
      });
    },
  });
}

export function useSpecActionMutation<TBody, TResult>(
  projectName: string,
  slug: string,
  action: SpecAction,
  responseSchema: z.ZodType<TResult>,
  overlay?: { specId: string; eventTypes: readonly SpecSseEventType[] },
) {
  const queryClient = useQueryClient();

  return useMutation<
    TResult,
    Error,
    TBody,
    PendingSpecOverlayRegistration | null
  >({
    mutationFn: (body: TBody) =>
      mutationFetch(
        specMutationPaths.specAction(projectName, slug, action),
        `spec-${action}`,
        postJson(body),
        responseSchema,
      ),
    onMutate: () =>
      overlay === undefined
        ? null
        : registerPendingSpecOverlay(
            queryClient,
            overlay.specId,
            overlay.eventTypes,
          ),
    onSettled: (_data, _error, _body, registration) => {
      if (registration !== null && registration !== undefined) {
        replayDeferredSpecEvents(
          queryClient,
          releasePendingSpecOverlay(queryClient, registration),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: specKeys.detail(projectName, slug),
      });
      void queryClient.invalidateQueries({
        queryKey: specKeys.list(projectName),
      });
    },
  });
}
