"use client";

import type { ComponentProps } from "react";
import type SessionContent from "@/features/session/conversation/SessionContent";
import type { ConversationWorkspaceViewProps } from "@/features/session/ConversationWorkspaceView";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { useCollabContext } from "@/features/session/hooks/use-collab-context";
import type { usePromptComposerProps } from "@/features/session/hooks/use-prompt-composer-props";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { CollabConfigDraft } from "@/stores/collaboration.store";
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";

type PromptComposerArgs = Parameters<typeof usePromptComposerProps>[0];
type SessionContentProps = ComponentProps<typeof SessionContent>;
type PanelContainerProps =
  ConversationWorkspaceViewProps["contentProps"]["panelContainerProps"];

/**
 * The session workspace's view props are assembled from stable, knowledge-owning
 * slices rather than one flat prop bag. Each slice concentrates one area of
 * knowledge (identity, prompt execution, collaboration, backend/model/effort,
 * voice, dev servers, layout, dialog actions) so a change in one area touches
 * one slice, not a ~90-field relay. `useSessionPageViewProps` composes these
 * into `ConversationWorkspaceViewProps`; each internal builder reads only the
 * slices it owns.
 */

/** Session identity + derived status + read-only/busy gating. */
export interface SessionIdentitySlice {
  projectName: string;
  sessionName: string;
  conversationId: string;
  session: SessionState;
  activeConversation: ConversationState | undefined;
  conversations: ConversationState[] | undefined;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  buildContext: () => string | null;
  isFinished: boolean;
  isReadOnly: boolean;
  isBusy: boolean;
  isWorkflowManagedConversation: boolean;
  targetBranch: string;
  worktreePath: string | undefined;
  messages: readonly TranscriptMessage[];
  messagesPending: boolean;
  cumulativeImageCount: number;
}

/** Prompt turn execution: send / stop / answer / debug / fork + approval gate. */
export interface PromptExecutionSlice {
  approvalGate: ConversationWorkspaceViewProps["promptInputSlotProps"]["approvalGate"];
  handleSendPrompt: PromptComposerArgs["handleSendPrompt"];
  handlePromptTextChange: PromptComposerArgs["handlePromptTextChange"];
  canStop: boolean;
  handleStopPrompt: () => void;
  handleAnswerSubmit: ConversationWorkspaceViewProps["promptInputSlotProps"]["handleAnswerSubmit"];
  handleDebugPrompt: PanelContainerProps["handleDebugPrompt"];
  handleFork: PanelContainerProps["handleFork"];
  debugToggleMutation: PromptComposerArgs["debugToggleMutation"];
}

/** Collaboration (`/collab`) config draft + active-collab flags. */
export interface CollaborationSlice {
  hasActiveCollab: boolean;
  hasCollabChip: boolean;
  effectiveCollabConfig: CollabConfigDraft;
  originatingCollabAgent: PromptComposerArgs["originatingCollabAgent"];
  setCollabConfigDraft: PromptComposerArgs["setCollabConfigDraft"];
  clearCollabConfigDraft: PromptComposerArgs["clearCollabConfigDraft"];
}

/** Backend / model / effort selection. */
export interface BackendModelEffortSlice {
  backendLocked: boolean;
  selectedBackend: PromptComposerArgs["selectedBackend"];
  selectedModel: string;
  selectedEffort: EffortLevel;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  setSelectedEffort: (effort: EffortLevel) => void;
  handleBackendChange: PromptComposerArgs["handleBackendChange"];
  handleModelChange: PromptComposerArgs["handleModelChange"];
}

/** Voice transcription recorder state + controls. */
export interface VoiceSlice {
  isRecording: boolean;
  isProcessing: boolean;
  voiceAvailable: boolean;
  elapsedTime: number;
  toggleRecording: () => void;
  stopAndSubmit: () => void;
}

/** Per-session dev-server roster + lifecycle controls. */
export interface DevServerSlice {
  dsServers: SessionContentProps["dsServers"];
  dsStartServer: SessionContentProps["dsStartServer"];
  dsStopServer: SessionContentProps["dsStopServer"];
  dsStartAll: () => void;
  dsStopAll: () => void;
  dsUnmanagedConflict?: SessionContentProps["dsUnmanagedConflict"];
  dsDismissUnmanagedConflict?: () => void;
  dsStopUnmanagedAndRetry?: () => void;
  dsIsStoppingUnmanaged?: boolean;
}

/** Layout mode, TDD toggle, and the page-level open-tabs working set. */
export interface LayoutSlice {
  tddEnabled: boolean;
  onTddChange: (val: boolean) => void;
  tddDisabled: boolean;
  onLayoutChange: SessionContentProps["onLayoutChange"];
  /**
   * Page-level open-tabs working set (present only on /conversations); flows
   * into SessionContent's tab strip + panes grid.
   */
  openTabs?: OpenTabsApi;
}

/** Confirmation dialogs: delete + concurrent-submission arbitration. */
export interface DialogActionsSlice {
  handleDelete: () => void;
  handleConcurrentConfirm: () => void;
  cancelConcurrentSubmission: () => void;
  pendingConcurrentSubmission: ConversationWorkspaceViewProps["dialogsProps"]["pendingConcurrentSubmission"];
}

/**
 * The composed slice set consumed by {@link useSessionPageViewProps}. The three
 * pre-grouped hook bundles (`store`, `local`, `collab`) are carried whole
 * because each already hides its own knowledge behind a stable return shape.
 */
export interface SessionWorkspaceSlices {
  identity: SessionIdentitySlice;
  prompt: PromptExecutionSlice;
  collaboration: CollaborationSlice;
  backendModelEffort: BackendModelEffortSlice;
  voice: VoiceSlice;
  devServers: DevServerSlice;
  layout: LayoutSlice;
  dialogActions: DialogActionsSlice;
  store: ReturnType<typeof useSessionPageStoreBundle>;
  local: ReturnType<typeof useSessionPageLocalState>;
  collab: ReturnType<typeof useCollabContext>;
}
