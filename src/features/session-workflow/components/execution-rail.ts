import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowExecutionOrigin,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import {
  ONE_OFF_SEED_DEFINITION_ID_PREFIX,
  SPEC_DELIVERY_SEED_DEFINITION_ID_PREFIX,
} from "@/lib/workflow-graph/execution-origin";

/**
 * The executions rail's Current/History split and row provenance (design
 * README §9), as pure functions.
 *
 * Tenure — not terminality — decides the section: Current is whichever run
 * still holds the session's execution lease, so a paused run and a resumably
 * halted one that nobody abandoned stay there, while a run whose lease is gone
 * belongs to History even though the active-execution endpoint still answers
 * with it. That question has exactly one owner, `holdsExecutionLease`, which is
 * the same predicate the status bar's control matrix consumes.
 */

export type ExecutionTenure = "current" | "history";

/** What a past run must state to take its place in History. */
export interface ExecutionRailPastRow {
  readonly executionId: string;
  /** ISO launch time; orders History newest-first. */
  readonly startedAt: string;
}

/**
 * The lease-relevant facts the session's one lease candidate must carry.
 *
 * Only the candidate needs them: a history summary is never promoted, so it is
 * never asked a lease question — which is what keeps the rail from inventing an
 * `abandonment: null` for a projection that has no such field.
 */
export interface ExecutionRailCandidate extends ExecutionRailPastRow {
  readonly status: GraphWorkflowStatus;
  readonly haltReason: GraphWorkflowHaltReason | null;
  readonly abandonment: GraphWorkflowAbandonment | null;
}

export interface ExecutionRailSections<T, P> {
  readonly current: T | null;
  readonly history: readonly (T | P)[];
}

/**
 * Place the session's lease candidate and its past runs into the two rail
 * sections.
 *
 * `leaseCandidate` is what the active-execution endpoint answered with, not a
 * verdict: a terminal run stays that endpoint's answer until a newer launch
 * replaces it, and the history endpoint lists it too. Demoting it here and
 * de-duplicating by id is what keeps one run from occupying both sections.
 */
export function partitionExecutionRail<
  T extends ExecutionRailCandidate,
  P extends ExecutionRailPastRow,
>(leaseCandidate: T | null, past: readonly P[]): ExecutionRailSections<T, P> {
  const holdsLease =
    leaseCandidate !== null &&
    holdsExecutionLease(
      leaseCandidate.status,
      leaseCandidate.haltReason,
      leaseCandidate.abandonment,
    );
  const current = holdsLease ? leaseCandidate : null;

  const rows: (T | P)[] = past.filter((row) =>
    leaseCandidate === null
      ? true
      : row.executionId !== leaseCandidate.executionId,
  );
  if (leaseCandidate !== null && !holdsLease) {
    // The demoted candidate is the richer record — it is the whole execution
    // rather than a history summary — so it replaces the row the history
    // endpoint listed for the same run.
    rows.push(leaseCandidate);
  }

  return {
    current,
    history: rows.sort(
      (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
    ),
  };
}

/**
 * The definition revision a run was launched from, or null when there is none.
 *
 * A definition-less run (one-off, spec delivery) persists legacy-shaped seed
 * filler so older builds can still parse its row, and the history endpoint
 * projects that filler as `definitionRevision: 1`. Rendering it would tell an
 * operator the run came from r1 of a definition that does not exist, so the
 * filler namespaces are refused here rather than at each render site.
 */
export function resolveLaunchRevision(input: {
  readonly origin: GraphWorkflowExecutionOrigin | null;
  readonly summaryDefinitionId: string | null;
  readonly summaryDefinitionRevision: number | null;
}): number | null {
  if (input.origin !== null) {
    return input.origin.kind === "template"
      ? input.origin.definitionRevision
      : null;
  }
  const definitionId = input.summaryDefinitionId;
  if (
    definitionId === null ||
    definitionId.startsWith(ONE_OFF_SEED_DEFINITION_ID_PREFIX) ||
    definitionId.startsWith(SPEC_DELIVERY_SEED_DEFINITION_ID_PREFIX)
  ) {
    return null;
  }
  return input.summaryDefinitionRevision;
}

export interface ExecutionRailMeta {
  readonly tenure: ExecutionTenure;
  readonly executionId: string;
  readonly launchRevision: number | null;
  /** Stands in for the revision a definition-less run cannot have. */
  readonly originLabel: string;
  readonly contextCount: number | null;
  /** Preformatted launch time; null when the record is not loaded. */
  readonly launchedAtLabel: string | null;
}

/**
 * The one meta line under a rail row's name: `exec_7f3a · launched from r4 · 6
 * contexts` under Current, `exec_5c10 · r3 snapshot · Aug 14, 9:12` under
 * History. Both state the same immutable launch snapshot; the Current phrasing
 * says what the run is working from now, the History phrasing what it is frozen
 * at.
 */
export function formatExecutionRailMeta(meta: ExecutionRailMeta): string {
  const revision =
    meta.launchRevision === null
      ? meta.originLabel
      : meta.tenure === "current"
        ? `launched from r${meta.launchRevision}`
        : `r${meta.launchRevision} snapshot`;
  const trailing =
    meta.tenure === "current"
      ? meta.contextCount === null
        ? null
        : `${meta.contextCount} ${meta.contextCount === 1 ? "context" : "contexts"}`
      : meta.launchedAtLabel;

  return [meta.executionId, revision, trailing]
    .filter((segment): segment is string => segment !== null)
    .join(" · ");
}

/** The bound launch inputs a run was started with, or null when it bound none. */
export function formatBoundInputsLine(
  boundInputs: Readonly<Record<string, string>>,
): string | null {
  const entries = Object.entries(boundInputs);
  if (entries.length === 0) return null;
  return `inputs: ${entries.map(([name, value]) => `${name}=${value}`).join(" · ")}`;
}
