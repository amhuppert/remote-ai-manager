import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "@/cli/core";
import type { CliEnv, CliHost } from "@/cli/shared";
import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import { deliveryPlanDocumentSchema } from "./delivery-plan";
import {
  deliveryPlanMutationViewSchema,
  type DeliveryPlanMutationView,
} from "./delivery-plan-views";
import {
  LEGACY_IMPORT_FIXTURES,
  seedLegacyImportFixture,
  type LegacyImportFixture,
} from "./legacy-import-fixtures";
import { LEGACY_UNMAPPED_CRITERION_NOTICE } from "./legacy-plan-render";
import {
  createSpecSpineWorld,
  SPINE_BEARER_TOKEN,
  SPINE_CONVERSATION_ID,
  SPINE_PROJECT_NAME,
  SPINE_PROJECT_PATH,
  SPINE_SESSION_NAME,
  type SpecSpineWorld,
} from "./spine-test-fixture";

/**
 * The production `spec plan open --seed-from last` path, driven end to end for
 * the two real specs that were delivered through the legacy compiled path:
 * `cctl` command implementation → spec action route → delivery-plan service →
 * importer → repository. Nothing here calls the importer directly, because the
 * behaviour under test is the DETECTION and the wiring, not the mapping — a
 * direct importer call would pass with the production caller unwired.
 */

const cliEnv: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: SPINE_BEARER_TOKEN,
  CC_PROJECT: SPINE_PROJECT_NAME,
  CC_SESSION: SPINE_SESSION_NAME,
  CC_CONVERSATION_ID: SPINE_CONVERSATION_ID,
};

function bridgeHost(world: SpecSpineWorld): CliHost {
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (
        segments[0] !== "api" ||
        segments[1] !== "specs" ||
        init.method !== "POST" ||
        segments[4] !== "actions"
      ) {
        throw new Error(
          `Unbridged CLI request: ${init.method} ${parsed.pathname}`,
        );
      }
      const request = new Request(`http://cc.test${parsed.pathname}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      return world.writeHandlers.specActionPOST(request, {
        params: Promise.resolve({
          name: segments[2] ?? "",
          slug: segments[3] ?? "",
          action: segments[5] ?? "",
        }),
      });
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

async function seededOpen(
  world: SpecSpineWorld,
  fixture: LegacyImportFixture,
): Promise<DeliveryPlanMutationView> {
  const response = await world.postAction(
    fixture.spec.slug,
    "plan-open",
    { seedFromLast: true },
    "agent",
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return deliveryPlanMutationViewSchema.parse(body);
}

describe("spec plan open --seed-from last over a legacy approved plan", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
    world = createSpecSpineWorld();
    for (const fixture of LEGACY_IMPORT_FIXTURES) {
      seedLegacyImportFixture(world.db, SPINE_PROJECT_PATH, fixture);
    }
  });

  afterEach(() => {
    _resetPublicationForTesting();
    resetJobQueue();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetDeliveryGateEvaluatorForTesting();
  });

  for (const fixture of LEGACY_IMPORT_FIXTURES) {
    describe(fixture.key, () => {
      it("detects the legacy delivery source and persists the imported draft attempt", async () => {
        const view = await seededOpen(world, fixture);

        expect(view.legacyImport?.sourceExecutionId).toBe(fixture.executionId);
        expect(view.legacyImport?.sourceRevisionId).toBe(
          fixture.snapshot.revision.id,
        );
        expect(view.attempt.status).toBe("draft");

        // The attempt is durable, not just reported: read the row back through
        // the repository the service wrote it with.
        const stored = world.repos.specs;
        expect(await stored.findById(fixture.spec.id)).not.toBeNull();
        const attempts = world.db
          .prepare(
            "SELECT content_json, status FROM spec_delivery_plan_attempts WHERE spec_id = ?",
          )
          .all(fixture.spec.id) as { content_json: string; status: string }[];
        expect(attempts).toHaveLength(1);
        const persisted = deliveryPlanDocumentSchema.parse(
          JSON.parse(attempts[0]!.content_json),
        );
        expect(persisted.contexts).toHaveLength(
          fixture.launchedDefinition.executionContexts.length,
        );
        expect(persisted.tasks).toHaveLength(
          fixture.launchedDefinition.tasks.length,
        );
        expect(persisted.edges).toHaveLength(
          fixture.launchedDefinition.edges.length,
        );
      });

      it("maps lane groups, singletons, dependencies, and criterion ownership out of the approved plan", async () => {
        const view = await seededOpen(world, fixture);
        const document = view.document;

        const selectedTaskIds = new Set(fixture.scope.selectedTaskIds);
        const laneGroups = new Set(
          fixture.snapshot.elements.flatMap(({ element, version }) =>
            version.payload.kind === "task" &&
            selectedTaskIds.has(element.id) &&
            version.payload.laneGroup !== undefined
              ? [version.payload.laneGroup]
              : [],
          ),
        );
        const ungrouped = fixture.snapshot.elements.filter(
          ({ element, version }) =>
            version.payload.kind === "task" &&
            selectedTaskIds.has(element.id) &&
            version.payload.laneGroup === undefined,
        );
        // One context per lane value plus one per ungrouped task — the whole
        // grouping law, checked against the revision rather than a constant.
        expect(document.contexts).toHaveLength(
          laneGroups.size + ungrouped.length,
        );
        expect(document.tasks).toHaveLength(selectedTaskIds.size);

        // Task order inside every context is contiguous from 0.
        for (const context of document.contexts) {
          const orders = document.tasks
            .filter((task) => task.contextId === context.contextId)
            .map((task) => task.order)
            .sort((left, right) => left - right);
          expect(orders).toEqual(orders.map((_unused, index) => index));
        }

        // Every dependency that crosses a context boundary is an edge, and a
        // context pair carries exactly one however many tasks span it.
        const contextIdByTaskId = new Map(
          document.tasks.map((task) => [task.taskId, task.contextId]),
        );
        expect(new Set(document.edges.map((edge) => edge.edgeId)).size).toBe(
          document.edges.length,
        );
        expect(
          new Set(
            document.edges.map(
              (edge) => `${edge.fromContextId}->${edge.toContextId}`,
            ),
          ).size,
        ).toBe(document.edges.length);
        for (const edge of document.edges) {
          expect(edge.fromContextId).not.toBe(edge.toContextId);
          expect(
            document.contexts.some(
              (context) => context.contextId === edge.fromContextId,
            ),
          ).toBe(true);
        }
        expect(contextIdByTaskId.size).toBe(document.tasks.length);

        // Criterion ownership: no criterion is owned twice, and every selected
        // criterion is either owned once or named on the split list.
        const owners = document.contexts.flatMap(
          (context) => context.criterionElementIds,
        );
        expect(new Set(owners).size).toBe(owners.length);
        const split = new Set(
          (view.legacyImport?.requiresHumanSplit ?? []).map(
            (entry) => entry.criterionElementId,
          ),
        );
        for (const criterionId of fixture.scope.selectedCriterionIds) {
          expect(
            owners.includes(criterionId) || split.has(criterionId),
            `criterion ${criterionId} is neither owned nor split`,
          ).toBe(true);
        }
        for (const criterionId of split) {
          expect(owners).not.toContain(criterionId);
        }
      });

      it("drops the compiler's prerequisite apology and types criterion-less contexts", async () => {
        const view = await seededOpen(world, fixture);

        for (const task of view.document.tasks) {
          expect(task.instructions).not.toContain(
            LEGACY_UNMAPPED_CRITERION_NOTICE,
          );
        }
        for (const context of view.document.contexts) {
          expect(context.contextType).toBe(
            context.criterionElementIds.length === 0
              ? "integration"
              : "delivery",
          );
        }
      });

      it("reports the import and any split it could not decide through the cctl receipt", async () => {
        const result = await runCli(
          [
            "spec",
            "plan",
            "open",
            fixture.spec.slug,
            "--seed-from",
            "last",
            "--json",
          ],
          cliEnv,
          bridgeHost(world),
        );

        expect(result.exitCode).toBe(0);
        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          plan: DeliveryPlanMutationView;
        };
        expect(envelope.ok).toBe(true);
        const legacyImport = envelope.plan.legacyImport;
        expect(legacyImport).not.toBeNull();
        expect(legacyImport?.sourceExecutionId).toBe(fixture.executionId);
        expect(legacyImport?.contextCount).toBe(
          envelope.plan.document.contexts.length,
        );
        // Every split entry names its remedy AND its target, so an author
        // holding several can act on one without a second lookup.
        for (const entry of legacyImport?.requiresHumanSplit ?? []) {
          expect(entry.resolution).toContain(entry.handle);
          expect(entry.resolution).toContain("cctl spec plan edit");
        }
      });
    });
  }

  /**
   * Neither captured spec spreads a criterion across contexts, so the split
   * path needs a legacy plan that does. It is seeded through the same tables,
   * driven through the same route, and read off the same receipt — the point
   * is that the entries reach an author, not that the mapping is right (the
   * unit tests own that).
   */
  it("returns actionable split entries through the receipt when a legacy plan spread a criterion across contexts", async () => {
    const specId = "spec-split-legacy";
    const revisionId = "revision-split-legacy";
    const at = "2026-08-01T00:00:00.000Z";
    world.db
      .prepare(
        `INSERT INTO specs (id, project_path, slug, name, gate_policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        specId,
        SPINE_PROJECT_PATH,
        "split-legacy",
        "Split legacy",
        '{"preset":"contract-bearing"}',
        at,
        at,
      );
    world.db
      .prepare(
        `INSERT INTO spec_revisions (id, spec_id, number, state, authoring_stage,
           based_on_revision_id, content_hash, proposed_at, approved_at, created_at)
         VALUES (?, ?, 1, 'approved', 'plan', NULL, 'sha256:split', ?, ?, ?)`,
      )
      .run(revisionId, specId, at, at, at);
    const insertElement = world.db.prepare(
      `INSERT INTO spec_elements (id, spec_id, kind, number, parent_element_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertVersion = world.db.prepare(
      `INSERT INTO spec_element_versions (revision_id, element_id, position, payload_json,
         payload_hash, element_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const add = (
      id: string,
      kind: string,
      number: number | null,
      parent: string | null,
      position: number,
      payload: unknown,
    ) => {
      insertElement.run(id, specId, kind, number, parent, at);
      insertVersion.run(
        revisionId,
        id,
        position,
        JSON.stringify(payload),
        `hash-${id}`,
        at,
        at,
      );
    };
    add("split-req", "requirement", 1, null, 0, {
      kind: "requirement",
      statement: "Delivery is observable.",
      priority: "must",
      risk: "medium",
    });
    add("split-crit", "criterion", 1, "split-req", 1, {
      kind: "criterion",
      text: "Both halves are observable.",
      validationStrategy: { kinds: ["test_run"] },
    });
    const taskPayload = (title: string) => ({
      kind: "task",
      title,
      instructions: `Do ${title}.`,
      tracedRequirementElementIds: ["split-req"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["split-crit"],
      dependsOnTaskElementIds: [],
    });
    add("split-task-a", "task", 1, null, 2, taskPayload("First half"));
    add("split-task-b", "task", 2, null, 3, taskPayload("Second half"));
    world.db
      .prepare(
        `INSERT INTO spec_executions (id, spec_id, revision_id, scope_json, state,
           execution_start_dial, workflow_definition_id, workflow_definition_revision,
           workflow_execution_id, session_name, delivered_at, abandoned_reason,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'definition_review', NULL, 'workflow-split', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        "execution-split-legacy",
        specId,
        revisionId,
        JSON.stringify({
          selectedTaskIds: ["split-task-a", "split-task-b"],
          selectedCriterionIds: ["split-crit"],
          exclusionDispositions: [],
        }),
        at,
        at,
      );

    const result = await runCli(
      ["spec", "plan", "open", "split-legacy", "--seed-from", "last", "--json"],
      cliEnv,
      bridgeHost(world),
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      plan: DeliveryPlanMutationView;
    };
    const split = envelope.plan.legacyImport?.requiresHumanSplit ?? [];
    expect(split).toHaveLength(1);
    expect(split[0]?.criterionElementId).toBe("split-crit");
    expect(split[0]?.contextIds).toEqual(["t1", "t2"]);
    expect(split[0]?.resolution).toContain("split-legacy/R1.1");
    expect(split[0]?.resolution).toContain("cctl spec plan edit split-legacy");
    // Never silently duplicated: no context claims it, so propose stays shut
    // until a human decides where it belongs.
    expect(
      envelope.plan.document.contexts.flatMap(
        (context) => context.criterionElementIds,
      ),
    ).toEqual([]);
    expect(
      envelope.plan.health.findings.some(
        (finding) => finding.ruleId === "plan/selected-unowned",
      ),
    ).toBe(true);
  });

  it("does not import when the open is unseeded", async () => {
    const fixture = LEGACY_IMPORT_FIXTURES[0]!;
    const response = await world.postAction(
      fixture.spec.slug,
      "plan-open",
      { seedFromLast: false },
      "agent",
    );
    const view = deliveryPlanMutationViewSchema.parse(await response.json());

    expect(view.legacyImport).toBeNull();
    expect(view.document.contexts).toEqual([]);
  });
});
