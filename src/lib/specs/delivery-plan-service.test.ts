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
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/definition-schemas";

import {
  canonicalDeliveryPlanEnvelopeBytes,
  deliveryPlanDocumentSchema,
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
    admitModelSelections: async ({ launch }) => ({ ok: true, launch }),
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

function requiredWorkflowImplementer(launch: WorkflowDefinitionDraft) {
  const implementer = launch.definition.workflowConfig.implementer;
  if (implementer === undefined) {
    throw new Error("Fixture launch requires a workflow implementer.");
  }
  return implementer;
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

  it("refuses an invalid model selection before persisting draft bytes", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const original = maximalPlanDocument();
    openAttempt(repos, { id: "attempt-model-selection", document: original });
    const invalid = maximalPlanDocument();
    requiredWorkflowImplementer(invalid.launch).agent.modelSelection = {
      modelId: "unknown-model",
      parameters: { effort: "high" },
    };
    let admittedLaunch: WorkflowDefinitionDraft | null = null;
    const service = serviceWith(db, repos, {
      admitModelSelections: async ({ launch }) => {
        admittedLaunch = launch;
        return {
          ok: false,
          issues: [
            {
              path: "definition.workflowConfig.implementer.agent.modelSelection.modelId",
              message:
                "implementer claude model selection is invalid: Unknown model unknown-model.",
              code: "unknown_model",
              modelId: "unknown-model",
            },
          ],
        };
      },
    });

    const edited = await service.edit({
      spec: SPEC,
      expectedDraftRevision: 1,
      document: invalid,
      actor: AGENT,
    });

    expect(admittedLaunch).toEqual(invalid.launch);
    expect(edited.ok).toBe(false);
    if (edited.ok) return;
    expect(edited.refusal).toMatchObject({
      code: "validation",
      unmetConditions: [
        "definition.workflowConfig.implementer.agent.modelSelection.modelId: implementer claude model selection is invalid: Unknown model unknown-model.",
      ],
    });
    const persisted = repos.plans.findAttemptById("attempt-model-selection");
    expect(persisted?.draft_revision).toBe(1);
    expect(persisted?.content_json).toBe(
      canonicalDeliveryPlanEnvelopeBytes(original),
    );
  });

  it("persists the canonical launch returned by model admission", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    openAttempt(repos, {
      id: "attempt-canonical-model-selection",
      document: maximalPlanDocument(),
    });
    const editedDocument = maximalPlanDocument();
    requiredWorkflowImplementer(
      editedDocument.launch,
    ).agent.modelSelection.modelId = "opus-alias";
    const service = serviceWith(db, repos, {
      admitModelSelections: async ({ launch }) => {
        const canonicalLaunch = structuredClone(launch);
        requiredWorkflowImplementer(
          canonicalLaunch,
        ).agent.modelSelection.modelId = "opus";
        return { ok: true, launch: canonicalLaunch };
      },
    });

    const edited = await service.edit({
      spec: SPEC,
      expectedDraftRevision: 1,
      document: editedDocument,
      actor: AGENT,
    });

    expect(edited.ok).toBe(true);
    const persisted = repos.plans.findAttemptById(
      "attempt-canonical-model-selection",
    );
    const persistedDocument = deliveryPlanDocumentSchema.parse(
      JSON.parse(persisted?.content_json ?? "null"),
    );
    expect(
      requiredWorkflowImplementer(persistedDocument.launch).agent.modelSelection
        .modelId,
    ).toBe("opus");
    expect(
      requiredWorkflowImplementer(editedDocument.launch).agent.modelSelection
        .modelId,
    ).toBe("opus-alias");
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
    document: DeliveryPlanDocument = maximalPlanDocument(),
  ): Promise<void> {
    openAttempt(repos, {
      id: "attempt-prior",
      document,
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

  it("admits the copied launch before opening and persists the canonical launch", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const source = maximalPlanDocument();
    requiredWorkflowImplementer(source.launch).agent.modelSelection.modelId =
      "opus-alias";
    await abandonedProposal(repos, source);
    const admissions: Array<{
      spec: Spec;
      launch: WorkflowDefinitionDraft;
    }> = [];
    let admissionCompleted = false;
    let openedAfterAdmission = false;
    const service = serviceWith(db, repos, {
      plans: {
        ...repos.plans,
        open(input) {
          openedAfterAdmission = admissionCompleted;
          return repos.plans.open(input);
        },
      },
      admitModelSelections: async ({ spec, launch }) => {
        admissions.push({ spec, launch });
        const canonicalLaunch = structuredClone(launch);
        requiredWorkflowImplementer(
          canonicalLaunch,
        ).agent.modelSelection.modelId = "opus";
        admissionCompleted = true;
        return { ok: true, launch: canonicalLaunch };
      },
    });

    const opened = await service.open({
      spec: SPEC,
      seedFromLast: true,
      actor: AGENT,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.spec).toBe(SPEC);
    expect(
      requiredWorkflowImplementer(admissions[0]!.launch).agent.modelSelection
        .modelId,
    ).toBe("opus-alias");
    expect(openedAfterAdmission).toBe(true);
    expect(
      requiredWorkflowImplementer(opened.value.document.launch).agent
        .modelSelection.modelId,
    ).toBe("opus");
    const persisted = repos.plans.findAttemptById(opened.value.attempt.id);
    const persistedDocument = deliveryPlanDocumentSchema.parse(
      JSON.parse(persisted?.content_json ?? "null"),
    );
    expect(
      requiredWorkflowImplementer(persistedDocument.launch).agent.modelSelection
        .modelId,
    ).toBe("opus");
  });

  it("refuses a rejected copied launch without opening an attempt", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    const source = maximalPlanDocument();
    requiredWorkflowImplementer(source.launch).agent.modelSelection.modelId =
      "retired-model";
    await abandonedProposal(repos, source);
    const attemptIdsBefore = repos.plans
      .findAttemptsBySpecId(SPEC_ID)
      .map((attempt) => attempt.id);
    const openedEventsBefore = repos.countEvents("spec-delivery-plan-opened");
    let openCalls = 0;
    const service = serviceWith(db, repos, {
      plans: {
        ...repos.plans,
        open(input) {
          openCalls += 1;
          return repos.plans.open(input);
        },
      },
      admitModelSelections: async () => ({
        ok: false,
        issues: [
          {
            path: "definition.workflowConfig.implementer.agent.modelSelection.modelId",
            message:
              "implementer claude model selection is invalid: Unknown model retired-model.",
            code: "unknown_model",
            modelId: "retired-model",
          },
        ],
      }),
    });

    const opened = await service.open({
      spec: SPEC,
      seedFromLast: true,
      actor: AGENT,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.refusal).toMatchObject({
      code: "validation",
      unmetConditions: [
        "definition.workflowConfig.implementer.agent.modelSelection.modelId: implementer claude model selection is invalid: Unknown model retired-model.",
      ],
    });
    expect(openCalls).toBe(0);
    expect(
      repos.plans.findAttemptsBySpecId(SPEC_ID).map((attempt) => attempt.id),
    ).toEqual(attemptIdsBefore);
    expect(repos.countEvents("spec-delivery-plan-opened")).toBe(
      openedEventsBefore,
    );
  });

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

describe("delivery-plan service prelaunch abandon", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => {
    db.close();
  });

  const AMENDED_REVISION_ID = "revision-amended";

  /** The pinned revision's successor: the spec amended past the pin. */
  function amendedRevision(): SpecRevisionSnapshot {
    const snapshot = pinnedRevision();
    return {
      ...snapshot,
      revision: {
        ...snapshot.revision,
        id: AMENDED_REVISION_ID,
        number: snapshot.revision.number + 1,
        basedOnRevisionId: PINNED_REVISION_ID,
      },
    };
  }

  it("retires a never-launched attempt so a fresh open pins the current approved revision", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    db.prepare(
      `INSERT INTO spec_revisions (
         id, spec_id, number, state, content_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(AMENDED_REVISION_ID, SPEC_ID, 3, "approved", "sha256:amended", NOW);
    openAttempt(repos, {
      id: "attempt-stranded",
      document: maximalPlanDocument(),
    });
    const service = serviceWith(db, repos, {
      currentApprovedRevision: async () => amendedRevision(),
    });

    // The command-center#92 deadlock: the draft blocks a replacement, and no
    // verb retires it — the spec legitimately amended past the pin.
    const blocked = await service.open({
      spec: SPEC,
      seedFromLast: false,
      actor: AGENT,
    });
    expect(blocked.ok).toBe(false);

    const abandoned = await service.abandonPrelaunch({
      spec: SPEC,
      reason: "The spec amended past this attempt's pin.",
      actor: HUMAN,
    });
    if (!abandoned.ok) {
      throw new Error(abandoned.refusal.unmetConditions.join(" "));
    }
    expect(abandoned.value.attemptId).toBe("attempt-stranded");

    const reopened = await service.open({
      spec: SPEC,
      seedFromLast: false,
      actor: AGENT,
    });
    if (!reopened.ok) {
      throw new Error(reopened.refusal.unmetConditions.join(" "));
    }

    // Reloaded through the repo: the retirement and the fresh pin are durable.
    const attempts = repos.plans.findAttemptsBySpecId(SPEC_ID);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "abandoned",
      "draft",
    ]);
    expect(attempts[1]?.pinned_revision_id).toBe(AMENDED_REVISION_ID);
  });

  it("refuses a launched attempt, naming the post-launch paths", async () => {
    const repos = createDeliveryPlanTestRepos(db);
    repos.plans.open({
      attempt: {
        id: "attempt-launched",
        spec_id: SPEC_ID,
        pinned_revision_id: PINNED_REVISION_ID,
        delta_basis_execution_id: null,
        status: "launched",
        draft_revision: 1,
        content_json: canonicalDeliveryPlanEnvelopeBytes(maximalPlanDocument()),
        proposed_snapshot_id: null,
        approval_json: null,
        prelaunch_json: null,
        launched_execution_id: LAUNCHED_EXECUTION_ID,
        created_at: NOW,
        updated_at: NOW,
      },
      occurredAt: NOW,
      actor: AGENT,
    });
    const service = serviceWith(db, repos);

    const refused = await service.abandonPrelaunch({
      spec: SPEC,
      reason: "Trying to retire a running delivery.",
      actor: HUMAN,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("plan_status_conflict");
    expect(refused.refusal.instruction).toContain("cctl spec capture");
    expect(repos.plans.findAttemptById("attempt-launched")?.status).toBe(
      "launched",
    );
  });
});
