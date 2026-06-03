import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { SpawnCardRowData } from "./spawn-card-slot";

/**
 * A row in the project transcript: either a transcript message or an inline
 * spawn-card supplied by chat-session-spawning. Mirrors the session transcript's
 * `ConversationRow` union (message | collab) but with a `spawn-card` variant in
 * place of `collab` — the documented mount seam.
 */
export type ProjectTranscriptRow =
  | { kind: "message"; messageIndex: number; msg: TranscriptMessage }
  | SpawnCardRowData;

/**
 * Interleave spawn cards among messages at their `anchorMessageIndex`. A card
 * anchored at index N renders immediately after message N; cards anchored at or
 * beyond the last message are appended; cards anchored before the first message
 * are prepended. Message order is always preserved. Cards keep their supplied
 * order when multiple share an anchor. The card payload is never inspected
 * beyond `proposalId`/`anchorMessageIndex`.
 */
export function buildProjectTranscriptRows(
  messages: readonly TranscriptMessage[],
  spawnCards: readonly SpawnCardRowData[],
): ProjectTranscriptRow[] {
  if (spawnCards.length === 0) {
    return messages.map((msg, messageIndex) => ({
      kind: "message" as const,
      messageIndex,
      msg,
    }));
  }

  const byAnchor = new Map<number, SpawnCardRowData[]>();
  const before: SpawnCardRowData[] = [];
  const after: SpawnCardRowData[] = [];
  for (const card of spawnCards) {
    if (card.anchorMessageIndex < 0) {
      before.push(card);
    } else if (card.anchorMessageIndex >= messages.length) {
      after.push(card);
    } else {
      const bucket = byAnchor.get(card.anchorMessageIndex);
      if (bucket) bucket.push(card);
      else byAnchor.set(card.anchorMessageIndex, [card]);
    }
  }

  const rows: ProjectTranscriptRow[] = [...before];
  messages.forEach((msg, messageIndex) => {
    rows.push({ kind: "message", messageIndex, msg });
    const cards = byAnchor.get(messageIndex);
    if (cards) rows.push(...cards);
  });
  rows.push(...after);
  return rows;
}

/** Stable key for a transcript row, stable across re-renders. */
export function projectRowKey(row: ProjectTranscriptRow): string {
  if (row.kind === "spawn-card") {
    return `spawn:${row.proposalId}`;
  }
  return `${row.messageIndex}:${row.msg.role}:${row.msg.timestamp ?? "no-ts"}`;
}
