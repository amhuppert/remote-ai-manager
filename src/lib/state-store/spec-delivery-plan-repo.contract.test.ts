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
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  type DeliveryPlanDocument,
} from "@/lib/specs/delivery-plan";
import {
  discoveredTaskSchema,
  specDeliveryDiscoveryRowSchema,
  specDeliveryPlanAttemptRowSchema,
  specDeliveryPlanCandidateRowSchema,
  specDeliveryPlanCommentRowSchema,
  specDeliveryPlanSnapshotRowSchema,
  type DiscoveredTask,
  type SpecDeliveryPlanAttemptRow,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { stableStringify } from "./serialization";
import { _createTestDb } from "./state-db";
import type { SpecDeliveryPlanRepo } from "./spec-delivery-plan-repo";
import {
  candidateFor,
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  seedDeliveryPlanParents,
  EARLIER_EXECUTION_ID,
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
} from "./spec-delivery-plan-test-fixture";

type Db = InstanceType<typeof Database>;

const AGENT = {
  kind: "agent",
  conversationId: "conversation-delivery-plan-contract",
  backend: "codex",
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

/**
 * Every nullable column carries a value: a maximal fixture is the only way a
 * dropped column shows up, and a null would prove nothing about the write.
 */
function maximalAttempt(): SpecDeliveryPlanAttemptRow {
  return specDeliveryPlanAttemptRowSchema.parse({
    id: "attempt-delivery-plan-maximal",
    spec_id: SPEC_ID,
    pinned_revision_id: PINNED_REVISION_ID,
    delta_basis_execution_id: EARLIER_EXECUTION_ID,
    status: "launched",
    draft_revision: 4,
    content_json: JSON.stringify(maximalPlanDocument()),
    proposed_snapshot_id: "snapshot-delivery-plan-maximal",
    approval_json: JSON.stringify({
      snapshotId: "snapshot-delivery-plan-maximal",
      candidateId: "candidate-delivery-plan-maximal",
      planHash: `sha256:${"a".repeat(64)}`,
      compiledDefinitionHash: `sha256:${"c".repeat(64)}`,
      approvedAt: "2026-08-07T11:00:00.000Z",
      approvedBy: { kind: "human" },
    }),
    prelaunch_json: JSON.stringify({
      parkedAt: "2026-08-07T10:45:00.000Z",
      parkedBy: { kind: "human" },
      reason: "Reviewing the closeout context before launch.",
      candidate: {
        candidateId: "candidate-delivery-plan-maximal",
        planHash: `sha256:${"a".repeat(64)}`,
        compiledDefinitionHash: `sha256:${"c".repeat(64)}`,
      },
      approvedAtPark: true,
    }),
    launched_execution_id: LAUNCHED_EXECUTION_ID,
    created_at: "2026-08-07T09:00:00.000Z",
    updated_at: "2026-08-07T12:00:00.000Z",
  });
}

/** Every optional field populated, so a dropped one fails the round trip. */
function maximalDiscoveredTask(): DiscoveredTask {
  return discoveredTaskSchema.parse({
    title: "Carry the discovered prerequisite into the next plan",
    instructions: "The pinned run cannot absorb it; the next attempt owns it.",
    tracedRequirementElementIds: ["requirement-discovered"],
    tracedDecisionElementIds: ["decision-discovered"],
    coveredCriterionElementIds: ["criterion-selected"],
    dependsOnTaskElementIds: ["task-store"],
    laneGroup: "discovery",
    executionLane: "discovery-lane",
    touchedPaths: ["src/lib/specs"],
  });
}

function openDraft(
  id: string,
  document: DeliveryPlanDocument,
): SpecDeliveryPlanAttemptRow {
  return plans.open({
    attempt: specDeliveryPlanAttemptRowSchema.parse({
      id,
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: EARLIER_EXECUTION_ID,
      status: "draft",
      draft_revision: 1,
      content_json: JSON.stringify(document),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      created_at: "2026-08-07T09:00:00.000Z",
      updated_at: "2026-08-07T09:00:00.000Z",
    }),
    occurredAt: "2026-08-07T09:00:00.000Z",
    actor: AGENT,
  });
}

describe("spec delivery-plan persistence contract", () => {
  it("round-trips every persisted attempt, snapshot, and document field", async () => {
    await assertRoundTripDurability({
      label: "spec-delivery-plan-attempt",
      schema: specDeliveryPlanAttemptRowSchema,
      buildMaximalFixture: maximalAttempt,
      persist: (fixture) =>
        plans.open({
          attempt: fixture,
          occurredAt: "2026-08-07T09:00:00.000Z",
          actor: AGENT,
        }),
      reload: (fixture) => plans.findAttemptById(fixture.id),
    });

    await assertRoundTripDurability({
      label: "spec-delivery-plan-snapshot",
      schema: specDeliveryPlanSnapshotRowSchema,
      buildMaximalFixture: () =>
        specDeliveryPlanSnapshotRowSchema.parse({
          id: "snapshot-delivery-plan-frozen",
          attempt_id: "attempt-delivery-plan-frozen",
          draft_revision: 1,
          plan_hash: `sha256:${"b".repeat(64)}`,
          content_json: JSON.stringify(maximalPlanDocument()),
          pinned_revision_id: PINNED_REVISION_ID,
          proposed_at: "2026-08-07T10:00:00.000Z",
          proposed_by_json: JSON.stringify(AGENT),
        }),
      // The snapshot is only ever written by propose, so the propose result is
      // the expected persisted row — the hash and the frozen content come from
      // the attempt, not from the fixture.
      persist: (fixture) => {
        const attempt = openDraft(fixture.attempt_id, maximalPlanDocument());
        return plans.propose({
          attemptId: attempt.id,
          expectedDraftRevision: attempt.draft_revision,
          snapshotId: fixture.id,
          proposedAt: fixture.proposed_at,
          actor: AGENT,
          candidate: candidateFor(maximalPlanDocument(), {
            draftRevision: attempt.draft_revision,
          }),
        }).snapshot;
      },
      reload: (expected) => plans.findSnapshotById(expected.id),
      fieldPolicies: { plan_hash: "derived-on-write" },
    });

    await assertRoundTripDurability({
      label: "spec-delivery-plan-candidate",
      schema: specDeliveryPlanCandidateRowSchema,
      buildMaximalFixture: () =>
        specDeliveryPlanCandidateRowSchema.parse({
          id: "candidate-delivery-plan-frozen",
          attempt_id: "attempt-delivery-plan-candidate",
          snapshot_id: "snapshot-delivery-plan-candidate",
          compiled_definition_hash: `sha256:${"c".repeat(64)}`,
          definition_json: JSON.stringify({ schemaVersion: 1 }),
          materialized_at: "2026-08-07T10:00:00.000Z",
        }),
      // Like the snapshot, a candidate is only ever written by propose, so the
      // propose result is the expected persisted row.
      persist: (fixture) => {
        const attempt = openDraft(fixture.attempt_id, maximalPlanDocument());
        return plans.propose({
          attemptId: attempt.id,
          expectedDraftRevision: attempt.draft_revision,
          snapshotId: fixture.snapshot_id,
          proposedAt: fixture.materialized_at,
          actor: AGENT,
          candidate: candidateFor(maximalPlanDocument(), {
            draftRevision: attempt.draft_revision,
            id: fixture.id,
            compiledDefinitionHash: fixture.compiled_definition_hash,
          }),
        }).candidate;
      },
      reload: (expected) =>
        plans.findCandidateBySnapshotId(expected.snapshot_id),
      fieldPolicies: { definition_json: "derived-on-write" },
    });

    await assertRoundTripDurability({
      label: "spec-delivery-plan-document",
      schema: deliveryPlanDocumentSchema,
      buildMaximalFixture: maximalPlanDocument,
      // Opened empty on purpose: seeding the attempt with the same document
      // would let a `saveDraft` that wrote nothing still reload correctly.
      persist: (fixture) => {
        const attempt = openDraft(
          "attempt-delivery-plan-document",
          emptyDeliveryPlanDocument(),
        );
        plans.saveDraft({
          attemptId: attempt.id,
          expectedDraftRevision: attempt.draft_revision,
          document: fixture,
          updatedAt: "2026-08-07T09:30:00.000Z",
        });
        return fixture;
      },
      reload: () => {
        const attempt = plans.findAttemptById("attempt-delivery-plan-document");
        return attempt === null
          ? null
          : deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json));
      },
    });

    await assertRoundTripDurability({
      label: "spec-delivery-plan-comment",
      schema: specDeliveryPlanCommentRowSchema,
      buildMaximalFixture: () =>
        specDeliveryPlanCommentRowSchema.parse({
          id: "comment-delivery-plan-maximal",
          attempt_id: "attempt-delivery-plan-comment",
          context_id: "dpa-document",
          body: "The lint criterion belongs in its own context.",
          author_json: JSON.stringify({ kind: "human" }),
          created_at: "2026-08-07T11:30:00.000Z",
        }),
      persist: (fixture) => {
        openDraft(fixture.attempt_id, maximalPlanDocument());
        return plans.addComment({
          comment: fixture,
          actor: { kind: "human" },
        });
      },
      reload: (expected) =>
        plans
          .findCommentsByAttemptId(expected.attempt_id)
          .find((row) => row.id === expected.id) ?? null,
    });

    await assertRoundTripDurability({
      label: "spec-delivery-discovery",
      schema: specDeliveryDiscoveryRowSchema,
      buildMaximalFixture: () =>
        specDeliveryDiscoveryRowSchema.parse({
          id: "discovery-delivery-plan-maximal",
          spec_id: SPEC_ID,
          execution_id: LAUNCHED_EXECUTION_ID,
          attempt_id: "attempt-delivery-plan-discovery",
          pinned_revision_id: PINNED_REVISION_ID,
          discovered_task_json: JSON.stringify(maximalDiscoveredTask()),
          blocking_reason: "The pinned scope cannot absorb the prerequisite.",
          captured_by_json: JSON.stringify(AGENT),
          captured_at: "2026-08-07T13:00:00.000Z",
        }),
      persist: (fixture) => {
        openDraft("attempt-delivery-plan-discovery", maximalPlanDocument());
        return plans.recordDiscovery({
          discovery: fixture,
          eventType: "spec-execution-changed",
          actor: AGENT,
        }).discovery;
      },
      reload: (expected) =>
        plans
          .findDiscoveriesBySpecId(expected.spec_id)
          .find((row) => row.id === expected.id) ?? null,
    });

    await assertRoundTripDurability({
      label: "spec-delivery-discovery-task",
      schema: discoveredTaskSchema,
      buildMaximalFixture: maximalDiscoveredTask,
      persist: (fixture) => {
        plans.recordDiscovery({
          discovery: specDeliveryDiscoveryRowSchema.parse({
            id: "discovery-delivery-plan-payload",
            spec_id: SPEC_ID,
            execution_id: LAUNCHED_EXECUTION_ID,
            attempt_id: null,
            pinned_revision_id: PINNED_REVISION_ID,
            discovered_task_json: JSON.stringify(fixture),
            blocking_reason: null,
            captured_by_json: JSON.stringify(AGENT),
            captured_at: "2026-08-07T13:05:00.000Z",
          }),
          eventType: "spec-execution-changed",
          actor: AGENT,
        });
        return fixture;
      },
      reload: () => {
        const row = plans
          .findDiscoveriesBySpecId(SPEC_ID)
          .find((entry) => entry.id === "discovery-delivery-plan-payload");
        return row === undefined
          ? null
          : discoveredTaskSchema.parse(JSON.parse(row.discovered_task_json));
      },
    });
  });

  it("writes the discovery and its audit row in one transaction", () => {
    const { discovery } = plans.recordDiscovery({
      discovery: specDeliveryDiscoveryRowSchema.parse({
        id: "discovery-audited",
        spec_id: SPEC_ID,
        execution_id: LAUNCHED_EXECUTION_ID,
        attempt_id: null,
        pinned_revision_id: PINNED_REVISION_ID,
        discovered_task_json: JSON.stringify(maximalDiscoveredTask()),
        blocking_reason: null,
        captured_by_json: JSON.stringify(AGENT),
        captured_at: "2026-08-07T13:10:00.000Z",
      }),
      eventType: "spec-execution-changed",
      actor: AGENT,
    });

    const events = db
      .prepare(
        `SELECT payload_json FROM spec_events
         WHERE event_type = 'spec-execution-changed'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { payload_json: string } | undefined;
    expect(JSON.parse(events?.payload_json ?? "{}")).toMatchObject({
      kind: "discovery_captured",
      discoveryId: discovery.id,
      executionId: LAUNCHED_EXECUTION_ID,
    });
  });

  it("refuses a discovery whose execution does not exist and writes nothing", () => {
    expect(() =>
      plans.recordDiscovery({
        discovery: specDeliveryDiscoveryRowSchema.parse({
          id: "discovery-orphan",
          spec_id: SPEC_ID,
          execution_id: "execution-that-never-existed",
          attempt_id: null,
          pinned_revision_id: PINNED_REVISION_ID,
          discovered_task_json: JSON.stringify(maximalDiscoveredTask()),
          blocking_reason: null,
          captured_by_json: JSON.stringify(AGENT),
          captured_at: "2026-08-07T13:15:00.000Z",
        }),
        eventType: "spec-execution-changed",
        actor: AGENT,
      }),
    ).toThrow();

    expect(
      plans
        .findDiscoveriesBySpecId(SPEC_ID)
        .some((row) => row.id === "discovery-orphan"),
    ).toBe(false);
  });

  /**
   * The harness above proves no persisted key path is dropped; this proves the
   * stored COLUMN is byte-identical to the canonical serialization of what was
   * saved. Placement is the reason it is worth stating separately: a grade
   * flattened, an `ownedPaths` entry reordered, or a strict-union branch
   * silently re-parsed into a different one would still deep-equal on some
   * paths, but it would not produce the same bytes — and the bytes are what the
   * plan hash, and therefore the approval, is taken over.
   */
  it("stores a placement-bearing document as the exact canonical bytes it was given", () => {
    const document = maximalPlanDocument();
    expect(document.contexts.map((context) => context.placement?.mode)).toEqual(
      ["owned", "full", "readOnly"],
    );

    const attempt = openDraft(
      "attempt-delivery-plan-placement",
      emptyDeliveryPlanDocument(),
    );
    plans.saveDraft({
      attemptId: attempt.id,
      expectedDraftRevision: attempt.draft_revision,
      document,
      updatedAt: "2026-08-07T09:45:00.000Z",
    });

    const reloaded = plans.findAttemptById(attempt.id);
    expect(reloaded?.content_json).toBe(stableStringify(document));
  });

  it("keeps a frozen snapshot byte-identical to the draft it froze", () => {
    const document = maximalPlanDocument();
    const attempt = openDraft("attempt-delivery-plan-freeze", document);

    const { snapshot } = plans.propose({
      attemptId: attempt.id,
      expectedDraftRevision: attempt.draft_revision,
      snapshotId: "snapshot-delivery-plan-freeze",
      proposedAt: "2026-08-07T10:00:00.000Z",
      actor: AGENT,
      candidate: candidateFor(document, {
        draftRevision: attempt.draft_revision,
      }),
    });

    expect(
      deliveryPlanDocumentSchema.parse(JSON.parse(snapshot.content_json)),
    ).toEqual(document);
    expect(snapshot.pinned_revision_id).toBe(attempt.pinned_revision_id);
  });

  /**
   * A newer build sharing this database may store a document field this build
   * has not learned. The raw UPDATE is the only way to stage that: every repo
   * write parses the document first, which is exactly the per-attempt refusal
   * being characterised here. Listing must survive it, because
   * `findAttemptsBySpecId` is what a spec's plan list reads and a set-wide
   * failure is the blast radius that would have justified a schema-version
   * bump.
   */
  it("lists an attempt written with an unknown document field, and refuses only its document", () => {
    const attempt = openDraft(
      "attempt-delivery-plan-future",
      maximalPlanDocument(),
    );
    const [firstContext, ...restContexts] = maximalPlanDocument().contexts;
    if (firstContext === undefined) throw new Error("fixture lost its context");
    const futureContentJson = JSON.stringify({
      ...maximalPlanDocument(),
      contexts: [
        { ...firstContext, placement: { grade: "solo", lane: "lane-store" } },
        ...restContexts,
      ],
    });
    db.prepare(
      `UPDATE spec_delivery_plan_attempts SET content_json = ? WHERE id = ?`,
    ).run(futureContentJson, attempt.id);

    const listed = plans.findAttemptsBySpecId(SPEC_ID);
    const reloaded = listed.find((row) => row.id === attempt.id);
    expect(reloaded?.content_json).toBe(futureContentJson);
    expect(reloaded?.status).toBe("draft");

    expect(
      deliveryPlanDocumentSchema.safeParse(JSON.parse(futureContentJson))
        .success,
    ).toBe(false);
  });
});
