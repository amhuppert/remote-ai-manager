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
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSpecEventsPublisher } from "./events";
import type {
  AttachEvidenceInput,
  EvidenceMutationRecord,
  ProofVerdictInput,
} from "./evidence-service";
import type {
  ActorProvenance,
  EvidenceEvaluatedState,
  EvidenceKind,
  SpecEvidenceRow,
  SpecProofVerdictRow,
} from "./schemas";
import type { ExecutionScope } from "./scope-validation";
import {
  createDeliveryGate,
  type CandidateValidationSource,
  type DeliveryGateDeps,
} from "./delivery-gate";
import type { CandidateValidationFact } from "@/lib/workflows/merge/types";

type Db = InstanceType<typeof Database>;

const projectPath = "/repos/delivery-gate";
const specId = "spec-delivery-gate";
const revisionId = "revision-delivery-gate";
const executionId = "spec-execution-current";
const workflowExecutionId = "workflow-execution-current";
const priorExecutionId = "spec-execution-prior";
const preparedSha = "candidate-sha";
const now = "2026-07-18T18:00:00.000Z";

const criteria = {
  proven: "criterion-proven",
  waived: "criterion-waived",
  delivered: "criterion-delivered",
  deferred: "criterion-deferred",
  pending: "criterion-pending",
} as const;

describe("DeliveryGateAdapter", () => {
  let db: Db;
  let deps: DeliveryGateDeps;
  let deliveryRepo: ReturnType<typeof createSpecDeliveryRepo>;
  let candidateRelevantTreeHash: string;
  let candidateFullTreeHash: string;
  let candidateSource: CandidateValidationSource | null;
  let recordedInterventions: EvidenceMutationRecord[];
  let sequence: number;
  let queueLabels: string[];
  let policyAdmitted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = _createTestDb();
    seedSpecState(db);
    const writeQueue = createWriteQueue();
    deliveryRepo = createSpecDeliveryRepo(db);
    candidateRelevantTreeHash = "tree-relevant-stable";
    candidateFullTreeHash = "tree-full-candidate";
    candidateSource = null;
    recordedInterventions = [];
    sequence = 0;
    queueLabels = [];
    policyAdmitted = vi.fn();
    const eventsRepo = createSpecEventsRepo(db);

    deps = {
      deliveryRepo,
      reviewRepo: createSpecReviewRepo(db),
      specsRepo: createSpecsRepo(db, writeQueue),
      newAdmissionId: () => `admission-${++sequence}`,
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      writeQueue: {
        withWriteQueue(label, fn) {
          queueLabels.push(label);
          return writeQueue.withWriteQueue(label, fn);
        },
        tryWithWriteQueue: writeQueue.tryWithWriteQueue,
        _resetForTesting: writeQueue._resetForTesting,
      },
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      policyNotifier: { policyAdmitted },
      evidenceService: {
        attachEvidence: vi.fn(async (input) => attachEvidence(input)),
        recordProofVerdict: vi.fn(async (input) => recordProofVerdict(input)),
      },
      ingestExecutionEvidence: vi.fn(async () => undefined),
      gitProbesForProject: () => ({
        async isAncestor(ancestorSha, descendantSha) {
          return (
            ancestorSha === "ancestor-sha" && descendantSha === preparedSha
          );
        },
        async relevantTreeHash(_commitSha, relevantPaths) {
          return relevantPaths.length === 0
            ? candidateFullTreeHash
            : candidateRelevantTreeHash;
        },
      }),
      async resolveCandidateValidation(input) {
        if (
          candidateSource?.validation.validationRef !== input.validationRef ||
          input.workflowExecutionId !== workflowExecutionId
        ) {
          return null;
        }
        return candidateSource;
      },
      recordIntervention(input) {
        recordedInterventions.push(input);
      },
      now: () => now,
    };
  });

  it("18.1-18.5 passes exactly the pinned scope for valid proof, waiver, and earlier delivery while exposing deferred criteria", async () => {
    seedExistingProof();

    const result = await createDeliveryGate(deps).evaluate(gateInput());

    expect(result).toEqual({
      status: "pass",
      satisfied: [
        expect.objectContaining({
          criterionId: criteria.proven,
          criterionHandle: "delivery-gate/R1.1",
          outcome: "proven",
        }),
        expect.objectContaining({
          criterionId: criteria.waived,
          criterionHandle: "delivery-gate/R1.2",
          outcome: "waived",
        }),
        expect.objectContaining({
          criterionId: criteria.delivered,
          criterionHandle: "delivery-gate/R1.3",
          outcome: "delivered_elsewhere",
        }),
      ],
      deferred: ["delivery-gate/R1.4"],
    });
    expect(deps.ingestExecutionEvidence).toHaveBeenCalledWith(executionId);
  });

  it("passes through a workflow execution with no linked spec execution", async () => {
    const result = await createDeliveryGate(deps).evaluate({
      ...gateInput(),
      workflowExecutionId: "workflow-execution-unlinked",
    });

    expect(result).toEqual({ status: "pass", satisfied: [], deferred: [] });
    expect(deps.ingestExecutionEvidence).not.toHaveBeenCalled();
  });

  it("11.2 records a notify-policy delivery admission when the Notify dial admits the merge, exactly once", async () => {
    seedExistingProof();
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"delivery":"notify"}}',
      specId,
    );
    db.prepare("DELETE FROM spec_gate_admissions WHERE execution_id = ?").run(
      executionId,
    );

    const gate = createDeliveryGate(deps);
    const first = await gate.evaluate(gateInput());
    const replay = await gate.evaluate(gateInput());

    expect(first).toMatchObject({ status: "pass" });
    expect(replay).toMatchObject({ status: "pass" });
    const admissions = deps.reviewRepo
      .findGateAdmissionsByRevision(revisionId)
      .filter((admission) => admission.gate === "delivery");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      basis: "notify_policy",
      execution_id: executionId,
      approval_id: null,
    });
  });

  it("11.2/19.1 lands the notify-policy delivery admission through the write queue with its typed gate event and one post-hoc notice", async () => {
    seedExistingProof();
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"contract-bearing","overrides":{"delivery":"notify"}}',
      specId,
    );
    db.prepare("DELETE FROM spec_gate_admissions WHERE execution_id = ?").run(
      executionId,
    );

    const gate = createDeliveryGate(deps);
    await gate.evaluate(gateInput());
    // A replayed evaluation keeps one admission row, one event, one notice.
    await gate.evaluate(gateInput());

    const admissionEvents = (
      db
        .prepare(
          "SELECT payload_json FROM spec_events WHERE spec_id = ? AND event_type = 'spec-approval-changed'",
        )
        .all(specId) as { payload_json: string }[]
    )
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
      .filter((payload) => payload.kind === "delivery-policy-admitted");
    expect(admissionEvents).toHaveLength(1);
    expect(admissionEvents[0]).toMatchObject({
      gate: "delivery",
      basis: "notify_policy",
      executionId,
      revisionId,
    });
    expect(
      queueLabels.filter((label) => label.includes("delivery-admission"))
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(policyAdmitted).toHaveBeenCalledTimes(1);
    expect(policyAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        specId,
        gate: "delivery",
        basis: "notify_policy",
        executionId,
        revisionId,
      }),
    );
  });

  it("11.2 refuses a Gate delivery without the execution's human delivery approval", async () => {
    seedExistingProof();
    db.prepare("DELETE FROM spec_gate_admissions WHERE execution_id = ?").run(
      executionId,
    );

    const result = await createDeliveryGate(deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: expect.arrayContaining([
        expect.objectContaining({ outcome: "gate_blocked" }),
      ]),
      instruction: expect.stringMatching(/human.*approve/i),
    });
  });

  it("11.4 refuses exploratory delivery even when every selected criterion is otherwise satisfied", async () => {
    seedExistingProof();
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"exploratory"}',
      specId,
    );

    const result = await createDeliveryGate(deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: expect.arrayContaining([
        expect.objectContaining({ outcome: "delivery_gate_failed" }),
      ]),
      instruction: expect.stringMatching(/shipping-capable/i),
    });
  });

  it("3.10 refuses an abandoned linked execution even when waiver and prior delivery satisfy its selected criteria", async () => {
    const scope = executionScope();
    scope.selectedCriterionIds = [criteria.waived, criteria.delivered];
    db.prepare(
      "UPDATE spec_executions SET state = 'abandoned', abandoned_reason = ?, scope_json = ? WHERE id = ?",
    ).run("Terminal execution.", JSON.stringify(scope), executionId);

    const result = await createDeliveryGate(deps).evaluate(gateInput());

    expect(result).toMatchObject({
      status: "refused",
      unmet: expect.arrayContaining([
        expect.objectContaining({ outcome: "gate_blocked" }),
      ]),
      instruction: expect.stringMatching(/terminal/i),
    });
  });

  it.each([
    {
      label: "missing proof",
      arrange() {
        selectPendingCriterion();
      },
      criterionId: criteria.pending,
    },
    {
      label: "stale waiver",
      arrange() {
        seedExistingProof();
        db.prepare("UPDATE spec_waivers SET stale = 1 WHERE id = ?").run(
          "waiver-current",
        );
      },
      criterionId: criteria.waived,
    },
    {
      label: "unmerged delivered-elsewhere execution",
      arrange() {
        seedExistingProof();
        db.prepare(
          "UPDATE spec_executions SET state = 'running', delivered_at = NULL WHERE id = ?",
        ).run(priorExecutionId);
      },
      criterionId: criteria.delivered,
    },
  ])(
    "18.3-18.4 refuses $label with criterion detail and re-dispatch guidance",
    async ({ arrange, criterionId }) => {
      arrange();

      const result = await createDeliveryGate(deps).evaluate(gateInput());

      expect(result).toMatchObject({
        status: "refused",
        unmet: expect.arrayContaining([
          expect.objectContaining({ criterionId }),
        ]),
        instruction: expect.stringMatching(/re-dispatch/i),
      });
    },
  );

  it("13.9 keeps an existing verdict valid across a pure rebase with an identical relevant tree", async () => {
    seedExistingProof("evidence-sha");

    const result = await createDeliveryGate(deps).evaluate(gateInput());

    expect(result).toMatchObject({ status: "pass" });
    expect(deps.evidenceService.attachEvidence).not.toHaveBeenCalled();
    expect(deps.evidenceService.recordProofVerdict).not.toHaveBeenCalled();
  });

  it("13.11 accepts commit proof only while the evidence commit remains in candidate history", async () => {
    setCriterionStrategy(criteria.proven, ["commit"]);
    seedExistingProof("ancestor-sha", "commit");
    const gate = createDeliveryGate(deps);

    const valid = await gate.evaluate(gateInput());
    db.prepare(
      "UPDATE spec_evidence SET evaluated_state_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({
        commitSha: "unrelated-sha",
        relevantPaths: ["src/feature.ts"],
        relevantTreeHash: "tree-relevant-stable",
      }),
      "evidence-existing-proof",
    );
    const stale = await gate.evaluate(gateInput());

    expect(valid).toMatchObject({ status: "pass" });
    expect(stale).toMatchObject({
      status: "refused",
      unmet: expect.arrayContaining([
        expect.objectContaining({ criterionId: criteria.proven }),
      ]),
    });
  });

  it("13.10 issues candidate evidence and a deterministic verdict once per validationRef", async () => {
    seedExistingProof();
    candidateRelevantTreeHash = "tree-relevant-changed";
    const validation = candidateFact();
    candidateSource = {
      mergeJobId: "merge-job-candidate",
      validation,
      producer: {
        kind: "agent",
        conversationId: "conversation-candidate-validation",
      },
    };
    const input = { ...gateInput(), candidateValidation: validation };
    const gate = createDeliveryGate(deps);

    const first = await gate.evaluate(input);
    const replay = await gate.evaluate(input);

    expect(first).toMatchObject({ status: "pass" });
    expect(replay).toEqual(first);
    expect(deps.evidenceService.attachEvidence).toHaveBeenCalledTimes(1);
    expect(deps.evidenceService.recordProofVerdict).toHaveBeenCalledTimes(1);
    expect(
      deliveryRepo.findEvidenceByMergeValidationRef(
        executionId,
        criteria.proven,
        validation.validationRef,
      ),
    ).toHaveLength(1);
    expect(
      deliveryRepo.findProofVerdictsByCriterionRevision(
        criteria.proven,
        revisionId,
      ),
    ).toHaveLength(2);
  });

  it("13.10 cites the current validation fact when older fresh evidence has no verdict", async () => {
    setCriterionStrategy(criteria.proven, ["test_run", "validator_verdict"]);
    for (const kind of ["test_run", "validator_verdict"] as const) {
      deliveryRepo.insertEvidence(
        evidenceRow({
          id: `evidence-fresh-without-verdict-${kind}`,
          criterionId: criteria.proven,
          kind,
          evaluatedState: {
            commitSha: preparedSha,
            relevantPaths: [],
            relevantTreeHash: candidateFullTreeHash,
          },
        }),
      );
    }
    const validation = candidateFact();
    candidateSource = {
      mergeJobId: "merge-job-current-fact",
      validation,
      producer: {
        kind: "agent",
        conversationId: "conversation-current-validation",
      },
    };

    const result = await createDeliveryGate(deps).evaluate({
      ...gateInput(),
      candidateValidation: validation,
    });

    expect(result).toMatchObject({ status: "pass" });
    const [verdict] = deliveryRepo.findProofVerdictsByCriterionRevision(
      criteria.proven,
      revisionId,
    );
    expect(verdict).toBeDefined();
    const evidenceIds = JSON.parse(verdict!.evidence_ids_json) as string[];
    expect(evidenceIds).not.toContain(
      "evidence-fresh-without-verdict-test_run",
    );
    expect(evidenceIds).not.toContain(
      "evidence-fresh-without-verdict-validator_verdict",
    );
    expect(
      evidenceIds.flatMap((evidenceId) => {
        const evidence = deliveryRepo.findEvidenceById(evidenceId);
        if (evidence === null) return [];
        const ref = JSON.parse(evidence.ref_json) as {
          type?: string;
          validationRef?: string;
        };
        return ref.type === "merge_validation" &&
          ref.validationRef === validation.validationRef
          ? [evidence.kind]
          : [];
      }),
    ).toEqual(["test_run", "validator_verdict"]);
    expect(
      evidenceIds.every((evidenceId) => {
        const evidence = deliveryRepo.findEvidenceById(evidenceId);
        if (evidence === null) return false;
        const ref = JSON.parse(evidence.ref_json) as {
          type?: string;
          validationRef?: string;
        };
        return (
          ref.type === "merge_validation" &&
          ref.validationRef === validation.validationRef
        );
      }),
    ).toBe(true);
  });

  it("13.10 refuses a validation fact for an older candidate tree without issuing gate-side proof", async () => {
    seedExistingProof();
    candidateRelevantTreeHash = "tree-relevant-changed";
    const validation = {
      ...candidateFact(),
      validatedSha: "older-candidate",
      validatedTreeHash: "tree-full-older-candidate",
    };
    candidateSource = {
      mergeJobId: "merge-job-older",
      validation,
      producer: {
        kind: "agent",
        conversationId: "conversation-old-validation",
      },
    };

    const result = await createDeliveryGate(deps).evaluate({
      ...gateInput(),
      candidateValidation: validation,
    });

    expect(result).toMatchObject({
      status: "refused",
      unmet: [expect.objectContaining({ criterionId: criteria.proven })],
      instruction: expect.stringMatching(/re-dispatch/i),
    });
    expect(deps.evidenceService.attachEvidence).not.toHaveBeenCalled();
    expect(deps.evidenceService.recordProofVerdict).not.toHaveBeenCalled();
  });

  function attachEvidence(input: AttachEvidenceInput) {
    const evidence: SpecEvidenceRow = {
      id: `gate-evidence-${++sequence}`,
      spec_id: input.specId,
      criterion_element_id: input.criterionElementId,
      revision_id: input.revisionId,
      kind: input.kind,
      ref_json: JSON.stringify(input.ref),
      evaluated_state_json: JSON.stringify(input.evaluatedState),
      producer_json: JSON.stringify(input.producer),
      execution_id: input.executionId,
      source_event_id: null,
      created_at: now,
    };
    deliveryRepo.insertEvidence(evidence);
    return { ok: true as const, value: evidence };
  }

  function recordProofVerdict(input: ProofVerdictInput) {
    const verdict: SpecProofVerdictRow = {
      id: `gate-verdict-${++sequence}`,
      spec_id: input.specId,
      criterion_element_id: input.criterionElementId,
      revision_id: input.revisionId,
      execution_id: input.executionId ?? null,
      verdict_kind: input.verdictKind,
      evidence_ids_json: JSON.stringify(input.evidenceIds),
      verdict_at: now,
      stale_at: null,
      stale_reason: null,
    };
    deliveryRepo.saveProofVerdict(verdict);
    return { ok: true as const, value: verdict };
  }

  function seedExistingProof(
    commitSha = "evidence-sha",
    kind: EvidenceKind = "validator_verdict",
  ) {
    const evidence = evidenceRow({
      id: "evidence-existing-proof",
      criterionId: criteria.proven,
      kind,
      evaluatedState: {
        commitSha,
        relevantPaths: ["src/feature.ts"],
        relevantTreeHash: "tree-relevant-stable",
      },
    });
    deliveryRepo.insertEvidence(evidence);
    deliveryRepo.saveProofVerdict({
      id: "verdict-existing-proof",
      spec_id: specId,
      criterion_element_id: criteria.proven,
      revision_id: revisionId,
      execution_id: executionId,
      verdict_kind: "agent_validator",
      evidence_ids_json: JSON.stringify([evidence.id]),
      verdict_at: "2026-07-18T17:00:00.000Z",
      stale_at: null,
      stale_reason: null,
    });
  }

  function setCriterionStrategy(
    criterionId: string,
    kinds: EvidenceKind[],
  ): void {
    db.prepare(
      "UPDATE spec_element_versions SET payload_json = ? WHERE revision_id = ? AND element_id = ?",
    ).run(
      JSON.stringify({
        kind: "criterion",
        text: "Criterion proof strategy",
        validationStrategy: { kinds },
      }),
      revisionId,
      criterionId,
    );
  }

  function selectPendingCriterion() {
    const scope = executionScope();
    scope.selectedCriterionIds.push(criteria.pending);
    db.prepare("UPDATE spec_executions SET scope_json = ? WHERE id = ?").run(
      JSON.stringify(scope),
      executionId,
    );
    deliveryRepo.saveCriterionDisposition({
      execution_id: executionId,
      criterion_element_id: criteria.pending,
      disposition: "in_scope",
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: now,
      updated_at: now,
    });
  }

  function gateInput() {
    return {
      workflowExecutionId,
      preparedSha,
      expectedTargetSha: "target-sha",
      projectPath,
    };
  }

  function candidateFact(): CandidateValidationFact {
    return {
      validationRef: "validation-candidate",
      validatedSha: preparedSha,
      validatedTreeHash: candidateFullTreeHash,
      commandIdentity: "bun run test:unit",
      outcome: "pass",
    };
  }
});

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
    "delivery-gate",
    "Delivery Gate",
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
    statement: "Delivery is scoped and proof-gated.",
    priority: "must",
    risk: "high",
  });
  Object.values(criteria).forEach((criterionId, index) => {
    insertElement(
      db,
      criterionId,
      "criterion",
      index + 1,
      "requirement-1",
      index + 1,
      {
        kind: "criterion",
        text: `Criterion ${index + 1}`,
        validationStrategy: { kinds: ["validator_verdict"] },
      },
    );
  });

  insertExecution(
    db,
    priorExecutionId,
    "workflow-execution-prior",
    "delivered",
    {
      selectedTaskIds: [],
      selectedCriterionIds: [criteria.delivered],
      exclusionDispositions: [],
    },
    "2026-07-18T14:00:00.000Z",
  );
  insertExecution(
    db,
    executionId,
    workflowExecutionId,
    "running",
    executionScope(),
    "2026-07-18T15:00:00.000Z",
  );

  const repo = createSpecDeliveryRepo(db);
  repo.saveWaiver({
    id: "waiver-current",
    spec_id: specId,
    criterion_element_id: criteria.waived,
    revision_id: revisionId,
    reason: "Approved human waiver.",
    waived_at: now,
    stale: 0,
  });
  const reviewRepo = createSpecReviewRepo(db);
  reviewRepo.saveApproval({
    id: "approval-delivery-current",
    spec_id: specId,
    subject_kind: "revision",
    element_id: null,
    revision_id: revisionId,
    approver: "human-operator",
    granted_at: now,
    validity: "valid",
  });
  reviewRepo.insertGateAdmission({
    id: "admission-delivery-current",
    spec_id: specId,
    gate: "delivery",
    basis: "human_approval",
    approval_id: "approval-delivery-current",
    revision_id: revisionId,
    execution_id: executionId,
    actor_json: JSON.stringify({ kind: "human" }),
    created_at: now,
  });
  for (const [criterionId, disposition, waiverId, deliveredBy] of [
    [criteria.proven, "in_scope", null, null],
    [criteria.waived, "waived", "waiver-current", null],
    [criteria.delivered, "delivered_elsewhere", null, priorExecutionId],
    [criteria.deferred, "deferred", null, null],
  ] as const) {
    repo.saveCriterionDisposition({
      execution_id: executionId,
      criterion_element_id: criterionId,
      disposition,
      waiver_id: waiverId,
      delivered_by_execution_id: deliveredBy,
      created_at: now,
      updated_at: now,
    });
  }
  repo.saveCriterionDisposition({
    execution_id: priorExecutionId,
    criterion_element_id: criteria.delivered,
    disposition: "in_scope",
    waiver_id: null,
    delivered_by_execution_id: priorExecutionId,
    created_at: now,
    updated_at: now,
  });
}

function executionScope(): ExecutionScope {
  return {
    selectedTaskIds: [],
    selectedCriterionIds: [
      criteria.proven,
      criteria.waived,
      criteria.delivered,
    ],
    exclusionDispositions: [
      { criterionId: criteria.deferred, disposition: "deferred" as const },
      { criterionId: criteria.pending, disposition: "deferred" as const },
    ],
  };
}

function insertExecution(
  db: Db,
  id: string,
  linkedWorkflowExecutionId: string,
  state: "running" | "delivered",
  scope: ReturnType<typeof executionScope>,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    specId,
    revisionId,
    JSON.stringify(scope),
    state,
    `workflow-definition-${id}`,
    linkedWorkflowExecutionId,
    `session-${id}`,
    state === "delivered" ? createdAt : null,
    createdAt,
    createdAt,
  );
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

function evidenceRow(input: {
  id: string;
  criterionId: string;
  kind: EvidenceKind;
  evaluatedState: EvidenceEvaluatedState;
  producer?: ActorProvenance;
}): SpecEvidenceRow {
  return {
    id: input.id,
    spec_id: specId,
    criterion_element_id: input.criterionId,
    revision_id: revisionId,
    kind: input.kind,
    ref_json: JSON.stringify({ type: "git_object", objectId: "evidence-sha" }),
    evaluated_state_json: JSON.stringify(input.evaluatedState),
    producer_json: JSON.stringify(
      input.producer ?? {
        kind: "agent",
        conversationId: "conversation-existing-proof",
      },
    ),
    execution_id: executionId,
    source_event_id: null,
    created_at: "2026-07-18T16:00:00.000Z",
  };
}
