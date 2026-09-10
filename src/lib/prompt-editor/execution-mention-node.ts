import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ExecutionRefEditorChip } from "@/components/references/ExecutionRefChips";

const fields = [
  "project-name",
  "session-name",
  "execution-id",
  "title",
] as const;
export const ExecutionMentionNode = Node.create({
  name: "executionMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return Object.fromEntries(
      fields.map((key) => [
        key,
        {
          default: "",
          parseHTML: (element: HTMLElement) =>
            element.getAttribute(`data-${key}`) ?? "",
          renderHTML: (attrs: Record<string, unknown>) => ({
            [`data-${key}`]: String(attrs[key] ?? ""),
          }),
        },
      ]),
    );
  },
  parseHTML() {
    return [{ tag: "span[data-execution-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-execution-mention": "" }),
      String(HTMLAttributes["data-title"] ?? ""),
    ];
  },
  renderText({ node }) {
    return String(node.attrs.title ?? "");
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExecutionRefEditorChip);
  },
});
