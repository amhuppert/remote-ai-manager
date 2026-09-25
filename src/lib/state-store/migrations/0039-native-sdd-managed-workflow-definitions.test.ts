import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import {
  deliveryPlanCandidateManifestV3Schema,
  deliveryPlanV3DocumentSchema,
} from "@/lib/specs/delivery-plan";
import { deliveryPlanCandidateHash } from "@/lib/specs/delivery-plan-hash";
import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import {
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
  maximalLegacyPlanDocument,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import {
  _createTestDbAtPath,
  SPEC_DELIVERY_PLAN_SCHEMA_DDL,
} from "../state-db";
import { schemaCompatibilityBarrierPath } from "../schema-compatibility";
import { workflowDefinitionFilePath } from "@/lib/workflow-graph/storage-paths";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION,
  nativeSddManagedWorkflowDefinitions,
} from "./0039-native-sdd-managed-workflow-definitions";

type Db = InstanceType<typeof Database>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function world(): Promise<{ configDir: string; db: Db }> {
  const configDir = await mkdtemp(path.join(tmpdir(), "cc-sdd-managed-"));
  tempDirs.push(configDir);
  const db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  openDbs.push(db);
  seedDeliveryPlanParents(db);
  return { configDir, db };
}

async function runMigration(db: Db, configDir: string | null): Promise<void> {
  await nativeSddManagedWorkflowDefinitions.up({
    name: nativeSddManagedWorkflowDefinitions.name,
    context: { db, configDir },
  });
}

function insertAttempt(
  db: Db,
  input: {
    id: string;
    status: "draft" | "proposed";
    proposedSnapshotId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, workflow_definition_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.id,
    SPEC_ID,
    PINNED_REVISION_ID,
    input.status,
    stableStringify(maximalLegacyPlanDocument()),
    input.proposedSnapshotId ?? null,
    "2026-08-30T10:00:00.000Z",
    "2026-08-30T10:00:00.000Z",
  );
}

describe("0039-native-sdd-managed-workflow-definitions", () => {
  it("owns schema version 14 and publishes its compatibility barrier", async () => {
    const { configDir, db } = await world();

    expect(NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION).toBe(14);
    await runMigration(db, configDir);

    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          configDir,
          NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION,
        ),
      ),
    ).toBe(true);
  });

  it("stamps a fresh database without requiring a config directory", async () => {
    const { db } = await world();

    await runMigration(db, null);

    expect(
      db
        .prepare("SELECT description FROM schema_migrations WHERE version = ?")
        .get(NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION),
    ).toBeDefined();
  });

  it("repairs an approval foreign key left on a renamed snapshot table", async () => {
    const { db } = await world();
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX idx_spec_delivery_plan_snapshots_attempt;
      DROP INDEX idx_spec_delivery_plan_snapshots_definition;
      ALTER TABLE spec_delivery_plan_snapshots
        RENAME TO spec_delivery_plan_snapshots_v2;
    `);
    db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
    db.exec(`
      DROP TABLE spec_delivery_plan_snapshots_v2;
      PRAGMA foreign_keys = ON;
    `);
    expect(
      db
        .prepare(
          "PRAGMA foreign_key_list(spec_delivery_plan_candidate_approvals)",
        )
        .all(),
    ).toEqual([
      expect.objectContaining({ table: "spec_delivery_plan_snapshots_v2" }),
    ]);

    await runMigration(db, null);

    expect(
      db
        .prepare(
          "PRAGMA foreign_key_list(spec_delivery_plan_candidate_approvals)",
        )
        .all(),
    ).toEqual([
      expect.objectContaining({ table: "spec_delivery_plan_snapshots" }),
    ]);
  });

  it("materializes a draft as a managed definition and stores only its v3 binding", async () => {
    const { configDir, db } = await world();
    insertAttempt(db, { id: "attempt-draft", status: "draft" });

    await runMigration(db, configDir);

    const attempt = db
      .prepare(
        `SELECT content_json, workflow_definition_id
         FROM spec_delivery_plan_attempts WHERE id = ?`,
      )
      .get("attempt-draft") as {
      content_json: string;
      workflow_definition_id: string;
    };
    expect(
      deliveryPlanV3DocumentSchema.parse(JSON.parse(attempt.content_json)),
    ).not.toHaveProperty("launch");
    expect(attempt.workflow_definition_id).toMatch(/^sdd-draft-[a-f0-9]{40}$/u);
    const definitionPath = workflowDefinitionFilePath(
      configDir,
      { kind: "project", projectPath: PROJECT_PATH },
      attempt.workflow_definition_id,
    );
    const record = JSON.parse(await readFile(definitionPath, "utf8")) as {
      id: string;
      revision: number;
      layout: { workflowId: string };
    };
    expect(record).toMatchObject({
      id: attempt.workflow_definition_id,
      revision: 1,
      layout: { workflowId: attempt.workflow_definition_id },
    });

    await runMigration(db, configDir);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM spec_delivery_plan_attempts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("refuses version-2 rows without a configuration directory and leaves them uncut", async () => {
    const { db } = await world();
    insertAttempt(db, { id: "attempt-no-config", status: "draft" });

    await expect(runMigration(db, null)).rejects.toThrow(
      /requires configDir.*version-2/u,
    );

    const row = db
      .prepare(
        "SELECT content_json, workflow_definition_id FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get("attempt-no-config") as {
      content_json: string;
      workflow_definition_id: string | null;
    };
    expect(JSON.parse(row.content_json)).toMatchObject({ schemaVersion: 2 });
    expect(row.workflow_definition_id).toBeNull();
    expect(
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("refuses a deterministic draft-file collision before cutting over SQLite", async () => {
    const { configDir, db } = await world();
    const attemptId = "attempt-collision";
    insertAttempt(db, { id: attemptId, status: "draft" });
    const definitionId = `sdd-draft-${createHash("sha256")
      .update(`${attemptId}:1`)
      .digest("hex")
      .slice(0, 40)}`;
    const definitionPath = workflowDefinitionFilePath(
      configDir,
      { kind: "project", projectPath: PROJECT_PATH },
      definitionId,
    );
    const legacy = maximalLegacyPlanDocument();
    await atomicWriteJson(definitionPath, {
      id: definitionId,
      name: "Conflicting managed definition",
      description: null,
      schemaVersion: 1,
      revision: 1,
      definition: legacy.launch.definition,
      layout: { ...legacy.launch.layout, workflowId: definitionId },
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    });

    await expect(runMigration(db, configDir)).rejects.toThrow(
      /collision.*authored bytes do not match/u,
    );

    const row = db
      .prepare(
        "SELECT content_json, workflow_definition_id FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get(attemptId) as {
      content_json: string;
      workflow_definition_id: string | null;
    };
    expect(JSON.parse(row.content_json)).toMatchObject({ schemaVersion: 2 });
    expect(row.workflow_definition_id).toBeNull();
    expect(
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("refuses to stamp an invalid v3 definition reference", async () => {
    const { configDir, db } = await world();
    db.prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
         draft_revision, content_json, proposed_snapshot_id, approval_json,
         prelaunch_json, launched_execution_id, workflow_definition_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, NULL, 'draft', 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      "attempt-invalid-v3",
      SPEC_ID,
      PINNED_REVISION_ID,
      stableStringify({
        schemaVersion: 3,
        binding: maximalLegacyPlanDocument().binding,
      }),
      "missing-definition",
      "2026-08-30T10:00:00.000Z",
      "2026-08-30T10:00:00.000Z",
    );

    await expect(runMigration(db, configDir)).rejects.toThrow(
      /missing-definition.*missing/u,
    );
    expect(
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(NATIVE_SDD_MANAGED_DEFINITIONS_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("converts an immutable proposal to a manifest that pins exact definition bytes", async () => {
    const { configDir, db } = await world();
    const attemptId = "attempt-proposed";
    const snapshotId = "snapshot-proposed";
    const candidateId = "candidate-proposed";
    // The floor DDL no longer admits `proposed`; the schema this migration
    // ran against did, and 0057 later retires such attempts.
    db.pragma("ignore_check_constraints = ON");
    insertAttempt(db, {
      id: attemptId,
      status: "proposed",
      proposedSnapshotId: snapshotId,
    });
    const document = maximalLegacyPlanDocument();
    const finalized = {
      ...document,
      launch: finalizeDeliveryPlanLaunch({
        specId: SPEC_ID,
        specSlug: "delivery-plan",
        pinnedRevisionId: PINNED_REVISION_ID,
        attemptId,
        candidateId,
        launch: document.launch,
      }),
    };
    const candidate = {
      protocol: "native-sdd-delivery-candidate/v2",
      schemaVersion: 2,
      specId: SPEC_ID,
      attemptId,
      candidateId,
      pinnedRevisionId: PINNED_REVISION_ID,
      draftRevision: 1,
      document: finalized,
    } as const;
    const candidateBytes = stableStringify(candidate);
    db.prepare(
      `INSERT INTO spec_delivery_plan_snapshots (
         id, attempt_id, candidate_id, candidate_hash, draft_revision,
         content_json, pinned_revision_id, proposed_at, proposed_by_json,
         workflow_definition_id, workflow_definition_revision,
         workflow_definition_hash, binding_hash
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
      snapshotId,
      attemptId,
      candidateId,
      sha256(candidateBytes),
      candidateBytes,
      PINNED_REVISION_ID,
      "2026-08-30T10:01:00.000Z",
      '{"kind":"human","userId":"alex"}',
    );
    db.prepare(
      `INSERT INTO spec_events (
         spec_id, occurred_at, event_type, actor_json, payload_json
       ) VALUES (?, ?, 'spec-review-item-approved', ?, ?)`,
    ).run(
      SPEC_ID,
      "2026-08-30T10:02:00.000Z",
      '{"kind":"human","userId":"alex"}',
      stableStringify({
        kind: "delivery-plan-candidate-approved",
        gate: "execution_start",
        attemptId,
        candidateId,
        candidateHash: sha256(candidateBytes),
      }),
    );

    await runMigration(db, configDir);
    db.pragma("ignore_check_constraints = OFF");

    const snapshot = db
      .prepare("SELECT * FROM spec_delivery_plan_snapshots WHERE id = ?")
      .get(snapshotId) as Record<string, unknown>;
    const manifest = deliveryPlanCandidateManifestV3Schema.parse(
      JSON.parse(String(snapshot["content_json"])),
    );
    expect(manifest.workflowDefinition).toMatchObject({
      id: candidateId,
      revision: 1,
      definitionHash: snapshot["workflow_definition_hash"],
    });
    expect(snapshot["candidate_hash"]).toBe(
      deliveryPlanCandidateHash(manifest),
    );
    expect(snapshot["binding_hash"]).toBe(manifest.bindingHash);
    expect(
      db
        .prepare(
          `SELECT candidate_id, candidate_hash, approved_at
           FROM spec_delivery_plan_candidate_approvals
           WHERE snapshot_id = ?`,
        )
        .get(snapshotId),
    ).toEqual({
      candidate_id: candidateId,
      candidate_hash: deliveryPlanCandidateHash(manifest),
      approved_at: "2026-08-30T10:02:00.000Z",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM spec_events
           WHERE event_type = 'spec-delivery-plan-candidate-migrated'
             AND json_extract(payload_json, '$.snapshotId') = ?`,
        )
        .get(snapshotId),
    ).toEqual({ count: 1 });
  });
});
