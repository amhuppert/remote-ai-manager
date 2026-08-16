import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  PINNED_REVISION_ID,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { migrations } from "./index";
import type { StateMigration } from "./types";

const MIGRATION_NAME = "0028-retire-legacy-spec-executions";
let fixture: PersistenceFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function registered(): StateMigration {
  const migration = migrations.find((entry) => entry.name === MIGRATION_NAME);
  if (migration === undefined)
    throw new Error(`missing migration ${MIGRATION_NAME}`);
  return migration;
}

describe(MIGRATION_NAME, () => {
  it("normalizes stale delivery-plan graph fields when no legacy execution is active", async () => {
    fixture = createPersistenceFixture();
    seedDeliveryPlanParents(fixture.db);
    fixture.db
      .prepare("DELETE FROM spec_executions WHERE id = ?")
      .run("execution-delivery-plan-launched");
    fixture.db
      .prepare(
        `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
         draft_revision, content_json, proposed_snapshot_id, approval_json,
         prelaunch_json, launched_execution_id, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'draft', 1, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        "attempt-legacy-graph",
        SPEC_ID,
        PINNED_REVISION_ID,
        JSON.stringify({
          launch: null,
          binding: { dispositions: [], claims: [] },
          contexts: [{ contextId: "legacy" }],
          tasks: [],
          edges: [],
        }),
        "2026-08-15T00:00:00.000Z",
        "2026-08-15T00:00:00.000Z",
      );

    await registered().up({
      name: MIGRATION_NAME,
      context: { db: fixture.db, configDir: null },
    });

    expect(
      JSON.parse(
        (
          fixture.db
            .prepare(
              "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
            )
            .get("attempt-legacy-graph") as { content_json: string }
        ).content_json,
      ),
    ).toEqual({ launch: null, binding: { dispositions: [], claims: [] } });
  });

  it.each(["definition_review", "running", "abandoning"])(
    "refuses cutover without mutating an active %s legacy-linked execution",
    async (state) => {
      fixture = createPersistenceFixture();
      seedDeliveryPlanParents(fixture.db);
      fixture.db
        .prepare("DELETE FROM spec_executions WHERE id = ?")
        .run("execution-delivery-plan-launched");
      fixture.db
        .prepare(
          `INSERT INTO spec_executions (
         id, spec_id, revision_id, scope_json, state, execution_start_dial,
         workflow_definition_id, workflow_definition_revision,
         workflow_seed_source_json, workflow_execution_binding_json,
         workflow_execution_id, session_name, delivered_at, abandoned_reason,
         cleanup_phase, linked_workflow_execution_id, cleanup_last_error,
         cleanup_last_error_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'gate', ?, 3, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          "execution-legacy-definition",
          SPEC_ID,
          PINNED_REVISION_ID,
          JSON.stringify({
            selectedTaskIds: [],
            selectedCriterionIds: [],
            exclusionDispositions: [],
          }),
          state,
          "workflow-definition-legacy",
          JSON.stringify({
            kind: "saved-definition",
            id: "workflow-definition-legacy",
            revision: 3,
            tier: "project",
          }),
          "2026-08-15T00:00:00.000Z",
          "2026-08-15T00:00:00.000Z",
        );

      await expect(
        registered().up({
          name: MIGRATION_NAME,
          context: { db: fixture.db, configDir: null },
        }),
      ).rejects.toThrow("active legacy-linked native-SDD execution");

      expect(
        fixture.db
          .prepare(
            "SELECT state, workflow_definition_id, workflow_seed_source_json FROM spec_executions WHERE id = ?",
          )
          .get("execution-legacy-definition"),
      ).toMatchObject({
        state,
        workflow_definition_id: "workflow-definition-legacy",
        workflow_seed_source_json: JSON.stringify({
          kind: "saved-definition",
          id: "workflow-definition-legacy",
          revision: 3,
          tier: "project",
        }),
      });
    },
  );
});
