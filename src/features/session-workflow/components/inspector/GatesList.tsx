"use client";

import { cn } from "@/lib/ui/cn";
import { ChevronRightIcon } from "@/components/workflow-config-panel/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import { inspectorFocusRingClass } from "./chrome";
import type { ExecutionGate } from "@/lib/workflow-graph/execution-gates";

/**
 * Everything waiting on the human on this run, as one list (E2, README §10).
 *
 * There is no single global gate: a context approval and a parked question are
 * separate waits on separate contexts, so the header states the count and every
 * row names the context it belongs to and navigates there. The two entrances —
 * the status bar's gates chip and the Overview's Gates row — render this same
 * list, so a count and a list can never disagree.
 */

export interface GatesListProps {
  gates: readonly ExecutionGate[];
  onOpenGate: (gate: ExecutionGate) => void;
}

/**
 * Amber is the decision the run is parked on; blue is a question it asked; red
 * is a join that failed to merge and needs a hand.
 */
const GATE_DOT_CLASS: Record<ExecutionGate["kind"], string> = {
  approval: "bg-amber",
  question: "bg-blue",
  join: "bg-red",
};

const ROW_CLASS =
  "flex w-full items-center gap-[9px] border-x-0 border-t-0 border-b border-solid border-border-dim px-3 py-[9px] text-left max-768:min-h-[44px]";

export default function GatesList({
  gates,
  onOpenGate,
}: GatesListProps): React.JSX.Element {
  if (gates.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        Nothing on this run is waiting on you.
      </p>
    );
  }

  return (
    <section
      aria-label="Gates awaiting you"
      data-testid="execution-gates-list"
      className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base"
    >
      <header className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-surface px-3 py-[9px]">
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
          Gates awaiting you
        </span>
        <StatusChip tone="amber" data-testid="gates-count">
          {gates.length}
        </StatusChip>
        <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
          there is no single global gate — each row names its context
        </span>
      </header>
      <ul className="m-0 flex list-none flex-col p-0">
        {gates.map((gate) => {
          const body = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "h-[6px] w-[6px] shrink-0 rounded-full",
                  GATE_DOT_CLASS[gate.kind],
                )}
              />
              <span className="font-mono text-[0.74rem] font-medium text-text-primary">
                {gate.contextTitle}
              </span>
              <span className="min-w-0 font-mono text-[0.7rem] text-text-tertiary">
                {gate.detail}
              </span>
            </>
          );
          return (
            <li
              key={`${gate.kind}:${gate.contextId ?? gate.joinId ?? ""}:${gate.laneKey ?? ""}`}
            >
              {/*
                A join whose roster cannot name the blocked member has no
                context to open, so the row states the conflict instead of
                offering a control that would navigate nowhere.
              */}
              {gate.contextId === null ? (
                <div
                  data-testid="execution-gate-row"
                  data-gate-kind={gate.kind}
                  className={ROW_CLASS}
                >
                  {body}
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="execution-gate-row"
                  data-gate-kind={gate.kind}
                  data-context-id={gate.contextId}
                  onClick={() => onOpenGate(gate)}
                  className={cn(
                    ROW_CLASS,
                    "cursor-pointer bg-transparent transition-colors duration-150 hover:bg-bg-elevated",
                    inspectorFocusRingClass,
                  )}
                >
                  {body}
                  <span className="ml-auto flex shrink-0 text-text-tertiary">
                    <ChevronRightIcon size={13} />
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
