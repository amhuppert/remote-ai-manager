import { z } from "zod";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import { messageContentBlockSchema } from "@/lib/conversations/message-content-schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

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

/**
 * Typed fields of a conversation JSONL frame carried inside a
 * `transcript_entry` envelope. Loose: adapter-authored frames may carry
 * additional fields (`raw`, `model`, `origin`, …) which pass through
 * untouched — the ORIGINAL object is returned so serialized bytes (including
 * key order) are exactly what the adapter built.
 */
const conversationFrameSchema = z.looseObject({
  timestamp: z.string(),
  type: z.string(),
  role: z.enum(["user", "assistant", "notice"]).optional(),
  content: z.array(messageContentBlockSchema).optional(),
  uuid: z.string().optional(),
  id: z.string().optional(),
});

/**
 * Resolve the conversation-transcript frame to append for a
 * `transcript_entry` envelope. This is the ONLY sanctioned reader of
 * `entry.raw` above the adapters' own modules: callers append the returned
 * frame verbatim and never branch on the payload themselves.
 *
 * A frame-shaped payload (adapter-built, e.g. Claude's interpreted frames) is
 * returned as-is after validation. Any other payload — a backend-native item
 * wrapped losslessly by an adapter that does not build frames — is recorded
 * under a generic `{timestamp, type, raw}` frame so nothing is dropped.
 */
export function conversationTranscriptFrame(
  entry: AgentTranscriptEntry,
): TranscriptEntry {
  const parsed = conversationFrameSchema.safeParse(entry.raw);
  if (parsed.success) {
    // Verified frame-shaped by the safeParse above; return the original
    // object (not parsed.data) to preserve byte-exact serialization.
    return entry.raw as TranscriptEntry;
  }
  return {
    timestamp: new Date().toISOString(),
    type: entry.type,
    raw: entry.raw,
  };
}
