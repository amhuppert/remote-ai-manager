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
  hasValidHumanGateApproval(input: {
    specId: string;
    revisionId: string;
    executionId: string;
    gate: SpecGateAdmissionRow["gate"];
  }): boolean;
  saveQuestion(question: SpecQuestionRow): void;
  findQuestionById(id: string): SpecQuestionRow | null;
  findQuestionsBySpecId(specId: string): SpecQuestionRow[];
  saveAssumption(assumption: SpecAssumptionRow): void;
  findAssumptionById(id: string): SpecAssumptionRow | null;
  findAssumptionsBySpecId(specId: string): SpecAssumptionRow[];
  saveComment(comment: SpecCommentRow): void;
  findCommentById(id: string): SpecCommentRow | null;
  findCommentsByRevision(revisionId: string): SpecCommentRow[];
}

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

  const saveQuestionStmt = db.prepare(
    `INSERT INTO spec_questions (
       id, spec_id, number, element_id, text, provenance_json, status, answer,
       answered_at, created_at, updated_at
     ) VALUES (
       @id, @spec_id, @number, @element_id, @text, @provenance_json, @status,
       @answer, @answered_at, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       number = excluded.number,
       element_id = excluded.element_id,
       text = excluded.text,
       provenance_json = excluded.provenance_json,
       status = excluded.status,
       answer = excluded.answer,
       answered_at = excluded.answered_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  );
  const findQuestionStmt = db.prepare(
    "SELECT * FROM spec_questions WHERE id = ? LIMIT 1",
  );
  const findQuestionsBySpecStmt = db.prepare(
    `SELECT * FROM spec_questions
     WHERE spec_id = ?
     ORDER BY number ASC`,
  );

  const saveAssumptionStmt = db.prepare(
    `INSERT INTO spec_assumptions (
       id, spec_id, number, element_id, text, proposed_by_json, disposition,
       disposed_at, created_at, updated_at
     ) VALUES (
       @id, @spec_id, @number, @element_id, @text, @proposed_by_json,
       @disposition, @disposed_at, @created_at, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       spec_id = excluded.spec_id,
       number = excluded.number,
       element_id = excluded.element_id,
       text = excluded.text,
       proposed_by_json = excluded.proposed_by_json,
       disposition = excluded.disposition,
       disposed_at = excluded.disposed_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
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
    saveQuestion(question) {
      timed("save", "spec_question", question.id, () => {
        saveQuestionStmt.run(
          parseRow(
            specQuestionRowSchema,
            "spec_question",
            question.id,
            question,
          ),
        );
      });
    },
    findQuestionById(id) {
      return timed("find_by_id", "spec_question", id, () =>
        readOne(specQuestionRowSchema, "spec_question", id, () =>
          findQuestionStmt.get(id),
        ),
      );
    },
    findQuestionsBySpecId(specId) {
      return timed("find_by_spec", "spec_question", specId, () =>
        readMany(specQuestionRowSchema, "spec_question", `spec:${specId}`, () =>
          findQuestionsBySpecStmt.all(specId),
        ),
      );
    },
    saveAssumption(assumption) {
      timed("save", "spec_assumption", assumption.id, () => {
        saveAssumptionStmt.run(
          parseRow(
            specAssumptionRowSchema,
            "spec_assumption",
            assumption.id,
            assumption,
          ),
        );
      });
    },
    findAssumptionById(id) {
      return timed("find_by_id", "spec_assumption", id, () =>
        readOne(specAssumptionRowSchema, "spec_assumption", id, () =>
          findAssumptionStmt.get(id),
        ),
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
  };
}
