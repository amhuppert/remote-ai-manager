import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config";
import { createStateManager } from "@/lib/state";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import { createWorkflowStorageService } from "./storage";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";

const TEST_DIR = path.join("/tmp", `cc-graph-workflow-${Date.now()}`);

function createServices() {
  const configReader = createConfigReader(TEST_DIR);
  const stateManager = createStateManager({
    readConfig: () => configReader.readConfig(),
  });

  return {
    stateManager,
    storage: createWorkflowStorageService({
      readConfig: () => configReader.readConfig(),
    }),
    repository: createGraphWorkflowExecutionRepository({
      getSession: stateManager.getSession,
      mutateSession: stateManager.mutateSession,
    }),
  };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
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
      workflow: null,
      workflowHistory: [],
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
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
    created.activeContextId = "context-plan";
    await repository.update("/repo", "session-1", created);

    const active = await repository.getActive("/repo", "session-1");
    expect(active?.status).toBe("running");
    expect(active?.activeContextId).toBe("context-plan");

    await repository.archiveActive("/repo", "session-1");

    const session = await stateManager.getSession("/repo", "session-1");
    expect(session?.graphWorkflowExecution).toBeNull();
    expect(session?.graphWorkflowExecutionHistory).toHaveLength(1);
  });
});
