import {
  abandonGraphWorkflowExecutionForSession,
  abortGraphWorkflowExecutionForSession,
  locateGraphWorkflowExecution,
} from "@/lib/workflow-graph/execution-route-handlers";
import type { SpecWorkflowCleanupPort } from "./execution-service";

/**
 * The production spec→graph-workflow cleanup port: the forward half of the
 * handoff whose reverse half is the `executionAborted` lifecycle callback.
 *
 * Shared by both compositions that run the abandon coordinator (the
 * `abandon-execution` route path in `service-factory`, and the reverse-hook
 * path in `production-workflow-composition`) so the two can never drift into
 * disagreeing about what counts as a completed cleanup phase.
 *
 * Every adapter reports honestly whether its act took effect. A seam that
 * did nothing — because the pinned run no longer holds the session's execution
 * lease — returns `ok: false` with the reason, and the coordinator parks rather
 * than writing a phase-completed audit event over a no-op.
 */
export function createProductionSpecWorkflowCleanupPort(): SpecWorkflowCleanupPort {
  return {
    observe: (target) => locateGraphWorkflowExecution(target),
    async abort(target) {
      const aborted = await abortGraphWorkflowExecutionForSession(target);
      return aborted === null
        ? {
            ok: false,
            reason: `execution ${target.workflowExecutionId} no longer owns this session's execution slot, so there was nothing to abort`,
          }
        : { ok: true };
    },
    async abandon(target) {
      const outcome = await abandonGraphWorkflowExecutionForSession(target);
      // The act's own refusal reason, forwarded verbatim: the coordinator parks
      // on it rather than writing a phase-completed audit over a run the
      // audited seam declined to end.
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
  };
}
