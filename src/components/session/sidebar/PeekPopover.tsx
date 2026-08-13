"use client";

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import ApprovalGatePanel, {
  type ApprovalScopedChanges,
} from "@/components/ApprovalGatePanel";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import MessageRow from "@/components/conversation/MessageRow";
import TypingIndicator from "@/components/conversation/TypingIndicator";
import {
  RichPromptInput,
  type RichPromptInputHandle,
} from "@/components/rich-prompt/RichPromptInput";
import CollabConfigRow from "@/components/session/CollabConfigRow";
import { BranchIcon, CloseIcon } from "@/components/icons";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import type {
  ActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import {
  isWorkflowLaneRole,
  type AskQuestionAnswer,
  type TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import {
  hasCollabPrefix,
  stripCollabPrefix,
} from "@/lib/conversation-commands/parse";
import { buildAgentTwoStartRequest } from "@/lib/workflows/collaboration/agent-two-request";
import { oppositeCollaborationBackend } from "@/lib/workflows/collaboration/backend-pair";
import {
  type CollabConfigDraft,
  seedAgentTwoDraft,
  useClearCollabConfigDraft,
  useCollabConfigDraft,
  useSetCollabConfigDraft,
} from "@/stores/collaboration.store";
import type { PeekCollabConfig } from "@/components/session/sidebar/use-peek-reply";

type ActiveConversationStatus = ActiveConversation["status"];

type PeekReplyArgs =
  | [text: string, images: ImagePayload[]]
  | [
      text: string,
      images: ImagePayload[],
      collab: PeekCollabConfig,
      collabDraft: CollabConfigDraft,
    ];

export interface PeekApprovalGate {
  isSubmitting: boolean;
  executionSuspended: boolean;
  /**
   * The frozen owned-path artifact for an enveloped context, null for a
   * full-access one (R15.2). Required rather than optional: the peek offers
   * live Approve/Reject controls, so it is a real approval surface, and a
   * surface that can decide has to state what it is deciding on instead of
   * defaulting into showing nothing.
   */
  scopedChanges: ApprovalScopedChanges | null;
  onApprove(): void;
  onReject(message: string): void;
}

interface PeekPopoverProps {
  anchorEl: HTMLElement | null;
  conversation: SessionActiveConversation;
  transcriptMessages: TranscriptMessage[];
  backendDefaults: BackendSelectionDefaultsById | null;
  onClose: () => void;
  onOpenFull: () => void;
  onReplyText: (...args: PeekReplyArgs) => void;
  /** Reply mutation in flight — the send control shows a visible sending state. */
  isSendingReply?: boolean;
  onAnswerQuestion: (answers: Record<string, AskQuestionAnswer>) => void;
  onFork: (messageIndex: number, profile?: AgentProfileRef) => void;
  /**
   * Project whose profile library the index-0 fork picker lists. The peek
   * renders the conversation's real transcript indices, so index 0 here is the
   * same fresh-conversation fork the full transcript offers (R7.1).
   */
  forkProjectName: string;
  approvalGate?: PeekApprovalGate | null;
}

const STATUS_LABEL: Record<ActiveConversationStatus, string> = {
  waiting_for_input: "waiting for input",
  running: "running",
  awaiting: "awaiting",
  new: "new",
};
const DEFAULT_REPLY_PLACEHOLDER = "Reply to this conversation...";

// Status dot color (legacy `.peek__dot--<status>`).
const PEEK_DOT: Record<ActiveConversationStatus, string> = {
  running:
    "bg-cyan shadow-[0_0_6px_var(--color-cyan-glow-strong)] animate-[peek-dot-pulse_1.6s_ease-in-out_infinite]",
  waiting_for_input: "bg-amber shadow-[0_0_6px_var(--color-amber-glow)]",
  awaiting: "bg-green shadow-[0_0_4px_var(--color-green-glow)]",
  new: "bg-blue shadow-[0_0_6px_var(--color-blue-glow)]",
};

// Status pill color (legacy `.peek__status--<status>`); approval reuses amber.
const PEEK_STATUS_COLOR: Record<ActiveConversationStatus, string> = {
  waiting_for_input: "text-amber",
  running: "text-cyan",
  awaiting: "text-green",
  new: "text-blue",
};

function formatPeekTime(isoDate: string): string {
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getConversationTitle(conversation: ActiveConversation): string {
  return conversation.name ?? conversation.summary ?? "Unnamed conversation";
}

function logPeekDebug(message: string, fields: Record<string, unknown>): void {
  if (typeof window !== "undefined") return;
  void import("@/lib/logging").then(({ createLogger }) => {
    createLogger("features/session/sidebar/PeekPopover").debug(message, fields);
  });
}

function PeekReplyComposer({
  conversation,
  backendDefaults,
  onReplyText,
  isSending = false,
}: {
  conversation: SessionActiveConversation;
  backendDefaults: BackendSelectionDefaultsById | null;
  onReplyText: (...args: PeekReplyArgs) => void;
  isSending?: boolean;
}): React.JSX.Element {
  const [replyText, setReplyText] = useState("");
  const [hasReplyText, setHasReplyText] = useState(false);
  const [hasImages, setHasImages] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [placeholder, setPlaceholder] = useState(DEFAULT_REPLY_PLACEHOLDER);
  const promptRef = useRef<RichPromptInputHandle | null>(null);
  const collabConfigDraft = useCollabConfigDraft(
    conversation.projectName,
    conversation.sessionName,
    conversation.id,
  );
  const setCollabConfigDraft = useSetCollabConfigDraft();
  const clearCollabConfigDraft = useClearCollabConfigDraft();
  const originatingAgent = conversation.agentBackend;
  const hasCollabCommand = hasCollabPrefix(replyText);
  const effectiveCollabConfig = useMemo(() => {
    if (backendDefaults === null) return null;
    const agentTwo =
      collabConfigDraft.agentTwo ??
      seedAgentTwoDraft(
        oppositeCollaborationBackend(originatingAgent),
        backendDefaults,
      );
    return { ...collabConfigDraft, agentTwo };
  }, [backendDefaults, collabConfigDraft, originatingAgent]);

  const handleReplyTextChange = useCallback((text: string) => {
    setReplyText(text);
    setHasReplyText(text.trim() !== "");
  }, []);

  const submitReply = useCallback(
    (document: SerializedPromptDoc) => {
      if (isSending) return;
      const trimmed = document.prompt.trim();
      if (trimmed === "" && document.images.length === 0) return;
      const collaborationRequested = hasCollabPrefix(trimmed);
      if (collaborationRequested && stripCollabPrefix(trimmed).trim() === "") {
        return;
      }
      if (collaborationRequested && effectiveCollabConfig === null) return;
      logPeekDebug("peek.reply.submit", {
        conversationId: conversation.id,
        status: conversation.status,
        textLength: trimmed.length,
        imageCount: document.images.length,
        collaborationRequested,
      });
      if (collaborationRequested && effectiveCollabConfig !== null) {
        const agentTwo = buildAgentTwoStartRequest(
          effectiveCollabConfig.agentTwo,
        );
        onReplyText(
          trimmed,
          document.images,
          {
            negotiationRounds: effectiveCollabConfig.negotiationRounds,
            autonomousResolutionThreshold:
              effectiveCollabConfig.autonomousResolutionThreshold,
            ...(agentTwo !== null ? { agentTwo } : {}),
          },
          effectiveCollabConfig,
        );
      } else {
        onReplyText(trimmed, document.images);
      }
      promptRef.current?.clear();
      setReplyText("");
      setHasReplyText(false);
      setHasImages(false);
      setPlaceholder(DEFAULT_REPLY_PLACEHOLDER);
    },
    [
      conversation.id,
      conversation.status,
      effectiveCollabConfig,
      isSending,
      onReplyText,
    ],
  );

  const handleSubmit = useCallback(() => {
    promptRef.current?.primaryAction();
  }, []);

  const collabBriefMissing =
    hasCollabCommand && stripCollabPrefix(replyText).trim() === "";
  const sendDisabled =
    (!hasReplyText && !hasImages && !voiceBusy) ||
    isSending ||
    collabBriefMissing ||
    (hasCollabCommand && effectiveCollabConfig === null);

  const dismissCollab = useCallback(() => {
    const document = promptRef.current?.serialize();
    if (document !== undefined) {
      promptRef.current?.replacePrompt(stripCollabPrefix(document.prompt));
    }
    clearCollabConfigDraft(
      conversation.projectName,
      conversation.sessionName,
      conversation.id,
    );
  }, [clearCollabConfigDraft, conversation]);

  return (
    <div className="flex flex-col">
      {hasCollabCommand &&
      effectiveCollabConfig !== null &&
      backendDefaults !== null ? (
        <CollabConfigRow
          config={effectiveCollabConfig}
          originatingAgent={originatingAgent}
          onChange={(next) =>
            setCollabConfigDraft(
              conversation.projectName,
              conversation.sessionName,
              conversation.id,
              next,
            )
          }
          onDismiss={dismissCollab}
          backendDefaults={backendDefaults}
          projectName={conversation.projectName}
          selectContentLayer="popover"
        />
      ) : hasCollabCommand ? (
        <div
          className="rounded-t-md border border-b-0 border-solid border-border-subtle bg-bg-base px-md py-sm font-mono text-[0.7rem] text-text-secondary"
          role="status"
        >
          Loading collaboration controls…
        </div>
      ) : null}
      <div
        className={cn(
          "peek__composer-box grid grid-cols-[minmax(0,1fr)_auto] items-end gap-sm rounded-md border border-solid border-cyan-dim bg-bg-surface px-[10px] py-[8px] shadow-[0_0_0_3px_var(--color-cyan-glow)] focus-within:border-cyan focus-within:shadow-[0_0_0_3px_var(--color-cyan-glow-strong)]",
          hasCollabCommand && "rounded-t-none",
        )}
      >
        <RichPromptInput
          ref={promptRef}
          capabilityContext={{
            projectName: conversation.projectName,
            sessionName: conversation.sessionName,
            conversationId: conversation.id,
            backend: conversation.agentBackend,
            isWorkflowManagedConversation: isWorkflowLaneRole(
              conversation.role,
            ),
          }}
          value={replyText}
          onValueChange={handleReplyTextChange}
          onDocumentChange={(document) =>
            setHasReplyText(document.prompt.trim() !== "")
          }
          onSubmit={submitReply}
          onImagesChange={(images) => setHasImages(images.length > 0)}
          onVoiceStateChange={setVoiceBusy}
          ariaLabel="Reply text"
          placeholder={placeholder}
          submitLabel="Send"
          showSubmitControl={false}
          disabled={isSending}
        />
        <div className="inline-flex items-center gap-xs">
          <button
            type="button"
            className="inline-flex min-h-[28px] cursor-pointer items-center justify-center rounded-sm border-0 bg-cyan px-[10px] py-[4px] font-mono text-[9.5px] font-semibold tracking-[0.06em] text-text-inverse uppercase disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSubmit}
            disabled={sendDisabled}
            aria-busy={isSending || undefined}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PeekPopover({
  anchorEl,
  conversation,
  transcriptMessages,
  backendDefaults,
  onClose,
  onOpenFull,
  onReplyText,
  isSendingReply = false,
  onAnswerQuestion,
  onFork,
  forkProjectName,
  approvalGate = null,
}: PeekPopoverProps): React.JSX.Element | null {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyMounted, setBodyMounted] = useState(false);
  const messageCount = transcriptMessages.length;

  const setBodyRef = useCallback((node: HTMLDivElement | null) => {
    bodyRef.current = node;
    setBodyMounted(node !== null);
  }, []);

  const pendingQuestions = useMemo(
    () => conversation.pendingQuestions ?? [],
    [conversation.pendingQuestions],
  );
  const questionResetKey = useMemo(
    () =>
      [
        conversation.pendingQuestionId ?? "",
        ...pendingQuestions.map((question) => question.question),
      ].join("\u0000"),
    [conversation.pendingQuestionId, pendingQuestions],
  );
  const [questionNav, setQuestionNav] = useState({
    key: questionResetKey,
    index: 0,
  });
  const rawQuestionIndex =
    questionNav.key === questionResetKey ? questionNav.index : 0;
  const currentQuestionIndex =
    pendingQuestions.length === 0
      ? 0
      : Math.min(rawQuestionIndex, pendingQuestions.length - 1);

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    placement: "right-start",
    middleware: [
      offset({ mainAxis: 8, crossAxis: -40 }),
      flip({
        fallbackPlacements: ["left-start", "bottom-start", "top-start"],
      }),
      shift({ padding: 12 }),
      size({
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.min(620, availableHeight)}px`;
        },
        padding: 12,
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const dismiss = useDismiss(context);
  const { getFloatingProps } = useInteractions([dismiss]);

  useOverlayScope(true);

  const setFloatingRef = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node);
    },
    [refs],
  );

  const hasPendingQuestions = pendingQuestions.length > 0;
  const showFallbackBanner =
    conversation.status === "waiting_for_input" &&
    !hasPendingQuestions &&
    conversation.pendingQuestion !== null &&
    conversation.pendingQuestion.trim() !== "";
  const title = getConversationTitle(conversation);
  const timeLabel = formatPeekTime(conversation.lastActivityAt);
  const sessionLabel = conversation.branchName ?? conversation.sessionName;
  // The ≤800px reposition pins the popover to the bottom of the viewport,
  // overriding the inline floating-ui positioning (hence `!`).
  const className = cn(
    "z-popover flex max-h-[620px] w-[460px] animate-[peek-in_0.16s_cubic-bezier(0.2,0.7,0.3,1)] flex-col overflow-hidden rounded-lg border border-solid border-border-strong bg-bg-surface font-body text-text-primary shadow-[0_18px_48px_var(--cc-black-a50),0_0_0_1px_var(--cc-cyan-a04)] max-800:fixed! max-800:inset-[auto_12px_12px]! max-800:max-h-[min(72dvh,620px)]! max-800:w-auto max-800:transform-none!",
  );

  useEffect(() => {
    refs.setReference(anchorEl);
  }, [anchorEl, refs]);

  useEffect(() => {
    if (!bodyMounted) return;
    if (messageCount === 0) return;
    const body = bodyRef.current;
    if (body === null) return;

    let userScrolled = false;
    const NEAR_BOTTOM_PX = 8;
    const isNearBottom = () =>
      body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_BOTTOM_PX;
    const handleScroll = () => {
      if (!isNearBottom()) userScrolled = true;
    };
    const scrollToBottom = () => {
      if (userScrolled) return;
      body.scrollTop = body.scrollHeight;
    };

    scrollToBottom();
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(body);
    Array.from(body.children).forEach((child) => observer.observe(child));
    body.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      observer.disconnect();
      body.removeEventListener("scroll", handleScroll);
    };
  }, [bodyMounted, messageCount]);

  const handleOpenFull = useCallback(() => {
    logPeekDebug("peek.open_full", { conversationId: conversation.id });
    onOpenFull();
  }, [conversation.id, onOpenFull]);

  const handleQuestionSubmit = useCallback(
    (_questionId: string, answers: Record<string, AskQuestionAnswer>) => {
      logPeekDebug("peek.question.submit", {
        conversationId: conversation.id,
        answerCount: Object.keys(answers).length,
      });
      onAnswerQuestion(answers);
    },
    [conversation.id, onAnswerQuestion],
  );

  const handleQuestionNavigate = useCallback(
    (index: number) => {
      setQuestionNav({ key: questionResetKey, index });
    },
    [questionResetKey],
  );

  if (anchorEl === null) return null;

  return (
    <FloatingPortal>
      <FloatingOverlay className="peek-backdrop" lockScroll onClick={onClose} />
      <FloatingFocusManager context={context} initialFocus={-1}>
        <section
          ref={setFloatingRef}
          className={className}
          style={floatingStyles}
          aria-label="Conversation peek"
          {...getFloatingProps()}
        >
          <header className="border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base p-md">
            <div className="mb-xs flex min-w-0 items-center gap-sm">
              <span
                className={cn(
                  "size-[7px] flex-none rounded-full bg-text-tertiary",
                  PEEK_DOT[conversation.status],
                )}
                aria-hidden="true"
              />
              <span
                className="min-w-0 flex-1 overflow-hidden font-display text-[14px] font-semibold text-ellipsis whitespace-nowrap text-text-primary"
                title={title}
              >
                {title}
              </span>
              <button
                type="button"
                className="inline-flex min-h-[28px] cursor-pointer items-center justify-center gap-[5px] rounded-sm border border-solid border-cyan-dim bg-cyan-glow px-[9px] py-[4px] font-mono text-[9.5px] font-semibold tracking-[0.07em] whitespace-nowrap text-cyan uppercase hover:border-cyan hover:bg-cyan hover:text-text-inverse"
                onClick={handleOpenFull}
              >
                Open conversation
              </button>
              <button
                type="button"
                className="inline-flex size-[24px] flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                onClick={onClose}
                aria-label="Close peek"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-[6px] font-mono text-[10.5px] leading-[1.4] text-text-tertiary [&_b]:font-medium [&_b]:text-text-secondary">
              {conversation.pendingApproval !== null ? (
                <span className="inline-flex flex-none items-center gap-xs font-mono text-[10px] leading-[1.4] font-semibold tracking-[0.08em] text-amber uppercase">
                  awaiting approval ·{" "}
                  {formatPeekTime(conversation.pendingApproval.requestedAt)}
                </span>
              ) : (
                <span
                  className={cn(
                    "inline-flex flex-none items-center gap-xs font-mono text-[10px] leading-[1.4] font-semibold tracking-[0.08em] uppercase",
                    PEEK_STATUS_COLOR[conversation.status],
                  )}
                >
                  {STATUS_LABEL[conversation.status]}
                </span>
              )}
              <span aria-hidden="true">·</span>
              <b>{conversation.projectName}</b>
              <span aria-hidden="true">·</span>
              <span className="inline-flex min-w-0 items-center gap-[4px] overflow-hidden text-ellipsis whitespace-nowrap [&_svg]:flex-none">
                <BranchIcon size={12} />
                {sessionLabel}
              </span>
              {timeLabel !== "" && (
                <>
                  <span aria-hidden="true">·</span>
                  <time dateTime={conversation.lastActivityAt}>
                    {timeLabel}
                  </time>
                </>
              )}
            </div>
          </header>

          <div className="relative flex min-h-0 flex-auto flex-col">
            <div
              className={cn(
                "flex min-h-0 flex-auto flex-col gap-md overflow-y-auto bg-bg-surface",
                hasPendingQuestions
                  ? "max-h-none px-md pt-md pb-[66px]"
                  : "max-h-[310px] p-md",
              )}
              ref={setBodyRef}
              data-testid="peek-body"
            >
              {showFallbackBanner && (
                <div className="flex flex-col gap-xs rounded-sm border border-solid border-amber-dim bg-amber-glow px-[11px] py-[8px] font-body text-[11.5px] leading-[1.5] text-amber">
                  {conversation.pendingQuestion}
                </div>
              )}

              {transcriptMessages.length === 0 ? (
                <div className="px-0 py-md text-center font-body text-[12px] text-text-tertiary">
                  No transcript messages yet.
                </div>
              ) : (
                transcriptMessages.map((message, index) => (
                  <MessageRow
                    key={`${message.role}-${message.timestamp ?? "no-time"}-${index}`}
                    msg={message}
                    messageIndex={index}
                    isLast={index === transcriptMessages.length - 1}
                    selectedBackend={conversation.agentBackend}
                    worktreePath={conversation.worktreePath}
                    onFork={onFork}
                    forkProjectName={forkProjectName}
                    lastMessageExtras={null}
                  />
                ))
              )}
              <TypingIndicator
                conversationId={conversation.id}
                selectedBackend={conversation.agentBackend}
                visible={conversation.status === "running"}
              />
            </div>

            {(!hasPendingQuestions ||
              (conversation.pendingApproval !== null &&
                approvalGate != null)) && (
              <footer className="max-h-[55dvh] flex-none overflow-y-auto border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-base px-md pt-[9px] pb-md">
                {conversation.pendingApproval !== null &&
                  approvalGate != null && (
                    <ApprovalGatePanel
                      contextTitle={conversation.pendingApproval.contextTitle}
                      // The workflow segment is dropped in the peek's compact
                      // strip; the 380px card only fits the context.
                      workflowName={null}
                      requestedAt={conversation.pendingApproval.requestedAt}
                      isSubmitting={approvalGate.isSubmitting}
                      conversationBusy={conversation.status === "running"}
                      executionSuspended={approvalGate.executionSuspended}
                      scopedChanges={approvalGate.scopedChanges}
                      onApprove={approvalGate.onApprove}
                      onReject={approvalGate.onReject}
                      voiceProjectName={conversation.projectName}
                    />
                  )}
                {!hasPendingQuestions && (
                  <PeekReplyComposer
                    conversation={conversation}
                    backendDefaults={backendDefaults}
                    onReplyText={onReplyText}
                    isSending={isSendingReply}
                  />
                )}
              </footer>
            )}

            {hasPendingQuestions && (
              <AskQuestionPanel
                key={questionResetKey}
                questions={pendingQuestions}
                questionId={conversation.pendingQuestionId ?? conversation.id}
                currentIndex={currentQuestionIndex}
                onNavigate={handleQuestionNavigate}
                onSubmit={handleQuestionSubmit}
                agent={conversation.agentBackend}
                compact
                voiceProjectName={conversation.projectName}
              />
            )}
          </div>
        </section>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
