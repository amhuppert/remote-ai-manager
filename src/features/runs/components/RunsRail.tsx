"use client";

import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
} from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { StatusDot } from "@/components/ui/StatusDot";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { PauseIcon } from "../icons";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import type { RunSummary } from "../model";
import { formatUsd, runStatus } from "../present";

function RailItem({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect(runId: string): void;
}) {
  const status = runStatus(run.status);
  const active = run.finishedAt === null;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        data-selected={selected}
        onClick={() => onSelect(run.runId)}
        className={cn(
          "group relative flex w-full cursor-pointer flex-col gap-[6px] rounded-md border border-solid border-transparent bg-transparent px-md py-[10px] text-left transition-colors duration-150",
          "hover:border-border-subtle hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
          "data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised",
        )}
      >
        <span
          aria-hidden="true"
          className="absolute top-[10px] bottom-[10px] left-0 w-[2px] rounded-full bg-transparent group-data-[selected=true]:bg-cyan"
        />
        <span className="flex min-w-0 items-start gap-sm">
          <span
            className={cn(
              "min-w-0 flex-1 font-mono text-[0.78rem] leading-[1.35] font-medium",
              active ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {run.title}
          </span>
          <span className="shrink-0 pt-[2px] font-mono text-[0.7rem] text-text-tertiary">
            {formatLocalTime(run.finishedAt ?? run.startedAt)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
          <span className="min-w-0 truncate">
            {run.kind === "workflow"
              ? `${run.contexts.done}/${run.contexts.total} · `
              : ""}
            {formatUsd(run.costUsd)}
          </span>
          {run.attention > 0 ? (
            <span
              className="ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-amber px-[5px] font-mono text-[0.7rem] font-semibold text-text-inverse"
              aria-label={`${run.attention} need you`}
            >
              {run.attention}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Group({
  label,
  runs,
  selectedId,
  onSelect,
}: {
  label: string;
  runs: RunSummary[];
  selectedId: string;
  onSelect(runId: string): void;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="flex flex-col gap-[4px]">
      <h2 className="m-0 px-md font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
        {label} <span className="font-normal">{runs.length}</span>
      </h2>
      <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
        {runs.map((run) => (
          <RailItem
            key={run.runId}
            run={run}
            selected={run.runId === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

function RunMark({ run }: { run: RunSummary }) {
  switch (run.status.kind) {
    case "running":
    case "stopping":
      return <StatusDot tone="cyan" />;
    case "needs_input":
      return <StatusDot tone="amber" />;
    case "paused":
      return (
        <span className="text-text-secondary">
          <PauseIcon size={13} />
        </span>
      );
    case "succeeded":
      return (
        <span className="text-green">
          <CheckIcon size={13} />
        </span>
      );
    case "cancelled":
      return (
        <span className="text-text-tertiary">
          <CloseIcon size={12} />
        </span>
      );
  }
}

/** The rail folded to a strip: one mark per run, its title on hover and focus. */
function CollapsedRail({
  runs,
  selectedId,
  onSelect,
  onToggle,
}: {
  runs: RunSummary[];
  selectedId: string;
  onSelect(runId: string): void;
  onToggle(): void;
}) {
  return (
    <nav aria-label="Runs" className="flex flex-col items-center gap-md">
      <WithTooltip label="Show runs" side="right">
        <IconButton variant="ghost" aria-label="Show runs" onClick={onToggle}>
          <ChevronRightIcon />
        </IconButton>
      </WithTooltip>
      <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
        {runs.map((run) => (
          <li key={run.runId}>
            <WithTooltip
              label={`${run.title} · ${runStatus(run.status).label}`}
              side="right"
            >
              <button
                type="button"
                aria-label={run.title}
                aria-current={run.runId === selectedId ? "page" : undefined}
                data-selected={run.runId === selectedId}
                onClick={() => onSelect(run.runId)}
                className="relative flex size-[36px] cursor-pointer items-center justify-center rounded-md border border-solid border-transparent bg-transparent transition-colors duration-150 hover:border-border-subtle hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised"
              >
                <RunMark run={run} />
                {run.attention > 0 ? (
                  <span className="absolute -top-[3px] -right-[3px] inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-amber px-[3px] font-mono text-[0.7rem] leading-none font-semibold text-text-inverse">
                    {run.attention}
                  </span>
                ) : null}
              </button>
            </WithTooltip>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The session's runs: current first, then history. */
export function RunsRail({
  runs,
  selectedId,
  onSelect,
  collapsed = false,
  onToggle,
}: {
  runs: RunSummary[];
  selectedId: string;
  onSelect(runId: string): void;
  collapsed?: boolean;
  onToggle?(): void;
}) {
  if (collapsed && onToggle !== undefined)
    return (
      <CollapsedRail
        runs={runs}
        selectedId={selectedId}
        onSelect={onSelect}
        onToggle={onToggle}
      />
    );
  return (
    <nav aria-label="Runs" className="flex flex-col gap-xl">
      <div className="flex items-center gap-sm px-md">
        <span className="font-display text-[1.05rem] font-bold text-text-primary">
          Runs
        </span>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          this session
        </span>
        {onToggle !== undefined ? (
          <WithTooltip label="Fold the rail">
            <IconButton
              variant="ghost"
              aria-label="Fold the rail"
              onClick={onToggle}
              layoutClassName="ml-auto"
            >
              <ChevronLeftIcon />
            </IconButton>
          </WithTooltip>
        ) : null}
      </div>
      <Group
        label="Current"
        runs={runs.filter((run) => run.finishedAt === null)}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <Group
        label="History"
        runs={runs.filter((run) => run.finishedAt !== null)}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </nav>
  );
}
