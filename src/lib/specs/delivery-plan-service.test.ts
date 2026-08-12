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

import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createDeliveryPlanTestRepos,
  seedDeliveryPlanParents,
  EARLIER_EXECUTION_ID,
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import {
  deliveryPlanDocumentSchema,
  emptyDeliveryPlanDocument,
  withPinnedSpecSource,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryDeltaProjectionSchema,
  type DeliveryDeltaProjection,
} from "./delivery-delta";
import {
  createDeliveryPlanService,
  type DeliveryPlanCompilationContext,
  type DeliveryPlanService,
  type DeliveryPlanServiceDeps,
} from "./delivery-plan-service";
import { discoveryTaskId, type PlanSeedDiscovery } from "./delivery-plan-seed";
import type { SpecPolicyAdmissionNotice } from "./policy-admissions";
import type {
  Spec,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const AGENT = {
  kind: "agent",
  conversationId: "conversation-plan-service",
  backend: "claude",
} as const;

const SPEC: Spec = {
  id: SPEC_ID,
  projectPath: PROJECT_PATH,
  slug: "delivery-plan",
  name: "Delivery plan",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: "2026-08-07T08:00:00.000Z",
  updatedAt: "2026-08-07T08:00:00.000Z",
};

const PINNED_AT = "2026-08-07T08:02:00.000Z";

function pinnedElement(
  id: string,
  kind: SpecRevisionElement["element"]["kind"],
  number: number,
  parentElementId: string | null,
  position: number,
  payload: SpecRevisionElement["version"]["payload"],
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind,
      number,
      parentElementId,
      createdAt: PINNED_AT,
    },
    version: {
      revisionId: PINNED_REVISION_ID,
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: PINNED_AT,
      updatedAt: PINNED_AT,
    },
  };
}

/**
 * The pinned revision behind the delta fixture: two requirements carrying the
 * four criteria the delta grades, so a projection that resolves criterion text
 * off the snapshot has real elements to resolve rather than an empty list.
 */
function pinnedElements(): SpecRevisionElement[] {
  const requirements = [
    pinnedElement("req-1", "requirement", 1, null, 0, {
      kind: "requirement",
      statement: "The plan is reviewable.",
      priority: "must",
      risk: "medium",
    }),
    pinnedElement("req-2", "requirement", 2, null, 1, {
      kind: "requirement",
      statement: "New work is planned.",
      priority: "must",
      risk: "low",
    }),
  ];
  const criteria = (
    [
      ["c-fresh", 1, "req-1", 1],
      ["c-soft", 2, "req-1", 2],
      ["c-hard", 3, "req-1", 3],
      ["c-new", 4, "req-2", 1],
    ] as const
  ).map(([id, position, parent], index) =>
    pinnedElement(
      id,
      "criterion",
      index === 3 ? 1 : position,
      parent,
      2 + index,
      {
        kind: "criterion",
        text: `Criterion ${id} is observable.`,
        validationStrategy: { kinds: ["validator_verdict"] },
      },
    ),
  );
  return [...requirements, ...criteria];
}

function pinnedSnapshot(): SpecRevisionSnapshot {
  return {
    revision: {
      id: PINNED_REVISION_ID,
      specId: SPEC_ID,
      number: 2,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "sha256:pinned",
      proposedAt: null,
      approvedAt: PINNED_AT,
      externalDelivery: null,
      createdAt: PINNED_AT,
    },
    elements: pinnedElements(),
  };
}

/**
 * The delivered-spec fixture: one criterion per delivery class against an
 * earlier merged execution, which is what makes the seeded dispositions
 * observable one class at a time.
 */
function deliveredDelta(): DeliveryDeltaProjection {
  return deliveryDeltaProjectionSchema.parse({
    specSlug: SPEC.slug,
    current: { revisionId: PINNED_REVISION_ID, revisionNumber: 2 },
    base: { revisionId: "revision-delivery-plan-prior", revisionNumber: 1 },
    comparedExecution: {
      executionId: EARLIER_EXECUTION_ID,
      revisionId: "revision-delivery-plan-prior",
      state: "delivered",
      deliveredAt: "2026-08-07T08:03:30.000Z",
    },
    elements: [],
    criteria: [
      {
        criterionElementId: "c-fresh",
        handle: "R1.1",
        class: "delivered_and_fresh",
        priorDisposition: "in_scope",
        freshness: { grade: "fresh", basis: [] },
      },
      {
        criterionElementId: "c-soft",
        handle: "R1.2",
        class: "soft_stale",
        priorDisposition: "in_scope",
        freshness: {
          grade: "soft_stale",
          basis: [
            {
              elementId: "req-1",
              kind: "requirement",
              handle: "R1",
              reason: "parent_requirement",
              baseHash: "req-1-a",
              currentHash: "req-1-b",
            },
          ],
        },
      },
      {
        criterionElementId: "c-hard",
        handle: "R1.3",
        class: "hard_stale",
        priorDisposition: "in_scope",
        freshness: { grade: "hard_stale", basis: [] },
      },
      {
        criterionElementId: "c-new",
        handle: "R2.1",
        class: "never_delivered",
        priorDisposition: null,
        freshness: null,
      },
    ],
    advisories: [],
    counts: {
      elements: { added: 0, amended: 0, unchanged: 0, removed: 0 },
      criteria: {
        delivered_and_fresh: 1,
        soft_stale: 1,
        hard_stale: 1,
        never_delivered: 1,
        deferred: 0,
        waived: 0,
      },
    },
  });
}

/**
 * What materialization needs beyond the document. The criteria mirror the
 * delta fixture's ids so a plan that disposes every pinned criterion also
 * compiles — a mismatch here would refuse as a dangling reference, which is a
 * different test.
 */
function compilationContext(): DeliveryPlanCompilationContext {
  return {
    criteria: ["c-fresh", "c-soft", "c-hard", "c-new"].map(
      (criterionElementId, index) => ({
        criterionElementId,
        handle: `R${index + 1}.1`,
        text: `Criterion ${criterionElementId} is observable.`,
        validationStrategy: { kinds: ["validator_verdict"] },
      }),
    ),
    registeredValidationCommandNames: ["typecheck", "test"],
    defaults: {
      approvalRequired: true,
      workflowConfig: {
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
        },
      },
    },
  };
}

/** The governance a plan must author before anything can compile a charter. */
function authoredGovernance(): DeliveryPlanDocument["governance"] {
  return {
    mission: "Deliver the remaining criteria of the delivery-plan spec.",
    charterInvariants: [
      {
        id: "exact-approval",
        statement: "Launch runs the approved candidate.",
      },
    ],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "final-design",
        label: "Final agreed design",
        type: "document",
        locator: "command-center#47 attachment f7b542c4",
        description: "Section 5 owns exact materialization.",
        appliesTo: null,
        accessPolicy: "external-readonly",
      },
    ],
    validationCommandNames: ["typecheck"],
  };
}

/**
 * The seeded plan turned proposable: every interim disposition resolved, one
 * context owning what is left, and an authored charter — the minimum a plan
 * needs before anything will compile it.
 */
function selectedOnlyDocument(
  seeded: DeliveryPlanDocument,
): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    ...seeded,
    dispositions: seeded.dispositions.map((entry) =>
      entry.disposition === "pending_reaffirmation"
        ? { ...entry, disposition: "selected" }
        : entry,
    ),
    contexts: [
      {
        contextId: "ctx-only",
        title: "Everything",
        contextType: "delivery",
        criterionElementIds: ["c-soft", "c-hard", "c-new"],
        acceptanceContract: ["It is observable."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-only",
        contextId: "ctx-only",
        title: "Do it",
        instructions: "Make the remaining criteria observable.",
        order: 0,
        contributesToCriterionElementIds: ["c-new"],
      },
    ],
    edges: [],
    wiring: [],
    governance: authoredGovernance(),
  });
}

/**
 * A plan that already launched, written straight to the store: it is history
 * by the time a test opens the next attempt, so no verb should have to produce
 * it.
 */
function seedLaunchedAttempt(
  db: Db,
  input: { attemptId: string; document: DeliveryPlanDocument },
): void {
  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
       draft_revision, content_json, proposed_snapshot_id, approval_json,
       prelaunch_json, launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'launched', 1, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    input.attemptId,
    SPEC_ID,
    PINNED_REVISION_ID,
    EARLIER_EXECUTION_ID,
    JSON.stringify(deliveryPlanDocumentSchema.parse(input.document)),
    EARLIER_EXECUTION_ID,
    "2026-08-07T09:00:00.000Z",
    "2026-08-07T09:00:00.000Z",
  );
}

interface Harness {
  readonly service: DeliveryPlanService;
  readonly db: Db;
  discoveries: PlanSeedDiscovery[];
  /** The `sinceExecutionId` each delta read was computed against, in order. */
  deltaBases: (string | null)[];
  /** Policy admissions the service forwarded for post-hoc review. */
  policyNotices: SpecPolicyAdmissionNotice[];
}

function createHarness(
  overrides: Partial<DeliveryPlanServiceDeps> = {},
): Harness {
  const db = _createTestDb();
  seedDeliveryPlanParents(db);
  const { plans, review, events } = createDeliveryPlanTestRepos(db);
  const discoveries: PlanSeedDiscovery[] = [];
  const deltaBases: (string | null)[] = [];
  const policyNotices: SpecPolicyAdmissionNotice[] = [];
  let clock = 0;
  let ids = 0;

  const service = createDeliveryPlanService({
    plans,
    reviewRepo: review,
    events,
    policyNotifier: { policyAdmitted: (notice) => policyNotices.push(notice) },
    runInTransaction: <T>(operation: () => T): T =>
      db.transaction(operation).immediate(),
    currentApprovedRevision: async () => pinnedSnapshot(),
    revisionSnapshot: async (revisionId) =>
      revisionId === PINNED_REVISION_ID ? pinnedSnapshot() : null,
    // Records what each read asked to be graded against, so a test can prove
    // the attempt's own basis is used rather than "the latest delivery".
    deliveryDelta: async ({ sinceExecutionId }) => {
      deltaBases.push(sinceExecutionId);
      return { ok: true, projection: deliveredDelta() };
    },
    latestLegacyDeliverySource: async () => null,
    capturedDiscoveries: async () => discoveries,
    // Every seeded claim rests on the earlier merged execution, which the
    // fixture makes real, so the accepted path is the one under test unless a
    // case overrides it.
    classifyDeliveredElsewhere: (input) =>
      input.deliveredByExecutionId === EARLIER_EXECUTION_ID
        ? { code: "accepted", baseExecutionId: EARLIER_EXECUTION_ID }
        : { code: "missing_base", baseExecutionId: null },
    compilationContext: async () => compilationContext(),
    nextId: () => `id-${++ids}`,
    now: () => `2026-08-08T10:0${clock++}:00.000Z`,
    ...overrides,
  });

  return { service, db, discoveries, deltaBases, policyNotices };
}

/**
 * A second service over the harness's OWN database, so a test can change one
 * dependency while the durable attempt stays exactly as it was written.
 */
function createDeliveryPlanServiceOver(
  harness: Harness,
  overrides: Partial<DeliveryPlanServiceDeps>,
): DeliveryPlanService {
  const { plans, review, events } = createDeliveryPlanTestRepos(harness.db);
  return createDeliveryPlanService({
    plans,
    reviewRepo: review,
    events,
    policyNotifier: {
      policyAdmitted: (notice) => harness.policyNotices.push(notice),
    },
    runInTransaction: <T>(operation: () => T): T =>
      harness.db.transaction(operation).immediate(),
    currentApprovedRevision: async () => pinnedSnapshot(),
    revisionSnapshot: async (revisionId) =>
      revisionId === PINNED_REVISION_ID ? pinnedSnapshot() : null,
    deliveryDelta: async () => ({ ok: true, projection: deliveredDelta() }),
    latestLegacyDeliverySource: async () => null,
    capturedDiscoveries: async () => [],
    classifyDeliveredElsewhere: () => ({
      code: "accepted",
      baseExecutionId: EARLIER_EXECUTION_ID,
    }),
    compilationContext: async () => compilationContext(),
    nextId: () => "id-override",
    now: () => "2026-08-08T12:00:00.000Z",
    ...overrides,
  });
}

async function openSeeded(harness: Harness) {
  const opened = await harness.service.open({
    spec: SPEC,
    seedFromLast: true,
    actor: AGENT,
  });
  if (!opened.ok) throw new Error(`open refused: ${opened.refusal.code}`);
  return opened.value;
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.db.close();
});

describe("delivery plan service — seed-from-last", () => {
  it("gives every pinned criterion exactly one disposition", async () => {
    const view = await openSeeded(harness);

    expect(view.document.dispositions).toHaveLength(4);
    expect(
      view.document.dispositions.map((entry) => ({
        id: entry.criterionElementId,
        disposition: entry.disposition,
      })),
    ).toEqual([
      { id: "c-fresh", disposition: "delivered_elsewhere" },
      { id: "c-soft", disposition: "pending_reaffirmation" },
      { id: "c-hard", disposition: "selected" },
      { id: "c-new", disposition: "selected" },
    ]);
  });

  it("pins the revision and records the delta basis the seed was computed against", async () => {
    const view = await openSeeded(harness);

    expect(view.attempt.pinnedRevisionId).toBe(PINNED_REVISION_ID);
    expect(view.attempt.deltaBasisExecutionId).toBe(EARLIER_EXECUTION_ID);
    expect(view.attempt.status).toBe("draft");
  });

  /**
   * The pin is the whole point of an attempt: a spec that keeps being amended
   * and delivered while a plan is open must not re-grade that plan's criteria.
   * Opening CHOOSES a basis; every read afterwards is graded against the one
   * the attempt froze (`computed-projections`).
   */
  it("grades every later read against the attempt's own pins, not the current head", async () => {
    const opened = await openSeeded(harness);
    // Opening reads the delta twice: once unstated, to CHOOSE the basis, and
    // once against the basis it just froze onto the row.
    expect(harness.deltaBases).toEqual([null, EARLIER_EXECUTION_ID]);
    harness.deltaBases.length = 0;

    await harness.service.read({ spec: SPEC });
    await harness.service.propose({ spec: SPEC, actor: AGENT });

    // Never null again, and never "whatever delivered most recently": every
    // later read states the attempt's own frozen basis.
    expect(harness.deltaBases.length).toBeGreaterThan(0);
    expect(new Set(harness.deltaBases)).toEqual(
      new Set([EARLIER_EXECUTION_ID]),
    );
    expect(opened.attempt.deltaBasisExecutionId).toBe(EARLIER_EXECUTION_ID);
  });

  it("refuses to re-pin a plan whose pinned revision cannot be read", async () => {
    await openSeeded(harness);
    // A second service over the SAME durable attempt, whose pinned revision no
    // longer resolves: the plan must refuse rather than silently re-pin to
    // whatever revision is current.
    const blind = createDeliveryPlanServiceOver(harness, {
      revisionSnapshot: async () => null,
    });

    const read = await blind.read({ spec: SPEC });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("integrity_mismatch");
    expect(read.refusal.instruction).toContain(PINNED_REVISION_ID);
    expect(read.refusal.instruction).toContain("never re-pinned");
  });

  /**
   * "Empty" means the author has said nothing yet — not that the plan has no
   * sources. The pinned spec is ranked first because the engine materializes
   * it into every lane; leaving an author to invent that locator is what
   * produced a #1-ranked source no validator could read.
   */
  it("opens an unauthored document ranking the pinned spec first when the caller does not seed", async () => {
    const opened = await harness.service.open({
      spec: SPEC,
      seedFromLast: false,
      actor: AGENT,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.document).toEqual(
      withPinnedSpecSource(emptyDeliveryPlanDocument(), {
        specSlug: SPEC.slug,
        pinnedRevisionId: opened.value.attempt.pinnedRevisionId,
      }),
    );
  });

  it("blocks propose on the seeded pending_reaffirmation and names both resolutions", async () => {
    const view = await openSeeded(harness);
    const pending = view.health.findings.filter(
      (finding) => finding.ruleId === "plan/pending-reaffirmation",
    );

    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toContain("R1.2");
    expect(pending[0]?.message).toContain("Reaffirm it in Spec Studio");
    expect(pending[0]?.message).toContain("selected");
  });

  it("lands captured discoveries from the delta basis as work items", async () => {
    harness.discoveries.push({
      discoveryId: "discovery-t9",
      title: "Close the empty case",
      instructions: "The prior run found it unhandled.",
      coveredCriterionElementIds: ["c-hard"],
    });

    const view = await openSeeded(harness);

    expect(view.document.tasks.map((task) => task.title)).toEqual([
      "Close the empty case",
    ]);
  });

  /**
   * A discovery is consumed by the plan that LAUNCHED carrying it, not by the
   * plan that happens to still carry it forward. Once that plan's context
   * delivers, carry-forward drops the context and its tasks — so dedupe based
   * on the carried document alone would resurrect the discovery as fresh
   * unowned work on every later plan, forever.
   */
  it("does not resurrect a discovery a launched plan already carried", async () => {
    const discoveryId = "discovery-consumed";
    // The launched plan owns only the criterion the delta reports as
    // delivered_and_fresh, so the next seed drops this context and its tasks.
    seedLaunchedAttempt(harness.db, {
      attemptId: "attempt-launched-consumed",
      document: {
        ...emptyDeliveryPlanDocument(),
        contexts: [
          {
            contextId: "ctx-delivered",
            title: "Delivered last run",
            contextType: "delivery",
            criterionElementIds: ["c-fresh"],
            acceptanceContract: ["It is observable."],
            proofPlan: [],
          },
        ],
        tasks: [
          {
            taskId: discoveryTaskId(discoveryId),
            contextId: "ctx-delivered",
            title: "Close the empty case",
            instructions: "The prior run found it unhandled.",
            order: 0,
            contributesToCriterionElementIds: [],
          },
        ],
      },
    });
    harness.discoveries.push({
      discoveryId,
      title: "Close the empty case",
      instructions: "The prior run found it unhandled.",
      coveredCriterionElementIds: [],
    });

    const view = await openSeeded(harness);

    expect(
      view.document.tasks.filter(
        (task) => task.title === "Close the empty case",
      ),
    ).toEqual([]);
  });

  it("refuses a second attempt while one is still open, naming the attempt and its exits", async () => {
    const first = await openSeeded(harness);
    const second = await harness.service.open({
      spec: SPEC,
      seedFromLast: true,
      actor: AGENT,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.code).toBe("plan_status_conflict");
    expect(second.refusal.instruction).toContain(first.attempt.id);
    expect(second.refusal.instruction).toContain("cctl spec plan reopen");
  });

  /**
   * The whole interim-disposition chain in one walk: the seed leaves the
   * soft-stale criterion pending, lint blocks the proposal on it, the audited
   * human reaffirmation resolves it, and the plan comes out clean. The seed is
   * only safe to auto-write BECAUSE this chain ends somewhere.
   */
  it("resolves the seeded pending_reaffirmation through a human reaffirmation", async () => {
    const seeded = await openSeeded(harness);
    expect(seeded.health.findings.map((finding) => finding.ruleId)).toContain(
      "plan/pending-reaffirmation",
    );

    const reaffirmed = deliveryPlanDocumentSchema.parse({
      ...seeded.document,
      dispositions: seeded.document.dispositions.map((entry) =>
        entry.disposition === "pending_reaffirmation"
          ? {
              ...entry,
              disposition: "reaffirmed",
              reaffirmation: {
                actor: { kind: "human" },
                at: "2026-08-08T11:00:00.000Z",
                basisRevisionId: "revision-delivery-plan-prior",
                basis: [
                  {
                    elementId: "req-1",
                    reason: "parent_requirement",
                    baseHash: "req-1-a",
                    currentHash: "req-1-b",
                  },
                ],
              },
            }
          : entry,
      ),
      contexts: [
        {
          contextId: "ctx-remaining",
          title: "The work that is still owed",
          contextType: "delivery",
          criterionElementIds: ["c-hard", "c-new"],
          acceptanceContract: ["The remaining work is observable."],
          proofPlan: [],
        },
      ],
      tasks: [],
      edges: [],
      wiring: [],
      governance: authoredGovernance(),
    });

    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: reaffirmed,
      actor: AGENT,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.health.blocking).toBe(0);
    expect(edited.value.unresolved).toEqual([]);

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });
    expect(proposed.ok).toBe(true);
  });

  it("refuses a reaffirmation an agent asserted for itself", async () => {
    const seeded = await openSeeded(harness);
    const selfAttested = deliveryPlanDocumentSchema.parse({
      ...seeded.document,
      dispositions: seeded.document.dispositions.map((entry) =>
        entry.disposition === "pending_reaffirmation"
          ? {
              ...entry,
              disposition: "reaffirmed",
              reaffirmation: {
                actor: AGENT,
                at: "2026-08-08T11:00:00.000Z",
                basisRevisionId: "revision-delivery-plan-prior",
                basis: [
                  {
                    elementId: "req-1",
                    reason: "parent_requirement",
                    baseHash: "req-1-a",
                    currentHash: "req-1-b",
                  },
                ],
              },
            }
          : entry,
      ),
    });

    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selfAttested,
      actor: AGENT,
    });

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      edited.value.health.findings.map((finding) => finding.ruleId),
    ).toContain("plan/reaffirmed-unattested");
  });
});

describe("delivery plan service — edit, propose, reopen", () => {
  it("reports the blocking-count delta the edit moved", async () => {
    const seeded = await openSeeded(harness);
    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.previousHealth?.blocking).toBe(seeded.health.blocking);
    expect(edited.value.health.blocking).toBe(0);
    expect(edited.value.attempt.draftRevision).toBe(
      seeded.attempt.draftRevision + 1,
    );
  });

  it("refuses a stale edit with the current draft revision", async () => {
    const seeded = await openSeeded(harness);
    const stale = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision + 7,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.refusal.code).toBe("stale_plan_draft");
    expect(stale.refusal.instruction).toContain(
      String(seeded.attempt.draftRevision),
    );
  });

  it("refuses propose while a blocking finding stands, naming the finding", async () => {
    await openSeeded(harness);
    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.code).toBe("lint_blocked");
    expect(proposed.refusal.unmetConditions.join("\n")).toContain("R1.2");
  });

  it("freezes a snapshot with a plan hash once nothing blocks", async () => {
    const seeded = await openSeeded(harness);
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.attempt.status).toBe("proposed");
    expect(proposed.value.attempt.planHash).toMatch(/^sha256:/);
    expect(proposed.value.snapshots).toHaveLength(1);
  });

  it("reopens a proposal to a fresh draft revision whose re-propose hashes differently", async () => {
    const seeded = await openSeeded(harness);
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });
    const first = await harness.service.propose({ spec: SPEC, actor: AGENT });
    if (!first.ok) throw new Error("propose refused");

    const reopened = await harness.service.reopen({
      spec: SPEC,
      reason: "the closeout context is missing",
      actor: AGENT,
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.attempt.status).toBe("draft");

    const second = await harness.service.propose({ spec: SPEC, actor: AGENT });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.attempt.planHash).not.toBe(
      first.value.attempt.planHash,
    );
    // The first proposal's snapshot is still readable exactly as proposed.
    expect(second.value.snapshots).toHaveLength(2);
    expect(second.value.snapshots[0]?.planHash).toBe(
      first.value.attempt.planHash,
    );
  });

  it("refuses reopen on a draft, naming the edit verb instead", async () => {
    await openSeeded(harness);
    const reopened = await harness.service.reopen({
      spec: SPEC,
      reason: "nothing to undo",
      actor: AGENT,
    });

    expect(reopened.ok).toBe(false);
    if (reopened.ok) return;
    expect(reopened.refusal.instruction).toContain("cctl spec plan edit");
  });

  it("refuses every verb with the opening act when the spec has no attempt", async () => {
    const read = await harness.service.read({ spec: SPEC });
    const launch = await harness.service.resolveLaunch({ spec: SPEC });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.code).toBe("not_found");
    expect(read.refusal.instruction).toContain("cctl spec plan open");
    expect(launch).toMatchObject({
      kind: "refused",
      refusal: {
        instruction: expect.stringContaining(
          `cctl spec plan open ${SPEC.slug} --seed-from last`,
        ),
      },
    });
  });
});

describe("delivery plan service — propose materializes and pins", () => {
  async function proposable(): Promise<void> {
    const seeded = await openSeeded(harness);
    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(`edit refused: ${edited.refusal.code}`);
  }

  function candidateRows(): {
    snapshot_id: string;
    compiled_definition_hash: string;
    definition_json: string;
  }[] {
    return harness.db
      .prepare(
        "SELECT snapshot_id, compiled_definition_hash, definition_json FROM spec_delivery_plan_candidates",
      )
      .all() as {
      snapshot_id: string;
      compiled_definition_hash: string;
      definition_json: string;
    }[];
  }

  it("persists the snapshot and its compiled candidate together", async () => {
    await proposable();

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const rows = candidateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snapshot_id).toBe(
      proposed.value.attempt.proposedSnapshotId,
    );
    expect(rows[0]?.compiled_definition_hash).toMatch(/^sha256:/);
  });

  it("leaves the attempt editable with no proposal when materialization refuses", async () => {
    const seeded = await openSeeded(harness);
    // Everything lint asks for, but no authored charter: propose gets as far
    // as materialization and stops there.
    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: deliveryPlanDocumentSchema.parse({
        ...selectedOnlyDocument(seeded.document),
        governance: emptyDeliveryPlanDocument().governance,
      }),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error("edit refused");
    expect(edited.value.health.blocking).toBe(0);

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.instruction).toContain("governance.mission");
    expect(candidateRows()).toEqual([]);
    const read = await harness.service.read({ spec: SPEC });
    if (!read.ok) throw new Error("read refused");
    expect(read.value.attempt.status).toBe("draft");
    expect(read.value.snapshots).toEqual([]);
  });

  /**
   * The graph tier's accept-time validation is a BACKSTOP, not a second copy of
   * the lint: the case below is one the plan lint has no rule for — an
   * unresolvable `{{...}}` reference the graph tier refuses on every author
   * path — so a plan that lint calls clean still cannot become a candidate that
   * would be refused at launch.
   */
  it("forwards a graph-validation refusal from propose, writing no snapshot and no candidate", async () => {
    const seeded = await openSeeded(harness);
    const clean = selectedOnlyDocument(seeded.document);
    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: deliveryPlanDocumentSchema.parse({
        ...clean,
        tasks: clean.tasks.map((task) => ({
          ...task,
          instructions: `${task.instructions} Follow {{feature}} to the end.`,
        })),
      }),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(`edit refused: ${edited.refusal.code}`);
    // Nothing the plan lint owns objects, so the refusal below can only have
    // come from the compiled candidate.
    expect(edited.value.health.blocking).toBe(0);

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    const stated = proposed.refusal.unmetConditions.join("\n");
    expect(stated).toContain("invalid-placeholder-token");
    expect(stated).toContain("tasks[0].instructions");
    expect(proposed.refusal.details?.graphRules).toEqual([
      "invalid-placeholder-token",
    ]);
    expect(candidateRows()).toEqual([]);
    const read = await harness.service.read({ spec: SPEC });
    if (!read.ok) throw new Error("read refused");
    expect(read.value.attempt.status).toBe("draft");
    expect(read.value.snapshots).toEqual([]);

    // The draft preview compiles through the same call site, so a planner is
    // shown the refusal when they ask what the plan would compile to, not only
    // when they try to freeze it.
    const previewed = await harness.service.preview({
      spec: SPEC,
      stage: "draft",
    });
    expect(previewed.ok).toBe(false);
    if (previewed.ok) return;
    expect(previewed.refusal).toEqual(proposed.refusal);
  });

  it("refuses a validation command the project has not registered", async () => {
    const seeded = await openSeeded(harness);
    const edited = await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: deliveryPlanDocumentSchema.parse({
        ...selectedOnlyDocument(seeded.document),
        governance: {
          ...authoredGovernance(),
          validationCommandNames: ["typecheck", "smoke"],
        },
      }),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error("edit refused");

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.unmetConditions.join(" ")).toContain("smoke");
    expect(candidateRows()).toEqual([]);
  });

  it("pins the candidate against a later change to the inherited defaults", async () => {
    await proposable();
    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("propose refused");
    const stored = candidateRows()[0];

    // A second service over the SAME database, resolving different defaults.
    const later = createDeliveryPlanServiceOver(harness, {
      compilationContext: async () => ({
        ...compilationContext(),
        defaults: {
          approvalRequired: false,
          workflowConfig: {
            mutability: {
              allowAgentTaskAdd: true,
              allowAgentContextAdd: false,
            },
          },
        },
      }),
    });
    const preview = await later.preview({ spec: SPEC, stage: "proposed" });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.compiledDefinitionHash).toBe(
      stored?.compiled_definition_hash,
    );
    expect(preview.value.definition.approvalRequired).toBe(true);
    expect(candidateRows()[0]?.definition_json).toBe(stored?.definition_json);
  });
});

describe("delivery plan service — candidate-bound sign-off", () => {
  const HUMAN = { kind: "human" } as const;

  interface SignedOffCandidate {
    candidateId: string;
    planHash: string;
    compiledDefinitionHash: string;
  }

  async function proposedCandidate(
    activeHarness: Harness = harness,
  ): Promise<SignedOffCandidate> {
    const seeded = await openSeeded(activeHarness);
    const edited = await activeHarness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(`edit refused: ${edited.refusal.code}`);
    const proposed = await activeHarness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });
    if (!proposed.ok)
      throw new Error(`propose refused: ${proposed.refusal.code}`);
    const preview = await activeHarness.service.preview({
      spec: SPEC,
      stage: "proposed",
    });
    if (!preview.ok)
      throw new Error(`preview refused: ${preview.refusal.code}`);
    const candidateId = preview.value.candidateId;
    if (candidateId === null)
      throw new Error("the proposal stored no candidate");
    return {
      candidateId,
      planHash: preview.value.planHash,
      compiledDefinitionHash: preview.value.compiledDefinitionHash,
    };
  }

  function admissionRows(): {
    gate: string;
    basis: string;
    approval_id: string | null;
    revision_id: string | null;
    execution_id: string | null;
  }[] {
    return harness.db
      .prepare(
        "SELECT gate, basis, approval_id, revision_id, execution_id FROM spec_gate_admissions",
      )
      .all() as {
      gate: string;
      basis: string;
      approval_id: string | null;
      revision_id: string | null;
      execution_id: string | null;
    }[];
  }

  it("binds the approval and its audit record to the stored candidate identity", async () => {
    const candidate = await proposedCandidate();

    const signed = await harness.service.signOff({
      spec: SPEC,
      ...candidate,
      approver: "operator",
      actor: HUMAN,
    });

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.attempt.status).toBe("approved");
    expect(signed.value.approval).toMatchObject({
      candidateId: candidate.candidateId,
      planHash: candidate.planHash,
      compiledDefinitionHash: candidate.compiledDefinitionHash,
      approvedBy: { kind: "human" },
    });
    const payload = createDeliveryPlanTestRepos(harness.db).readEventPayload(
      "spec-delivery-plan-transitioned",
    ) as { transition?: Record<string, unknown> };
    expect(payload.transition).toMatchObject({
      kind: "approve",
      candidateId: candidate.candidateId,
      planHash: candidate.planHash,
      compiledDefinitionHash: candidate.compiledDefinitionHash,
    });
  });

  it("refuses a sign-off naming a compiled hash the stored candidate does not carry", async () => {
    const candidate = await proposedCandidate();

    const signed = await harness.service.signOff({
      spec: SPEC,
      candidateId: candidate.candidateId,
      // The plan hash is the real one: only the compiled bytes differ, which
      // is exactly the substitution `exact-approval` has to catch.
      planHash: candidate.planHash,
      compiledDefinitionHash: `sha256:${"f".repeat(64)}`,
      approver: "operator",
      actor: HUMAN,
    });

    expect(signed.ok).toBe(false);
    if (signed.ok) return;
    expect(signed.refusal.code).toBe("integrity_mismatch");
    expect(signed.refusal.instruction).toContain("cctl spec plan propose");
    expect(signed.refusal.instruction).toContain(
      candidate.compiledDefinitionHash,
    );
    const read = await harness.service.read({ spec: SPEC });
    if (!read.ok) throw new Error("read refused");
    expect(read.value.attempt.status).toBe("proposed");
    expect(read.value.approval).toBeNull();
    expect(admissionRows()).toHaveLength(0);
  });

  it("satisfies the execution_start gate in the same act when the dial is gate", async () => {
    const candidate = await proposedCandidate();

    const signed = await harness.service.signOff({
      spec: SPEC,
      ...candidate,
      approver: "operator",
      actor: HUMAN,
    });

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.executionStartAdmission).toMatchObject({
      dial: "gate",
      basis: "human_approval",
    });
    const rows = admissionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gate: "execution_start",
      basis: "human_approval",
      revision_id: PINNED_REVISION_ID,
      // No execution exists yet: the slot-free prelaunch path is the point.
      execution_id: null,
    });
    expect(rows[0]?.approval_id).toBe(
      signed.value.executionStartAdmission?.approvalId,
    );
    expect(harness.policyNotices).toHaveLength(0);
  });

  it("refuses an agent sign-off while the dial requires a human", async () => {
    const candidate = await proposedCandidate();

    const signed = await harness.service.signOff({
      spec: SPEC,
      ...candidate,
      approver: "agent",
      actor: AGENT,
    });

    expect(signed.ok).toBe(false);
    if (signed.ok) return;
    expect(signed.refusal.code).toBe("human_act_required");
    expect(admissionRows()).toHaveLength(0);
  });

  it("records a policy-basis admission instead of a human approval under a notify dial", async () => {
    const notifySpec = {
      ...SPEC,
      gatePolicy: { preset: "exploratory" } as const,
    };
    const seeded = await harness.service.open({
      spec: notifySpec,
      seedFromLast: true,
      actor: AGENT,
    });
    if (!seeded.ok) throw new Error("open refused");
    await harness.service.edit({
      spec: notifySpec,
      expectedDraftRevision: seeded.value.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.value.document),
      actor: AGENT,
    });
    await harness.service.propose({ spec: notifySpec, actor: AGENT });
    const preview = await harness.service.preview({
      spec: notifySpec,
      stage: "proposed",
    });
    if (!preview.ok) throw new Error("preview refused");

    const signed = await harness.service.signOff({
      spec: notifySpec,
      candidateId: preview.value.candidateId ?? "",
      planHash: preview.value.planHash,
      compiledDefinitionHash: preview.value.compiledDefinitionHash,
      approver: "agent",
      actor: AGENT,
    });

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.executionStartAdmission).toMatchObject({
      dial: "notify",
      basis: "notify_policy",
      approvalId: null,
    });
    expect(admissionRows()).toEqual([
      expect.objectContaining({
        gate: "execution_start",
        basis: "notify_policy",
        approval_id: null,
        execution_id: null,
      }),
    ]);
    expect(harness.policyNotices).toHaveLength(1);
    expect(harness.policyNotices[0]).toMatchObject({
      gate: "execution_start",
      basis: "notify_policy",
    });
  });
});

describe("delivery plan service — preview parity", () => {
  it("gives a proposed preview the exact stored candidate, never a recompile", async () => {
    const seeded = await openSeeded(harness);
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });
    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("propose refused");

    const preview = await harness.service.preview({
      spec: SPEC,
      stage: "proposed",
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const stored = harness.db
      .prepare(
        "SELECT compiled_definition_hash, definition_json FROM spec_delivery_plan_candidates WHERE snapshot_id = ?",
      )
      .get(proposed.value.attempt.proposedSnapshotId) as {
      compiled_definition_hash: string;
      definition_json: string;
    };
    expect(preview.value.compiledDefinitionHash).toBe(
      stored.compiled_definition_hash,
    );
    expect(preview.value.definition).toEqual(
      JSON.parse(stored.definition_json),
    );
    expect(preview.value.planHash).toBe(proposed.value.attempt.planHash);
    expect(preview.value.approvable).toBe(true);
    expect(preview.value.snapshotId).toBe(
      proposed.value.attempt.proposedSnapshotId,
    );
  });

  it("compiles a draft preview that is never approvable and matches what propose will store", async () => {
    const seeded = await openSeeded(harness);
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: seeded.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });

    const draft = await harness.service.preview({ spec: SPEC, stage: "draft" });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.value.approvable).toBe(false);
    expect(draft.value.snapshotId).toBeNull();
    expect(draft.value.candidateId).toBeNull();
    expect(draft.value.approvability).toContain("cctl spec plan propose");

    const proposed = await harness.service.propose({
      spec: SPEC,
      actor: AGENT,
    });
    if (!proposed.ok) throw new Error("propose refused");
    const stored = await harness.service.preview({
      spec: SPEC,
      stage: "proposed",
    });
    if (!stored.ok) throw new Error("proposed preview refused");
    expect(stored.value.compiledDefinitionHash).toBe(
      draft.value.compiledDefinitionHash,
    );
  });

  it("refuses a draft preview whose compare-and-swap token is behind", async () => {
    const seeded = await openSeeded(harness);

    const stale = await harness.service.preview({
      spec: SPEC,
      stage: "draft",
      expectedDraftRevision: seeded.attempt.draftRevision + 3,
    });

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.refusal.code).toBe("stale_plan_draft");
    expect(stale.refusal.instruction).toContain(
      String(seeded.attempt.draftRevision),
    );
  });

  it("refuses a proposed preview while the attempt has frozen nothing", async () => {
    await openSeeded(harness);

    const preview = await harness.service.preview({
      spec: SPEC,
      stage: "proposed",
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.refusal.instruction).toContain("cctl spec plan propose");
    expect(preview.refusal.instruction).toContain("--stage draft");
  });
});

describe("delivery plan service — read projection", () => {
  it("names the act a blocked draft owes and who performs it", async () => {
    await openSeeded(harness);
    const read = await harness.service.read({ spec: SPEC });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.nextAct.actor).toBe("agent");
    expect(read.value.nextAct.command).toContain("cctl spec plan edit");
  });

  it("counts dispositions and lists what still blocks a proposal", async () => {
    await openSeeded(harness);
    const read = await harness.service.read({ spec: SPEC });
    if (!read.ok) return;

    expect(read.value.dispositionCounts).toEqual(
      expect.arrayContaining([
        { disposition: "selected", count: 2 },
        { disposition: "pending_reaffirmation", count: 1 },
        { disposition: "delivered_elsewhere", count: 1 },
      ]),
    );
    expect(read.value.unresolved.map((row) => row.handle)).toEqual(["R1.2"]);
  });

  it("reads the durable attempt back, not an in-memory copy", async () => {
    const opened = await openSeeded(harness);
    const { plans } = createDeliveryPlanTestRepos(harness.db);
    const reloaded = plans.findAttemptById(opened.attempt.id);

    expect(reloaded).not.toBeNull();
    expect(
      deliveryPlanDocumentSchema.parse(
        JSON.parse(reloaded?.content_json ?? ""),
      ),
    ).toEqual(opened.document);
  });
});

describe("delivery plan service — review projection", () => {
  it("resolves each pinned criterion to its full text and delivery class", async () => {
    await openSeeded(harness);

    const review = await harness.service.review({ spec: SPEC });

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const soft = review.value.criteria.find(
      (criterion) => criterion.criterionElementId === "c-soft",
    );
    expect(soft).toMatchObject({
      handle: "R1.2",
      text: "Criterion c-soft is observable.",
      disposition: "pending_reaffirmation",
      deliveryClass: "soft_stale",
    });
  });

  it("names the owning context of a criterion the plan assigned", async () => {
    const opened = await openSeeded(harness);
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: opened.attempt.draftRevision,
      document: selectedOnlyDocument(opened.document),
      actor: AGENT,
    });

    const review = await harness.service.review({ spec: SPEC });
    if (!review.ok) return;

    expect(
      review.value.criteria
        .filter((criterion) => criterion.owningContextId !== null)
        .map((criterion) => criterion.criterionElementId),
    ).toEqual(["c-soft", "c-hard", "c-new"]);
  });

  /**
   * The review surface reads the same projection `spec plan status` does, so a
   * hash a reviewer approves and a hash a receipt reports cannot diverge.
   */
  it("carries the attempt state and candidate identity the plan view reports", async () => {
    const opened = await openSeeded(harness);
    const read = await harness.service.read({ spec: SPEC });

    const review = await harness.service.review({ spec: SPEC });
    if (!review.ok || !read.ok) return;

    expect(review.value.attempt).toEqual(read.value.attempt);
    expect(review.value.health).toEqual(read.value.health);
    expect(review.value.nextAct).toEqual(read.value.nextAct);
    expect(review.value.attempt.id).toBe(opened.attempt.id);
  });

  it("refuses with the opening act when the spec has no attempt", async () => {
    const review = await harness.service.review({ spec: SPEC });

    expect(review.ok).toBe(false);
    if (review.ok) return;
    expect(review.refusal.instruction).toContain("cctl spec plan open");
  });
});

const HUMAN = { kind: "human" } as const;

describe("delivery plan service — audited reaffirmation", () => {
  it("moves the disposition to reaffirmed and records the basis the human judged", async () => {
    await openSeeded(harness);

    const result = await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: HUMAN,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.document.dispositions.find(
      (disposition) => disposition.criterionElementId === "c-soft",
    );
    expect(entry?.disposition).toBe("reaffirmed");
    expect(entry?.reaffirmation).toMatchObject({
      actor: { kind: "human" },
      basisRevisionId: PINNED_REVISION_ID,
      basis: [
        {
          elementId: "req-1",
          reason: "parent_requirement",
          baseHash: "req-1-a",
          currentHash: "req-1-b",
        },
      ],
    });
    expect(
      result.value.criteria.find(
        (criterion) => criterion.criterionElementId === "c-soft",
      )?.effectiveDisposition,
    ).toBe("reaffirmed");
  });

  it("writes the durable audit row naming the criterion", async () => {
    await openSeeded(harness);
    await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: HUMAN,
    });

    const rows = harness.db
      .prepare("SELECT payload_json FROM spec_events WHERE event_type = ?")
      .all("spec-delivery-plan-reaffirmed") as { payload_json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toMatchObject({
      criterionElementId: "c-soft",
      basisRevisionId: PINNED_REVISION_ID,
    });
  });

  it("refuses an agent and names the human act", async () => {
    await openSeeded(harness);

    const result = await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: AGENT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("human_act_required");
    expect(result.refusal.instruction).toContain("Spec Studio");
  });

  it("refuses a criterion whose class does not allow reaffirmation", async () => {
    await openSeeded(harness);

    const result = await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-hard",
      actor: HUMAN,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.unmetConditions.join(" ")).toContain("hard_stale");
    expect(result.refusal.instruction).toContain("re-prove it");
  });

  it("refuses outside a draft and names the reopen that makes it legal", async () => {
    const seeded = await openSeeded(harness);
    await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: HUMAN,
    });
    const current = await harness.service.read({ spec: SPEC });
    if (!current.ok) return;
    await harness.service.edit({
      spec: SPEC,
      expectedDraftRevision: current.value.attempt.draftRevision,
      document: selectedOnlyDocument(seeded.document),
      actor: AGENT,
    });
    await harness.service.propose({ spec: SPEC, actor: AGENT });

    const result = await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: HUMAN,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.instruction).toContain("cctl spec plan reopen");
  });

  /**
   * The act covered the basis a human actually read. When the criterion goes
   * soft-stale against a DIFFERENT basis, nobody has judged the new content,
   * so the criterion reads as pending again — computed from the recorded
   * hashes, never from a stored verdict.
   */
  it("returns the criterion to pending_reaffirmation when its basis moves again", async () => {
    await openSeeded(harness);
    await harness.service.reaffirm({
      spec: SPEC,
      criterionElementId: "c-soft",
      actor: HUMAN,
    });

    const movedBasis = createDeliveryPlanServiceOver(harness, {
      deliveryDelta: async () => ({
        ok: true,
        projection: deliveryDeltaProjectionSchema.parse({
          ...deliveredDelta(),
          criteria: deliveredDelta().criteria.map((criterion) =>
            criterion.criterionElementId === "c-soft"
              ? {
                  ...criterion,
                  freshness: {
                    grade: "soft_stale",
                    basis: [
                      {
                        elementId: "req-1",
                        kind: "requirement",
                        handle: "R1",
                        reason: "parent_requirement",
                        baseHash: "req-1-b",
                        currentHash: "req-1-c",
                      },
                    ],
                  },
                }
              : criterion,
          ),
        }),
      }),
    });

    const review = await movedBasis.review({ spec: SPEC });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const row = review.value.criteria.find(
      (criterion) => criterion.criterionElementId === "c-soft",
    );
    expect(row?.disposition).toBe("reaffirmed");
    expect(row?.effectiveDisposition).toBe("pending_reaffirmation");
    expect(
      review.value.health.findings.map((finding) => finding.ruleId),
    ).toContain("plan/reaffirmed-stale-basis");
  });
});
