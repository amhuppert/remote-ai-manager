import { readConfig } from "@/lib/config";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "./execution-state";
import { resolveWorkflowDefinition } from "./resolve-config";
import { assertNoLegacyWorkflowFields } from "./schema-cutover-guard";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
} from "./validation";
import type {
  GlobalConfig,
  GraphWorkflowExecution,
  SessionState,
  WorkflowSemanticDefinition,
} from "@/types";

export { GraphWorkflowValidationError } from "./validation";

export interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
}

export interface GraphWorkflowExecutionRepositoryDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T>;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  readConfig?: () => Promise<GlobalConfig>;
}

async function createExecutionFromSeed(
  seed: GraphWorkflowExecutionSeed,
  readConfigDep: () => Promise<GlobalConfig>,
): Promise<GraphWorkflowExecution> {
  assertNoLegacyWorkflowFields(
    seed.definition,
    "Workflow definition (execution start)",
  );
  const global = await readConfigDep();
  const workingDefinition = resolveWorkflowDefinition(global, seed.definition);

  const resolvedValidation = validateResolvedWorkflow(workingDefinition);
  if (!resolvedValidation.ok) {
    throw new GraphWorkflowValidationError(
      resolvedValidation.errors,
      "Workflow definition failed resolved validation",
    );
  }

  const contextStates = buildInitialContextStates(workingDefinition);
  const taskStates = buildInitialTaskStates(workingDefinition);

  return graphWorkflowExecutionSchema.parse({
    id: seed.executionId,
    seedDefinitionId: seed.definitionId,
    seedDefinitionRevision: seed.definitionRevision,
    workingDefinition,
    status: "pending",
    activeContextIds: [],
    activeTaskId: null,
    contextStates,
    taskStates,
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: seed.startedAt,
    completedAt: null,
    haltReason: null,
  });
}

export function createGraphWorkflowExecutionRepository(
  deps: GraphWorkflowExecutionRepositoryDeps,
) {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const readConfigDep = deps.readConfig ?? readConfig;

  async function getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    const session = await deps.getSession(projectPath, sessionName);
    return session?.graphWorkflowExecution ?? null;
  }

  async function create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution> {
    const execution = await createExecutionFromSeed(seed, readConfigDep);
    let storedExecution = execution;

    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.create",
      (session) => {
        storedExecution = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: null,
          nextExecution: execution,
        });
        session.graphWorkflowExecution = storedExecution;
        session.lastActivityAt = seed.startedAt;
      },
    );

    return storedExecution;
  }

  async function update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    const parsed = graphWorkflowExecutionSchema.parse(execution);

    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.update",
      (session) => {
        if (!session.graphWorkflowExecution) {
          throw new Error("No active graph workflow execution");
        }

        session.graphWorkflowExecution = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: session.graphWorkflowExecution,
          nextExecution: parsed,
        });
        session.lastActivityAt = new Date().toISOString();
      },
    );
  }

  async function mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution> {
    return deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.mutateActive",
      async (session) => {
        if (!session.graphWorkflowExecution) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }

        const previous = session.graphWorkflowExecution;
        const next = await fn(structuredClone(previous));
        const parsed = graphWorkflowExecutionSchema.parse(next);
        const published = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: previous,
          nextExecution: parsed,
        });
        session.graphWorkflowExecution = published;
        session.lastActivityAt = new Date().toISOString();
        return published;
      },
    );
  }

  async function archiveActive(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.archive",
      (session) => {
        if (!session.graphWorkflowExecution) {
          return;
        }

        session.graphWorkflowExecutionHistory.push(
          session.graphWorkflowExecution,
        );
        session.graphWorkflowExecution = null;
        session.lastActivityAt = new Date().toISOString();
      },
    );
  }

  return {
    getActive,
    create,
    update,
    mutateActive,
    archiveActive,
  };
}
