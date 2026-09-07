import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { ConversationBackendEvent } from "@/lib/agent-backends/conversation";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import { createLogger } from "@/lib/logging";
import type { ConversationEvent, PromptActorResult } from "./types";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("external-turn-handler");

export interface ExternalTurnHandlerIdentity {
  conversationId: string;
}

export interface ExternalTurnHandlerRuntime {
  isCurrent?(): boolean;
  sendToMachine(event: ConversationEvent): void;
}

export interface ExternalTurnHandlerDeps {
  safeAppendTranscriptEntry(
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void>;
  /** Clear delivery state when this external turn compacted backend context. */
  onBackendCompaction?(): Promise<void>;
  /**
   * Drain any `staged-idle` capability cascades when an external/background
   * turn finishes (running → idle). Optional: the actor wires it only for
   * backends declaring an `idle_live` capability kind. The caller-initiated
   * path drains via the conversation actor directly; external turns never run
   * through that actor and need their own hook on the running-to-idle
   * transition.
   */
  applyCapabilityWhenIdle?(): Promise<unknown>;
}

/**
 * Bridge a backend's external (background auto-continuation) turn events to
 * the conversation machine and the transcript. The adapter interprets its
 * native frames into neutral events before they arrive here; this handler
 * records `transcript_entry` envelopes verbatim and forwards the turn
 * lifecycle to the machine — it never reads a provider payload.
 */
export interface ExternalTurnHandler {
  (event: ConversationBackendEvent): void;
  drain(): Promise<void>;
  stopAndDrain(): Promise<void>;
}

export function createExternalTurnHandler(
  identity: ExternalTurnHandlerIdentity,
  runtime: ExternalTurnHandlerRuntime,
  deps: ExternalTurnHandlerDeps,
): ExternalTurnHandler {
  // One chain serializes every handler action — frame appends AND machine
  // sends — so frames land in the JSONL in emission order, machine completion
  // is observed only after all of the turn's frame appends settle, and a
  // following turn's start can never overtake a completion still waiting on
  // slow appends. The handler itself cannot await, so it queues.
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  const effects = new Set<Promise<unknown>>();

  const enqueue = (
    step: () => void | Promise<void>,
    failureEvent: string,
    context: Record<string, unknown> = {},
  ): void => {
    chain = chain
      .then(() => (runtime.isCurrent?.() === false ? undefined : step()))
      .catch((err) => {
        logger.warn(failureEvent, {
          conversationId: identity.conversationId,
          ...context,
          error: getErrorMessage(err),
        });
      });
  };

  const handle = (event: ConversationBackendEvent): void => {
    if (stopped || runtime.isCurrent?.() === false) return;
    switch (event.type) {
      case "external_turn_started": {
        enqueue(
          () => runtime.sendToMachine({ type: "EXTERNAL_TURN_STARTED" }),
          "external_turn.machine_send_failed",
          { machineEvent: "EXTERNAL_TURN_STARTED" },
        );
        return;
      }

      case "transcript_entry": {
        const frame = conversationTranscriptFrame(event.entry);
        enqueue(
          () => deps.safeAppendTranscriptEntry(identity.conversationId, frame),
          "external_turn.transcript_append_failed",
          { entryType: event.entry.type },
        );
        return;
      }

      case "external_turn_completed": {
        const result: PromptActorResult = {
          backendRef: event.result.backendRef,
          costUsd: event.result.costUsd,
          durationMs: event.result.durationMs,
          numTurns: event.result.numTurns,
          contextTokens: event.result.contextTokens,
          contextWindow: event.result.contextWindowMax,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: event.result.contentBlocks,
          structuredOutput: event.result.structuredOutput,
          aborted: event.result.aborted,
          compacted: event.result.compacted,
          error: event.result.failure?.message ?? null,
          continuationDisposition: event.result.continuationDisposition,
        };
        if (event.result.compacted && deps.onBackendCompaction) {
          enqueue(
            () => deps.onBackendCompaction?.(),
            "external_turn.compaction_handler_failed",
          );
        }
        enqueue(
          () => {
            runtime.sendToMachine({ type: "EXTERNAL_TURN_COMPLETED", result });
            // Fire-and-forget from the chain: the drain must start only after
            // the turn's appends settled and completion was sent, but a slow
            // capability apply must not delay the next turn's frames.
            if (deps.applyCapabilityWhenIdle) {
              const effect = deps.applyCapabilityWhenIdle().catch((err) => {
                logger.warn("external_turn.capability_idle_drain_failed", {
                  conversationId: identity.conversationId,
                  error: getErrorMessage(err),
                });
              });
              effects.add(effect);
              void effect.finally(() => effects.delete(effect));
            }
          },
          "external_turn.machine_send_failed",
          { machineEvent: "EXTERNAL_TURN_COMPLETED" },
        );
        return;
      }

      default:
        return;
    }
  };
  const drain = async () => {
    await chain;
    await Promise.allSettled(effects);
  };
  return Object.assign(handle, {
    drain,
    stopAndDrain: async () => {
      stopped = true;
      await drain();
    },
  });
}
