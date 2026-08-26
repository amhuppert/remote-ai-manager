"use client";

import type { SessionConversationListItem } from "@/lib/conversations/schemas";
import { useId, useRef, useState } from "react";

import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
} from "@/components/ui/Dialog";
import {
  FormError,
  FormGroup,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useDialogRequestGeneration } from "@/hooks/use-dialog-request-generation";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import { useAllConversationsQuery } from "@/lib/conversations/queries";
import { useProjectsQuery } from "@/lib/projects/queries";
import { useProjectConversationsQuery } from "@/lib/project-conversations-client/queries";
import { useSessionsQuery } from "@/lib/sessions/list-queries";
import {
  useAddTicketAttachmentMutation,
  type JsonAttachmentPayloadInput,
} from "@/lib/tickets/mutations";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketAttachmentKind } from "@/lib/tickets/schemas";
import { useOpenerFocus } from "@/hooks/use-opener-focus";

import FieldGroupLabel from "./FieldGroupLabel";

/** The attachment request minus its target — the ticket may not exist yet. */
export type QueuedTicketAttachmentRequest = { description: string } & (
  | { payload: JsonAttachmentPayloadInput; file?: never }
  | { file: File; fileName?: string; mediaType?: string; payload?: never }
);

export interface QueuedTicketAttachment {
  /** Stable client key for list rendering and removal. */
  localId: string;
  kind: TicketAttachmentKind;
  /** Human summary of the target (file name, session, ticket reference…). */
  summary: string;
  request: QueuedTicketAttachmentRequest;
}

export interface AttachmentDialogProps {
  projectName: string;
  /** Owning ticket; absent in queue mode where the ticket does not exist yet. */
  number?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * File uploads are owned by the index (in-entry progress + failure panel
   * with Retry/Discard), so submitting a file hands off and closes.
   * Required unless `onQueue` is set.
   */
  onFileSubmit?: (input: { file: File; description: string }) => void;
  /**
   * Queue mode: hand the composed attachment back instead of POSTing it —
   * used by surfaces that create the ticket later (quick ticket creation).
   */
  onQueue?: (attachment: QueuedTicketAttachment) => void;
}

const KIND_OPTIONS: ReadonlyArray<{
  kind: TicketAttachmentKind;
  label: string;
}> = [
  { kind: "file", label: "File" },
  { kind: "conversation", label: "Conversation" },
  { kind: "session", label: "Session" },
  { kind: "related_ticket", label: "Related ticket" },
  { kind: "note", label: "Note" },
];

// The `FormInput` primitive's recipe, applied to the multiline input it cannot
// render — same approach as CreateSessionModal.
const FIELD_CLASS =
  "box-border w-full rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] font-mono text-[0.82rem] text-text-primary outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] disabled:opacity-60";

export default function AttachmentDialog({
  projectName,
  number,
  open,
  onOpenChange,
  onFileSubmit,
  onQueue,
}: AttachmentDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<TicketAttachmentKind>("file");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [conversationLabel, setConversationLabel] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [targetProject, setTargetProject] = useState(projectName);
  const [ticketNumber, setTicketNumber] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceBusyFields, setVoiceBusyFields] = useState<Set<string>>(
    () => new Set(),
  );
  const markdownActionRef = useRef<MultilineInputActionHandle | null>(null);
  const descriptionActionRef = useRef<MultilineInputActionHandle | null>(null);
  const addMutation = useAddTicketAttachmentMutation();
  const requestGeneration = useDialogRequestGeneration(open);
  const kindLabelId = useId();
  // State-opened dialog (no Radix trigger) — restore focus to the opener.
  const { captureOpener, restoreOpener } = useOpenerFocus();

  const reset = () => {
    setKind("file");
    setDescription("");
    setFile(null);
    setConversationId("");
    setConversationLabel("");
    setSessionName("");
    setTargetProject(projectName);
    setTicketNumber("");
    setMarkdown("");
    setError(null);
    setVoiceBusyFields(new Set());
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      requestGeneration.invalidate();
      reset();
    }
    onOpenChange(nextOpen);
  };

  const parsedNumber = Number(ticketNumber);
  const kindComplete = (() => {
    switch (kind) {
      case "file":
        return file !== null;
      case "conversation":
        return (
          conversationId.trim().length > 0 && targetProject.trim().length > 0
        );
      case "session":
        return sessionName.trim().length > 0 && targetProject.trim().length > 0;
      case "related_ticket":
        return (
          targetProject.trim().length > 0 &&
          Number.isSafeInteger(parsedNumber) &&
          parsedNumber > 0
        );
      case "note":
        return markdown.trim().length > 0;
    }
  })();

  const submitDisabled =
    description.trim().length === 0 || !kindComplete || addMutation.isPending;

  const submit = (completed?: { description?: string; markdown?: string }) => {
    const nextDescription = completed?.description ?? description;
    const nextMarkdown = completed?.markdown ?? markdown;
    const nextKindComplete = (() => {
      if (kind === "note") return nextMarkdown.trim().length > 0;
      return kindComplete;
    })();
    setError(null);
    if (
      nextDescription.trim().length === 0 ||
      !nextKindComplete ||
      addMutation.isPending
    ) {
      return;
    }
    if (kind === "file") {
      if (file === null) return;
      if (onQueue !== undefined) {
        onQueue({
          localId: crypto.randomUUID(),
          kind,
          summary: file.name,
          request: { description: nextDescription, file },
        });
        close(false);
        return;
      }
      onFileSubmit?.({ file, description: nextDescription });
      close(false);
      return;
    }

    const payload = (() => {
      switch (kind) {
        case "conversation":
          return {
            kind: "conversation" as const,
            projectName: targetProject,
            conversationId,
            sessionName: sessionName.trim().length > 0 ? sessionName : null,
          };
        case "session":
          return {
            kind: "session" as const,
            projectName: targetProject,
            sessionName,
          };
        case "related_ticket":
          return {
            kind: "related_ticket" as const,
            projectName: targetProject,
            number: parsedNumber,
          };
        default:
          return { kind: "note" as const, markdown: nextMarkdown };
      }
    })();

    if (onQueue !== undefined) {
      const summary = (() => {
        switch (payload.kind) {
          case "conversation":
            return conversationLabel.length > 0
              ? conversationLabel
              : conversationId;
          case "session":
            return `${targetProject} / ${sessionName}`;
          case "related_ticket":
            return `${targetProject}#${parsedNumber}`;
          case "note":
            return nextMarkdown.length > 60
              ? `${nextMarkdown.slice(0, 60)}…`
              : nextMarkdown;
        }
      })();
      onQueue({
        localId: crypto.randomUUID(),
        kind: payload.kind,
        summary,
        request: { description: nextDescription, payload },
      });
      close(false);
      return;
    }

    if (number === undefined) return;
    const generation = requestGeneration.capture();
    addMutation.mutate(
      { projectName, number, description: nextDescription, payload },
      {
        onSuccess: () => {
          if (!requestGeneration.isCurrent(generation)) return;
          close(false);
        },
        onError: (mutationError) => {
          if (!requestGeneration.isCurrent(generation)) return;
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : "Couldn't add the attachment",
          );
        },
      },
    );
  };

  const pending = addMutation.isPending;
  const updateVoiceBusy = (field: string, busy: boolean) => {
    setVoiceBusyFields((previous) => {
      const next = new Set(previous);
      if (busy) next.add(field);
      else next.delete(field);
      return next;
    });
  };
  const voiceBusy = voiceBusyFields.size > 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        mobileSheet
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        <DialogTitle>Add context</DialogTitle>

        <FormGroup>
          <FieldGroupLabel id={kindLabelId}>Kind</FieldGroupLabel>
          <div className="max-w-full overflow-x-auto pb-2xs">
            <SegmentedControl
              value={kind}
              onValueChange={(value) => setKind(value as TicketAttachmentKind)}
              aria-labelledby={kindLabelId}
              required
            >
              {KIND_OPTIONS.map((option) => (
                <SegmentedControlItem
                  key={option.kind}
                  value={option.kind}
                  disabled={pending}
                >
                  {option.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </FormGroup>

        {kind === "file" && (
          <FormGroup>
            <FormLabel htmlFor="attachment-dialog-file">File</FormLabel>
            <FormInput
              id="attachment-dialog-file"
              type="file"
              required
              disabled={pending}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </FormGroup>
        )}

        {kind === "conversation" && (
          <ConversationTargetSelect
            projectName={targetProject}
            conversationId={conversationId}
            disabled={pending}
            onProjectChange={(nextProject) => {
              setTargetProject(nextProject);
              setConversationId("");
              setSessionName("");
            }}
            onSelect={(selection) => {
              setConversationId(selection.conversationId);
              setConversationLabel(selection.label);
              setSessionName(selection.sessionName);
              setTargetProject(selection.projectName);
            }}
          />
        )}

        {kind === "session" && (
          <SessionTargetSelect
            projectName={targetProject}
            sessionName={sessionName}
            disabled={pending}
            onProjectChange={(nextProject) => {
              setTargetProject(nextProject);
              setSessionName("");
            }}
            onSessionChange={setSessionName}
          />
        )}

        {kind === "related_ticket" && (
          <RelatedTicketTargetSelect
            owningProjectName={projectName}
            owningTicketNumber={number}
            projectName={targetProject}
            ticketNumber={ticketNumber}
            disabled={pending}
            onProjectChange={(nextProject) => {
              setTargetProject(nextProject);
              setTicketNumber("");
            }}
            onTicketNumberChange={setTicketNumber}
          />
        )}

        {kind === "note" && (
          <FormGroup>
            <FormLabel htmlFor="attachment-dialog-markdown">Markdown</FormLabel>
            <MultilineInput
              id="attachment-dialog-markdown"
              rows={5}
              required
              value={markdown}
              disabled={pending}
              onValueChange={setMarkdown}
              onPrimaryAction={(value) => submit({ markdown: value })}
              actionRef={markdownActionRef}
              onVoiceStateChange={(busy) => updateVoiceBusy("markdown", busy)}
              voiceProjectName={projectName}
              placeholder="## Context…"
              className={FIELD_CLASS}
            />
          </FormGroup>
        )}

        <FormGroup>
          <FormLabel htmlFor="attachment-dialog-description">
            Description
          </FormLabel>
          <MultilineInput
            id="attachment-dialog-description"
            rows={2}
            required
            value={description}
            disabled={pending}
            onValueChange={setDescription}
            onPrimaryAction={(value) => submit({ description: value })}
            actionRef={descriptionActionRef}
            onVoiceStateChange={(busy) => updateVoiceBusy("description", busy)}
            voiceProjectName={projectName}
            placeholder="What this contains and why it matters for the work"
            className={FIELD_CLASS}
          />
        </FormGroup>

        {error !== null && <FormError role="alert">{error}</FormError>}

        <DialogActions>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending || (submitDisabled && !voiceBusy)}
            onClick={() =>
              runMultilinePrimaryAction(
                [markdownActionRef.current, descriptionActionRef.current],
                submit,
              )
            }
          >
            {pending && <Spinner size="sm" tone="inherit" />}
            Attach
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

interface TargetProjectSelectProps {
  value: string;
  disabled: boolean;
  onValueChange: (projectName: string) => void;
}

function TargetProjectSelect({
  value,
  disabled,
  onValueChange,
}: TargetProjectSelectProps): React.JSX.Element {
  const selectId = useId();
  const projectsQuery = useProjectsQuery();
  const names = new Set(
    (projectsQuery.data ?? []).map((project) => project.name),
  );
  if (value.length > 0) names.add(value);
  const options = [...names].sort((a, b) => a.localeCompare(b));

  return (
    <FormGroup>
      <FormLabel htmlFor={selectId}>Project</FormLabel>
      <Select
        value={value.length > 0 ? value : undefined}
        onValueChange={onValueChange}
        disabled={
          disabled ||
          projectsQuery.isPending ||
          (projectsQuery.data === undefined && projectsQuery.isFetching)
        }
      >
        <SelectTrigger
          id={selectId}
          layoutClassName="w-full"
          aria-required="true"
        >
          <SelectValue
            placeholder={
              projectsQuery.isPending
                ? "Loading projects…"
                : "Choose a project…"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {projectsQuery.isPending && (
        <PickerLoading>Loading projects…</PickerLoading>
      )}
      {projectsQuery.isError && (
        <PickerError
          retryLabel="Retry projects"
          retrying={projectsQuery.isFetching}
          onRetry={() => void projectsQuery.refetch()}
        >
          Couldn&apos;t load projects
        </PickerError>
      )}
    </FormGroup>
  );
}

interface ConversationTargetSelectProps {
  projectName: string;
  conversationId: string;
  disabled: boolean;
  onProjectChange: (projectName: string) => void;
  onSelect: (selection: {
    projectName: string;
    sessionName: string;
    conversationId: string;
    label: string;
  }) => void;
}

function ConversationTargetSelect({
  projectName,
  conversationId,
  disabled,
  onProjectChange,
  onSelect,
}: ConversationTargetSelectProps): React.JSX.Element {
  const selectId = useId();
  const conversationsQuery = useAllConversationsQuery({
    includeArchived: false,
  });
  const projectConversationsQuery = useProjectConversationsQuery(projectName);
  // Session-scoped rows only: project conversations come from
  // `projectConversationsQuery` below, so taking them from the all-list too would
  // both duplicate them and require a session name they do not have.
  const sessionConversations = (conversationsQuery.data?.items ?? []).filter(
    (conversation): conversation is SessionConversationListItem =>
      conversation.scope === "session" &&
      conversation.projectName === projectName,
  );
  const conversations = [
    ...sessionConversations.map((conversation) => ({
      id: conversation.conversationId,
      label: resolveDisplayLabel({
        conversationName: conversation.conversationName,
        summary: conversation.summary,
        firstPromptSnippet: conversation.firstPromptSnippet,
        conversationId: conversation.conversationId,
      }),
      sessionName: conversation.sessionName,
      lastActivityAt: conversation.lastActivityAt,
    })),
    ...(projectConversationsQuery.data ?? []).map((conversation) => ({
      id: conversation.id,
      label: resolveDisplayLabel({
        conversationName: conversation.name,
        summary: conversation.summary,
        firstPromptSnippet: null,
        conversationId: conversation.id,
      }),
      sessionName: "",
      lastActivityAt: conversation.lastActivityAt,
    })),
  ].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return (
    <>
      <TargetProjectSelect
        value={projectName}
        disabled={disabled}
        onValueChange={onProjectChange}
      />
      <FormGroup>
        <FormLabel htmlFor={selectId}>Conversation</FormLabel>
        <Select
          value={conversationId}
          onValueChange={(nextId) => {
            const selected = conversations.find(
              (conversation) => conversation.id === nextId,
            );
            if (selected === undefined) return;
            onSelect({
              projectName,
              sessionName: selected.sessionName,
              conversationId: selected.id,
              label: selected.label,
            });
          }}
          disabled={
            disabled ||
            conversationsQuery.isPending ||
            projectConversationsQuery.isPending ||
            (conversationsQuery.data === undefined &&
              conversationsQuery.isFetching) ||
            (projectConversationsQuery.data === undefined &&
              projectConversationsQuery.isFetching)
          }
        >
          <SelectTrigger
            id={selectId}
            layoutClassName="w-full"
            aria-required="true"
          >
            <SelectValue
              placeholder={
                conversationsQuery.isPending ||
                projectConversationsQuery.isPending
                  ? "Loading conversations…"
                  : "Choose a conversation…"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {conversations.map((conversation) => (
              <SelectItem
                key={conversation.id}
                value={conversation.id}
                description={
                  conversation.sessionName.length > 0
                    ? conversation.sessionName
                    : "project conversation"
                }
              >
                {conversation.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(conversationsQuery.isPending ||
          projectConversationsQuery.isPending) && (
          <PickerLoading>Loading conversations…</PickerLoading>
        )}
        {(conversationsQuery.isError || projectConversationsQuery.isError) && (
          <PickerError
            retryLabel="Retry conversations"
            retrying={
              conversationsQuery.isFetching ||
              projectConversationsQuery.isFetching
            }
            onRetry={() => {
              void conversationsQuery.refetch();
              void projectConversationsQuery.refetch();
            }}
          >
            Couldn&apos;t load conversations
          </PickerError>
        )}
        {conversationsQuery.isSuccess &&
          projectConversationsQuery.isSuccess &&
          conversations.length === 0 && (
            <PickerEmpty>No addressable conversations found</PickerEmpty>
          )}
      </FormGroup>
    </>
  );
}

interface SessionTargetSelectProps {
  projectName: string;
  sessionName: string;
  disabled: boolean;
  onProjectChange: (projectName: string) => void;
  onSessionChange: (sessionName: string) => void;
}

function SessionTargetSelect({
  projectName,
  sessionName,
  disabled,
  onProjectChange,
  onSessionChange,
}: SessionTargetSelectProps): React.JSX.Element {
  const selectId = useId();
  const sessionsQuery = useSessionsQuery(projectName);
  const sessions = [...(sessionsQuery.data ?? [])].sort((a, b) =>
    a.sessionName.localeCompare(b.sessionName),
  );

  return (
    <>
      <TargetProjectSelect
        value={projectName}
        disabled={disabled}
        onValueChange={onProjectChange}
      />
      <FormGroup>
        <FormLabel htmlFor={selectId}>Session</FormLabel>
        <Select
          value={sessionName}
          onValueChange={onSessionChange}
          disabled={
            disabled ||
            sessionsQuery.isPending ||
            (sessionsQuery.data === undefined && sessionsQuery.isFetching)
          }
        >
          <SelectTrigger
            id={selectId}
            layoutClassName="w-full"
            aria-required="true"
          >
            <SelectValue
              placeholder={
                sessionsQuery.isPending
                  ? "Loading sessions…"
                  : "Choose a session…"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {sessions.map((session) => (
              <SelectItem
                key={session.sessionName}
                value={session.sessionName}
                description={
                  session.finished ? "finished" : session.derivedStatus
                }
              >
                {session.sessionName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sessionsQuery.isPending && (
          <PickerLoading>Loading sessions…</PickerLoading>
        )}
        {sessionsQuery.isError && (
          <PickerError
            retryLabel="Retry sessions"
            retrying={sessionsQuery.isFetching}
            onRetry={() => void sessionsQuery.refetch()}
          >
            Couldn&apos;t load sessions
          </PickerError>
        )}
        {sessionsQuery.isSuccess && sessions.length === 0 && (
          <PickerEmpty>No sessions found in this project</PickerEmpty>
        )}
      </FormGroup>
    </>
  );
}

interface RelatedTicketTargetSelectProps {
  owningProjectName: string;
  owningTicketNumber: number | undefined;
  projectName: string;
  ticketNumber: string;
  disabled: boolean;
  onProjectChange: (projectName: string) => void;
  onTicketNumberChange: (ticketNumber: string) => void;
}

function RelatedTicketTargetSelect({
  owningProjectName,
  owningTicketNumber,
  projectName,
  ticketNumber,
  disabled,
  onProjectChange,
  onTicketNumberChange,
}: RelatedTicketTargetSelectProps): React.JSX.Element {
  const selectId = useId();
  const ticketsQuery = useTicketListQuery({ projectName });
  const tickets = (ticketsQuery.data ?? []).filter(
    (ticket) =>
      owningTicketNumber === undefined ||
      ticket.projectName !== owningProjectName ||
      ticket.number !== owningTicketNumber,
  );

  return (
    <>
      <TargetProjectSelect
        value={projectName}
        disabled={disabled}
        onValueChange={onProjectChange}
      />
      <FormGroup>
        <FormLabel htmlFor={selectId}>Related ticket</FormLabel>
        <Select
          value={ticketNumber}
          onValueChange={onTicketNumberChange}
          disabled={
            disabled ||
            ticketsQuery.isPending ||
            (ticketsQuery.data === undefined && ticketsQuery.isFetching)
          }
        >
          <SelectTrigger
            id={selectId}
            layoutClassName="w-full"
            aria-required="true"
          >
            <SelectValue
              placeholder={
                ticketsQuery.isPending ? "Loading tickets…" : "Choose a ticket…"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {tickets.map((ticket) => (
              <SelectItem
                key={ticket.id}
                value={String(ticket.number)}
                description={ticket.status.replaceAll("_", " ")}
              >
                {ticket.projectName}#{ticket.number} · {ticket.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {ticketsQuery.isPending && (
          <PickerLoading>Loading tickets…</PickerLoading>
        )}
        {ticketsQuery.isError && (
          <PickerError
            retryLabel="Retry tickets"
            retrying={ticketsQuery.isFetching}
            onRetry={() => void ticketsQuery.refetch()}
          >
            Couldn&apos;t load tickets
          </PickerError>
        )}
        {ticketsQuery.isSuccess && tickets.length === 0 && (
          <PickerEmpty>No other tickets found in this project</PickerEmpty>
        )}
      </FormGroup>
    </>
  );
}

function PickerError({
  children,
  retryLabel,
  retrying,
  onRetry,
}: {
  children: React.ReactNode;
  retryLabel: string;
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="mt-xs flex items-center gap-sm font-mono text-[0.7rem] text-red"
    >
      <span>{children}</span>
      <button
        type="button"
        disabled={retrying}
        onClick={onRetry}
        className="min-h-[24px] cursor-pointer border-0 bg-transparent p-0 font-mono font-semibold text-red underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
      >
        {retrying ? "Retrying…" : retryLabel}
      </button>
    </div>
  );
}

function PickerLoading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p
      role="status"
      className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary"
    >
      {children}
    </p>
  );
}

function PickerEmpty({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
      {children}
    </p>
  );
}
