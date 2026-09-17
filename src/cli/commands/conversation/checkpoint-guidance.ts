import { invocation } from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import { checkpointRefusalSchema } from "@/lib/conversation-checkpoints/admission";
import {
  checkpointCheckCommand,
  checkpointGetCommand,
  checkpointListCommand,
  checkpointReconcileCommand,
  compactCommand,
  compactContextCommand,
} from "./definitions";
import { scopeFlags, type NativeTarget } from "./native-target";
import type { CcFailedRequest } from "../../framework/request";

const refusalDetails = z.object({ refusal: checkpointRefusalSchema });
export function checkpointRefusal(response: CcFailedRequest) {
  const parsed =
    response.kind === "error"
      ? refusalDetails.safeParse(response.details)
      : null;
  return parsed?.success ? parsed.data.refusal : null;
}

const rationales: Readonly<Partial<Record<string, string>>> = {
  queue_review_required:
    "a queued delivery may or may not have reached the provider, and CC never replays uncertain input automatically",
  recovery_required:
    "an operation whose outcome is unresolved is superseded explicitly, never continued in place",
  recovery_target_mismatch:
    "recovery addresses one named operation, so a mismatched id is refused rather than applied to whichever operation is active",
  conversation_owned:
    "a workflow or collaboration owns this conversation's turns, and a checkpoint would retire context it is mid-way through using",
  not_cancellable:
    "the operation already retired the conversation's context, and cancelling cannot restore a provider session",
};
export function checkpointRationale(code: string): string | undefined {
  return rationales[code];
}

export function checkpointAdvice(
  target: NativeTarget,
  code: string,
  operationId: string | null,
) {
  const args = { "conversation-id": target.target.conversationId };
  const flags = scopeFlags(target);
  if (code === "backend_unsupported")
    return hint(
      invocation(compactCommand, { args, flags }),
      "This backend has no checkpoint capability; generate a reading artifact instead",
    );
  if (
    ["recovery_required", "queue_review_required"].includes(code) &&
    operationId
  )
    return hint(
      invocation(compactContextCommand, {
        args,
        flags: { ...flags, recover: operationId },
      }),
      code === "queue_review_required"
        ? "Resolve uncertain queued messages in Command Center, then supersede this checkpoint explicitly"
        : "Supersede this unresolved checkpoint explicitly",
    );
  if (code === "reconciliation_failed" && operationId)
    return hint(
      invocation(checkpointReconcileCommand, {
        args: { ...args, "operation-id": operationId },
        flags,
      }),
      "Retry deterministic checkpoint repair",
    );
  if (
    [
      "turn_active",
      "background_work",
      "conversation_busy",
      "question_pending",
      "debug_mode",
      "conversation_archived",
    ].includes(code)
  )
    return hint(
      invocation(checkpointCheckCommand, { args, flags }),
      "Resolve the blocking conversation state, then check checkpoint admission again",
    );
  return operationId
    ? hint(
        invocation(checkpointGetCommand, {
          args: { ...args, "operation-id": operationId },
          flags,
        }),
        "Inspect this checkpoint's current receipt",
      )
    : hint(
        invocation(checkpointListCommand, { args, flags }),
        "Inspect the conversation's checkpoint operations",
      );
}
