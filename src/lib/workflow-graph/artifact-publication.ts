import { createLogger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import type { GraphWorkflowExecution } from "./schemas";
import type { MaterializeInput } from "./document-materialization";
import { matchesLoopFence, StaleLoopFenceError } from "./loop-fence";

const logger = createLogger("graph-workflow-artifact-publication");
const PUBLICATION_QUEUE_KEY = "cc.graphWorkflow.artifactPublication";

/**
 * Canonical session paths share a publication order across all publishers in
 * the driving runtime, including module reloads. Cancellation never releases
 * a slot before its actual file I/O settles. Callers check their generation
 * inside the slot; neither database transactions nor agent turns belong here.
 */
export function withArtifactPublication<T>(
  projectPath: string,
  sessionName: string,
  work: () => Promise<T>,
): Promise<T> {
  const mutex = getGlobalSingleton(PUBLICATION_QUEUE_KEY, createKeyedMutex);
  logger.debug("graph-workflow.artifacts.publication_queued", {
    projectPath,
    sessionName,
  });
  return mutex.run(JSON.stringify([projectPath, sessionName]), async () => {
    logger.debug("graph-workflow.artifacts.publication_started", {
      projectPath,
      sessionName,
    });
    try {
      return await work();
    } finally {
      logger.debug("graph-workflow.artifacts.publication_settled", {
        projectPath,
        sessionName,
      });
    }
  });
}

export interface WorkflowDocumentPublicationInput extends MaterializeInput {
  projectPath: string;
  sessionName: string;
}

export interface WorkflowDocumentPublicationDeps {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  materialize(input: MaterializeInput): Promise<unknown>;
}

export function publishWorkflowDocuments(
  input: WorkflowDocumentPublicationInput,
  deps: WorkflowDocumentPublicationDeps,
): Promise<GraphWorkflowExecution> {
  return withArtifactPublication(
    input.projectPath,
    input.sessionName,
    async () => {
      const fence = {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: input.execution.id,
        loopEpoch: input.execution.loopEpoch,
      };
      const requireOwner = async () => {
        const current = await deps.getActive(
          input.projectPath,
          input.sessionName,
        );
        if (
          !current ||
          !matchesLoopFence(fence, current) ||
          current.status !== "running"
        ) {
          logger.info("graph-workflow.documents.publication_refused", {
            ...fence,
            actualExecutionId: current?.id ?? null,
            actualLoopEpoch: current?.loopEpoch ?? null,
            actualStatus: current?.status ?? null,
          });
          throw new StaleLoopFenceError(fence, current);
        }
        return current;
      };
      const delivered = await requireOwner();
      await deps.materialize({
        execution: delivered,
        worktreePath: input.worktreePath,
      });
      await requireOwner();
      logger.info("graph-workflow.documents.publication_delivered", {
        ...fence,
        worktreePath: input.worktreePath,
        documentCount: delivered.sharedDocuments.length,
      });
      return delivered;
    },
  );
}
