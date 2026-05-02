"use client";

import { useState, memo } from "react";
import type { MessageContentBlock } from "@/types";
import { formatToolUse } from "@/lib/format-tool-use";
import type { ToolResultLookup } from "./MessageContent";

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

  const groupClassName = [
    "tool-use-group",
    expanded ? "expanded" : "",
    hasError ? "tool-use-group-has-error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={groupClassName}>
      <button
        className="tool-use-group-header"
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        <span className="tool-use-group-icon">{"\u2699"}</span>
        <span className="tool-use-group-count">
          {count} tool use{count !== 1 ? "s" : ""}
        </span>
        <span className="tool-use-group-summary">{summary}</span>
        {hasError && (
          <span className="tool-use-group-error-flag">{"\u2715"}</span>
        )}
        <span className="tool-use-group-chevron">
          {expanded ? "\u25B2" : "\u25BC"}
        </span>
      </button>
      {expanded && (
        <div className="tool-use-group-body">
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
          })}
        </div>
      )}
    </div>
  );
});
