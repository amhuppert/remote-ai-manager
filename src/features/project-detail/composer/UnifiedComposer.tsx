"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PromptComposer, {
  type ComposerQueueTurnState,
} from "@/components/session/prompt/PromptComposer";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { deserializePromptDoc } from "@/lib/prompt-editor";
import { useVoiceWiring } from "@/hooks/use-voice-wiring";
import { useClearInputHotkey } from "@/hooks/use-clear-input-hotkey";
import {
  backendSupportsFastMode,
  getDefaultModelForBackend,
  getEffortLevelsForBackend,
  isSelectableModelForBackend,
} from "@/lib/agent-backends/catalog";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { seedAgentTwoDraft } from "@/stores/collaboration.store";
import { Button } from "@/components/ui/Button";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { usePendingPromptPersistence } from "@/hooks/use-pending-prompt-persistence";
import { useCodexFastMode } from "@/hooks/use-codex-fast-mode";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { projectConversationTarget } from "@/lib/conversations/conversation-target";
import {
  effortLevelSchema,
  type EffortLevel,
} from "@/lib/agent-backends/schemas";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { ProjectPromptError } from "@/lib/project-conversations-client/mutations";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import type { FilterToken } from "../components/filter-tokens";
import { detectComposerMode } from "./detect-composer-mode";
import { parseFilterDraft, replaceTokenByCat } from "./parse-filter-draft";

export interface UnifiedComposerSendInput {
  text: string;
  images: ImagePayload[];
  backend: AgentBackendId;
  modelId: string;
  effort?: string;
  codexFastMode?: boolean;
}

/**
 * Whether the server took a submission. `"rejected"` covers a refusal (busy,
 * not running, unsupported backend), a transport failure, and a duplicate the
 * client dropped — every case where nothing was recorded and the user's text
 * would otherwise be gone.
 */
export type UnifiedComposerSendResult = "accepted" | "rejected";

export interface UnifiedComposerProps {
  projectName: string;
  /** `null` => first-run; a chat send issues create-and-send (PLC-5). */
  activeConversationId: string | null;
  activeConversation: ConversationState | undefined;
  agentBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
  /** Disabled (presented fixed) once the conversation is initialized. */
  onAgentChange: (next: AgentBackendId) => void;
  tokens: FilterToken[];
  /** Shared with the sessions panel's filter popover. */
  onTokensChange: (next: FilterToken[]) => void;
  sessions: SessionListItem[];
  archivedCount: number;
  /**
   * Submit the composed message. Reporting the outcome is what lets the composer
   * hand the text back on a refusal instead of clearing it into nothing (R6.1).
   */
  onSendPrompt: (
    input: UnifiedComposerSendInput,
  ) => Promise<UnifiedComposerSendResult>;
  /**
   * Durable queue and server-reported turn state for the active conversation.
   * Drives the pending-message chips, their cancellation, and whether the send
   * button offers to queue rather than send.
   */
  queueTurnState?: ComposerQueueTurnState;
  /**
   * The tab's in-memory composer document, lifted so a closed-and-reopened tab
   * comes back with what was typed in it. Distinct from the conversation's
   * persisted draft below, which is what survives a reload.
   */
  initialDocument?: SerializedPromptDoc;
  onDocumentChange?: (document: SerializedPromptDoc) => void;
  onRunCommand: (id: "new" | "capabilities" | "workflow-builder") => void;
  lastUsedModelId?: string;
  lastUsedEffort?: string;
  lastUsedCodexFastMode?: boolean;
  busy: boolean;
  error?: ProjectPromptError | null;
  onDismissError?: () => void;
}

type ProjectCommandId = "new" | "capabilities" | "workflow-builder";

export type ProjectComposerSubmitResult =
  | { kind: "noop" }
  | { kind: "command"; id: ProjectCommandId }
  | { kind: "tokens"; tokens: FilterToken[] }
  | { kind: "send"; input: UnifiedComposerSendInput };

const DEFAULT_EFFORT: EffortLevel = "high";

/**
 * The attachment scope for the create-and-send path, which has no conversation
 * id yet. Prefixed apart from the conversation keys so it can never collide with
 * one.
 */
const NEW_CONVERSATION_ATTACHMENT_SCOPE = "new-conversation";

function modelForBackend(
  backend: AgentBackendId,
  preferred: string | undefined,
  backendDefaults: BackendSelectionDefaultsById,
): string {
  if (
    preferred !== undefined &&
    isSelectableModelForBackend(backend, preferred)
  ) {
    return preferred;
  }
  const fallback = backendDefaults[backend].modelId;
  return isSelectableModelForBackend(backend, fallback)
    ? fallback
    : getDefaultModelForBackend(backend);
}

function parseEffort(value: string | undefined): EffortLevel | undefined {
  if (value === undefined) return undefined;
  const result = effortLevelSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function pickEffort(
  availableLevels: readonly EffortLevel[],
  preferred: EffortLevel,
): EffortLevel {
  if (availableLevels.length === 0) return preferred;
  if (availableLevels.includes(preferred)) return preferred;
  return availableLevels.includes(DEFAULT_EFFORT)
    ? DEFAULT_EFFORT
    : availableLevels[0]!;
}

function parseCommandDraft(draft: string): ProjectCommandId | null {
  const command = draft.trim();
  if (command === "/") return "new";
  if (command === "/new") return "new";
  if (command === "/capabilities") return "capabilities";
  if (command === "/workflow-builder") return "workflow-builder";
  return null;
}

export function resolveProjectComposerSubmit({
  draft,
  pendingImages,
  tokens,
  backend,
  modelId,
  effort,
  effortSupported,
  codexFastMode,
}: {
  draft: string;
  pendingImages: ImagePayload[];
  tokens: FilterToken[];
  backend: AgentBackendId;
  modelId: string;
  effort: EffortLevel;
  effortSupported: boolean;
  codexFastMode?: boolean;
}): ProjectComposerSubmitResult {
  const trimmed = draft.trim();
  if (!trimmed && pendingImages.length === 0) return { kind: "noop" };

  const mode = detectComposerMode(trimmed);
  if (mode === "command") {
    const id = parseCommandDraft(trimmed);
    if (id) return { kind: "command", id };
  }

  if (mode === "filter") {
    const token = parseFilterDraft(trimmed);
    if (token) {
      return { kind: "tokens", tokens: replaceTokenByCat(tokens, token) };
    }
  }

  return {
    kind: "send",
    input: {
      text: trimmed,
      images: pendingImages,
      backend,
      modelId,
      ...(effortSupported ? { effort } : {}),
      ...(backendSupportsFastMode(backend)
        ? { codexFastMode: codexFastMode ?? false }
        : {}),
    },
  };
}

export default function UnifiedComposer({
  projectName,
  activeConversationId,
  activeConversation,
  agentBackend,
  backendDefaults,
  onAgentChange,
  tokens,
  onTokensChange,
  onSendPrompt,
  initialDocument,
  onDocumentChange,
  onRunCommand,
  lastUsedModelId,
  lastUsedEffort,
  lastUsedCodexFastMode,
  busy,
  error,
  onDismissError,
  queueTurnState,
}: UnifiedComposerProps): React.JSX.Element {
  const rememberedSettingsKey = JSON.stringify([
    activeConversationId,
    agentBackend,
    backendDefaults,
    lastUsedModelId,
    lastUsedEffort,
  ]);
  const [draft, setDraft] = useState(initialDocument?.prompt ?? "");
  const [modelPref, setModelPref] = useState(() =>
    modelForBackend(agentBackend, lastUsedModelId, backendDefaults),
  );
  const [effortPref, setEffortPref] = useState<EffortLevel>(
    () => parseEffort(lastUsedEffort) ?? backendDefaults[agentBackend].effort,
  );
  const { codexFastMode, setCodexFastMode } = useCodexFastMode({
    conversationId: activeConversationId,
    promptCount: activeConversation?.promptCount ?? 0,
    defaultValue: backendDefaults.codex.codexFastMode ?? false,
    lastUsedValue: lastUsedCodexFastMode,
  });
  const [prevRememberedSettingsKey, setPrevRememberedSettingsKey] = useState(
    rememberedSettingsKey,
  );
  const [inlineMarkerIds, setInlineMarkerIds] = useState<string[]>([]);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptPlaceholder, setPromptPlaceholder] = useState<string | null>(
    null,
  );
  const editorRef = useRef<PromptEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptTextRef = useRef(initialDocument?.prompt ?? "");
  // The draft flush reads this ref, and hydration writes the draft without going
  // through the editor's change handler — so the ref tracks the state rather
  // than only the keystrokes that produced it.
  useEffect(() => {
    promptTextRef.current = draft;
  }, [draft]);
  const fireAndForgetRef = useRef(false);

  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  if (prevRememberedSettingsKey !== rememberedSettingsKey) {
    setPrevRememberedSettingsKey(rememberedSettingsKey);
    setModelPref(
      modelForBackend(agentBackend, lastUsedModelId, backendDefaults),
    );
    setEffortPref(
      parseEffort(lastUsedEffort) ?? backendDefaults[agentBackend].effort,
    );
  }

  const selectedModel = modelPref;

  const availableEffortLevels = useMemo(
    () => getEffortLevelsForBackend(agentBackend, selectedModel),
    [agentBackend, selectedModel],
  );
  const effortSupported = availableEffortLevels.length > 0;
  const selectedEffort = pickEffort(availableEffortLevels, effortPref);

  // One composer instance serves every tab, so both halves of a draft — the
  // text and the attachments — are bound to the conversation they were authored
  // for. The text rides the conversation's persisted `pendingPromptText` (so it
  // also survives a reload); the attachments are held per conversation in the
  // attachment hook (R3.3 / D6).
  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments(
      initialDocument?.images ?? [],
      activeConversationId === null
        ? NEW_CONVERSATION_ATTACHMENT_SCOPE
        : `conversation:${activeConversationId}`,
    );

  // The lifted tab document tracks the attachments too, so reopening a closed
  // tab restores what was attached to it, not just the text.
  useEffect(() => {
    if (!onDocumentChange || !editorRef.current) return;
    onDocumentChange(editorRef.current.serialize(pendingImages));
  }, [onDocumentChange, pendingImages]);

  // The cockpit remounts this composer per tab, so a reopened tab arrives with
  // its lifted document already in hand. Read once at mount: the persisted draft
  // must not hydrate over text the user can see.
  const [mountedWithLocalDraft] = useState(
    () => (initialDocument?.prompt ?? "") !== "",
  );

  // Stable identity required: the draft hook's flush and beacon effects key off
  // the target. Null until the create-and-send path has a conversation to
  // address, and the draft stays composer-local until then.
  const draftTarget = useMemo(
    () =>
      activeConversationId === null
        ? null
        : projectConversationTarget(projectName, activeConversationId),
    [projectName, activeConversationId],
  );

  const { handlePromptTextChange, suppressPendingPromptAutosaveAfterSubmit } =
    usePendingPromptPersistence({
      target: draftTarget,
      activeConversation,
      promptText: draft,
      setPromptText: setDraft,
      promptTextRef,
      editorRef,
      mountedWithLocalDraft,
    });

  // Switching tabs keeps this composer mounted — the attachment scope map and
  // the per-conversation draft hook both depend on that — so the tab's lifted
  // document is re-seeded here rather than by a remount. It is the same draft as
  // the conversation's persisted copy but ahead of it by the autosave debounce,
  // so it wins; an empty one defers to the hook's hydration.
  const seededDraftKeyRef = useRef(
    activeConversationId ?? NEW_CONVERSATION_ATTACHMENT_SCOPE,
  );
  useEffect(() => {
    const draftKey = activeConversationId ?? NEW_CONVERSATION_ATTACHMENT_SCOPE;
    if (seededDraftKeyRef.current === draftKey) return;
    seededDraftKeyRef.current = draftKey;
    const text = initialDocument?.prompt ?? "";
    if (text === "") return;
    // Marks the conversation hydrated, so the persisted draft cannot land on top
    // of the text the user is looking at.
    handlePromptTextChange(text);
    promptTextRef.current = text;
    editorRef.current?.editor?.commands.setContent(
      deserializePromptDoc({ prompt: text, images: [] }),
    );
  }, [activeConversationId, initialDocument, handlePromptTextChange]);

  const clearComposer = useCallback(() => {
    setDraft("");
    promptTextRef.current = "";
    setInlineMarkerIds([]);
    setPromptPlaceholder(null);
    editorRef.current?.clear();
    clearImages();
    // The persisted draft has to go with the visible one, or the next time this
    // tab is selected the conversation rehydrates the text just consumed.
    suppressPendingPromptAutosaveAfterSubmit();
    // The lifted tab document is the other copy of the same draft; leaving it
    // behind would restore the consumed text when the tab is reopened.
    onDocumentChange?.({ prompt: "", images: [] });
  }, [clearImages, onDocumentChange, suppressPendingPromptAutosaveAfterSubmit]);

  /**
   * Hand a refused submission's text back to the composer. The composer clears
   * optimistically — a send that waited for the server before emptying would
   * stall on every ordinary turn — so a refusal restores rather than never
   * having cleared. Attachments are not restored: the durable text is what the
   * user would otherwise have to retype, and re-materializing image payloads as
   * fresh attachments is a separate concern from this recovery.
   */
  const restoreComposer = useCallback((text: string) => {
    setDraft(text);
    promptTextRef.current = text;
    setPromptPlaceholder(null);
    const editor = editorRef.current?.editor;
    if (!editor) return;
    // The same primitive the session composer restores a persisted draft with.
    // `insertText` would be wrong here: it focuses the editor, stealing focus
    // from wherever the user moved while the request was in flight.
    editor.commands.setContent(
      deserializePromptDoc({ prompt: text, images: [] }),
    );
  }, []);

  const handleSendPrompt = useCallback(() => {
    const serialized = editorRef.current?.serialize(pendingImages);
    const images =
      serialized?.images ??
      pendingImages.flatMap((attachment) => {
        const parsed = imagePayloadSchema.safeParse({
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          base64Data: attachment.base64Data,
        });
        return parsed.success ? [parsed.data] : [];
      });
    const result = resolveProjectComposerSubmit({
      draft: serialized?.prompt ?? draft,
      pendingImages: images,
      tokens,
      backend: agentBackend,
      modelId: selectedModel,
      effort: selectedEffort,
      effortSupported,
      codexFastMode,
    });

    switch (result.kind) {
      case "noop":
        return;
      case "command":
        onRunCommand(result.id);
        clearComposer();
        return;
      case "tokens":
        onTokensChange(result.tokens);
        clearComposer();
        return;
      case "send": {
        const submitted = result.input.text;
        void onSendPrompt(result.input)
          // A throw means nothing was recorded either, so it restores like any
          // other refusal — and swallowing it here is what keeps a rejected
          // promise from escaping as an unhandled rejection.
          .catch(() => "rejected" as const)
          .then((outcome) => {
            if (outcome === "rejected") restoreComposer(submitted);
          });
        clearComposer();
        return;
      }
    }
  }, [
    pendingImages,
    draft,
    tokens,
    agentBackend,
    selectedModel,
    selectedEffort,
    effortSupported,
    codexFastMode,
    onRunCommand,
    clearComposer,
    restoreComposer,
    onTokensChange,
    onSendPrompt,
  ]);

  // Voice dictation with the same wiring as session conversations: the
  // Ctrl+Shift+. hotkey, transcribed-text insertion, and stop-and-submit on
  // Enter while recording all come from useVoiceWiring.
  const handleSendPromptAsync = useCallback(async () => {
    handleSendPrompt();
  }, [handleSendPrompt]);
  const voice = useVoiceWiring({
    projectName,
    promptTextRef,
    editorRef,
    fireAndForgetRef,
    handleSendPrompt: handleSendPromptAsync,
  });

  useClearInputHotkey({
    editorRef,
    setPromptText: setDraft,
    clearPlaceholder: useCallback(() => setPromptPlaceholder(null), []),
    clearImages,
  });

  useAppHotkey("focusComposer", () => {
    editorRef.current?.focus();
  });

  const visibleError = promptError ?? error?.message ?? null;

  return (
    <>
      <PromptComposer
        projectName={projectName}
        sessionName={PROJECT_CONVERSATION_SESSION_SENTINEL}
        conversationId={activeConversationId ?? ""}
        // Deliberately absent: the session-shaped record would light up the debug
        // strip and the capability drawer, which stay session-only. The queue
        // state the composer legitimately needs comes through its own prop.
        activeConversation={undefined}
        {...(queueTurnState ? { queueTurnState } : {})}
        editorRef={editorRef}
        fileInputRef={fileInputRef}
        promptText={draft}
        initialDocument={initialDocument}
        onDocumentChange={onDocumentChange}
        onPromptTextChange={(text) => {
          handlePromptTextChange(text);
          promptTextRef.current = text;
          if (promptPlaceholder !== null) setPromptPlaceholder(null);
        }}
        onSendPrompt={handleSendPrompt}
        pendingImages={pendingImages}
        inlineMarkerIds={inlineMarkerIds}
        onInlineMarkersChange={setInlineMarkerIds}
        addImage={addImage}
        removeImage={removeImage}
        isAtLimit={isAtLimit}
        cumulativeImageCount={0}
        failPrompt={setPromptError}
        showPlaceholder={setPromptPlaceholder}
        promptPlaceholder={promptPlaceholder}
        isReadOnly={false}
        isFinished={false}
        sending={busy}
        hasActiveCollab={false}
        isRecording={voice.isRecording}
        isProcessing={voice.isProcessing}
        voiceAvailable={voice.voiceAvailable}
        elapsedTime={voice.elapsedTime}
        toggleRecording={voice.toggleRecording}
        stopAndSubmit={voice.stopAndSubmit}
        backendLocked={backendLocked}
        selectedBackend={agentBackend}
        onBackendChange={onAgentChange}
        selectedModel={selectedModel}
        onModelChange={setModelPref}
        selectedEffort={selectedEffort}
        onEffortChange={setEffortPref}
        codexFastMode={codexFastMode}
        onCodexFastModeChange={setCodexFastMode}
        availableEffortLevels={availableEffortLevels}
        effortSupported={effortSupported}
        hasCollabChip={false}
        effectiveCollabConfig={{
          agentTwo: seedAgentTwoDraft(
            agentBackend === "claude" ? "codex" : "claude",
            backendDefaults,
          ),
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }}
        originatingCollabAgent={agentBackend}
        onCollabConfigChange={() => {}}
        collabBackendDefaults={backendDefaults}
        onCollabDismiss={() => {}}
        onDebugToggle={() => {}}
        debugTogglePending={false}
      />
      {visibleError && (
        <div
          className="flex items-center gap-sm font-mono text-[0.72rem] text-red"
          role="alert"
        >
          <span>{visibleError}</span>
          {error && onDismissError && (
            <Button variant="ghost" size="sm" onClick={onDismissError}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </>
  );
}
