import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import type Database from "better-sqlite3";
import { fromPromise } from "xstate";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createJobsRepo } from "@/lib/jobs/repo";
import { runRegisteredMergeJob } from "@/lib/jobs/queue";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import {
  createManagedDefinitionTestService,
  type TestManagedDefinitionService,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { dedupeServerOwnedDeliveryPlanSources } from "./delivery-plan-finalization";
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
import { WorkflowStartInputError } from "@/lib/workflow-graph/spec-bridge";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";
import { admitAuthoredWorkflowLaunch } from "@/lib/workflow-graph/authored-launch-admission";
import { createGraphWorkflowMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  stubAssignmentSnapshotPreparation,
  TEST_AGENT_BACKENDS_CONFIG,
} from "@/lib/workflow-graph/test-fixtures";
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
  ClassifyWorktreeInput,
  ClassifyWorktreeOutput,
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
import { createDeliveryGate } from "./delivery-gate-v2";
import { createAuthoredContextOutcomeService } from "@/lib/workflow-graph/authored-context-outcome";
import { loadDeliveryPlanSeedBasis } from "./delivery-plan-basis-query";
import { createDeliveryPlanService } from "./delivery-plan-service";
import {
  executionScopeFromBinding,
  specExecutionBindingSchema,
  type SpecExecutionBinding,
} from "./execution-binding";
import { createSpecExecutionBindingPorts } from "./execution-binding-service";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import { createImportService } from "./import-service";
import {
  loadSpecExportState,
  renderVerifiedCanonicalBundle,
  verifyExportState,
} from "./export";
import {
  createExecutionLifecycleCallbacks,
  createExecutionService,
  type ExecutionStartGatePort,
  type SpecWorkflowCleanupObservation,
  type SpecWorkflowCleanupTarget,
} from "./execution-service";
import { createMeasuresQuery } from "./measures-query";
import type { SpecApprovalRequestsClosedNotice } from "./attention-records";
import type {
  SpecExecutionGateAdmissionNotifier,
  SpecPolicyAdmissionNotice,
} from "./policy-admissions";
import {
  createReviewService,
  type SpecApprovalGrantNotice,
  type SpecApprovalRequestNotice,
} from "./review-service";
import {
  createSpecRouteHandlers,
  createSpecWriteRouteHandlers,
  SPEC_CALLER_CONVERSATION_HEADER,
  type SpecMutationServices,
} from "./route-handlers";
import { registerSpecWorkflowComposition } from "./workflow-composition";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  CONVERSATION_CAPABILITY_HEADER,
  verifyConversationCapability,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_HEADER,
  verifyLaneCapability,
} from "@/lib/agent-gateway/lane-capability";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import type { GraphWorkflowExecutionSeed } from "@/lib/workflow-graph/execution-repository";
import { buildExecutionProvenance } from "@/lib/workflow-graph/execution-origin";

type Db = InstanceType<typeof Database>;

export const SPINE_PROJECT_NAME = "spine";
export const SPINE_PROJECT_PATH = "/repos/spec-spine";
export const SPINE_SESSION_NAME = "spine-session";
export const SPINE_CONVERSATION_ID = "conversation-spine";
export const SPINE_WORKFLOW_EXECUTION_ID = "workflow-execution-spine";
const SPINE_CANDIDATE_ID = "candidate-spine";
const SPINE_CANDIDATE_HASH = `sha256:${"5".repeat(64)}`;
export const SPINE_BEARER_TOKEN = "contract-token";
/**
 * Stands in for the server-only capability signing key. It is deliberately NOT
 * the bearer token: the whole point of the key is that a holder of the exported
 * instance token cannot mint a capability with it, and a fixture that reused
 * the token would prove the opposite of what the routes enforce.
 */
const SPINE_CAPABILITY_SECRET = "spine-server-only-capability-key";

class InMemoryWorkflowDefinitions {
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
    deliveryPlans: ReturnType<typeof createSpecDeliveryPlanRepo>;
    executionBindings: ReturnType<typeof createSpecExecutionBindingRepo>;
    links: ReturnType<typeof createSpecLinksRepo>;
    events: ReturnType<typeof createSpecEventsRepo>;
    workflowEvents: ReturnType<typeof createGraphWorkflowEventsRepo>;
    jobs: ReturnType<typeof createJobsRepo>;
  };
  services: SpecMutationServices & {
    execution: ReturnType<typeof createExecutionService>;
  };
  definitions: InMemoryWorkflowDefinitions;
  /** The managed definitions the delivery-plan service reads and writes. */
  managedDefinitions: TestManagedDefinitionService;
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
      | "ABORT",
    body?: unknown,
    headers?: Record<string, string>,
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
  /**
   * Hold the parked run's definition decision through the production manager,
   * the way a concurrent approval act at its admission gate holds it. Every
   * other decision on that park loses to it.
   */
  reserveWorkflowDefinitionDecision(): Promise<void>;
  markWorkflowContextRunning(contextId: string, taskId: string): Promise<void>;
  setWorkflowExecutionStatus(
    status: GraphWorkflowExecution["status"],
  ): Promise<void>;
  readActiveWorkflowExecution(): GraphWorkflowExecution | null;
  /**
   * The most recently relocated run, whole. History renders from the record, so
   * what an audited release preserved on it — halt reason, abandonment — is
   * only assertable here.
   */
  readArchivedWorkflowExecution(): GraphWorkflowExecution | null;
  /**
   * Fault injection for the spec→workflow cleanup port, so a test can stop the
   * abandon coordinator at a chosen phase boundary and assert the reached
   * phase is durable. `beforeOp` throws to simulate an unreachable workflow
   * store; the `*IsNoOp` flags accept the act but leave the run live, which is
   * how the "never reports success over a live run" invariant is proved for
   * each of the two acts that end a run.
   */
  cleanupFaults: {
    beforeOp: ((op: "observe" | "abort" | "abandon") => void) | null;
    abortIsNoOp: boolean;
    abandonIsNoOp: boolean;
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
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "medium" },
          },
        },
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
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
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
      memory: {
        implementer: {
          read: { value: "ambient", source: "global" },
          contribute: { value: "on", source: "global" },
        },
        validator: {
          read: { value: "off", source: "global" },
          contribute: { value: "off", source: "global" },
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
  const bindingRepo = createSpecExecutionBindingRepo(db);
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
  const policyNotifier: SpecExecutionGateAdmissionNotifier = {
    policyAdmitted(notice) {
      reviewNotifications.policyAdmitted.push(notice);
    },
    approvalRequestsClosed(notice) {
      reviewNotifications.closed.push(notice);
    },
  };
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
  // The service factory's order: authoring files the gate asks a propose
  // leaves pending through the review service's own request verb, so a spine
  // propose leaves the same durable asks a production propose does.
  const authoring = createAuthoringService({
    specs,
    review,
    links,
    events,
    waivers: delivery,
    policyNotifier,
    approvalRequests: {
      requestApproval: (input) => reviewService.requestApproval(input),
    },
    newId,
    now,
  });

  const definitions = new InMemoryWorkflowDefinitions(now);
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

  const evidencePublication = createEvidenceMutationRecorder({
    eventsRepo,
    events,
    findSpecById: (specId) => specs.findByIdInTransaction(specId),
    runInImmediateTransaction: (operation) => operation(),
  });
  const recordMutation = evidencePublication.recordMutation;
  const evidence = createEvidenceService({
    repo: delivery,
    recordMutation,
    runInImmediateTransaction: evidencePublication.runInImmediateTransaction,
    nextId: newId,
    now,
    routeWaiverRequestToHuman: async () => ({
      attentionId: newId("attention"),
    }),
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

  // Late-bound: the graph-workflow route handlers are constructed further
  // down (they need the workflow manager), but the execution service's gate
  // port must reach their non-HTTP definition-approval seam.
  const workflowDefinitionGateRef: {
    launchApproved:
      | ((
          input: Parameters<ExecutionStartGatePort["launchApprovedLaunch"]>[0],
        ) => ReturnType<ExecutionStartGatePort["launchApprovedLaunch"]>)
      | null;
  } = {
    launchApproved: null,
  };

  const executionStartGate: ExecutionStartGatePort = {
    async launchApprovedLaunch(input) {
      if (workflowDefinitionGateRef.launchApproved === null) {
        return { ok: false, reason: "unavailable" };
      }
      return workflowDefinitionGateRef.launchApproved(input);
    },
  };

  const execution = createExecutionService({
    specsRepo: specs,
    deliveryRepo: delivery,
    bindingRepo,
    linksRepo: links,
    eventsRepo,
    reviewRepo: review,
    events,
    writeQueue,
    nextId: newId,
    now,
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
    },
    plansRepo: plans,
    deliveryPlanCapture: {
      abandonLaunchedAttempt(input) {
        return deliveryPlan.abandonLaunch(input);
      },
      async openSeededReplacement(replacementInput) {
        const opened = await deliveryPlan.open({
          spec: replacementInput.spec,
          actor: replacementInput.actor,
        });
        return opened.ok
          ? { ok: true, value: { attemptId: opened.value.attempt.id } }
          : opened;
      },
    },
    executionStartGate,
    // Late-bound over the same workflow seams production wires: abort sends the
    // real manager's abort event and abandon runs the real audited act, so the
    // coordinator drives the run exactly as it does live — including what each
    // act leaves behind. `cleanupFaults` is the only test affordance; it
    // injects the infrastructure faults a phase boundary has to survive.
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
        // Deliberately no archive: the production abort seam transitions the
        // run and stops. `aborted` holds no lease, so the record projects into
        // History from wherever it sits and the next launch normalizes it —
        // archiving here would model a relocation production never performs.
        return { ok: true };
      },
      async abandon(target) {
        cleanupFaults.beforeOp?.("abandon");
        if (cleanupFaults.abandonIsNoOp) return { ok: true };
        const outcome = await workflowManager.abandon({
          projectPath: target.projectPath,
          sessionName: target.sessionName,
          executionId: target.workflowExecutionId,
          reason: target.reason,
          actor: target.actor,
        });
        return outcome.ok
          ? { ok: true }
          : { ok: false, reason: `abandon refused (${outcome.reason})` };
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
    events: eventsRepo,
    observeLinkedWorkflow: (target: SpecWorkflowCleanupTarget) =>
      observeWorkflowPlacement(target.workflowExecutionId),
  };

  // Real, not a failing proxy: the spine's whole point is that a spec walks
  // authoring -> plan -> execution through the same services production wires,
  // and a plan surface that throws would hide a break in that walk.
  const managedDefinitions = createManagedDefinitionTestService();
  const deliveryPlan = createDeliveryPlanService({
    plans,
    managedDefinitions,
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
    launchedExecutionState: (executionId) =>
      delivery.findExecutionById(executionId)?.state ?? null,
    launchedWorkflowExecutionId: (executionId) =>
      delivery.findExecutionById(executionId)?.workflow_execution_id ?? null,
    lastDeliveryBasis: ({ spec, pinnedRevision }) =>
      loadDeliveryPlanSeedBasis(
        {
          getRevisionSnapshot: (revisionId) =>
            specs.getRevisionSnapshot(revisionId),
          findExecutionsBySpecId: (id) => delivery.findExecutionsBySpecId(id),
          findCriterionDispositionsByExecution: (executionId) =>
            delivery.findCriterionDispositionsByExecution(executionId),
          findDeliveryVerdictsBySpecExecutionId: (executionId) =>
            delivery.findDeliveryVerdictsBySpecExecutionId(executionId),
          findExecutionBindingBySpecExecutionId: (executionId) =>
            bindingRepo.findBySpecExecutionId(executionId),
          findWaiversByRevision: (revisionId) =>
            delivery.findWaiversByRevision(revisionId),
        },
        { spec, pinnedRevision },
      ),
    admitLaunch: ({ spec, launch, accountabilityGroups }) =>
      admitAuthoredWorkflowLaunch(launch, {
        caller: "spec-proposal",
        documentScope: { kind: "project", projectPath: spec.projectPath },
        workflowDefaults: {},
        agentBackends: TEST_AGENT_BACKENDS_CONFIG,
        accountabilityGroups,
      }),
    admitModelSelections: async ({ launch }) => ({ ok: true, launch }),
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
    async verify(specId) {
      return verifyExportState(await loadSpecExportState(exportDeps, specId));
    },
  };

  const measures = createMeasuresQuery({
    specs,
    events: eventsRepo,
    delivery,
    executionBindings: bindingRepo,
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
    findWorkflowEventsByExecution: (_projectPath, _sessionName, executionId) =>
      workflowEvents.findByExecution(
        SPINE_PROJECT_PATH,
        SPINE_SESSION_NAME,
        executionId,
      ),
    async reconcileExecution(_projectPath, executionRow) {
      const result = await execution.getStatus(executionRow.id);
      return result.ok
        ? result.value
        : { execution: executionRow, workflowStatus: null };
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
    findDeliveryVerdictsBySpecExecutionId: (executionId) =>
      delivery.findDeliveryVerdictsBySpecExecutionId(executionId),
    findExecutionBindingBySpecExecutionId: (executionId) =>
      bindingRepo.findBySpecExecutionId(executionId),
    findWaiverForCriterionRevision: (criterionElementId, revisionId) =>
      delivery.findWaiverForCriterionRevision(criterionElementId, revisionId),
    findWaiverById: (waiverId) => delivery.findWaiverById(waiverId),
    findWaiversByRevision: (revisionId) =>
      delivery.findWaiversByRevision(revisionId),
    async exportSpec(specId) {
      return renderVerifiedCanonicalBundle(
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
    listRevisions: (specId) => specs.listRevisions(specId),
    getRevisionSnapshot: (revisionId) => specs.getRevisionSnapshot(revisionId),
    findQuestionsBySpecId: (specId) => review.findQuestionsBySpecId(specId),
    findAssumptionsBySpecId: (specId) => review.findAssumptionsBySpecId(specId),
    findEventsBySpecId: (specId) => eventsRepo.findBySpecId(specId),
  });

  function registerMergeComposition(): void {
    const deliveryGate = createDeliveryGate({
      bindingPort: createSpecExecutionBindingPorts(bindingRepo).delivery,
      outcomePort: createAuthoredContextOutcomeService({
        async findExecutionById(executionId) {
          return activeWorkflowExecution !== null &&
            activeWorkflowExecution.id === executionId
            ? { execution: activeWorkflowExecution, location: "active" }
            : null;
        },
      }),
      deliveryRepo: delivery,
      reviewRepo: review,
      specsRepo: specs,
      attention: eventsRepo,
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
      newVerdictId: () => newId("delivery-verdict"),
      newAdmissionId: () => newId("admission"),
      events,
      writeQueue,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier,
    });
    const lifecycleCallbacks = createExecutionLifecycleCallbacks({
      specsRepo: specs,
      deliveryRepo: delivery,
      bindingRepo,
      linksRepo: links,
      eventsRepo,
      reviewRepo: review,
      events,
      writeQueue,
      nextId: newId,
      now,
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
  /** The whole relocated records, newest last, beside the status index above. */
  const archivedWorkflowExecutions: GraphWorkflowExecution[] = [];
  const cleanupFaults: SpecSpineWorld["cleanupFaults"] = {
    beforeOp: null,
    abortIsNoOp: false,
    abandonIsNoOp: false,
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
      return {
        kind: "active",
        status: activeWorkflowExecution.status,
        leaseHeld: holdsExecutionLease(
          activeWorkflowExecution.status,
          activeWorkflowExecution.haltReason,
          activeWorkflowExecution.abandonment,
        ),
      };
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
      seed: GraphWorkflowExecutionSeed,
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
      const provenance = buildExecutionProvenance(
        seed.source,
        seed.executionId,
      );
      const created = createWorkflowExecution({
        id: seed.executionId,
        origin: provenance.origin,
        launchDocument: seed.launchDocument,
        seedDefinitionId: provenance.seedDefinitionId,
        seedDefinitionRevision: provenance.seedDefinitionRevision,
        boundInputs: seed.inputs,
        launchedTier: provenance.launchedTier,
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
      seed.transactionAttachment?.({ executionId: created.id });
      activeWorkflowExecution = created;
      return created;
    },
    // Honours guard and stamp because the audited acts built on this seam
    // (abandon) depend on both: the guard is their admission test and the stamp
    // is the record change they commit with the relocation.
    async archiveActive(
      _projectPath: string,
      _sessionName: string,
      _audit?: { reason: string; actor: string | null },
      guard?: (execution: GraphWorkflowExecution) => boolean,
      stamp?: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
    ): Promise<GraphWorkflowArchiveOutcome> {
      const incumbent = activeWorkflowExecution;
      if (incumbent === null) return { archived: false, reason: "no_active" };
      if (guard !== undefined && !guard(incumbent)) {
        return {
          archived: false,
          reason: "guard_rejected",
          execution: incumbent,
        };
      }
      const released = stamp === undefined ? incumbent : stamp(incumbent);
      archivedWorkflowStatuses.set(released.id, released.status);
      archivedWorkflowExecutions.push(released);
      activeWorkflowExecution = null;
      return { archived: true, execution: released };
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
    // The agent caller this world speaks as is a real session conversation:
    // capability verification re-checks membership, so a session with none
    // would make every agent act unverifiable for the wrong reason.
    conversations: [
      conversationStateSchema.parse({
        id: SPINE_CONVERSATION_ID,
        scope: "session",
        transcriptPath: null,
        status: "idle",
        promptCount: 1,
        createdAt: "2026-07-18T10:00:00.000Z",
        lastActivityAt: "2026-07-18T10:00:00.000Z",
        agentBackend: "codex",
      }),
    ],
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
  const spineAuth = {
    async validateOptionalToken(
      request: Request,
    ): Promise<OptionalTokenValidation> {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" };
      return header === `Bearer ${SPINE_BEARER_TOKEN}`
        ? { kind: "valid" }
        : { kind: "invalid" };
    },
  };
  /**
   * Verify against the fixture's key rather than falling through to the
   * registered verifier, which would read the real config directory of whatever
   * machine runs the suite.
   */
  const spineCapabilityVerifiers = {
    verifyConversationCapability: async (request: Request) =>
      verifyConversationCapability(
        request.headers.get(CONVERSATION_CAPABILITY_HEADER),
        SPINE_CAPABILITY_SECRET,
      ),
    verifyLaneCapability: async (request: Request) =>
      verifyLaneCapability(
        request.headers.get(LANE_CAPABILITY_HEADER),
        SPINE_CAPABILITY_SECRET,
      ),
  };
  const workflowHandlers = createGraphWorkflowExecutionRouteHandlers({
    // Same clock the manager stamps reservations with, so "has this decision's
    // holder gone away" is asked against the fixture's timeline rather than the
    // wall clock — which would call every reservation here stranded.
    now,
    resolveProjectPath: async (name) =>
      name === SPINE_PROJECT_NAME ? SPINE_PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === SPINE_PROJECT_PATH && sessionName === SPINE_SESSION_NAME
        ? spineSession
        : null,
    normalizeExecutionAfterRestart: async () => activeWorkflowExecution,
    startExecution: (input) => workflowManager.start(input),
    runExecution: (input) => workflowManager.run(input),
    launchSpecDeliveryExecution: (input) =>
      workflowManager.launchSpecDelivery(input),
    markRunning: (context, workflowExecutionId, origin) =>
      createRegisteredGraphExecutionLifecycleCallbacks().markRunning(
        context,
        workflowExecutionId,
        origin,
      ),
    awaitingDefinitionApproval: (context, workflowExecutionId, origin) =>
      createRegisteredGraphExecutionLifecycleCallbacks().awaitingDefinitionApproval?.(
        context,
        workflowExecutionId,
        origin,
      ) ?? Promise.resolve(),
    admitDefinitionApproval: (context, workflowExecutionId, origin) =>
      createRegisteredGraphExecutionLifecycleCallbacks().admitDefinitionApproval?.(
        context,
        workflowExecutionId,
        origin,
      ) ?? Promise.resolve({ ok: true as const }),
    recordDefinitionApproval: (input) =>
      workflowManager.recordDefinitionApproval(input),
    claimDefinitionApproval: (input) =>
      workflowManager.claimDefinitionApproval(input),
    releaseDefinitionApprovalClaim: (input) =>
      workflowManager.releaseDefinitionApprovalClaim(input),
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
      archivedWorkflowExecutions.push(active);
      activeWorkflowExecution = null;
      return { archived: true, execution: active };
    },
    recordPendingHaltReason: (input) =>
      workflowManager.recordPendingHaltReason(input),
    drainAndHalt: (input) => workflowManager.drainAndHalt(input),
    recordApprovalDecision: unsupported("recordApprovalDecision"),
    auth: spineAuth,
    ...spineCapabilityVerifiers,
  });
  // The production start+kickoff seam, exactly as
  // `launchSpecDeliveryGraphWorkflowExecution` wires it live: the same route
  // handlers, the same manager, and the owner conversation the spec-launch
  // seam resolved server-side.
  workflowDefinitionGateRef.launchApproved = async (input) => {
    try {
      const launched = await workflowHandlers.launchSpecDelivery({
        projectPath: SPINE_PROJECT_PATH,
        projectName: input.projectName,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        expectedDefinitionRevision: input.definitionRevision,
        specSlug: input.specSlug,
        candidateId: input.candidateId,
        ownerConversationId: input.ownerConversationId,
        ...(input.parameters === undefined ? {} : { inputs: input.parameters }),
        seededDocuments: input.seededDocuments,
        transactionAttachment: input.transactionAttachment,
      });
      return {
        ok: true,
        workflowExecutionId: launched.id,
        resolvedDefinitionHash: workingDefinitionHash(
          launched.workingDefinition,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkflowStartInputError
          ? { code: "validation" as const }
          : {}),
      };
    }
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
   * Stand in for a concurrent approval act that is at its admission gate right
   * now: it has reserved the park's decision through the production manager and
   * has not finalized. Every other decision on that park loses to it, which is
   * how a losing Studio grant is staged causally rather than modelled.
   */
  async function reserveWorkflowDefinitionDecision(): Promise<void> {
    const reserved = await workflowManager.claimDefinitionApproval({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
    });
    if (!reserved.ok) {
      throw new Error(
        `The park refused the reservation: ${reserved.reason}. The run must be parked awaiting definition approval first.`,
      );
    }
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
      | "ABORT",
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

  const liveEditEventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      publishedSse.push(event);
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
    publishLiveEditApplied: liveEditEventPublisher.publishLiveEditApplied,
    publishCharterUpdated: liveEditEventPublisher.publishCharterUpdated,
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

  return {
    db,
    publishedSse,
    reviewNotifications,
    now,
    repos: {
      specs,
      review,
      delivery,
      deliveryPlans: plans,
      executionBindings: bindingRepo,
      links,
      events: eventsRepo,
      workflowEvents,
      jobs,
    },
    services,
    definitions,
    managedDefinitions,
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
    postWorkflowLiveEdit,
    haltWorkflowExecution,
    pauseWorkflowExecution,
    reserveWorkflowDefinitionDecision,
    markWorkflowContextRunning,
    setWorkflowExecutionStatus,
    readActiveWorkflowExecution: () => activeWorkflowExecution,
    readArchivedWorkflowExecution: () =>
      archivedWorkflowExecutions.at(-1) ?? null,
    cleanupFaults,
  };
}

export function scenarioMachine(
  scenario: MergeScenario,
  branchName = "cc/spec-spine",
): MergeMachineType {
  return mergeMachine.provide({
    actors: {
      classifyWorktree: fromPromise<
        ClassifyWorktreeOutput,
        ClassifyWorktreeInput
      >(async () => ({ kind: "clean" })),
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

/**
 * The charter remedy a planner performs with `cctl workflow replace`: an
 * authored mission and an authored source of truth stored on the managed
 * definition the open draft names. Propose refuses a draft whose charter is
 * still the seed, so a spine walk that reaches a candidate has to author one.
 */
export async function authorSpineDeliveryPlanCharter(
  world: SpecSpineWorld,
  workflowDefinitionId: string,
): Promise<void> {
  const existing = await world.managedDefinitions.get({
    projectPath: SPINE_PROJECT_PATH,
    workflowDefinitionId,
  });
  if (existing === null) {
    throw new Error(`Managed definition ${workflowDefinitionId} is missing.`);
  }
  world.managedDefinitions.replaceLaunch({
    workflowDefinitionId,
    launch: {
      name: existing.name,
      description: existing.description,
      definition: {
        ...existing.definition,
        charter: {
          ...existing.definition.charter,
          mission: "Deliver the spine spec's criteria through the plan lanes.",
          sourcesOfTruth: dedupeServerOwnedDeliveryPlanSources([
            ...existing.definition.charter.sourcesOfTruth,
            {
              rank: existing.definition.charter.sourcesOfTruth.length + 1,
              id: "spine-design",
              label: "Spine delivery design",
              type: "document" as const,
              locator: "docs/designs/spine.md",
              description: "The decisions this delivery implements.",
            },
          ]),
        },
      },
      layout: existing.layout,
    },
  });
}

export interface StartedSpineExecution {
  specExecutionId: string;
  definition: WorkflowDefinitionRecord;
  deliveryPlan?: {
    attemptId: string;
    candidateId: string;
    candidateHash: string;
  };
}

function spineExecutionBinding(
  authored: AuthoredSpineSpec,
): SpecExecutionBinding {
  return specExecutionBindingSchema.parse({
    dispositions: [authored.criterionOneId, authored.criterionTwoId].map(
      (criterionElementId) => ({
        criterionElementId,
        disposition: "in_scope" as const,
        deliveredByExecutionId: null,
      }),
    ),
    claims: [
      {
        accountabilitySourceId: "ctx-implement",
        taskElementId: authored.taskOneId,
        touchedPaths: [],
        criterionElementIds: [authored.criterionOneId],
      },
      {
        accountabilitySourceId: "ctx-wire",
        taskElementId: authored.taskTwoId,
        touchedPaths: [],
        criterionElementIds: [authored.criterionTwoId],
      },
    ],
  });
}

function spineAuthoredLaunch(
  authored: AuthoredSpineSpec,
): WorkflowDefinitionDraft {
  const sourceUri = `spec-plan://${authored.specId}/attempts/authored-spine`;
  return {
    name: "Agent-authored spine delivery",
    description: "An admitted graph launch authored for the spine delivery.",
    definition: {
      schemaVersion: 1,
      approvalRequired: false,
      origin: { sourceUri, label: "Agent-authored spine delivery" },
      lockedRegions: [
        {
          paths: ["/tasks/*/instructions"],
          sourceUri,
          reason: "The admitted delivery binding owns these instructions.",
          instruction: "Reopen the delivery plan to change the authored graph.",
        },
      ],
      workflowConfig: {},
      charter: {
        mission: "Deliver the spine feature from its approved graph launch.",
        invariants: [
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
            description: "The immutable revision this delivery binding pins.",
            accessPolicy: "worktree-relative",
          },
        ],
      },
      parameters: [],
      prerequisites: [],
      executionContexts: [
        {
          id: "ctx-implement",
          title: "Implement the spine service",
          description: "Deliver the first approved criterion.",
          acceptanceCriteria:
            "The first approved spine criterion is observable in production.",
          placement: { lane: "ctx-implement", mode: "full" },
          origin: {
            sourceUri: `${sourceUri}#ctx-implement`,
            label: "Implement the spine service",
          },
        },
        {
          id: "ctx-wire",
          title: "Wire the spine delivery",
          description: "Deliver the second approved criterion.",
          acceptanceCriteria:
            "The second approved spine criterion is observable in production.",
          placement: { lane: "ctx-wire", mode: "full" },
          origin: {
            sourceUri: `${sourceUri}#ctx-wire`,
            label: "Wire the spine delivery",
          },
        },
      ],
      tasks: [
        {
          id: authored.taskOneId,
          contextId: "ctx-implement",
          order: 1,
          title: "Implement the spine service",
          instructions: "Build the service behind criterion one.",
          source: "user",
        },
        {
          id: authored.taskTwoId,
          contextId: "ctx-wire",
          order: 1,
          title: "Wire the spine delivery",
          instructions: "Land the delivery path behind criterion two.",
          source: "user",
        },
      ],
      edges: [
        {
          id: "edge-implement-wire",
          sourceContextId: "ctx-implement",
          targetContextId: "ctx-wire",
        },
      ],
    },
    layout: {
      workflowId: "agent-authored-spine-layout",
      contextPositions: {
        "ctx-implement": { x: 71, y: -29 },
        "ctx-wire": { x: 613, y: 164 },
      },
      viewport: { x: -149, y: 53, zoom: 1.2 },
    },
  };
}

/**
 * Seeds post-launch spine state — a running graph, the typed binding, and the
 * criterion dispositions — without going through proposal and sign-off, so the
 * cleanup, delivery-gate and refusal suites can start from a live run and
 * assert their own subject. It writes the rows production start writes, but it
 * is a shortcut, not the boundary: `delivery-plan-launch.integration.test.ts`
 * owns the proof that the direct path produces this state, including that it
 * mints no saved workflow definition. The saved definition here exists only to
 * give those suites a graph to drive; nothing reads it as a spec launch.
 */
export async function startSpineExecution(
  world: SpecSpineWorld,
  _slug: string,
  authored: AuthoredSpineSpec,
): Promise<StartedSpineExecution> {
  const launch = spineAuthoredLaunch(authored);
  const binding = spineExecutionBinding(authored);
  const definition = await world.definitions.create(launch);

  world.registerMergeComposition();
  await postJson(
    world.postWorkflowRoute("START", {
      definitionId: definition.id,
      definitionRevision: definition.revision,
      tier: "project",
    }),
  );

  const specExecutionId = `execution-${authored.specId}`;
  const timestamp = world.now();
  world.db
    .transaction(() => {
      world.repos.delivery.insertExecution({
        id: specExecutionId,
        spec_id: authored.specId,
        revision_id: authored.draftRevisionId,
        scope_json: JSON.stringify(executionScopeFromBinding(binding)),
        state: "running",
        execution_start_dial: "gate",
        workflow_definition_id: definition.id,
        workflow_definition_revision: definition.revision,
        workflow_seed_source_json: JSON.stringify({
          kind: "saved-definition",
          id: definition.id,
          revision: definition.revision,
          tier: "project",
        }),
        workflow_execution_binding_json: null,
        workflow_execution_id: SPINE_WORKFLOW_EXECUTION_ID,
        session_name: SPINE_SESSION_NAME,
        delivered_at: null,
        abandoned_reason: null,
        cleanup_phase: null,
        linked_workflow_execution_id: null,
        cleanup_last_error: null,
        cleanup_last_error_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      // The typed link the direct delivery path resolves from. Production
      // start writes it through the start attachment; the spine writes the
      // same row so the gate under test is the bound one.
      world.repos.executionBindings.insert({
        specExecutionId,
        workflowExecutionId: SPINE_WORKFLOW_EXECUTION_ID,
        binding: {
          schemaVersion: 2,
          candidateId: SPINE_CANDIDATE_ID,
          candidateHash: SPINE_CANDIDATE_HASH,
          pinnedRevisionId: authored.draftRevisionId,
          dispositions: binding.dispositions.map((disposition) => ({
            ...disposition,
          })),
          claims: binding.claims.map((claim) => ({
            contextId: claim.accountabilitySourceId,
            criterionElementIds: [...claim.criterionElementIds],
          })),
        },
        createdAt: timestamp,
      });
      for (const disposition of binding.dispositions) {
        world.repos.delivery.saveCriterionDisposition({
          execution_id: specExecutionId,
          criterion_element_id: disposition.criterionElementId,
          disposition: disposition.disposition,
          waiver_id: null,
          delivered_by_execution_id: disposition.deliveredByExecutionId,
          created_at: timestamp,
          updated_at: timestamp,
        });
      }
    })
    .immediate();

  return {
    specExecutionId,
    definition,
  };
}

export async function startSpineWorkflowThroughProductionGate(
  world: SpecSpineWorld,
  started: StartedSpineExecution,
  _slug = "spec-spine",
): Promise<void> {
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

  const linked = world.repos.executionBindings.findBySpecExecutionId(
    started.specExecutionId,
  );
  const contextIds = [
    ...new Set(linked?.binding.claims.map((claim) => claim.contextId) ?? []),
  ];
  if (contextIds.length === 0) {
    throw new Error("The started execution has no accountable binding sources");
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
