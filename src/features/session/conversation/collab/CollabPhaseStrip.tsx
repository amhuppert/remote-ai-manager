"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";

type CollabPhaseKind =
  | { kind: "initial_draft" }
  | { kind: "cross_review" }
  | { kind: "negotiation"; round: number }
  | { kind: "open_conflicts" }
  | { kind: "final_answer" }
  | { kind: "failed" };

type CollabPhaseStatus = "pending" | "active" | "done";

export type CollabPhaseVerdict =
  | "converged"
  | "ask_user"
  | "failed"
  | "user_stopped";

export interface CollabPhaseStripPhase {
  kind: CollabPhaseKind;
  status: CollabPhaseStatus;
}

export interface CollabPhaseStripProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  compact?: boolean;
  onStop?: () => void;
}

function phaseLabel(kind: CollabPhaseKind): string {
  switch (kind.kind) {
    case "initial_draft":
      return "Draft";
    case "cross_review":
      return "X-Rev";
    case "negotiation":
      return `R${kind.round}`;
    case "open_conflicts":
      return "Conflicts";
    case "final_answer":
      return "Final";
    case "failed":
      return "Failed";
  }
}

function phaseDataKind(kind: CollabPhaseKind): string {
  return kind.kind;
}

const VERDICT_LABEL: Record<CollabPhaseVerdict, string> = {
  converged: "converged",
  ask_user: "awaiting Alex",
  failed: "failed",
  user_stopped: "stopped",
};

const VERDICT_GLYPH: Record<CollabPhaseVerdict, string> = {
  converged: "✓",
  ask_user: "?",
  failed: "×",
  user_stopped: "■",
};

function isStopAvailable(phases: CollabPhaseStripPhase[]): boolean {
  return phases.some((phase) => phase.status === "active");
}

type PipTone = "red" | "amber" | "done" | "active" | "pending";

function pipTone(dataKind: string, status: CollabPhaseStatus): PipTone {
  if (dataKind === "failed" && status === "done") return "red";
  if (dataKind === "open_conflicts" && status === "active") return "amber";
  if (status === "done") return "done";
  if (status === "active") return "active";
  return "pending";
}

const pipTextColor: Record<PipTone, string> = {
  red: "text-red",
  amber: "text-amber",
  done: "text-text-primary",
  active: "text-cyan",
  pending: "text-text-secondary",
};

const pipDotTone: Record<PipTone, string> = {
  red: "border-red bg-red shadow-[0_0_6px_var(--red-glow)]",
  // open_conflicts+active recolors to amber but does NOT reset the animation
  // from the base [data-status=active] dot rule, so the amber dot still pulses.
  amber:
    "border-amber bg-amber shadow-[0_0_8px_var(--amber-glow)] animate-pulse-dot",
  done: "border-cyan bg-cyan shadow-[0_0_6px_var(--cyan-glow-strong)]",
  active:
    "border-cyan bg-cyan shadow-[0_0_8px_var(--cyan-glow-strong)] animate-pulse-dot",
  pending: "border-border-default bg-transparent",
};

const verdictColor: Record<CollabPhaseVerdict, string> = {
  converged: "bg-green-glow text-green",
  ask_user: "bg-amber-glow text-amber",
  failed: "bg-red-glow text-red",
  user_stopped: "bg-bg-raised text-text-secondary",
};

export default function CollabPhaseStrip({
  phases,
  verdict,
  compact,
  onStop,
}: CollabPhaseStripProps): React.JSX.Element {
  const stopAvailable = isStopAvailable(phases);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-md border border-solid border-border-subtle bg-bg-base",
        compact ? "rounded-sm px-sm py-[6px]" : "rounded-md px-md py-sm",
      )}
      data-compact={compact ? "true" : "false"}
      data-verdict={verdict ?? "none"}
      role="group"
      aria-label="Collaboration phase progress"
    >
      <ol className="m-0 flex min-w-0 flex-1 [scroll-snap-type:x_proximity] list-none items-center gap-sm overflow-x-auto p-0 max-768:[-webkit-overflow-scrolling:touch]">
        {phases.map((phase, idx) => {
          const label = phaseLabel(phase.kind);
          const dataKind = phaseDataKind(phase.kind);
          const tone = pipTone(dataKind, phase.status);
          return (
            <li
              key={`${dataKind}-${label}-${idx}`}
              className={cn(
                "inline-flex flex-none [scroll-snap-align:center] items-center gap-[6px] font-mono text-[0.72rem] font-semibold tracking-[0.06em] uppercase max-768:min-h-[var(--touch-target-min)] max-768:min-w-[var(--touch-target-min)] max-768:justify-center max-768:px-xs",
                pipTextColor[tone],
              )}
              data-kind={dataKind}
              data-status={phase.status}
              aria-current={phase.status === "active" ? "step" : undefined}
            >
              <span
                className={cn(
                  "inline-block h-[10px] w-[10px] rounded-full border border-solid",
                  pipDotTone[tone],
                )}
                aria-hidden="true"
              />
              <span>{label}</span>
            </li>
          );
        })}
        {verdict ? (
          <li
            className={cn(
              "inline-flex flex-none items-center gap-[6px] rounded-sm px-[8px] py-[2px] font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase",
              verdictColor[verdict],
            )}
            data-verdict={verdict}
            aria-label={VERDICT_LABEL[verdict]}
          >
            <span aria-hidden="true">{VERDICT_GLYPH[verdict]}</span>
            <span>{VERDICT_LABEL[verdict]}</span>
          </li>
        ) : null}
      </ol>

      {stopAvailable && onStop ? (
        <Button
          variant="danger"
          size="sm"
          touch
          layoutClassName="shrink-0 grow-0 basis-auto max-768:min-w-[var(--touch-target-min)]"
          onClick={onStop}
          aria-label="Stop collaboration"
        >
          Stop
        </Button>
      ) : null}
    </div>
  );
}
