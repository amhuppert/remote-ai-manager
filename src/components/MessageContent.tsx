"use client";

import { memo, useMemo } from "react";
import type { MessageContentBlock, ToolResultMetrics } from "@/types";
import MarkdownContent from "./MarkdownContent";
import { formatToolUse } from "@/lib/format-tool-use";
import ToolUseGroup from "./ToolUseGroup";
import DebugStructuredCard from "./DebugStructuredCard";

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

export interface ToolResultLookup {
  get(
    toolUseId: string | undefined,
  ): { isError?: boolean; metrics?: ToolResultMetrics } | undefined;
}

/** Build a lookup from tool_use.id → its paired tool_result metadata. */
export function buildToolResultLookup(
  blocks: MessageContentBlock[],
): ToolResultLookup {
  const map = new Map<
    string,
    { isError?: boolean; metrics?: ToolResultMetrics }
  >();
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    map.set(block.tool_use_id, {
      ...(block.isError !== undefined ? { isError: block.isError } : {}),
      ...(block.metrics ? { metrics: block.metrics } : {}),
    });
  }
  return {
    get: (toolUseId) =>
      toolUseId === undefined ? undefined : map.get(toolUseId),
  };
}

interface Props {
  content: MessageContentBlock[];
  /** Session worktree path — used to display tool file paths as relative when nested. */
  worktreePath?: string;
}

export default memo(function MessageContent({
  content,
  worktreePath,
}: Props): React.JSX.Element {
  const grouped = useMemo(() => groupContentBlocks(content), [content]);
  const resultLookup = useMemo(() => buildToolResultLookup(content), [content]);

  return (
    <>
      {grouped.map((item) => {
        if (item.kind === "tool_group") {
          return (
            <ToolUseGroup
              key={`tg-${item.startIndex}`}
              blocks={item.blocks}
              worktreePath={worktreePath}
              resultLookup={resultLookup}
            />
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
        if (block.type === "image_marker") {
          return (
            <span key={i} className="message-image-caption">
              #{block.index}
            </span>
          );
        }
        if (block.type === "debug_structured") {
          return (
            <DebugStructuredCard
              key={i}
              phase={block.phase}
              payload={block.payload}
            />
          );
        }
        if (block.type === "tool_use") {
          const formatted = formatToolUse(block.name, block.input, {
            worktreePath,
            result: resultLookup.get(block.id),
          });
          const className = `tool-use-indicator${formatted.isError ? " tool-use-error" : ""}`;
          return (
            <div key={i} className={className}>
              <span className="tool-use-icon">
                {formatted.isError ? "\u2715" : "\u2699"}
              </span>
              <span className="tool-use-name">{formatted.name}</span>
              {formatted.context && (
                <span className="tool-use-context">{formatted.context}</span>
              )}
              {formatted.metricsLabel && (
                <span className="tool-use-metrics">
                  {formatted.metricsLabel}
                </span>
              )}
            </div>
          );
        }
        // tool_result blocks are not rendered standalone; their data is folded
        // into the paired tool_use indicator via resultLookup above.
        return null;
      })}
    </>
  );
});
