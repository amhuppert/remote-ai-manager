import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";

type TextDeltaBlock = Extract<
  MessageContentBlock,
  { type: "text" | "thinking" }
>;

function isMergeableDelta(block: MessageContentBlock): block is TextDeltaBlock {
  return (
    block.type === "text" ||
    (block.type === "thinking" && block.redacted !== true)
  );
}

/**
 * Cursor's `run.stream()` maps `text-delta` and `thinking-delta` updates onto
 * ordinary SDK message shapes. Adjacent records of the same kind are therefore
 * fragments of one Markdown block, not separate paragraphs.
 */
export function appendCursorContentDelta(
  blocks: MessageContentBlock[],
  incoming: MessageContentBlock,
): void {
  const previous = blocks.at(-1);
  if (
    previous !== undefined &&
    isMergeableDelta(previous) &&
    isMergeableDelta(incoming) &&
    previous.type === incoming.type
  ) {
    blocks[blocks.length - 1] = {
      ...previous,
      text: previous.text + incoming.text,
    };
    return;
  }

  blocks.push({ ...incoming });
}

export function coalesceCursorContentDeltas(
  blocks: readonly MessageContentBlock[],
): MessageContentBlock[] {
  const coalesced: MessageContentBlock[] = [];
  for (const block of blocks) appendCursorContentDelta(coalesced, block);
  return coalesced;
}

export function isCursorTranscriptEntryId(entryId: unknown): boolean {
  return typeof entryId === "string" && entryId.startsWith("cursor:");
}
