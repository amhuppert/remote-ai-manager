"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type {
  ConversationMentionAttrs,
  ConversationMentionFields,
} from "@/lib/conversations/schemas";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";
import { truncate } from "@/lib/shared/truncate";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";

const MAX_LABEL_LENGTH = 40;

/**
 * Node attributes as the chip renders them: the backend id is parsed through
 * the canonical schema, so an id outside it is carried as null and rendered
 * as an explicit unknown-backend state — never coerced to a default backend.
 *
 * Scope stays discriminated (D1): a project chip has no `sessionName` field, so
 * its tooltip cannot render a stale or sentinel session name.
 */
export type ConversationMentionChipAttrs = Omit<
  ConversationMentionFields,
  "backend"
> & { backend: AgentBackendId | null } & ConversationScopeRef;

export function coerceMentionAttrs(
  value: unknown,
): ConversationMentionChipAttrs {
  if (typeof value !== "object" || value === null) {
    return EMPTY_ATTRS;
  }
  const v = value as Record<string, unknown>;
  const backend = agentBackendSchema.safeParse(v["backend"]);
  return {
    ...coerceScopeRef(v),
    projectName: str(v["projectName"]),
    projectPath: str(v["projectPath"]),
    worktreePath: str(v["worktreePath"]),
    conversationId: str(v["conversationId"]),
    conversationName: str(v["conversationName"]),
    backend: backend.success ? backend.data : null,
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

/**
 * Lift the node's FLAT attribute bag — TipTap stores `scope` and `sessionName`
 * as separate string attributes — back into the discriminated scope union.
 * Not a wire-compat path: `conversationRefAttrsSchema` requires `scope`, so a
 * ref without one never reaches a chip.
 */
function coerceScopeRef(v: Record<string, unknown>): ConversationScopeRef {
  return v["scope"] === "project"
    ? { scope: "project" }
    : { scope: "session", sessionName: str(v["sessionName"]) };
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

const EMPTY_ATTRS: ConversationMentionChipAttrs = {
  projectName: "",
  projectPath: "",
  scope: "session",
  sessionName: "",
  worktreePath: "",
  conversationId: "",
  conversationName: "",
  backend: null,
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

export function ConversationMentionChipBody({
  attrs,
  selected,
  onRemove,
  as: Wrapper = "span",
}: {
  attrs: ConversationMentionChipAttrs;
  selected: boolean;
  onRemove: () => void;
  /** NodeViewWrapper in the editor; a plain span in tests. */
  as?: React.ElementType;
}): React.JSX.Element {
  // NodeViewWrapper picks its rendered tag from an `as` prop; a native span
  // must not receive one.
  const wrapperTagProps = Wrapper === "span" ? {} : { as: "span" };
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove();
  };

  const label = truncate(
    resolveDisplayLabel({
      conversationName:
        attrs.conversationName.length > 0 ? attrs.conversationName : null,
      summary: null,
      firstPromptSnippet: null,
      conversationId: attrs.conversationId,
    }),
    MAX_LABEL_LENGTH,
    { countEllipsisInBudget: true },
  );

  // The scope's user-visible name: the session name, or "project" for a
  // session-less project conversation — never an empty segment (R1.3).
  const scopeLabel = attrs.scope === "session" ? attrs.sessionName : "project";
  const tooltip =
    attrs.backend === null
      ? `${attrs.projectName} · ${scopeLabel} · unknown agent backend`
      : `${attrs.projectName} · ${scopeLabel}`;
  const removeAriaTarget =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;

  return (
    <Wrapper
      {...wrapperTagProps}
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[backend-unknown=true]:border-amber-dim data-[backend=codex]:border-violet-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] data-[backend=claude]:data-[selected=true]:border-cyan-dim max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-backend={attrs.backend ?? undefined}
      data-backend-unknown={attrs.backend === null ? "true" : undefined}
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
    </Wrapper>
  );
}

export default function ConversationMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  return (
    <ConversationMentionChipBody
      attrs={coerceMentionAttrs(node.attrs)}
      selected={selected}
      onRemove={deleteNode}
      as={NodeViewWrapper}
    />
  );
}
