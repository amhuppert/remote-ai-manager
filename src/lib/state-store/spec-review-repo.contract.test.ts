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
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { _createTestDb } from "./state-db";
import { createSpecReviewRepo, type SpecReviewRepo } from "./spec-review-repo";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-review-maximal";
const ELEMENT_ID = "requirement-review-maximal";
const REVISION_ID = "revision-review-maximal";
const EXECUTION_ID = "execution-review-maximal";
const SECOND_REVISION_ID = "revision-review-maximal-2";
const FOREIGN_SPEC_ID = "spec-review-foreign";
const FOREIGN_REVISION_ID = "revision-review-foreign";

let db: Db;
let repo: SpecReviewRepo;

function seedReviewParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/review-contract",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repos/review-contract",
    "review-contract",
    "Review contract",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T08:00:00.000Z",
    "2026-07-18T08:01:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ELEMENT_ID,
    SPEC_ID,
    "requirement",
    7,
    null,
    "2026-07-18T08:02:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    4,
    "approved",
    null,
    "sha256:review-maximal",
    "2026-07-18T08:03:00.000Z",
    "2026-07-18T08:04:00.000Z",
    "2026-07-18T08:02:30.000Z",
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
    '{"taskElementIds":["task-7"]}',
    "running",
    "workflow-definition-review-maximal",
    "workflow-execution-review-maximal",
    "native-sdd-review",
    null,
    null,
    "2026-07-18T08:05:00.000Z",
    "2026-07-18T08:06:00.000Z",
  );
}

function insertRevision(
  id: string,
  specId: string,
  number: number,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, specId, number, "draft", null, null, null, null, createdAt);
}

function seedSecondRevision(): void {
  insertRevision(SECOND_REVISION_ID, SPEC_ID, 5, "2026-07-18T09:30:00.000Z");
}

function seedForeignSpec(): void {
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    FOREIGN_SPEC_ID,
    "/repos/review-contract",
    "review-contract-foreign",
    "Review contract foreign",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T08:00:00.000Z",
    "2026-07-18T08:01:00.000Z",
  );
  insertRevision(
    FOREIGN_REVISION_ID,
    FOREIGN_SPEC_ID,
    1,
    "2026-07-18T08:02:30.000Z",
  );
}

function maximalApproval(): SpecApprovalRow {
  return specApprovalRowSchema.parse({
    id: "approval-review-maximal",
    spec_id: SPEC_ID,
    subject_kind: "requirement",
    element_id: ELEMENT_ID,
    revision_id: REVISION_ID,
    approver: "alex@example.com",
    granted_at: "2026-07-18T09:00:00.000Z",
    validity: "stale",
  });
}

function maximalGateAdmission(): SpecGateAdmissionRow {
  return specGateAdmissionRowSchema.parse({
    id: "admission-review-maximal",
    spec_id: SPEC_ID,
    gate: "execution_start",
    basis: "human_approval",
    approval_id: "approval-review-maximal",
    revision_id: REVISION_ID,
    execution_id: EXECUTION_ID,
    actor_json: JSON.stringify({
      kind: "human",
      accountId: "account-review-maximal",
      displayName: "Alex Reviewer",
    }),
    created_at: "2026-07-18T09:01:00.000Z",
  });
}

function maximalQuestion(): SpecQuestionRow {
  return specQuestionRowSchema.parse({
    id: "question-review-maximal",
    spec_id: SPEC_ID,
    number: 12,
    element_id: ELEMENT_ID,
    text: "Which delivery surface proves this criterion?",
    provenance_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-review-maximal",
      backend: "codex",
      sourceRevisionId: REVISION_ID,
    }),
    status: "answered",
    answer: "The Spec Studio evidence panel.",
    answered_at: "2026-07-18T09:03:00.000Z",
    created_at: "2026-07-18T09:02:00.000Z",
    updated_at: "2026-07-18T09:03:30.000Z",
  });
}

function maximalAssumption(): SpecAssumptionRow {
  return specAssumptionRowSchema.parse({
    id: "assumption-review-maximal",
    spec_id: SPEC_ID,
    number: 9,
    element_id: ELEMENT_ID,
    text: "The validator can resolve the linked workflow run.",
    proposed_by_json: JSON.stringify({
      kind: "agent",
      conversationId: "conversation-review-maximal",
      backend: "codex",
      source: { type: "question", number: 12 },
    }),
    disposition: "deferred",
    disposed_at: "2026-07-18T09:05:00.000Z",
    created_at: "2026-07-18T09:04:00.000Z",
    updated_at: "2026-07-18T09:05:30.000Z",
  });
}

function maximalComment(): SpecCommentRow {
  return specCommentRowSchema.parse({
    id: "comment-review-maximal",
    spec_id: SPEC_ID,
    thread_id: "thread-review-maximal",
    parent_comment_id: "comment-review-parent",
    element_id: ELEMENT_ID,
    anchor_json: JSON.stringify({
      sectionId: "requirements",
      line: 84,
      charStart: 6,
      charEnd: 41,
      quote: "Every gated transition is refused by the server",
      prefix: "The approved contract says ",
      suffix: " until its predicate passes.",
    }),
    revision_id: REVISION_ID,
    body: "Please connect this claim to the refusal response contract.",
    author_json: JSON.stringify({
      kind: "human",
      accountId: "account-review-maximal",
      displayName: "Alex Reviewer",
    }),
    blocking: 1,
    resolution: "dismissed",
    created_at: "2026-07-18T09:06:00.000Z",
    updated_at: "2026-07-18T09:07:00.000Z",
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedReviewParents();
  repo = createSpecReviewRepo(db);
  repo.saveApproval(maximalApproval());
  repo.saveComment(
    specCommentRowSchema.parse({
      ...maximalComment(),
      id: "comment-review-parent",
      parent_comment_id: null,
      body: "Parent review comment.",
    }),
  );
});

afterEach(() => {
  db.close();
});

describe("spec-review-repo durability contract", () => {
  it("round-trips every persisted review field and structured payload", async () => {
    await assertRoundTripDurability({
      label: "spec-approval",
      schema: specApprovalRowSchema,
      buildMaximalFixture: maximalApproval,
      persist: (fixture) => {
        repo.saveApproval(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findApprovalById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-gate-admission",
      schema: specGateAdmissionRowSchema,
      buildMaximalFixture: maximalGateAdmission,
      persist: (fixture) => {
        repo.insertGateAdmission(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findGateAdmissionById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-question",
      schema: specQuestionRowSchema,
      buildMaximalFixture: maximalQuestion,
      persist: (fixture) => {
        repo.saveQuestion(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findQuestionById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-assumption",
      schema: specAssumptionRowSchema,
      buildMaximalFixture: maximalAssumption,
      persist: (fixture) => {
        repo.saveAssumption(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findAssumptionById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-comment",
      schema: specCommentRowSchema,
      buildMaximalFixture: maximalComment,
      persist: (fixture) => {
        repo.saveComment(fixture);
        return fixture;
      },
      reload: (fixture) => repo.findCommentById(fixture.id),
    });

    expect(JSON.parse(maximalGateAdmission().actor_json)).toEqual({
      kind: "human",
      accountId: "account-review-maximal",
      displayName: "Alex Reviewer",
    });
    expect(JSON.parse(maximalComment().anchor_json)).toEqual({
      sectionId: "requirements",
      line: 84,
      charStart: 6,
      charEnd: 41,
      quote: "Every gated transition is refused by the server",
      prefix: "The approved contract says ",
      suffix: " until its predicate passes.",
    });
  });

  it.each(["valid", "stale", "closed"] as const)(
    "persists approval validity %s",
    (validity) => {
      const approval = maximalApproval();
      repo.saveApproval({ ...approval, validity });
      expect(repo.findApprovalById(approval.id)?.validity).toBe(validity);
    },
  );

  it("deletes an approval row durably", () => {
    const approval = maximalApproval();
    expect(repo.findApprovalById(approval.id)).not.toBeNull();

    repo.deleteApproval(approval.id);

    expect(repo.findApprovalById(approval.id)).toBeNull();
    expect(repo.findApprovalsBySpecId(SPEC_ID)).toEqual([]);
  });

  it.each(["proposed", "confirmed", "rejected", "deferred"] as const)(
    "persists assumption disposition %s",
    (disposition) => {
      const assumption = maximalAssumption();
      repo.saveAssumption({ ...assumption, disposition });
      expect(repo.findAssumptionById(assumption.id)?.disposition).toBe(
        disposition,
      );
    },
  );

  it("persists an import-basis admission that no approval row backs", () => {
    // An imported spec crosses its authoring gates on an external document's
    // word: the row records that provenance and deliberately carries no
    // approval id, so the storage layer has to accept the basis with a null
    // approval rather than only alongside a human grant.
    const imported = specGateAdmissionRowSchema.parse({
      ...maximalGateAdmission(),
      id: "admission-review-import",
      gate: "design",
      basis: "import",
      approval_id: null,
      execution_id: null,
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: "conversation-import",
      }),
    });

    repo.insertGateAdmission(imported);

    expect(repo.findGateAdmissionById(imported.id)).toEqual(imported);
  });

  it("reads every admission a spec ever recorded, across its revisions, in one query", () => {
    seedSecondRevision();
    seedForeignSpec();
    const onSecondRevision = specGateAdmissionRowSchema.parse({
      ...maximalGateAdmission(),
      id: "admission-review-second-revision",
      gate: "requirements",
      approval_id: null,
      revision_id: SECOND_REVISION_ID,
      execution_id: null,
      created_at: "2026-07-18T10:00:00.000Z",
    });
    const foreign = specGateAdmissionRowSchema.parse({
      ...maximalGateAdmission(),
      id: "admission-review-foreign",
      spec_id: FOREIGN_SPEC_ID,
      gate: "design",
      approval_id: null,
      revision_id: FOREIGN_REVISION_ID,
      execution_id: null,
      created_at: "2026-07-18T08:59:00.000Z",
    });
    repo.insertGateAdmission(maximalGateAdmission());
    repo.insertGateAdmission(onSecondRevision);
    repo.insertGateAdmission(foreign);

    const reloaded = repo.findGateAdmissionsBySpecId(SPEC_ID);

    expect(reloaded.map((admission) => admission.id)).toEqual([
      "admission-review-maximal",
      "admission-review-second-revision",
    ]);
    expect(reloaded[0]).toEqual(maximalGateAdmission());
    expect(repo.findGateAdmissionsBySpecId(FOREIGN_SPEC_ID)).toEqual([foreign]);
  });
});
