import { describe, expect, it } from "vitest";

import {
  notRunningCaptureRefusal,
  rePinnedCaptureRefusal,
} from "./execution-service";
import { specExecutionRowSchema, type SpecExecutionRow } from "./schemas";

const WORKFLOW_EXECUTION_ID = "workflow-execution-1";
const SPEC_EXECUTION_ID = "execution-1";
const NOW = "2026-09-03T00:00:00.000Z";

function specExecution(
  overrides: Partial<SpecExecutionRow> = {},
): SpecExecutionRow {
  return specExecutionRowSchema.parse({
    id: SPEC_EXECUTION_ID,
    spec_id: "spec-1",
    revision_id: "revision-2",
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

function refusalText(
  result:
    | {
        ok: false;
        refusal: { unmetConditions: readonly string[]; instruction: string };
      }
    | { ok: true },
): string {
  if (result.ok) throw new Error("Expected a refusal");
  return [...result.refusal.unmetConditions, result.refusal.instruction].join(
    " ",
  );
}

/**
 * Both refusals are reached with a spec execution ROW in hand, so the tempting
 * id to print is `row.id` — the internal spec execution row id, which every
 * `--execution` input now refuses (design 3.5, D-B). A refusal that named it
 * would hand back an id the reader cannot retry with, which is exactly the
 * two-ids confusion this workstream removes.
 */
describe("capture refusals name only the addressable execution id", () => {
  it("names the workflow execution id when the run re-pins mid-capture", () => {
    const text = refusalText(
      rePinnedCaptureRefusal("native-sdd", "revision-1", specExecution()),
    );

    expect(text).toContain(`Execution ${WORKFLOW_EXECUTION_ID} re-pinned`);
    expect(text).toContain("revision-1");
    expect(text).toContain("revision-2");
    expect(text).not.toMatch(/(?<![\w-])execution-1(?![\w-])/);
  });

  it("falls back to the linked id, then to no id, rather than the row id", () => {
    const linked = refusalText(
      rePinnedCaptureRefusal(
        "native-sdd",
        "revision-1",
        specExecution({
          workflow_execution_id: null,
          linked_workflow_execution_id: "workflow-execution-linked",
        }),
      ),
    );
    expect(linked).toContain("Execution workflow-execution-linked re-pinned");

    const unlinked = refusalText(
      rePinnedCaptureRefusal(
        "native-sdd",
        "revision-1",
        specExecution({ workflow_execution_id: null }),
      ),
    );
    // No lane means no id an agent could pass, so the refusal states the fact
    // instead of substituting the one id it must never print.
    expect(unlinked).toContain("The run re-pinned");
    expect(unlinked).not.toMatch(/(?<![\w-])execution-1(?![\w-])/);
  });

  it("names the workflow execution id when the run is no longer running", () => {
    const text = refusalText(
      notRunningCaptureRefusal(
        "native-sdd",
        specExecution({ state: "abandoning" }),
      ),
    );

    expect(text).toContain(WORKFLOW_EXECUTION_ID);
    expect(text).not.toMatch(/(?<![\w-])execution-1(?![\w-])/);
  });
});
