import { z } from "zod";
import { readFileLines } from "@/lib/shared/read-jsonl";
import { promptDispatchSchema, type PromptDispatchEvidence } from "./schemas";

export {
  promptDispatchEvidenceSchema,
  type PromptDispatchEvidence,
} from "./schemas";

const dispatchFrameSchema = z.object({
  type: z.literal("prompt_dispatch"),
  timestamp: z.string(),
  promptDispatch: promptDispatchSchema,
});

/** Read non-user prompt evidence without loading an entire transcript into memory. */
export async function readPromptDispatches(
  transcriptPath: string | null,
): Promise<PromptDispatchEvidence[]> {
  if (transcriptPath === null) return [];
  const dispatches: PromptDispatchEvidence[] = [];
  let seq = -1;
  for await (const line of readFileLines(transcriptPath)) {
    seq += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A partial final write or malformed unrelated frame cannot hide earlier evidence.
      continue;
    }
    const parsed = dispatchFrameSchema.safeParse(value);
    if (!parsed.success) continue;
    dispatches.push({
      ...parsed.data.promptDispatch,
      seq,
      timestamp: parsed.data.timestamp,
    });
  }
  return dispatches;
}
