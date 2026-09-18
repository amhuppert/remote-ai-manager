import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { AgentTranscriptEntry } from "../transcript";
import type { TranscriptUsageProjection } from "../transcript-projections";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { decodeTaggedPayload } from "./worker/ipc";

/**
 * Cursor transcript projection (spec D5, D7, D21): envelope first,
 * interpretation second.
 *
 * Every complete public SDK object the worker forwards becomes exactly ONE
 * persisted frame carrying the lossless tagged payload under `raw`, the
 * run-scoped entry id the idempotent append boundary keys on, and — for the
 * content-worthy classes — the visible content blocks. One frame per native
 * event is what makes exactly-once structural: a re-delivered event has one id
 * to collide on, not one per projected block.
 *
 * Unknown native types project no content and are still persisted verbatim, so
 * a future SDK message class survives reload without this module knowing it.
 */

/** One forwarded native event, as the runtime holds it after decoding. */
export interface CursorNativeEvent {
  runId: string;
  eventIndex: number;
  /** The SDK's `type` discriminant as the worker read it. */
  eventType: string;
  /**
   * The tagged JSON-safe form. Persisted verbatim: the decoded form can carry
   * `undefined`, `NaN`, or `BigInt`, none of which survive JSONL.
   */
  tagged: unknown;
  /** The decoded native object. The ONLY value interpretation reads. */
  decoded: unknown;
}

export interface CursorProjectionContext {
  conversationId: string;
  timestamp: string;
}

export interface CursorNativeEventProjection {
  /** The lossless envelope wrapping the frame this event persists as. */
  entry: AgentTranscriptEntry;
  /** Blocks to surface as neutral `content` events; empty for inert types. */
  blocks: readonly MessageContentBlock[];
  /** Native summary observed; the SDK does not expose replacement completion. */
  compacted: boolean;
}

/**
 * The run-scoped exactly-once key (D21). Deterministic from data the worker
 * stamps, so the same event derives the same id in a resumed stream, a
 * re-delivered IPC frame, or a restarted server.
 */
export function cursorTranscriptEntryId(
  conversationId: string,
  runId: string,
  eventIndex: number,
): string {
  return `cursor:${conversationId}:${runId}:${eventIndex}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Tool payloads are arbitrary JSON. They are rendered rather than truncated:
 * the worker's encode bounds already cap what can reach here (D7), so the
 * projection inherits that bound instead of imposing a second, lossier one.
 * SDK-side truncation markers ride along in `raw` untouched.
 */
function renderToolPayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text;
  } catch {
    return undefined;
  }
}

function toolUseBlock(
  callId: string,
  name: string,
  args: unknown,
): MessageContentBlock {
  const input = record(args);
  return {
    type: "tool_use",
    id: callId,
    name,
    ...(input !== null ? { input } : {}),
  };
}

function toolResultBlock(
  callId: string,
  result: unknown,
  isError: boolean,
): MessageContentBlock {
  const content = renderToolPayload(result);
  return {
    type: "tool_result",
    tool_use_id: callId,
    ...(content !== undefined ? { content } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * A `tool_call` event that has reached its terminal state. Its blocks are
 * `tool_result`s, and its frame takes the `tool_result` type so the transcript
 * reader routes it back through the registered decoder on reload — the same
 * shape Claude's stored tool results use.
 */
function terminalToolCall(
  decoded: unknown,
): { callId: string; isError: boolean; result: unknown } | null {
  const source = record(decoded);
  if (source === null || source.type !== "tool_call") return null;
  const callId = readString(source, "call_id");
  if (callId === null) return null;
  const status = source.status;
  if (status !== "completed" && status !== "error") return null;
  return { callId, isError: status === "error", result: source.result };
}

function projectAssistantBlocks(
  source: Record<string, unknown>,
): MessageContentBlock[] {
  const message = record(source.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const blocks: MessageContentBlock[] = [];
  for (const candidate of content) {
    const block = record(candidate);
    if (block === null) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "tool_use") {
      const id = readString(block, "id");
      const name = readString(block, "name");
      if (id !== null && name !== null) {
        blocks.push(toolUseBlock(id, name, block.input));
      }
    }
  }
  return blocks;
}

/**
 * Content-worthy classes only. `user` echoes the prompt Command Center already
 * persisted and `system`/`status`/`request`/`usage` carry no
 * conversation content. Native summaries become notices separately, never
 * assistant content or part of the final response.
 */
function projectBlocks(decoded: unknown): MessageContentBlock[] {
  const source = record(decoded);
  if (source === null) return [];

  switch (source.type) {
    case "assistant":
      return projectAssistantBlocks(source);
    case "thinking": {
      const text = source.text;
      return typeof text === "string" ? [{ type: "thinking", text }] : [];
    }
    case "tool_call": {
      const callId = readString(source, "call_id");
      if (callId === null) return [];
      const terminal = terminalToolCall(source);
      if (terminal !== null) {
        return [
          toolResultBlock(terminal.callId, terminal.result, terminal.isError),
        ];
      }
      const name = readString(source, "name");
      return name === null ? [] : [toolUseBlock(callId, name, source.args)];
    }
    default:
      return [];
  }
}

export function projectCursorNativeEvent(
  event: CursorNativeEvent,
  context: CursorProjectionContext,
): CursorNativeEventProjection {
  const id = cursorTranscriptEntryId(
    context.conversationId,
    event.runId,
    event.eventIndex,
  );
  const blocks = projectBlocks(event.decoded);
  // The pinned local SDK maps its native `summary` update exclusively to
  // SDKTaskMessage. Its public callback filters summary-started/completed, so
  // this is evidence of compaction activity, not confirmed replacement success.
  // Nested task deltas and assistant-authored text are deliberately excluded.
  const source = record(event.decoded);
  const compacted =
    source?.type === "task" &&
    readString(source, "agent_id") !== null &&
    readString(source, "run_id") !== null &&
    typeof source.text === "string" &&
    source.text.trim().length > 0;
  const frame: TranscriptEntry = compacted
    ? {
        id,
        timestamp: context.timestamp,
        type: "notice",
        role: "notice",
        content: [
          {
            type: "text",
            text: "Cursor produced a native context summary. Context occupancy and window size remain unknown; the provider does not report whether context replacement completed.",
          },
        ],
        raw: event.tagged,
      }
    : terminalToolCall(event.decoded) !== null
      ? {
          id,
          timestamp: context.timestamp,
          type: "tool_result",
          raw: event.tagged,
        }
      : blocks.length > 0
        ? {
            id,
            timestamp: context.timestamp,
            type: "assistant",
            role: "assistant",
            content: blocks,
            raw: event.tagged,
          }
        : {
            id,
            timestamp: context.timestamp,
            type: event.eventType,
            raw: event.tagged,
          };

  return {
    entry: {
      seq: event.eventIndex,
      backend: CURSOR_BACKEND_ID,
      type: frame.type,
      raw: frame,
    },
    blocks,
    compacted,
  };
}

/**
 * Decode a stored Cursor `tool_result` frame's payload back into neutral
 * blocks. Registered in the shared `TOOL_RESULT_PROJECTORS`; declines any
 * payload that is not a terminal Cursor `tool_call`, and never throws.
 */
export function projectCursorStoredToolResultBlocks(
  raw: unknown,
): MessageContentBlock[] | null {
  const decoded = decodeTaggedPayload("tool_call", raw);
  if (!decoded.ok) return null;
  const terminal = terminalToolCall(decoded.value);
  if (terminal === null) return null;
  return [toolResultBlock(terminal.callId, terminal.result, terminal.isError)];
}

/**
 * Decode a stored Cursor `usage` frame. Cursor reports per-turn token counts
 * and no cost at all (D17), so the projection names its lineage and reports
 * cost unavailable rather than inventing a figure from tokens or rates.
 */
export function projectCursorUsageFrame(
  raw: unknown,
): TranscriptUsageProjection | null {
  const decoded = decodeTaggedPayload("usage", raw);
  if (!decoded.ok) return null;
  const source = record(decoded.value);
  if (source === null || source.type !== "usage") return null;
  const usage = record(source.usage);
  if (usage === null || typeof usage.totalTokens !== "number") return null;
  return {
    lineageId: readString(source, "agent_id") ?? "unknown",
    cumulativeCostUsd: null,
    numTurns: null,
  };
}
