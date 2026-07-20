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
import { createSpecRepoHelpers } from "./spec-repo-helpers";

type Db = InstanceType<typeof Database>;

const { parseRow, readMany, readOne, timed } = createSpecRepoHelpers(
  "state-store.spec-delivery",
);

export interface SpecDeliveryRepo {
  insertEvidence(evidence: SpecEvidenceRow): SpecEvidenceRow;
  findEvidenceById(id: string): SpecEvidenceRow | null;
  findEvidenceBySourceEventId(sourceEventId: number): SpecEvidenceRow[];
  findEvidenceByIngestKey(
    sourceEventId: number,
    criterionElementId: string,
    kind: SpecEvidenceRow["kind"],
  ): SpecEvidenceRow | null;
  findEvidenceByCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecEvidenceRow[];
  findEvidenceByMergeValidationRef(
    executionId: string,
    criterionElementId: string,
    validationRef: string,
  ): SpecEvidenceRow[];
  saveProofVerdict(verdict: SpecProofVerdictRow): void;
  findProofVerdictById(id: string): SpecProofVerdictRow | null;
  findProofVerdictsByRevision(revisionId: string): SpecProofVerdictRow[];
  findProofVerdictsByCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecProofVerdictRow[];
  saveWaiver(waiver: SpecWaiverRow): void;
  findWaiverById(id: string): SpecWaiverRow | null;
  findWaiversByRevision(revisionId: string): SpecWaiverRow[];
  /** Every waiver for the spec across revisions (R14.5 staleness sweeps). */
  findWaiversBySpecId(specId: string): SpecWaiverRow[];
  findWaiverForCriterionRevision(
    criterionElementId: string,
    revisionId: string,
  ): SpecWaiverRow | null;
  saveCriterionDisposition(disposition: SpecCriterionDispositionRow): void;
  findCriterionDisposition(
    executionId: string,
    criterionElementId: string,
  ): SpecCriterionDispositionRow | null;
  findCriterionDispositionsByExecution(
    executionId: string,
  ): SpecCriterionDispositionRow[];
  saveTaskClaim(claim: SpecTaskClaimRow): void;
  findTaskClaimById(id: string): SpecTaskClaimRow | null;
  findTaskClaimsBySpecId(specId: string): SpecTaskClaimRow[];
  insertExecution(execution: SpecExecutionRow): void;
  findExecutionById(id: string): SpecExecutionRow | null;
  findExecutionsBySpecId(specId: string): SpecExecutionRow[];
  findActiveExecutionBySpecId(specId: string): SpecExecutionRow | null;
  /** Every execution in definition_review or running, across all specs. */
  listActiveExecutions(): SpecExecutionRow[];
  /**
   * Non-terminal executions hosted by one session, scoped to the project that
   * owns the spec (session names are only unique per project). This is the
   * merge-association lookup: a user merge of the session must carry these
   * executions' provenance through the delivery gate.
   */
  findActiveExecutionsBySessionName(
    projectPath: string,
    sessionName: string,
  ): SpecExecutionRow[];
  findExecutionByWorkflowExecutionId(
    workflowExecutionId: string,
  ): SpecExecutionRow | null;
  /**
   * The spec execution still awaiting its workflow: in definition_review with
   * this compiled definition pinned and no workflow execution linked yet. This
   * is how a generic workflow start finds the spec side without the workflow
   * machinery knowing about specs.
   */
  findExecutionAwaitingWorkflowByDefinitionId(
    workflowDefinitionId: string,
  ): SpecExecutionRow | null;
  linkWorkflowExecution(
    executionId: string,
    workflowExecutionId: string,
    updatedAt: string,
  ): SpecExecutionRow;
  updateExecutionLifecycle(input: {
    executionId: string;
    state: SpecExecutionRow["state"];
    deliveredAt: string | null;
    abandonedReason: string | null;
    updatedAt: string;
  }): SpecExecutionRow;
}

export function createSpecDeliveryRepo(db: Db): SpecDeliveryRepo {
  const insertEvidenceStmt = db.prepare(
    `INSERT INTO spec_evidence (
       id, spec_id, criterion_element_id, revision_id, kind, ref_json,
       evaluated_state_json, producer_json, execution_id, source_event_id,
       created_at
     ) VALUES (
       @id, @spec_id, @criterion_element_id, @revision_id, @kind, @ref_json,
       @evaluated_state_json, @producer_json, @execution_id, @source_event_id,
       @created_at
     )`,
  );
  const findEvidenceStmt = db.prepare(
    "SELECT * FROM spec_evidence WHERE id = ? LIMIT 1",
  );
  const findEvidenceBySourceEventStmt = db.prepare(
    `SELECT * FROM spec_evidence
     WHERE source_event_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findEvidenceByIngestKeyStmt = db.prepare(
    `SELECT * FROM spec_evidence
     WHERE source_event_id = ?
       AND criterion_element_id = ?
       AND kind = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
  );
  const findEvidenceByCriterionRevisionStmt = db.prepare(
    `SELECT * FROM spec_evidence
     WHERE criterion_element_id = ? AND revision_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findEvidenceByMergeValidationRefStmt = db.prepare(
    `SELECT * FROM spec_evidence
     WHERE execution_id = ?
       AND criterion_element_id = ?
       AND json_extract(ref_json, '$.type') = 'merge_validation'
       AND json_extract(ref_json, '$.validationRef') = ?
     ORDER BY created_at ASC, id ASC`,
  );

  const saveProofVerdictStmt = db.prepare(
    `INSERT INTO spec_proof_verdicts (
       id, spec_id, criterion_element_id, revision_id, execution_id,
       verdict_kind, evidence_ids_json, verdict_at, stale_at, stale_reason
     ) VALUES (
       @id, @spec_id, @criterion_element_id, @revision_id, @execution_id,
       @verdict_kind, @evidence_ids_json, @verdict_at, @stale_at, @stale_reason
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       criterion_element_id = excluded.criterion_element_id,
       revision_id = excluded.revision_id,
       execution_id = excluded.execution_id,
       verdict_kind = excluded.verdict_kind,
       evidence_ids_json = excluded.evidence_ids_json,
       verdict_at = excluded.verdict_at,
       stale_at = excluded.stale_at,
       stale_reason = excluded.stale_reason`,
  );
  const findProofVerdictStmt = db.prepare(
    "SELECT * FROM spec_proof_verdicts WHERE id = ? LIMIT 1",
  );
  const findProofVerdictsByRevisionStmt = db.prepare(
    `SELECT * FROM spec_proof_verdicts
     WHERE revision_id = ?
     ORDER BY verdict_at ASC, id ASC`,
  );
  const findProofVerdictsByCriterionRevisionStmt = db.prepare(
    `SELECT * FROM spec_proof_verdicts
     WHERE criterion_element_id = ? AND revision_id = ?
     ORDER BY verdict_at DESC, id DESC`,
  );

  const saveWaiverStmt = db.prepare(
    `INSERT INTO spec_waivers (
       id, spec_id, criterion_element_id, revision_id, reason, waived_at, stale
     ) VALUES (
       @id, @spec_id, @criterion_element_id, @revision_id, @reason, @waived_at,
       @stale
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       criterion_element_id = excluded.criterion_element_id,
       revision_id = excluded.revision_id,
       reason = excluded.reason,
       waived_at = excluded.waived_at,
       stale = excluded.stale`,
  );
  const findWaiverStmt = db.prepare(
    "SELECT * FROM spec_waivers WHERE id = ? LIMIT 1",
  );
  const findWaiversByRevisionStmt = db.prepare(
    `SELECT * FROM spec_waivers
     WHERE revision_id = ?
     ORDER BY waived_at ASC, id ASC`,
  );
  const findWaiverForCriterionRevisionStmt = db.prepare(
    `SELECT * FROM spec_waivers
     WHERE criterion_element_id = ? AND revision_id = ?
     LIMIT 1`,
  );
  const findWaiversBySpecStmt = db.prepare(
    `SELECT * FROM spec_waivers
     WHERE spec_id = ?
     ORDER BY waived_at ASC, id ASC`,
  );

  const saveDispositionStmt = db.prepare(
    `INSERT INTO spec_criterion_dispositions (
       execution_id, criterion_element_id, disposition, waiver_id,
       delivered_by_execution_id, created_at, updated_at
     ) VALUES (
       @execution_id, @criterion_element_id, @disposition, @waiver_id,
       @delivered_by_execution_id, @created_at, @updated_at
     )
     ON CONFLICT(execution_id, criterion_element_id) DO UPDATE SET
       disposition = excluded.disposition,
       waiver_id = excluded.waiver_id,
       delivered_by_execution_id = excluded.delivered_by_execution_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  );
  const findDispositionStmt = db.prepare(
    `SELECT * FROM spec_criterion_dispositions
     WHERE execution_id = ? AND criterion_element_id = ?
     LIMIT 1`,
  );
  const findDispositionsByExecutionStmt = db.prepare(
    `SELECT * FROM spec_criterion_dispositions
     WHERE execution_id = ?
     ORDER BY criterion_element_id ASC`,
  );

  const saveTaskClaimStmt = db.prepare(
    `INSERT INTO spec_task_claims (
       id, spec_id, task_element_id, execution_id, actor_json,
       evidence_ids_json, claimed_at, status
     ) VALUES (
       @id, @spec_id, @task_element_id, @execution_id, @actor_json,
       @evidence_ids_json, @claimed_at, @status
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       task_element_id = excluded.task_element_id,
       execution_id = excluded.execution_id,
       actor_json = excluded.actor_json,
       evidence_ids_json = excluded.evidence_ids_json,
       claimed_at = excluded.claimed_at,
       status = excluded.status`,
  );
  const findTaskClaimStmt = db.prepare(
    "SELECT * FROM spec_task_claims WHERE id = ? LIMIT 1",
  );
  const findTaskClaimsBySpecStmt = db.prepare(
    `SELECT * FROM spec_task_claims
     WHERE spec_id = ?
     ORDER BY claimed_at ASC, id ASC`,
  );

  const insertExecutionStmt = db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (
       @id, @spec_id, @revision_id, @scope_json, @state,
       @workflow_definition_id, @workflow_execution_id, @session_name,
       @delivered_at, @abandoned_reason, @created_at, @updated_at
     )`,
  );
  const findExecutionStmt = db.prepare(
    "SELECT * FROM spec_executions WHERE id = ? LIMIT 1",
  );
  const findExecutionsBySpecStmt = db.prepare(
    `SELECT * FROM spec_executions
     WHERE spec_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findActiveExecutionBySpecStmt = db.prepare(
    `SELECT * FROM spec_executions
     WHERE spec_id = ? AND state IN ('definition_review', 'running')
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
  );
  const listActiveExecutionsStmt = db.prepare(
    `SELECT * FROM spec_executions
     WHERE state IN ('definition_review', 'running')
     ORDER BY created_at ASC, id ASC`,
  );
  const findActiveExecutionsBySessionStmt = db.prepare(
    `SELECT e.* FROM spec_executions e
     JOIN specs s ON s.id = e.spec_id
     WHERE s.project_path = ?
       AND e.session_name = ?
       AND e.state IN ('definition_review', 'running')
     ORDER BY e.created_at ASC, e.id ASC`,
  );
  const findExecutionByWorkflowExecutionStmt = db.prepare(
    `SELECT * FROM spec_executions
     WHERE workflow_execution_id = ?
     LIMIT 1`,
  );
  const findExecutionAwaitingWorkflowByDefinitionStmt = db.prepare(
    `SELECT * FROM spec_executions
     WHERE workflow_definition_id = ?
       AND workflow_execution_id IS NULL
       AND state = 'definition_review'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );
  const linkWorkflowExecutionStmt = db.prepare(
    `UPDATE spec_executions
     SET workflow_execution_id = ?, updated_at = ?
     WHERE id = ?
       AND (workflow_execution_id IS NULL OR workflow_execution_id = ?)`,
  );
  const updateExecutionLifecycleStmt = db.prepare(
    `UPDATE spec_executions
     SET state = @state,
         delivered_at = @delivered_at,
         abandoned_reason = @abandoned_reason,
         updated_at = @updated_at
     WHERE id = @execution_id`,
  );

  return {
    insertEvidence(evidence) {
      return timed("insert", "spec_evidence", evidence.id, () => {
        const validated = parseRow(
          specEvidenceRowSchema,
          "spec_evidence",
          evidence.id,
          evidence,
        );
        const existingById = findEvidenceStmt.get(validated.id);
        if (existingById !== undefined) {
          insertEvidenceStmt.run(validated);
        }
        if (validated.source_event_id !== null) {
          const existing = readOne(
            specEvidenceRowSchema,
            "spec_evidence",
            `ingest:${validated.source_event_id}:${validated.criterion_element_id}:${validated.kind}`,
            () =>
              findEvidenceByIngestKeyStmt.get(
                validated.source_event_id,
                validated.criterion_element_id,
                validated.kind,
              ),
          );
          if (existing !== null) return existing;
        }
        insertEvidenceStmt.run(validated);
        return validated;
      });
    },
    findEvidenceById(id) {
      return timed("find_by_id", "spec_evidence", id, () =>
        readOne(specEvidenceRowSchema, "spec_evidence", id, () =>
          findEvidenceStmt.get(id),
        ),
      );
    },
    findEvidenceBySourceEventId(sourceEventId) {
      return timed(
        "find_by_source_event_id",
        "spec_evidence",
        String(sourceEventId),
        () =>
          readMany(
            specEvidenceRowSchema,
            "spec_evidence",
            `source_event_id:${sourceEventId}`,
            () => findEvidenceBySourceEventStmt.all(sourceEventId),
          ),
      );
    },
    findEvidenceByIngestKey(sourceEventId, criterionElementId, kind) {
      const identifier = `ingest:${sourceEventId}:${criterionElementId}:${kind}`;
      return timed("find_by_ingest_key", "spec_evidence", identifier, () =>
        readOne(specEvidenceRowSchema, "spec_evidence", identifier, () =>
          findEvidenceByIngestKeyStmt.get(
            sourceEventId,
            criterionElementId,
            kind,
          ),
        ),
      );
    },
    findEvidenceByCriterionRevision(criterionElementId, revisionId) {
      const identifier = `${criterionElementId}:${revisionId}`;
      return timed(
        "find_by_criterion_revision",
        "spec_evidence",
        identifier,
        () =>
          readMany(specEvidenceRowSchema, "spec_evidence", identifier, () =>
            findEvidenceByCriterionRevisionStmt.all(
              criterionElementId,
              revisionId,
            ),
          ),
      );
    },
    findEvidenceByMergeValidationRef(
      executionId,
      criterionElementId,
      validationRef,
    ) {
      const identifier = `${executionId}:${criterionElementId}:${validationRef}`;
      return timed(
        "find_by_merge_validation_ref",
        "spec_evidence",
        identifier,
        () =>
          readMany(specEvidenceRowSchema, "spec_evidence", identifier, () =>
            findEvidenceByMergeValidationRefStmt.all(
              executionId,
              criterionElementId,
              validationRef,
            ),
          ),
      );
    },
    saveProofVerdict(verdict) {
      timed("save", "spec_proof_verdict", verdict.id, () => {
        saveProofVerdictStmt.run(
          parseRow(
            specProofVerdictRowSchema,
            "spec_proof_verdict",
            verdict.id,
            verdict,
          ),
        );
      });
    },
    findProofVerdictById(id) {
      return timed("find_by_id", "spec_proof_verdict", id, () =>
        readOne(specProofVerdictRowSchema, "spec_proof_verdict", id, () =>
          findProofVerdictStmt.get(id),
        ),
      );
    },
    findProofVerdictsByRevision(revisionId) {
      return timed("find_by_revision", "spec_proof_verdict", revisionId, () =>
        readMany(
          specProofVerdictRowSchema,
          "spec_proof_verdict",
          `revision:${revisionId}`,
          () => findProofVerdictsByRevisionStmt.all(revisionId),
        ),
      );
    },
    findProofVerdictsByCriterionRevision(criterionElementId, revisionId) {
      const identifier = `${criterionElementId}:${revisionId}`;
      return timed(
        "find_by_criterion_revision",
        "spec_proof_verdict",
        identifier,
        () =>
          readMany(
            specProofVerdictRowSchema,
            "spec_proof_verdict",
            identifier,
            () =>
              findProofVerdictsByCriterionRevisionStmt.all(
                criterionElementId,
                revisionId,
              ),
          ),
      );
    },
    saveWaiver(waiver) {
      timed("save", "spec_waiver", waiver.id, () => {
        saveWaiverStmt.run(
          parseRow(specWaiverRowSchema, "spec_waiver", waiver.id, waiver),
        );
      });
    },
    findWaiverById(id) {
      return timed("find_by_id", "spec_waiver", id, () =>
        readOne(specWaiverRowSchema, "spec_waiver", id, () =>
          findWaiverStmt.get(id),
        ),
      );
    },
    findWaiversByRevision(revisionId) {
      return timed("find_by_revision", "spec_waiver", revisionId, () =>
        readMany(
          specWaiverRowSchema,
          "spec_waiver",
          `revision:${revisionId}`,
          () => findWaiversByRevisionStmt.all(revisionId),
        ),
      );
    },
    findWaiversBySpecId(specId) {
      return timed("find_by_spec", "spec_waiver", specId, () =>
        readMany(specWaiverRowSchema, "spec_waiver", `spec:${specId}`, () =>
          findWaiversBySpecStmt.all(specId),
        ),
      );
    },
    findWaiverForCriterionRevision(criterionElementId, revisionId) {
      const identifier = `${criterionElementId}:${revisionId}`;
      return timed(
        "find_by_criterion_revision",
        "spec_waiver",
        identifier,
        () =>
          readOne(specWaiverRowSchema, "spec_waiver", identifier, () =>
            findWaiverForCriterionRevisionStmt.get(
              criterionElementId,
              revisionId,
            ),
          ),
      );
    },
    saveCriterionDisposition(disposition) {
      const identifier = `${disposition.execution_id}:${disposition.criterion_element_id}`;
      timed("save", "spec_criterion_disposition", identifier, () => {
        saveDispositionStmt.run(
          parseRow(
            specCriterionDispositionRowSchema,
            "spec_criterion_disposition",
            identifier,
            disposition,
          ),
        );
      });
    },
    findCriterionDisposition(executionId, criterionElementId) {
      const identifier = `${executionId}:${criterionElementId}`;
      return timed("find", "spec_criterion_disposition", identifier, () =>
        readOne(
          specCriterionDispositionRowSchema,
          "spec_criterion_disposition",
          identifier,
          () => findDispositionStmt.get(executionId, criterionElementId),
        ),
      );
    },
    findCriterionDispositionsByExecution(executionId) {
      return timed(
        "find_by_execution",
        "spec_criterion_disposition",
        executionId,
        () =>
          readMany(
            specCriterionDispositionRowSchema,
            "spec_criterion_disposition",
            executionId,
            () => findDispositionsByExecutionStmt.all(executionId),
          ),
      );
    },
    saveTaskClaim(claim) {
      timed("save", "spec_task_claim", claim.id, () => {
        saveTaskClaimStmt.run(
          parseRow(specTaskClaimRowSchema, "spec_task_claim", claim.id, claim),
        );
      });
    },
    findTaskClaimById(id) {
      return timed("find_by_id", "spec_task_claim", id, () =>
        readOne(specTaskClaimRowSchema, "spec_task_claim", id, () =>
          findTaskClaimStmt.get(id),
        ),
      );
    },
    findTaskClaimsBySpecId(specId) {
      return timed("find_by_spec", "spec_task_claim", specId, () =>
        readMany(
          specTaskClaimRowSchema,
          "spec_task_claim",
          `spec:${specId}`,
          () => findTaskClaimsBySpecStmt.all(specId),
        ),
      );
    },
    insertExecution(execution) {
      timed("insert", "spec_execution", execution.id, () => {
        insertExecutionStmt.run(
          parseRow(
            specExecutionRowSchema,
            "spec_execution",
            execution.id,
            execution,
          ),
        );
      });
    },
    findExecutionById(id) {
      return timed("find_by_id", "spec_execution", id, () =>
        readOne(specExecutionRowSchema, "spec_execution", id, () =>
          findExecutionStmt.get(id),
        ),
      );
    },
    findExecutionsBySpecId(specId) {
      return timed("find_by_spec", "spec_execution", specId, () =>
        readMany(
          specExecutionRowSchema,
          "spec_execution",
          `spec:${specId}`,
          () => findExecutionsBySpecStmt.all(specId),
        ),
      );
    },
    findActiveExecutionBySpecId(specId) {
      return timed("find_active_by_spec", "spec_execution", specId, () =>
        readOne(specExecutionRowSchema, "spec_execution", specId, () =>
          findActiveExecutionBySpecStmt.get(specId),
        ),
      );
    },
    listActiveExecutions() {
      return timed("list_active", "spec_execution", "all", () =>
        readMany(specExecutionRowSchema, "spec_execution", "all", () =>
          listActiveExecutionsStmt.all(),
        ),
      );
    },
    findActiveExecutionsBySessionName(projectPath, sessionName) {
      return timed(
        "find_active_by_session",
        "spec_execution",
        `${projectPath}:${sessionName}`,
        () =>
          readMany(
            specExecutionRowSchema,
            "spec_execution",
            `session:${sessionName}`,
            () =>
              findActiveExecutionsBySessionStmt.all(projectPath, sessionName),
          ),
      );
    },
    findExecutionByWorkflowExecutionId(workflowExecutionId) {
      return timed(
        "find_by_workflow_execution",
        "spec_execution",
        workflowExecutionId,
        () =>
          readOne(
            specExecutionRowSchema,
            "spec_execution",
            workflowExecutionId,
            () => findExecutionByWorkflowExecutionStmt.get(workflowExecutionId),
          ),
      );
    },
    findExecutionAwaitingWorkflowByDefinitionId(workflowDefinitionId) {
      return timed(
        "find_awaiting_by_definition",
        "spec_execution",
        workflowDefinitionId,
        () =>
          readOne(
            specExecutionRowSchema,
            "spec_execution",
            workflowDefinitionId,
            () =>
              findExecutionAwaitingWorkflowByDefinitionStmt.get(
                workflowDefinitionId,
              ),
          ),
      );
    },
    linkWorkflowExecution(executionId, workflowExecutionId, updatedAt) {
      return timed(
        "link_workflow_execution",
        "spec_execution",
        executionId,
        () => {
          const result = linkWorkflowExecutionStmt.run(
            workflowExecutionId,
            updatedAt,
            executionId,
            workflowExecutionId,
          );
          if (result.changes === 0) {
            throw new Error(
              `Spec execution ${executionId} is already linked to a different workflow execution.`,
            );
          }
          const execution = readOne(
            specExecutionRowSchema,
            "spec_execution",
            executionId,
            () => findExecutionStmt.get(executionId),
          );
          if (execution === null) {
            throw new Error(`Spec execution ${executionId} was not found.`);
          }
          return execution;
        },
      );
    },
    updateExecutionLifecycle(input) {
      return timed(
        "update_lifecycle",
        "spec_execution",
        input.executionId,
        () => {
          updateExecutionLifecycleStmt.run({
            execution_id: input.executionId,
            state: input.state,
            delivered_at: input.deliveredAt,
            abandoned_reason: input.abandonedReason,
            updated_at: input.updatedAt,
          });
          const execution = readOne(
            specExecutionRowSchema,
            "spec_execution",
            input.executionId,
            () => findExecutionStmt.get(input.executionId),
          );
          if (execution === null) {
            throw new Error(
              `Spec execution ${input.executionId} was not found.`,
            );
          }
          return execution;
        },
      );
    },
  };
}
