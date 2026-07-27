"use client";

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  backendLabel,
  getModelsForBackend,
} from "@/lib/agent-backends/catalog";
import { EFFORT_OPTIONS } from "@/components/ReasoningLevelSelector";
import ConversationAgentCapabilitiesConfig from "@/components/agent-capabilities/ConversationAgentCapabilitiesConfig";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { CloseIcon } from "@/components/icons";
import DebugStatusStrip from "@/components/session/DebugStatusStrip";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import MobilePromptToolbar, {
  MOBILE_PROMPT_ROW_CLASS,
} from "@/components/session/MobilePromptToolbar";
import PromptDesktopToolbar, {
  SEND_BUTTON_CLASS,
} from "@/components/session/prompt/PromptDesktopToolbar";
import { useComposerFocus } from "@/components/session/prompt/use-composer-focus";
import MobileComposerBar from "@/components/session/prompt/MobileComposerBar";
import {
  computeComposerCollapsed,
  computeComposerIdle,
} from "@/components/session/prompt/composer-collapse";
import { useIsMobile } from "@/hooks/use-is-mobile";
import CollabConfigRow, {
  COLLAB_RUNNING_TOOLTIP,
  type CollabConfigRowConfig,
} from "@/components/session/CollabConfigRow";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import type {
  AddImageResult,
  ImageAttachment,
} from "@/hooks/use-image-attachments";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import {
  conversationTargetApiBase,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
import {
  useCancelOptimisticQueueEntry,
  useComposerFocused,
  useSetQueueError,
} from "@/stores/session-detail.store";

const PromptEditor = lazy(() =>
  import("@/components/session/prompt/PromptEditor").then((m) => ({
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
  conversationRunning = false,
  conversationId,
  backend,
  isReadOnly,
  isRecording,
  isProcessing = false,
  queueCapabilityForBackend = defaultQueueCapabilityForBackend,
}: {
  promptText: string;
  pendingImageCount: number;
  sending: boolean;
  /**
   * The conversation's server-side status says a turn is running. Covers turns
   * this tab did not start — a drained queued turn (Codex next-turn delivery),
   * a turn started before a reload, or one started from another client —
   * where `sending` is false but a submitted message will still be queued.
   */
  conversationRunning?: boolean;
  conversationId: string;
  backend: AgentBackendId;
  isReadOnly: boolean;
  isRecording: boolean;
  isProcessing?: boolean;
  queueCapabilityForBackend?: (backend: AgentBackendId) => QueueCapability;
}): SendButtonState {
  const sessionBusyNoConvo = sending && !conversationId;
  const queuingIntoRunningTurn =
    (sending || conversationRunning) && !!conversationId;
  const noContent = !promptText.trim() && pendingImageCount === 0;

  if (isReadOnly) {
    return { disabled: true, title: "Session is read-only" };
  }
  if (sessionBusyNoConvo) {
    return { disabled: true, title: "Session is busy" };
  }
  if (isProcessing) {
    return { disabled: true, title: "Processing voice input…" };
  }
  if (queuingIntoRunningTurn) {
    const cap = queueCapabilityForBackend(backend);
    if (!cap.acceptsWhileRunning) {
      return {
        disabled: true,
        title: "Queuing isn't supported for this backend",
      };
    }
    const title =
      cap.deliveryTiming === "in_turn"
        ? "Queue for this turn"
        : "Queue for next turn";
    return { disabled: noContent && !isRecording, title };
  }
  return {
    disabled: noContent && !isRecording,
    title: "Send prompt",
  };
}

interface CancellableQueueEntry {
  id: string;
  preview: string;
}

function queueEntryPreview(content: PendingQueuedMessage["content"]): string {
  const text = content.find((block) => block.type === "text");
  if (text) return text.text;
  if (content.some((block) => block.type === "image")) {
    return "Image attachment";
  }
  return "Queued message";
}

/**
 * Project the durable pending queue down to the entries the composer can
 * offer to cancel. Only `pending` entries are cancellable; once delivery has
 * been claimed (`delivering`) or completed (`delivered`) the agent may already
 * have seen the message, so cancellation is no longer offered (req 9.3).
 */
export function selectCancellableQueueEntries(
  pendingQueue: readonly PendingQueuedMessage[],
): CancellableQueueEntry[] {
  return pendingQueue
    .filter((entry) => entry.status === "pending")
    .map((entry) => ({
      id: entry.id,
      preview: queueEntryPreview(entry.content),
    }));
}

/**
 * Queue-affecting turn state for a surface that cannot hand over a session-shaped
 * `activeConversation` — the project cockpit passes `undefined` there so the
 * debug strip and the capability drawer stay session-only. Supplying it
 * explicitly is what lets a project conversation show and cancel its pending
 * follow-ups without also lighting up session-only chrome. Omitted, it is read
 * off `activeConversation`, so session surfaces are unchanged.
 */
export interface ComposerQueueTurnState {
  pendingQueue: readonly PendingQueuedMessage[];
  /** The server says a turn is running, so a submission queues rather than sends. */
  running: boolean;
}

interface PromptComposerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  activeConversation: ConversationState | undefined;
  queueTurnState?: ComposerQueueTurnState;
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
  /** Graph-workflow lane conversation — hides lane-ineligible slash commands. */
  isWorkflowManagedConversation?: boolean;
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
}

export default function PromptComposer({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  queueTurnState,
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
  isWorkflowManagedConversation = false,
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
}: PromptComposerProps): React.JSX.Element {
  const cancelOptimisticQueueEntry = useCancelOptimisticQueueEntry();
  const setQueueError = useSetQueueError();
  // The composer is handed the session-keyed storage name, which is the
  // sentinel for a project conversation. Converting it to explicit scope once,
  // here, is what lets the capability surfaces below address the
  // project-conversation cascade instead of inferring scope from the name (D1).
  const scope = useMemo(
    () => scopeRefFromStoreSessionName(sessionName),
    [sessionName],
  );
  const { containerRef, onFocus, onBlur, setControlActive } =
    useComposerFocus();

  const isMobile = useIsMobile();
  const composerFocused = useComposerFocused();
  // Latch held from the tap on the collapsed bar until the editor takes focus,
  // so the composer does not flicker back to collapsed in the intervening frame.
  const [expandLatch, setExpandLatch] = useState(false);
  const inputInert = isReadOnly || hasActiveCollab;
  const composerIdle = computeComposerIdle({
    promptText,
    pendingImageCount: pendingImages.length,
    isRecording,
    hasCollabChip,
    inputInert,
  });
  const composerCollapsed = computeComposerCollapsed({
    isMobile,
    idle: composerIdle,
    composerFocused,
    expandLatch,
  });
  // Once focus lands anywhere in the composer the latch has done its job; drop
  // it here (event-driven) so a later empty blur re-collapses via composerFocused.
  const handleComposerFocus = useCallback(() => {
    onFocus();
    setExpandLatch(false);
  }, [onFocus]);
  useEffect(() => {
    if (expandLatch) editorRef.current?.focus();
  }, [expandLatch, editorRef]);
  const expandComposer = useCallback(() => setExpandLatch(true), []);
  const selectedBackendLabel = backendLabel(selectedBackend);
  const collapsedPlaceholder = hasActiveCollab
    ? COLLAB_RUNNING_TOOLTIP
    : isFinished
      ? "Session is merged and read-only"
      : isReadOnly
        ? "Session is read-only"
        : (promptPlaceholder ?? `Message ${selectedBackendLabel}…`);
  // Portaled controls (model/effort dropdowns, capabilities drawer) render
  // outside this region and move focus away from the editor; they report their
  // open-state so the focus hook holds `composerFocused` true while open. Each
  // reporter is memoized so the controls' onOpenChange effects don't re-fire.
  const onModelOpenChange = useCallback(
    (open: boolean) => setControlActive("model", open),
    [setControlActive],
  );
  const onEffortOpenChange = useCallback(
    (open: boolean) => setControlActive("effort", open),
    [setControlActive],
  );
  const onCapabilitiesOpenChange = useCallback(
    (open: boolean) => setControlActive("capabilities", open),
    [setControlActive],
  );
  const onCapabilitiesMobileOpenChange = useCallback(
    (open: boolean) => setControlActive("capabilities-mobile", open),
    [setControlActive],
  );
  const onMobileSheetOpenChange = useCallback(
    (open: boolean) => setControlActive("mobile-sheet", open),
    [setControlActive],
  );
  const [hasSerializedContent, setHasSerializedContent] = useState(
    promptText.trim() !== "" || pendingImages.length > 0,
  );
  const { disabled: sendDisabled, title: sendTitle } = computeSendButtonState({
    promptText: hasSerializedContent ? "content" : promptText,
    pendingImageCount: pendingImages.length,
    sending,
    conversationRunning:
      queueTurnState?.running ?? activeConversation?.status === "running",
    conversationId,
    backend: selectedBackend,
    isReadOnly,
    isRecording,
    isProcessing,
  });
  const handlePrimaryAction = useCallback(() => {
    if (isRecording || isProcessing) {
      stopAndSubmit();
      return;
    }
    onSendPrompt();
  }, [isProcessing, isRecording, onSendPrompt, stopAndSubmit]);
  const cancellableEntries = selectCancellableQueueEntries(
    queueTurnState?.pendingQueue ?? activeConversation?.pendingQueue ?? [],
  );

  const cancelQueued = useCallback(
    async (id: string) => {
      // Optimistic removal is applied only on a confirmed cancel so a lost
      // race (the entry already claimed for delivery, returning 409) leaves
      // the pending entry visible. The `message-queue-updated` SSE reconciles
      // the durable cache afterward.
      //
      // Built from the conversation TARGET, not from the session name: a project
      // conversation's `sessionName` here is the internal store key, and
      // interpolating it would address `/sessions/__project__/…` — a route that
      // does not exist and a sentinel on a public URL.
      const url = `${conversationTargetApiBase(
        targetFromStoreSessionName(projectName, sessionName, conversationId),
      )}/queue/${encodeURIComponent(id)}`;
      let res: Response;
      try {
        res = await tracedFetch(url, "cancel-queued", { method: "DELETE" });
      } catch {
        setQueueError(conversationId, "Failed to cancel queued message");
        return;
      }
      if (!res.ok) {
        setQueueError(conversationId, "Failed to cancel queued message");
        return;
      }
      cancelOptimisticQueueEntry(conversationId, id);
    },
    [
      projectName,
      sessionName,
      conversationId,
      cancelOptimisticQueueEntry,
      setQueueError,
    ],
  );
  const sendBusy = sending && !conversationId;
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
    <div
      className="prompt-input-area shrink-0 border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-lg py-md max-768:border-border-default max-768:bg-[var(--cc-bg-base-a60)] max-768:px-sm max-768:py-xs"
      ref={containerRef}
      onFocus={handleComposerFocus}
      onBlur={onBlur}
    >
      {composerCollapsed ? (
        <MobileComposerBar
          placeholder={collapsedPlaceholder}
          disabled={inputInert}
          onExpand={expandComposer}
        />
      ) : (
        <div className="relative flex flex-col gap-sm">
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
              onDocumentChange={(document) =>
                setHasSerializedContent(
                  document.prompt.trim() !== "" || document.images.length > 0,
                )
              }
              onSubmit={handlePrimaryAction}
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
              isWorkflowManagedConversation={isWorkflowManagedConversation}
              onShowPlaceholder={showPlaceholder}
              disabled={isReadOnly}
              readOnly={hasActiveCollab}
              title={hasActiveCollab ? COLLAB_RUNNING_TOOLTIP : undefined}
              placeholder={
                isFinished
                  ? "Session is merged and read-only"
                  : (promptPlaceholder ??
                    `Send a prompt to ${selectedBackendLabel}...`)
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
          {cancellableEntries.length > 0 ? (
            <div
              className="mb-sm flex flex-wrap gap-xs"
              // A named group, not a landmark: this is a set of related controls
              // inside the composer, so the existing `aria-label` names it for
              // assistive tech without adding a page-level region to navigate.
              role="group"
              aria-label="Pending queued messages"
            >
              {cancellableEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="inline-flex max-w-full items-center gap-xs rounded-full border border-border-subtle bg-bg-raised px-sm py-2xs font-mono text-[0.72rem] text-text-secondary"
                >
                  <span className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.preview}
                  </span>
                  <WithTooltip label="Cancel queued message">
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-text-tertiary transition-colors duration-150 hover:text-red"
                      aria-label="Cancel queued message"
                      onClick={() => void cancelQueued(entry.id)}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </WithTooltip>
                </div>
              ))}
            </div>
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
            scope={scope}
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
            sendBusy={sendBusy}
            sendDisabled={sendDisabled}
            sendTitle={sendTitle}
            sendButtonInner={sendButtonInner}
            onSendPrompt={handlePrimaryAction}
            onModelOpenChange={onModelOpenChange}
            onEffortOpenChange={onEffortOpenChange}
            onCapabilitiesOpenChange={onCapabilitiesOpenChange}
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
            onSheetOpenChange={onMobileSheetOpenChange}
            debugActive={activeConversation?.debugMode?.active ?? false}
            debugSupported={!!activeConversation}
            onToggleDebug={onDebugToggle}
            debugDisabled={sending || debugTogglePending}
            debugPending={debugTogglePending}
            mcpRow={
              <div className={MOBILE_PROMPT_ROW_CLASS}>
                <ConversationAgentCapabilitiesConfig
                  projectName={projectName}
                  scope={scope}
                  conversationId={conversationId}
                  disabled={isReadOnly}
                  disabledTooltip={
                    isReadOnly ? "Session is read-only" : undefined
                  }
                  onOpenChange={onCapabilitiesMobileOpenChange}
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
            sendButton={
              <button
                className={SEND_BUTTON_CLASS}
                data-busy={sendBusy}
                disabled={sendDisabled}
                onClick={handlePrimaryAction}
                title={sendTitle}
              >
                {sendButtonInner}
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}
