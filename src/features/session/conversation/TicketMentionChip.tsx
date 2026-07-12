"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { TicketMentionAttrs } from "@/lib/prompt-editor";

const MAX_TITLE_LENGTH = 32;

function coerceAttrs(value: unknown): TicketMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return EMPTY_ATTRS;
  }
  const v = value as Record<string, unknown>;
  return {
    projectName: str(v["projectName"]),
    ticketNumber: str(v["ticketNumber"]),
    identifier: str(v["identifier"]),
    title: str(v["title"]),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const EMPTY_ATTRS: TicketMentionAttrs = {
  projectName: "",
  ticketNumber: "0",
  identifier: "",
  title: "",
};

function truncate(label: string): string {
  if (label.length <= MAX_TITLE_LENGTH) return label;
  return label.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

function TicketGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      aria-hidden="true"
      className="h-[12px] w-[12px] shrink-0 text-cyan"
    >
      <path d="M2 5.75A1.25 1.25 0 0 1 3.25 4.5h9.5A1.25 1.25 0 0 1 14 5.75v1a1.75 1.75 0 0 0 0 3.5v1a1.25 1.25 0 0 1-1.25 1.25h-9.5A1.25 1.25 0 0 1 2 11.25v-1a1.75 1.75 0 0 0 0-3.5z" />
      <path d="M6.5 4.5v8" strokeDasharray="1.5 1.5" />
    </svg>
  );
}

export default function TicketMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  const label =
    attrs.title.length > 0
      ? `${attrs.identifier} · ${truncate(attrs.title)}`
      : attrs.identifier;

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-ticket-mention-chip=""
      contentEditable={false}
      title={attrs.title}
    >
      <TicketGlyph />
      <span className="text-text-primary">{label}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove ticket ${attrs.identifier}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
