"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { createClientLogger } from "@/lib/logging/client-logger";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import { cn } from "@/lib/ui/cn";
import { ConversationTargetPicker } from "@/features/session/document-viewer/ConversationTargetPicker";
import { useConversationTarget } from "@/features/session/document-viewer/use-conversation-target";

import {
  buildNotepadFeedbackPayload,
  deliverNotepadFeedback,
  type DispatchNotepadRef,
} from "./notepad-comment-dispatch";
import type { NotepadReviewThread } from "./notepad-review-annotations";

const logger = createClientLogger("notepad-dispatch-bar");

export interface NotepadDispatchBarProps {
  notepad: DispatchNotepadRef;
  threads: readonly NotepadReviewThread[];
}

/**
 * Send this notepad's open review comments to a conversation. The user picks a
 * target and presses send — the request is composed from the comments
 * themselves (quote, location, body, and the notepad reference), never
 * hand-authored, which is the whole point of the loop.
 *
 * Dispatch does not resolve anything: resolution is a separate user act, and a
 * comment stays open until the reader decides the agent actually addressed it.
 */
export default function NotepadDispatchBar({
  notepad,
  threads,
}: NotepadDispatchBarProps): React.JSX.Element {
  const { target, setTarget } = useConversationTarget();
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = buildNotepadFeedbackPayload(
    notepad,
    threads.map(({ thread }) => thread),
  );
  const openCount = payload?.items.length ?? 0;
  const canSend = payload !== null && target !== null && !isSending;

  const handleSend = useCallback(async () => {
    if (payload === null || target === null) return;
    setIsSending(true);
    setError(null);
    try {
      const outcome = await deliverNotepadFeedback({
        payload,
        target,
        fetchImpl: tracedFetch,
      });
      if (!outcome.ok) {
        logger.warn("notepad-dispatch.send_failed", {
          notepadId: payload.notepadId,
          conversationId: target.conversationId,
          count: payload.items.length,
          error: outcome.message,
        });
        setError(outcome.message);
        return;
      }
      logger.info("notepad-dispatch.sent", {
        notepadId: payload.notepadId,
        conversationId: target.conversationId,
        count: payload.items.length,
        queued: target.status === "running",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send comments");
    } finally {
      setIsSending(false);
    }
  }, [payload, target]);

  return (
    <div
      data-testid="notepad-dispatch-bar"
      className="flex shrink-0 items-center gap-sm border-0 border-t border-solid border-border-subtle bg-bg-raised px-[12px] py-[5px]"
    >
      <span className="shrink-0 font-mono text-[0.66rem] tracking-[0.04em] text-text-tertiary uppercase">
        Send to
      </span>
      <ConversationTargetPicker
        target={target}
        onSelect={setTarget}
        docProjectName={notepad.projectName}
      />
      <Button
        variant="default"
        size="sm"
        layoutClassName="ml-auto"
        disabled={!canSend}
        onClick={() => void handleSend()}
      >
        {isSending
          ? "Sending…"
          : `Send ${openCount} open comment${openCount === 1 ? "" : "s"}`}
      </Button>
      {error ? (
        <button
          type="button"
          onClick={() => setError(null)}
          title="Dismiss"
          className={cn(
            "max-w-[40%] truncate text-left font-mono text-[0.68rem] text-red",
            "cursor-pointer border-none bg-transparent",
          )}
        >
          {error}
        </button>
      ) : null}
    </div>
  );
}
