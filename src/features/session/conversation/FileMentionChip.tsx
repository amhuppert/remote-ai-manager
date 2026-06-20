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
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-ext={attrs.ext}
      contentEditable={false}
      title={attrs.path}
    >
      <span className="font-semibold text-cyan">@</span>
      <span className="text-text-primary">{displayName}</span>
      {attrs.ext ? (
        <span className="rounded-[3px] bg-bg-surface px-[4px] py-[1px] text-[0.7rem] text-text-tertiary lowercase">
          {attrs.ext}
        </span>
      ) : null}
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove @${attrs.path}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
