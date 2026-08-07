import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import {
  projectClaudeStoredToolResultBlocks,
  projectClaudeUsageFrame,
} from "./claude/transcript-projections";
import { projectCodexUsageFrame } from "./codex/transcript-projections";

/**
 * Neutral projections over persisted transcript frames. Conversation JSONL
 * frames may carry a backend-native payload under `raw` (today only the
 * Claude interpreter stores raw frames; Codex writes interpreted content
 * blocks). Consumers above the seam never read into `raw` themselves — they
 * hand the whole frame to these projections, and each backend-owned decoder
 * recognizes (or declines) its own shapes. A backend that stores raw frames
 * registers its decoder here; consumers stay untouched.
 */

/**
 * A transcript frame as consumers hold it: everything except `raw` is
 * neutral, and `raw` stays opaque above the seam.
 */
interface RawFrameCarrier {
  raw?: unknown;
}

/**
 * Usage counters projected from one backend result frame. Counters are
 * cumulative WITHIN a lineage: the lineage's last frame carries its final
 * cost, and a cumulative decrease under the same `lineageId` signals a
 * lineage restart. Aggregation across frames stays with the caller.
 */
export interface TranscriptUsageProjection {
  /** Backend session lineage the cumulative counters belong to. */
  lineageId: string;
  /** Cumulative cost of the lineage as of this frame. */
  cumulativeCostUsd: number;
  /** API turns reported by this frame; null when the backend omits it. */
  numTurns: number | null;
}

type ToolResultProjector = (
  raw: unknown,
  toolNamesById: ReadonlyMap<string, string>,
) => MessageContentBlock[] | null;

type UsageProjector = (raw: unknown) => TranscriptUsageProjection | null;

const TOOL_RESULT_PROJECTORS: readonly ToolResultProjector[] = [
  projectClaudeStoredToolResultBlocks,
];

const USAGE_PROJECTORS: readonly UsageProjector[] = [
  projectClaudeUsageFrame,
  projectCodexUsageFrame,
];

/**
 * Project a stored `{type:"tool_result"}` frame's payload into neutral
 * `tool_result` content blocks. Payloads no registered backend recognizes
 * become a single generic block — this function never throws, because a
 * transcript read must not fail on one malformed line.
 */
export function projectStoredToolResultBlocks(
  frame: RawFrameCarrier,
  toolNamesById: ReadonlyMap<string, string>,
): MessageContentBlock[] {
  for (const project of TOOL_RESULT_PROJECTORS) {
    const blocks = project(frame.raw, toolNamesById);
    if (blocks !== null) return blocks;
  }
  return [
    {
      type: "tool_result",
      tool_use_id: "",
      content: "[unrecognized tool_result payload]",
    },
  ];
}

/**
 * Project a transcript frame's backend result payload into neutral usage
 * counters, or null when the frame carries none.
 */
export function projectTranscriptUsage(
  frame: RawFrameCarrier,
): TranscriptUsageProjection | null {
  for (const project of USAGE_PROJECTORS) {
    const projection = project(frame.raw);
    if (projection !== null) return projection;
  }
  return null;
}
