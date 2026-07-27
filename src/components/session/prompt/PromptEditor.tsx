"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  ArgumentHint,
  AssumptionMentionNode,
  CodeFormatting,
  ConversationMentionNode,
  deserializePromptDoc,
  FileMention,
  FileMentionNode,
  ImageMarker,
  ImagePasteHandler,
  MessageMentionNode,
  DecisionMentionNode,
  QuestionMentionNode,
  RefPasteHandler,
  RequirementMentionNode,
  serializePromptDoc,
  SlashCommand,
  SlashCommandMarker,
  TerminalHotkeys,
  TicketShortcut,
  TicketMentionNode,
  SpecMentionNode,
  TaskMentionNode,
  UnifiedMention,
  getUnifiedMentionGroups,
  type ReferencePickerContext,
  type ReferencePickerItem,
  type SerializedPromptDoc,
  type SlashCommandTrigger,
} from "@/lib/prompt-editor";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import { skillTriggerPrefixForBackend } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  PromptEditorSlashCommandPopup,
  type SlashCommandPopupHandle,
  type SlashCommandSelection,
} from "@/components/session/prompt/PromptEditorSlashCommandPopup";
import {
  PromptEditorFileMentionPopup,
  type FileMentionPopupHandle,
  type FileMentionSelection,
} from "@/components/session/prompt/PromptEditorFileMentionPopup";
import {
  PromptEditorTicketMentionPopup,
  type TicketMentionPopupHandle,
  type TicketMentionSelection,
} from "@/components/session/prompt/PromptEditorTicketMentionPopup";
import {
  UnifiedMentionPopup,
  type UnifiedMentionPopupHandle,
} from "@/components/session/prompt/UnifiedMentionPopup";
import { HotkeyAwaitingHUD } from "@/components/hotkeys/HotkeyAwaitingHUD";
import {
  useHotkeyDispatcher,
  useHotkeySnapshot,
} from "@/components/hotkeys/HotkeyProvider";

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
  id?: string;
  conversationId?: string;
  value: string;
  initialDocument?: SerializedPromptDoc;
  onChange: (text: string) => void;
  onDocumentChange?: (document: SerializedPromptDoc) => void;
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
  ariaLabel?: string;
  placeholder?: string;
  /**
   * Fires whenever the set of inline-marker `attachmentId`s in the editor doc
   * changes. The callback receives the ids in document order. Used by the page
   * to filter the strip preview so chips and thumbnails don't double-render
   * the same image.
   */
  onInlineMarkersChange?: (attachmentIds: string[]) => void;
  /** Project context used to power the `/` command and `@` file autocompletes. */
  projectName?: string;
  sessionName?: string;
  backend?: AgentBackendId;
  /** Hides lane-ineligible built-ins (/ticket) in the slash-command popup. */
  isWorkflowManagedConversation?: boolean;
  /** Called when a selected slash command exposes an `argumentHint`. */
  onShowPlaceholder?: (text: string) => void;
}

interface SlashSuggestionState {
  triggerChar: string;
  query: string;
  command: (item: SlashCommandSelection) => void;
}

interface FileSuggestionState {
  query: string;
  command: (item: FileMentionSelection) => void;
}

interface UnifiedMentionSuggestionState {
  query: string;
  command: (item: ReferencePickerItem) => void;
}

interface TicketSuggestionState {
  query: string;
  command: (item: TicketMentionSelection) => void;
}

/**
 * Decide whether typing `char` at the start of the line should open the
 * command/skill popup for the given backend. `/` works on every backend; `$`
 * applies only to backends whose catalog entry declares it as the
 * skill-trigger prefix.
 */
export function shouldOpenSlashPopup(
  char: string,
  backend: AgentBackendId | undefined,
): boolean {
  if (char === "$") {
    return (
      backend !== undefined && skillTriggerPrefixForBackend(backend) === "$"
    );
  }
  return true;
}

function buildSlashTriggers(args: {
  backendRef: React.RefObject<AgentBackendId | undefined>;
  setSlashState: (state: SlashSuggestionState | null) => void;
  slashPopupRef: React.RefObject<SlashCommandPopupHandle | null>;
}): SlashCommandTrigger[] {
  const { backendRef, setSlashState, slashPopupRef } = args;
  // Register both trigger characters up front and decide per keystroke whether
  // the popup should open. The Tiptap editor is created once and never rebuilt,
  // so a backend value captured here would go stale when the user toggles the
  // backend (before the first message) or when the conversation's stored
  // backend loads after mount. Reading it from a ref keeps the gate live.
  const chars = ["/", "$"] as const;
  return chars.map((char) => ({
    char,
    items: () => [],
    render: () => ({
      onStart: (props) => {
        if (!shouldOpenSlashPopup(char, backendRef.current)) {
          setSlashState(null);
          return;
        }
        setSlashState({
          triggerChar: char,
          query: props.query,
          command: props.command as (item: SlashCommandSelection) => void,
        });
      },
      onUpdate: (props) => {
        if (!shouldOpenSlashPopup(char, backendRef.current)) {
          setSlashState(null);
          return;
        }
        setSlashState({
          triggerChar: char,
          query: props.query,
          command: props.command as (item: SlashCommandSelection) => void,
        });
      },
      onExit: () => {
        setSlashState(null);
      },
      onKeyDown: ({ event }) =>
        slashPopupRef.current?.handleKeyDown(event) ?? false,
    }),
  }));
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
      id,
      conversationId,
      value,
      initialDocument,
      onChange,
      onDocumentChange,
      onSubmit,
      pendingImages,
      onAddImage,
      onRemoveImage,
      cumulativeImageCount,
      disabled = false,
      readOnly = false,
      title,
      ariaLabel,
      placeholder = "Type a message…",
      onInlineMarkersChange,
      projectName,
      sessionName,
      backend,
      isWorkflowManagedConversation = false,
      onShowPlaceholder,
    } = props;
    const editable = !disabled && !readOnly;
    const generatedPromptId = useId();
    const shortcutPromptId = `prompt-${generatedPromptId}`;
    const hotkeyDispatcher = useHotkeyDispatcher();
    const hotkeySnapshot = useHotkeySnapshot();

    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onChangeRef = useRef(onChange);
    const onDocumentChangeRef = useRef(onDocumentChange);
    const pendingImagesRef = useRef(pendingImages);
    useEffect(() => {
      onChangeRef.current = onChange;
      onDocumentChangeRef.current = onDocumentChange;
      pendingImagesRef.current = pendingImages;
    }, [onChange, onDocumentChange, pendingImages]);
    const onAddImageRef = useRef(onAddImage);
    onAddImageRef.current = onAddImage;
    const cumulativeRef = useRef(cumulativeImageCount);
    cumulativeRef.current = cumulativeImageCount;
    const onInlineMarkersChangeRef = useRef(onInlineMarkersChange);
    onInlineMarkersChangeRef.current = onInlineMarkersChange;
    const lastMarkerIdsRef = useRef<string[]>([]);
    // The editor is created once; keep the current backend in a ref so the
    // slash-command triggers can read the live value without recreating it.
    const backendRef = useRef(backend);
    backendRef.current = backend;
    const pickerContextRef = useRef<ReferencePickerContext>({
      currentProjectName: projectName ?? null,
      currentConversationId: conversationId ?? null,
      conversations: [],
      tickets: [],
      specs: [],
      selectedSpec: null,
    });
    pickerContextRef.current = {
      ...pickerContextRef.current,
      currentProjectName: projectName ?? null,
      currentConversationId: conversationId ?? null,
    };

    const [slashState, setSlashState] = useState<SlashSuggestionState | null>(
      null,
    );
    const [fileState, setFileState] = useState<FileSuggestionState | null>(
      null,
    );
    const [unifiedMentionState, setUnifiedMentionState] =
      useState<UnifiedMentionSuggestionState | null>(null);
    const [ticketState, setTicketState] =
      useState<TicketSuggestionState | null>(null);
    const slashPopupRef = useRef<SlashCommandPopupHandle>(null);
    const filePopupRef = useRef<FileMentionPopupHandle>(null);
    const unifiedMentionPopupRef = useRef<UnifiedMentionPopupHandle>(null);
    const ticketPopupRef = useRef<TicketMentionPopupHandle>(null);

    useEffect(() => {
      if (
        hotkeySnapshot.mode !== "one-shot" ||
        hotkeySnapshot.promptId !== shortcutPromptId
      ) {
        return;
      }
      setSlashState(null);
      setFileState(null);
      setUnifiedMentionState(null);
      setTicketState(null);
    }, [hotkeySnapshot.mode, hotkeySnapshot.promptId, shortcutPromptId]);

    useEffect(
      () => () => {
        if (hotkeyDispatcher.getSnapshot().promptId === shortcutPromptId) {
          hotkeyDispatcher.cancel("prompt_unmounted");
        }
      },
      [hotkeyDispatcher, shortcutPromptId],
    );

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
        ImageMarker,
        SlashCommandMarker,
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
        RefPasteHandler,
        ArgumentHint,
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
          triggers: buildSlashTriggers({
            backendRef,
            setSlashState,
            slashPopupRef,
          }),
        }),
        FileMention.configure({
          items: () => [],
          render: () => ({
            onStart: (props) => {
              setFileState({
                query: props.query,
                command: props.command as (item: FileMentionSelection) => void,
              });
            },
            onUpdate: (props) => {
              setFileState({
                query: props.query,
                command: props.command as (item: FileMentionSelection) => void,
              });
            },
            onExit: () => {
              setFileState(null);
            },
            onKeyDown: ({ event }) =>
              filePopupRef.current?.handleKeyDown(event) ?? false,
          }),
        }),
        UnifiedMention.configure({
          items: ({ query }) =>
            getUnifiedMentionGroups(query, pickerContextRef.current),
          render: () => ({
            onStart: (props) => {
              setUnifiedMentionState({
                query: props.query,
                command: props.command,
              });
            },
            onUpdate: (props) => {
              setUnifiedMentionState({
                query: props.query,
                command: props.command,
              });
            },
            onExit: () => {
              setUnifiedMentionState(null);
            },
            onKeyDown: ({ event }) =>
              unifiedMentionPopupRef.current?.handleKeyDown(event) ?? false,
          }),
        }),
        TicketShortcut.configure({
          items: () => [],
          render: () => ({
            onStart: (props) => {
              setTicketState({
                query: props.query,
                command: props.command as (
                  item: TicketMentionSelection,
                ) => void,
              });
            },
            onUpdate: (props) => {
              setTicketState({
                query: props.query,
                command: props.command as (
                  item: TicketMentionSelection,
                ) => void,
              });
            },
            onExit: () => setTicketState(null),
            onKeyDown: ({ event }) =>
              ticketPopupRef.current?.handleKeyDown(event) ?? false,
          }),
        }),
        TerminalHotkeys.configure({
          onSubmit: () => onSubmitRef.current(),
        }),
      ],
      content: deserializePromptDoc(
        initialDocument ?? { prompt: value, images: [] },
      ),
      editorProps: {
        attributes: {
          class: "prompt-editor__content-inner",
          "data-testid": "prompt-input",
          "data-cc-prompt-id": shortcutPromptId,
          "aria-keyshortcuts":
            "Control+; Control+. Control+Shift+. Meta+Enter Control+Enter Control+A Control+E Control+U Control+K Control+W Alt+B Alt+F Alt+D",
          ...(id ? { id } : {}),
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        },
      },
      onUpdate: ({ editor: ed }) => {
        compactInlineIndices(ed, cumulativeRef.current);
        const document = serializePromptDoc({
          doc: ed.state.doc,
          attachments: pendingImagesRef.current,
        });
        onChangeRef.current(document.prompt);
        onDocumentChangeRef.current?.(document);
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
          editor
            .chain()
            .focus()
            .setTextSelection(editor.state.selection.head)
            .insertContent(text)
            .run();
        },
        get editor() {
          return editor;
        },
      }),
      [editor],
    );

    return (
      <div className="relative" title={title}>
        <HotkeyAwaitingHUD promptId={shortcutPromptId} />
        {slashState && projectName ? (
          <PromptEditorSlashCommandPopup
            ref={slashPopupRef}
            query={slashState.query}
            triggerChar={slashState.triggerChar}
            projectName={projectName}
            sessionName={sessionName}
            conversationId={conversationId}
            backend={backend}
            isWorkflowManagedConversation={isWorkflowManagedConversation}
            onSelect={(selection) => slashState.command(selection)}
            onShowPlaceholder={onShowPlaceholder}
            onClose={() => setSlashState(null)}
          />
        ) : null}
        {fileState && projectName ? (
          <PromptEditorFileMentionPopup
            ref={filePopupRef}
            query={fileState.query}
            projectName={projectName}
            sessionName={sessionName}
            onSelect={(selection) => fileState.command(selection)}
            onClose={() => setFileState(null)}
          />
        ) : null}
        {unifiedMentionState && projectName ? (
          <UnifiedMentionPopup
            ref={unifiedMentionPopupRef}
            query={unifiedMentionState.query}
            currentProjectName={projectName}
            currentConversationId={conversationId ?? null}
            onSelect={(selection) => unifiedMentionState.command(selection)}
            onClose={() => setUnifiedMentionState(null)}
            onPickerContextChange={(context) => {
              pickerContextRef.current = context;
            }}
          />
        ) : null}
        {ticketState && projectName ? (
          <PromptEditorTicketMentionPopup
            ref={ticketPopupRef}
            query={ticketState.query}
            currentProjectName={projectName}
            onSelect={(selection) => ticketState.command(selection)}
            onClose={() => setTicketState(null)}
          />
        ) : null}
        <EditorContent
          editor={editor}
          className="prompt-editor__content max-h-[50vh] min-h-[80px] overflow-y-auto rounded-md border border-border-default bg-bg-surface px-[14px] py-[12px] font-mono text-[0.85rem] leading-[1.5] text-text-primary transition-[border-color,box-shadow] duration-150 focus-within:border-cyan-dim focus-within:shadow-[0_0_0_3px_var(--cyan-glow)]"
        />
      </div>
    );
  },
);
