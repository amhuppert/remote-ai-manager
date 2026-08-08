/**
 * Accept-time checks on authored lane placement (R1, R4, R5).
 *
 * The Zod schema owns placement's SHAPE — the grade discriminator, the
 * non-empty owned-prefix set, and each prefix's normalization. What it cannot
 * own is anything that needs the surrounding definition: which lane names are
 * reserved, whether a read-only context declared the output contract that is
 * its only delivery channel, and which same-lane pairs could ever run at the
 * same time. Those live here, in the composite the authoring surfaces
 * (`cctl workflow validate`, create, replace, and the saved-edit applier) all
 * reach through `validateAuthoredDefinition`, so no surface can miss them.
 *
 * Every check reports through the located `WorkflowGraphValidationError` shape:
 * the offending context id plus a definition-relative field path, which
 * `plan-validation.ts` renders as a JSON path into the submitted body.
 *
 * These are LEXICAL checks over declared strings. The runtime counterpart — a
 * symlink-resolved canonical disjointness re-check before two members are
 * admitted concurrently — is deliberately elsewhere: two prefixes that look
 * distinct here can still resolve into one another on disk, and only the
 * scheduler can see that.
 */

import type {
  ContextPlacement,
  GraphWorkflowContextEdge,
  GraphWorkflowExecutionContextDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  laneIdViolation,
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "./lane-identity";

/** A placement that may write: everything except the read-only grade. */
function isWriteCapable(placement: ContextPlacement): boolean {
  return placement.mode !== "readOnly";
}

function ownedPathsOf(placement: ContextPlacement): readonly string[] {
  return placement.mode === "owned" ? placement.ownedPaths : [];
}

/**
 * Whether `outer` covers `inner` — the prefix semantics an ownership entry
 * declares: an entry covers itself and everything beneath it. Compared at
 * segment boundaries so `src/lib` does not swallow the sibling `src/libraries`.
 */
function covers(outer: string, inner: string): boolean {
  return outer === inner || inner.startsWith(`${outer}/`);
}

function prefixesOverlap(left: string, right: string): boolean {
  return covers(left, right) || covers(right, left);
}

/**
 * The lane-name grammar, the session lane's read-only restriction, and the
 * read-only output contract — everything decidable from one context alone.
 */
function validateContextPlacement(
  context: GraphWorkflowExecutionContextDefinition,
  contextIndex: number,
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const { placement } = context;
  const laneField = `executionContexts.${contextIndex}.placement.lane`;

  if (placement.lane === SESSION_LANE_ID) {
    errors.push({
      code: "placement-reserved-lane-name",
      message: `Context "${context.id}" places itself on "${SESSION_LANE_ID}", which is the engine's internal id for the session lane; author the session lane as "${SESSION_LANE_NAME}"`,
      contextId: context.id,
      field: laneField,
    });
  } else if (placement.lane === SESSION_LANE_NAME) {
    // The session lane is the session worktree itself: it is never provisioned
    // as a group lane and never lands through a join, so a write-capable member
    // there would have no gate to publish through.
    if (isWriteCapable(placement)) {
      errors.push({
        code: "placement-session-lane-write-capable",
        message: `Context "${context.id}" is write-capable (mode "${placement.mode}") on the reserved lane "${SESSION_LANE_NAME}", which admits only read-only contexts; place write-capable work on a group lane`,
        contextId: context.id,
        field: laneField,
      });
    }
  } else {
    const violation = laneIdViolation(placement.lane);
    if (violation !== null) {
      errors.push({
        code: "placement-lane-name-invalid",
        message: `Context "${context.id}" declares lane "${placement.lane}", which is not a legal lane name: it ${violation}. Lane names become branch and worktree path segments`,
        contextId: context.id,
        field: laneField,
      });
    }
  }

  // Structured outputs are a read-only context's ONLY delivery channel — it
  // produces no landing commit and no join — so an undeclared output contract
  // makes the context unable to deliver anything at all.
  if (placement.mode === "readOnly" && context.outputSchema === undefined) {
    errors.push({
      code: "placement-readonly-missing-output-schema",
      message: `Read-only context "${context.id}" declares no outputSchema; a read-only context delivers its results exclusively through structured context outputs, so an output contract is required`,
      contextId: context.id,
      field: `executionContexts.${contextIndex}.outputSchema`,
    });
  }

  return errors;
}

/**
 * The contexts reachable from each context by following dependency edges.
 *
 * Guarded (conditional) edges count as ordering: if the guard declines, the
 * target is skipped and never runs at all, so treating every declared edge as a
 * dependency is exact rather than merely conservative.
 */
function buildReachability(
  contexts: readonly GraphWorkflowExecutionContextDefinition[],
  edges: readonly GraphWorkflowContextEdge[],
): Map<string, Set<string>> {
  const adjacency = new Map<string, string[]>();
  for (const context of contexts) adjacency.set(context.id, []);
  for (const edge of edges) {
    adjacency.get(edge.sourceContextId)?.push(edge.targetContextId);
  }

  const reachable = new Map<string, Set<string>>();
  for (const context of contexts) {
    const seen = new Set<string>();
    const stack = [...(adjacency.get(context.id) ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(adjacency.get(next) ?? []));
    }
    reachable.set(context.id, seen);
  }
  return reachable;
}

/**
 * Pairwise ownership disjointness for same-lane members that could run at the
 * same time (R5).
 *
 * Two members of one lane share one worktree. Concurrency-comparable means
 * neither depends on the other transitively, so nothing sequences their turns
 * and both could hold the worktree at once. The rule follows directly: a
 * full-access member has no declared surface to be disjoint FROM, so it needs
 * the lane to itself; two owning members are safe exactly when their prefix
 * sets do not touch. Read-only members are exempt — they write nothing in the
 * worktree, so they collide with no one.
 *
 * Dependency-ordered members may share paths freely: that is the ordinary
 * hand-off inside a lane, and it is the reason ordering is checked rather than
 * ownership alone.
 */
function validateLaneConcurrency(
  definition: WorkflowSemanticDefinition,
): WorkflowGraphValidationError[] {
  const contexts = definition.executionContexts;
  const reachable = buildReachability(contexts, definition.edges);

  interface LaneMember {
    context: GraphWorkflowExecutionContextDefinition;
    index: number;
  }
  const membersByLane = new Map<string, LaneMember[]>();
  contexts.forEach((context, index) => {
    if (!isWriteCapable(context.placement)) return;
    const members = membersByLane.get(context.placement.lane) ?? [];
    members.push({ context, index });
    membersByLane.set(context.placement.lane, members);
  });

  const errors: WorkflowGraphValidationError[] = [];
  for (const members of membersByLane.values()) {
    members.forEach(({ context: left, index: leftIndex }, position) => {
      for (const { context: right } of members.slice(position + 1)) {
        const ordered =
          reachable.get(left.id)?.has(right.id) === true ||
          reachable.get(right.id)?.has(left.id) === true;
        if (ordered) continue;

        const field = `executionContexts.${leftIndex}.placement`;
        const unowned = [left, right].filter(
          (member) => member.placement.mode === "full",
        );
        if (unowned.length > 0) {
          errors.push({
            code: "placement-full-access-concurrency",
            message: `Contexts "${left.id}" and "${right.id}" are both write-capable on lane "${left.placement.lane}" with no dependency path between them, and ${unowned
              .map((member) => `"${member.id}"`)
              .join(
                " and ",
              )} declares full access; a full-access member must be dependency-ordered against every other write-capable member of its lane, or declare ownedPaths`,
            contextId: left.id,
            field,
          });
          continue;
        }

        const overlaps = ownedPathsOf(left.placement).flatMap((leftPath) =>
          ownedPathsOf(right.placement)
            .filter((rightPath) => prefixesOverlap(leftPath, rightPath))
            .map((rightPath) => `"${leftPath}" and "${rightPath}"`),
        );
        if (overlaps.length > 0) {
          errors.push({
            code: "placement-owned-paths-overlap",
            message: `Contexts "${left.id}" and "${right.id}" can run concurrently on lane "${left.placement.lane}" but claim overlapping owned paths (${overlaps.join(
              ", ",
            )}); concurrent same-lane members must own pairwise-disjoint prefixes, or be dependency-ordered`,
            contextId: left.id,
            field,
          });
        }
      }
    });
  }
  return errors;
}

/**
 * Every placement check an authored definition must pass, in one call so the
 * authoring composite has a single line to compose.
 */
export function validatePlacements(
  definition: WorkflowSemanticDefinition,
): WorkflowGraphValidationError[] {
  return [
    ...definition.executionContexts.flatMap((context, index) =>
      validateContextPlacement(context, index),
    ),
    ...validateLaneConcurrency(definition),
  ];
}
