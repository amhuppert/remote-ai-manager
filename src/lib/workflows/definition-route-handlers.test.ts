import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

// The POST bodies below are authored plans: create refuses the legacy source
// shapes makeTestCharter still carries (prose appliesTo, retired accessPolicy),
// so the authored requests override them with the authored shape.
function makeAuthoredCharter() {
  return makeTestCharter({
    sourcesOfTruth: [
      {
        rank: 1,
        id: "design-doc",
        label: "Approved design document",
        type: "document",
        locator: ".kiro/specs/workflow-charter/design.md",
        description: "The authoritative architecture for this workflow",
      },
    ],
  });
}
import { workflowDefinitionGetResponseSchema } from "@/lib/workflow-definitions/schemas";
import { createWorkflowDefinitionRouteHandlers } from "./definition-route-handlers";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
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
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      timeoutMs: null,
    },
  },
  defaultAgentBackend: "claude",
};

const OVERSIZED_REPO_CONFIG: PerRepoConfig = {
  validation: {
    commands: {
      test: {
        command: {
          full: "scripts/validate/test-full-suite.sh",
          changed: "scripts/validate/test.sh",
        },
        cost: 5,
        pathArgs: "paths",
      },
    },
    preMerge: ["test"],
  },
};

describe("workflow definition route handlers", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const readConfig = vi.fn<() => Promise<GlobalConfig>>();
  const readRepoConfig =
    vi.fn<(_projectPath: string) => Promise<PerRepoConfig | null>>();
  const listDefinitions = vi.fn();
  const getDefinition = vi.fn();
  const createDefinition = vi.fn();
  const updateDefinition = vi.fn();
  const deleteDefinition = vi.fn();

  const handlers = createWorkflowDefinitionRouteHandlers({
    resolveProjectPath,
    readConfig,
    readRepoConfig,
    listDefinitions,
    getDefinition,
    createDefinition,
    updateDefinition,
    deleteDefinition,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    readConfig.mockResolvedValue(MOCK_CONFIG);
    readRepoConfig.mockResolvedValue(null);
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
    const getPayload = await getResponse.json();
    expect(getPayload).toEqual({
      item: expectedRecord,
      resolved: expectedResolved,
    });
    expect(() =>
      workflowDefinitionGetResponseSchema.parse(getPayload),
    ).not.toThrow();

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

  it("rejects oversized validation selections before create or replace persistence", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    readRepoConfig.mockResolvedValue(OVERSIZED_REPO_CONFIG);
    readConfig.mockResolvedValue({
      ...MOCK_CONFIG,
      validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: { scriptValidator: { commands: ["test"] } },
    });
    const body = {
      name: "Oversized validation",
      definition,
      layout: createWorkflowLayout(),
    };

    const createResponse = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", body),
      makeContext({ name: "repo" }),
    );
    const updateResponse = await handlers.UPDATE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", body),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    for (const response of [createResponse, updateResponse]) {
      expect(response.status).toBe(400);
      const responseBody = (await response.json()) as {
        code?: string;
        issues: Array<{ path: string; message: string }>;
      };
      expect(responseBody.code).toBe("validation_cost_exceeds_limit");
      expect(responseBody.issues).toContainEqual(
        expect.objectContaining({
          path: "definition.workflowConfig.scriptValidator.commands.0",
          message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
        }),
      );
    }
    expect(createDefinition).not.toHaveBeenCalled();
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it("rejects an oversized selection introduced by a saved-definition edit", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    readRepoConfig.mockResolvedValue(OVERSIZED_REPO_CONFIG);
    readConfig.mockResolvedValue({
      ...MOCK_CONFIG,
      validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
    });
    getDefinition.mockResolvedValue(
      createWorkflowDefinitionRecord({ revision: 3 }),
    );

    const response = await handlers.EDIT(
      makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
        baseRevision: 3,
        operations: [
          {
            type: "update-workflow-config",
            scriptValidator: { commands: ["test"] },
          },
        ],
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as {
      code?: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(responseBody.code).toBe("validation_cost_exceeds_limit");
    expect(responseBody.issues).toContainEqual(
      expect.objectContaining({
        path: "workflowConfig.scriptValidator.commands.0",
        message: expect.stringMatching(
          /validation_cost_exceeds_limit.*cost 5.*limit 4.*lower-worker/,
        ),
      }),
    );
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it("retains the unknown-command code for a saved-definition edit", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    readRepoConfig.mockResolvedValue(OVERSIZED_REPO_CONFIG);
    readConfig.mockResolvedValue({
      ...MOCK_CONFIG,
      validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
    });
    getDefinition.mockResolvedValue(
      createWorkflowDefinitionRecord({ revision: 3 }),
    );

    const response = await handlers.EDIT(
      makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
        baseRevision: 3,
        operations: [
          {
            type: "update-workflow-config",
            scriptValidator: { commands: ["missing"] },
          },
          {
            type: "update-context",
            contextId: "context-implement",
            agentValidation: {
              implementer: { mode: "all", except: ["test"] },
            },
          },
        ],
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as {
      code?: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(responseBody.code).toBe("invalid_edit");
    expect(responseBody.issues).toContainEqual(
      expect.objectContaining({
        path: "workflowConfig.scriptValidator.commands.0",
        message: expect.stringMatching(
          /^unknown-validation-command — Unknown validation command "missing"/,
        ),
      }),
    );
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it("keeps each saved-definition edit command issue labeled by its own code", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    readRepoConfig.mockResolvedValue(OVERSIZED_REPO_CONFIG);
    readConfig.mockResolvedValue({
      ...MOCK_CONFIG,
      validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
    });
    getDefinition.mockResolvedValue(
      createWorkflowDefinitionRecord({ revision: 3 }),
    );

    const response = await handlers.EDIT(
      makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
        baseRevision: 3,
        operations: [
          {
            type: "update-workflow-config",
            scriptValidator: { commands: ["missing", "test"] },
          },
        ],
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as {
      code?: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(responseBody.code).toBe("validation_cost_exceeds_limit");
    expect(responseBody.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "workflowConfig.scriptValidator.commands.0",
          message: expect.stringMatching(
            /^unknown-validation-command — Unknown validation command "missing"/,
          ),
        }),
        expect.objectContaining({
          path: "workflowConfig.scriptValidator.commands.1",
          message: expect.stringMatching(
            /^validation_cost_exceeds_limit — Validation command "test" has configured cost 5/,
          ),
        }),
      ]),
    );
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
          charter: makeAuthoredCharter(),
          executionContexts: [
            {
              id: "context-plan",
              title: "Plan",
              acceptanceCriteria: "Plan is documented",
              placement: { lane: "plan", mode: "full" },
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

  it.each([
    [
      "no placement at all",
      { id: "context-plan", title: "Plan", acceptanceCriteria: "Documented" },
      "definition.executionContexts.0.placement",
    ],
    [
      "a lane name outside the lane-id charset",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "plan lane", mode: "full" },
      },
      "definition.executionContexts.0.placement.lane",
    ],
    [
      "a write-capable context on the reserved session lane",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "session", mode: "full" },
      },
      "definition.executionContexts.0.placement.lane",
    ],
    [
      "an owned path naming repository metadata",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "plan", mode: "owned", ownedPaths: [".git/config"] },
      },
      "definition.executionContexts.0.placement.ownedPaths.0",
    ],
    [
      "a read-only context with no output contract",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "session", mode: "readOnly" },
      },
      "definition.executionContexts.0.outputSchema",
    ],
  ])(
    "returns 400 from create when a context declares %s",
    async (_label, context, expectedPath) => {
      resolveProjectPath.mockResolvedValue("/repo");

      const response = await handlers.CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", {
          name: "Bad placement",
          definition: {
            schemaVersion: 1,
            workflowConfig: {},
            charter: makeAuthoredCharter(),
            executionContexts: [context],
            tasks: [],
            edges: [],
          },
          layout: createWorkflowLayout(),
        }),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        issues: Array<{ path: string; message: string }>;
      };
      expect(body.issues).toContainEqual(
        expect.objectContaining({ path: expectedPath }),
      );
      expect(createDefinition).not.toHaveBeenCalled();
    },
  );

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
