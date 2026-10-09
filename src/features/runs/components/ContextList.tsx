"use client";

import { BranchIcon, ChevronRightIcon, RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { LoopIcon } from "../icons";
import type { RunContext, RunLane, RunLoop } from "../model";
import { contextState, formatUsd, laneState, loopState } from "../present";
import { ContextGlyph, SeatMark } from "./parts";

const stateText: Record<ReturnType<typeof contextState>["tone"], string> = {
  neutral: "text-text-secondary",
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
  violet: "text-violet",
};

const RETRYABLE: ReadonlySet<RunLane["state"]> = new Set(["blocked", "stale", "failed", "provision_failed", "uncertain"]);

function Row({
  context,
  selected,
  onSelect,
}: {
  context: RunContext;
  selected: boolean;
  onSelect(key: string): void;
}) {
  const state = contextState(context.state);
  const quiet = context.state.kind === "skipped" || context.state.kind === "cancelled";
  const reviewers = context.reviewers.length;
  return (
    <li className="border-x-0 border-t-0 border-b border-solid border-border-dim last:border-b-0">
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(context.key)}
        data-selected={selected}
        className={cn(
          "group relative flex w-full cursor-pointer items-center gap-md border-0 bg-transparent px-lg py-[10px] text-left transition-colors duration-150",
          "hover:bg-bg-raised focus-visible:z-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:-outline-offset-2",
          "data-[selected=true]:bg-bg-raised",
        )}
      >
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 left-0 w-[2px] bg-transparent transition-colors duration-150 group-data-[selected=true]:bg-cyan"
        />
        <ContextGlyph state={context.state} />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-baseline gap-sm">
            <span className={cn("break-words font-mono text-[0.82rem] font-medium", quiet ? "text-text-tertiary" : "text-text-primary")}>
              {context.title}
            </span>
            {context.loop !== null ? (
              <span className="inline-flex shrink-0 items-center gap-[4px] font-mono text-[0.7rem] text-text-tertiary">
                <LoopIcon size={11} />
                {context.loop.pass}/{context.loop.maxPasses}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-sm font-mono text-[0.7rem] text-text-tertiary max-640:hidden">
            <span className="shrink-0">{context.key}</span>
            {quiet ? null : (
              <>
                <span aria-hidden="true">·</span>
                <SeatMark seat={context.implementer} showEffort={false} />
                {reviewers > 0 ? (
                  <span className="shrink-0">
                    + {reviewers} {reviewers === 1 ? "reviewer" : "reviewers"}
                  </span>
                ) : null}
              </>
            )}
          </span>
          {/* On a phone the state takes the second line; seats live in the inspector. */}
          <span className={cn("hidden min-w-0 truncate font-mono text-[0.72rem] font-medium max-640:block", stateText[state.tone])}>
            {state.label}
          </span>
        </span>
        <span className="flex max-w-[42%] shrink-0 flex-col items-end gap-[3px] max-640:hidden">
          <span className={cn("text-right font-mono text-[0.72rem] font-medium", stateText[state.tone])}>
            {state.label}
          </span>
          <span className="flex items-center gap-md font-mono text-[0.7rem] text-text-tertiary">
            {quiet ? null : (
              <span>
                {context.tasks.done}/{context.tasks.total} tasks
              </span>
            )}
            <span className="w-[44px] text-right">{formatUsd(context.costUsd)}</span>
          </span>
        </span>
        <span className="shrink-0 text-text-tertiary transition-colors duration-150 group-hover:text-text-secondary">
          <ChevronRightIcon size={14} />
        </span>
      </button>
    </li>
  );
}

function LaneHeader({ lane, onRetry }: { lane: RunLane; onRetry(key: string): void }) {
  const state = laneState(lane.state);
  return (
    <div className="flex min-h-[40px] flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-lg py-[6px]">
      <span className="text-text-tertiary">
        <BranchIcon size={13} />
      </span>
      <span className="shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] whitespace-nowrap text-text-secondary uppercase">
        Lane {lane.key}
      </span>
      <StatusChip tone={state.tone}>{state.label}</StatusChip>
      <span className="min-w-0 truncate font-mono text-[0.7rem] text-text-tertiary" title={lane.worktreePath}>
        {lane.branch}
        {lane.commit !== null ? ` · ${lane.commit}` : ""}
      </span>

      {RETRYABLE.has(lane.state) ? (
        <Button touch size="sm" variant="default" layoutClassName="ml-auto shrink-0" onClick={() => onRetry(lane.key)}>
          <RefreshIcon size={13} />
          Retry lane
        </Button>
      ) : null}
      {lane.detail !== null ? <span className="basis-full font-mono text-[0.72rem] leading-relaxed text-amber">{lane.detail}</span> : null}
      <details className="basis-full font-mono text-[0.7rem] text-text-secondary">
        <summary className="cursor-pointer rounded-sm py-xs focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2">Publication checks</summary>
        <div className="flex flex-col gap-sm py-sm">
          {lane.worktreePath ? <code className="break-all text-text-tertiary">{lane.worktreePath}</code> : null}
          <span>{lane.checks.length > 0 ? lane.checks.join(" · ") : "No publication checks configured."}</span>
        </div>
      </details>
    </div>
  );
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[40px] flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-lg py-[6px]">
      {children}
    </div>
  );
}

/**
 * Every context key's current invocation, grouped by where it works: the
 * session worktree, then each lane with its state. Order is the definition's.
 */
export function ContextList({
  contexts,
  lanes,
  loops,
  selectedKey,
  onSelect,
  onRetryLane,
}: {
  contexts: RunContext[];
  lanes: RunLane[];
  loops: RunLoop[];
  selectedKey: string | null;
  onSelect(key: string): void;
  onRetryLane(key: string): void;
}) {
  const session = contexts.filter((context) => context.placement.kind === "session");
  const groups = lanes.map((lane) => ({
    lane,
    contexts: contexts.filter((context) => context.placement.kind === "lane" && context.placement.lane === lane.key),
  }));
  return (
    <div className="flex flex-col gap-md">
      {loops.length > 0 ? (
        <div aria-label="Loop progress" className="flex flex-col gap-sm">
          {loops.map(loop => {
            const progress = loopState(loop);
            return <div key={loop.key} className="flex flex-wrap items-center gap-sm rounded-md border border-solid border-border-dim bg-bg-base px-lg py-sm">
              <span className="text-text-tertiary"><LoopIcon size={14} /></span>
              <span className="font-mono text-[0.75rem] font-medium text-text-primary">{loop.key}</span>
              <StatusChip tone={progress.tone}>{progress.label}</StatusChip>
              <span className="min-w-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">Until {loop.until}</span>
            </div>;
          })}
        </div>
      ) : null}
      {session.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface">
          <GroupHeader>
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
              Session worktree
            </span>
            <span className="font-mono text-[0.7rem] text-text-tertiary">{session.length}</span>

          </GroupHeader>
          <ul className="m-0 list-none p-0">
            {session.map((context) => (
              <Row key={context.key} context={context} selected={selectedKey === context.key} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ) : null}
      {groups.map(({ lane, contexts: members }) => (
        <section key={lane.key} className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface">
          <LaneHeader lane={lane} onRetry={onRetryLane} />
          <ul className="m-0 list-none p-0">
            {members.map((context) => (
              <Row key={context.key} context={context} selected={selectedKey === context.key} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
