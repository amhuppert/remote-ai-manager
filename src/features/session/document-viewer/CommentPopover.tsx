"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import {
  MultilineInput,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { Button } from "@/components/ui/Button";

interface CommentPopoverProps {
  /** The exact selected passage, shown as a read-only preview. */
  quote: string;
  /** Save as a pending (unsent) comment with the entered note. */
  onQueue: (note: string) => void;
  /** Save and immediately send the comment with the entered note. */
  onSend: (note: string) => void;
  /** Dismiss without creating a comment (cancel / Escape / outside-click). */
  onCancel: () => void;
}

/**
 * The selection comment editor: a preview of the selected passage plus a note
 * input with queue and immediate-send actions. Both actions stay disabled while
 * the note is empty/whitespace (5.5); Escape cancels (5.6). Positioning is owned
 * by the caller — this renders only the editor card.
 */
export default function CommentPopover({
  quote,
  onQueue,
  onSend,
  onCancel,
}: CommentPopoverProps): React.JSX.Element {
  const [note, setNote] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const sendActionRef = useRef<MultilineInputActionHandle | null>(null);
  const primaryModeRef = useRef<"queue" | "send">("send");
  const trimmed = note.trim();
  const canSubmit = trimmed.length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      className="flex w-[320px] flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-elevated p-[12px] shadow-menu"
    >
      <blockquote className="m-0 max-h-[88px] overflow-y-auto overscroll-contain border-x-0 border-y-0 border-l-2 border-solid border-l-cyan bg-bg-raised px-[10px] py-[6px] font-body text-[0.8rem] leading-[1.5] text-text-secondary">
        {quote}
      </blockquote>
      <MultilineInput
        autoFocus
        value={note}
        onValueChange={setNote}
        actionRef={sendActionRef}
        onPrimaryAction={(nextNote) => {
          const nextTrimmed = nextNote.trim();
          if (!nextTrimmed) return;
          const mode = primaryModeRef.current;
          primaryModeRef.current = "send";
          if (mode === "queue") onQueue(nextTrimmed);
          else onSend(nextTrimmed);
        }}
        onVoiceStateChange={setVoiceBusy}
        placeholder="Add a comment…"
        aria-label="Comment note"
        rows={3}
        className="w-full resize-none rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[6px] font-body text-[0.8rem] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-1px]"
      />
      <div className="flex items-center justify-end gap-sm">
        <Button variant="ghost" size="sm" onClick={onCancel} type="button">
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          type="button"
          disabled={!canSubmit && !voiceBusy}
          onClick={() => {
            primaryModeRef.current = "queue";
            sendActionRef.current?.primaryAction();
          }}
        >
          Add comment
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={!canSubmit && !voiceBusy}
          onClick={() => {
            primaryModeRef.current = "send";
            sendActionRef.current?.primaryAction();
          }}
        >
          Add &amp; send
        </Button>
      </div>
    </div>
  );
}
