import { toAuthoredAssignment } from "@/lib/workflow-graph/authored-assignment";
import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { ExecutionContextNodeData } from "./derive-graph";

export type NodeAgentTarget =
  | { kind: "implementer" }
  | { kind: "validator"; assignmentId: string };
export type NodeAgentPatch = Pick<
  GraphWorkflowExecutionContextDefinition,
  "implementer" | "contextValidator"
>;

export function nodeAgentPatch(
  context: ExecutionContextNodeData["context"],
  target: NodeAgentTarget,
  agent: GraphWorkflowAgentConfig,
): NodeAgentPatch {
  if (target.kind === "implementer") {
    if (!context.implementer) return {};
    return {
      implementer: { ...toAuthoredAssignment(context.implementer), agent },
    };
  }
  const cohort = context.contextValidator;
  if (
    !cohort?.assignments.some(
      (assignment) => assignment.id === target.assignmentId,
    )
  )
    return {};
  return {
    contextValidator: {
      ...cohort,
      assignments: cohort.assignments.map((assignment) => ({
        ...toAuthoredAssignment(assignment),
        agent: assignment.id === target.assignmentId ? agent : assignment.agent,
      })),
    },
  };
}
