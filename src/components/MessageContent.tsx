"use client";

import { memo, useMemo } from "react";
import type { MessageContentBlock } from "@/types";
import MarkdownContent from "./MarkdownContent";
import { formatToolUse } from "@/lib/format-tool-use";
import ToolUseGroup from "./ToolUseGroup";

/** Minimum consecutive tool_use blocks required to form a collapsed group */
const GROUP_THRESHOLD = 2;

type GroupedItem =
  | { kind: "block"; block: MessageContentBlock; index: number }
  | { kind: "tool_group"; blocks: MessageContentBlock[]; startIndex: number };

/** Group consecutive tool_use/tool_result blocks together. */
function groupContentBlocks(blocks: MessageContentBlock[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let pending: MessageContentBlock[] = [];
  let pendingStart = 0;

  function flushPending() {
    if (pending.length === 0) return;
    const toolUseCount = pending.filter((b) => b.type === "tool_use").length;
    if (toolUseCount >= GROUP_THRESHOLD) {
      result.push({
        kind: "tool_group",
        blocks: pending,
        startIndex: pendingStart,
      });
    } else {
      // Not enough to group — emit individually
      for (let j = 0; j < pending.length; j++) {
        result.push({
          kind: "block",
          block: pending[j]!,
          index: pendingStart + j,
        });
      }
    }
    pending = [];
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type === "tool_use" || block.type === "tool_result") {
      if (pending.length === 0) pendingStart = i;
      pending.push(block);
    } else {
      flushPending();
      result.push({ kind: "block", block, index: i });
    }
  }
  flushPending();
  return result;
}

interface Props {
  content: MessageContentBlock[];
}

export default memo(function MessageContent({
  content,
}: Props): React.JSX.Element {
  const grouped = useMemo(() => groupContentBlocks(content), [content]);

  return (
    <>
      {grouped.map((item) => {
        if (item.kind === "tool_group") {
          return (
            <ToolUseGroup key={`tg-${item.startIndex}`} blocks={item.blocks} />
          );
        }

        const { block, index: i } = item;

        if (block.type === "text") {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === "command") {
          return (
            <div key={i} className="command-indicator">
              <span className="command-name">{block.name}</span>
              {block.args && <span className="command-args">{block.args}</span>}
            </div>
          );
        }
        if (block.type === "image") {
          return (
            // eslint-disable-next-line @next/next/no-img-element -- base64 data URLs
            <img
              key={i}
              src={`data:${block.mediaType};base64,${block.base64Data}`}
              alt="Attached image"
              className="message-inline-image"
            />
          );
        }
        if (block.type === "tool_use") {
          const formatted = formatToolUse(
            block.name,
            block.input as Record<string, unknown> | undefined,
          );
          return (
            <div key={i} className="tool-use-indicator">
              <span className="tool-use-icon">{"\u2699"}</span>
              <span className="tool-use-name">{formatted.name}</span>
              {formatted.context && (
                <span className="tool-use-context">{formatted.context}</span>
              )}
            </div>
          );
        }
        // tool_result blocks are not rendered
        return null;
      })}
    </>
  );
});
