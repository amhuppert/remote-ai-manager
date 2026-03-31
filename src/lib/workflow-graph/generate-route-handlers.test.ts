import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { createWorkflowGenerateRouteHandlers } from "./generate-route-handlers";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/workflows/generate",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

describe("workflow graph generate route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const generateDraft = vi.fn();

  const handlers = createWorkflowGenerateRouteHandlers({
    resolveProjectPath,
    generateDraft,
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a generated draft for a valid request", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    generateDraft.mockResolvedValue({
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
      validationErrors: [],
    });

    const response = await handlers.POST(
      makeRequest({
        objective: "Create a workflow draft",
        references: [],
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      definition: {
        executionContexts: expect.any(Array),
      },
      validationErrors: [],
    });
  });

  it("returns 400 for an invalid planning request", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.POST(
      makeRequest({
        objective: "",
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when the project is missing", async () => {
    resolveProjectPath.mockResolvedValue(null);

    const response = await handlers.POST(
      makeRequest({
        objective: "Create a workflow draft",
        references: [],
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(404);
  });
});
