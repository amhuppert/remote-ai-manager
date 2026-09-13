import { CheckpointForkError } from "./fork-service";
import {
  checkpointAssignmentKey,
  checkpointWorkflowAssignments,
} from "./fork-workflow-assignments";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { CheckpointRelatedWork } from "./fork-schemas";

export interface CheckpointWorkReaders {
  ticket(projectPath: string, number: number): Promise<unknown | null>;
  spec(id: string): Promise<{ projectPath: string } | null>;
  revision(id: string): Promise<{
    revision: { specId: string };
    elements: readonly { element: { id: string; kind: string } }[];
  } | null>;
  execution(
    projectPath: string,
    sessionName: string,
    id: string,
  ): Promise<Pick<
    GraphWorkflowExecution,
    "launchDocument" | "workingDefinition"
  > | null>;
}

export function createCheckpointWorkResolver(readers: CheckpointWorkReaders) {
  return async (
    projectPath: string,
    work: CheckpointRelatedWork,
  ): Promise<void> => {
    const missing = () =>
      new CheckpointForkError(
        "related_work_not_found",
        "Related work does not exist in this project at the selected revision or assignment",
        422,
      );
    if (work.kind === "ticket") {
      if ((await readers.ticket(projectPath, work.ticketNumber)) === null)
        throw missing();
      return;
    }
    if (work.kind === "spec_task") {
      const spec = await readers.spec(work.specId);
      const snapshot = await readers.revision(work.revisionId);
      if (
        spec?.projectPath !== projectPath ||
        snapshot?.revision.specId !== work.specId ||
        !snapshot.elements.some(
          ({ element }) =>
            element.id === work.elementId && element.kind === "task",
        )
      )
        throw missing();
      return;
    }
    const execution = await readers.execution(
      projectPath,
      work.sessionName,
      work.executionId,
    );
    if (
      !execution ||
      !checkpointWorkflowAssignments(execution).some(
        (choice) => choice.id === checkpointAssignmentKey(work),
      )
    )
      throw missing();
  };
}
