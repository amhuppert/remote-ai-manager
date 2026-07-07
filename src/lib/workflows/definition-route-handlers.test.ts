import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { createWorkflowDefinitionRouteHandlers } from "./definition-route-handlers";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { GlobalConfig } from "@/lib/config/schemas";
function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

const MOCK_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  claudeTimeoutMs: 3600000,
  defaultModel: "opus",
  defaultAgentBackend: "claude",
};

describe("workflow definition route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const readConfig = vi.fn<() => Promise<GlobalConfig>>();
  const listDefinitions = vi.fn();
  const getDefinition = vi.fn();
  const createDefinition = vi.fn();
  const updateDefinition = vi.fn();
  const deleteDefinition = vi.fn();

  const handlers = createWorkflowDefinitionRouteHandlers({
    resolveProjectPath,
    readConfig,
    listDefinitions,
    getDefinition,
    createDefinition,
    updateDefinition,
    deleteDefinition,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    readConfig.mockResolvedValue(MOCK_CONFIG);
  });

  it("lists workflow definitions for a project", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    listDefinitions.mockResolvedValue([
      {
        id: "workflow-1",
        name: "Workflow One",
        description: "Stored workflow",
        revision: 1,
        createdAt: "2026-03-27T12:00:00.000Z",
        updatedAt: "2026-03-27T12:00:00.000Z",
      },
    ]);

    const response = await handlers.LIST(
      makeRequest("/api/projects/repo/workflows", "GET"),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: "workflow-1",
          name: "Workflow One",
          description: "Stored workflow",
          revision: 1,
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      ],
    });
  });

  it("creates a workflow definition", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    createDefinition.mockResolvedValue(createWorkflowDefinitionRecord());

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "Workflow Graph",
        description: "Create workflow",
        definition: createWorkflowDefinitionRecord().definition,
        layout: createWorkflowDefinitionRecord().layout,
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      item: {
        id: "workflow-1",
        name: "Workflow Graph Builder",
      },
    });
  });

  it("loads, updates, and deletes individual definitions", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    getDefinition.mockResolvedValue(createWorkflowDefinitionRecord());
    updateDefinition.mockResolvedValue(
      createWorkflowDefinitionRecord({
        revision: 2,
        name: "Updated Workflow",
      }),
    );
    deleteDefinition.mockResolvedValue(true);

    const getResponse = await handlers.GET(
      makeRequest("/api/projects/repo/workflows/workflow-1", "GET"),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
    expect(getResponse.status).toBe(200);
    const expectedRecord = createWorkflowDefinitionRecord();
    const expectedResolved = resolveWorkflowDefinition(
      MOCK_CONFIG,
      expectedRecord.definition,
    );
    await expect(getResponse.json()).resolves.toEqual({
      item: expectedRecord,
      resolved: expectedResolved,
    });

    const putResponse = await handlers.UPDATE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
        name: "Updated Workflow",
        description: "Updated",
        definition: createWorkflowDefinitionRecord().definition,
        layout: createWorkflowDefinitionRecord().layout,
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      item: {
        revision: 2,
        name: "Updated Workflow",
      },
    });

    const deleteResponse = await handlers.DELETE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "DELETE"),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });
  });

  it("returns 404 when the project cannot be resolved", async () => {
    resolveProjectPath.mockResolvedValue(null);

    const response = await handlers.LIST(
      makeRequest("/api/projects/missing/workflows", "GET"),
      makeContext({ name: "missing" }),
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 with the normalized {error, issues} shape for invalid create payloads", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "",
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
    // Byte-compatible with the validate route (validate-route-handlers.ts:80):
    // a stable error string + structured issues, never a flattened prose blob.
    const body = (await response.json()) as {
      error: string;
      issues: Array<{ path: string; message: string }>;
      code?: string;
    };
    expect(body.error).toBe("Workflow plan is invalid");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) {
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
    // No legacy flattened "Invalid request:" prose leaked into the error string.
    expect(body.error).not.toMatch(/Invalid request:/);
  });

  it("returns the same normalized {error, issues} shape for invalid replace (UPDATE) payloads", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.UPDATE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
        name: "",
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBe("Workflow plan is invalid");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it("accepts a POST with workflowConfig: {} and minimal contexts", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    createDefinition.mockResolvedValue(createWorkflowDefinitionRecord());

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "Minimal Workflow",
        definition: {
          schemaVersion: 1,
          workflowConfig: {},
          charter: makeTestCharter(),
          executionContexts: [
            {
              id: "context-plan",
              title: "Plan",
              acceptanceCriteria: "Plan is documented",
            },
          ],
          tasks: [],
          edges: [],
        },
        layout: createWorkflowLayout(),
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(201);
    expect(createDefinition).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when a context is missing acceptanceCriteria", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const definitionWithMissingAC = createWorkflowDefinition();
    const [firstContext, ...restContexts] =
      definitionWithMissingAC.executionContexts;
    if (!firstContext) throw new Error("fixture missing context");
    const { acceptanceCriteria: _omit, ...contextWithoutAC } = firstContext;

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "Missing AC",
        definition: {
          ...definitionWithMissingAC,
          executionContexts: [contextWithoutAC, ...restContexts],
        },
        layout: createWorkflowLayout(),
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(body.error).toBe("Workflow plan is invalid");
    // The field-level detail now lives in the structured issues, not the string.
    expect(
      body.issues.some(
        (issue) =>
          issue.path.includes("acceptanceCriteria") ||
          issue.message.includes("acceptanceCriteria"),
      ),
    ).toBe(true);
    expect(createDefinition).not.toHaveBeenCalled();
  });
});
