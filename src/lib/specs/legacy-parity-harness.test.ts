import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import { deliveryPlanDocumentSchema } from "./delivery-plan";
import {
  deliveryPlanMaterializationCriteria,
  materializeDeliveryPlan,
} from "./delivery-plan-materializer";
import {
  LEGACY_IMPORT_FIXTURES,
  seedLegacyImportFixture,
  type LegacyImportFixture,
} from "./legacy-import-fixtures";
import {
  APPROVED_DELTAS,
  compareLegacyParity,
  type ParityCaseReport,
} from "./legacy-parity-harness";
import {
  createSpecSpineWorld,
  SPINE_PROJECT_PATH,
  type SpecSpineWorld,
} from "./spine-test-fixture";

/**
 * The shadow parity harness, run against the two real legacy deliveries.
 *
 * Both attempts are opened through the production route so what is compared is
 * the attempt an author would actually get, then compiled through the
 * production materializer with the same inputs `service-factory.ts` supplies.
 * The comparison basis is the definition the archived execution was LAUNCHED
 * with, and every difference must map to an enumerated approved delta.
 *
 * The report is committed. A change to the importer, the materializer, or the
 * compiler that moves any compiled byte shows up as a diff on a reviewable
 * artifact rather than as a silently different plan.
 */

const REPORT_PATH = path.join(
  process.cwd(),
  "src/lib/specs/legacy-import-fixtures/parity-report.json",
);

interface ParityReport {
  readonly approvedDeltas: Readonly<Record<string, string>>;
  readonly cases: readonly ParityCaseReport[];
}

async function importedAttemptDefinition(
  world: SpecSpineWorld,
  fixture: LegacyImportFixture,
) {
  const response = await world.postAction(
    fixture.spec.slug,
    "plan-open",
    { seedFromLast: true },
    "agent",
  );
  expect(response.status, await response.clone().text()).toBe(200);

  const row = world.db
    .prepare(
      "SELECT id, content_json, draft_revision, pinned_revision_id FROM spec_delivery_plan_attempts WHERE spec_id = ?",
    )
    .get(fixture.spec.id) as {
    id: string;
    content_json: string;
    draft_revision: number;
    pinned_revision_id: string;
  };

  const result = materializeDeliveryPlan({
    spec: {
      id: fixture.spec.id,
      slug: fixture.spec.slug,
      name: fixture.spec.name,
    },
    attemptId: row.id,
    pinnedRevisionId: row.pinned_revision_id,
    draftRevision: row.draft_revision,
    document: deliveryPlanDocumentSchema.parse(JSON.parse(row.content_json)),
    criteria: deliveryPlanMaterializationCriteria(fixture.snapshot),
    registeredValidationCommandNames: [],
    defaults: {
      // Taken from the launched definition so the approval policy is not
      // itself a difference: the plan gate decides it in production, and the
      // question here is whether the graph matches.
      approvalRequired: fixture.launchedDefinition.approvalRequired ?? false,
      workflowConfig: {},
    },
  });
  if (!result.ok) {
    throw new Error(
      `${fixture.key}: the imported attempt did not compile — ${result.refusal.unmetConditions.join(" ")}`,
    );
  }
  return result.value.definition;
}

describe("legacy plan shadow parity harness", () => {
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

  it("reproduces both launched definitions with only enumerated deltas, and the report says so", async () => {
    const cases: ParityCaseReport[] = [];
    for (const fixture of LEGACY_IMPORT_FIXTURES) {
      const materialized = await importedAttemptDefinition(world, fixture);
      cases.push(
        compareLegacyParity({
          caseKey: fixture.key,
          launched: fixture.launchedDefinition,
          materialized,
          snapshot: fixture.snapshot,
          launchedFrom: fixture.launchedFrom,
          postLaunchAmendments: fixture.postLaunchAmendments,
        }),
      );
    }

    for (const report of cases) {
      // Every context, task, and edge of the launched definition is accounted
      // for — a harness that compared nothing would also report no difference.
      expect(report.counts.materializedContexts).toBe(
        report.counts.launchedContexts,
      );
      expect(report.counts.materializedTasks).toBe(report.counts.launchedTasks);
      expect(report.counts.materializedEdges).toBe(report.counts.launchedEdges);
      expect(report.counts.comparedCriteria).toBeGreaterThan(0);
      expect(report.differences.length).toBeGreaterThan(0);
      expect(
        report.unenumerated,
        `${report.case}: ${report.unenumerated
          .map((entry) => `${entry.subject} — ${entry.finding}`)
          .join("; ")}`,
      ).toEqual([]);
      for (const difference of report.differences) {
        expect(Object.keys(APPROVED_DELTAS)).toContain(
          difference.approvedDelta,
        );
      }
    }

    // The committed artifact. Delete it and re-run to regenerate, then review
    // the diff — a moved compiled byte must be seen, not silently accepted.
    const report: ParityReport = { approvedDeltas: APPROVED_DELTAS, cases };
    await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
      REPORT_PATH,
    );
  });

  it("fails a difference no approved delta explains", async () => {
    const fixture = LEGACY_IMPORT_FIXTURES[0]!;
    const materialized = await importedAttemptDefinition(world, fixture);
    // Rewrite one task's instructions to something the apology rule cannot
    // explain, exactly as a regression in the importer's rendering would.
    const tampered = {
      ...materialized,
      tasks: materialized.tasks.map((task, index) =>
        index === 0 ? { ...task, instructions: "Do something else." } : task,
      ),
    };

    const report = compareLegacyParity({
      caseKey: fixture.key,
      launched: fixture.launchedDefinition,
      materialized: tampered,
      snapshot: fixture.snapshot,
      launchedFrom: fixture.launchedFrom,
      postLaunchAmendments: fixture.postLaunchAmendments,
    });

    expect(report.unenumerated).toHaveLength(1);
    expect(report.unenumerated[0]?.dimension).toBe("instruction-content");
    expect(report.unenumerated[0]?.finding).toContain(
      "more than the compiler's unmapped-criterion apology",
    );
  });
});
