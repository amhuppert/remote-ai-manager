/**
 * Why a collaboration run failed, and whether the user may resume it.
 *
 * `failRun` records a cause rather than only a message string, because the
 * resume affordance is a claim about the future: offering Resume on a failure
 * that will deterministically recur wastes the user's time and money. The two
 * classes answer different questions than the backend's own `retryable` flag
 * does — see `collaborationFailureClass`.
 */

import { z } from "zod";
import { normalizedAgentCallFailureKindSchema } from "@/lib/workflows/primitives/agent-call-vocabulary";

export const collaborationFailureCauseSchema = z.discriminatedUnion("kind", [
  /** A backend call failed. Carries the classifier's own verdict for display;
   *  the resume class is decided independently (see below). */
  z.object({
    kind: z.literal("agent_call"),
    failureKind: normalizedAgentCallFailureKindSchema,
    retryable: z.boolean().optional(),
    retryAfterHint: z.string().optional(),
  }),
  /** The model's structured output could not be parsed, or the orchestrator's
   *  injected envelope failed its own invariant. */
  z.object({ kind: z.literal("structured_output") }),
  /** A generated markdown artifact was missing, unreadable, or invalid. */
  z.object({ kind: z.literal("artifact_files") }),
  /** The server restarted while the run was in flight. */
  z.object({ kind: z.literal("process_restart") }),
  /** The slice or its manager threw. */
  z.object({ kind: z.literal("unhandled") }),
  /** Agent One's resolution decision chose `fail`. */
  z.object({ kind: z.literal("policy_fail") }),
  /** The recorded artifact stream cannot be trusted to replay. */
  z.object({ kind: z.literal("ledger_unusable"), code: z.string().min(1) }),
  /** The envelope does not carry the premises a resumed run would need. */
  z.object({ kind: z.literal("missing_premise"), detail: z.string().min(1) }),
  /** The user stopped the run. Not a failure; never resumable. */
  z.object({ kind: z.literal("user_stopped") }),
]);
export type CollaborationFailureCause = z.infer<
  typeof collaborationFailureCauseSchema
>;

export const collaborationFailureClassSchema = z.enum([
  "operational",
  "terminal",
]);
export type CollaborationFailureClass = z.infer<
  typeof collaborationFailureClassSchema
>;

/**
 * Whether the user may resume a run that failed for this cause.
 *
 * `operational` means the failure came from the environment — a provider
 * outage, a timeout, a quota wall, a restart — so the same run against a
 * healthy environment can still finish. `terminal` means replaying would
 * reach the same place: the peers decided to fail, or the run's own recorded
 * premises are unusable.
 *
 * Deliberately NOT derived from the backend's `retryable` flag. That flag
 * answers whether re-dispatching the call *right now* is safe, which is a
 * different question: a quota wall is `retryable: false` and is exactly the
 * case this feature exists to survive, because the user resumes later.
 */
export function collaborationFailureClass(
  cause: CollaborationFailureCause,
): CollaborationFailureClass {
  switch (cause.kind) {
    case "agent_call":
    case "structured_output":
    case "artifact_files":
    case "process_restart":
    case "unhandled":
      return "operational";
    case "policy_fail":
    case "ledger_unusable":
    case "missing_premise":
    case "user_stopped":
      return "terminal";
  }
}
