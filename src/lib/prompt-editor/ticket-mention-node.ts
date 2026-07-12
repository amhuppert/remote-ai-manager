import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import TicketMentionChip from "@/features/session/conversation/TicketMentionChip";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";

/**
 * Node attributes are all strings so they round-trip losslessly through the
 * DOM `data-*` representation. The embedded read command is not stored — the
 * serializer re-derives it from the identifier, keeping the emitted XML
 * canonical regardless of what was pasted.
 */
export interface TicketMentionAttrs {
  projectName: string;
  /** Per-project ticket number as a decimal string. */
  ticketNumber: string;
  /** Human-facing identity, e.g. `command-center#12`. */
  identifier: string;
  title: string;
}

/** Map validated `<ticket-ref />` wire attributes onto node attributes. */
export function ticketRefAttrsToMentionAttrs(
  attrs: TicketRefAttrs,
): TicketMentionAttrs {
  return {
    projectName: attrs["project-name"],
    ticketNumber: attrs["ticket-number"],
    identifier: attrs.identifier,
    title: attrs.title,
  };
}

interface AttrSpec {
  key: keyof TicketMentionAttrs;
  dataAttr: string;
  defaultValue: string;
}

const ATTR_SPECS: AttrSpec[] = [
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
  { key: "ticketNumber", dataAttr: "data-ticket-number", defaultValue: "0" },
  { key: "identifier", dataAttr: "data-identifier", defaultValue: "" },
  { key: "title", dataAttr: "data-title", defaultValue: "" },
];

/**
 * Atomic inline node representing a pasted ticket reference in the prompt
 * editor. `serializePromptDoc` emits this as the canonical self-closing
 * `<ticket-ref ... />` XML tag with the embedded globally-valid read command;
 * deleting the chip removes the reference from the outgoing prompt.
 */
export const TicketMentionNode = Node.create({
  name: "ticketMention",

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
    return [{ tag: "span[data-ticket-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const identifier = String(HTMLAttributes["data-identifier"] ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-ticket-mention": "",
        class: "ticket-mention-chip",
      }),
      identifier,
    ];
  },

  renderText({ node }) {
    const identifier = node.attrs["identifier"];
    return typeof identifier === "string" ? identifier : "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(TicketMentionChip);
  },
});
