"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import ConversationVirtuosoList, {
  type ConversationVirtuosoListProps,
  type VirtuosoHandle,
} from "./ConversationVirtuosoList";
import MessageRow from "./MessageRow";
import TypingIndicator from "./TypingIndicator";
import BackgroundActivityIndicator from "./BackgroundActivityIndicator";
import {
  buildConversationRows,
  computeLastVisibleMessageIndex,
  type CollabEnvelope,
  type TranscriptExtensionRowData,
} from "./conversation-rows";
import { EmptyStateTitle, EmptyStateDesc } from "@/components/ui/EmptyState";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
import { useDisplayMessages } from "@/hooks/conversation/use-display-messages";
import { useConversationNav } from "@/hooks/conversation/use-conversation-nav";
import {
  useDismissCancelled,
  useDismissError,
  usePromptCancelledFor,
  usePromptErrorFor,
  useSendingFor,
} from "@/stores/session-detail.store";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";
import type {
  ConversationBackgroundActivity,
  ConversationStatus,
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

/**
 * Address of the conversation a transcript renders — session-scoped (the
 * conversation page, panes, workflow viewers) or project-scoped (the project
 * cockpit). The scope picks which messages query feeds the transcript; both
 * caches are patched live by the global SSE listener under the same keys.
 */
export type ConversationScopeRef =
  | {
      kind: "session";
      projectName: string;
      sessionName: string;
      conversationId: string;
    }
  | { kind: "project"; projectName: string; conversationId: string };

/** Scroll-derived nav state reported to parent chrome (header counter/buttons). */
export interface TranscriptNav {
  currentMessageIndex: number;
  totalMessages: number;
  followBottom: boolean;
  handleFirstMessage(): void;
  handlePrevMessage(): void;
  handleNextMessage(): void;
  handleLastMessage(): void;
}

/** Collab passage integration — only meaningful for session-scoped transcripts. */
export interface TranscriptCollab {
  envelope: CollabEnvelope | undefined;
  hiddenMessageIndex: number | null;
  renderRow: ConversationVirtuosoListProps["renderCollab"];
  /** True while the collab workflow is active — suppresses the typing indicator. */
  suppressIndicator: boolean;
}

/**
 * Surface-supplied rows interleaved among the messages (the cockpit's spawn
 * cards). Method syntax keeps `render` bivariant, so a surface may type both
 * `rows` and `render` with its own `TranscriptExtensionRowData` subtype — the
 * rows handed back to `render` are exactly the rows passed in.
 */
export interface TranscriptExtensions {
  rows?: readonly TranscriptExtensionRowData[];
  /** Derive durable rows from the server-projected transcript on every load. */
  deriveRows?(
    messages: readonly TranscriptMessage[],
  ): readonly TranscriptExtensionRowData[];
  /** Remove raw units replaced by an extension card before message rendering. */
  transformContent?(
    content: readonly TranscriptMessage["content"][number][],
    messageIndex: number,
    messages: readonly TranscriptMessage[],
  ): TranscriptMessage["content"];
  render(row: TranscriptExtensionRowData): ReactNode;
}

export interface ConversationTranscriptProps {
  scope: ConversationScopeRef;
  backend: AgentBackendId;
  /**
   * Server-side turn status. The working indicator shows while the
   * conversation's own keyed `sending` flag is set OR the server reports
   * `running` — the same gate on every surface.
   */
  status?: ConversationStatus | undefined;
  /** Durable queued messages, rendered as pending rows after the transcript. */
  pendingQueue?: readonly PendingQueuedMessage[] | undefined;
  /**
   * Live harness background work for this conversation. Shown only between
   * turns: while a turn streams the typing indicator already reports activity.
   * Surfaces that cannot resolve it (the workflow viewer) leave it unset.
   */
  backgroundActivity?: ConversationBackgroundActivity | null | undefined;
  worktreePath?: string | undefined;
  thinkingExpansionCommand?: ThinkingBlockExpansionCommand | undefined;
  /**
   * Message-row renderer override for surfaces with extra affordances (fork,
   * compaction, debug cards). The default renders the shared `MessageRow`
   * read-only.
   */
  renderMessageRow?: ConversationVirtuosoListProps["renderMessage"];
  collab?: TranscriptCollab | undefined;
  extensions?: TranscriptExtensions | undefined;
  /**
   * Surface this conversation's keyed prompt-error / cancelled banners inside
   * the transcript region.
   */
  showInFlightBanners?: boolean;
  /**
   * Rendered inside the `.conversation` region ahead of the transcript — the
   * main panel mounts its sticky collab pinned-top target here.
   */
  leadingSlot?: ReactNode;
  /** Reports scroll-derived nav state upward for header chrome. */
  onNavChange?: (nav: TranscriptNav) => void;
  /** Share the scroller handle with parent chrome (hotkeys, nav shortcuts). */
  virtuosoRef?: RefObject<VirtuosoHandle | null>;
  /** Replaces the default "No messages yet" empty state. */
  emptyState?: ReactNode;
}

/**
 * The unified conversation transcript: one container that owns the messages
 * query (scope-dispatched), the optimistic/queue display projection, row
 * building (collab passage + queued rows), the working indicator gate,
 * follow-bottom scroll state, and the loading/empty/error states. Every
 * conversation surface (main panel, split-screen pane, project cockpit,
 * workflow viewer) renders this component so transcript behavior cannot
 * drift between them; chrome (headers, composers, gates) stays per-surface.
 */
export default function ConversationTranscript(
  props: ConversationTranscriptProps,
): React.JSX.Element {
  return props.scope.kind === "session" ? (
    <SessionScopedTranscript {...props} scope={props.scope} />
  ) : (
    <ProjectScopedTranscript {...props} scope={props.scope} />
  );
}

type ScopedProps<K extends ConversationScopeRef["kind"]> = Omit<
  ConversationTranscriptProps,
  "scope"
> & { scope: Extract<ConversationScopeRef, { kind: K }> };

function SessionScopedTranscript(
  props: ScopedProps<"session">,
): React.JSX.Element {
  const query = useConversationMessagesQuery(
    props.scope.projectName,
    props.scope.sessionName,
    props.scope.conversationId,
  );
  return (
    <TranscriptCore
      {...props}
      conversationId={props.scope.conversationId}
      messages={query.data}
      isPending={query.isPending}
      isError={query.isError}
    />
  );
}

function ProjectScopedTranscript(
  props: ScopedProps<"project">,
): React.JSX.Element {
  const query = useProjectConversationMessagesQuery(
    props.scope.projectName,
    props.scope.conversationId,
  );
  return (
    <TranscriptCore
      {...props}
      conversationId={props.scope.conversationId}
      messages={query.data}
      isPending={query.isPending}
      isError={query.isError}
    />
  );
}

const stateClass =
  "flex flex-col items-center justify-center py-xl text-center";

interface TranscriptCoreProps extends Omit<
  ConversationTranscriptProps,
  "scope"
> {
  conversationId: string;
  messages: readonly TranscriptMessage[] | undefined;
  isPending: boolean;
  isError: boolean;
}

// Stable fallback while the query has no data: a fresh `[]` per render would
// rebuild rows (and everything downstream) on every render.
const EMPTY_MESSAGES: readonly TranscriptMessage[] = [];

function TranscriptCore({
  conversationId,
  backend,
  status,
  pendingQueue,
  backgroundActivity,
  worktreePath,
  thinkingExpansionCommand,
  renderMessageRow,
  collab,
  extensions,
  showInFlightBanners = false,
  leadingSlot,
  onNavChange,
  virtuosoRef: externalVirtuosoRef,
  emptyState,
  messages,
  isPending,
  isError,
}: TranscriptCoreProps): React.JSX.Element {
  const displayMessages = useDisplayMessages(
    conversationId,
    messages ?? EMPTY_MESSAGES,
    pendingQueue,
  );

  const collabEnvelope = collab?.envelope;
  const hiddenMessageIndex = collab?.hiddenMessageIndex ?? null;
  const rawMessages = messages ?? EMPTY_MESSAGES;
  const extensionRows = useMemo(
    () => [
      ...(extensions?.rows ?? []),
      ...(extensions?.deriveRows?.(rawMessages) ?? []),
    ],
    [extensions, rawMessages],
  );
  // Applied here rather than per rendered row: the transform decides how many
  // renderable units a message has, so the split must see its output. It also
  // stops the projection from re-running for every row on every render.
  const transformContent = extensions?.transformContent;
  const rowContentTransform = useMemo(
    () =>
      transformContent === undefined
        ? undefined
        : (content: MessageContentBlock[], messageIndex: number) =>
            transformContent(content, messageIndex, rawMessages),
    [transformContent, rawMessages],
  );
  const rows = useMemo(
    () =>
      buildConversationRows(
        displayMessages,
        collabEnvelope,
        hiddenMessageIndex,
        extensionRows,
        rowContentTransform,
      ),
    [
      displayMessages,
      collabEnvelope,
      hiddenMessageIndex,
      extensionRows,
      rowContentTransform,
    ],
  );

  const internalVirtuosoRef = useRef<VirtuosoHandle | null>(null);
  const virtuosoRef = externalVirtuosoRef ?? internalVirtuosoRef;
  const nav = useConversationNav({
    rows,
    totalMessages: displayMessages.length,
    virtuosoRef,
    conversationId,
  });

  // Report nav upward only when its VALUES change. Hosts store the report in
  // state (setNav), so every report re-renders them; keying the effect on the
  // nav handlers' identities would loop whenever an identity churns per render
  // (rows rebuild → new scroll closures → report → host re-render → rebuild…).
  // The handler methods are a stable object delegating through a ref instead.
  const navRef = useRef(nav);
  // eslint-disable-next-line react-hooks/refs -- stable delegate handlers read the latest nav without keying the report effect on handler identities.
  navRef.current = nav;
  const stableNavHandlers = useMemo(
    () => ({
      handleFirstMessage: () => navRef.current.handleFirstMessage(),
      handlePrevMessage: () => navRef.current.handlePrevMessage(),
      handleNextMessage: () => navRef.current.handleNextMessage(),
      handleLastMessage: () => navRef.current.handleLastMessage(),
    }),
    [],
  );

  // The callback rides a ref so an inline `onNavChange={(n) => …}` (new
  // identity per host render) cannot re-trigger the report: the effect fires
  // on value changes only, and each report re-renders the host via setState.
  const onNavChangeRef = useRef(onNavChange);
  // eslint-disable-next-line react-hooks/refs -- see above: the report effect must not key on callback identity.
  onNavChangeRef.current = onNavChange;

  const totalMessages = displayMessages.length;
  useEffect(() => {
    onNavChangeRef.current?.({
      currentMessageIndex: nav.currentMessageIndex,
      totalMessages,
      followBottom: nav.followBottom,
      ...stableNavHandlers,
    });
  }, [
    nav.currentMessageIndex,
    totalMessages,
    nav.followBottom,
    stableNavHandlers,
  ]);

  const sending = useSendingFor(conversationId);
  const responding =
    !collab?.suppressIndicator && (sending || status === "running");

  const promptError = usePromptErrorFor(conversationId);
  const promptCancelled = usePromptCancelledFor(conversationId);
  const dismissError = useDismissError();
  const dismissCancelled = useDismissCancelled();

  const defaultRenderMessageRow = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    ({ row, isLast }) => (
      <MessageRow
        msg={row.msg}
        queuedMetadata={row.msg.queued ? row.msg.queued.metadata : undefined}
        provisional={row.msg.provisional}
        messageIndex={row.messageIndex}
        part={row.part}
        isLast={isLast}
        selectedBackend={backend}
        worktreePath={worktreePath}
        thinkingExpansionCommand={thinkingExpansionCommand}
        lastMessageExtras={null}
      />
    ),
    [backend, worktreePath, thinkingExpansionCommand],
  );

  // "Last" is message-based, not row-based: a trailing collab row (or the
  // hidden collab trigger) would make the virtuoso's last-row check tag the
  // wrong message with last-message affordances.
  const lastVisibleMessageIndex = computeLastVisibleMessageIndex(
    displayMessages.length,
    hiddenMessageIndex,
  );
  const activeRenderMessageRow = renderMessageRow ?? defaultRenderMessageRow;
  const renderMessage = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    // The content transform already ran when the rows were built, so the row
    // handed over here is final.
    ({ row }) =>
      activeRenderMessageRow({
        row,
        isLast: row.messageIndex === lastVisibleMessageIndex,
      }),
    [activeRenderMessageRow, lastVisibleMessageIndex],
  );

  const renderCollabRow = collab?.renderRow;
  const renderCollab = useCallback<
    ConversationVirtuosoListProps["renderCollab"]
  >(
    (args) => (renderCollabRow ? renderCollabRow(args) : null),
    [renderCollabRow],
  );

  const renderExtensionRow = extensions?.render;
  const renderExtension = useCallback<
    NonNullable<ConversationVirtuosoListProps["renderExtension"]>
  >(
    ({ row }) => (renderExtensionRow ? renderExtensionRow(row.ext) : null),
    [renderExtensionRow],
  );

  const renderFooter = useCallback(
    () => (
      <>
        <TypingIndicator
          conversationId={conversationId}
          selectedBackend={backend}
          visible={responding}
        />
        <BackgroundActivityIndicator
          activity={backgroundActivity ?? null}
          visible={!responding}
        />
      </>
    ),
    [conversationId, backend, responding, backgroundActivity],
  );

  return (
    <div className="conversation" data-backend={backend}>
      {leadingSlot}
      {showInFlightBanners && promptError && (
        <div className="mb-md flex animate-[fadeIn_0.3s_ease] items-center justify-between gap-sm rounded-md border border-solid border-[var(--cc-red-border)] bg-red-glow px-md py-sm font-mono text-[0.78rem] text-red">
          <span>{promptError}</span>
          <button
            className="cursor-pointer border-none bg-transparent px-xs py-0 text-[1.1rem] text-red opacity-70 hover:opacity-100"
            aria-label="Dismiss error"
            onClick={() => dismissError(conversationId)}
          >
            &times;
          </button>
        </div>
      )}
      {showInFlightBanners && promptCancelled && (
        <div className="mb-md flex animate-[fadeInOut_2.5s_ease_forwards] items-center justify-between gap-sm rounded-md border border-solid border-[var(--cc-amber-a20)] bg-amber-glow px-md py-sm font-mono text-[0.78rem] text-amber">
          <span>Prompt cancelled</span>
          <button
            className="cursor-pointer border-none bg-transparent px-xs py-0 text-[1.1rem] text-amber opacity-70 hover:opacity-100"
            aria-label="Dismiss cancelled notice"
            onClick={() => dismissCancelled(conversationId)}
          >
            &times;
          </button>
        </div>
      )}
      {isPending ? (
        <div className={stateClass}>
          <EmptyStateTitle>Loading conversation...</EmptyStateTitle>
        </div>
      ) : isError ? (
        <div className={stateClass}>
          <EmptyStateTitle>Could not load messages</EmptyStateTitle>
        </div>
      ) : rows.length > 0 ? (
        <ConversationVirtuosoList
          rows={rows}
          virtuosoRef={virtuosoRef}
          conversationId={conversationId}
          followBottom={nav.followBottom}
          renderMessage={renderMessage}
          renderCollab={renderCollab}
          renderExtension={renderExtension}
          renderFooter={renderFooter}
          onRangeChanged={nav.handleRangeChanged}
          onAtBottomStateChange={nav.handleAtBottomStateChange}
          onAtTopStateChange={nav.handleAtTopStateChange}
        />
      ) : responding ? (
        // A running conversation with no transcript yet still shows the agent
        // is working rather than a misleading "No messages yet" placeholder.
        <TypingIndicator
          conversationId={conversationId}
          selectedBackend={backend}
          visible
        />
      ) : (
        (emptyState ?? (
          <div className={stateClass}>
            <EmptyStateTitle>No messages yet</EmptyStateTitle>
            <EmptyStateDesc>
              Send a prompt to start the conversation.
            </EmptyStateDesc>
          </div>
        ))
      )}
    </div>
  );
}
