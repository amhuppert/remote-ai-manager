import { z } from "zod";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

/**
 * One entry of a captured agent transcript. A lossless envelope around a
 * backend-native item (codex `ThreadItem`) or message (claude `SDKMessage`):
 * the original payload is preserved verbatim in `raw` so post-hoc forensic
 * readers lose nothing, while `seq`/`backend`/`type` give cheap structure for
 * filtering without parsing every payload.
 */
export const agentTranscriptEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  backend: agentBackendSchema,
  type: z.string(),
  raw: z.unknown(),
});
export type AgentTranscriptEntry = z.infer<typeof agentTranscriptEntrySchema>;

function entryType(raw: unknown): string {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "type" in raw &&
    typeof (raw as { type: unknown }).type === "string"
  ) {
    return (raw as { type: string }).type;
  }
  return "unknown";
}

/**
 * Wrap each backend-native item/message in an {@link AgentTranscriptEntry}
 * without copying or normalizing the payload. Order is preserved and `seq` is
 * the index, so the entries replay the agent's turn exactly as the backend
 * produced it.
 */
export function toRawTranscriptEntries(
  backend: AgentBackendId,
  rawItems: readonly unknown[],
): AgentTranscriptEntry[] {
  return rawItems.map((raw, seq) => ({
    seq,
    backend,
    type: entryType(raw),
    raw,
  }));
}
