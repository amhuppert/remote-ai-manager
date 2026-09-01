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
  specDeliveryPlanAttemptRowSchema,
  type SpecDeliveryPlanAttemptRow,
} from "@/lib/specs/schemas";

import {
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  seedDeliveryPlanParents,
  EARLIER_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
} from "./spec-delivery-plan-test-fixture";
import type { SpecDeliveryPlanRepo } from "./spec-delivery-plan-repo";
import { _createTestDb } from "./state-db";

type Db = InstanceType<typeof Database>;

const HUMAN = { kind: "human" } as const;
const AGENT = {
  kind: "agent",
  conversationId: "conversation-plan-comments",
  backend: "claude",
} as const;

let db: Db;
let plans: SpecDeliveryPlanRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
  plans = createDeliveryPlanTestRepos(db).plans;
});

afterEach(() => {
  db.close();
});

function openAttempt(id: string): SpecDeliveryPlanAttemptRow {
  return plans.open({
    attempt: specDeliveryPlanAttemptRowSchema.parse({
      id,
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: EARLIER_EXECUTION_ID,
      status: "draft",
      draft_revision: 1,
      content_json: JSON.stringify(maximalPlanDocument()),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      workflow_definition_id: null,
      created_at: "2026-08-08T09:00:00.000Z",
      updated_at: "2026-08-08T09:00:00.000Z",
    }),
    occurredAt: "2026-08-08T09:00:00.000Z",
    actor: AGENT,
  });
}

describe("delivery-plan comment persistence", () => {
  it("stores a comment against its attempt and context anchor", () => {
    const attempt = openAttempt("attempt-comments-1");

    plans.addComment({
      comment: {
        id: "comment-1",
        attempt_id: attempt.id,
        context_id: "dpa-document",
        body: "This context owns two criteria that need separate proofs.",
        author_json: JSON.stringify(HUMAN),
        created_at: "2026-08-08T09:10:00.000Z",
      },
      actor: HUMAN,
    });

    expect(plans.findCommentsByAttemptId(attempt.id)).toEqual([
      {
        id: "comment-1",
        attempt_id: attempt.id,
        context_id: "dpa-document",
        body: "This context owns two criteria that need separate proofs.",
        author_json: JSON.stringify(HUMAN),
        created_at: "2026-08-08T09:10:00.000Z",
      },
    ]);
  });

  /**
   * The anchor is a context id inside the plan document, not a foreign key: a
   * later edit that removes the context must leave the comment standing so the
   * review surface can show it as an orphan rather than losing the note.
   *
   * DEFERRED, by design: anchor survival across the full production
   * reopen → re-propose cycle is verified downstream in context `lock-reopen`,
   * which owns those transitions. What is proven here is the storage property
   * they rest on — a document edit never reaches the comment table.
   */
  it("keeps a comment whose anchored context no longer exists in the document", () => {
    const attempt = openAttempt("attempt-comments-2");
    plans.addComment({
      comment: {
        id: "comment-orphan",
        attempt_id: attempt.id,
        context_id: "ctx-removed",
        body: "Why does this context exist at all?",
        author_json: JSON.stringify(HUMAN),
        created_at: "2026-08-08T09:12:00.000Z",
      },
      actor: HUMAN,
    });

    plans.saveDraft({
      attemptId: attempt.id,
      expectedDraftRevision: attempt.draft_revision,
      document: maximalPlanDocument(),
      updatedAt: "2026-08-08T09:15:00.000Z",
    });

    expect(
      plans.findCommentsByAttemptId(attempt.id).map((row) => row.context_id),
    ).toEqual(["ctx-removed"]);
  });

  it("returns comments oldest first so a thread reads in order", () => {
    const attempt = openAttempt("attempt-comments-3");
    for (const [id, at] of [
      ["comment-late", "2026-08-08T10:00:00.000Z"],
      ["comment-early", "2026-08-08T09:00:00.000Z"],
    ] as const) {
      plans.addComment({
        comment: {
          id,
          attempt_id: attempt.id,
          context_id: "dpa-document",
          body: `Note ${id}.`,
          author_json: JSON.stringify(HUMAN),
          created_at: at,
        },
        actor: HUMAN,
      });
    }

    expect(
      plans.findCommentsByAttemptId(attempt.id).map((row) => row.id),
    ).toEqual(["comment-early", "comment-late"]);
  });

  it("writes the durable audit row in the same transaction as the comment", () => {
    const attempt = openAttempt("attempt-comments-4");
    plans.addComment({
      comment: {
        id: "comment-audited",
        attempt_id: attempt.id,
        context_id: "dpa-document",
        body: "Audited.",
        author_json: JSON.stringify(HUMAN),
        created_at: "2026-08-08T09:20:00.000Z",
      },
      actor: HUMAN,
    });

    const events = db
      .prepare(
        "SELECT event_type, payload_json FROM spec_events WHERE event_type = ?",
      )
      .all("spec-delivery-plan-commented") as {
      event_type: string;
      payload_json: string;
    }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({
      attemptId: attempt.id,
      contextId: "dpa-document",
      commentId: "comment-audited",
    });
  });
});
