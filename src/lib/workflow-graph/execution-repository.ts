import { readConfig } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { ensureGraphWorkflowDocsExcluded } from "@/lib/git/worktree";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";
import {
  createWorkflowCharterService,
  type WorkflowCharterService,
} from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "./execution-state";
import { computeLanePlan } from "./lane-plan";
import { resolveWorkflowDefinition } from "./resolve-config";
import { assertNoLegacyWorkflowFields } from "./schema-cutover-guard";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
} from "./validation";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
export { GraphWorkflowValidationError } from "./validation";

const logger = createLogger("graph-workflow-execution-repository");

export interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
}

/**
 * A `mutateActive` callback may return the next execution alone (its
 * append-only events are derived from the prev→next diff) or pair it with
 * `events` it published directly (e.g. a validation-result or approval event,
 * which no state diff can reconstruct). Both the diff events and these extra
 * events are appended to `graph_workflow_events` in the same write.
 */
export interface MutateActiveResult {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
}

function isMutateActiveResult(
  value: MutateActiveResult | GraphWorkflowExecution,
): value is MutateActiveResult {
  return (
    "events" in value &&
    "execution" in value &&
    Array.isArray((value as MutateActiveResult).events)
  );
}

export interface GraphWorkflowExecutionRepositoryDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * Read the merged active graph-workflow execution for a session from the
   * dedicated `graph_workflow_executions` table (definition ⊕ runtime tiers),
   * or null. The execution no longer rides the session row.
   */
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  /**
   * Atomically persist the history-free execution blob and append the
   * publisher-computed events to `graph_workflow_events` inside one write-queue
   * critical section. The mutator receives the currently-persisted execution.
   */
  mutateActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (current: GraphWorkflowExecution | null) => Promise<{
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
    }>,
  ): Promise<GraphWorkflowExecution>;
  /**
   * Move the active execution to the archived-executions table and null the
   * active blob (its events stay in `graph_workflow_events`).
   */
  archiveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<void>;
  /**
   * Mark every persisted event for a context up to the current boundary as
   * pre-reset, replacing the old in-memory `history.map` reset marking.
   */
  markGraphWorkflowContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number>;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  charterService?: WorkflowCharterService;
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
  const lanePlan = computeLanePlan(workingDefinition);

  return graphWorkflowExecutionSchema.parse({
    id: seed.executionId,
    seedDefinitionId: seed.definitionId,
    seedDefinitionRevision: seed.definitionRevision,
    workingDefinition,
    charter: seed.definition.charter,
    status: "pending",
    activeContextIds: [],
    activeTaskId: null,
    contextStates,
    taskStates,
    sharedDocuments: [],
    machineSnapshot: null,
    startedAt: seed.startedAt,
    completedAt: null,
    haltReason: null,
    lanePlan,
  });
}

export function createGraphWorkflowExecutionRepository(
  deps: GraphWorkflowExecutionRepositoryDeps,
) {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const charterService =
    deps.charterService ??
    createWorkflowCharterService({
      publishCharterRegistered: eventPublisher.publishCharterRegistered,
    });
  const readConfigDep = deps.readConfig ?? readConfig;

  async function getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    return deps.getActiveGraphWorkflowExecution(projectPath, sessionName);
  }

  async function create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution> {
    const baseExecution = await createExecutionFromSeed(seed, readConfigDep);

    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      throw new Error(
        `Cannot seed charter: session "${sessionName}" was not found for project "${projectPath}"`,
      );
    }
    if (!session.worktreePath) {
      throw new Error(
        `Cannot seed charter: session "${sessionName}" has no worktree path`,
      );
    }

    // Keep CC's managed docs dir git-ignored before any file lands in it, so the
    // charter and materialized shared docs are never committed by a lane and
    // never churn the session worktree (which would trip the dirty-start gate
    // and the final-join precondition). Best-effort: a failure here must not
    // block starting the workflow.
    try {
      await ensureGraphWorkflowDocsExcluded(session.worktreePath);
    } catch (err) {
      logger.warn("graph-workflow.docs_exclude_failed", {
        projectPath,
        sessionName,
        worktreePath: session.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Seed the charter before the first iteration: write charter.md inside the
    // worktree, register the kind:"charter" shared-document entry, snapshot the
    // charter onto the execution, and compute the charter-registered event. A
    // render/write/register failure throws here, halting the seed with no
    // partial charter state.
    const {
      nextExecution: seededExecution,
      events: charterEvents,
    } = await charterService.seedCharter({
      charter: baseExecution.charter,
      worktreePath: session.worktreePath,
      execution: baseExecution,
      projectPath,
      sessionName,
    });

    return deps.mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      "graphWorkflowExecution.create",
      async () => {
        const updateEvents = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: null,
          nextExecution: seededExecution,
        });
        return {
          execution: seededExecution,
          events: [...charterEvents, ...updateEvents],
        };
      },
    );
  }

  async function update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    const parsed = graphWorkflowExecutionSchema.parse(execution);

    await deps.mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      "graphWorkflowExecution.update",
      async (current) => {
        if (!current) {
          throw new Error("No active graph workflow execution");
        }
        const events = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: current,
          nextExecution: parsed,
        });
        return { execution: parsed, events };
      },
    );
  }

  async function mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | MutateActiveResult
      | GraphWorkflowExecution
      | Promise<MutateActiveResult | GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution> {
    return deps.mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      "graphWorkflowExecution.mutateActive",
      async (current) => {
        if (!current) {
          throw new Error(
            "Session does not have an active graph workflow execution",
          );
        }

        const result = await fn(structuredClone(current));
        const next = isMutateActiveResult(result) ? result.execution : result;
        const extraEvents = isMutateActiveResult(result) ? result.events : [];
        const parsed = graphWorkflowExecutionSchema.parse(next);
        const diffEvents = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: current,
          nextExecution: parsed,
        });
        return { execution: parsed, events: [...diffEvents, ...extraEvents] };
      },
    );
  }

  async function archiveActive(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await deps.archiveActiveGraphWorkflowExecution(projectPath, sessionName);
  }

  async function markContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number> {
    return deps.markGraphWorkflowContextEventsPreReset(
      projectPath,
      sessionName,
      executionId,
      contextId,
    );
  }

  return {
    getActive,
    create,
    update,
    mutateActive,
    archiveActive,
    markContextEventsPreReset,
  };
}
