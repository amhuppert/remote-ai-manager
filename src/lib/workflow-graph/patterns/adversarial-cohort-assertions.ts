import { expect } from "vitest";

import type { GraphWorkflowValidationSpecialist } from "../schemas";
import type { GraphWorkflowExecution } from "../schemas";
import type { WorkflowSemanticDefinition } from "../definition-schemas";

/**
 * The Adversarial Verification panel, shared by the standalone pattern proof and
 * the composite that reuses it (D6 R2.3, R2.7).
 *
 * It lives in one module because the composite's claim is that it runs THE
 * approved cohort, not a cohort that happens to look similar. Two hand-copied
 * seat tables could drift into two different panels while both test files stayed
 * green, and the drift would be invisible exactly where it matters.
 */

/**
 * The four seats, in authored order.
 *
 * The partition is the pattern: one generalist that can send the work back, and
 * three specialists whose lens reaches past the context's acceptance criteria.
 * Every specialist is advisory because `defaultValidatorAuthority` makes that
 * the library default — a specialist that could fail a context is a deliberate
 * act by the author, who then owns convergence for it, and this pattern
 * deliberately does not take that on.
 */
export const COHORT_SEATS = [
  {
    id: "acceptance",
    profileId: "general-reviewer",
    authority: "blocking",
  },
  {
    id: "security",
    profileId: "security-reviewer",
    authority: "advisory",
  },
  {
    id: "type-api-contract",
    profileId: "type-api-contract-reviewer",
    authority: "advisory",
  },
  {
    id: "test-reliability",
    profileId: "test-reliability-reviewer",
    authority: "advisory",
  },
] as const;

/**
 * Assert that `contextId` is staffed with exactly the approved panel.
 *
 * Exactness in both directions is the point: a missing specialist silently
 * narrows the review, and an extra seat is a reviewer nobody approved. Ordering
 * is asserted too, because the roster is frozen in authored order and a reader
 * comparing two executions reads it positionally.
 */
export function expectAdversarialCohort(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): void {
  const context = definition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  expect(context, `no context "${contextId}" in the definition`).toBeDefined();

  const cohort = context?.contextValidator;
  expect(cohort?.enabled).toBe(true);
  expect(
    cohort?.assignments.map((assignment) => ({
      id: assignment.id,
      profileId: assignment.profile.id,
      authority: assignment.authority,
    })),
  ).toEqual(
    COHORT_SEATS.map((seat) => ({
      id: seat.id,
      profileId: seat.profileId,
      authority: seat.authority,
    })),
  );

  // Every seat reads from the builtin library rather than carrying an inline
  // prompt: a use site that re-states a reviewer's mandate cannot inherit a
  // later revision of it, which is the whole reason the library tier exists.
  for (const assignment of cohort?.assignments ?? []) {
    expect(assignment.profile.tier).toBe("builtin");
  }

  // Exactly one seat can send the work back. Two blocking seats would make the
  // panel's convergence a function of which one is stricter.
  expect(
    cohort?.assignments.filter(
      (assignment) => assignment.authority === "blocking",
    ),
  ).toHaveLength(1);
}

/**
 * The durable per-seat records from `contextId`'s latest validation round.
 *
 * Read off the execution rather than off a verdict the scenario scripted: what
 * the criterion asks is whether each seat got its OWN identity and settled on
 * its own, and only the persisted round can answer that.
 */
export function settledSpecialists(
  execution: GraphWorkflowExecution,
  contextId: string,
): Record<string, GraphWorkflowValidationSpecialist> {
  return execution.contextStates[contextId]?.validationRound?.specialists ?? {};
}
