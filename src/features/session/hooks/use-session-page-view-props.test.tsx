// @vitest-environment jsdom
// Parity pin for the session-workspace assembly boundary: given a full set of
// workspace slices, useSessionPageViewProps must map every field to the exact
// slot the downstream view components consume. This test is behavior-neutral
// ground truth for the knowledge-slice reorg — it asserts the precise
// field-to-source wiring so the composition can be restructured without drift.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useSessionPageViewProps } from "./use-session-page-view-props";
import type { SessionWorkspaceSlices } from "./session-workspace-slices";
import { useSessionPageStoreBundle } from "./use-session-page-store-bundle";
import { useSessionPageLocalState } from "./use-session-page-local-state";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  toPublicConversationState,
  type ConversationState,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { useSessionDetailStore } from "@/stores/session-detail.store";

const CONVERSATION_ID = "conv-1";

function makeConversation(): PublicConversationState {
  // Projected, like every conversation a client actually receives.
  return toPublicConversationState({
    profileSnapshot: null,
    profileLockedAt: null,
    id: CONVERSATION_ID,
    scope: "session",
    nameOrigin: "default",
    name: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-06-15T10:00:00Z",
    lastActivityAt: "2024-06-15T12:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
  });
}

function makeSession(conversation: ConversationState): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/projects/repo/.worktrees/test-session",
    branchName: "csm/test-session",
    createdAt: "2024-06-15T10:00:00Z",
    lastActivityAt: "2024-06-15T12:00:00Z",
    archived: false,
    finished: false,
    targetBranch: "main",
    parentSessionName: null,
    conversations: [conversation],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

// Builds a fully-populated slice set with distinguishable sentinel values so
// the mapping test can prove each output slot draws from the intended slice.
function makeSlices(
  store: ReturnType<typeof useSessionPageStoreBundle>,
  local: ReturnType<typeof useSessionPageLocalState>,
): SessionWorkspaceSlices {
  const conversation = makeConversation();
  const session = makeSession(conversation);
  const dsServers = [
    { name: "web", status: "running" as const },
    { name: "api", status: "stopped" as const },
  ] as unknown as SessionWorkspaceSlices["devServers"]["dsServers"];

  return {
    identity: {
      projectName: "repo",
      sessionName: "test-session",
      conversationId: CONVERSATION_ID,
      session,
      activeConversation: conversation,
      conversations: [conversation],
      statusDotClass: "status-dot-idle",
      displayStatus: "Idle",
      contextPercent: 42,
      buildContext: () => "ctx",
      isFinished: false,
      isReadOnly: false,
      isBusy: false,
      isWorkflowManagedConversation: false,
      targetBranch: "main",
      worktreePath: "/projects/repo/.worktrees/test-session",
      messages: [],
      messagesPending: false,
      cumulativeImageCount: 3,
    },
    prompt: {
      approvalGate: null,
      handleSendPrompt: vi.fn(async () => {}),
      handlePromptTextChange: vi.fn(),
      canStop: false,
      handleStopPrompt: vi.fn(),
      handleAnswerSubmit: vi.fn(async () => {}),
      handleDirectPrompt: vi.fn(async () => {}),
      handleFork: vi.fn(),
      debugToggleMutation: { isPending: false, mutate: vi.fn() },
    },
    collaboration: {
      hasActiveCollab: false,
      hasCollabChip: false,
      effectiveCollabConfig: {
        secondAgent: "codex",
        negotiationRounds: 2,
        autonomousResolutionThreshold: "minor",
      },
      originatingCollabAgent: "claude",
      setCollabConfigDraft: vi.fn(),
      clearCollabConfigDraft: vi.fn(),
    },
    backendModelEffort: {
      backendLocked: false,
      selectedBackend: "claude",
      codexFastMode: true,
      setCodexFastMode: vi.fn(),
      selectedModel: "sonnet",
      selectedEffort: "high",
      availableEffortLevels: ["low", "medium", "high"],
      effortSupported: true,
      setSelectedEffort: vi.fn(),
      handleBackendChange: vi.fn(),
      handleModelChange: vi.fn(),
    },
    voice: {
      isRecording: false,
      isProcessing: false,
      voiceAvailable: true,
      elapsedTime: 0,
      toggleRecording: vi.fn(),
      stopAndSubmit: vi.fn(),
    },
    devServers: {
      dsServers,
      dsStartServer: vi.fn(),
      dsStopServer: vi.fn(),
      dsStartAll: vi.fn(),
      dsStopAll: vi.fn(),
      dsUnmanagedConflict: undefined,
      dsDismissUnmanagedConflict: vi.fn(),
      dsStopUnmanagedAndRetry: vi.fn(),
      dsIsStoppingUnmanaged: false,
    },
    layout: {
      tddEnabled: true,
      onTddChange: vi.fn(),
      tddDisabled: false,
      onLayoutChange: vi.fn(),
      openTabs: undefined,
    },
    dialogActions: {
      handleDelete: vi.fn(),
      handleConcurrentConfirm: vi.fn(),
      cancelConcurrentSubmission: vi.fn(),
      pendingConcurrentSubmission: null,
    },
    store,
    local,
    collab: {
      hasActiveCollab: false,
    } as unknown as SessionWorkspaceSlices["collab"],
  };
}

function renderViewProps() {
  useSessionDetailStore.getState().resetStore();
  return renderHook(() => {
    const store = useSessionPageStoreBundle(CONVERSATION_ID);
    const local = useSessionPageLocalState();
    return useSessionPageViewProps(makeSlices(store, local));
  });
}

describe("useSessionPageViewProps", () => {
  it("wires session identity + status into contentProps", () => {
    const { result } = renderViewProps();
    const { contentProps } = result.current;
    expect(contentProps.projectName).toBe("repo");
    expect(contentProps.sessionName).toBe("test-session");
    expect(contentProps.conversationId).toBe(CONVERSATION_ID);
    expect(contentProps.statusDotClass).toBe("status-dot-idle");
    expect(contentProps.displayStatus).toBe("Idle");
    expect(contentProps.contextPercent).toBe(42);
    expect(contentProps.isFinished).toBe(false);
    expect(contentProps.targetBranch).toBe("main");
    expect(contentProps.buildContext()).toBe("ctx");
    expect(contentProps.session.sessionName).toBe("test-session");
    expect(contentProps.activeConversation?.id).toBe(CONVERSATION_ID);
    expect(contentProps.openTabs).toBeUndefined();
  });

  it("wires the panel container props (identity, busy/read-only, backend, collab bundle)", () => {
    const { result } = renderViewProps();
    const panel = result.current.contentProps.panelContainerProps;
    expect(panel.projectName).toBe("repo");
    expect(panel.sessionName).toBe("test-session");
    expect(panel.conversationId).toBe(CONVERSATION_ID);
    expect(panel.isBusy).toBe(false);
    expect(panel.isReadOnly).toBe(false);
    expect(panel.hasActiveCollab).toBe(false);
    expect(panel.worktreePath).toBe("/projects/repo/.worktrees/test-session");
    expect(panel.selectedBackend).toBe("claude");
    expect(panel.contextPercent).toBe(42);
    expect(panel.canStop).toBe(false);
    expect(panel.collab.hasActiveCollab).toBe(false);
  });

  it("wires dev-server controls into contentProps", () => {
    const { result } = renderViewProps();
    const { contentProps } = result.current;
    expect(contentProps.dsServers).toHaveLength(2);
    expect(typeof contentProps.dsStartServer).toBe("function");
    expect(typeof contentProps.dsStopServer).toBe("function");
    expect(typeof contentProps.dsStartAll).toBe("function");
    expect(typeof contentProps.dsStopAll).toBe("function");
    expect(contentProps.dsUnmanagedConflict).toBeUndefined();
    expect(contentProps.dsIsStoppingUnmanaged).toBe(false);
  });

  it("wires layout + tdd controls into contentProps", () => {
    const { result } = renderViewProps();
    const { contentProps } = result.current;
    expect(contentProps.tddEnabled).toBe(true);
    expect(contentProps.tddDisabled).toBe(false);
    expect(typeof contentProps.onTddChange).toBe("function");
    expect(typeof contentProps.onLayoutChange).toBe("function");
  });

  it("wires prompt execution + composer into promptInputSlotProps", () => {
    const { result } = renderViewProps();
    const slot = result.current.promptInputSlotProps;
    expect(slot.isWorkflowManagedConversation).toBe(false);
    expect(slot.approvalGate).toBeNull();
    expect(slot.agentBackend).toBe("claude");
    // Composer sub-bundle carries backend/model/effort + collab + voice.
    expect(slot.promptComposerProps.selectedBackend).toBe("claude");
    expect(slot.promptComposerProps.codexFastMode).toBe(true);
    expect(slot.promptComposerProps.selectedModel).toBe("sonnet");
    expect(slot.promptComposerProps.selectedEffort).toBe("high");
    expect(slot.promptComposerProps.availableEffortLevels).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(slot.promptComposerProps.voiceAvailable).toBe(true);
    expect(slot.promptComposerProps.cumulativeImageCount).toBe(3);
    expect(slot.promptComposerProps.hasCollabChip).toBe(false);
    expect(slot.promptComposerProps.originatingCollabAgent).toBe("claude");
  });

  it("wires mobile bottom bar props (dev-server counts derived from dsServers)", () => {
    const { result } = renderViewProps();
    const bar = result.current.mobileBottomBarProps;
    expect(bar.tddEnabled).toBe(true);
    expect(bar.tddDisabled).toBe(false);
    expect(bar.devServerCounts).toEqual({ running: 1, total: 2 });
    expect(typeof bar.onSwitchPanel).toBe("function");
    expect(typeof bar.onDelete).toBe("function");
  });

  it("wires dialog actions into dialogsProps", () => {
    const { result } = renderViewProps();
    const dialogs = result.current.dialogsProps;
    expect(dialogs.sessionName).toBe("test-session");
    expect(dialogs.pendingConcurrentSubmission).toBeNull();
    expect(typeof dialogs.onDeleteConfirm).toBe("function");
    expect(typeof dialogs.onConcurrentConfirm).toBe("function");
    expect(typeof dialogs.onConcurrentCancel).toBe("function");
  });
});
