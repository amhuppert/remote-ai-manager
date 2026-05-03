"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  FileMention,
  ImageMarker,
  ImagePasteHandler,
  serializePromptDoc,
  SlashCommand,
  type SerializedPromptDoc,
} from "@/lib/prompt-editor";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

export interface PromptEditorHandle {
  /** Serialize the current document to `{ prompt, images }`. */
  serialize(attachments: ImageAttachment[]): SerializedPromptDoc;
  /** Clear the editor content. */
  clear(): void;
  /** Focus the editor. */
  focus(): void;
  /** Insert plain text at the current selection (used by voice input). */
  insertText(text: string): void;
  /** The underlying Tiptap editor instance, for advanced callers. */
  editor: Editor | null;
}

export interface PromptEditorProps {
  conversationId: string;
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  pendingImages: ImageAttachment[];
  onAddImage: (file: File) => Promise<ImageAttachment | null>;
  onRemoveImage: (attachmentId: string) => void;
  /**
   * Number of images already present in the conversation transcript before
   * any pending images. Used as the starting index for chip compaction so the
   * first new chip displays the correct cumulative `#N` to the user.
   */
  cumulativeImageCount: number;
  disabled?: boolean;
  readOnly?: boolean;
  title?: string;
  placeholder?: string;
  /**
   * Fires whenever the set of inline-marker `attachmentId`s in the editor doc
   * changes. The callback receives the ids in document order. Used by the page
   * to filter the strip preview so chips and thumbnails don't double-render
   * the same image.
   */
  onInlineMarkersChange?: (attachmentIds: string[]) => void;
}

/**
 * Walk all `imageMarker` nodes in document order and reassign their `index`
 * attribute so the sequence is contiguous starting at
 * `cumulativeCount + 1`. Dispatches a single transaction; bails out early
 * (without dispatching) when every chip already has its correct index.
 */
export function compactInlineIndices(
  editor: Editor,
  cumulativeCount: number,
): boolean {
  const tr = editor.state.tr;
  let counter = cumulativeCount + 1;
  let changed = false;

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "imageMarker") return undefined;
    const currentIndex = node.attrs["index"];
    if (currentIndex !== counter) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, index: counter });
      changed = true;
    }
    counter += 1;
    return false;
  });

  if (!changed) return false;
  editor.view.dispatch(tr);
  return true;
}

function collectInlineMarkerIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "imageMarker") return undefined;
    const id = node.attrs["attachmentId"];
    if (typeof id === "string" && id.length > 0) ids.push(id);
    return false;
  });
  return ids;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function notifyInlineMarkersIfChanged(
  editor: Editor,
  lastIdsRef: React.MutableRefObject<string[]>,
  callback: ((attachmentIds: string[]) => void) | undefined,
): void {
  if (!callback) return;
  const next = collectInlineMarkerIds(editor);
  if (arraysEqual(next, lastIdsRef.current)) return;
  lastIdsRef.current = next;
  callback(next);
}

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(
  function PromptEditor(props, ref) {
    const {
      value,
      onChange,
      onSubmit,
      onAddImage,
      onRemoveImage,
      cumulativeImageCount,
      disabled = false,
      readOnly = false,
      title,
      placeholder = "Type a message…",
      onInlineMarkersChange,
    } = props;
    const editable = !disabled && !readOnly;

    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onAddImageRef = useRef(onAddImage);
    onAddImageRef.current = onAddImage;
    const cumulativeRef = useRef(cumulativeImageCount);
    cumulativeRef.current = cumulativeImageCount;
    const onInlineMarkersChangeRef = useRef(onInlineMarkersChange);
    onInlineMarkersChangeRef.current = onInlineMarkersChange;
    const lastMarkerIdsRef = useRef<string[]>([]);

    const editor = useEditor({
      immediatelyRender: true,
      editable,
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          strike: false,
          underline: false,
          trailingNode: false,
        }),
        Placeholder.configure({ placeholder }),
        ImageMarker,
        ImagePasteHandler.configure({
          onAddImage: (file) =>
            onAddImageRef.current(file).then((att) =>
              att
                ? {
                    attachmentId: att.id,
                    thumbnailUrl: att.previewUrl,
                    mediaType: att.mediaType,
                    fileName: att.fileName,
                  }
                : null,
            ),
        }),
        SlashCommand.configure({
          items: () => [],
          render: () => ({}),
        }),
        FileMention.configure({
          items: () => [],
          render: () => ({}),
        }),
      ],
      content: value,
      editorProps: {
        attributes: {
          class: "prompt-editor__content-inner",
        },
        handleKeyDown: (_view, event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            onSubmitRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        compactInlineIndices(ed, cumulativeRef.current);
        onChangeRef.current(ed.getText());
        notifyInlineMarkersIfChanged(
          ed,
          lastMarkerIdsRef,
          onInlineMarkersChangeRef.current,
        );
      },
    });

    useEffect(() => {
      if (!editor) return;
      editor.setEditable(editable);
    }, [editor, editable]);

    useEffect(() => {
      if (!editor) return;
      const storage = editor.storage.imageMarker;
      if (storage) {
        storage.onRemoveAttachment = (attachmentId: string) => {
          onRemoveImage(attachmentId);
        };
      }
    }, [editor, onRemoveImage]);

    // Keep chip indices contiguous when the cumulative count shifts (e.g. a
    // prior turn was sent and the server count advanced).
    useEffect(() => {
      if (!editor) return;
      compactInlineIndices(editor, cumulativeImageCount);
    }, [editor, cumulativeImageCount]);

    useImperativeHandle(
      ref,
      () => ({
        serialize(attachments) {
          if (!editor) return { prompt: "", images: [] };
          return serializePromptDoc({
            doc: editor.state.doc,
            attachments,
          });
        },
        clear() {
          editor?.commands.clearContent(true);
        },
        focus() {
          editor?.commands.focus();
        },
        insertText(text) {
          if (!editor) return;
          editor.chain().focus().insertContent(text).run();
        },
        get editor() {
          return editor;
        },
      }),
      [editor],
    );

    return (
      <div className="prompt-editor" title={title}>
        <EditorContent editor={editor} className="prompt-editor__content" />
      </div>
    );
  },
);
