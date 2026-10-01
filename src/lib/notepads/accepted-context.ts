import type { z } from "zod";
import type { NotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import type { notepadAcceptedContextSchema } from "./schemas";

export type NotepadDeliveryRecord = z.infer<
  typeof notepadAcceptedContextSchema
>;

/** Accepted knowledge survives out-of-order receipt retries; marker fields stay one rendered pair. */
export function mergeAcceptedNotepadContext(
  previous: NotepadDeliveryRecord | undefined,
  received: NotepadDeliveryRecord,
): NotepadDeliveryRecord {
  if (!previous) return received;
  if (previous.notepadId !== received.notepadId)
    throw new Error("Cannot merge context from different notepads");
  const older = previous.openComments;
  const newer = received.openComments;
  const advanceMarker =
    newer.latestCreatedAt !== null &&
    (older.latestCreatedAt === null ||
      newer.latestCreatedAt > older.latestCreatedAt ||
      (newer.latestCreatedAt === older.latestCreatedAt &&
        newer.count > older.count));
  const commentIds =
    previous.commentIds === undefined && received.commentIds === undefined
      ? undefined
      : [
          ...new Set([
            ...(previous.commentIds ?? []),
            ...(received.commentIds ?? []),
          ]),
        ];
  return {
    notepadId: received.notepadId,
    revision: Math.max(previous.revision, received.revision),
    openComments: { ...(advanceMarker ? newer : older) },
    ...(commentIds === undefined ? {} : { commentIds }),
  };
}

/** Records source context only; the subscription inbox owns notice delivery. */
export function createNotepadAcceptedContextRecorder(deps: {
  watermarks: NotepadDeliveryWatermarksRepo;
  now(): string;
}) {
  return {
    async recordDelivered(input: {
      conversationId: string;
      notepads: readonly NotepadDeliveryRecord[];
    }): Promise<void> {
      for (const context of input.notepads)
        await deps.watermarks.record({
          ...context,
          conversationId: input.conversationId,
          updatedAt: deps.now(),
        });
    },
  };
}
