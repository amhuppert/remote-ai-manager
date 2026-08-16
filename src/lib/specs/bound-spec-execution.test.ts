import { describe, expect, it } from "vitest";

import {
  resolveBoundSpecExecution,
  type BoundSpecExecutionReaders,
} from "./execution-service";
import {
  specExecutionBindingSnapshotV2Schema,
  type LinkedSpecExecutionBindingV2,
} from "./execution-binding";
import { specExecutionRowSchema, type SpecExecutionRow } from "./schemas";

const WORKFLOW_EXECUTION_ID = "wf-exec-1";
const SPEC_EXECUTION_ID = "spec-exec-1";
const PINNED_REVISION_ID = "revision-1";
const NOW = "2026-08-16T00:00:00.000Z";

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
  binding: LinkedSpecExecutionBindingV2 | null;
  execution: SpecExecutionRow | null;
}): BoundSpecExecutionReaders {
  return {
    bindingRepo: {
      findByWorkflowExecutionId: () => input.binding,
      requireByWorkflowExecutionId: () => {
        if (input.binding === null) {
          throw new Error(
            "requireByWorkflowExecutionId reached without a typed link",
          );
        }
        return input.binding;
      },
    },
    deliveryRepo: {
      findExecutionById: () => input.execution,
    },
  };
}

describe("resolveBoundSpecExecution", () => {
  it("resolves the execution the typed binding names", () => {
    const execution = specExecution();

    expect(
      resolveBoundSpecExecution(
        readers({ binding: linkedBinding(), execution }),
        WORKFLOW_EXECUTION_ID,
      ),
    ).toBe(execution);
  });

  it("refuses a run with no typed binding, whatever its row says", () => {
    // The retired shape: a spec execution row naming a saved workflow
    // definition and no binding. Correlating on that row alone was the legacy
    // reader the cutover removes — the readers this decision is given cannot
    // reach it, and without a binding nothing proves which candidate ran.
    const legacyRun = specExecution({
      workflow_definition_id: "definition-1",
      workflow_definition_revision: 3,
    });

    expect(
      resolveBoundSpecExecution(
        readers({ binding: null, execution: legacyRun }),
        WORKFLOW_EXECUTION_ID,
      ),
    ).toBeNull();
  });

  it("fails closed when the bound execution drifts from the binding", () => {
    expect(() =>
      resolveBoundSpecExecution(
        readers({
          binding: linkedBinding(),
          execution: specExecution({ revision_id: "revision-other" }),
        }),
        WORKFLOW_EXECUTION_ID,
      ),
    ).toThrow(/stale native-SDD execution link/);
  });
});
