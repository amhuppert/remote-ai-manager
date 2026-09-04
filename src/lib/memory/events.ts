import {
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import type { createLogger } from "@/lib/logging";
import {
  memoryChangedEventSchema,
  type MemoryAuthorKind,
  type MemoryChangeKind,
  type MemoryLinkKind,
  type MemoryNote,
} from "./schemas";

type MemoryLogger = ReturnType<typeof createLogger>;

export interface PublishMemoryChangeInput {
  publish: PublishFn;
  logger: MemoryLogger;
  change: MemoryChangeKind;
  /** The note as it stands after the change (as it stood, for `deleted`). */
  note: MemoryNote;
  authorKind: MemoryAuthorKind;
  /** The link a `linked`/`unlinked` change concerns. */
  link?: { id: string; kind: MemoryLinkKind } | null;
}

/**
 * Single builder for `memory-changed` events, so every memory surface emits the
 * same envelope and a schema failure after a committed mutation degrades to a
 * structured warning rather than a throw. The frame is identity, scope owner,
 * lifecycle, and head revision — never the hook or body.
 */
export function publishMemoryChange(input: PublishMemoryChangeInput): void {
  publishEventBestEffort({
    publish: input.publish,
    logger: input.logger,
    failureEvent: "memory.service.event_broadcast_failed",
    context: {
      change: input.change,
      memoryId: input.note.id,
      scope: input.note.scope,
    },
    build: () =>
      memoryChangedEventSchema.parse({
        type: "memory-changed",
        change: input.change,
        memoryId: input.note.id,
        slug: input.note.slug,
        scope: input.note.scope,
        projectPath: input.note.projectPath,
        sessionName: input.note.sessionName,
        sessionCreatedAt: input.note.sessionCreatedAt,
        lifecycle: input.note.lifecycle,
        revision: input.note.revision,
        authorKind: input.authorKind,
        link: input.link ?? null,
      }),
  });
}
