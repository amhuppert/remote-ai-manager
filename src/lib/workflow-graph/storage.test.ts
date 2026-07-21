import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createStateStore as createStateManager } from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "./test-fixtures";
import { createWorkflowStorageService, type WorkflowScope } from "./storage";
import { createWorkflowCharterService } from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";

const TEST_DIR = path.join("/tmp", `workflow-storage-test-${Date.now()}`);

const REPO_SCOPE: WorkflowScope = { kind: "project", projectPath: "/repo" };

function createServices() {
  const configReader = createConfigReader(TEST_DIR);
  const stateManager = createStateManager({
    readConfig: () => configReader.readConfig(),
  });

  // Charter seed writes charter.md to the session worktree. These tests use a
  // synthetic worktree path that does not exist on disk, so inject a no-op fs
  // writer — the subject under test is state-store persistence, not the file.
  const eventPublisher = createGraphWorkflowExecutionEventPublisher();
  const charterService = createWorkflowCharterService({
    writeFile: async () => {},
    ensureDir: async () => {},
    publishCharterRegistered: eventPublisher.publishCharterRegistered,
  });

  return {
    stateManager,
    storage: createWorkflowStorageService({
      resolveConfigDir: () => TEST_DIR,
    }),
    repository: createGraphWorkflowExecutionRepository({
      getSession: stateManager.getSession,
      getActiveGraphWorkflowExecution:
        stateManager.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        stateManager.mutateActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        stateManager.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        stateManager.markGraphWorkflowContextEventsPreReset,
      eventPublisher,
      charterService,
      readConfig: () => configReader.readConfig(),
    }),
  };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
});

afterEach(() => {
  _resetStateDb();
});

describe("workflow-graph storage", () => {
  it("refuses replacing locked content while an execution seeds from the definition", async () => {
    let seededDefinitionId: string | null = null;
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => TEST_DIR,
      async listActiveExecutions() {
        if (seededDefinitionId === null) return new Map();
        return new Map([
          [
            "/repo\0session-1",
            createWorkflowExecution({
              seedDefinitionId: seededDefinitionId,
              status: "running",
            }),
          ],
        ]);
      },
    });
    const definition = createWorkflowDefinition({
      lockedRegions: [
        {
          paths: ["/tasks/task-plan-1/instructions"],
          sourceUri: "contract://plans/revision-7",
          reason: "Task instructions are contract-derived",
        },
      ],
    });
    const created = await storage.create(REPO_SCOPE, {
      name: "Locked workflow",
      description: null,
      definition,
      layout: createWorkflowDefinitionRecord().layout,
    });
    seededDefinitionId = created.id;
    const replacement = structuredClone(definition);
    replacement.tasks[0]!.instructions = "Weakened downstream instructions";

    await expect(
      storage.update(REPO_SCOPE, created.id, {
        name: created.name,
        description: created.description,
        definition: replacement,
        layout: created.layout,
      }),
    ).rejects.toMatchObject({
      code: "region_locked",
      lockedPath: "/tasks/task-plan-1/instructions",
      sourceUri: "contract://plans/revision-7",
      instruction:
        "Amend at source contract://plans/revision-7 and recompile the workflow definition.",
    });

    expect((await storage.get(REPO_SCOPE, created.id))?.revision).toBe(1);
    expect(
      (await storage.get(REPO_SCOPE, created.id))?.definition.tasks[0]
        ?.instructions,
    ).toBe("Read the relevant files.");
  });

  it("refuses replacing content selected by a wildcard locked path", async () => {
    let seededDefinitionId: string | null = null;
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => TEST_DIR,
      async listActiveExecutions() {
        if (seededDefinitionId === null) return new Map();
        return new Map([
          [
            "/repo\0session-1",
            createWorkflowExecution({
              seedDefinitionId: seededDefinitionId,
              status: "running",
            }),
          ],
        ]);
      },
    });
    const definition = createWorkflowDefinition({
      lockedRegions: [
        {
          paths: ["/tasks/*/instructions"],
          sourceUri: "contract://plans/revision-7",
          reason: "All task instructions are contract-derived",
        },
      ],
    });
    const created = await storage.create(REPO_SCOPE, {
      name: "Wildcard-locked workflow",
      description: null,
      definition,
      layout: createWorkflowDefinitionRecord().layout,
    });
    seededDefinitionId = created.id;
    const replacement = structuredClone(definition);
    replacement.tasks[0]!.instructions = "Weakened downstream instructions";

    await expect(
      storage.update(REPO_SCOPE, created.id, {
        name: created.name,
        description: created.description,
        definition: replacement,
        layout: created.layout,
      }),
    ).rejects.toMatchObject({
      code: "region_locked",
      lockedPath: "/tasks/*/instructions",
      sourceUri: "contract://plans/revision-7",
    });

    expect((await storage.get(REPO_SCOPE, created.id))?.revision).toBe(1);
    expect(
      (await storage.get(REPO_SCOPE, created.id))?.definition.tasks[0]
        ?.instructions,
    ).toBe("Read the relevant files.");
  });

  it("creates, lists, gets, updates, and deletes workflow definitions", async () => {
    const { storage } = createServices();

    const created = await storage.create(REPO_SCOPE, {
      name: "My Workflow",
      description: "Stored workflow",
      definition: createWorkflowDefinition(),
      layout: createWorkflowDefinitionRecord().layout,
    });

    expect(created.id).toBeTruthy();
    expect(created.revision).toBe(1);

    const listed = await storage.list(REPO_SCOPE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const loaded = await storage.get(REPO_SCOPE, created.id);
    expect(loaded?.name).toBe("My Workflow");

    const updated = await storage.update(REPO_SCOPE, created.id, {
      name: "Updated Workflow",
      description: "Updated description",
      definition: createWorkflowDefinition(),
      layout: createWorkflowDefinitionRecord().layout,
    });
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe("Updated Workflow");

    expect(await storage.delete(REPO_SCOPE, created.id)).toBe(true);
    expect(await storage.get(REPO_SCOPE, created.id)).toBeNull();
  });

  it("rejects invalid definitions before persisting", async () => {
    const { storage } = createServices();

    await expect(
      storage.create(REPO_SCOPE, {
        name: "Bad Workflow",
        description: null,
        definition: createWorkflowDefinition({
          tasks: [
            {
              id: "task-bad",
              contextId: "missing",
              order: 1,
              title: "Bad task",
              instructions: "Broken",
              source: "user",
            },
          ],
        }),
        layout: createWorkflowDefinitionRecord().layout,
      }),
    ).rejects.toThrow("unknown-task-context");
  });

  it("rejects create with an undeclared parameter reference (accept-time lint via choke point)", async () => {
    const { storage } = createServices();
    const base = createWorkflowDefinition();

    await expect(
      storage.create(REPO_SCOPE, {
        name: "Parameterized",
        description: null,
        definition: createWorkflowDefinition({
          tasks: base.tasks.map((task, index) =>
            index === 0
              ? { ...task, instructions: "Build {{inputs.unknown-name}} now" }
              : task,
          ),
        }),
        layout: createWorkflowDefinitionRecord().layout,
      }),
    ).rejects.toThrow("undeclared-parameter-reference");
  });

  it("persists a clean parameterized definition through create", async () => {
    const { storage } = createServices();
    const base = createWorkflowDefinition();

    const created = await storage.create(REPO_SCOPE, {
      name: "Parameterized",
      description: null,
      definition: createWorkflowDefinition({
        parameters: [
          {
            type: "string",
            name: "feature-name",
            label: "Feature",
            required: true,
          },
        ],
        tasks: base.tasks.map((task, index) =>
          index === 0
            ? { ...task, instructions: "Build {{inputs.feature-name}} now" }
            : task,
        ),
      }),
      layout: createWorkflowDefinitionRecord().layout,
    });

    const loaded = await storage.get(REPO_SCOPE, created.id);
    expect(loaded?.definition.parameters).toHaveLength(1);
    expect(loaded?.definition.parameters[0]?.name).toBe("feature-name");
  });

  it("rejects update with an undeclared parameter reference (accept-time lint via choke point)", async () => {
    const { storage } = createServices();
    const base = createWorkflowDefinition();

    const created = await storage.create(REPO_SCOPE, {
      name: "Clean",
      description: null,
      definition: createWorkflowDefinition(),
      layout: createWorkflowDefinitionRecord().layout,
    });

    await expect(
      storage.update(REPO_SCOPE, created.id, {
        name: "Now Broken",
        description: null,
        definition: createWorkflowDefinition({
          tasks: base.tasks.map((task, index) =>
            index === 0
              ? { ...task, instructions: "Build {{inputs.unknown-name}} now" }
              : task,
          ),
        }),
        layout: createWorkflowDefinitionRecord().layout,
      }),
    ).rejects.toThrow("undeclared-parameter-reference");
  });
});

describe("graph workflow execution repository", () => {
  it("creates, updates, and archives active executions in session state", async () => {
    const { repository, stateManager } = createServices();

    seedWholeState(getStateDb(), {
      projects: {
        "/repo": {
          rootPath: "/repo",
          sessions: {
            "session-1": {
              sessionName: "session-1",
              worktreePath: "/repo/.worktrees/session-1",
              branchName: "csm/session-1",
              createdAt: "2026-03-27T12:00:00.000Z",
              lastActivityAt: "2026-03-27T12:00:00.000Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              graphWorkflowExecution: null,
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const created = await repository.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "workflow-1",
      definitionRevision: 2,
      executionId: "execution-1",
      startedAt: "2026-03-27T12:00:00.000Z",
      inputs: {},
      launchedTier: "project",
    });

    expect(created.status).toBe("pending");
    expect(created.taskStates["task-plan-1"]?.status).toBe("pending");

    created.status = "running";
    created.activeContextIds = ["context-plan"];
    await repository.update("/repo", "session-1", created);

    const active = await repository.getActive("/repo", "session-1");
    expect(active?.status).toBe("running");
    expect(active?.activeContextIds).toEqual(["context-plan"]);

    await repository.archiveActive("/repo", "session-1");

    // The active execution is cleared from the dedicated table on archive...
    const afterArchive = await repository.getActive("/repo", "session-1");
    expect(afterArchive).toBeNull();
    // ...and never lived on the session row in the first place.
    const session = await stateManager.getSession("/repo", "session-1");
    expect(session?.graphWorkflowExecution).toBeNull();

    const archived = await stateManager.listArchivedGraphWorkflowExecutions(
      "/repo",
      "session-1",
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]?.id).toBe("execution-1");
  });
});
