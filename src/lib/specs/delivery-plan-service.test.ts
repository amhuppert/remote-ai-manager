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
  EARLIER_EXECUTION_ID,
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
  createDeliveryPlanTestRepos,
  maximalPlanDocument,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { _createTestDb } from "@/lib/state-store/state-db";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  createDeliveryPlanService,
  type DeliveryPlanServiceDeps,
} from "./delivery-plan-service";
import type { DeliveryPlanSeedBasis } from "./delivery-plan-seed";
import type { Spec, SpecRevisionSnapshot } from "./schemas";

type Db = InstanceType<typeof Database>;

const NOW = "2026-08-15T12:00:00.000Z";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-plan-service",
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

/** R1 with two criteria, so findings and unresolved rows carry real handles. */
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
    elements: [
      {
        element: {
          id: "requirement-one",
          specId: SPEC_ID,
          kind: "requirement" as const,
          number: 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: PINNED_REVISION_ID,
          elementId: "requirement-one",
          position: 0,
          payload: {
            kind: "requirement" as const,
            statement: "The plan states what it owes.",
            priority: "must" as const,
            risk: "high" as const,
          },
          payloadHash: "sha256:requirement-one",
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      ...criteria.map((criterionId, index) => ({
        element: {
          id: criterionId,
          specId: SPEC_ID,
          kind: "criterion" as const,
          number: index + 1,
          parentElementId: "requirement-one",
          createdAt: NOW,
        },
        version: {
          revisionId: PINNED_REVISION_ID,
          elementId: criterionId,
          position: index + 1,
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
    ],
  };
}

const NO_DELIVERY: DeliveryPlanSeedBasis = {
  comparedExecutionId: null,
  criteria: [],
};

function serviceWith(
  db: Db,
  repos: ReturnType<typeof createDeliveryPlanTestRepos>,
  overrides: Partial<DeliveryPlanServiceDeps> = {},
) {
  let sequence = 0;
  return createDeliveryPlanService({
    plans: repos.plans,
    reviewRepo: repos.review,
    events: repos.events,
    runInTransaction: (operation) => db.transaction(operation).immediate(),
    currentApprovedRevision: async () => pinnedRevision(),
    revisionSnapshot: async () => pinnedRevision(),
    // Cases that care about a finished run override this; the default keeps a
    // launched attempt blocking, which is what every other case expects.
    launchedExecutionState: () => "running",
    lastDeliveryBasis: async () => ({ ok: true, basis: NO_DELIVERY }),
    admitLaunch: async ({ launch, accountabilityGroups }) => ({
      ok: true,
      launch,
      warnings: [],
      stableAccountabilityContextIds: ["fixture-context"],
      accountabilityGroupAnalysis: accountabilityGroups.map((group) => ({
        bindingKey: group.bindingKey,
        claimantContextIds: [...group.claimantContextIds],
        stableExistingClaimantContextIds: [...group.claimantContextIds],
        mustRunClaimantContextIds: [...group.claimantContextIds],
        covered: group.claimantContextIds.length > 0,
      })),
    }),
    nextId: () => `plan-service-${++sequence}`,
    now: () => NOW,
    ...overrides,
  });
}

function openAttempt(
  repos: ReturnType<typeof createDeliveryPlanTestRepos>,
  input: { id: string; document: DeliveryPlanDocument },
): void {
  repos.plans.open({
    attempt: {
      id: input.id,
      spec_id: SPEC_ID,
      pinned_revision_id: PINNED_REVISION_ID,
      delta_basis_execution_id: null,
      status: "draft",
      draft_revision: 1,
      content_json: canonicalDeliveryPlanEnvelopeBytes(input.document),
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
}

describe("delivery-plan service draft health", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  it("reports on read exactly what propose refuses", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const document = maximalPlanDocument();
    document.binding.claims = [];
    openAttempt(repos, { id: "attempt-health", document });
    const service = serviceWith(db, repos);

    const read = await service.read({ spec: SPEC });
    if (!read.ok) throw new Error(read.refusal.unmetConditions.join(" "));

    expect(read.value.health.blocking).toBeGreaterThan(0);
    expect(
      read.value.health.findings.map((finding) => finding.ruleId),
    ).toContain("binding/selected-criterion-unclaimed");
    expect(read.value.unresolved.map((row) => row.criterionElementId)).toEqual([
      "criterion-selected",
    ]);

    const proposed = await service.propose({ spec: SPEC, actor: AGENT });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) throw new Error("expected a refusal");
    expect(proposed.refusal.code).toBe("lint_blocked");
    expect(proposed.refusal.unmetConditions).toHaveLength(
      read.value.health.blocking,
    );
  });

  it("reports a clean draft as proposable", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, {
      id: "attempt-clean",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos);

    const read = await service.read({ spec: SPEC });
    if (!read.ok) throw new Error(read.refusal.unmetConditions.join(" "));

    expect(read.value.health).toEqual({
      total: 0,
      blocking: 0,
      counts: [],
      findings: [],
    });
    expect(read.value.unresolved).toEqual([]);
    expect((await service.propose({ spec: SPEC, actor: AGENT })).ok).toBe(true);
  });

  it("reports the graph launch its proposal cannot admit", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, {
      id: "attempt-graph",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos, {
      admitLaunch: async () => ({
        ok: false,
        issues: [
          {
            path: "definition.executionContexts.0.id",
            message: "Context ids must be unique.",
          },
        ],
      }),
    });

    const read = await service.read({ spec: SPEC });
    if (!read.ok) throw new Error(read.refusal.unmetConditions.join(" "));

    expect(read.value.health.blocking).toBe(1);
    expect(read.value.health.findings[0]?.message).toBe(
      "Context ids must be unique.",
    );
  });

  it("carries the pre-edit blocking count on the edit receipt", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const blocked = maximalPlanDocument();
    blocked.binding.claims = [];
    openAttempt(repos, { id: "attempt-receipt", document: blocked });
    const service = serviceWith(db, repos);

    const edited = await service.edit({
      spec: SPEC,
      expectedDraftRevision: 1,
      document: maximalPlanDocument(),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));

    expect(edited.value.previousHealth).toEqual({ total: 2, blocking: 2 });
    expect(edited.value.health.blocking).toBe(0);
  });
});

describe("delivery-plan service preview", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  it("refuses a finalized preview read for a draft revision the attempt has left", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, {
      id: "attempt-preview",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos);
    const proposed = await service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));

    const stale = await service.preview({
      spec: SPEC,
      stage: "proposed",
      expectedDraftRevision: proposed.value.attempt.draftRevision + 1,
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected a refusal");
    expect(stale.refusal.code).toBe("stale_plan_draft");

    const current = await service.preview({
      spec: SPEC,
      stage: "proposed",
      expectedDraftRevision: proposed.value.attempt.draftRevision,
    });
    expect(current.ok).toBe(true);
  });
});

describe("delivery-plan service seeding", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  async function abandonedProposal(
    repos: ReturnType<typeof createDeliveryPlanTestRepos>,
  ): Promise<void> {
    openAttempt(repos, {
      id: "attempt-prior",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos);
    const proposed = await service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    repos.plans.recordTransition({
      attemptId: "attempt-prior",
      transition: { kind: "abandon", reason: "Seed the next attempt." },
      occurredAt: NOW,
      actor: AGENT,
    });
  }

  /**
   * A prior attempt taken all the way to `launched`, which is the state every
   * real delivery leaves behind. The seed cases above use an ABANDONED prior
   * attempt, so nothing else here exercises the state a spec is actually in
   * after it delivers.
   */
  async function launchedAttempt(
    repos: ReturnType<typeof createDeliveryPlanTestRepos>,
  ): Promise<void> {
    openAttempt(repos, {
      id: "attempt-launched",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos);
    const proposed = await service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const { candidateId, candidateHash } = proposed.value.attempt;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate identity.");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
  }

  it.each([
    ["delivered", "delivered"],
    ["abandoned", "abandoned"],
  ] as const)(
    "opens a replacement once the launched attempt's execution is %s",
    async (_label, state) => {
      const repos = createDeliveryPlanTestRepos(db);
      await launchedAttempt(repos);
      const service = serviceWith(db, repos, {
        launchedExecutionState: () => state,
      });

      const opened = await service.open({
        spec: SPEC,
        seedFromLast: true,
        actor: AGENT,
      });

      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.attempt.status).toBe("draft");
      // The delivered attempt stays readable rather than being erased: only
      // `open` stops treating it as a blocker.
      expect(repos.plans.findAttemptById("attempt-launched")?.status).toBe(
        "launched",
      );
    },
  );

  it.each([
    ["running", "running"],
    ["still cleaning up", "abandoning"],
    ["unresolvable", null],
  ] as const)(
    "still refuses a replacement while the launched execution is %s",
    async (_label, state) => {
      const repos = createDeliveryPlanTestRepos(db);
      await launchedAttempt(repos);
      const service = serviceWith(db, repos, {
        launchedExecutionState: () => state,
      });

      const opened = await service.open({
        spec: SPEC,
        seedFromLast: true,
        actor: AGENT,
      });

      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.refusal.code).toBe("plan_status_conflict");
    },
  );

  it("derives seeded dispositions from the delivery delta", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    await abandonedProposal(repos);
    const service = serviceWith(db, repos, {
      lastDeliveryBasis: async () => ({
        ok: true,
        basis: {
          comparedExecutionId: EARLIER_EXECUTION_ID,
          criteria: [
            {
              criterionElementId: "criterion-reaffirmed",
              deliveryClass: "soft_stale",
              deliveredByExecutionId: EARLIER_EXECUTION_ID,
            },
            {
              criterionElementId: "criterion-selected",
              deliveryClass: "delivered_and_fresh",
              deliveredByExecutionId: EARLIER_EXECUTION_ID,
            },
          ],
        },
      }),
    });

    const opened = await service.open({
      spec: SPEC,
      seedFromLast: true,
      actor: AGENT,
    });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    expect(opened.value.document.binding.dispositions).toEqual([
      {
        criterionElementId: "criterion-reaffirmed",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: EARLIER_EXECUTION_ID,
      },
      {
        criterionElementId: "criterion-selected",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: EARLIER_EXECUTION_ID,
      },
    ]);
    // Nothing is selected, so the prior claim on `criterion-selected` cannot
    // ride along into the new attempt.
    expect(opened.value.document.binding.claims).toEqual([]);
    expect(opened.value.attempt.deltaBasisExecutionId).toBe(
      EARLIER_EXECUTION_ID,
    );
    expect(
      repos.plans.findAttemptById(opened.value.attempt.id)
        ?.delta_basis_execution_id,
    ).toBe(EARLIER_EXECUTION_ID);
  });

  it("records the measured delivery on an unseeded attempt too", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const service = serviceWith(db, repos, {
      lastDeliveryBasis: async () => ({
        ok: true,
        basis: {
          comparedExecutionId: EARLIER_EXECUTION_ID,
          criteria: [
            {
              criterionElementId: "criterion-selected",
              deliveryClass: "never_delivered",
              deliveredByExecutionId: null,
            },
          ],
        },
      }),
    });

    const opened = await service.open({
      spec: SPEC,
      seedFromLast: false,
      actor: AGENT,
    });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    expect(opened.value.attempt.deltaBasisExecutionId).toBe(
      EARLIER_EXECUTION_ID,
    );
  });
});

describe("delivery-plan service reaffirmation", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  function pendingDocument(): DeliveryPlanDocument {
    const document = maximalPlanDocument();
    document.binding.dispositions = [
      {
        criterionElementId: "criterion-reaffirmed",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: EARLIER_EXECUTION_ID,
      },
      {
        criterionElementId: "criterion-selected",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
    ];
    return document;
  }

  it("refuses a reaffirmation of a draft revision the caller did not read", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, { id: "attempt-cas", document: pendingDocument() });
    const service = serviceWith(db, repos);

    const refused = await service.reaffirm({
      spec: SPEC,
      expectedDraftRevision: 7,
      criterionElementId: "criterion-reaffirmed",
      actor: HUMAN,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("stale_plan_draft");
    expect(refused.refusal.instruction).toContain("cctl spec plan status");
    expect(repos.plans.findAttemptById("attempt-cas")?.draft_revision).toBe(1);
  });

  it("reaffirms the criterion at the draft revision the caller read", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, { id: "attempt-cas-ok", document: pendingDocument() });
    const service = serviceWith(db, repos);

    const reaffirmed = await service.reaffirm({
      spec: SPEC,
      expectedDraftRevision: 1,
      criterionElementId: "criterion-reaffirmed",
      actor: HUMAN,
    });
    if (!reaffirmed.ok) {
      throw new Error(reaffirmed.refusal.unmetConditions.join(" "));
    }

    expect(
      reaffirmed.value.document.binding.dispositions.find(
        (entry) => entry.criterionElementId === "criterion-reaffirmed",
      )?.disposition,
    ).toBe("reaffirmed");
    expect(reaffirmed.value.attempt.draftRevision).toBe(2);
  });
});
