"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { FileMentionAttrs } from "@/lib/prompt-editor";

function coerceAttrs(value: unknown): FileMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return { path: "", basename: "", ext: "" };
  }
  const v = value as Record<string, unknown>;
  return {
    path: typeof v["path"] === "string" ? v["path"] : "",
    basename: typeof v["basename"] === "string" ? v["basename"] : "",
    ext: typeof v["ext"] === "string" ? v["ext"] : "",
  };
}

export default function FileMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  const displayName = attrs.basename.length > 0 ? attrs.basename : attrs.path;

  return (
    <NodeViewWrapper
      as="span"
      className="file-mention-chip"
      data-selected={selected ? "true" : "false"}
      data-ext={attrs.ext}
      contentEditable={false}
      title={attrs.path}
    >
      <span className="file-mention-chip__at">@</span>
      <span className="file-mention-chip__name">{displayName}</span>
      {attrs.ext ? (
        <span className="file-mention-chip__ext">{attrs.ext}</span>
      ) : null}
      <button
        type="button"
        className="file-mention-chip__remove"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove @${attrs.path}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
