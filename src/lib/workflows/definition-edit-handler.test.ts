import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "@/lib/workflow-graph/test-fixtures";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import { runDefinitionEditRequest } from "./definition-edit-handler";

function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

/** A persist double that records the last draft and echoes an updated record. */
function persistSpy(record: WorkflowDefinitionRecord) {
  const calls: WorkflowDefinitionDraft[] = [];
  const persist = vi.fn(async (draft: WorkflowDefinitionDraft) => {
    calls.push(draft);
    return {
      ...record,
      name: draft.name,
      description: draft.description,
      definition: draft.definition,
      layout: draft.layout,
      revision: record.revision + 1,
    };
  });
  return { persist, calls };
}

describe("runDefinitionEditRequest", () => {
  it("honors the injected contract before persisting changed task membership", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: {
        ...createTestGraphExecutionContract(),
        deriveContextAcceptanceCriteria: () => ({
          ok: false,
          code: "fixture_contract_refused",
          issues: [
            { code: "fixture-contract", message: "Task membership is fixed" },
          ],
          instruction: "Amend the source contract",
        }),
      },
      rawBody: {
        expectedRevision: 3,
        operations: [
          {
            type: "move-task",
            taskId: "task-plan-1",
            contextId: "context-implement",
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: [
        expect.objectContaining({
          message: expect.stringContaining("Task membership is fixed"),
        }),
      ],
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects a malformed body at 400 without persisting", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 7 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: { operations: [] },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown definition", async () => {
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 1,
        operations: [{ type: "update-workflow", name: "x" }],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => null,
      persist: async () => ({}),
    });
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({
      error: "Workflow not found",
    });
  });

  it("returns 409 stale_workflow_definition when expectedRevision is stale", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 8 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 7,
        operations: [{ type: "update-workflow", name: "x" }],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      code: "stale_workflow_definition",
      expectedRevision: 7,
      currentRevision: 8,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns 400 with a locator-first issue for an invalid edit", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [{ type: "update-task", taskId: "missing", title: "x" }],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(400);
    const body = (await bodyOf(response)) as {
      issues: Array<{ path: string; message: string }>;
    };
    expect(body.issues[0]?.path).toBe("operations[0]");
    expect(body.issues[0]?.message).toContain("unknown-task-id");
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns a machine-readable 409 with amend-at-source guidance for a locked region", async () => {
    const record = createWorkflowDefinitionRecord({
      revision: 3,
      definition: createWorkflowDefinition({
        lockedRegions: [
          {
            paths: ["/tasks/task-plan-1/instructions"],
            sourceUri: "contract://plans/revision-7",
            reason: "Task instructions are contract-derived",
          },
        ],
      }),
    });
    const { persist } = persistSpy(record);

    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [
          {
            type: "update-task",
            taskId: "task-plan-1",
            instructions: "Weaken the contract downstream",
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });

    expect(response.status).toBe(409);
    await expect(bodyOf(response)).resolves.toMatchObject({
      code: "region_locked",
      instruction:
        "Amend at source contract://plans/revision-7 and recompile the workflow definition.",
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("applies a dry-run without persisting and reports the outcome", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        dryRun: true,
        operations: [
          {
            type: "update-task",
            taskId: "task-plan-1",
            title: "Renamed",
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      applied: 1,
      dryRun: true,
      item: { revision: 3 },
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects the entire batch when final launch admission fails", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [
          {
            type: "update-workflow",
            name: "Would otherwise persist",
          },
          {
            type: "update-task",
            taskId: "task-plan-1",
            instructions: "Would otherwise persist too.",
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      admitLaunch: async () => ({
        ok: false,
        issues: [
          {
            path: "definition.workflowConfig.implementer.profile",
            message: "The profile is unavailable.",
          },
        ],
      }),
      persist,
    });

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({
      code: "invalid_edit",
      issues: [
        expect.objectContaining({
          path: "workflowConfig.implementer.profile",
        }),
      ],
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists a valid edit and returns the applied count", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist, calls } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [
          {
            type: "update-task",
            taskId: "task-plan-1",
            instructions: "Do the new thing.",
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ applied: 1 });
    expect(persist).toHaveBeenCalledOnce();
    // The persisted draft carries the edited definition.
    const persistedTask = calls[0]?.definition.tasks.find(
      (t) => t.id === "task-plan-1",
    );
    expect(persistedTask?.instructions).toBe("Do the new thing.");
  });

  it("rejects an update-charter op whose fields are nested under a charter key instead of silently applying nothing", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [
          {
            type: "update-charter",
            charter: { mission: "Deliver the approved spec." },
          },
        ],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({
      error: "Invalid edit request",
      issues: [
        expect.objectContaining({
          path: "operations.0",
          message: expect.stringContaining("charter"),
        }),
      ],
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects an update-charter op that names no charter field", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: {
        expectedRevision: 3,
        operations: [{ type: "update-charter" }],
      },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
    });
    expect(response.status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("runDefinitionEditRequest receipt fields", () => {
  const rename = {
    expectedRevision: 3,
    operations: [{ type: "update-workflow", name: "Renamed" }],
  };

  it("merges the fields a persisted write reports beside item and applied", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const receiptFields = vi.fn(async () => ({
      proposeGate: { blockingBefore: 1, blockingAfter: 0 },
    }));

    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: rename,
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
      receiptFields,
    });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      item: { name: "Renamed", revision: 4 },
      applied: 1,
      proposeGate: { blockingBefore: 1, blockingAfter: 0 },
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(receiptFields).toHaveBeenCalledOnce();
  });

  it("never asks for receipt fields on a dry run", async () => {
    const record = createWorkflowDefinitionRecord({ revision: 3 });
    const { persist } = persistSpy(record);
    const receiptFields = vi.fn(async () => ({ proposeGate: {} }));

    const response = await runDefinitionEditRequest({
      executionContract: createTestGraphExecutionContract(),
      rawBody: { ...rename, dryRun: true },
      notFoundError: "Workflow not found",
      loadRecord: async () => record,
      persist,
      receiptFields,
    });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).not.toHaveProperty("proposeGate");
    expect(persist).not.toHaveBeenCalled();
    expect(receiptFields).not.toHaveBeenCalled();
  });
});
