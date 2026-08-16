import type { ValidationCommandCost, ValidationScope } from "./schemas";

// Cost projection is the one part of command resolution that browser-reachable
// surfaces need (the workflow builder reaches preflight through
// command-selector-validation), so it stays free of the worktree path
// validation — and therefore of `node:path` — that executable resolution needs.

// Collapses a registered cost declaration into the single reservation weight
// snapshotted onto the run at submission; everything downstream of admission
// only ever sees that number. A scoped charge is capped at the changed weight
// so narrowing can never cost more than not narrowing.
export function resolveSubmissionCost(input: {
  cost: ValidationCommandCost;
  effectiveScope: ValidationScope;
  scopedPathCount: number;
}): number {
  const { cost, effectiveScope, scopedPathCount } = input;

  if (typeof cost === "number") return cost;
  if (effectiveScope === "full") return cost.full;

  const changedCost = cost.changed ?? cost.full;
  if (scopedPathCount <= 0 || cost.paths === undefined) return changedCost;

  return Math.min(
    cost.paths.base + cost.paths.perPath * scopedPathCount,
    changedCost,
  );
}

// The heaviest reading of a declaration, for surfaces that must describe a
// command before a scope exists: preflight admissibility, the advisory command
// summaries, and the per-lane prompt annotation. An unscoped submission already
// falls back to the full weight, so the maximum is the only honest single
// number to quote ahead of a run.
export function maxDeclaredCost(cost: ValidationCommandCost): number {
  return resolveSubmissionCost({
    cost,
    effectiveScope: "full",
    scopedPathCount: 0,
  });
}
