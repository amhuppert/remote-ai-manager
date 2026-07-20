"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import {
  PromptEditor,
  type PromptEditorHandle,
} from "@/components/session/prompt/PromptEditor";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { useMultilineVoice } from "@/hooks/use-multiline-voice";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";
import { cn } from "@/lib/ui/cn";
import {
  resolvePromptCapabilityContext,
  type PromptCapabilityContext,
} from "./capabilities";

export interface RichPromptInputHandle {
  focus(): void;
  clear(): void;
  serialize(): SerializedPromptDoc;
  primaryAction(): void;
  isVoiceBusy(): boolean;
}

export interface RichPromptInputProps {
  id?: string;
  capabilityContext: PromptCapabilityContext;
  value: string;
  onValueChange(value: string): void;
  onSubmit(document: SerializedPromptDoc): void;
  ariaLabel: string;
  placeholder?: string;
  submitLabel: string;
  disabled?: boolean;
  readOnly?: boolean;
  title?: string;
  className?: string;
  onError?(message: string): void;
  onImagesChange?(images: ImagePayload[]): void;
  onDocumentChange?(document: SerializedPromptDoc): void;
  onVoiceStateChange?(busy: boolean): void;
  initialImages?: readonly ImagePayload[];
  showSubmitControl?: boolean;
  /** Submit even when the document is empty (e.g. optional description fields). */
  allowEmptySubmit?: boolean;
}

const actionButtonClass =
  "inline-flex h-[36px] cursor-pointer items-center justify-center rounded-sm border border-solid border-cyan bg-cyan px-[12px] font-mono text-[0.72rem] font-semibold text-text-inverse transition-[background-color,border-color] duration-150 hover:bg-cyan-dim hover:border-cyan-dim disabled:cursor-not-allowed disabled:opacity-40";

const iconButtonClass =
  "flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-transparent p-0 text-text-secondary transition-[border-color,color] duration-150 hover:border-cyan-dim hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export const RichPromptInput = forwardRef<
  RichPromptInputHandle,
  RichPromptInputProps
>(function RichPromptInput(
  {
    id,
    capabilityContext,
    value,
    onValueChange,
    onSubmit,
    ariaLabel,
    placeholder,
    submitLabel,
    disabled = false,
    readOnly = false,
    title,
    className,
    onError,
    onImagesChange,
    onDocumentChange,
    onVoiceStateChange,
    initialImages,
    showSubmitControl = true,
    allowEmptySubmit = false,
  },
  ref,
) {
  const context = resolvePromptCapabilityContext(capabilityContext);
  const editorRef = useRef<PromptEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [initialDocument] = useState<SerializedPromptDoc>(() => ({
    prompt: value,
    images: [...(initialImages ?? [])],
  }));
  const valueRef = useRef(value);
  const onImagesChangeRef = useRef(onImagesChange);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const [inlineMarkerIds, setInlineMarkerIds] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [hasSerializedText, setHasSerializedText] = useState(
    value.trim().length > 0,
  );
  const { pendingImages, addImage, clearImages, isAtLimit, removeImage } =
    useImageAttachments(initialImages);
  const didMountImagesRef = useRef(false);

  useEffect(() => {
    valueRef.current =
      editorRef.current?.serialize(pendingImages).prompt ?? value;
  }, [pendingImages, value]);
  useEffect(() => {
    onImagesChangeRef.current = onImagesChange;
  }, [onImagesChange]);
  useEffect(() => {
    onDocumentChangeRef.current = onDocumentChange;
  }, [onDocumentChange]);

  const serialize = useCallback(
    () =>
      editorRef.current?.serialize(pendingImages) ?? { prompt: "", images: [] },
    [pendingImages],
  );
  const submit = useCallback(() => {
    if (disabled || readOnly) return;
    const document = serialize();
    if (
      !allowEmptySubmit &&
      !document.prompt.trim() &&
      document.images.length === 0
    ) {
      return;
    }
    onSubmit(document);
  }, [allowEmptySubmit, disabled, onSubmit, readOnly, serialize]);
  const handleValueChange = useCallback(
    (text: string) => {
      onValueChange(text);
      const document = serialize();
      valueRef.current = document.prompt;
      setHasSerializedText(document.prompt.trim().length > 0);
      onDocumentChangeRef.current?.(document);
    },
    [onValueChange, serialize],
  );
  const voice = useMultilineVoice({
    projectName: context.projectName,
    valueRef,
    insertText: (text) => {
      editorRef.current?.insertText(text);
      const document = serialize();
      valueRef.current = document.prompt;
      return document;
    },
    focus: () => editorRef.current?.focus(),
    isFocused: focused && !disabled && !readOnly,
    onStopAndSubmit: (document) => {
      if (
        !allowEmptySubmit &&
        !document.prompt.trim() &&
        document.images.length === 0
      ) {
        return;
      }
      onSubmit(document);
    },
    hotkeyEnabled: !disabled && !readOnly,
  });
  const primaryAction = useCallback(() => {
    if (disabled || readOnly) return;
    if (voice.isRecording || voice.isProcessing) {
      voice.stopAndSubmit();
      return;
    }
    submit();
  }, [disabled, readOnly, submit, voice]);
  useEffect(() => {
    onVoiceStateChange?.(voice.isRecording || voice.isProcessing);
  }, [onVoiceStateChange, voice.isProcessing, voice.isRecording]);

  useEffect(() => {
    if (!didMountImagesRef.current) {
      didMountImagesRef.current = true;
      return;
    }
    const images = pendingImages.flatMap((image) => {
      const markerIndex = inlineMarkerIds.indexOf(image.id);
      const result = imagePayloadSchema.safeParse({
        attachmentId: image.id,
        mediaType: image.mediaType,
        base64Data: image.base64Data,
        ...(markerIndex >= 0 ? { inlineMarkerIndex: markerIndex + 1 } : {}),
      });
      return result.success ? [result.data] : [];
    });
    const document = serialize();
    valueRef.current = document.prompt;
    onImagesChangeRef.current?.(images);
    onDocumentChangeRef.current?.(document);
  }, [inlineMarkerIds, pendingImages, serialize]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editorRef.current?.focus(),
      clear: () => {
        editorRef.current?.clear();
        clearImages();
      },
      serialize,
      primaryAction,
      isVoiceBusy: () => voice.isRecording || voice.isProcessing,
    }),
    [
      clearImages,
      primaryAction,
      serialize,
      voice.isProcessing,
      voice.isRecording,
    ],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        void addImage(file).then((result) => {
          if (result.error) onError?.(result.error);
        });
      }
    },
    [addImage, onError],
  );

  return (
    <div
      className={cn("flex flex-col gap-[var(--space-sm)]", className)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <PromptEditor
        ref={editorRef}
        id={id}
        conversationId={context.conversationId}
        value={value}
        initialDocument={initialDocument}
        onChange={handleValueChange}
        onSubmit={primaryAction}
        pendingImages={pendingImages}
        onAddImage={async (file) => {
          const result = await addImage(file);
          if (result.error) {
            onError?.(result.error);
            return null;
          }
          return result.attachment;
        }}
        onRemoveImage={removeImage}
        cumulativeImageCount={0}
        onInlineMarkersChange={setInlineMarkerIds}
        projectName={context.projectName}
        sessionName={context.sessionName}
        backend={context.backend}
        isWorkflowManagedConversation={context.isWorkflowManagedConversation}
        disabled={disabled}
        readOnly={readOnly}
        title={title}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <ImageAttachmentPreview
        images={pendingImages.filter(
          (image) => !inlineMarkerIds.includes(image.id),
        )}
        onRemove={removeImage}
      />
      <div className="flex items-center gap-[var(--space-sm)]">
        <button
          type="button"
          className={iconButtonClass}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || readOnly || isAtLimit}
          title="Attach image"
          aria-label="Attach image"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </button>
        <VoiceRecordButton
          isRecording={voice.isRecording}
          isProcessing={voice.isProcessing}
          elapsedTime={voice.elapsedTime}
          isAvailable={voice.isAvailable}
          toggleRecording={voice.toggleRecording}
          disabled={disabled || readOnly}
        />
        {showSubmitControl && (
          <button
            type="button"
            className={cn(actionButtonClass, "ml-auto")}
            onClick={primaryAction}
            disabled={
              disabled ||
              readOnly ||
              (!voice.isRecording &&
                !voice.isProcessing &&
                !hasSerializedText &&
                pendingImages.length === 0)
            }
          >
            {submitLabel}
          </button>
        )}
      </div>
    </div>
  );
});
