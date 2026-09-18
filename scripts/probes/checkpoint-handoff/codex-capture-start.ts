import { z } from "zod";

const owned = z.object({
  type: z.literal("codex_app_server"),
  origin: z.object({
    source: z.literal("checkpoint_capture"),
    checkpointCapture: z.object({ captureId: z.string() }),
  }),
  raw: z.object({ record: z.string() }),
});
const started = z.object({
  method: z.literal("turn/started"),
  params: z.object({ turn: z.object({ id: z.string().min(1) }) }),
});

/** A durable running phase precedes provider dispatch; interrupt only the owned native turn. */
export function codexCaptureStarted(
  archive: string,
  captureId: string,
): boolean {
  return archive.split("\n").some((line) => {
    try {
      const frame = owned.safeParse(JSON.parse(line));
      return (
        frame.success &&
        frame.data.origin.checkpointCapture.captureId === captureId &&
        started.safeParse(JSON.parse(frame.data.raw.record)).success
      );
    } catch {
      return false;
    }
  });
}
