"use client";

import { useState, memo } from "react";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { formatToolUse } from "@/lib/conversations/format-tool-use";
import { cn } from "@/lib/ui/cn";
import { ChevronDownIcon } from "@/components/icons";
import { ToolUseIndicator, type ToolResultLookup } from "./MessageContent";

interface Props {
  /** The tool_use and tool_result blocks in this group */
  blocks: MessageContentBlock[];
  /** Session worktree path — used to display tool file paths as relative when nested. */
  worktreePath?: string;
  /** Lookup from tool_use.id → paired tool_result metadata (isError, metrics). */
  resultLookup: ToolResultLookup;
}

export default memo(function ToolUseGroup({
  blocks,
  worktreePath,
  resultLookup,
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Only count visible tool_use blocks (tool_result renders nothing)
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
  const count = toolUseBlocks.length;
  const hasError = toolUseBlocks.some((b) => {
    if (b.type !== "tool_use") return false;
    return resultLookup.get(b.id)?.isError === true;
  });

  // Build a summary of unique tool names
  const uniqueNames = [
    ...new Set(
      toolUseBlocks.map((b) => {
        if (b.type !== "tool_use") return "";
        return formatToolUse(
          b.name,
          b.input as Record<string, unknown> | undefined,
        ).name;
      }),
    ),
  ].filter(Boolean);

  const summary =
    uniqueNames.length <= 3
      ? uniqueNames.join(", ")
      : `${uniqueNames.slice(0, 3).join(", ")} +${uniqueNames.length - 3}`;

  return (
    <div
      className={cn(
        "my-sm overflow-hidden rounded-sm border-y-0 border-r-0 border-l-2 border-solid bg-bg-raised",
        hasError ? "border-l-red" : "border-l-cyan-dim",
      )}
    >
      <button
        aria-expanded={expanded}
        className="group flex min-h-[30px] w-full cursor-pointer items-center gap-[6px] border-none bg-transparent px-sm py-[6px] font-mono text-[0.75rem] text-text-secondary transition-[background,color] duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary"
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        <span
          className={cn(
            "shrink-0 text-[0.85rem]",
            hasError ? "text-red" : "text-cyan-dim",
          )}
        >
          {"\u2699"}
        </span>
        <span className="shrink-0 font-semibold text-text-primary">
          {count} tool use{count !== 1 ? "s" : ""}
        </span>
        <span className="min-w-0 overflow-hidden text-[0.72rem] font-normal text-ellipsis whitespace-nowrap text-text-tertiary">
          {summary}
        </span>
        {hasError && (
          <span className="ml-xs shrink-0 text-[0.85rem] text-red">
            {"\u2715"}
          </span>
        )}
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 text-text-tertiary transition-[color,transform] duration-150 ease-[ease] group-hover:text-text-secondary",
            expanded && "rotate-180",
          )}
        >
          <ChevronDownIcon size={13} />
        </span>
      </button>
      {expanded && (
        <div className="px-sm pt-0 pb-xs">
          {blocks.map((block, i) => {
            if (block.type !== "tool_use") return null;
            const formatted = formatToolUse(
              block.name,
              block.input as Record<string, unknown> | undefined,
              {
                worktreePath,
                result: resultLookup.get(block.id),
              },
            );
            return <ToolUseIndicator key={i} formatted={formatted} nested />;
          })}
        </div>
      )}
    </div>
  );
});
