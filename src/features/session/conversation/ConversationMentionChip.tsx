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
    compactArtifactId: str(v["compactArtifactId"]),
    compactStatus: coerceCompactStatus(v["compactStatus"]),
    compactCoveredSeq: str(v["compactCoveredSeq"]),
    compactCreatedAt: str(v["compactCreatedAt"]),
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

function coerceCompactStatus(
  value: unknown,
): ConversationMentionAttrs["compactStatus"] {
  if (value === "fresh" || value === "stale") return value;
  return "none";
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
  compactArtifactId: "",
  compactStatus: "none",
  compactCoveredSeq: "",
  compactCreatedAt: "",
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
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[backend=codex]:border-violet-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] data-[backend=claude]:data-[selected=true]:border-cyan-dim max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-backend={attrs.backend}
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
        aria-label={`Remove #${removeAriaTarget}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
