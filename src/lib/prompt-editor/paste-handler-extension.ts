import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { ImageMarkerAttrs } from "./image-marker-node";

export interface AddImageResult {
  attachmentId: string;
  thumbnailUrl: string;
  mediaType: string;
  fileName: string | null;
}

export interface PastedImageNode {
  type: string;
  attrs: Record<string, unknown>;
}

export interface ImagePasteHandlerOptions {
  /**
   * Add a pasted/dropped image file to the surrounding image-attachment store.
   * Returns the metadata needed to populate an `imageMarker` node, or `null`
   * if the file was rejected (over-limit, unsupported type, etc.).
   */
  onAddImage: (file: File) => Promise<AddImageResult | null>;
  /**
   * Build the node inserted for an accepted image. Defaults to the prompt
   * editor's `imageMarker`; the notepad editor swaps in its id-addressed
   * `notepadImage` node without duplicating the paste/drop plumbing.
   */
  buildNode: (result: AddImageResult) => PastedImageNode;
}

const SUPPORTED_IMAGE_RE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Tiptap extension that intercepts pasted and dropped image files. Each
 * accepted image is forwarded to `onAddImage`, and a placeholder
 * `imageMarker` node (with `index: 0`) is inserted at the drop/paste
 * position. Index reassignment is the responsibility of the caller — the
 * parent editor runs `compactInlineIndices` after every transaction that
 * touches `imageMarker` nodes.
 */
export const ImagePasteHandler = Extension.create<ImagePasteHandlerOptions>({
  name: "imagePasteHandler",

  addOptions() {
    return {
      onAddImage: async () => null,
      buildNode: (result: AddImageResult): PastedImageNode => ({
        type: "imageMarker",
        attrs: {
          index: 0,
          attachmentId: result.attachmentId,
          mediaType: result.mediaType,
          thumbnailUrl: result.thumbnailUrl,
          fileName: result.fileName,
        } satisfies ImageMarkerAttrs,
      }),
    };
  },

  addProseMirrorPlugins() {
    const { onAddImage, buildNode } = this.options;

    return [
      new Plugin({
        key: new PluginKey("imagePasteHandler"),
        props: {
          handlePaste(view, event) {
            const items = event.clipboardData?.items;
            if (!items) return false;

            const imageFiles = collectImageFilesFromClipboard(items);
            if (imageFiles.length === 0) return false;

            void insertAfterAdd(
              view,
              imageFiles,
              onAddImage,
              buildNode,
              view.state.selection.from,
            );
            event.preventDefault();
            return true;
          },

          handleDrop(view, event) {
            const dt = event.dataTransfer;
            if (!dt || dt.files.length === 0) return false;

            const imageFiles: File[] = [];
            for (const file of Array.from(dt.files)) {
              if (SUPPORTED_IMAGE_RE.test(file.type)) {
                imageFiles.push(file);
              }
            }
            if (imageFiles.length === 0) return false;

            const coords = { left: event.clientX, top: event.clientY };
            const pos =
              view.posAtCoords(coords)?.pos ?? view.state.doc.content.size;

            void insertAfterAdd(view, imageFiles, onAddImage, buildNode, pos);
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});

function collectImageFilesFromClipboard(items: DataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (!SUPPORTED_IMAGE_RE.test(item.type)) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function insertAfterAdd(
  view: import("@tiptap/pm/view").EditorView,
  files: File[],
  onAddImage: ImagePasteHandlerOptions["onAddImage"],
  buildNode: ImagePasteHandlerOptions["buildNode"],
  insertPos: number,
): Promise<void> {
  let pos = insertPos;
  for (const file of files) {
    const result = await onAddImage(file);
    if (!result) continue;

    const node = buildNode(result);
    const nodeType = view.state.schema.nodes[node.type];
    if (!nodeType) return;

    const tr = view.state.tr.insert(pos, nodeType.create(node.attrs));
    view.dispatch(tr);
    pos += 1;
  }
}
