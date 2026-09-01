import { hasCollabPrefix } from "@/lib/conversation-commands/parse";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import {
  groupContentBlocks,
  type MessagePartRange,
} from "@/lib/conversations/group-content-blocks";
import type { DisplayMessage } from "@/hooks/conversation/use-display-messages";
export interface CollabEnvelope {
  workflowId: string;
}

/**
 * A surface-supplied row interleaved among transcript messages (e.g. the
 * project cockpit's spawn cards). The payload stays opaque to the transcript:
 * `key` keys the virtualized row, `anchorMessageIndex` places it. Surfaces
 * extend this shape with their own fields and narrow it back in their render
 * callback (the rows passed in are the rows handed back).
 */
export interface TranscriptExtensionRowData {
  /** Stable row key, unique within the transcript. */
  key: string;
  /**
   * Message index after which the row renders. Anchors before the first
   * message prepend; anchors at or beyond the last message append.
   */
  anchorMessageIndex: number;
}

export type ConversationRow =
  | {
      kind: "message";
      messageIndex: number;
      msg: DisplayMessage;
      /**
       * Which slice of the message this row renders. A message contributes one
       * row per renderable unit, so the transcript's single virtualizer bounds
       * mounted content by the viewport rather than by turn length.
       */
      part: MessagePartRange;
    }
  | { kind: "collab"; workflowId: string }
  | { kind: "extension"; ext: TranscriptExtensionRowData };

/**
 * Rewrites a message's blocks before it is split into rows. Applied once here
 * rather than per render so the part count always matches what is displayed —
 * a transform that hides blocks must not leave empty trailing rows behind.
 * Returning an empty array drops the message entirely.
 */
export type TranscriptContentTransform = (
  content: MessageContentBlock[],
  messageIndex: number,
) => MessageContentBlock[];

export function isCollabTriggerMessage(message: TranscriptMessage): boolean {
  for (const block of message.content) {
    if (block.type === "text" && hasCollabPrefix(block.text.trim())) {
      return true;
    }
    if (block.type === "command" && block.name === "/collab") {
      return true;
    }
  }
  return false;
}

export function findCollabAnchorIndex(
  messages: readonly TranscriptMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (isCollabTriggerMessage(msg)) return i;
  }
  return -1;
}

export function buildConversationRows(
  messages: readonly DisplayMessage[],
  collab: CollabEnvelope | undefined,
  hiddenMessageIndex: number | null = null,
  extensions: readonly TranscriptExtensionRowData[] = [],
  transformContent?: TranscriptContentTransform,
): ConversationRow[] {
  const isHidden = (i: number) => i === hiddenMessageIndex;

  /**
   * One row per renderable unit. An empty message still yields a single row so
   * its role header and affordances survive; a message the transform empties
   * yields none.
   */
  function messageRows(
    msg: DisplayMessage,
    messageIndex: number,
  ): ConversationRow[] {
    const content = transformContent
      ? transformContent(msg.content, messageIndex)
      : msg.content;
    // A transform that hides every block withdraws the message; a message that
    // was natively empty still renders its header and affordances.
    if (content !== msg.content && content.length === 0) return [];
    const displayed = content === msg.content ? msg : { ...msg, content };
    const count = groupContentBlocks(content).length;
    if (count <= 1) {
      return [
        {
          kind: "message",
          messageIndex,
          msg: displayed,
          part: { index: 0, count: 1, start: 0, end: count },
        },
      ];
    }
    return Array.from({ length: count }, (_unused, index) => ({
      kind: "message" as const,
      messageIndex,
      msg: displayed,
      part: { index, count, start: index, end: index + 1 },
    }));
  }

  // Bucket extension rows by anchor. Out-of-range anchors prepend/append so a
  // card can never be dropped; supplied order is kept within a shared anchor.
  const extBefore: ConversationRow[] = [];
  const extAfter: ConversationRow[] = [];
  const extByAnchor = new Map<number, ConversationRow[]>();
  for (const ext of extensions) {
    const row: ConversationRow = { kind: "extension", ext };
    if (ext.anchorMessageIndex < 0) {
      extBefore.push(row);
    } else if (ext.anchorMessageIndex >= messages.length) {
      extAfter.push(row);
    } else {
      const bucket = extByAnchor.get(ext.anchorMessageIndex);
      if (bucket) bucket.push(row);
      else extByAnchor.set(ext.anchorMessageIndex, [row]);
    }
  }

  const anchor = collab ? findCollabAnchorIndex(messages) : -1;
  const rows: ConversationRow[] = [...extBefore];
  for (let i = 0; i < messages.length; i++) {
    if (!isHidden(i)) {
      rows.push(...messageRows(messages[i]!, i));
    }
    if (collab && i === anchor) {
      rows.push({ kind: "collab", workflowId: collab.workflowId });
    }
    const bucket = extByAnchor.get(i);
    if (bucket) rows.push(...bucket);
  }
  if (collab && anchor === -1) {
    rows.push({ kind: "collab", workflowId: collab.workflowId });
  }
  rows.push(...extAfter);
  return rows;
}

/**
 * Index of the last visible message — the anchor for last-message affordances
 * (debug card, streaming styling). Skips the collab-hidden message, which a
 * rows-based "last row" check would miscount when a collab row trails the
 * transcript.
 */
export function computeLastVisibleMessageIndex(
  displayMessageCount: number,
  hiddenMessageIndex: number | null,
): number {
  for (let i = displayMessageCount - 1; i >= 0; i--) {
    if (i !== hiddenMessageIndex) return i;
  }
  return -1;
}

export function computeRowKey(row: ConversationRow): string {
  if (row.kind === "collab") {
    return row.workflowId ? `collab:${row.workflowId}` : "collab-row";
  }
  if (row.kind === "extension") {
    return `extension:${row.ext.key}`;
  }
  return `${row.messageIndex}:${row.part.index}:${row.msg.role}:${row.msg.timestamp ?? "no-ts"}`;
}

export function topmostMessageIndexForRange(
  rows: readonly ConversationRow[],
  startIndex: number,
): number {
  const safeStartIndex = Math.max(0, Math.min(startIndex, rows.length - 1));
  for (let i = safeStartIndex; i < rows.length; i++) {
    const row = rows[i];
    if (row?.kind === "message") return row.messageIndex;
  }
  for (let i = safeStartIndex - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "message") return row.messageIndex;
  }
  return 0;
}
