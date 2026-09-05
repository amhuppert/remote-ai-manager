import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import {
  canonicalDeliveryPlanCandidateBytes,
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanBindingV3Schema,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanDocumentSchema,
  deliveryPlanCandidateManifestV3Schema,
  deliveryPlanV3DocumentSchema,
  finalizedDeliveryPlanApprovalSchema,
  type DeliveryPlanCandidateManifestV3,
} from "@/lib/specs/delivery-plan";
import {
  deliveryPlanBindingHash,
  deliveryPlanCandidateHash,
  workflowDefinitionHash,
} from "@/lib/specs/delivery-plan-hash";
import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  workflowDefinitionMutationSchema,
  type WorkflowDefinitionRecord,
} from "@/lib/workflow-graph/definition-schemas";
import { workflowDefinitionFilePath } from "@/lib/workflow-graph/storage-paths";
import {
  SPEC_DELIVERY_PLAN_SCHEMA_DDL,
  SPEC_EXECUTION_BINDINGS_SCHEMA_DDL,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import {
  hasCurrentCandidateApprovalForeignKey,
  rebuildCandidateApprovalForeignKey,
} from "./spec-delivery-plan-candidate-approval-foreign-key";
import type { MigrationContext, StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 14;
const MIGRATION_DESCRIPTION =
  "native SDD delivery plans materialized as managed workflow definitions";
const logger = createLogger(
  "state-store/migrations/native-sdd-managed-definitions",
);

const legacyDeliveryPlanDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    launch: workflowDefinitionMutationSchema,
    binding: deliveryPlanBindingV3Schema,
  })
  .strict();

const legacyDeliveryPlanCandidateRecordV2Schema = z
  .object({
    protocol: z.literal("native-sdd-delivery-candidate/v2"),
    schemaVersion: z.literal(2),
    specId: z.string().min(1),
    attemptId: z.string().min(1),
    candidateId: z.string().min(1),
    pinnedRevisionId: z.string().min(1),
    draftRevision: z.number().int().positive(),
    document: legacyDeliveryPlanDocumentV2Schema,
  })
  .strict();

export const NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION =
  MIGRATION_SCHEMA_VERSION;

interface AttemptRow {
  id: string;
  spec_id: string;
  pinned_revision_id: string;
  status: string;
  draft_revision: number;
  content_json: string;
  proposed_snapshot_id: string | null;
  approval_json: string | null;
  prelaunch_json: string | null;
  workflow_definition_id: string | null;
  updated_at: string;
  project_path: string;
  slug: string;
}

interface SnapshotRow {
  id: string;
  attempt_id: string;
  candidate_id: string;
  candidate_hash: string;
  draft_revision: number;
  content_json: string;
  pinned_revision_id: string;
  proposed_at: string;
  proposed_by_json: string;
  workflow_definition_id: string | null;
  workflow_definition_revision: number | null;
  workflow_definition_hash: string | null;
  binding_hash: string | null;
}

interface MigratedSnapshot {
  row: SnapshotRow;
  manifest: DeliveryPlanCandidateManifestV3;
  candidateHash: string;
  oldCandidateHash: string;
}

function tableColumns(context: MigrationContext, table: string): Set<string> {
  const rows = context.db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(
  context: MigrationContext,
  table: string,
  name: string,
  declaration: string,
): void {
  if (tableColumns(context, table).has(name)) return;
  context.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}

function ensureStructure(context: MigrationContext): void {
  addColumn(
    context,
    "spec_delivery_plan_attempts",
    "workflow_definition_id",
    "TEXT",
  );
  addColumn(
    context,
    "spec_delivery_plan_snapshots",
    "workflow_definition_id",
    "TEXT",
  );
  addColumn(
    context,
    "spec_delivery_plan_snapshots",
    "workflow_definition_revision",
    "INTEGER",
  );
  addColumn(
    context,
    "spec_delivery_plan_snapshots",
    "workflow_definition_hash",
    "TEXT",
  );
  addColumn(context, "spec_delivery_plan_snapshots", "binding_hash", "TEXT");
  context.db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  ensureCandidateApprovalForeignKey(context);
}

function ensureCandidateApprovalForeignKey(context: MigrationContext): void {
  if (hasCurrentCandidateApprovalForeignKey(context.db)) return;

  context.db.exec("BEGIN IMMEDIATE");
  try {
    const preservedApprovals = rebuildCandidateApprovalForeignKey(context.db);
    context.db.exec("COMMIT");
    logger.info(
      "state-store.migrations.native_sdd_managed_definition_approval_fk_rebuilt",
      { preservedApprovals },
    );
  } catch (error) {
    if (context.db.inTransaction) context.db.exec("ROLLBACK");
    throw error;
  }
}

function draftDefinitionId(attemptId: string, draftRevision: number): string {
  const hash = createHash("sha256")
    .update(`${attemptId}:${draftRevision}`)
    .digest("hex");
  return `sdd-draft-${hash.slice(0, 40)}`;
}

async function materializeDefinition(input: {
  configDir: string;
  projectPath: string;
  workflowId: string;
  launch: {
    name: string;
    description: string | null;
    definition: WorkflowDefinitionRecord["definition"];
    layout: WorkflowDefinitionRecord["layout"];
  };
  occurredAt: string;
}): Promise<WorkflowDefinitionRecord> {
  const record: WorkflowDefinitionRecord = {
    id: input.workflowId,
    name: input.launch.name,
    description: input.launch.description,
    schemaVersion: 1,
    revision: 1,
    definition: input.launch.definition,
    layout: { ...input.launch.layout, workflowId: input.workflowId },
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
  const filePath = workflowDefinitionFilePath(
    input.configDir,
    { kind: "project", projectPath: input.projectPath },
    input.workflowId,
  );
  if (existsSync(filePath)) {
    const existing = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const existingHash = workflowDefinitionHash(
      existing as WorkflowDefinitionRecord,
    );
    if (existingHash !== workflowDefinitionHash(record)) {
      throw new Error(
        `Managed workflow definition collision for ${input.workflowId}: existing authored bytes do not match the migrated candidate`,
      );
    }
    return existing as WorkflowDefinitionRecord;
  }
  await atomicWriteJson(filePath, record);
  return record;
}

function replaceCandidateHashes(
  value: unknown,
  hashes: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return hashes.get(value) ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceCandidateHashes(entry, hashes));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      replaceCandidateHashes(entry, hashes),
    ]),
  );
}

function migratedJson(
  raw: string | null,
  hashes: ReadonlyMap<string, string>,
): string | null {
  if (raw === null) return null;
  return stableStringify(replaceCandidateHashes(JSON.parse(raw), hashes));
}

async function buildSnapshotMigration(input: {
  context: MigrationContext;
  configDir: string;
  attempt: AttemptRow;
  snapshot: SnapshotRow;
}): Promise<MigratedSnapshot> {
  const candidate = legacyDeliveryPlanCandidateRecordV2Schema.parse(
    JSON.parse(input.snapshot.content_json),
  );
  const definition = await materializeDefinition({
    configDir: input.configDir,
    projectPath: input.attempt.project_path,
    workflowId: candidate.candidateId,
    launch: candidate.document.launch,
    occurredAt: input.snapshot.proposed_at,
  });
  const bindingHash = deliveryPlanBindingHash(candidate.document.binding);
  const manifest = deliveryPlanCandidateManifestV3Schema.parse({
    protocol: "native-sdd-delivery-candidate/v3",
    schemaVersion: 3,
    specId: candidate.specId,
    attemptId: candidate.attemptId,
    candidateId: candidate.candidateId,
    pinnedRevisionId: candidate.pinnedRevisionId,
    draftRevision: candidate.draftRevision,
    workflowDefinition: {
      id: definition.id,
      revision: definition.revision,
      definitionHash: workflowDefinitionHash(definition),
    },
    binding: candidate.document.binding,
    bindingHash,
  });
  return {
    row: input.snapshot,
    manifest,
    candidateHash: deliveryPlanCandidateHash(manifest),
    oldCandidateHash: input.snapshot.candidate_hash,
  };
}

async function materializeDraft(input: {
  configDir: string;
  attempt: AttemptRow;
  workflowId: string;
}): Promise<void> {
  const document = legacyDeliveryPlanDocumentV2Schema.parse(
    JSON.parse(input.attempt.content_json),
  );
  const launch = finalizeDeliveryPlanLaunch({
    specId: input.attempt.spec_id,
    specSlug: input.attempt.slug,
    pinnedRevisionId: input.attempt.pinned_revision_id,
    attemptId: input.attempt.id,
    candidateId: input.workflowId,
    launch: document.launch,
  });
  await materializeDefinition({
    configDir: input.configDir,
    projectPath: input.attempt.project_path,
    workflowId: input.workflowId,
    launch,
    occurredAt: input.attempt.updated_at,
  });
}

function stampVersion(context: MigrationContext): void {
  context.db
    .prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, description)
       VALUES (?, ?)`,
    )
    .run(MIGRATION_SCHEMA_VERSION, MIGRATION_DESCRIPTION);
}

async function readVerifiedDefinition(input: {
  configDir: string;
  projectPath: string;
  workflowId: string;
}): Promise<WorkflowDefinitionRecord> {
  const filePath = workflowDefinitionFilePath(
    input.configDir,
    { kind: "project", projectPath: input.projectPath },
    input.workflowId,
  );
  if (!existsSync(filePath)) {
    throw new Error(
      `Managed workflow definition ${input.workflowId} is missing during migration verification`,
    );
  }
  return JSON.parse(
    await readFile(filePath, "utf8"),
  ) as WorkflowDefinitionRecord;
}

async function verifyManagedState(context: MigrationContext): Promise<void> {
  const attempts = context.db
    .prepare(
      `SELECT attempts.*, specs.project_path, specs.slug
       FROM spec_delivery_plan_attempts attempts
       JOIN specs ON specs.id = attempts.spec_id
       ORDER BY attempts.id ASC`,
    )
    .all() as AttemptRow[];
  const snapshots = context.db
    .prepare(
      `SELECT snapshots.*, specs.project_path
       FROM spec_delivery_plan_snapshots snapshots
       JOIN spec_delivery_plan_attempts attempts ON attempts.id = snapshots.attempt_id
       JOIN specs ON specs.id = attempts.spec_id
       ORDER BY snapshots.id ASC`,
    )
    .all() as Array<SnapshotRow & { project_path: string }>;
  if (attempts.length > 0 && context.configDir === null) {
    throw new Error(
      "Native SDD managed-definition verification requires configDir when delivery plans exist",
    );
  }
  const configDir = context.configDir;
  if (configDir === null) return;

  for (const attempt of attempts) {
    deliveryPlanDocumentSchema.parse(JSON.parse(attempt.content_json));
    if (attempt.workflow_definition_id === null) {
      throw new Error(
        `Delivery plan attempt ${attempt.id} has no managed workflow definition`,
      );
    }
    await readVerifiedDefinition({
      configDir,
      projectPath: attempt.project_path,
      workflowId: attempt.workflow_definition_id,
    });
  }

  for (const snapshot of snapshots) {
    const manifest = deliveryPlanCandidateRecordSchema.parse(
      JSON.parse(snapshot.content_json),
    );
    const definition = await readVerifiedDefinition({
      configDir,
      projectPath: snapshot.project_path,
      workflowId: manifest.workflowDefinition.id,
    });
    const actualDefinitionHash = workflowDefinitionHash(definition);
    if (
      snapshot.candidate_hash !== deliveryPlanCandidateHash(manifest) ||
      snapshot.workflow_definition_id !== manifest.workflowDefinition.id ||
      snapshot.workflow_definition_revision !==
        manifest.workflowDefinition.revision ||
      snapshot.workflow_definition_hash !==
        manifest.workflowDefinition.definitionHash ||
      snapshot.binding_hash !== manifest.bindingHash ||
      definition.revision !== manifest.workflowDefinition.revision ||
      actualDefinitionHash !== manifest.workflowDefinition.definitionHash
    ) {
      throw new Error(
        `Delivery plan snapshot ${snapshot.id} failed managed-definition integrity verification`,
      );
    }
  }
}

async function migrate(context: MigrationContext): Promise<void> {
  enforceCurrentSchemaCompatibility(
    context.db,
    context.db.name,
    MIGRATION_SCHEMA_VERSION,
  );
  ensureStructure(context);
  const attempts = context.db
    .prepare(
      `SELECT attempts.*, specs.project_path, specs.slug
       FROM spec_delivery_plan_attempts attempts
       JOIN specs ON specs.id = attempts.spec_id
       ORDER BY attempts.created_at ASC, attempts.id ASC`,
    )
    .all() as AttemptRow[];
  const v2Attempts = attempts.filter((attempt) => {
    const parsed = JSON.parse(attempt.content_json) as {
      schemaVersion?: number;
    };
    return parsed.schemaVersion === 2;
  });
  const v2SnapshotCount = (
    context.db
      .prepare(
        `SELECT COUNT(*) AS count FROM spec_delivery_plan_snapshots
         WHERE json_extract(content_json, '$.schemaVersion') = 2`,
      )
      .get() as { count: number }
  ).count;

  if (
    context.configDir === null &&
    (v2Attempts.length > 0 || v2SnapshotCount > 0)
  ) {
    throw new Error(
      "Native SDD managed-definition migration requires configDir when version-2 delivery plans exist",
    );
  }
  if (v2Attempts.length === 0 && v2SnapshotCount === 0) {
    await verifyManagedState(context);
    stampVersion(context);
    return;
  }

  const configDir = context.configDir!;
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const snapshots = context.db
    .prepare(
      `SELECT * FROM spec_delivery_plan_snapshots
       ORDER BY proposed_at ASC, id ASC`,
    )
    .all() as SnapshotRow[];
  const migratedSnapshots: MigratedSnapshot[] = [];
  for (const snapshot of snapshots) {
    const raw = JSON.parse(snapshot.content_json) as { schemaVersion?: number };
    if (raw.schemaVersion !== 2) continue;
    const attempt = attemptById.get(snapshot.attempt_id);
    if (!attempt) {
      throw new Error(`Snapshot ${snapshot.id} has no delivery plan attempt`);
    }
    migratedSnapshots.push(
      await buildSnapshotMigration({
        context,
        configDir,
        attempt,
        snapshot,
      }),
    );
  }

  const migratedBySnapshot = new Map(
    migratedSnapshots.map((entry) => [entry.row.id, entry]),
  );
  const candidateHashes = new Map(
    migratedSnapshots.map((entry) => [
      entry.oldCandidateHash,
      entry.candidateHash,
    ]),
  );
  const attemptDefinitionIds = new Map<string, string>();
  for (const attempt of v2Attempts) {
    const proposed =
      attempt.proposed_snapshot_id === null
        ? undefined
        : migratedBySnapshot.get(attempt.proposed_snapshot_id);
    const workflowId =
      attempt.status !== "draft" && proposed
        ? proposed.manifest.workflowDefinition.id
        : draftDefinitionId(attempt.id, attempt.draft_revision);
    if (attempt.status === "draft" || !proposed) {
      await materializeDraft({ configDir, attempt, workflowId });
    }
    attemptDefinitionIds.set(attempt.id, workflowId);
  }

  context.db.exec("BEGIN IMMEDIATE");
  try {
    const updateSnapshot = context.db.prepare(
      `UPDATE spec_delivery_plan_snapshots SET
         candidate_hash = @candidate_hash,
         content_json = @content_json,
         workflow_definition_id = @workflow_definition_id,
         workflow_definition_revision = @workflow_definition_revision,
         workflow_definition_hash = @workflow_definition_hash,
         binding_hash = @binding_hash
       WHERE id = @id`,
    );
    for (const migrated of migratedSnapshots) {
      updateSnapshot.run({
        id: migrated.row.id,
        candidate_hash: migrated.candidateHash,
        content_json: canonicalDeliveryPlanCandidateBytes(migrated.manifest),
        workflow_definition_id: migrated.manifest.workflowDefinition.id,
        workflow_definition_revision:
          migrated.manifest.workflowDefinition.revision,
        workflow_definition_hash:
          migrated.manifest.workflowDefinition.definitionHash,
        binding_hash: migrated.manifest.bindingHash,
      });
    }

    const updateAttempt = context.db.prepare(
      `UPDATE spec_delivery_plan_attempts SET
         content_json = @content_json,
         workflow_definition_id = @workflow_definition_id,
         approval_json = @approval_json,
         prelaunch_json = @prelaunch_json
       WHERE id = @id`,
    );
    const insertApproval = context.db.prepare(
      `INSERT OR REPLACE INTO spec_delivery_plan_candidate_approvals (
         snapshot_id, candidate_id, candidate_hash, approved_at,
         approved_by_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const findCandidateSnapshot = context.db.prepare(
      `SELECT id FROM spec_delivery_plan_snapshots
       WHERE attempt_id = ? AND candidate_id = ?
       ORDER BY proposed_at DESC, id DESC
       LIMIT 1`,
    );
    const approvalEvents = context.db
      .prepare(
        `SELECT occurred_at, actor_json, payload_json
         FROM spec_events
         WHERE event_type IN (
           'spec-review-item-approved', 'spec-approval-changed'
         )
         ORDER BY id ASC`,
      )
      .all() as Array<{
      occurred_at: string;
      actor_json: string;
      payload_json: string;
    }>;
    for (const event of approvalEvents) {
      const payload = JSON.parse(event.payload_json) as {
        attemptId?: unknown;
        candidateId?: unknown;
        candidateHash?: unknown;
      };
      if (
        typeof payload.attemptId !== "string" ||
        typeof payload.candidateId !== "string" ||
        typeof payload.candidateHash !== "string"
      ) {
        continue;
      }
      const snapshot = findCandidateSnapshot.get(
        payload.attemptId,
        payload.candidateId,
      ) as { id: string } | undefined;
      if (!snapshot) continue;
      insertApproval.run(
        snapshot.id,
        payload.candidateId,
        candidateHashes.get(payload.candidateHash) ?? payload.candidateHash,
        event.occurred_at,
        event.actor_json,
      );
    }
    for (const attempt of v2Attempts) {
      const document = legacyDeliveryPlanDocumentV2Schema.parse(
        JSON.parse(attempt.content_json),
      );
      const v3Document = deliveryPlanV3DocumentSchema.parse({
        schemaVersion: 3,
        binding: document.binding,
      });
      const approval =
        attempt.approval_json === null
          ? null
          : finalizedDeliveryPlanApprovalSchema.parse(
              JSON.parse(attempt.approval_json),
            );
      if (approval) {
        insertApproval.run(
          approval.snapshotId,
          approval.candidateId,
          candidateHashes.get(approval.candidateHash) ?? approval.candidateHash,
          approval.approvedAt,
          stableStringify(approval.approvedBy),
        );
      }
      updateAttempt.run({
        id: attempt.id,
        content_json: canonicalDeliveryPlanEnvelopeBytes(v3Document),
        workflow_definition_id: attemptDefinitionIds.get(attempt.id),
        approval_json: migratedJson(attempt.approval_json, candidateHashes),
        prelaunch_json: migratedJson(attempt.prelaunch_json, candidateHashes),
      });
    }

    context.db.exec("DROP TRIGGER IF EXISTS spec_execution_bindings_immutable");
    const bindingRows = context.db
      .prepare(
        "SELECT spec_execution_id, binding_json FROM spec_execution_bindings",
      )
      .all() as Array<{ spec_execution_id: string; binding_json: string }>;
    const updateBinding = context.db.prepare(
      "UPDATE spec_execution_bindings SET binding_json = ? WHERE spec_execution_id = ?",
    );
    for (const binding of bindingRows) {
      updateBinding.run(
        migratedJson(binding.binding_json, candidateHashes),
        binding.spec_execution_id,
      );
    }
    context.db.exec(SPEC_EXECUTION_BINDINGS_SCHEMA_DDL);

    for (const [oldHash, nextHash] of candidateHashes) {
      context.db
        .prepare(
          "UPDATE spec_delivery_verdicts SET candidate_hash = ? WHERE candidate_hash = ?",
        )
        .run(nextHash, oldHash);
    }
    const executionRows = context.db
      .prepare(
        `SELECT id, workflow_execution_binding_json
         FROM spec_executions
         WHERE workflow_execution_binding_json IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      workflow_execution_binding_json: string;
    }>;
    const updateExecution = context.db.prepare(
      `UPDATE spec_executions
       SET workflow_execution_binding_json = ? WHERE id = ?`,
    );
    for (const execution of executionRows) {
      updateExecution.run(
        migratedJson(
          execution.workflow_execution_binding_json,
          candidateHashes,
        ),
        execution.id,
      );
    }

    const migrationEventExists = context.db.prepare(
      `SELECT 1 FROM spec_events
       WHERE event_type = 'spec-delivery-plan-candidate-migrated'
         AND json_extract(payload_json, '$.snapshotId') = ?
       LIMIT 1`,
    );
    const insertEvent = context.db.prepare(
      `INSERT INTO spec_events (
         spec_id, occurred_at, event_type, actor_json, payload_json
       ) VALUES (?, ?, 'spec-delivery-plan-candidate-migrated', ?, ?)`,
    );
    for (const migrated of migratedSnapshots) {
      if (migrationEventExists.get(migrated.row.id)) continue;
      const attempt = attemptById.get(migrated.row.attempt_id)!;
      insertEvent.run(
        attempt.spec_id,
        migrated.row.proposed_at,
        stableStringify({ kind: "system" }),
        stableStringify({
          attemptId: attempt.id,
          snapshotId: migrated.row.id,
          candidateId: migrated.manifest.candidateId,
          oldCandidateHash: migrated.oldCandidateHash,
          candidateHash: migrated.candidateHash,
          workflowDefinition: migrated.manifest.workflowDefinition,
          bindingHash: migrated.manifest.bindingHash,
        }),
      );
    }

    context.db.exec("COMMIT");
  } catch (error) {
    if (context.db.inTransaction) context.db.exec("ROLLBACK");
    throw error;
  }
  await verifyManagedState(context);
  stampVersion(context);
}

export const nativeSddManagedWorkflowDefinitions: StateMigration = {
  name: "0039-native-sdd-managed-workflow-definitions",
  up: async ({ context }) => {
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    await migrate(context);
  },
};
