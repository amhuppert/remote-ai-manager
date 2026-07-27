import type Database from "better-sqlite3";
import { fromPromise } from "xstate";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createJobsRepo } from "@/lib/jobs/repo";
import { runRegisteredMergeJob } from "@/lib/jobs/queue";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
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
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import { createRegisteredGraphExecutionLifecycleCallbacks } from "@/lib/workflow-graph/execution-lifecycle-port";
import { createGraphWorkflowExecutionRouteHandlers } from "@/lib/workflow-graph/execution-route-handlers";
import { createGraphWorkflowMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { TemplateTier } from "@/lib/workflow-graph/template-library-service";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
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
import { readCompiledOriginMap } from "./compiler";
import { createDeliveryGate } from "./delivery-gate";
import { createEvidenceIngestService } from "./evidence-ingest";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import {
  loadSpecExportState,
  renderCanonicalBundle,
  verifyExportState,
} from "./export";
import {
  createExecutionLifecycleCallbacks,
  createExecutionService,
  type ExecutionStartGatePort,
  type ExecutionWorkflowDefinitions,
} from "./execution-service";
import { createMeasuresQuery } from "./measures-query";
import { toLintSnapshot } from "./review-state";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
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
      | "getSpecGET"
      | "getSpecStatusGET"
      | "getSpecElementGET"
      | "getSpecMeasuresGET",
    params: Record<string, string>,
  ): Promise<Response>;
  /**
   * Drive the REAL graph-workflow route handlers (start, definition approval,
   * status) composed over the real workflow manager. Start and approval report
   * through the registered lifecycle port — the production spec↔workflow
   * handoff — so tests never link spec executions by hand.
   */
  postWorkflowRoute(
    handler: "START" | "APPROVE_DEFINITION" | "STATUS" | "EXECUTION",
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /**
   * Mirror the production execution loop's failed-merge handling: record the
   * structured halt reason and drain the active workflow execution to
   * `halted` so status routes and the CLI surface the machine-readable code.
   */
  haltWorkflowExecution(reason: GraphWorkflowHaltReason): Promise<void>;
  readActiveWorkflowExecution(): GraphWorkflowExecution | null;
}

export function createSpecSpineWorld(): SpecSpineWorld {
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
    },
    policyNotifier,
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
    },
    writeQueue,
    async loadOriginMap(workflowDefinitionId) {
      const record = definitions.findById(workflowDefinitionId);
      return record === null ? [] : readCompiledOriginMap(record.definition);
    },
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
        }) => Promise<
          Awaited<
            ReturnType<ExecutionStartGatePort["approveWorkflowDefinition"]>
          >
        >)
      | null;
    hasPending: (() => Promise<boolean>) | null;
  } = { approve: null, hasPending: null };

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
    executionStartGate: {
      async hasPendingDefinitionApproval() {
        if (workflowDefinitionGateRef.hasPending === null) return false;
        return workflowDefinitionGateRef.hasPending();
      },
      grantApproval: (input) =>
        reviewService.grantGateApproval({ ...input, gate: "execution_start" }),
      async approveWorkflowDefinition(input) {
        if (workflowDefinitionGateRef.approve === null) {
          return { ok: false, reason: "unavailable" };
        }
        return workflowDefinitionGateRef.approve(input);
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

  const services: SpecSpineWorld["services"] = {
    authoring,
    review: reviewService,
    evidence,
    execution,
    links: failingLinks,
    ingestEvidenceBestEffort: (executionId) =>
      ingest.ingestBestEffort(executionId),
    async verify(specId) {
      return verifyExportState(
        await loadSpecExportState({ specs, review }, specId),
      );
    },
  };

  const measures = createMeasuresQuery({
    specs,
    events: eventsRepo,
    delivery,
    workflowEvents,
    async loadOriginMap(workflowDefinitionId) {
      const record = definitions.findById(workflowDefinitionId);
      return record === null ? [] : readCompiledOriginMap(record.definition);
    },
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
        await loadSpecExportState({ specs, review }, specId),
      );
    },
    async verifySpec(specId) {
      return verifyExportState(
        await loadSpecExportState({ specs, review }, specId),
      );
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
      | "getSpecGET"
      | "getSpecStatusGET"
      | "getSpecElementGET"
      | "getSpecMeasuresGET",
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
    activeWorkflowExecution =
      typeof result === "object" && "execution" in result && "events" in result
        ? result.execution
        : (result as GraphWorkflowExecution);
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
      },
    ): Promise<GraphWorkflowExecution> {
      activeWorkflowExecution = createWorkflowExecution({
        id: seed.executionId,
        seedDefinitionId: seed.definitionId,
        seedDefinitionRevision: seed.definitionRevision,
        boundInputs: seed.inputs,
        launchedTier: seed.launchedTier,
        definitionApproval:
          seed.definition.approvalRequired === true
            ? { requestedAt: seed.startedAt, approvedAt: null }
            : null,
        workingDefinition:
          seed.definition as unknown as ResolvedWorkflowSemanticDefinition,
        startedAt: seed.startedAt,
      });
      return activeWorkflowExecution;
    },
    async archiveActive(): Promise<void> {
      activeWorkflowExecution = null;
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
    markRunning: (workflowExecutionId, definitionId) =>
      createRegisteredGraphExecutionLifecycleCallbacks().markRunning(
        workflowExecutionId,
        definitionId,
      ),
    awaitingDefinitionApproval: (workflowExecutionId, definitionId) =>
      createRegisteredGraphExecutionLifecycleCallbacks().awaitingDefinitionApproval?.(
        workflowExecutionId,
        definitionId,
      ) ?? Promise.resolve(),
    admitDefinitionApproval: (workflowExecutionId, definitionId) =>
      createRegisteredGraphExecutionLifecycleCallbacks().admitDefinitionApproval?.(
        workflowExecutionId,
        definitionId,
      ) ?? Promise.resolve({ ok: true as const }),
    recordDefinitionApproval: (input) =>
      workflowManager.recordDefinitionApproval(input),
    async kickOffExecutionLoop() {},
    getActiveExecution: async () => activeWorkflowExecution,
    pauseExecution: unsupported("pauseExecution"),
    resumeExecution: unsupported("resumeExecution"),
    abortExecution: unsupported("abortExecution"),
    resetExecutionContext: unsupported("resetExecutionContext"),
    archiveExecution: async () => {
      activeWorkflowExecution = null;
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
    });
  workflowDefinitionGateRef.hasPending = () =>
    workflowHandlers.hasPendingDefinitionApproval({
      projectPath: SPINE_PROJECT_PATH,
      sessionName: SPINE_SESSION_NAME,
    });

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

  async function postWorkflowRoute(
    handler: "START" | "APPROVE_DEFINITION" | "STATUS" | "EXECUTION",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const suffix =
      handler === "APPROVE_DEFINITION"
        ? "/approve-definition"
        : handler === "EXECUTION"
          ? "/execution"
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
    haltWorkflowExecution,
    readActiveWorkflowExecution: () => activeWorkflowExecution,
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

/**
 * Drives contract-bearing authoring through requirements and design review,
 * then returns the plan-stage draft that completes the golden-path contract.
 */
export async function authorSpineDraft(
  world: SpecSpineWorld,
  slug: string,
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
        gatePolicy: { preset: "contract-bearing" },
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
    id: string;
    authoringStage: string;
  }>(world.postAction(slug, "open-amendment", {}, "agent"));
  ids.designRevisionId = designRevision.id;
  await postJson(
    world.postAction(
      slug,
      "draft-upsert",
      {
        revisionId: designRevision.id,
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
      { revisionId: designRevision.id },
      "agent",
    ),
  );
  await postJson(
    world.postAction(
      slug,
      "approve-item",
      {
        revisionId: designRevision.id,
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
      { revisionId: designRevision.id },
      "human",
    ),
  );

  const planRevision = await postJson<{
    id: string;
    authoringStage: string;
  }>(world.postAction(slug, "open-amendment", {}, "agent"));
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
}

export async function startSpineExecution(
  world: SpecSpineWorld,
  slug: string,
  authored: AuthoredSpineSpec,
): Promise<StartedSpineExecution> {
  const started = await postJson<{
    execution: { id: string; state: string };
    definition: WorkflowDefinitionRecord;
  }>(
    world.postAction(
      slug,
      "start-execution",
      {
        revisionId: authored.draftRevisionId,
        scope: {
          selectedTaskIds: [authored.taskOneId, authored.taskTwoId],
          selectedCriterionIds: [
            authored.criterionOneId,
            authored.criterionTwoId,
          ],
          exclusionDispositions: [],
        },
        sessionName: SPINE_SESSION_NAME,
      },
      "agent",
    ),
  );
  return {
    specExecutionId: started.execution.id,
    definition: started.definition,
  };
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

  const originMap = readCompiledOriginMap(started.definition.definition);
  if (originMap.length === 0) {
    throw new Error("The compiled definition exposes no origin map");
  }
  const contextIds = [...new Set(originMap.map((entry) => entry.contextId))];
  const commitShas: string[] = [];
  const workflowEventRows = contextIds.flatMap((contextId, index) => {
    const sha = `commit-${index + 1}`;
    // Each lane commit extends the branch lineage, so downstream candidates
    // that build on the last lane commit contain every earlier one.
    world.linkCommit(sha, index === 0 ? [] : [`commit-${index}`]);
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
