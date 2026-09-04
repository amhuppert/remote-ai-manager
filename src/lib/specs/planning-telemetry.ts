/**
 * Planning-phase telemetry for the native-SDD delivery plan (#80 design 3.10).
 *
 * The spec-side half of the planning event set: how often the propose gate was
 * evaluated and on which surface, what coverage a freeze carried, and every
 * attempt transition. Pure builders, for the reasons stated on the graph-side
 * sibling — ids, codes and counts only, never plan prose or an actor's name.
 */

import type { LintSeverity } from "./lint";
import type { DeliveryPlanAttemptStatus } from "./schemas";

export interface SpecPlanningTelemetryEvent {
  readonly event: string;
  readonly fields: Readonly<
    Record<string, string | number | readonly string[] | null>
  >;
}

export const SPEC_PLAN_PREFLIGHT_EVENT = "spec.plan.preflight";
export const SPEC_PLAN_PROPOSE_ACCEPTED_EVENT = "spec.plan.propose.accepted";
export const SPEC_PLAN_ATTEMPT_TRANSITION_EVENT =
  "spec.plan.attempt.transition";

/**
 * The surface a draft-health evaluation was asked for. Every reading of the
 * projection belongs to exactly one of them, so a preflight-to-propose ratio
 * is a group-by rather than a join.
 */
export type DeliveryPlanGateSurface = "validate" | "status" | "propose";

export interface SpecPlanPreflightInput {
  readonly slug: string;
  readonly surface: DeliveryPlanGateSurface;
  readonly findings: readonly { ruleId: string; severity: LintSeverity }[];
}

/**
 * `blocking` counts findings; `codes` names rules. They disagree on purpose —
 * one rule tripping twice is one code and two blockers, and the ratio is what
 * says whether a draft owes many acts or one lesson.
 */
export function specPlanPreflightEvent(
  input: SpecPlanPreflightInput,
): SpecPlanningTelemetryEvent {
  return {
    event: SPEC_PLAN_PREFLIGHT_EVENT,
    fields: {
      slug: input.slug,
      surface: input.surface,
      blocking: input.findings.filter(
        (finding) => finding.severity === "blocks_propose",
      ).length,
      codes: [...new Set(input.findings.map((finding) => finding.ruleId))],
    },
  };
}

export interface SpecPlanProposeAcceptedInput {
  readonly slug: string;
  readonly covered: number;
  readonly selected: number;
  readonly contexts: number;
}

export function specPlanProposeAcceptedEvent(
  input: SpecPlanProposeAcceptedInput,
): SpecPlanningTelemetryEvent {
  return {
    event: SPEC_PLAN_PROPOSE_ACCEPTED_EVENT,
    fields: {
      slug: input.slug,
      covered: input.covered,
      selected: input.selected,
      contexts: input.contexts,
    },
  };
}

/**
 * Where an attempt stood before the transition. `none` is the opening of a
 * fresh attempt, which has no predecessor state to name.
 */
export type DeliveryPlanAttemptOrigin = DeliveryPlanAttemptStatus | "none";

export interface SpecPlanAttemptTransitionInput {
  readonly slug: string;
  readonly from: DeliveryPlanAttemptOrigin;
  readonly to: DeliveryPlanAttemptStatus;
  /** The actor's KIND. A name or handle would be content, not an id. */
  readonly actor: "agent" | "human";
}

export function specPlanAttemptTransitionEvent(
  input: SpecPlanAttemptTransitionInput,
): SpecPlanningTelemetryEvent {
  return {
    event: SPEC_PLAN_ATTEMPT_TRANSITION_EVENT,
    fields: {
      slug: input.slug,
      from: input.from,
      to: input.to,
      actor: input.actor,
    },
  };
}
