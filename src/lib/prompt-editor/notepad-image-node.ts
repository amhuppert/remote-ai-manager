import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import NotepadImageChip from "@/components/notepad/NotepadImageChip";
import { buildNotepadImageToken } from "./notepad-image-token";

export interface NotepadImageNodeOptions {
  /**
   * The open notepad. The chip resolves its thumbnail through this notepad's
   * image route; the id is not a node attribute because canonical text stores
   * only the image id and every image in a document belongs to one notepad.
   */
  notepadId: string;
}

/**
 * Atomic inline node representing an embedded notepad image. Serializes as
 * the id-addressed token `[Image: <image-id>]` in canonical notepad text;
 * deleting the chip removes the token while the uploaded bytes stay durable
 * (a restored revision may re-reference them).
 */
export const NotepadImageNode = Node.create<NotepadImageNodeOptions>({
  name: "notepadImage",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { notepadId: "" };
  },

  addAttributes() {
    return {
      imageId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-image-id") ?? "",
        renderHTML: (attributes) => ({
          "data-image-id": String(attributes["imageId"] ?? ""),
        }),
      },
      fileName: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-file-name") ?? "",
        renderHTML: (attributes) => {
          const fileName = attributes["fileName"];
          if (typeof fileName !== "string" || fileName.length === 0) return {};
          return { "data-file-name": fileName };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-notepad-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-notepad-image": "",
        class: "notepad-image-chip",
      }),
      buildNotepadImageToken(String(HTMLAttributes["data-image-id"] ?? "")),
    ];
  },

  renderText({ node }) {
    const imageId = node.attrs["imageId"];
    return buildNotepadImageToken(typeof imageId === "string" ? imageId : "");
  },

  addNodeView() {
    return ReactNodeViewRenderer(NotepadImageChip);
  },
});
