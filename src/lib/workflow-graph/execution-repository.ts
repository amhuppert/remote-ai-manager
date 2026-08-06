import { readConfig } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { ensureCcArtifactsExcluded } from "@/lib/git/worktree";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  StaleLoopFenceError,
  getCurrentLoopFence,
  loopFenceAppliesTo,
  matchesLoopFence,
} from "./loop-fence";
import {
  createWorkflowCharterService,
  type WorkflowCharterService,
} from "./charter/service";
import {
  combineEventDeliveries,
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
  type GraphWorkflowPushInfo,
} from "./execution-events";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "./execution-state";
import { IllegalContextStatusTransitionError } from "./context-transitions";
import { computeLanePlan } from "./lane-plan";
import { substituteContent } from "./parameter-substitution";
import type { TemplateTier } from "./template-library-service";
import { resolveWorkflowDefinition } from "./resolve-config";
import { seedAssignmentSnapshots } from "./seed-assignment-snapshots";
import {
  WorkflowAssignmentReferenceError,
  createAssignmentReferenceChecker,
  type AssignmentReferenceChecker,
} from "./assignment-references";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { assertNoLegacyWorkflowFields } from "./schema-cutover-guard";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
} from "./validation";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { readRepoConfig } from "@/lib/projects/repo-config";
import {
  collectValidationCommandIssues,
  freezeResolvedDefinitionSelections,
} from "./command-selector-validation";
import {
  createValidationCommandPreflight,
  type ValidationCommandPreflight,
} from "@/lib/validation/preflight";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowStatus,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { WorkflowStartGuardError } from "./workflow-manager";
import { getErrorMessage } from "@/lib/shared/errors";
export { GraphWorkflowValidationError } from "./validation";

const logger = createLogger("graph-workflow-execution-repository");

export interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
  /**
   * Validated bound launch inputs (every declared name → its string value),
   * already normalized by the start service. Snapshotted onto the execution as
   * `boundInputs` and substituted into the definition before resolution.
   */
  inputs: Record<string, string>;
  /**
   * The tier the template was resolved from. Snapshotted onto the execution as
   * the additive `launchedTier` audit annotation, parallel to `boundInputs` —
   * it rides the definition tier and never mutates after seed.
   */
  launchedTier: TemplateTier;
}

/**
 * A `mutateActive` callback may return the next execution alone (its
 * append-only events are derived from the prev→next diff) or pair it with a
 * pure-DATA delivery it derived directly (e.g. a validation-result or approval
 * event, which no state diff can reconstruct). Both the diff events and these
 * extra events are appended to `graph_workflow_events` in the same write.
 *
 * This is inert data — `events` (append-only rows) and `pushes` (push
 * descriptors), NO callable. The reducer therefore cannot broadcast; the
 * mutation seam derives the full delivery, and the repository performs it only
 * AFTER the transaction commits (Design 3.2, `post-commit-delivery`). A callback
 * that returns only the next execution has no extra events.
 */
export interface MutateActiveResult extends GraphWorkflowEventDelivery {
  execution: GraphWorkflowExecution;
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
   * critical section. The mutator receives the currently-persisted execution
   * and MUST be synchronous and pure — it runs on the sync WriteQueue entry, so
   * no I/O (logging included), awaits, or O(total-state) work (Design 3.3,
   * `no-slow-work-in-critical-section`). It returns inert delivery DATA (rows +
   * push descriptors), never a callable, so it cannot broadcast. This seam
   * commits the rows and hands the committed delivery back for the repository to
   * perform post-commit; the seam itself performs no external delivery. Slow
   * callers stage their work around it (reserve/finalize).
   */
  mutateActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (current: GraphWorkflowExecution | null) => {
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
      pushes?: GraphWorkflowPushInfo[];
    },
  ): Promise<{
    execution: GraphWorkflowExecution;
    delivery: GraphWorkflowEventDelivery;
  }>;
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
  /**
   * Reads `CommandCenter.json` so execution start can preflight the seed
   * definition's command selections against the project's validation registry
   * and global capacity (validation-concurrency §§3, 6).
   */
  readRepoConfig?: (projectPath: string) => Promise<PerRepoConfig | null>;
  agentProfileLibrary?: AgentProfileLibraryService;
  assignmentReferences?: AssignmentReferenceChecker;
}

/**
 * What the seed needs to turn reference-bearing assignments into the bytes the
 * execution runs: the library to resolve through, the project scope to resolve
 * the project tier in, and the shared checker for the pre-seed re-check.
 */
interface ExecutionAssignmentSeedingDeps {
  library: AgentProfileLibraryService;
  assignmentReferences: AssignmentReferenceChecker;
  projectPath: string;
}

async function createExecutionFromSeed(
  seed: GraphWorkflowExecutionSeed,
  readConfigDep: () => Promise<GlobalConfig>,
  assignmentSeeding: ExecutionAssignmentSeedingDeps,
  validationPreflight: ValidationCommandPreflight,
): Promise<GraphWorkflowExecution> {
  assertNoLegacyWorkflowFields(
    seed.definition,
    "Workflow definition (execution start)",
  );

  // Substitute BEFORE resolution so the resolver, charter snapshot, and state
  // build all run over the concrete (placeholder-free) definition — the
  // persisted `workingDefinition` + `charter` are the post-substitution record
  // of what actually ran (R4.6, R4.7).
  const concrete = substituteContent(seed.definition, seed.inputs);

  logger.info("graph-workflow.substitution", {
    definitionId: seed.definitionId,
    revision: seed.definitionRevision,
    parameterCount: seed.definition.parameters.length,
    boundInputCount: Object.keys(seed.inputs).length,
  });

  // Re-validate the concrete definition through the STRUCTURAL graph validator
  // ONLY (graph/spec-lint + non-empty required-content checks) — NOT the
  // placeholder-grammar lint. A substituted launcher value may legitimately
  // contain a literal `{{...}}` (e.g. a GitHub Actions `${{ … }}` expression),
  // and re-scanning data for the placeholder grammar would reject a valid launch
  // (R5.1, R5.5). Failure fails closed here, before any state is built or
  // persisted — seed nothing (R5.2, R5.3).
  const structuralValidation = validateWorkflowDefinition(concrete);
  if (!structuralValidation.ok) {
    throw new GraphWorkflowValidationError(
      structuralValidation.errors,
      "Substituted workflow definition failed structural validation",
    );
  }

  // Re-check assignment references immediately before seeding. Definition
  // acceptance and `workflow validate` already checked them, but a profile can
  // be deleted in between, and after the seed there is no library lookup left
  // to catch it — so the last word belongs here (R4).
  //
  // BOTH sources of staffing are checked, because both can dangle. A reference
  // held only by `workflowDefaults` appears nowhere in the definition — it
  // arrives through the cascade below — so checking the definition alone lets
  // it through to `seedAssignmentSnapshots`, which throws an UNLOCATED "could
  // not be resolved" naming no field to fix. R15 requires the located error for
  // every holder kind the deletion preview enumerates, and `workflowDefaults`
  // is one of the three.
  //
  // The whole defaults block is checked, not just the slots this definition
  // happens to inherit: a dangling default is broken global configuration, and
  // making it fail some launches but not others is the silent breakage R15
  // exists to prevent.
  const global = await readConfigDep();
  const referenceIssues = [
    ...(await assignmentSeeding.assignmentReferences.checkDefinition(concrete, {
      kind: "project",
      projectPath: assignmentSeeding.projectPath,
    })),
    ...(await assignmentSeeding.assignmentReferences.checkWorkflowDefaults(
      global.workflowDefaults,
    )),
  ];
  if (referenceIssues.length > 0) {
    throw new WorkflowAssignmentReferenceError(referenceIssues);
  }

  const cascade = resolveWorkflowDefinition(global, concrete);
  // Snapshot seeding comes first: past this point the definition is
  // snapshot-bearing, which is the shape resolved validation and the selector
  // freeze below both operate on.
  const resolvedDefinition = await seedAssignmentSnapshots(cascade, {
    library: assignmentSeeding.library,
    projectPath: assignmentSeeding.projectPath,
  });

  const resolvedValidation = validateResolvedWorkflow(resolvedDefinition);
  if (!resolvedValidation.ok) {
    throw new GraphWorkflowValidationError(
      resolvedValidation.errors,
      "Workflow definition failed resolved validation",
    );
  }

  // Seed-time freeze (design §6): expand every resolved role selector into an
  // explicit command-name snapshot, and fail the start for unknown or
  // oversized selections inherited from global defaults, which the authored
  // definition preflight in create() cannot see.
  const frozen = freezeResolvedDefinitionSelections(
    resolvedDefinition,
    validationPreflight,
  );
  if (frozen.issues.length > 0) {
    logger.warn("graph-workflow.validation_preflight_rejected", {
      boundary: "start.resolved",
      definitionId: seed.definitionId,
      issueCount: frozen.issues.length,
      codes: frozen.issues.map((issue) => issue.code),
    });
    throw new GraphWorkflowValidationError(
      frozen.issues,
      "Resolved workflow configuration has invalid validation command selections",
    );
  }
  const workingDefinition = frozen.definition;

  const contextStates = buildInitialContextStates(workingDefinition);
  const taskStates = buildInitialTaskStates(workingDefinition);
  const lanePlan = computeLanePlan(workingDefinition);

  return graphWorkflowExecutionSchema.parse({
    id: seed.executionId,
    seedDefinitionId: seed.definitionId,
    seedDefinitionRevision: seed.definitionRevision,
    boundInputs: seed.inputs,
    launchedTier: seed.launchedTier,
    definitionApproval:
      concrete.approvalRequired === true
        ? { requestedAt: seed.startedAt, approvedAt: null }
        : null,
    workingDefinition,
    charter: concrete.charter,
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
  const readRepoConfigDep = deps.readRepoConfig ?? readRepoConfig;
  const agentProfileLibrary =
    deps.agentProfileLibrary ?? createAgentProfileLibraryService();
  const assignmentReferences =
    deps.assignmentReferences ?? createAssignmentReferenceChecker();

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
    // Start-boundary preflight. The seed definition is checked against the
    // current registry and capacity because either may have changed since
    // create/replace accepted it. Command selections are not substitution
    // targets, so checking before substitution is equivalent.
    const [repoConfig, globalConfig] = await Promise.all([
      readRepoConfigDep(projectPath),
      readConfigDep(),
    ]);
    const validationPreflight = createValidationCommandPreflight(
      repoConfig?.validation,
      globalConfig.validation,
    );
    const commandSelectionIssues = collectValidationCommandIssues(
      seed.definition,
      validationPreflight,
    );
    if (commandSelectionIssues.length > 0) {
      logger.warn("graph-workflow.validation_preflight_rejected", {
        boundary: "start.authored",
        projectPath,
        definitionId: seed.definitionId,
        issueCount: commandSelectionIssues.length,
        codes: commandSelectionIssues.map((issue) => issue.code),
      });
      throw new GraphWorkflowValidationError(
        commandSelectionIssues,
        "Workflow definition has invalid validation command selections",
      );
    }

    const baseExecution = await createExecutionFromSeed(
      seed,
      readConfigDep,
      {
        library: agentProfileLibrary,
        assignmentReferences,
        projectPath,
      },
      validationPreflight,
    );

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

    // Keep CC's .cc artifact namespace git-ignored before any file lands in
    // it, so the charter, materialized shared docs, and agent scratch (logs,
    // live-run evidence) are never committed by a lane's `add -A` sweep and
    // never churn the session worktree (which would trip the dirty-start gate
    // and the final-join precondition). Best-effort: a failure here must not
    // block starting the workflow.
    try {
      await ensureCcArtifactsExcluded(session.worktreePath);
    } catch (err) {
      logger.warn("graph-workflow.cc_artifacts_exclude_failed", {
        projectPath,
        sessionName,
        worktreePath: session.worktreePath,
        error: getErrorMessage(err),
      });
    }

    // Seed the charter before the first iteration: write charter.md inside the
    // worktree, register the kind:"charter" shared-document entry, snapshot the
    // charter onto the execution, and compute the charter-registered event. A
    // render/write/register failure throws here, halting the seed with no
    // partial charter state.
    const { nextExecution: seededExecution, delivery: charterDelivery } =
      await charterService.seedCharter({
        charter: baseExecution.charter,
        worktreePath: session.worktreePath,
        execution: baseExecution,
        projectPath,
        sessionName,
      });

    // Conflict details captured (pure) inside the reducer and logged AFTER the
    // critical section, so the queue callback performs no logging I/O
    // (`no-slow-work-in-critical-section`). The reducer throws the guard error
    // without logging; the catch below reconstructs the warn from this data.
    let createConflict: {
      activeExecutionId: string;
      activeStatus: GraphWorkflowStatus;
    } | null = null;
    const { execution, delivery } = await deps
      .mutateActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
        "graphWorkflowExecution.create",
        (current) => {
          // Compare-and-set inside the write-queue critical section. start()'s
          // active-execution guard runs a long async gauntlet (git probes,
          // definition load, charter seeding) before create, so two concurrent
          // starts can both pass it — the second create must not silently
          // overwrite the first execution, which would leave two loop drivers
          // on one execution under matching (executionId, loopEpoch) fences.
          // Terminal statuses mirror the start() guard: those actives are
          // replaceable (start archives them before creating).
          const replaceableStatuses: GraphWorkflowStatus[] = [
            "completed",
            "halted",
            "aborted",
          ];
          if (current && !replaceableStatuses.includes(current.status)) {
            createConflict = {
              activeExecutionId: current.id,
              activeStatus: current.status,
            };
            throw new WorkflowStartGuardError(
              "active_execution",
              `Session "${sessionName}" already has an active graph workflow execution`,
            );
          }
          const updateDelivery = eventPublisher.publishExecutionUpdate({
            projectPath,
            sessionName,
            previousExecution: null,
            nextExecution: seededExecution,
          });
          const combined = combineEventDeliveries([
            charterDelivery,
            updateDelivery,
          ]);
          return {
            execution: seededExecution,
            events: combined.events,
            pushes: combined.pushes,
          };
        },
      )
      .catch((err: unknown) => {
        // Log the CAS-conflict rejection OUTSIDE the write-queue critical section
        // (the reducer threw inside it without logging).
        if (err instanceof WorkflowStartGuardError && createConflict !== null) {
          logger.warn("graph-workflow.execution.create_conflict_rejected", {
            projectPath,
            sessionName,
            attemptedExecutionId: seededExecution.id,
            activeExecutionId: createConflict.activeExecutionId,
            activeStatus: createConflict.activeStatus,
          });
        }
        throw err;
      });
    // Post-commit, post-critical-section: the mutation seam has durably
    // committed the event rows; the repository (which owns the publisher, hence
    // the broadcaster + push dispatcher) performs delivery now — no reducer ever
    // holds a delivery capability (`post-commit-delivery`).
    eventPublisher.deliver(delivery);
    return execution;
  }

  async function update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    const parsed = graphWorkflowExecutionSchema.parse(execution);

    const { delivery } = await deps.mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      "graphWorkflowExecution.update",
      (current) => {
        if (!current) {
          throw new Error("No active graph workflow execution");
        }
        const diff = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: current,
          nextExecution: parsed,
        });
        return {
          execution: parsed,
          events: diff.events,
          pushes: diff.pushes,
        };
      },
    );
    eventPublisher.deliver(delivery);
  }

  /**
   * Loop-generation fence, checked inside the write-queue critical section
   * against the *persisted* execution: a mutation issued by a superseded loop
   * instance (its generation retired by a lifecycle transition) is
   * rejected atomically before the mutator runs. Also asserts an active
   * execution exists, narrowing `current` to non-null for the reducer.
   *
   * Purely computational: it throws {@link StaleLoopFenceError} (which carries
   * the fence + observed generation) but performs NO logging — logging is I/O
   * and this runs inside the queue critical section (`no-slow-work-in-critical-
   * section`). The rejection is logged by `mutateActive`'s catch, outside the
   * lock.
   */
  function assertMutableActive(
    projectPath: string,
    sessionName: string,
    current: GraphWorkflowExecution | null,
  ): asserts current is GraphWorkflowExecution {
    const fence = getCurrentLoopFence();
    if (
      fence !== null &&
      loopFenceAppliesTo(fence, projectPath, sessionName) &&
      !matchesLoopFence(fence, current)
    ) {
      throw new StaleLoopFenceError(fence, current);
    }
    if (!current) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }
  }

  /**
   * Derive the seam return from a reducer's result: parse the next execution,
   * compute the prev→next diff delivery, and merge it with any pure delivery
   * DATA (events + pushes) the reducer supplied directly. Pure — the result is
   * inert data the seam commits and the repository delivers post-commit; no
   * side effect happens here.
   */
  function deriveMutateResult(
    projectPath: string,
    sessionName: string,
    current: GraphWorkflowExecution,
    result: MutateActiveResult | GraphWorkflowExecution,
  ): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
    pushes: GraphWorkflowPushInfo[];
  } {
    const next = isMutateActiveResult(result) ? result.execution : result;
    const extraEvents = isMutateActiveResult(result) ? result.events : [];
    const extraPushes = isMutateActiveResult(result) ? result.pushes : [];
    const parsed = graphWorkflowExecutionSchema.parse(next);
    const diffDelivery = eventPublisher.publishExecutionUpdate({
      projectPath,
      sessionName,
      previousExecution: current,
      nextExecution: parsed,
    });
    return {
      execution: parsed,
      events: [...diffDelivery.events, ...extraEvents],
      pushes: [...diffDelivery.pushes, ...extraPushes],
    };
  }

  /**
   * Atomic read-modify-write of the active execution. The reducer runs inside
   * the global write queue, so it MUST be synchronous and pure — no I/O, no
   * awaits, nothing that can block (Design 3.1, `no-slow-work-in-critical-
   * section`). The non-async reducer type makes "await an LLM / git / registry
   * while holding the global lock" unrepresentable here; slow callers use their
   * own staged reserve → work-outside-lock → fenced-finalize protocols.
   */
  async function mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    const { execution, delivery } = await deps
      .mutateActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
        "graphWorkflowExecution.mutateActive",
        (current) => {
          assertMutableActive(projectPath, sessionName, current);
          const result = fn(structuredClone(current));
          return deriveMutateResult(projectPath, sessionName, current, result);
        },
      )
      .catch((err: unknown) => {
        // Log rejections OUTSIDE the write-queue critical section. The reducer
        // (and the transition helpers it calls) throw WITHOUT logging — logging
        // is `appendFileSync` I/O and must not run inside the lock
        // (`no-slow-work-in-critical-section`). Each error carries the data the
        // structured log needs, reconstructed here post-abort.
        if (err instanceof StaleLoopFenceError) {
          logger.warn("graph-workflow.loop_fence.stale_write_rejected", {
            projectPath,
            sessionName,
            fencedExecutionId: err.fence.executionId,
            fencedLoopEpoch: err.fence.loopEpoch,
            activeExecutionId: err.actualExecutionId,
            activeLoopEpoch: err.actualLoopEpoch,
          });
        } else if (err instanceof IllegalContextStatusTransitionError) {
          logger.error("graph-workflow.context_transition.illegal", {
            projectPath,
            sessionName,
            contextId: err.contextId,
            from: err.from,
            to: err.to,
            reason: err.reason,
          });
        }
        throw err;
      });
    // Delivery is performed by the mutation seam post-commit, never by the
    // reducer (`post-commit-delivery`).
    eventPublisher.deliver(delivery);
    return execution;
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
