/**
 * Dropping a context on another lane (README §2.1) — the one semantic edit a
 * canvas drag may make.
 *
 * The rule the module exists to hold: a cross-lane drop writes EXACTLY
 * `placement.lane` on the dragged context and nothing else. Grade and owned
 * paths ride across verbatim, so there is no silent re-grading and no path
 * rewriting; a within-lane drag never reaches here at all, because it is layout.
 *
 * Acceptance is decided by `validateAuthoredDefinition` — the same accept-time
 * gate the CLI and the save path use — asked of the POST-DROP draft. Two kinds
 * of issue in that result refuse the drop: any issue the drop INTRODUCED, and
 * any PLACEMENT issue the post-drop draft raises against the dragged context,
 * pre-existing or not. The second is what makes the gesture answerable for the
 * field it writes: a read-only context with no output contract is invalidly
 * placed wherever it lands, and accepting the drop because the same complaint
 * pre-dated the drag would leave the author with a placement the save path will
 * refuse and no word about why. Everything else a mid-authoring draft is wrong
 * about (an empty acceptance criterion, a half-typed task) is none of the drop's
 * business — refusing every drag until the whole draft is savable would make the
 * gesture unusable exactly when an author is using it to fix the draft.
 *
 * The copy is the design's: each refusal states the concrete reason and the
 * remedy. Where a refusal is about the dragged context alone the sentence is
 * composed from its own placement; where it is about a PAIR of members the
 * validator's message is carried verbatim, because it is the owner of which
 * members clash and over which paths.
 */

import type {
  ContextPlacement,
  GraphWorkflowExecutionContextDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  laneIdViolation,
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "./lane-identity";
import { validateAuthoredDefinition } from "./validation";

export interface LaneDropInput {
  readonly definition: WorkflowSemanticDefinition;
  readonly contextId: string;
  readonly targetLane: string;
}

export type LaneDropEvaluation =
  | { readonly outcome: "unchanged"; readonly previewLabel: string }
  | {
      readonly outcome: "accepted";
      readonly previewLabel: string;
      /** The post-drop draft, ready to become the store's draft definition. */
      readonly definition: WorkflowSemanticDefinition;
      /**
       * A legal-but-notable consequence of the accepted placement, e.g. a full
       * member that will wait for exclusive occupancy of its lane.
       */
      readonly notice: string | null;
    }
  | {
      readonly outcome: "refused";
      readonly previewLabel: string;
      readonly reason: string;
      readonly remedy: string;
      readonly issues: readonly WorkflowGraphValidationError[];
    };

/**
 * How the preview spells a grade (README §2.1:
 * `grade: owned (src/checkout, src/risk) · unchanged`). Deliberately the
 * AUTHORED vocabulary rather than the node chip's prose label — the preview
 * names the field value that is being carried across, and `read-only` is the
 * one grade whose authored spelling no surface shows in camel case.
 */
const PREVIEW_GRADE: Record<ContextPlacement["mode"], string> = {
  full: "full",
  owned: "owned",
  readOnly: "read-only",
};

/** How a refusal describes the grade a context carries onto a lane. */
const REFUSAL_GRADE: Record<ContextPlacement["mode"], string> = {
  full: "full-access",
  owned: "owning",
  readOnly: "read-only",
};

function findContext(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): GraphWorkflowExecutionContextDefinition | undefined {
  return definition.executionContexts.find(
    (context) => context.id === contextId,
  );
}

function ownedPathsText(placement: ContextPlacement): string {
  return placement.mode === "owned" ? placement.ownedPaths.join(", ") : "";
}

function previewLabelFor(
  placement: ContextPlacement,
  targetLane: string,
): string {
  const paths = ownedPathsText(placement);
  const grade = paths
    ? `${PREVIEW_GRADE[placement.mode]} (${paths})`
    : PREVIEW_GRADE[placement.mode];
  return `Re-place → lane: ${targetLane} · grade: ${grade} · unchanged`;
}

/**
 * The pill shown above the dragged node while it hovers another band. Exported
 * on its own because the preview appears BEFORE a drop is attempted, and it
 * describes the pending change whether or not the check will pass.
 */
export function laneDropPreviewLabel(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  targetLane: string,
): string {
  const placement = findContext(definition, contextId)?.placement;
  return placement === undefined
    ? `Re-place → lane: ${targetLane}`
    : previewLabelFor(placement, targetLane);
}

/** The post-drop draft: one context's `placement.lane`, nothing else. */
function withLane(
  definition: WorkflowSemanticDefinition,
  contextId: string,
  lane: string,
): WorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      context.id === contextId && context.placement
        ? { ...context, placement: { ...context.placement, lane } }
        : context,
    ),
  };
}

function issueKey(issue: WorkflowGraphValidationError): string {
  return [
    issue.code,
    issue.contextId ?? "",
    issue.field ?? "",
    issue.message,
  ].join("\u0000");
}

/**
 * A placement check is the drop's own subject, so its verdict counts against the
 * gesture however long it has stood. Matched by code prefix rather than by an
 * enumerated list so a placement check added later refuses by default instead of
 * being silently waved through.
 */
function isPlacementIssue(issue: WorkflowGraphValidationError): boolean {
  return issue.code.startsWith("placement-");
}

function disqualifyingIssues(
  before: WorkflowSemanticDefinition,
  after: WorkflowSemanticDefinition,
  contextId: string,
): WorkflowGraphValidationError[] {
  const known = new Set(
    validateAuthoredDefinition(before).errors.map(issueKey),
  );
  return validateAuthoredDefinition(after).errors.filter(
    (issue) =>
      !known.has(issueKey(issue)) ||
      (isPlacementIssue(issue) && issue.contextId === contextId),
  );
}

interface Refusal {
  reason: string;
  remedy: string;
}

function refusalFor(
  issue: WorkflowGraphValidationError,
  context: GraphWorkflowExecutionContextDefinition,
  placement: ContextPlacement,
  targetLane: string,
): Refusal {
  const paths = ownedPathsText(placement);
  const carried = paths
    ? `${REFUSAL_GRADE[placement.mode]} (${paths})`
    : REFUSAL_GRADE[placement.mode];

  switch (issue.code) {
    case "placement-session-lane-write-capable":
      return {
        reason: `"${SESSION_LANE_NAME}" admits only read-only contexts. "${context.title}" is ${carried}.`,
        remedy: "Change its grade to read-only, or drop it on a group lane.",
      };
    case "placement-reserved-lane-name":
      return {
        reason: `"${SESSION_LANE_ID}" is the engine's internal id for the session lane, never an authored lane name.`,
        remedy: `Author the session lane as "${SESSION_LANE_NAME}".`,
      };
    case "placement-lane-name-invalid":
      return {
        reason: `"${targetLane}" is not a legal lane name: it ${laneIdViolation(targetLane) ?? "is not accepted here"}.`,
        remedy:
          "Lane names become branch and worktree path segments — use letters, digits, and the separators _ . and -.",
      };
    case "placement-readonly-missing-output-schema":
      return {
        reason: `"${context.title}" is read-only, and a read-only context delivers exclusively through its output contract — it declares none, so it is invalidly placed on any lane.`,
        remedy:
          "Declare an outputSchema on its Schema screen, or give it a write-capable grade.",
      };
    case "placement-owned-paths-overlap":
      return {
        reason: issue.message,
        remedy:
          "Give the two members disjoint owned paths, or add a dependency edge so one runs after the other.",
      };
    case "placement-full-access-concurrency":
      return {
        reason: issue.message,
        remedy:
          "Add a dependency edge between them, or give the full-access member owned paths.",
      };
    default:
      return {
        reason: issue.message,
        remedy: `Change the placement on the Placement screen, or leave "${context.title}" on lane ${placement.lane}.`,
      };
  }
}

/**
 * The full-access member's cost, said where it bites (README §4): a full member
 * needs its lane to itself, so a lane that holds one alongside any other
 * write-capable member runs them in sequence. Legal — and worth saying at the
 * moment the second member lands there.
 */
function occupancyNotice(
  definition: WorkflowSemanticDefinition,
  lane: string,
): string | null {
  const writeCapable = definition.executionContexts.filter(
    (context) =>
      context.placement?.lane === lane && context.placement.mode !== "readOnly",
  );
  if (writeCapable.length < 2) return null;

  const exclusive = writeCapable.filter(
    (context) => context.placement?.mode === "full",
  );
  if (exclusive.length === 0) return null;

  const names = exclusive.map((context) => `"${context.title}"`).join(" and ");
  return `${names} ${exclusive.length > 1 ? "each need" : "needs"} exclusive occupancy of lane ${lane}, so ${exclusive.length > 1 ? "they wait" : "it waits"} while the lane's other write-capable members run.`;
}

export function evaluateLaneDrop(input: LaneDropInput): LaneDropEvaluation {
  const { definition, contextId, targetLane } = input;
  const previewLabel = laneDropPreviewLabel(definition, contextId, targetLane);
  const context = findContext(definition, contextId);

  if (!context) {
    return {
      outcome: "refused",
      previewLabel,
      reason: "This context is no longer in the draft.",
      remedy: "Reload the workflow and try the drag again.",
      issues: [],
    };
  }

  const placement = context.placement;
  if (!placement) {
    return {
      outcome: "refused",
      previewLabel,
      reason: `"${context.title}" declares no placement, so there is no lane to re-place.`,
      remedy: "Give it a placement on the Placement screen first.",
      issues: [],
    };
  }

  if (placement.lane === targetLane) {
    return { outcome: "unchanged", previewLabel };
  }

  const dropped = withLane(definition, contextId, targetLane);
  const disqualifying = disqualifyingIssues(definition, dropped, contextId);

  // The dragged context's own issue is the one the author can act on from
  // here; a pair-wise issue names it as either member, so preferring it
  // keeps the sentence about the gesture that was just made.
  const issue =
    disqualifying.find((candidate) => candidate.contextId === contextId) ??
    disqualifying[0];

  if (issue !== undefined) {
    return {
      outcome: "refused",
      previewLabel,
      ...refusalFor(issue, context, placement, targetLane),
      issues: disqualifying,
    };
  }

  return {
    outcome: "accepted",
    previewLabel,
    definition: dropped,
    notice: occupancyNotice(dropped, targetLane),
  };
}
