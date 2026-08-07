/**
 * Criterion protection over the must-run set (D4 R5, decision D11).
 *
 * Skipping a context must never implicitly waive a linked spec acceptance
 * criterion, so both locks — the spec-to-workflow compiler at authoring time and
 * `checkLiveEditFrontier` at mutation time — ask the same question of the same
 * projection: after this graph, does every linked criterion still have at least
 * one covering context that runs on EVERY path?
 *
 * "Runs on every path" is the projection's transitive must-run set (no direct
 * guard, and either an entry context or reached by an unconditional edge from
 * another must-run context), which is why a guard added to an ANCESTOR edge
 * takes coverage away just as a guard on the covering context's own edge does.
 *
 * The two locks share this module rather than each deriving the rule, so a
 * scope the compiler accepts and a mutation the frontier accepts cannot mean
 * two different things. Pure and browser-safe; the coverage map is supplied by
 * whoever owns criteria (the specs domain, through the registered execution
 * contract port) and never read from here.
 */

import {
  projectMustRunContextIds,
  type RouteProjectionContext,
  type RouteProjectionEdge,
} from "@/lib/workflow-graph/route-projection";

/** criterion id → the contexts whose tasks cover it. */
export type CriterionContextCoverage = Readonly<
  Record<string, readonly string[]>
>;

export interface CriterionMustRunCoverageInput {
  readonly executionContexts: readonly RouteProjectionContext[];
  readonly edges: readonly RouteProjectionEdge[];
  readonly coverageByCriterionId: CriterionContextCoverage;
}

/** A criterion no must-run context covers, with the coverage it does have. */
export interface CriterionCoverageGap {
  readonly criterionId: string;
  readonly coveringContextIds: readonly string[];
}

export function findCriteriaWithoutMustRunCoverage(
  input: CriterionMustRunCoverageInput,
): CriterionCoverageGap[] {
  const mustRun = projectMustRunContextIds(input);
  const gaps: CriterionCoverageGap[] = [];
  // Own entries only: a criterion id is external data, and `Object.entries`
  // keeps an inherited `toString` from reading as a covered criterion.
  for (const [criterionId, coveringContextIds] of Object.entries(
    input.coverageByCriterionId,
  )) {
    if (coveringContextIds.some((contextId) => mustRun.has(contextId))) {
      continue;
    }
    gaps.push({ criterionId, coveringContextIds: [...coveringContextIds] });
  }
  return gaps;
}
