"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import { DocumentMarkdown } from "@/components/markdown/Markdown";
import {
  RichPromptInput,
  type RichPromptInputHandle,
} from "@/components/rich-prompt/RichPromptInput";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { imageMediaTypeSchema, type ImagePayload } from "@/lib/images/schemas";
import {
  collectDescriptionImageRefs,
  pastedImageUploadFile,
  planDescriptionImageSync,
  type DescriptionImageRef,
} from "@/lib/tickets/description-images";
import {
  useAddTicketAttachmentMutation,
  useEditTicketAttachmentMutation,
  useRemoveTicketAttachmentMutation,
  useUpdateTicketMutation,
} from "@/lib/tickets/mutations";
import { ticketQueries } from "@/lib/tickets/queries";
import type { TicketAttachment } from "@/lib/tickets/schemas";
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
// Description — Edit swaps the rendered markdown for the rich prompt editor
// (image paste/chips + voice) + Save/Cancel. Pasted images persist as file
// attachments linked through their deterministic description
// (`pastedImageDescription`), so saving executes a sync plan: upload new
// images first (references need backing), then the description text, then
// renumber/demotion syncs, then deletions of de-referenced images.
// ---------------------------------------------------------------------------

export interface TicketDescriptionEditorProps extends TicketEditorTarget {
  description: string;
  attachments: readonly TicketAttachment[];
}

interface DescriptionEditSession {
  initialImages: ImagePayload[];
  refs: DescriptionImageRef[];
}

export function TicketDescriptionEditor({
  projectName,
  number,
  description,
  attachments,
}: TicketDescriptionEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState<DescriptionEditSession | null>(null);
  const richRef = useRef<RichPromptInputHandle | null>(null);
  const queryClient = useQueryClient();
  const updateMutation = useUpdateTicketMutation();
  const addAttachmentMutation = useAddTicketAttachmentMutation();
  const editAttachmentMutation = useEditTicketAttachmentMutation();
  const removeAttachmentMutation = useRemoveTicketAttachmentMutation();
  const editButtonId = useId();
  const requestFocusRestore = useFocusReturn(editing, editButtonId);

  const cancel = () => {
    requestFocusRestore();
    setEditing(false);
    setSession(null);
  };

  const startEdit = async () => {
    if (preparing) return;
    setPreparing(true);
    try {
      const refs = collectDescriptionImageRefs(attachments);
      const initialImages = await Promise.all(
        refs.map(async (ref): Promise<ImagePayload> => {
          const resolved = await queryClient.fetchQuery(
            ticketQueries.attachmentResolve(
              projectName,
              number,
              ref.attachmentId,
            ),
          );
          if (resolved.kind !== "file" || resolved.encoding !== "base64") {
            throw new Error("pasted image bytes are unavailable");
          }
          return {
            attachmentId: ref.attachmentId,
            mediaType: imageMediaTypeSchema.parse(resolved.mediaType),
            base64Data: resolved.content,
            inlineMarkerIndex: ref.index,
          };
        }),
      );
      setSession({ initialImages, refs });
      setDraft(description);
      setEditing(true);
    } catch {
      pushToast(
        `Couldn't load the pasted images for ${ticketIdentifier({ projectName, number })} — try again`,
      );
    } finally {
      setPreparing(false);
    }
  };

  const save = async () => {
    const handle = richRef.current;
    if (handle === null || session === null || saving) return;
    const serialized = handle.serialize();
    const plan = planDescriptionImageSync({
      editorImages: serialized.images.map((image) => ({
        id: image.attachmentId,
        mediaType: image.mediaType,
        base64Data: image.base64Data,
        ...(image.inlineMarkerIndex !== undefined
          ? { inlineMarkerIndex: image.inlineMarkerIndex }
          : {}),
      })),
      existing: session.refs,
    });
    const descriptionChanged = serialized.prompt !== description;
    const planEmpty =
      plan.uploads.length === 0 &&
      plan.descriptionSyncs.length === 0 &&
      plan.deletions.length === 0;
    if (!descriptionChanged && planEmpty) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      for (const upload of plan.uploads) {
        await addAttachmentMutation.mutateAsync({
          projectName,
          number,
          description: upload.description,
          file: pastedImageUploadFile(upload),
          fileName: upload.fileName,
          mediaType: upload.mediaType,
        });
      }
      if (descriptionChanged) {
        await updateMutation.mutateAsync({
          projectName,
          number,
          fields: { description: serialized.prompt },
        });
      }
      for (const sync of plan.descriptionSyncs) {
        await editAttachmentMutation.mutateAsync({
          projectName,
          number,
          attachmentId: sync.attachmentId,
          description: sync.description,
        });
      }
      for (const attachmentId of plan.deletions) {
        await removeAttachmentMutation.mutateAsync({
          projectName,
          number,
          attachmentId,
        });
      }
      requestFocusRestore();
      setEditing(false);
      setSession(null);
    } catch {
      pushToast(
        `Couldn't save the description for ${ticketIdentifier({ projectName, number })} — some changes may not have applied`,
      );
    } finally {
      setSaving(false);
    }
  };

  const saveAction = () => {
    const handle = richRef.current;
    if (handle?.isVoiceBusy() === true) {
      // Finalizing dictation routes back through onSubmit once transcription
      // lands, so the dictated text is part of the saved document.
      handle.primaryAction();
      return;
    }
    void save();
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
            disabled={preparing}
            onClick={() => void startEdit()}
          >
            {preparing && <Spinner size="sm" tone="inherit" />}
            Edit
          </Button>
        )}
      </div>
      {editing && session !== null ? (
        <div
          className="flex flex-col gap-sm"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            cancel();
          }}
        >
          <RichPromptInput
            ref={richRef}
            capabilityContext={{ projectName }}
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void save()}
            initialImages={session.initialImages}
            ariaLabel="Ticket description"
            placeholder="Describe the work — paste images to attach them inline"
            submitLabel="Save"
            showSubmitControl={false}
            disabled={saving}
            onError={pushToast}
          />
          <div className="flex items-center gap-sm">
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={saveAction}
            >
              {saving && <Spinner size="sm" tone="inherit" />}
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={cancel}
            >
              Cancel
            </Button>
            <span className="font-mono text-[0.68rem] text-text-tertiary">
              Markdown supported · pasted images attach to the ticket
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
