import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsActionableGate } from "@/lib/workflow-graph/lifecycle-classifier";
import { unansweredPendingUserInputs } from "@/lib/workflow-graph/pending-user-input";
import { deriveJoinConflictSummary } from "@/components/workflow-graph/join-conflict-summary";

/**
 * Everything on this run that is waiting on the human, as one list.
 *
 * README §10 is explicit that there is no single global gate: a context
 * approval and a parked question are separate waits on separate contexts, and
 * the Overview surfaces them as rows that each name their own context. This is
 * the seam the gates-and-recovery surface builds its list from, and the same
 * derivation the Overview's Gates row counts — one owner, so the count and the
 * list cannot disagree.
 *
 * Tenure decides whether a wait is a gate at all: a park on a run that can
 * never continue is a question nobody can answer, so it goes through
 * `holdsActionableGate` exactly as the answer panels do.
 */

export type ExecutionGateKind = "approval" | "question" | "join";

export interface ExecutionGate {
  kind: ExecutionGateKind;
  /**
   * The context this gate is answered on. Null only on a join gate whose frozen
   * roster cannot name the blocked member — the join is the subject there, and
   * the row names the lane instead of inventing a destination.
   */
  contextId: string | null;
  contextTitle: string;
  /** Set on a join gate: the join the conflict belongs to. */
  joinId?: string;
  /**
   * The asking lane of a question gate (`implementer`,
   * `context_validator:<assignmentId>`); absent on an approval gate, which is
   * held by the context rather than by one of its lanes.
   */
  laneKey?: string;
  /**
   * What this gate is waiting for, in the operator's words — the row's own
   * sentence, kind included, so the list never has to re-spell a gate kind
   * that the derivation already knows.
   */
  detail: string;
}

/**
 * The conflicted join as a gate row (README §11: join conflicts reach both the
 * lane rail's join card and this list).
 *
 * A failed join is a wait on the human just like an approval — nothing on the
 * run advances until someone resolves the merge — so it belongs in the one list
 * of everything waiting. `deriveJoinConflictSummary` stays the owner of WHICH
 * member is blocked and why; this only phrases the row, so the gate row and the
 * recovery card can never name different members.
 */
function joinGates(execution: GraphWorkflowExecution): ExecutionGate[] {
  const reason = execution.haltReason;
  if (reason === null) return [];
  const summary = deriveJoinConflictSummary(execution, reason);
  if (summary === null) return [];

  // The summary owns which member is the subject. Reading it from the roster
  // here instead would let this row name one context and open another, since
  // the blocked LANE can carry several. The title already falls back to the
  // lane id when the roster cannot name a context, which is the honest subject
  // for a join nobody can attribute.
  const blocked = summary.blockedMember;
  const subject = blocked?.title ?? summary.laneLabel;
  const cause = blocked?.detail ? `: ${blocked.detail}` : "";

  return [
    {
      kind: "join",
      joinId: summary.joinId,
      contextId: blocked?.contextId ?? null,
      contextTitle: subject,
      detail: `join conflict · merging into ${summary.laneLabel} · ${subject} blocked${cause}`,
    },
  ];
}

export function deriveExecutionGates(
  execution: GraphWorkflowExecution,
): ExecutionGate[] {
  if (
    !holdsActionableGate(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    )
  ) {
    return [];
  }

  return [
    ...joinGates(execution),
    ...execution.workingDefinition.executionContexts.flatMap(
      (context): ExecutionGate[] => {
        const state = execution.contextStates[context.id];
        if (!state) return [];

        // A pending record still awaiting a decision, not the status alone: a
        // decided gate keeps the status until orchestration moves on, and a row
        // for it would offer a decision that has already been made.
        if (
          state.status === "awaiting_approval" &&
          state.pendingApproval !== null &&
          state.pendingApproval.decision === null
        ) {
          return [
            {
              kind: "approval",
              contextId: context.id,
              contextTitle: context.title,
              detail: `context approval · iteration ${state.iterationCount} candidate`,
            },
          ];
        }

        if (state.status !== "awaiting_user_input") return [];
        return unansweredPendingUserInputs(state).map((entry) => ({
          kind: "question" as const,
          contextId: context.id,
          contextTitle: context.title,
          laneKey: entry.laneKey,
          detail: `parked question · ${
            entry.record.questions.length === 1
              ? `"${entry.record.questions[0]?.question ?? "awaiting your answer"}"`
              : `${entry.record.questions.length} questions awaiting you`
          }`,
        }));
      },
    ),
  ];
}
