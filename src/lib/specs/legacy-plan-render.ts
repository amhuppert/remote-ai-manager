import type { ValidationStrategy } from "./schemas";

/**
 * The legacy evergreen-plan renderers: the exact strings the spec→graph
 * compiler puts into a compiled definition's task instructions, context title,
 * and criterion briefs.
 *
 * They live here rather than inside `compiler.ts` because two callers now need
 * the same bytes: the compiler itself, and the importer that lifts an already
 * launched legacy plan into a `DeliveryPlanAttempt`. An importer that rendered
 * its own version of these strings would report a parity difference on every
 * task for no reason other than two copies drifting.
 */

export interface LegacyRenderRequirement {
  readonly handle: string;
  readonly statement: string;
}

export interface LegacyRenderDecision {
  readonly handle: string;
  readonly title: string;
  readonly chosenApproach: string;
  readonly reason: string;
}

export interface LegacyRenderCriterion {
  readonly handle: string;
  readonly text: string;
  readonly validationStrategy: ValidationStrategy;
}

export interface LegacyRenderTask {
  /** The qualified handle (`<slug>/T5`); rendering bares it where it must. */
  readonly handle: string;
  readonly title: string;
}

/**
 * The compiler's apology for a task no selected criterion maps to. The graph
 * vocabulary replaces it with an explicitly typed integration context, so the
 * importer omits the line and the parity harness classifies its absence.
 */
export const LEGACY_UNMAPPED_CRITERION_NOTICE =
  "- No selected criterion is directly mapped to this prerequisite task.";

/**
 * The compiler's context-level preamble, which exists because a compiled
 * context's contract was a union assembled from whichever tasks happened to be
 * grouped into it. An authored plan states its contract directly, so the
 * preamble has nothing left to warn about.
 */
export const LEGACY_GROUP_ACCEPTANCE_CRITERIA =
  "Validate the locked criterion briefs of every task currently assigned to this context. The effective contract is the union of those task briefs; regrouping must never drop or weaken one.";

export function legacyCriterionBrief(
  criteria: readonly LegacyRenderCriterion[],
): string {
  if (criteria.length === 0) {
    return "Verify the approved task instructions are complete without expanding the pinned execution scope.";
  }
  return [
    "Validate only these approved acceptance criteria:",
    ...criteria.flatMap((criterion) => [
      `- ${criterion.handle}: ${criterion.text}`,
      `  Required evidence: ${requiredKinds(criterion.validationStrategy)}`,
      `  Approved strategy note: ${strategyNote(criterion.validationStrategy)}`,
    ]),
  ].join("\n");
}

export interface LegacyTaskInstructionsInput {
  readonly task: LegacyRenderTask & { readonly instructions: string };
  readonly requirements: readonly LegacyRenderRequirement[];
  readonly criteria: readonly LegacyRenderCriterion[];
  readonly decisions: readonly LegacyRenderDecision[];
  /**
   * Whether a criterion-less task still gets the compiler's apology line.
   * `keep` reproduces the compiled bytes; `omit` is the importer's, because the
   * plan says the same thing structurally with a typed context.
   */
  readonly unmappedCriterionNotice: "keep" | "omit";
}

export function legacyTaskInstructions(
  input: LegacyTaskInstructionsInput,
): string {
  const criteriaLines =
    input.criteria.length === 0
      ? input.unmappedCriterionNotice === "keep"
        ? [LEGACY_UNMAPPED_CRITERION_NOTICE]
        : []
      : input.criteria.flatMap((criterion) => [
          `- ${criterion.handle}: ${criterion.text}`,
          `  Required evidence: ${requiredKinds(criterion.validationStrategy)}`,
          `  Approved strategy note: ${strategyNote(criterion.validationStrategy)}`,
        ]);
  return [
    `Approved task ${input.task.handle}`,
    "",
    input.task.instructions,
    "",
    "Narrow context pack",
    "Requirements:",
    ...input.requirements.map(
      (requirement) => `- ${requirement.handle}: ${requirement.statement}`,
    ),
    ...(input.decisions.length === 0
      ? []
      : [
          "Approved decisions:",
          ...input.decisions.flatMap((decision) => [
            `- ${decision.handle}: ${decision.title}`,
            `  Chosen approach: ${decision.chosenApproach}`,
            `  Reason: ${decision.reason}`,
          ]),
        ]),
    "Acceptance criteria and required validation:",
    ...criteriaLines,
  ].join("\n");
}

export interface LegacyContextTitleInput {
  readonly laneGroup: string | undefined;
  /** Members in their compiled order; the first names a singleton context. */
  readonly members: readonly LegacyRenderTask[];
  /** Used when a group carries no member to name it after. */
  readonly fallbackId: string;
}

export function legacyContextTitle(input: LegacyContextTitleInput): string {
  const memberHandles = input.members.map((member) =>
    bareHandle(member.handle),
  );
  if (input.laneGroup !== undefined) {
    return `${input.laneGroup} — ${memberHandles.join(", ")}`;
  }
  const member = input.members[0];
  if (member === undefined) return input.fallbackId;
  return `${bareHandle(member.handle)} — ${member.title}`;
}

export function bareHandle(handle: string): string {
  return handle.slice(handle.lastIndexOf("/") + 1);
}

function strategyNote(strategy: ValidationStrategy): string {
  return strategy.note ?? "No additional strategy note was approved.";
}

function requiredKinds(strategy: ValidationStrategy): string {
  return strategy.kinds.length === 0
    ? "none declared"
    : strategy.kinds.join(", ");
}
