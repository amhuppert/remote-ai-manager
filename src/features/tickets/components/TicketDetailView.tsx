"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import ConfirmDialog from "@/components/ConfirmDialog";
import Topbar from "@/components/Topbar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { ApiCallError } from "@/lib/api/errors";
import {
  useUpdateTicketMutation,
  useDeleteTicketMutation,
} from "@/lib/tickets/mutations";
import {
  useTicketDetailQuery,
  useTicketSessionLinksQuery,
} from "@/lib/tickets/queries";
import type {
  TicketDetail,
  TicketLinkSummary,
  TicketSessionLink,
  TicketStatus,
  TicketWorkType,
} from "@/lib/tickets/schemas";
import { pushToast } from "@/stores/toast.store";
import { cn } from "@/lib/ui/cn";
import { formatRelativeTime } from "../format-relative-time";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "@/lib/tickets/ticket-visuals";
import TicketBundleControl from "./TicketBundleControl";
import AttachmentIndex from "./AttachmentIndex";
import TicketRelationships from "./TicketRelationships";
import TicketStatusUpdates from "./TicketStatusUpdates";
import CopyTicketReferenceButton from "@/components/references/CopyTicketReferenceButton";
import StartTicketDialog, {
  StartTicketConflictAlert,
} from "./StartTicketDialog";
import { TicketDescriptionEditor, TicketTitleEditor } from "./TicketEditor";
import TicketSpecsCard from "./TicketSpecsCard";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

export interface TicketDetailViewProps {
  projectName: string;
  number: number;
  defaultAgentBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}

const RAIL_CARD_CLASS =
  "flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md";

const RAIL_HEADING_CLASS =
  "font-mono text-[0.68rem] font-semibold tracking-[0.08em] uppercase text-text-tertiary";

const COUNT_PILL_CLASS =
  "inline-flex min-w-[18px] items-center justify-center rounded-full bg-bg-raised px-[6px] py-px font-mono text-[0.68rem] font-semibold text-text-secondary";

export default function TicketDetailView({
  projectName,
  number,
  defaultAgentBackend,
  backendDefaults,
}: TicketDetailViewProps): React.JSX.Element {
  const detailQuery = useTicketDetailQuery(projectName, number);
  const identifier = ticketIdentifier({ projectName, number });
  const detailNotFound = detailQuery.isError && isNotFound(detailQuery.error);

  return (
    <div className="app" data-page="ticket-detail">
      <Topbar
        page="tickets"
        breadcrumbs={[
          { label: "tickets", href: "/tickets" },
          { label: identifier },
        ]}
      />
      <main className="main">
        {detailQuery.isPending ? (
          <div className="px-xl py-lg font-mono text-[0.72rem] text-text-tertiary">
            Loading ticket…
          </div>
        ) : detailQuery.isError ? (
          <div role={detailNotFound ? undefined : "alert"} className="py-3xl">
            <EmptyState>
              <EmptyStateTitle>
                {detailNotFound
                  ? `${identifier} doesn't exist`
                  : "Couldn't load the ticket"}
              </EmptyStateTitle>
              <EmptyStateDesc>
                {detailNotFound ? (
                  <>
                    It may have been deleted — ticket numbers are never reused.{" "}
                    <Link href="/tickets">Back to tickets</Link>
                  </>
                ) : detailQuery.error instanceof Error ? (
                  detailQuery.error.message
                ) : (
                  "Something went wrong fetching the ticket."
                )}
              </EmptyStateDesc>
              {!detailNotFound && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={detailQuery.isFetching}
                  onClick={() => void detailQuery.refetch()}
                >
                  {detailQuery.isFetching ? "Retrying…" : "Retry ticket"}
                </Button>
              )}
            </EmptyState>
          </div>
        ) : (
          <TicketDossier
            detail={detailQuery.data}
            defaultAgentBackend={defaultAgentBackend}
            backendDefaults={backendDefaults}
          />
        )}
      </main>
    </div>
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 404;
}

export interface TicketDossierProps {
  detail: TicketDetail;
  defaultAgentBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
  /** `pane` stacks the rail below the main column for the split pane. */
  layout?: "page" | "pane";
  /** Where to go after a confirmed delete; defaults to the tickets index. */
  onDeleted?: () => void;
}

export function TicketDossier({
  detail,
  defaultAgentBackend,
  backendDefaults,
  layout = "page",
  onDeleted,
}: TicketDossierProps): React.JSX.Element {
  const router = useRouter();
  const updateMutation = useUpdateTicketMutation();
  const deleteMutation = useDeleteTicketMutation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [conflictSessionName, setConflictSessionName] = useState<string | null>(
    null,
  );
  const [conflictOpen, setConflictOpen] = useState(false);
  const [startResolving, setStartResolving] = useState(false);

  const identifier = ticketIdentifier(detail);
  const statusVisual = TICKET_STATUS_VISUALS[detail.status];

  // The pre-dialog conflict decision must be liveness-aware: link demotion is
  // reconciliation-driven (it runs on the next start request), so a raw link
  // row can keep `endedAt: null` after its session finished or was deleted —
  // gating Start on the rows alone would block that very reconciliation. The
  // per-project session-link map derives `active` with the instance guard,
  // but session lifecycle changes don't invalidate its query key, so a cached
  // map can say `active: true` after the session ended. The decision therefore
  // refetches the map when Start is clicked and judges the fresh result; a
  // refetch failure defers to the server's 409 (which the start dialog
  // surfaces naming the session).
  const sessionLinksQuery = useTicketSessionLinksQuery(detail.projectName);
  const findActiveSession = (
    links: Record<string, TicketLinkSummary>,
  ): string | null =>
    Object.entries(links).find(
      ([, link]) => link.ticketId === detail.id && link.active,
    )?.[0] ?? null;

  // Cached knowledge only — rendered as `data-start-conflict` so tests (and
  // devtools) can observe when the map has loaded; raw rows are the
  // placeholder while it does. The click never trusts this value.
  const cachedConflictSessionName = ((): string | null => {
    const links = sessionLinksQuery.data;
    if (links !== undefined) return findActiveSession(links);
    if (sessionLinksQuery.isError) return null;
    return (
      detail.sessions.find((link) => link.endedAt === null)?.sessionName ?? null
    );
  })();

  const requestStart = async () => {
    if (startResolving) return;
    setStartResolving(true);
    try {
      const fresh = await sessionLinksQuery.refetch();
      // On refetch failure `fresh.data` still holds the stale cache — never
      // judge the conflict from it; let the server's 409 backstop decide.
      const activeSessionName =
        fresh.isError || fresh.data === undefined
          ? null
          : findActiveSession(fresh.data);
      if (activeSessionName !== null) {
        setConflictSessionName(activeSessionName);
        setConflictOpen(true);
      } else {
        setStartOpen(true);
      }
    } finally {
      setStartResolving(false);
    }
  };

  const changeField = (
    fields: { status: TicketStatus } | { workType: TicketWorkType },
  ) => {
    const failedTarget =
      "status" in fields
        ? TICKET_STATUS_VISUALS[fields.status].label
        : TICKET_WORK_TYPE_LABELS[fields.workType];
    void updateMutation
      .mutateAsync({
        projectName: detail.projectName,
        number: detail.number,
        fields,
      })
      .catch(() => {
        pushToast(
          `Couldn't move ${identifier} to ${failedTarget} — rolled back`,
          {
            action: { label: "Retry", onClick: () => changeField(fields) },
          },
        );
      });
  };

  const confirmDelete = () => {
    setDeleteOpen(false);
    void deleteMutation
      .mutateAsync({ projectName: detail.projectName, number: detail.number })
      .catch(() => {
        pushToast(`Couldn't delete ${identifier} — it was restored`);
      });
    // Optimistic-removal contract: the caches already dropped the ticket, so
    // the dossier leaves the view immediately; a failure restores it and says so.
    if (onDeleted !== undefined) {
      onDeleted();
    } else {
      router.push("/tickets");
    }
  };

  return (
    <>
      {/* Header */}
      <div
        className={cn(
          "flex flex-col gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-dim py-md max-768:px-md",
          layout === "pane" ? "px-lg" : "px-xl",
        )}
      >
        <div className="flex items-center gap-sm max-768:flex-wrap">
          <span className="font-mono text-[0.8rem] font-semibold text-text-secondary">
            {detail.projectName}
            <span className="text-cyan">#{detail.number}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
              statusVisual.text,
            )}
          >
            <span
              aria-hidden="true"
              className={cn("h-[6px] w-[6px] rounded-full", statusVisual.dot)}
            />
            {statusVisual.label}
          </span>
          <Badge tier="type" kind={detail.workType}>
            {TICKET_WORK_TYPE_LABELS[detail.workType]}
          </Badge>
          <div className="ml-auto flex items-center gap-sm max-768:grid max-768:w-full max-768:grid-cols-2">
            <CopyTicketReferenceButton
              projectName={detail.projectName}
              ticketNumber={detail.number}
              title={detail.title}
            />
            {/* Busy, not disabled: disabling would blur the button during the
                pre-dialog liveness check, so the dialog that follows could
                never capture it as its focus-return target. */}
            <Button
              variant="primary"
              size="sm"
              touch
              aria-busy={startResolving || undefined}
              layoutClassName="max-768:flex-1"
              data-start-conflict={
                cachedConflictSessionName !== null || undefined
              }
              onClick={requestStart}
            >
              {startResolving ? (
                <Spinner size="sm" tone="inherit" />
              ) : (
                <PlayIcon />
              )}
              Start work
            </Button>
            <TicketBundleControl
              projectName={detail.projectName}
              number={detail.number}
            />
            <IconButton
              variant="square"
              tone="danger"
              aria-label="Delete ticket"
              layoutClassName="max-768:justify-self-end"
              onClick={() => setDeleteOpen(true)}
            >
              <TrashIcon />
            </IconButton>
          </div>
        </div>
        <TicketTitleEditor
          projectName={detail.projectName}
          number={detail.number}
          title={detail.title}
        />
      </div>

      {/* Body: main + 340px rail on the page; single stacked column in the pane */}
      <div
        className={cn(
          "items-start pt-lg pb-2xl max-768:grid-cols-[minmax(0,1fr)] max-768:px-md",
          layout === "pane"
            ? "grid grid-cols-[minmax(0,1fr)] gap-lg px-lg"
            : "grid grid-cols-[minmax(0,1fr)_340px] gap-xl px-xl",
        )}
      >
        <div className="flex min-w-0 flex-col gap-xl">
          <TicketDescriptionEditor
            projectName={detail.projectName}
            number={detail.number}
            description={detail.description}
            attachments={detail.attachments}
          />

          <TicketStatusUpdates
            projectName={detail.projectName}
            number={detail.number}
          />

          <TicketRelationships
            projectName={detail.projectName}
            number={detail.number}
            relationships={detail.relationships}
          />

          <AttachmentIndex
            projectName={detail.projectName}
            number={detail.number}
            attachments={detail.attachments}
          />
        </div>

        <div className="flex flex-col gap-lg">
          <FieldsCard detail={detail} onChangeField={changeField} />
          <SessionsCard
            sessions={detail.sessions}
            projectName={detail.projectName}
            ticketId={detail.id}
            sessionLinks={
              sessionLinksQuery.isError ? undefined : sessionLinksQuery.data
            }
            sessionLinksError={sessionLinksQuery.isError}
            sessionLinksFetching={sessionLinksQuery.isFetching}
            onRetrySessionLinks={() => void sessionLinksQuery.refetch()}
          />
          <TicketSpecsCard detail={detail} />
        </div>
      </div>

      <StartTicketDialog
        projectName={detail.projectName}
        number={detail.number}
        open={startOpen}
        onOpenChange={setStartOpen}
        defaultBackend={defaultAgentBackend}
        backendDefaults={backendDefaults}
      />
      {conflictSessionName !== null && (
        <StartTicketConflictAlert
          sessionName={conflictSessionName}
          open={conflictOpen}
          onOpenChange={setConflictOpen}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete ticket?"
        message={`This permanently deletes ${identifier}, its ${detail.attachments.length} context attachment${detail.attachments.length === 1 ? "" : "s"}, ${detail.relationships.length} relationship${detail.relationships.length === 1 ? "" : "s"}, and ${detail.statusUpdates.total} status update${detail.statusUpdates.total === 1 ? "" : "s"}. Any children become top-level. Linked tickets are not deleted. Number ${detail.number} is never reused. Linked sessions and their worktrees are not touched.`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}

function FieldsCard({
  detail,
  onChangeField,
}: {
  detail: TicketDetail;
  onChangeField: (
    fields: { status: TicketStatus } | { workType: TicketWorkType },
  ) => void;
}): React.JSX.Element {
  return (
    <section aria-label="Fields" className={RAIL_CARD_CLASS}>
      <span className={RAIL_HEADING_CLASS}>Fields</span>
      <div className="grid grid-cols-[72px_1fr] items-center gap-x-sm gap-y-[8px]">
        <span className="font-mono text-[0.7rem] font-medium text-text-tertiary">
          status
        </span>
        <Select
          value={detail.status}
          onValueChange={(value) =>
            onChangeField({ status: value as TicketStatus })
          }
        >
          <SelectTrigger aria-label="Status" layoutClassName="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TICKET_STATUS_ORDER.map((status) => (
              <SelectItem key={status} value={status}>
                {TICKET_STATUS_VISUALS[status].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="font-mono text-[0.7rem] font-medium text-text-tertiary">
          type
        </span>
        <Select
          value={detail.workType}
          onValueChange={(value) =>
            onChangeField({ workType: value as TicketWorkType })
          }
        >
          <SelectTrigger aria-label="Work type" layoutClassName="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TICKET_WORK_TYPE_ORDER.map((workType) => (
              <SelectItem key={workType} value={workType}>
                {capitalize(TICKET_WORK_TYPE_LABELS[workType])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="font-mono text-[0.7rem] font-medium text-text-tertiary">
          project
        </span>
        <span className="font-mono text-[0.76rem] font-medium text-text-primary">
          {detail.projectName}
        </span>
        <span className="font-mono text-[0.7rem] font-medium text-text-tertiary">
          created
        </span>
        <span className="font-mono text-[0.72rem] text-text-secondary">
          {formatRelativeTime(detail.createdAt)}
        </span>
        <span className="font-mono text-[0.7rem] font-medium text-text-tertiary">
          updated
        </span>
        <span className="font-mono text-[0.72rem] text-text-secondary">
          {formatRelativeTime(detail.updatedAt)}
        </span>
      </div>
      <span className="border-x-0 border-t border-b-0 border-solid border-border-subtle pt-[8px] font-mono text-[0.66rem] text-text-tertiary">
        All status transitions allowed. Only “Start work” changes status
        automatically (→ In Progress).
      </span>
    </section>
  );
}

function SessionsCard({
  sessions,
  projectName,
  ticketId,
  sessionLinks,
  sessionLinksError,
  sessionLinksFetching,
  onRetrySessionLinks,
}: {
  sessions: readonly TicketSessionLink[];
  projectName: string;
  ticketId: string;
  sessionLinks: Record<string, TicketLinkSummary> | undefined;
  sessionLinksError: boolean;
  sessionLinksFetching: boolean;
  onRetrySessionLinks: () => void;
}): React.JSX.Element {
  const active =
    sessionLinks === undefined
      ? []
      : sessions.filter((link) => {
          const current = sessionLinks[link.sessionName];
          return (
            current?.ticketId === ticketId &&
            current.linkedAt === link.linkedAt &&
            current.active
          );
        });
  const activeLinkIds = new Set(active.map((link) => link.id));
  const unverified = sessions.filter(
    (link) => !activeLinkIds.has(link.id) && link.endedAt === null,
  );
  const unverifiedLinkIds = new Set(unverified.map((link) => link.id));
  const ended = [...sessions]
    .filter(
      (link) => !activeLinkIds.has(link.id) && !unverifiedLinkIds.has(link.id),
    )
    .sort((a, b) => b.linkedAt.localeCompare(a.linkedAt));

  return (
    <section aria-label="Sessions" className={RAIL_CARD_CLASS}>
      <div className="flex items-center gap-[6px]">
        <span className={RAIL_HEADING_CLASS}>Sessions</span>
        <span className={COUNT_PILL_CLASS}>{sessions.length}</span>
      </div>
      {sessionLinksError && (
        <div
          role="alert"
          className="flex items-center gap-sm rounded-md border border-solid border-amber-dim bg-amber-glow px-sm py-xs font-mono text-[0.68rem] text-amber"
        >
          <span>Session status unavailable</span>
          <Button
            variant="ghost"
            size="sm"
            layoutClassName="ml-auto shrink-0"
            disabled={sessionLinksFetching}
            onClick={onRetrySessionLinks}
          >
            {sessionLinksFetching ? "Retrying…" : "Retry sessions"}
          </Button>
        </div>
      )}
      {active.map((link) => (
        <div
          key={link.id}
          className="flex flex-col gap-[7px] rounded-md border border-solid border-cyan-dim bg-[var(--cc-cyan-a04)] p-[10px]"
        >
          <div className="flex items-center gap-[7px]">
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 [animation:pulse-dot_2s_ease_infinite] rounded-full bg-green shadow-[0_0_6px_var(--color-green-glow)] motion-reduce:[animation:none]"
            />
            <SessionHistoryName
              link={link}
              projectName={projectName}
              ticketId={ticketId}
              sessionLinks={sessionLinks}
              active
            />
            <span className="ml-auto font-mono text-[0.62rem] font-semibold tracking-[0.07em] text-cyan uppercase">
              active
            </span>
          </div>
          <span className="font-mono text-[0.68rem] text-text-tertiary">
            {startModeLabel(link.startMode)} · linked{" "}
            {formatRelativeTime(link.linkedAt)}
          </span>
        </div>
      ))}
      {unverified.map((link) => (
        <div
          key={link.id}
          className="flex flex-col gap-[5px] rounded-md border border-solid border-border-subtle p-[9px_10px]"
        >
          <div className="flex items-center gap-[7px]">
            <span
              aria-hidden="true"
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-amber-dim"
            />
            <SessionHistoryName
              link={link}
              projectName={projectName}
              ticketId={ticketId}
              sessionLinks={sessionLinks}
            />
            <span className="ml-auto font-mono text-[0.62rem] font-medium tracking-[0.05em] text-amber uppercase">
              status unknown
            </span>
          </div>
          <span className="font-mono text-[0.66rem] text-text-tertiary">
            {startModeLabel(link.startMode)} · linked{" "}
            {formatRelativeTime(link.linkedAt)}
          </span>
        </div>
      ))}
      {ended.map((link) => (
        <div
          key={link.id}
          className="flex flex-col gap-[5px] rounded-md border border-solid border-border-subtle p-[9px_10px]"
        >
          <div className="flex items-center gap-[7px]">
            <span
              aria-hidden="true"
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-text-tertiary"
            />
            <SessionHistoryName
              link={link}
              projectName={projectName}
              ticketId={ticketId}
              sessionLinks={sessionLinks}
            />
            <span className="ml-auto font-mono text-[0.62rem] font-medium tracking-[0.05em] text-text-tertiary uppercase">
              {link.endReason ?? "ended"}
            </span>
          </div>
          <span className="font-mono text-[0.66rem] text-text-tertiary">
            {startModeLabel(link.startMode)} · linked{" "}
            {formatRelativeTime(link.linkedAt)}
            {link.endedAt !== null &&
              ` · ended ${formatRelativeTime(link.endedAt)}`}
          </span>
        </div>
      ))}
      {sessions.length === 0 && (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          No sessions yet — Start work provisions one with the ticket&apos;s
          context materialized.
        </span>
      )}
      <span className="font-mono text-[0.66rem] text-text-tertiary">
        One active session at a time; history is kept.
      </span>
    </section>
  );
}

function SessionHistoryName({
  link,
  projectName,
  ticketId,
  sessionLinks,
  active = false,
}: {
  link: TicketSessionLink;
  projectName: string;
  ticketId: string;
  sessionLinks: Record<string, TicketLinkSummary> | undefined;
  active?: boolean;
}): React.JSX.Element {
  const current = sessionLinks?.[link.sessionName];
  const addressable =
    current?.ticketId === ticketId && current.linkedAt === link.linkedAt;
  const className = active
    ? "overflow-hidden font-mono text-[0.78rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary!"
    : "overflow-hidden font-mono text-[0.74rem] font-medium text-ellipsis whitespace-nowrap text-text-secondary!";

  if (!addressable) {
    return <span className={className}>{link.sessionName}</span>;
  }

  return (
    <Link
      href={sessionHref(projectName, link.sessionName)}
      className={`${className} no-underline hover:text-cyan!`}
    >
      {link.sessionName}
    </Link>
  );
}

function sessionHref(projectName: string, sessionName: string): string {
  return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
}

function startModeLabel(mode: TicketSessionLink["startMode"]): string {
  return mode === "agent" ? "agent mode" : "prepared";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M4 2.5 L13 8 L4 13.5 Z" />
    </svg>
  );
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 4.5 H13 M6.5 4.5 V3 A1 1 0 0 1 7.5 2 H8.5 A1 1 0 0 1 9.5 3 V4.5 M4.5 4.5 L5.2 13 A1.2 1.2 0 0 0 6.4 14 H9.6 A1.2 1.2 0 0 0 10.8 13 L11.5 4.5 M6.7 7 V11.5 M9.3 7 V11.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
