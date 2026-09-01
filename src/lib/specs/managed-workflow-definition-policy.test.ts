import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { _createTestDb } from "@/lib/state-store/state-db";
import {
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { stableStringify } from "@/lib/state-store/serialization";
import { createNativeSddManagedWorkflowDefinitionPolicy } from "./managed-workflow-definition-policy";

type Db = InstanceType<typeof Database>;
let db: Db;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
});

afterEach(() => db.close());

describe("native SDD managed workflow definition policy", () => {
  it("projects the current draft as editable and an older definition as superseded", async () => {
    const binding = {
      schemaVersion: 3,
      binding: { dispositions: [], claims: [] },
    };
    db.prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, status, draft_revision, content_json,
         workflow_definition_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'draft', 2, ?, ?, ?, ?)`,
    ).run(
      "attempt-1",
      SPEC_ID,
      PINNED_REVISION_ID,
      stableStringify(binding),
      "definition-current",
      "2026-08-31T10:00:00.000Z",
      "2026-08-31T10:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO spec_delivery_plan_snapshots (
         id, attempt_id, candidate_id, candidate_hash, draft_revision,
         content_json, pinned_revision_id, proposed_at, proposed_by_json,
         workflow_definition_id, workflow_definition_revision,
         workflow_definition_hash, binding_hash
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      "snapshot-1",
      "attempt-1",
      "definition-old",
      `sha256:${"1".repeat(64)}`,
      stableStringify({
        protocol: "native-sdd-delivery-candidate/v3",
        schemaVersion: 3,
        specId: SPEC_ID,
        attemptId: "attempt-1",
        candidateId: "definition-old",
        pinnedRevisionId: PINNED_REVISION_ID,
        draftRevision: 1,
        workflowDefinition: {
          id: "definition-old",
          revision: 1,
          definitionHash: `sha256:${"2".repeat(64)}`,
        },
        binding: binding.binding,
        bindingHash: `sha256:${"3".repeat(64)}`,
      }),
      PINNED_REVISION_ID,
      "2026-08-31T09:00:00.000Z",
      stableStringify({ kind: "human", userId: "alex" }),
      "definition-old",
      `sha256:${"2".repeat(64)}`,
      `sha256:${"3".repeat(64)}`,
    );
    const policy = createNativeSddManagedWorkflowDefinitionPolicy({
      db,
      resolveProjectName: () => "repo",
    });

    const projections = await policy.list(PROJECT_PATH, [
      "definition-current",
      "definition-old",
    ]);

    expect(projections.get("definition-current")).toMatchObject({
      lifecycle: "draft",
      editable: true,
      isCurrentDefinition: true,
    });
    expect(projections.get("definition-old")).toMatchObject({
      lifecycle: "superseded",
      editable: false,
      isCurrentDefinition: false,
    });
  });

  it("uses the latest approved candidate as the managed Changes baseline", async () => {
    const binding = {
      schemaVersion: 3,
      binding: {
        dispositions: [],
        claims: [
          {
            contextId: "context-current",
            criterionElementIds: ["criterion-1"],
          },
        ],
      },
    };
    db.prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, status, draft_revision, content_json,
         workflow_definition_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'draft', 2, ?, ?, ?, ?)`,
    ).run(
      "attempt-current",
      SPEC_ID,
      PINNED_REVISION_ID,
      stableStringify(binding),
      "definition-current",
      "2026-08-31T11:00:00.000Z",
      "2026-08-31T11:00:00.000Z",
    );
    const baselineManifest = {
      protocol: "native-sdd-delivery-candidate/v3",
      schemaVersion: 3,
      specId: SPEC_ID,
      attemptId: "attempt-current",
      candidateId: "definition-approved",
      pinnedRevisionId: PINNED_REVISION_ID,
      draftRevision: 1,
      workflowDefinition: {
        id: "definition-approved",
        revision: 1,
        definitionHash: `sha256:${"2".repeat(64)}`,
      },
      binding: { dispositions: [], claims: [] },
      bindingHash: `sha256:${"3".repeat(64)}`,
    } as const;
    db.prepare(
      `INSERT INTO spec_delivery_plan_snapshots (
         id, attempt_id, candidate_id, candidate_hash, draft_revision,
         content_json, pinned_revision_id, proposed_at, proposed_by_json,
         workflow_definition_id, workflow_definition_revision,
         workflow_definition_hash, binding_hash
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      "snapshot-approved",
      "attempt-current",
      "definition-approved",
      `sha256:${"1".repeat(64)}`,
      stableStringify(baselineManifest),
      PINNED_REVISION_ID,
      "2026-08-31T10:00:00.000Z",
      stableStringify({ kind: "human" }),
      "definition-approved",
      baselineManifest.workflowDefinition.definitionHash,
      baselineManifest.bindingHash,
    );
    db.prepare(
      `INSERT INTO spec_delivery_plan_candidate_approvals (
         snapshot_id, candidate_id, candidate_hash, approved_at, approved_by_json
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "snapshot-approved",
      "definition-approved",
      `sha256:${"1".repeat(64)}`,
      "2026-08-31T10:01:00.000Z",
      stableStringify({ kind: "human" }),
    );
    const policy = createNativeSddManagedWorkflowDefinitionPolicy({
      db,
      resolveProjectName: () => "repo",
    });

    const detail = await policy.get(PROJECT_PATH, "definition-current");

    expect(detail?.approvedBaseline).toMatchObject({
      snapshotId: "snapshot-approved",
      candidateId: "definition-approved",
    });
    expect(detail?.changes).toMatchObject({ claims: true });
  });
});
