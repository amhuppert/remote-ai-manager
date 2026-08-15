import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import {
  specCriterionDispositionRowSchema,
  specEvidenceRowSchema,
  specExecutionRowSchema,
  specProofVerdictRowSchema,
  specTaskClaimRowSchema,
  specWaiverRowSchema,
  type SpecCriterionDispositionRow,
  type SpecEvidenceRow,
  type SpecExecutionRow,
  type SpecProofVerdictRow,
  type SpecTaskClaimRow,
  type SpecWaiverRow,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { _createTestDb } from "./state-db";
import {
  createSpecDeliveryRepo,
  type SpecDeliveryRepo,
} from "./spec-delivery-repo";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-delivery-maximal";
const CRITERION_ID = "criterion-delivery-maximal";
const SECOND_CRITERION_ID = "criterion-delivery-second";
const TASK_ID = "task-delivery-maximal";
const REVISION_ID = "revision-delivery-maximal";
const SOURCE_EXECUTION_ID = "execution-delivery-source";
const DELIVERED_EXECUTION_ID = "execution-delivery-prior";

let db: Db;
let repo: SpecDeliveryRepo;

function insertExecutionParent(
  id: string,
  state: "running" | "delivered",
): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({ criterionElementIds: [CRITERION_ID] }),
    state,
    `workflow-definition-${id}`,
    `workflow-execution-${id}`,
    `session-${id}`,
    state === "delivered" ? "2026-07-18T10:00:00.000Z" : null,
    null,
    "2026-07-18T09:00:00.000Z",
    "2026-07-18T09:01:00.000Z",
  );
}

function seedDeliveryParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/delivery-contract",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repos/delivery-contract",
    "delivery-contract",
    "Delivery contract",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T08:00:00.000Z",
    "2026-07-18T08:01:00.000Z",
  );
  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertElement.run(
    CRITERION_ID,
    SPEC_ID,
    "criterion",
    3,
    null,
    "2026-07-18T08:02:00.000Z",
  );
  insertElement.run(
    SECOND_CRITERION_ID,
    SPEC_ID,
    "criterion",
    4,
    null,
    "2026-07-18T08:02:30.000Z",
  );
  insertElement.run(
    TASK_ID,
    SPEC_ID,
    "task",
    8,
    null,
    "2026-07-18T08:03:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    6,
    "approved",
    null,
    "sha256:delivery-maximal",
    "2026-07-18T08:04:00.000Z",
    "2026-07-18T08:05:00.000Z",
    "2026-07-18T08:03:30.000Z",
  );
  insertExecutionParent(SOURCE_EXECUTION_ID, "running");
  insertExecutionParent(DELIVERED_EXECUTION_ID, "delivered");
}

function maximalEvidence(): SpecEvidenceRow {
  return specEvidenceRowSchema.parse({
    id: "evidence-delivery-maximal",
    spec_id: SPEC_ID,
    criterion_element_id: CRITERION_ID,
    revision_id: REVISION_ID,
    kind: "validator_verdict",
    ref_json: JSON.stringify({
      type: "workflow_event",
      workflowExecutionId: "workflow-execution-delivery-source",
      eventId: 481,
      artifactUrl: "cc://workflows/execution-delivery-source/events/481",
    }),
    evaluated_state_json: JSON.stringify({
      commitSha: "abc123delivery",
      relevantPaths: [
        "src/lib/state-store/spec-delivery-repo.ts",
        "src/lib/state-store/spec-delivery-repo.contract.test.ts",
      ],
      relevantTreeHash: "tree-delivery-maximal",
      // Retained-historical field: no evaluation path reads surfaceId since
      // the evidence-kind narrowing dropped surface evidence, but persisted
      // rows carrying it must keep parsing — this fixture is that proof.
      surfaceId: "spec-studio/evidence",
    }),
    producer_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-delivery-maximal",
      backend: "codex",
    }),
    execution_id: SOURCE_EXECUTION_ID,
    source_event_id: 481,
    created_at: "2026-07-18T11:00:00.000Z",
  });
}

function maximalProofVerdict(): SpecProofVerdictRow {
  return specProofVerdictRowSchema.parse({
    id: "verdict-delivery-maximal",
    spec_id: SPEC_ID,
    criterion_element_id: CRITERION_ID,
    revision_id: REVISION_ID,
    execution_id: SOURCE_EXECUTION_ID,
    verdict_kind: "agent_validator",
    evidence_ids_json: JSON.stringify([
      "evidence-delivery-maximal",
      "evidence-delivery-secondary",
    ]),
    verdict_at: "2026-07-18T11:01:00.000Z",
    stale_at: "2026-07-18T11:02:00.000Z",
    stale_reason: "The evaluated relevant-tree hash no longer matches.",
  });
}

function maximalWaiver(): SpecWaiverRow {
  return specWaiverRowSchema.parse({
    id: "waiver-delivery-maximal",
    spec_id: SPEC_ID,
    criterion_element_id: CRITERION_ID,
    revision_id: REVISION_ID,
    reason: "The external validation environment is unavailable for V1.",
    waived_at: "2026-07-18T11:03:00.000Z",
    stale: 1,
  });
}

function maximalDisposition(): SpecCriterionDispositionRow {
  return specCriterionDispositionRowSchema.parse({
    execution_id: SOURCE_EXECUTION_ID,
    criterion_element_id: CRITERION_ID,
    disposition: "delivered_elsewhere",
    waiver_id: "waiver-delivery-maximal",
    delivered_by_execution_id: DELIVERED_EXECUTION_ID,
    created_at: "2026-07-18T11:04:00.000Z",
    updated_at: "2026-07-18T11:05:00.000Z",
  });
}

function maximalTaskClaim(): SpecTaskClaimRow {
  return specTaskClaimRowSchema.parse({
    id: "claim-delivery-maximal",
    spec_id: SPEC_ID,
    task_element_id: TASK_ID,
    execution_id: SOURCE_EXECUTION_ID,
    actor_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-delivery-maximal",
      backend: "codex",
    }),
    evidence_ids_json: JSON.stringify([
      "evidence-delivery-maximal",
      "evidence-delivery-secondary",
    ]),
    claimed_at: "2026-07-18T11:06:00.000Z",
    status: "reopened",
  });
}

function maximalExecution(): SpecExecutionRow {
  return specExecutionRowSchema.parse({
    id: "execution-delivery-maximal",
    spec_id: SPEC_ID,
    revision_id: REVISION_ID,
    scope_json: JSON.stringify({
      taskElementIds: [TASK_ID],
      criterionElementIds: [CRITERION_ID],
      dispositions: {
        [CRITERION_ID]: "in_scope",
      },
    }),
    state: "abandoning",
    execution_start_dial: "notify",
    workflow_definition_id: "workflow-definition-delivery-maximal",
    workflow_definition_revision: 4,
    workflow_execution_id: "workflow-execution-delivery-maximal",
    session_name: "native-sdd-delivery-maximal",
    delivered_at: "2026-07-18T11:07:00.000Z",
    abandoned_reason: "The pinned execution was superseded by human choice.",
    cleanup_phase: "finalize",
    linked_workflow_execution_id: "workflow-execution-delivery-maximal",
    cleanup_last_error:
      "Graph workflow execution workflow-execution-delivery-maximal is still live (running).",
    cleanup_last_error_at: "2026-07-18T11:07:30.000Z",
    created_at: "2026-07-18T10:30:00.000Z",
    updated_at: "2026-07-18T11:08:00.000Z",
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryParents();
  repo = createSpecDeliveryRepo(db);
  repo.saveWaiver(maximalWaiver());
});

afterEach(() => {
  db.close();
});

describe("spec-delivery-repo durability contract", () => {
  it("round-trips every persisted delivery field and structured payload", async () => {
    await assertRoundTripDurability({
      label: "spec-evidence",
      schema: specEvidenceRowSchema,
      buildMaximalFixture: maximalEvidence,
      persist: (fixture) => {
        repo.insertEvidence(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findEvidenceById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-proof-verdict",
      schema: specProofVerdictRowSchema,
      buildMaximalFixture: maximalProofVerdict,
      persist: (fixture) => {
        repo.saveProofVerdict(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findProofVerdictById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-waiver",
      schema: specWaiverRowSchema,
      buildMaximalFixture: maximalWaiver,
      persist: (fixture) => {
        repo.saveWaiver(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findWaiverById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-criterion-disposition",
      schema: specCriterionDispositionRowSchema,
      buildMaximalFixture: maximalDisposition,
      persist: (fixture) => {
        repo.saveCriterionDisposition(fixture);
        return fixture;
      },
      reload: (fixture) =>
        repo.findCriterionDisposition(
          fixture.execution_id,
          fixture.criterion_element_id,
        ),
    });

    await assertRoundTripDurability({
      label: "spec-task-claim",
      schema: specTaskClaimRowSchema,
      buildMaximalFixture: maximalTaskClaim,
      persist: (fixture) => {
        repo.saveTaskClaim(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findTaskClaimById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-execution",
      schema: specExecutionRowSchema,
      buildMaximalFixture: maximalExecution,
      persist: (fixture) => {
        repo.insertExecution(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findExecutionById(fixture.id),
    });

    expect(JSON.parse(maximalEvidence().evaluated_state_json)).toEqual({
      commitSha: "abc123delivery",
      relevantPaths: [
        "src/lib/state-store/spec-delivery-repo.ts",
        "src/lib/state-store/spec-delivery-repo.contract.test.ts",
      ],
      relevantTreeHash: "tree-delivery-maximal",
      surfaceId: "spec-studio/evidence",
    });
    expect(repo.findEvidenceBySourceEventId(481)).toEqual([maximalEvidence()]);
    expect(
      repo.findEvidenceByIngestKey(481, CRITERION_ID, "validator_verdict"),
    ).toEqual(maximalEvidence());
    expect(repo.findProofVerdictsByRevision(REVISION_ID)).toEqual([
      maximalProofVerdict(),
    ]);
    expect(repo.findWaiversByRevision(REVISION_ID)).toEqual([maximalWaiver()]);
    expect(repo.findTaskClaimsBySpecId(SPEC_ID)).toEqual([maximalTaskClaim()]);
    expect(repo.findExecutionsBySpecId(SPEC_ID)).toEqual([
      expect.objectContaining({ id: DELIVERED_EXECUTION_ID }),
      expect.objectContaining({ id: SOURCE_EXECUTION_ID }),
      maximalExecution(),
    ]);
    expect(
      repo.findWaiverForCriterionRevision(CRITERION_ID, REVISION_ID),
    ).toEqual(maximalWaiver());
  });

  it("keeps every abandon-coordinator phase durable across a reload", () => {
    const execution = {
      ...maximalExecution(),
      id: "execution-abandon-coordinator",
      state: "running",
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      workflow_execution_id: "workflow-execution-abandon-coordinator",
      delivered_at: null,
      abandoned_reason: null,
    } as SpecExecutionRow;
    repo.insertExecution(execution);

    const entered = repo.saveExecutionCleanupState({
      executionId: execution.id,
      state: "abandoning",
      cleanupPhase: "abort_workflow",
      linkedWorkflowExecutionId: "workflow-execution-abandon-coordinator",
      cleanupLastError: null,
      cleanupLastErrorAt: null,
      abandonedReason: "superseded by a replanned run",
      updatedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(repo.findExecutionById(execution.id)).toEqual(entered);
    expect(entered).toMatchObject({
      state: "abandoning",
      cleanup_phase: "abort_workflow",
      linked_workflow_execution_id: "workflow-execution-abandon-coordinator",
      abandoned_reason: "superseded by a replanned run",
    });

    const blocked = repo.saveExecutionCleanupState({
      executionId: execution.id,
      state: "abandoning",
      cleanupPhase: "finalize",
      linkedWorkflowExecutionId: "workflow-execution-abandon-coordinator",
      cleanupLastError: "the linked run is still live (running)",
      cleanupLastErrorAt: "2026-07-18T12:01:00.000Z",
      abandonedReason: "superseded by a replanned run",
      updatedAt: "2026-07-18T12:01:00.000Z",
    });
    expect(repo.findExecutionById(execution.id)).toEqual(blocked);
    expect(blocked).toMatchObject({
      cleanup_phase: "finalize",
      cleanup_last_error: "the linked run is still live (running)",
      cleanup_last_error_at: "2026-07-18T12:01:00.000Z",
    });

    const finalized = repo.saveExecutionCleanupState({
      executionId: execution.id,
      state: "abandoned",
      cleanupPhase: null,
      linkedWorkflowExecutionId: "workflow-execution-abandon-coordinator",
      cleanupLastError: null,
      cleanupLastErrorAt: null,
      abandonedReason: "superseded by a replanned run",
      updatedAt: "2026-07-18T12:02:00.000Z",
    });
    expect(repo.findExecutionById(execution.id)).toEqual(finalized);
    expect(finalized).toMatchObject({
      state: "abandoned",
      cleanup_phase: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
    });
  });

  it("leaves an abandoning execution out of the session's active set", () => {
    const session = "session-abandoning-active-set";
    repo.insertExecution({
      ...maximalExecution(),
      id: "execution-abandoning-not-active",
      state: "abandoning",
      cleanup_phase: "abort_workflow",
      workflow_execution_id: "workflow-execution-abandoning-not-active",
      session_name: session,
      delivered_at: null,
    } as SpecExecutionRow);
    repo.insertExecution({
      ...maximalExecution(),
      id: "execution-running-in-session",
      state: "running",
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      workflow_execution_id: "workflow-execution-running-in-session",
      session_name: session,
      delivered_at: null,
    } as SpecExecutionRow);

    // A run committed to termination is not "active": leaving it in would keep
    // Needs You and the session's execution reads pointing at work nobody is
    // going to finish.
    expect(
      repo
        .findActiveExecutionsBySessionName("/repos/delivery-contract", session)
        .map((row) => row.id),
    ).toEqual(["execution-running-in-session"]);
  });

  it("round-trips the immutable workflow launch contract", () => {
    const execution = {
      ...maximalExecution(),
      id: "execution-frozen-launch",
      workflow_definition_id: "workflow-definition-frozen-launch",
      workflow_definition_revision: 7,
      workflow_execution_id: "workflow-execution-frozen-launch",
      execution_start_dial: "off",
    } as SpecExecutionRow;

    repo.insertExecution(execution);

    expect(repo.findExecutionById(execution.id)).toMatchObject({
      execution_start_dial: "off",
      workflow_definition_id: "workflow-definition-frozen-launch",
      workflow_definition_revision: 7,
    });
  });

  it("finds the awaiting execution by exact workflow definition revision", () => {
    const revisionSeven = {
      ...maximalExecution(),
      id: "execution-definition-revision-7",
      state: "definition_review",
      workflow_definition_id: "workflow-definition-shared",
      workflow_definition_revision: 7,
      workflow_execution_id: null,
      delivered_at: null,
      abandoned_reason: null,
      created_at: "2026-07-18T12:00:00.000Z",
      updated_at: "2026-07-18T12:00:00.000Z",
    } as SpecExecutionRow;
    const revisionEight = {
      ...revisionSeven,
      id: "execution-definition-revision-8",
      workflow_definition_revision: 8,
      created_at: "2026-07-18T12:01:00.000Z",
      updated_at: "2026-07-18T12:01:00.000Z",
    } as SpecExecutionRow;
    repo.insertExecution(revisionSeven);
    repo.insertExecution(revisionEight);

    expect(
      repo.findExecutionAwaitingWorkflowByDefinitionIdInSession(
        "/repos/delivery-contract",
        "native-sdd-delivery-maximal",
        "workflow-definition-shared",
        7,
      ),
    ).toMatchObject({
      id: "execution-definition-revision-7",
      workflow_definition_revision: 7,
    });
  });

  it("isolates identical awaiting definition identities by project and session", () => {
    const otherProjectPath = "/repos/delivery-contract-other";
    const otherSpecId = "spec-delivery-other";
    const otherRevisionId = "revision-delivery-other";
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
      otherProjectPath,
    );
    db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json,
         abandoned_at, abandoned_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      otherSpecId,
      otherProjectPath,
      "delivery-other",
      "Delivery other",
      '{"preset":"contract-bearing"}',
      null,
      null,
      "2026-07-18T08:00:00.000Z",
      "2026-07-18T08:01:00.000Z",
    );
    db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, based_on_revision_id, content_hash,
         proposed_at, approved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      otherRevisionId,
      otherSpecId,
      1,
      "approved",
      null,
      "sha256:delivery-other",
      "2026-07-18T08:04:00.000Z",
      "2026-07-18T08:05:00.000Z",
      "2026-07-18T08:03:30.000Z",
    );

    const sharedIdentity = {
      state: "definition_review" as const,
      workflow_definition_id: "workflow-definition-collision",
      workflow_definition_revision: 3,
      workflow_execution_id: null,
      session_name: "shared-session",
      delivered_at: null,
      abandoned_reason: null,
    };
    repo.insertExecution({
      ...maximalExecution(),
      ...sharedIdentity,
      id: "execution-collision-primary",
    });
    repo.insertExecution({
      ...maximalExecution(),
      ...sharedIdentity,
      id: "execution-collision-other",
      spec_id: otherSpecId,
      revision_id: otherRevisionId,
    });

    expect(
      repo.findExecutionAwaitingWorkflowByDefinitionIdInSession(
        "/repos/delivery-contract",
        "shared-session",
        "workflow-definition-collision",
        3,
      ),
    ).toMatchObject({ id: "execution-collision-primary" });
    expect(
      repo.findExecutionAwaitingWorkflowByDefinitionIdInSession(
        otherProjectPath,
        "shared-session",
        "workflow-definition-collision",
        3,
      ),
    ).toMatchObject({ id: "execution-collision-other" });
  });

  it("exposes no evidence update path and refuses reinsertion as an update", () => {
    const evidence = maximalEvidence();
    repo.insertEvidence(evidence);

    expect("updateEvidence" in repo).toBe(false);
    expect(() =>
      repo.insertEvidence({
        ...evidence,
        ref_json: JSON.stringify({ type: "commit", sha: "replacement" }),
      }),
    ).toThrow();
    expect(repo.findEvidenceById(evidence.id)).toEqual(evidence);
  });

  it("deduplicates evidence ingestion by source event, criterion, and kind", () => {
    const evidence = maximalEvidence();
    expect(repo.insertEvidence(evidence)).toEqual(evidence);

    const replay = repo.insertEvidence({
      ...evidence,
      id: "evidence-delivery-replay",
    });

    expect(replay).toEqual(evidence);
    expect(repo.findEvidenceById("evidence-delivery-replay")).toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM spec_evidence WHERE source_event_id = ?",
        )
        .get(evidence.source_event_id),
    ).toEqual({ count: 1 });
  });

  it("materializes one source event for multiple criteria and evidence kinds", () => {
    const firstCriterion = maximalEvidence();
    const secondCriterion = specEvidenceRowSchema.parse({
      ...firstCriterion,
      id: "evidence-delivery-second-criterion",
      criterion_element_id: SECOND_CRITERION_ID,
    });
    const secondKind = specEvidenceRowSchema.parse({
      ...firstCriterion,
      id: "evidence-delivery-second-kind",
      kind: "test_run",
    });

    expect(repo.insertEvidence(firstCriterion)).toEqual(firstCriterion);
    expect(repo.insertEvidence(secondCriterion)).toEqual(secondCriterion);
    expect(repo.insertEvidence(secondKind)).toEqual(secondKind);
    expect(repo.findEvidenceBySourceEventId(481)).toEqual([
      firstCriterion,
      secondCriterion,
      secondKind,
    ]);
    expect(
      repo.findEvidenceByIngestKey(
        481,
        SECOND_CRITERION_ID,
        "validator_verdict",
      ),
    ).toEqual(secondCriterion);
    expect(repo.findEvidenceByIngestKey(481, CRITERION_ID, "test_run")).toEqual(
      secondKind,
    );
  });
});

describe("findActiveExecutionsBySessionName", () => {
  function insertExecutionForSession(
    id: string,
    specId: string,
    state: "definition_review" | "running" | "delivered" | "abandoned",
    sessionName: string,
    createdAt: string,
  ): void {
    db.prepare(
      `INSERT INTO spec_executions (
         id, spec_id, revision_id, scope_json, state, workflow_definition_id,
         workflow_execution_id, session_name, delivered_at, abandoned_reason,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      specId,
      REVISION_ID,
      JSON.stringify({ criterionElementIds: [CRITERION_ID] }),
      state,
      `workflow-definition-${id}`,
      state === "definition_review" ? null : `workflow-execution-${id}`,
      sessionName,
      state === "delivered" ? "2026-07-18T10:00:00.000Z" : null,
      state === "abandoned" ? "superseded" : null,
      createdAt,
      createdAt,
    );
  }

  it("returns only the project's non-terminal executions hosted by the session", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
      "/repos/other-project",
    );
    db.prepare(
      `INSERT INTO specs (
         id, project_path, slug, name, gate_policy_json,
         abandoned_at, abandoned_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "spec-other-project",
      "/repos/other-project",
      "other-spec",
      "Other project spec",
      '{"preset":"contract-bearing"}',
      null,
      null,
      "2026-07-18T08:00:00.000Z",
      "2026-07-18T08:01:00.000Z",
    );

    insertExecutionForSession(
      "exec-host-running",
      SPEC_ID,
      "running",
      "fx-host",
      "2026-07-18T09:10:00.000Z",
    );
    insertExecutionForSession(
      "exec-host-review",
      SPEC_ID,
      "definition_review",
      "fx-host",
      "2026-07-18T09:05:00.000Z",
    );
    insertExecutionForSession(
      "exec-host-delivered",
      SPEC_ID,
      "delivered",
      "fx-host",
      "2026-07-18T09:00:00.000Z",
    );
    insertExecutionForSession(
      "exec-host-abandoned",
      SPEC_ID,
      "abandoned",
      "fx-host",
      "2026-07-18T09:01:00.000Z",
    );
    insertExecutionForSession(
      "exec-other-session",
      SPEC_ID,
      "running",
      "fx-elsewhere",
      "2026-07-18T09:02:00.000Z",
    );
    insertExecutionForSession(
      "exec-other-project",
      "spec-other-project",
      "running",
      "fx-host",
      "2026-07-18T09:03:00.000Z",
    );

    const found = repo.findActiveExecutionsBySessionName(
      "/repos/delivery-contract",
      "fx-host",
    );
    expect(found.map((execution) => execution.id)).toEqual([
      "exec-host-review",
      "exec-host-running",
    ]);
  });

  it("returns an empty list when the session hosts nothing active", () => {
    expect(
      repo.findActiveExecutionsBySessionName(
        "/repos/delivery-contract",
        "fx-unhosted",
      ),
    ).toEqual([]);
  });
});
