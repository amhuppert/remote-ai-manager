import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowDefinitionRecord } from "./test-fixtures";
import { createWorkflowDefinitionRouteHandlers } from "./route-handlers";

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

describe("workflow definition route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const listDefinitions = vi.fn();
  const getDefinition = vi.fn();
  const createDefinition = vi.fn();
  const updateDefinition = vi.fn();
  const deleteDefinition = vi.fn();

  const handlers = createWorkflowDefinitionRouteHandlers({
    resolveProjectPath,
    listDefinitions,
    getDefinition,
    createDefinition,
    updateDefinition,
    deleteDefinition,
  });

  beforeEach(() => {
    vi.resetAllMocks();
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

  it("returns 400 for invalid create payloads", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "",
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
  });
});
