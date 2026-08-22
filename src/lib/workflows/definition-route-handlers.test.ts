import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { unreviewedPlanReviewLookup } from "@/lib/shared/testing/graph-plan-review-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphPlanReviewsRepo } from "@/lib/state-store/graph-plan-reviews-repo";
import { planDefinitionHash } from "./plan-review/schemas";
import {
  createPlanReviewService,
  type PlanReviewLookup,
  type PlanReviewStore,
} from "./plan-review/service";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowLayout,
  createRootIndependentWarningDefinition,
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
    cursor: { model: "composer-2.5", timeoutMs: null },
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
    planReviews: unreviewedPlanReviewLookup,
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

  it("keeps create, replace, and edit root-independent while preserving every context-independent warning", async () => {
    resolveProjectPath.mockResolvedValue("/canonical-checkout-without-sources");
    const definition = createRootIndependentWarningDefinition();
    const record = createWorkflowDefinitionRecord({
      revision: 3,
      definition,
    });
    getDefinition.mockResolvedValue(record);
    createDefinition.mockResolvedValue(record);
    updateDefinition.mockResolvedValue({ ...record, revision: 4 });
    const plan = {
      name: record.name,
      description: record.description,
      definition,
      layout: record.layout,
    };

    const responses = [
      await handlers.CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", plan),
        makeContext({ name: "repo" }),
      ),
      await handlers.UPDATE(
        makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", plan),
        makeContext({ name: "repo", workflowId: "workflow-1" }),
      ),
      await handlers.EDIT(
        makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
          baseRevision: 3,
          operations: [
            { type: "update-workflow", name: "Edited warning plan" },
          ],
        }),
        makeContext({ name: "repo", workflowId: "workflow-1" }),
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBeLessThan(300);
      const body = (await response.json()) as {
        warnings?: { path: string; message: string }[];
      };
      const warnings = body.warnings ?? [];
      const sourcePaths = warnings
        .filter((warning) =>
          warning.message.startsWith("lint/source-locator-unresolvable"),
        )
        .map((warning) => warning.path);
      expect(sourcePaths).toEqual([
        "definition.charter.sourcesOfTruth.1.locator",
        "definition.charter.sourcesOfTruth.2.locator",
        "definition.charter.sourcesOfTruth.3.locator",
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

  // A workflow role dispatches through the backend's task facet, so a plan
  // naming a backend that registers none is refused at admission — before any
  // definition is written (spec R15.2).
  it("refuses an assignment backend with no task facet, naming the facet, and writes nothing", async () => {
    resolveProjectPath.mockResolvedValue("/repo");

    const response = await handlers.CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", {
        name: "Cursor Workflow",
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
              implementer: {
                id: "implementer",
                profile: { tier: "builtin", id: "general-implementer" },
                agent: {
                  backend: "cursor",
                  model: "composer-2.5",
                  reasoningEffort: "medium",
                },
              },
            },
          ],
          tasks: [],
          edges: [],
        },
        layout: createWorkflowLayout(),
      }),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues?: { path: string; message: string }[];
    };
    expect(JSON.stringify(body)).toMatch(/task/i);
    expect(createDefinition).not.toHaveBeenCalled();
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

/**
 * The advisory review status create and replace report for the exact revision
 * they admitted (#69 change 5). The whole point of these tests is what does NOT
 * happen: nothing here may turn a successful save into a failure.
 */
describe("create/replace review advisory", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const readConfig = vi.fn<() => Promise<GlobalConfig>>();
  const readRepoConfig =
    vi.fn<(_projectPath: string) => Promise<PerRepoConfig | null>>();
  const createDefinition = vi.fn();
  const updateDefinition = vi.fn();

  let fixture: PersistenceFixture;

  function handlersWith(planReviews: PlanReviewLookup) {
    return createWorkflowDefinitionRouteHandlers({
      resolveProjectPath,
      readConfig,
      readRepoConfig,
      listDefinitions: vi.fn(),
      getDefinition: vi.fn(),
      createDefinition,
      updateDefinition,
      deleteDefinition: vi.fn(),
      planReviews,
    });
  }

  const record = createWorkflowDefinitionRecord();
  const planBody = {
    name: "Workflow Graph",
    description: "Create workflow",
    definition: record.definition,
    layout: record.layout,
  };

  /** The service over a real repository — the production read path. */
  function realLookup(): PlanReviewLookup {
    return createPlanReviewService(createGraphPlanReviewsRepo(fixture.db));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    readConfig.mockResolvedValue(MOCK_CONFIG);
    readRepoConfig.mockResolvedValue(null);
    resolveProjectPath.mockResolvedValue("/repo");
    createDefinition.mockResolvedValue(createWorkflowDefinitionRecord());
    updateDefinition.mockResolvedValue(createWorkflowDefinitionRecord());
    fixture = createPersistenceFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  /** Record a verdict against whatever hash the admitted plan actually gets. */
  function recordVerdictForAdmittedPlan(
    verdict: "approved" | "changes_requested",
  ): void {
    const hashed = planDefinitionHash(planBody);
    if (!hashed.ok) throw new Error("fixture plan does not validate");
    createPlanReviewService(
      createGraphPlanReviewsRepo(fixture.db),
    ).recordPlanReview({
      id: "review-1",
      definitionHash: hashed.hash,
      reviewerConversationId: "conv-reviewer-1",
      verdict,
      findings: verdict === "approved" ? null : "Split the second context.",
      reviewedAt: "2026-08-18T12:00:00.000Z",
    });
  }

  it("reports the recorded verdict for the exact admitted revision on create", async () => {
    recordVerdictForAdmittedPlan("approved");

    const response = await handlersWith(realLookup()).CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", planBody),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { reviewStatus?: unknown };
    expect(body.reviewStatus).toEqual({
      state: "approved",
      reviewerConversationId: "conv-reviewer-1",
      reviewedAt: "2026-08-18T12:00:00.000Z",
    });
  });

  it("reports the recorded verdict on replace", async () => {
    recordVerdictForAdmittedPlan("changes_requested");
    const hashed = planDefinitionHash(planBody);
    if (!hashed.ok) throw new Error("fixture plan does not validate");

    const response = await handlersWith(realLookup()).UPDATE(
      makeRequest("/api/projects/repo/workflows/wf-1", "PUT", {
        ...planBody,
        // The acknowledgement gate covers this exact revision; acknowledging it
        // is what leaves the VERDICT REPORTING this test is about observable.
        acknowledgeReviewHash: hashed.hash,
      }),
      makeContext({ name: "repo", workflowId: "wf-1" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reviewStatus?: { state?: string };
    };
    expect(body.reviewStatus?.state).toBe("changes_requested");
    expect(updateDefinition).toHaveBeenCalled();
  });

  it("still creates an unreviewed plan, reporting unreviewed", async () => {
    const response = await handlersWith(realLookup()).CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", planBody),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reviewStatus: { state: "unreviewed" },
    });
    expect(createDefinition).toHaveBeenCalled();
  });

  it("still replaces an unreviewed plan, reporting unreviewed", async () => {
    const response = await handlersWith(realLookup()).UPDATE(
      makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
      makeContext({ name: "repo", workflowId: "wf-1" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewStatus: { state: "unreviewed" },
    });
    expect(updateDefinition).toHaveBeenCalled();
  });

  it("fails open when the review REPOSITORY throws: the create succeeds, the failure is logged", async () => {
    const log = createCapturingLogger();
    const brokenStore: PlanReviewStore = {
      record: () => {},
      listByDefinitionHash: () => {
        throw new Error("graph_plan_reviews table is missing");
      },
    };

    const response = await handlersWith(
      createPlanReviewService(brokenStore, log),
    ).CREATE(
      makeRequest("/api/projects/repo/workflows", "POST", planBody),
      makeContext({ name: "repo" }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reviewStatus: { state: "unreviewed" },
    });
    const warned = log.entries.find(
      (entry) => entry.message === "workflows.plan-review.lookup_failed",
    );
    expect(warned?.level).toBe("warn");
    expect(warned?.fields["error"]).toContain("table is missing");
  });

  it("fails open when the LOOKUP itself throws: the replace still succeeds", async () => {
    const response = await handlersWith({
      findLatestTerminalReview: () => {
        throw new Error("review service unavailable");
      },
    }).UPDATE(
      makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
      makeContext({ name: "repo", workflowId: "wf-1" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewStatus: { state: "unreviewed" },
    });
    expect(updateDefinition).toHaveBeenCalled();
  });

  /**
   * The one operation shape review machinery blocks: re-submitting the EXACT
   * revision a changes-requested review rejected, without acknowledging it.
   * Every test here is paired with the case that must stay open, because the
   * gate's whole risk is widening past that one shape.
   */
  describe("acknowledgement gate", () => {
    /** The canonical hash the admitted plan actually gets. */
    function admittedHash(): string {
      const hashed = planDefinitionHash(planBody);
      if (!hashed.ok) throw new Error("fixture plan does not validate");
      return hashed.hash;
    }

    function acknowledged(hash: string) {
      return { ...planBody, acknowledgeReviewHash: hash };
    }

    async function refusalBodyOf(response: Response) {
      return (await response.json()) as {
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
      };
    }

    it("refuses an unacknowledged create of the rejected revision, before persisting", async () => {
      recordVerdictForAdmittedPlan("changes_requested");

      const response = await handlersWith(realLookup()).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", planBody),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(409);
      const body = await refusalBodyOf(response);
      expect(body.code).toBe("review-changes-requested-unacknowledged");
      expect(body.details).toEqual({
        definitionHash: admittedHash(),
        verdict: "changes_requested",
        reviewerConversationId: "conv-reviewer-1",
        reviewedAt: "2026-08-18T12:00:00.000Z",
        findingsCommand: "cctl workflow review --file <plan.json>",
      });
      expect(createDefinition).not.toHaveBeenCalled();
    });

    it("refuses an unacknowledged replace of the rejected revision", async () => {
      recordVerdictForAdmittedPlan("changes_requested");

      const response = await handlersWith(realLookup()).UPDATE(
        makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(response.status).toBe(409);
      expect((await refusalBodyOf(response)).code).toBe(
        "review-changes-requested-unacknowledged",
      );
      expect(updateDefinition).not.toHaveBeenCalled();
    });

    it("clears the gate on create when the acknowledgement equals the submitted revision, still reporting the advisory", async () => {
      recordVerdictForAdmittedPlan("changes_requested");

      const response = await handlersWith(realLookup()).CREATE(
        makeRequest(
          "/api/projects/repo/workflows",
          "POST",
          acknowledged(admittedHash()),
        ),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        reviewStatus: {
          state: "changes_requested",
          reviewerConversationId: "conv-reviewer-1",
        },
      });
      expect(createDefinition).toHaveBeenCalled();
    });

    it("clears the gate on replace when the acknowledgement matches", async () => {
      recordVerdictForAdmittedPlan("changes_requested");

      const response = await handlersWith(realLookup()).UPDATE(
        makeRequest(
          "/api/projects/repo/workflows/wf-1",
          "PUT",
          acknowledged(admittedHash()),
        ),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        reviewStatus: { state: "changes_requested" },
      });
      expect(updateDefinition).toHaveBeenCalled();
    });

    it("does not let an acknowledgement of a DIFFERENT revision through, and names the expected hash", async () => {
      recordVerdictForAdmittedPlan("changes_requested");

      const response = await handlersWith(realLookup()).CREATE(
        makeRequest(
          "/api/projects/repo/workflows",
          "POST",
          acknowledged(`sha256:${"ab".repeat(32)}`),
        ),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(409);
      const body = await refusalBodyOf(response);
      expect(body.details?.["definitionHash"]).toBe(admittedHash());
      expect(body.error).toContain(admittedHash());
      expect(createDefinition).not.toHaveBeenCalled();
    });

    it("never gates an APPROVED revision: create and replace succeed with no acknowledgement", async () => {
      recordVerdictForAdmittedPlan("approved");

      const created = await handlersWith(realLookup()).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", planBody),
        makeContext({ name: "repo" }),
      );
      const replaced = await handlersWith(realLookup()).UPDATE(
        makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(created.status).toBe(201);
      expect(replaced.status).toBe(200);
      expect(createDefinition).toHaveBeenCalled();
      expect(updateDefinition).toHaveBeenCalled();
    });

    it("never gates an UNREVIEWED revision: create and replace succeed with no acknowledgement", async () => {
      const created = await handlersWith(realLookup()).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", planBody),
        makeContext({ name: "repo" }),
      );
      const replaced = await handlersWith(realLookup()).UPDATE(
        makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(created.status).toBe(201);
      expect(replaced.status).toBe(200);
      expect(createDefinition).toHaveBeenCalled();
      expect(updateDefinition).toHaveBeenCalled();
    });

    it("skips the gate when the lookup fails: the create succeeds unreviewed and the failure is logged", async () => {
      const log = createCapturingLogger();
      const brokenStore: PlanReviewStore = {
        record: () => {},
        listByDefinitionHash: () => {
          throw new Error("graph_plan_reviews table is missing");
        },
      };

      const response = await handlersWith(
        createPlanReviewService(brokenStore, log),
      ).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", planBody),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        reviewStatus: { state: "unreviewed" },
      });
      expect(createDefinition).toHaveBeenCalled();
      expect(
        log.entries.find(
          (entry) => entry.message === "workflows.plan-review.lookup_failed",
        )?.level,
      ).toBe("warn");
    });

    it("skips the gate when the LOOKUP itself throws on replace", async () => {
      const response = await handlersWith({
        findLatestTerminalReview: () => {
          throw new Error("review service unavailable");
        },
      }).UPDATE(
        makeRequest("/api/projects/repo/workflows/wf-1", "PUT", planBody),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        reviewStatus: { state: "unreviewed" },
      });
      expect(updateDefinition).toHaveBeenCalled();
    });
  });

  /**
   * Admission has always produced warnings; create and replace used to drop
   * them on the floor, so an author who skipped `validate` never saw one.
   */
  describe("admission warnings", () => {
    /** A plan whose criteria trip the open-quantifier lint (#69 change 6). */
    const warnedPlanBody = {
      ...planBody,
      definition: {
        ...record.definition,
        executionContexts: record.definition.executionContexts.map(
          (context, index) =>
            index === 0
              ? {
                  ...context,
                  acceptanceCriteria: [
                    {
                      id: "ac-sweep",
                      statement: "Every call site is migrated",
                    },
                  ],
                }
              : context,
        ),
      },
    };

    it("returns the admission warnings on create", async () => {
      const response = await handlersWith(unreviewedPlanReviewLookup).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", warnedPlanBody),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        warnings?: { path: string; message: string }[];
      };
      expect(body.warnings).toContainEqual({
        path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
        message: expect.stringContaining("lint/open-quantifier"),
      });
      // Advisory to the last: the plan is still persisted.
      expect(createDefinition).toHaveBeenCalled();
    });

    it("returns the admission warnings on replace", async () => {
      const response = await handlersWith(unreviewedPlanReviewLookup).UPDATE(
        makeRequest("/api/projects/repo/workflows/wf-1", "PUT", warnedPlanBody),
        makeContext({ name: "repo", workflowId: "wf-1" }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        warnings?: { path: string; message: string }[];
      };
      expect(body.warnings).toContainEqual({
        path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
        message: expect.stringContaining("lint/open-quantifier"),
      });
      expect(updateDefinition).toHaveBeenCalled();
    });

    it("omits the key entirely when a plan warns about nothing", async () => {
      // A real project root with a charter locator that actually resolves in
      // it: the clean case has to be reachable, or "warnings" would be a field
      // every response carries and no author would read.
      resolveProjectPath.mockResolvedValue(process.cwd());
      const response = await handlersWith(unreviewedPlanReviewLookup).CREATE(
        makeRequest("/api/projects/repo/workflows", "POST", {
          ...planBody,
          definition: {
            ...record.definition,
            charter: makeTestCharter({
              sourcesOfTruth: [
                {
                  rank: 1,
                  id: "engineering-contract",
                  label: "Repository engineering contract",
                  type: "document",
                  locator: "AGENTS.md",
                  description: "The rules every context implements under",
                },
              ],
            }),
          },
        }),
        makeContext({ name: "repo" }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).not.toHaveProperty("warnings");
    });
  });
});
