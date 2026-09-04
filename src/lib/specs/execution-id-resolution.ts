import type { BoundSpecExecutionReaders } from "./execution-service";
import type { SpecExecutionRow } from "./schemas";
import type { TransitionRefusal } from "./transitions";

export type ResolvedSpecExecutionId =
  | { readonly ok: true; readonly execution: SpecExecutionRow }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

/**
 * The one place a caller-supplied execution id becomes a spec execution row
 * (design 3.5, decision D-B).
 *
 * Agents hold exactly one execution id — the workflow execution id every
 * `cctl workflow` verb takes — so this accepts that id and nothing else. The
 * spec-side row id is internal, and a verb that quietly accepted both would
 * put an agent back in the position I-6 describes: two ids on screen, no way
 * to tell which one the next command wants. It is therefore refused with its
 * own code, and the refusal hands back the id that works rather than only
 * naming the mistake.
 */
export function resolveSpecExecutionByWorkflowId(
  readers: BoundSpecExecutionReaders,
  workflowExecutionId: string,
): ResolvedSpecExecutionId {
  const binding =
    readers.bindingRepo.findByWorkflowExecutionId(workflowExecutionId);
  if (binding !== null) {
    const linked =
      readers.bindingRepo.requireByWorkflowExecutionId(workflowExecutionId);
    const execution = readers.deliveryRepo.findExecutionById(
      linked.specExecutionId,
    );
    if (execution !== null) return { ok: true, execution };
  }
  const specSide = readers.deliveryRepo.findExecutionById(workflowExecutionId);
  if (specSide !== null) return { ok: false, refusal: specSideId(specSide) };
  return {
    ok: false,
    refusal: {
      code: "not_found",
      unmetConditions: [
        `No spec delivery is bound to workflow execution ${workflowExecutionId}.`,
      ],
      instruction:
        "Read the run's id from the `cctl spec start` receipt, or from `cctl spec status <slug>`.",
    },
  };
}

function specSideId(execution: SpecExecutionRow): TransitionRefusal {
  const bound = execution.workflow_execution_id;
  return {
    code: "spec_side_execution_id",
    unmetConditions: [
      `${execution.id} is the internal spec execution row id, not a workflow execution id.`,
    ],
    instruction:
      bound === null
        ? `Spec execution ${execution.id} has no workflow execution to address. Read \`cctl spec status\` for a run that has one.`
        : `Pass the workflow execution id instead: ${bound}.`,
  };
}
