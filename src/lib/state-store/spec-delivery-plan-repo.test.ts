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
import { deliveryPlanHash } from "@/lib/specs/delivery-plan-hash";
import type { SpecDeliveryPlanAttemptRow } from "@/lib/specs/schemas";
import { _createTestDb } from "./state-db";
import {
  DeliveryPlanAttemptNotFoundError,
  DeliveryPlanCandidateMismatchError,
  DeliveryPlanStatusConflictError,
  StaleDeliveryPlanDraftError,
  type ProposeDeliveryPlanResult,
  type SpecDeliveryPlanRepo,
} from "./spec-delivery-plan-repo";
import {
  candidateFor,
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  seedDeliveryPlanParents,
  EARLIER_EXECUTION_ID,
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  SPEC_ID,
  type DeliveryPlanTestRepos,
} from "./spec-delivery-plan-test-fixture";

type Db = InstanceType<typeof Database>;

const ATTEMPT_ID = "attempt-delivery-plan";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-delivery-plan",
  backend: "claude",
} as const;

let db: Db;
let repos: DeliveryPlanTestRepos;
let plans: SpecDeliveryPlanRepo;

function openAttempt(
  overrides: Partial<SpecDeliveryPlanAttemptRow> = {},
): SpecDeliveryPlanAttemptRow {
  return plans.open({
    attempt: {
      id: ATTEMPT_ID,
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
      created_at: "2026-08-07T09:00:00.000Z",
      updated_at: "2026-08-07T09:00:00.000Z",
      ...overrides,
    },
    occurredAt: "2026-08-07T09:00:00.000Z",
    actor: AGENT,
  });
}

function propose(
  expectedDraftRevision: number,
  snapshotId: string,
  candidateOverrides: { readonly id?: string } = {},
) {
  return plans.propose({
    attemptId: ATTEMPT_ID,
    expectedDraftRevision,
    snapshotId,
    proposedAt: "2026-08-07T10:00:00.000Z",
    actor: AGENT,
    candidate: candidateFor(maximalPlanDocument(), {
      draftRevision: expectedDraftRevision,
      id: candidateOverrides.id ?? `candidate-${snapshotId}`,
    }),
  });
}

/**
 * The candidate identity a proposal stored. Every status transition states it,
 * so the transaction can refuse one aimed at bytes the attempt no longer
 * carries (`exact-approval`).
 */
function identity(result: ProposeDeliveryPlanResult) {
  return {
    candidateId: result.candidate.id,
    planHash: result.snapshot.plan_hash,
    compiledDefinitionHash: result.candidate.compiled_definition_hash,
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
  repos = createDeliveryPlanTestRepos(db);
  plans = repos.plans;
});

afterEach(() => {
  db.close();
});

describe("delivery plan attempt drafts", () => {
  it("opens an attempt keyed independently of its revision and execution", () => {
    const attempt = openAttempt();

    expect(attempt.status).toBe("draft");
    expect(attempt.draft_revision).toBe(1);
    expect(plans.findAttemptById(ATTEMPT_ID)).toEqual(attempt);
    expect(plans.findAttemptsBySpecId(SPEC_ID).map(({ id }) => id)).toEqual([
      ATTEMPT_ID,
    ]);
    expect(repos.countEvents("spec-delivery-plan-opened")).toBe(1);
  });

  it("advances the draft revision on every accepted edit", () => {
    openAttempt();
    const document = maximalPlanDocument();

    const saved = plans.saveDraft({
      attemptId: ATTEMPT_ID,
      expectedDraftRevision: 1,
      document: { ...document, touchedSurfaces: ["src/cli/"] },
      updatedAt: "2026-08-07T09:05:00.000Z",
    });

    expect(saved.draft_revision).toBe(2);
    expect(JSON.parse(saved.content_json)).toMatchObject({
      touchedSurfaces: ["src/cli/"],
    });
  });

  it("refuses a stale draft revision and names the current one", () => {
    openAttempt();
    plans.saveDraft({
      attemptId: ATTEMPT_ID,
      expectedDraftRevision: 1,
      document: maximalPlanDocument(),
      updatedAt: "2026-08-07T09:05:00.000Z",
    });

    let caught: unknown;
    try {
      plans.saveDraft({
        attemptId: ATTEMPT_ID,
        expectedDraftRevision: 1,
        document: maximalPlanDocument(),
        updatedAt: "2026-08-07T09:06:00.000Z",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleDeliveryPlanDraftError);
    const conflict = caught as StaleDeliveryPlanDraftError;
    expect(conflict.currentDraftRevision).toBe(2);
    expect(conflict.expectedDraftRevision).toBe(1);
    expect(conflict.message).toContain("2");
    expect(conflict.message).toContain(ATTEMPT_ID);
  });

  it("refuses an edit to an attempt that does not exist", () => {
    expect(() =>
      plans.saveDraft({
        attemptId: "attempt-missing",
        expectedDraftRevision: 1,
        document: maximalPlanDocument(),
        updatedAt: "2026-08-07T09:05:00.000Z",
      }),
    ).toThrow(DeliveryPlanAttemptNotFoundError);
  });

  it("refuses an edit once the attempt is no longer a draft", () => {
    openAttempt();
    propose(1, "snapshot-1");

    expect(() =>
      plans.saveDraft({
        attemptId: ATTEMPT_ID,
        expectedDraftRevision: 1,
        document: maximalPlanDocument(),
        updatedAt: "2026-08-07T10:05:00.000Z",
      }),
    ).toThrow(DeliveryPlanStatusConflictError);
  });
});

describe("delivery plan propose", () => {
  it("freezes an immutable snapshot with a plan hash in one transaction", () => {
    const opened = openAttempt();

    const { attempt, snapshot } = propose(opened.draft_revision, "snapshot-1");

    expect(attempt.status).toBe("proposed");
    expect(attempt.proposed_snapshot_id).toBe("snapshot-1");
    expect(snapshot.plan_hash).toBe(
      deliveryPlanHash({
        pinnedRevisionId: PINNED_REVISION_ID,
        draftRevision: opened.draft_revision,
        document: maximalPlanDocument(),
      }),
    );
    expect(snapshot.content_json).toBe(opened.content_json);
    expect(plans.findSnapshotById("snapshot-1")).toEqual(snapshot);
    expect(repos.readEventPayload("spec-delivery-plan-proposed")).toMatchObject(
      {
        attemptId: ATTEMPT_ID,
        snapshotId: "snapshot-1",
        planHash: snapshot.plan_hash,
      },
    );
  });

  it("refuses a propose at a stale draft revision", () => {
    openAttempt();
    plans.saveDraft({
      attemptId: ATTEMPT_ID,
      expectedDraftRevision: 1,
      document: maximalPlanDocument(),
      updatedAt: "2026-08-07T09:05:00.000Z",
    });

    expect(() => propose(1, "snapshot-1")).toThrow(StaleDeliveryPlanDraftError);
    expect(repos.countEvents("spec-delivery-plan-proposed")).toBe(0);
    expect(plans.findSnapshotById("snapshot-1")).toBeNull();
  });

  it("refuses a second propose while a proposal is live", () => {
    openAttempt();
    propose(1, "snapshot-1");

    expect(() => propose(1, "snapshot-2")).toThrow(
      DeliveryPlanStatusConflictError,
    );
  });

  it("persists the compiled candidate in the same transaction as the snapshot", () => {
    const opened = openAttempt();

    const { snapshot, candidate } = propose(
      opened.draft_revision,
      "snapshot-1",
    );

    expect(candidate.snapshot_id).toBe(snapshot.id);
    expect(candidate.attempt_id).toBe(ATTEMPT_ID);
    expect(plans.findCandidateBySnapshotId("snapshot-1")).toEqual(candidate);
    expect(plans.findCandidatesByAttemptId(ATTEMPT_ID)).toEqual([candidate]);
    expect(repos.readEventPayload("spec-delivery-plan-proposed")).toMatchObject(
      {
        candidateId: candidate.id,
        compiledDefinitionHash: candidate.compiled_definition_hash,
      },
    );
  });

  it("holds at most one candidate per proposed snapshot", () => {
    openAttempt();
    propose(1, "snapshot-1");

    expect(() =>
      db
        .prepare(
          `INSERT INTO spec_delivery_plan_candidates (
             id, attempt_id, snapshot_id, compiled_definition_hash,
             definition_json, materialized_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "candidate-second",
          ATTEMPT_ID,
          "snapshot-1",
          `sha256:${"d".repeat(64)}`,
          "{}",
          "2026-08-07T10:05:00.000Z",
        ),
    ).toThrow(/UNIQUE/);
  });

  it("rolls the snapshot back when the candidate write fails inside the commit boundary", () => {
    openAttempt();
    const first = propose(1, "snapshot-1", { id: "candidate-1" });
    plans.reopen({
      attemptId: ATTEMPT_ID,
      reopenedAt: "2026-08-07T11:00:00.000Z",
      actor: { kind: "human" },
      reason: "The delta basis moved.",
    });

    // Re-using the first candidate's id makes the snapshot insert succeed and
    // the candidate insert fail on the primary key. Nothing else observes that
    // the two writes share one commit boundary rather than merely running in
    // order: a snapshot left behind here would be a proposal with no bytes an
    // approval could bind to.
    expect(() => propose(2, "snapshot-2", { id: "candidate-1" })).toThrow(
      /UNIQUE|constraint/i,
    );

    expect(plans.findSnapshotById("snapshot-2")).toBeNull();
    expect(plans.findSnapshotsByAttemptId(ATTEMPT_ID)).toEqual([
      first.snapshot,
    ]);
    expect(plans.findCandidatesByAttemptId(ATTEMPT_ID)).toEqual([
      first.candidate,
    ]);
    expect(repos.countEvents("spec-delivery-plan-proposed")).toBe(1);
    const attempt = plans.findAttemptById(ATTEMPT_ID);
    expect(attempt?.status).toBe("draft");
    expect(attempt?.proposed_snapshot_id).toBeNull();
  });

  it("writes neither snapshot nor candidate when the candidate answers to another document", () => {
    const opened = openAttempt();

    expect(() =>
      plans.propose({
        attemptId: ATTEMPT_ID,
        expectedDraftRevision: opened.draft_revision,
        snapshotId: "snapshot-1",
        proposedAt: "2026-08-07T10:00:00.000Z",
        actor: AGENT,
        candidate: candidateFor(maximalPlanDocument(), {
          // A different draft revision means a different plan identity, which
          // is precisely the drift the repository refuses to store.
          draftRevision: opened.draft_revision + 1,
        }),
      }),
    ).toThrow(DeliveryPlanCandidateMismatchError);
    expect(plans.findSnapshotById("snapshot-1")).toBeNull();
    expect(plans.findCandidatesByAttemptId(ATTEMPT_ID)).toEqual([]);
    expect(repos.countEvents("spec-delivery-plan-proposed")).toBe(0);
    expect(plans.findAttemptById(ATTEMPT_ID)?.status).toBe("draft");
  });
});

describe("delivery plan reopen", () => {
  it.each(["proposed", "approved", "parked"] as const)(
    "returns a %s attempt to draft with a new draft revision",
    (status) => {
      openAttempt();
      const proposed = propose(1, "snapshot-1");
      if (status !== "proposed") {
        plans.recordTransition({
          attemptId: ATTEMPT_ID,
          transition:
            status === "approved"
              ? { kind: "approve", ...identity(proposed) }
              : { kind: "park", reason: null, ...identity(proposed) },
          occurredAt: "2026-08-07T10:30:00.000Z",
          actor: { kind: "human" },
        });
      }

      const reopened = plans.reopen({
        attemptId: ATTEMPT_ID,
        reopenedAt: "2026-08-07T11:00:00.000Z",
        actor: { kind: "human" },
        reason: "The delta basis moved.",
      });

      expect(reopened.attempt.status).toBe("draft");
      expect(reopened.attempt.draft_revision).toBe(2);
      expect(reopened.attempt.proposed_snapshot_id).toBeNull();
      expect(reopened.attempt.approval_json).toBeNull();
      // Prior snapshots stay readable exactly as they were proposed.
      expect(plans.findSnapshotById("snapshot-1")).toEqual(proposed.snapshot);
      expect(repos.countEvents("spec-delivery-plan-reopened")).toBe(1);
    },
  );

  it("invalidates the approval so the next propose needs a new one", () => {
    openAttempt();
    const first = propose(1, "snapshot-1");
    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: { kind: "approve", ...identity(first) },
      occurredAt: "2026-08-07T10:30:00.000Z",
      actor: { kind: "human" },
    });

    const reopened = plans.reopen({
      attemptId: ATTEMPT_ID,
      reopenedAt: "2026-08-07T11:00:00.000Z",
      actor: { kind: "human" },
      reason: "A criterion moved.",
    });
    const second = propose(reopened.attempt.draft_revision, "snapshot-2");

    expect(reopened.invalidatedApproval).toEqual({
      snapshotId: "snapshot-1",
      planHash: first.snapshot.plan_hash,
    });
    // Same content, new plan identity: the approval covered the first
    // proposal's draft revision and cannot carry to the second.
    expect(second.snapshot.plan_hash).not.toBe(first.snapshot.plan_hash);
    expect(second.attempt.status).toBe("proposed");
    expect(second.attempt.approval_json).toBeNull();
  });

  it("refuses a launched attempt and names the three post-launch paths", () => {
    openAttempt();
    const proposed = propose(1, "snapshot-1");
    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: { kind: "approve", ...identity(proposed) },
      occurredAt: "2026-08-07T10:29:00.000Z",
      actor: { kind: "human" },
    });
    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: {
        kind: "launch",
        executionId: LAUNCHED_EXECUTION_ID,
        ...identity(proposed),
      },
      occurredAt: "2026-08-07T10:30:00.000Z",
      actor: { kind: "human" },
    });

    let caught: unknown;
    try {
      plans.reopen({
        attemptId: ATTEMPT_ID,
        reopenedAt: "2026-08-07T11:00:00.000Z",
        actor: { kind: "human" },
        reason: "Too late.",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeliveryPlanStatusConflictError);
    const refusal = caught as DeliveryPlanStatusConflictError;
    expect(refusal.message).toContain(LAUNCHED_EXECUTION_ID);
    // The blocking arm of `spec capture` IS the abandon-and-replan path
    // (design §11), so the three the refusal names are the two capture forms
    // and the audited live amendment.
    expect(refusal.message).toContain("spec capture");
    expect(refusal.message).toContain("--blocking-reason <why>");
    expect(refusal.message).toContain("workflow live amend");
  });

  it("refuses an attempt that is already a draft and names the edit verb", () => {
    openAttempt();

    let caught: unknown;
    try {
      plans.reopen({
        attemptId: ATTEMPT_ID,
        reopenedAt: "2026-08-07T11:00:00.000Z",
        actor: { kind: "human" },
        reason: "Nothing to reopen.",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeliveryPlanStatusConflictError);
    expect((caught as Error).message).toContain("spec plan edit");
    expect(repos.countEvents("spec-delivery-plan-reopened")).toBe(0);
  });
});

describe("delivery plan transitions", () => {
  it("records the approval the exact-approval invariant pins", () => {
    openAttempt();
    const proposed = propose(1, "snapshot-1");

    const approved = plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: { kind: "approve", ...identity(proposed) },
      occurredAt: "2026-08-07T10:30:00.000Z",
      actor: { kind: "human" },
    });

    expect(approved.status).toBe("approved");
    expect(JSON.parse(approved.approval_json ?? "null")).toMatchObject({
      snapshotId: "snapshot-1",
      ...identity(proposed),
      approvedAt: "2026-08-07T10:30:00.000Z",
      approvedBy: { kind: "human" },
    });
    expect(
      repos.readEventPayload("spec-delivery-plan-transitioned"),
    ).toMatchObject({
      attemptId: ATTEMPT_ID,
      to: "approved",
      transition: { kind: "approve", ...identity(proposed) },
    });
  });

  it("refuses an approval aimed at compiled bytes the attempt does not carry", () => {
    openAttempt();
    const proposed = propose(1, "snapshot-1");

    expect(() =>
      plans.recordTransition({
        attemptId: ATTEMPT_ID,
        transition: {
          kind: "approve",
          ...identity(proposed),
          compiledDefinitionHash: `sha256:${"9".repeat(64)}`,
        },
        occurredAt: "2026-08-07T10:30:00.000Z",
        actor: { kind: "human" },
      }),
    ).toThrow(/cctl spec plan propose/);
    expect(plans.findAttemptById(ATTEMPT_ID)?.status).toBe("proposed");
    expect(plans.findAttemptById(ATTEMPT_ID)?.approval_json).toBeNull();
  });

  it("leaves the frozen snapshot untouched when the approval is recorded", () => {
    openAttempt();
    const proposed = propose(1, "snapshot-1");

    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: { kind: "approve", ...identity(proposed) },
      occurredAt: "2026-08-07T10:30:00.000Z",
      actor: { kind: "human" },
    });

    expect(plans.findSnapshotById("snapshot-1")).toEqual(proposed.snapshot);
  });

  it("keeps the prelaunch record through a reopen so a later refusal can name the parked hash", () => {
    openAttempt();
    const proposed = propose(1, "snapshot-1");
    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: { kind: "approve", ...identity(proposed) },
      occurredAt: "2026-08-07T10:30:00.000Z",
      actor: { kind: "human" },
    });
    plans.recordTransition({
      attemptId: ATTEMPT_ID,
      transition: {
        kind: "park",
        reason: "Reviewing the closeout context first.",
        ...identity(proposed),
      },
      occurredAt: "2026-08-07T10:40:00.000Z",
      actor: { kind: "human" },
    });

    const reopened = plans.reopen({
      attemptId: ATTEMPT_ID,
      reopenedAt: "2026-08-07T11:00:00.000Z",
      actor: { kind: "human" },
      reason: "Tune the parked plan.",
    });

    expect(reopened.attempt.approval_json).toBeNull();
    expect(JSON.parse(reopened.attempt.prelaunch_json ?? "null")).toMatchObject(
      {
        candidate: identity(proposed),
        approvedAtPark: true,
        reason: "Reviewing the closeout context first.",
      },
    );
  });

  it("keeps every snapshot of an attempt readable in draft-revision order", () => {
    openAttempt();
    const first = propose(1, "snapshot-1");
    const reopened = plans.reopen({
      attemptId: ATTEMPT_ID,
      reopenedAt: "2026-08-07T11:00:00.000Z",
      actor: { kind: "human" },
      reason: "Revise.",
    });
    const second = propose(reopened.attempt.draft_revision, "snapshot-2");

    expect(plans.findSnapshotsByAttemptId(ATTEMPT_ID)).toEqual([
      first.snapshot,
      second.snapshot,
    ]);
  });
});
