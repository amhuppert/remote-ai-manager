import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import {
  applyLaneCommitSnapshot,
  createLaneCommitter,
} from "@/lib/workflow-graph/lane-committer";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { CompiledOriginMapEntry } from "./compiler";
import { createEvidenceIngestService } from "./evidence-ingest";
import {
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import { createMeasuresQuery } from "./measures-query";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/self-committed-lane";
const PROJECT_NAME = "self-committed-lane";
const SESSION_NAME = "lane-session";
const SPEC_ID = "spec-self-committed";
const REVISION_ID = "revision-self-committed";
const SPEC_EXECUTION_ID = "spec-execution-self-committed";
const WORKFLOW_EXECUTION_ID = "workflow-execution-self-committed";
const WORKFLOW_DEFINITION_ID = "workflow-definition-self-committed";
const CONTEXT_ID = "context-implement";
const LANE_ID = "lane-implement";
const LANE_WORKTREE = "/repos/.worktrees/lane-session.lane-implement";
const FORK_SHA = "fork-point-sha";
const SELF_SHA = "self-committed-sha";
const AT = "2026-07-19T12:00:00.000Z";

// Reproduces the native-SDD live-rerun shape: the lane implementer committed
// its own work during the turn, so the commit phase finds a clean worktree.
// The adopted lane HEAD must flow through the production seams unchanged —
// snapshot append → derived graph-workflow-lane-commit event → persisted
// event log → evidence ingest (origin-map routed, append-only, idempotent)
// → measures navigation chain with non-empty changedCode.
describe("self-committed lane work evidence chain (R13, R20.2, R21.2)", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    seedChainSpecEvents(db);
  });

  afterEach(() => db.close());

  it("delivers commit evidence and a complete requirement→task→changedCode→proof→merge chain when the implementer self-committed", async () => {
    const workflowEvents = createGraphWorkflowEventsRepo(db);

    // --- Engine span: commit phase on a clean worktree with a moved HEAD ---
    const previous = executionWithLane();
    const committer = createLaneCommitter({
      hasUncommittedChanges: async () => false,
      commitChanges: async () => {
        throw new Error(
          "commitChanges must not run — the implementer already committed",
        );
      },
      resolveHeadSha: async () => SELF_SHA,
      now: () => AT,
    });
    const commitResult = await committer.commit({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      contextId: CONTEXT_ID,
      laneId: LANE_ID,
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: FORK_SHA,
    });
    if (commitResult.status !== "adopted") {
      throw new Error(
        `Expected an adopted lane HEAD, got ${commitResult.status}`,
      );
    }
    expect(commitResult.snapshot).toEqual({
      contextId: CONTEXT_ID,
      sha: SELF_SHA,
      committedAt: AT,
    });

    const next = applyLaneCommitSnapshot(
      previous,
      LANE_ID,
      commitResult.snapshot,
    );

    // Production snapshot-diff derivation emits the lane-commit event.
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      now: () => AT,
    });
    const derived = publisher.publishExecutionUpdate({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      previousExecution: previous,
      nextExecution: next,
    });
    const laneCommitEvents = derived.events.filter(
      (record) => record.event.type === "graph-workflow-lane-commit",
    );
    expect(laneCommitEvents).toHaveLength(1);
    expect(laneCommitEvents[0]!.event).toMatchObject({
      contextId: CONTEXT_ID,
      laneId: LANE_ID,
      sha: SELF_SHA,
    });

    // Production ordering: the context completes on its passing validation
    // FIRST; the commit phase then adopts the self-committed lane HEAD and
    // the snapshot-diff derivation publishes the lane-commit event after it.
    workflowEvents.appendMany(
      PROJECT_PATH,
      SESSION_NAME,
      WORKFLOW_EXECUTION_ID,
      AT,
      [
        graphWorkflowExecutionEventSchema.parse({
          occurredAt: AT,
          event: {
            type: "graph-workflow-validation-result",
            projectName: PROJECT_NAME,
            sessionName: SESSION_NAME,
            executionId: WORKFLOW_EXECUTION_ID,
            contextId: CONTEXT_ID,
            validatorType: "context",
            pass: true,
            summary: "Focused tests pass for the delivered criterion.",
            sessionRef: {
              backend: "codex",
              ref: "validator-response-1",
              lane: "context_validator",
              refKind: "backend",
            },
          },
        }),
        ...derived.events,
      ],
    );

    // --- Ingest span: append-only, origin-map routed, idempotent ---
    const repo = createSpecDeliveryRepo(db);
    const specEvents = createSpecEventsRepo(db);
    let nextEvidenceId = 0;
    const recordMutation: EvidenceServiceDeps["recordMutation"] = (input) => {
      specEvents.append({
        spec_id: input.specId,
        occurred_at: input.occurredAt,
        event_type: "spec-evidence-changed",
        actor_json: stableStringify(input.actor),
        payload_json: stableStringify({ kind: input.kind, ...input.payload }),
      });
    };
    const evidenceService = createEvidenceService({
      repo,
      ingestExecutionEvidence: async () => undefined,
      nextId: () => `evidence-${++nextEvidenceId}`,
      now: () => AT,
      getApprovedCriterion: async (targetRevisionId, criterionElementId) =>
        targetRevisionId === REVISION_ID && criterionElementId === "criterion-1"
          ? {
              specId: SPEC_ID,
              validationStrategy: {
                kinds: ["commit", "test_run", "validator_verdict"],
              },
            }
          : null,
      gitObjectExists: async (ref) => ref.objectId === SELF_SHA,
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

      isEvidenceFresh: async () => true,
      routeStrategyInadequacy: async () => undefined,
      routeWaiverRequestToHuman: async () => ({ attentionId: "unused" }),
      getTaskClaimContext: async () => null,
      getCriterionVersion: async () => null,
      wasCriterionDeliveredByMergedExecution: async () => false,
      recordMutation,
      runInImmediateTransaction: (operation) => operation(),
    } satisfies EvidenceServiceDeps);

    const ingest = createEvidenceIngestService({
      repo,
      workflowEvents,
      evidenceService,
      writeQueue: createWriteQueue(),
      loadOriginMap: async () => originMap(),
      getWorkflowExecutionStatus: async () => "running",
    });

    const first = await ingest.ingestAuthoritatively(SPEC_EXECUTION_ID);
    const second = await ingest.ingestAuthoritatively(SPEC_EXECUTION_ID);

    expect(first).toMatchObject({
      materializedEvidenceCount: 3,
      existingEvidenceCount: 0,
    });
    // Re-ingest attaches nothing new: append-only and idempotent.
    expect(second).toMatchObject({
      materializedEvidenceCount: 0,
      existingEvidenceCount: 3,
    });

    const evidenceRows = db
      .prepare(
        `SELECT kind, criterion_element_id, ref_json, evaluated_state_json
           FROM spec_evidence
          ORDER BY id ASC`,
      )
      .all() as Array<{
      kind: string;
      criterion_element_id: string;
      ref_json: string;
      evaluated_state_json: string;
    }>;
    expect(
      evidenceRows.map((row) => [row.kind, row.criterion_element_id]),
    ).toEqual([
      ["test_run", "criterion-1"],
      ["validator_verdict", "criterion-1"],
      ["commit", "criterion-1"],
    ]);
    expect(JSON.parse(evidenceRows[2]!.ref_json)).toEqual({
      type: "git_object",
      objectId: SELF_SHA,
    });
    // Adopted-snapshot sha correlation (F24): the validation evidence is
    // stamped with the same self-committed HEAD the commit phase adopted.
    for (const row of evidenceRows.slice(0, 2)) {
      expect(JSON.parse(row.evaluated_state_json)).toEqual({
        commitSha: SELF_SHA,
        relevantPaths: [],
      });
    }

    // The proof verdict cites the test_run + validator_verdict evidence the
    // ingest attached (the rerun shape: those kinds were present; changedCode
    // was the missing link).
    appendSpecEvent(db, "spec-evidence-changed", 30, {
      kind: "lifecycle-measure",
      measureEvents: [
        {
          kind: "proof-verdict-recorded",
          verdictId: "verdict-1",
          criterionId: "criterion-1",
          revisionId: REVISION_ID,
          evidenceIds: ["evidence-2", "evidence-3"],
          valid: true,
        },
      ],
    });
    appendSpecEvent(db, "spec-execution-changed", 31, {
      kind: "execution_delivered",
      executionId: SPEC_EXECUTION_ID,
      revisionId: REVISION_ID,
      mergeHash: "merge-sha",
    });

    // --- Measures span: the full navigation chain closes ---
    const report = await createMeasuresQuery({
      specs: createSpecsRepo(db, createWriteQueue()),
      events: specEvents,
      delivery: repo,
      workflowEvents,
      loadOriginMap: async () => originMap(),
      now: () => AT,
    }).forProject(PROJECT_PATH);

    expect(report.navigationChains).toMatchObject([
      {
        criterionId: "criterion-1",
        requirementId: "requirement-1",
        approvedRevisionId: REVISION_ID,
        executionId: SPEC_EXECUTION_ID,
        tasks: [{ taskId: "task-1", changedCode: [{ commitSha: SELF_SHA }] }],
        validProof: { verdictId: "verdict-1" },
        mergeResult: { mergeCommitSha: "merge-sha" },
        complete: true,
      },
    ]);
  });
});

function executionWithLane(): GraphWorkflowExecution {
  const base = createWorkflowExecution({
    id: WORKFLOW_EXECUTION_ID,
    status: "running",
  });
  return {
    ...base,
    executionLanes: {
      [LANE_ID]: {
        laneId: LANE_ID,
        kind: "worktree",
        status: "active",
        worktreePath: LANE_WORKTREE,
        branchName: "csm/lane-session-lane-implement",
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: AT,
        updatedAt: AT,
      },
    },
  };
}

function originMap(): CompiledOriginMapEntry[] {
  return [
    {
      contextId: CONTEXT_ID,
      taskElementId: "task-1",
      taskHandle: "native-sdd/T1",
      criterionElementIds: ["criterion-1"],
      criterionHandles: ["native-sdd/R1.1"],
      validationStrategies: {
        "criterion-1": { kinds: ["commit", "test_run", "validator_verdict"] },
      },
      criterionBriefs: {
        "criterion-1": "Prove the delivered behavior with tests.",
      },
    },
  ];
}

function appendSpecEvent(
  db: Db,
  eventType:
    | "spec-evidence-changed"
    | "spec-execution-changed"
    | "spec-review-revision-signed-off",
  second: number,
  payload: Record<string, unknown>,
): void {
  createSpecEventsRepo(db).append({
    spec_id: SPEC_ID,
    occurred_at: `2026-07-19T12:01:${String(second).padStart(2, "0")}.000Z`,
    event_type: eventType,
    actor_json: '{"kind":"system"}',
    payload_json: stableStringify(payload),
  });
}

function seedParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name, created_at,
       last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(PROJECT_PATH, SESSION_NAME, "/worktrees/lane", "lane", AT, AT);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "self-committed-lane",
    "Self-committed lane",
    '{"preset":"contract-bearing"}',
    AT,
    AT,
  );
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("criterion-1", SPEC_ID, "criterion", 1, null, AT);
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', NULL, 'hash', ?, ?, ?)`,
  ).run(REVISION_ID, SPEC_ID, AT, AT, AT);
  createSpecDeliveryRepo(db).insertExecution({
    id: SPEC_EXECUTION_ID,
    spec_id: SPEC_ID,
    revision_id: REVISION_ID,
    scope_json: stableStringify({
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [],
    }),
    state: "delivered",
    execution_start_dial: "gate",
    workflow_definition_id: WORKFLOW_DEFINITION_ID,
    workflow_definition_revision: 1,
    workflow_execution_id: WORKFLOW_EXECUTION_ID,
    session_name: SESSION_NAME,
    delivered_at: AT,
    abandoned_reason: null,
    created_at: AT,
    updated_at: AT,
  });
}

function seedChainSpecEvents(db: Db): void {
  appendSpecEvent(db, "spec-review-revision-signed-off", 1, {
    kind: "lifecycle-measure",
    measureEvents: [
      {
        kind: "review-action",
        action: "sign_off",
        reviewAttemptId: "attempt-1",
        activeStartedAt: "2026-07-19T11:59:58.000Z",
        revisionId: REVISION_ID,
      },
    ],
  });
  appendSpecEvent(db, "spec-execution-changed", 2, {
    kind: "lifecycle-measure",
    measureEvents: [
      {
        kind: "criterion-delivered-in-scope",
        criterionId: "criterion-1",
        requirementId: "requirement-1",
        revisionId: REVISION_ID,
        executionId: SPEC_EXECUTION_ID,
        taskIds: ["task-1"],
      },
    ],
  });
}
