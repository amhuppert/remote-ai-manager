/**
 * Claude SDK message interpretation — the only place raw `SDKMessage` frames
 * are turned into neutral `ConversationBackendEvent`s and conversation
 * transcript frames. Everything above the backend seam consumes the neutral
 * events; the frames cross it opaquely inside `transcript_entry` envelopes
 * (the actor appends them without reading into the payload).
 *
 * Frame shapes are a byte-stable on-disk contract (see
 * `transcript-frames.contract.test.ts`): readers depend on the assistant
 * `uuid` (fork `resumeSessionAt`), the mapped assistant `content`, and the
 * verbatim `raw` payloads of system/tool_result/result frames.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ConversationBackendEvent } from "../conversation";
import { mapAssistantContentBlocks } from "./map-content-blocks";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("claude:process-message");

export function mapErrorSubtype(error: SDKResultError): string {
  switch (error.subtype) {
    case "error_max_turns":
      return `Agent reached maximum turns (${error.num_turns})`;
    case "error_max_budget_usd":
      return `Agent exceeded budget limit ($${error.total_cost_usd.toFixed(2)})`;
    case "error_max_structured_output_retries":
      return "Agent exceeded structured output retry limit";
    case "error_during_execution":
      return error.errors.length > 0
        ? error.errors.join("; ")
        : "Error during execution";
    default:
      return "Unknown error";
  }
}

export interface ClaudeMessageInterpreter {
  /** Interpret one raw SDK message into neutral backend events. */
  handleMessage(message: SDKMessage): void;
  /**
   * Emit a CC-authored conversation frame (e.g. the external-turn wake
   * marker) through the same envelope sequence as interpreted frames.
   */
  emitFrame(frame: TranscriptEntry): void;
  /**
   * Queue a neutral event behind everything already emitted, so events the
   * runtime authors itself (`input_accepted`, post-turn `backend_init`,
   * `external_turn_completed`) keep their emission order relative to
   * interpreted frames even when handlers are async.
   */
  emitEvent(event: ConversationBackendEvent): void;
  /**
   * Resolves once every event emitted so far has been handled (each handler
   * promise settled). Never rejects — handler failures are logged and the
   * chain continues.
   */
  flush(): Promise<void>;
}

/**
 * One interpreter instance per turn: it tracks whether any assistant content
 * was emitted (the result-text fallback fires only for content-less turns)
 * and stamps a monotonic `seq` on every transcript envelope.
 *
 * Handler invocations are serialized on one internal promise chain: handler N
 * settles before handler N+1 starts, so async consumers (transcript appends)
 * observe events in emission order, and `flush()` gives the runtime an
 * awaitable drain barrier before it reports the turn complete.
 */
export function createClaudeMessageInterpreter(opts: {
  onEvent(event: ConversationBackendEvent): Promise<void> | void;
}): ClaudeMessageInterpreter {
  let seq = 0;
  let contentEmitted = false;
  let chain: Promise<void> = Promise.resolve();

  const emitEvent = (event: ConversationBackendEvent): void => {
    chain = chain
      .then(() => opts.onEvent(event))
      .catch((err) => {
        logger.warn("process_message.event_handler_failed", {
          eventType: event.type,
          error: getErrorMessage(err),
        });
      });
  };

  const flush = (): Promise<void> => chain;

  const emitFrame = (frame: TranscriptEntry): void => {
    emitEvent({
      type: "transcript_entry",
      entry: { seq: seq++, backend: "claude", type: frame.type, raw: frame },
    });
  };

  const handleMessage = (message: SDKMessage): void => {
    const timestamp = new Date().toISOString();

    switch (message.type) {
      case "system": {
        const sysMsg = message as SDKSystemMessage;
        if (sysMsg.subtype === "init") {
          if (sysMsg.session_id) {
            emitEvent({
              type: "backend_init",
              backendRef: { backend: "claude", ref: sysMsg.session_id },
            });
          }
          emitFrame({
            timestamp,
            type: "system",
            raw: { subtype: "init", session_id: sysMsg.session_id },
          });
        } else {
          emitFrame({ timestamp, type: "system", raw: message });
        }
        break;
      }

      case "assistant": {
        const asstMsg = message as SDKAssistantMessage;
        const blocks = mapAssistantContentBlocks(asstMsg.message.content);
        for (const block of blocks) {
          emitEvent({ type: "content", block });
        }
        if (blocks.length > 0) {
          contentEmitted = true;
        }
        emitFrame({
          timestamp,
          type: "assistant",
          role: "assistant",
          content: blocks,
          uuid: asstMsg.uuid,
        });
        break;
      }

      case "user": {
        emitFrame({ timestamp, type: "tool_result", raw: message });
        break;
      }

      case "result": {
        const resultMsg = message as SDKResultSuccess | SDKResultError;
        if (resultMsg.subtype === "success") {
          const success = resultMsg as SDKResultSuccess;
          if (success.result && !contentEmitted) {
            const textBlock: MessageContentBlock = {
              type: "text",
              text: success.result,
            };
            contentEmitted = true;
            emitEvent({ type: "content", block: textBlock });
          }
        } else {
          const error = resultMsg as SDKResultError;
          const errorMessage = mapErrorSubtype(error);
          logger.debug("process_message.result_error", {
            subtype: error.subtype,
            message: errorMessage,
          });
          emitEvent({ type: "error", message: errorMessage });
        }
        emitFrame({ timestamp, type: "result", raw: resultMsg });
        break;
      }

      default: {
        emitFrame({ timestamp, type: message.type, raw: message });
        break;
      }
    }
  };

  return { handleMessage, emitFrame, emitEvent, flush };
}

/**
 * Interpreter for one external (background auto-continuation) turn. Wraps the
 * per-turn interpreter with the wake-marker policy: the marker notice frame is
 * appended lazily before the turn's FIRST assistant frame — never at turn
 * start — so notification-only noise turns (trailing task lifecycle messages
 * with no agentic continuation) leave no marker row. The most recent
 * `task_notification` summary is folded into the marker text.
 */
export function createClaudeExternalTurnInterpreter(opts: {
  onEvent(event: ConversationBackendEvent): Promise<void> | void;
}): ClaudeMessageInterpreter {
  const inner = createClaudeMessageInterpreter(opts);
  let markerEmitted = false;
  let lastSettledTaskSummary: string | null = null;

  const handleMessage = (message: SDKMessage): void => {
    if (message.type === "system" && message.subtype === "task_notification") {
      // Typed as required by the SDK, but this is subprocess wire input —
      // treat it as untrusted and tolerate an omitted summary.
      const summary: unknown = Reflect.get(message, "summary");
      if (typeof summary === "string" && summary.length > 0) {
        lastSettledTaskSummary = summary;
      }
    }

    if (message.type === "assistant" && !markerEmitted) {
      markerEmitted = true;
      const trigger = lastSettledTaskSummary
        ? ` after background-task activity (${lastSettledTaskSummary})`
        : " after background-task activity";
      logger.debug("process_message.wake_marker", {
        hasTaskSummary: lastSettledTaskSummary !== null,
      });
      inner.emitFrame({
        timestamp: new Date().toISOString(),
        type: "notice",
        role: "notice",
        content: [
          {
            type: "text",
            text: `Agent continued autonomously${trigger}.`,
          },
        ],
      });
    }

    inner.handleMessage(message);
  };

  return {
    handleMessage,
    emitFrame: inner.emitFrame,
    emitEvent: inner.emitEvent,
    flush: inner.flush,
  };
}
