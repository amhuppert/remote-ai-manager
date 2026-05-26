"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { ConversationMentionAttrs } from "@/lib/prompt-editor";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";

const MAX_LABEL_LENGTH = 40;

function coerceAttrs(value: unknown): ConversationMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return EMPTY_ATTRS;
  }
  const v = value as Record<string, unknown>;
  return {
    projectName: str(v["projectName"]),
    projectPath: str(v["projectPath"]),
    sessionName: str(v["sessionName"]),
    worktreePath: str(v["worktreePath"]),
    conversationId: str(v["conversationId"]),
    conversationName: str(v["conversationName"]),
    backend: v["backend"] === "codex" ? "codex" : "claude",
    backendRef: str(v["backendRef"]),
    transcriptPath: str(v["transcriptPath"]),
    debugLogPath: str(v["debugLogPath"]),
    status: coerceStatus(v["status"]),
    lastActivityAt: str(v["lastActivityAt"]),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceStatus(value: unknown): ConversationMentionAttrs["status"] {
  if (
    value === "new" ||
    value === "awaiting" ||
    value === "running" ||
    value === "waiting_for_input"
  ) {
    return value;
  }
  return "new";
}

const EMPTY_ATTRS: ConversationMentionAttrs = {
  projectName: "",
  projectPath: "",
  sessionName: "",
  worktreePath: "",
  conversationId: "",
  conversationName: "",
  backend: "claude",
  backendRef: "",
  transcriptPath: "",
  debugLogPath: "",
  status: "new",
  lastActivityAt: "",
};

function truncate(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

export default function ConversationMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  const label = truncate(
    resolveDisplayLabel({
      conversationName:
        attrs.conversationName.length > 0 ? attrs.conversationName : null,
      summary: null,
      firstPromptSnippet: null,
      conversationId: attrs.conversationId,
    }),
  );

  const tooltip = `${attrs.projectName} · ${attrs.sessionName}`;
  const removeAriaTarget =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;

  return (
    <NodeViewWrapper
      as="span"
      className="conversation-mention-chip"
      data-selected={selected ? "true" : "false"}
      data-backend={attrs.backend}
      contentEditable={false}
      title={tooltip}
    >
      <span className="conversation-mention-chip__hash">#</span>
      <span className="conversation-mention-chip__name">{label}</span>
      <button
        type="button"
        className="conversation-mention-chip__remove"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove #${removeAriaTarget}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
