import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import MessageMentionChip from "@/features/session/conversation/MessageMentionChip";
import type { MessageRefAttrs } from "@/lib/conversations/schemas";

/**
 * Node attributes are all strings so they round-trip losslessly through the
 * DOM `data-*` representation; empty string means "absent".
 */
export interface MessageMentionAttrs {
  projectName: string;
  /** Empty string for project-scoped conversations with no owning session. */
  sessionName: string;
  conversationId: string;
  /** Empty string when the source conversation had no name. */
  conversationName: string;
  /** 0-based visible-message index as a decimal string. */
  messageIndex: string;
  role: string;
  timestamp: string;
  model: string;
  /** "true" when a completed message compaction covers the message. */
  compacted: string;
  compactArtifactId: string;
  compactCreatedAt: string;
}

/** Map validated `<message-ref />` wire attributes onto node attributes. */
export function messageRefAttrsToMentionAttrs(
  attrs: MessageRefAttrs,
): MessageMentionAttrs {
  return {
    projectName: attrs["project-name"],
    sessionName: attrs["session-name"] ?? "",
    conversationId: attrs["conversation-id"],
    conversationName: attrs["conversation-name"] ?? "",
    messageIndex: attrs["message-index"],
    role: attrs.role,
    timestamp: attrs.timestamp ?? "",
    model: attrs.model ?? "",
    compacted: attrs.compacted ?? "false",
    compactArtifactId: attrs["compact-artifact-id"] ?? "",
    compactCreatedAt: attrs["compact-created-at"] ?? "",
  };
}

interface AttrSpec {
  key: keyof MessageMentionAttrs;
  dataAttr: string;
  defaultValue: string;
}

const ATTR_SPECS: AttrSpec[] = [
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
  { key: "sessionName", dataAttr: "data-session-name", defaultValue: "" },
  { key: "conversationId", dataAttr: "data-conversation-id", defaultValue: "" },
  {
    key: "conversationName",
    dataAttr: "data-conversation-name",
    defaultValue: "",
  },
  { key: "messageIndex", dataAttr: "data-message-index", defaultValue: "0" },
  { key: "role", dataAttr: "data-role", defaultValue: "assistant" },
  { key: "timestamp", dataAttr: "data-timestamp", defaultValue: "" },
  { key: "model", dataAttr: "data-model", defaultValue: "" },
  { key: "compacted", dataAttr: "data-compacted", defaultValue: "false" },
  {
    key: "compactArtifactId",
    dataAttr: "data-compact-artifact-id",
    defaultValue: "",
  },
  {
    key: "compactCreatedAt",
    dataAttr: "data-compact-created-at",
    defaultValue: "",
  },
];

/**
 * Atomic inline node representing a pasted message reference in the prompt
 * editor. `serializePromptDoc` emits this as a self-closing
 * `<message-ref ... />` XML tag carrying locating metadata plus ready-to-run
 * cctl commands so the agent can read the referenced message (and its
 * compaction, when one exists).
 */
export const MessageMentionNode = Node.create({
  name: "messageMention",

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
    return [{ tag: "span[data-message-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const conversationLabel =
      String(HTMLAttributes["data-conversation-name"] ?? "") ||
      String(HTMLAttributes["data-conversation-id"] ?? "");
    const index = String(HTMLAttributes["data-message-index"] ?? "0");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-message-mention": "",
        class: "message-mention-chip",
      }),
      `#${conversationLabel} · msg ${index}`,
    ];
  },

  renderText() {
    return " ";
  },

  addNodeView() {
    return ReactNodeViewRenderer(MessageMentionChip);
  },
});
