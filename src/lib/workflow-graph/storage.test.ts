import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createStateManager } from "@/lib/state-store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import { createWorkflowStorageService } from "./storage";
import { createWorkflowCharterService } from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";

const TEST_DIR = path.join("/tmp", `cc-graph-workflow-${Date.now()}`);

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
  it("creates, lists, gets, updates, and deletes workflow definitions", async () => {
    const { storage } = createServices();

    const created = await storage.create("/repo", {
      name: "My Workflow",
      description: "Stored workflow",
      definition: createWorkflowDefinition(),
      layout: createWorkflowDefinitionRecord().layout,
    });

    expect(created.id).toBeTruthy();
    expect(created.revision).toBe(1);

    const listed = await storage.list("/repo");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const loaded = await storage.get("/repo", created.id);
    expect(loaded?.name).toBe("My Workflow");

    const updated = await storage.update("/repo", created.id, {
      name: "Updated Workflow",
      description: "Updated description",
      definition: createWorkflowDefinition(),
      layout: createWorkflowDefinitionRecord().layout,
    });
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe("Updated Workflow");

    expect(await storage.delete("/repo", created.id)).toBe(true);
    expect(await storage.get("/repo", created.id)).toBeNull();
  });

  it("rejects invalid definitions before persisting", async () => {
    const { storage } = createServices();

    await expect(
      storage.create("/repo", {
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
});

describe("graph workflow execution repository", () => {
  it("creates, updates, and archives active executions in session state", async () => {
    const { repository, stateManager } = createServices();

    await stateManager.updateSession("/repo", {
      sessionName: "session-1",
      worktreePath: "/repo/.worktrees/session-1",
      branchName: "csm/session-1",
      createdAt: "2026-03-27T12:00:00.000Z",
      lastActivityAt: "2026-03-27T12:00:00.000Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc",
      objective: null,
      creationMode: "fast",
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      referenceDocuments: [],
    });

    const created = await repository.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      definitionId: "workflow-1",
      definitionRevision: 2,
      executionId: "execution-1",
      startedAt: "2026-03-27T12:00:00.000Z",
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
