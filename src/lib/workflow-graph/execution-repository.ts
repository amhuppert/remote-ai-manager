import { changed, unchanged } from "@/lib/workflow-graph/execution-mutation";
import { withArtifactPublication } from "./artifact-publication";

import { createLogger } from "@/lib/logging";

import { assertLoopFence } from "./loop-fence";

import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import { type GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";

import { getErrorMessage } from "@/lib/shared/errors";

import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
  ExecutionMutationValue,
  GraphWorkflowStorageMutation,
  GraphWorkflowStorageMutationOutcome,
} from "./execution-mutation";
import { GraphWorkflowResourceMissingError } from "./lifecycle-errors";
import { readConfig } from "@/lib/config/loader";

import { ensureCcArtifactsExcluded } from "@/lib/git/worktree";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowLaunchDocument } from "@/lib/workflow-graph/schemas";
import {
  StaleLoopFenceError,
  getCurrentLoopFence,
  loopFenceAppliesTo,
  matchesLoopFence,
} from "./loop-fence";
import {
  ExecutionTurnoverError,
  assertExecutionPrincipalFence,
} from "./principal-fence";
import {
  createWorkflowCharterService,
  type WorkflowCharterService,
} from "./charter/service";
import {
  createWorkflowSeededDocumentService,
  type SeededWorkflowDocument,
  type WorkflowSeededDocumentService,
} from "./shared-documents";
import {
  combineEventDeliveries,
  type GraphWorkflowPushInfo,
} from "./execution-events";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "./execution-state";
import {
  IllegalContextStatusTransitionError,
  buildLifecycleSnapshot,
} from "./context-transitions";
import { toHaltReason } from "./errors";
import {
  buildExecutionProvenance,
  describeLaunchSource,
  type GraphWorkflowLaunchSource,
} from "./execution-origin";
import { substituteContent } from "./parameter-substitution";
import { resolveWorkflowDefinition } from "./resolve-config";
import { collectLiveSessionReadOnlyViolations } from "./live-session-read-only";
import { seedAssignmentSnapshots } from "./seed-assignment-snapshots";
import {
  WorkflowAssignmentReferenceError,
  createAssignmentReferenceChecker,
  type AssignmentReferenceChecker,
} from "./assignment-references";
import { locatePlanIssues } from "@/lib/workflows/plan-issue-locator";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { assertNoLegacyWorkflowFields } from "./schema-cutover-guard";
import { nextStructuralRevision } from "./structural-revision";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
} from "./definition-validation";
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

import type { GraphWorkflowPendingArtifacts } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowArchiveOutcome,
  GraphWorkflowExecutionReservation,
  GraphWorkflowReservationOutcome,
} from "@/lib/state-store/setters";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { leaseHeldStartGuardError } from "./start-guards";
import { transitionToNonRunningState } from "./execution-transitions";

import { stopExecutionLaneDevServers as defaultStopExecutionLaneDevServers } from "@/lib/workflow-graph/dev-server-lane-cleanup";
import { unregisterExecutionLogger as defaultUnregisterExecutionLogger } from "@/lib/workflow-graph/execution-logger";
export { GraphWorkflowValidationError } from "./definition-validation";

const logger = createLogger("graph-workflow-execution-repository");

export interface GraphWorkflowExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  /**
   * `fence` is evaluated inside the reserving transaction and declines by
   * throwing: it is how a launch checks an admission fact that lives outside
   * the row (the session-finalizing merge) without the check going stale in the
   * asynchronous distance between reading it and taking the lease.
   */
  create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
    fence?: () => void,
  ): Promise<GraphWorkflowExecution>;
  archiveActive(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
    stamp?: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowArchiveOutcome>;
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
  /**
   * Settle any artifact debt the launch's reserving transaction recorded,
   * rewriting the charter and seeded documents from durable state. Null when
   * the run owes nothing, which is every run whose launch completed normally.
   */
  ensureArtifactsMaterialized(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
  }): Promise<GraphWorkflowExecution | null>;
}

export interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  /**
   * Where the definition content came from (D7 decision D2). One field rather
   * than a definition id plus a tier plus an origin: `buildExecutionProvenance`
   * derives the persisted `origin` AND the legacy-shaped seed projection from
   * it, so a launch that has no saved definition cannot accidentally describe
   * itself as one.
   */
  source: GraphWorkflowLaunchSource;
  /**
   * The authored document this run was launched from, snapshotted once here
   * (D7 decision D13): the submitted `{name, description, definition, layout}`
   * for a one-off run, and the template record's same four fields for a
   * template run. Required for BOTH origins because History renders a run from
   * its own record — a template that is later edited or deleted must not change
   * or erase what a past run shows.
   */
  launchDocument: GraphWorkflowLaunchDocument;
  executionId: string;
  startedAt: string;
  /**
   * Validated bound launch inputs (every declared name → its string value),
   * already normalized by the start service. Snapshotted onto the execution as
   * `boundInputs` and substituted into the definition before resolution.
   */
  inputs: Record<string, string>;
  /**
   * The conversation that launched this run, as captured server-side by the
   * start seam (`null` for a launch with no conversation identity, e.g. a
   * browser-driven start). Required on the seed rather than optional so a new
   * start seam cannot forget to decide: an owner is produced, never assumed.
   */
  ownerConversationId: string | null;
  /**
   * Documents the launching tier already rendered, seeded into the session
   * worktree and the central store before the first iteration so every lane
   * forked afterwards materializes them. Opaque content: the engine registers
   * and distributes the bytes without interpreting them. Omitted is a launch
   * that seeds nothing.
   */
  seededDocuments?: readonly SeededWorkflowDocument[];
  /**
   * Whether the launch guard admitted this run under the dirty-worktree
   * exemption (R8, decision D10). Written once, with the row, because it is the
   * invariant every later structural mutation is judged against: pinning it
   * after creation would leave a window where a mutation could widen the run
   * the guard admitted only because it was mechanically read-only. Omitted on a
   * clean-worktree launch, which pins nothing.
   */
  liveSessionReadOnlyPinned?: boolean;
  /**
   * Caller-owned rows committed atomically with the execution's reservation —
   * the native-SDD launch bridge writes its spec execution, immutable binding
   * snapshot, and typed link here. Runs inside the reserving transaction after
   * the execution row is installed; throwing refuses the launch whole.
   */
  transactionAttachment?: GraphWorkflowExecutionTransactionAttachment;
}

/** The atomic spec-row attachment a launch bridge rides into the reservation. */
export type GraphWorkflowExecutionTransactionAttachment = (input: {
  executionId: string;
}) => void;

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
  mutateActiveGraphWorkflowExecution<Value = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: GraphWorkflowExecution | null,
    ) => GraphWorkflowStorageMutation<Value>,
  ): Promise<GraphWorkflowStorageMutationOutcome<Value>>;
  /**
   * THE authoritative lease reservation: read the incumbent, decide admission,
   * and either install the candidate (relocating a lease-free incumbent into
   * History in the same transaction) or refuse — all inside one serialized
   * critical section. Nothing outside the row may be written before this
   * resolves, which is what makes a losing racer provably artifact-free.
   */
  reserveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    reservation: GraphWorkflowExecutionReservation,
  ): Promise<GraphWorkflowReservationOutcome>;
  /**
   * What a reserved execution still owes the filesystem, or null once its
   * materialization succeeded. Production binds the state store's pending
   * artifact table so an interrupted materialization can be retried.
   */
  getGraphWorkflowPendingArtifacts(
    projectPath: string,
    sessionName: string,
    executionId: string,
  ): Promise<GraphWorkflowPendingArtifacts | null>;
  /** Settle one execution's outstanding-artifact record. */
  clearGraphWorkflowPendingArtifacts(
    expected: GraphWorkflowPendingArtifacts,
    owner: Pick<GraphWorkflowExecution, "loopEpoch" | "status">,
  ): Promise<boolean>;
  /**
   * Move the active execution to the archived-executions table and null the
   * active blob (its events stay in `graph_workflow_events`).
   */
  archiveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
    stamp?: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowArchiveOutcome>;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  charterService?: WorkflowCharterService;
  seededDocumentService?: WorkflowSeededDocumentService;
  readConfig?: () => Promise<GlobalConfig>;
  /**
   * Reads `CommandCenter.json` so execution start can preflight the seed
   * definition's command selections against the project's validation registry
   * and global capacity (validation-concurrency §§3, 6).
   */
  readRepoConfig?: (projectPath: string) => Promise<PerRepoConfig | null>;
  agentProfileLibrary?: AgentProfileLibraryService;
  assignmentReferences?: AssignmentReferenceChecker;
  /**
   * Winner-only post-commit teardown for a normalized incumbent's surviving
   * resources. Injected rather than imported so a test can observe that the
   * cleanup ran exactly once, on the admit path only.
   */
  stopExecutionLaneDevServers?(input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
  }): Promise<void>;
  unregisterExecutionLogger?(executionId: string): void;
  /**
   * Git-exclude CC's `.cc` namespace in a worktree. Injectable so the
   * materialization failure path can be exercised without a real git worktree.
   */
  ensureCcArtifactsExcluded?(worktreePath: string): Promise<void>;
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

/**
 * The durable form of the authored launch document (D7 decision D13).
 *
 * The seed carries a document straight from its author, so an optional field
 * the author simply did not set can arrive as an explicit `undefined` property
 * (`{outputSchema: undefined}`). The store serializes blobs with
 * `stableStringify`, which writes such a property as `null` — and a `null` in a
 * slot whose schema accepts only the value or its absence fails the re-parse on
 * read, making the row unloadable. Snapshotting the document as the JSON it is
 * about to become resolves that distinction once, here, instead of teaching
 * every reader to tolerate a null it should never have been shown.
 */
function toDurableLaunchDocument(
  document: GraphWorkflowLaunchDocument,
): GraphWorkflowLaunchDocument {
  return JSON.parse(JSON.stringify(document)) as GraphWorkflowLaunchDocument;
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
    ...describeLaunchSource(seed.source),
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
    // Located against the definition being launched, so this refusal names the
    // same record ids `workflow validate` did (#80 design 3.2). The defaults
    // issues are rooted at `workflowDefaults`, which the locator leaves alone.
    ...locatePlanIssues(
      await assignmentSeeding.assignmentReferences.checkDefinition(concrete, {
        kind: "project",
        projectPath: assignmentSeeding.projectPath,
      }),
      concrete,
    ),
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

  const resolvedValidation = validateResolvedWorkflow(resolvedDefinition, {
    configuredModelSelectionFor: (backend) =>
      global.agentBackends?.[backend]?.modelSelection,
  });
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
      ...describeLaunchSource(seed.source),
      issueCount: frozen.issues.length,
      codes: frozen.issues.map((issue) => issue.code),
    });
    throw new GraphWorkflowValidationError(
      frozen.issues,
      "Resolved workflow configuration has invalid validation command selections",
    );
  }
  const workingDefinition = frozen.definition;

  // The dirty-worktree exemption's seed-time tie (R8, decision D10). The launch
  // guard proved eligibility against a resolution it built from its OWN config
  // read; `workingDefinition` is the resolution the execution will actually run,
  // built from the independent read above and then frozen. Nothing makes the two
  // agree — a global default can move between the reads, and the freeze can
  // widen a selection the guard never saw — so a seed that carries the pin is
  // re-proven against the bytes about to be persisted. Anything else would land
  // a write-capable run wearing a read-only pin, and every later structural
  // mutation would then be judged against a property the run never had.
  //
  // Refusing is the only safe outcome: the launch was admitted over uncommitted
  // changes solely because of this property, so losing it retracts the
  // admission rather than downgrading the pin. It fails here, before the
  // reservation, so the refusal costs neither a row nor a byte.
  if (seed.liveSessionReadOnlyPinned === true) {
    const pinIssues = collectLiveSessionReadOnlyViolations(workingDefinition);
    if (pinIssues.length > 0) {
      logger.warn("graph-workflow.start.dirty_exemption_retracted", {
        ...describeLaunchSource(seed.source),
        executionId: seed.executionId,
        issueCount: pinIssues.length,
        codes: pinIssues.map((issue) => issue.code),
      });
      throw new GraphWorkflowValidationError(
        pinIssues,
        "Workflow was admitted over uncommitted changes as a wholly read-only live-session run, but its resolved configuration is write-capable",
      );
    }
  }

  const contextStates = buildInitialContextStates(workingDefinition);
  const taskStates = buildInitialTaskStates(workingDefinition);

  const execution = graphWorkflowExecutionSchema.parse({
    id: seed.executionId,
    // Provenance, recorded rather than left to be re-derived from the seed
    // projection columns later (D7 decision D2). The authoritative `origin` and
    // the legacy-shaped projection beside it come from one derivation, so a
    // one-off run's filler can never be mistaken for a definition identity.
    ...buildExecutionProvenance(seed.source),
    launchDocument: toDurableLaunchDocument(seed.launchDocument),
    liveSessionReadOnlyPinned: seed.liveSessionReadOnlyPinned ?? false,
    boundInputs: seed.inputs,
    ownerConversationId: seed.ownerConversationId,
    definitionApproval:
      concrete.approvalRequired === true
        ? { requestedAt: seed.startedAt, approvedAt: null }
        : null,
    workingDefinition,
    charter: concrete.charter,
    status: concrete.approvalRequired === true ? "pending" : "running",
    activeContextIds: [],
    activeTaskId: null,
    contextStates,
    taskStates,
    sharedDocuments: [],
    machineSnapshot: null,
    startedAt: seed.startedAt,
    completedAt: null,
    haltReason: null,
  });
  if (execution.status === "running") {
    execution.machineSnapshot = buildLifecycleSnapshot(execution, {
      hasLiveIteration: false,
    });
  }
  return execution;
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
  const seededDocumentService =
    deps.seededDocumentService ?? createWorkflowSeededDocumentService();
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

  /**
   * `fence` is the launch's non-lease admission facts, re-asked inside the
   * reserving transaction and declining by throwing the caller's own guard
   * error (see `GraphWorkflowExecutionReservation.fence`). It rides the
   * reservation rather than being checked here because everything in this
   * function is asynchronous: a check made anywhere above would be stale by the
   * time the lease is actually taken.
   */
  async function create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
    fence?: () => void,
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
        ...describeLaunchSource(seed.source),
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

    const worktreePath = await resolveSeedWorktreePath(
      projectPath,
      sessionName,
    );

    // Registration, not materialization: the charter and every launcher-seeded
    // document are validated (worktree confinement included) and registered
    // onto the candidate, and their delivery computed — with no file written.
    // Splitting the seed here is what lets the reservation commit the COMPLETE
    // record in one transaction while every byte of `.cc` I/O still waits for
    // the lease. A path that escapes the worktree therefore refuses the launch
    // with neither a row nor a file (R5.2).
    const { nextExecution: charteredExecution, delivery: charterDelivery } =
      await charterService.prepareCharter({
        charter: baseExecution.charter,
        worktreePath,
        execution: baseExecution,
        projectPath,
        sessionName,
      });
    const seededDocuments = seed.seededDocuments ?? [];
    const candidate = await seededDocumentService.registerDocuments({
      documents: seededDocuments,
      worktreePath,
      execution: charteredExecution,
    });

    // THE authoritative admission (D7 R3.5, R5.2). Everything above this line
    // is a pure read or an in-memory registration, so this reservation is the
    // launch's FIRST mutation of any kind. The seam re-reads the incumbent
    // inside its serialized critical section and runs the same
    // `evaluateLeaseAdmission` the manager's advisory guard consulted, so the
    // two can only agree; a lease holder refuses here with the standard blocker
    // and a lease-free physical incumbent is relocated into History atomically
    // with the winner's installation.
    const reserveDelivery = combineEventDeliveries([
      charterDelivery,
      eventPublisher.publishExecutionUpdate({
        projectPath,
        sessionName,
        previousExecution: null,
        nextExecution: candidate,
      }),
    ]);
    const reservation = await deps.reserveActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      "graphWorkflowExecution.reserve",
      {
        execution: candidate,
        events: reserveDelivery.events,
        pushes: reserveDelivery.pushes,
        // The bytes, not just the registrations: the transaction that installs
        // the winner is the last moment they are guaranteed to exist, since the
        // `.cc` writes below run after it and the execution row stores only
        // where each document goes, never what it says.
        seededDocuments,
        ...(fence !== undefined && { fence }),
        ...(seed.transactionAttachment !== undefined && {
          transactionAttachment: seed.transactionAttachment,
        }),
      },
    );
    if (!reservation.reserved) {
      logger.warn("graph-workflow.execution.create_conflict_rejected", {
        projectPath,
        sessionName,
        attemptedExecutionId: candidate.id,
        activeExecutionId: reservation.refusal.incumbent.executionId,
        activeStatus: reservation.refusal.incumbent.status,
      });
      throw leaseHeldStartGuardError({
        projectPath,
        sessionName,
        refusal: reservation.refusal,
      });
    }
    if (reservation.normalized !== null) {
      logger.info("graph-workflow.execution.archived", {
        projectPath,
        sessionName,
        executionId: reservation.normalized.executionId,
        status: reservation.normalized.status,
        reason: "normalized_on_admission",
      });
      // WINNER ONLY, post-commit: a legacy terminal row can still own live
      // resources — lane dev servers and a registered execution logger — that
      // no explicit release act ever tore down, because normalization is
      // precisely the path where the operator performed no such act. Moving the
      // record to History without this would leave those servers running beside
      // the successor, competing for the same lane worktrees. Best-effort: the
      // lease is already won, so a failed teardown must not fail the launch.
      await releaseNormalizedIncumbentResources({
        projectPath,
        sessionName,
        execution: reservation.normalizedExecution,
        executionId: reservation.normalized.executionId,
      });
    }
    // Post-commit, post-critical-section: the reservation seam has durably
    // committed the event rows; the repository (which owns the publisher, hence
    // the broadcaster + push dispatcher) performs delivery now — no reducer ever
    // holds a delivery capability (`post-commit-delivery`).
    await eventPublisher.deliver(reservation.delivery);

    // WINNER ONLY, post-commit: the out-of-row artifacts. A losing racer never
    // reaches this line, which is the whole reason the reservation moved ahead
    // of it.
    await materializeArtifacts({
      projectPath,
      sessionName,
      executionId: reservation.execution.id,
      expectedExecution: reservation.execution,
      worktreePath,
      seededDocuments,
    });
    return reservation.execution;
  }

  /**
   * Tear down what a normalized incumbent left running. Runs once, after the
   * reserving transaction commits, and only for the launch that won the lease —
   * a refused racer must never reach it, or a refusal would end live work.
   *
   * Best-effort throughout: the successor is already durably installed, so a
   * failed stop is a logged warning rather than a failed launch.
   */
  async function releaseNormalizedIncumbentResources(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution | null;
    executionId: string;
  }): Promise<void> {
    try {
      if (input.execution !== null) {
        const stopLaneDevServers =
          deps.stopExecutionLaneDevServers ??
          defaultStopExecutionLaneDevServers;
        await stopLaneDevServers({
          execution: input.execution,
          projectPath: input.projectPath,
        });
      }
      const unregisterLogger =
        deps.unregisterExecutionLogger ?? defaultUnregisterExecutionLogger;
      unregisterLogger(input.executionId);
    } catch (err) {
      logger.warn("graph-workflow.execution.normalized_cleanup_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: input.executionId,
        error: getErrorMessage(err),
      });
    }
  }

  async function resolveSeedWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string> {
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
    return session.worktreePath;
  }

  /**
   * Put a reserved execution's registered artifacts on disk: the `.cc`
   * git-exclusion, the charter document, and every document the launching tier
   * seeded. Runs only for the execution that WON the lease, and only after its
   * row — which already carries every one of those registrations — is durably
   * committed.
   *
   * Idempotent, so a retry over a run whose materialization was interrupted
   * converges rather than duplicating: the exclusion is already idempotent, and
   * each delivered document atomically replaces its file while stored content
   * keeps the identity referenced by its registration.
   *
   * A failure halts the LOCATED winner (`execution_loop_failed`, cause `io` —
   * resumable) rather than unwinding it. The lease is already won at this
   * point, so the alternatives are a durable halted record the operator can see
   * and retry, or a row nobody can explain; the halt is the honest one.
   */
  async function materializeArtifacts(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    worktreePath?: string;
    seededDocuments: readonly SeededWorkflowDocument[];
    expectedExecution?: Pick<
      GraphWorkflowExecution,
      "id" | "loopEpoch" | "status"
    >;
    capturedPending?: GraphWorkflowPendingArtifacts | null;
  }): Promise<GraphWorkflowExecution> {
    const { projectPath, sessionName, executionId } = input;
    const captured =
      input.expectedExecution ??
      (await deps.getActiveGraphWorkflowExecution(projectPath, sessionName));
    if (!captured || captured.id !== executionId) {
      throw new Error(
        `Cannot materialize graph workflow execution "${executionId}": it no longer holds the active row for session "${sessionName}"`,
      );
    }
    const owner = {
      id: captured.id,
      loopEpoch: captured.loopEpoch,
      status: captured.status,
    };
    const pending =
      input.capturedPending === undefined
        ? await deps.getGraphWorkflowPendingArtifacts(
            projectPath,
            sessionName,
            executionId,
          )
        : input.capturedPending;

    function assertOwner(
      current: GraphWorkflowExecution | null,
    ): asserts current is GraphWorkflowExecution {
      assertLoopFence(projectPath, sessionName, current);
      if (
        !current ||
        current.id !== owner.id ||
        current.loopEpoch !== owner.loopEpoch
      ) {
        throw new StaleLoopFenceError(
          {
            projectPath,
            sessionName,
            executionId: owner.id,
            loopEpoch: owner.loopEpoch,
          },
          current,
        );
      }
      if (
        current.status !== owner.status ||
        current.abandonment !== null ||
        current.haltReason?.type === "aborted" ||
        current.status === "completed"
      ) {
        throw new Error(
          `Cannot materialize graph workflow execution "${executionId}": its lifecycle admission changed`,
        );
      }
    }

    return withArtifactPublication(projectPath, sessionName, async () => {
      const reserved = await deps.getActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
      );
      assertOwner(reserved);
      try {
        const worktreePath =
          input.worktreePath ??
          (await resolveSeedWorktreePath(projectPath, sessionName));
        // Keep CC's .cc artifact namespace git-ignored BEFORE any file lands in
        // it, so the charter, materialized shared docs, and agent scratch (logs,
        // live-run evidence) are never committed by a lane's `add -A` sweep and
        // never churn the session worktree (which would trip the dirty-start gate
        // and the final-join precondition).
        //
        // A failure here fails the whole materialization rather than being
        // logged and stepped over. Continuing would write exactly the artifacts
        // the exclusion exists to hide, into a worktree that will now commit
        // them, and then settle the pending record — so the run proceeds with a
        // dirty tree and no durable statement that anything is wrong. Halting the
        // located winner leaves an operator something to see and retry, which is
        // what the exclusion being ordered first was always for.
        await (deps.ensureCcArtifactsExcluded ?? ensureCcArtifactsExcluded)(
          worktreePath,
        );
        await charterService.writeCharterDocument({
          charter: reserved.charter,
          worktreePath,
        });
        await seededDocumentService.writeDocuments({
          documents: pending?.documents ?? input.seededDocuments,
          worktreePath,
          executionId,
        });
        const current = await deps.getActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
        );
        assertOwner(current);
        // A publisher acknowledges the exact reconstruction record it read.
        // Identical retries can observe an already-settled record; newer debt
        // must prevent dispatch until its own bytes have been prepared.
        const settled =
          pending === null
            ? false
            : await deps.clearGraphWorkflowPendingArtifacts(pending, owner);
        if (
          !settled &&
          (await deps.getGraphWorkflowPendingArtifacts(
            projectPath,
            sessionName,
            executionId,
          )) !== null
        ) {
          throw new Error(
            `Artifact reconstruction changed while preparing execution "${executionId}"; retry its current inputs`,
          );
        }
        return current;
      } catch (err) {
        if (!(err instanceof StaleLoopFenceError)) {
          await haltAfterMaterializationFailure(
            projectPath,
            sessionName,
            owner,
            err,
          );
        }
        throw err;
      }
    });
  }

  /**
   * The kickoff-side repair for a launch whose artifacts never reached disk.
   *
   * The lease CAS deliberately commits BEFORE any `.cc` write, so a crash in
   * between leaves a durable execution whose charter and seeded documents are
   * missing — and whose agents would otherwise start against a worktree lacking
   * the very sources the run points them at. The reserving transaction records
   * what the launch owes, contents included, so every path that (re)starts
   * driving an execution can settle that debt from durable state alone: no
   * caller has to still be holding the seed.
   *
   * A no-op for the overwhelmingly common case — a run whose materialization
   * already succeeded owns no record, so this is one indexed point read.
   * Returns null in exactly that case.
   */
  async function ensureArtifactsMaterialized(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
  }): Promise<GraphWorkflowExecution | null> {
    const expectedExecution = await deps.getActiveGraphWorkflowExecution(
      input.projectPath,
      input.sessionName,
    );
    assertLoopFence(input.projectPath, input.sessionName, expectedExecution);
    if (!expectedExecution || expectedExecution.id !== input.executionId) {
      throw new Error(
        `Cannot repair artifact debt for superseded execution "${input.executionId}"`,
      );
    }
    const readPending = deps.getGraphWorkflowPendingArtifacts;
    const pending = await readPending(
      input.projectPath,
      input.sessionName,
      input.executionId,
    );
    if (pending === null) return null;

    logger.info("graph-workflow.execution.artifacts_retry", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: input.executionId,
      documentCount: pending.documents.length,
      recordedAt: pending.recordedAt,
    });
    return materializeArtifacts({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: input.executionId,
      seededDocuments: pending.documents,
      expectedExecution,
      capturedPending: pending,
    });
  }

  async function haltAfterMaterializationFailure(
    projectPath: string,
    sessionName: string,
    owner: Pick<GraphWorkflowExecution, "id" | "loopEpoch" | "status">,
    cause: unknown,
  ): Promise<void> {
    const executionId = owner.id;
    const haltReason = toHaltReason(cause, { cause: "io" });
    try {
      await mutateActive(projectPath, sessionName, (execution) => {
        // Locate the winner before halting: a concurrent transition may already
        // have moved on, and halting whatever happens to hold the row would end
        // a run this failure has nothing to do with.
        if (
          execution.id !== owner.id ||
          execution.loopEpoch !== owner.loopEpoch ||
          execution.status !== owner.status
        ) {
          return unchanged();
        }
        // The shared execution-level transition owner, not a local status
        // write: a second copy of "what halting means" here would drift from
        // every other halt in the engine.
        return changed(
          transitionToNonRunningState(execution, "halted", null, haltReason),
        );
      }).then((mutation) => mutation.execution);
      logger.error("graph-workflow.execution.materialization_failed", {
        projectPath,
        sessionName,
        executionId,
        haltReasonType: haltReason.type,
        error: getErrorMessage(cause),
      });
    } catch (haltError) {
      logger.error("graph-workflow.execution.materialization_failed", {
        projectPath,
        sessionName,
        executionId,
        haltReasonType: haltReason.type,
        error: getErrorMessage(cause),
        haltError: getErrorMessage(haltError),
      });
    }
  }

  async function update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    const parsed = graphWorkflowExecutionSchema.parse(execution);

    await mutateActive(projectPath, sessionName, () => changed(parsed));
  }

  /**
   * Both fences, checked inside the write-queue critical section against the
   * *persisted* execution, before the mutator runs and therefore write-free.
   *
   * The loop fence rejects a mutation issued by a superseded loop instance (its
   * generation retired by a lifecycle transition). The principal fence rejects
   * one issued by an agent whose authority was established against a different
   * execution — the run it read settled and a successor took the lease. Also
   * asserts an active execution exists, narrowing `current` for the reducer.
   *
   * Purely computational: it throws errors carrying the fence and what was
   * observed, but performs NO logging — logging is I/O and this runs inside the
   * queue critical section (`no-slow-work-in-critical-section`). The rejections
   * are logged by `mutateActive`'s catch, outside the lock.
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
    assertExecutionPrincipalFence(projectPath, sessionName, current);
    if (!current) {
      throw new GraphWorkflowResourceMissingError(
        "execution",
        "Session does not have an active graph workflow execution",
      );
    }
  }

  /**
   * Derive the seam return from a reducer's result: stamp the repository-owned
   * staging fence, parse the next execution, compute the prev→next diff
   * delivery, and merge it with any pure delivery DATA (events + pushes) the
   * reducer supplied directly. Pure — the result is inert data the seam commits
   * and the repository delivers post-commit; no side effect happens here.
   *
   * Both staging fences are stamped HERE rather than by any caller, which is what
   * makes them fences: a reducer cannot hold one still to hide its own write from
   * a staged finalize (D4, decision D5). `executionStateRevision` advances on
   * every committed mutation, including the scheduler and lane writes that touch
   * no live-edit field; `structuralRevision` advances whenever the graph tier
   * moved, whoever moved it and whether or not they knew the fence exists. A
   * rejected reducer never reaches this point, so a refused mutation leaves both
   * counters where they were.
   */
  function deriveMutateResult<Value>(
    projectPath: string,
    sessionName: string,
    current: GraphWorkflowExecution,
    result: Extract<ExecutionMutationDecision<Value>, { kind: "changed" }>,
  ): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
    pushes: GraphWorkflowPushInfo[];
    preResetContextIds?: readonly string[];
  } {
    const next = result.execution;
    const extraEvents = result.delivery?.events ?? [];
    const extraPushes = result.delivery?.pushes ?? [];
    // Parse first: `structuralRevision` compares the committed shape against the
    // committed shape, so schema defaulting and coercion must already have run on
    // both sides or an unchanged tier can read as changed.
    const committed = graphWorkflowExecutionSchema.parse(next);
    const parsed: GraphWorkflowExecution = {
      ...committed,
      executionStateRevision: current.executionStateRevision + 1,
      structuralRevision: nextStructuralRevision(current, committed),
    };
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
      ...(result.delivery?.preResetContextIds !== undefined && {
        preResetContextIds: result.delivery.preResetContextIds,
      }),
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
  async function mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>> {
    const result = await deps
      .mutateActiveGraphWorkflowExecution<
        ExecutionMutationValue<Value, Refusal>
      >(
        projectPath,
        sessionName,
        "graphWorkflowExecution.mutateActive",
        (current) => {
          assertMutableActive(projectPath, sessionName, current);
          const decision = fn(structuredClone(current));
          switch (decision.kind) {
            case "unchanged":
            case "refused":
              return { kind: "no_commit", value: decision };
            case "events_only": {
              if (
                decision.delivery.events.length === 0 &&
                decision.delivery.pushes.length === 0
              )
                throw new Error(
                  "An events_only mutation requires nonempty delivery",
                );
              return {
                kind: "commit",
                execution: {
                  ...current,
                  executionStateRevision: current.executionStateRevision + 1,
                },
                ...decision.delivery,
                value: { kind: "events_only", value: decision.value },
              };
            }
            case "changed":
              return {
                kind: "commit",
                ...deriveMutateResult(
                  projectPath,
                  sessionName,
                  current,
                  decision,
                ),
                value: { kind: "changed", value: decision.value },
              };
          }
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
        } else if (err instanceof ExecutionTurnoverError) {
          logger.warn("graph-workflow.principal_fence.turnover_rejected", {
            projectPath,
            sessionName,
            authorizedExecutionId: err.fence.executionId,
            activeExecutionId: err.actualExecutionId,
            principal: err.fence.principal.kind,
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
    if (result.execution === null)
      throw new Error(
        "An active mutation returned without its authoritative execution",
      );
    if (result.kind === "committed")
      await eventPublisher.deliver(result.delivery);
    return { ...result.value, execution: result.execution };
  }

  /**
   * `stamp` lets an act whose whole point is the release — abandon — commit the
   * record change and the relocation together. It is pure and runs inside the
   * archive's critical section, so it obeys the same reducer rules the mutation
   * seam imposes: no I/O, no awaits.
   *
   * The principal assertion is composed into `guard`, which the state store
   * evaluates against its authoritative read inside the archive transaction.
   * Checking before this seam would leave abandon with the same lane-turnover
   * gap that `mutateActive` closes inside its reducer.
   */
  async function archiveActive(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
    stamp?: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowArchiveOutcome> {
    const fencedGuard = (execution: GraphWorkflowExecution): boolean => {
      assertExecutionPrincipalFence(projectPath, sessionName, execution);
      return guard?.(execution) ?? true;
    };
    const outcome = await deps.archiveActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      audit,
      fencedGuard,
      stamp,
    );
    if (outcome.archived && outcome.delivery !== undefined) {
      await eventPublisher.deliver(outcome.delivery);
    }
    return outcome;
  }

  return {
    getActive,
    create,
    materializeArtifacts,
    ensureArtifactsMaterialized,
    update,
    mutateActive,
    archiveActive,
  };
}

export async function requireCurrentExecution(
  repository: Pick<GraphWorkflowExecutionRepository, "getActive">,
  projectPath: string,
  sessionName: string,
): Promise<GraphWorkflowExecution> {
  const execution = await repository.getActive(projectPath, sessionName);
  assertLoopFence(projectPath, sessionName, execution);
  if (!execution) {
    throw new Error("Session does not have an active graph workflow execution");
  }
  return execution;
}
