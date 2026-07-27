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
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";
import type { RevisionSnapshot } from "./lint";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-evidence";
const REVISION_ID = "revision-evidence";
const OTHER_REVISION_ID = "revision-evidence-other";
const CRITERION_ID = "criterion-evidence";
const OTHER_CRITERION_ID = "criterion-other";
const TASK_ID = "task-evidence";
const EXECUTION_ID = "execution-evidence";
const PRIOR_EXECUTION_ID = "execution-evidence-prior";
const UNRELATED_EXECUTION_ID = "execution-evidence-unrelated";

const TASK_CLAIM_DRAFT: RevisionSnapshot = {
  specHandle: "evidence-service",
  authoringStage: "plan",
  elements: [
    {
      id: CRITERION_ID,
      handle: "R1.1",
      payloadHash: "criterion-evidence-hash",
      payload: {
        kind: "criterion",
        text: "Evidence proves the criterion.",
        validationStrategy: { kinds: ["commit"] },
      },
    },
    {
      id: TASK_ID,
      handle: "T1",
      payloadHash: "task-evidence-hash",
      payload: {
        kind: "task",
        title: "Produce evidence",
        instructions: "Implement and prove the criterion.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [CRITERION_ID],
        dependsOnTaskElementIds: [],
      },
    },
  ],
};

function seedParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/evidence-service",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repos/evidence-service",
    "evidence-service",
    "Evidence service",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T12:00:00.000Z",
    "2026-07-18T12:00:00.000Z",
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
    1,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  insertElement.run(
    OTHER_CRITERION_ID,
    SPEC_ID,
    "criterion",
    2,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  insertElement.run(
    TASK_ID,
    SPEC_ID,
    "task",
    1,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    1,
    "approved",
    null,
    "sha256:evidence-revision",
    "2026-07-18T12:00:00.000Z",
    "2026-07-18T12:01:00.000Z",
    "2026-07-18T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    OTHER_REVISION_ID,
    SPEC_ID,
    2,
    "approved",
    REVISION_ID,
    "sha256:evidence-revision-other",
    "2026-07-18T12:02:00.000Z",
    "2026-07-18T12:03:00.000Z",
    "2026-07-18T12:02:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({
      selectedTaskIds: ["task-evidence"],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [
        { criterionId: OTHER_CRITERION_ID, disposition: "deferred" },
      ],
    }),
    "running",
    "workflow-definition-evidence",
    "workflow-execution-evidence",
    "evidence-session",
    null,
    null,
    "2026-07-18T12:02:00.000Z",
    "2026-07-18T12:02:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PRIOR_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({
      selectedTaskIds: [TASK_ID],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    "delivered",
    "workflow-definition-evidence-prior",
    "workflow-execution-evidence-prior",
    "evidence-prior-session",
    "2026-07-18T12:01:30.000Z",
    null,
    "2026-07-18T12:00:30.000Z",
    "2026-07-18T12:01:30.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    UNRELATED_EXECUTION_ID,
    SPEC_ID,
    OTHER_REVISION_ID,
    JSON.stringify({
      selectedTaskIds: [TASK_ID],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    "running",
    "workflow-definition-evidence-unrelated",
    "workflow-execution-evidence-unrelated",
    "evidence-unrelated-session",
    null,
    null,
    "2026-07-18T12:03:30.000Z",
    "2026-07-18T12:03:30.000Z",
  );
}

describe("EvidenceService evidence records and proof verdicts", () => {
  let db: Db;
  let deps: EvidenceServiceDeps;
  let ids: number;

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    ids = 0;
    deps = {
      repo: createSpecDeliveryRepo(db),
      ingestExecutionEvidence: vi.fn(async () => undefined),
      nextId: (kind) => `${kind}-${++ids}`,
      now: () => "2026-07-18T12:03:00.000Z",
      getApprovedCriterion: async () => ({
        specId: SPEC_ID,
        validationStrategy: { kinds: ["commit", "test_run"] },
      }),
      gitObjectExists: vi.fn(async () => false),
      workflowEventExists: vi.fn(async () => false),
      mergeValidationFactExists: vi.fn(async () => false),
      isEvidenceFresh: vi.fn(async () => true),
      routeStrategyInadequacy: vi.fn(async () => undefined),
      routeWaiverRequestToHuman: vi.fn(async () => ({
        attentionId: "attention-waiver",
      })),
      getTaskClaimContext: vi.fn(async () => ({
        specId: SPEC_ID,
        revisionId: REVISION_ID,
        policy: { preset: "contract-bearing" as const },
        draft: TASK_CLAIM_DRAFT,
        coveredCriterionElementIds: [CRITERION_ID],
      })),
      getCriterionVersion: vi.fn(async (revisionId) => ({
        specId: SPEC_ID,
        revisionNumber: revisionId === REVISION_ID ? 1 : 2,
        payloadHash:
          revisionId === REVISION_ID
            ? "criterion-hash-approved"
            : "criterion-hash-changed",
      })),
      wasCriterionDeliveredByMergedExecution: vi.fn(async () => false),
      recordMutation: vi.fn(),
      runInImmediateTransaction: (operation) => operation(),
    };
  });

  it.each([
    ["commit", { type: "git_object", objectId: "missing-commit" }],
    [
      "validator_verdict",
      {
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-evidence",
        eventId: 41,
        contextId: "context-evidence",
      },
    ],
    [
      "test_run",
      {
        type: "merge_validation",
        mergeJobId: "merge-job-evidence",
        validationRef: "validation-evidence",
      },
    ],
  ] as const)(
    "13.2 refuses an unresolvable %s reference",
    async (kind, ref) => {
      const service = createEvidenceService(deps);

      const result = await service.attachEvidence({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        kind,
        ref,
        evaluatedState: { relevantPaths: [] },
        producer: { kind: "agent", conversationId: "conversation-evidence" },
        executionId: EXECUTION_ID,
      });

      expect(result).toEqual({
        ok: false,
        refusal: {
          code: "unresolvable_evidence",
          unmetConditions: [
            `${kind} evidence reference could not be resolved by the server.`,
          ],
          instruction:
            "Attach a reference to an object Command Center can resolve.",
        },
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM spec_evidence").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("13.2 accepts a workflow event only when its execution, event row, and context resolve", async () => {
    deps.workflowEventExists = vi.fn(async (ref) =>
      Boolean(
        ref.workflowExecutionId === "workflow-execution-evidence" &&
        ref.eventId === 41 &&
        ref.contextId === "context-evidence",
      ),
    );
    const service = createEvidenceService(deps);

    const result = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "validator_verdict",
      ref: {
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-evidence",
        eventId: 41,
        contextId: "context-evidence",
      },
      evaluatedState: {
        commitSha: "commit-evidence",
        relevantPaths: ["src/lib/specs/evidence-service.ts"],
        relevantTreeHash: "tree-evidence",
      },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
      sourceEventId: 41,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        spec_id: SPEC_ID,
        criterion_element_id: CRITERION_ID,
        revision_id: REVISION_ID,
        kind: "validator_verdict",
        execution_id: EXECUTION_ID,
        source_event_id: 41,
      },
    });
    expect(deps.workflowEventExists).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowExecutionId: "workflow-execution-evidence",
        eventId: 41,
        contextId: "context-evidence",
      }),
      {
        specExecutionId: EXECUTION_ID,
        workflowExecutionId: "workflow-execution-evidence",
      },
    );
  });

  it("13.2 refuses a workflow event from a different producing execution", async () => {
    deps.workflowEventExists = vi.fn(async () => true);
    const service = createEvidenceService(deps);

    const result = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "validator_verdict",
      ref: {
        type: "workflow_event",
        workflowExecutionId: "workflow-execution-evidence-prior",
        eventId: 42,
        contextId: "context-evidence",
      },
      evaluatedState: { relevantPaths: [] },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "unresolvable_evidence",
        unmetConditions: [
          "validator_verdict evidence reference could not be resolved by the server.",
        ],
      },
    });
  });

  it("13.2 resolves merge validation facts in the declared producing execution context", async () => {
    deps.mergeValidationFactExists = vi.fn(
      async (_ref, expectedExecution?) =>
        expectedExecution?.specExecutionId === PRIOR_EXECUTION_ID,
    );
    const service = createEvidenceService(deps);
    const ref = {
      type: "merge_validation" as const,
      mergeJobId: "merge-job-evidence-prior",
      validationRef: "validation-evidence-prior",
    };

    const result = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "test_run",
      ref,
      evaluatedState: { relevantPaths: [] },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });

    expect(deps.mergeValidationFactExists).toHaveBeenCalledWith(ref, {
      specExecutionId: EXECUTION_ID,
      workflowExecutionId: "workflow-execution-evidence",
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "unresolvable_evidence" },
    });
  });

  it("13.4 refuses a verdict missing a resolvable fresh record for every strategy kind", async () => {
    deps.gitObjectExists = vi.fn(async () => true);
    const service = createEvidenceService(deps);
    const evidence = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "commit",
      ref: { type: "git_object", objectId: "commit-evidence" },
      evaluatedState: {
        commitSha: "commit-evidence",
        relevantPaths: [],
      },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    if (!evidence.ok) throw new Error("fixture evidence was refused");

    const result = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [evidence.value.id],
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          "The approved validation strategy requires fresh, resolvable test_run evidence.",
        ],
        instruction:
          "Attach fresh, resolvable evidence for every kind in the approved validation strategy.",
      },
    });
  });

  it("13.5 records a verdict when all and only approved strategy requirements are satisfied", async () => {
    deps.gitObjectExists = vi.fn(async () => true);
    deps.mergeValidationFactExists = vi.fn(async () => true);
    const service = createEvidenceService(deps);
    const commit = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "commit",
      ref: { type: "git_object", objectId: "commit-evidence" },
      evaluatedState: { commitSha: "commit-evidence", relevantPaths: [] },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    const testRun = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "test_run",
      ref: {
        type: "merge_validation",
        mergeJobId: "merge-job-evidence",
        validationRef: "validation-evidence",
      },
      evaluatedState: {
        commitSha: "commit-evidence",
        relevantPaths: [],
        relevantTreeHash: "tree-evidence",
      },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    if (!commit.ok || !testRun.ok)
      throw new Error("fixture evidence was refused");

    const result = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "deterministic_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [commit.value.id, testRun.value.id],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        criterion_element_id: CRITERION_ID,
        revision_id: REVISION_ID,
        verdict_kind: "deterministic_validator",
        stale_at: null,
        stale_reason: null,
      },
    });
    if (!result.ok) throw new Error("verdict was refused");
    expect(deps.repo.findProofVerdictById(result.value.id)).toEqual(
      result.value,
    );
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "proof-verdict-recorded",
        actor: { kind: "system" },
      }),
    );
  });

  it("F24 qualifies stamped in-run machine evidence for a proof verdict where a sha-less row stays disqualified", async () => {
    deps.getApprovedCriterion = async () => ({
      specId: SPEC_ID,
      validationStrategy: { kinds: ["validator_verdict"] },
    });
    deps.workflowEventExists = vi.fn(async () => true);
    // Production-shaped freshness: evaluateEvidenceFreshness routes machine
    // evidence without a tree hash through ancestry, which requires a
    // commitSha — a sha-less evaluated state can never probe git.
    deps.isEvidenceFresh = vi.fn(async (evidence) => {
      const state: unknown = JSON.parse(evidence.evaluated_state_json);
      return (
        typeof state === "object" &&
        state !== null &&
        "commitSha" in state &&
        typeof state.commitSha === "string"
      );
    });
    const service = createEvidenceService(deps);
    const workflowEventRef = {
      type: "workflow_event",
      workflowExecutionId: "workflow-execution-evidence",
      eventId: 41,
      contextId: "context-evidence",
    } as const;
    const stamped = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "validator_verdict",
      ref: workflowEventRef,
      evaluatedState: { commitSha: "lane-head-sha", relevantPaths: [] },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    const legacy = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      kind: "validator_verdict",
      ref: workflowEventRef,
      evaluatedState: { relevantPaths: [] },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    if (!stamped.ok || !legacy.ok)
      throw new Error("fixture evidence was refused");

    const fromLegacy = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [legacy.value.id],
    });
    const fromStamped = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [stamped.value.id],
    });

    expect(fromLegacy).toEqual({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          "The approved validation strategy requires fresh, resolvable validator_verdict evidence.",
        ],
        instruction:
          "Attach fresh, resolvable evidence for every kind in the approved validation strategy.",
      },
    });
    expect(fromStamped).toMatchObject({
      ok: true,
      value: {
        criterion_element_id: CRITERION_ID,
        revision_id: REVISION_ID,
        stale_at: null,
      },
    });
  });

  it.each([
    ["agent_validator", "ui_route"],
    ["deterministic_validator", "ui_route"],
    ["human", "execution_ingest"],
  ] as const)(
    "13.4 refuses %s verdicts from %s",
    async (verdictKind, origin) => {
      const service = createEvidenceService(deps);

      const result = await service.recordProofVerdict({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        executionId: EXECUTION_ID,
        verdictKind,
        origin,
        actor: { kind: "system" },
        evidenceIds: [],
      });

      expect(result).toMatchObject({
        ok: false,
        refusal: { code: "human_act_required" },
      });
    },
  );

  it("13.4 tells a stranded human verdict caller the waiver is the remedy", async () => {
    const service = createEvidenceService(deps);

    const result = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "human",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [],
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "human_act_required",
        unmetConditions: ["Human proof verdicts have no recording surface."],
        instruction:
          "Waive the criterion instead: Spec Studio → Controls → Merge gate → Waive…, which records a human decision with a reason.",
      },
    });
  });

  it.each([
    ["missing", undefined],
    ["nonexistent", "execution-does-not-exist"],
    ["unrelated", UNRELATED_EXECUTION_ID],
  ] as const)(
    "13.4 refuses a machine verdict with a %s producing execution",
    async (_label, executionId) => {
      const service = createEvidenceService(deps);

      const result = await service.recordProofVerdict({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        executionId,
        verdictKind: "agent_validator",
        origin: "execution_ingest",
        actor: { kind: "system" },
        evidenceIds: [],
      });

      expect(result).toEqual({
        ok: false,
        refusal: {
          code: "validation",
          unmetConditions: [
            "Machine proof verdicts require a producing execution pinned to the target spec revision.",
          ],
          instruction:
            "Ingest the validator verdict from the linked execution that pins this revision.",
        },
      });
    },
  );

  it("13.6 routes strategy inadequacy to the human without raising the evidence bar", async () => {
    const service = createEvidenceService(deps);

    const result = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [],
      strategyAssessment: {
        adequate: false,
        reason: "The strategy cannot observe the browser-only interaction.",
      },
    });

    expect(deps.routeStrategyInadequacy).toHaveBeenCalledWith({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      criterionElementId: CRITERION_ID,
      reason: "The strategy cannot observe the browser-only interaction.",
    });
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "validation" },
    });
  });

  it("13.6 refuses a validation strategy change as amendment-required", async () => {
    const service = createEvidenceService(deps);

    const result = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "agent_validator",
      origin: "execution_ingest",
      actor: { kind: "system" },
      evidenceIds: [],
      validationStrategy: { kinds: ["validator_verdict"] },
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          "The proposed validation strategy differs from the approved revision.",
        ],
        instruction:
          "Create and approve a new spec revision before validating against a changed strategy.",
      },
    });
  });
});

describe("EvidenceService claims, waivers, and dispositions", () => {
  let db: Db;
  let deps: EvidenceServiceDeps;
  let ids: number;

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    ids = 0;
    deps = {
      repo: createSpecDeliveryRepo(db),
      ingestExecutionEvidence: vi.fn(async () => undefined),
      nextId: (kind) => `${kind}-${++ids}`,
      now: () => "2026-07-18T12:10:00.000Z",
      getApprovedCriterion: async () => ({
        specId: SPEC_ID,
        validationStrategy: { kinds: ["commit"] },
      }),
      gitObjectExists: vi.fn(async () => true),
      workflowEventExists: vi.fn(async () => true),
      mergeValidationFactExists: vi.fn(async () => true),
      isEvidenceFresh: vi.fn(async () => true),
      routeStrategyInadequacy: vi.fn(async () => undefined),
      routeWaiverRequestToHuman: vi.fn(async () => ({
        attentionId: "attention-waiver",
      })),
      getTaskClaimContext: vi.fn(async () => ({
        specId: SPEC_ID,
        revisionId: REVISION_ID,
        policy: { preset: "contract-bearing" as const },
        draft: TASK_CLAIM_DRAFT,
        coveredCriterionElementIds: [CRITERION_ID],
      })),
      getCriterionVersion: vi.fn(async (revisionId) => ({
        specId: SPEC_ID,
        revisionNumber: revisionId === REVISION_ID ? 1 : 2,
        payloadHash:
          revisionId === REVISION_ID
            ? "criterion-hash-approved"
            : "criterion-hash-changed",
      })),
      wasCriterionDeliveredByMergedExecution: vi.fn(async () => false),
      recordMutation: vi.fn(),
      runInImmediateTransaction: (operation) => operation(),
    };
  });

  async function attachCommit(criterionElementId = CRITERION_ID) {
    const service = createEvidenceService(deps);
    const result = await service.attachEvidence({
      specId: SPEC_ID,
      criterionElementId,
      revisionId: REVISION_ID,
      kind: "commit",
      ref: { type: "git_object", objectId: `commit-${criterionElementId}` },
      evaluatedState: {
        commitSha: `commit-${criterionElementId}`,
        relevantPaths: [],
      },
      producer: { kind: "agent", conversationId: "conversation-evidence" },
      executionId: EXECUTION_ID,
    });
    if (!result.ok) throw new Error("fixture evidence was refused");
    return result.value;
  }

  it("6.7 durably records the actual actor for evidence-surface mutations", async () => {
    const events = createSpecEventsRepo(db);
    const specsRepo = createSpecsRepo(db, createWriteQueue());
    const recorder = createEvidenceMutationRecorder({
      eventsRepo: events,
      events: createSpecEventsPublisher({
        appendInTransaction: events.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      findSpecById: (targetSpecId) =>
        specsRepo.findByIdInTransaction(targetSpecId),
      runInImmediateTransaction: (operation) =>
        db.transaction(operation).immediate(),
    });
    deps.recordMutation = recorder.recordMutation;
    deps.runInImmediateTransaction = recorder.runInImmediateTransaction;
    const service = createEvidenceService(deps);
    const evidence = await attachCommit();

    const verdict = await service.recordProofVerdict({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      executionId: EXECUTION_ID,
      verdictKind: "human",
      origin: "ui_route",
      actor: { kind: "human" },
      evidenceIds: [evidence.id],
    });
    const claim = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });
    if (!verdict.ok || !claim.ok) {
      throw new Error("provenance fixtures were refused");
    }
    await service.reopenTaskClaim(claim.value.id, { kind: "human" }, []);
    await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "Human waiver reason",
    });
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    const actorsByKind = new Map(
      events
        .findBySpecId(SPEC_ID)
        .map((event) => [
          (JSON.parse(event.payload_json) as { kind: string }).kind,
          JSON.parse(event.actor_json) as unknown,
        ]),
    );
    expect(actorsByKind.get("proof-verdict-recorded")).toEqual({
      kind: "human",
    });
    expect(actorsByKind.get("task-claim-reopened")).toEqual({ kind: "human" });
    expect(actorsByKind.get("waiver-granted")).toEqual({ kind: "human" });
    expect(actorsByKind.get("criterion-disposition-saved")).toEqual({
      kind: "agent",
      conversationId: "conversation-evidence",
    });
  });

  it("rolls back evidence mutations when provenance persistence fails", async () => {
    deps.recordMutation = () => {
      throw new Error("event persistence failed");
    };
    deps.runInImmediateTransaction = (operation) =>
      db.transaction(operation).immediate();
    const service = createEvidenceService(deps);

    await expect(
      service.grantWaiver({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        actor: { kind: "human" },
        reason: "Human waiver reason",
      }),
    ).rejects.toThrow("event persistence failed");
    expect(
      deps.repo.findWaiverForCriterionRevision(CRITERION_ID, REVISION_ID),
    ).toBeNull();
  });

  it("6.6 refuses a completion claim with no evidence", async () => {
    const service = createEvidenceService(deps);

    const result = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [],
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "lint_blocked",
        unmetConditions: ["A task completion claim must cite evidence."],
        instruction:
          "Cite ingested evidence ids for the task's covered criteria — the server ingests commit and validation evidence from workflow events — and claim again.",
      },
    });
    expect(deps.ingestExecutionEvidence).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it("6.6 refuses a claim when a cited record no longer resolves", async () => {
    const evidence = await attachCommit();
    deps.gitObjectExists = vi.fn(async () => false);
    const service = createEvidenceService(deps);

    const result = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "unresolvable_evidence",
        instruction:
          "Cite an evidence id the server has already ingested for this execution and claim again.",
      },
    });
  });

  it("6.6 points an uncovered-criterion refusal at ingestion, not attachment", async () => {
    const evidence = await attachCommit();
    deps.getTaskClaimContext = vi.fn(async () => ({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      policy: { preset: "contract-bearing" as const },
      draft: TASK_CLAIM_DRAFT,
      coveredCriterionElementIds: [CRITERION_ID, OTHER_CRITERION_ID],
    }));
    const service = createEvidenceService(deps);

    const result = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "lint_blocked",
        unmetConditions: [
          `Covered criterion ${OTHER_CRITERION_ID} has no cited evidence.`,
        ],
        instruction:
          "Cite ingested evidence for every covered criterion and claim again — a criterion with no evidence usually means its covering work has not been committed or validated yet.",
      },
    });
  });

  it("6.6 refuses evidence for a criterion the task does not cover at the pin", async () => {
    const evidence = await attachCommit(OTHER_CRITERION_ID);
    const service = createEvidenceService(deps);

    const result = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          `Evidence ${evidence.id} targets criterion ${OTHER_CRITERION_ID}, which task ${TASK_ID} does not cover at revision ${REVISION_ID}.`,
        ],
      },
    });
  });

  it("11.4 refuses claims outright under the exploratory preset", async () => {
    const evidence = await attachCommit();
    deps.getTaskClaimContext = vi.fn(async () => ({
      specId: SPEC_ID,
      revisionId: REVISION_ID,
      policy: { preset: "exploratory" as const },
      draft: TASK_CLAIM_DRAFT,
      coveredCriterionElementIds: [CRITERION_ID],
    }));
    const service = createEvidenceService(deps);

    const result = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          "Exploratory specs cannot record task completion claims.",
        ],
      },
    });
  });

  it("6.6 persists an accepted claim and supports reopening it", async () => {
    const evidence = await attachCommit();
    const service = createEvidenceService(deps);
    const accepted = await service.claimTaskComplete({
      specId: SPEC_ID,
      taskElementId: TASK_ID,
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      evidenceIds: [evidence.id],
    });
    if (!accepted.ok) throw new Error("claim was refused");

    expect(accepted.value.status).toBe("accepted");
    const reopened = await service.reopenTaskClaim(
      accepted.value.id,
      {
        kind: "human",
      },
      [],
    );

    expect(reopened).toMatchObject({
      ok: true,
      value: { id: accepted.value.id, status: "reopened" },
    });
    expect(deps.repo.findTaskClaimById(accepted.value.id)?.status).toBe(
      "reopened",
    );
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "task-claim-reopened",
        actor: { kind: "human" },
      }),
    );
  });

  it("14.2 refuses an agent waiver attempt as a required human act", async () => {
    const service = createEvidenceService(deps);

    const result = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      reason: "The test environment is unavailable.",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "human_act_required",
        instruction:
          "Ask a human to grant the waiver with a reason in Spec Studio.",
      },
    });
  });

  it("14.3 lets an agent route a waiver request to human attention without granting it", async () => {
    const service = createEvidenceService(deps);
    const source = {
      kind: "agent" as const,
      conversationId: "conversation-evidence",
    };

    const result = await service.requestWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      source,
      reason: "The external validation environment is unavailable.",
    });

    expect(deps.routeWaiverRequestToHuman).toHaveBeenCalledWith({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      source,
      reason: "The external validation environment is unavailable.",
    });
    expect(result).toEqual({
      ok: true,
      value: { attentionId: "attention-waiver" },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_waivers").get(),
    ).toEqual({ count: 0 });
  });

  it.each(["notify", "off"] as const)(
    "14.3 lets %s policy route a waiver request but not grant it",
    async (dial) => {
      const service = createEvidenceService(deps);
      const source = { kind: "policy" as const, dial };

      const result = await service.requestWaiver({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        source,
        reason: "Delivery needs a human exception decision.",
      });

      expect(deps.routeWaiverRequestToHuman).toHaveBeenCalledWith(
        expect.objectContaining({ source }),
      );
      expect(result).toEqual({
        ok: true,
        value: { attentionId: "attention-waiver" },
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM spec_waivers").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("14.2 refuses a human waiver without a reason", async () => {
    const service = createEvidenceService(deps);

    const result = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "  ",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: ["A waiver requires a reason."],
      },
    });
  });

  it("14.2 records one terminal, reasoned waiver per criterion revision", async () => {
    const service = createEvidenceService(deps);
    const input = {
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" } as const,
      reason: "The external validation environment is unavailable.",
    };

    const granted = await service.grantWaiver(input);
    const duplicate = await service.grantWaiver(input);

    expect(granted).toMatchObject({
      ok: true,
      value: { stale: 0, reason: input.reason },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "waiver-granted",
        actor: { kind: "human" },
      }),
    );
  });

  it("forwards the waiver-granted notice only after a successful grant commits", async () => {
    const waiverGranted = vi.fn();
    deps.waiverNotifier = { waiverGranted };
    const service = createEvidenceService(deps);

    const refused = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      reason: "Agents cannot grant waivers.",
    });
    expect(refused.ok).toBe(false);
    expect(waiverGranted).not.toHaveBeenCalled();

    const granted = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!granted.ok) throw new Error("waiver was refused");
    expect(waiverGranted).toHaveBeenCalledTimes(1);
    expect(waiverGranted).toHaveBeenCalledWith({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      criterionHandle: null,
      revisionId: REVISION_ID,
      waiverId: granted.value.id,
      occurredAt: granted.value.waived_at,
    });
  });

  it("14.5 marks a waiver stale when the criterion changes in a later revision", async () => {
    const service = createEvidenceService(deps);
    const granted = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!granted.ok) throw new Error("waiver was refused");

    const result = await service.markWaiverStaleForCriterionChange({
      waiverId: granted.value.id,
      laterRevisionId: "revision-evidence-2",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({ ok: true, value: { stale: 1 } });
    expect(deps.repo.findWaiverById(granted.value.id)?.stale).toBe(1);
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "waiver-staled",
        actor: {
          kind: "agent",
          conversationId: "conversation-evidence",
        },
      }),
    );
  });

  it("16.8 refuses moving a selected criterion into deferred scope after start", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "deferred",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${CRITERION_ID} is pinned in scope for execution ${EXECUTION_ID}.`,
        ],
      },
    });
    expect(deps.recordMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "criterion-disposition-saved" }),
    );
  });

  it("16.8 refuses expanding a deferred criterion into selected scope after start", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "in_scope",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
  });

  it("14.4 and 16.8 refuse waiving a criterion excluded at execution start", async () => {
    const service = createEvidenceService(deps);
    const waiver = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: OTHER_CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "This waiver must not change an excluded criterion.",
    });
    if (!waiver.ok) throw new Error("waiver was refused");

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "waived",
      waiverId: waiver.value.id,
      actor: { kind: "human" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
  });

  it("14.4 and 16.8 refuse delivered-elsewhere for a criterion excluded at execution start", async () => {
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
    expect(deps.wasCriterionDeliveredByMergedExecution).not.toHaveBeenCalled();
  });

  it("14.1 points a waived disposition at its human waiver", async () => {
    const service = createEvidenceService(deps);
    const waiver = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!waiver.ok) throw new Error("waiver was refused");

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "waived",
      waiverId: waiver.value.id,
      actor: { kind: "human" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "waived",
        waiver_id: waiver.value.id,
        delivered_by_execution_id: null,
      },
    });
  });

  it("14.6 refuses delivered-elsewhere without an earlier merged delivery", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          `Execution ${PRIOR_EXECUTION_ID} is not an earlier successfully merged delivery of criterion ${CRITERION_ID}.`,
        ],
      },
    });
  });

  it("14.6 records delivered-elsewhere after verifying earlier merged delivery", async () => {
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(deps.wasCriterionDeliveredByMergedExecution).toHaveBeenCalledWith({
      executionId: PRIOR_EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      beforeExecutionId: EXECUTION_ID,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "delivered_elsewhere",
        delivered_by_execution_id: PRIOR_EXECUTION_ID,
      },
    });
  });
});
