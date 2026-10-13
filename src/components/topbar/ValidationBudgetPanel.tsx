"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import type {
  ValidationBudgetRow,
  ValidationBudgetView,
} from "@/lib/validation/budget-view";
import { ValidationBudgetGauge } from "./ValidationBudgetGauge";

/**
 * The budget detail body, shared verbatim by the desktop popover and the
 * mobile sheet. It answers one question — what is holding the budget — in
 * three passes: the totals, the allocation across running commands, and the
 * runs themselves with the queue behind them.
 */

const SECTION_LABEL =
  "font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase";

function ArrowIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-cyan-dim"
    >
      <path
        d="M3 8h10m-3.5-3.5L13 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A run row is a link only when the run knows where it lives; system-owned
 * runs can name no conversation or session, so they render as plain rows
 * rather than as links to nowhere.
 */
function RunRowShell({
  href,
  className,
  children,
}: {
  href: string | null;
  className: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (href === null) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

function RunOwner({ row }: { row: ValidationBudgetRow }): React.JSX.Element {
  return (
    <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-md gap-y-xs font-mono text-[0.7rem] leading-normal">
      {row.sessionName !== null && (
        <>
          <span className="text-text-tertiary">Session</span>
          <span className="[overflow-wrap:anywhere] text-text-secondary">
            {row.sessionName}
          </span>
        </>
      )}
      {row.conversationName !== null && (
        <>
          <span className="text-text-tertiary">Conversation</span>
          <span className="[overflow-wrap:anywhere] text-text-secondary">
            {row.conversationName}
          </span>
        </>
      )}
    </span>
  );
}

function elapsedTime(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return minutes > 0
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

function RunningRow({
  row,
  now,
}: {
  row: ValidationBudgetRow;
  now: number;
}): React.JSX.Element {
  return (
    <RunRowShell
      href={row.href}
      className="group flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md text-text-primary! no-underline transition-colors duration-150 hover:border-border-default hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
    >
      <span className="flex items-center gap-sm">
        <span className="min-w-0 flex-1 font-mono text-[0.82rem] font-bold [overflow-wrap:anywhere] text-text-primary">
          {row.commandName}
        </span>
        <span
          className="shrink-0 font-mono text-[0.78rem] font-semibold text-cyan tabular-nums"
          title="Elapsed running time"
        >
          {row.startedAt === null ? "—" : elapsedTime(row.startedAt, now)}
        </span>
        <Badge tier="count">{row.cost}u</Badge>
        {row.href !== null && <ArrowIcon />}
      </span>
      <RunOwner row={row} />
      <span className="flex flex-wrap items-baseline justify-between gap-x-md gap-y-xs font-mono text-[0.7rem] text-text-tertiary group-hover:text-text-secondary group-focus-visible:text-text-secondary">
        <span className="[overflow-wrap:anywhere]">{row.projectName}</span>
        <span>
          Started{" "}
          {row.startedAt === null ? (
            "—"
          ) : (
            <time
              dateTime={row.startedAt}
              title={new Date(row.startedAt).toLocaleString()}
            >
              {new Date(row.startedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          )}
        </span>
      </span>
    </RunRowShell>
  );
}

function QueuedRow({ row }: { row: ValidationBudgetRow }): React.JSX.Element {
  // Only the head of the queue is next to run; the rest are just waiting, so
  // only the head carries the awaiting tone.
  const isNext = row.queuePosition === 1;
  return (
    <RunRowShell
      href={row.href}
      className="group flex items-start gap-sm rounded-md p-sm text-text-primary! no-underline transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
    >
      <StatusChip
        tone={isNext ? "amber" : "neutral"}
        layoutClassName="shrink-0"
      >
        {row.queuePosition}
      </StatusChip>
      <span className="flex min-w-0 flex-1 flex-col gap-xs">
        <span className="flex flex-wrap items-baseline gap-x-sm font-mono text-[0.78rem]">
          <span className="font-semibold [overflow-wrap:anywhere] text-text-primary">
            {row.commandName}
          </span>
          <span className="text-[0.7rem] [overflow-wrap:anywhere] text-text-tertiary group-hover:text-text-secondary">
            {row.projectName}
          </span>
        </span>
        <RunOwner row={row} />
      </span>
      <Badge tier="count">{row.cost}u</Badge>
      {row.href !== null && <ArrowIcon />}
    </RunRowShell>
  );
}

export function ValidationBudgetPanel({
  view,
}: {
  view: ValidationBudgetView;
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = view.running.length > 0;
  useEffect(() => {
    if (!hasRunning) return;
    // The server's start timestamp is fixed; ticking needs no network request.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  return (
    <>
      <div className="flex items-center gap-lg border-x-0 border-t-0 border-b border-solid border-b-border-subtle p-lg pb-[14px]">
        <ValidationBudgetGauge
          fraction={view.fraction}
          tone={view.tone}
          size="large"
          pixelSize={52}
        />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-mono text-[1.1rem] font-bold text-text-primary">
            {view.headline}
          </span>
          {/* 0.72rem, not the prototype's 0.8rem: CC's chrome font is Geist
              Mono (Manrope is reserved for message prose), and mono's wider
              advance wraps the longest detail string at 0.8rem. */}
          <span className="font-mono text-[0.72rem] font-normal text-text-secondary">
            {view.detail}
          </span>
        </div>
      </div>

      <div className="border-x-0 border-t-0 border-b border-solid border-b-border-subtle px-lg py-[14px]">
        {/* The bar carries its meaning visually, so the caption doubles as its
            accessible name rather than leaving a stack of unlabelled boxes. */}
        <div
          role="img"
          aria-label={view.allocationCaption}
          className="mb-[6px] flex gap-xs"
        >
          {view.allocation.map((segment, index) => (
            <span
              key={segment.runId ?? `free-${index}`}
              // The ratio is the datum — a data-driven flex-grow cannot be a
              // static utility, so it is the one inline style here.
              style={{ flexGrow: segment.units }}
              className={cn(
                "box-border flex h-[26px] shrink basis-0 items-center justify-center overflow-hidden rounded-sm border border-solid",
                segment.kind === "run"
                  ? "border-cyan-glow-strong bg-cyan-glow font-mono text-[0.66rem] font-semibold text-cyan"
                  : "border-dashed border-border-default bg-border-dim",
              )}
            >
              {segment.label}
            </span>
          ))}
        </div>
        <div className="font-mono text-[0.66rem] font-normal text-text-tertiary">
          {view.allocationCaption}
        </div>
      </div>

      {view.running.length > 0 && (
        <>
          <div
            className={cn(
              SECTION_LABEL,
              "px-lg pt-md pb-[6px] text-text-secondary",
            )}
          >
            Running now
          </div>
          <div className="flex flex-col gap-sm px-md pb-md">
            {view.running.map((row) => (
              <RunningRow key={row.runId} row={row} now={now} />
            ))}
          </div>
        </>
      )}

      {view.queued.length > 0 && (
        <>
          <div className="flex items-baseline gap-sm border-x-0 border-t border-b-0 border-solid border-t-border-subtle px-lg pt-[10px] pb-[6px]">
            <span className={cn(SECTION_LABEL, "text-amber")}>Next up</span>
            <span className="font-mono text-[0.7rem] font-normal text-text-tertiary">
              {view.queueDepth} queued
            </span>
          </div>
          <div className="flex flex-col gap-xs px-sm pb-md">
            {view.queued.map((row) => (
              <QueuedRow key={row.runId} row={row} />
            ))}
            {view.queuedOverflow > 0 && (
              <span className="pt-[6px] font-mono text-[0.7rem] font-normal text-text-tertiary">
                +{view.queuedOverflow} more queued
              </span>
            )}
          </div>
        </>
      )}
    </>
  );
}
