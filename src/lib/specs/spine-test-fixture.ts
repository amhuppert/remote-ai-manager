import type Database from "better-sqlite3";
import { fromPromise } from "xstate";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createJobsRepo } from "@/lib/jobs/repo";
import { runRegisteredMergeJob } from "@/lib/jobs/queue";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createMergeAssociationResolver } from "./merge-association";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb, _installTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import {
  graphWorkflowExecutionEventSchema,
  type GraphWorkflowExecutionEvent,
} from "@/lib/workflow-graph/event-schemas";
import { createRegisteredGraphExecutionLifecycleCallbacks } from "@/lib/workflow-graph/execution-lifecycle-port";
import { createGraphWorkflowExecutionRouteHandlers } from "@/lib/workflow-graph/execution-route-handlers";
import { createGraphWorkflowMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import type { TemplateTier } from "@/lib/workflow-graph/template-library-service";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  stubAssignmentSnapshotPreparation,
} from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowAmendRouteHandlers } from "@/lib/workflow-graph/amend-route-handlers";
import { createGraphWorkflowRuntimeEditRouteHandlers } from "@/lib/workflow-graph/runtime-edit-route-handlers";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "@/lib/workflow-graph/execution-state";
import { DEFAULT_LANE_MERGE_VALIDATION_CONFIG } from "@/lib/workflow-graph/config-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import type { LiveEditDeps } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowManager } from "@/lib/workflow-graph/workflow-manager";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
} from "@/lib/workflow-graph/storage";
import type {
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
} from "@/lib/workflows/merge/actors";
import { createRegisteredDeliveryGateEvaluator } from "@/lib/workflows/merge/delivery-gate-port";
import {
  mergeMachine,
  type MergeMachineType,
} from "@/lib/workflows/merge/machine";
import type { CandidateValidationFact } from "@/lib/workflows/merge/types";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  RunValidationInput,
  RunValidationOutput,
} from "@/lib/workflows/validation-fix/actors";

import { createAuthoringService } from "./authoring-service";
import { compileSpecExecutionPlan, readCompiledOriginMap } from "./compiler";
import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import { readDeliveryPlanSourceMap } from "./delivery-plan-materializer";
import {
  deliveryPlanMutationViewSchema,
  deliveryPlanPreviewViewSchema,
} from "./delivery-plan-views";
import {
  classifyEarlierMergedDelivery,
  createDeliveryGate,
} from "./delivery-gate";
import { loadDeliveryDelta } from "./delivery-delta-query";
import { createDeliveryPlanService } from "./delivery-plan-service";
import { createEvidenceIngestService } from "./evidence-ingest";
import { readSpecExecutionOriginMap } from "./execution-origin-map";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import { createImportService } from "./import-service";
import {
  discoveredTaskSchema,
  specGateDialSchema,
  type SpecExecutionRow,
} from "./schemas";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
} from "./export";
import {
  createExecutionLifecycleCallbacks,
  createExecutionService,
  hashExecutionScope,
  type ExecutionStartGatePort,
  type ExecutionWorkflowDefinitions,
  type SpecWorkflowCleanupObservation,
  type SpecWorkflowCleanupTarget,
} from "./execution-service";
import { resolveLegacyDeliverySource } from "./legacy-plan-import";
import { createMeasuresQuery } from "./measures-query";
import { toLintSnapshot } from "./review-state";
import { resolveDial } from "./policy";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import {
  createReviewService,
  type SpecApprovalGrantNotice,
  type SpecApprovalRequestNotice,
  type SpecApprovalRequestsClosedNotice,
} from "./review-service";
import {
  createSpecRouteHandlers,
  createSpecWriteRouteHandlers,
  SPEC_CALLER_BACKEND_HEADER,
  SPEC_CALLER_CONVERSATION_HEADER,
  type SpecMutationServices,
} from "./route-handlers";
import { registerSpecWorkflowComposition } from "./workflow-composition";

type Db = InstanceType<typeof Database>;

export const SPINE_PROJECT_NAME = "spine";
export const SPINE_PROJECT_PATH = "/repos/spec-spine";
export const SPINE_SESSION_NAME = "spine-session";
export const SPINE_CONVERSATION_ID = "conversation-spine";
export const SPINE_WORKFLOW_EXECUTION_ID = "workflow-execution-spine";
export const SPINE_BEARER_TOKEN = "contract-token";

class InMemoryWorkflowDefinitions implements ExecutionWorkflowDefinitions {
  records: WorkflowDefinitionRecord[] = [];
  private revisionCount = 0;

  constructor(private readonly now: () => string) {}

  async findByOrigin(
    sourceUri: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    return (
      this.records.find(
        (record) => record.definition.origin?.sourceUri === sourceUri,
      ) ?? null
    );
  }

  async create(
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    this.revisionCount += 1;
    const record = this.record(
      `workflow-definition-${this.revisionCount}`,
      draft,
      1,
    );
    this.records.push(record);
    return record;
  }

  async update(
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    const index = this.records.findIndex((record) => record.id === workflowId);
    if (index === -1) throw new Error("workflow definition not found");
    const current = this.records[index];
    if (current === undefined) throw new Error("workflow definition not found");
    const record = this.record(workflowId, draft, current.revision + 1);
    this.records[index] = record;
    return record;
  }

  async list(): Promise<WorkflowDefinitionSummary[]> {
    return this.records.map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      parameters: record.definition.parameters,
      prerequisites: record.definition.prerequisites,
    }));
  }

  findById(workflowId: string): WorkflowDefinitionRecord | null {
    return this.records.find((record) => record.id === workflowId) ?? null;
  }

  private record(
    id: string,
    draft: WorkflowDefinitionDraft,
    revision: number,
  ): WorkflowDefinitionRecord {
    return {
      id,
      name: draft.name,
      description: draft.description,
      schemaVersion: 1,
      revision,
      definition: draft.definition,
      layout: { ...draft.layout, workflowId: id },
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }
}

export interface MergeScenario {
  validation: CandidateValidationFact;
  preparations: PrepareActorOutput[];
  publications: PublishActorOutput[];
  publishedCandidates: string[];
}

export interface SpecSpineWorld {
  db: Db;
  publishedSse: SSEEvent[];
  /** Approval notices the review service reported to the notifier port. */
  reviewNotifications: {
    requested: SpecApprovalRequestNotice[];
    granted: SpecApprovalGrantNotice[];
    /** Requests that ended unanswered: a revision withdrawn or sent back. */
    closed: SpecApprovalRequestsClosedNotice[];
    /** Notify-dial policy admissions surfaced for post-hoc review (R11.2). */
    policyAdmitted: SpecPolicyAdmissionNotice[];
  };
  now(): string;
  repos: {
    specs: ReturnType<typeof createSpecsRepo>;
    review: ReturnType<typeof createSpecReviewRepo>;
    delivery: ReturnType<typeof createSpecDeliveryRepo>;
    links: ReturnType<typeof createSpecLinksRepo>;
    events: ReturnType<typeof createSpecEventsRepo>;
    workflowEvents: ReturnType<typeof createGraphWorkflowEventsRepo>;
    jobs: ReturnType<typeof createJobsRepo>;
  };
  services: SpecMutationServices & {
    execution: ReturnType<typeof createExecutionService>;
  };
  definitions: InMemoryWorkflowDefinitions;
  ingest: ReturnType<typeof createEvidenceIngestService>;
  measures: ReturnType<typeof createMeasuresQuery>;
  readHandlers: ReturnType<typeof createSpecRouteHandlers>;
  writeHandlers: ReturnType<typeof createSpecWriteRouteHandlers>;
  /** Commits the fake git universe recognizes for evidence resolvability. */
  knownCommits: Set<string>;
  /** commit sha -> relevant tree hash used by the delivery gate freshness probes. */
  treeByCommit: Map<string, string>;
  /**
   * Register a commit with explicit parent edges in the modeled git universe.
   * Ancestry (`isCommitAncestor`, and the delivery gate's isAncestor probe)
   * follows ONLY these edges — existence alone never places a commit in a
   * candidate's history.
   */
  linkCommit(sha: string, parents?: string[]): void;
  /** `git merge-base --is-ancestor` over the modeled lineage (reflexive). */
  isCommitAncestor(ancestorSha: string, descendantSha: string): boolean;
  registerMergeComposition(): void;
  runMerge(jobId: string, scenario: MergeScenario): Promise<unknown>;
  postAction(
    slug: string,
    action: string,
    body: unknown,
    transport: "agent" | "human",
  ): Promise<Response>;
  getRoute(
    handler:
      | "listSpecsGET"
      | "getSpecGET"
      | "getSpecStatusGET"
      | "getSpecElementGET"
      | "getSpecMeasuresGET"
      | "getSpecVerifyGET",
    params: Record<string, string>,
  ): Promise<Response>;
  /**
   * Drive the REAL graph-workflow route handlers (start, definition approval,
   * status) composed over the real workflow manager. Start and approval report
   * through the registered lifecycle port — the production spec↔workflow
   * handoff — so tests never link spec executions by hand.
   */
  postWorkflowRoute(
    handler:
      | "START"
      | "APPROVE_DEFINITION"
      | "STATUS"
      | "EXECUTION"
      | "PAUSE"
      | "ABORT"
      | "RELEASE",
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /**
   * Drive the REAL `graph-workflow/amend` route — the one authorized way to
   * change a launched delivery-plan definition. `human` posts with no token
   * (the Studio control); `agent` posts the bearer token plus the caller
   * conversation header, as `cctl workflow live amend` does.
   */
  postWorkflowAmend(
    body: unknown,
    transport: "agent" | "human",
  ): Promise<Response>;
  /**
   * Drive the REAL generic `graph-workflow/runtime-edits` route — the surface a
   * delivery plan's locked regions refuse and a legacy definition still accepts.
   */
  postWorkflowLiveEdit(body: unknown): Promise<Response>;
  /**
   * Mirror the production execution loop's failed-merge handling: record the
   * structured halt reason and drain the active workflow execution to
   * `halted` so status routes and the CLI surface the machine-readable code.
   */
  haltWorkflowExecution(reason: GraphWorkflowHaltReason): Promise<void>;
  /** Park the active run at `paused` — non-terminal, yet archive-eligible. */
  pauseWorkflowExecution(): Promise<void>;
  markWorkflowContextRunning(contextId: string, taskId: string): Promise<void>;
  setWorkflowExecutionStatus(
    status: GraphWorkflowExecution["status"],
  ): Promise<void>;
  readActiveWorkflowExecution(): GraphWorkflowExecution | null;
  /**
   * Fault injection for the spec→workflow cleanup port, so a test can stop the
   * abandon coordinator at a chosen phase boundary and assert the reached
   * phase is durable. `beforeOp` throws to simulate an unreachable workflow
   * store; `abortIsNoOp` accepts the abort but leaves the run live, which is
   * how the "never reports success over a live run" invariant is proved.
   */
  cleanupFaults: {
    beforeOp: ((op: "observe" | "abort" | "release") => void) | null;
    abortIsNoOp: boolean;
  };
}

/**
 * The concrete config an amendment's `add-context` seeds from. These are the
 * global defaults a live edit resolves in production; resolving them for real
 * would need the CC config file and the profile library, neither of which an
 * amendment consults for anything it decides.
 */
function spineLiveEditDeps(
  now: () => string,
  allowAgentTaskAdd = false,
): LiveEditDeps {
  return {
    createTaskId: () => "task-amended",
    resolvedGlobalDefaults: () => ({
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
      },
      contextValidator: { enabled: false, assignments: [] },
      scriptValidator: { commands: [] },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd, allowAgentContextAdd: false },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
      planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      collaboration: {
        enabled: { value: false, source: "global" },
        secondAgent: {
          value: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          source: "global",
        },
        negotiationRounds: { value: 3, source: "global" },
        autonomousResolutionThreshold: { value: "minor", source: "global" },
      },
      agentValidation: {
        implementer: { value: { mode: "all", except: [] }, source: "global" },
        contextValidator: {
          value: { mode: "only", commands: [] },
          source: "global",
        },
      },
    }),
    validationCommandPreflight: () => ({
      commandCosts: {},
      concurrencyLimit: 8,
    }),
    snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
    now,
  };
}

/**
 * The resolved working definition a launch commits: every context carries the
 * concrete config the cascade produced plus the workflow charter. Production
 * resolves this from the CC config file and the profile library; the fixture
 * substitutes the same shape from fixed defaults, because what the tests here
 * decide never depends on which model a context inherited.
 */
function resolveSpineWorkingDefinition(
  definition: WorkflowDefinitionRecord["definition"],
  now: () => string,
  allowAgentTaskAdd: boolean,
): ResolvedWorkflowSemanticDefinition {
  const defaults = spineLiveEditDeps(
    now,
    allowAgentTaskAdd,
  ).resolvedGlobalDefaults();
  const pinnedMutability = definition.workflowConfig?.mutability;
  // Authored loop groups carry `bodyContextIds`; the resolved shape carries the
  // `template`/`templateVersion`/`planRepair` a launched execution expands from,
  // and this fixture has no way to synthesize one. The spec spine authors no
  // loops, so the field is dropped rather than mis-resolved — loudly, so a
  // future spine definition that adds one is not silently stripped.
  const { loopGroups, ...authoredWithoutLoops } = definition;
  if (loopGroups !== undefined && loopGroups.length > 0) {
    throw new Error(
      "resolveSpineWorkingDefinition: the spec spine fixture does not resolve loop groups",
    );
  }
  return {
    ...authoredWithoutLoops,
    laneMergeValidation: DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
    executionContexts: definition.executionContexts.map((context) => ({
      ...context,
      // Resolved config last: the fixture's fixed defaults ARE the cascade's
      // answer here, so an authored reference-bearing override never survives
      // into the snapshot-bearing shape a launched execution must carry.
      ...defaults,
      ...(pinnedMutability === undefined
        ? {}
        : { mutability: pinnedMutability }),
      ...(definition.charter === undefined
        ? {}
        : { charter: definition.charter }),
    })),
  };
}

export function createSpecSpineWorld(
  options: {
    pinnedAllowAgentTaskAdd?: boolean;
    currentGlobalAllowAgentTaskAdd?: boolean;
  } = {},
): SpecSpineWorld {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    SPINE_PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    SPINE_PROJECT_PATH,
    SPINE_SESSION_NAME,
    `${SPINE_PROJECT_PATH}/.worktrees/${SPINE_SESSION_NAME}`,
    "cc/spec-spine",
    "2026-07-18T10:00:00.000Z",
    "2026-07-18T10:00:00.000Z",
  );

  let idSequence = 0;
  let clockSequence = 0;
  const newId = (prefix: string) => `${prefix}-${++idSequence}`;
  const now = () => {
    clockSequence += 1;
    const minutes = String(Math.floor(clockSequence / 60)).padStart(2, "0");
    const seconds = String(clockSequence % 60).padStart(2, "0");
    return `2026-07-18T12:${minutes}:${seconds}.000Z`;
  };

  const publishedSse: SSEEvent[] = [];
  const writeQueue = createWriteQueue();
  const specs = createSpecsRepo(db, writeQueue);
  const review = createSpecReviewRepo(db);
  const delivery = createSpecDeliveryRepo(db);
  const links = createSpecLinksRepo(db);
  const eventsRepo = createSpecEventsRepo(db);
  const plans = createSpecDeliveryPlanRepo(db, {
    appendEvent: (event) => eventsRepo.appendInTransaction(event),
  });
  const workflowEvents = createGraphWorkflowEventsRepo(db);
  const jobs = createJobsRepo(db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
    publish(event) {
      publishedSse.push(event);
      return { delivered: true };
    },
  });

  const reviewNotifications: SpecSpineWorld["reviewNotifications"] = {
    requested: [],
    granted: [],
    closed: [],
    policyAdmitted: [],
  };
  const policyNotifier: SpecPolicyAdmissionNotifier = {
    policyAdmitted(notice) {
      reviewNotifications.policyAdmitted.push(notice);
    },
  };
  const authoring = createAuthoringService({
    specs,
    review,
    links,
    events,
    waivers: delivery,
    policyNotifier,
    newId,
    now,
  });
  const reviewService = createReviewService({
    specs,
    review,
    delivery,
    links,
    events,
    attention: eventsRepo,
    notifier: {
      approvalRequested(notice) {
        reviewNotifications.requested.push(notice);
      },
      approvalGranted(notice) {
        reviewNotifications.granted.push(notice);
      },
      approvalRequestsClosed(notice) {
        reviewNotifications.closed.push(notice);
      },
    },
    policyNotifier,
    newId,
    now,
  });

  const definitions = new InMemoryWorkflowDefinitions(now);
  async function loadFixtureOriginMap(workflowDefinitionId: string) {
    const record = definitions.findById(workflowDefinitionId);
    if (record === null) return [];
    return readSpecExecutionOriginMap(record.definition, (revisionId) =>
      specs.getRevisionSnapshot(revisionId),
    );
  }
  const knownCommits = new Set<string>();
  const treeByCommit = new Map<string, string>();
  // Explicit ancestry model: commit -> parents. `isCommitAncestor` mirrors
  // `git merge-base --is-ancestor` (reflexive, walks parent edges), so a
  // commit that merely EXISTS in the universe is NOT in a candidate's history
  // unless a lineage edge places it there.
  const commitParents = new Map<string, string[]>();
  function linkCommit(sha: string, parents: string[] = []): void {
    knownCommits.add(sha);
    for (const parent of parents) knownCommits.add(parent);
    commitParents.set(sha, [
      ...new Set([...(commitParents.get(sha) ?? []), ...parents]),
    ]);
  }
  function isCommitAncestor(
    ancestorSha: string,
    descendantSha: string,
  ): boolean {
    if (ancestorSha === descendantSha) return knownCommits.has(ancestorSha);
    const queue = [...(commitParents.get(descendantSha) ?? [])];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      if (current === ancestorSha) return true;
      queue.push(...(commitParents.get(current) ?? []));
    }
    return false;
  }

  const evidenceRef: {
    current?: ReturnType<typeof createEvidenceService>;
  } = {};
  const ingest = createEvidenceIngestService({
    repo: delivery,
    workflowEvents,
    evidenceService: {
      attachEvidence(input) {
        if (evidenceRef.current === undefined) {
          throw new Error("Spine evidence service is not initialized");
        }
        return evidenceRef.current.attachEvidence(input);
      },
      recordProofVerdict(input) {
        if (evidenceRef.current === undefined) {
          throw new Error("Spine evidence service is not initialized");
        }
        return evidenceRef.current.recordProofVerdict(input);
      },
    },
    writeQueue,
    async validatedTreeHash(_execution, commitSha) {
      const tree = treeByCommit.get(commitSha);
      if (tree === undefined) {
        throw new Error(`No relevant tree registered for ${commitSha}`);
      }
      return tree;
    },
    loadOriginMap: loadFixtureOriginMap,
    // Late-bound like the execution service's probe below: the fixture's live
    // workflow status decides deferred-stamp terminality exactly as the
    // production repos do.
    getWorkflowExecutionStatus: async (workflowExecutionId) =>
      activeWorkflowExecution !== null &&
      activeWorkflowExecution.id === workflowExecutionId
        ? activeWorkflowExecution.status
        : null,
  });
  const ingestExecutionEvidence = (executionId: string) =>
    ingest.ingestAuthoritatively(executionId);

  const evidencePublication = createEvidenceMutationRecorder({
    eventsRepo,
    events,
    findSpecById: (specId) => specs.findByIdInTransaction(specId),
    runInImmediateTransaction: (operation) => operation(),
  });
  const recordMutation = evidencePublication.recordMutation;
  const evidence = createEvidenceService({
    repo: delivery,
    ingestExecutionEvidence,
    recordMutation,
    runInImmediateTransaction: evidencePublication.runInImmediateTransaction,
    nextId: newId,
    now,
    async getApprovedCriterion(revisionId, criterionElementId) {
      const snapshot = await specs.getRevisionSnapshot(revisionId);
      if (snapshot?.revision.state !== "approved") return null;
      const criterion = snapshot.elements.find(
        (item) =>
          item.element.id === criterionElementId &&
          item.version.payload.kind === "criterion",
      );
      return criterion?.version.payload.kind === "criterion"
        ? {
            specId: snapshot.revision.specId,
            validationStrategy: criterion.version.payload.validationStrategy,
          }
        : null;
    },
    gitObjectExists: async (ref) => knownCommits.has(ref.objectId),
    async workflowEventExists(ref, expectedExecution) {
      const record = workflowEvents.findRecordById(ref.eventId);
      return (
        record !== null &&
        record.executionId === expectedExecution.workflowExecutionId &&
        "contextId" in record.event &&
        record.event.contextId === ref.contextId
      );
    },
    async mergeValidationFactExists(ref, expectedExecution) {
      const job = jobs.getJobRecord(ref.mergeJobId);
      return (
        job?.executionId === expectedExecution.workflowExecutionId &&
        job.candidateValidation?.validationRef === ref.validationRef
      );
    },

    isEvidenceFresh: async () => true,
    routeStrategyInadequacy: async () => undefined,
    routeWaiverRequestToHuman: async () => ({
      attentionId: newId("attention"),
    }),
    async getTaskClaimContext(executionId, taskElementId) {
      const execution = delivery.findExecutionById(executionId);
      if (execution === null) return null;
      const [spec, snapshot] = await Promise.all([
        specs.findById(execution.spec_id),
        specs.getRevisionSnapshot(execution.revision_id),
      ]);
      const task = snapshot?.elements.find(
        (item) =>
          item.element.id === taskElementId &&
          item.version.payload.kind === "task",
      );
      if (
        spec === null ||
        snapshot === null ||
        task?.version.payload.kind !== "task"
      ) {
        return null;
      }
      return {
        specId: spec.id,
        revisionId: execution.revision_id,
        policy: spec.gatePolicy,
        draft: toLintSnapshot(spec, snapshot),
        coveredCriterionElementIds:
          task.version.payload.coveredCriterionElementIds,
      };
    },
    async getCriterionVersion(revisionId, criterionElementId) {
      const snapshot = await specs.getRevisionSnapshot(revisionId);
      const criterion = snapshot?.elements.find(
        (item) => item.element.id === criterionElementId,
      );
      return snapshot !== null &&
        snapshot !== undefined &&
        criterion !== undefined
        ? {
            specId: snapshot.revision.specId,
            revisionNumber: snapshot.revision.number,
            payloadHash: criterion.version.payloadHash,
          }
        : null;
    },
    wasCriterionDeliveredByMergedExecution: async () => false,
  });
  evidenceRef.current = evidence;

  // Late-bound: the graph-workflow route handlers are constructed further
  // down (they need the workflow manager), but the execution service's gate
  // port must reach their non-HTTP definition-approval seam.
  const workflowDefinitionGateRef: {
    approve:
      | ((input: {
          projectName: string;
          sessionName: string;
          workflowExecutionId: string;
          definitionId: string;
          definitionRevision: number;
        }) => Promise<
          Awaited<
            ReturnType<ExecutionStartGatePort["approveWorkflowDefinition"]>
          >
        >)
      | null;
    hasPending:
      | ((input: {
          projectName: string;
          sessionName: string;
          definitionId: string;
          definitionRevision: number;
        }) => Promise<string | null>)
      | null;
    ensurePending:
      | ((input: {
          projectName: string;
          sessionName: string;
          definitionId: string;
          definitionRevision: number;
        }) => ReturnType<
          ExecutionStartGatePort["ensurePendingDefinitionApproval"]
        >)
      | null;
    launchApproved:
      | ((input: {
          projectName: string;
          sessionName: string;
          definitionId: string;
          definitionRevision: number;
          ownerConversationId: string | null;
        }) => ReturnType<ExecutionStartGatePort["launchApprovedDefinition"]>)
      | null;
  } = {
    approve: null,
    hasPending: null,
    ensurePending: null,
    launchApproved: null,
  };

  const executionStartGate: ExecutionStartGatePort = {
    async launchApprovedDefinition(input) {
      if (workflowDefinitionGateRef.launchApproved === null) {
        return { ok: false, reason: "unavailable" };
      }
      return workflowDefinitionGateRef.launchApproved(input);
    },
    async hasPendingDefinitionApproval(input) {
      if (workflowDefinitionGateRef.hasPending === null) return null;
      return workflowDefinitionGateRef.hasPending(input);
    },
    async ensurePendingDefinitionApproval(input) {
      if (workflowDefinitionGateRef.ensurePending === null) {
        return { ok: false, reason: "unavailable" };
      }
      return workflowDefinitionGateRef.ensurePending(input);
    },
    grantApproval: (input) =>
      reviewService.grantGateApproval({ ...input, gate: "execution_start" }),
    async approveWorkflowDefinition(input) {
      if (workflowDefinitionGateRef.approve === null) {
        return { ok: false, reason: "unavailable" };
      }
      return workflowDefinitionGateRef.approve(input);
    },
  };

  const execution = createExecutionService({
    specsRepo: specs,
    deliveryRepo: delivery,
    linksRepo: links,
    eventsRepo,
    reviewRepo: review,
    events,
    workflowDefinitions: definitions,
    writeQueue,
    nextId: newId,
    now,
    ingestExecutionEvidence,
    // The fixture has no sessions store; every named session resolves.
    sessionExists: async () => true,
    // Late-bound like the definition gate below: reports the fixture's live
    // workflow status so read-path reconciliation sees the run instead of
    // treating the linked workflow as deleted (null now means "abandon").
    getWorkflowExecutionStatus: async (workflowExecutionId) =>
      activeWorkflowExecution !== null &&
      activeWorkflowExecution.id === workflowExecutionId
        ? activeWorkflowExecution.status
        : null,
    getPublishedMerge: async (workflowExecutionId) =>
      jobs.findLatestPublishedMergeByExecutionId(workflowExecutionId),
    runInImmediateTransaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },
    policyNotifier,
    // Late-bound over the plan service composed below: a launch only asks
    // after the fixture is fully wired.
    deliveryPlanLaunch: {
      resolveLaunch: (launchInput) => deliveryPlan.resolveLaunch(launchInput),
      park: (parkInput) => deliveryPlan.park(parkInput),
      recordLaunch: (launchInput) => deliveryPlan.recordLaunch(launchInput),
    },
    plansRepo: plans,
    deliveryPlanCapture: {
      async openSeededReplacement(replacementInput) {
        const opened = await deliveryPlan.open({
          spec: replacementInput.spec,
          seedFromLast: true,
          actor: replacementInput.actor,
        });
        return opened.ok
          ? { ok: true, value: { attemptId: opened.value.attempt.id } }
          : opened;
      },
    },
    executionStartGate,
    // Late-bound over the same workflow seams production wires: abort sends
    // the real manager's abort event and release performs the explicit
    // archive act, so the abandon coordinator drives the run exactly as it
    // does live. `cleanupFaults` is the only test affordance — it injects the
    // infrastructure faults a phase boundary has to survive.
    workflowCleanup: {
      async observe(target) {
        cleanupFaults.beforeOp?.("observe");
        return observeWorkflowPlacement(target.workflowExecutionId);
      },
      async abort(target) {
        cleanupFaults.beforeOp?.("abort");
        // Models a seam that accepts the call but leaves the run live — the
        // coordinator must not record an aborted phase over it.
        if (cleanupFaults.abortIsNoOp) return { ok: true };
        if (
          activeWorkflowExecution === null ||
          activeWorkflowExecution.id !== target.workflowExecutionId
        ) {
          return { ok: false, reason: "the run no longer owns the slot" };
        }
        await workflowManager.send(target.projectPath, target.sessionName, {
          type: "abort",
        });
        return { ok: true };
      },
      async release(target) {
        cleanupFaults.beforeOp?.("release");
        if (
          activeWorkflowExecution === null ||
          activeWorkflowExecution.id !== target.workflowExecutionId
        ) {
          return { ok: false, reason: "the run no longer owns the slot" };
        }
        archivedWorkflowStatuses.set(
          activeWorkflowExecution.id,
          activeWorkflowExecution.status,
        );
        activeWorkflowExecution = null;
        return { ok: true };
      },
    },
  });

  const failingLinks = new Proxy(
    {},
    {
      get(_target, property) {
        return () => {
          throw new Error(
            `Spec links service is out of spine-fixture scope: ${String(property)}`,
          );
        };
      },
    },
  ) as SpecMutationServices["links"];

  const exportDeps = {
    specs,
    review,
    delivery,
    observeLinkedWorkflow: (target: SpecWorkflowCleanupTarget) =>
      observeWorkflowPlacement(target.workflowExecutionId),
  };

  // Real, not a failing proxy: the spine's whole point is that a spec walks
  // authoring -> plan -> execution through the same services production wires,
  // and a plan surface that throws would hide a break in that walk.
  const deliveryPlan = createDeliveryPlanService({
    plans,
    reviewRepo: review,
    events,
    policyNotifier,
    runInTransaction<T>(operation: () => T): T {
      return db.transaction(operation).immediate();
    },
    async currentApprovedRevision(specId) {
      const approved = (await specs.listRevisions(specId))
        .filter((revision) => revision.state === "approved")
        .sort((left, right) => right.number - left.number)[0];
      return approved === undefined
        ? null
        : specs.getRevisionSnapshot(approved.id);
    },
    revisionSnapshot: (revisionId) => specs.getRevisionSnapshot(revisionId),
    deliveryDelta({ spec, pinned, sinceExecutionId }) {
      return loadDeliveryDelta(
        {
          getRevisionSnapshot: (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          findExecutionsBySpecId:
            delivery.findExecutionsBySpecId.bind(delivery),
          findCriterionDispositionsByExecution:
            delivery.findCriterionDispositionsByExecution.bind(delivery),
          findProofVerdictsByCriterionRevision:
            delivery.findProofVerdictsByCriterionRevision.bind(delivery),
          findWaiverById: delivery.findWaiverById.bind(delivery),
        },
        {
          spec,
          currentApprovedSnapshot: pinned,
          ...(sinceExecutionId === null ? {} : { sinceExecutionId }),
        },
      );
    },
    // The same resolution production performs, over the fixture's own rows: a
    // stubbed null would hide the legacy-import branch from every spine test.
    latestLegacyDeliverySource: (specId) =>
      resolveLegacyDeliverySource(
        delivery.findExecutionsBySpecId(specId),
        (revisionId) => specs.getRevisionSnapshot(revisionId),
      ),
    // The production read, over the fixture's own rows: a stubbed empty list
    // would hide the seeded-replacement path from every spine test.
    async capturedDiscoveries({ specId }) {
      return plans.findDiscoveriesBySpecId(specId).map((row) => {
        const task = discoveredTaskSchema.parse(
          JSON.parse(row.discovered_task_json),
        );
        return {
          discoveryId: row.id,
          title: task.title,
          instructions: task.instructions,
          coveredCriterionElementIds: task.coveredCriterionElementIds,
        };
      });
    },
    classifyDeliveredElsewhere: ({
      claim,
      criterionElementId,
      deliveredByExecutionId,
    }) =>
      classifyEarlierMergedDelivery(
        {
          findExecutionById: delivery.findExecutionById.bind(delivery),
          findCriterionDisposition:
            delivery.findCriterionDisposition.bind(delivery),
        },
        { id: claim.id, spec_id: claim.specId, created_at: claim.createdAt },
        {
          criterion_element_id: criterionElementId,
          delivered_by_execution_id: deliveredByExecutionId,
        },
      ),
    // The same resolution production performs, against the fixture's own
    // revision store: the spine walks a plan through propose, and propose
    // materializes, so a stubbed context would let a compile break go unseen.
    async compilationContext({ pinnedRevisionId }) {
      const snapshot = await specs.getRevisionSnapshot(pinnedRevisionId);
      if (snapshot === null) return null;
      return {
        criteria: snapshot.elements.flatMap(({ element, version }) =>
          version.payload.kind === "criterion"
            ? [
                {
                  criterionElementId: element.id,
                  handle: `C${element.number ?? 0}`,
                  text: version.payload.text,
                  validationStrategy: version.payload.validationStrategy,
                },
              ]
            : [],
        ),
        registeredValidationCommandNames: ["typecheck", "test", "lint"],
        // Mirrors production: a delivery-plan candidate never parks for
        // workflow definition approval, because the plan sign-off already
        // admitted the execution-start gate.
        defaults: {
          approvalRequired: false,
          workflowConfig:
            options.pinnedAllowAgentTaskAdd === undefined
              ? {}
              : {
                  mutability: {
                    allowAgentTaskAdd: options.pinnedAllowAgentTaskAdd,
                    allowAgentContextAdd: false,
                  },
                },
        },
      };
    },
    nextId: () => newId("delivery-plan"),
    now,
  });

  const services: SpecSpineWorld["services"] = {
    authoring,
    review: reviewService,
    evidence,
    execution,
    links: failingLinks,
    deliveryPlan,
    import: createImportService({ specs, review, links, events, newId, now }),
    ingestEvidenceBestEffort: (executionId) =>
      ingest.ingestBestEffort(executionId),
    async verify(specId) {
      return verifyExportState(await loadSpecExportState(exportDeps, specId));
    },
  };

  const measures = createMeasuresQuery({
    specs,
    events: eventsRepo,
    delivery,
    workflowEvents,
    loadOriginMap: loadFixtureOriginMap,
    now,
  });

  const resolveProjectPath = async (name: string) =>
    name === SPINE_PROJECT_NAME ? SPINE_PROJECT_PATH : null;

  const readHandlers = createSpecRouteHandlers({
    resolveProjectPath,
    listSpecs: (projectPath) => specs.listByProject(projectPath),
    resolveSpec: (projectPath, slug) => authoring.getSpec(projectPath, slug),
    listAliases: (specId) => specs.listAliases(specId),
    listRevisions: (specId) => specs.listRevisions(specId),
    getRevisionSnapshot: (revisionId) =>
      authoring.getRevisionSnapshot(revisionId),
    lintDraft: (specId, revisionId) => authoring.lintDraft(specId, revisionId),
    findApprovalsBySpecId: (specId) => review.findApprovalsBySpecId(specId),
    findCommentsByRevision: (revisionId) =>
      review.findCommentsByRevision(revisionId),
    findEventsBySpecId: (specId) => eventsRepo.findBySpecId(specId),
    findGateAdmissionsBySpecId: (specId) =>
      review.findGateAdmissionsBySpecId(specId),
    findLinksBySpecId: (specId) => links.findBySpecId(specId),
    getLinkedTickets: async () => [],
    findQuestionsBySpecId: (specId) => review.findQuestionsBySpecId(specId),
    findAssumptionsBySpecId: (specId) => review.findAssumptionsBySpecId(specId),
    findExecutionsBySpecId: (specId) => delivery.findExecutionsBySpecId(specId),
    findTaskClaimsBySpecId: (specId) => delivery.findTaskClaimsBySpecId(specId),
    findWorkflowEventsByExecution: (executionId) =>
      workflowEvents.findByExecution(executionId),
    async reconcileExecution(_projectPath, executionRow) {
      const result = await execution.getStatus(executionRow.id);
      return result.ok
        ? result.value
        : { execution: executionRow, workflowStatus: null };
    },
    async ingestExecutionEvidenceBestEffort(_projectPath, executionId) {
      await ingest.ingestBestEffort(executionId);
    },
    findCriterionDispositionsByExecution: (executionId) =>
      delivery.findCriterionDispositionsByExecution(executionId),
    findEvidenceByCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findEvidenceByCriterionRevision(criterionElementId, revisionId),
    findProofVerdictsByCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findProofVerdictsByCriterionRevision(
        criterionElementId,
        revisionId,
      ),
    findWaiverForCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findWaiverForCriterionRevision(criterionElementId, revisionId),
    findWaiverById: (waiverId) => delivery.findWaiverById(waiverId),
    findWaiversByRevision: (revisionId) =>
      delivery.findWaiversByRevision(revisionId),
    async exportSpec(specId) {
      return renderCanonicalBundle(
        await loadSpecExportState(exportDeps, specId),
      );
    },
    async verifySpec(specId) {
      return verifyExportState(await loadSpecExportState(exportDeps, specId));
    },
    measureProject: (projectPath) => measures.forProject(projectPath),
  });

  const auth: AgentAuth = {
    async requireToken(request) {
      const result = await this.validateOptionalToken(request);
      return result.kind === "valid"
        ? null
        : Response.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken(request) {
      const value = request.headers.get("authorization");
      if (value === null) return { kind: "absent" };
      return value.startsWith("Bearer ")
        ? { kind: "valid" }
        : { kind: "invalid" };
    },
  };

  const writeHandlers = createSpecWriteRouteHandlers({
    auth,
    resolveProjectPath,
    resolveSpec: (projectPath, slug) => specs.resolve(projectPath, slug),
    getServices: async () => services,
  });

  function registerMergeComposition(): void {
    const deliveryGate = createDeliveryGate({
      deliveryRepo: delivery,
      reviewRepo: review,
      specsRepo: specs,
      evidenceService: evidence,
      ingestExecutionEvidence,
      recordIntervention: recordMutation,
      getProjectDisplayName: () => SPINE_PROJECT_NAME,
      // Mirrors production composition: the gate's missing-approval refusal
      // opens the same durable Needs You request Spec Studio and the CLI use.
      async requestDeliveryApproval({
        specId,
        revisionId,
        workflowExecutionId,
      }) {
        await reviewService.requestApproval({
          specId,
          revisionId,
          gate: "delivery",
          subject: "delivery",
          actor: {
            kind: "agent",
            conversationId: `workflow:${workflowExecutionId}`,
          },
        });
      },
      now,
      newAdmissionId: () => newId("admission"),
      events,
      writeQueue,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier,
      gitProbesForProject: () => ({
        isAncestor: async (ancestorSha, descendantSha) =>
          isCommitAncestor(ancestorSha, descendantSha),
        async relevantTreeHash(commitSha) {
          const tree = treeByCommit.get(commitSha);
          if (tree === undefined) {
            throw new Error(`No relevant tree registered for ${commitSha}`);
          }
          return tree;
        },
      }),
      async resolveCandidateValidation(input) {
        const source = jobs.findMergeValidationByExecutionIdAndRef(
          input.workflowExecutionId,
          input.validationRef,
        );
        return source === null
          ? null
          : {
              ...source,
              producer: {
                kind: "agent" as const,
                conversationId: SPINE_CONVERSATION_ID,
              },
            };
      },
    });
    const lifecycleCallbacks = createExecutionLifecycleCallbacks({
      specsRepo: specs,
      deliveryRepo: delivery,
      linksRepo: links,
      eventsRepo,
      reviewRepo: review,
      events,
      writeQueue,
      nextId: newId,
      now,
      ingestExecutionEvidence,
      getPublishedMerge: async (workflowExecutionId) =>
        jobs.findLatestPublishedMergeByExecutionId(workflowExecutionId),
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier,
      lifecycleGate: {
        async requestApproval(input) {
          const result = await reviewService.requestApproval({
            specId: input.specId,
            revisionId: input.revisionId,
            gate: "execution_start",
            subject: "execution_start",
            actor: input.actor,
          });
          if (!result.ok) {
            throw new Error(result.refusal.unmetConditions.join(" "));
          }
        },
        grantApproval: (input) =>
          reviewService.grantGateApproval({
            ...input,
            gate: "execution_start",
          }),
      },
    });
    registerSpecWorkflowComposition({
      deliveryGate,
      lifecycleCallbacks,
      mergeAssociation: createMergeAssociationResolver({
        findActiveExecutionsBySessionName:
          delivery.findActiveExecutionsBySessionName,
        getSessionTargetBranch: () => null,
      }),
      mergeDeliveryLifecycle: {
        markDelivered: (workflowExecutionId, mergeHash) =>
          lifecycleCallbacks.markDelivered(workflowExecutionId, mergeHash),
      },
    });
  }

  async function runMerge(jobId: string, scenario: MergeScenario) {
    const lifecycle = createRegisteredGraphExecutionLifecycleCallbacks();
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => scenarioMachine(scenario),
      deliveryGate: createRegisteredDeliveryGateEvaluator(),
      markDelivered: lifecycle.markDelivered,
      runMachine: runRegisteredMergeJob,
      recordMergeIntent: () => undefined,
    });
    return runner.run({
      jobId,
      projectPath: SPINE_PROJECT_PATH,
      projectName: SPINE_PROJECT_NAME,
      sessionName: SPINE_SESSION_NAME,
      contextId: "context-final-publish",
      branchName: "cc/spec-spine",
      featureWorktreePath: `${SPINE_PROJECT_PATH}/.worktrees/${SPINE_SESSION_NAME}`,
      targetBranch: "main",
      targetWorktreePath: SPINE_PROJECT_PATH,
      message: "Publish the spec spine feature",
      executionId: SPINE_WORKFLOW_EXECUTION_ID,
      finalPublish: true,
      validationMode: {
        mode: "run",
        source: "graph_lane_merge",
        selection: { mode: "only", commands: [] },
      },
    });
  }

  async function postAction(
    slug: string,
    action: string,
    body: unknown,
    transport: "agent" | "human",
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (transport === "agent") {
      headers.authorization = `Bearer ${SPINE_BEARER_TOKEN}`;
      headers[SPEC_CALLER_CONVERSATION_HEADER] = SPINE_CONVERSATION_ID;
    }
    const projectAction = ["create", "promote-conversation", "graduate-ticket"];
    if (projectAction.includes(action)) {
      const request = new Request(
        `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/actions/${action}`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      return writeHandlers.projectActionPOST(request, {
        params: Promise.resolve({ name: SPINE_PROJECT_NAME, action }),
      });
    }
    const request = new Request(
      `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${slug}/actions/${action}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    return writeHandlers.specActionPOST(request, {
      params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug, action }),
    });
  }

  async function getRoute(
    handler:
      | "listSpecsGET"
      | "getSpecGET"
      | "getSpecStatusGET"
      | "getSpecElementGET"
      | "getSpecMeasuresGET"
      | "getSpecVerifyGET",
    params: Record<string, string>,
  ): Promise<Response> {
    const request = new Request("http://cc.test/api/specs/read");
    return readHandlers[handler](request, {
      params: Promise.resolve({ name: SPINE_PROJECT_NAME, ...params }),
    });
  }

  // ---- Production workflow gate: the REAL graph-workflow manager + route
  // handlers drive definition review and workflow start, so the spec side is
  // linked exclusively through the registered lifecycle port — the same seam
  // production uses. Only the lane/agent execution loop is inert.
  let activeWorkflowExecution: GraphWorkflowExecution | null = null;
  /**
   * Runs released from the slot keep their terminal status here, mirroring the
   * production archive: an execution that has been cleared is `archived`, not
   * `missing`, and the abandon coordinator must tell those apart.
   */
  const archivedWorkflowStatuses = new Map<string, GraphWorkflowStatus>();
  const cleanupFaults: SpecSpineWorld["cleanupFaults"] = {
    beforeOp: null,
    abortIsNoOp: false,
  };
  /**
   * Where a run stands, as the production locate seam answers it. Shared by the
   * cleanup port and by spec verification: the two must agree about slot
   * ownership, but only the cleanup port carries the fault injection — an
   * unreachable cleanup seam is not an unreachable read path.
   */
  async function observeWorkflowPlacement(
    workflowExecutionId: string,
  ): Promise<SpecWorkflowCleanupObservation> {
    if (
      activeWorkflowExecution !== null &&
      activeWorkflowExecution.id === workflowExecutionId
    ) {
      return { kind: "active", status: activeWorkflowExecution.status };
    }
    const archivedStatus = archivedWorkflowStatuses.get(workflowExecutionId);
    return archivedStatus === undefined
      ? { kind: "missing" }
      : { kind: "archived", status: archivedStatus };
  }
  // Read-modify-write backing the sync `mutateActive`; awaits `fn` so a
  // synchronous reducer is applied exactly as the production seam does.
  const mutateActiveImpl = async (
    _projectPath: string,
    _sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | GraphWorkflowExecution
      | { execution: GraphWorkflowExecution; events: unknown[] }
      | Promise<
          | GraphWorkflowExecution
          | { execution: GraphWorkflowExecution; events: unknown[] }
        >,
  ): Promise<GraphWorkflowExecution> => {
    if (activeWorkflowExecution === null) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }
    const result = await fn(structuredClone(activeWorkflowExecution));
    const carriesEvents =
      typeof result === "object" && "execution" in result && "events" in result;
    activeWorkflowExecution = carriesEvents
      ? result.execution
      : (result as GraphWorkflowExecution);
    // The production seam persists a reducer's extra events in the same write
    // that commits the execution. Dropping them here would let a durable-audit
    // assertion pass or fail on the fixture rather than on the code under test.
    if (carriesEvents && result.events.length > 0) {
      workflowEvents.appendMany(
        SPINE_PROJECT_PATH,
        SPINE_SESSION_NAME,
        activeWorkflowExecution.id,
        now(),
        result.events as GraphWorkflowExecutionEvent[],
      );
    }
    return activeWorkflowExecution;
  };
  const workflowExecutionRepository = {
    async getActive(): Promise<GraphWorkflowExecution | null> {
      return activeWorkflowExecution;
    },
    async create(
      _projectPath: string,
      _sessionName: string,
      seed: {
        definition: WorkflowDefinitionRecord["definition"];
        definitionId: string;
        definitionRevision: number;
        executionId: string;
        startedAt: string;
        inputs: Record<string, string>;
        launchedTier: TemplateTier;
        ownerConversationId: string | null;
      },
    ): Promise<GraphWorkflowExecution> {
      // Resolve the config cascade and build the runtime maps from THIS
      // definition, as production start does. A raw cast would leave the
      // contexts unresolved and the runtime maps describing some other graph,
      // which any live edit's frontier check reads.
      const workingDefinition = resolveSpineWorkingDefinition(
        seed.definition,
        now,
        options.currentGlobalAllowAgentTaskAdd ?? false,
      );
      activeWorkflowExecution = createWorkflowExecution({
        id: seed.executionId,
        seedDefinitionId: seed.definitionId,
        seedDefinitionRevision: seed.definitionRevision,
        boundInputs: seed.inputs,
        launchedTier: seed.launchedTier,
        ownerConversationId: seed.ownerConversationId,
        definitionApproval:
          seed.definition.approvalRequired === true
            ? { requestedAt: seed.startedAt, approvedAt: null }
            : null,
        workingDefinition,
        contextStates: buildInitialContextStates(workingDefinition),
        taskStates: buildInitialTaskStates(workingDefinition),
        startedAt: seed.startedAt,
      });
      return activeWorkflowExecution;
    },
    async archiveActive(): Promise<GraphWorkflowArchiveOutcome> {
      const archived = activeWorkflowExecution;
      activeWorkflowExecution = null;
      return archived === null
        ? { archived: false, reason: "no_active" }
        : { archived: true, execution: archived };
    },
    async update(
      _projectPath: string,
      _sessionName: string,
      execution: GraphWorkflowExecution,
    ): Promise<void> {
      activeWorkflowExecution = execution;
    },
    mutateActive: mutateActiveImpl,
    async markContextEventsPreReset(): Promise<number> {
      return 0;
    },
  };
  const workflowManager = createGraphWorkflowManager({
    executionRepository: workflowExecutionRepository,
    loadDefinition: async (_projectPath, definitionId) =>
      definitions.findById(definitionId),
    now,
    createExecutionId: () => SPINE_WORKFLOW_EXECUTION_ID,
  });
  const spineSession: SessionState = {
    sessionName: SPINE_SESSION_NAME,
    worktreePath: `${SPINE_PROJECT_PATH}/.worktrees/${SPINE_SESSION_NAME}`,
    branchName: "cc/spec-spine",
    createdAt: "2026-07-18T10:00:00.000Z",
    lastActivityAt: "2026-07-18T10:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
  const unsupported = (operation: string) => async (): Promise<never> => {
    throw new Error(`${operation} is not supported by the spine fixture`);
  };
  const workflowHandlers = createGraphWorkflowExecutionRouteHandlers({
    resolveProjectPath: async (name) =>
      name === SPINE_PROJECT_NAME ? SPINE_PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === SPINE_PROJECT_PATH && sessionName === SPINE_SESSION_NAME
        ? spineSession
        : null,
    normalizeExecutionAfterRestart: async () => activeWorkflowExecution,
    startExecution: (input) => workflowManager.start(input),
    markRunning: (
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) =>
      createRegisteredGraphExecutionLifecycleCallbacks().markRunning(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      ),
    awaitingDefinitionApproval: (
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) =>
      createRegisteredGraphExecutionLifecycleCallbacks().awaitingDefinitionApproval?.(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      ) ?? Promise.resolve(),
    admitDefinitionApproval: (
      context,
      workflowExecutionId,
      definitionId,
      definitionRevision,
    ) =>
      createRegisteredGraphExecutionLifecycleCallbacks().admitDefinitionApproval?.(
        context,
        workflowExecutionId,
        definitionId,
        definitionRevision,
      ) ?? Promise.resolve({ ok: true as const }),
    recordDefinitionApproval: (input) =>
      workflowManager.recordDefinitionApproval(input),
    async kickOffExecutionLoop() {},
    getActiveExecution: async () => activeWorkflowExecution,
    pauseExecution: (projectPath, sessionName) =>
      workflowManager.send(projectPath, sessionName, { type: "pause" }),
    resumeExecution: unsupported("resumeExecution"),
    // The seam behind `cctl workflow live abort`, wired exactly as production
    // wires it, so the recovery verb an orphan finding names is executable
    // here rather than modelled.
    abortExecution: (projectPath, sessionName) =>
      workflowManager.send(projectPath, sessionName, { type: "abort" }),
    resetExecutionContext: unsupported("resetExecutionContext"),
    resetExecutionContextAssignment: unsupported(
      "resetExecutionContextAssignment",
    ),
    archiveExecution: async (_projectPath, _sessionName, _audit, guard) => {
      const active = activeWorkflowExecution;
      if (active === null) return { archived: false, reason: "no_active" };
      if (guard !== undefined && !guard(active)) {
        return { archived: false, reason: "guard_rejected", execution: active };
      }
      // Released runs are archived, not gone: the locate seam must keep
      // telling "cleared" apart from "never existed".
      archivedWorkflowStatuses.set(active.id, active.status);
      activeWorkflowExecution = null;
      return { archived: true, execution: active };
    },
    recordPendingHaltReason: (input) =>
      workflowManager.recordPendingHaltReason(input),
    drainAndHalt: (input) => workflowManager.drainAndHalt(input),
    recordApprovalDecision: unsupported("recordApprovalDecision"),
    auth: {
      async validateOptionalToken(request) {
        const header = request.headers.get("authorization");
        if (header === null) return { kind: "absent" };
        return header === `Bearer ${SPINE_BEARER_TOKEN}`
          ? { kind: "valid" }
          : { kind: "invalid" };
      },
    },
  });
  workflowDefinitionGateRef.approve = async (input) =>
    workflowHandlers.approveDefinition({
      projectPath: SPINE_PROJECT_PATH,
      projectName: input.projectName,
      sessionName: input.sessionName,
      expectedExecutionId: input.workflowExecutionId,
      expectedDefinitionId: input.definitionId,
      expectedDefinitionRevision: input.definitionRevision,
    });
  workflowDefinitionGateRef.hasPending = (input) =>
    workflowHandlers.hasPendingDefinitionApproval({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      expectedDefinitionId: input.definitionId,
      expectedDefinitionRevision: input.definitionRevision,
    });
  // The production start+kickoff seam, exactly as `launchGraphWorkflowExecution`
  // wires it live: the same route handlers, the same manager, and the owner
  // conversation the spec-launch seam resolved server-side.
  workflowDefinitionGateRef.launchApproved = async (input) => {
    try {
      const launched = await workflowHandlers.launch({
        projectPath: SPINE_PROJECT_PATH,
        projectName: input.projectName,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        expectedDefinitionRevision: input.definitionRevision,
        ownerConversationId: input.ownerConversationId,
      });
      return { ok: true, workflowExecutionId: launched.id };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
  workflowDefinitionGateRef.ensurePending = async (input) => {
    const response = await postWorkflowRoute("START", {
      definitionId: input.definitionId,
      definitionRevision: input.definitionRevision,
    });
    const pendingExecutionId =
      await workflowHandlers.hasPendingDefinitionApproval({
        projectPath: SPINE_PROJECT_PATH,
        sessionName: SPINE_SESSION_NAME,
        expectedDefinitionId: input.definitionId,
        expectedDefinitionRevision: input.definitionRevision,
      });
    if (pendingExecutionId !== null) {
      return { ok: true, workflowExecutionId: pendingExecutionId };
    }
    const payload = (await response.json()) as {
      code?: string;
      error?: string;
    };
    return {
      ok: false,
      reason:
        payload.error ??
        payload.code ??
        `workflow start failed with status ${response.status}`,
    };
  };

  /**
   * Mirrors the production execution loop's failed-merge handling
   * (execution-loop.ts join failure): record the structured pending halt
   * reason on the active workflow execution, then drain to `halted` so the
   * status/CLI surfaces report the machine-readable refusal.
   */
  async function haltWorkflowExecution(
    reason: Parameters<
      typeof workflowManager.recordPendingHaltReason
    >[0]["reason"],
  ): Promise<void> {
    await workflowManager.recordPendingHaltReason({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
      reason,
    });
    await workflowManager.drainAndHalt({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
    });
  }

  /**
   * Park the active run at `paused` through the same read-modify-write seam
   * the production pause route mutates through. `paused` is the one status the
   * lifecycle contract calls non-terminal AND explicitly archivable, so it is
   * the only way to build an archived-but-unfinished run — the shape that
   * separates "no slot to recover" from "not ended yet".
   */
  async function pauseWorkflowExecution(): Promise<void> {
    const response = await postWorkflowRoute("PAUSE");
    if (!response.ok) {
      throw new Error(
        `Workflow pause failed: ${JSON.stringify(await response.json())}`,
      );
    }
  }

  async function markWorkflowContextRunning(
    contextId: string,
    taskId: string,
  ): Promise<void> {
    await mutateActiveImpl(
      SPINE_PROJECT_PATH,
      SPINE_SESSION_NAME,
      (current) => {
        const context = current.contextStates[contextId];
        const task = current.taskStates[taskId];
        if (context === undefined || task === undefined) {
          throw new Error(
            `Unknown workflow context/task ${contextId}/${taskId}`,
          );
        }
        return {
          ...current,
          activeContextIds: [contextId],
          contextStates: {
            ...current.contextStates,
            [contextId]: {
              ...context,
              status: "running",
              iterationCount: Math.max(1, context.iterationCount),
            },
          },
          taskStates: {
            ...current.taskStates,
            [taskId]: {
              ...task,
              status: "running",
              startedAt: now(),
              lastConversationId: SPINE_CONVERSATION_ID,
            },
          },
          machineSnapshot: {
            schemaVersion: 1,
            lifecycleStatus: "running",
            activeContextId: contextId,
            recoveryMode: "none",
            hasLiveIteration: true,
          },
        };
      },
    );
  }

  async function setWorkflowExecutionStatus(
    status: GraphWorkflowExecution["status"],
  ): Promise<void> {
    await mutateActiveImpl(
      SPINE_PROJECT_PATH,
      SPINE_SESSION_NAME,
      (current) => ({
        ...current,
        status,
      }),
    );
  }

  async function postWorkflowRoute(
    handler:
      | "START"
      | "APPROVE_DEFINITION"
      | "STATUS"
      | "EXECUTION"
      | "PAUSE"
      | "ABORT"
      | "RELEASE",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const suffix =
      handler === "APPROVE_DEFINITION"
        ? "/approve-definition"
        : handler === "EXECUTION"
          ? "/execution"
          : handler === "PAUSE"
            ? "/pause"
            : handler === "ABORT"
              ? "/abort"
              : handler === "RELEASE"
                ? "/release"
                : "";
    const isGet = handler === "STATUS" || handler === "EXECUTION";
    const request = new Request(
      `http://cc.test/api/projects/${SPINE_PROJECT_NAME}/sessions/${SPINE_SESSION_NAME}/graph-workflow${suffix}`,
      isGet
        ? { method: "GET", headers }
        : {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? {}),
          },
    );
    const context = {
      params: Promise.resolve({
        name: SPINE_PROJECT_NAME,
        session: SPINE_SESSION_NAME,
      }),
    };
    return workflowHandlers[handler](request, context);
  }

  /**
   * The REAL amend route over this world's live execution and event store, so
   * the audited amendment is exercised as `cctl workflow live amend` and the
   * Studio control reach it. Only the agent-profile resolution is stubbed — the
   * library is not part of what an amendment decides.
   */
  const amendEventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      publishedSse.push(event);
    },
  });
  const amendHandlers = createGraphWorkflowAmendRouteHandlers({
    resolveProjectPath: async (name) =>
      name === SPINE_PROJECT_NAME ? SPINE_PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === SPINE_PROJECT_PATH && sessionName === SPINE_SESSION_NAME
        ? spineSession
        : null,
    getActiveExecution: async () => activeWorkflowExecution,
    mutateActive: mutateActiveImpl,
    buildLiveEditDeps: async () =>
      spineLiveEditDeps(now, options.currentGlobalAllowAgentTaskAdd ?? false),
    prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
    publishLiveEditApplied: amendEventPublisher.publishLiveEditApplied,
    publishCharterUpdated: amendEventPublisher.publishCharterUpdated,
    publishExecutionAmended: amendEventPublisher.publishExecutionAmended,
    writeCharterDocument: async () => {},
    auth: {
      async validateOptionalToken(request) {
        const header = request.headers.get("authorization");
        if (header === null) return { kind: "absent" };
        return header === `Bearer ${SPINE_BEARER_TOKEN}`
          ? { kind: "valid" }
          : { kind: "invalid" };
      },
    },
  });

  const runtimeEditHandlers = createGraphWorkflowRuntimeEditRouteHandlers({
    resolveProjectPath: async (name) =>
      name === SPINE_PROJECT_NAME ? SPINE_PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === SPINE_PROJECT_PATH && sessionName === SPINE_SESSION_NAME
        ? spineSession
        : null,
    getActiveExecution: async () => activeWorkflowExecution,
    mutateActive: mutateActiveImpl,
    buildLiveEditDeps: async () =>
      spineLiveEditDeps(now, options.currentGlobalAllowAgentTaskAdd ?? false),
    prepareAssignmentSnapshots: stubAssignmentSnapshotPreparation(),
    publishLiveEditApplied: amendEventPublisher.publishLiveEditApplied,
    publishCharterUpdated: amendEventPublisher.publishCharterUpdated,
    writeCharterDocument: async () => {},
  });

  /**
   * The REAL generic live-edit route — the surface a delivery plan's locked
   * regions have to refuse and a legacy definition's unlocked ones must still
   * accept.
   */
  async function postWorkflowLiveEdit(body: unknown): Promise<Response> {
    const request = new Request(
      `http://cc.test/api/projects/${SPINE_PROJECT_NAME}/sessions/${SPINE_SESSION_NAME}/graph-workflow/runtime-edits`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return runtimeEditHandlers.POST(request, {
      params: Promise.resolve({
        name: SPINE_PROJECT_NAME,
        session: SPINE_SESSION_NAME,
      }),
    });
  }

  async function postWorkflowAmend(
    body: unknown,
    transport: "agent" | "human",
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (transport === "agent") {
      headers.authorization = `Bearer ${SPINE_BEARER_TOKEN}`;
      headers[SPEC_CALLER_CONVERSATION_HEADER] = SPINE_CONVERSATION_ID;
      headers[SPEC_CALLER_BACKEND_HEADER] = "codex";
    }
    const request = new Request(
      `http://cc.test/api/projects/${SPINE_PROJECT_NAME}/sessions/${SPINE_SESSION_NAME}/graph-workflow/amend`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    return amendHandlers.POST(request, {
      params: Promise.resolve({
        name: SPINE_PROJECT_NAME,
        session: SPINE_SESSION_NAME,
      }),
    });
  }

  return {
    db,
    publishedSse,
    reviewNotifications,
    now,
    repos: {
      specs,
      review,
      delivery,
      links,
      events: eventsRepo,
      workflowEvents,
      jobs,
    },
    services,
    definitions,
    ingest,
    measures,
    readHandlers,
    writeHandlers,
    knownCommits,
    treeByCommit,
    linkCommit,
    isCommitAncestor,
    registerMergeComposition,
    runMerge,
    postAction,
    getRoute,
    postWorkflowRoute,
    postWorkflowAmend,
    postWorkflowLiveEdit,
    haltWorkflowExecution,
    pauseWorkflowExecution,
    markWorkflowContextRunning,
    setWorkflowExecutionStatus,
    readActiveWorkflowExecution: () => activeWorkflowExecution,
    cleanupFaults,
  };
}

export function scenarioMachine(
  scenario: MergeScenario,
  branchName = "cc/spec-spine",
): MergeMachineType {
  return mergeMachine.provide({
    actors: {
      checkUncommitted: fromPromise<
        CheckUncommittedOutput,
        CheckUncommittedInput
      >(async () => ({ hasChanges: false })),
      getCurrentBranch: fromPromise<
        GetCurrentBranchOutput,
        GetCurrentBranchInput
      >(async () => ({ branch: branchName })),
      mergeMain: fromPromise<MergeMainOutput, MergeMainInput>(async () => ({
        status: "clean",
        conflictFiles: [],
      })),
      runValidation: fromPromise<RunValidationOutput, RunValidationInput>(
        async () => scenario.validation,
      ),
      prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(async () => {
        const preparation = scenario.preparations.shift();
        if (preparation === undefined) {
          throw new Error("Scenario exhausted its prepared candidates");
        }
        return preparation;
      }),
      publish: fromPromise<PublishActorOutput, PublishActorInput>(
        async ({ input }) => {
          scenario.publishedCandidates.push(input.preparedSha);
          const publication = scenario.publications.shift();
          if (publication === undefined) {
            throw new Error("Scenario exhausted its publish outcomes");
          }
          return publication;
        },
      ),
    },
  });
}

export interface AuthoredSpineSpec {
  specId: string;
  requirementsRevisionId: string;
  designRevisionId: string;
  draftRevisionId: string;
  requirementId: string;
  criterionOneId: string;
  criterionTwoId: string;
  decisionId: string;
  taskOneId: string;
  taskTwoId: string;
}

/** Builds the approved lineage and a persisted legacy-plan compatibility fixture. */
export async function authorSpineDraft(
  world: SpecSpineWorld,
  slug: string,
  executionStartDial?: "gate" | "notify" | "off",
): Promise<AuthoredSpineSpec> {
  // The create call IS the first draft save: the requirement travels inside
  // it, so no durable spec ever exists without content (R4.1).
  const created = await postJson<{
    spec: { id: string };
    draft: { id: string };
  }>(
    world.postAction(
      slug,
      "create",
      {
        slug,
        name: "Spec Spine Feature",
        gatePolicy:
          executionStartDial === undefined
            ? { preset: "contract-bearing" }
            : {
                preset: "contract-bearing",
                overrides: { execution_start: executionStartDial },
              },
        initialElement: {
          elementId: "element-requirement-1",
          kind: "requirement",
          parentElementId: null,
          position: 0,
          payload: {
            kind: "requirement",
            statement: "The spine feature ships with server-enforced proof.",
            priority: "must",
            risk: "high",
          },
        },
      },
      "agent",
    ),
  );

  const specId = created.spec.id;
  const requirementsRevisionId = created.draft.id;
  const ids: AuthoredSpineSpec = {
    specId,
    requirementsRevisionId,
    designRevisionId: "",
    draftRevisionId: "",
    requirementId: "element-requirement-1",
    criterionOneId: "element-criterion-1",
    criterionTwoId: "element-criterion-2",
    decisionId: "element-decision-1",
    taskOneId: "element-task-1",
    taskTwoId: "element-task-2",
  };

  const criteria: Array<[string, string]> = [
    [ids.criterionOneId, "Deterministic validation passes for the feature."],
    [ids.criterionTwoId, "The feature lands with commit-traceable changes."],
  ];
  for (const [index, [elementId, text]] of criteria.entries()) {
    await postJson(
      world.postAction(
        slug,
        "draft-upsert",
        {
          revisionId: requirementsRevisionId,
          elementId,
          kind: "criterion",
          parentElementId: ids.requirementId,
          position: index + 1,
          payload: {
            kind: "criterion",
            text,
            validationStrategy: { kinds: ["test_run", "validator_verdict"] },
          },
          baseElementVersion: null,
        },
        "agent",
      ),
    );
  }

  await postJson(
    world.postAction(
      slug,
      "propose",
      { revisionId: requirementsRevisionId },
      "agent",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "approve-item",
      {
        revisionId: requirementsRevisionId,
        subjectKind: "requirement",
        elementId: ids.requirementId,
      },
      "human",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "sign-off",
      { revisionId: requirementsRevisionId },
      "human",
    ),
  );

  const designRevision = await postJson<{
    revision: { id: string; authoringStage: string };
  }>(world.postAction(slug, "open-amendment", {}, "agent"));
  ids.designRevisionId = designRevision.revision.id;
  await postJson(
    world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: designRevision.revision.id,
        elementId: ids.decisionId,
        kind: "decision",
        parentElementId: null,
        position: 3,
        payload: {
          kind: "decision",
          title: "Execution boundary",
          chosenApproach: "Compile the approved plan into a workflow.",
          rejectedAlternatives: [],
          reason: "The execution pin remains reviewable and durable.",
          tracedRequirementElementIds: [ids.requirementId],
        },
        baseElementVersion: null,
      },
      "agent",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "propose",
      { revisionId: designRevision.revision.id },
      "agent",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "approve-item",
      {
        revisionId: designRevision.revision.id,
        subjectKind: "decision",
        elementId: ids.decisionId,
      },
      "human",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "sign-off",
      { revisionId: designRevision.revision.id },
      "human",
    ),
  );

  const planRevision = await world.repos.specs.createDraftFromBase({
    id: `revision-legacy-plan-${slug}`,
    specId,
    baseRevisionId: designRevision.revision.id,
    authoringStage: "plan",
    createdAt: world.now(),
  });
  ids.draftRevisionId = planRevision.id;

  await postJson(
    world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: planRevision.id,
        elementId: ids.taskOneId,
        kind: "task",
        parentElementId: null,
        position: 3,
        payload: {
          kind: "task",
          title: "Implement the spine service",
          instructions: "Build the service behind criterion one.",
          tracedRequirementElementIds: [ids.requirementId],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [ids.criterionOneId],
          dependsOnTaskElementIds: [],
        },
        baseElementVersion: null,
      },
      "agent",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: planRevision.id,
        elementId: ids.taskTwoId,
        kind: "task",
        parentElementId: null,
        position: 4,
        payload: {
          kind: "task",
          title: "Wire the spine delivery",
          instructions: "Land the delivery path behind criterion two.",
          tracedRequirementElementIds: [ids.requirementId],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [ids.criterionTwoId],
          dependsOnTaskElementIds: [ids.taskOneId],
        },
        baseElementVersion: null,
      },
      "agent",
    ),
  );

  return ids;
}

export interface ProposedSpineSpec extends AuthoredSpineSpec {
  proposeResponse: {
    revision: { id: string; state: string };
    diff: {
      changeList: Array<{ elementId: string; change: string; kind: string }>;
    };
    absorbedSignOff: boolean;
  };
}

export async function proposeSpineRevision(
  world: SpecSpineWorld,
  slug: string,
  authored: AuthoredSpineSpec,
): Promise<ProposedSpineSpec> {
  const proposeResponse = await postJson<ProposedSpineSpec["proposeResponse"]>(
    world.postAction(
      slug,
      "propose",
      {
        revisionId: authored.draftRevisionId,
      },
      "agent",
    ),
  );
  return { ...authored, proposeResponse };
}

/** Human review through the routes: item approvals, plan approval, sign-off. */
export async function approveAndSignOffSpine(
  world: SpecSpineWorld,
  slug: string,
  authored: AuthoredSpineSpec,
): Promise<void> {
  await postJson(
    world.postAction(
      slug,
      "bulk-approve",
      {
        revisionId: authored.draftRevisionId,
        subjects: [{ subjectKind: "plan", elementId: null }],
      },
      "human",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "sign-off",
      {
        revisionId: authored.draftRevisionId,
      },
      "human",
    ),
  );
}

export interface StartedSpineExecution {
  specExecutionId: string;
  definition: WorkflowDefinitionRecord;
  deliveryPlan?: {
    attemptId: string;
    candidateId: string;
    planHash: string;
    compiledDefinitionHash: string;
  };
}

function spineDeliveryPlanDocument(
  seeded: DeliveryPlanDocument,
  authored: AuthoredSpineSpec,
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...seeded,
    dispositions: [authored.criterionOneId, authored.criterionTwoId].map(
      (criterionElementId) => ({
        criterionElementId,
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      }),
    ),
    contexts: [
      {
        contextId: "ctx-implement",
        title: "Implement the spine service",
        contextType: "delivery",
        criterionElementIds: [authored.criterionOneId],
        acceptanceContract: [
          "The first approved spine criterion is observable in production.",
        ],
        proofPlan: [
          {
            criterionElementId: authored.criterionOneId,
            evidenceKinds: ["validator_verdict"],
            note: "Validate the implementation context against criterion one.",
          },
        ],
      },
      {
        contextId: "ctx-wire",
        title: "Wire the spine delivery",
        contextType: "delivery",
        criterionElementIds: [authored.criterionTwoId],
        acceptanceContract: [
          "The second approved spine criterion is observable in production.",
        ],
        proofPlan: [
          {
            criterionElementId: authored.criterionTwoId,
            evidenceKinds: ["validator_verdict"],
            note: "Validate the production wiring against criterion two.",
          },
        ],
      },
    ],
    tasks: [
      {
        taskId: authored.taskOneId,
        contextId: "ctx-implement",
        title: "Implement the spine service",
        instructions: "Build the service behind criterion one.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionOneId],
      },
      {
        taskId: authored.taskTwoId,
        contextId: "ctx-wire",
        title: "Wire the spine delivery",
        instructions: "Land the delivery path behind criterion two.",
        order: 0,
        contributesToCriterionElementIds: [authored.criterionTwoId],
      },
    ],
    edges: [
      {
        edgeId: "edge-implement-wire",
        fromContextId: "ctx-implement",
        toContextId: "ctx-wire",
      },
    ],
    wiring: [],
    policyOverrides: [],
    touchedSurfaces: ["src/lib/specs/"],
    governance: {
      mission: "Deliver the spine feature from its approved delivery plan.",
      charterInvariants: [
        {
          id: "exact-approval",
          statement:
            "The launched graph is the exact candidate the human approved.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "approved-revision",
          label: "Approved spec revision",
          type: "spec",
          locator: `spec://${authored.specId}/revisions/${authored.draftRevisionId}`,
          description: "The immutable revision this delivery plan pins.",
          appliesTo: null,
          accessPolicy: "worktree-relative",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

export async function startSpineExecution(
  world: SpecSpineWorld,
  slug: string,
  authored: AuthoredSpineSpec,
): Promise<StartedSpineExecution> {
  const opened = deliveryPlanMutationViewSchema.parse(
    await postJson(
      world.postAction(slug, "plan-open", { seedFromLast: false }, "agent"),
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "plan-edit",
      {
        expectedDraftRevision: opened.attempt.draftRevision,
        document: spineDeliveryPlanDocument(opened.document, authored),
      },
      "agent",
    ),
  );
  await postJson(world.postAction(slug, "plan-propose", {}, "agent"));
  const previewResponse = await world.writeHandlers.specPlanPreviewGET(
    new Request(
      `http://cc.test/api/specs/${SPINE_PROJECT_NAME}/${slug}/plan/preview?stage=proposed`,
    ),
    {
      params: Promise.resolve({ name: SPINE_PROJECT_NAME, slug }),
    },
  );
  const preview = deliveryPlanPreviewViewSchema.parse(
    await postJson(Promise.resolve(previewResponse)),
  );
  if (preview.candidateId === null) {
    throw new Error("The proposed spine delivery plan stored no candidate");
  }
  await postJson(
    world.postAction(
      slug,
      "plan-sign-off",
      {
        candidateId: preview.candidateId,
        planHash: preview.planHash,
        compiledDefinitionHash: preview.compiledDefinitionHash,
      },
      "human",
    ),
  );
  world.registerMergeComposition();
  const started = await postJson<{
    execution: { id: string; state: string };
    definition: WorkflowDefinitionRecord;
    deliveryPlan: {
      attemptId: string;
      candidateId: string;
      planHash: string;
      compiledDefinitionHash: string;
    };
  }>(
    world.postAction(
      slug,
      "start-execution",
      {
        revisionId: authored.draftRevisionId,
        sessionName: SPINE_SESSION_NAME,
      },
      "agent",
    ),
  );
  return {
    specExecutionId: started.execution.id,
    definition: started.definition,
    deliveryPlan: started.deliveryPlan,
  };
}

/**
 * Seeds the persisted shape of a legacy compiled run. This is a historical
 * compatibility fixture, not an alternate active start path.
 */
export async function startLegacySpineExecution(
  world: SpecSpineWorld,
  slug: string,
  authored: AuthoredSpineSpec,
): Promise<StartedSpineExecution> {
  const spec = await world.repos.specs.resolve(SPINE_PROJECT_PATH, slug);
  const snapshot = await world.repos.specs.getRevisionSnapshot(
    authored.draftRevisionId,
  );
  if (spec === null || snapshot === null) {
    throw new Error("The historical spine revision could not be read");
  }
  const scope = {
    selectedTaskIds: [authored.taskOneId, authored.taskTwoId],
    selectedCriterionIds: [authored.criterionOneId, authored.criterionTwoId],
    exclusionDispositions: [],
  };
  const scopeHash = hashExecutionScope(scope);
  const executionStartDial = specGateDialSchema.parse(
    resolveDial(spec.gatePolicy, "execution_start"),
  );
  const compiled = compileSpecExecutionPlan({
    spec: { id: spec.id, slug: spec.slug, name: spec.name },
    revisionSnapshot: snapshot,
    scope,
    scopeHash,
    approvalRequired: executionStartDial === "gate",
  });
  const definition = await world.definitions.create({
    name: `${spec.name} revision ${snapshot.revision.number}`,
    description: `Historical compiled execution for ${spec.slug}.`,
    definition: compiled,
    layout: {
      workflowId: "historical-compiled-spec-definition",
      contextPositions: Object.fromEntries(
        compiled.executionContexts.map((context, index) => [
          context.id,
          { x: index * 360, y: 0 },
        ]),
      ),
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
  const createdAt = world.now();
  const execution: SpecExecutionRow = {
    id: `historical-execution-${slug}`,
    spec_id: spec.id,
    revision_id: snapshot.revision.id,
    scope_json: JSON.stringify(scope),
    state: "definition_review",
    execution_start_dial: executionStartDial,
    workflow_definition_id: definition.id,
    workflow_definition_revision: definition.revision,
    workflow_execution_id: null,
    session_name: SPINE_SESSION_NAME,
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  world.repos.delivery.insertExecution(execution);
  for (const criterionElementId of scope.selectedCriterionIds) {
    world.repos.delivery.saveCriterionDisposition({
      execution_id: execution.id,
      criterion_element_id: criterionElementId,
      disposition: "in_scope",
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }
  return { specExecutionId: execution.id, definition };
}

/**
 * Simulates the linked workflow going live and producing evidence: lane
 * commits and passing validation results for every compiled context.
 */
/**
 * Approves the compiled definition through the real workflow-definition gate
 * and starts the workflow through the production route path. The spec
 * execution ends up linked + running exclusively via the registered lifecycle
 * port — the same handoff a live start uses. Returns after asserting that
 * handoff took effect.
 */
export async function startSpineWorkflowThroughProductionGate(
  world: SpecSpineWorld,
  started: StartedSpineExecution,
  slug = "spec-spine",
): Promise<void> {
  // The start/approval handlers report through the registered lifecycle port;
  // make sure this world's composition owns the registration before starting.
  world.registerMergeComposition();
  const existing = world.repos.delivery.findExecutionById(
    started.specExecutionId,
  );
  if (
    existing?.workflow_execution_id === SPINE_WORKFLOW_EXECUTION_ID &&
    existing.state === "running"
  ) {
    return;
  }
  const startResponse = await world.postWorkflowRoute("START", {
    definitionId: started.definition.id,
  });
  if (startResponse.status === 409) {
    const payload = (await startResponse.json()) as { code?: string };
    if (payload.code !== "definition_approval_required") {
      throw new Error(
        `Workflow start was refused for an unexpected reason: ${JSON.stringify(payload)}`,
      );
    }
    // The execution-start gate is a human-only act: approval flows through
    // the spec-side approve-execution-start action on human transport, which
    // records the spec approval + execution_start admission with provenance
    // and then approves the pending workflow definition through the seam.
    const approve = await world.postAction(
      slug,
      "approve-execution-start",
      { executionId: started.specExecutionId },
      "human",
    );
    if (approve.status !== 200) {
      throw new Error(
        `Execution-start approval failed with status ${approve.status}: ${await approve.text()}`,
      );
    }
  } else if (startResponse.status !== 202) {
    throw new Error(
      `Workflow start failed with status ${startResponse.status}`,
    );
  }

  const linked = world.repos.delivery.findExecutionById(
    started.specExecutionId,
  );
  if (
    linked === null ||
    linked.workflow_execution_id !== SPINE_WORKFLOW_EXECUTION_ID ||
    linked.state !== "running"
  ) {
    throw new Error(
      "The production workflow start did not link the spec execution and mark it running",
    );
  }
}

export async function runSpineWorkflowToEvidence(
  world: SpecSpineWorld,
  started: StartedSpineExecution,
  slug = "spec-spine",
): Promise<{ commitShas: string[] }> {
  await startSpineWorkflowThroughProductionGate(world, started, slug);

  const contextIds = started.definition.definition.origin?.sourceUri.startsWith(
    "spec-plan://",
  )
    ? readDeliveryPlanSourceMap(started.definition.definition).contexts.map(
        (entry) => entry.contextId,
      )
    : [
        ...new Set(
          readCompiledOriginMap(started.definition.definition).map(
            (entry) => entry.contextId,
          ),
        ),
      ];
  if (contextIds.length === 0) {
    throw new Error("The compiled definition exposes no origin map");
  }
  const commitShas: string[] = [];
  const workflowEventRows = contextIds.flatMap((contextId, index) => {
    const sha = `commit-${index + 1}`;
    // Each lane commit extends the branch lineage, so downstream candidates
    // that build on the last lane commit contain every earlier one.
    world.linkCommit(sha, index === 0 ? [] : [`commit-${index}`]);
    world.treeByCommit.set(sha, `tree-${sha}`);
    commitShas.push(sha);
    // Production ordering: the context's passing validation precedes the
    // lane commit that seals its tree, so ingest stamps the validation
    // evidence with this lane commit's sha (forward correlation, F24).
    return [
      graphWorkflowExecutionEventSchema.parse({
        occurredAt: world.now(),
        event: {
          type: "graph-workflow-validation-result",
          projectName: SPINE_PROJECT_NAME,
          sessionName: SPINE_SESSION_NAME,
          executionId: SPINE_WORKFLOW_EXECUTION_ID,
          contextId,
          validatorType: "context",
          pass: true,
          summary: "Context validation passed for the spine feature.",
          sessionRef: {
            backend: "claude",
            ref: `validator-${index + 1}`,
            lane: "context_validator",
            refKind: "backend",
          },
        },
      }),
      graphWorkflowExecutionEventSchema.parse({
        occurredAt: world.now(),
        event: {
          type: "graph-workflow-lane-commit",
          projectName: SPINE_PROJECT_NAME,
          sessionName: SPINE_SESSION_NAME,
          executionId: SPINE_WORKFLOW_EXECUTION_ID,
          contextId,
          laneId: `lane-${index + 1}`,
          sha,
          committedAt: world.now(),
        },
      }),
    ];
  });
  world.repos.workflowEvents.appendMany(
    SPINE_PROJECT_PATH,
    SPINE_SESSION_NAME,
    SPINE_WORKFLOW_EXECUTION_ID,
    world.now(),
    workflowEventRows,
  );
  return { commitShas };
}

export async function postJson<T = unknown>(
  responsePromise: Promise<Response>,
): Promise<T> {
  const response = await responsePromise;
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `Spec route call failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body as T;
}
