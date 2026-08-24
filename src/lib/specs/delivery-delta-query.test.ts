import { describe, expect, it } from "vitest";

import {
  loadDeliveryDelta,
  type DeliveryDeltaQueryDeps,
} from "./delivery-delta-query";
import type {
  Spec,
  SpecCriterionDispositionRow,
  SpecDeliveryVerdictRow,
  SpecExecutionRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "./schemas";

const SPEC_ID = "spec-1";
const TS = "2026-08-07T00:00:00.000Z";

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
  const requirement = {
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
  };
  return {
    revision: {
      id: revisionId,
      specId: SPEC_ID,
      number: revisionNumber,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: `content-${revisionId}`,
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: TS,
      approvedAt: TS,
      externalDelivery: null,
      createdAt: TS,
    },
    assumptionCitations: [],
    elements: [
      requirement,
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

function execution(
  id: string,
  revisionId: string,
  overrides: Partial<SpecExecutionRow> = {},
): SpecExecutionRow {
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
    ...overrides,
  };
}

interface FakeState {
  snapshots: Record<string, SpecRevisionSnapshot>;
  executions: SpecExecutionRow[];
  dispositions: Record<string, SpecCriterionDispositionRow[]>;
  verdicts: SpecDeliveryVerdictRow[];
  waivers: SpecWaiverRow[];
}

function deps(state: FakeState): DeliveryDeltaQueryDeps {
  return {
    getRevisionSnapshot: (revisionId) =>
      Promise.resolve(state.snapshots[revisionId] ?? null),
    findExecutionsBySpecId: () => state.executions,
    findCriterionDispositionsByExecution: (executionId) =>
      state.dispositions[executionId] ?? [],
    findDeliveryVerdictsBySpecExecutionId: (executionId) =>
      state.verdicts.filter((row) => row.spec_execution_id === executionId),
    findExecutionBindingBySpecExecutionId: (executionId) => {
      const execution = state.executions.find((row) => row.id === executionId);
      if (
        execution?.workflow_execution_id === null ||
        execution === undefined
      ) {
        return null;
      }
      return {
        specExecutionId: execution.id,
        workflowExecutionId: execution.workflow_execution_id,
        binding: {
          schemaVersion: 2,
          candidateId: `candidate-${execution.id}`,
          candidateHash: `sha256:${"a".repeat(64)}`,
          pinnedRevisionId: execution.revision_id,
          dispositions: [],
          claims: [],
        },
        createdAt: TS,
      };
    },
    findWaiversByRevision: (revisionId) =>
      state.waivers.filter((row) => row.revision_id === revisionId),
  };
}

function baseState(): FakeState {
  return {
    snapshots: {
      "rev-1": snapshotOf("rev-1", 1, { "crit-1": "c1" }),
      "rev-2": snapshotOf("rev-2", 2, { "crit-1": "c1" }),
      "rev-3": snapshotOf("rev-3", 3, { "crit-1": "c1-changed" }),
    },
    executions: [
      execution("exec-old", "rev-1", {
        created_at: "2026-08-01T00:00:00.000Z",
        delivered_at: "2026-08-02T00:00:00.000Z",
      }),
      execution("exec-new", "rev-2", {
        created_at: "2026-08-03T00:00:00.000Z",
        delivered_at: "2026-08-04T00:00:00.000Z",
      }),
    ],
    dispositions: {
      "exec-old": [criterionDisposition("exec-old", "crit-1", "in_scope")],
      "exec-new": [criterionDisposition("exec-new", "crit-1", "in_scope")],
    },
    verdicts: [
      deliveryVerdict("crit-1", "exec-old"),
      deliveryVerdict("crit-1", "exec-new"),
    ],
    waivers: [],
  };
}

function snapshotFor(
  state: FakeState,
  revisionId: string,
): SpecRevisionSnapshot {
  const snapshot = state.snapshots[revisionId];
  if (snapshot === undefined) {
    throw new Error(`This fixture holds no snapshot for ${revisionId}.`);
  }
  return snapshot;
}

function criterionDisposition(
  executionId: string,
  criterionElementId: string,
  value: SpecCriterionDispositionRow["disposition"],
  overrides: Partial<SpecCriterionDispositionRow> = {},
): SpecCriterionDispositionRow {
  return {
    execution_id: executionId,
    criterion_element_id: criterionElementId,
    disposition: value,
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

function deliveryVerdict(
  criterionElementId: string,
  executionId: string,
): SpecDeliveryVerdictRow {
  return {
    id: `delivery-verdict-${criterionElementId}-${executionId}`,
    spec_execution_id: executionId,
    workflow_execution_id: `wfx-${executionId}`,
    candidate_id: `candidate-${executionId}`,
    candidate_hash: `sha256:${"a".repeat(64)}`,
    criterion_element_id: criterionElementId,
    satisfying_context_id: "authored-context-1",
    verdict_at: TS,
  };
}

describe("loadDeliveryDelta", () => {
  it("defaults to the most recently delivered execution", async () => {
    const state = baseState();
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.comparedExecution?.executionId).toBe("exec-new");
    expect(result.projection.base?.revisionId).toBe("rev-2");
    expect(result.projection.criteria[0]?.class).toBe("hard_stale");
  });

  it("compares against an explicitly selected execution", async () => {
    const state = baseState();
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
      sinceExecutionId: "exec-old",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.comparedExecution?.executionId).toBe("exec-old");
    expect(result.projection.base?.revisionId).toBe("rev-1");
  });

  it("refuses an unknown execution id and names the id and its remedy", async () => {
    const state = baseState();
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
      sinceExecutionId: "exec-missing",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("execution_not_found");
    expect(result.message).toContain("exec-missing");
    expect(result.message).toContain("cctl spec status native-sdd");
  });

  it("refuses when the compared execution's pinned revision cannot be read", async () => {
    const state = baseState();
    state.snapshots = { "rev-3": snapshotFor(state, "rev-3") };
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pinned_revision_unavailable");
    expect(result.message).toContain("rev-2");
    expect(result.message).toContain("exec-new");
  });

  it("projects every criterion as never-delivered when nothing has delivered yet", async () => {
    const state = baseState();
    state.executions = [
      execution("exec-running", "rev-2", {
        state: "running",
        delivered_at: null,
      }),
    ];
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.base).toBeNull();
    expect(result.projection.comparedExecution).toBeNull();
    expect(result.projection.criteria[0]?.class).toBe("never_delivered");
    expect(result.projection.counts.elements.added).toBe(2);
  });

  it("resolves a waiver through the disposition's waiver_id", async () => {
    const state = baseState();
    state.dispositions["exec-new"] = [
      criterionDisposition("exec-new", "crit-1", "waived", {
        waiver_id: "waiver-1",
      }),
    ];
    state.waivers = [
      {
        id: "waiver-1",
        spec_id: SPEC_ID,
        criterion_element_id: "crit-1",
        revision_id: "rev-2",
        reason: "Accepted risk.",
        waived_at: TS,
        stale: 0,
      },
    ];
    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.criteria[0]?.class).toBe("waived");
  });

  it("retains a current waiver accepted while the frozen disposition remains in-scope", async () => {
    const state = baseState();
    state.dispositions["exec-new"] = [
      criterionDisposition("exec-new", "crit-1", "in_scope"),
    ];
    state.verdicts = [];
    state.waivers = [
      {
        id: "waiver-current",
        spec_id: SPEC_ID,
        criterion_element_id: "crit-1",
        revision_id: "rev-2",
        reason: "Accepted during execution.",
        waived_at: TS,
        stale: 0,
      },
    ];

    const result = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.criteria[0]?.class).toBe("waived");
  });

  it("credits delivered_elsewhere only for an earlier merged delivery", async () => {
    const state = baseState();
    state.dispositions["exec-new"] = [
      criterionDisposition("exec-new", "crit-1", "delivered_elsewhere", {
        delivered_by_execution_id: "exec-old",
      }),
    ];
    state.dispositions["exec-old"] = [
      criterionDisposition("exec-old", "crit-1", "in_scope", {
        delivered_by_execution_id: "exec-old",
      }),
    ];
    state.snapshots["rev-3"] = snapshotOf("rev-3", 3, { "crit-1": "c1" });

    const credited = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });
    expect(credited.ok).toBe(true);
    if (!credited.ok) return;
    expect(credited.projection.criteria[0]?.class).toBe("delivered_and_fresh");

    // The gate's rule refuses a prior run that never delivered the criterion.
    state.dispositions["exec-old"] = [
      criterionDisposition("exec-old", "crit-1", "in_scope"),
    ];
    const refused = await loadDeliveryDelta(deps(state), {
      spec,
      currentApprovedSnapshot: snapshotFor(state, "rev-3"),
    });
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.projection.criteria[0]?.class).toBe("never_delivered");
  });
});
