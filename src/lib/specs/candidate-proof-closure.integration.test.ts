import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { fromPromise } from "xstate";
import { createJobsRepo } from "@/lib/jobs/repo";
import {
  _resetForTesting as resetJobQueue,
  runRegisteredMergeJob,
} from "@/lib/jobs/queue";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createMergeAssociationResolver } from "./merge-association";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb, _installTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import {
  createRegisteredGraphExecutionLifecycleCallbacks,
  resetGraphExecutionLifecycleCallbacksForTesting,
} from "@/lib/workflow-graph/execution-lifecycle-port";
import {
  createGraphWorkflowMergeRunner,
  type GraphMergeRunner,
} from "@/lib/workflow-graph/graph-merge-runner";
import {
  createJoinRunner,
  type JoinRunnerMutateActive,
} from "@/lib/workflow-graph/join-runner";
import { createPerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
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
import {
  _resetDeliveryGateEvaluatorForTesting,
  createRegisteredDeliveryGateEvaluator,
} from "@/lib/workflows/merge/delivery-gate-port";
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
import { createDeliveryGate } from "./delivery-gate";
import { createSpecEventsPublisher } from "./events";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
} from "./evidence-service";
import { createExecutionLifecycleCallbacks } from "./execution-service";
import { registerSpecWorkflowComposition } from "./workflow-composition";

type Db = InstanceType<typeof Database>;

const projectPath = "/repos/candidate-proof-closure";
const specId = "spec-candidate-proof-closure";
const revisionId = "revision-candidate-proof-closure";
const specExecutionId = "spec-execution-candidate-proof-closure";
const workflowExecutionId = "workflow-execution-candidate-proof-closure";
const criterionId = "criterion-candidate-proof-closure";
const now = "2026-07-18T20:00:00.000Z";

interface MergeScenario {
  validation: CandidateValidationFact;
  preparations: PrepareActorOutput[];
  publications: PublishActorOutput[];
  publishedCandidates: string[];
}

describe("candidate-proof closure over the wired merge bridge", () => {
  let db: Db;
  let deliveryRepo: ReturnType<typeof createSpecDeliveryRepo>;
  let jobsRepo: ReturnType<typeof createJobsRepo>;
  let linksRepo: ReturnType<typeof createSpecLinksRepo>;
  let eventsRepo: ReturnType<typeof createSpecEventsRepo>;
  let treeByCommit: Map<string, string>;
  let nextId: number;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    db = _createTestDb({ inMemory: true });
    _installTestDb(db);
    seedSpecState(db);
    deliveryRepo = createSpecDeliveryRepo(db);
    jobsRepo = createJobsRepo(db);
    linksRepo = createSpecLinksRepo(db);
    eventsRepo = createSpecEventsRepo(db);
    treeByCommit = new Map();
    nextId = 0;
    registerComposition();
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
  });

  it("refuses changed candidate B until a fresh dispatch validates it, then delivers once under callback replay", async () => {
    setTrees({
      "feature-a": "tree-a",
      "prepared-a": "tree-a",
      "prepared-b": "tree-b",
      "feature-b": "tree-b",
      "prepared-b-retry": "tree-b",
    });
    const candidateA = validationFact("a", "feature-a", "tree-a");
    const firstScenario: MergeScenario = {
      validation: candidateA,
      preparations: [
        prepared("prepared-a", "target-a"),
        prepared("prepared-b", "target-b"),
      ],
      publications: [{ status: "cas-lost", actualTargetSha: "target-b" }],
      publishedCandidates: [],
    };

    const refused = await runMerge("merge-job-a", firstScenario);

    expect(refused).toMatchObject({
      status: "failed",
      haltReason: {
        type: "delivery_gate_failed",
        unmet: [expect.objectContaining({ criterionId })],
      },
    });
    expect(firstScenario.publishedCandidates).toEqual(["prepared-a"]);
    expect(
      deliveryRepo.findEvidenceByMergeValidationRef(
        specExecutionId,
        criterionId,
        candidateA.validationRef,
      ),
    ).toHaveLength(2);

    const candidateB = validationFact("b", "feature-b", "tree-b");
    const secondScenario: MergeScenario = {
      validation: candidateB,
      preparations: [
        prepared("prepared-b", "target-b"),
        prepared("prepared-b-retry", "target-b-retry"),
      ],
      publications: [
        { status: "cas-lost", actualTargetSha: "target-b-retry" },
        { status: "completed", mergeHash: "merge-b" },
      ],
      publishedCandidates: [],
    };

    const published = await runMerge("merge-job-b", secondScenario);
    const lifecycle = createRegisteredGraphExecutionLifecycleCallbacks();
    await lifecycle.markDelivered(workflowExecutionId, "merge-b");

    expect(published).toMatchObject({
      status: "completed",
      mergeHash: "merge-b",
    });
    expect(secondScenario.publishedCandidates).toEqual([
      "prepared-b",
      "prepared-b-retry",
    ]);
    expect(
      deliveryRepo.findEvidenceByMergeValidationRef(
        specExecutionId,
        criterionId,
        candidateB.validationRef,
      ),
    ).toHaveLength(2);
    expect(
      deliveryRepo.findEvidenceByCriterionRevision(criterionId, revisionId),
    ).toHaveLength(4);
    expect(
      deliveryRepo.findProofVerdictsByCriterionRevision(
        criterionId,
        revisionId,
      ),
    ).toHaveLength(2);
    expect(deliveryRepo.findExecutionById(specExecutionId)).toMatchObject({
      state: "delivered",
      delivered_at: now,
    });
    expect(
      linksRepo
        .findBySpecId(specId)
        .filter((link) => link.object_kind === "merge_job"),
    ).toHaveLength(1);
    expect(
      eventsRepo
        .findBySpecId(specId)
        .filter((event) =>
          event.payload_json.includes('"kind":"execution_delivered"'),
        ),
    ).toHaveLength(1);
  });

  it("keeps proof across a pure rebase with an identical relevant tree without duplicate evidence", async () => {
    setTrees({
      "feature-a": "tree-a",
      "prepared-a": "tree-a",
      "prepared-a-rebased": "tree-a",
    });
    const candidateA = validationFact("a", "feature-a", "tree-a");
    const scenario: MergeScenario = {
      validation: candidateA,
      preparations: [
        prepared("prepared-a", "target-a"),
        prepared("prepared-a-rebased", "target-a-rebased"),
      ],
      publications: [
        { status: "cas-lost", actualTargetSha: "target-a-rebased" },
        { status: "completed", mergeHash: "merge-a-rebased" },
      ],
      publishedCandidates: [],
    };

    const published = await runMerge("merge-job-pure-rebase", scenario);

    expect(published).toMatchObject({
      status: "completed",
      mergeHash: "merge-a-rebased",
    });
    expect(scenario.publishedCandidates).toEqual([
      "prepared-a",
      "prepared-a-rebased",
    ]);
    expect(
      deliveryRepo.findEvidenceByMergeValidationRef(
        specExecutionId,
        criterionId,
        candidateA.validationRef,
      ),
    ).toHaveLength(2);
    expect(
      deliveryRepo.findProofVerdictsByCriterionRevision(
        criterionId,
        revisionId,
      ),
    ).toHaveLength(1);
  });

  it("gates every source in a multi-source final join and delivers only on the delivery-target merge", async () => {
    setTrees({
      "feature-a": "tree-a",
      "prepared-a": "tree-a",
      "feature-b": "tree-b",
      "prepared-b": "tree-b",
      "feature-final": "tree-final",
      "prepared-final": "tree-final",
    });
    const scenarios = new Map<string, MergeScenario>([
      [
        "cc/source-a",
        {
          validation: validationFact("a", "feature-a", "tree-a"),
          preparations: [prepared("prepared-a", "target-a")],
          publications: [{ status: "completed", mergeHash: "merge-a" }],
          publishedCandidates: [],
        },
      ],
      [
        "cc/source-b",
        {
          validation: validationFact("b", "feature-b", "tree-b"),
          preparations: [prepared("prepared-b", "target-b")],
          publications: [{ status: "completed", mergeHash: "merge-b" }],
          publishedCandidates: [],
        },
      ],
    ]);
    const gatedCandidates: string[] = [];
    let stateBeforeLastSource: string | null = null;
    let publishedBeforeLastSource: ReturnType<
      typeof jobsRepo.findLatestPublishedMergeByExecutionId
    > = null;
    const registeredGate = createRegisteredDeliveryGateEvaluator();
    const lifecycle = createRegisteredGraphExecutionLifecycleCallbacks();
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        if (input.branchName === "cc/source-b") {
          stateBeforeLastSource =
            deliveryRepo.findExecutionById(specExecutionId)?.state ?? null;
          publishedBeforeLastSource =
            jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId);
        }
        const scenario = scenarios.get(input.branchName);
        if (scenario === undefined) {
          throw new Error(`No merge scenario for ${input.branchName}`);
        }
        return createGraphWorkflowMergeRunner({
          buildMachine: () => scenarioMachine(scenario, input.branchName),
          deliveryGate: {
            async evaluate(gateInput) {
              gatedCandidates.push(gateInput.preparedSha);
              return registeredGate.evaluate(gateInput);
            },
          },
          markDelivered: lifecycle.markDelivered,
          runMachine: runRegisteredMergeJob,
          recordMergeIntent: () => undefined,
        }).run(input);
      },
    };
    const persistedExecution = createInMemoryWorkflowExecution(
      multiSourceWorkflowExecution(),
    );
    const jobIds = ["merge-job-source-a", "merge-job-source-b"];
    const joinRunner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => undefined,
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId() {
        const jobId = jobIds.shift();
        if (jobId === undefined) throw new Error("No merge job id remains");
        return jobId;
      },
      now: () => now,
    });

    const result = await joinRunner.run({
      projectPath,
      projectName: "candidate-proof-closure",
      sessionName: "session-candidate-proof-closure",
      joinId: "join-final",
      mutateActive: persistedExecution.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(gatedCandidates).toEqual(["prepared-a", "prepared-b"]);
    expect(stateBeforeLastSource).toBe("running");
    expect(publishedBeforeLastSource).toBeNull();

    // The join's session-boundary merges gate every source but never deliver
    // (finalPublish belongs to the delivery-target merge alone).
    expect(deliveryRepo.findExecutionById(specExecutionId)?.state).toBe(
      "running",
    );
    expect(
      jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId),
    ).toBeNull();

    const deliveringMerge = await runMerge("merge-job-deliver", {
      validation: validationFact("final", "feature-final", "tree-final"),
      preparations: [prepared("prepared-final", "target-final")],
      publications: [{ status: "completed", mergeHash: "merge-final" }],
      publishedCandidates: [],
    });
    expect(deliveringMerge.status).toBe("completed");
    expect(deliveryRepo.findExecutionById(specExecutionId)?.state).toBe(
      "delivered",
    );
    expect(
      jobsRepo.findLatestPublishedMergeByExecutionId(workflowExecutionId),
    ).toEqual({ mergeHash: "merge-final", deliveryGatePassed: true });
    expect(
      eventsRepo
        .findBySpecId(specId)
        .filter((event) =>
          event.payload_json.includes('"kind":"execution_delivered"'),
        ),
    ).toHaveLength(1);
    expect(
      linksRepo
        .findBySpecId(specId)
        .filter((link) => link.object_kind === "merge_job"),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT job_id, final_publish
             FROM job_records
            WHERE execution_id = ?
            ORDER BY rowid`,
        )
        .all(workflowExecutionId),
    ).toEqual([
      { job_id: "merge-job-source-a", final_publish: 0 },
      { job_id: "merge-job-source-b", final_publish: 0 },
      { job_id: "merge-job-deliver", final_publish: 1 },
    ]);
  });

  function registerComposition(): void {
    const writeQueue = createWriteQueue();
    const specsRepo = createSpecsRepo(db, writeQueue);
    const reviewRepo = createSpecReviewRepo(db);
    const specEventsPublisher = createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    const evidenceService = createEvidenceService({
      repo: deliveryRepo,
      ingestExecutionEvidence: async () => undefined,
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      async getApprovedCriterion(targetRevisionId, targetCriterionId) {
        const snapshot = await specsRepo.getRevisionSnapshot(targetRevisionId);
        const criterion = snapshot?.elements.find(
          (item) => item.element.id === targetCriterionId,
        );
        if (
          snapshot?.revision.state !== "approved" ||
          criterion?.version.payload.kind !== "criterion"
        ) {
          return null;
        }
        return {
          specId: snapshot.revision.specId,
          validationStrategy: criterion.version.payload.validationStrategy,
        };
      },
      gitObjectExists: async () => false,
      workflowEventExists: async () => false,
      async mergeValidationFactExists(ref, expectedExecution) {
        const source = jobsRepo.findMergeValidationByExecutionIdAndRef(
          expectedExecution.workflowExecutionId ?? "",
          ref.validationRef,
        );
        return source?.mergeJobId === ref.mergeJobId;
      },

      isEvidenceFresh: async () => true,
      routeStrategyInadequacy: async () => undefined,
      routeWaiverRequestToHuman: async () => ({ attentionId: "attention-1" }),
      getTaskClaimContext: async () => null,
      getCriterionVersion: async () => null,
      wasCriterionDeliveredByMergedExecution: async () => false,
      recordMutation: () => undefined,
      runInImmediateTransaction: (operation) => operation(),
    });
    const deliveryGate = createDeliveryGate({
      deliveryRepo,
      reviewRepo,
      specsRepo,
      evidenceService,
      ingestExecutionEvidence: async () => undefined,
      getProjectDisplayName: () => "closure-project",
      requestDeliveryApproval: async () => undefined,
      recordIntervention: createEvidenceMutationRecorder({
        eventsRepo,
        events: specEventsPublisher,
        findSpecById: (targetSpecId) =>
          specsRepo.findByIdInTransaction(targetSpecId),
        runInImmediateTransaction: (operation) => operation(),
      }).recordMutation,
      now: () => now,
      newAdmissionId: () => `admission-${++nextId}`,
      events: specEventsPublisher,
      writeQueue,
      runInImmediateTransaction: (operation) => operation(),
      gitProbesForProject: () => ({
        isAncestor: async () => false,
        async relevantTreeHash(commitSha) {
          const tree = treeByCommit.get(commitSha);
          if (tree === undefined) {
            throw new Error(`No relevant tree registered for ${commitSha}`);
          }
          return tree;
        },
      }),
      async resolveCandidateValidation(input) {
        const source = jobsRepo.findMergeValidationByExecutionIdAndRef(
          input.workflowExecutionId,
          input.validationRef,
        );
        return source === null
          ? null
          : {
              ...source,
              producer: {
                kind: "agent" as const,
                conversationId: "conversation-candidate-validation",
              },
            };
      },
    });
    const lifecycleCallbacks = createExecutionLifecycleCallbacks({
      specsRepo,
      deliveryRepo,
      linksRepo,
      eventsRepo,
      reviewRepo,
      events: specEventsPublisher,
      writeQueue,
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      ingestExecutionEvidence: async () => undefined,
      getPublishedMerge: async (linkedWorkflowExecutionId) =>
        jobsRepo.findLatestPublishedMergeByExecutionId(
          linkedWorkflowExecutionId,
        ),
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
    });
    registerSpecWorkflowComposition({
      deliveryGate,
      lifecycleCallbacks,
      mergeAssociation: createMergeAssociationResolver({
        findActiveExecutionsBySessionName:
          deliveryRepo.findActiveExecutionsBySessionName,
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
      projectPath,
      projectName: "candidate-proof-closure",
      sessionName: "session-candidate-proof-closure",
      contextId: "context-final-publish",
      branchName: "cc/candidate-proof-closure",
      featureWorktreePath: `${projectPath}/.worktrees/candidate-proof-closure`,
      targetBranch: "main",
      targetWorktreePath: projectPath,
      message: "Publish candidate-proof closure",
      executionId: workflowExecutionId,
      finalPublish: true,
      validationMode: {
        mode: "run",
        source: "graph_lane_merge",
        selection: { mode: "only", commands: [] },
      },
    });
  }

  function setTrees(trees: Record<string, string>): void {
    treeByCommit = new Map(Object.entries(trees));
  }
});

function scenarioMachine(
  scenario: MergeScenario,
  branchName = "cc/candidate-proof-closure",
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

function validationFact(
  suffix: string,
  validatedSha: string,
  validatedTreeHash: string,
): CandidateValidationFact {
  return {
    validationRef: `validation-${suffix}`,
    validatedSha,
    validatedTreeHash,
    commandIdentity: "bun run test:closure",
    outcome: "pass",
  };
}

function prepared(
  preparedSha: string,
  expectedTargetSha: string,
): PrepareActorOutput {
  return {
    status: "prepared",
    preparedSha,
    expectedTargetSha,
    parkedRef: `refs/cc-merges/${preparedSha}`,
  };
}

function seedSpecState(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(projectPath);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    specId,
    projectPath,
    "candidate-proof-closure",
    "Candidate Proof Closure",
    '{"preset":"contract-bearing"}',
    now,
    now,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, ?, ?, ?, ?)`,
  ).run(revisionId, specId, "revision-hash", now, now, now);
  insertElement(db, "requirement-1", "requirement", 1, null, 0, {
    kind: "requirement",
    statement: "The candidate is proven before delivery.",
    priority: "must",
    risk: "high",
  });
  insertElement(db, criterionId, "criterion", 1, "requirement-1", 1, {
    kind: "criterion",
    text: "The final candidate passes deterministic validation.",
    validationStrategy: { kinds: ["test_run", "validator_verdict"] },
  });
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    specExecutionId,
    specId,
    revisionId,
    JSON.stringify({
      selectedTaskIds: [],
      selectedCriterionIds: [criterionId],
      exclusionDispositions: [],
    }),
    "workflow-definition-candidate-proof-closure",
    workflowExecutionId,
    "session-candidate-proof-closure",
    now,
    now,
  );
  const deliveryRepo = createSpecDeliveryRepo(db);
  deliveryRepo.saveCriterionDisposition({
    execution_id: specExecutionId,
    criterion_element_id: criterionId,
    disposition: "in_scope",
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: now,
    updated_at: now,
  });
  const reviewRepo = createSpecReviewRepo(db);
  reviewRepo.saveApproval({
    id: "approval-candidate-proof-closure",
    spec_id: specId,
    subject_kind: "revision",
    element_id: null,
    revision_id: revisionId,
    approver: "human-operator",
    granted_at: now,
    validity: "valid",
  });
  reviewRepo.insertGateAdmission({
    id: "admission-candidate-proof-closure",
    spec_id: specId,
    gate: "delivery",
    basis: "human_approval",
    approval_id: "approval-candidate-proof-closure",
    revision_id: revisionId,
    execution_id: specExecutionId,
    actor_json: JSON.stringify({ kind: "human" }),
    created_at: now,
  });
}

function insertElement(
  db: Db,
  id: string,
  kind: string,
  number: number,
  parentElementId: string | null,
  position: number,
  payload: unknown,
): void {
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, specId, kind, number, parentElementId, now);
  db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    revisionId,
    id,
    position,
    JSON.stringify(payload),
    `hash-${id}`,
    now,
    now,
  );
}

function multiSourceWorkflowExecution(): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  const lanes: Record<string, GraphWorkflowExecutionLaneState> = {
    "lane-session": workflowLane(
      "lane-session",
      "cc/session",
      `${projectPath}/.worktrees/session`,
    ),
    "lane-source-a": workflowLane(
      "lane-source-a",
      "cc/source-a",
      `${projectPath}/.worktrees/source-a`,
    ),
    "lane-source-b": workflowLane(
      "lane-source-b",
      "cc/source-b",
      `${projectPath}/.worktrees/source-b`,
    ),
  };
  const join: GraphWorkflowExecutionJoinState = {
    joinId: "join-final",
    kind: "final_publish",
    contextId: null,
    targetLaneId: "lane-session",
    sourceLaneIds: ["lane-session", "lane-source-a", "lane-source-b"],
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  return {
    ...base,
    id: workflowExecutionId,
    executionLanes: lanes,
    joins: { [join.joinId]: join },
  };
}

function workflowLane(
  laneId: string,
  branchName: string,
  worktreePath: string,
): GraphWorkflowExecutionLaneState {
  return {
    laneId,
    kind: "worktree",
    branchName,
    worktreePath,
    status: "active",
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createInMemoryWorkflowExecution(initial: GraphWorkflowExecution): {
  mutateActive: JoinRunnerMutateActive;
} {
  let current = initial;
  return {
    async mutateActive(mutator) {
      current = await mutator(current);
      return current;
    },
  };
}
