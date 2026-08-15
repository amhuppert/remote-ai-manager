/**
 * The mechanical whole-run proof behind the dirty-worktree exemption (R8, D10).
 *
 * A plan may launch over uncommitted work only when the engine can PROVE the
 * run never writes the repository. Prose cannot prove that and neither can the
 * plan's origin, so the question is asked of the fully resolved definition and
 * quantifies over exactly the three properties the engine already enforces per
 * context:
 *  - placement is `{lane: "session", mode: "readOnly"}` — the session worktree
 *    itself, provisioning no lane, planning no join, landing nothing, and
 *    composing a write envelope of scratch-plus-tmp with the git directory
 *    denied;
 *  - the cascade-resolved script-validator selection is empty — a registered
 *    command is arbitrary shell, so one selected command falsifies the claim;
 *  - the cascade-resolved collaboration block is disabled — a collaborator turn
 *    dispatches write-capable in the execution worktree, which no envelope here
 *    confines.
 *
 * Loop bodies are quantified over too: a pass unrolls its group's template, so
 * a write-capable template context is a write-capable run one pass later.
 *
 * Every judgement is FAIL-CLOSED. A member whose resolution left out the field
 * the proof reads is unsafe, not exempt: an absent collaboration snapshot means
 * the run would fall back to reloading the saved definition, and an absent
 * placement means nothing declares where the context runs. The exemption is a
 * proof obligation, and an unanswerable question is not a proof.
 *
 * The same verdict is asked twice, which is why both forms live here: the
 * launch guard wants the boolean (D10's eligibility check, short-circuiting on
 * the first unsafe member), and the live-edit frontier wants located issues so
 * an operator, an expanding agent, or a repair agent learns WHICH context its
 * mutation would have made write-capable. One per-member rule, two callers.
 */

import type {
  ContextPlacement,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import { SESSION_LANE_NAME } from "./lane-identity";

/**
 * The slice of a resolved context this proof reads, structural so every
 * resolved tier satisfies it: the cascade result the launch guard evaluates and
 * the seeded working-definition context the frontier re-evaluates.
 *
 * Each field is optional because a resolved context need not carry it, and the
 * absence itself is a judgement this module makes rather than a shape it
 * refuses.
 */
export interface LiveSessionReadOnlyContext {
  readonly id: string;
  readonly placement?: ContextPlacement | undefined;
  readonly scriptValidator?:
    | { readonly commands: readonly string[] }
    | undefined;
  readonly collaboration?:
    | { readonly enabled: { readonly value: boolean } }
    | undefined;
}

export interface LiveSessionReadOnlyLoopGroup {
  readonly template: {
    readonly contexts: readonly LiveSessionReadOnlyContext[];
  };
}

export interface LiveSessionReadOnlyDefinition {
  readonly executionContexts: readonly LiveSessionReadOnlyContext[];
  readonly loopGroups?: readonly LiveSessionReadOnlyLoopGroup[] | undefined;
}

/**
 * The one per-member rule. Returns the reason this member cannot be part of a
 * mechanically read-only run, or `null` when it can.
 *
 * `fieldPrefix` is the definition-relative path of the member itself, so the
 * issue points into the top-level context array or into the loop group's
 * template with the same code either way.
 */
function judgeMember(
  context: LiveSessionReadOnlyContext,
  fieldPrefix: string,
): WorkflowGraphValidationError | null {
  const { placement } = context;
  if (placement === undefined) {
    return {
      code: "live-session-read-only-placement",
      message: `Context "${context.id}" declares no placement, so this run cannot be proven to run read-only on the session worktree`,
      contextId: context.id,
      field: `${fieldPrefix}.placement`,
    };
  }
  if (placement.lane !== SESSION_LANE_NAME || placement.mode !== "readOnly") {
    return {
      code: "live-session-read-only-placement",
      message: `Context "${context.id}" is placed on lane "${placement.lane}" with mode "${placement.mode}"; a run that may execute over uncommitted changes admits only read-only contexts on the "${SESSION_LANE_NAME}" lane`,
      contextId: context.id,
      field: `${fieldPrefix}.placement`,
    };
  }

  const commands = context.scriptValidator?.commands ?? [];
  if (commands.length > 0) {
    return {
      code: "live-session-read-only-script-validator",
      message: `Context "${context.id}" selects script validation command(s) ${commands
        .map((command) => `"${command}"`)
        .join(
          ", ",
        )}; a registered command is arbitrary shell, so it cannot be proven read-only`,
      contextId: context.id,
      field: `${fieldPrefix}.scriptValidator.commands`,
    };
  }

  // Fail-closed on an absent snapshot: a context with no resolved
  // collaboration block would resolve one from the saved definition at dispatch
  // time, and a collaborator turn runs write-capable in the execution worktree.
  if (context.collaboration?.enabled.value !== false) {
    return {
      code: "live-session-read-only-collaboration",
      message: `Context "${context.id}" does not have collaboration resolved to disabled; a collaborator turn runs write-capable in the execution worktree`,
      contextId: context.id,
      field: `${fieldPrefix}.collaboration.enabled`,
    };
  }

  return null;
}

/**
 * Every member of the run, paired with its definition-relative path: the
 * top-level contexts followed by each loop group's template body. Generated so
 * the boolean form can stop at the first unsafe member without judging — or
 * even reading — the rest.
 */
function* runMembers(
  definition: LiveSessionReadOnlyDefinition,
): Generator<{ context: LiveSessionReadOnlyContext; fieldPrefix: string }> {
  for (const [index, context] of definition.executionContexts.entries()) {
    yield { context, fieldPrefix: `executionContexts.${index}` };
  }
  for (const [groupIndex, group] of (definition.loopGroups ?? []).entries()) {
    for (const [index, context] of group.template.contexts.entries()) {
      yield {
        context,
        fieldPrefix: `loopGroups.${groupIndex}.template.contexts.${index}`,
      };
    }
  }
}

/**
 * Whether the whole resolved run provably executes against the live session
 * worktree with no repository write surface — the dirty-worktree exemption's
 * eligibility question (R8.1, R8.2), and the invariant a pinned execution keeps
 * for its whole lifetime (R8.3).
 */
export function isWholeRunLiveSessionReadOnly(
  definition: LiveSessionReadOnlyDefinition,
): boolean {
  for (const { context, fieldPrefix } of runMembers(definition)) {
    if (judgeMember(context, fieldPrefix) !== null) return false;
  }
  return true;
}

/**
 * The same verdict as located issues, one per unsafe member, for the frontier
 * that has to tell a caller which context its mutation would have made
 * write-capable.
 */
export function collectLiveSessionReadOnlyViolations(
  definition: LiveSessionReadOnlyDefinition,
): WorkflowGraphValidationError[] {
  const issues: WorkflowGraphValidationError[] = [];
  for (const { context, fieldPrefix } of runMembers(definition)) {
    const issue = judgeMember(context, fieldPrefix);
    if (issue !== null) issues.push(issue);
  }
  return issues;
}
