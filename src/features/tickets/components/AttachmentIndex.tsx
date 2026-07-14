"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import { DocumentMarkdown } from "@/components/markdown/Markdown";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import {
  useAddTicketAttachmentMutation,
  useEditTicketAttachmentMutation,
  useRemoveTicketAttachmentMutation,
} from "@/lib/tickets/mutations";
import { useResolveTicketAttachmentQuery } from "@/lib/tickets/queries";
import {
  formatTicketIdentifier,
  parseTicketIdentifier,
} from "@/lib/tickets/references";
import type {
  ResolvedAttachment,
  TicketAttachment,
  TicketAttachmentKind,
} from "@/lib/tickets/schemas";
import { pushToast } from "@/stores/toast.store";
import { cn } from "@/lib/ui/cn";
import { formatRelativeTime } from "../format-relative-time";
import AttachmentDialog from "./AttachmentDialog";
import {
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
} from "../ticket-visuals";

export interface AttachmentIndexProps {
  projectName: string;
  number: number;
  attachments: readonly TicketAttachment[];
}

// ---------------------------------------------------------------------------
// Kind visual language (design §Status & type visual language): 26px tinted
// icon tiles + mono kind chips. Static variant map — never dynamic classes.
// ---------------------------------------------------------------------------

const KIND_VISUALS: Record<
  TicketAttachmentKind,
  { label: string; tile: string }
> = {
  file: { label: "file", tile: "bg-cyan-glow text-cyan" },
  conversation: { label: "conversation", tile: "bg-green-glow text-green" },
  session: { label: "session", tile: "bg-violet-glow text-violet" },
  related_ticket: {
    label: "related ticket",
    tile: "bg-[var(--cc-cyan-a08)] text-cyan",
  },
  note: { label: "note", tile: "bg-amber-glow text-amber" },
};

const ACTION_BUTTON_CLASS =
  "inline-flex min-h-[24px] min-w-[24px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-mono text-[0.7rem] font-medium text-text-tertiary hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

const ATTACHMENT_LINK_CLASS =
  "inline-flex min-h-[24px] items-center gap-xs font-mono text-[0.7rem] font-medium text-text-secondary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

const CHIP_CLASS =
  "inline-flex items-center rounded-full bg-bg-raised px-[7px] py-px font-mono text-[0.64rem] font-semibold tracking-[0.06em] uppercase text-text-secondary";

const METADATA_CLASS = "font-mono text-[0.68rem] text-text-tertiary";

const ENTRY_TEXTAREA_CLASS =
  "box-border w-full resize-y rounded-md border border-solid border-border-default bg-bg-surface px-[10px] py-[8px] font-mono text-[0.76rem] leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_2px_var(--color-cyan-glow)]";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Pending uploads — local state only. A failed file attach never renders as
// an attachment entry (no phantom): it renders as a red panel with
// Retry/Discard until it succeeds or the user discards it.
// ---------------------------------------------------------------------------

interface PendingUpload {
  localId: string;
  file: File;
  description: string;
  status: "uploading" | "failed";
  errorMessage: string | null;
}

export default function AttachmentIndex({
  projectName,
  number,
  attachments,
}: AttachmentIndexProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const addMutation = useAddTicketAttachmentMutation();
  const pendingRemovalFocusRef = useRef<{
    removedId: string;
    successorId: string | null;
  } | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const pendingFocus = pendingRemovalFocusRef.current;
    if (pendingFocus === null) return;
    if (
      attachments.some((attachment) => attachment.id === pendingFocus.removedId)
    ) {
      return;
    }
    pendingRemovalFocusRef.current = null;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        const successor = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "button[data-attachment-view]",
          ),
        ).find(
          (button) =>
            button.dataset.attachmentView === pendingFocus.successorId,
        );
        if (successor !== undefined) {
          successor.focus();
          return;
        }
        document
          .querySelector<HTMLButtonElement>("button[data-add-ticket-context]")
          ?.focus();
      });
    });
  }, [attachments]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    [],
  );

  const prepareRemovalFocus = (attachmentId: string) => {
    const index = attachments.findIndex(
      (attachment) => attachment.id === attachmentId,
    );
    const successor =
      attachments[index + 1] ?? attachments[Math.max(0, index - 1)] ?? null;
    pendingRemovalFocusRef.current = {
      removedId: attachmentId,
      successorId: successor?.id ?? null,
    };
  };

  const startUpload = (upload: { file: File; description: string }) => {
    const localId = crypto.randomUUID();
    setPendingUploads((prev) => [
      ...prev,
      { localId, ...upload, status: "uploading", errorMessage: null },
    ]);
    runUpload(localId, upload);
  };

  const runUpload = (
    localId: string,
    upload: { file: File; description: string },
  ) => {
    void addMutation
      .mutateAsync({
        projectName,
        number,
        description: upload.description,
        file: upload.file,
      })
      .then(
        () => {
          setPendingUploads((prev) =>
            prev.filter((p) => p.localId !== localId),
          );
        },
        (error: unknown) => {
          setPendingUploads((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? {
                    ...p,
                    status: "failed",
                    errorMessage:
                      error instanceof Error ? error.message : String(error),
                  }
                : p,
            ),
          );
        },
      );
  };

  const retryUpload = (upload: PendingUpload) => {
    setPendingUploads((prev) =>
      prev.map((p) =>
        p.localId === upload.localId
          ? { ...p, status: "uploading", errorMessage: null }
          : p,
      ),
    );
    runUpload(upload.localId, upload);
  };

  const discardUpload = (localId: string) => {
    setPendingUploads((prev) => prev.filter((p) => p.localId !== localId));
  };

  return (
    <section aria-label="Context attachments" className="flex flex-col gap-sm">
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle pb-[6px]">
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Context attachments
        </span>
        <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-bg-raised px-[6px] py-px font-mono text-[0.68rem] font-semibold text-text-secondary">
          {attachments.length}
        </span>
        <span className="text-[0.7rem] text-text-tertiary max-768:hidden">
          — the index agents read first; full content is retrieved on demand
        </span>
        <Button
          variant="default"
          size="sm"
          layoutClassName="ml-auto shrink-0"
          data-add-ticket-context
          onClick={() => setDialogOpen(true)}
        >
          Add context
        </Button>
      </div>

      {attachments.length === 0 && pendingUploads.length === 0 ? (
        <span className="py-sm font-mono text-[0.74rem] text-text-tertiary">
          No context attachments yet — Add context so the ticket is
          self-sufficient by the time work starts.
        </span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {attachments.map((attachment) => (
            <AttachmentEntry
              key={attachment.id}
              projectName={projectName}
              number={number}
              attachment={attachment}
              onBeforeRemove={() => prepareRemovalFocus(attachment.id)}
            />
          ))}
          {pendingUploads.map((upload) =>
            upload.status === "uploading" ? (
              <UploadingEntry key={upload.localId} upload={upload} />
            ) : (
              <FailedUploadEntry
                key={upload.localId}
                upload={upload}
                onRetry={() => retryUpload(upload)}
                onDiscard={() => discardUpload(upload.localId)}
              />
            ),
          )}
        </ul>
      )}

      <AttachmentDialog
        projectName={projectName}
        number={number}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onFileSubmit={startUpload}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

type EntryPanel = "preview" | "edit" | null;

function AttachmentEntry({
  projectName,
  number,
  attachment,
  onBeforeRemove,
}: {
  projectName: string;
  number: number;
  attachment: TicketAttachment;
  onBeforeRemove: () => void;
}): React.JSX.Element {
  const [panel, setPanel] = useState<EntryPanel>(null);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const restoreEditFocusRef = useRef(false);
  const removeMutation = useRemoveTicketAttachmentMutation();
  const visual = KIND_VISUALS[attachment.payload.kind];
  const panelIdPrefix = useId();
  const previewPanelId = `${panelIdPrefix}-preview`;
  const editPanelId = `${panelIdPrefix}-edit`;

  useEffect(() => {
    if (panel !== null || !restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    editButtonRef.current?.focus();
  }, [panel]);

  const closeEditAndRestoreFocus = () => {
    restoreEditFocusRef.current = true;
    setPanel(null);
  };

  const remove = () => {
    setRemoveConfirmOpen(false);
    onBeforeRemove();
    void removeMutation
      .mutateAsync({
        projectName,
        number,
        attachmentId: attachment.id,
      })
      .catch(() => {
        pushToast(
          `Couldn't remove the ${visual.label} attachment — it was restored`,
        );
      });
  };

  return (
    <li
      aria-label={attachment.description}
      data-attachment-entry-id={attachment.id}
      data-expanded={panel === "preview"}
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md transition-colors hover:bg-bg-surface data-[expanded=true]:border-border-default"
    >
      <button
        type="button"
        data-attachment-view={attachment.id}
        data-expanded={panel === "preview"}
        className="group flex min-h-[44px] w-full cursor-pointer items-start gap-sm rounded-sm border-0 bg-transparent p-0 text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        aria-expanded={panel === "preview"}
        aria-controls={previewPanelId}
        onClick={() =>
          setPanel((current) => (current === "preview" ? null : "preview"))
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm",
            visual.tile,
          )}
        >
          <KindIcon kind={attachment.payload.kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <span className="text-[0.84rem] leading-[1.5] text-text-primary">
            {attachment.description}
          </span>
          <span className="flex flex-wrap items-center gap-sm">
            <span className={CHIP_CLASS}>{visual.label}</span>
            <EntryMetadata attachment={attachment} />
          </span>
        </span>
        <ChevronDownIcon />
      </button>
      <div className="flex flex-wrap items-center gap-sm pl-2xl max-768:pl-0">
        <AttachmentLink attachment={attachment} />
        <span className="ml-auto flex shrink-0 items-center gap-sm">
          <button
            ref={editButtonRef}
            type="button"
            className={ACTION_BUTTON_CLASS}
            aria-expanded={panel === "edit"}
            aria-controls={editPanelId}
            onClick={() =>
              setPanel((current) => (current === "edit" ? null : "edit"))
            }
          >
            Edit
          </button>
          <button
            type="button"
            className={cn(ACTION_BUTTON_CLASS, "hover:text-red")}
            onClick={() => setRemoveConfirmOpen(true)}
          >
            Remove
          </button>
        </span>
      </div>
      {panel === "preview" && (
        <AttachmentPreview
          id={previewPanelId}
          projectName={projectName}
          number={number}
          attachmentId={attachment.id}
        />
      )}
      {panel === "edit" && (
        <AttachmentEditForm
          id={editPanelId}
          projectName={projectName}
          number={number}
          attachment={attachment}
          onDone={closeEditAndRestoreFocus}
          onCancel={closeEditAndRestoreFocus}
        />
      )}
      <ConfirmDialog
        open={removeConfirmOpen}
        title="Remove attachment?"
        message={`“${attachment.description}” and its saved context will be removed permanently.`}
        confirmLabel="Remove"
        danger
        onConfirm={remove}
        onCancel={() => setRemoveConfirmOpen(false)}
      />
    </li>
  );
}

function EntryMetadata({
  attachment,
}: {
  attachment: TicketAttachment;
}): React.JSX.Element {
  const payload = attachment.payload;
  switch (payload.kind) {
    case "file":
      return (
        <span className={METADATA_CLASS}>
          {payload.fileName} · {formatBytes(payload.sizeBytes)}
        </span>
      );
    case "conversation":
      return (
        <span className={METADATA_CLASS}>
          {payload.sessionName ?? payload.conversationId} · captured{" "}
          {formatRelativeTime(payload.snapshotCapturedAt)}
        </span>
      );
    case "session":
      return <span className={METADATA_CLASS}>{payload.sessionName}</span>;
    case "related_ticket": {
      return (
        <span className={METADATA_CLASS}>{payload.identifierSnapshot}</span>
      );
    }
    case "note":
      return (
        <span className={METADATA_CLASS}>
          updated {formatRelativeTime(attachment.updatedAt)}
        </span>
      );
  }
}

function AttachmentLink({
  attachment,
}: {
  attachment: TicketAttachment;
}): React.JSX.Element | null {
  const payload = attachment.payload;
  switch (payload.kind) {
    case "conversation":
      return (
        <Link
          href={conversationsPageHref({
            conversationId: payload.conversationId,
          })}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open conversation"
          className={ATTACHMENT_LINK_CLASS}
        >
          Open conversation
          <ExternalLinkIcon />
        </Link>
      );
    case "session":
      return (
        <Link
          href={sessionDetailHref(payload.projectPath, payload.sessionName)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open session"
          className={ATTACHMENT_LINK_CLASS}
        >
          Open session
          <ExternalLinkIcon />
        </Link>
      );
    case "related_ticket": {
      const parsed = parseTicketIdentifier(payload.identifierSnapshot);
      if (parsed === null) return null;
      return (
        <Link
          href={ticketDetailHref(parsed.projectName, parsed.ticketNumber)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open ticket"
          className={ATTACHMENT_LINK_CLASS}
        >
          Open ticket
          <ExternalLinkIcon />
        </Link>
      );
    }
    case "file":
    case "note":
      return null;
  }
}

function sessionDetailHref(projectPath: string, sessionName: string): string {
  const pathSegments = projectPath.split(/[\\/]/).filter(Boolean);
  const projectName = pathSegments.at(-1) ?? projectPath;
  return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
}

// ---------------------------------------------------------------------------
// Expand-in-place preview (design: on the void surface)
// ---------------------------------------------------------------------------

function AttachmentPreview({
  id,
  projectName,
  number,
  attachmentId,
}: {
  id: string;
  projectName: string;
  number: number;
  attachmentId: string;
}): React.JSX.Element {
  const resolveQuery = useResolveTicketAttachmentQuery(
    projectName,
    number,
    attachmentId,
  );

  return (
    <div id={id} className="rounded-md bg-bg-void p-md">
      {resolveQuery.isPending ? (
        <span className="font-mono text-[0.72rem] text-text-tertiary">
          Loading content…
        </span>
      ) : resolveQuery.isError ? (
        <span
          role="alert"
          className="flex items-center gap-sm font-mono text-[0.72rem] text-red"
        >
          {resolveQuery.error instanceof Error
            ? resolveQuery.error.message
            : "Couldn't load the content"}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void resolveQuery.refetch()}
          >
            Retry
          </Button>
        </span>
      ) : (
        <ResolvedContent resolved={resolveQuery.data} />
      )}
    </div>
  );
}

function ResolvedContent({
  resolved,
}: {
  resolved: ResolvedAttachment;
}): React.JSX.Element {
  switch (resolved.kind) {
    case "file":
      if (resolved.encoding === "base64") {
        return (
          <span className="font-mono text-[0.72rem] text-text-tertiary">
            Binary file · {resolved.fileName} ·{" "}
            {formatBytes(resolved.sizeBytes)} — retrieve it with cctl.
          </span>
        );
      }
      return (
        <pre className="m-0 max-h-[360px] overflow-auto font-mono text-[0.74rem] leading-[1.55] whitespace-pre-wrap text-text-primary">
          {resolved.content}
        </pre>
      );
    case "conversation":
      return (
        <div className="flex flex-col gap-sm">
          <span className="font-mono text-[0.66rem] tracking-[0.05em] text-text-tertiary uppercase">
            {resolved.source === "live_compaction"
              ? "live compaction"
              : "retained compaction"}
            {!resolved.sourceAvailable && " — source conversation deleted"}
            {" · captured "}
            {formatRelativeTime(resolved.capturedAt)}
          </span>
          <DocumentMarkdown content={resolved.markdown} />
        </div>
      );
    case "session":
      return (
        <div className="flex flex-col gap-[4px] font-mono text-[0.74rem] text-text-secondary">
          <span className="text-text-primary">{resolved.sessionName}</span>
          <span>
            {resolved.finished ? "finished" : "active"} ·{" "}
            {resolved.conversationIds.length} conversation
            {resolved.conversationIds.length === 1 ? "" : "s"}
          </span>
        </div>
      );
    case "related_ticket":
      if (!resolved.available) {
        return (
          <span className="font-mono text-[0.72rem] text-text-tertiary">
            {resolved.identifierSnapshot} no longer exists — ticket numbers are
            never reused.
          </span>
        );
      }
      return (
        <div className="flex flex-col gap-[4px]">
          <Link
            href={ticketDetailHref(
              resolved.ticket.projectName,
              resolved.ticket.number,
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[0.78rem] font-semibold text-text-primary! no-underline hover:text-cyan!"
          >
            {formatTicketIdentifier(
              resolved.ticket.projectName,
              resolved.ticket.number,
            )}{" "}
            — {resolved.ticket.title}
          </Link>
          <span className="font-mono text-[0.68rem] text-text-tertiary">
            {TICKET_STATUS_VISUALS[resolved.ticket.status].label} ·{" "}
            {TICKET_WORK_TYPE_LABELS[resolved.ticket.workType]} ·{" "}
            {resolved.ticket.attachments.length} attachment
            {resolved.ticket.attachments.length === 1 ? "" : "s"}
          </span>
        </div>
      );
    case "note":
      return <DocumentMarkdown content={resolved.markdown} />;
  }
}

// ---------------------------------------------------------------------------
// Inline edit — description everywhere, markdown for notes; optimistic with
// snapshot rollback (the mutation restores the cache) + toast on failure.
// ---------------------------------------------------------------------------

function AttachmentEditForm({
  id,
  projectName,
  number,
  attachment,
  onDone,
  onCancel,
}: {
  id: string;
  projectName: string;
  number: number;
  attachment: TicketAttachment;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [description, setDescription] = useState(attachment.description);
  const [markdown, setMarkdown] = useState(
    attachment.payload.kind === "note" ? attachment.payload.markdown : "",
  );
  const editMutation = useEditTicketAttachmentMutation();
  const descriptionActionRef = useRef<MultilineInputActionHandle | null>(null);
  const markdownActionRef = useRef<MultilineInputActionHandle | null>(null);
  const [voiceBusyFields, setVoiceBusyFields] = useState<Set<string>>(
    () => new Set(),
  );

  const isNote = attachment.payload.kind === "note";
  const saveDisabled =
    description.trim().length === 0 || (isNote && markdown.trim().length === 0);

  const descriptionId = `attachment-description-${attachment.id}`;
  const markdownId = `attachment-markdown-${attachment.id}`;

  const save = (completed?: { description?: string; markdown?: string }) => {
    const nextDescription = completed?.description ?? description;
    const nextMarkdown = completed?.markdown ?? markdown;
    if (
      nextDescription.trim().length === 0 ||
      (isNote && nextMarkdown.trim().length === 0)
    ) {
      return;
    }
    onDone();
    void editMutation
      .mutateAsync({
        projectName,
        number,
        attachmentId: attachment.id,
        description: nextDescription,
        ...(isNote ? { markdown: nextMarkdown } : {}),
      })
      .catch(() => {
        pushToast("Couldn't save the attachment — rolled back");
      });
  };

  return (
    <div id={id} className="flex flex-col gap-sm rounded-md bg-bg-void p-md">
      <label
        htmlFor={descriptionId}
        className="font-mono text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase"
      >
        Description
      </label>
      <MultilineInput
        id={descriptionId}
        rows={2}
        required
        value={description}
        onValueChange={setDescription}
        onPrimaryAction={(value) => save({ description: value })}
        actionRef={descriptionActionRef}
        onVoiceStateChange={(busy) =>
          setVoiceBusyFields((previous) => {
            const next = new Set(previous);
            if (busy) next.add("description");
            else next.delete("description");
            return next;
          })
        }
        voiceProjectName={projectName}
        className={ENTRY_TEXTAREA_CLASS}
      />
      {isNote && (
        <>
          <label
            htmlFor={markdownId}
            className="font-mono text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase"
          >
            Markdown
          </label>
          <MultilineInput
            id={markdownId}
            rows={5}
            required
            value={markdown}
            onValueChange={setMarkdown}
            onPrimaryAction={(value) => save({ markdown: value })}
            actionRef={markdownActionRef}
            onVoiceStateChange={(busy) =>
              setVoiceBusyFields((previous) => {
                const next = new Set(previous);
                if (busy) next.add("markdown");
                else next.delete("markdown");
                return next;
              })
            }
            voiceProjectName={projectName}
            className={ENTRY_TEXTAREA_CLASS}
          />
        </>
      )}
      <div className="flex items-center gap-sm">
        <Button
          variant="primary"
          size="sm"
          disabled={saveDisabled && voiceBusyFields.size === 0}
          onClick={() =>
            runMultilinePrimaryAction(
              [descriptionActionRef.current, markdownActionRef.current],
              save,
            )
          }
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending / failed upload entries
// ---------------------------------------------------------------------------

function UploadingEntry({
  upload,
}: {
  upload: PendingUpload;
}): React.JSX.Element {
  return (
    <li
      aria-label={`Uploading ${upload.file.name}`}
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-[12px]"
    >
      <div className="flex items-start gap-sm">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm",
            KIND_VISUALS.file.tile,
          )}
        >
          <KindIcon kind="file" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <p className="m-0 text-[0.84rem] leading-[1.5] text-text-primary">
            {upload.description}
          </p>
          <span className={METADATA_CLASS}>Uploading {upload.file.name}…</span>
          <Progress
            value={null}
            aria-label={`Upload progress for ${upload.file.name}`}
          />
        </div>
      </div>
    </li>
  );
}

function FailedUploadEntry({
  upload,
  onRetry,
  onDiscard,
}: {
  upload: PendingUpload;
  onRetry: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  return (
    <li
      aria-label={`Failed upload ${upload.file.name}`}
      className="flex flex-col gap-sm rounded-md border border-solid border-red-dim bg-red-glow p-[12px]"
    >
      <div role="alert" className="flex flex-col gap-sm">
        <span className="font-mono text-[0.76rem] font-semibold text-red">
          Couldn&apos;t attach {upload.file.name}
        </span>
        <span className="text-[0.76rem] text-text-secondary">
          {upload.description}
        </span>
        {upload.errorMessage !== null && (
          <span className="font-mono text-[0.68rem] text-text-tertiary">
            {upload.errorMessage}
          </span>
        )}
        <div className="flex items-center gap-sm">
          <Button variant="primary" size="sm" onClick={onRetry}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </div>
    </li>
  );
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="mt-xs shrink-0 text-text-tertiary transition-transform duration-150 group-hover:text-text-primary group-data-[expanded=true]:rotate-180 motion-reduce:transition-none"
    >
      <path
        d="M6 9 L12 15 L18 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M14 5 H19 V10 M19 5 L11 13 M19 13 V19 H5 V5 H11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Kind icons — 16-grid, 1.2 stroke, matching the ticket icon language
// ---------------------------------------------------------------------------

function KindIcon({ kind }: { kind: TicketAttachmentKind }): React.JSX.Element {
  switch (kind) {
    case "file":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 2 H9.5 L12.5 5 V14 H4 Z M9.5 2 V5 H12.5 M6 8 H10.5 M6 10.5 H10.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "conversation":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 3.5 H13.5 V10.5 H8 L5 13 V10.5 H2.5 Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "session":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 3 H14 V13 H2 Z M4.5 6.5 L7 8.5 L4.5 10.5 M8.5 10.5 H11.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      );
    case "related_ticket":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 5 H14 V7 A1.5 1.5 0 0 0 14 10 V12 H2 V10 A1.5 1.5 0 0 0 2 7 Z M9.5 5 V12"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            strokeDasharray="0"
          />
        </svg>
      );
    case "note":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 2.5 H13 V10 L9.5 13.5 H3 Z M9.5 13.5 V10 H13 M5.5 6 H10.5 M5.5 8.5 H8.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}
