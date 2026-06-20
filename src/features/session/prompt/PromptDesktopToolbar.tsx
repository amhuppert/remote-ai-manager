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

/**
 * The send/queue button recipe (legacy `.send-btn` + `.send-btn.busy`). Shared
 * by the desktop toolbar and the mobile toolbar's send slot so the two render
 * the identical button. Busy state (`sending` with no live conversation) is a
 * `data-busy` attribute, not a runtime class.
 */
export const SEND_BUTTON_CLASS =
  "send-btn flex items-center justify-center w-[36px] h-[36px] rounded-md border-0 bg-cyan text-text-inverse text-[0.9rem] transition-all duration-150 shrink-0 cursor-pointer hover:bg-cyan-dim hover:shadow-[0_0_24px_var(--cyan-glow-strong)] disabled:opacity-40 disabled:cursor-not-allowed data-[busy=true]:bg-bg-raised data-[busy=true]:text-cyan data-[busy=true]:border data-[busy=true]:border-solid data-[busy=true]:border-cyan-dim data-[busy=true]:animate-[pulse-border_1.5s_ease-in-out_infinite]";

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
  sendBusy: boolean;
  sendDisabled: boolean;
  sendTitle: string;
  sendButtonInner: React.ReactNode;
  onSendPrompt: () => void;
  onModelOpenChange?: (open: boolean) => void;
  onEffortOpenChange?: (open: boolean) => void;
  onCapabilitiesOpenChange?: (open: boolean) => void;
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
  sendBusy,
  sendDisabled,
  sendTitle,
  sendButtonInner,
  onSendPrompt,
  onModelOpenChange,
  onEffortOpenChange,
  onCapabilitiesOpenChange,
}: PromptDesktopToolbarProps): React.JSX.Element {
  return (
    <div className="prompt-toolbar flex items-center justify-between max-768:hidden">
      {/* Clicking an in-flow control keeps the literal editor focused (focus
          continuity for typing) via the established onMouseDown→preventDefault
          idiom; the control still fires its own onClick. */}
      <div
        className="flex items-center gap-sm"
        onMouseDown={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest("button")) {
            e.preventDefault();
          }
        }}
      >
        <button
          className="flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-transparent p-0 text-text-secondary transition-[border-color,color] duration-150 ease-[ease] hover:border-cyan-dim hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
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
          onOpenChange={onModelOpenChange}
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
          onOpenChange={onEffortOpenChange}
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
          onOpenChange={onCapabilitiesOpenChange}
        />
      </div>
      <div className="flex items-center gap-sm">
        <VoiceRecordButton
          isRecording={isRecording}
          isProcessing={isProcessing}
          elapsedTime={elapsedTime}
          isAvailable={voiceAvailable}
          toggleRecording={toggleRecording}
          disabled={sending}
        />
        <button
          className={SEND_BUTTON_CLASS}
          data-busy={sendBusy}
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
