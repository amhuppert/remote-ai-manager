"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  PublicConversationState,
  ConversationStatus,
} from "@/lib/conversations/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { backendLabel } from "@/lib/agent-backends/catalog";
import { createClientLogger } from "@/lib/logging/client-logger";
import { Badge } from "@/components/ui/Badge";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { IconButton } from "@/components/ui/IconButton";
import { FormInput } from "@/components/ui/FormField";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { ArchiveIcon, CopyIcon, KebabIcon, UndoIcon } from "@/components/icons";
import { formatSessionDate } from "./session-overview-model";

const log = createClientLogger("session-overview");

const statusPresentation: Record<
  ConversationStatus | "idle" | "merged",
  { label: string; tone: StatusChipTone }
> = {
  new: { label: "New", tone: "neutral" },
  awaiting: { label: "Ready", tone: "green" },
  running: { label: "Running", tone: "cyan" },
  waiting_for_input: { label: "Needs input", tone: "amber" },
  idle: { label: "Idle", tone: "neutral" },
  merged: { label: "Merged", tone: "green" },
};

export function SessionStatus({
  status,
}: {
  status: keyof typeof statusPresentation;
}) {
  const { label, tone } = statusPresentation[status];
  return <StatusChip tone={tone}>{label}</StatusChip>;
}

export interface SessionConversationRowProps {
  conversation: PublicConversationState;
  archivePending?: boolean;
  onArchive(id: string, archived: boolean): void;
  onRename(id: string, name: string): Promise<unknown>;
}

export default function SessionConversationRow({
  conversation,
  archivePending,
  onArchive,
  onRename,
}: SessionConversationRowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const title = conversation.name ?? conversation.summary ?? "New conversation";
  const summary = conversation.summary !== title ? conversation.summary : null;

  function finishEditing() {
    restoreFocus.current = true;
    setEditing(false);
  }

  useEffect(() => {
    if (editing || saving || !restoreFocus.current) return;
    restoreFocus.current = false;
    menuRef.current?.querySelector("button")?.focus();
  }, [editing, saving]);

  async function saveName() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(conversation.id, name.trim());
      finishEditing();
    } catch {
      setError("Could not rename conversation. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(conversation.id);
      setFeedback("Conversation ID copied");
      log.debug("session_overview.conversation_id_copied", {
        conversationId: conversation.id,
      });
    } catch {
      setError("Could not copy the conversation ID.");
      log.warn("session_overview.copy_failed", {
        conversationId: conversation.id,
      });
    }
  }

  return (
    <li
      data-testid="conversation-row"
      data-status={conversation.status}
      data-archived={conversation.archived}
      className="group flex flex-col rounded-lg border border-solid border-border-subtle bg-bg-base transition-colors duration-150 hover:border-border-strong hover:bg-bg-surface data-[archived=true]:border-dashed data-[status=waiting_for_input]:border-amber-glow"
    >
      <div className="flex items-start gap-sm p-lg max-768:p-md">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
              className="flex flex-col gap-sm"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !saving) {
                  event.stopPropagation();
                  finishEditing();
                }
              }}
            >
              <FormInput
                aria-label="Conversation name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                disabled={saving}
              />
              <div className="flex gap-sm">
                <Button
                  type="submit"
                  size="sm"
                  touch
                  loading={saving}
                  disabled={!name.trim()}
                >
                  {saving ? "Saving…" : "Save name"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  touch
                  onClick={finishEditing}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Link
              href={conversationsPageHref({ conversationId: conversation.id })}
              className="block rounded-sm text-text-primary no-underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-4"
            >
              <div className="mb-sm flex flex-wrap items-center gap-sm">
                <SessionStatus status={conversation.status} />
                {conversation.unread && (
                  <span className="flex items-center gap-xs text-[0.7rem] text-cyan">
                    <span className="size-[5px] rounded-full bg-cyan" />
                    Unread
                  </span>
                )}
                {conversation.archived && <StatusChip>Archived</StatusChip>}
                {conversation.source === "imported" && (
                  <StatusChip>Imported</StatusChip>
                )}
              </div>
              <h3 className="text-[0.9rem] leading-relaxed font-semibold [overflow-wrap:anywhere] text-text-primary">
                {title}
              </h3>
              {summary && (
                <p className="mt-xs line-clamp-2 text-[0.78rem] leading-relaxed text-text-secondary">
                  {summary}
                </p>
              )}
              {conversation.promptCount === 0 && !summary && (
                <p className="mt-xs text-[0.78rem] text-text-secondary">
                  Ready for the first prompt.
                </p>
              )}
              <div className="mt-md flex flex-wrap items-center gap-x-md gap-y-sm text-[0.7rem] text-text-secondary">
                <Badge backend={conversation.agentBackend}>
                  {backendLabel(conversation.agentBackend)}
                </Badge>
                <span>
                  {conversation.promptCount}{" "}
                  <span className="uppercase">prompts</span>
                </span>
                <time dateTime={conversation.lastActivityAt}>
                  {formatSessionDate(conversation.lastActivityAt)}
                </time>
                {conversation.forkedFrom && <span>Forked conversation</span>}
              </div>
            </Link>
          )}
        </div>
        <div ref={menuRef}>
          <DropdownMenu>
            <WithTooltip label="Conversation actions">
              <DropdownMenuTrigger asChild>
                <IconButton
                  aria-label={`Actions for ${title}`}
                  disabled={saving || archivePending}
                >
                  <KebabIcon size={18} />
                </IconButton>
              </DropdownMenuTrigger>
            </WithTooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                touch
                onSelect={() => {
                  setName(title === "New conversation" ? "" : title);
                  setError(null);
                  setEditing(true);
                }}
              >
                Rename conversation
              </DropdownMenuItem>
              <DropdownMenuItem touch onSelect={() => void copyId()}>
                <CopyIcon size={16} />
                Copy conversation ID
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                touch
                onSelect={() =>
                  onArchive(conversation.id, !conversation.archived)
                }
              >
                {conversation.archived ? (
                  <UndoIcon size={16} />
                ) : (
                  <ArchiveIcon size={16} />
                )}
                {conversation.archived
                  ? "Unarchive conversation"
                  : "Archive conversation"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {archivePending && (
        <p
          role="status"
          className="px-lg pb-md text-[0.72rem] text-text-secondary"
        >
          Updating archive…
        </p>
      )}
      {feedback && (
        <p role="status" className="px-lg pb-md text-[0.72rem] text-green">
          {feedback}
        </p>
      )}
      {error && (
        <p role="alert" className="px-lg pb-md text-[0.72rem] text-red-text">
          {error}
        </p>
      )}
    </li>
  );
}
