import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ConversationCostSettlement } from "@/lib/agent-backends/conversation";
import { projectTranscriptUsage } from "@/lib/agent-backends/transcript-projections";
import { getTranscriptPath } from "@/lib/prompt/transcript";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";

/** What a workflow's task run costs its conversation, and the transcript frame that records it. */
export interface TaskRunCost {
  /** The run's own spend, which the conversation's totals add. */
  costUsd: number;
  settlement: ConversationCostSettlement;
}

/**
 * Pure: a task run's own cost and its cost frame. A run that reports its
 * session's running total (a backend whose session totals are cumulative, as
 * a resumed session continues from its saved total) is charged only what it
 * added, on the session's lineage, so the transcript's per-lineage fold and
 * the session's next baseline both see it once. Any other run's cost stays on
 * a lineage of its own. Null when the run cost nothing measurable.
 */
export function attributeTaskRunCost(input: {
  usage: AgentCallResult["usage"];
  /** The session the run ran in (its continuation ref). */
  sessionRef: AgentSessionRef | null;
  /** The run's own lineage, for a backend with no session total. */
  runLineageId: string;
  /** The session lineage's recorded total before the run, or null for none. */
  previousCumulativeUsd: number | null;
}): TaskRunCost | null {
  const cumulative = input.usage.cumulativeCostUsd;
  if (cumulative !== undefined && input.sessionRef !== null) {
    const previous = input.previousCumulativeUsd ?? 0;
    // A total below the recorded one is a restarted lineage, which counts from zero.
    const costUsd = cumulative >= previous ? cumulative - previous : cumulative;
    return {
      costUsd,
      settlement: { lineageId: input.sessionRef.ref, cumulativeCostUsd: cumulative, costUsdDelta: costUsd },
    };
  }
  const costUsd = input.usage.costUsd;
  if (costUsd === undefined || !(costUsd > 0)) return null;
  return { costUsd, settlement: { lineageId: input.runLineageId, cumulativeCostUsd: costUsd, costUsdDelta: costUsd } };
}

/**
 * The latest total the conversation's transcript records for a cost lineage
 * (any backend's result frames and cost settlements), or null when none
 * does. Never throws: an unreadable transcript leaves the lineage unknown.
 */
export async function readLineageCumulativeCost(
  conversationId: string,
  lineageId: string,
  configDir?: string,
): Promise<number | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId, configDir);
    const lines = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
    let latest: number | null = null;
    for await (const line of lines) {
      if (!line.includes(lineageId)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      // The frame goes whole to the backends' projections, which alone read its payload.
      const usage = projectTranscriptUsage(entry);
      if (usage?.lineageId === lineageId && usage.cumulativeCostUsd !== null && usage.cumulativeCostUsd > 0) {
        latest = usage.cumulativeCostUsd;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
