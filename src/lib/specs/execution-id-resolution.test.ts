import { describe, expect, it } from "vitest";

import type { BoundSpecExecutionReaders } from "./execution-service";
import {
  specExecutionBindingSnapshotV2Schema,
  type LinkedSpecExecutionBindingV2,
} from "./execution-binding";
import { resolveSpecExecutionByWorkflowId } from "./execution-id-resolution";
import { specExecutionRowSchema, type SpecExecutionRow } from "./schemas";

const WORKFLOW_EXECUTION_ID = "workflow-execution-1";
const SPEC_EXECUTION_ID = "execution-1";
const PINNED_REVISION_ID = "revision-1";
const NOW = "2026-09-03T00:00:00.000Z";

function specExecution(
  overrides: Partial<SpecExecutionRow> = {},
): SpecExecutionRow {
  return specExecutionRowSchema.parse({
    id: SPEC_EXECUTION_ID,
    spec_id: "spec-1",
    revision_id: PINNED_REVISION_ID,
    scope_json: "{}",
    state: "running",
    execution_start_dial: null,
    workflow_definition_id: null,
    workflow_definition_revision: null,
    workflow_seed_source_json: null,
    workflow_execution_binding_json: null,
    workflow_execution_id: WORKFLOW_EXECUTION_ID,
    session_name: "session",
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

function linkedBinding(): LinkedSpecExecutionBindingV2 {
  return {
    specExecutionId: SPEC_EXECUTION_ID,
    workflowExecutionId: WORKFLOW_EXECUTION_ID,
    binding: specExecutionBindingSnapshotV2Schema.parse({
      schemaVersion: 2,
      candidateId: "candidate-1",
      candidateHash: `sha256:${"a".repeat(64)}`,
      pinnedRevisionId: PINNED_REVISION_ID,
      dispositions: [],
      claims: [],
    }),
    createdAt: NOW,
  };
}

function readers(input: {
  bindingsByWorkflowId: Record<string, LinkedSpecExecutionBindingV2>;
  executionsById: Record<string, SpecExecutionRow>;
}): BoundSpecExecutionReaders {
  return {
    bindingRepo: {
      findByWorkflowExecutionId: (workflowExecutionId) =>
        input.bindingsByWorkflowId[workflowExecutionId] ?? null,
      requireByWorkflowExecutionId: (workflowExecutionId) => {
        const found = input.bindingsByWorkflowId[workflowExecutionId];
        if (found === undefined) {
          throw new Error("requireByWorkflowExecutionId reached with no link");
        }
        return found;
      },
    },
    deliveryRepo: {
      findExecutionById: (id) => input.executionsById[id] ?? null,
    },
  };
}

describe("resolveSpecExecutionByWorkflowId", () => {
  it("resolves the workflow execution id through the spec-execution binding", () => {
    const execution = specExecution();

    const resolved = resolveSpecExecutionByWorkflowId(
      readers({
        bindingsByWorkflowId: { [WORKFLOW_EXECUTION_ID]: linkedBinding() },
        executionsById: { [SPEC_EXECUTION_ID]: execution },
      }),
      WORKFLOW_EXECUTION_ID,
    );

    expect(resolved).toEqual({ ok: true, execution });
  });

  it("refuses a spec-side execution row id and names the workflow id to use", () => {
    const execution = specExecution();

    const resolved = resolveSpecExecutionByWorkflowId(
      readers({
        bindingsByWorkflowId: { [WORKFLOW_EXECUTION_ID]: linkedBinding() },
        executionsById: { [SPEC_EXECUTION_ID]: execution },
      }),
      SPEC_EXECUTION_ID,
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("a spec-side id was accepted");
    // D-B: one id. The refusal is typed so a transport can branch on it, and
    // it hands back the id that works rather than only naming the mistake.
    expect(resolved.refusal.code).toBe("spec_side_execution_id");
    expect(resolved.refusal.unmetConditions.join(" ")).toContain(
      SPEC_EXECUTION_ID,
    );
    expect(resolved.refusal.instruction).toContain(WORKFLOW_EXECUTION_ID);
  });

  it("refuses an id that is neither a bound workflow run nor a spec execution", () => {
    const resolved = resolveSpecExecutionByWorkflowId(
      readers({ bindingsByWorkflowId: {}, executionsById: {} }),
      "workflow-execution-absent",
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("an unknown id was accepted");
    expect(resolved.refusal.code).toBe("not_found");
    expect(resolved.refusal.unmetConditions.join(" ")).toContain(
      "workflow-execution-absent",
    );
  });

  it("refuses a spec execution that never launched a workflow run", () => {
    const neverLaunched = specExecution({
      id: "execution-parked",
      state: "definition_review",
      workflow_execution_id: null,
    });

    const resolved = resolveSpecExecutionByWorkflowId(
      readers({
        bindingsByWorkflowId: {},
        executionsById: { "execution-parked": neverLaunched },
      }),
      "execution-parked",
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("a spec-side id was accepted");
    expect(resolved.refusal.code).toBe("spec_side_execution_id");
    // Nothing to hand back: the refusal says so rather than inventing an id.
    expect(resolved.refusal.instruction).toContain("no workflow execution");
  });
});
