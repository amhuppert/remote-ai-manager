import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import ImageMarkerChip from "@/components/session/prompt/ImageMarkerChip";

export interface ImageMarkerAttrs {
  index: number;
  attachmentId: string;
  mediaType: string;
  thumbnailUrl: string;
  fileName: string | null;
}

/**
 * Editor-scoped storage published by the ImageMarker extension. The host
 * (`PromptEditor`) sets `onRemoveAttachment` so that chip clicks can notify
 * the parent's `useImageAttachments` state to drop the underlying attachment
 * after the node is removed from the doc.
 */
export interface ImageMarkerStorage {
  onRemoveAttachment: ((attachmentId: string) => void) | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageMarker: {
      insertImageMarker: (attrs: ImageMarkerAttrs) => ReturnType;
    };
  }
  interface Storage {
    imageMarker: ImageMarkerStorage;
  }
}

/**
 * Atomic inline node representing a `[Image #N]` chip in the prompt editor.
 *
 * The chip is the source-of-truth for an image's inline position; the
 * matching `ImageAttachment` (paired by `attachmentId`) supplies the bytes
 * and preview URL. The numeric `index` is reassigned by `compactInlineIndices`
 * after every paste/remove so chips remain contiguous in document order
 * starting at the conversation's cumulative image count.
 */
export const ImageMarker = Node.create({
  name: "imageMarker",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addStorage() {
    return {
      onRemoveAttachment: null,
    } satisfies ImageMarkerStorage;
  },

  addAttributes() {
    return {
      index: {
        default: 0,
        parseHTML: (element) =>
          Number.parseInt(element.getAttribute("data-index") ?? "0", 10),
        renderHTML: (attributes) => ({
          "data-index": String(attributes["index"] ?? 0),
        }),
      },
      attachmentId: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-attachment-id") ?? "",
        renderHTML: (attributes) => ({
          "data-attachment-id": String(attributes["attachmentId"] ?? ""),
        }),
      },
      mediaType: {
        default: "image/png",
        parseHTML: (element) =>
          element.getAttribute("data-media-type") ?? "image/png",
        renderHTML: (attributes) => ({
          "data-media-type": String(attributes["mediaType"] ?? "image/png"),
        }),
      },
      thumbnailUrl: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-thumbnail-url") ?? "",
        renderHTML: () => ({}),
      },
      fileName: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-file-name"),
        renderHTML: (attributes) => {
          const fileName = attributes["fileName"];
          if (typeof fileName !== "string" || fileName.length === 0) return {};
          return { "data-file-name": fileName };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-image-marker]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-image-marker": "",
        class: "image-marker-chip",
      }),
      `[Image #${HTMLAttributes["data-index"] ?? 0}]`,
    ];
  },

  renderText({ node }) {
    const index = node.attrs["index"];
    return `[Image #${typeof index === "number" ? index : 0}]`;
  },

  addCommands() {
    return {
      insertImageMarker:
        (attrs: ImageMarkerAttrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageMarkerChip);
  },
});
