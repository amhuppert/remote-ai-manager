"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { MessageMentionAttrs } from "@/lib/prompt-editor";

const MAX_LABEL_LENGTH = 40;

function coerceAttrs(value: unknown): MessageMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return EMPTY_ATTRS;
  }
  const v = value as Record<string, unknown>;
  return {
    projectName: str(v["projectName"]),
    sessionName: str(v["sessionName"]),
    conversationId: str(v["conversationId"]),
    conversationName: str(v["conversationName"]),
    messageIndex: str(v["messageIndex"]),
    role: str(v["role"]),
    timestamp: str(v["timestamp"]),
    model: str(v["model"]),
    compacted: v["compacted"] === "true" ? "true" : "false",
    compactArtifactId: str(v["compactArtifactId"]),
    compactCreatedAt: str(v["compactCreatedAt"]),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const EMPTY_ATTRS: MessageMentionAttrs = {
  projectName: "",
  sessionName: "",
  conversationId: "",
  conversationName: "",
  messageIndex: "0",
  role: "assistant",
  timestamp: "",
  model: "",
  compacted: "false",
  compactArtifactId: "",
  compactCreatedAt: "",
};

function truncate(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

export default function MessageMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  const conversationLabel =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;
  const label = truncate(`${conversationLabel} · msg ${attrs.messageIndex}`);

  const tooltip = [attrs.projectName, attrs.sessionName]
    .filter((part) => part.length > 0)
    .join(" · ");

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-message-mention-chip=""
      contentEditable={false}
      title={tooltip}
    >
      <span className="font-semibold text-cyan">#</span>
      <span className="text-text-primary">{label}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove reference to message ${attrs.messageIndex}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
