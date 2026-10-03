import type Database from "better-sqlite3";
import { z } from "zod";
import type { OwnerRef } from "@/lib/intents/schemas";
import {
  attemptRecordSchema,
  coreQuestionRecordSchema,
  mailboxItemRecordSchema,
  seatBindingRecordSchema,
  type AttemptRecord,
  type CoreQuestionRecord,
  type MailboxItemRecord,
  type SeatBindingRecord,
} from "@/lib/conversation-core/schemas";

type Db = InstanceType<typeof Database>;

const seatRow = z.object({
  conversation_id: z.string(),
  context_id: z.string(),
  assignment_id: z.string(),
  replacement: z.number().int(),
  role: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  backend: z.string(),
  backend_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const mailboxRow = z.object({
  cause: z.string(),
  conversation_id: z.string(),
  requester_kind: z.string(),
  requester_id: z.string(),
  request_json: z.string(),
  permit_controller_id: z.string().nullable(),
  permit_generation: z.number().int().nullable(),
  state: z.string(),
  attempt_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const attemptRow = z.object({
  attempt_id: z.string(),
  conversation_id: z.string(),
  cause: z.string(),
  state: z.string(),
  outcome_json: z.string().nullable(),
  opened_at: z.string(),
  settled_at: z.string().nullable(),
});
const questionRow = z.object({
  question_id: z.string(),
  conversation_id: z.string(),
  attempt_id: z.string(),
  question_text: z.string(),
  questions_json: z.string(),
  state: z.string(),
  answer: z.string().nullable(),
  created_at: z.string(),
  answered_at: z.string().nullable(),
});
const waitRow = z.object({
  cause: z.string(),
  question_id: z.string(),
  requester_kind: z.enum(["context", "run"]),
  requester_id: z.string(),
});

function seatFromRow(raw: unknown): SeatBindingRecord {
  const r = seatRow.parse(raw);
  return seatBindingRecordSchema.parse({
    conversationId: r.conversation_id,
    contextId: r.context_id,
    assignmentId: r.assignment_id,
    replacement: r.replacement,
    role: r.role,
    projectPath: r.project_path,
    sessionName: r.session_name,
    backend: r.backend,
    backendRef: r.backend_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function mailboxFromRow(raw: unknown): MailboxItemRecord {
  const r = mailboxRow.parse(raw);
  return mailboxItemRecordSchema.parse({
    cause: r.cause,
    conversationId: r.conversation_id,
    requester: { kind: r.requester_kind, id: r.requester_id },
    request: JSON.parse(r.request_json),
    permit:
      r.permit_controller_id === null || r.permit_generation === null
        ? null
        : {
            controllerId: r.permit_controller_id,
            generation: r.permit_generation,
          },
    state: r.state,
    attemptId: r.attempt_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function attemptFromRow(raw: unknown): AttemptRecord {
  const r = attemptRow.parse(raw);
  return attemptRecordSchema.parse({
    attemptId: r.attempt_id,
    conversationId: r.conversation_id,
    cause: r.cause,
    state: r.state,
    outcome: r.outcome_json === null ? null : JSON.parse(r.outcome_json),
    openedAt: r.opened_at,
    settledAt: r.settled_at,
  });
}

function questionFromRow(raw: unknown): CoreQuestionRecord {
  const r = questionRow.parse(raw);
  return coreQuestionRecordSchema.parse({
    questionId: r.question_id,
    conversationId: r.conversation_id,
    attemptId: r.attempt_id,
    questionText: r.question_text,
    questions: JSON.parse(r.questions_json),
    state: r.state,
    answer: r.answer,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  });
}

/** Sole writer of the Conversation core's seat, mailbox, attempt and question tables. */
export interface ConversationCoreRepo {
  insertSeat(record: SeatBindingRecord): void;
  getSeat(conversationId: string): SeatBindingRecord | null;
  findSeat(
    contextId: string,
    assignmentId: string,
    replacement: number,
  ): SeatBindingRecord | null;
  setSeatBackendRef(
    conversationId: string,
    backendRef: string | null,
    updatedAt: string,
  ): void;

  insertMailboxIfAbsent(record: MailboxItemRecord): void;
  getMailbox(cause: string): MailboxItemRecord | null;
  nextQueued(conversationId: string): MailboxItemRecord | null;
  conversationsWithQueued(): string[];
  refreshMailboxPermit(
    cause: string,
    permit: MailboxItemRecord["permit"],
    updatedAt: string,
  ): void;
  consumeMailbox(cause: string, attemptId: string, updatedAt: string): void;
  deleteMailbox(cause: string): void;

  insertAttempt(record: AttemptRecord): void;
  getAttempt(attemptId: string): AttemptRecord | null;
  latestAttemptFor(cause: string): AttemptRecord | null;
  attemptsInState(state: AttemptRecord["state"]): AttemptRecord[];
  admitAttempt(attemptId: string): void;
  settleAttempt(
    attemptId: string,
    outcome: AttemptRecord["outcome"],
    settledAt: string,
  ): void;

  insertQuestion(record: CoreQuestionRecord): void;
  getQuestion(questionId: string): CoreQuestionRecord | null;
  questionForAttempt(
    conversationId: string,
    attemptId: string,
  ): CoreQuestionRecord | null;
  resolveQuestion(
    questionId: string,
    change: {
      state: "answered" | "withdrawn";
      answer: string | null;
      answeredAt: string;
    },
  ): void;
  insertWaitIfAbsent(input: {
    cause: string;
    questionId: string;
    requester: OwnerRef;
    createdAt: string;
  }): void;
  getWait(cause: string): { questionId: string; requester: OwnerRef } | null;
  waitersFor(questionId: string): OwnerRef[];
}

export function createConversationCoreRepo(db: Db): ConversationCoreRepo {
  const SEAT = `conversation_id, context_id, assignment_id, replacement, role, project_path, session_name, backend, backend_ref, created_at, updated_at`;
  const MAILBOX = `cause, conversation_id, requester_kind, requester_id, request_json, permit_controller_id, permit_generation, state, attempt_id, created_at, updated_at`;
  const ATTEMPT = `attempt_id, conversation_id, cause, state, outcome_json, opened_at, settled_at`;
  const QUESTION = `question_id, conversation_id, attempt_id, question_text, questions_json, state, answer, created_at, answered_at`;
  const st = {
    insertSeat: db.prepare(
      `INSERT OR IGNORE INTO core_seat_bindings (${SEAT}) VALUES (@conversationId, @contextId, @assignmentId, @replacement, @role, @projectPath, @sessionName, @backend, @backendRef, @createdAt, @updatedAt)`,
    ),
    getSeat: db.prepare(
      `SELECT ${SEAT} FROM core_seat_bindings WHERE conversation_id = ?`,
    ),
    findSeat: db.prepare(
      `SELECT ${SEAT} FROM core_seat_bindings WHERE context_id = ? AND assignment_id = ? AND replacement = ?`,
    ),
    setSeatRef: db.prepare(
      `UPDATE core_seat_bindings SET backend_ref = ?, updated_at = ? WHERE conversation_id = ?`,
    ),
    insertMailbox: db.prepare(
      `INSERT OR IGNORE INTO core_mailbox (${MAILBOX}) VALUES (@cause, @conversationId, @requesterKind, @requesterId, @requestJson, @permitControllerId, @permitGeneration, @state, @attemptId, @createdAt, @updatedAt)`,
    ),
    getMailbox: db.prepare(
      `SELECT ${MAILBOX} FROM core_mailbox WHERE cause = ?`,
    ),
    nextQueued: db.prepare(
      `SELECT ${MAILBOX} FROM core_mailbox WHERE conversation_id = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT 1`,
    ),
    withQueued: db.prepare(
      `SELECT DISTINCT conversation_id AS id FROM core_mailbox WHERE state = 'queued'`,
    ),
    refreshPermit: db.prepare(
      `UPDATE core_mailbox SET permit_controller_id = ?, permit_generation = ?, updated_at = ? WHERE cause = ? AND state = 'queued'`,
    ),
    consume: db.prepare(
      `UPDATE core_mailbox SET state = 'consumed', attempt_id = ?, updated_at = ? WHERE cause = ?`,
    ),
    deleteMailbox: db.prepare(
      `DELETE FROM core_mailbox WHERE cause = ? AND state = 'queued'`,
    ),
    insertAttempt: db.prepare(
      `INSERT INTO core_attempts (${ATTEMPT}) VALUES (@attemptId, @conversationId, @cause, @state, @outcomeJson, @openedAt, @settledAt)`,
    ),
    getAttempt: db.prepare(
      `SELECT ${ATTEMPT} FROM core_attempts WHERE attempt_id = ?`,
    ),
    latestAttempt: db.prepare(
      `SELECT ${ATTEMPT} FROM core_attempts WHERE cause = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
    ),
    attemptsInState: db.prepare(
      `SELECT ${ATTEMPT} FROM core_attempts WHERE state = ?`,
    ),
    admitAttempt: db.prepare(
      `UPDATE core_attempts SET state = 'admitted' WHERE attempt_id = ? AND state = 'open'`,
    ),
    settleAttempt: db.prepare(
      `UPDATE core_attempts SET state = 'settled', outcome_json = ?, settled_at = ? WHERE attempt_id = ?`,
    ),
    insertQuestion: db.prepare(
      `INSERT INTO core_questions (${QUESTION}) VALUES (@questionId, @conversationId, @attemptId, @questionText, @questionsJson, @state, @answer, @createdAt, @answeredAt)`,
    ),
    getQuestion: db.prepare(
      `SELECT ${QUESTION} FROM core_questions WHERE question_id = ?`,
    ),
    questionForAttempt: db.prepare(
      `SELECT ${QUESTION} FROM core_questions WHERE conversation_id = ? AND attempt_id = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    resolveQuestion: db.prepare(
      `UPDATE core_questions SET state = ?, answer = ?, answered_at = ? WHERE question_id = ? AND state = 'open'`,
    ),
    insertWait: db.prepare(
      `INSERT OR IGNORE INTO core_question_waits (cause, question_id, requester_kind, requester_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    getWait: db.prepare(
      `SELECT cause, question_id, requester_kind, requester_id FROM core_question_waits WHERE cause = ?`,
    ),
    waitersFor: db.prepare(
      `SELECT cause, question_id, requester_kind, requester_id FROM core_question_waits WHERE question_id = ?`,
    ),
  };
  return {
    insertSeat(record) {
      st.insertSeat.run(seatBindingRecordSchema.parse(record));
    },
    getSeat(conversationId) {
      const raw: unknown = st.getSeat.get(conversationId);
      return raw === undefined ? null : seatFromRow(raw);
    },
    findSeat(contextId, assignmentId, replacement) {
      const raw: unknown = st.findSeat.get(
        contextId,
        assignmentId,
        replacement,
      );
      return raw === undefined ? null : seatFromRow(raw);
    },
    setSeatBackendRef(conversationId, backendRef, updatedAt) {
      st.setSeatRef.run(backendRef, updatedAt, conversationId);
    },
    insertMailboxIfAbsent(record) {
      const p = mailboxItemRecordSchema.parse(record);
      st.insertMailbox.run({
        cause: p.cause,
        conversationId: p.conversationId,
        requesterKind: p.requester.kind,
        requesterId: p.requester.id,
        requestJson: JSON.stringify(p.request),
        permitControllerId: p.permit?.controllerId ?? null,
        permitGeneration: p.permit?.generation ?? null,
        state: p.state,
        attemptId: p.attemptId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    },
    getMailbox(cause) {
      const raw: unknown = st.getMailbox.get(cause);
      return raw === undefined ? null : mailboxFromRow(raw);
    },
    nextQueued(conversationId) {
      const raw: unknown = st.nextQueued.get(conversationId);
      return raw === undefined ? null : mailboxFromRow(raw);
    },
    conversationsWithQueued() {
      return z
        .array(z.object({ id: z.string() }))
        .parse(st.withQueued.all())
        .map((r) => r.id);
    },
    refreshMailboxPermit(cause, permit, updatedAt) {
      st.refreshPermit.run(
        permit?.controllerId ?? null,
        permit?.generation ?? null,
        updatedAt,
        cause,
      );
    },
    consumeMailbox(cause, attemptId, updatedAt) {
      st.consume.run(attemptId, updatedAt, cause);
    },
    deleteMailbox(cause) {
      st.deleteMailbox.run(cause);
    },
    insertAttempt(record) {
      const p = attemptRecordSchema.parse(record);
      st.insertAttempt.run({
        attemptId: p.attemptId,
        conversationId: p.conversationId,
        cause: p.cause,
        state: p.state,
        outcomeJson: p.outcome === null ? null : JSON.stringify(p.outcome),
        openedAt: p.openedAt,
        settledAt: p.settledAt,
      });
    },
    getAttempt(attemptId) {
      const raw: unknown = st.getAttempt.get(attemptId);
      return raw === undefined ? null : attemptFromRow(raw);
    },
    latestAttemptFor(cause) {
      const raw: unknown = st.latestAttempt.get(cause);
      return raw === undefined ? null : attemptFromRow(raw);
    },
    attemptsInState(state) {
      return st.attemptsInState.all(state).map(attemptFromRow);
    },
    admitAttempt(attemptId) {
      st.admitAttempt.run(attemptId);
    },
    settleAttempt(attemptId, outcome, settledAt) {
      st.settleAttempt.run(
        outcome === null ? null : JSON.stringify(outcome),
        settledAt,
        attemptId,
      );
    },
    insertQuestion(record) {
      const p = coreQuestionRecordSchema.parse(record);
      st.insertQuestion.run({
        questionId: p.questionId,
        conversationId: p.conversationId,
        attemptId: p.attemptId,
        questionText: p.questionText,
        questionsJson: JSON.stringify(p.questions),
        state: p.state,
        answer: p.answer,
        createdAt: p.createdAt,
        answeredAt: p.answeredAt,
      });
    },
    getQuestion(questionId) {
      const raw: unknown = st.getQuestion.get(questionId);
      return raw === undefined ? null : questionFromRow(raw);
    },
    questionForAttempt(conversationId, attemptId) {
      const raw: unknown = st.questionForAttempt.get(conversationId, attemptId);
      return raw === undefined ? null : questionFromRow(raw);
    },
    resolveQuestion(questionId, change) {
      st.resolveQuestion.run(
        change.state,
        change.answer,
        change.answeredAt,
        questionId,
      );
    },
    insertWaitIfAbsent(input) {
      st.insertWait.run(
        input.cause,
        input.questionId,
        input.requester.kind,
        input.requester.id,
        input.createdAt,
      );
    },
    getWait(cause) {
      const raw: unknown = st.getWait.get(cause);
      if (raw === undefined) return null;
      const r = waitRow.parse(raw);
      return {
        questionId: r.question_id,
        requester: { kind: r.requester_kind, id: r.requester_id },
      };
    },
    waitersFor(questionId) {
      return st.waitersFor.all(questionId).map((raw) => {
        const r = waitRow.parse(raw);
        return { kind: r.requester_kind, id: r.requester_id };
      });
    },
  };
}
