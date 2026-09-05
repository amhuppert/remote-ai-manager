"use client";

import { useState } from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/Select";
import { useSessionsQuery } from "@/lib/sessions/queries";
import { createClientLogger } from "@/lib/logging/client-logger";

import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { useConversationsQuery } from "@/lib/conversations/queries";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import {
  useMemoryIndexPreviewQuery,
  type MemoryIndexBlockView,
} from "@/lib/memory/queries";
import type {
  MemoryIndexRender,
  MemoryScopeRef,
} from "@/lib/memory/query-keys";
import { useProjectConversationsQuery } from "@/lib/project-conversations-client/queries";
import { cn } from "@/lib/ui/cn";

export interface MemoryIndexPreviewProps {
  scopeRef: MemoryScopeRef;
  /** The conversation this panel is open in — the preview's default subject. */
  conversationId: string | null;
  active: boolean;
  layout?: "compact" | "page";
  onSubjectChange?(
    conversationId: string | null,
    sessionName: string | null,
  ): void;
}

/** Which conversation list the picker is drawing from. */
type PreviewScope = "session" | "project";

/**
 * The block a chosen conversation is due as it stands (spec R12.2), or the
 * whole index that conversation can be told (R12).
 *
 * The block arrives already composed, budgeted, and closed with its own
 * omission and withheld lines — including any backend-exception disclosure the
 * contract puts in it — and is relayed here VERBATIM. Nothing on this surface
 * re-wraps, re-orders, re-counts, or re-renders it: the preview is only worth
 * looking at if it reproduces the composed block byte for byte, and any
 * formatting here would be free to disagree with the turn while still looking
 * right.
 *
 * The two renders are two questions, not one answer filtered two ways, so the
 * switch changes the query rather than the presentation: what a conversation
 * holding a block is due is a delta, and the full index is what it COULD be
 * told. A surface that derived one from the other would be inventing a block no
 * turn composes.
 *
 * The next-turn view is a reading of the conversation, NOT a promise about the
 * turn, and it says so on screen ({@link NEXT_TURN_BOUNDARY}): the model, the
 * structured-output format, and a lane's write envelope are supplied by
 * whoever dispatches the turn and are held nowhere this surface can read, so a
 * differently-dispatched turn can rebuild its runtime and — with no stored
 * resume handle to carry the conversation across — be given the full index
 * where this showed a delta.
 */
const logger = createClientLogger("memory-index-preview");

export default function MemoryIndexPreview(
  props: MemoryIndexPreviewProps,
): React.JSX.Element {
  if (props.scopeRef.projectName === null)
    return (
      <EmptyState layoutClassName="flex-1">
        <EmptyStateTitle>
          Choose a project to preview a conversation
        </EmptyStateTitle>
      </EmptyState>
    );
  return <ProjectMemoryIndexPreview {...props} />;
}

function ProjectMemoryIndexPreview({
  scopeRef,
  conversationId,
  active,
  layout = "compact",
  onSubjectChange,
}: MemoryIndexPreviewProps): React.JSX.Element {
  const [scope, setScope] = useState<PreviewScope>(
    scopeRef.sessionName === null ? "project" : "session",
  );
  const [selected, setSelected] = useState(conversationId);
  const [selectedSession, setSelectedSession] = useState(scopeRef.sessionName);
  const sessions = useSessionsQuery(scopeRef.projectName ?? "", {
    enabled: active && layout === "page",
  });
  function selectSubject(id: string | null): void {
    setSelected(id);
    onSubjectChange?.(id, scope === "session" ? selectedSession : null);
    logger.info("memory.preview.subject_selected", {
      conversationId: id,
      projectName: scopeRef.projectName,
    });
  }
  const [render, setRender] = useState<MemoryIndexRender>("next-turn");

  // The session list shares the conversation sidebar's query key, so picking a
  // lane costs no fetch of its own in the running app.
  const sessionConversations = useConversationsQuery(
    scopeRef.projectName ?? "",
    selectedSession ?? "",
    { enabled: active && selectedSession !== null },
  );
  const projectConversations = useProjectConversationsQuery(
    scopeRef.projectName ?? "",
    { enabled: active, includeClosed: layout === "page" },
  );
  const conversations =
    (scope === "session"
      ? sessionConversations.data
      : projectConversations.data) ?? [];
  // Named from either list, because switching scope deliberately keeps the
  // selection: a human comparing a lane against the project thread must not
  // lose the block they were reading, and must never be left guessing which
  // conversation the block on screen belongs to.
  const selectedConversation =
    [
      ...(sessionConversations.data ?? []),
      ...(projectConversations.data ?? []),
    ].find((conversation) => conversation.id === selected) ?? null;

  const preview = useMemoryIndexPreviewQuery(selected, render, {
    enabled: active,
  });

  return (
    <>
      <div className="flex shrink-0 flex-col gap-sm border-0 border-b border-solid border-border-subtle px-md py-sm">
        {layout === "page" ? (
          <Select
            value={
              scope === "project" ? "project" : `session:${selectedSession}`
            }
            onValueChange={(value) => {
              const session = value === "project" ? null : value.slice(8);
              setSelectedSession(session);
              setScope(session === null ? "project" : "session");
              setSelected(null);
              onSubjectChange?.(null, session);
            }}
          >
            <SelectTrigger aria-label="Conversation scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">Project conversations</SelectItem>
              {(sessions.data ?? []).map((session) => (
                <SelectItem
                  key={session.sessionName}
                  value={`session:${session.sessionName}`}
                >
                  {session.sessionName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : scopeRef.sessionName === null ? null : (
          <SegmentedControl
            value={scope}
            onValueChange={(value) => {
              if (isPreviewScope(value)) setScope(value);
            }}
            aria-label="Conversations to preview"
          >
            <SegmentedControlItem value="session">
              this session
            </SegmentedControlItem>
            <SegmentedControlItem value="project">project</SegmentedControlItem>
          </SegmentedControl>
        )}
        {(
          scope === "session"
            ? sessionConversations.isError
            : projectConversations.isError
        ) ? (
          <p role="alert" className="font-mono text-[0.72rem] text-red-text">
            Could not load conversations
          </p>
        ) : null}
        {conversations.length === 0 ? (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            No conversations to preview in this scope.
          </span>
        ) : layout === "page" ? (
          <Select value={selected ?? ""} onValueChange={selectSubject}>
            <SelectTrigger aria-label="Conversation to preview">
              <SelectValue placeholder="Choose a conversation" />
            </SelectTrigger>
            <SelectContent>
              {conversations.map((conversation) => (
                <SelectItem key={conversation.id} value={conversation.id}>
                  {conversationLabel(conversation)} ·{" "}
                  {scope === "session" ? selectedSession : scopeRef.projectName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex flex-wrap gap-xs">
            {conversations.map((conversation) => (
              <ConversationChoice
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selected}
                onSelect={() => selectSubject(conversation.id)}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-sm">
          <SegmentedControl
            value={render}
            onValueChange={(value) => {
              if (isMemoryIndexRender(value)) setRender(value);
            }}
            aria-label="Which render of the index to show"
          >
            <SegmentedControlItem value="next-turn">
              next turn
            </SegmentedControlItem>
            <SegmentedControlItem value="full">full index</SegmentedControlItem>
          </SegmentedControl>
          {selectedConversation === null ? null : (
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              previewing {conversationLabel(selectedConversation)}
            </span>
          )}
        </div>
        {/* Only under the next-turn view: the full index makes no claim about a
            turn, so the same sentence there would be noise. */}
        {render === "next-turn" ? (
          <p
            data-testid="memory-index-preview-boundary"
            className="m-0 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary"
          >
            {NEXT_TURN_BOUNDARY}
          </p>
        ) : null}
      </div>

      {selected === null ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Choose a conversation to preview</EmptyStateTitle>
        </EmptyState>
      ) : (
        <PreviewBody failed={preview.isError} block={preview.data} />
      )}
    </>
  );
}

/**
 * What the next-turn view is and is not, in the reader's own terms. Named here
 * rather than written inline because the same boundary is stated by `cctl
 * memory index --help`, and the two surfaces answering differently is the whole
 * failure this copy exists to prevent.
 */
const NEXT_TURN_BOUNDARY =
  "The delivery due as this conversation stands, read from its delivery state and runtime. " +
  "The model, the structured-output format, and a lane's write envelope are supplied when a turn is dispatched " +
  "and are held nowhere outside it, so they are outside this prediction: a turn dispatched with any of them " +
  "changed rebuilds its runtime, and unless a stored resume handle carries the conversation across that " +
  "rebuild, it is given the full index instead.";

function isPreviewScope(value: string): value is PreviewScope {
  return value === "session" || value === "project";
}

function isMemoryIndexRender(value: string): value is MemoryIndexRender {
  return value === "next-turn" || value === "full";
}

/**
 * What this block IS, named from the block itself rather than from the switch
 * that asked for it: a delta is only meaningful with the instant it is a delta
 * since, and the block states that instant structurally so this label can never
 * disagree with the text under it.
 */
function renderLabel(block: MemoryIndexBlockView): string {
  if (block.kind !== "delta") return "full index";
  return block.since === null ? "delta" : `delta since ${block.since}`;
}

/** The conversation list's own naming, so the picker reads like the sidebar. */
function conversationLabel(conversation: PublicConversationState): string {
  return conversation.name ?? conversation.summary ?? "New conversation";
}

interface ConversationChoiceProps {
  conversation: PublicConversationState;
  selected: boolean;
  onSelect(): void;
}

function ConversationChoice({
  conversation,
  selected,
  onSelect,
}: ConversationChoiceProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "max-768:min-h-[44px] max-w-full cursor-pointer truncate rounded-sm border border-solid px-sm py-[3px] font-mono text-[0.7rem] transition-colors duration-150 ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[2px]",
        selected
          ? "border-cyan-dim bg-cyan-glow text-cyan"
          : "border-border-default bg-bg-base text-text-secondary hover:bg-bg-raised hover:text-text-primary",
      )}
    >
      {conversationLabel(conversation)}
    </button>
  );
}

interface PreviewBodyProps {
  failed: boolean;
  /** Undefined until the read resolves; null when the server composed none. */
  block: MemoryIndexBlockView | null | undefined;
}

function PreviewBody({ failed, block }: PreviewBodyProps): React.JSX.Element {
  if (failed) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Could not compose this preview</EmptyStateTitle>
      </EmptyState>
    );
  }
  if (block === undefined) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Composing the block…</EmptyStateTitle>
      </EmptyState>
    );
  }
  // A null block is data, not a failure — and it is only ever claimed once the
  // server has actually answered, never while the read is still outstanding: a
  // conversation whose policy tells it nothing, or whose visible library holds
  // nothing eligible, genuinely carries no block.
  if (block === null) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>This conversation is told nothing</EmptyStateTitle>
        <EmptyStateDesc>
          Its next turn carries no memory block at all — either its read policy
          delivers none, or no note it can see is eligible for the index.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-md py-sm">
      <div
        data-testid="memory-index-preview-budget"
        className="mb-sm flex flex-wrap gap-x-md gap-y-2xs font-mono text-[0.7rem] text-text-tertiary"
      >
        <span data-testid="memory-index-preview-render">
          {renderLabel(block)}
        </span>
        <span>
          {block.bytes} / {block.budget.bytes} bytes
        </span>
        <span>
          {block.entries.length} / {block.budget.hooks} hooks
        </span>
      </div>
      <pre
        data-testid="memory-index-preview-block"
        className="m-0 overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base px-sm py-sm font-mono text-[0.7rem] leading-[1.55] whitespace-pre-wrap text-text-secondary"
      >
        {block.text}
      </pre>
    </div>
  );
}
