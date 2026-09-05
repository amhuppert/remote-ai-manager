import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";

import {
  canonicalDeliveryPlanCandidateBytes,
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanCandidateManifestV4Schema,
  type DeliveryPlanDocument,
} from "@/lib/specs/delivery-plan";
import {
  deliveryPlanBindingHash,
  deliveryPlanCandidateHash,
} from "@/lib/specs/delivery-plan-hash";
import {
  PINNED_REVISION_ID,
  SPEC_ID,
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  maximalCoveragePlanDocument,
  seedDeliveryPlanParents,
} from "./spec-delivery-plan-test-fixture";
import {
  FinalizedDeliveryPlanCandidateMismatchError,
  FinalizedDeliveryPlanApprovalIdentityMismatchError,
  StaleDeliveryPlanDraftError,
  type SpecDeliveryPlanRepo,
} from "./spec-delivery-plan-repo";
import { _createTestDb } from "./state-db";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";
import { deriveDeliveryPlanClaims } from "@/lib/specs/delivery-plan-binding-lint";

type Db = InstanceType<typeof Database>;

const AGENT = {
  kind: "agent",
  conversationId: "conversation-v3-repository",
  backend: "codex",
} as const;
const HUMAN = { kind: "human" } as const;

let db: Db;
let plans: SpecDeliveryPlanRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedDeliveryPlanParents(db);
  plans = createDeliveryPlanTestRepos(db).plans;
});

afterEach(() => db.close());

function openAttempt(document: DeliveryPlanDocument = maximalPlanDocument()) {
  return plans.open({
    attempt: {
      id: "attempt-v3-round-trip",
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(document),
      proposed_snapshot_id: null,
      approval_json: null,
      prelaunch_json: null,
      launched_execution_id: null,
      workflow_definition_id: "definition-v3-round-trip",
      created_at: "2026-08-15T09:00:00.000Z",
      updated_at: "2026-08-15T09:00:00.000Z",
    },
    occurredAt: "2026-08-15T09:00:00.000Z",
    actor: AGENT,
  });
}

function candidate(
  attemptId: string,
  draftRevision: number,
  binding = maximalPlanDocument().binding,
) {
  const record = deliveryPlanCandidateRecordSchema.parse({
    protocol: "native-sdd-delivery-candidate/v3",
    schemaVersion: 3,
    specId: SPEC_ID,
    attemptId,
    candidateId: "definition-v3-round-trip",
    pinnedRevisionId: PINNED_REVISION_ID,
    draftRevision,
    workflowDefinition: {
      id: "definition-v3-round-trip",
      revision: 4,
      definitionHash: `sha256:${"d".repeat(64)}`,
    },
    binding,
    bindingHash: deliveryPlanBindingHash(binding),
  });
  return { record, candidateHash: deliveryPlanCandidateHash(record) };
}

describe("version-3 delivery-plan repository contract", () => {
  it("round-trips the complete v4 manifest with dispositions-only binding and frozen derived claims", async () => {
    const document = maximalCoveragePlanDocument();
    const opened = openAttempt(document);
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    const context = launch.definition.executionContexts.find(
      (entry) => entry.id === "context-spawner",
    );
    if (!context) throw new Error("Missing stable fixture context");
    context.acceptanceCriteria = [
      {
        id: "observable",
        statement: "The selected outcome holds",
        covers: ["criterion-selected"],
      },
    ];
    const historical = candidate(opened.id, opened.draft_revision).record;
    await assertRoundTripDurability({
      label: "delivery-plan-v4-candidate",
      schema: deliveryPlanCandidateManifestV4Schema,
      buildMaximalFixture: () =>
        deliveryPlanCandidateManifestV4Schema.parse({
          ...historical,
          protocol: "native-sdd-delivery-candidate/v4",
          schemaVersion: 4,
          binding: document.binding,
          bindingHash: deliveryPlanBindingHash(document.binding),
          claims: deriveDeliveryPlanClaims(document.binding, launch.definition),
        }),
      persist: (record) => {
        const proposed = plans.propose({
          attemptId: opened.id,
          expectedDraftRevision: opened.draft_revision,
          snapshotId: "snapshot-v4",
          proposedAt: "2026-09-05T12:00:00.000Z",
          actor: AGENT,
          candidate: {
            record,
            candidateHash: deliveryPlanCandidateHash(record),
          },
        });
        return deliveryPlanCandidateManifestV4Schema.parse(
          JSON.parse(proposed.snapshot.content_json),
        );
      },
      reload: () => {
        const snapshot = plans.findSnapshotById("snapshot-v4");
        return snapshot === null
          ? null
          : deliveryPlanCandidateManifestV4Schema.parse(
              JSON.parse(snapshot.content_json),
            );
      },
      fieldPolicies: {
        claims: "derived-on-write",
        bindingHash: "derived-on-write",
      },
    });
    expect(
      JSON.parse(plans.findAttemptById(opened.id)?.content_json ?? "null"),
    ).not.toHaveProperty("binding.claims");
  });
  it("rejects manifests that do not match the attempt definition and editable binding", () => {
    const opened = openAttempt();
    const valid = candidate(opened.id, opened.draft_revision);
    const otherBinding = structuredClone(maximalPlanDocument().binding);
    otherBinding.dispositions[0]!.disposition = "deferred";
    const mismatches = [
      candidate(opened.id, opened.draft_revision, otherBinding),
      (() => {
        const record = deliveryPlanCandidateRecordSchema.parse({
          ...valid.record,
          candidateId: "definition-other",
          workflowDefinition: {
            ...valid.record.workflowDefinition,
            id: "definition-other",
          },
        });
        return { record, candidateHash: deliveryPlanCandidateHash(record) };
      })(),
      (() => {
        const record = deliveryPlanCandidateRecordSchema.parse({
          ...valid.record,
          bindingHash: `sha256:${"0".repeat(64)}`,
        });
        return { record, candidateHash: deliveryPlanCandidateHash(record) };
      })(),
    ];

    for (const [index, mismatch] of mismatches.entries()) {
      expect(() =>
        plans.propose({
          attemptId: opened.id,
          expectedDraftRevision: opened.draft_revision,
          snapshotId: `snapshot-invalid-${index}`,
          candidate: mismatch,
          proposedAt: "2026-08-15T09:03:00.000Z",
          actor: AGENT,
        }),
      ).toThrow(FinalizedDeliveryPlanCandidateMismatchError);
    }
    expect(plans.findSnapshotsByAttemptId(opened.id)).toEqual([]);
  });

  it("round-trips binding CAS, immutable manifest, approval history, and clone-on-reopen identity", () => {
    const opened = openAttempt();
    const editedDocument = maximalPlanDocument();
    editedDocument.binding.dispositions[0]!.disposition = "deferred";
    const edited = plans.saveDraft({
      attemptId: opened.id,
      expectedDraftRevision: 1,
      document: editedDocument,
      updatedAt: "2026-08-15T09:01:00.000Z",
    });
    expect(edited.draft_revision).toBe(2);
    expect(JSON.parse(edited.content_json)).not.toHaveProperty("launch");

    const beforeStale = plans.findAttemptById(opened.id);
    expect(() =>
      plans.saveDraft({
        attemptId: opened.id,
        expectedDraftRevision: 1,
        document: maximalPlanDocument(),
        updatedAt: "2026-08-15T09:02:00.000Z",
      }),
    ).toThrow(StaleDeliveryPlanDraftError);
    expect(plans.findAttemptById(opened.id)).toEqual(beforeStale);

    const frozen = candidate(
      opened.id,
      edited.draft_revision,
      editedDocument.binding,
    );
    const proposed = plans.propose({
      attemptId: opened.id,
      expectedDraftRevision: edited.draft_revision,
      snapshotId: "snapshot-v3-round-trip",
      candidate: frozen,
      proposedAt: "2026-08-15T09:03:00.000Z",
      actor: AGENT,
    });
    expect(proposed.snapshot).toMatchObject({
      workflow_definition_id: frozen.record.workflowDefinition.id,
      workflow_definition_revision: frozen.record.workflowDefinition.revision,
      workflow_definition_hash: frozen.record.workflowDefinition.definitionHash,
      binding_hash: frozen.record.bindingHash,
      content_json: canonicalDeliveryPlanCandidateBytes(frozen.record),
    });
    expect(JSON.parse(proposed.snapshot.content_json)).not.toHaveProperty(
      "document",
    );

    expect(() =>
      plans.recordTransition({
        attemptId: opened.id,
        transition: {
          kind: "approve",
          candidateId: frozen.record.candidateId,
          candidateHash: `sha256:${"0".repeat(64)}`,
        },
        occurredAt: "2026-08-15T09:04:00.000Z",
        actor: HUMAN,
      }),
    ).toThrow(FinalizedDeliveryPlanApprovalIdentityMismatchError);

    const approved = plans.recordTransition({
      attemptId: opened.id,
      transition: {
        kind: "approve",
        candidateId: frozen.record.candidateId,
        candidateHash: frozen.candidateHash,
      },
      occurredAt: "2026-08-15T09:05:00.000Z",
      actor: HUMAN,
    });
    expect(approved.status).toBe("approved");
    expect(
      plans.findCandidateApprovalBySnapshotId(proposed.snapshot.id),
    ).toMatchObject({
      candidate_id: frozen.record.candidateId,
      candidate_hash: frozen.candidateHash,
    });

    const reopened = plans.reopen({
      attemptId: opened.id,
      workflowDefinitionId: "definition-v3-clone",
      reopenedAt: "2026-08-15T09:06:00.000Z",
      actor: AGENT,
      reason: "Adjust the managed workflow.",
    });
    expect(reopened.attempt).toMatchObject({
      status: "draft",
      draft_revision: 3,
      workflow_definition_id: "definition-v3-clone",
      proposed_snapshot_id: null,
      approval_json: null,
    });
    expect(plans.findSnapshotById(proposed.snapshot.id)).toEqual(
      proposed.snapshot,
    );
    expect(
      plans.findLatestApprovedSnapshotBySpecId({ specId: SPEC_ID }),
    ).toEqual(proposed.snapshot);
  });
});
