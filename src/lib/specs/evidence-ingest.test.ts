import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import {
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import {
  createEvidenceIngestService,
  type EvidenceIngestDeps,
} from "./evidence-ingest";
import type { CompiledOriginMapEntry } from "./compiler";

type Db = InstanceType<typeof Database>;

const projectPath = "/repos/evidence-ingest";
const sessionName = "evidence-session";
const workflowExecutionId = "workflow-execution-evidence";
const specExecutionId = "spec-execution-evidence";
const specId = "spec-evidence-ingest";
const revisionId = "revision-evidence-ingest";
const now = "2026-07-18T14:00:00.000Z";

describe("EvidenceIngest", () => {
  let db: Db;
  let deps: EvidenceIngestDeps;
  let originMap: CompiledOriginMapEntry[];

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    const workflowEvents = createGraphWorkflowEventsRepo(db);
    workflowEvents.appendMany(
      projectPath,
      sessionName,
      workflowExecutionId,
      now,
      [
        graphWorkflowExecutionEventSchema.parse({
          occurredAt: "2026-07-18T13:58:00.000Z",
          event: {
            type: "graph-workflow-lane-commit",
            projectName: "evidence-ingest",
            sessionName,
            executionId: workflowExecutionId,
            contextId: "context-task-1",
            laneId: "lane-1",
            sha: "commit-abc",
            committedAt: "2026-07-18T13:58:00.000Z",
          },
        }),
        graphWorkflowExecutionEventSchema.parse({
          occurredAt: "2026-07-18T13:59:00.000Z",
          event: {
            type: "graph-workflow-validation-result",
            projectName: "evidence-ingest",
            sessionName,
            executionId: workflowExecutionId,
            contextId: "context-task-1",
            validatorType: "context",
            pass: true,
            summary: "Compiler contract and focused tests pass.",
            sessionRef: {
              backend: "codex",
              ref: "validator-response-1",
              lane: "context_validator",
              refKind: "backend",
            },
          },
        }),
        graphWorkflowExecutionEventSchema.parse({
          occurredAt: "2026-07-18T13:59:30.000Z",
          event: {
            type: "graph-workflow-validation-result",
            projectName: "evidence-ingest",
            sessionName,
            executionId: workflowExecutionId,
            contextId: "context-task-2",
            validatorType: "context",
            pass: false,
            summary: "A distinct criterion still fails.",
          },
        }),
      ],
    );

    const repo = createSpecDeliveryRepo(db);
    let nextEvidenceId = 0;
    const evidenceService = createEvidenceService({
      repo,
      ingestExecutionEvidence: async () => undefined,
      nextId: () => `ingested-evidence-${++nextEvidenceId}`,
      now: () => now,
      getApprovedCriterion: async (targetRevisionId, criterionElementId) =>
        targetRevisionId === revisionId &&
        ["criterion-1", "criterion-2", "criterion-3"].includes(
          criterionElementId,
        )
          ? { specId, validationStrategy: { kinds: ["validator_verdict"] } }
          : null,
      gitObjectExists: async (ref) => ref.objectId === "commit-abc",
      workflowEventExists: async (ref, expectedExecution) => {
        const record = workflowEvents.findRecordById(ref.eventId);
        return (
          record !== null &&
          record.executionId === expectedExecution.workflowExecutionId &&
          "contextId" in record.event &&
          record.event.contextId === ref.contextId
        );
      },
      mergeValidationFactExists: async () => false,
      contentObjectExists: async () => false,
      humanActorExists: async () => false,
      isEvidenceFresh: async () => true,
      routeStrategyInadequacy: async () => undefined,
      routeWaiverRequestToHuman: async () => ({ attentionId: "unused" }),
      getTaskClaimContext: async () => null,
      getCriterionVersion: async () => null,
      wasCriterionDeliveredByMergedExecution: async () => false,
      recordMutation: () => undefined,
      runInImmediateTransaction: (operation) => operation(),
    } satisfies EvidenceServiceDeps);
    const writeQueue = createWriteQueue();
    originMap = [
      {
        contextId: "context-task-1",
        taskElementId: "task-1",
        taskHandle: "native-sdd/T1",
        criterionElementIds: ["criterion-1", "criterion-2"],
        criterionHandles: ["native-sdd/R1.1", "native-sdd/R1.2"],
        validationStrategies: {
          "criterion-1": {
            kinds: ["commit", "test_run", "validator_verdict"],
          },
          "criterion-2": { kinds: ["validator_verdict"] },
        },
        criterionBriefs: {
          "criterion-1": "Validate criterion 1.",
          "criterion-2": "Validate criterion 2.",
        },
      },
      {
        contextId: "context-task-2",
        taskElementId: "task-2",
        taskHandle: "native-sdd/T2",
        criterionElementIds: ["criterion-3"],
        criterionHandles: ["native-sdd/R2.1"],
        validationStrategies: {
          "criterion-3": { kinds: ["validator_verdict"] },
        },
        criterionBriefs: {
          "criterion-3": "Validate criterion 3.",
        },
      },
    ];

    deps = {
      repo,
      workflowEvents,
      evidenceService,
      writeQueue,
      loadOriginMap: async () => originMap,
    };
  });

  it("13.7 folds a seeded workflow log twice into one identical criterion-routed evidence set", async () => {
    const service = createEvidenceIngestService(deps);

    const first = await service.ingestAuthoritatively(specExecutionId);
    const afterFirst = readEvidence(db);
    const second = await service.ingestAuthoritatively(specExecutionId);
    const afterSecond = readEvidence(db);

    expect(first).toMatchObject({
      scannedEventCount: 3,
      materializedEvidenceCount: 6,
      existingEvidenceCount: 0,
    });
    expect(second).toMatchObject({
      scannedEventCount: 3,
      materializedEvidenceCount: 0,
      existingEvidenceCount: 6,
    });
    expect(afterSecond).toEqual(afterFirst);
    expect(JSON.parse(afterSecond[0]!.ref_json)).toEqual({
      type: "git_object",
      objectId: "commit-abc",
    });
    expect(
      afterSecond.map((row) => [
        row.criterion_element_id,
        row.kind,
        row.source_event_id,
      ]),
    ).toEqual([
      ["criterion-1", "commit", 1],
      ["criterion-2", "commit", 1],
      ["criterion-1", "test_run", 2],
      ["criterion-1", "validator_verdict", 2],
      ["criterion-2", "validator_verdict", 2],
      ["criterion-3", "validator_verdict", 3],
    ]);
  });

  it("13.7 unions criterion mappings when legal regrouping assigns multiple compiled tasks to one context", async () => {
    originMap[1] = { ...originMap[1]!, contextId: "context-task-1" };
    const service = createEvidenceIngestService(deps);

    const summary = await service.ingestAuthoritatively(specExecutionId);

    expect(summary).toMatchObject({
      scannedEventCount: 3,
      ignoredEventCount: 1,
      materializedEvidenceCount: 7,
    });
    expect(
      readEvidence(db).map((row) => [
        row.criterion_element_id,
        row.kind,
        row.source_event_id,
      ]),
    ).toEqual([
      ["criterion-1", "commit", 1],
      ["criterion-2", "commit", 1],
      ["criterion-3", "commit", 1],
      ["criterion-1", "test_run", 2],
      ["criterion-1", "validator_verdict", 2],
      ["criterion-2", "validator_verdict", 2],
      ["criterion-3", "validator_verdict", 2],
    ]);
  });

  it("best-effort reads return current state immediately when the write queue is contended", async () => {
    const contendedQueue: EvidenceIngestDeps["writeQueue"] = {
      withWriteQueue: vi.fn(async (_label, fn) => fn()),
      withWriteQueueSync: vi.fn(async (_label, fn, ...reject) => {
        void reject; // compile-time-only guard tuple; never populated at runtime
        return fn();
      }),
      async tryWithWriteQueue<T>(): Promise<
        { acquired: true; value: T } | { acquired: false }
      > {
        return { acquired: false };
      },
      _resetForTesting: vi.fn(),
    };
    const service = createEvidenceIngestService({
      ...deps,
      writeQueue: contendedQueue,
    });

    await expect(service.ingestBestEffort(specExecutionId)).resolves.toEqual({
      status: "contended",
    });
    expect(contendedQueue.withWriteQueue).not.toHaveBeenCalled();
  });
});

function seedParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(projectPath);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name, created_at,
       last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectPath, sessionName, "/worktrees/evidence", "evidence", now, now);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    projectPath,
    "evidence-ingest",
    "Evidence ingest",
    '{"preset":"contract-bearing"}',
    null,
    null,
    now,
    now,
  );
  for (const [index, criterionId] of [
    "criterion-1",
    "criterion-2",
    "criterion-3",
  ].entries()) {
    db.prepare(
      `INSERT INTO spec_elements (
         id, spec_id, kind, number, parent_element_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(criterionId, specId, "criterion", index + 1, null, now);
  }
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    specId,
    1,
    "approved",
    null,
    "revision-hash",
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specExecutionId,
    specId,
    revisionId,
    JSON.stringify({
      selectedTaskIds: ["task-1", "task-2"],
      selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-3"],
      exclusionDispositions: [],
    }),
    "running",
    "workflow-definition-evidence",
    workflowExecutionId,
    sessionName,
    null,
    null,
    now,
    now,
  );
}

function readEvidence(db: Db) {
  return db
    .prepare(
      `SELECT criterion_element_id, kind, source_event_id, ref_json,
              evaluated_state_json, producer_json
         FROM spec_evidence
        ORDER BY source_event_id ASC, criterion_element_id ASC, kind ASC`,
    )
    .all() as Array<{
    criterion_element_id: string;
    kind: string;
    source_event_id: number;
    ref_json: string;
    evaluated_state_json: string;
    producer_json: string;
  }>;
}
