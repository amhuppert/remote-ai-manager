"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  ContextRouteRow,
  ContextSkipDisplay,
} from "@/components/workflow-graph/derive-graph";
import {
  ControlFlowChip,
  GroupHeader,
  formatInspectorTimestamp,
  inspectorSectionClass,
} from "./chrome";

/**
 * Tasks tab → Routing (§11): the guarded edges into this context and how each
 * one resolved, plus the recorded verdicts behind a branch that was not taken.
 *
 * Renders from the SAME derivations the graph nodes and edges use
 * (`derive-graph.ts`), so the inspector and the canvas cannot report different
 * routing.
 */

const routeResolutionTone: Record<
  ContextRouteRow["resolution"],
  StatusChipTone
> = {
  active: "cyan",
  inactive: "neutral",
  omitted: "neutral",
  unresolved: "amber",
  unevaluable: "red",
};

const routingRowClass =
  "flex flex-wrap items-center gap-[6px] border-x-0 border-t-0 border-b border-solid border-border-dim py-[6px] text-[0.72rem] last:border-b-0";

export default function RoutingSection({
  routes,
  skip,
}: {
  routes: readonly ContextRouteRow[];
  skip: ContextSkipDisplay | null;
}): React.JSX.Element | null {
  const hasGuard = routes.some((route) => route.guard !== "none");
  if (!hasGuard && !skip) return null;

  return (
    <section className={inspectorSectionClass} data-testid="context-routing">
      <GroupHeader label="Routing" />
      {skip && (
        <div
          data-testid="context-skip-reason"
          className="mb-sm rounded-sm border border-border-dim bg-bg-raised p-3 text-[0.72rem] text-text-secondary"
        >
          <div className="mb-1 font-medium text-text-primary">
            Branch not taken
          </div>
          <div className="text-text-tertiary">
            Decided {formatInspectorTimestamp(skip.at)} — recorded verdicts:
          </div>
          <ul className="mt-1 list-none p-0">
            {skip.edgeEvaluations.map((evaluation) => (
              <li key={evaluation.edgeId} className="font-mono text-[0.7rem]">
                {evaluation.edgeId} · {evaluation.verdict}
              </li>
            ))}
          </ul>
        </div>
      )}
      {routes.map((route) => (
        <div
          key={route.edgeId}
          className={routingRowClass}
          data-testid="context-route-row"
          data-edge-id={route.edgeId}
          data-guard={route.guard}
          data-resolution={route.resolution}
        >
          <span className="font-mono text-[0.7rem] text-text-secondary">
            {route.logicalSourceId}
          </span>
          {route.effectiveSourceId !== null &&
            route.effectiveSourceId !== route.logicalSourceId && (
              <span className="font-mono text-[0.7rem] text-text-tertiary">
                via {route.effectiveSourceId}
              </span>
            )}
          {route.guard !== "none" && (
            <ControlFlowChip>
              {route.guard === "else" ? "else" : "when"}
            </ControlFlowChip>
          )}
          <StatusChip tone={routeResolutionTone[route.resolution]}>
            {route.resolution}
          </StatusChip>
        </div>
      ))}
    </section>
  );
}
