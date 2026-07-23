import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import type { Db } from "@/lib/state-store/schemas";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  registerGraphExecutionContract,
  resetGraphExecutionContractForTesting,
} from "@/lib/workflow-graph/execution-contract-port";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import { validateWorkflowDefinition } from "@/lib/workflow-graph/validation";
import { runDefinitionEditRequest } from "@/lib/workflows/definition-edit-handler";
import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import {
  compileSpecExecutionPlan,
  readCompiledContextContract,
} from "./compiler";
import { createSpecExecutionContract } from "./execution-contract";
import { createSpecEventsPublisher } from "./events";

const PROJECT_PATH = "/repos/plan-stage-execution-planning";
const ACTOR = { kind: "agent", conversationId: "conversation-plan" } as const;
const TIMESTAMP = "2026-07-22T12:00:00.000Z";

let db: Db;
let specs: SpecsRepo;
let authoring: AuthoringService;
let idSequence: number;
let timeSequence: number;

beforeEach(() => {
  registerGraphExecutionContract(createSpecExecutionContract());
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  specs = createSpecsRepo(db, createWriteQueue());
  idSequence = 0;
  timeSequence = 0;
  authoring = createAuthoringService({
    specs,
    review: createSpecReviewRepo(db),
    links: createSpecLinksRepo(db),
    events: createSpecEventsPublisher({
      appendInTransaction: createSpecEventsRepo(db).appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    newId(prefix) {
      idSequence += 1;
      return `${prefix}-${idSequence}`;
    },
    now() {
      timeSequence += 1;
      return `2026-07-22T12:00:${String(timeSequence).padStart(2, "0")}.000Z`;
    },
  });
});

afterEach(() => {
  resetGraphExecutionContractForTesting();
  db.close();
});

describe("plan-stage execution planning acceptance", () => {
  it("authors, approves, and compiles a grouped plan into its reviewed execution graph", async () => {
    const authored = await authorGroupedPlan();
    const proposed = await authoring.proposeRevision({
      specId: authored.specId,
      revisionId: authored.revisionId,
      actor: ACTOR,
    });
    expect(proposed).toMatchObject({
      ok: true,
      absorbedSignOff: true,
      revision: { state: "approved", authoringStage: "plan" },
    });
    if (!proposed.ok) throw new Error("expected the plan proposal to pass");

    const definition = await compileApprovedPlan(authored);

    expect(workflowSemanticDefinitionSchema.safeParse(definition).success).toBe(
      true,
    );
    expect(validateWorkflowDefinition(definition)).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      definition.executionContexts.map(({ id, title }) => ({ id, title })),
    ).toEqual([
      { id: "context-lane-build", title: "build — T1, T2" },
      {
        id: "context-task-3",
        title: "T3 — Verify the grouped delivery",
      },
    ]);
    expect(
      definition.tasks.map(({ id, contextId, order }) => ({
        id,
        contextId,
        order,
      })),
    ).toEqual([
      { id: "spec-task-task-1", contextId: "context-lane-build", order: 1 },
      { id: "spec-task-task-2", contextId: "context-lane-build", order: 2 },
      { id: "spec-task-task-3", contextId: "context-task-3", order: 1 },
    ]);
    expect(definition.edges).toEqual([
      {
        id: "edge-groups-%5B%22lane%3Abuild%22%2C%22task%3Atask-3%22%5D",
        sourceContextId: "context-lane-build",
        targetContextId: "context-task-3",
      },
    ]);
    expect(
      readCompiledContextContract(definition, "context-lane-build"),
    ).toMatchObject({
      taskElementIds: ["task-1", "task-2"],
      criterionElementIds: ["criterion-1", "criterion-2"],
    });
  });

  it("regroups through the definition-edit request while preserving every locked task contract and re-deriving context criteria", async () => {
    const authored = await authorGroupedPlan();
    const proposed = await authoring.proposeRevision({
      specId: authored.specId,
      revisionId: authored.revisionId,
      actor: ACTOR,
    });
    if (!proposed.ok) throw new Error("expected the plan proposal to pass");
    const definition = await compileApprovedPlan(authored);
    const originalContractBytes = lockedTaskContractBytes(definition);
    expect(Object.keys(originalContractBytes).sort()).toEqual(
      definition.tasks.map(({ id }) => id).sort(),
    );
    const record: WorkflowDefinitionRecord = {
      id: "workflow-plan-stage",
      name: "Plan-stage execution",
      description: "Compiled from the approved grouped plan",
      schemaVersion: 1,
      revision: 4,
      definition,
      layout: generateWorkflowLayout(definition),
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    let persisted: WorkflowDefinitionDraft | null = null;

    const response = await runDefinitionEditRequest({
      rawBody: {
        baseRevision: 4,
        operations: [
          {
            type: "move-task",
            taskId: "spec-task-task-2",
            contextId: "context-task-3",
            position: { before: "spec-task-task-3" },
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist: async (draft) => {
        persisted = draft;
        return {
          ...record,
          ...draft,
          revision: record.revision + 1,
          updatedAt: "2026-07-22T12:10:00.000Z",
        };
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      applied: 1,
      item: { id: record.id, revision: 5 },
    });
    expect(persisted).not.toBeNull();
    const edited = persisted!.definition;
    expect(lockedTaskContractBytes(edited)).toEqual(originalContractBytes);
    expect(
      edited.tasks.map(({ id, contextId, order }) => ({
        id,
        contextId,
        order,
      })),
    ).toEqual([
      { id: "spec-task-task-1", contextId: "context-lane-build", order: 1 },
      { id: "spec-task-task-2", contextId: "context-task-3", order: 1 },
      { id: "spec-task-task-3", contextId: "context-task-3", order: 2 },
    ]);

    const sourceContract = readCompiledContextContract(
      edited,
      "context-lane-build",
    );
    const targetContract = readCompiledContextContract(
      edited,
      "context-task-3",
    );
    expect(sourceContract.criterionElementIds).toEqual(["criterion-1"]);
    expect(targetContract.criterionElementIds).toEqual([
      "criterion-2",
      "criterion-3",
    ]);
    expect(
      edited.executionContexts.find(({ id }) => id === "context-lane-build")
        ?.acceptanceCriteria,
    ).toBe(sourceContract.acceptanceCriteria);
    expect(
      edited.executionContexts.find(({ id }) => id === "context-task-3")
        ?.acceptanceCriteria,
    ).toBe(targetContract.acceptanceCriteria);
  });

  it("surfaces a concrete 9.12 advisory for a plan-stage proposal without blocking it", async () => {
    const authored = await authorGroupedPlan("contract-bearing");
    const draft = await specs.findRevision(authored.revisionId);
    expect(draft?.authoringStage).toBe("plan");

    const panel = await authoring.lintDraft(
      authored.specId,
      authored.revisionId,
    );
    expect(panel).toContainEqual({
      ruleId: "9.12.serialized-plan",
      severity: "advisory",
      elementHandle: "T1",
      message:
        "The 3-task plan contracts to 2 contexts with no parallel execution path.",
    });

    const proposed = await authoring.proposeRevision({
      specId: authored.specId,
      revisionId: authored.revisionId,
      actor: ACTOR,
    });
    expect(proposed).toMatchObject({
      ok: true,
      absorbedSignOff: false,
      revision: { state: "proposed", authoringStage: "plan" },
    });
  });
});

async function authorGroupedPlan(
  finalPreset: "contract-bearing" | "exploratory" = "exploratory",
): Promise<{
  specId: string;
  revisionId: string;
  specSlug: string;
  specName: string;
}> {
  const created = await authoring.createSpec({
    projectPath: PROJECT_PATH,
    slug: "grouped-plan",
    name: "Grouped Plan",
    gatePolicy: { preset: "fast-path" },
    initialElement: {
      elementId: "requirement-1",
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Compile the reviewed plan into an honest execution graph.",
        priority: "must",
        risk: "high",
      },
    },
    actor: ACTOR,
  });

  const criteria = [
    ["criterion-1", "The first build task produces its approved output."],
    ["criterion-2", "The second build task consumes the first output."],
    ["criterion-3", "Verification consumes the grouped build output."],
  ] as const;
  for (const [index, [elementId, text]] of criteria.entries()) {
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId,
      kind: "criterion",
      parentElementId: "requirement-1",
      position: index + 1,
      payload: {
        kind: "criterion",
        text,
        validationStrategy: {
          kinds: ["test_run", "validator_verdict"],
          note: `Validate ${elementId} from the compiled context contract.`,
        },
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
  }

  const tasks = [
    {
      id: "task-1",
      title: "Build the first contract",
      instructions: "Implement the first approved unit of work.",
      criterionId: "criterion-1",
      dependencies: [] as string[],
      laneGroup: "build",
      touchedPaths: ["src/lib/specs/compiler.ts"],
    },
    {
      id: "task-2",
      title: "Build the dependent contract",
      instructions: "Implement the dependent approved unit of work.",
      criterionId: "criterion-2",
      dependencies: ["task-1"],
      laneGroup: "build",
      touchedPaths: ["src/lib/specs/execution-contract.ts"],
    },
    {
      id: "task-3",
      title: "Verify the grouped delivery",
      instructions: "Verify the approved grouped execution output.",
      criterionId: "criterion-3",
      dependencies: ["task-2"],
      laneGroup: undefined,
      touchedPaths: ["src/lib/specs/compiler.test.ts"],
    },
  ] as const;
  for (const [index, task] of tasks.entries()) {
    await authoring.upsertDraftElement({
      specId: created.spec.id,
      revisionId: created.draft.id,
      elementId: task.id,
      kind: "task",
      parentElementId: null,
      position: criteria.length + index + 1,
      payload: {
        kind: "task",
        title: task.title,
        instructions: task.instructions,
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [task.criterionId],
        dependsOnTaskElementIds: [...task.dependencies],
        ...(task.laneGroup === undefined ? {} : { laneGroup: task.laneGroup }),
        touchedPaths: [...task.touchedPaths],
      },
      baseElementVersion: null,
      actor: ACTOR,
    });
  }

  await specs.updateGatePolicy({
    specId: created.spec.id,
    gatePolicy: { preset: finalPreset },
    updatedAt: "2026-07-22T12:01:00.000Z",
  });

  return {
    specId: created.spec.id,
    revisionId: created.draft.id,
    specSlug: created.spec.slug,
    specName: created.spec.name,
  };
}

async function compileApprovedPlan(authored: {
  specId: string;
  revisionId: string;
  specSlug: string;
  specName: string;
}): Promise<WorkflowSemanticDefinition> {
  const snapshot = await authoring.getRevisionSnapshot(authored.revisionId);
  if (snapshot === null) throw new Error("missing approved plan snapshot");
  return compileSpecExecutionPlan({
    spec: {
      id: authored.specId,
      slug: authored.specSlug,
      name: authored.specName,
    },
    revisionSnapshot: snapshot,
    scope: {
      selectedTaskIds: ["task-1", "task-2", "task-3"],
      selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-3"],
      exclusionDispositions: [],
    },
    scopeHash: "grouped-plan-scope-hash",
    approvalRequired: false,
  });
}

function lockedTaskContractBytes(
  definition: WorkflowSemanticDefinition,
): Record<string, string> {
  const taskRegions = (definition.lockedRegions ?? []).filter((region) =>
    region.paths.every((path) => path.startsWith("/tasks/")),
  );
  return Object.fromEntries(
    taskRegions.map((region) => {
      const taskId = region.paths[0]?.split("/")[2];
      const task = definition.tasks.find(
        (candidate) => candidate.id === taskId,
      );
      if (taskId === undefined || task === undefined) {
        throw new Error("locked task contract points to a missing task");
      }
      const contract = {
        lockedRegion: region,
        id: task.id,
        title: task.title,
        instructions: task.instructions,
        metadata: task.metadata,
      };
      return [taskId, Buffer.from(JSON.stringify(contract)).toString("hex")];
    }),
  );
}
