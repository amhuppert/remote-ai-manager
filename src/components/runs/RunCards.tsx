"use client";

import Link from "next/link";
import { AlertTriangleIcon, ArrowUpRightIcon } from "@/components/icons";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import { StatusChip } from "@/components/ui/StatusChip";
import type { RunControlRequest } from "@/lib/runs/schemas";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import { Refusal, useAwaitedAction } from "./awaited-action";
import { Cost } from "./Cost";
import { ApprovalIcon } from "./icons";
import type { AttentionItem, RunSummary } from "./model";
import { haltTitle, runHaltTitle, runStatus } from "./present";

/** What a person acts on from a card; a seat's question is its owner's to answer. */
export type PersonAttentionItem = Exclude<AttentionItem, { kind: "question" }>;

/**
 * What a line's button does: open the run page (at a context, when the decision
 * lives in its inspector), or steer the run in place.
 */
type LineAction =
  | { kind: "open"; label: string; contextKey?: string }
  | { kind: "control"; label: string; control: RunControlRequest };

/** The item's identity across reads, so a refusal stays with the line that acted. */
function lineKey(item: PersonAttentionItem): string {
  switch (item.kind) {
    case "approval":
    case "halt":
      return `${item.kind}:${item.contextKey}`;
    case "run_halt":
      return `run_halt:${item.occurrence}`;
    case "stalled":
      return `stalled:${item.contextKey ?? "run"}`;
  }
}

function attentionLine(item: PersonAttentionItem): {
  icon: React.ReactNode;
  tone: string;
  text: React.ReactNode;
  action: LineAction;
} {
  switch (item.kind) {
    case "halt":
      return {
        icon: <AlertTriangleIcon size={13} />,
        tone: "text-red",
        text: (
          <>
            <span className="text-text-tertiary">{item.contextKey}</span>{" "}
            {haltTitle(item.halt).toLowerCase()}
          </>
        ),
        action: { kind: "open", label: "Resolve", contextKey: item.contextKey },
      };
    case "approval":
      return {
        icon: <ApprovalIcon size={13} />,
        tone: "text-amber",
        text: (
          <>
            <span className="text-text-tertiary">{item.contextKey}</span> awaits
            your approval
          </>
        ),
        action: { kind: "open", label: "Review", contextKey: item.contextKey },
      };
    case "run_halt":
      return {
        icon: <AlertTriangleIcon size={13} />,
        tone: "text-red",
        text:
          item.lane !== undefined ? (
            <>
              <span className="text-text-tertiary">{item.lane}</span> ·{" "}
              {runHaltTitle(item.halt)}
            </>
          ) : (
            runHaltTitle(item.halt)
          ),
        // Lanes stop alike; the label names the one a retry goes to.
        action:
          item.clearedBy === "retry_lane" && item.lane !== undefined
            ? {
                kind: "control",
                label: `Retry ${item.lane} lane`,
                control: { action: "retry", lane: item.lane },
              }
            : item.clearedBy === "resume"
              ? {
                  kind: "control",
                  label: "Resume",
                  control: { action: "resume" },
                }
              : { kind: "open", label: "Open" },
      };
    case "stalled":
      return {
        icon: <AlertTriangleIcon size={13} />,
        tone: "text-amber",
        text: (
          <>
            {item.contextKey !== undefined ? (
              <span className="text-text-tertiary">{item.contextKey} · </span>
            ) : null}
            Finished work was not picked up
          </>
        ),
        action: {
          kind: "control",
          label: "Resume",
          control: { action: "resume" },
        },
      };
  }
}

/**
 * A run in its owner's conversation: what it is, how far it got, and what it
 * needs, with the way into the run page. One per run the conversation owns.
 */
export function OwnerRunCard({
  run,
  attention,
  hrefOf,
  onControl,
  readFailure,
}: {
  run: RunSummary;
  attention: AttentionItem[];
  /** The run page, at a context when one is named. */
  hrefOf(contextKey?: string): string;
  /** Resolves once the run took the control; a rejection is the run's refusal. */
  onControl(control: RunControlRequest): void | Promise<void>;
  /** Why what the run needs could not be read, when it could not. */
  readFailure?: React.ReactNode;
}) {
  const { pending, refusal, act } = useAwaitedAction<string>();
  const status = runStatus(run.status);
  const yours = attention.filter(
    (item): item is PersonAttentionItem => item.kind !== "question",
  );
  const finished = run.finishedAt !== null;
  return (
    <article
      aria-label={`Run: ${run.title}`}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-lg border border-solid bg-bg-surface",
        yours.length > 0
          ? "border-[var(--cc-amber-a25)]"
          : "border-border-subtle",
      )}
    >
      <div className="flex flex-col gap-md px-lg py-md">
        <div className="flex min-w-0 flex-wrap items-center gap-sm">
          <span className="shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase max-640:w-full">
            {run.kind === "workflow" ? "Workflow run" : "Agent run"}
          </span>
          <span className="min-w-0 flex-1 font-mono text-[0.82rem] font-medium break-words text-text-primary">
            {run.title}
          </span>
          <StatusChip tone={status.tone} layoutClassName="ml-auto shrink-0">
            {status.label}
          </StatusChip>
        </div>
        <div className="flex flex-wrap items-center gap-md">
          {run.kind === "workflow" ? (
            <div className="w-[120px] shrink-0">
              <Progress
                value={run.contexts.done}
                max={run.contexts.total}
                tone={yours.length > 0 ? "warning" : "accent"}
                aria-label="Contexts done"
              />
            </div>
          ) : null}
          <span className="font-mono text-[0.72rem] text-text-secondary">
            {run.kind === "workflow"
              ? `${run.contexts.done} of ${run.contexts.total} contexts · `
              : ""}
            <Cost usd={run.costUsd} complete={run.costComplete} />
            {finished
              ? ` · finished ${formatLocalTime(run.finishedAt ?? run.startedAt)}`
              : ` · started ${formatLocalTime(run.startedAt)}`}
          </span>
          <ButtonLink
            href={hrefOf()}
            size="sm"
            touch
            variant="ghost"
            layoutClassName="ml-auto -mr-[8px] shrink-0"
          >
            Open run
            <ArrowUpRightIcon size={12} />
          </ButtonLink>
        </div>
      </div>
      {yours.length > 0 ? (
        <ul className="m-0 list-none border-x-0 border-t border-b-0 border-solid border-[var(--cc-amber-a18)] bg-[var(--cc-amber-a04)] p-0">
          {yours.map((item) => {
            const line = attentionLine(item);
            const key = lineKey(item);
            const { action } = line;
            const variant = item.kind === "approval" ? "primary" : "default";
            return (
              <li
                key={key}
                className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[6px] last:border-b-0"
              >
                <span className={cn("shrink-0", line.tone)}>{line.icon}</span>
                <span className="min-w-0 flex-1 font-mono text-[0.75rem] break-words text-text-primary">
                  {line.text}
                </span>
                {action.kind === "open" ? (
                  <ButtonLink
                    href={hrefOf(action.contextKey)}
                    size="sm"
                    touch
                    variant={variant}
                  >
                    {action.label}
                  </ButtonLink>
                ) : (
                  <Button
                    size="sm"
                    touch
                    variant={variant}
                    loading={pending === key}
                    disabled={pending !== null}
                    onClick={() =>
                      void act(key, () => onControl(action.control))
                    }
                  >
                    {action.label}
                  </Button>
                )}
                {refusal?.key === key ? (
                  <div
                    className="basis-full"
                    ref={(element) =>
                      element?.scrollIntoView?.({ block: "nearest" })
                    }
                  >
                    <Refusal message={refusal.message} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {readFailure !== undefined ? (
        <div className="px-lg py-md">{readFailure}</div>
      ) : null}
    </article>
  );
}

/**
 * Where a conversation's runs sit above its composer: bounded, so the
 * transcript keeps its room, and scrolling, while each card keeps its height.
 */
export function OwnedRunsRegion({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Runs this conversation owns"
      className="flex max-h-[50%] shrink-0 flex-col gap-sm overflow-y-auto border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-lg py-sm max-768:px-sm"
    >
      {children}
    </section>
  );
}

/** The session's runs on the session overview: current ones first, the way to the run page. */
export function SessionRunsCard({
  runs,
  hrefOf,
  onBrowseTemplates,
}: {
  runs: RunSummary[];
  /** The run page, at a run when one is named. */
  hrefOf(runId?: string): string;
  /** The session's run templates, offered beside its runs. */
  onBrowseTemplates?(): void;
}) {
  const current = runs.filter((run) => run.finishedAt === null);
  const finished = runs.filter((run) => run.finishedAt !== null);
  const shown = [...current, ...finished].slice(0, 4);
  return (
    <section className="flex flex-col gap-md rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg">
      <div className="flex items-center gap-sm">
        <h2 className="m-0 font-mono text-[0.82rem] font-semibold text-text-primary">
          Runs
        </h2>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {current.length} current · {finished.length} finished
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          {onBrowseTemplates !== undefined
            ? "Launch a run template, or ask a conversation to start a run."
            : "Ask a conversation to start a run."}{" "}
          Progress and decisions appear here.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
          {shown.map((run) => {
            const status = runStatus(run.status);
            return (
              <li key={run.runId}>
                <Link
                  href={hrefOf(run.runId)}
                  className="-mx-sm flex w-[calc(100%+16px)] flex-col gap-[5px] rounded-md px-sm py-[7px] text-left no-underline transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                >
                  <span className="flex w-full min-w-0 items-center gap-sm">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[0.75rem] font-medium",
                        run.finishedAt === null
                          ? "text-text-primary"
                          : "text-text-secondary",
                      )}
                    >
                      {run.title}
                    </span>
                    {run.attention > 0 ? (
                      <span className="inline-flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-amber px-[4px] font-mono text-[0.7rem] leading-none font-semibold text-text-inverse">
                        {run.attention}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex w-full items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
                    <StatusChip tone={status.tone}>{status.label}</StatusChip>
                    <span>
                      {run.kind === "workflow"
                        ? `${run.contexts.done}/${run.contexts.total}`
                        : "agent"}{" "}
                      · <Cost usd={run.costUsd} complete={run.costComplete} />
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {runs.length > 0 || onBrowseTemplates !== undefined ? (
        <div className="flex flex-wrap gap-sm">
          {runs.length > 0 ? (
            <ButtonLink href={hrefOf()} size="sm" touch variant="default">
              Open runs
              <ArrowUpRightIcon size={12} />
            </ButtonLink>
          ) : null}
          {onBrowseTemplates !== undefined ? (
            <Button
              size="sm"
              touch
              variant={runs.length === 0 ? "primary" : "ghost"}
              onClick={onBrowseTemplates}
            >
              Browse templates
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
