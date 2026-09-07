/**
 * Delivery watermarks for notepad change notices (R21, D17).
 *
 * A watermark records, per conversation and notepad, the state last presented
 * to the agent. It is written when the backend accepts a message carrying
 * the reference content, and read back by prompt assembly to
 * decide whether anything has changed since.
 *
 * Everything here is content-free: revisions and comment counts, never notepad
 * text or a comment body.
 */

import type {
  NotepadDeliveryWatermark,
  NotepadAuthorKind,
  NotepadOpenCommentMarker,
} from "./schemas";
import { buildNotepadReadCommand } from "./references";
import type { NotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import type {
  NotepadDeliveryWatermarksRepo,
  RecordNotepadDeliveryWatermarkInput,
} from "@/lib/state-store/notepad-delivery-watermarks-repo";
import type { NotepadsRepo } from "@/lib/state-store/notepads-repo";

/** One notepad as rendered, including the comment activity the message carried. */
export interface NotepadDeliveryRecord {
  notepadId: string;
  revision: number;
  openComments: NotepadOpenCommentMarker;
}

/** One notepad's change-relevant state as it stands today. */
export interface NotepadDeliveryState {
  id: string;
  name: string;
  revision: number;
  /**
   * Who wrote the head revision. Null only when the head revision row cannot
   * be read: a notice states what it knows rather than inventing an author.
   */
  authorKind: NotepadAuthorKind | null;
  openComments: NotepadOpenCommentMarker;
}

/** A tracked notepad: what the conversation last saw, beside what is true now. */
export interface TrackedNotepadDelivery {
  seen: NotepadDeliveryWatermark;
  current: NotepadDeliveryState;
}

export interface NotepadDeliveryTrackerDeps {
  watermarks: NotepadDeliveryWatermarksRepo;
  /** One notepad's current state; null when the notepad is gone. */
  readDeliveryState(notepadId: string): Promise<NotepadDeliveryState | null>;
  now(): string;
}

export interface NotepadDeliveryTracker {
  /**
   * Record that these notepads have now been delivered to the conversation.
   * The recorded revision is the one the message actually carried, not a
   * re-read, so a write landing between expansion and recording cannot make
   * the agent look as though it had seen the newer content.
   */
  recordDelivered(input: {
    conversationId: string;
    notepads: readonly NotepadDeliveryRecord[];
  }): Promise<void>;
  /**
   * The read seam prompt assembly consumes: every notepad this conversation
   * has been shown, paired with its state today. A notepad that no longer
   * exists is omitted — its watermark cascades away with it, and a deleted
   * notepad has nothing left to re-read.
   */
  listTracked(conversationId: string): Promise<TrackedNotepadDelivery[]>;
  /**
   * Build the transient notice for the next agent-delivered message of this
   * conversation. Reads only — the watermarks it names advance in `settle`,
   * once the backend has actually accepted the message carrying the notice.
   */
  prepare(
    conversationId: string,
    references?: readonly NotepadDeliveryRecord[],
  ): Promise<PreparedNotepadChangeNotice>;
  /**
   * Advance the watermarks the prepared notice named. Called only after the
   * backend accepts the delivery, so a failure before acceptance leaves the
   * watermarks where they were and the notice re-fires on the next message
   * (D17: at-least-once, duplicates tolerated, never silently lost).
   */
  settle(notice: PreparedNotepadChangeNotice): Promise<void>;
}

/** What changed about one notepad since the conversation last saw it. */
export interface NotepadChange {
  notepadId: string;
  name: string;
  revision: number;
  authorKind: NotepadAuthorKind | null;
  contentChanged: boolean;
  newOpenComments: boolean;
  openCommentCount: number;
}

/** A notice, plus the watermark advances acceptance of it would justify. */
export interface PreparedNotepadChangeNotice {
  conversationId: string;
  /** The transient agent-facing block, or null when nothing changed. */
  block: string | null;
  advances: readonly RecordNotepadDeliveryWatermarkInput[];
}

/**
 * Whether the notepad has open comments the conversation has not been shown.
 *
 * Ordered by `(newest open comment, how many are open)` because both move only
 * one way when a comment is ADDED: resolving or deleting one lowers the count
 * and can only lower the newest timestamp, so neither reads as new activity.
 * That asymmetry is the point — R21.3 fires on new open comments, and a user
 * clearing their own review must not summon a notice.
 */
export function hasNewOpenComments(
  seen: NotepadOpenCommentMarker,
  current: NotepadOpenCommentMarker,
): boolean {
  if (current.latestCreatedAt === null) return false;
  if (seen.latestCreatedAt === null) return current.count > 0;
  if (current.latestCreatedAt > seen.latestCreatedAt) return true;
  return (
    current.latestCreatedAt === seen.latestCreatedAt &&
    current.count > seen.count
  );
}

/** Header values are one line each, so a multi-line name cannot break the block. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderChange(change: NotepadChange): string {
  const changed = [
    ...(change.contentChanged ? ["content"] : []),
    ...(change.newOpenComments ? ["comments"] : []),
  ].join(", ");
  return [
    "<notepad-change>",
    `id: ${change.notepadId}`,
    `name: ${singleLine(change.name)}`,
    `revision: ${change.revision}`,
    `changed: ${changed}`,
    // Only a content change has an author to name; a comment-only change is
    // reported by its activity instead of by whoever last wrote the content.
    ...(change.contentChanged && change.authorKind !== null
      ? [`changed-by: ${change.authorKind}`]
      : []),
    ...(change.newOpenComments
      ? [`open-comments: ${change.openCommentCount}`]
      : []),
    `read: ${buildNotepadReadCommand(change.notepadId)}`,
    "</notepad-change>",
  ].join("\n");
}

/**
 * Render the changed notepads as one transient, agent-facing block. It names
 * versions and points at the read command; it never carries the changed
 * content, which is the whole reason the notice exists (D17).
 */
export function buildNotepadChangeNoticeBlock(
  changes: readonly NotepadChange[],
): string | null {
  if (changes.length === 0) return null;
  return [
    "<notepad-changes>",
    "Notepads this conversation was given have changed since it saw them. The",
    "changed content is NOT included — re-read any you still rely on.",
    ...changes.map(renderChange),
    "</notepad-changes>",
  ].join("\n");
}

/**
 * The production read of one notepad's change-relevant state. Reads are direct
 * over the repos — like the image service's — because nothing here is an
 * enforcement decision the notepad service owns: it is the head row, the head
 * revision's author, and a counted open-comment marker.
 */
export function createNotepadDeliveryStateReader(deps: {
  repo: NotepadsRepo;
  comments: NotepadCommentsRepo;
}): (notepadId: string) => Promise<NotepadDeliveryState | null> {
  return async (notepadId) => {
    const notepad = await deps.repo.find(notepadId);
    if (notepad === null) return null;
    const head = await deps.repo.findRevision(notepadId, notepad.revision);
    return {
      id: notepad.id,
      name: notepad.name,
      revision: notepad.revision,
      authorKind: head?.authorKind ?? null,
      openComments: await deps.comments.openCommentMarker(notepadId),
    };
  };
}

export function createNotepadDeliveryTracker(
  deps: NotepadDeliveryTrackerDeps,
): NotepadDeliveryTracker {
  async function listTracked(
    conversationId: string,
  ): Promise<TrackedNotepadDelivery[]> {
    const seen = await deps.watermarks.listForConversation(conversationId);
    const tracked: TrackedNotepadDelivery[] = [];
    for (const watermark of seen) {
      const current = await deps.readDeliveryState(watermark.notepadId);
      if (current === null) continue;
      tracked.push({ seen: watermark, current });
    }
    return tracked;
  }

  return {
    async recordDelivered({ conversationId, notepads }) {
      for (const notepad of notepads) {
        await deps.watermarks.record({
          conversationId,
          notepadId: notepad.notepadId,
          revision: notepad.revision,
          openComments: notepad.openComments,
          updatedAt: deps.now(),
        });
      }
    },

    listTracked,

    async prepare(conversationId, references = []) {
      const changes: NotepadChange[] = [];
      const advances: RecordNotepadDeliveryWatermarkInput[] = [];
      const now = deps.now();
      const tracked = new Map(
        (await listTracked(conversationId)).map((entry) => [
          entry.seen.notepadId,
          entry,
        ]),
      );
      for (const reference of references) {
        const current =
          tracked.get(reference.notepadId)?.current ??
          (await deps.readDeliveryState(reference.notepadId));
        if (current === null) continue;
        tracked.set(reference.notepadId, {
          current,
          seen: { ...reference, conversationId, updatedAt: now },
        });
      }
      for (const { seen, current } of tracked.values()) {
        // Rename, pin, and archive move none of these, so organization never
        // produces a notice — a read returns exactly what it returned before.
        const contentChanged = current.revision > seen.revision;
        const newOpenComments = hasNewOpenComments(
          seen.openComments,
          current.openComments,
        );
        if (!contentChanged && !newOpenComments) continue;
        changes.push({
          notepadId: current.id,
          name: current.name,
          revision: current.revision,
          authorKind: current.authorKind,
          contentChanged,
          newOpenComments,
          openCommentCount: current.openComments.count,
        });
        advances.push({
          conversationId,
          notepadId: current.id,
          revision: current.revision,
          openComments: current.openComments,
          updatedAt: now,
        });
      }
      return {
        conversationId,
        block: buildNotepadChangeNoticeBlock(changes),
        advances,
      };
    },

    async settle(notice) {
      for (const advance of notice.advances) {
        await deps.watermarks.record(advance);
      }
    },
  };
}
