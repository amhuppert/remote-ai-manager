import { AlertTriangleIcon, CheckIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import type { ContextStage } from "../model";

/**
 * Where a context is in its lifecycle: workspace, work, result, review,
 * approval when it has one, and acceptance. The current stage carries the
 * state's colour, so "what is it doing" reads before any text does. The
 * connector stops short of each circle, whose fills are translucent.
 */

const nodeClass: Record<ContextStage["state"], string> = {
  done: "border-[var(--cc-green-a20)] bg-green-glow text-green",
  current:
    "border-cyan bg-cyan-glow text-cyan shadow-[0_0_10px_var(--color-cyan-glow)]",
  waiting:
    "border-amber bg-amber-glow text-amber shadow-[0_0_10px_var(--color-amber-glow)]",
  halted:
    "border-red bg-red-glow text-red shadow-[0_0_10px_var(--color-red-glow)]",
  pending: "border-border-default bg-bg-base text-text-tertiary",
  skipped:
    "border-dashed border-border-default bg-transparent text-text-tertiary",
};

const labelClass: Record<ContextStage["state"], string> = {
  done: "text-text-secondary",
  current: "text-cyan",
  waiting: "text-amber",
  halted: "text-red",
  pending: "text-text-tertiary",
  skipped: "text-text-tertiary line-through decoration-border-strong",
};

function StageNode({
  state,
  paused,
}: {
  state: ContextStage["state"];
  paused: boolean;
}) {
  return (
    <span
      className={cn(
        "relative z-raised inline-flex size-[20px] items-center justify-center rounded-full border border-solid",
        nodeClass[paused && state === "current" ? "pending" : state],
      )}
    >
      {state === "done" ? <CheckIcon size={12} /> : null}
      {state === "halted" ? <AlertTriangleIcon size={11} /> : null}
      {state === "current" || state === "waiting" ? (
        <span
          className={cn(
            "size-[6px] rounded-full bg-current",
            !paused && "animate-pulse-dot",
          )}
        />
      ) : null}
    </span>
  );
}

export function StageTrack({
  stages,
  compact = false,
  paused = false,
}: {
  stages: ContextStage[];
  compact?: boolean;
  paused?: boolean;
}) {
  return (
    <ol className="m-0 flex list-none p-0" aria-label="Lifecycle">
      {stages.map((stage, index) => {
        const previousDone = index > 0 && stages[index - 1]?.state === "done";
        return (
          <li
            key={stage.key}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-[6px]"
            aria-current={
              stage.state === "current" ||
              stage.state === "waiting" ||
              stage.state === "halted"
                ? "step"
                : undefined
            }
          >
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-[10px] right-[calc(50%+14px)] left-0 h-px",
                  previousDone && stage.state !== "pending"
                    ? "bg-green-dim"
                    : "bg-border-default",
                )}
              />
            ) : null}
            {index < stages.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-[10px] right-0 left-[calc(50%+14px)] h-px",
                  stage.state === "done" ? "bg-green-dim" : "bg-border-default",
                )}
              />
            ) : null}
            <StageNode state={stage.state} paused={paused} />
            <span
              className={cn(
                "max-w-full truncate text-center font-mono text-[0.7rem] font-medium",
                labelClass[
                  paused && stage.state === "current" ? "pending" : stage.state
                ],
              )}
            >
              <span className="max-640:hidden">{stage.label}</span>
              <span className="hidden max-640:inline" title={stage.label}>
                {stage.key === "workspace" ? "Setup" : stage.label}
              </span>
              <span className="sr-only">
                : {paused && stage.state === "current" ? "paused" : stage.state}
              </span>
            </span>
            {!compact && stage.note !== undefined ? (
              <span className="-mt-[4px] max-w-full truncate text-center font-mono text-[0.7rem] text-text-tertiary">
                {stage.note}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
