import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import ConversationMentionChip from "@/features/session/conversation/ConversationMentionChip";
import type { ConversationStatus } from "@/lib/conversations/schemas";

export interface ConversationMentionAttrs {
  projectName: string;
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  conversationId: string;
  /** Empty string when the source conversation had no name. */
  conversationName: string;
  backend: "claude" | "codex";
  /** Empty string when the source conversation has no backend session yet. */
  backendRef: string;
  /** Empty string when null. */
  transcriptPath: string;
  /** Empty string when null. */
  debugLogPath: string;
  status: ConversationStatus;
  lastActivityAt: string;
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

interface AttrSpec {
  key: keyof ConversationMentionAttrs;
  dataAttr: string;
  defaultValue: string;
}

const ATTR_SPECS: AttrSpec[] = [
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
  { key: "projectPath", dataAttr: "data-project-path", defaultValue: "" },
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
