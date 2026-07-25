import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import ConversationMentionChip from "@/features/session/conversation/ConversationMentionChip";
import type {
  ConversationMentionAttrs,
  ConversationMentionFields,
  ConversationRefAttrs,
} from "@/lib/conversations/schemas";

export type { ConversationMentionAttrs };

/**
 * Map validated `<conversation-ref />` wire attributes onto node attributes.
 * `transcript-path` is not carried on the wire (the serializer omits it), so
 * it defaults to empty — it round-trips losslessly since re-serialization
 * omits it too.
 */
export function conversationRefAttrsToMentionAttrs(
  attrs: ConversationRefAttrs,
): ConversationMentionAttrs {
  return {
    ...(attrs.scope === "session"
      ? { scope: "session" as const, sessionName: attrs["session-name"] }
      : { scope: "project" as const }),
    projectName: attrs["project-name"],
    projectPath: attrs["project-path"],
    worktreePath: attrs["worktree-path"],
    conversationId: attrs["conversation-id"],
    conversationName: attrs["conversation-name"],
    backend: attrs.backend,
    backendRef: attrs["backend-ref"],
    transcriptPath: "",
    debugLogPath: attrs["debug-log-path"],
    status: attrs.status,
    lastActivityAt: attrs["last-activity-at"],
    compactArtifactId: attrs["compact-artifact-id"] ?? "",
    compactStatus: attrs["compact-status"] ?? "none",
    compactCoveredSeq: attrs["compact-covered-seq"] ?? "",
    compactCreatedAt: attrs["compact-created-at"] ?? "",
  };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    conversationMentionNode: {
      insertConversationMention: (
        attrs: ConversationMentionAttrs,
      ) => ReturnType;
    };
  }
}

/**
 * The node's FLAT attribute storage. TipTap requires a string-keyed bag with a
 * default per key, so the scope-discriminated public contract is denormalized
 * here — a project mention still stores `sessionName: ""`. Editor-internal: the
 * serializer drops that key at project scope, so the empty value never reaches
 * the wire contract.
 */
type ConversationMentionNodeAttrKey =
  | keyof ConversationMentionFields
  | "scope"
  | "sessionName";

interface AttrSpec {
  key: ConversationMentionNodeAttrKey;
  dataAttr: string;
  defaultValue: string;
}

const ATTR_SPECS: AttrSpec[] = [
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
  { key: "projectPath", dataAttr: "data-project-path", defaultValue: "" },
  { key: "scope", dataAttr: "data-scope", defaultValue: "session" },
  { key: "sessionName", dataAttr: "data-session-name", defaultValue: "" },
  { key: "worktreePath", dataAttr: "data-worktree-path", defaultValue: "" },
  { key: "conversationId", dataAttr: "data-conversation-id", defaultValue: "" },
  {
    key: "conversationName",
    dataAttr: "data-conversation-name",
    defaultValue: "",
  },
  { key: "backend", dataAttr: "data-backend", defaultValue: "claude" },
  { key: "backendRef", dataAttr: "data-backend-ref", defaultValue: "" },
  { key: "transcriptPath", dataAttr: "data-transcript-path", defaultValue: "" },
  { key: "debugLogPath", dataAttr: "data-debug-log-path", defaultValue: "" },
  { key: "status", dataAttr: "data-status", defaultValue: "new" },
  {
    key: "lastActivityAt",
    dataAttr: "data-last-activity-at",
    defaultValue: "",
  },
  {
    key: "compactArtifactId",
    dataAttr: "data-compact-artifact-id",
    defaultValue: "",
  },
  {
    key: "compactStatus",
    dataAttr: "data-compact-status",
    defaultValue: "none",
  },
  {
    key: "compactCoveredSeq",
    dataAttr: "data-compact-covered-seq",
    defaultValue: "",
  },
  {
    key: "compactCreatedAt",
    dataAttr: "data-compact-created-at",
    defaultValue: "",
  },
];

/**
 * Atomic inline node representing a selected conversation reference in the
 * prompt editor. `serializePromptDoc` emits this as a self-closing
 * `<conversation-ref ... />` XML tag carrying full metadata so the agent
 * can read the referenced conversation's transcript.
 */
export const ConversationMentionNode = Node.create({
  name: "conversationMention",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    const attrs: Record<
      string,
      {
        default: string;
        parseHTML: (element: HTMLElement) => string;
        renderHTML: (
          attributes: Record<string, unknown>,
        ) => Record<string, string>;
      }
    > = {};
    for (const spec of ATTR_SPECS) {
      attrs[spec.key] = {
        default: spec.defaultValue,
        parseHTML: (element) =>
          element.getAttribute(spec.dataAttr) ?? spec.defaultValue,
        renderHTML: (attributes) => ({
          [spec.dataAttr]: String(attributes[spec.key] ?? spec.defaultValue),
        }),
      };
    }
    return attrs;
  },

  parseHTML() {
    return [{ tag: "span[data-conversation-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const label =
      String(HTMLAttributes["data-conversation-name"] ?? "") ||
      String(HTMLAttributes["data-conversation-id"] ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-conversation-mention": "",
        class: "conversation-mention-chip",
      }),
      `#${label}`,
    ];
  },

  renderText() {
    return " ";
  },

  addCommands() {
    return {
      insertConversationMention:
        (attrs: ConversationMentionAttrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ConversationMentionChip);
  },
});
