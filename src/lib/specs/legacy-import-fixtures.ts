import type Database from "better-sqlite3";
import { z } from "zod";

import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { migrateRawDefinitionPlacement } from "@/lib/workflow-graph/placement-migration";

import dynamicGraphPrimitivesPlan from "./legacy-import-fixtures/dynamic-graph-primitives.legacy-plan.json";
import dynamicGraphPrimitivesDefinition from "./legacy-import-fixtures/dynamic-graph-primitives.launched-definition.json";
import workflowValidatorCohortsPlan from "./legacy-import-fixtures/workflow-validator-cohorts.legacy-plan.json";
import workflowValidatorCohortsDefinition from "./legacy-import-fixtures/workflow-validator-cohorts.launched-definition.json";
import { executionScopeSchema, type ExecutionScope } from "./scope-validation";
import {
  specRevisionSnapshotSchema,
  type SpecRevisionSnapshot,
} from "./schemas";

type Db = InstanceType<typeof Database>;

/**
 * The two real legacy deliveries the importer and the shadow parity harness are
 * held to, read out of their committed captures.
 *
 * They are seeded into a test database through the same tables production
 * writes, so a test composed over the real repositories, services, and route
 * handlers reads exactly the rows the live system would have read — which is
 * what makes "tested through the CLI/service composition" mean something more
 * than calling the importer with a hand-built snapshot.
 */

const legacyPlanFixtureSchema = z
  .object({
    capturedFrom: z
      .object({
        database: z.string().min(1),
        specId: z.string().min(1),
        specExecutionId: z.string().min(1),
        capturedAt: z.string().min(1),
      })
      .strict(),
    spec: z
      .object({
        id: z.string().min(1),
        projectPath: z.string().min(1),
        slug: z.string().min(1),
        name: z.string().min(1),
        gatePolicyJson: z.string().min(1),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
      })
      .strict(),
    execution: z
      .object({
        id: z.string().min(1),
        spec_id: z.string().min(1),
        revision_id: z.string().min(1),
        scope_json: z.string().min(1),
        state: z.string().min(1),
        execution_start_dial: z.string().nullable(),
        workflow_definition_id: z.string().min(1),
        workflow_definition_revision: z.number().int().nullable(),
        workflow_execution_id: z.string().nullable(),
        session_name: z.string().nullable(),
        delivered_at: z.string().nullable(),
        abandoned_reason: z.string().nullable(),
        created_at: z.string().min(1),
        updated_at: z.string().min(1),
      })
      .strict(),
    snapshot: specRevisionSnapshotSchema,
  })
  .strict();

const launchedDefinitionFixtureSchema = z
  .object({
    capturedFrom: z
      .object({
        archivedExecutionId: z.string().min(1),
        sessionName: z.string().min(1),
        archivedStatus: z.string().min(1),
        archivedAt: z.string().min(1),
        seedDefinitionId: z.string().min(1),
        seedDefinitionRevision: z.number().int().positive(),
        liveRevisionAtArchive: z.number().int().positive(),
        definitionRecordUpdatedAt: z.string().min(1),
        capturedAt: z.string().min(1),
      })
      .strict(),
    postLaunchAmendments: z.array(z.record(z.string(), z.unknown())),
    definition: workflowSemanticDefinitionSchema,
  })
  .strict();

export interface LegacyImportFixture {
  readonly key: string;
  readonly spec: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly gatePolicyJson: string;
  };
  readonly executionId: string;
  readonly snapshot: SpecRevisionSnapshot;
  readonly scope: ExecutionScope;
  /** The definition the archived execution was launched with. */
  readonly launchedDefinition: WorkflowSemanticDefinition;
  readonly launchedFrom: z.infer<
    typeof launchedDefinitionFixtureSchema
  >["capturedFrom"];
  /** Post-launch amendments recorded at capture, so they stay visible. */
  readonly postLaunchAmendments: readonly Readonly<Record<string, unknown>>[];
}

function toFixture(
  key: string,
  rawPlan: unknown,
  rawDefinition: unknown,
): LegacyImportFixture {
  const plan = legacyPlanFixtureSchema.parse(rawPlan);
  // These are captured production executions, launched before placement became
  // a required field, so the raw JSON carries none. Production reads such rows
  // through the same backfill rather than rejecting them; applying it here is
  // what keeps the fixture a faithful capture instead of a doctored one.
  migrateRawDefinitionPlacement(
    typeof rawDefinition === "object" && rawDefinition !== null
      ? (rawDefinition as { definition?: unknown }).definition
      : undefined,
  );
  const launched = launchedDefinitionFixtureSchema.parse(rawDefinition);
  return {
    key,
    spec: {
      id: plan.spec.id,
      slug: plan.spec.slug,
      name: plan.spec.name,
      gatePolicyJson: plan.spec.gatePolicyJson,
    },
    executionId: plan.execution.id,
    snapshot: plan.snapshot,
    scope: executionScopeSchema.parse(JSON.parse(plan.execution.scope_json)),
    launchedDefinition: launched.definition,
    launchedFrom: launched.capturedFrom,
    postLaunchAmendments: launched.postLaunchAmendments,
  };
}

export const LEGACY_IMPORT_FIXTURES: readonly LegacyImportFixture[] = [
  toFixture(
    "dynamic-graph-primitives",
    dynamicGraphPrimitivesPlan,
    dynamicGraphPrimitivesDefinition,
  ),
  toFixture(
    "workflow-validator-cohorts",
    workflowValidatorCohortsPlan,
    workflowValidatorCohortsDefinition,
  ),
];

export function legacyImportFixture(key: string): LegacyImportFixture {
  const fixture = LEGACY_IMPORT_FIXTURES.find((entry) => entry.key === key);
  if (fixture === undefined) {
    throw new Error(`No legacy import fixture named ${key}.`);
  }
  return fixture;
}

/**
 * The fixture written through the same tables the production repositories read:
 * the spec, its approved revision and every element version in it, and the
 * legacy `spec_executions` row with its validated scope.
 *
 * `projectPath` is the caller's, not the capture's, so the rows join to the
 * project the surrounding composition already created.
 */
export function seedLegacyImportFixture(
  db: Db,
  projectPath: string,
  fixture: LegacyImportFixture,
): void {
  const plan = legacyPlanFixtureSchema.parse(rawPlanFor(fixture.key));
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.spec.id,
    projectPath,
    plan.spec.slug,
    plan.spec.name,
    plan.spec.gatePolicyJson,
    plan.spec.createdAt,
    plan.spec.updatedAt,
  );
  const revision = plan.snapshot.revision;
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revision.id,
    revision.specId,
    revision.number,
    revision.state,
    revision.authoringStage,
    // The capture carries one revision, not its lineage: the withdrawn draft it
    // was based on is not seeded, so the pointer would dangle.
    null,
    revision.contentHash,
    revision.proposedAt,
    revision.approvedAt,
    revision.createdAt,
  );

  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Requirements before their criteria: a criterion row's parent must already
  // exist, and the capture is ordered by revision position, not by kind.
  const ordered = [...plan.snapshot.elements].sort(
    (left, right) =>
      Number(left.element.kind === "criterion") -
        Number(right.element.kind === "criterion") ||
      left.version.position - right.version.position,
  );
  for (const entry of ordered) {
    insertElement.run(
      entry.element.id,
      entry.element.specId,
      entry.element.kind,
      entry.element.number,
      entry.element.parentElementId,
      entry.element.createdAt,
    );
    insertVersion.run(
      entry.version.revisionId,
      entry.version.elementId,
      entry.version.position,
      JSON.stringify(entry.version.payload),
      entry.version.payloadHash,
      entry.version.elementVersion,
      entry.version.createdAt,
      entry.version.updatedAt,
    );
  }

  const execution = plan.execution;
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, execution_start_dial,
       workflow_definition_id, workflow_definition_revision,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    execution.id,
    execution.spec_id,
    execution.revision_id,
    execution.scope_json,
    execution.state,
    execution.execution_start_dial,
    execution.workflow_definition_id,
    execution.workflow_definition_revision,
    execution.workflow_execution_id,
    execution.session_name,
    execution.delivered_at,
    execution.abandoned_reason,
    execution.created_at,
    execution.updated_at,
  );
}

function rawPlanFor(key: string): unknown {
  switch (key) {
    case "dynamic-graph-primitives":
      return dynamicGraphPrimitivesPlan;
    case "workflow-validator-cohorts":
      return workflowValidatorCohortsPlan;
    default:
      throw new Error(`No legacy import fixture named ${key}.`);
  }
}
