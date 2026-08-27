import {
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import type { createLogger } from "@/lib/logging";
import {
  notepadChangedEventSchema,
  type NotepadAuthorKind,
  type NotepadChangedEvent,
  type NotepadListItem,
  type NotepadScope,
} from "./schemas";

type NotepadLogger = ReturnType<typeof createLogger>;

export interface PublishNotepadChangeInput {
  publish: PublishFn;
  logger: NotepadLogger;
  change: NotepadChangedEvent["change"];
  notepadId: string;
  scope: NotepadScope;
  projectPath: string | null;
  /** The new head revision for a content change; null for every other kind. */
  revision: number | null;
  authorKind: NotepadAuthorKind | null;
  /** Null once the notepad is gone, so a list reaction can drop the row. */
  listItem: NotepadListItem | null;
}

/**
 * Single builder for `notepad-changed` events so every notepad surface emits
 * the same envelope, and so a schema-validation failure degrades to a
 * structured warning rather than throwing after a committed mutation.
 *
 * The frame deliberately carries identity, the change kind, the head revision,
 * and the content-free list projection — never the notepad's content, which can
 * be arbitrarily large and belongs on an ordinary fetch by the one open panel
 * that needs it.
 */
export function publishNotepadChange(input: PublishNotepadChangeInput): void {
  publishEventBestEffort({
    publish: input.publish,
    logger: input.logger,
    failureEvent: "notepads.service.event_broadcast_failed",
    context: {
      change: input.change,
      notepadId: input.notepadId,
      scope: input.scope,
    },
    build: () =>
      notepadChangedEventSchema.parse({
        type: "notepad-changed",
        change: input.change,
        notepadId: input.notepadId,
        scope: input.scope,
        projectPath: input.projectPath,
        revision: input.revision,
        authorKind: input.authorKind,
        listItem: input.listItem,
      }),
  });
}
