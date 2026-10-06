import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { BackendConversationTranscriptProjection } from "@/lib/agent-backends/descriptor";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import type { TranscriptBroadcastMeta, TranscriptEntry } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { TranscriptDependencies } from "@/lib/workflows/conversation/actor-dependencies";
import {
  classifyFailureForBackend,
  resolveFailureClassifierForBackend,
} from "@/lib/workflows/conversation/failure-classification";
import { wireTurnAbort } from "@/lib/workflows/conversation/pre-turn/abort-wiring";
import type { TurnExecutionOutcome, TurnInterruption } from "@/lib/workflows/conversation/turn-result";
import { withRuntimeReplacementRetry } from "@/lib/workflows/conversation/with-runtime-replacement-retry";
import type { executeAgentCall as ExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallRequest, AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import type { HostedConversation, RuntimeHost, RuntimeRequirements } from "./runtime-host";

export interface TurnEngineDeps {
  host: RuntimeHost;
  executeAgentCall: typeof ExecuteAgentCall;
  transcript: Pick<TranscriptDependencies, "safeAppendTranscriptEntry" | "safeAppendTranscriptEntryOnce">;
  projection(backend: AgentBackendId): BackendConversationTranscriptProjection;
  /** Safety-net timeout and inactivity bound for one backend invocation; 0 disables either. */
  timeouts(backend: AgentBackendId): Promise<{ timeoutMs: number; stallTimeoutMs: number }>;
  /** A turn could not verify its child processes stopped; the conversation stays blocked until collected. */
  onCleanupUnverified?(conversation: HostedConversation, message: string): void;
  /** The provider compacted the agent's context; per-turn deliveries keyed to it must start over. */
  onCompacted?(conversationId: string): Promise<void>;
  /** The backend accepted the input under the MCP and capability configuration the event names. */
  recordAccepted?(
    conversation: HostedConversation,
    event: Extract<ConversationBackendEvent, { type: "input_accepted" }>,
  ): Promise<void>;
  log: Logger;
}

export interface TurnRequest {
  conversation: HostedConversation;
  requirements: RuntimeRequirements;
  broadcast: TranscriptBroadcastMeta;
  /** What the agent receives. */
  promptText: string;
  /** The person's own words, when the prompt adds context around them. */
  userPromptText?: string;
  /** Per-turn context a backend may deliver apart from the user's words. */
  promptContext?: string;
  /** Whether the provider send happened, for receipts that must know. */
  observe?: { sending(): void; failed(error: unknown): void };
  /**
   * What the transcript records as the user's turn, at dispatch. Null when the
   * caller archives it itself once the backend accepts the input (a queued
   * delivery, whose queue owns the content until then).
   */
  userEntry: TranscriptEntry | null;
  /** Images the user's message carries, already saved with the transcript. */
  imageRefs?: readonly ConversationImageRef[];
  writeCapability: AgentCallRequest["writeCapability"];
  autonomous: boolean;
  waitForBackgroundTasks: boolean;
  outputFormat?: ConversationBackendTurnInput["outputFormat"];
  structuredOutputTurns?: AgentCallRequest["structuredOutputTurns"];
  onUserQuestion?: ConversationBackendTurnInput["onUserQuestion"];
  /** The backend announced the continuation this turn runs under; persist it before the turn ends. */
  onBackendInit?(ref: AgentSessionRef): Promise<void>;
  /** Additional observer of the backend's events, after the engine has recorded them. */
  onEvent?(event: ConversationBackendEvent): Promise<void> | void;
  signal: AbortSignal;
}

export interface TurnEngine {
  /** Runs one admitted turn to an outcome; never throws for a provider failure. */
  runTurn(request: TurnRequest): Promise<TurnExecutionOutcome>;
  /**
   * The conversation's runtime is working outside the turn's event stream (a
   * background task's progress): its running turn is not stalled.
   */
  notifyActivity(conversationId: string): void;
}

/**
 * One turn of a core-owned conversation: bind its runtime, record the user
 * turn, dispatch through AgentCall (work, format and one repair), record the
 * backend's events as transcript entries, and return the normalized outcome.
 * Settlement belongs to the caller; the engine owns no conversation state.
 */
export function createTurnEngine(deps: TurnEngineDeps): TurnEngine {
  /** Each conversation's running turn's watchdog, which activity outside its event stream refreshes too. */
  const watchdogs = new Map<string, () => void>();
  return {
    notifyActivity(conversationId) {
      watchdogs.get(conversationId)?.();
    },
    async runTurn(request) {
      const { conversation } = request;
      const conversationId = conversation.conversationId;
      const backend = conversation.backend;
      const scopeRef = scopeRefFromStoreSessionName(request.broadcast.storeSessionName);
      const projection = deps.projection(backend);
      const append = (entry: TranscriptEntry) =>
        deps.transcript.safeAppendTranscriptEntry(conversationId, entry, request.broadcast);
      const appendBackendEntry = (entry: TranscriptEntry) =>
        entry.id !== undefined
          ? deps.transcript.safeAppendTranscriptEntryOnce(conversationId, { ...entry, id: entry.id }, request.broadcast)
          : append(entry);

      const cancelledBeforeStart = (): TurnExecutionOutcome => ({
        kind: "not_started",
        reason: "cancelled",
        message: "The turn was cancelled before it started",
        ...(request.signal.reason === "shutdown" ? { interruption: { reason: "shutdown" as const } } : {}),
      });
      if (request.signal.aborted) return cancelledBeforeStart();
      let runtime: ConversationBackendRuntime;
      try {
        ({ runtime } = await deps.host.obtain(conversation, request.requirements));
      } catch (error) {
        deps.log.error("conversation_core.runtime_unavailable", {
          conversationId,
          backend,
          error: getErrorMessage(error),
        });
        return { kind: "not_started", reason: "configuration", message: getErrorMessage(error) };
      }

      let timeouts: { timeoutMs: number; stallTimeoutMs: number };
      try {
        timeouts = await deps.timeouts(backend);
      } catch (error) {
        deps.log.error("conversation_core.timeouts_unavailable", { conversationId, backend, error: getErrorMessage(error) });
        return { kind: "not_started", reason: "configuration", message: getErrorMessage(error) };
      }
      const { timeoutMs, stallTimeoutMs } = timeouts;
      const abortState: { abortController: AbortController; timeoutHandle?: ReturnType<typeof setTimeout> } = {
        abortController: new AbortController(),
      };
      const abort = wireTurnAbort({
        runtimeState: abortState,
        conversationId,
        sessionName: request.broadcast.storeSessionName,
        backend,
        timeoutMs,
        stallTimeoutMs,
      });
      // An adapter may ignore the signal mid-turn; closing the runtime is what
      // stops the provider. The next turn resumes from the persisted continuity.
      let closing: Promise<void> | null = null;
      abort.abortController.signal.addEventListener(
        "abort",
        () => {
          closing ??= deps.host.release(conversationId).catch((error: unknown) =>
            deps.log.error("conversation_core.abort_close_failed", {
              conversationId,
              backend,
              error: getErrorMessage(error),
            }),
          );
        },
        { once: true },
      );
      const cancel = () => abort.abortController.abort(request.signal.reason);
      request.signal.addEventListener("abort", cancel, { once: true });
      const touch = () => abort.notifyActivity();
      watchdogs.set(conversationId, touch);
      const stopListening = async (): Promise<void> => {
        if (watchdogs.get(conversationId) === touch) watchdogs.delete(conversationId);
        request.signal.removeEventListener("abort", cancel);
        abort.cleanup();
        if (closing !== null) await closing;
      };
      // A cancellation that arrived while the runtime was being obtained.
      if (request.signal.aborted) {
        cancel();
        await stopListening();
        return cancelledBeforeStart();
      }
      runtime.notifyTurnStarting?.();
      if (request.userEntry !== null) await append(request.userEntry);

      const contentBlocks: MessageContentBlock[] = [];
      let persistedContent = 0;
      let workRef: AgentSessionRef | null | undefined;
      const onEvent = async (event: ConversationBackendEvent): Promise<void> => {
        abort.notifyActivity();
        switch (event.type) {
          case "backend_init": {
            await request.onBackendInit?.(event.backendRef);
            const entry = projection.projectBackendInit({
              timestamp: new Date().toISOString(),
              backendRef: event.backendRef,
            });
            if (entry !== null) await appendBackendEntry(entry);
            break;
          }
          case "content":
            contentBlocks.push(event.block);
            if (projection.persistContentEvents) {
              await appendBackendEntry({
                timestamp: new Date().toISOString(),
                type: "assistant",
                role: "assistant",
                content: [event.block],
              });
              persistedContent += 1;
            }
            break;
          case "transcript_entry":
            await appendBackendEntry(conversationTranscriptFrame(event.entry));
            break;
          case "input_accepted":
            // The agent already has the input: a receipt that cannot be recorded must not cost the turn.
            await deps.recordAccepted?.(conversation, event).catch((error: unknown) =>
              deps.log.warn("conversation_core.application_receipt_failed", {
                conversationId,
                backend,
                error: getErrorMessage(error),
              }),
            );
            break;
          default:
            break;
        }
        await request.onEvent?.(event);
      };

      const retrying = withRuntimeReplacementRetry({
        getRuntime: () => runtime,
        async replaceRuntime() {
          // A format or repair call must resume the work this call completed.
          if (workRef === null) throw new Error("Cannot replace the runtime: the completed work has no continuation");
          runtime = await deps.host.replace(conversationId, workRef === undefined ? conversation.persistedRef : workRef);
          return runtime;
        },
        classify: (error) => classifyFailureForBackend(backend, error),
        signal: abort.abortController.signal,
        meta: { conversationId, scopeRef, backend },
        log: deps.log,
        observe: {
          sending: () => request.observe?.sending(),
          failed: (error) => request.observe?.failed(error),
          completed: (result) => {
            workRef = result.backendRef;
            // Unverified cleanup keeps the runtime's processes owned: no new runtime may
            // start beside them, and the operator must hear about it.
            if (result.cleanupFailure !== undefined && deps.host.recordCleanupFailure(conversationId, result.cleanupFailure)) {
              deps.log.error("conversation_core.cleanup_unverified", {
                conversationId,
                backend,
                message: result.cleanupFailure.message,
              });
              deps.onCleanupUnverified?.(conversation, result.cleanupFailure.message);
            }
          },
        },
      });

      const interruption = (): TurnInterruption | undefined =>
        abort.timeoutFired()
          ? { reason: "timeout", timeoutMs }
          : abort.stallFired()
            ? { reason: "stalled", timeoutMs: stallTimeoutMs }
            : request.signal.aborted
              ? { reason: request.signal.reason === "shutdown" ? "shutdown" : "user" }
              : undefined;

      let result: AgentCallResult;
      try {
        result = await deps.executeAgentCall(
          {
            kind: "conversation_turn",
            executionClass: conversation.executionClass,
            prompt: request.promptText,
            backend,
            writeCapability: request.writeCapability,
            structuredOutputTurns: request.structuredOutputTurns,
            ...(request.outputFormat?.type === "json_schema" ? { outputSchema: request.outputFormat.schema } : {}),
            ...(request.requirements.fsWritePolicy !== undefined
              ? { fsWritePolicy: request.requirements.fsWritePolicy }
              : {}),
          },
          {
            resolveConversationRuntime: () => ({
              runtime: retrying,
              capabilityView: capabilityViewForBackend(backend),
              signal: abort.abortController.signal,
              modelSelection: request.requirements.modelSelection,
              autonomous: request.autonomous,
              ...(request.waitForBackgroundTasks ? { waitForBackgroundTasks: true } : {}),
              ...(request.onUserQuestion !== undefined ? { onUserQuestion: request.onUserQuestion } : {}),
              sessionInstructions: [],
              userPromptText: request.userPromptText ?? request.promptText,
              ...(request.imageRefs !== undefined && request.imageRefs.length > 0 ? { imageRefs: request.imageRefs } : {}),
              ...(request.promptContext !== undefined ? { promptContext: request.promptContext } : {}),
              onEvent,
            }),
            getFailureClassifier: resolveFailureClassifierForBackend,
          },
        );
      } catch (error) {
        const stopped = interruption();
        deps.log.error("conversation_core.turn_dispatch_failed", {
          conversationId,
          backend,
          error: getErrorMessage(error),
          ...(stopped !== undefined ? { interruption: stopped.reason } : {}),
        });
        return {
          kind: "not_started",
          reason: stopped !== undefined ? "cancelled" : "configuration",
          message: getErrorMessage(error),
          ...(stopped !== undefined ? { interruption: stopped } : {}),
        };
      } finally {
        await stopListening();
      }

      const stopped = interruption();
      if (result.compacted === true) {
        // Bookkeeping about the provider's compaction must never cost the finished turn.
        await deps.onCompacted?.(conversationId).catch((error: unknown) =>
          deps.log.warn("conversation_core.compaction_reset_failed", { conversationId, error: getErrorMessage(error) }),
        );
      }
      const outcome = result.outcome;
      const adapterBlocks =
        outcome.kind === "completed" || outcome.kind === "failed" ? outcome.contentBlocks : undefined;
      if (adapterBlocks !== undefined) {
        // Blocks a backend returned without streaming them still belong in the transcript.
        if (projection.persistContentEvents && adapterBlocks.length > persistedContent) {
          await append({
            timestamp: new Date().toISOString(),
            type: "assistant",
            role: "assistant",
            content: adapterBlocks.slice(persistedContent),
          });
        }
        const resultEntry = projection.projectTurnResult({
          timestamp: new Date().toISOString(),
          backendRef: result.backendRef,
          durationMs: result.usage.durationMs ?? null,
          numTurns: outcome.kind === "completed" || outcome.kind === "failed" ? (outcome.numTurns ?? null) : null,
          contextTokens: result.usage.contextTokens ?? null,
          contextWindowMax: result.usage.contextWindowMax ?? null,
          costUsd: result.usage.costUsd ?? null,
          cumulativeCostUsd: result.usage.cumulativeCostUsd ?? null,
          aborted: stopped !== undefined,
          error: outcome.kind === "failed" ? outcome.error.message : null,
        });
        if (resultEntry !== null) await append(resultEntry);
      }
      // A failure must stay explicable after reload, not only in a live stream.
      if (outcome.kind === "failed" && stopped === undefined) {
        await append({
          timestamp: new Date().toISOString(),
          type: "notice",
          role: "notice",
          content: [{ type: "text", text: `Turn stopped: ${outcome.error.message}` }],
        });
      }
      deps.log.info("conversation_core.turn_completed", {
        conversationId,
        backend,
        outcome: outcome.kind,
        ...(stopped !== undefined ? { interruption: stopped.reason } : {}),
      });
      return { kind: "call_result", result, ...(stopped !== undefined ? { interruption: stopped } : {}) };
    },
  };
}
