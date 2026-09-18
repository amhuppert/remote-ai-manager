import { z } from "zod";
import { captureAuditEvidence, parseJsonl } from "./evidence";
const ownedTransport = z.object({
  type: z.literal("codex_app_server"),
  origin: z.object({
    source: z.literal("checkpoint_capture"),
    checkpointCapture: z.object({ captureId: z.string() }),
  }),
  raw: z.object({ record: z.string() }),
});
const startedTurn = z.object({
  method: z.literal("turn/started"),
  params: z.object({
    threadId: z.string(),
    turn: z.object({ id: z.string() }),
  }),
});
/** Persisted attempt-owned provider starts, without inferring from progress. */
export function restartCaptureStarts(
  archive: string,
  captureId: string,
  mode: "tool-disabled" | "instruction-only",
): { count: number; turnIds: string[] } {
  if (mode === "tool-disabled")
    return {
      count: captureAuditEvidence(archive, captureId).initInventories.length,
      turnIds: [],
    };
  const turnIds: string[] = [];
  for (const entry of parseJsonl(archive)) {
    const parsed = ownedTransport.safeParse(entry);
    if (
      !parsed.success ||
      parsed.data.origin.checkpointCapture.captureId !== captureId
    )
      continue;
    let record: unknown;
    try {
      record = JSON.parse(parsed.data.raw.record);
    } catch {
      continue;
    }
    const started = startedTurn.safeParse(record);
    if (started.success) turnIds.push(started.data.params.turn.id);
  }
  return { count: turnIds.length, turnIds };
}
