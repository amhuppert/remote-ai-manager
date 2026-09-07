import type { MessageContentBlock } from "@/lib/conversations/schemas";

/**
 * One renderable unit of a message's content.
 *
 * Consecutive tool and thinking blocks coalesce into a single group, so this
 * list — not the raw block array — is the message's true render granularity.
 * The transcript splits a message into one virtualized row per item (see
 * `buildConversationRows`), which is what keeps a long agent turn from
 * mounting its whole scrollback at once (command-center#97).
 */
export type GroupedItem =
  | { kind: "block"; block: MessageContentBlock; index: number }
  | { kind: "tool_group"; blocks: MessageContentBlock[]; startIndex: number }
  | {
      kind: "thinking_group";
      block: CombinedThinkingBlock;
      startIndex: number;
    };

type ThinkingContentBlock = Extract<MessageContentBlock, { type: "thinking" }>;

export interface CombinedThinkingBlock {
  text: string;
  redacted: boolean;
  redactedCount: number;
}

/** Group consecutive tool_use/tool_result blocks together. */
export function groupContentBlocks(
  blocks: readonly MessageContentBlock[],
): GroupedItem[] {
  const result: GroupedItem[] = [];
  let pending: MessageContentBlock[] = [];
  let pendingStart = 0;
  let pendingThinking: ThinkingContentBlock[] = [];
  let pendingThinkingStart = 0;

  function flushPending() {
    if (pending.length === 0) return;
    const toolUseCount = pending.filter((b) => b.type === "tool_use").length;
    if (toolUseCount > 0) {
      result.push({
        kind: "tool_group",
        blocks: pending,
        startIndex: pendingStart,
      });
    }
    pending = [];
  }

  function flushThinking() {
    if (pendingThinking.length === 0) return;
    const visibleText = pendingThinking
      .filter((block) => !block.redacted && block.text.length > 0)
      .map((block) => block.text);
    const redactedCount = pendingThinking.filter(
      (block) => block.redacted,
    ).length;
    result.push({
      kind: "thinking_group",
      block: {
        text: visibleText.join("\n\n"),
        redacted: visibleText.length === 0 && redactedCount > 0,
        redactedCount,
      },
      startIndex: pendingThinkingStart,
    });
    pendingThinking = [];
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type === "tool_use" || block.type === "tool_result") {
      flushThinking();
      if (pending.length === 0) pendingStart = i;
      pending.push(block);
    } else if (block.type === "thinking") {
      flushPending();
      if (pendingThinking.length === 0) pendingThinkingStart = i;
      pendingThinking.push(block);
    } else {
      flushPending();
      flushThinking();
      // Standalone results and blank text have no visible body. They stay in
      // the source blocks for metadata lookups, but cannot own virtual rows.
      if (block.type !== "text" || block.text.trim().length > 0) {
        result.push({ kind: "block", block, index: i });
      }
    }
  }
  flushPending();
  flushThinking();
  return result;
}

/**
 * The slice of a message's grouped content that one transcript row renders.
 *
 * `index === 0` carries the message's role header; the final part carries the
 * per-message affordances (actions, debug card) and any trailing file cards.
 */
export interface MessagePartRange {
  index: number;
  count: number;
  /** Grouped-item slice, `[start, end)`. */
  start: number;
  end: number;
}

/** The single part covering a message that is not split. */
export function wholeMessagePart(groupedCount: number): MessagePartRange {
  return { index: 0, count: 1, start: 0, end: groupedCount };
}
