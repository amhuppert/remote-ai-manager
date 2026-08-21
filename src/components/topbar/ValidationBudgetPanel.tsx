"use client";

import Link from "next/link";
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

function RunningRow({ row }: { row: ValidationBudgetRow }): React.JSX.Element {
  return (
    <RunRowShell
      href={row.href}
      className="flex items-center gap-md rounded-md border border-solid border-border-dim px-[10px] py-[9px] text-text-primary! no-underline [transition:all_0.15s_ease] hover:border-border-default hover:bg-bg-hover max-768:min-h-[44px]"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate font-mono text-[0.82rem] font-bold text-text-primary">
          {row.commandName}
        </span>
        <span className="truncate font-mono text-[0.7rem] font-normal text-text-tertiary">
          {row.projectName}
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-cyan-glow px-sm py-[2px] font-mono text-[0.7rem] font-semibold text-cyan">
        {row.cost}u
      </span>
      {row.href !== null && <ArrowIcon />}
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
      className="flex items-center gap-[10px] py-[6px] text-text-primary! no-underline [transition:all_0.15s_ease] hover:opacity-80 max-768:min-h-[44px]"
    >
      <span
        className={cn(
          "inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-solid font-mono text-[0.62rem]",
          isNext
            ? "border-amber-glow text-amber"
            : "border-border-default text-text-tertiary",
        )}
      >
        {row.queuePosition}
      </span>
      <span className="min-w-[72px] shrink-0 truncate font-mono text-[0.78rem] font-semibold text-text-primary">
        {row.commandName}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] font-normal text-text-secondary">
        {row.projectName}
      </span>
      <span className="shrink-0 font-mono text-[0.7rem] font-normal text-text-tertiary">
        {row.cost}u
      </span>
    </RunRowShell>
  );
}

export function ValidationBudgetPanel({
  view,
}: {
  view: ValidationBudgetView;
}): React.JSX.Element {
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
          <div className="flex flex-col gap-xs px-[10px] pb-[10px]">
            {view.running.map((row) => (
              <RunningRow key={row.runId} row={row} />
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
          <div className="flex flex-col px-lg pb-[14px]">
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
