"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import PromptComposer from "@/features/session/prompt/PromptComposer";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";
import { getModelsForBackend } from "@/components/ModelSelector";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import {
  effortLevelSchema,
  getEffortLevelsForBackend,
  type EffortLevel,
} from "@/lib/agent-backends/schemas";
import { imagePayloadSchema, type ImagePayload } from "@/lib/images/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { ProjectPromptError } from "@/lib/project-conversations-client/mutations";
import type { FilterToken } from "../components/filter-tokens";
import { detectComposerMode } from "./detect-composer-mode";
import { parseFilterDraft, replaceTokenByCat } from "./parse-filter-draft";
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
  /** `null` => first-run; a chat send issues create-and-send (PLC-5). */
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
  lastUsedModelId?: string;
  lastUsedEffort?: string;
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

function modelForBackend(
  backend: AgentBackendId,
  preferred: string | undefined,
): string {
  const modelOptions = getModelsForBackend(backend).map((m) => m.id);
  if (preferred !== undefined && modelOptions.includes(preferred)) {
    return preferred;
  }
  return modelOptions[0] ?? "";
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
}: {
  draft: string;
  pendingImages: ImagePayload[];
  tokens: FilterToken[];
  backend: AgentBackendId;
  modelId: string;
  effort: EffortLevel;
  effortSupported: boolean;
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
    },
  };
}

export default function UnifiedComposer({
  projectName,
  activeConversationId,
  activeConversation,
  agentBackend,
  onAgentChange,
  tokens,
  onTokensChange,
  onSendPrompt,
  onRunCommand,
  lastUsedModelId,
  lastUsedEffort,
  busy,
  error,
  onDismissError,
}: UnifiedComposerProps): React.JSX.Element {
  const rememberedSettingsKey = JSON.stringify([
    activeConversationId,
    agentBackend,
    lastUsedModelId,
    lastUsedEffort,
  ]);
  const [draft, setDraft] = useState("");
  const [modelPref, setModelPref] = useState(() =>
    modelForBackend(agentBackend, lastUsedModelId),
  );
  const [effortPref, setEffortPref] = useState<EffortLevel>(
    () => parseEffort(lastUsedEffort) ?? DEFAULT_EFFORT,
  );
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

  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  if (prevRememberedSettingsKey !== rememberedSettingsKey) {
    setPrevRememberedSettingsKey(rememberedSettingsKey);
    setModelPref(modelForBackend(agentBackend, lastUsedModelId));
    setEffortPref(parseEffort(lastUsedEffort) ?? DEFAULT_EFFORT);
  }

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
  const selectedEffort = pickEffort(availableEffortLevels, effortPref);

  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();

  const voice = useVoiceRecorder({
    projectName,
    onResult: (text) => {
      const prefix = draft.trim().length > 0 ? " " : "";
      editorRef.current?.insertText(`${prefix}${text}`);
      setDraft((current) => (current ? `${current} ${text}` : text));
    },
    onError: setPromptError,
  });

  const clearComposer = useCallback(() => {
    setDraft("");
    setInlineMarkerIds([]);
    setPromptPlaceholder(null);
    editorRef.current?.clear();
    clearImages();
  }, [clearImages]);

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
      case "send":
        onSendPrompt(result.input);
        clearComposer();
        return;
    }
  }, [
    pendingImages,
    draft,
    tokens,
    agentBackend,
    selectedModel,
    selectedEffort,
    effortSupported,
    onRunCommand,
    clearComposer,
    onTokensChange,
    onSendPrompt,
  ]);

  const visibleError = promptError ?? error?.message ?? null;

  return (
    <>
      <PromptComposer
        projectName={projectName}
        sessionName=""
        conversationId={activeConversationId ?? ""}
        activeConversation={undefined}
        editorRef={editorRef}
        fileInputRef={fileInputRef}
        promptText={draft}
        onPromptTextChange={(text) => {
          setDraft(text);
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
        voiceAvailable={voice.isAvailable}
        elapsedTime={voice.elapsedTime}
        toggleRecording={voice.toggleRecording}
        stopAndSubmit={voice.stopRecording}
        backendLocked={backendLocked}
        selectedBackend={agentBackend}
        onBackendChange={onAgentChange}
        selectedModel={selectedModel}
        onModelChange={setModelPref}
        selectedEffort={selectedEffort}
        onEffortChange={setEffortPref}
        availableEffortLevels={availableEffortLevels}
        effortSupported={effortSupported}
        hasCollabChip={false}
        effectiveCollabConfig={{
          secondAgent: agentBackend === "claude" ? "codex" : "claude",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }}
        originatingCollabAgent={agentBackend}
        onCollabConfigChange={() => {}}
        onCollabDismiss={() => {}}
        onDebugToggle={() => {}}
        debugTogglePending={false}
      />
      {visibleError && (
        <div className="plc-uc-error" role="alert">
          <span>{visibleError}</span>
          {error && onDismissError && (
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
    </>
  );
}
