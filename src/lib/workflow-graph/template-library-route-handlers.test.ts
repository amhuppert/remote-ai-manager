import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalConfig } from "@/lib/config/schemas";
import { createWorkflowStorageService } from "./storage";
import { createTemplateLibraryService } from "./template-library-service";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { createTemplateLibraryRouteHandlers } from "./template-library-route-handlers";

const MOCK_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  claudeTimeoutMs: 3600000,
  defaultModel: "opus",
  defaultAgentBackend: "claude",
};

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

const PROJECT_PATH = "/repo";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-template-library-routes-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function realHandlers() {
  const storage = createWorkflowStorageService({
    resolveConfigDir: () => tempDir,
  });
  const library = createTemplateLibraryService({ storage });
  return createTemplateLibraryRouteHandlers({
    resolveProjectPath: async (name) => (name === "repo" ? PROJECT_PATH : null),
    readConfig: async () => MOCK_CONFIG,
    list: (projectPath) => library.list(projectPath),
    listGlobal: () => storage.list({ kind: "global" }),
    createGlobal: (draft) => storage.create({ kind: "global" }, draft),
    getGlobal: (workflowId) => storage.get({ kind: "global" }, workflowId),
    updateGlobal: (workflowId, draft) =>
      storage.update({ kind: "global" }, workflowId, draft),
    deleteGlobal: (workflowId) =>
      storage.delete({ kind: "global" }, workflowId),
  });
}

function mutationBody(name: string, overrides = {}) {
  return {
    name,
    description: `Description for ${name}`,
    definition: createWorkflowDefinition(overrides),
    layout: createWorkflowLayout(),
  };
}

describe("template library route handlers — cross-tier listing", () => {
  it("returns global AND project items, each tagged by tier", async () => {
    const handlers = realHandlers();
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    await storage.create(
      { kind: "global" },
      {
        name: "Global Template",
        description: "global",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
    );
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      {
        name: "Project Template",
        description: "project",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
    );

    const response = await handlers.LIST_TEMPLATES(
      makeRequest("/api/projects/repo/workflow-templates", "GET"),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ tier: string; name: string }>;
    };
    const byName = new Map(body.items.map((item) => [item.name, item.tier]));
    expect(byName.get("Global Template")).toBe("global");
    expect(byName.get("Project Template")).toBe("project");
    expect(body.items).toHaveLength(2);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const handlers = realHandlers();

    const response = await handlers.LIST_TEMPLATES(
      makeRequest("/api/projects/missing/workflow-templates", "GET"),
      makeContext({ name: "missing" }),
    );

    expect(response.status).toBe(404);
  });
});

describe("template library route handlers — global-tier listing", () => {
  it("lists only global templates, excluding project templates", async () => {
    const handlers = realHandlers();
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    await storage.create(
      { kind: "global" },
      {
        name: "Global A",
        description: "global",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
    );
    await storage.create(
      { kind: "project", projectPath: PROJECT_PATH },
      {
        name: "Project A",
        description: "project",
        definition: createWorkflowDefinition(),
        layout: createWorkflowLayout(),
      },
    );

    const response = await handlers.LIST_GLOBAL(
      makeRequest("/api/workflow-templates", "GET"),
      makeContext({}),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ name: string }>;
    };
    expect(body.items.map((item) => item.name)).toEqual(["Global A"]);
  });

  it("returns an empty list when no global templates exist", async () => {
    const handlers = realHandlers();

    const response = await handlers.LIST_GLOBAL(
      makeRequest("/api/workflow-templates", "GET"),
      makeContext({}),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
  });
});

describe("template library route handlers — global-tier CRUD", () => {
  it("GET returns the global template with its resolved definition", async () => {
    const handlers = realHandlers();

    const createResponse = await handlers.CREATE(
      makeRequest("/api/workflow-templates", "POST", mutationBody("Resolved")),
      makeContext({}),
    );
    const created = (await createResponse.json()) as { item: { id: string } };

    const getResponse = await handlers.GET(
      makeRequest(`/api/workflow-templates/${created.item.id}`, "GET"),
      makeContext({ workflowId: created.item.id }),
    );

    expect(getResponse.status).toBe(200);
    const fetched = (await getResponse.json()) as {
      item: { id: string };
      resolved?: { executionContexts: unknown[] };
    };
    expect(fetched.item.id).toBe(created.item.id);
    // The detail response carries a resolved definition so it satisfies the
    // same `workflowDefinitionGetResponseSchema` contract as the project GET.
    expect(fetched.resolved).toBeDefined();
    expect(Array.isArray(fetched.resolved?.executionContexts)).toBe(true);
  });

  it("round-trips a clean global template through create→get→update→delete", async () => {
    const handlers = realHandlers();

    const createResponse = await handlers.CREATE(
      makeRequest(
        "/api/workflow-templates",
        "POST",
        mutationBody("Methodology"),
      ),
      makeContext({}),
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      item: { id: string; name: string };
    };
    expect(created.item.name).toBe("Methodology");
    const { id } = created.item;

    const getResponse = await handlers.GET(
      makeRequest(`/api/workflow-templates/${id}`, "GET"),
      makeContext({ workflowId: id }),
    );
    expect(getResponse.status).toBe(200);
    const fetched = (await getResponse.json()) as {
      item: { id: string; revision: number };
    };
    expect(fetched.item.id).toBe(id);
    expect(fetched.item.revision).toBe(1);

    const updateResponse = await handlers.UPDATE(
      makeRequest(`/api/workflow-templates/${id}`, "PUT", {
        ...mutationBody("Methodology v2"),
      }),
      makeContext({ workflowId: id }),
    );
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as {
      item: { name: string; revision: number };
    };
    expect(updated.item.name).toBe("Methodology v2");
    expect(updated.item.revision).toBe(2);

    const deleteResponse = await handlers.DELETE(
      makeRequest(`/api/workflow-templates/${id}`, "DELETE"),
      makeContext({ workflowId: id }),
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const missingResponse = await handlers.GET(
      makeRequest(`/api/workflow-templates/${id}`, "GET"),
      makeContext({ workflowId: id }),
    );
    expect(missingResponse.status).toBe(404);
  });

  it("rejects a global template with an invalid prerequisite (accept-time validation, 400)", async () => {
    const handlers = realHandlers();

    const response = await handlers.CREATE(
      makeRequest(
        "/api/workflow-templates",
        "POST",
        mutationBody("Bad Prereq", {
          prerequisites: [{ kind: "path", path: "/etc/absolute" }],
        }),
      ),
      makeContext({}),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a global template with an invalid definition (missing acceptanceCriteria, 400)", async () => {
    const handlers = realHandlers();

    const definition = createWorkflowDefinition();
    const [firstContext, ...restContexts] = definition.executionContexts;
    if (!firstContext) throw new Error("fixture missing context");
    const { acceptanceCriteria: _omit, ...contextWithoutAC } = firstContext;

    const response = await handlers.CREATE(
      makeRequest("/api/workflow-templates", "POST", {
        name: "Bad Definition",
        description: "bad",
        definition: {
          ...definition,
          executionContexts: [contextWithoutAC, ...restContexts],
        },
        layout: createWorkflowLayout(),
      }),
      makeContext({}),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid request body", async () => {
    const handlers = realHandlers();

    const response = await handlers.CREATE(
      makeRequest("/api/workflow-templates", "POST", { name: "" }),
      makeContext({}),
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 for get/update/delete of an absent global template", async () => {
    const handlers = realHandlers();

    const getResponse = await handlers.GET(
      makeRequest("/api/workflow-templates/nope", "GET"),
      makeContext({ workflowId: "nope" }),
    );
    expect(getResponse.status).toBe(404);

    const updateResponse = await handlers.UPDATE(
      makeRequest("/api/workflow-templates/nope", "PUT", mutationBody("X")),
      makeContext({ workflowId: "nope" }),
    );
    expect(updateResponse.status).toBe(404);

    const deleteResponse = await handlers.DELETE(
      makeRequest("/api/workflow-templates/nope", "DELETE"),
      makeContext({ workflowId: "nope" }),
    );
    expect(deleteResponse.status).toBe(404);
  });
});
