"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { LiveReferenceChip } from "@/components/references/LiveReferenceChip";
import { buildConversationRefXml } from "@/lib/conversations/conversation-ref";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type {
  ConversationMentionAttrs,
  ConversationMentionFields,
} from "@/lib/conversations/schemas";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

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
  return (
    <Wrapper
      {...wrapperTagProps}
      title={`${attrs.projectName} · ${attrs.scope === "session" ? attrs.sessionName : "project"}${attrs.backend === null ? " · unknown agent backend" : ""}`}
      contentEditable={false}
      data-backend={attrs.backend ?? undefined}
      data-backend-unknown={attrs.backend === null ? "true" : undefined}
    >
      <LiveReferenceChip
        target={{
          kind: "conversation",
          projectName: attrs.projectName,
          id: attrs.conversationId,
        }}
        title={attrs.conversationName}
        identity={attrs.conversationId}
        selected={selected}
        onRemove={onRemove}
        reference={buildConversationRefXml(attrs)}
      />
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
