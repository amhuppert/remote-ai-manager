import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import type { TranscriptUsageProjection } from "../transcript-projections";

/**
 * Claude-owned decoding of persisted transcript frame payloads. The Claude
 * message interpreter (`process-message.ts`) stores two raw-frame shapes in
 * conversation JSONL — `{type:"tool_result", raw:<SDK user message>}` and
 * `{type:"result", raw:<SDK result message>}`. This module is the only place
 * those shapes are decoded back out; consumers above the seam go through the
 * neutral projections in `agent-backends/transcript-projections`.
 */

/**
 * Decode a stored tool_result frame's `raw` payload into `tool_result`
 * content blocks. The production shape is the full SDK user message —
 * `{ type:"user", message:{ content:[{type:"tool_result", tool_use_id,
 * content, is_error}] } }` where `content` is a string or an array of
 * `{type:"text"|"tool_reference", …}` blocks. Legacy/fabricated lines may
 * store the bare block itself. Returns null when the payload contains no
 * recognizable tool_result block — the neutral dispatcher owns the generic
 * fallback. Never throws.
 *
 * The raw payload carries no tool name, so metrics are recovered by pairing
 * `tool_use_id` with the preceding assistant `tool_use` blocks
 * (`toolNamesById`) and re-running `parseToolResultMetrics`, exactly like the
 * live Claude turn path (`query-session.ts` `buildToolResultBlock`).
 */
export function projectClaudeStoredToolResultBlocks(
  raw: unknown,
  toolNamesById: ReadonlyMap<string, string>,
): MessageContentBlock[] | null {
  const candidates: unknown[] = [];
  if (raw !== null && typeof raw === "object") {
    const rawObj = raw as { message?: unknown; content?: unknown };
    const message = rawObj.message;
    const messageContent =
      message !== null && typeof message === "object"
        ? (message as { content?: unknown }).content
        : undefined;
    if (Array.isArray(messageContent)) {
      candidates.push(...messageContent);
    } else if (Array.isArray(rawObj.content)) {
      candidates.push(...rawObj.content);
    } else {
      candidates.push(raw);
    }
  }

  const blocks: MessageContentBlock[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const record = candidate as {
      type?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      content?: unknown;
    };
    if (typeof record.tool_use_id !== "string") continue;
    if (record.type !== undefined && record.type !== "tool_result") continue;
    const text = extractStoredToolResultText(record.content);
    const toolName = toolNamesById.get(record.tool_use_id);
    const metrics = toolName ? parseToolResultMetrics(toolName, text) : {};
    blocks.push({
      type: "tool_result",
      tool_use_id: record.tool_use_id,
      ...(text !== undefined ? { content: text } : {}),
      ...(record.is_error === true ? { isError: true } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
  }

  return blocks.length > 0 ? blocks : null;
}

function extractStoredToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Decode a Claude SDK result frame's cumulative usage counters. The SDK
 * reports `total_cost_usd` cumulatively per `session_id` lineage; a restarted
 * subprocess can resume the SAME session id with its cumulative reset, which
 * consumers observe as a decrease (the lineage boundary). Returns null for
 * any payload without a numeric `total_cost_usd`.
 */
export function projectClaudeUsageFrame(
  raw: unknown,
): TranscriptUsageProjection | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as {
    total_cost_usd?: unknown;
    session_id?: unknown;
    num_turns?: unknown;
  };
  if (typeof record.total_cost_usd !== "number") return null;
  return {
    lineageId: String(record.session_id ?? "unknown"),
    cumulativeCostUsd: record.total_cost_usd,
    numTurns: typeof record.num_turns === "number" ? record.num_turns : null,
  };
}
