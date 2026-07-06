"use client";

import { useMemo } from "react";
import Link from "next/link";
import type {
  SessionListItem,
  DerivedSessionStatus,
} from "@/lib/sessions/schemas";
import {
  useTddToggleMutation,
  useArchiveSessionMutation,
} from "@/lib/sessions/mutations";
import { useConfirmDeleteSession } from "@/stores/sessions.store";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { cn } from "@/lib/ui/cn";
import TddToggle from "@/components/TddToggle";
import { ChatIcon } from "@/components/icons";
import BranchChip from "./BranchChip";
import ModeDot from "./ModeDot";
import StatusPill from "./StatusPill";
import KebabMenu from "./KebabMenu";
import CCCheckbox from "./CCCheckbox";
import { buildRowActions } from "./build-row-actions";

type RowStatus = DerivedSessionStatus | "merged" | "error";

// Shared row geometry: the 9-track desktop grid collapses on mobile into the
// two-line card defined by `grid-template-areas`. Imported by the header row in
// SessionRows so both stay in lockstep.
export const ROW_BASE =
  "relative grid items-center gap-sm py-[9px] pr-[12px] pl-0 " +
  "border-x-0 border-t-0 border-b border-solid border-border-subtle " +
  "transition-[background] duration-[120ms] ease-[ease] " +
  "grid-cols-[32px_28px_minmax(0,1.7fr)_minmax(0,1.3fr)_80px_96px_72px_120px_120px] " +
  "max-768:grid-cols-[16px_minmax(0,1fr)_auto_auto] " +
  "max-768:[grid-template-areas:'mode_name_name_actions'_'._branch_time_actions'] " +
  "max-768:gap-y-[2px] max-768:py-[10px] max-768:pr-[8px] max-768:pl-[14px]";

const railBase = "absolute left-0 top-0 bottom-0 w-[3px]";
const railColor: Record<RowStatus, string> = {
  new: "bg-cyan opacity-100 shadow-[0_0_8px_var(--color-cyan-glow),inset_0_0_6px_var(--color-cyan-glow)]",
  running: "bg-cyan opacity-100 shadow-[0_0_8px_var(--color-cyan-glow)]",
  awaiting: "bg-green opacity-100 shadow-[0_0_8px_var(--color-green-glow)]",
  waiting_for_input:
    "bg-amber opacity-100 shadow-[0_0_8px_var(--color-amber-glow)]",
  merged: "bg-green opacity-[0.55]",
  idle: "bg-text-tertiary opacity-[0.25]",
  error: "bg-red opacity-100 shadow-[0_0_8px_var(--color-red-glow)]",
};

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SessionTddToggle({
  projectName,
  session,
}: {
  projectName: string;
  session: SessionListItem;
}) {
  const tddMutation = useTddToggleMutation(projectName, session.sessionName);
  // The TDD toggle is hidden on the mobile row. The shared TddToggle expresses
  // this via a `.v3-row` ancestor hook we no longer expose, so the hide is owned
  // here by a layout-transparent wrapper (inline-flex keeps the desktop flex
  // placement identical; display:none takes over on mobile).
  return (
    <span className="inline-flex items-center max-768:hidden">
      <TddToggle
        enabled={session.tddEnabled}
        onChange={(val) => tddMutation.mutate(val)}
        disabled={tddMutation.isPending}
        compact
      />
    </span>
  );
}

export interface SessionRowProps {
  session: SessionListItem;
  projectName: string;
  selected: boolean;
  onToggleSelect: (sessionName: string, next: boolean) => void;
  onBranch?: (sessionName: string) => void;
}

export default function SessionRow({
  session,
  projectName,
  selected,
  onToggleSelect,
  onBranch,
}: SessionRowProps): React.JSX.Element {
  const archiveMutation = useArchiveSessionMutation(
    projectName,
    session.sessionName,
  );
  const confirmDelete = useConfirmDeleteSession();

  const status: RowStatus = session.finished ? "merged" : session.derivedStatus;
  const modeKey = session.finished ? "merged" : session.creationMode;

  const handlers = useMemo(
    () => ({
      onBranch: (s: SessionListItem) => onBranch?.(s.sessionName),
      onCopyBranch: (s: SessionListItem) => {
        void navigator.clipboard?.writeText(s.branchName);
      },
      onArchive: (s: SessionListItem) => {
        archiveMutation.mutate(!s.archived);
      },
      onDelete: (s: SessionListItem) =>
        confirmDelete({
          sessionName: s.sessionName,
          projectName,
        }),
    }),
    [archiveMutation, confirmDelete, onBranch, projectName],
  );

  const rowActions = useMemo(
    () => buildRowActions(session, handlers),
    [session, handlers],
  );

  return (
    <div
      className={cn(
        ROW_BASE,
        selected ? "bg-[var(--cc-cyan-a05)]" : "hover:bg-bg-base",
        // Dim every cell EXCEPT the actions cell. Putting opacity on the row (or
        // the actions cell) would wrap KebabMenu's open dropdown in an opacity
        // layer: that both makes the popup semi-transparent and traps its
        // z-index, so the next row paints over the part of the menu below it.
        session.archived &&
          "[&>*:not(.session-row-actions)]:opacity-50 hover:[&>*:not(.session-row-actions)]:opacity-[0.92]",
      )}
      data-testid="session-card"
      data-status={status}
    >
      <span className={cn(railBase, railColor[status])} />
      <span className="ml-[16px] max-768:hidden">
        <CCCheckbox
          checked={selected}
          onChange={(next) => onToggleSelect(session.sessionName, next)}
          ariaLabel={`Select ${session.sessionName}`}
        />
      </span>
      <ModeDot
        mode={modeKey}
        layoutClassName="max-768:self-center max-768:[grid-area:mode]"
      />
      <div className="flex min-w-0 flex-col gap-[3px] max-768:self-center max-768:[grid-area:name]">
        <div className="flex min-w-0 items-center gap-[8px]">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`}
            className="cursor-pointer truncate font-mono text-[0.85rem] font-semibold text-text-primary hover:text-cyan max-768:text-[0.86rem]"
          >
            {session.sessionName}
          </Link>
        </div>
      </div>
      <div className="flex min-w-0 max-768:items-center max-768:overflow-hidden max-768:[grid-area:branch]">
        <BranchChip branch={session.branchName} />
      </div>
      <div
        className={cn(
          "text-left font-mono text-[0.7rem] max-768:hidden",
          session.targetBranch !== "main" ? "text-cyan" : "text-text-tertiary",
        )}
        title={session.targetBranch}
      >
        {session.targetBranch}
      </div>
      <StatusPill status={status} layoutClassName="max-768:hidden" />
      <span
        className={cn(
          "text-right font-mono text-[0.76rem] tabular-nums max-768:hidden",
          session.promptCount === 0
            ? "text-text-tertiary"
            : "text-text-primary",
        )}
      >
        {session.promptCount}
      </span>
      <span className="text-right font-mono text-[0.72rem] text-text-secondary max-768:self-center max-768:justify-self-end max-768:pl-[8px] max-768:text-[0.68rem] max-768:[grid-area:time]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>
      <div className="session-row-actions flex items-center gap-xs max-768:self-center max-768:[grid-area:actions]">
        <Link
          href={conversationsPageHref({
            projectName,
            sessionName: session.sessionName,
          })}
          className="relative flex size-[30px] items-center justify-center rounded-sm border border-solid border-border-default bg-transparent p-0 text-[0.85rem] text-text-secondary transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary max-768:size-[44px] max-768:min-h-[44px] max-768:min-w-[44px] max-768:text-[1rem] [&>svg]:size-[18px]"
          aria-label="Open in Conversations"
          data-tooltip="Open in Conversations"
          onClick={(e) => e.stopPropagation()}
        >
          <ChatIcon size={14} />
        </Link>
        <SessionTddToggle projectName={projectName} session={session} />
        <KebabMenu items={rowActions} />
      </div>
    </div>
  );
}
