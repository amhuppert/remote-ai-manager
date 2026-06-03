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
import { useOverlayScope } from "@/hooks/useOverlayScope";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import MessageRow from "@/components/conversation/MessageRow";
import TypingIndicator from "@/components/conversation/TypingIndicator";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { BranchIcon, CloseIcon } from "@/components/icons";
import {
  PromptEditor,
  type PromptEditorHandle,
} from "@/features/session/prompt/PromptEditor";
import { useVoiceWiring } from "@/features/session/hooks/use-voice-wiring";
import type {
  ActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

type ActiveConversationStatus = ActiveConversation["status"];

interface PeekPopoverProps {
  anchorEl: HTMLElement | null;
  conversation: SessionActiveConversation;
  transcriptMessages: TranscriptMessage[];
  onClose: () => void;
  onOpenFull: () => void;
  onReplyText: (text: string) => void;
  onAnswerQuestion: (answers: Record<string, string>) => void;
  onFork: (messageIndex: number) => void;
}

const STATUS_LABEL: Record<ActiveConversationStatus, string> = {
  waiting_for_input: "waiting for input",
  running: "running",
  awaiting: "awaiting",
  new: "new",
};
const EMPTY_IMAGE_ATTACHMENTS: ImageAttachment[] = [];
const DEFAULT_REPLY_PLACEHOLDER = "Reply to this conversation...";

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

function isVoiceToggleEvent(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "v"
  );
}

async function ignorePeekImagePaste(): Promise<ImageAttachment | null> {
  return null;
}

function PeekReplyComposer({
  conversation,
  onReplyText,
}: {
  conversation: SessionActiveConversation;
  onReplyText: (text: string) => void;
}): React.JSX.Element {
  const [replyText, setReplyText] = useState("");
  const [hasReplyContent, setHasReplyContent] = useState(false);
  const [placeholder, setPlaceholder] = useState(DEFAULT_REPLY_PLACEHOLDER);
  const editorRef = useRef<PromptEditorHandle | null>(null);
  const promptTextRef = useRef(replyText);
  const fireAndForgetRef = useRef(false);

  useEffect(() => {
    promptTextRef.current = replyText;
  }, [replyText]);

  const handleReplyTextChange = useCallback((text: string) => {
    setReplyText(text);
    const serialized = editorRef.current?.serialize(EMPTY_IMAGE_ATTACHMENTS);
    setHasReplyContent((serialized?.prompt ?? text).trim() !== "");
  }, []);

  const submitReply = useCallback(async () => {
    const serialized = editorRef.current?.serialize(EMPTY_IMAGE_ATTACHMENTS);
    const trimmed = (serialized?.prompt ?? promptTextRef.current).trim();
    if (trimmed === "") return;
    logPeekDebug("peek.reply.submit", {
      conversationId: conversation.id,
      status: conversation.status,
      textLength: trimmed.length,
    });
    onReplyText(trimmed);
    editorRef.current?.clear();
    setReplyText("");
    setHasReplyContent(false);
    setPlaceholder(DEFAULT_REPLY_PLACEHOLDER);
  }, [conversation.id, conversation.status, onReplyText]);

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
    stopAndSubmit,
  } = useVoiceWiring({
    projectName: conversation.projectName,
    promptTextRef,
    editorRef,
    fireAndForgetRef,
    handleSendPrompt: submitReply,
    hotkeyEnabled: false,
  });

  const handleToggleRecording = useCallback(() => {
    if (!isRecording && !isProcessing) {
      fireAndForgetRef.current = false;
    }
    void toggleRecording();
  }, [isRecording, isProcessing, toggleRecording]);

  const handleSubmit = useCallback(() => {
    if (isRecording) {
      stopAndSubmit();
      return;
    }
    void submitReply();
  }, [isRecording, stopAndSubmit, submitReply]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isVoiceToggleEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!voiceAvailable || isProcessing) return;
      handleToggleRecording();
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [voiceAvailable, isProcessing, handleToggleRecording]);

  const sendDisabled = !hasReplyContent || isRecording || isProcessing;

  return (
    <div className="peek__composer-box">
      <PromptEditor
        ref={editorRef}
        conversationId={conversation.id}
        value={replyText}
        onChange={handleReplyTextChange}
        onSubmit={handleSubmit}
        pendingImages={EMPTY_IMAGE_ATTACHMENTS}
        onAddImage={ignorePeekImagePaste}
        onRemoveImage={() => {}}
        cumulativeImageCount={0}
        projectName={conversation.projectName}
        sessionName={conversation.sessionName}
        backend={conversation.agentBackend}
        ariaLabel="Reply text"
        placeholder={placeholder}
        onShowPlaceholder={setPlaceholder}
      />
      <div className="peek__composer-actions">
        <VoiceRecordButton
          isRecording={isRecording}
          isProcessing={isProcessing}
          elapsedTime={elapsedTime}
          isAvailable={voiceAvailable}
          toggleRecording={handleToggleRecording}
        />
        <button
          type="button"
          className="peek__send"
          onClick={handleSubmit}
          disabled={sendDisabled}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default function PeekPopover({
  anchorEl,
  conversation,
  transcriptMessages,
  onClose,
  onOpenFull,
  onReplyText,
  onAnswerQuestion,
  onFork,
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
  const className = ["peek", hasPendingQuestions ? "peek--asking" : null]
    .filter(Boolean)
    .join(" ");

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
    (_questionId: string, answers: Record<string, string>) => {
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
          <header className="peek__head">
            <div className="peek__top">
              <span
                className={`peek__dot peek__dot--${conversation.status}`}
                aria-hidden="true"
              />
              <span className="peek__title" title={title}>
                {title}
              </span>
              <button
                type="button"
                className="peek__btn peek__btn--primary"
                onClick={handleOpenFull}
              >
                Open conversation
              </button>
              <button
                type="button"
                className="peek__close"
                onClick={onClose}
                aria-label="Close peek"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="peek__meta">
              <span
                className={`peek__status peek__status--${conversation.status}`}
              >
                {STATUS_LABEL[conversation.status]}
              </span>
              <span aria-hidden="true">·</span>
              <b>{conversation.projectName}</b>
              <span aria-hidden="true">·</span>
              <span className="peek__meta-session">
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

          <div className="peek__body" ref={setBodyRef}>
            {showFallbackBanner && (
              <div className="peek__awaiting">
                {conversation.pendingQuestion}
              </div>
            )}

            {transcriptMessages.length === 0 ? (
              <div className="peek__empty">No transcript messages yet.</div>
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
                  lastMessageExtras={null}
                />
              ))
            )}
            <TypingIndicator
              selectedBackend={conversation.agentBackend}
              visible={conversation.status === "running"}
              hasAssistantOptimistic={false}
            />
          </div>

          <footer className="peek__composer">
            {hasPendingQuestions ? (
              <AskQuestionPanel
                questions={pendingQuestions}
                questionId={conversation.pendingQuestionId ?? conversation.id}
                currentIndex={currentQuestionIndex}
                onNavigate={handleQuestionNavigate}
                onSubmit={handleQuestionSubmit}
              />
            ) : (
              <PeekReplyComposer
                conversation={conversation}
                onReplyText={onReplyText}
              />
            )}
          </footer>
        </section>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
