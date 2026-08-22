import type { GraphWorkflowTaskDefinition } from "@/lib/workflow-graph/definition-schemas";
import { createTaskId } from "@/lib/workflow-graph/builder-draft";
import {
  criterionRecordsOf,
  type CriterionRecord,
} from "@/lib/workflow-graph/criteria/criterion-records";

/**
 * The ordered-collection edits the structural screens share: acceptance
 * criteria and tasks are both author-ordered lists with move / remove / add,
 * and both are edited by handing the host a whole new array.
 *
 * Pure and immutable on purpose — the host stores hold the draft, so an
 * in-place splice would mutate state React never saw change, and the builder's
 * dirty tracking would miss the edit.
 */

export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = [...items];
  const moved = next[from];
  if (from === to || moved === undefined || to < 0 || to >= next.length) {
    return next;
  }
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeItem<T>(items: readonly T[], index: number): T[] {
  return items.filter((_unused, at) => at !== index);
}

/**
 * A fresh `ac-N` that no existing criterion holds. Ids are cited verbatim in
 * validator verdicts, so reusing one a removed criterion had would silently
 * re-point every stored citation at different prose — the counter walks past
 * taken ids rather than keying off the list length.
 */
export function nextCriterionId(existing: readonly CriterionRecord[]): string {
  const taken = new Set(existing.map((record) => record.id));
  let index = existing.length + 1;
  while (taken.has(`ac-${index}`)) index += 1;
  return `ac-${index}`;
}

/**
 * The context's criteria as records, whatever it stores. Legacy prose parses as
 * one record (`ac-1`) through the schema module's own normalizer, so editing a
 * prose context canonicalizes it exactly the way the accept paths would.
 */
export function criteriaRecords(
  criteria: string | readonly CriterionRecord[],
): CriterionRecord[] {
  return criterionRecordsOf(criteria);
}

/**
 * `order` is what the implementer is dispatched against, so it has to stay a
 * contiguous 1..N run over the array's own sequence — a move or a remove that
 * left a gap would dispatch against a position no task holds.
 */
export function renumberTasks(
  tasks: readonly GraphWorkflowTaskDefinition[],
): GraphWorkflowTaskDefinition[] {
  return tasks.map((task, index) => ({ ...task, order: index + 1 }));
}

/**
 * A task id no task ANYWHERE in the workflow holds.
 *
 * Task ids are unique across the whole definition, not per context
 * (`duplicate-task-id` in `workflow-graph/validation.ts`), so `takenIds` is
 * every task id in the workflow: a counter over one context's own tasks would
 * hand `context-1` the id `context-2` already uses and Save would refuse the
 * definition. The shape comes from the builder's allocator so both authoring
 * surfaces mint the same thing.
 */
export function nextTaskId(
  contextId: string,
  order: number,
  takenIds: readonly string[],
): string {
  const taken = new Set(takenIds);
  let candidate = order;
  while (taken.has(createTaskId(contextId, candidate))) candidate += 1;
  return createTaskId(contextId, candidate);
}
