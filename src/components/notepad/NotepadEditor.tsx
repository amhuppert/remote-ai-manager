"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  AssumptionMentionNode,
  CodeFormatting,
  ConversationMentionNode,
  DecisionMentionNode,
  deserializePromptDoc,
  FileMentionNode,
  ImagePasteHandler,
  MessageMentionNode,
  NotepadImageNode,
  NotepadMentionNode,
  QuestionMentionNode,
  ReferencePicker,
  RefPasteHandler,
  RequirementMentionNode,
  serializePromptDoc,
  SpecMentionNode,
  TaskMentionNode,
  TicketMentionNode,
  pickerHasAnyMatch,
  type PickerSelection,
  type PickerTrigger,
} from "@/lib/prompt-editor";
import {
  uploadNotepadImage,
  notepadImageUrl,
} from "@/lib/notepads/image-client";
import type { NotepadImage } from "@/lib/notepads/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  ReferencePickerPopup,
  type ReferencePickerData,
  type ReferencePickerPopupHandle,
} from "@/components/session/prompt/ReferencePickerPopup";

const logger = createClientLogger("notepad-editor");

export interface NotepadEditorHandle {
  /** Serialize the current document to canonical notepad text. */
  serialize(): string;
  /**
   * Replace the document from canonical text without emitting a content
   * change — the panel applies external revisions through this, and an echo
   * back into autosave would re-persist what was just loaded.
   */
  setContent(text: string): void;
  focus(): void;
  /** The underlying Tiptap editor instance, for advanced callers. */
  editor: Editor | null;
}

export interface NotepadEditorProps {
  notepadId: string;
  /** Canonical notepad text the editor opens with. */
  initialContent: string;
  /** Fires with the serialized canonical text after every edit. */
  onContentChange(text: string): void;
  /** Enables the reference picker popup; without it `#`/`@`/`!` stay text. */
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Upload seam for pasted images; defaults to the multipart POST against the
   * notepad image route. Returning null drops the paste (nothing inserted).
   */
  uploadImage?(notepadId: string, file: File): Promise<NotepadImage | null>;
}

async function defaultUploadImage(
  notepadId: string,
  file: File,
): Promise<NotepadImage | null> {
  try {
    return await uploadNotepadImage(notepadId, file);
  } catch (error) {
    logger.warn("notepad_image_upload_failed", {
      notepadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface ReferencePickerSuggestionState {
  trigger: PickerTrigger;
  query: string;
  select: (selection: PickerSelection) => void;
  complete: (text: string) => void;
  isCaretAtQueryEnd: () => boolean;
}

/**
 * The chip-bearing notepad editing surface: the prompt editor's extension
 * stack over literal Markdown text, minus the prompt-only extensions (slash
 * commands, argument hints, terminal hotkeys, submit handling) and with
 * images as id-addressed `notepadImage` chips uploaded on paste. The user
 * types `#`, `-`, and fences as text; references and images render as chips.
 */
export const NotepadEditor = forwardRef<
  NotepadEditorHandle,
  NotepadEditorProps
>(function NotepadEditor(props, ref) {
  const {
    notepadId,
    initialContent,
    onContentChange,
    projectName,
    sessionName,
    conversationId,
    readOnly = false,
    placeholder = "Write Markdown…",
    ariaLabel = "Notepad content",
    uploadImage = defaultUploadImage,
  } = props;
  const editable = !readOnly;
  const scopeRef = useMemo(
    () => scopeRefFromStoreSessionName(sessionName),
    [sessionName],
  );

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const uploadImageRef = useRef(uploadImage);
  uploadImageRef.current = uploadImage;
  // The editor is created once; the ref keeps the live id available to the
  // paste handler without recreating the extension stack.
  const notepadIdRef = useRef(notepadId);
  notepadIdRef.current = notepadId;

  const pickerDataRef = useRef<ReferencePickerData | null>(null);
  const capturePickerData = useCallback((data: ReferencePickerData) => {
    pickerDataRef.current = data;
  }, []);
  const [pickerState, setPickerState] =
    useState<ReferencePickerSuggestionState | null>(null);
  const pickerPopupRef = useRef<ReferencePickerPopupHandle>(null);

  const editor = useEditor({
    immediatelyRender: true,
    editable,
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
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
      CodeFormatting,
      Placeholder.configure({ placeholder }),
      FileMentionNode,
      ConversationMentionNode,
      MessageMentionNode,
      TicketMentionNode,
      SpecMentionNode,
      RequirementMentionNode,
      DecisionMentionNode,
      TaskMentionNode,
      QuestionMentionNode,
      AssumptionMentionNode,
      NotepadMentionNode,
      NotepadImageNode.configure({ notepadId }),
      RefPasteHandler,
      ImagePasteHandler.configure({
        onAddImage: async (file) => {
          const image = await uploadImageRef.current(
            notepadIdRef.current,
            file,
          );
          if (!image) return null;
          return {
            attachmentId: image.id,
            thumbnailUrl: notepadImageUrl(notepadIdRef.current, image.id),
            mediaType: image.mediaType,
            fileName: image.fileName,
          };
        },
        buildNode: (result) => ({
          type: "notepadImage",
          attrs: {
            imageId: result.attachmentId,
            fileName: result.fileName ?? "",
          },
        }),
      }),
      ReferencePicker.configure({
        hasAnyMatch: (query) => {
          const data = pickerDataRef.current;
          if (data === null) return true;
          return pickerHasAnyMatch({
            query,
            trigger: "#",
            scope: "all",
            drillScope: "all",
            context: data.context,
            files: data.files,
            canOpenDocuments: data.canOpenDocuments,
          });
        },
        render: (trigger) => ({
          onStart: (suggestion) => setPickerState({ ...suggestion, trigger }),
          onUpdate: (suggestion) => setPickerState({ ...suggestion, trigger }),
          onExit: () => setPickerState(null),
          onKeyDown: ({ event }) =>
            pickerPopupRef.current?.handleKeyDown(event) ?? false,
        }),
      }),
    ],
    content: deserializePromptDoc(
      { prompt: initialContent, images: [] },
      { notepadImages: true },
    ),
    editorProps: {
      attributes: {
        class: "notepad-editor__content-inner",
        "data-testid": "notepad-editor-input",
        "aria-label": ariaLabel,
      },
    },
    onUpdate: ({ editor: ed }) => {
      onContentChangeRef.current(
        serializePromptDoc({ doc: ed.state.doc, attachments: [] }).prompt,
      );
    },
  });

  useEffect(() => {
    if (!editor) return;
    // Without emitUpdate: false this fires onUpdate at mount, echoing the
    // just-loaded content straight into the caller's autosave path.
    editor.setEditable(editable, false);
  }, [editor, editable]);

  useImperativeHandle(
    ref,
    () => ({
      serialize() {
        if (!editor) return "";
        return serializePromptDoc({ doc: editor.state.doc, attachments: [] })
          .prompt;
      },
      setContent(text) {
        editor?.commands.setContent(
          deserializePromptDoc(
            { prompt: text, images: [] },
            { notepadImages: true },
          ),
          { emitUpdate: false },
        );
      },
      focus() {
        editor?.commands.focus();
      },
      get editor() {
        return editor;
      },
    }),
    [editor],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {pickerState && projectName ? (
        <ReferencePickerPopup
          // Remounting per trigger is what makes the prefix key preselect a
          // scope: a fresh `!` starts on Tickets even after a Tab to Files.
          key={pickerState.trigger}
          ref={pickerPopupRef}
          trigger={pickerState.trigger}
          query={pickerState.query}
          currentProjectName={projectName}
          scopeRef={scopeRef}
          currentConversationId={conversationId ?? null}
          onSelect={(selection) => pickerState.select(selection)}
          onComplete={(text) => pickerState.complete(text)}
          isCaretAtQueryEnd={() => pickerState.isCaretAtQueryEnd()}
          onClose={() => setPickerState(null)}
          onDataChange={capturePickerData}
        />
      ) : null}
      <EditorContent
        editor={editor}
        className="prompt-editor__content min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-bg-base px-[16px] py-[14px] font-mono text-[0.82rem] leading-[1.7] break-words text-text-primary"
      />
    </div>
  );
});
