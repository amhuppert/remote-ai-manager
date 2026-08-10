import { emptyDeliveryPlanDocument } from "@/lib/specs/delivery-plan";
import type { DeliveryPlanDocument } from "@/lib/specs/delivery-plan";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";

/**
 * A delivery-plan attempt with one of every shape the review surface has to
 * render: a delivery context that owns criteria, a closeout context that owns
 * none, an edge between them, a soft-stale criterion awaiting reaffirmation,
 * and a hard-stale one. Shared by the Studio tests and stories so a surface
 * change is exercised against the same plan everywhere.
 */

export function reviewDocument(): DeliveryPlanDocument {
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
        criterionElementId: "c-done",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-earlier",
        reaffirmation: null,
        note: "Landed with the shadow migration.",
      },
    ],
    contexts: [
      {
        contextId: "dpa-document",
        title: "Attempt document and lint",
        contextType: "delivery",
        criterionElementIds: ["c-hard", "c-soft"],
        acceptanceContract: [
          "The attempt document persists with round-trip coverage.",
          "Plan lint refuses an undisposed criterion by handle.",
        ],
        proofPlan: [],
      },
      {
        contextId: "dpa-closeout",
        title: "Cutover verification",
        contextType: "closeout",
        criterionElementIds: [],
        acceptanceContract: ["The legacy launch branch is gone."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-schema",
        contextId: "dpa-document",
        title: "Persist the attempt",
        instructions: "Add the table, the mapping, and the round-trip test.",
        order: 0,
        contributesToCriterionElementIds: ["c-hard"],
      },
      {
        taskId: "task-lint",
        contextId: "dpa-document",
        title: "Refuse an undisposed criterion",
        instructions: "Name the handle and the disposing verb.",
        order: 1,
        contributesToCriterionElementIds: ["c-soft"],
      },
      {
        taskId: "task-cutover",
        contextId: "dpa-closeout",
        title: "Delete the legacy branch",
        instructions: "Remove the shim and its last caller.",
        order: 0,
        contributesToCriterionElementIds: [],
      },
    ],
    edges: [
      {
        edgeId: "dpa-document->dpa-closeout",
        fromContextId: "dpa-document",
        toContextId: "dpa-closeout",
      },
    ],
    governance: {
      mission: "Make the authored plan the executed graph.",
      charterInvariants: [
        { id: "exact-approval", statement: "Launch runs the approved bytes." },
      ],
      sourcesOfTruth: [],
      validationCommandNames: ["typecheck", "test"],
    },
  };
}

/**
 * `attempt` is partial on purpose: a case that only cares about the status
 * should not have to restate the identity of the attempt it is describing.
 */
export type ReviewViewOverrides = Partial<
  Omit<DeliveryPlanReviewView, "attempt">
> & { attempt?: Partial<DeliveryPlanReviewView["attempt"]> };

export function reviewView(
  overrides: ReviewViewOverrides = {},
): DeliveryPlanReviewView {
  const document = overrides.document ?? reviewDocument();
  const base: DeliveryPlanReviewView = {
    attempt: {
      id: "attempt-dpa-1",
      specSlug: "native-sdd",
      status: "proposed",
      draftRevision: 4,
      pinnedRevisionId: "revision-7",
      deltaBasisExecutionId: "execution-earlier",
      proposedSnapshotId: "snapshot-2",
      planHash: "sha256:plan-2",
      compiledDefinitionHash: "sha256:compiled-2",
      candidateId: "candidate-2",
      launchedExecutionId: null,
      createdAt: "2026-08-08T09:00:00.000Z",
      updatedAt: "2026-08-08T09:30:00.000Z",
    },
    approval: null,
    prelaunch: null,
    document,
    health: { total: 0, blocking: 0, counts: [], findings: [] },
    dispositionCounts: [
      { disposition: "selected", count: 1 },
      { disposition: "pending_reaffirmation", count: 1 },
      { disposition: "delivered_elsewhere", count: 1 },
    ],
    unresolved: [],
    snapshots: [
      {
        id: "snapshot-2",
        draftRevision: 4,
        planHash: "sha256:plan-2",
        proposedAt: "2026-08-08T09:30:00.000Z",
      },
    ],
    nextAct: {
      actor: "human",
      command: "cctl spec plan sign-off native-sdd",
      reason: "The proposed candidate is awaiting sign-off.",
    },
    wiringByContext: [
      {
        contextId: "dpa-document",
        entries: [
          "plan-lint — reached from the call site src/cli/commands/spec/plan.ts; covers c-soft",
        ],
      },
      { contextId: "dpa-closeout", entries: [] },
    ],
    criteria: [
      {
        criterionElementId: "c-soft",
        handle: "R2.1",
        text: "The attempt refuses an edit against a stale draft revision.",
        disposition: "pending_reaffirmation",
        effectiveDisposition: "pending_reaffirmation",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
        owningContextId: "dpa-document",
        deliveryClass: "soft_stale",
        freshness: {
          grade: "soft_stale",
          basis: [
            {
              elementId: "req-2",
              kind: "requirement",
              handle: "R2",
              reason: "parent_requirement",
              baseHash: "req-2-a",
              currentHash: "req-2-b",
            },
          ],
        },
      },
      {
        criterionElementId: "c-hard",
        handle: "R2.2",
        text: "The attempt document round-trips through the repository.",
        disposition: "selected",
        effectiveDisposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
        owningContextId: "dpa-document",
        deliveryClass: "hard_stale",
        freshness: { grade: "hard_stale", basis: [] },
      },
      {
        criterionElementId: "c-done",
        handle: "R3.1",
        text: "The shadow migration backfills every legacy attempt.",
        disposition: "delivered_elsewhere",
        effectiveDisposition: "delivered_elsewhere",
        deliveredByExecutionId: "execution-earlier",
        reaffirmation: null,
        note: "Landed with the shadow migration.",
        owningContextId: null,
        deliveryClass: "delivered_and_fresh",
        freshness: { grade: "fresh", basis: [] },
      },
    ],
    comments: [
      {
        id: "comment-live",
        contextId: "dpa-document",
        body: "Split the lint criterion out; two proofs, two contexts.",
        author: { kind: "human" },
        createdAt: "2026-08-08T09:40:00.000Z",
        orphaned: false,
      },
      {
        id: "comment-orphan",
        contextId: "dpa-prerequisite",
        body: "This prerequisite context never had an observable contract.",
        author: { kind: "human" },
        createdAt: "2026-08-08T09:41:00.000Z",
        orphaned: true,
      },
    ],
  };
  // Merged rather than spread wholesale so a case can override one attempt
  // field without restating the identity of the attempt it is describing.
  return {
    ...base,
    ...overrides,
    attempt: { ...base.attempt, ...overrides.attempt },
  };
}
