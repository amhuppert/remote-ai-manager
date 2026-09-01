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
  createManagedDefinitionTestService,
  seedDeliveryPlanParents,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import { applyDefinitionEdits } from "@/lib/workflow-graph/definition-edits";
import { validateCharterSourceAuthoredShapes } from "@/lib/workflow-graph/validation";
import type { ManagedWorkflowDefinitionService } from "./managed-workflow-definition-service";
import type { DeliveryPlanBinding } from "./delivery-plan";
import { workflowDefinitionHash } from "./delivery-plan-hash";
import {
  createDeliveryPlanService,
  type DeliveryPlanService,
  type DeliveryPlanServiceDeps,
} from "./delivery-plan-service";
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
    elements: ["criterion-one", "criterion-two"].map((id, index) => ({
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
        position: index,
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
  };
}

function deferredBinding(): DeliveryPlanBinding {
  return {
    dispositions: ["criterion-one", "criterion-two"].map((id) => ({
      criterionElementId: id,
      disposition: "deferred" as const,
      deliveredByExecutionId: null,
    })),
    claims: [],
  };
}

interface World {
  service: DeliveryPlanService;
  repos: ReturnType<typeof createDeliveryPlanTestRepos>;
  managedDefinitions: ManagedWorkflowDefinitionService;
}

function createWorld(
  db: Db,
  overrides: Partial<DeliveryPlanServiceDeps> = {},
): World {
  const repos = createDeliveryPlanTestRepos(db);
  const managedDefinitions = createManagedDefinitionTestService();
  let sequence = 0;
  const service = createDeliveryPlanService({
    plans: repos.plans,
    managedDefinitions,
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

async function openClean(world: World) {
  const opened = await world.service.open({ spec: SPEC, actor: AGENT });
  if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
  const edited = await world.service.edit({
    spec: SPEC,
    expectedDraftRevision: opened.value.attempt.draftRevision,
    binding: deferredBinding(),
    actor: AGENT,
  });
  if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));
  return edited.value;
}

describe("delivery-plan service v3 lifecycle", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    seedDeliveryPlanParents(db);
  });

  afterEach(() => db.close());

  it("opens a binding-only plan backed by a real managed definition", async () => {
    const world = createWorld(db);

    const opened = await world.service.open({ spec: SPEC, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));

    expect(opened.value.document).toEqual({
      schemaVersion: 3,
      binding: opened.value.document.binding,
    });
    expect(opened.value.document).not.toHaveProperty("launch");
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
      protocol: "native-sdd-delivery-candidate/v3",
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
    const guarded: ManagedWorkflowDefinitionService = {
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
      claims: [],
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
