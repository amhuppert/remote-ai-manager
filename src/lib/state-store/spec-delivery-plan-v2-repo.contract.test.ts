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
  DELIVERY_PLAN_ENVELOPE_MAX_BYTES,
  canonicalDeliveryPlanCandidateBytes,
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanEnvelopeByteLength,
} from "@/lib/specs/delivery-plan";
import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import { deliveryPlanCandidateHash } from "@/lib/specs/delivery-plan-hash";
import {
  DeliveryPlanStatusConflictError,
  FinalizedDeliveryPlanApprovalIdentityMismatchError,
  StaleDeliveryPlanDraftError,
  type SpecDeliveryPlanRepo,
} from "./spec-delivery-plan-repo";
import {
  EARLIER_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  seedDeliveryPlanParents,
} from "./spec-delivery-plan-test-fixture";
import { _createTestDb } from "./state-db";

type Db = InstanceType<typeof Database>;

const AGENT = {
  kind: "agent",
  conversationId: "conversation-v2-repository",
  backend: "claude",
} as const;
const HUMAN = { kind: "human" } as const;

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

function openAttempt() {
  const document = maximalPlanDocument();
  return plans.open({
    attempt: {
      id: "attempt-v2-round-trip",
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: EARLIER_EXECUTION_ID,
      status: "draft",
      draft_revision: 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(document),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      created_at: "2026-08-15T09:00:00.000Z",
      updated_at: "2026-08-15T09:00:00.000Z",
    },
    occurredAt: "2026-08-15T09:00:00.000Z",
    actor: AGENT,
  });
}

describe("version-2 delivery-plan repository contract", () => {
  it("round-trips the maximal canonical envelope through CAS, one immutable proposal snapshot, approval, reopen, comments, and audit events", () => {
    const opened = openAttempt();
    const edited = maximalPlanDocument();
    edited.launch.name = "Edited maximal fixture launch";
    expect(edited.launch.definition.parameters).toContainEqual(
      expect.objectContaining({
        type: "enum",
        name: "fixture-mode",
        options: ["safe", "fast"],
      }),
    );
    expect(edited.launch.definition.prerequisites).toContainEqual(
      expect.objectContaining({
        kind: "skill",
        skill: "fixture-skill",
        backend: "codex",
      }),
    );
    expect(edited.launch.definition.parameters).toContainEqual(
      expect.objectContaining({
        type: "text",
        name: "fixture-notes",
        minLength: 1,
        maxLength: 200,
      }),
    );
    expect(edited.launch.definition.executionContexts).toContainEqual(
      expect.objectContaining({
        id: "fixture-context",
        placement: {
          lane: "fixture",
          mode: "owned",
          ownedPaths: ["src/fixture"],
        },
      }),
    );
    expect(edited.launch.definition.edges).toContainEqual(
      expect.objectContaining({ when: { else: true } }),
    );
    expect(edited.launch.definition.executionContexts).toContainEqual(
      expect.objectContaining({
        id: "fixture-followup",
        placement: { lane: "fixture-followup", mode: "readOnly" },
      }),
    );
    expect(edited.launch.definition.edges).toContainEqual(
      expect.objectContaining({
        when: {
          schema: {
            type: "object",
            properties: { result: { const: "persisted" } },
            required: ["result"],
          },
        },
      }),
    );

    const saved = plans.saveDraft({
      attemptId: opened.id,
      expectedDraftRevision: opened.draft_revision,
      document: edited,
      updatedAt: "2026-08-15T09:01:00.000Z",
    });
    const canonicalEdited = canonicalDeliveryPlanEnvelopeBytes(edited);
    expect(saved).toMatchObject({
      draft_revision: 2,
      content_json: canonicalEdited,
      pinned_revision_id: PINNED_REVISION_ID,
    });
    expect(JSON.parse(saved.content_json)).toEqual(edited);

    const beforeStaleWrite = plans.findAttemptById(opened.id);
    expect(() =>
      plans.saveDraft({
        attemptId: opened.id,
        expectedDraftRevision: opened.draft_revision,
        document: maximalPlanDocument(),
        updatedAt: "2026-08-15T09:02:00.000Z",
      }),
    ).toThrow(StaleDeliveryPlanDraftError);
    expect(plans.findAttemptById(opened.id)).toEqual(beforeStaleWrite);

    plans.addComment({
      comment: {
        id: "comment-v2-round-trip",
        attempt_id: opened.id,
        context_id: "fixture-context",
        body: "The maximal launch must remain byte-for-byte reviewable.",
        author_json: JSON.stringify(HUMAN),
        created_at: "2026-08-15T09:03:00.000Z",
      },
      actor: HUMAN,
    });

    const candidateRecord = deliveryPlanCandidateRecordSchema.parse({
      protocol: "native-sdd-delivery-candidate/v2",
      schemaVersion: 2,
      specId: SPEC_ID,
      attemptId: opened.id,
      candidateId: "candidate-v2-round-trip",
      pinnedRevisionId: PINNED_REVISION_ID,
      draftRevision: saved.draft_revision,
      document: {
        schemaVersion: 2,
        launch: finalizeDeliveryPlanLaunch({
          specId: SPEC_ID,
          specSlug: "delivery-plan",
          attemptId: opened.id,
          candidateId: "candidate-v2-round-trip",
          launch: edited.launch,
        }),
        binding: edited.binding,
      },
    });
    const candidateHash = deliveryPlanCandidateHash(candidateRecord);
    const proposed = plans.propose({
      attemptId: opened.id,
      expectedDraftRevision: saved.draft_revision,
      snapshotId: "snapshot-v2-round-trip",
      candidate: {
        record: candidateRecord,
        candidateHash,
      },
      proposedAt: "2026-08-15T09:04:00.000Z",
      actor: AGENT,
    });
    expect(proposed.snapshot).toMatchObject({
      id: "snapshot-v2-round-trip",
      attempt_id: opened.id,
      draft_revision: saved.draft_revision,
      candidate_id: "candidate-v2-round-trip",
      candidate_hash: candidateHash,
      content_json: canonicalDeliveryPlanCandidateBytes(candidateRecord),
      pinned_revision_id: PINNED_REVISION_ID,
    });
    expect(JSON.parse(proposed.snapshot.content_json)).toEqual(candidateRecord);

    const beforeStaleApproval = plans.findAttemptById(opened.id);
    expect(() =>
      plans.recordTransition({
        attemptId: opened.id,
        transition: {
          kind: "approve",
          candidateId: "candidate-v2-round-trip",
          candidateHash: `sha256:${"0".repeat(64)}`,
        },
        occurredAt: "2026-08-15T09:05:00.000Z",
        actor: HUMAN,
      }),
    ).toThrow(FinalizedDeliveryPlanApprovalIdentityMismatchError);
    expect(plans.findAttemptById(opened.id)).toEqual(beforeStaleApproval);

    const approved = plans.recordTransition({
      attemptId: opened.id,
      transition: {
        kind: "approve",
        candidateId: "candidate-v2-round-trip",
        candidateHash,
      },
      occurredAt: "2026-08-15T09:06:00.000Z",
      actor: HUMAN,
    });
    expect(approved.status).toBe("approved");
    expect(JSON.parse(approved.approval_json ?? "null")).toMatchObject({
      snapshotId: proposed.snapshot.id,
      candidateId: "candidate-v2-round-trip",
      candidateHash,
      approvedBy: HUMAN,
    });

    const reopened = plans.reopen({
      attemptId: opened.id,
      reopenedAt: "2026-08-15T09:07:00.000Z",
      actor: AGENT,
      reason: "Re-evaluate the approved authored launch.",
    });
    expect(reopened.attempt).toMatchObject({
      status: "draft",
      draft_revision: 3,
      proposed_snapshot_id: null,
      approval_json: null,
    });
    expect(reopened.invalidatedApproval).toEqual({
      snapshotId: proposed.snapshot.id,
      candidateHash,
    });
    const afterReopen = plans.findAttemptById(opened.id);
    expect(() =>
      plans.reopen({
        attemptId: opened.id,
        reopenedAt: "2026-08-15T09:08:00.000Z",
        actor: AGENT,
        reason: "This stale reopen must not change the draft.",
      }),
    ).toThrow(DeliveryPlanStatusConflictError);
    expect(plans.findAttemptById(opened.id)).toEqual(afterReopen);
    expect(plans.findSnapshotById(proposed.snapshot.id)).toEqual(
      proposed.snapshot,
    );
    expect(plans.findCommentsByAttemptId(opened.id)).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT event_type FROM spec_events WHERE spec_id = ? ORDER BY id ASC",
        )
        .all(SPEC_ID),
    ).toEqual(
      expect.arrayContaining([
        { event_type: "spec-delivery-plan-opened" },
        { event_type: "spec-delivery-plan-commented" },
        { event_type: "spec-delivery-plan-proposed" },
        { event_type: "spec-delivery-plan-transitioned" },
        { event_type: "spec-delivery-plan-reopened" },
      ]),
    );
  });

  it("refuses an over-limit envelope without changing the draft or writing a snapshot", () => {
    const opened = openAttempt();
    const overLimit = maximalPlanDocument();
    overLimit.launch.description = "x".repeat(DELIVERY_PLAN_ENVELOPE_MAX_BYTES);
    expect(deliveryPlanEnvelopeByteLength(overLimit)).toBeGreaterThan(
      DELIVERY_PLAN_ENVELOPE_MAX_BYTES,
    );

    expect(() =>
      plans.saveDraft({
        attemptId: opened.id,
        expectedDraftRevision: opened.draft_revision,
        document: overLimit,
        updatedAt: "2026-08-15T09:10:00.000Z",
      }),
    ).toThrow(/whole-envelope limit/);
    expect(plans.findAttemptById(opened.id)).toEqual(opened);
    expect(plans.findSnapshotsByAttemptId(opened.id)).toEqual([]);
  });
});
