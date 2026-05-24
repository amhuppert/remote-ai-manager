import type { TranscriptMessage } from "@/lib/conversations/schemas";
export interface CollabEnvelope {
  workflowId: string;
}

export type ConversationRow =
  | { kind: "message"; messageIndex: number; msg: TranscriptMessage }
  | { kind: "collab"; workflowId: string };

function hasCollabPrefix(text: string): boolean {
  return text === "/collab" || text.startsWith("/collab ");
}

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
  messages: readonly TranscriptMessage[],
  collab: CollabEnvelope | undefined,
): ConversationRow[] {
  if (!collab) {
    return messages.map((msg, messageIndex) => ({
      kind: "message",
      messageIndex,
      msg,
    }));
  }

  const anchor = findCollabAnchorIndex(messages);
  const rows: ConversationRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    rows.push({ kind: "message", messageIndex: i, msg: messages[i]! });
    if (i === anchor) {
      rows.push({ kind: "collab", workflowId: collab.workflowId });
    }
  }
  if (anchor === -1) {
    rows.push({ kind: "collab", workflowId: collab.workflowId });
  }
  return rows;
}

export function computeRowKey(row: ConversationRow): string {
  if (row.kind === "collab") {
    return row.workflowId ? `collab:${row.workflowId}` : "collab-row";
  }
  return `${row.messageIndex}:${row.msg.role}:${row.msg.timestamp ?? "no-ts"}`;
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
