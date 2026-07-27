/**
 * Runtime-replacement retry policy for conversation turns.
 *
 * Wraps a managed `ConversationBackendRuntime` so `sendTurn` applies the
 * undelivered-prompt recovery policy in-place: classify the thrown failure
 * via the backend descriptor's failure classifier, replace the dead runtime
 * (resume-preserving), and reattempt exactly once. Retry requires two
 * independent facts and neither substitutes for the other: the descriptor's
 * classifier must declare the failure `retryable` (its policy verdict — a
 * mid-turn death that may have side effects is non-retryable even on a dead
 * runtime), and the neutral prompt-not-delivered mark must be present (the
 * orthogonal double-delivery safety proof — the prompt never reached the
 * agent, so re-dispatch cannot duplicate it). The delivery mark is not a
 * substitute for the classifier's verdict: an adapter may mark an error the
 * classifier still refuses to retry, and that veto is honored.
 *
 * The wrapper also enforces the adapter turn-result continuation contract
 * (`turnContinuationSchema`): "clear" implies `backendRef: null`. A violating
 * result is normalized — the ref is dropped so a stale continuation can never
 * ride a "clear" disposition back into machine context — and logged loudly as
 * an adapter bug.
 */

import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import {
  isPromptNotDeliveredFailure,
  turnContinuationSchema,
  type AgentFailureClassification,
} from "@/lib/agent-backends/errors";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";

export interface RuntimeReplacementRetryDeps {
  /** Live runtime accessor — replacement swaps the underlying instance. */
  getRuntime(): ConversationBackendRuntime;
  /** Close + recreate the runtime (resume-preserving) and return it. */
  replaceRuntime(): Promise<ConversationBackendRuntime>;
  /** The backend descriptor's failure classifier (`descriptor.errors`). */
  classify(error: unknown): AgentFailureClassification;
  /** Turn abort signal; an aborted turn is never retried. */
  signal: AbortSignal;
  /**
   * Identity fields for structured logging. Scope arrives DISCRIMINATED rather
   * than as a session name: the caller's session name is the session-keyed
   * STORE key, which is the project sentinel for a project conversation, and
   * log fields are a public identity surface (R1.3). The project variant has no
   * field for the sentinel to occupy.
   */
  meta: {
    conversationId: string;
    scopeRef: ConversationScopeRef;
    backend: string;
  };
  /**
   * The turn's structured-log sink, injected rather than module-scoped so a
   * test can read what this policy actually emitted — the module-level file
   * sink has no seam, which is how the sentinel survived here (R1.3).
   */
  log: Logger;
}

/** Flat identity fields for one log line: scope leads, session name only at session scope. */
function logFields(
  meta: RuntimeReplacementRetryDeps["meta"],
): Record<string, unknown> {
  return {
    conversationId: meta.conversationId,
    backend: meta.backend,
    ...meta.scopeRef,
  };
}

/**
 * Pure retry decision: a single reattempt is allowed only for the first
 * failure of a turn whose prompt verifiably never reached the agent
 * (the neutral delivery-safety mark), on a runtime that is already dead,
 * when the turn was not aborted — and only when the backend descriptor's
 * classifier declares the failure retryable.
 *
 * Both facts are required and neither substitutes for the other. `retryable`
 * is the descriptor's policy verdict (a mid-turn death that may have produced
 * side effects is non-retryable even though the runtime is dead); the delivery
 * mark is the orthogonal double-delivery safety proof (the prompt provably
 * never reached the agent, so re-dispatch cannot duplicate it). A resend is
 * legal only when the descriptor permits retry AND the prompt is proven
 * undelivered.
 */
export function shouldReplaceRuntimeAndRetry(input: {
  error: unknown;
  runtimeStatus: "alive" | "dead";
  aborted: boolean;
  attempt: number;
  retryable: boolean;
}): boolean {
  return (
    input.attempt === 0 &&
    input.retryable &&
    !input.aborted &&
    input.runtimeStatus === "dead" &&
    isPromptNotDeliveredFailure(input.error)
  );
}

function enforceContinuationConsistency(
  result: ConversationBackendTurnResult,
  deps: Pick<RuntimeReplacementRetryDeps, "meta" | "log">,
): ConversationBackendTurnResult {
  const check = turnContinuationSchema.safeParse({
    backendRef: result.backendRef,
    continuationDisposition: result.continuationDisposition,
  });
  if (check.success) return result;
  deps.log.error("prompt.continuation_pair_contradiction", {
    ...logFields(deps.meta),
    backendRef: result.backendRef,
    continuationDisposition: result.continuationDisposition,
  });
  return { ...result, backendRef: null };
}

/**
 * Named replacement for the actor's former `Proxy`-based retry: returns a
 * `ConversationBackendRuntime` view that delegates every member to the LIVE
 * runtime (so a mid-turn replacement is transparent to the caller) and runs
 * the retry policy inside `sendTurn`.
 */
export function withRuntimeReplacementRetry(
  deps: RuntimeReplacementRetryDeps,
): ConversationBackendRuntime {
  async function sendTurnWithRetry(
    turnInput: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    let attempt = 0;
    let current = deps.getRuntime();
    while (true) {
      try {
        return enforceContinuationConsistency(
          await current.sendTurn(turnInput),
          deps,
        );
      } catch (err) {
        const classification = deps.classify(err);
        if (
          !shouldReplaceRuntimeAndRetry({
            error: err,
            runtimeStatus: current.status,
            aborted: deps.signal.aborted,
            attempt,
            retryable: classification.retryable,
          })
        ) {
          throw err;
        }
        attempt += 1;
        deps.log.warn("prompt.runtime_retry", {
          ...logFields(deps.meta),
          attempt,
          failureKind: classification.kind,
          error: classification.message,
        });
        current = await deps.replaceRuntime();
      }
    }
  }

  const live = deps.getRuntime;
  return {
    get backend() {
      return live().backend;
    },
    get status() {
      return live().status;
    },
    get isTurnActive() {
      return live().isTurnActive;
    },
    get modelId() {
      return live().modelId;
    },
    get reasoningEffort() {
      return live().reasoningEffort;
    },
    get outputFormat() {
      return live().outputFormat;
    },
    get alignmentVersion() {
      return live().alignmentVersion;
    },
    sendTurn: sendTurnWithRetry,
    notifyTurnStarting: () => live().notifyTurnStarting?.(),
    prepareForTurnStart: async () =>
      (await live().prepareForTurnStart?.()) ?? { status: "ready" as const },
    queueUserInput: async (input) => {
      const target = live().queueUserInput;
      if (!target) {
        throw new Error(
          `Runtime for backend "${live().backend}" does not support queueUserInput`,
        );
      }
      return target.call(live(), input);
    },
    applyPortableMcpConfig: async (config) => {
      const target = live().applyPortableMcpConfig;
      if (!target) {
        return {
          disposition: "unsupported" as const,
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        };
      }
      return target.call(live(), config);
    },
    supportedCommands: async () => (await live().supportedCommands?.()) ?? [],
    supportedAgents: async () => (await live().supportedAgents?.()) ?? [],
    listMcpServerTools: async (serverKey) =>
      live().listMcpServerTools?.(serverKey),
    close: () => live().close(),
  };
}
