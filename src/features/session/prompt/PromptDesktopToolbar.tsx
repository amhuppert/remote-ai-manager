"use client";

import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import ConversationAgentCapabilitiesConfig from "@/components/agent-capabilities/ConversationAgentCapabilitiesConfig";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import DebugModeToggle from "@/features/session/debug/DebugModeToggle";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

export interface PromptDesktopToolbarProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  activeConversation: ConversationState | undefined;
  onAttachClick: () => void;
  attachDisabled: boolean;
  backendLocked: boolean;
  selectedBackend: AgentBackendId;
  onBackendChange: (backend: AgentBackendId) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  selectedEffort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  isReadOnly: boolean;
  sending: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  voiceAvailable: boolean;
  elapsedTime: number;
  toggleRecording: () => void;
  sendBtnClass: string;
  sendDisabled: boolean;
  sendTitle: string;
  sendButtonInner: React.ReactNode;
  onSendPrompt: () => void;
}

export default function PromptDesktopToolbar({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  onAttachClick,
  attachDisabled,
  backendLocked,
  selectedBackend,
  onBackendChange,
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  availableEffortLevels,
  effortSupported,
  isReadOnly,
  sending,
  isRecording,
  isProcessing,
  voiceAvailable,
  elapsedTime,
  toggleRecording,
  sendBtnClass,
  sendDisabled,
  sendTitle,
  sendButtonInner,
  onSendPrompt,
}: PromptDesktopToolbarProps): React.JSX.Element {
  return (
    <div className="prompt-toolbar">
      <div className="prompt-toolbar-start">
        <button
          className="attachment-btn"
          onClick={onAttachClick}
          disabled={attachDisabled}
          title="Attach image"
          type="button"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <BackendToggle
          value={selectedBackend}
          onChange={onBackendChange}
          disabled={sending || isReadOnly}
          readOnly={backendLocked}
        />
        <ModelSelector
          value={selectedModel}
          onChange={onModelChange}
          disabled={sending || isReadOnly}
          backend={selectedBackend}
        />
        <ReasoningLevelSelector
          value={selectedEffort}
          onChange={onEffortChange}
          disabled={sending || isReadOnly || !effortSupported}
          availableLevels={availableEffortLevels}
          disabledTooltip={
            !effortSupported
              ? "Reasoning level is only available for Opus and Sonnet models"
              : undefined
          }
        />
        <DebugModeToggle
          projectName={projectName}
          sessionName={sessionName}
          conversation={activeConversation}
          disabled={sending || isReadOnly}
        />
        <ConversationAgentCapabilitiesConfig
          projectName={projectName}
          sessionName={sessionName}
          conversationId={conversationId}
          disabled={isReadOnly}
          disabledTooltip={isReadOnly ? "Session is read-only" : undefined}
        />
      </div>
      <div className="prompt-toolbar-end">
        <VoiceRecordButton
          isRecording={isRecording}
          isProcessing={isProcessing}
          elapsedTime={elapsedTime}
          isAvailable={voiceAvailable}
          toggleRecording={toggleRecording}
          disabled={sending}
        />
        <button
          className={sendBtnClass}
          disabled={sendDisabled}
          onClick={onSendPrompt}
          title={sendTitle}
        >
          {sendButtonInner}
        </button>
      </div>
    </div>
  );
}
