import { readFile } from "node:fs/promises";
import { parseJsonl } from "@/lib/shared/read-jsonl";
import { projectTranscriptUsage } from "@/lib/agent-backends/transcript-projections";
import { createLogger } from "@/lib/logging";
import { getTranscriptPath } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("workflow-conversation-telemetry");

/**
 * Occupancy-vs-outcome telemetry for one lane conversation, derived from its
 * transcript. Emitted per iteration so dose-response evidence for the
 * context-limit feature (does high occupancy degrade quality / raise cost?)
 * accumulates across executions without an A/B setup.
 */
export interface ConversationTelemetrySummary {
  /**
   * True conversation cost: the sum of each session lineage's FINAL
   * cumulative cost. (Summing every result frame double-counts — the usage
   * projection reports cost cumulatively per lineage.) Null when the
   * transcript has no result frames.
   */
  costUsd: number | null;
  /** Sum of turns across all result frames; null when none exist. */
  apiTurns: number | null;
  /** Distinct session lineages observed (restarts within the conversation). */
  lineageCount: number;
  reads: {
    uniqueFiles: number;
    totalReads: number;
    repeatReads: number;
  };
  /** Files Read more than once, most-repeated first (capped at 5). */
  topReReads: Array<{ path: string; count: number }>;
}

const TOP_RE_READS_LIMIT = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pure transcript scan. Tolerates malformed lines — a telemetry pass must
 * never fail the iteration that emits it.
 */
export function summarizeTranscriptTelemetry(
  jsonlText: string,
): ConversationTelemetrySummary {
  const lineageFinalCost = new Map<string, number>();
  let committedLineageCost = 0;
  let lineageRestarts = 0;
  let apiTurns: number | null = null;
  const readCounts = new Map<string, number>();

  for (const parsed of parseJsonl(jsonlText)) {
    const entry = asRecord(parsed);
    if (!entry) continue;

    const usage = projectTranscriptUsage(entry);
    if (usage) {
      // Cumulative per lineage — the last result in file order is the final.
      // A cumulative drop under the same lineage id is the lineage boundary
      // (backend restart), so bank the finished lineage's final before
      // tracking the new one.
      const previous = lineageFinalCost.get(usage.lineageId);
      if (previous !== undefined && usage.cumulativeCostUsd < previous) {
        committedLineageCost += previous;
        lineageRestarts += 1;
      }
      lineageFinalCost.set(usage.lineageId, usage.cumulativeCostUsd);
      if (usage.numTurns !== null) {
        apiTurns = (apiTurns ?? 0) + usage.numTurns;
      }
    }

    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      for (const rawBlock of entry.content) {
        const block = asRecord(rawBlock);
        if (!block || block.type !== "tool_use" || block.name !== "Read") {
          continue;
        }
        const input = asRecord(block.input);
        const filePath = input?.file_path;
        if (typeof filePath === "string" && filePath.length > 0) {
          readCounts.set(filePath, (readCounts.get(filePath) ?? 0) + 1);
        }
      }
    }
  }

  let totalReads = 0;
  for (const count of readCounts.values()) {
    totalReads += count;
  }
  const topReReads = [...readCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RE_READS_LIMIT)
    .map(([path, count]) => ({ path, count }));

  const costUsd =
    lineageFinalCost.size === 0
      ? null
      : committedLineageCost +
        [...lineageFinalCost.values()].reduce((sum, cost) => sum + cost, 0);

  return {
    costUsd,
    apiTurns,
    lineageCount: lineageFinalCost.size + lineageRestarts,
    reads: {
      uniqueFiles: readCounts.size,
      totalReads,
      repeatReads: totalReads - readCounts.size,
    },
    topReReads,
  };
}

/**
 * Production reader for the orchestrator's telemetry dep: parses the
 * conversation's transcript once. Returns null (never throws) on any miss.
 */
export async function readConversationTelemetry(
  conversationId: string,
): Promise<ConversationTelemetrySummary | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId);
    const jsonlText = await readFile(transcriptPath, "utf-8");
    return summarizeTranscriptTelemetry(jsonlText);
  } catch (error) {
    logger.debug("conversation_telemetry.read_failed", {
      conversationId,
      error: getErrorMessage(error),
    });
    return null;
  }
}
