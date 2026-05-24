"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  useTddToggleMutation,
  useArchiveSessionMutation,
} from "@/lib/sessions/mutations";
import { useConfirmDeleteSession } from "@/stores/sessions.store";
import TddToggle from "@/components/TddToggle";
import BranchChip from "./BranchChip";
import ModeDot from "./ModeDot";
import StatusPill from "./StatusPill";
import KebabMenu from "./KebabMenu";
import CCCheckbox from "./CCCheckbox";
import { buildRowActions } from "./build-row-actions";

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
  return (
    <TddToggle
      enabled={session.tddEnabled}
      onChange={(val) => tddMutation.mutate(val)}
      disabled={tddMutation.isPending}
      compact
    />
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

  const status = session.finished ? "merged" : session.derivedStatus;
  const modeKey = session.finished ? "merged" : session.creationMode;

  const handlers = useMemo(
    () => ({
      onBranch: (s: SessionListItem) => onBranch?.(s.sessionName),
      onMerge: () => {
        // Wired in a follow-up once the merge mutation lives in this UI.
      },
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

  const cls = ["v3-row"];
  if (session.archived) cls.push("archived");
  if (selected) cls.push("selected");

  return (
    <div className={cls.join(" ")} data-status={status}>
      <span className="rail" />
      <span className="v3-check">
        <CCCheckbox
          checked={selected}
          onChange={(next) => onToggleSelect(session.sessionName, next)}
          ariaLabel={`Select ${session.sessionName}`}
        />
      </span>
      <ModeDot mode={modeKey} />
      <div className="v3-name">
        <div className="top">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`}
            className="title"
          >
            {session.sessionName}
          </Link>
        </div>
      </div>
      <div className="v3-branch">
        <BranchChip branch={session.branchName} />
      </div>
      <div
        className={
          "v3-target" + (session.targetBranch !== "main" ? " non-default" : "")
        }
        title={session.targetBranch}
      >
        {session.targetBranch}
      </div>
      <StatusPill status={status} />
      <span
        className={"v3-prompts" + (session.promptCount === 0 ? " zero" : "")}
      >
        {session.promptCount}
      </span>
      <span className="v3-time">
        {formatRelativeTime(session.lastActivityAt)}
      </span>
      <div
        style={{
          display: "flex",
          gap: "var(--space-xs)",
          alignItems: "center",
        }}
      >
        <SessionTddToggle projectName={projectName} session={session} />
        <KebabMenu items={rowActions} />
      </div>
    </div>
  );
}
