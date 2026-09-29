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

export default function CommentPopover({
  anchor,
  composer,
  onCancel,
  onSuccess,
  onPendingChange,
}: CommentPopoverProps): React.JSX.Element {
  const [note, setNote] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [visualViewportMaxWidth, setVisualViewportMaxWidth] = useState<
    number | null
  >(null);
  const errorId = useId();
  const actionRef = useRef<MultilineInputActionHandle | null>(null);
  const trimmed = note.trim();
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

  async function submit(nextNote: string): Promise<void> {
    const nextTrimmed = nextNote.trim();
    if (submittingRef.current || nextTrimmed.length === 0) return;

    setError(null);
    submittingRef.current = true;
    setPending(true);
    onPendingChange?.(true);
    try {
      await composer.submit({ anchor, note: nextTrimmed });
      onSuccess();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Couldn't add this comment.",
      );
    } finally {
      submittingRef.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!pending) onCancel();
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
        onPrimaryAction={(nextNote) => void submit(nextNote)}
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
          variant="primary"
          size="touch"
          type="button"
          disabled={pending || (!canSubmit && !voiceBusy)}
          aria-busy={pending}
          onClick={() => actionRef.current?.primaryAction()}
        >
          {pending ? "Adding…" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}
