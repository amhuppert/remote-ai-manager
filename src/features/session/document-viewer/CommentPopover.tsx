"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  MultilineInput,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import type { CommentComposerCapability } from "@/components/document-viewer/annotation-contract";
import { Button } from "@/components/ui/Button";
import type { CommentAnchor } from "@/lib/document-comments/schemas";

export interface CommentPopoverProps {
  anchor: CommentAnchor;
  composer: CommentComposerCapability;
  onCancel(): void;
  onSuccess(): void;
  onPendingChange?(pending: boolean): void;
}

type SubmissionMode = "queue" | "send";

export default function CommentPopover({
  anchor,
  composer,
  onCancel,
  onSuccess,
  onPendingChange,
}: CommentPopoverProps): React.JSX.Element {
  const [note, setNote] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [pendingMode, setPendingMode] = useState<SubmissionMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visualViewportMaxWidth, setVisualViewportMaxWidth] = useState<
    number | null
  >(null);
  const errorId = useId();
  const actionRef = useRef<MultilineInputActionHandle | null>(null);
  const primaryModeRef = useRef<SubmissionMode>(
    composer.kind === "persist-only" ? "queue" : "send",
  );
  const trimmed = note.trim();
  const pending = pendingMode !== null;
  const canSubmit = trimmed.length > 0;

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === undefined || viewport === null) return;

    const updateMaxWidth = (): void => {
      setVisualViewportMaxWidth(Math.max(0, viewport.width - 16));
    };
    updateMaxWidth();
    viewport.addEventListener("resize", updateMaxWidth);
    return () => viewport.removeEventListener("resize", updateMaxWidth);
  }, []);

  async function submit(mode: SubmissionMode, nextNote: string): Promise<void> {
    const nextTrimmed = nextNote.trim();
    if (pending || nextTrimmed.length === 0) return;

    setError(null);
    setPendingMode(mode);
    onPendingChange?.(true);
    try {
      if (composer.kind === "persist-only") {
        await composer.submit({ anchor, note: nextTrimmed });
      } else {
        await composer.submit({ anchor, note: nextTrimmed, delivery: mode });
      }
      onPendingChange?.(false);
      setPendingMode(null);
      onSuccess();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Couldn't add this comment.",
      );
      setPendingMode(null);
      onPendingChange?.(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!pending) onCancel();
  }

  function runPrimaryAction(mode: SubmissionMode): void {
    primaryModeRef.current = mode;
    actionRef.current?.primaryAction();
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      style={
        visualViewportMaxWidth === null
          ? undefined
          : { maxWidth: visualViewportMaxWidth }
      }
      className="flex max-h-[var(--radix-popover-content-available-height)] w-[320px] max-w-[calc(100vw-16px)] min-w-0 flex-col gap-sm overflow-y-auto overscroll-contain rounded-md border border-solid border-border-default bg-bg-elevated p-md shadow-menu"
    >
      <blockquote className="m-0 max-h-[88px] min-w-0 overflow-y-auto overscroll-contain border-x-0 border-y-0 border-l border-solid border-l-cyan bg-bg-raised px-sm py-xs font-mono text-[0.78rem] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-secondary">
        {anchor.quote}
      </blockquote>
      <MultilineInput
        autoFocus
        value={note}
        onValueChange={(nextNote) => {
          setNote(nextNote);
          if (error !== null) setError(null);
        }}
        actionRef={actionRef}
        onPrimaryAction={(nextNote) => {
          const mode = primaryModeRef.current;
          primaryModeRef.current =
            composer.kind === "persist-only" ? "queue" : "send";
          void submit(mode, nextNote);
        }}
        onVoiceStateChange={setVoiceBusy}
        placeholder="Add a comment…"
        aria-label="Comment note"
        aria-invalid={error === null ? undefined : true}
        aria-describedby={error === null ? undefined : errorId}
        rows={3}
        disabled={pending}
        className="w-full resize-none rounded-sm border border-solid border-border-default bg-bg-base px-sm py-xs font-body text-[0.8rem] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-1px]"
      />
      {error !== null ? (
        <p
          id={errorId}
          role="alert"
          className="m-0 rounded-sm bg-bg-base p-xs font-mono text-[0.7rem] text-red-text"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-sm">
        <Button
          variant="default"
          size="touch"
          onClick={onCancel}
          type="button"
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          variant={composer.kind === "persist-only" ? "primary" : "default"}
          size="touch"
          type="button"
          disabled={pending || (!canSubmit && !voiceBusy)}
          aria-busy={pendingMode === "queue"}
          onClick={() => runPrimaryAction("queue")}
        >
          {pendingMode === "queue" ? "Adding…" : "Add comment"}
        </Button>
        {composer.kind === "persist-or-send" ? (
          <Button
            variant="primary"
            size="touch"
            type="button"
            disabled={pending || (!canSubmit && !voiceBusy)}
            aria-busy={pendingMode === "send"}
            onClick={() => runPrimaryAction("send")}
          >
            {pendingMode === "send" ? "Adding & sending…" : "Add & send"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
