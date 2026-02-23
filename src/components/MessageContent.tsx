"use client";

import { memo } from "react";
import type { MessageContentBlock } from "@/types";
import MarkdownContent from "./MarkdownContent";
import { formatToolUse } from "@/lib/format-tool-use";

interface Props {
  content: MessageContentBlock[];
}

export default memo(function MessageContent({
  content,
}: Props): React.JSX.Element {
  return (
    <>
      {content.map((block, i) => {
        if (block.type === "text") {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === "command") {
          return (
            <div key={i} className="command-indicator">
              <span className="command-icon">/</span>
              <span className="command-name">{block.name}</span>
              {block.args && <span className="command-args">{block.args}</span>}
            </div>
          );
        }
        if (block.type === "image") {
          return (
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
