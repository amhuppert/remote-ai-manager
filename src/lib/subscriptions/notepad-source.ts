import { z } from "zod";
import type { NotepadsRepo } from "@/lib/state-store/notepads-repo";
import type { NotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import type { NotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import type { NotepadDeliveryRecord } from "@/lib/notepads/accepted-context";
import {
  notepadOpenCommentMarkerSchema,
  type NotepadCommentThread,
  type NotepadOpenCommentMarker,
} from "@/lib/notepads/schemas";
import type {
  SourceCursor,
  SourceFact,
  SourceReadResult,
  SubscriptionRecipient,
  SubscriptionSourceRef,
} from "./schemas";

const cursorSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    commentIds: z.array(z.string().min(1)).optional(),
    legacyOpenComments: notepadOpenCommentMarkerSchema.optional(),
  })
  .strict();
type NotepadCursor = z.infer<typeof cursorSchema>;

export function notepadInvolvementCursor(
  context: NotepadDeliveryRecord,
): string {
  return JSON.stringify({
    revision: context.revision,
    ...(context.commentIds === undefined
      ? { legacyOpenComments: context.openComments }
      : { commentIds: context.commentIds }),
  });
}

export function openCommentMarkerFromThreads(
  threads: readonly NotepadCommentThread[],
): NotepadOpenCommentMarker {
  const open = threads.filter((thread) => thread.comment.status === "open");
  return {
    count: open.length,
    latestCreatedAt: open.reduce<string | null>(
      (latest, { comment }) =>
        latest === null || comment.createdAt > latest
          ? comment.createdAt
          : latest,
      null,
    ),
  };
}

/** Legacy rows only have this aggregate; their equal-timestamp ambiguity cannot be reconstructed. */
function legacyHasNewComments(
  seen: NotepadOpenCommentMarker,
  current: NotepadOpenCommentMarker,
): boolean {
  if (current.latestCreatedAt === null) return false;
  if (seen.latestCreatedAt === null) return current.count > 0;
  return (
    current.latestCreatedAt > seen.latestCreatedAt ||
    (current.latestCreatedAt === seen.latestCreatedAt &&
      current.count > seen.count)
  );
}

export function isNotepadFactCovered(
  fact: SourceFact,
  context: NotepadDeliveryRecord,
): boolean {
  if (fact.eventKind === "notepad-content-revised") {
    const revision = Number(fact.revision);
    return (
      Number.isSafeInteger(revision) &&
      revision > 0 &&
      revision <= context.revision
    );
  }
  if (fact.eventKind !== "notepad-comment-added" || !fact.notepadContext)
    return false;
  const commentIds = fact.notepadContext.commentIds;
  if (commentIds && context.commentIds)
    return commentIds.every((id) => context.commentIds?.includes(id));
  return !legacyHasNewComments(
    context.openComments,
    fact.notepadContext.openComments,
  );
}

const quoteArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const boundedTitle = (value: string) => value.replace(/\s+/g, " ").slice(0, 96);

export function createNotepadSourceReader(deps: {
  notepads: NotepadsRepo;
  comments: NotepadCommentsRepo;
  watermarks?: NotepadDeliveryWatermarksRepo;
}) {
  async function readCursor(
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    cursor: string,
    currentIds: string[],
  ): Promise<NotepadCursor> {
    if (cursor.startsWith("{")) return cursorSchema.parse(JSON.parse(cursor));
    const revision = Number(cursor);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid notepad subscription cursor");
    const watermark = (
      await deps.watermarks?.listForConversation(recipient.conversationId)
    )?.find((record) => record.notepadId === source.id);
    return {
      revision,
      ...(watermark
        ? watermark.commentIds === undefined
          ? { legacyOpenComments: watermark.openComments }
          : { commentIds: watermark.commentIds }
        : { commentIds: currentIds }),
    };
  }

  return async (
    recipient: SubscriptionRecipient,
    source: SubscriptionSourceRef,
    cursor: SourceCursor,
  ): Promise<SourceReadResult> => {
    if (source.kind !== "notepad")
      throw new Error("Notepad reader requires a notepad source");
    const notepad = await deps.notepads.find(source.id);
    if (
      !notepad ||
      (notepad.scope === "project" &&
        notepad.projectPath !== recipient.projectPath)
    )
      return { cursor, facts: [], missing: true };
    const threads = await deps.comments.list({ notepadId: source.id });
    const currentIds = threads.map(({ comment }) => comment.id);
    const marker = openCommentMarkerFromThreads(threads);
    if (cursor === null)
      return {
        cursor: JSON.stringify({
          revision: notepad.revision,
          commentIds: currentIds,
        }),
        facts: [],
        missing: false,
      };
    const previous = await readCursor(recipient, source, cursor, currentIds);
    const acceptedContext = (
      await deps.watermarks?.listForConversation(recipient.conversationId)
    )?.find((record) => record.notepadId === source.id);
    const known = new Set(previous.commentIds ?? []);
    const legacy = previous.legacyOpenComments;
    const newComments = threads.filter(({ comment }) => {
      if (
        comment.status !== "open" ||
        known.has(comment.id) ||
        acceptedContext?.commentIds?.includes(comment.id)
      )
        return false;
      if (!legacy) return true;
      return (
        legacyHasNewComments(legacy, marker) &&
        (legacy.latestCreatedAt === null ||
          comment.createdAt >= legacy.latestCreatedAt)
      );
    });
    const history = (await deps.notepads.listRevisions(source.id)).sort(
      (a, b) => a.revision - b.revision,
    );
    const revisions = history.filter(
      (revision) =>
        revision.revision >
        Math.max(previous.revision, acceptedContext?.revision ?? 0),
    );
    const coveredRevisions: string[] = [];
    let priorRevision = 0;
    for (const revision of history) {
      // Browser save bursts reuse a revision row ID while advancing its counter.
      // Every counter in that row's span can therefore have an earlier inbox fact.
      for (
        let presented = priorRevision + 1;
        presented <=
        Math.min(revision.revision, acceptedContext?.revision ?? 0);
        presented++
      )
        coveredRevisions.push(`${revision.id}:${presented}`);
      priorRevision = revision.revision;
    }
    const title = boundedTitle(notepad.name);
    const facts: SourceFact[] = revisions.map((revision) => ({
      occurrenceId: `${revision.id}:${revision.revision}`,
      eventKind: "notepad-content-revised",
      category: "revision",
      sourceTitle: title,
      summary: `${title} was ${revision.origin === "restore" ? "restored" : "updated"} to revision ${revision.revision}.`,
      sourceText: JSON.stringify({
        notepadId: source.id,
        name: notepad.name,
        revision,
      }),
      notepadContext: {
        revision: revision.revision,
        openComments: marker,
        commentIds: currentIds,
      },
      occurredAt: revision.createdAt,
      revision: String(revision.revision),
      outcome: null,
      retrievalHandle: `cctl notepad get -- ${quoteArgument(source.id)}`,
      actorConversationId: revision.authorConversationId,
    }));
    for (const { comment } of newComments)
      facts.push({
        occurrenceId: `notepad-comment:${comment.id}`,
        eventKind: "notepad-comment-added",
        category: "activity",
        sourceTitle: title,
        summary: `${title} has a new open review comment. Read the comment before acting.`,
        sourceText: JSON.stringify({
          notepadId: source.id,
          name: notepad.name,
          comment,
        }),
        notepadContext: {
          revision: notepad.revision,
          openComments: marker,
          commentIds: [comment.id],
        },
        occurredAt: comment.createdAt,
        revision: String(comment.anchor.notepadRevision),
        outcome: null,
        retrievalHandle: `cctl notepad comment list --open -- ${quoteArgument(source.id)}`,
        actorConversationId: comment.authorConversationId,
      });
    const openIds = new Set(
      threads
        .filter(({ comment }) => comment.status === "open")
        .map(({ comment }) => comment.id),
    );
    return {
      cursor: JSON.stringify({
        revision: Math.max(
          previous.revision,
          notepad.revision,
          ...revisions.map((revision) => revision.revision),
        ),
        commentIds: [...new Set([...known, ...currentIds])],
      }),
      facts,
      missing: false,
      withdrawnOccurrenceIds: [
        ...new Set([
          ...coveredRevisions,
          ...(acceptedContext?.commentIds ?? []).map(
            (id) => `notepad-comment:${id}`,
          ),
          ...[...known]
            .filter((id) => !openIds.has(id))
            .map((id) => `notepad-comment:${id}`),
        ]),
      ],
    };
  };
}
