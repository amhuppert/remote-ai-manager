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
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  PINNED_REVISION_ID,
  PROJECT_PATH,
  seedDeliveryPlanParents,
  SPEC_ID,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { _createTestDb } from "@/lib/state-store/state-db";
import { admitAuthoredWorkflowLaunch } from "@/lib/workflow-graph/authored-launch-admission";
import {
  MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY,
  createMaximalAuthoredWorkflowLaunchFixture,
} from "@/lib/workflow-graph/testing/maximal-authored-launch";

import {
  canonicalDeliveryPlanCandidateBytes,
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanDocumentSchema,
  type DeliveryPlanCandidateRecord,
} from "./delivery-plan";
import { deliveryPlanCandidateHash } from "./delivery-plan-hash";
import { seedDeliveryPlanFromLast } from "./delivery-plan-seed";
import { createDeliveryPlanService } from "./delivery-plan-service";
import { deliveryPlanPreviewViewSchema } from "./delivery-plan-views";
import type { Spec, SpecRevisionSnapshot } from "./schemas";

type Db = InstanceType<typeof Database>;

const NOW = "2026-08-15T12:00:00.000Z";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-candidate-service",
  backend: "codex",
} as const;
const HUMAN = { kind: "human" } as const;
const SPEC: Spec = {
  id: SPEC_ID,
  projectPath: PROJECT_PATH,
  slug: "delivery-plan",
  name: "Delivery plan",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function scopedInvariantCanary(
  launch: DeliveryPlanCandidateRecord["document"]["launch"],
) {
  return launch.definition.charter.invariants?.find(
    (invariant) => invariant.id === "graph-after-envelope-canary",
  )?.appliesTo;
}

function pinnedRevision(): SpecRevisionSnapshot {
  const criteria = ["criterion-reaffirmed", "criterion-selected"];
  return {
    revision: {
      id: PINNED_REVISION_ID,
      specId: SPEC_ID,
      number: 2,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:pinned",
      citationContractVersion: 2,
      citationVersion: 1,
      citationHash: "0".repeat(64),
      proposedAt: NOW,
      approvedAt: NOW,
      externalDelivery: null,
      createdAt: NOW,
    },
    assumptionCitations: [],
    elements: criteria.map((criterionId, index) => ({
      element: {
        id: criterionId,
        specId: SPEC_ID,
        kind: "criterion" as const,
        number: index + 1,
        parentElementId: null,
        createdAt: NOW,
      },
      version: {
        revisionId: PINNED_REVISION_ID,
        elementId: criterionId,
        position: index,
        payload: {
          kind: "criterion" as const,
          text: criterionId,
          validationStrategy: { kinds: ["test_run" as const] },
        },
        payloadHash: `sha256:${criterionId}`,
        elementVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    })),
  };
}

const SIGNED_REGION_MUTATIONS: ReadonlyArray<
  readonly [string, (record: DeliveryPlanCandidateRecord) => void]
> = [
  [
    "protocol",
    (record) => {
      (record as unknown as Record<string, unknown>).protocol = "other";
    },
  ],
  [
    "schema version",
    (record) => {
      (record as unknown as Record<string, unknown>).schemaVersion = 3;
    },
  ],
  [
    "spec id",
    (record) => {
      record.specId = "spec-other";
    },
  ],
  [
    "attempt id",
    (record) => {
      record.attemptId = "attempt-other";
    },
  ],
  [
    "candidate id",
    (record) => {
      record.candidateId = "candidate-other";
    },
  ],
  [
    "pinned revision",
    (record) => {
      record.pinnedRevisionId = "revision-other";
    },
  ],
  [
    "draft revision",
    (record) => {
      record.draftRevision += 1;
    },
  ],
  [
    "launch",
    (record) => {
      record.document.launch.name = "Changed launch";
    },
  ],
  [
    "binding",
    (record) => {
      record.document.binding.claims[0]!.contextId = "fixture-followup";
    },
  ],
  [
    "layout",
    (record) => {
      record.document.launch.layout.viewport.x += 1;
    },
  ],
  [
    "sources",
    (record) => {
      record.document.launch.definition.charter.sourcesOfTruth[0]!.label =
        "Changed source";
    },
  ],
  [
    "locks",
    (record) => {
      record.document.launch.definition.lockedRegions![0]!.reason =
        "Changed lock";
    },
  ],
];

describe("delivery-plan candidate service identity", () => {
  let db: Db;

  async function createSignedCandidate() {
    const repos = createDeliveryPlanTestRepos(db);
    const document = maximalPlanDocument();
    repos.plans.open({
      attempt: {
        id: "attempt-candidate-service",
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
        created_at: NOW,
        updated_at: NOW,
      },
      occurredAt: NOW,
      actor: AGENT,
    });
    let sequence = 0;
    const service = createDeliveryPlanService({
      plans: repos.plans,
      reviewRepo: repos.review,
      events: repos.events,
      runInTransaction: (operation) => db.transaction(operation).immediate(),
      currentApprovedRevision: async () => pinnedRevision(),
      revisionSnapshot: async () => pinnedRevision(),
      launchedExecutionState: () => "running",
      lastDeliveryBasis: async () => ({
        ok: true,
        basis: { comparedExecutionId: null, criteria: [] },
      }),
      admitLaunch: async ({ launch }) => ({
        ok: true,
        launch,
        warnings: [],
        stableAccountabilityContextIds: ["fixture-context"],
        accountabilityGroupAnalysis: [
          {
            bindingKey: "criterion-selected",
            claimantContextIds: ["fixture-context"],
            stableExistingClaimantContextIds: ["fixture-context"],
            mustRunClaimantContextIds: ["fixture-context"],
            covered: true,
          },
        ],
      }),
      nextId: () => `candidate-service-${++sequence}`,
      now: () => NOW,
    });
    const proposed = await service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const identity = {
      candidateId: proposed.value.attempt.candidateId!,
      candidateHash: proposed.value.attempt.candidateHash!,
    };
    const signed = await service.signOff({
      spec: SPEC,
      ...identity,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    return {
      repos,
      service,
      identity,
      snapshotId: proposed.value.attempt.proposedSnapshotId!,
    };
  }

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    [
      "duplicate claim records",
      () => {
        const document = maximalPlanDocument();
        document.binding.claims.push(
          structuredClone(document.binding.claims[0]!),
        );
        return document;
      },
      "claims.1.contextId",
    ],
    [
      "repeated criteria within a claim record",
      () => {
        const document = maximalPlanDocument();
        document.binding.claims[0]!.criterionElementIds.push(
          "criterion-selected",
        );
        return document;
      },
      "claims.0.criterionElementIds.1",
    ],
  ])(
    "allocates and admits before binding lint refuses %s",
    async (_label, createDocument, expectedPath) => {
      const repos = createDeliveryPlanTestRepos(db);
      const document = createDocument();
      repos.plans.open({
        attempt: {
          id: "attempt-binding-order",
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
          created_at: NOW,
          updated_at: NOW,
        },
        occurredAt: NOW,
        actor: AGENT,
      });
      const order: string[] = [];
      const service = createDeliveryPlanService({
        plans: repos.plans,
        reviewRepo: repos.review,
        events: repos.events,
        runInTransaction: (operation) => db.transaction(operation).immediate(),
        currentApprovedRevision: async () => pinnedRevision(),
        revisionSnapshot: async () => pinnedRevision(),
        launchedExecutionState: () => "running",
        lastDeliveryBasis: async () => ({
          ok: true,
          basis: { comparedExecutionId: null, criteria: [] },
        }),
        admitLaunch: async ({ launch }) => {
          order.push("admit");
          return {
            ok: true,
            launch,
            warnings: [],
            stableAccountabilityContextIds: ["fixture-context"],
            accountabilityGroupAnalysis: [
              {
                bindingKey: "criterion-selected",
                claimantContextIds: ["fixture-context"],
                stableExistingClaimantContextIds: ["fixture-context"],
                mustRunClaimantContextIds: ["fixture-context"],
                covered: true,
              },
            ],
          };
        },
        nextId: () => {
          order.push("allocate");
          return "candidate-binding-order";
        },
        now: () => NOW,
      });

      const proposed = await service.propose({ spec: SPEC, actor: AGENT });

      expect(proposed.ok).toBe(false);
      if (proposed.ok) return;
      expect(proposed.refusal.code).toBe("lint_blocked");
      expect(proposed.refusal.unmetConditions.join(" ")).toContain(
        expectedPath,
      );
      expect(order).toEqual(["allocate", "admit"]);
      expect(
        repos.plans.findSnapshotsByAttemptId("attempt-binding-order"),
      ).toEqual([]);
    },
  );

  it("previews the frozen finalized launch, authored layout, and binding", async () => {
    const { repos, service, identity, snapshotId } =
      await createSignedCandidate();
    const snapshot = repos.plans.findSnapshotById(snapshotId)!;
    const record = deliveryPlanCandidateRecordSchema.parse(
      JSON.parse(snapshot.content_json),
    );
    const preview = await service.preview({ spec: SPEC, stage: "proposed" });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value).toMatchObject({
      candidateId: identity.candidateId,
      candidateHash: identity.candidateHash,
      launch: record.document.launch,
      binding: record.document.binding,
    });
    expect(preview.value.launch.layout).toEqual(record.document.launch.layout);
    expect(preview.value).not.toHaveProperty("compiledHash");
  });

  it("reaffirms a pending soft-stale criterion in the draft binding", async () => {
    const { repos, service } = await createSignedCandidate();
    const reopened = await service.reopen({
      spec: SPEC,
      reason: "Reaffirm a soft-stale criterion.",
      actor: AGENT,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const draft = deliveryPlanDocumentSchema.parse({
      ...maximalPlanDocument(),
      binding: {
        ...maximalPlanDocument().binding,
        dispositions: maximalPlanDocument().binding.dispositions.map(
          (disposition) =>
            disposition.criterionElementId === "criterion-reaffirmed"
              ? {
                  ...disposition,
                  disposition: "pending_reaffirmation",
                }
              : disposition,
        ),
      },
    });
    const edited = await service.edit({
      spec: SPEC,
      expectedDraftRevision: reopened.value.attempt.draftRevision,
      document: draft,
      actor: AGENT,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const blockedProposal = await service.propose({ spec: SPEC, actor: AGENT });
    expect(blockedProposal.ok).toBe(false);
    if (!blockedProposal.ok) {
      expect(blockedProposal.refusal.unmetConditions.join(" ")).toContain(
        "needs human reaffirmation",
      );
    }

    const reaffirmed = await service.reaffirm({
      spec: SPEC,
      expectedDraftRevision: edited.value.attempt.draftRevision,
      criterionElementId: "criterion-reaffirmed",
      actor: HUMAN,
    });

    expect(reaffirmed.ok).toBe(true);
    if (!reaffirmed.ok) return;
    expect(reaffirmed.value.attempt.draftRevision).toBe(
      edited.value.attempt.draftRevision + 1,
    );
    expect(reaffirmed.value.criteria).toContainEqual(
      expect.objectContaining({
        criterionElementId: "criterion-reaffirmed",
        disposition: "reaffirmed",
      }),
    );
    expect(
      repos.plans.findAttemptById(reaffirmed.value.attempt.id)?.content_json,
    ).toContain("reaffirmed");
  });

  it("preserves a future graph field through edit persistence, finalization, candidate bytes, preview, and seed-from-last", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const initialDocument = maximalPlanDocument();
    repos.plans.open({
      attempt: {
        id: "attempt-candidate-canary",
        spec_id: SPEC_ID,
        pinned_revision_id: PINNED_REVISION_ID,
        delta_basis_execution_id: null,
        status: "draft",
        draft_revision: 1,
        content_json: canonicalDeliveryPlanEnvelopeBytes(initialDocument),
        proposed_snapshot_id: null,
        approval_json: null,
        prelaunch_json: null,
        launched_execution_id: null,
        created_at: NOW,
        updated_at: NOW,
      },
      occurredAt: NOW,
      actor: AGENT,
    });
    const authoredLaunch = createMaximalAuthoredWorkflowLaunchFixture();
    delete authoredLaunch.definition.origin;
    delete authoredLaunch.definition.lockedRegions;
    delete authoredLaunch.definition.approvalRequired;
    const editedDocument = deliveryPlanDocumentSchema.parse({
      schemaVersion: 2,
      launch: authoredLaunch,
      binding: {
        dispositions: initialDocument.binding.dispositions,
        claims: [
          {
            contextId: "context-integrate",
            criterionElementIds: ["criterion-selected"],
          },
        ],
      },
    });
    repos.plans.saveDraft({
      attemptId: "attempt-candidate-canary",
      expectedDraftRevision: 1,
      document: editedDocument,
      updatedAt: NOW,
    });
    const persistedAttempt = repos.plans.findAttemptById(
      "attempt-candidate-canary",
    )!;
    const persistedDocument = deliveryPlanDocumentSchema.parse(
      JSON.parse(persistedAttempt.content_json),
    );
    const admissionStages: DeliveryPlanCandidateRecord["document"]["launch"][] =
      [];
    let sequence = 0;
    const service = createDeliveryPlanService({
      plans: repos.plans,
      reviewRepo: repos.review,
      events: repos.events,
      runInTransaction: (operation) => db.transaction(operation).immediate(),
      currentApprovedRevision: async () => pinnedRevision(),
      revisionSnapshot: async () => pinnedRevision(),
      launchedExecutionState: () => "running",
      lastDeliveryBasis: async () => ({
        ok: true,
        basis: { comparedExecutionId: null, criteria: [] },
      }),
      admitLaunch: async ({ spec, launch, accountabilityGroups }) => {
        admissionStages.push(structuredClone(launch));
        const result = await admitAuthoredWorkflowLaunch(launch, {
          caller: "spec-proposal",
          documentScope: { kind: "project", projectPath: spec.projectPath },
          workflowDefaults: undefined,
          accountabilityGroups,
        });
        if (result.ok) admissionStages.push(structuredClone(result.launch));
        return result;
      },
      nextId: () => `candidate-canary-${++sequence}`,
      now: () => NOW,
    });

    const proposed = await service.propose({ spec: SPEC, actor: AGENT });

    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    if (!proposed.ok) return;
    const snapshotId = proposed.value.attempt.proposedSnapshotId!;
    const snapshot = repos.plans.findSnapshotById(snapshotId)!;
    const frozen = deliveryPlanCandidateRecordSchema.parse(
      JSON.parse(snapshot.content_json),
    );
    expect(snapshot.content_json).toBe(
      canonicalDeliveryPlanCandidateBytes(frozen),
    );
    expect(snapshot.candidate_hash).toBe(deliveryPlanCandidateHash(frozen));

    const previewResult = await service.preview({
      spec: SPEC,
      stage: "proposed",
    });
    expect(previewResult.ok, JSON.stringify(previewResult)).toBe(true);
    if (!previewResult.ok) return;
    const preview = deliveryPlanPreviewViewSchema.parse(previewResult.value);
    const seeded = seedDeliveryPlanFromLast({
      source: {
        candidateId: frozen.candidateId,
        launch: preview.launch,
        binding: preview.binding,
      },
      dispositions: preview.binding.dispositions,
    });

    expect([
      scopedInvariantCanary(editedDocument.launch),
      scopedInvariantCanary(persistedDocument.launch),
      ...admissionStages.map(scopedInvariantCanary),
      scopedInvariantCanary(frozen.document.launch),
      scopedInvariantCanary(preview.launch),
      scopedInvariantCanary(seeded.launch),
    ]).toEqual(Array(7).fill(MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY));
    expect(
      seeded.launch.definition.charter.sourcesOfTruth.map(
        (source) => source.rank,
      ),
    ).toEqual(
      authoredLaunch.definition.charter.sourcesOfTruth.map(
        (source) => source.rank,
      ),
    );
  });

  it("recomputes the candidate hash from the exact stored snapshot bytes", async () => {
    const { repos, service, snapshotId } = await createSignedCandidate();
    const snapshot = repos.plans.findSnapshotById(snapshotId)!;
    const changed = deliveryPlanCandidateRecordSchema.parse(
      JSON.parse(snapshot.content_json),
    );
    changed.document.launch.name = "Bytes changed without identity change";
    db.prepare(
      "UPDATE spec_delivery_plan_snapshots SET content_json = ? WHERE id = ?",
    ).run(canonicalDeliveryPlanCandidateBytes(changed), snapshotId);

    const resolution = await service.resolveLaunch({ spec: SPEC });

    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.refusal.code).toBe("integrity_mismatch");
      expect(resolution.refusal.unmetConditions.join(" ")).toContain(
        "canonical bytes hash",
      );
    }
  });

  it.each(SIGNED_REGION_MUTATIONS)(
    "refuses start when the signed %s moves after sign-off",
    async (_label, mutate) => {
      const { repos, service, snapshotId } = await createSignedCandidate();
      const snapshot = repos.plans.findSnapshotById(snapshotId)!;
      const changed = deliveryPlanCandidateRecordSchema.parse(
        JSON.parse(snapshot.content_json),
      );
      mutate(changed);
      const changedHash = deliveryPlanCandidateHash(changed);
      db.prepare(
        `UPDATE spec_delivery_plan_snapshots
       SET content_json = ?, candidate_id = ?, candidate_hash = ?
       WHERE id = ?`,
      ).run(
        canonicalDeliveryPlanCandidateBytes(changed),
        changed.candidateId,
        changedHash,
        snapshotId,
      );

      const resolution = await service.resolveLaunch({ spec: SPEC });
      expect(resolution.kind).toBe("refused");
      if (resolution.kind === "refused") {
        expect(resolution.refusal.code).toBe("integrity_mismatch");
        expect(resolution.refusal.unmetConditions.join(" ")).toContain(
          "approval",
        );
      }
    },
  );
});
