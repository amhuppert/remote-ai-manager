import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalConfig } from "@/lib/config/schemas";
import { createWorkflowStorageService } from "./storage";
import { createTemplateLibraryService } from "./template-library-service";
import {
  createRootIndependentWarningDefinition,
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { createTemplateLibraryRouteHandlers } from "./template-library-route-handlers";

const MOCK_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends: {
    claude: {
      modelSelection: { modelId: "opus", parameters: { effort: "high" } },
      timeoutMs: 3_600_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: { modelId: "composer-2.5", parameters: { fast: "true" } },
      timeoutMs: null,
    },
  },
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
    getExecutionContract: createTestGraphExecutionContract,
    resolveProjectPath: async (name) => (name === "repo" ? PROJECT_PATH : null),
    readConfig: async () => MOCK_CONFIG,
    list: (projectPath) => library.list(projectPath),
    listGlobal: () => storage.list({ kind: "global" }),
    createGlobal: (draft) => storage.create({ kind: "global" }, draft),
    getGlobal: (workflowId) => storage.get({ kind: "global" }, workflowId),
    updateGlobal: (workflowId, expectedRevision, draft) =>
      storage.update({ kind: "global" }, workflowId, expectedRevision, draft),
    deleteGlobal: (workflowId) =>
      storage.delete({ kind: "global" }, workflowId),
  });
}

function mutationBody(name: string, overrides = {}) {
  return {
    expectedRevision: 1,
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

  it("keeps global create, replace, and edit root-independent while preserving every context-independent warning", async () => {
    const handlers = realHandlers();
    const definition = createRootIndependentWarningDefinition();
    const plan = {
      expectedRevision: 1,
      name: "Global warning plan",
      description: "Root-independent global admission",
      definition,
      layout: createWorkflowLayout(),
    };

    const created = await handlers.CREATE(
      makeRequest("/api/workflow-templates", "POST", plan),
      makeContext({}),
    );
    const createdBody = (await created.json()) as {
      item: { id: string; revision: number };
      warnings?: { path: string; message: string }[];
    };
    const replaced = await handlers.UPDATE(
      makeRequest(
        `/api/workflow-templates/${createdBody.item.id}`,
        "PUT",
        plan,
      ),
      makeContext({ workflowId: createdBody.item.id }),
    );
    const replacedBody = (await replaced.json()) as {
      item: { revision: number };
      warnings?: { path: string; message: string }[];
    };
    const edited = await handlers.EDIT(
      makeRequest(
        `/api/workflow-templates/${createdBody.item.id}/edit`,
        "PATCH",
        {
          expectedRevision: replacedBody.item.revision,
          operations: [
            { type: "update-workflow", name: "Edited global warning plan" },
          ],
        },
      ),
      makeContext({ workflowId: createdBody.item.id }),
    );
    const editedBody = (await edited.json()) as {
      warnings?: { path: string; message: string }[];
    };

    for (const [response, body] of [
      [created, createdBody],
      [replaced, replacedBody],
      [edited, editedBody],
    ] as const) {
      expect(response.status).toBeLessThan(300);
      const warnings = body.warnings ?? [];
      const sourcePaths = warnings
        .filter((warning) =>
          warning.message.startsWith("lint/source-locator-unresolvable"),
        )
        .map((warning) => warning.path);
      expect(sourcePaths).toEqual([
        "definition.charter.sourcesOfTruth.1 (url).locator",
        "definition.charter.sourcesOfTruth.2 (absolute).locator",
        "definition.charter.sourcesOfTruth.3 (traversal).locator",
      ]);
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("lint/criteria-density"),
          }),
          expect.objectContaining({
            message: expect.stringContaining("lint/open-quantifier"),
          }),
          expect.objectContaining({
            message: expect.stringContaining("lint/oversized-prose"),
          }),
          expect.objectContaining({
            message: expect.stringContaining("no outgoing edge covers"),
          }),
        ]),
      );
    }
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

  // The global tier is the OTHER create/replace surface. It used to parse a
  // local copy of the mutation schema and let storage collapse every semantic
  // rejection into a comma-joined code string, which cannot say WHICH context or
  // WHICH keyword was wrong. Both tiers now share the plan validator, so an
  // author gets the same JSON-path locator either way (R1.2).
  it.each([
    ["CREATE", "POST"],
    ["UPDATE", "PUT"],
  ])(
    "%s refuses an unsupported outputSchema keyword with a JSON-path locator",
    async (handlerName, method) => {
      const handlers = realHandlers();
      const created = await handlers.CREATE(
        makeRequest("/api/workflow-templates", "POST", mutationBody("Seed")),
        makeContext({}),
      );
      const { item } = await created.json();

      const definition = createWorkflowDefinition();
      const [firstContext, ...restContexts] = definition.executionContexts;
      if (!firstContext) throw new Error("fixture missing context");
      const body = {
        expectedRevision: 1,
        name: "Bad Output Schema",
        description: "bad",
        definition: {
          ...definition,
          executionContexts: [
            {
              ...firstContext,
              outputSchema: {
                type: "object",
                properties: { verdict: { type: "string", format: "uri" } },
              },
            },
            ...restContexts,
          ],
        },
        layout: createWorkflowLayout(),
      };

      const response =
        handlerName === "CREATE"
          ? await handlers.CREATE(
              makeRequest("/api/workflow-templates", method, body),
              makeContext({}),
            )
          : await handlers.UPDATE(
              makeRequest(`/api/workflow-templates/${item.id}`, method, body),
              makeContext({ workflowId: item.id }),
            );

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            // Bracket-indexed, matching the `prerequisites[0]` locator the
            // other semantic validators already emit.
            path: "definition.executionContexts[0] (context-plan).outputSchema.properties.verdict.format",
            message: expect.stringContaining('Context "context-plan"'),
          }),
        ]),
      );
    },
  );

  it("accepts a global template whose outputSchema stays inside the supported subset", async () => {
    const handlers = realHandlers();
    const definition = createWorkflowDefinition();
    const [firstContext, ...restContexts] = definition.executionContexts;
    if (!firstContext) throw new Error("fixture missing context");
    const outputSchema = {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
    };

    const response = await handlers.CREATE(
      makeRequest("/api/workflow-templates", "POST", {
        name: "Good Output Schema",
        description: "good",
        definition: {
          ...definition,
          executionContexts: [
            { ...firstContext, outputSchema },
            ...restContexts,
          ],
        },
        layout: createWorkflowLayout(),
      }),
      makeContext({}),
    );

    expect(response.status).toBe(201);
    const { item } = await response.json();
    expect(item.definition.executionContexts[0].outputSchema).toEqual(
      outputSchema,
    );
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
