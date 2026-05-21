import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import FileMentionChip from "@/app/projects/[name]/[session]/FileMentionChip";

export interface FileMentionAttrs {
  path: string;
  basename: string;
  ext: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileMentionNode: {
      insertFileMention: (attrs: FileMentionAttrs) => ReturnType;
    };
  }
}

/**
 * Atomic inline node representing a selected file path in the prompt editor.
 * `serializePromptDoc` emits this as `@<path>` so the agent receives the same
 * literal token it did before chips existed.
 */
export const FileMentionNode = Node.create({
  name: "fileMention",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      path: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-path") ?? "",
        renderHTML: (attributes) => ({
          "data-path": String(attributes["path"] ?? ""),
        }),
      },
      basename: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-basename") ?? "",
        renderHTML: (attributes) => ({
          "data-basename": String(attributes["basename"] ?? ""),
        }),
      },
      ext: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-ext") ?? "",
        renderHTML: (attributes) => ({
          "data-ext": String(attributes["ext"] ?? ""),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-file-mention]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-file-mention": "",
        class: "file-mention-chip",
      }),
      `@${HTMLAttributes["data-path"] ?? ""}`,
    ];
  },

  renderText({ node }) {
    const path = node.attrs["path"];
    return typeof path === "string" && path.length > 0 ? `@${path}` : "";
  },

  addCommands() {
    return {
      insertFileMention:
        (attrs: FileMentionAttrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileMentionChip);
  },
});
