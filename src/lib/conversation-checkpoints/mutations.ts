/**
 * Checkpoint mutations a client may issue: start, skip handoff, cancel an
 * owned build, and reconcile an owned repair. Every one of them is a request
 * the SERVER owns from the moment it is admitted, so none of them carries the
 * operation's outcome — they seed the receipt caches and the progress query
 * takes over (design §8).
 *
 * No optimistic checkpoint row exists here on purpose. An admission can be
 * refused for a dozen typed reasons the client cannot predict, and a
 * placeholder operation would claim a durable ordinal the server may never
 * issue. The triggering controls therefore carry a visible pending state
 * (data-fetching-and-sse.md rung 3) and the truth arrives with the 202.
 *
 * `requestId` is minted once per invocation and is the operation's identity:
 * one activation of the action is one operation, and a second click after a
 * network error opens a new one rather than silently rejoining a build the
 * server may already have refused.
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";

import { ApiCallError } from "@/lib/api/errors";

import { checkpointRefusalSchema, type CheckpointRefusal } from "./admission";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import { checkpointsBaseUrl, checkpointUrl } from "./queries";
import { checkpointReceiptSchema, type CheckpointReceipt } from "./receipt";
import type {
  StartCheckpointRequest,
  ReconcileCheckpointRequest,
} from "./schemas";
import { publishCheckpointReceipt } from "./sse-cache";

export const startCheckpointResponseSchema = z.object({
  outcome: z.enum(["admitted", "reused"]),
  receipt: checkpointReceiptSchema,
  /** Where the operation's durable state is read; already resolvable at 202. */
  statusUrl: z.string().min(1),
});
export type StartCheckpointResponse = z.infer<
  typeof startCheckpointResponseSchema
>;

export const cancelCheckpointResponseSchema = z.object({
  outcome: z.enum(["cancelled", "completed"]),
  receipt: checkpointReceiptSchema,
});

export const reconcileCheckpointResponseSchema = z.object({
  outcome: z.enum(["repaired", "unchanged"]),
  receipt: checkpointReceiptSchema,
});

export interface StartCheckpointVariables {
  handoff?: StartCheckpointRequest["handoff"];
  /**
   * Explicit recovery: the recovery-required operation this build supersedes.
   * Absent for an ordinary checkpoint, which cannot supersede anything.
   */
  recoversOperationId?: string;
}

function settle(
  queryClient: QueryClient,
  target: CheckpointTarget,
  receipt: CheckpointReceipt,
): void {
  publishCheckpointReceipt(queryClient, target, receipt);
}

/**
 * The typed refusal a failed request carried, or null when the failure was not
 * a checkpoint refusal at all (a dropped connection, a 500). Reading it from
 * the error rather than re-deriving it from cached eligibility is what lets a
 * client that lost a race report the reason the server actually gave.
 */
export function checkpointRefusalFromError(
  error: unknown,
): CheckpointRefusal | null {
  if (!(error instanceof ApiCallError) || error.details === undefined) {
    return null;
  }
  const parsed = checkpointRefusalSchema.safeParse(error.details["refusal"]);
  return parsed.success ? parsed.data : null;
}

/**
 * Refresh eligibility after a request that may have changed it.
 *
 * A typed refusal is deliberately NOT such a request. The refusal is itself
 * the server's newest word on these predicates, so re-reading eligibility here
 * would immediately produce a competing answer of the same age and leave the
 * surfaces unable to say which one is current. Anything else — a success that
 * took the slot, a dropped connection that left it unknown — does warrant the
 * read.
 */
function refreshEligibilityUnlessRefused(
  queryClient: QueryClient,
  target: CheckpointTarget,
  error: unknown,
): void {
  if (checkpointRefusalFromError(error) !== null) return;
  void queryClient.invalidateQueries({
    queryKey: checkpointKeys.eligibility(target),
  });
}

export function useStartCheckpointMutation(target: CheckpointTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: StartCheckpointVariables = {}) =>
      mutationFetch(
        checkpointsBaseUrl(target),
        "start-conversation-checkpoint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            ...(variables.handoff === undefined
              ? {}
              : { handoff: variables.handoff }),
            ...(variables.recoversOperationId === undefined
              ? {}
              : { recoversOperationId: variables.recoversOperationId }),
          } satisfies StartCheckpointRequest),
        },
        startCheckpointResponseSchema,
      ),
    onSuccess: (data) => {
      settle(queryClient, target, data.receipt);
    },
    onSettled: (_data, error) => {
      refreshEligibilityUnlessRefused(queryClient, target, error);
    },
  });
}

export interface CheckpointOperationVariables {
  operationId: string;
}

export function useCancelCheckpointMutation(target: CheckpointTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: CheckpointOperationVariables) =>
      mutationFetch(
        `${checkpointUrl(target, variables.operationId)}/cancel`,
        "cancel-conversation-checkpoint",
        { method: "POST" },
        cancelCheckpointResponseSchema,
      ),
    onSuccess: (data) => {
      settle(queryClient, target, data.receipt);
    },
    onSettled: (_data, error) => {
      refreshEligibilityUnlessRefused(queryClient, target, error);
    },
  });
}

export interface ReconcileCheckpointVariables extends CheckpointOperationVariables {
  captureExecutionStopped?: ReconcileCheckpointRequest["captureExecutionStopped"];
}

export function useReconcileCheckpointMutation(target: CheckpointTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: ReconcileCheckpointVariables) =>
      mutationFetch(
        `${checkpointUrl(target, variables.operationId)}/reconcile`,
        "reconcile-conversation-checkpoint",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(variables.captureExecutionStopped === undefined
              ? {}
              : { captureExecutionStopped: variables.captureExecutionStopped }),
            source: "ui",
          } satisfies ReconcileCheckpointRequest),
        },
        reconcileCheckpointResponseSchema,
      ),
    onSuccess: (data) => {
      settle(queryClient, target, data.receipt);
    },
    onError: (error, variables) => {
      if (!(error instanceof ApiCallError)) return;
      const parsed = checkpointReceiptSchema.safeParse(
        error.details?.["receipt"],
      );
      if (
        parsed.success &&
        parsed.data.scope === target.scope &&
        parsed.data.conversationId === target.conversationId &&
        parsed.data.operationId === variables.operationId
      ) {
        settle(queryClient, target, parsed.data);
      }
    },
    onSettled: (_data, error, variables) => {
      refreshOperation(queryClient, target, variables.operationId);
      refreshEligibilityUnlessRefused(queryClient, target, error);
    },
  });
}

export const skipCheckpointHandoffResponseSchema = z.object({
  outcome: z.enum(["stopping", "handoff_already_settled"]),
  receipt: checkpointReceiptSchema,
});

function refreshOperation(
  queryClient: QueryClient,
  target: CheckpointTarget,
  operationId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: checkpointKeys.detail(target, operationId),
  });
  void queryClient.invalidateQueries({
    queryKey: checkpointKeys.lists(target),
  });
}

export function useSkipCheckpointHandoffMutation(target: CheckpointTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: CheckpointOperationVariables) =>
      mutationFetch(
        `${checkpointUrl(target, variables.operationId)}/skip-handoff`,
        "skip-checkpoint-handoff",
        { method: "POST" },
        skipCheckpointHandoffResponseSchema,
      ),
    onSuccess: (data) => settle(queryClient, target, data.receipt),
    onSettled: (_data, error, variables) => {
      refreshOperation(queryClient, target, variables.operationId);
      refreshEligibilityUnlessRefused(queryClient, target, error);
    },
  });
}
