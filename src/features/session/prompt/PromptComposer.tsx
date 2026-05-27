"use client";

import { Suspense, lazy } from "react";
import { getModelsForBackend } from "@/components/ModelSelector";
import { EFFORT_OPTIONS } from "@/components/ReasoningLevelSelector";
import ConversationAgentCapabilitiesConfig from "@/components/agent-capabilities/ConversationAgentCapabilitiesConfig";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import DebugStatusStrip from "@/features/session/debug/DebugStatusStrip";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import MobilePromptToolbar from "@/features/session/mobile/MobilePromptToolbar";
import PromptDesktopToolbar from "@/features/session/prompt/PromptDesktopToolbar";
import CollabConfigRow, {
  type CollabConfigRowConfig,
} from "@/features/session/conversation/collab/CollabConfigRow";
import { COLLAB_RUNNING_TOOLTIP } from "@/features/session/conversation/collab/page-helpers";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";
import type {
  AddImageResult,
  ImageAttachment,
} from "@/hooks/use-image-attachments";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

const PromptEditor = lazy(() =>
  import("@/features/session/prompt/PromptEditor").then((m) => ({
    default: m.PromptEditor,
  })),
);

interface SendButtonState {
  disabled: boolean;
  title: string;
}

export function computeSendButtonState({
  promptText,
  pendingImageCount,
  sending,
  conversationId,
  isReadOnly,
  isRecording,
}: {
  promptText: string;
  pendingImageCount: number;
  sending: boolean;
  conversationId: string;
  isReadOnly: boolean;
  isRecording: boolean;
}): SendButtonState {
  const sessionBusyNoConvo = sending && !conversationId;
  const disabled =
    (!promptText.trim() && pendingImageCount === 0) ||
    sessionBusyNoConvo ||
    isReadOnly ||
    isRecording;
  const title = isReadOnly
    ? "Session is read-only"
    : sessionBusyNoConvo
      ? "Session is busy"
      : sending
        ? "Queue message"
        : "Send prompt";
  return { disabled, title };
}

interface PromptComposerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  activeConversation: ConversationState | undefined;
  editorRef: React.RefObject<PromptEditorHandle | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  promptText: string;
  onPromptTextChange: (text: string) => void;
  onSendPrompt: () => void;
  pendingImages: ImageAttachment[];
  inlineMarkerIds: string[];
  onInlineMarkersChange: (ids: string[]) => void;
  addImage: (file: File | Blob, fileName?: string) => Promise<AddImageResult>;
  removeImage: (id: string) => void;
  isAtLimit: boolean;
  cumulativeImageCount: number;
  failPrompt: (message: string) => void;
  showPlaceholder: (text: string) => void;
  promptPlaceholder: string | null;
  isReadOnly: boolean;
  isFinished: boolean;
  sending: boolean;
  hasActiveCollab: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  voiceAvailable: boolean;
  elapsedTime: number;
  toggleRecording: () => void;
  stopAndSubmit: () => void;
  backendLocked: boolean;
  selectedBackend: AgentBackendId;
  onBackendChange: (backend: AgentBackendId) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  selectedEffort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  hasCollabChip: boolean;
  effectiveCollabConfig: CollabConfigRowConfig;
  originatingCollabAgent: "claude" | "codex";
  onCollabConfigChange: (next: CollabConfigRowConfig) => void;
  onCollabDismiss: () => void;
  onDebugToggle: () => void;
  debugTogglePending: boolean;
  canStop: boolean;
  onStopPrompt: () => void;
}

export default function PromptComposer({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  editorRef,
  fileInputRef,
  promptText,
  onPromptTextChange,
  onSendPrompt,
  pendingImages,
  inlineMarkerIds,
  onInlineMarkersChange,
  addImage,
  removeImage,
  isAtLimit,
  cumulativeImageCount,
  failPrompt,
  showPlaceholder,
  promptPlaceholder,
  isReadOnly,
  isFinished,
  sending,
  hasActiveCollab,
  isRecording,
  isProcessing,
  voiceAvailable,
  elapsedTime,
  toggleRecording,
  stopAndSubmit,
  backendLocked,
  selectedBackend,
  onBackendChange,
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  availableEffortLevels,
  effortSupported,
  hasCollabChip,
  effectiveCollabConfig,
  originatingCollabAgent,
  onCollabConfigChange,
  onCollabDismiss,
  onDebugToggle,
  debugTogglePending,
  canStop,
  onStopPrompt,
}: PromptComposerProps): React.JSX.Element {
  const { disabled: sendDisabled, title: sendTitle } = computeSendButtonState({
    promptText,
    pendingImageCount: pendingImages.length,
    sending,
    conversationId,
    isReadOnly,
    isRecording,
  });
  const sendBtnClass = `send-btn${sending && !conversationId ? " busy" : ""}`;
  const sendButtonInner =
    sending && !conversationId ? (
      <div
        className="spinner"
        style={{
          borderColor: "rgba(0, 229, 255, 0.3)",
          borderTopColor: "var(--cyan)",
          width: 18,
          height: 18,
        }}
      />
    ) : (
      "\u25B6"
    );

  return (
    <div className="prompt-input-area">
      <div className="prompt-input-wrapper">
        {activeConversation && (
          <DebugStatusStrip
            projectName={projectName}
            sessionName={sessionName}
            conversation={activeConversation}
          />
        )}
        <Suspense fallback={null}>
          <PromptEditor
            ref={editorRef}
            conversationId={conversationId}
            value={promptText}
            onChange={onPromptTextChange}
            onSubmit={() => {
              if (isRecording) {
                stopAndSubmit();
                return;
              }
              onSendPrompt();
            }}
            pendingImages={pendingImages}
            onAddImage={async (file) => {
              const result = await addImage(file);
              if (result.error) {
                failPrompt(result.error);
                return null;
              }
              return result.attachment;
            }}
            onRemoveImage={removeImage}
            cumulativeImageCount={cumulativeImageCount}
            onInlineMarkersChange={onInlineMarkersChange}
            projectName={projectName}
            sessionName={sessionName}
            backend={selectedBackend}
            onShowPlaceholder={showPlaceholder}
            disabled={isReadOnly}
            readOnly={hasActiveCollab}
            title={hasActiveCollab ? COLLAB_RUNNING_TOOLTIP : undefined}
            placeholder={
              isFinished
                ? "Session is merged and read-only"
                : (promptPlaceholder ?? "Send a prompt to Claude...")
            }
          />
        </Suspense>
        {hasCollabChip ? (
          <CollabConfigRow
            config={effectiveCollabConfig}
            originatingAgent={originatingCollabAgent}
            onChange={onCollabConfigChange}
            onDismiss={onCollabDismiss}
          />
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = e.target.files;
            if (!files) return;
            for (const file of files) {
              void addImage(file).then((result) => {
                if (result.error) failPrompt(result.error);
              });
            }
            e.target.value = "";
          }}
        />
        <ImageAttachmentPreview
          images={pendingImages.filter(
            (img) => !inlineMarkerIds.includes(img.id),
          )}
          onRemove={removeImage}
        />
        <PromptDesktopToolbar
          projectName={projectName}
          sessionName={sessionName}
          conversationId={conversationId}
          activeConversation={activeConversation}
          onAttachClick={() => fileInputRef.current?.click()}
          attachDisabled={isAtLimit || sending || isReadOnly}
          backendLocked={backendLocked}
          selectedBackend={selectedBackend}
          onBackendChange={onBackendChange}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          selectedEffort={selectedEffort}
          onEffortChange={onEffortChange}
          availableEffortLevels={availableEffortLevels}
          effortSupported={effortSupported}
          isReadOnly={isReadOnly}
          sending={sending}
          isRecording={isRecording}
          isProcessing={isProcessing}
          voiceAvailable={voiceAvailable}
          elapsedTime={elapsedTime}
          toggleRecording={toggleRecording}
          sendBtnClass={sendBtnClass}
          sendDisabled={sendDisabled}
          sendTitle={sendTitle}
          sendButtonInner={sendButtonInner}
          onSendPrompt={onSendPrompt}
          canStop={canStop}
          onStopPrompt={onStopPrompt}
        />
        <MobilePromptToolbar
          modelOptions={getModelsForBackend(selectedBackend)}
          effortOptions={EFFORT_OPTIONS.filter((o) =>
            availableEffortLevels.includes(o.id),
          )}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          effortSupported={effortSupported}
          effortDisabledReason={
            !effortSupported
              ? "Reasoning level is only available for Opus and Sonnet models"
              : undefined
          }
          onSelectModel={onModelChange}
          onSelectEffort={onEffortChange}
          backend={selectedBackend}
          backendLocked={backendLocked}
          onSelectBackend={onBackendChange}
          onAttach={() => fileInputRef.current?.click()}
          attachDisabled={isAtLimit || sending}
          debugActive={activeConversation?.debugMode?.active ?? false}
          debugSupported={!!activeConversation}
          onToggleDebug={onDebugToggle}
          debugDisabled={sending || debugTogglePending}
          mcpRow={
            <div className="mobile-prompt-row mobile-prompt-row--mcp">
              <ConversationAgentCapabilitiesConfig
                projectName={projectName}
                sessionName={sessionName}
                conversationId={conversationId}
                disabled={isReadOnly}
                disabledTooltip={
                  isReadOnly ? "Session is read-only" : undefined
                }
              />
            </div>
          }
          isReadOnly={isReadOnly}
          isBusy={sending && !conversationId}
          voiceButton={
            <VoiceRecordButton
              isRecording={isRecording}
              isProcessing={isProcessing}
              elapsedTime={elapsedTime}
              isAvailable={voiceAvailable}
              toggleRecording={toggleRecording}
              disabled={sending}
            />
          }
          stopButton={
            canStop ? (
              <button
                type="button"
                className="stop-btn"
                onClick={onStopPrompt}
                title="Stop agent"
                aria-label="Stop agent"
              >
                {"\u25A0"}
              </button>
            ) : null
          }
          sendButton={
            <button
              className={sendBtnClass}
              disabled={sendDisabled}
              onClick={onSendPrompt}
              title={sendTitle}
            >
              {sendButtonInner}
            </button>
          }
        />
      </div>
    </div>
  );
}
