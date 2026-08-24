import type Database from "better-sqlite3";
import {
  specApprovalRowSchema,
  specAssumptionRowSchema,
  specCommentRowSchema,
  specGateAdmissionRowSchema,
  specQuestionRowSchema,
  type SpecApprovalRow,
  type SpecAssumptionRow,
  type SpecCommentRow,
  type SpecGateAdmissionRow,
  type SpecQuestionRow,
} from "@/lib/specs/schemas";
import { createSpecRepoHelpers } from "./spec-repo-helpers";

type Db = InstanceType<typeof Database>;

const { parseRow, readMany, readOne, timed } = createSpecRepoHelpers(
  "state-store.spec-review",
);

export interface SpecReviewRepo {
  saveApproval(approval: SpecApprovalRow): void;
  deleteApproval(id: string): void;
  findApprovalById(id: string): SpecApprovalRow | null;
  findApprovalsBySpecId(specId: string): SpecApprovalRow[];
  findLatestApprovalForSubject(input: {
    specId: string;
    revisionId: string;
    subjectKind: SpecApprovalRow["subject_kind"];
    elementId: string | null;
  }): SpecApprovalRow | null;
  insertGateAdmission(admission: SpecGateAdmissionRow): void;
  findGateAdmissionById(id: string): SpecGateAdmissionRow | null;
  findGateAdmissionsByRevision(revisionId: string): SpecGateAdmissionRow[];
  findGateAdmissionsBySpecId(specId: string): SpecGateAdmissionRow[];
  hasValidHumanGateApproval(input: {
    specId: string;
    revisionId: string;
    executionId: string;
    gate: SpecGateAdmissionRow["gate"];
  }): boolean;
  insertQuestion(
    question: SpecQuestionRow,
  ): AttentionInsertOutcome<SpecQuestionRow>;
  updateOpenQuestion(
    input: UpdateOpenQuestionInput,
  ): AttentionCasOutcome<SpecQuestionRow>;
  answerOpenQuestion(
    input: AnswerOpenQuestionInput,
  ): AttentionCasOutcome<SpecQuestionRow>;
  withdrawOpenQuestion(
    input: WithdrawOpenQuestionInput,
  ): AttentionCasOutcome<SpecQuestionRow>;
  findQuestionById(id: string): SpecQuestionRow | null;
  findQuestionsBySpecId(specId: string): SpecQuestionRow[];
  insertAssumption(
    assumption: SpecAssumptionRow,
  ): AttentionInsertOutcome<SpecAssumptionRow>;
  updateProposedAssumption(
    input: UpdateProposedAssumptionInput,
  ): AttentionCasOutcome<SpecAssumptionRow>;
  disposeProposedAssumption(
    input: DisposeProposedAssumptionInput,
  ): AttentionCasOutcome<SpecAssumptionRow>;
  withdrawProposedAssumption(
    input: WithdrawProposedAssumptionInput,
  ): AttentionCasOutcome<SpecAssumptionRow>;
  insertAssumptionSuccessor(
    input: InsertAssumptionSuccessorInput,
  ): IdempotentSupersessionOutcome;
  findAssumptionById(id: string): SpecAssumptionRow | null;
  findAssumptionsBySpecId(specId: string): SpecAssumptionRow[];
  saveComment(comment: SpecCommentRow): void;
  findCommentById(id: string): SpecCommentRow | null;
  findCommentsByRevision(revisionId: string): SpecCommentRow[];
  findCommentsByThread(threadId: string): SpecCommentRow[];
}

export type AttentionInsertOutcome<Row> =
  | { readonly kind: "success"; readonly row: Row }
  | { readonly kind: "uniqueness_conflict" };

export type AttentionCasOutcome<Row> =
  | { readonly kind: "success"; readonly row: Row }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale_version"; readonly currentVersion: number }
  | { readonly kind: "illegal_lifecycle"; readonly currentVersion: number };

export interface UpdateOpenQuestionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly text: string;
  readonly elementId: string | null;
  readonly updatedAt: string;
}

export interface AnswerOpenQuestionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly answer: string;
  readonly answeredAt: string;
  readonly updatedAt: string;
}

export interface WithdrawOpenQuestionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly withdrawnAt: string;
  readonly updatedAt: string;
}

export interface UpdateProposedAssumptionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly text: string;
  readonly elementId: string | null;
  readonly updatedAt: string;
}

export interface DisposeProposedAssumptionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly disposition: "confirmed" | "rejected" | "deferred";
  readonly disposedAt: string;
  readonly updatedAt: string;
}

export interface WithdrawProposedAssumptionInput {
  readonly id: string;
  readonly expectedRecordVersion: number;
  readonly withdrawnAt: string;
  readonly updatedAt: string;
}

export interface InsertAssumptionSuccessorInput {
  readonly predecessorId: string;
  readonly specId: string;
  readonly expectedRecordVersion: number;
  readonly operationId: string;
  readonly requestHash: string;
  readonly successor: {
    readonly id: string;
    readonly elementId: string | null;
    readonly text: string;
    readonly proposedByJson: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

export type IdempotentSupersessionOutcome =
  | {
      readonly kind: "success";
      readonly predecessor: SpecAssumptionRow;
      readonly successor: SpecAssumptionRow;
      readonly idempotentReplay: boolean;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale_version"; readonly currentVersion: number }
  | {
      readonly kind: "illegal_lifecycle";
      readonly currentVersion: number;
      readonly successorId: string | null;
    }
  | { readonly kind: "uniqueness_conflict" }
  | { readonly kind: "idempotency_conflict"; readonly successorId: string };

export function createSpecReviewRepo(db: Db): SpecReviewRepo {
  const saveApprovalStmt = db.prepare(
    `INSERT INTO spec_approvals (
       id, spec_id, subject_kind, element_id, revision_id, approver,
       granted_at, validity
     ) VALUES (
       @id, @spec_id, @subject_kind, @element_id, @revision_id, @approver,
       @granted_at, @validity
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       subject_kind = excluded.subject_kind,
       element_id = excluded.element_id,
       revision_id = excluded.revision_id,
       approver = excluded.approver,
       granted_at = excluded.granted_at,
       validity = excluded.validity`,
  );
  const deleteApprovalStmt = db.prepare(
    "DELETE FROM spec_approvals WHERE id = ?",
  );
  const findApprovalStmt = db.prepare(
    "SELECT * FROM spec_approvals WHERE id = ? LIMIT 1",
  );
  const findApprovalsBySpecStmt = db.prepare(
    `SELECT * FROM spec_approvals
     WHERE spec_id = ?
     ORDER BY granted_at ASC, id ASC`,
  );
  const findLatestApprovalForSubjectStmt = db.prepare(
    `SELECT * FROM spec_approvals
     WHERE spec_id = ?
       AND revision_id = ?
       AND subject_kind = ?
       AND element_id IS ?
     ORDER BY granted_at DESC, id DESC
     LIMIT 1`,
  );

  const insertGateAdmissionStmt = db.prepare(
    `INSERT INTO spec_gate_admissions (
       id, spec_id, gate, basis, approval_id, revision_id, execution_id,
       actor_json, created_at
     ) VALUES (
       @id, @spec_id, @gate, @basis, @approval_id, @revision_id, @execution_id,
       @actor_json, @created_at
     )`,
  );
  const findGateAdmissionStmt = db.prepare(
    "SELECT * FROM spec_gate_admissions WHERE id = ? LIMIT 1",
  );
  const findGateAdmissionsByRevisionStmt = db.prepare(
    `SELECT * FROM spec_gate_admissions
     WHERE revision_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  // Whole-spec gate history in one round trip. `idx_spec_gate_admissions_spec_gate`
  // serves the spec_id lookup; the chronological order costs a temp sort over
  // the spec's own admissions, which is bounded by its gate count.
  const findGateAdmissionsBySpecStmt = db.prepare(
    `SELECT * FROM spec_gate_admissions
     WHERE spec_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const hasValidHumanGateApprovalStmt = db.prepare(
    `SELECT 1
       FROM spec_gate_admissions admission
       JOIN spec_approvals approval ON approval.id = admission.approval_id
      WHERE admission.spec_id = @spec_id
        AND admission.revision_id = @revision_id
        AND admission.execution_id = @execution_id
        AND admission.gate = @gate
        AND admission.basis = 'human_approval'
        AND approval.spec_id = admission.spec_id
        AND approval.revision_id = admission.revision_id
        AND approval.validity = 'valid'
      LIMIT 1`,
  );

  const insertQuestionStmt = db.prepare(
    `INSERT INTO spec_questions (
       id, spec_id, number, element_id, text, provenance_json, record_version,
       status, answer, answered_at, withdrawn_at, created_at, updated_at
     ) VALUES (
       @id, @spec_id, @number, @element_id, @text, @provenance_json,
       @record_version, @status, @answer, @answered_at, @withdrawn_at,
       @created_at, @updated_at
     )
     ON CONFLICT DO NOTHING`,
  );
  const updateOpenQuestionStmt = db.prepare(
    `UPDATE spec_questions
     SET text = @text,
         element_id = @element_id,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND status = 'open'`,
  );
  const answerOpenQuestionStmt = db.prepare(
    `UPDATE spec_questions
     SET status = 'answered',
         answer = @answer,
         answered_at = @answered_at,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND status = 'open'`,
  );
  const withdrawOpenQuestionStmt = db.prepare(
    `UPDATE spec_questions
     SET status = 'withdrawn',
         withdrawn_at = @withdrawn_at,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND status = 'open'`,
  );
  const findQuestionStmt = db.prepare(
    "SELECT * FROM spec_questions WHERE id = ? LIMIT 1",
  );
  const findQuestionsBySpecStmt = db.prepare(
    `SELECT * FROM spec_questions
     WHERE spec_id = ?
     ORDER BY number ASC`,
  );

  const insertAssumptionStmt = db.prepare(
    `INSERT INTO spec_assumptions (
       id, spec_id, number, element_id, text, proposed_by_json, record_version,
       disposition, disposed_at, withdrawn_at, supersedes_assumption_id,
       supersession_operation_id, supersession_request_hash, created_at,
       updated_at
     ) VALUES (
       @id, @spec_id, @number, @element_id, @text, @proposed_by_json,
       @record_version, @disposition, @disposed_at, @withdrawn_at,
       @supersedes_assumption_id, @supersession_operation_id,
       @supersession_request_hash, @created_at, @updated_at
     )
     ON CONFLICT DO NOTHING`,
  );
  const updateProposedAssumptionStmt = db.prepare(
    `UPDATE spec_assumptions
     SET text = @text,
         element_id = @element_id,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND disposition = 'proposed'`,
  );
  const disposeProposedAssumptionStmt = db.prepare(
    `UPDATE spec_assumptions
     SET disposition = @disposition,
         disposed_at = @disposed_at,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND disposition = 'proposed'`,
  );
  const withdrawProposedAssumptionStmt = db.prepare(
    `UPDATE spec_assumptions
     SET disposition = 'withdrawn',
         withdrawn_at = @withdrawn_at,
         record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND record_version = @expected_record_version
       AND disposition = 'proposed'`,
  );
  const findSuccessorByPredecessorStmt = db.prepare(
    `SELECT * FROM spec_assumptions
     WHERE spec_id = ? AND supersedes_assumption_id = ?
     LIMIT 1`,
  );
  const findSuccessorByOperationStmt = db.prepare(
    `SELECT * FROM spec_assumptions
     WHERE spec_id = ? AND supersession_operation_id = ?
     LIMIT 1`,
  );
  const incrementSupersededPredecessorStmt = db.prepare(
    `UPDATE spec_assumptions
     SET record_version = record_version + 1,
         updated_at = @updated_at
     WHERE id = @id
       AND spec_id = @spec_id
       AND record_version = @expected_record_version
       AND disposition IN ('confirmed', 'rejected', 'deferred')
       AND NOT EXISTS (
         SELECT 1 FROM spec_assumptions AS successor
         WHERE successor.spec_id = @spec_id
           AND successor.supersedes_assumption_id = @id
       )`,
  );
  const allocateAssumptionNumberStmt = db.prepare(
    `INSERT INTO spec_counters (spec_id, scope_key, last_number)
     VALUES (?, 'A', 1)
     ON CONFLICT(spec_id, scope_key)
     DO UPDATE SET last_number = last_number + 1
     RETURNING last_number`,
  );
  const findAssumptionStmt = db.prepare(
    "SELECT * FROM spec_assumptions WHERE id = ? LIMIT 1",
  );
  const findAssumptionsBySpecStmt = db.prepare(
    `SELECT * FROM spec_assumptions
     WHERE spec_id = ?
     ORDER BY number ASC`,
  );

  const saveCommentStmt = db.prepare(
    `INSERT INTO spec_comments (
       id, spec_id, thread_id, parent_comment_id, element_id, anchor_json,
       revision_id, body, author_json, blocking, resolution, created_at,
       updated_at
     ) VALUES (
       @id, @spec_id, @thread_id, @parent_comment_id, @element_id, @anchor_json,
       @revision_id, @body, @author_json, @blocking, @resolution, @created_at,
       @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       thread_id = excluded.thread_id,
       parent_comment_id = excluded.parent_comment_id,
       element_id = excluded.element_id,
       anchor_json = excluded.anchor_json,
       revision_id = excluded.revision_id,
       body = excluded.body,
       author_json = excluded.author_json,
       blocking = excluded.blocking,
       resolution = excluded.resolution,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  );
  const findCommentStmt = db.prepare(
    "SELECT * FROM spec_comments WHERE id = ? LIMIT 1",
  );
  const findCommentsByRevisionStmt = db.prepare(
    `SELECT * FROM spec_comments
     WHERE revision_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findCommentsByThreadStmt = db.prepare(
    `SELECT * FROM spec_comments
     WHERE thread_id = ?
     ORDER BY created_at ASC, id ASC`,
  );

  function readQuestionById(id: string): SpecQuestionRow | null {
    return readOne(specQuestionRowSchema, "spec_question", id, () =>
      findQuestionStmt.get(id),
    );
  }

  function readAssumptionById(id: string): SpecAssumptionRow | null {
    return readOne(specAssumptionRowSchema, "spec_assumption", id, () =>
      findAssumptionStmt.get(id),
    );
  }

  function questionCasFailure(
    id: string,
    expectedRecordVersion: number,
  ): Exclude<AttentionCasOutcome<SpecQuestionRow>, { kind: "success" }> {
    const current = readQuestionById(id);
    if (current === null) return { kind: "not_found" };
    if (current.record_version !== expectedRecordVersion) {
      return {
        kind: "stale_version",
        currentVersion: current.record_version,
      };
    }
    return {
      kind: "illegal_lifecycle",
      currentVersion: current.record_version,
    };
  }

  function assumptionCasFailure(
    id: string,
    expectedRecordVersion: number,
  ): Exclude<AttentionCasOutcome<SpecAssumptionRow>, { kind: "success" }> {
    const current = readAssumptionById(id);
    if (current === null) return { kind: "not_found" };
    if (current.record_version !== expectedRecordVersion) {
      return {
        kind: "stale_version",
        currentVersion: current.record_version,
      };
    }
    return {
      kind: "illegal_lifecycle",
      currentVersion: current.record_version,
    };
  }

  return {
    saveApproval(approval) {
      timed("save", "spec_approval", approval.id, () => {
        saveApprovalStmt.run(
          parseRow(
            specApprovalRowSchema,
            "spec_approval",
            approval.id,
            approval,
          ),
        );
      });
    },
    deleteApproval(id) {
      timed("delete", "spec_approval", id, () => {
        deleteApprovalStmt.run(id);
      });
    },
    findApprovalById(id) {
      return timed("find_by_id", "spec_approval", id, () =>
        readOne(specApprovalRowSchema, "spec_approval", id, () =>
          findApprovalStmt.get(id),
        ),
      );
    },
    findApprovalsBySpecId(specId) {
      return timed("find_by_spec", "spec_approval", specId, () =>
        readMany(specApprovalRowSchema, "spec_approval", `spec:${specId}`, () =>
          findApprovalsBySpecStmt.all(specId),
        ),
      );
    },
    findLatestApprovalForSubject(input) {
      const identifier = `${input.specId}:${input.revisionId}:${input.subjectKind}:${input.elementId ?? "revision"}`;
      return timed("find_latest_for_subject", "spec_approval", identifier, () =>
        readOne(specApprovalRowSchema, "spec_approval", identifier, () =>
          findLatestApprovalForSubjectStmt.get(
            input.specId,
            input.revisionId,
            input.subjectKind,
            input.elementId,
          ),
        ),
      );
    },
    insertGateAdmission(admission) {
      timed("insert", "spec_gate_admission", admission.id, () => {
        insertGateAdmissionStmt.run(
          parseRow(
            specGateAdmissionRowSchema,
            "spec_gate_admission",
            admission.id,
            admission,
          ),
        );
      });
    },
    findGateAdmissionById(id) {
      return timed("find_by_id", "spec_gate_admission", id, () =>
        readOne(specGateAdmissionRowSchema, "spec_gate_admission", id, () =>
          findGateAdmissionStmt.get(id),
        ),
      );
    },
    findGateAdmissionsByRevision(revisionId) {
      return timed("find_by_revision", "spec_gate_admission", revisionId, () =>
        readMany(
          specGateAdmissionRowSchema,
          "spec_gate_admission",
          `revision:${revisionId}`,
          () => findGateAdmissionsByRevisionStmt.all(revisionId),
        ),
      );
    },
    findGateAdmissionsBySpecId(specId) {
      return timed("find_by_spec", "spec_gate_admission", specId, () =>
        readMany(
          specGateAdmissionRowSchema,
          "spec_gate_admission",
          `spec:${specId}`,
          () => findGateAdmissionsBySpecStmt.all(specId),
        ),
      );
    },
    hasValidHumanGateApproval(input) {
      const identifier = `${input.specId}:${input.revisionId}:${input.executionId}:${input.gate}`;
      return timed(
        "has_valid_human_gate_approval",
        "spec_gate_admission",
        identifier,
        () =>
          hasValidHumanGateApprovalStmt.get({
            spec_id: input.specId,
            revision_id: input.revisionId,
            execution_id: input.executionId,
            gate: input.gate,
          }) !== undefined,
      );
    },
    insertQuestion(question) {
      return timed("insert", "spec_question", question.id, () => {
        const parsed = parseRow(
          specQuestionRowSchema,
          "spec_question",
          question.id,
          question,
        );
        const result = insertQuestionStmt.run(parsed);
        if (result.changes === 0) return { kind: "uniqueness_conflict" };
        return { kind: "success", row: parsed };
      });
    },
    updateOpenQuestion(input) {
      return timed("update_open", "spec_question", input.id, () => {
        const result = updateOpenQuestionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          text: input.text,
          element_id: input.elementId,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return questionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readQuestionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    answerOpenQuestion(input) {
      return timed("answer_open", "spec_question", input.id, () => {
        const result = answerOpenQuestionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          answer: input.answer,
          answered_at: input.answeredAt,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return questionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readQuestionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    withdrawOpenQuestion(input) {
      return timed("withdraw_open", "spec_question", input.id, () => {
        const result = withdrawOpenQuestionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          withdrawn_at: input.withdrawnAt,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return questionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readQuestionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    findQuestionById(id) {
      return timed("find_by_id", "spec_question", id, () =>
        readQuestionById(id),
      );
    },
    findQuestionsBySpecId(specId) {
      return timed("find_by_spec", "spec_question", specId, () =>
        readMany(specQuestionRowSchema, "spec_question", `spec:${specId}`, () =>
          findQuestionsBySpecStmt.all(specId),
        ),
      );
    },
    insertAssumption(assumption) {
      return timed("insert", "spec_assumption", assumption.id, () => {
        const parsed = parseRow(
          specAssumptionRowSchema,
          "spec_assumption",
          assumption.id,
          assumption,
        );
        const result = insertAssumptionStmt.run(parsed);
        if (result.changes === 0) return { kind: "uniqueness_conflict" };
        return { kind: "success", row: parsed };
      });
    },
    updateProposedAssumption(input) {
      return timed("update_proposed", "spec_assumption", input.id, () => {
        const result = updateProposedAssumptionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          text: input.text,
          element_id: input.elementId,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return assumptionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readAssumptionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    disposeProposedAssumption(input) {
      return timed("dispose_proposed", "spec_assumption", input.id, () => {
        const result = disposeProposedAssumptionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          disposition: input.disposition,
          disposed_at: input.disposedAt,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return assumptionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readAssumptionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    withdrawProposedAssumption(input) {
      return timed("withdraw_proposed", "spec_assumption", input.id, () => {
        const result = withdrawProposedAssumptionStmt.run({
          id: input.id,
          expected_record_version: input.expectedRecordVersion,
          withdrawn_at: input.withdrawnAt,
          updated_at: input.updatedAt,
        });
        if (result.changes === 0) {
          return assumptionCasFailure(input.id, input.expectedRecordVersion);
        }
        const row = readAssumptionById(input.id);
        if (row === null) return { kind: "not_found" };
        return { kind: "success", row };
      });
    },
    insertAssumptionSuccessor(input) {
      return timed(
        "insert_successor",
        "spec_assumption",
        input.predecessorId,
        () =>
          db
            .transaction((): IdempotentSupersessionOutcome => {
              const replayRaw = findSuccessorByOperationStmt.get(
                input.specId,
                input.operationId,
              );
              if (replayRaw !== undefined) {
                const successor = parseRow(
                  specAssumptionRowSchema,
                  "spec_assumption",
                  input.operationId,
                  replayRaw,
                );
                if (successor.supersession_request_hash !== input.requestHash) {
                  return {
                    kind: "idempotency_conflict",
                    successorId: successor.id,
                  };
                }
                const predecessor = readAssumptionById(input.predecessorId);
                if (
                  predecessor === null ||
                  successor.supersedes_assumption_id !== predecessor.id
                ) {
                  return {
                    kind: "idempotency_conflict",
                    successorId: successor.id,
                  };
                }
                return {
                  kind: "success",
                  predecessor,
                  successor,
                  idempotentReplay: true,
                };
              }

              const predecessor = readAssumptionById(input.predecessorId);
              if (
                predecessor === null ||
                predecessor.spec_id !== input.specId
              ) {
                return { kind: "not_found" };
              }
              if (predecessor.record_version !== input.expectedRecordVersion) {
                return {
                  kind: "stale_version",
                  currentVersion: predecessor.record_version,
                };
              }
              const existingSuccessorRaw = findSuccessorByPredecessorStmt.get(
                input.specId,
                input.predecessorId,
              );
              if (
                !["confirmed", "rejected", "deferred"].includes(
                  predecessor.disposition,
                ) ||
                existingSuccessorRaw !== undefined
              ) {
                const existingSuccessor =
                  existingSuccessorRaw === undefined
                    ? null
                    : parseRow(
                        specAssumptionRowSchema,
                        "spec_assumption",
                        input.predecessorId,
                        existingSuccessorRaw,
                      );
                return {
                  kind: "illegal_lifecycle",
                  currentVersion: predecessor.record_version,
                  successorId: existingSuccessor?.id ?? null,
                };
              }
              if (readAssumptionById(input.successor.id) !== null) {
                return { kind: "uniqueness_conflict" };
              }

              const predecessorUpdate = incrementSupersededPredecessorStmt.run({
                id: input.predecessorId,
                spec_id: input.specId,
                expected_record_version: input.expectedRecordVersion,
                updated_at: input.successor.updatedAt,
              });
              if (predecessorUpdate.changes === 0) {
                const failure = assumptionCasFailure(
                  input.predecessorId,
                  input.expectedRecordVersion,
                );
                if (failure.kind !== "illegal_lifecycle") return failure;
                const successorRaw = findSuccessorByPredecessorStmt.get(
                  input.specId,
                  input.predecessorId,
                );
                return {
                  ...failure,
                  successorId:
                    successorRaw === undefined
                      ? null
                      : parseRow(
                          specAssumptionRowSchema,
                          "spec_assumption",
                          input.predecessorId,
                          successorRaw,
                        ).id,
                };
              }

              const allocated = allocateAssumptionNumberStmt.get(
                input.specId,
              ) as { last_number: number };
              const successor = specAssumptionRowSchema.parse({
                id: input.successor.id,
                spec_id: input.specId,
                number: allocated.last_number,
                element_id: input.successor.elementId,
                text: input.successor.text,
                proposed_by_json: input.successor.proposedByJson,
                record_version: 1,
                disposition: "proposed",
                disposed_at: null,
                withdrawn_at: null,
                supersedes_assumption_id: input.predecessorId,
                supersession_operation_id: input.operationId,
                supersession_request_hash: input.requestHash,
                created_at: input.successor.createdAt,
                updated_at: input.successor.updatedAt,
              });
              const insert = insertAssumptionStmt.run(successor);
              if (insert.changes === 0) return { kind: "uniqueness_conflict" };
              const updatedPredecessor = readAssumptionById(
                input.predecessorId,
              );
              if (updatedPredecessor === null) return { kind: "not_found" };
              return {
                kind: "success",
                predecessor: updatedPredecessor,
                successor,
                idempotentReplay: false,
              };
            })
            .immediate(),
      );
    },
    findAssumptionById(id) {
      return timed("find_by_id", "spec_assumption", id, () =>
        readAssumptionById(id),
      );
    },
    findAssumptionsBySpecId(specId) {
      return timed("find_by_spec", "spec_assumption", specId, () =>
        readMany(
          specAssumptionRowSchema,
          "spec_assumption",
          `spec:${specId}`,
          () => findAssumptionsBySpecStmt.all(specId),
        ),
      );
    },
    saveComment(comment) {
      timed("save", "spec_comment", comment.id, () => {
        saveCommentStmt.run(
          parseRow(specCommentRowSchema, "spec_comment", comment.id, comment),
        );
      });
    },
    findCommentById(id) {
      return timed("find_by_id", "spec_comment", id, () =>
        readOne(specCommentRowSchema, "spec_comment", id, () =>
          findCommentStmt.get(id),
        ),
      );
    },
    findCommentsByRevision(revisionId) {
      return timed("find_by_revision", "spec_comment", revisionId, () =>
        readMany(
          specCommentRowSchema,
          "spec_comment",
          `revision:${revisionId}`,
          () => findCommentsByRevisionStmt.all(revisionId),
        ),
      );
    },
    findCommentsByThread(threadId) {
      return timed("find_by_thread", "spec_comment", threadId, () =>
        readMany(
          specCommentRowSchema,
          "spec_comment",
          `thread:${threadId}`,
          () => findCommentsByThreadStmt.all(threadId),
        ),
      );
    },
  };
}
