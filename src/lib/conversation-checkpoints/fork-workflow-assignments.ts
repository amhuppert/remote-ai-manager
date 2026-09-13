import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { CheckpointRelatedWork } from "./fork-schemas";
type Work = Extract<CheckpointRelatedWork, { kind: "workflow_assignment" }>;
export type CheckpointAssignmentChoice = Pick<
  Work,
  "owner" | "assignmentId" | "useSite"
> & { id: string; label: string };
export function checkpointAssignmentKey(
  work: Pick<Work, "owner" | "assignmentId" | "useSite">,
): string {
  return JSON.stringify([work.owner, work.useSite, work.assignmentId]);
}
export function checkpointWorkflowAssignments(
  execution: Pick<
    GraphWorkflowExecution,
    "launchDocument" | "workingDefinition"
  >,
): CheckpointAssignmentChoice[] {
  const choices: CheckpointAssignmentChoice[] = [];
  function add(
    owner: Work["owner"],
    title: string,
    config: {
      implementer?: { id: string; focus?: string };
      contextValidator?: {
        enabled: boolean;
        assignments: readonly { id: string; focus?: string }[];
      };
    },
  ) {
    const append = (
      assignment: { id: string; focus?: string },
      useSite: Work["useSite"],
      dormant: boolean,
    ) => {
      const value = { owner, assignmentId: assignment.id, useSite };
      choices.push({
        ...value,
        id: checkpointAssignmentKey(value),
        label: `${title} · ${useSite === "implementer" ? "Implementer" : "Validator"} ${assignment.id}${assignment.focus ? ` · ${assignment.focus}` : ""}${dormant ? " · Disabled cohort" : ""}`,
      });
    };
    if (config.implementer) append(config.implementer, "implementer", false);
    for (const assignment of config.contextValidator?.assignments ?? [])
      append(
        assignment,
        "validator",
        config.contextValidator?.enabled === false,
      );
  }
  const workflow = execution.launchDocument?.definition.workflowConfig;
  if (workflow) add({ kind: "workflow" }, "Workflow", workflow);
  for (const context of execution.workingDefinition.executionContexts)
    add({ kind: "context", contextId: context.id }, context.title, context);
  for (const group of execution.workingDefinition.loopGroups ?? []) {
    for (const context of group.template.contexts)
      add(
        { kind: "loop_template", loopGroupId: group.id, contextId: context.id },
        `${group.id} / ${context.title}`,
        context,
      );
  }
  return choices;
}
