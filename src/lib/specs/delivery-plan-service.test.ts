import { collectStableAccountabilityContextIds } from "@/lib/workflow-graph/authored-accountability";
import { locateAuthoredAccountabilityCoverage } from "@/lib/workflow-graph/authored-accountability-coverage";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";
import { canonicalPlanDefinitionHash } from "@/lib/workflows/plan-review/schemas";
import { createGraphPlanReviewsRepo } from "@/lib/state-store/graph-plan-reviews-repo";
import { createPlanReviewService } from "@/lib/workflows/plan-review/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A capturing logger, not a silent one: the planning telemetry of #80 design
 * 3.10 is a field contract this service is held to, and the module-level file
 * sink has no injectable seam.
 */
const capturedLogs = vi.hoisted(() => {
  const entries: { level: string; message: string; fields: unknown }[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };
  return {
    entries,
    info: record("info"),
    debug: record("debug"),
    warn: record("warn"),
    error: record("error"),
  };
});

vi.mock("@/lib/logging", () => ({
  createLogger: () => capturedLogs,
}));

import type Database from "better-sqlite3";

import {
  EARLIER_EXECUTION_ID,
  LAUNCHED_EXECUTION_ID,
  PINNED_REVISION_ID,
  PROJECT_PATH,
  SPEC_ID,
  createDeliveryPlanTestRepos,
  createManagedDefinitionTestService,
  seedDeliveryPlanParents,
  type TestManagedDefinitionService,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import { applyDefinitionEdits } from "@/lib/workflow-graph/definition-edits";
import { validateCharterSourceAuthoredShapes } from "@/lib/workflow-graph/validation";
import {
  NATIVE_SDD_CLAIMS_SOURCE_ID,
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  deliveryPlanCandidateRecordSchema,
  deliveryPlanCandidateManifestV3Schema,
  deliveryPlanCandidateClaims,
} from "./delivery-plan";
import { renderSeededDeliveryPlanMission } from "./delivery-plan-charter-seed";
import {
  dedupeServerOwnedDeliveryPlanSources,
  isServerOwnedDeliveryPlanSource,
} from "./delivery-plan-finalization";
import { mergeServerOwnedRegions } from "@/lib/workflow-graph/locked-regions";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  workflowDefinitionHash,
  deliveryPlanBindingHash,
  deliveryPlanCandidateHash,
} from "./delivery-plan-hash";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  createDeliveryPlanService,
  type DeliveryPlanService,
  type DeliveryPlanServiceDeps,
} from "./delivery-plan-service";
import type { Spec, SpecRevisionSnapshot } from "./schemas";
import type { DeliveryPlanView } from "./delivery-plan-views";
import { createDeliveryPlanPreflightPort } from "./delivery-plan-preflight";
import { CHARTER_UNAUTHORED_RATIONALE } from "./refusal-rationale";

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

const INTENT_SECTIONS = [
  {
    id: "section-problem",
    role: "intent_problem" as const,
    title: "Problem",
    body: "Planners pay an accidental cost on the native SDD path.",
  },
  {
    id: "section-outcomes",
    role: "intent_outcomes" as const,
    title: "Outcomes",
    body: "A planner authors one plan.json and proposes it.",
  },
];

function pinnedRevision(): SpecRevisionSnapshot {
  return {
    revision: {
      id: PINNED_REVISION_ID,
      specId: SPEC_ID,
      number: 2,
      state: "approved",
      authoringStage: "design",
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
      ...INTENT_SECTIONS.map(({ id, role, title, body }, index) => ({
        element: {
          id,
          specId: SPEC_ID,
          kind: "section" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: PINNED_REVISION_ID,
          elementId: id,
          position: index,
          payload: { kind: "section" as const, role, title, body },
          payloadHash: `sha256:${id}`,
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      })),
      ...["criterion-one", "criterion-two"].map((id, index) => ({
        element: {
          id,
          specId: SPEC_ID,
          kind: "criterion" as const,
          number: index + 1,
          parentElementId: null,
          createdAt: NOW,
        },
        version: {
          revisionId: PINNED_REVISION_ID,
          elementId: id,
          position: INTENT_SECTIONS.length + index,
          payload: {
            kind: "criterion" as const,
            text: id,
            validationStrategy: { kinds: ["test_run" as const] },
          },
          payloadHash: `sha256:${id}`,
          elementVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      })),
    ],
  };
}

function deferredBinding(): DeliveryPlanBinding {
  return {
    dispositions: ["criterion-one", "criterion-two"].map((id) => ({
      criterionElementId: id,
      disposition: "deferred" as const,
      deliveredByExecutionId: null,
    })),
  };
}

interface World {
  service: DeliveryPlanService;
  repos: ReturnType<typeof createDeliveryPlanTestRepos>;
  managedDefinitions: TestManagedDefinitionService;
}

function createWorld(
  db: Db,
  overrides: Partial<Omit<DeliveryPlanServiceDeps, "managedDefinitions">> & {
    managedDefinitions?: TestManagedDefinitionService;
  } = {},
): World {
  const repos = createDeliveryPlanTestRepos(db);
  // The world hands back the SAME service its plan service reads, so a test
  // that authors a charter through the replace path writes where propose looks.
  const managedDefinitions =
    overrides.managedDefinitions ?? createManagedDefinitionTestService();
  let sequence = 0;
  const service = createDeliveryPlanService({
    plans: repos.plans,
    managedDefinitions,
    reviewRepo: repos.review,
    planReviews: createPlanReviewService(createGraphPlanReviewsRepo(db)),
    events: repos.events,
    runInTransaction: (operation) => db.transaction(operation).immediate(),
    currentApprovedRevision: async () => pinnedRevision(),
    revisionSnapshot: async () => pinnedRevision(),
    launchedExecutionState: () => "running",
    launchedWorkflowExecutionId: () => "workflow-execution-launched",
    lastDeliveryBasis: async () => ({
      ok: true,
      basis: { comparedExecutionId: null, criteria: [] },
    }),
    admitLaunch: async ({ launch, accountabilityGroups }) => ({
      ok: true,
      launch,
      warnings: [],
      stableAccountabilityContextIds: [],
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
    projectName: () => "command-center",
    ...overrides,
  });
  return { service, repos, managedDefinitions };
}

const AUTHORED_MISSION =
  "Deliver the withheld status line behind the memory gate.";
const AUTHORED_SOURCE = {
  rank: 1,
  id: "design-doc",
  label: "Memory design",
  type: "document" as const,
  locator: "docs/designs/memory.md",
  description: "The decisions this delivery implements.",
};

/**
 * The remedy a planner performs: `cctl workflow replace` with a bare plan
 * carrying an authored charter. The route's own merge runs here — server-owned
 * regions filled from the stored record, server-owned sources deduplicated —
 * so the bytes this stores are the bytes the replace path would store.
 */
async function replaceWithAuthoredCharter(
  world: World,
  workflowDefinitionId: string,
  charter: Partial<WorkflowDefinitionRecord["definition"]["charter"]> = {},
) {
  const existing = await world.managedDefinitions.get({
    projectPath: PROJECT_PATH,
    workflowDefinitionId,
  });
  if (existing === null) throw new Error("definition missing");
  const {
    origin: _origin,
    lockedRegions: _lockedRegions,
    approvalRequired: _approvalRequired,
    ...authored
  } = existing.definition;
  const merged = mergeServerOwnedRegions(existing.definition, {
    ...authored,
    charter: {
      mission: AUTHORED_MISSION,
      sourcesOfTruth: [AUTHORED_SOURCE],
      ...charter,
    },
  });
  return world.managedDefinitions.replaceLaunch({
    workflowDefinitionId,
    launch: {
      name: existing.name,
      description: existing.description,
      definition: {
        ...merged,
        charter: {
          ...merged.charter,
          sourcesOfTruth: dedupeServerOwnedDeliveryPlanSources(
            merged.charter.sourcesOfTruth,
          ),
        },
      },
      layout: existing.layout,
    },
  });
}

async function openClean(world: World) {
  const opened = await world.service.open({ spec: SPEC, actor: AGENT });
  if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
  await replaceWithAuthoredCharter(world, opened.value.workflowDefinition.id);
  const edited = await world.service.edit({
    spec: SPEC,
    expectedDraftRevision: opened.value.attempt.draftRevision,
    binding: deferredBinding(),
    actor: AGENT,
  });
  if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));
  return edited.value;
}

/**
 * Abandon transitions durably recorded against one attempt. Counted from the
 * audit rows rather than the attempt status because an idempotent retirement
 * and a double-recorded one leave the SAME status behind.
 */
function countAbandonTransitions(db: Db, attemptId: string): number {
  const rows = db
    .prepare(
      "SELECT payload_json FROM spec_events WHERE event_type = 'spec-delivery-plan-transitioned'",
    )
    .all() as { payload_json: string }[];
  return rows.filter((row) => {
    const payload: unknown = JSON.parse(row.payload_json);
    return (
      typeof payload === "object" &&
      payload !== null &&
      "attemptId" in payload &&
      payload.attemptId === attemptId &&
      "transition" in payload &&
      typeof payload.transition === "object" &&
      payload.transition !== null &&
      "kind" in payload.transition &&
      payload.transition.kind === "abandon"
    );
  }).length;
}

describe("delivery-plan service v4 lifecycle", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
    capturedLogs.entries.length = 0;
  });

  afterEach(() => db.close());

  it.each(["draft", "proposed", "approved", "parked"] as const)(
    "requires an unlaunched v3 %s to reopen into v4 while preserving candidate history",
    async (status) => {
      const world = createWorld(db);
      const opened = await openClean(world);
      const legacyBinding = { ...opened.document.binding, claims: [] };
      let snapshotId: string | null = null;
      let historicalBytes: string | null = null;
      if (status !== "draft") {
        const proposed = await world.service.propose({
          spec: SPEC,
          actor: AGENT,
        });
        if (!proposed.ok)
          throw new Error(proposed.refusal.unmetConditions.join(" "));
        snapshotId = proposed.value.attempt.proposedSnapshotId;
        if (!snapshotId)
          throw new Error("fixture requires a candidate snapshot");
        const snapshot = world.repos.plans.findSnapshotById(snapshotId);
        const record = deliveryPlanCandidateRecordSchema.parse(
          JSON.parse(snapshot?.content_json ?? "null"),
        );
        const legacy = deliveryPlanCandidateManifestV3Schema.parse({
          protocol: "native-sdd-delivery-candidate/v3",
          schemaVersion: 3,
          specId: record.specId,
          attemptId: record.attemptId,
          candidateId: record.candidateId,
          pinnedRevisionId: record.pinnedRevisionId,
          draftRevision: record.draftRevision,
          workflowDefinition: record.workflowDefinition,
          binding: {
            ...legacyBinding,
            claims: deliveryPlanCandidateClaims(record),
          },
          bindingHash: deliveryPlanBindingHash(legacyBinding),
        });
        historicalBytes = stableStringify(legacy);
        const candidateHash = deliveryPlanCandidateHash(legacy);
        db.prepare(
          "UPDATE spec_delivery_plan_snapshots SET content_json = ?, candidate_hash = ? WHERE id = ?",
        ).run(historicalBytes, candidateHash, snapshotId);
        if (status === "approved" || status === "parked") {
          world.repos.plans.recordTransition({
            attemptId: opened.attempt.id,
            occurredAt: NOW,
            actor: HUMAN,
            transition: {
              kind: "approve",
              candidateId: legacy.candidateId,
              candidateHash,
            },
          });
        }
        if (status === "parked") {
          world.repos.plans.recordTransition({
            attemptId: opened.attempt.id,
            occurredAt: NOW,
            actor: HUMAN,
            transition: {
              kind: "park",
              candidateId: legacy.candidateId,
              candidateHash,
              reason: "Review before launch",
            },
          });
        }
      }
      db.prepare(
        "UPDATE spec_delivery_plan_attempts SET content_json = ? WHERE id = ?",
      ).run(
        stableStringify({ schemaVersion: 3, binding: legacyBinding }),
        opened.attempt.id,
      );

      const launch = await world.service.resolveLaunch({ spec: SPEC });
      expect(launch.kind).toBe("refused");
      if (launch.kind === "refused")
        expect(launch.refusal.instruction).toContain(
          `spec plan reopen ${SPEC.slug}`,
        );
      const reopened = await world.service.reopen({
        spec: SPEC,
        actor: AGENT,
        reason: "Author criterion coverage",
      });
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      expect(reopened.value.document).toEqual({
        schemaVersion: 4,
        binding: { dispositions: legacyBinding.dispositions },
      });
      expect(reopened.value.attempt.status).toBe("draft");
      expect(reopened.value.approval).toBeNull();
      expect(reopened.value.prelaunch).toBeNull();
      if (snapshotId !== null)
        expect(
          world.repos.plans.findSnapshotById(snapshotId)?.content_json,
        ).toBe(historicalBytes);
    },
  );

  it.each(["approved", "changes_requested"] as const)(
    "shows an advisory %s review on proposal and sign-off",
    async (verdict) => {
      const world = createWorld(db);
      const opened = await openClean(world);
      const definition = await world.managedDefinitions.get({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: opened.workflowDefinition.id,
      });
      if (!definition) throw new Error("Missing definition");
      createGraphPlanReviewsRepo(db).record({
        id: "review-plan",
        definitionHash: canonicalPlanDefinitionHash(definition.definition),
        reviewerConversationId: "reviewer",
        verdict,
        reviewedAt: NOW,
        findings: verdict === "changes_requested" ? "Review findings" : null,
      });
      const proposed = await world.service.propose({
        spec: SPEC,
        actor: AGENT,
      });
      if (!proposed.ok)
        throw new Error(proposed.refusal.unmetConditions.join(" "));
      expect(proposed.value).toHaveProperty("reviewStatus.state", verdict);
      const { candidateId, candidateHash } = proposed.value.attempt;
      if (!candidateId || !candidateHash) throw new Error("Missing candidate");
      const signed = await world.service.signOff({
        spec: SPEC,
        actor: HUMAN,
        approver: "Alex",
        candidateId,
        candidateHash,
      });
      expect(signed).toMatchObject({
        ok: true,
        value: { reviewStatus: { state: verdict } },
      });
    },
  );

  it("keeps proposal advisory when the review lookup throws", async () => {
    const world = createWorld(db, {
      planReviews: {
        findLatestTerminalReview() {
          throw new Error("Review store unavailable");
        },
      },
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    expect(proposed).toMatchObject({
      ok: true,
      value: { reviewStatus: { state: "unreviewed" } },
    });
  });

  it.each([
    ["coverage/selected-criterion-uncovered", "context-spawner", []],
    ["coverage/not-must-run", "context-alternate", ["criterion-one"]],
    ["coverage/unknown-id", "context-spawner", ["missing-criterion"]],
    ["coverage/unselected", "context-spawner", ["criterion-two"]],
    ["coverage/unstable-context", "context-loop-worker", ["criterion-one"]],
  ] as const)(
    "clears %s through graph replacement with validate/status/propose parity",
    async (code, contextId, covers) => {
      const world = createWorld(db, {
        admitLaunch: async ({ launch, accountabilityGroups }) => ({
          ok: true,
          launch,
          warnings: [],
          stableAccountabilityContextIds: collectStableAccountabilityContextIds(
            launch.definition,
          ),
          accountabilityGroupAnalysis: locateAuthoredAccountabilityCoverage({
            source: { kind: "authored", definition: launch.definition },
            groups: accountabilityGroups,
          }),
        }),
      });
      const opened = await world.service.open({ spec: SPEC, actor: AGENT });
      if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
      const binding = {
        dispositions: opened.value.document.binding.dispositions.map((entry) =>
          entry.criterionElementId === "criterion-two"
            ? { ...entry, disposition: "deferred" as const }
            : entry,
        ),
      };
      const dispositioned = await world.service.edit({
        spec: SPEC,
        actor: HUMAN,
        expectedDraftRevision: opened.value.attempt.draftRevision,
        binding,
      });
      if (!dispositioned.ok)
        throw new Error(dispositioned.refusal.unmetConditions.join(" "));
      const launch = createMaximalAuthoredWorkflowLaunchFixture();
      launch.definition.executionContexts =
        launch.definition.executionContexts.map((context) => ({
          ...context,
          acceptanceCriteria: [
            {
              id: "observable",
              statement: "The selected outcome is observable",
              covers: context.id === contextId ? [...covers] : [],
            },
          ],
        }));
      const definition = await world.managedDefinitions.replaceLaunch({
        workflowDefinitionId: opened.value.workflowDefinition.id,
        launch,
      });
      const before = await world.service.read({ spec: SPEC });
      if (!before.ok) throw new Error(before.refusal.unmetConditions.join(" "));
      expect(before.value.health.findings).toContainEqual(
        expect.objectContaining({ ruleId: code }),
      );
      const preflight = await world.service.preflight({
        spec: SPEC,
        attemptId: opened.value.attempt.id,
        workflowDefinitionId: definition.id,
        launch: definition,
      });
      if (!preflight.ok) throw new Error(preflight.refusal.message);
      expect(preflight.findings).toEqual(before.value.health.findings);
      const refused = await world.service.propose({ spec: SPEC, actor: AGENT });
      if (refused.ok) throw new Error("Invalid coverage unexpectedly proposed");
      expect(refused.refusal.findings).toEqual(before.value.health.findings);
      launch.definition.executionContexts =
        launch.definition.executionContexts.map((context) => ({
          ...context,
          acceptanceCriteria: [
            {
              id: "observable",
              statement: "The selected outcome is observable",
              covers: context.id === "context-spawner" ? ["criterion-one"] : [],
            },
          ],
        }));
      await world.managedDefinitions.replaceLaunch({
        workflowDefinitionId: definition.id,
        launch,
      });
      const after = await world.service.read({ spec: SPEC });
      if (!after.ok) throw new Error(after.refusal.unmetConditions.join(" "));
      expect(after.value.health.findings).not.toContainEqual(
        expect.objectContaining({ ruleId: code }),
      );
      expect(after.value.health.blocking).toBe(0);
      const proposed = await world.service.propose({
        spec: SPEC,
        actor: AGENT,
      });
      expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    },
  );

  it("freezes coverage-derived claims in a v4 candidate after graph replacement", async () => {
    const world = createWorld(db, {
      admitLaunch: async ({ launch, accountabilityGroups }) => ({
        ok: true,
        launch,
        warnings: [],
        stableAccountabilityContextIds: launch.definition.executionContexts.map(
          (context) => context.id,
        ),
        accountabilityGroupAnalysis: accountabilityGroups.map((group) => ({
          ...group,
          claimantContextIds: [...group.claimantContextIds],
          stableExistingClaimantContextIds: [...group.claimantContextIds],
          mustRunClaimantContextIds: [...group.claimantContextIds],
          covered: group.claimantContextIds.length > 0,
        })),
      }),
    });
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const definition = createWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context, index) => ({
        ...context,
        acceptanceCriteria: [
          {
            id: "observable-outcome",
            statement: "The observable outcome holds.",
            covers: index === 0 ? ["criterion-one", "criterion-two"] : [],
          },
        ],
      }),
    );
    definition.seededDocuments = [
      {
        relativePath: ".cc/graph-workflow-docs/research.md",
        contents: "Authored research",
        description: "Research",
        readWhen: "Before planning",
      },
    ];
    await world.managedDefinitions.replaceLaunch({
      workflowDefinitionId: opened.value.workflowDefinition.id,
      launch: makeLaunchDocument(definition),
    });
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const snapshot = world.repos.plans.findSnapshotsByAttemptId(
      proposed.value.attempt.id,
    )[0];
    expect(snapshot).toBeDefined();
    const manifest: unknown = JSON.parse(snapshot?.content_json ?? "null");
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      protocol: "native-sdd-delivery-candidate/v4",
      claims: [
        {
          contextId: "context-plan",
          criterionElementIds: ["criterion-one", "criterion-two"],
        },
      ],
    });
    expect(manifest).not.toHaveProperty("binding.claims");
    const frozen = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: proposed.value.workflowDefinition.id,
    });
    const documents = frozen?.definition.seededDocuments;
    expect(
      documents?.find((document) =>
        document.relativePath.endsWith("/context-plan.md"),
      )?.contents,
    ).toContain("criterion-one");
    expect(
      documents?.find((document) =>
        document.relativePath.endsWith("/claims.md"),
      )?.contents,
    ).toContain("## Context context-plan");
    expect(
      documents?.find((document) =>
        document.relativePath.endsWith("/research.md"),
      )?.contents,
    ).toBe("Authored research");
  });

  it("opens a binding-only plan backed by a real managed definition", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    expect(opened.value.document).toEqual({
      schemaVersion: 4,
      binding: opened.value.document.binding,
    });
    expect(opened.value.document).not.toHaveProperty("launch");
    expect(opened.value.document.binding).not.toHaveProperty("claims");
    expect(opened.value.workflowDefinition).toMatchObject({
      id: opened.value.attempt.id,
      revision: 1,
      builderHref:
        "/projects/command-center/workflows?definition=plan-service-1",
    });
    await expect(
      world.managedDefinitions.get({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: opened.value.workflowDefinition.id,
      }),
    ).resolves.toMatchObject({ id: opened.value.workflowDefinition.id });
  });

  it("sends a draft author to plan.json and the preflight, never spec plan edit", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    expect(opened.value.nextAct.command).toBe(
      `author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition ${opened.value.workflowDefinition.id}`,
    );
    expect(
      `${opened.value.nextAct.command} ${opened.value.nextAct.reason}`,
    ).not.toContain("spec plan edit");
  });

  it("counts both sides of the ledger on the opened attempt", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    const selected = opened.value.document.binding.dispositions.filter(
      (disposition) => disposition.disposition === "in_scope",
    ).length;
    expect(opened.value.ledger).toMatchObject({
      selected,
      claimed: 0,
      unclaimed: selected,
      charter: { state: "seed_stub" },
    });
    expect(opened.value.ledger.dispositions).toEqual(
      opened.value.dispositionCounts.map(({ disposition, count }) => ({
        kind: disposition,
        count,
      })),
    );
  });

  it("withholds a claim from a context the graph never declared stable", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const selected = opened.value.document.binding.dispositions.filter(
      (disposition) => disposition.disposition === "in_scope",
    );

    const definition = createWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context, index) => ({
        ...context,
        acceptanceCriteria: [
          {
            id: "covered-outcome",
            statement: "The outcome holds.",
            covers:
              index === 0
                ? selected.map((entry) => entry.criterionElementId)
                : [],
          },
        ],
      }),
    );
    await world.managedDefinitions.replaceLaunch({
      workflowDefinitionId: opened.value.workflowDefinition.id,
      launch: makeLaunchDocument(definition),
    });
    const read = await world.service.read({ spec: SPEC });
    if (!read.ok) throw new Error(read.refusal.unmetConditions.join(" "));
    expect(
      read.value.health.findings.map((finding) => finding.ruleId),
    ).toContain("coverage/unstable-context");
    expect(read.value.ledger).toMatchObject({
      selected: selected.length,
      claimed: 0,
      unclaimed: selected.length,
    });
  });

  it("seeds the mission from the pinned revision's intent and no authoring source", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const definition = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: opened.value.workflowDefinition.id,
    });

    expect(definition?.definition.charter.mission).toBe(
      renderSeededDeliveryPlanMission({ pinnedRevision: pinnedRevision() }),
    );
    expect(definition?.definition.charter.mission).toContain(
      "Planners pay an accidental cost on the native SDD path.",
    );
    expect(definition?.definition.charter.mission).not.toContain(
      `Author the delivery launch for ${SPEC.slug}.`,
    );
    // A rename rewrites the spec's slug and name, so neither may appear in the
    // text the charter rule later reconstructs and compares against.
    expect(definition?.definition.charter.mission).not.toContain(SPEC.name);
    expect(definition?.definition.charter.mission).not.toContain(SPEC.slug);
    // Only the server-owned pair survives finalization, and each exactly once:
    // the seeded pinned-spec entry is the one finalization deduplicates.
    expect(
      definition?.definition.charter.sourcesOfTruth.map((source) => source.id),
    ).toEqual([NATIVE_SDD_PINNED_SPEC_SOURCE_ID, NATIVE_SDD_CLAIMS_SOURCE_ID]);
    expect(
      definition?.definition.charter.sourcesOfTruth.every((source) =>
        isServerOwnedDeliveryPlanSource(source),
      ),
    ).toBe(true);
  });

  it("opens a first managed definition that satisfies authored charter validation", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const definition = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: opened.value.workflowDefinition.id,
    });

    expect(definition).not.toBeNull();
    expect(
      validateCharterSourceAuthoredShapes(definition!.definition.charter),
    ).toEqual([]);
  });

  it("cleans up a newly created definition after a database failure", async () => {
    const stored = createManagedDefinitionTestService();
    const removeExact = vi.fn(stored.removeExact);
    const plans = createDeliveryPlanTestRepos(db).plans;
    const world = createWorld(db, {
      managedDefinitions: { ...stored, removeExact },
      plans: {
        ...plans,
        open: () => {
          throw new Error("database write failed");
        },
      },
    });

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });

    expect(opened.ok).toBe(false);
    expect(removeExact).toHaveBeenCalledOnce();
    await expect(
      stored.get({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: "plan-service-1",
      }),
    ).resolves.toBeNull();
  });

  it("reuses the sole process-crash orphan as the attempt identity", async () => {
    const stored = createManagedDefinitionTestService();
    const orphan = await stored.open({
      spec: SPEC,
      pinnedRevisionId: PINNED_REVISION_ID,
      attemptId: "orphan-attempt",
      launch: createWorkflowDefinitionRecord(),
    });
    const world = createWorld(db, {
      managedDefinitions: {
        ...stored,
        findOpenOrphan: async () => orphan,
      },
    });

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });

    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    expect(opened.value.attempt.id).toBe(orphan.id);
    expect(opened.value.workflowDefinition.id).toBe(orphan.id);
  });

  it("reports the unauthored charter in status and the edit receipt, and clears it through replace", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const edited = await world.service.edit({
      spec: SPEC,
      expectedDraftRevision: opened.value.attempt.draftRevision,
      binding: deferredBinding(),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));
    const status = await world.service.read({ spec: SPEC });
    if (!status.ok) throw new Error(status.refusal.unmetConditions.join(" "));

    const charterFindings = (
      findings: DeliveryPlanView["health"]["findings"],
    ) =>
      findings.filter(
        (finding) => finding.ruleId === "launch/charter-unauthored",
      );
    // One projection, so the receipt and the status read the same bytes — a
    // status reporting nothing while propose refuses is the shape this rules out.
    expect(charterFindings(edited.value.health.findings)).toEqual(
      charterFindings(status.value.health.findings),
    );
    expect(
      charterFindings(status.value.health.findings).map(
        (finding) => finding.elementHandle,
      ),
    ).toEqual(["charter.mission", "charter.sourcesOfTruth"]);
    expect(charterFindings(status.value.health.findings)[0]?.message).toContain(
      `cctl workflow replace ${opened.value.workflowDefinition.id}`,
    );
    // The count a managed replace or edit receipt reports its delta against.
    expect(edited.value.health.blocking).toBe(
      charterFindings(edited.value.health.findings).length,
    );

    await replaceWithAuthoredCharter(world, opened.value.workflowDefinition.id);
    const remedied = await world.service.read({ spec: SPEC });
    if (!remedied.ok)
      throw new Error(remedied.refusal.unmetConditions.join(" "));

    expect(charterFindings(remedied.value.health.findings)).toEqual([]);
    expect(remedied.value.health.blocking).toBe(0);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    expect(proposed.ok).toBe(true);
  });

  /**
   * `spec rename` rewrites the spec's slug and name. A seed reconstructed from
   * the current name would stop matching the text open actually wrote, and the
   * stub the gate exists to catch would sail through — so the seed is rendered
   * from the pinned revision alone, which no rename can move.
   */
  it("still refuses the seeded mission after the spec is renamed", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const definitionId = opened.value.workflowDefinition.id;
    const seeded = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: definitionId,
    });
    if (seeded === null) throw new Error("definition missing");

    // The bypass this pins: an authored source with the server's own mission
    // left untouched, read back under the spec's new name.
    await replaceWithAuthoredCharter(world, definitionId, {
      mission: seeded.definition.charter.mission,
    });
    const renamed = { ...SPEC, slug: "renamed-plan", name: "Renamed plan" };
    const status = await world.service.read({ spec: renamed });
    if (!status.ok) throw new Error(status.refusal.unmetConditions.join(" "));

    expect(
      status.value.health.findings
        .filter((finding) => finding.ruleId === "launch/charter-unauthored")
        .map((finding) => finding.elementHandle),
    ).toEqual(["charter.mission"]);
  });

  /**
   * `one-propose-projection`: propose refuses on what status reports, so the
   * two cannot disagree. An unavailable pinned revision used to travel a
   * refusal path of its own, with wording the projection never produced.
   */
  it("refuses propose through the projection status reads", async () => {
    let revisionAvailable = true;
    const world = createWorld(db, {
      revisionSnapshot: async () =>
        revisionAvailable ? pinnedRevision() : null,
    });
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    await replaceWithAuthoredCharter(world, opened.value.workflowDefinition.id);
    revisionAvailable = false;

    const status = await world.service.read({ spec: SPEC });
    if (!status.ok) throw new Error(status.refusal.unmetConditions.join(" "));
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(
      status.value.health.findings.map((finding) => finding.ruleId),
    ).toEqual(["plan/pinned-revision-unavailable"]);
    expect(proposed.refusal.unmetConditions).toEqual(
      status.value.health.findings.map((finding) => finding.message),
    );
  });

  it("returns the identical finding set through validate preflight, status, and propose", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const definition = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: opened.value.workflowDefinition.id,
    });
    if (definition === null) throw new Error("definition missing");
    const preflightPort = createDeliveryPlanPreflightPort({
      findOwnerships: async () => [
        {
          projectPath: PROJECT_PATH,
          specId: SPEC.id,
          specSlug: SPEC.slug,
          attemptId: opened.value.attempt.id,
        },
      ],
      findSpec: async () => SPEC,
      deliveryPlanFor: async () => world.service,
    });

    const preflight = await preflightPort.preflight({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: definition.id,
      launch: definition,
    });
    const status = await world.service.read({ spec: SPEC });
    if (!status.ok) throw new Error(status.refusal.unmetConditions.join(" "));
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });

    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.findings).toEqual(status.value.health.findings);
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.findings).toEqual(status.value.health.findings);
  });

  it.each([
    {
      ownerships: [],
      code: "definition_not_managed" as const,
      instruction: "cctl spec plan status <slug>",
    },
    {
      ownerships: [
        {
          projectPath: "/another-project",
          specId: "foreign-spec",
          specSlug: "foreign-plan",
          attemptId: "foreign-attempt",
        },
      ],
      code: "definition_project_mismatch" as const,
      instruction: "cctl spec plan status foreign-plan",
    },
  ])(
    "refuses ownership lookup with $code and its status instruction",
    async ({ ownerships, code, instruction }) => {
      const preflightPort = createDeliveryPlanPreflightPort({
        findOwnerships: async () => ownerships,
        findSpec: async () => {
          throw new Error("ownership refusal must not read a spec");
        },
        deliveryPlanFor: async () => {
          throw new Error("ownership refusal must not create a service");
        },
      });

      const preflight = await preflightPort.preflight({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: "managed-wf",
        launch: makeLaunchDocument(createWorkflowDefinitionRecord().definition),
      });

      expect(preflight).toMatchObject({
        ok: false,
        refusal: {
          code,
          instruction: expect.stringContaining(instruction),
        },
      });
    },
  );

  it("refuses a proposed attempt with the reopen instruction and rationale", async () => {
    const world = createWorld(db);
    const clean = await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const definition = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: clean.attempt.workflowDefinitionId,
    });
    if (definition === null) throw new Error("definition missing");
    const preflightPort = createDeliveryPlanPreflightPort({
      findOwnerships: async () => [
        {
          projectPath: PROJECT_PATH,
          specId: SPEC.id,
          specSlug: SPEC.slug,
          attemptId: clean.attempt.id,
        },
      ],
      findSpec: async () => SPEC,
      deliveryPlanFor: async () => world.service,
    });

    const preflight = await preflightPort.preflight({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: definition.id,
      launch: definition,
    });

    expect(preflight).toMatchObject({
      ok: false,
      refusal: {
        code: "delivery_plan_not_draft",
        instruction: expect.stringContaining(
          "cctl spec plan reopen delivery-plan",
        ),
        rationale:
          "the signed candidate is immutable so sign-off approves exact bytes",
      },
    });
  });

  /**
   * A graph the launch boundary refuses used to hide the charter refusal
   * entirely, so a planner fixed the graph, proposed again, and met a second
   * refusal about a charter that had been a stub the whole time.
   */
  it("refuses an inadmissible launch with the charter condition and its reason", async () => {
    let admissible = true;
    const world = createWorld(db, {
      admitLaunch: async ({ launch }) =>
        admissible
          ? {
              ok: true,
              launch,
              warnings: [],
              stableAccountabilityContextIds: [],
              accountabilityGroupAnalysis: [],
            }
          : {
              ok: false,
              issues: [
                {
                  path: "definition.executionContexts",
                  message: "A launch needs at least one execution context.",
                },
              ],
            },
    });
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    admissible = false;

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.unmetConditions).toContain(
      "definition.executionContexts: A launch needs at least one execution context.",
    );
    expect(
      proposed.refusal.unmetConditions.some((condition) =>
        condition.startsWith("charter.mission:"),
      ),
    ).toBe(true);
    expect(proposed.refusal.rationale).toBe(CHARTER_UNAUTHORED_RATIONALE);
  });

  it("refuses propose with the reason the seed stub cannot be signed", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const edited = await world.service.edit({
      spec: SPEC,
      expectedDraftRevision: opened.value.attempt.draftRevision,
      binding: deferredBinding(),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });

    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.refusal.code).toBe("lint_blocked");
    expect(proposed.refusal.rationale).toBe(CHARTER_UNAUTHORED_RATIONALE);
    // The remedy the condition names has to be reachable from the refusal that
    // carries it; `spec plan edit` cannot clear a charter finding.
    expect(proposed.refusal.instruction).toContain("cctl workflow replace");
    expect(
      proposed.refusal.unmetConditions.some((condition) =>
        condition.startsWith("charter.mission:"),
      ),
    ).toBe(true);
  });

  it("edits only binding bytes and proposes the frozen definition identity", async () => {
    const world = createWorld(db);
    const edited = await openClean(world);

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok) {
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    }

    expect(proposed.value.attempt.status).toBe("proposed");
    expect(proposed.value.document.binding).toEqual(deferredBinding());
    expect(proposed.value.workflowDefinition).toMatchObject({
      id: edited.workflowDefinition.id,
      revision: edited.workflowDefinition.revision + 1,
    });
    const snapshot = world.repos.plans.findSnapshotById(
      proposed.value.attempt.proposedSnapshotId!,
    );
    expect(JSON.parse(snapshot?.content_json ?? "null")).toMatchObject({
      protocol: "native-sdd-delivery-candidate/v4",
      candidateId: edited.workflowDefinition.id,
      workflowDefinition: {
        id: edited.workflowDefinition.id,
        revision: edited.workflowDefinition.revision + 1,
      },
    });
    expect(snapshot?.content_json).not.toContain('"launch"');
  });

  it("reopens by cloning the frozen definition and retains the prior candidate", async () => {
    const world = createWorld(db);
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const frozenId = proposed.value.workflowDefinition.id;

    const reopened = await world.service.reopen({
      spec: SPEC,
      reason: "Adjust configuration.",
      actor: AGENT,
    });
    if (!reopened.ok)
      throw new Error(reopened.refusal.unmetConditions.join(" "));

    expect(reopened.value.attempt.status).toBe("draft");
    expect(reopened.value.workflowDefinition.id).not.toBe(frozenId);
    await expect(
      world.managedDefinitions.get({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: frozenId,
      }),
    ).resolves.toMatchObject({ id: frozenId });
  });

  it("cleans up only a newly created reopen clone after a database failure", async () => {
    const stored = createManagedDefinitionTestService();
    const removeExact = vi.fn(stored.removeExact);
    const plans = createDeliveryPlanTestRepos(db).plans;
    const world = createWorld(db, {
      managedDefinitions: { ...stored, removeExact },
      plans: {
        ...plans,
        reopen: () => {
          throw new Error("database write failed");
        },
      },
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));

    const reopened = await world.service.reopen({
      spec: SPEC,
      reason: "Adjust configuration.",
      actor: AGENT,
    });

    expect(reopened.ok).toBe(false);
    expect(removeExact).toHaveBeenCalledOnce();
    const removedId = removeExact.mock.calls[0]?.[0].workflowDefinitionId;
    await expect(
      stored.get({
        projectPath: PROJECT_PATH,
        workflowDefinitionId: removedId!,
      }),
    ).resolves.toBeNull();
  });

  it("reuses the sole process-crash reopen clone", async () => {
    const stored = createManagedDefinitionTestService();
    const world = createWorld(db, { managedDefinitions: stored });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const sourceDefinitionId = proposed.value.workflowDefinition.id;
    const orphan = await stored.clone({
      spec: SPEC,
      pinnedRevisionId: PINNED_REVISION_ID,
      attemptId: proposed.value.attempt.id,
      sourceDefinitionId,
      cloneDefinitionId: "orphan-reopen",
    });
    const retryWorld = createWorld(db, {
      managedDefinitions: {
        ...stored,
        findReopenOrphan: async () => orphan,
      },
    });

    const reopened = await retryWorld.service.reopen({
      spec: SPEC,
      reason: "Retry after restart.",
      actor: AGENT,
    });

    if (!reopened.ok)
      throw new Error(reopened.refusal.unmetConditions.join(" "));
    expect(reopened.value.workflowDefinition.id).toBe(orphan.id);
  });

  it("refuses sign-off and launch when the frozen definition identity no longer matches", async () => {
    const stored = createManagedDefinitionTestService();
    let rejectExactRead = false;
    const guarded: TestManagedDefinitionService = {
      ...stored,
      getExact: async (input) => {
        if (rejectExactRead) {
          throw new Error("stored definition hash does not match the proposal");
        }
        return stored.getExact(input);
      },
    };
    const world = createWorld(db, { managedDefinitions: guarded });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    rejectExactRead = true;

    const signed = await world.service.signOff({
      spec: SPEC,
      candidateId,
      candidateHash,
      actor: HUMAN,
      approver: "Alex",
    });
    rejectExactRead = false;
    const approved = await world.service.signOff({
      spec: SPEC,
      candidateId,
      candidateHash,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!approved.ok) {
      throw new Error(approved.refusal.unmetConditions.join(" "));
    }
    rejectExactRead = true;
    const launch = await world.service.resolveLaunch({ spec: SPEC });

    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.refusal.code).toBe("integrity_mismatch");
    expect(launch.kind).toBe("refused");
    if (launch.kind === "refused") {
      expect(launch.refusal.code).toBe("integrity_mismatch");
    }
  });

  it("batch reaffirms multiple criteria in one binding revision", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    const pending: DeliveryPlanBinding = {
      dispositions: ["criterion-one", "criterion-two"].map((id) => ({
        criterionElementId: id,
        disposition: "pending_reaffirmation" as const,
        deliveredByExecutionId: EARLIER_EXECUTION_ID,
      })),
    };
    const edited = await world.service.edit({
      spec: SPEC,
      expectedDraftRevision: opened.value.attempt.draftRevision,
      binding: pending,
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));

    const reaffirmed = await world.service.reaffirmBatch({
      spec: SPEC,
      expectedDraftRevision: edited.value.attempt.draftRevision,
      criterionElementIds: ["criterion-one", "criterion-two"],
      actor: HUMAN,
    });
    if (!reaffirmed.ok) {
      throw new Error(reaffirmed.refusal.unmetConditions.join(" "));
    }

    expect(reaffirmed.value.attempt.draftRevision).toBe(
      edited.value.attempt.draftRevision + 1,
    );
    expect(
      reaffirmed.value.document.binding.dispositions.map(
        (entry) => entry.disposition,
      ),
    ).toEqual(["reaffirmed", "reaffirmed"]);
  });

  it("refuses planning while newer authoring is unsettled", async () => {
    const world = createWorld(db, {
      activeAuthoringBlocker: async () => ({
        revisionId: "requirements-extension",
        revisionNumber: 3,
        stage: "requirements",
        state: "proposed",
      }),
    });

    const refused = await world.service.open({ spec: SPEC, actor: AGENT });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("authoring_unsettled");
    expect(refused.refusal.unmetConditions.join(" ")).toContain(
      "requirements revision 3",
    );
  });

  it("reports unsettled authoring before a running prior delivery attempt", async () => {
    let authoringIsSettled = true;
    const world = createWorld(db, {
      activeAuthoringBlocker: async () =>
        authoringIsSettled
          ? null
          : {
              revisionId: "requirements-extension",
              revisionNumber: 3,
              stage: "requirements",
              state: "draft",
            },
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
    authoringIsSettled = false;

    const refused = await world.service.open({ spec: SPEC, actor: AGENT });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("authoring_unsettled");
    expect(refused.refusal.unmetConditions.join(" ")).toContain(
      "requirements revision 3",
    );
  });

  it("opens the next delta plan after the launched execution is terminal", async () => {
    const world = createWorld(db, {
      launchedExecutionState: () => "delivered",
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));

    const next = await world.service.open({ spec: SPEC, actor: AGENT });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.attempt.status).toBe("draft");
  });

  it("routes a retired launched attempt to `spec plan open`, not to sign-off", async () => {
    const world = createWorld(db);
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
    expect(launched.value.nextAct.command).toBe(
      `cctl spec status ${SPEC.slug}`,
    );

    const abandoned = await world.service.abandonLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      reason: "The run was abandoned.",
      actor: AGENT,
    });
    if (!abandoned.ok)
      throw new Error(abandoned.refusal.unmetConditions.join(" "));

    const status = await world.service.read({ spec: SPEC });
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error("A retired attempt still reads as live");
    expect(status.refusal.instruction).toContain(
      `cctl spec plan open ${SPEC.slug}`,
    );

    const relaunch = await world.service.resolveLaunch({ spec: SPEC });
    expect(relaunch.kind).toBe("refused");
    if (relaunch.kind === "ready") throw new Error("Launch was not refused");
    expect(relaunch.refusal.instruction).toContain(
      `cctl spec plan open ${SPEC.slug}`,
    );
    expect(relaunch.refusal.unmetConditions.join(" ")).not.toContain(
      "not signed off",
    );
  });

  it("refuses an edit of a launched attempt without naming the spec-side row id", async () => {
    const world = createWorld(db);
    const opened = await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));

    const edited = await world.service.edit({
      spec: SPEC,
      expectedDraftRevision: opened.attempt.draftRevision,
      binding: deferredBinding(),
      actor: AGENT,
    });

    expect(edited.ok).toBe(false);
    if (edited.ok) throw new Error("A launched attempt accepted an edit");
    const refusal = [
      ...edited.refusal.unmetConditions,
      edited.refusal.instruction,
    ].join(" ");
    // The storage-layer remedy used to interpolate `launched_execution_id`,
    // the internal spec execution row id, producing a `--execution` command
    // the resolver now refuses outright (design 3.5, D-B).
    expect(refusal).not.toContain(LAUNCHED_EXECUTION_ID);
    expect(refusal).toContain("cctl spec capture <slug> --file <task.json>");
  });

  it("retires a launched attempt idempotently, recording one abandon transition", async () => {
    const world = createWorld(db);
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
    const attemptId = launched.value.attempt.id;

    const first = await world.service.abandonLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      reason: "The run was abandoned.",
      actor: AGENT,
    });
    if (!first.ok) throw new Error(first.refusal.unmetConditions.join(" "));
    const second = await world.service.abandonLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      reason: "The run was abandoned.",
      actor: AGENT,
    });

    expect(second).toEqual({ ok: true, value: { attemptId } });
    expect(countAbandonTransitions(db, attemptId)).toBe(1);
  });

  it("serializes every frozen-definition lifecycle transition", async () => {
    const stored = createManagedDefinitionTestService();
    const lockKeys: string[] = [];
    const world = createWorld(db, {
      managedDefinitions: {
        ...stored,
        runExclusive: async (workflowDefinitionId, operation) => {
          lockKeys.push(workflowDefinitionId);
          return operation();
        },
      },
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    lockKeys.length = 0;

    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const parked = await world.service.park({
      spec: SPEC,
      ...candidate,
      reason: "Review launch inputs.",
      actor: AGENT,
    });
    if (!parked.ok) throw new Error(parked.refusal.unmetConditions.join(" "));
    const launch = await world.service.resolveLaunch({ spec: SPEC });
    if (launch.kind !== "ready") throw new Error("Launch was not ready");
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
    const abandoned = await world.service.abandonLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      reason: "Scope changed.",
      actor: AGENT,
    });
    if (!abandoned.ok) {
      throw new Error(abandoned.refusal.unmetConditions.join(" "));
    }

    expect(lockKeys).toEqual(Array(5).fill(candidateId));
  });

  it("lets a definition edit author the charter of an open draft and of a reopened draft", async () => {
    const world = createWorld(db);
    const opened = await openClean(world);
    const charterEdit = {
      type: "update-charter" as const,
      mission: "Deliver the approved spec, not the plan-authoring stub.",
      invariants: [
        { id: "inv-one", statement: "Every criterion maps to a context." },
      ],
    };

    const draft = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: opened.workflowDefinition.id,
    });
    const draftEdit = applyDefinitionEdits(draft!, [charterEdit]);
    expect(draftEdit.ok).toBe(true);
    if (!draftEdit.ok) return;
    expect(draftEdit.record.definition.charter.mission).toBe(
      charterEdit.mission,
    );

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const reopened = await world.service.reopen({
      spec: SPEC,
      reason: "Author the real charter.",
      actor: AGENT,
    });
    if (!reopened.ok)
      throw new Error(reopened.refusal.unmetConditions.join(" "));
    const clone = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: reopened.value.workflowDefinition.id,
    });
    const cloneEdit = applyDefinitionEdits(clone!, [charterEdit]);
    expect(cloneEdit.ok).toBe(true);
    const cloneSourceIds = clone!.definition.charter.sourcesOfTruth.map(
      (source) => source.id,
    );
    expect(
      cloneSourceIds.filter((id) => id === "native-sdd-pinned-spec"),
    ).toHaveLength(1);
    expect(
      cloneSourceIds.filter((id) => id === "native-sdd-claims"),
    ).toHaveLength(1);
  });

  it("freezes the charter into the definition revision the candidate names at propose", async () => {
    const world = createWorld(db);
    const edited = await openClean(world);

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));

    const frozen = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: edited.workflowDefinition.id,
    });
    expect(frozen?.revision).toBe(edited.workflowDefinition.revision + 1);
    expect(frozen?.definition.lockedRegions?.map((lock) => lock.paths)).toEqual(
      [["/charter"], ["/origin", "/approvalRequired"]],
    );
    expect(proposed.value.workflowDefinition).toMatchObject({
      id: frozen!.id,
      revision: frozen!.revision,
      definitionHash: workflowDefinitionHash(frozen!),
    });
    const locked = applyDefinitionEdits(frozen!, [
      { type: "update-charter", mission: "Too late." },
    ]);
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.issues[0]?.code).toBe("region_locked");
  });

  it("thaws the frozen definition when the proposal commit fails", async () => {
    const stored = createManagedDefinitionTestService();
    const plans = createDeliveryPlanTestRepos(db).plans;
    const world = createWorld(db, {
      managedDefinitions: stored,
      plans: {
        ...plans,
        propose: () => {
          throw new Error("database write failed");
        },
      },
    });
    const edited = await openClean(world);

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });

    expect(proposed.ok).toBe(false);
    const definition = await stored.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: edited.workflowDefinition.id,
    });
    expect(
      definition?.definition.lockedRegions?.flatMap((lock) => lock.paths),
    ).not.toContain("/charter");
    expect(
      applyDefinitionEdits(definition!, [
        { type: "update-charter", mission: "Still authorable." },
      ]).ok,
    ).toBe(true);
  });
});

// #80 design 3.10: planning-phase friction has to leave telemetry, or the next
// retrospective can count planning cost only by tallying tool calls in a
// transcript.
describe("delivery-plan planning telemetry", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
    capturedLogs.entries.length = 0;
  });

  afterEach(() => db.close());

  function eventsNamed(event: string) {
    return capturedLogs.entries.filter((entry) => entry.message === event);
  }

  function fieldsOf(event: string): unknown[] {
    return eventsNamed(event).map((entry) => entry.fields);
  }

  it("reports the surface of every draft-health evaluation", async () => {
    const world = createWorld(db);
    const edited = await openClean(world);
    const definition = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: edited.workflowDefinition.id,
    });

    const preflighted = await world.service.preflight({
      spec: SPEC,
      attemptId: edited.attempt.id,
      workflowDefinitionId: edited.workflowDefinition.id,
      launch: {
        name: definition!.name,
        description: definition!.description,
        definition: definition!.definition,
        layout: definition!.layout,
      },
    });
    expect(preflighted.ok).toBe(true);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    expect(proposed.ok).toBe(true);

    const surfaces = fieldsOf("spec.plan.preflight").map(
      (fields) => (fields as { surface: string }).surface,
    );
    expect(new Set(surfaces)).toEqual(
      new Set(["status", "validate", "propose"]),
    );
    for (const fields of fieldsOf("spec.plan.preflight")) {
      expect(fields).toMatchObject({ slug: "delivery-plan" });
      // Ids, a surface name and counts — never a finding message.
      expect(Object.keys(fields as object).sort()).toEqual([
        "blocking",
        "codes",
        "slug",
        "surface",
      ]);
    }
    // The evaluation the propose ran on a corrected draft owes nothing.
    expect(
      fieldsOf("spec.plan.preflight").filter(
        (fields) => (fields as { surface: string }).surface === "propose",
      ),
    ).toEqual([
      {
        slug: "delivery-plan",
        surface: "propose",
        blocking: 0,
        codes: [],
      },
    ]);
  });

  it("names the blocking codes a refused propose evaluation found", async () => {
    const world = createWorld(db);
    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    capturedLogs.entries.length = 0;

    // The seeded charter is still a stub, so propose refuses.
    const refused = await world.service.propose({ spec: SPEC, actor: AGENT });
    expect(refused.ok).toBe(false);

    const proposeEvaluations = fieldsOf("spec.plan.preflight").filter(
      (fields) => (fields as { surface: string }).surface === "propose",
    );
    expect(proposeEvaluations).toHaveLength(1);
    // `blocking` counts findings and `codes` names rules, so a seeded draft
    // that owes four acts under two rules reports both numbers.
    expect(proposeEvaluations[0]).toEqual({
      slug: "delivery-plan",
      surface: "propose",
      blocking: 4,
      codes: [
        "coverage/selected-criterion-uncovered",
        "launch/charter-unauthored",
      ],
    });
  });

  it("reports coverage at freeze", async () => {
    const world = createWorld(db);
    const edited = await openClean(world);
    // The seeded draft carries no execution contexts; give it the fixture
    // graph so `contexts` reports a count the definition actually has.
    const shape = createWorkflowDefinition();
    const existing = await world.managedDefinitions.get({
      projectPath: PROJECT_PATH,
      workflowDefinitionId: edited.workflowDefinition.id,
    });
    if (existing === null) throw new Error("definition missing");
    world.managedDefinitions.replaceLaunch({
      workflowDefinitionId: edited.workflowDefinition.id,
      launch: {
        name: existing.name,
        description: existing.description,
        definition: {
          ...existing.definition,
          executionContexts: shape.executionContexts,
          tasks: shape.tasks,
          edges: shape.edges,
        },
        layout: existing.layout,
      },
    });

    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));

    expect(shape.executionContexts.length).toBeGreaterThan(0);
    expect(fieldsOf("spec.plan.propose.accepted")).toEqual([
      {
        slug: "delivery-plan",
        covered: 0,
        selected: 0,
        contexts: shape.executionContexts.length,
      },
    ]);
  });

  it("records every attempt transition with the states either side and the actor kind", async () => {
    const world = createWorld(db, {
      launchedExecutionState: () => "delivered",
    });
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await world.service.signOff({
      spec: SPEC,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await world.service.recordLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));
    const retired = await world.service.abandonLaunch({
      spec: SPEC,
      executionId: LAUNCHED_EXECUTION_ID,
      reason: "Superseded",
      actor: AGENT,
    });
    if (!retired.ok) throw new Error(retired.refusal.unmetConditions.join(" "));

    expect(fieldsOf("spec.plan.attempt.transition")).toEqual([
      { slug: "delivery-plan", from: "none", to: "draft", actor: "agent" },
      { slug: "delivery-plan", from: "draft", to: "proposed", actor: "agent" },
      {
        slug: "delivery-plan",
        from: "proposed",
        to: "approved",
        actor: "human",
      },
      {
        slug: "delivery-plan",
        from: "approved",
        to: "launched",
        actor: "agent",
      },
      {
        slug: "delivery-plan",
        from: "launched",
        to: "abandoned",
        actor: "agent",
      },
    ]);
  });

  it("records the park and reopen transitions", async () => {
    const world = createWorld(db);
    await openClean(world);
    const proposed = await world.service.propose({ spec: SPEC, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("Proposal did not freeze a candidate");
    }
    const parked = await world.service.park({
      spec: SPEC,
      candidateId,
      candidateHash,
      reason: "Waiting on review",
      actor: AGENT,
    });
    if (!parked.ok) throw new Error(parked.refusal.unmetConditions.join(" "));
    const reopened = await world.service.reopen({
      spec: SPEC,
      reason: "Findings applied",
      actor: AGENT,
    });
    if (!reopened.ok)
      throw new Error(reopened.refusal.unmetConditions.join(" "));

    expect(fieldsOf("spec.plan.attempt.transition").slice(-2)).toEqual([
      { slug: "delivery-plan", from: "proposed", to: "parked", actor: "agent" },
      { slug: "delivery-plan", from: "parked", to: "draft", actor: "agent" },
    ]);
  });
});
