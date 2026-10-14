"use client";

import { useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ArrowUpRightIcon, StopIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import { PauseIcon, PlayIcon } from "@/components/runs/icons";
import type { RunDetail } from "@/components/runs/model";
import { runStatus, shortId } from "@/components/runs/present";
import { Cost } from "@/components/runs/Cost";
import { Refusal, useAwaitedAction } from "@/components/runs/awaited-action";
import { BackendDiamond } from "./parts";

export interface RunControls {
  /** Each settles once the server answered; a rejection carries its refusal. */
  onPause(): void | Promise<void>;
  onResume(): void | Promise<void>;
  onCancel(): void | Promise<void>;
  onOpenConversation(conversationId: string): void;
}

type Control = "pause" | "resume" | "cancel";

function Stat({
  value,
  label,
  tone,
}: {
  value: React.ReactNode;
  label: string;
  tone?: "amber" | "cyan" | "red";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[6px]">
      <span
        className={cn(
          "font-mono text-[1.35rem] leading-none font-medium tabular-nums",
          tone === "amber"
            ? "text-amber"
            : tone === "cyan"
              ? "text-cyan"
              : tone === "red"
                ? "text-red"
                : "text-text-primary",
        )}
      >
        {value}
      </span>
      <span className="font-mono text-[0.7rem] font-medium tracking-[0.1em] text-text-tertiary uppercase">
        {label}
      </span>
    </div>
  );
}

function elapsed(from: string, to: string | null, now: number): string {
  const end = to !== null ? new Date(to).getTime() : now;
  const minutes = Math.max(
    0,
    Math.round((end - new Date(from).getTime()) / 60_000),
  );
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A run's identity, standing and controls: what it is, who owns it, how far
 * it got and what it cost, with pause, resume and cancel beside it.
 */
export function RunHeader({
  run,
  controls,
  now,
  leading,
}: {
  run: RunDetail;
  controls: RunControls;
  now?: number;
  /** Narrow layouts put the run switcher here. */
  leading?: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const { pending, refusal, act } = useAwaitedAction<Control>();
  // The clock is read once; the live page ticks it from its own timer.
  const [mountedAt] = useState(() => Date.now());
  const status = runStatus(run.status);
  const finished =
    run.status.kind === "succeeded" || run.status.kind === "cancelled";
  const paused = run.status.kind === "paused";
  const done = run.contexts.filter(
    (context) => context.state.kind === "succeeded",
  ).length;
  const total = run.contexts.filter(
    (context) => context.state.kind !== "skipped",
  ).length;
  const working = run.contexts.filter(
    (context) => context.state.kind === "running",
  ).length;
  const agentContext = run.kind === "agent" ? run.contexts[0] : undefined;
  // Questions go to the owner conversation, not the person.
  const needsYou = run.attention.filter(
    (item) => item.kind !== "question",
  ).length;
  return (
    <header className="flex flex-col gap-xl">
      <div className="flex flex-col gap-md">
        <div className="flex min-w-0 items-center gap-sm font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary">
          {leading}
          <span className="uppercase max-640:hidden">
            {run.kind === "workflow" ? "Workflow run" : "Agent run"}
          </span>
          <span aria-hidden="true" className="max-640:hidden">
            /
          </span>
          <span title={run.runId} className="max-640:hidden">
            {shortId(run.runId.replace(/^run-/, ""))}
          </span>
        </div>
        <div className="flex flex-wrap items-start gap-md">
          <div className="flex min-w-0 flex-1 flex-col gap-sm">
            <div className="flex flex-wrap items-center gap-md">
              <h1 className="m-0 min-w-0 font-display text-[1.75rem] leading-[1.1] font-extrabold tracking-[-0.01em] text-text-primary max-768:text-[1.35rem]">
                {run.title}
              </h1>
              <StatusChip tone={status.tone}>{status.label}</StatusChip>
            </div>
            <div className="flex flex-wrap items-center gap-x-lg gap-y-[4px] font-mono text-[0.72rem] text-text-secondary">
              <button
                type="button"
                onClick={() =>
                  controls.onOpenConversation(run.owner.conversationId)
                }
                className="inline-flex cursor-pointer items-center gap-[6px] rounded-sm border-0 bg-transparent p-0 font-mono text-[0.72rem] text-text-secondary transition-colors duration-150 hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {run.owner.backend !== null ? (
                  <BackendDiamond backend={run.owner.backend} />
                ) : null}
                <span>
                  Owned by{" "}
                  <span className="text-text-primary">
                    {run.owner.title ??
                      (run.owner.backend === null
                        ? "a removed conversation"
                        : "an untitled conversation")}
                  </span>
                </span>
                <ArrowUpRightIcon size={11} />
              </button>
              <span>started {formatLocalTime(run.startedAt)}</span>
              {run.kind === "workflow" ? (
                <span>definition revision {run.definitionRevision}</span>
              ) : null}
            </div>
          </div>
          {finished ? null : (
            <div className="flex shrink-0 items-center gap-sm max-640:basis-full">
              {paused ? (
                <Button
                  touch
                  variant="default"
                  size="sm"
                  loading={pending === "resume"}
                  disabled={pending !== null}
                  onClick={() => void act("resume", controls.onResume)}
                >
                  <PlayIcon size={13} />
                  Resume
                </Button>
              ) : (
                <Button
                  touch
                  variant="default"
                  size="sm"
                  loading={pending === "pause"}
                  onClick={() => void act("pause", controls.onPause)}
                  disabled={pending !== null || run.status.kind === "stopping"}
                >
                  <PauseIcon size={13} />
                  Pause
                </Button>
              )}
              <Button
                touch
                variant="danger"
                size="sm"
                loading={pending === "cancel"}
                onClick={() => setConfirming(true)}
                disabled={pending !== null || run.status.kind === "stopping"}
              >
                <StopIcon size={11} />
                Cancel run
              </Button>
            </div>
          )}
        </div>
      </div>
      {refusal !== null ? <Refusal message={refusal.message} /> : null}
      <div className="grid grid-cols-5 gap-lg border-x-0 border-y border-solid border-border-dim py-lg max-768:grid-cols-3 max-768:gap-y-lg">
        {run.kind === "workflow" ? (
          <>
            <Stat value={`${done}/${total}`} label="Contexts done" />
            <Stat
              value={working}
              label="Working"
              tone={working > 0 ? "cyan" : undefined}
            />
          </>
        ) : (
          <>
            <Stat
              value={`${agentContext?.tasks.done ?? 0}/${agentContext?.tasks.total ?? 0}`}
              label="Tasks done"
            />
            <Stat
              value={agentContext?.reviews.length ?? 0}
              label="Review rounds"
            />
          </>
        )}
        <Stat
          value={needsYou}
          label="Needs you"
          tone={needsYou > 0 ? "amber" : undefined}
        />
        <Stat
          value={<Cost usd={run.costUsd} complete={run.costComplete} />}
          label="Cost"
        />
        <Stat
          value={elapsed(run.startedAt, run.finishedAt, now ?? mountedAt)}
          label={finished ? "Duration" : "Elapsed"}
        />
      </div>
      <ConfirmDialog
        open={confirming}
        title="Cancel this run?"
        message="Every context stops. Turns already running are interrupted and their partial work is kept. A cancelled run cannot be resumed."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        danger
        onConfirm={() => {
          setConfirming(false);
          void act("cancel", controls.onCancel);
        }}
        onCancel={() => setConfirming(false)}
      />
    </header>
  );
}
