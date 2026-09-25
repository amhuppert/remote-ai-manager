"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import {
  SectionCount,
  SectionHeader,
  SectionLabel,
} from "@/components/ui/SectionHeader";
import { ArrowUpRightIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { devServerInstanceId } from "@/lib/dev-server/mutations";
import type {
  DevServerInstance,
  DevServerOverviewProject,
  DevServerStatus,
  StopDevServerInstanceRequest,
} from "@/lib/dev-server/schemas";

/** Something the operator must see about one project's last start attempt. */
export type DevServerProjectNotice =
  | {
      kind: "conflict";
      serverName: string;
      port: number;
      pid: number;
      cwd: string;
    }
  | { kind: "error"; title: string; message: string };

export interface DevServerOverviewProps {
  projects: ReadonlyArray<DevServerOverviewProject>;
  pendingStopIds: ReadonlySet<string>;
  notices: Readonly<Record<string, DevServerProjectNotice>>;
  isStoppingUnmanaged: boolean;
  onStart(ref: { projectName: string; serverName: string }): void;
  onStop(ref: StopDevServerInstanceRequest): void;
  onDismissNotice(projectName: string): void;
  onStopUnmanagedAndRetry(projectName: string): void;
  /** Injectable clock for deterministic stories and tests. */
  now?: number;
}

const STATUS: Record<DevServerStatus, { label: string; tone: StatusChipTone }> =
  {
    running: { label: "Running", tone: "green" },
    starting: { label: "Starting", tone: "amber" },
    stopped: { label: "Stopped", tone: "neutral" },
    error: { label: "Error", tone: "red" },
  };

function isActive(status: DevServerStatus): boolean {
  return status === "running" || status === "starting";
}

// Live servers lead each project, failed starts follow, and idle project-root
// launchers settle at the bottom; the sort is stable within a rank.
const STATUS_RANK: Record<DevServerStatus, number> = {
  running: 0,
  starting: 0,
  error: 1,
  stopped: 2,
};

function countByStatus(
  projects: ReadonlyArray<DevServerOverviewProject>,
  status: DevServerStatus,
): number {
  return projects.reduce(
    (sum, project) =>
      sum + project.servers.filter((server) => server.status === status).length,
    0,
  );
}

function stopRef(
  projectName: string,
  server: DevServerInstance,
): StopDevServerInstanceRequest {
  return {
    projectName,
    sessionName:
      server.owner.kind === "project" ? null : server.owner.sessionName,
    worktreePath: server.worktreePath,
    serverName: server.serverName,
  };
}

function ownerPhrase(owner: DevServerInstance["owner"]): string {
  if (owner.kind === "project") return "in the project root";
  if (owner.kind === "session") return `in session ${owner.sessionName}`;
  return `in lane ${owner.worktreeName}`;
}

function sessionHref(projectName: string, sessionName: string): string {
  return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
}

const TAG =
  "shrink-0 font-mono text-[0.7rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

const INLINE_LINK =
  "min-w-0 truncate font-mono text-[0.75rem] text-text-secondary no-underline hover:text-text-primary! hover:underline";

function OwnerCell({
  projectName,
  server,
}: {
  projectName: string;
  server: DevServerInstance;
}): React.JSX.Element {
  const { owner } = server;
  if (owner.kind === "project") {
    return (
      <span className="flex min-w-0 items-baseline gap-sm">
        <span className={TAG}>Project root</span>
      </span>
    );
  }
  const lane =
    owner.kind === "workflow-lane"
      ? owner.worktreeName.split(".").slice(1).join(".") || owner.worktreeName
      : null;
  return (
    <span className="flex min-w-0 items-baseline gap-sm">
      <span className={TAG}>{lane === null ? "Session" : "Lane"}</span>
      <Link
        href={sessionHref(projectName, owner.sessionName)}
        className={INLINE_LINK}
        title={server.worktreePath}
      >
        {owner.sessionName}
      </Link>
      {lane !== null && (
        <span
          className="min-w-0 truncate font-mono text-[0.75rem] text-text-tertiary"
          title={server.worktreePath}
        >
          &rsaquo; {lane}
        </span>
      )}
    </span>
  );
}

const ADDRESS_LINK =
  "inline-flex min-w-0 items-center gap-[4px] font-mono text-[0.75rem] no-underline [transition:color_0.15s_ease] hover:underline";

function AddressCell({
  server,
}: {
  server: DevServerInstance;
}): React.JSX.Element {
  if (server.status !== "running" || server.localUrl === null) {
    return (
      <span className="font-mono text-[0.75rem] text-text-tertiary">—</span>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-md gap-y-[2px]">
      <a
        href={server.localUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(ADDRESS_LINK, "text-cyan hover:text-cyan!")}
      >
        <span className="truncate">
          {server.localUrl.replace(/^https?:\/\//, "")}
        </span>
        <ArrowUpRightIcon size={11} className="shrink-0" />
      </a>
      {server.remoteUrl !== null && (
        <a
          href={server.remoteUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={server.remoteUrl}
          className={cn(
            ADDRESS_LINK,
            "text-text-secondary hover:text-text-primary!",
          )}
        >
          Remote
          <ArrowUpRightIcon size={11} className="shrink-0" />
        </a>
      )}
    </span>
  );
}

function ServerRow({
  projectName,
  server,
  isStopPending,
  now,
  onStart,
  onStop,
}: {
  projectName: string;
  server: DevServerInstance;
  isStopPending: boolean;
  now: number | undefined;
  onStart(): void;
  onStop(): void;
}): React.JSX.Element {
  const status = STATUS[server.status];
  const active = isActive(server.status);
  return (
    <li className="border-x-0 border-t border-b-0 border-solid border-border-dim first:border-t-0">
      <div
        className={cn(
          // Sized by the project card (the page shares its width with the
          // conversation rail), not the viewport: full row, then without the
          // start time, then stacked under the name.
          "grid items-center gap-x-md gap-y-xs px-lg py-[10px]",
          "grid-cols-[88px_minmax(96px,0.8fr)_minmax(180px,1.6fr)_minmax(160px,1.2fr)_minmax(96px,auto)_76px]",
          "@min-[600px]:@max-[900px]:grid-cols-[88px_minmax(88px,0.8fr)_minmax(130px,1.4fr)_minmax(130px,1.2fr)_72px]",
          "@max-[600px]:grid-cols-[auto_minmax(0,1fr)_auto] @max-[600px]:px-md",
        )}
      >
        <span className="flex">
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[0.8rem] font-semibold",
            active || server.status === "error"
              ? "text-text-primary"
              : "text-text-secondary",
          )}
        >
          {server.serverName}
        </span>
        <span className="min-w-0 @max-[600px]:order-2 @max-[600px]:col-span-3">
          <OwnerCell projectName={projectName} server={server} />
        </span>
        <span className="min-w-0 @max-[600px]:order-2 @max-[600px]:col-span-3">
          <AddressCell server={server} />
        </span>
        <span
          className="font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary @max-[900px]:hidden"
          title={
            active && server.startedAt !== null
              ? `Started ${formatRelativeTime(server.startedAt, now === undefined ? {} : { now })}`
              : undefined
          }
        >
          {active && server.startedAt !== null
            ? `since ${formatLocalTime(server.startedAt, now === undefined ? {} : { now })}`
            : ""}
        </span>
        <span className="flex justify-end @max-[600px]:order-1">
          {active ? (
            <Button
              size="sm"
              touch
              loading={isStopPending}
              onClick={onStop}
              aria-label={`Stop ${server.serverName} ${ownerPhrase(server.owner)}`}
            >
              Stop
            </Button>
          ) : server.owner.kind === "project" ? (
            <Button
              size="sm"
              touch
              onClick={onStart}
              aria-label={`Start ${server.serverName} ${ownerPhrase(server.owner)}`}
            >
              Start
            </Button>
          ) : null}
        </span>
      </div>
      {server.status === "error" && server.errorMessage !== null && (
        <pre className="mx-lg mt-0 mb-[10px] max-h-[96px] overflow-auto rounded-sm border border-solid border-[var(--cc-red-a25)] bg-bg-base px-sm py-xs font-mono text-[0.7rem] break-all whitespace-pre-wrap text-red max-768:mx-md">
          {server.errorMessage.slice(0, 800)}
        </pre>
      )}
    </li>
  );
}

function NoticeCard({
  notice,
  isStoppingUnmanaged,
  onDismiss,
  onStopUnmanagedAndRetry,
}: {
  notice: DevServerProjectNotice;
  isStoppingUnmanaged: boolean;
  onDismiss(): void;
  onStopUnmanagedAndRetry(): void;
}): React.JSX.Element {
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="mx-lg my-sm flex items-start gap-md rounded-md border border-solid border-[var(--cc-red-a25)] bg-red-glow px-md py-sm max-768:mx-md"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-xs">
          <span className="font-mono text-[0.78rem] font-semibold text-red">
            {notice.title}
          </span>
          <span className="font-mono text-[0.72rem] break-words text-text-secondary">
            {notice.message}
          </span>
        </div>
        <Button size="sm" touch onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }
  return (
    <div
      role="alert"
      aria-label="Unmanaged dev server detected"
      className="mx-lg my-sm flex flex-col gap-xs rounded-md border border-solid border-[var(--cc-amber-a25)] bg-[var(--cc-amber-tint-a05)] px-md py-sm max-768:mx-md"
    >
      <span className="font-mono text-[0.78rem] font-semibold text-amber">
        Port {notice.port} is in use by process {notice.pid}
      </span>
      <span className="font-mono text-[0.72rem] leading-[1.5] text-text-secondary">
        It runs from this project&apos;s checkout, but Command Center did not
        start it. Stop it to start {notice.serverName}.
      </span>
      <code className="font-mono text-[0.7rem] break-all text-text-tertiary">
        {notice.cwd}
      </code>
      <div className="mt-xs flex justify-end gap-xs">
        <Button
          size="sm"
          touch
          onClick={onDismiss}
          disabled={isStoppingUnmanaged}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          touch
          onClick={onStopUnmanagedAndRetry}
          loading={isStoppingUnmanaged}
        >
          Stop process and start
        </Button>
      </div>
    </div>
  );
}

function ProjectGroup({
  project,
  props,
}: {
  project: DevServerOverviewProject;
  props: DevServerOverviewProps;
}): React.JSX.Element {
  const running = project.servers.filter((s) => s.status === "running").length;
  const notice = props.notices[project.projectName];
  const headingId = `dev-servers-${project.projectName}`;
  return (
    <section
      aria-labelledby={headingId}
      className="@container overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <header className="flex min-h-[44px] items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-lg py-sm max-768:px-md">
        <h2 id={headingId} className="m-0 flex min-w-0 items-baseline gap-sm">
          <Link
            href={`/projects/${encodeURIComponent(project.projectName)}`}
            className="shrink-0 font-mono text-[0.85rem] font-semibold text-text-primary! no-underline hover:text-cyan!"
          >
            {project.projectName}
          </Link>
          <span className="min-w-0 truncate font-mono text-[0.72rem] font-normal text-text-tertiary max-768:hidden">
            {project.projectPath}
          </span>
        </h2>
        <span className="ml-auto flex shrink-0 items-baseline gap-[6px] font-mono">
          <span
            className={cn(
              "text-[0.8rem] font-semibold tabular-nums",
              running > 0 ? "text-green" : "text-text-tertiary",
            )}
          >
            {running}
          </span>
          <span className="text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
            Running
          </span>
        </span>
      </header>
      {notice !== undefined && (
        <NoticeCard
          notice={notice}
          isStoppingUnmanaged={props.isStoppingUnmanaged}
          onDismiss={() => props.onDismissNotice(project.projectName)}
          onStopUnmanagedAndRetry={() =>
            props.onStopUnmanagedAndRetry(project.projectName)
          }
        />
      )}
      {project.configError !== null && (
        <pre
          role="alert"
          className="mx-lg my-sm max-h-[120px] overflow-auto rounded-sm border border-solid border-[var(--cc-red-a25)] bg-bg-base px-sm py-xs font-mono text-[0.7rem] break-words whitespace-pre-wrap text-red max-768:mx-md"
        >
          {project.configError}
        </pre>
      )}
      {project.servers.length > 0 && (
        <ul className="m-0 list-none p-0">
          {[...project.servers]
            .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
            .map((server) => {
              const ref = stopRef(project.projectName, server);
              const id = devServerInstanceId(ref);
              return (
                <ServerRow
                  key={id}
                  projectName={project.projectName}
                  server={server}
                  isStopPending={props.pendingStopIds.has(id)}
                  now={props.now}
                  onStart={() =>
                    props.onStart({
                      projectName: project.projectName,
                      serverName: server.serverName,
                    })
                  }
                  onStop={() => props.onStop(ref)}
                />
              );
            })}
        </ul>
      )}
    </section>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: "green" | "amber";
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-[2px]">
      <dd
        className={cn(
          "m-0 font-mono text-[1.25rem] leading-none font-semibold tabular-nums",
          value === 0
            ? "text-text-tertiary"
            : tone === "green"
              ? "text-green"
              : "text-amber",
        )}
      >
        {value}
      </dd>
      <dt className="font-mono text-[0.7rem] tracking-[0.08em] text-text-tertiary uppercase">
        {label}
      </dt>
    </div>
  );
}

export function DevServerOverviewHeader({
  projects,
}: {
  projects: ReadonlyArray<DevServerOverviewProject>;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-lg">
      <div className="flex min-w-0 flex-col gap-xs">
        <h1 className="m-0 font-display text-[1.5rem] font-extrabold tracking-[-0.03em] text-text-primary">
          Dev servers
        </h1>
        <p className="m-0 max-w-[62ch] font-mono text-[0.75rem] leading-[1.5] text-text-secondary">
          Every running dev server, by project. Project-root servers run in the
          project&apos;s own checkout, with no session.
        </p>
      </div>
      <dl className="m-0 flex flex-row-reverse gap-xl">
        <Stat
          value={countByStatus(projects, "starting")}
          label="Starting"
          tone="amber"
        />
        <Stat
          value={countByStatus(projects, "running")}
          label="Running"
          tone="green"
        />
      </dl>
    </div>
  );
}

export function DevServerOverview(
  props: DevServerOverviewProps,
): React.JSX.Element {
  const listed = props.projects.filter(
    (p) => p.servers.length > 0 || p.configError !== null,
  );
  const unconfigured = props.projects.filter(
    (p) => p.servers.length === 0 && p.configError === null,
  );
  return (
    <div className="flex flex-col gap-lg">
      {listed.map((project) => (
        <ProjectGroup
          key={project.projectName}
          project={project}
          props={props}
        />
      ))}
      {unconfigured.length > 0 && (
        <section aria-labelledby="dev-servers-unconfigured" className="mt-sm">
          <SectionHeader>
            <SectionLabel id="dev-servers-unconfigured">
              No dev servers configured
            </SectionLabel>
            <SectionCount>({unconfigured.length})</SectionCount>
          </SectionHeader>
          <p className="m-0 mb-sm font-mono text-[0.72rem] text-text-tertiary">
            Add a <code className="text-text-secondary">devServers</code> entry
            to a project&apos;s CommandCenter.json to run it from here.
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-x-md gap-y-xs p-0">
            {unconfigured.map((project) => (
              <li key={project.projectName}>
                <Link
                  href={`/projects/${encodeURIComponent(project.projectName)}`}
                  className="font-mono text-[0.72rem] text-text-tertiary! no-underline hover:text-text-primary! hover:underline"
                >
                  {project.projectName}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
