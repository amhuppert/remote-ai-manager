import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { NotepadRefEditorChip } from "@/components/references/NotepadRefChips";
import type { NotepadRefAttrs } from "@/lib/notepads/schemas";

/**
 * Node attributes are all strings so they round-trip losslessly through the
 * DOM `data-*` representation. The embedded read command is not stored — the
 * serializer re-derives it from the id, keeping the emitted XML canonical
 * regardless of what was pasted. `name` is the capture-time display snapshot;
 * the chip resolves the live name by id and only falls back to this.
 */
export interface NotepadMentionAttrs {
  notepadId: string;
  name: string;
  /** `global` or `project` — mirrors the notepad's scope. */
  scope: string;
  /** Empty string for a global notepad. */
  projectName: string;
}

/** Map validated `<notepad-ref />` wire attributes onto node attributes. */
export function notepadRefAttrsToMentionAttrs(
  attrs: NotepadRefAttrs,
): NotepadMentionAttrs {
  return {
    notepadId: attrs["notepad-id"],
    name: attrs.name,
    scope: attrs.scope,
    projectName: attrs["project-name"] ?? "",
  };
}

interface AttrSpec {
  key: keyof NotepadMentionAttrs;
  dataAttr: string;
  defaultValue: string;
}

const ATTR_SPECS: AttrSpec[] = [
  { key: "notepadId", dataAttr: "data-notepad-id", defaultValue: "" },
  { key: "name", dataAttr: "data-name", defaultValue: "" },
  { key: "scope", dataAttr: "data-scope", defaultValue: "global" },
  { key: "projectName", dataAttr: "data-project-name", defaultValue: "" },
];

/**
 * Atomic inline node representing a notepad reference in the prompt editor.
 * `serializePromptDoc` emits this as the canonical self-closing
 * `<notepad-ref ... />` XML tag with the embedded globally-valid read command;
 * deleting the chip removes the reference from the outgoing prompt.
 */
export const NotepadMentionNode = Node.create({
  name: "notepadMention",

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
    return [{ tag: "span[data-notepad-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const name = String(HTMLAttributes["data-name"] ?? "");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-notepad-mention": "",
        class: "notepad-mention-chip",
      }),
      name,
    ];
  },

  renderText({ node }) {
    const name = node.attrs["name"];
    return typeof name === "string" ? name : "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(NotepadRefEditorChip);
  },
});
