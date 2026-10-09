"use client";

import { AlertTriangleIcon, ArrowUpRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import { StatusChip } from "@/components/ui/StatusChip";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import { ApprovalIcon } from "../icons";
import type { AttentionItem, RunSummary } from "../model";
import { formatUsd, haltTitle, runHaltTitle, runStatus } from "../present";

function attentionLine(item: Exclude<AttentionItem, { kind: "question" }>): { icon: React.ReactNode; tone: string; text: React.ReactNode; action: string } {
  switch (item.kind) {
    case "halt":
      return {
        icon: <AlertTriangleIcon size={13} />,
        tone: "text-red",
        text: (
          <>
            <span className="text-text-tertiary">{item.contextKey}</span> {haltTitle(item.halt).toLowerCase()}
          </>
        ),
        action: "Resolve",
      };
    case "approval":
      return {
        icon: <ApprovalIcon size={13} />,
        tone: "text-amber",
        text: (
          <>
            <span className="text-text-tertiary">{item.contextKey}</span> awaits your approval
          </>
        ),
        action: "Review",
      };
    case "run_halt":
      return {
        icon: <AlertTriangleIcon size={13} />,
        tone: "text-red",
        text: runHaltTitle(item.halt),
        action: item.clearedBy === "retry_lane" ? "Retry lane" : item.clearedBy === "resume" ? "Resume" : "Open",
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
  onOpen,
  onAct,
}: {
  run: RunSummary;
  attention: AttentionItem[];
  onOpen(runId: string): void;
  onAct(item: AttentionItem): void;
}) {
  const status = runStatus(run.status);
  const yours = attention.filter((item): item is Exclude<AttentionItem, { kind: "question" }> => item.kind !== "question");
  const finished = run.finishedAt !== null;
  return (
    <article
      aria-label={`Run: ${run.title}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-solid bg-bg-surface",
        yours.length > 0 ? "border-[var(--cc-amber-a25)]" : "border-border-subtle",
      )}
    >
      <div className="flex flex-col gap-md px-lg py-md">
        <div className="flex min-w-0 flex-wrap items-center gap-sm">
          <span className="shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase max-640:w-full">
            {run.kind === "workflow" ? "Workflow run" : "Agent run"}
          </span>
          <span className="min-w-0 flex-1 font-mono text-[0.82rem] font-medium break-words text-text-primary">{run.title}</span>
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
            {run.kind === "workflow" ? `${run.contexts.done} of ${run.contexts.total} contexts · ` : ""}
            {formatUsd(run.costUsd)}
            {finished ? ` · finished ${formatLocalTime(run.finishedAt ?? run.startedAt)}` : ` · started ${formatLocalTime(run.startedAt)}`}
          </span>
          <Button size="sm" touch variant="ghost" layoutClassName="ml-auto -mr-[8px] shrink-0" onClick={() => onOpen(run.runId)}>
            Open run
            <ArrowUpRightIcon size={12} />
          </Button>
        </div>
      </div>
      {yours.length > 0 ? (
        <ul className="m-0 list-none border-x-0 border-t border-b-0 border-solid border-[var(--cc-amber-a18)] bg-[var(--cc-amber-a04)] p-0">
          {yours.map((item, index) => {
            const line = attentionLine(item);
            return (
              <li
                key={`${item.kind}-${index}`}
                className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[6px] last:border-b-0"
              >
                <span className={cn("shrink-0", line.tone)}>{line.icon}</span>
                <span className="min-w-0 flex-1 font-mono text-[0.75rem] break-words text-text-primary">{line.text}</span>
                <Button size="sm" touch variant={item.kind === "approval" ? "primary" : "default"} onClick={() => onAct(item)}>
                  {line.action}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

/** The session's runs on the session overview: current ones first, the way to the run page. */
export function SessionRunsCard({
  runs,
  onOpen,
  onBrowseTemplates,
}: {
  runs: RunSummary[];
  onOpen(runId: string | null): void;
  onBrowseTemplates(): void;
}) {
  const current = runs.filter((run) => run.finishedAt === null);
  const finished = runs.filter((run) => run.finishedAt !== null);
  const shown = [...current, ...finished].slice(0, 4);
  return (
    <section className="flex flex-col gap-md rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg">
      <div className="flex items-center gap-sm">
        <h2 className="m-0 font-mono text-[0.82rem] font-semibold text-text-primary">Runs</h2>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {current.length} current · {finished.length} finished
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          Launch a saved template, or ask a conversation to start a run. Progress and decisions appear here.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
          {shown.map((run) => {
            const status = runStatus(run.status);
            return (
              <li key={run.runId}>
                <button
                  type="button"
                  onClick={() => onOpen(run.runId)}
                  className="-mx-sm flex w-[calc(100%+16px)] cursor-pointer flex-col gap-[5px] rounded-md border-0 bg-transparent px-sm py-[7px] text-left transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                >
                  <span className="flex w-full min-w-0 items-center gap-sm">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[0.75rem] font-medium",
                        run.finishedAt === null ? "text-text-primary" : "text-text-secondary",
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
                      {run.kind === "workflow" ? `${run.contexts.done}/${run.contexts.total}` : "agent"} · {formatUsd(run.costUsd)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-sm">
        {runs.length > 0 ? (
          <Button size="sm" touch variant="default" onClick={() => onOpen(null)}>
            Open runs
            <ArrowUpRightIcon size={12} />
          </Button>
        ) : null}
        <Button size="sm" touch variant={runs.length === 0 ? "primary" : "ghost"} onClick={onBrowseTemplates}>
          Browse templates
        </Button>
      </div>
    </section>
  );
}
