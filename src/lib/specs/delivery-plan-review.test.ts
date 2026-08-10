import { describe, expect, it } from "vitest";

import type { DeliveryDeltaCriterion } from "./delivery-delta";
import { emptyDeliveryPlanDocument } from "./delivery-plan";
import type { DeliveryPlanDocument } from "./delivery-plan";
import { deliveryPlanReviewView } from "./delivery-plan-review";
import type { DeliveryPlanView } from "./delivery-plan-views";

const PINNED_CRITERIA = [
  { criterionElementId: "c-soft", handle: "R1.2", text: "Soft criterion." },
  { criterionElementId: "c-hard", handle: "R1.3", text: "Hard criterion." },
  { criterionElementId: "c-new", handle: "R2.1", text: "New criterion." },
] as const;

function deltaCriteria(): DeliveryDeltaCriterion[] {
  return [
    {
      criterionElementId: "c-soft",
      handle: "R1.2",
      class: "soft_stale",
      priorDisposition: "in_scope",
      freshness: {
        grade: "soft_stale",
        basis: [
          {
            elementId: "req-1",
            kind: "requirement",
            handle: "R1",
            reason: "parent_requirement",
            baseHash: "req-1-a",
            currentHash: "req-1-b",
          },
        ],
      },
    },
    {
      criterionElementId: "c-hard",
      handle: "R1.3",
      class: "hard_stale",
      priorDisposition: "in_scope",
      freshness: { grade: "hard_stale", basis: [] },
    },
    {
      criterionElementId: "c-new",
      handle: "R2.1",
      class: "never_delivered",
      priorDisposition: null,
      freshness: null,
    },
  ];
}

function document(): DeliveryPlanDocument {
  return {
    ...emptyDeliveryPlanDocument(),
    dispositions: [
      {
        criterionElementId: "c-soft",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "c-hard",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "c-new",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-a",
        title: "Deliver the hard one",
        contextType: "delivery",
        criterionElementIds: ["c-hard"],
        acceptanceContract: ["The hard criterion is observable."],
        proofPlan: [],
      },
      {
        contextId: "ctx-b",
        title: "Wire it together",
        contextType: "integration",
        criterionElementIds: [],
        acceptanceContract: ["The surfaces compose."],
        proofPlan: [],
      },
    ],
  };
}

function planView(doc: DeliveryPlanDocument): DeliveryPlanView {
  return {
    attempt: {
      id: "attempt-1",
      specSlug: "delivery-plan",
      status: "proposed",
      draftRevision: 3,
      pinnedRevisionId: "revision-pinned",
      deltaBasisExecutionId: "execution-earlier",
      proposedSnapshotId: "snapshot-1",
      planHash: "sha256:plan",
      compiledDefinitionHash: "sha256:compiled",
      candidateId: "candidate-1",
      launchedExecutionId: null,
      createdAt: "2026-08-08T10:00:00.000Z",
      updatedAt: "2026-08-08T10:01:00.000Z",
    },
    approval: null,
    prelaunch: null,
    document: doc,
    health: { total: 0, blocking: 0, counts: [], findings: [] },
    dispositionCounts: [],
    unresolved: [],
    snapshots: [],
    nextAct: {
      actor: "human",
      command: "cctl spec plan sign-off delivery-plan",
      reason: "The proposed candidate is awaiting sign-off.",
    },
    wiringByContext: [],
  };
}

describe("deliveryPlanReviewView", () => {
  it("resolves every pinned criterion to its full text, disposition, and delivery class", () => {
    const doc = document();

    const view = deliveryPlanReviewView({
      plan: planView(doc),
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: [],
    });

    expect(view.criteria).toEqual([
      {
        criterionElementId: "c-soft",
        handle: "R1.2",
        text: "Soft criterion.",
        disposition: "pending_reaffirmation",
        effectiveDisposition: "pending_reaffirmation",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
        deliveryClass: "soft_stale",
        freshness: deltaCriteria()[0]?.freshness ?? null,
        owningContextId: null,
      },
      {
        criterionElementId: "c-hard",
        handle: "R1.3",
        text: "Hard criterion.",
        disposition: "selected",
        effectiveDisposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
        deliveryClass: "hard_stale",
        freshness: { grade: "hard_stale", basis: [] },
        owningContextId: "ctx-a",
      },
      {
        criterionElementId: "c-new",
        handle: "R2.1",
        text: "New criterion.",
        disposition: "selected",
        effectiveDisposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
        deliveryClass: "never_delivered",
        freshness: null,
        owningContextId: null,
      },
    ]);
  });

  it("carries the plan view through unchanged so one projection owns both", () => {
    const doc = document();
    const plan = planView(doc);

    const view = deliveryPlanReviewView({
      plan,
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: [],
    });

    expect(view.attempt).toEqual(plan.attempt);
    expect(view.document).toEqual(plan.document);
    expect(view.nextAct).toEqual(plan.nextAct);
  });

  /**
   * A criterion the pinned revision carries but the plan never disposed is the
   * gap plan lint refuses at propose. The review surface has to show the row
   * anyway — a table that silently omits it would hide exactly the criterion a
   * reviewer needs to act on.
   */
  it("shows an undisposed pinned criterion rather than dropping the row", () => {
    const doc = document();
    doc.dispositions = doc.dispositions.filter(
      (entry) => entry.criterionElementId !== "c-new",
    );

    const view = deliveryPlanReviewView({
      plan: planView(doc),
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: [],
    });

    const row = view.criteria.find(
      (criterion) => criterion.criterionElementId === "c-new",
    );
    expect(row?.disposition).toBeNull();
  });

  /**
   * Ownership is resolved server-side because it is the rule the plan is held
   * to (exactly one context owns a selected criterion), not a lookup a table
   * should be re-deriving per row.
   */
  it("names the owning context of a criterion a context claims", () => {
    const doc = document();
    doc.contexts = [
      { ...doc.contexts[0]!, criterionElementIds: ["c-hard", "c-new"] },
      doc.contexts[1]!,
    ];

    const view = deliveryPlanReviewView({
      plan: planView(doc),
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: [],
    });

    expect(view.criteria.map((criterion) => criterion.owningContextId)).toEqual(
      [null, "ctx-a", "ctx-a"],
    );
  });

  const COMMENTS = [
    {
      id: "comment-live",
      contextId: "ctx-a",
      body: "Split this into two proofs.",
      author: { kind: "human" as const },
      createdAt: "2026-08-08T10:05:00.000Z",
    },
    {
      id: "comment-orphan",
      contextId: "ctx-gone",
      body: "Why does this context exist?",
      author: { kind: "human" as const },
      createdAt: "2026-08-08T10:06:00.000Z",
    },
  ];

  /**
   * A comment whose context a later edit removed is the case the anchor exists
   * for. Dropping it would silently discard reviewed work — the same dead end
   * ticket #50 reports one layer up.
   */
  it("marks a comment whose anchored context the document no longer carries", () => {
    const view = deliveryPlanReviewView({
      plan: planView(document()),
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: COMMENTS,
    });

    expect(
      view.comments.map((comment) => [comment.id, comment.orphaned]),
    ).toEqual([
      ["comment-live", false],
      ["comment-orphan", true],
    ]);
  });

  it("re-anchors a comment when a later document puts its context back", () => {
    const doc = document();
    doc.contexts = [
      ...doc.contexts,
      {
        contextId: "ctx-gone",
        title: "Restored",
        contextType: "integration",
        criterionElementIds: [],
        acceptanceContract: ["It composes."],
        proofPlan: [],
      },
    ];

    const view = deliveryPlanReviewView({
      plan: planView(doc),
      pinnedCriteria: PINNED_CRITERIA,
      deltaCriteria: deltaCriteria(),
      comments: COMMENTS,
    });

    expect(view.comments.every((comment) => !comment.orphaned)).toBe(true);
  });
});
