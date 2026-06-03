"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import BackendToggle from "@/components/BackendToggle";
import ModelSelector, { getModelsForBackend } from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  getEffortLevelsForBackend,
  type EffortLevel,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { ProjectPromptError } from "@/lib/project-conversations-client/mutations";
import {
  computeSuggestions,
  type Suggestion,
} from "../components/command-suggestions";
import type { FilterToken } from "../components/filter-tokens";
import { detectComposerMode } from "./detect-composer-mode";
import { parseFilterDraft, replaceTokenByCat } from "./parse-filter-draft";
import ComposerModeChip from "./ComposerModeChip";
import ComposerSuggestions from "./ComposerSuggestions";
import "./styles/composer.css";

export interface UnifiedComposerSendInput {
  text: string;
  images: ImagePayload[];
  backend: AgentBackendId;
  modelId: string;
  effort?: string;
}

export interface UnifiedComposerProps {
  projectName: string;
  /** `null` ⇒ first-run; a chat send issues create-and-send (PLC-5). */
  activeConversationId: string | null;
  activeConversation: ConversationState | undefined;
  agentBackend: AgentBackendId;
  /** Disabled (presented fixed) once the conversation is initialized. */
  onAgentChange: (next: AgentBackendId) => void;
  tokens: FilterToken[];
  /** Shared with the sessions panel's filter popover. */
  onTokensChange: (next: FilterToken[]) => void;
  sessions: SessionListItem[];
  archivedCount: number;
  onSendPrompt: (input: UnifiedComposerSendInput) => void;
  onRunCommand: (id: "new" | "capabilities" | "workflow-builder") => void;
  busy: boolean;
  error?: ProjectPromptError | null;
  onDismissError?: () => void;
}

const DEFAULT_EFFORT: EffortLevel = "high";

function PaperclipGlyph(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function SendGlyph(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function defaultModelFor(backend: AgentBackendId): string {
  return getModelsForBackend(backend)[0]?.id ?? "";
}

function addFilterToken(tokens: FilterToken[], s: Suggestion): FilterToken[] {
  if (s.kind !== "filter") return tokens;
  return replaceTokenByCat(tokens, {
    cat: s.cat,
    key: s.key,
    value: s.value,
    ...(s.exclusive !== undefined ? { exclusive: s.exclusive } : {}),
  });
}

export default function UnifiedComposer({
  projectName,
  activeConversationId,
  activeConversation,
  agentBackend,
  onAgentChange,
  tokens,
  onTokensChange,
  sessions,
  archivedCount,
  onSendPrompt,
  onRunCommand,
  busy,
  error,
  onDismissError,
}: UnifiedComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [modelPref, setModelPref] = useState(() =>
    defaultModelFor(agentBackend),
  );
  const [effortPref, setEffortPref] = useState<EffortLevel>(DEFAULT_EFFORT);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;
  const mode = detectComposerMode(draft);

  // Derive the effective model/effort during render so changing the backend
  // (which can be driven externally by the active conversation) self-corrects
  // an unsupported selection without a state-syncing effect.
  const modelOptions = useMemo(
    () => getModelsForBackend(agentBackend).map((m) => m.id),
    [agentBackend],
  );
  const selectedModel = modelOptions.includes(modelPref)
    ? modelPref
    : (modelOptions[0] ?? "");

  const availableEffortLevels = useMemo(
    () => getEffortLevelsForBackend(agentBackend, selectedModel),
    [agentBackend, selectedModel],
  );
  const effortSupported = availableEffortLevels.length > 0;
  const selectedEffort = availableEffortLevels.includes(effortPref)
    ? effortPref
    : (availableEffortLevels[0] ?? DEFAULT_EFFORT);

  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();

  const voice = useVoiceRecorder({
    projectName,
    onResult: (text) => setDraft((d) => (d ? `${d} ${text}` : text)),
    onError: () => {
      /* surfaced by the recorder UI; composer stays usable */
    },
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // `computeSuggestions` matches bare words, not the `key:value` colon syntax,
  // so in filter mode we feed it the post-colon value (e.g. `is:run` → `run`)
  // and keep only filter suggestions; command mode passes the `/…` draft as-is.
  const suggestionQuery =
    mode === "filter" ? draft.slice(draft.indexOf(":") + 1) : draft;
  const suggestions = useMemo<Suggestion[]>(() => {
    const all = computeSuggestions({
      draft: suggestionQuery,
      tokens,
      sessions,
      archivedCount,
    });
    return mode === "filter" ? all.filter((s) => s.kind === "filter") : all;
  }, [suggestionQuery, mode, tokens, sessions, archivedCount]);
  const showSuggestions =
    focused &&
    (mode === "command" || mode === "filter") &&
    suggestions.length > 0;
  // Clamp the highlight into range during render (suggestions shrink as the
  // draft changes); typing resets it to the top via the change handler.
  const activeIndexSafe =
    suggestions.length > 0 ? Math.min(activeIndex, suggestions.length - 1) : 0;

  const sendDisabled = busy || (!draft.trim() && pendingImages.length === 0);

  const doSend = useCallback(() => {
    if (sendDisabled) return;
    // Validate each attachment at the boundary — only well-formed image
    // payloads (recognized media type) reach the send envelope.
    const images: ImagePayload[] = pendingImages.flatMap((a) => {
      const parsed = imagePayloadSchema.safeParse({
        attachmentId: a.id,
        mediaType: a.mediaType,
        base64Data: a.base64Data,
      });
      return parsed.success ? [parsed.data] : [];
    });
    onSendPrompt({
      text: draft.trim(),
      images,
      backend: agentBackend,
      modelId: selectedModel,
      ...(effortSupported ? { effort: selectedEffort } : {}),
    });
    setDraft("");
    clearImages();
  }, [
    sendDisabled,
    pendingImages,
    onSendPrompt,
    draft,
    agentBackend,
    selectedModel,
    effortSupported,
    selectedEffort,
    clearImages,
  ]);

  const applySuggestion = useCallback(
    (s: Suggestion) => {
      if (s.kind === "action") {
        setDraft("");
        onRunCommand(s.id);
        return;
      }
      onTokensChange(addFilterToken(tokens, s));
      setDraft("");
    },
    [onRunCommand, onTokensChange, tokens],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Backspace" && draft === "" && tokens.length > 0) {
        onTokensChange(tokens.slice(0, -1));
        return;
      }
      if (showSuggestions) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          const target = suggestions[activeIndexSafe];
          if (target) {
            e.preventDefault();
            applySuggestion(target);
          }
          return;
        }
      }
      if (mode === "filter" && e.key === "Enter" && !e.shiftKey) {
        // No highlighted suggestion (e.g. `archived:true`) — parse the draft.
        const token = parseFilterDraft(draft);
        if (token) {
          e.preventDefault();
          onTokensChange(replaceTokenByCat(tokens, token));
          setDraft("");
        }
        return;
      }
      if (mode === "chat" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
        return;
      }
      if (e.key === "Escape") {
        textareaRef.current?.blur();
      }
    },
    [
      draft,
      tokens,
      onTokensChange,
      showSuggestions,
      suggestions,
      activeIndexSafe,
      applySuggestion,
      mode,
      doSend,
    ],
  );

  const placeholder =
    mode === "command"
      ? "Run a command…"
      : mode === "filter"
        ? "Filter sessions — key:value"
        : activeConversationId === null
          ? "Message the project — Enter to start a conversation"
          : "Message the conversation — Enter to send, Shift+Enter for newline";

  return (
    <div
      className="plc-uc"
      data-mode={mode}
      data-agent={agentBackend}
      data-focused={focused}
    >
      <div className="plc-uc-field" data-mode={mode} data-agent={agentBackend}>
        <ComposerModeChip mode={mode} agent={agentBackend} />
        <textarea
          ref={textareaRef}
          className="plc-uc-textarea"
          value={draft}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Project composer"
        />
      </div>

      {showSuggestions && (
        <ComposerSuggestions
          suggestions={suggestions}
          activeIndex={activeIndexSafe}
          onApply={applySuggestion}
          onHoverIndex={setActiveIndex}
        />
      )}

      {pendingImages.length > 0 && (
        <ImageAttachmentPreview images={pendingImages} onRemove={removeImage} />
      )}

      {error && (
        <div className="plc-uc-error" role="alert">
          <span>{error.message}</span>
          {onDismissError && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onDismissError}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="plc-uc-toolbar">
        <BackendToggle
          value={agentBackend}
          onChange={onAgentChange}
          readOnly={backendLocked}
        />
        <ModelSelector
          value={selectedModel}
          onChange={setModelPref}
          backend={agentBackend}
        />
        <ReasoningLevelSelector
          value={selectedEffort}
          onChange={setEffortPref}
          availableLevels={availableEffortLevels}
          disabled={!effortSupported}
        />
        <button
          type="button"
          className="btn-icon-only"
          aria-label="Attach image"
          data-tooltip="Attach image"
          disabled={isAtLimit}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipGlyph />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files;
            if (files) {
              for (const f of Array.from(files)) void addImage(f);
            }
            e.target.value = "";
          }}
        />
        <VoiceRecordButton
          isRecording={voice.isRecording}
          isProcessing={voice.isProcessing}
          elapsedTime={voice.elapsedTime}
          isAvailable={voice.isAvailable}
          toggleRecording={voice.toggleRecording}
        />
        <span className="plc-uc-toolbar-spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm plc-uc-send"
          aria-label="Send prompt"
          disabled={sendDisabled}
          onClick={doSend}
        >
          <SendGlyph />
        </button>
      </div>
    </div>
  );
}
