import { describe, expect, it } from "vitest";

import { loadDeliveryPlanSeedBasis } from "./delivery-plan-basis-query";
import type { DeliveryDeltaQueryDeps } from "./delivery-delta-query";
import type {
  Spec,
  SpecCriterionDispositionRow,
  SpecDeliveryVerdictRow,
  SpecExecutionRow,
  SpecRevisionSnapshot,
} from "./schemas";

const SPEC_ID = "spec-basis";
const TS = "2026-08-15T00:00:00.000Z";

const spec: Spec = {
  id: SPEC_ID,
  projectPath: "/repos/demo",
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: TS,
  updatedAt: TS,
};

function snapshotOf(
  revisionId: string,
  revisionNumber: number,
  criterionHashes: Readonly<Record<string, string>>,
): SpecRevisionSnapshot {
  return {
    revision: {
      id: revisionId,
      specId: SPEC_ID,
      number: revisionNumber,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: `content-${revisionId}`,
      proposedAt: TS,
      approvedAt: TS,
      externalDelivery: null,
      createdAt: TS,
    },
    elements: [
      {
        element: {
          id: "req-1",
          specId: SPEC_ID,
          kind: "requirement" as const,
          number: 1,
          parentElementId: null,
          createdAt: TS,
        },
        version: {
          revisionId,
          elementId: "req-1",
          position: 0,
          payload: {
            kind: "requirement" as const,
            statement: "The requirement",
            priority: "must" as const,
            risk: "high" as const,
          },
          payloadHash: "req-1-h1",
          elementVersion: 1,
          createdAt: TS,
          updatedAt: TS,
        },
      },
      ...Object.entries(criterionHashes).map(
        ([criterionId, payloadHash], index) => ({
          element: {
            id: criterionId,
            specId: SPEC_ID,
            kind: "criterion" as const,
            number: index + 1,
            parentElementId: "req-1",
            createdAt: TS,
          },
          version: {
            revisionId,
            elementId: criterionId,
            position: index + 1,
            payload: {
              kind: "criterion" as const,
              text: `Prove ${criterionId}`,
              validationStrategy: { kinds: ["test_run" as const] },
            },
            payloadHash,
            elementVersion: 1,
            createdAt: TS,
            updatedAt: TS,
          },
        }),
      ),
    ],
  };
}

function execution(id: string, revisionId: string): SpecExecutionRow {
  return {
    id,
    spec_id: SPEC_ID,
    revision_id: revisionId,
    scope_json: "{}",
    state: "delivered",
    execution_start_dial: null,
    workflow_definition_id: "wf-1",
    workflow_definition_revision: 1,
    workflow_execution_id: `wfx-${id}`,
    session_name: "session-1",
    delivered_at: TS,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: TS,
    updated_at: TS,
  };
}

function disposition(
  executionId: string,
  criterionElementId: string,
  value: SpecCriterionDispositionRow["disposition"],
  deliveredBy: string | null = null,
): SpecCriterionDispositionRow {
  return {
    execution_id: executionId,
    criterion_element_id: criterionElementId,
    disposition: value,
    waiver_id: null,
    delivered_by_execution_id: deliveredBy,
    created_at: TS,
    updated_at: TS,
  };
}

function verdict(
  criterionElementId: string,
  executionId: string,
): SpecDeliveryVerdictRow {
  return {
    id: `verdict-${criterionElementId}-${executionId}`,
    spec_execution_id: executionId,
    workflow_execution_id: `wfx-${executionId}`,
    candidate_id: `candidate-${executionId}`,
    candidate_hash: `sha256:${"a".repeat(64)}`,
    criterion_element_id: criterionElementId,
    satisfying_context_id: "authored-context-1",
    verdict_at: TS,
  };
}

const PINNED = snapshotOf("rev-2", 2, {
  "crit-proved": "c1",
  "crit-carried": "c2",
});

function deps(
  overrides: Partial<DeliveryDeltaQueryDeps> = {},
): DeliveryDeltaQueryDeps {
  const snapshots: Record<string, SpecRevisionSnapshot> = {
    "rev-1": snapshotOf("rev-1", 1, {
      "crit-proved": "c1",
      "crit-carried": "c2",
    }),
    "rev-2": PINNED,
  };
  return {
    getRevisionSnapshot: (revisionId) =>
      Promise.resolve(snapshots[revisionId] ?? null),
    findExecutionsBySpecId: () => [execution("exec-last", "rev-1")],
    findCriterionDispositionsByExecution: (executionId) =>
      executionId === "exec-last"
        ? [
            disposition("exec-last", "crit-proved", "in_scope"),
            disposition(
              "exec-last",
              "crit-carried",
              "delivered_elsewhere",
              "exec-ancient",
            ),
          ]
        : [disposition("exec-ancient", "crit-carried", "in_scope")],
    findDeliveryVerdictsBySpecExecutionId: (executionId) =>
      executionId === "exec-last" ? [verdict("crit-proved", "exec-last")] : [],
    // A verdict counts only through the immutable execution link, so the
    // fixture states the link the compared run actually launched under.
    findExecutionBindingBySpecExecutionId: (executionId) =>
      executionId === "exec-last"
        ? {
            specExecutionId: "exec-last",
            workflowExecutionId: "wfx-exec-last",
            binding: {
              schemaVersion: 2,
              candidateId: "candidate-exec-last",
              candidateHash: `sha256:${"a".repeat(64)}`,
              pinnedRevisionId: "rev-1",
              dispositions: [],
              claims: [],
            },
            createdAt: TS,
          }
        : null,
    findWaiversByRevision: () => [],
    ...overrides,
  };
}

describe("loadDeliveryPlanSeedBasis", () => {
  it("attributes each delivered criterion to the execution that proved it", async () => {
    const result = await loadDeliveryPlanSeedBasis(deps(), {
      spec,
      pinnedRevision: PINNED,
    });

    expect(result).toEqual({
      ok: true,
      basis: {
        comparedExecutionId: "exec-last",
        criteria: [
          {
            criterionElementId: "crit-proved",
            deliveryClass: "delivered_and_fresh",
            deliveredByExecutionId: "exec-last",
          },
          {
            criterionElementId: "crit-carried",
            deliveryClass: "never_delivered",
            deliveredByExecutionId: "exec-ancient",
          },
        ],
      },
    });
  });

  it("reports no basis when nothing has delivered", async () => {
    const result = await loadDeliveryPlanSeedBasis(
      deps({ findExecutionsBySpecId: () => [] }),
      { spec, pinnedRevision: PINNED },
    );

    expect(result).toEqual({
      ok: true,
      basis: { comparedExecutionId: null, criteria: [] },
    });
  });

  it("reports why an unreadable delta cannot seed", async () => {
    const result = await loadDeliveryPlanSeedBasis(
      deps({ getRevisionSnapshot: async () => null }),
      { spec, pinnedRevision: PINNED },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("exec-last");
  });
});
