"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { DocumentMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useUpdateTicketMutation } from "@/lib/tickets/mutations";
import { pushToast } from "@/stores/toast.store";
import { ticketIdentifier } from "../ticket-reference";

interface TicketEditorTarget {
  projectName: string;
  number: number;
}

// ---------------------------------------------------------------------------
// Title — click-to-edit with a saving spinner tail; a failed save rolls the
// cached value back (the mutation restores the snapshot) and offers inline
// retry of the rejected draft.
// ---------------------------------------------------------------------------

export interface TicketTitleEditorProps extends TicketEditorTarget {
  title: string;
}

export function TicketTitleEditor({
  projectName,
  number,
  title,
}: TicketTitleEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const mutation = useUpdateTicketMutation();
  const editButtonId = useId();
  const requestFocusRestore = useFocusReturn(editing, editButtonId);

  const cancel = () => {
    requestFocusRestore();
    setEditing(false);
  };

  const submit = (value: string) => {
    const next = value.trim();
    requestFocusRestore();
    setEditing(false);
    if (next.length === 0 || next === title) return;
    void mutation
      .mutateAsync({ projectName, number, fields: { title: next } })
      .then(
        () => setFailedDraft(null),
        () => setFailedDraft(next),
      );
  };

  if (editing) {
    return (
      <div className="flex min-h-[34px] items-center gap-sm">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit(draft);
              return;
            }
            if (event.key !== "Escape") return;
            event.preventDefault();
            cancel();
          }}
          autoFocus
          aria-label="Ticket title"
          className="max-w-[780px] flex-1 rounded-md border border-solid border-cyan-dim bg-bg-base px-[10px] py-[6px] font-display text-[1.25rem] font-extrabold text-text-primary shadow-[0_0_0_2px_var(--color-cyan-glow)] outline-none"
        />
        <Button variant="primary" size="sm" onClick={() => submit(draft)}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  const startEdit = () => {
    setDraft(title);
    setEditing(true);
  };

  return (
    <div className="flex min-h-[34px] items-baseline gap-[10px]">
      <h1
        onClick={startEdit}
        title="Click to edit"
        className="m-0 cursor-text font-display text-[1.5rem] leading-[1.15] font-extrabold tracking-[-0.01em] text-text-primary"
      >
        {title}
      </h1>
      <button
        id={editButtonId}
        type="button"
        onClick={startEdit}
        aria-label="Edit title"
        className="inline-flex min-h-[24px] min-w-[24px] cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-[2px] text-text-tertiary hover:text-cyan"
      >
        <PencilIcon />
      </button>
      {mutation.isPending && (
        <span className="inline-flex items-center gap-[6px] font-mono text-[0.7rem] font-medium whitespace-nowrap text-text-tertiary">
          <Spinner size="sm" tone="inherit" /> saving…
        </span>
      )}
      {failedDraft !== null && (
        <span
          role="alert"
          className="inline-flex items-center gap-[6px] font-mono text-[0.7rem] font-medium whitespace-nowrap text-red"
        >
          Save failed
          <Button
            variant="ghost"
            size="sm"
            disabled={mutation.isPending}
            aria-label={`Retry saving title "${failedDraft}"`}
            onClick={() => {
              const retryDraft = failedDraft;
              void mutation
                .mutateAsync({
                  projectName,
                  number,
                  fields: { title: retryDraft },
                })
                .then(() => {
                  setFailedDraft((current) =>
                    current === retryDraft ? null : current,
                  );
                })
                .catch(() => undefined);
            }}
          >
            Retry
          </Button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Description — Edit swaps the rendered markdown for a textarea + Save/Cancel.
// ---------------------------------------------------------------------------

export interface TicketDescriptionEditorProps extends TicketEditorTarget {
  description: string;
}

export function TicketDescriptionEditor({
  projectName,
  number,
  description,
}: TicketDescriptionEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const mutation = useUpdateTicketMutation();
  const editButtonId = useId();
  const descriptionActionRef = useRef<MultilineInputActionHandle | null>(null);
  const requestFocusRestore = useFocusReturn(editing, editButtonId);

  const cancel = () => {
    requestFocusRestore();
    setEditing(false);
  };

  const submit = (completedDraft?: string) => {
    const nextDraft = completedDraft ?? draft;
    requestFocusRestore();
    setEditing(false);
    if (nextDraft === description) return;
    void mutation
      .mutateAsync({
        projectName,
        number,
        fields: { description: nextDraft },
      })
      .catch(() => {
        pushToast(
          `Couldn't save the description for ${ticketIdentifier({ projectName, number })} — rolled back`,
        );
      });
  };

  return (
    <section aria-label="Description" className="flex flex-col gap-sm">
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle pb-[6px]">
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Description
        </span>
        {!editing && (
          <Button
            id={editButtonId}
            variant="ghost"
            size="sm"
            layoutClassName="ml-auto"
            onClick={() => {
              setDraft(description);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-sm">
          <MultilineInput
            rows={6}
            value={draft}
            onValueChange={setDraft}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              cancel();
            }}
            onPrimaryAction={submit}
            actionRef={descriptionActionRef}
            voiceProjectName={projectName}
            autoFocus
            aria-label="Ticket description"
            className="box-border w-full resize-y rounded-md border border-solid border-cyan-dim bg-bg-base px-[12px] py-[10px] font-mono text-[0.8rem] leading-[1.6] text-text-primary shadow-[0_0_0_2px_var(--color-cyan-glow)] outline-none"
          />
          <div className="flex items-center gap-sm">
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                runMultilinePrimaryAction(
                  [descriptionActionRef.current],
                  submit,
                )
              }
            >
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
            <span className="font-mono text-[0.68rem] text-text-tertiary">
              Markdown supported
            </span>
          </div>
        </div>
      ) : description.trim().length > 0 ? (
        <div className="max-w-[72ch]">
          <DocumentMarkdown content={description} />
        </div>
      ) : (
        <span className="font-mono text-[0.74rem] text-text-tertiary">
          No description yet — Edit to add one.
        </span>
      )}
    </section>
  );
}

function useFocusReturn(editing: boolean, triggerId: string): () => void {
  const pendingRef = useRef(false);

  useEffect(() => {
    if (editing || !pendingRef.current) return;
    pendingRef.current = false;
    document.getElementById(triggerId)?.focus();
  }, [editing, triggerId]);

  return () => {
    pendingRef.current = true;
  };
}

function PencilIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 13.5 L3 10.8 L10.8 3 A1.6 1.6 0 0 1 13 5.2 L5.2 13 L2.5 13.5 Z M9.6 4.2 L11.8 6.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
