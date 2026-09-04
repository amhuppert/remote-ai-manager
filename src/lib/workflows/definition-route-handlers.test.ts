import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
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
import { WorkflowAssignmentReferenceError } from "@/lib/workflow-graph/assignment-references";
import {
  StaleWorkflowDefinitionError,
  type WorkflowDefinitionDraft,
} from "@/lib/workflow-graph/storage";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import {
  NATIVE_SDD_CLAIMS_SOURCE_ID,
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
} from "@/lib/specs/delivery-plan";
import {
  authoredDeliveryPlanSources,
  finalizeDeliveryPlanLaunch,
} from "@/lib/specs/delivery-plan-finalization";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

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
function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
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
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
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

function managedProjection(
  overrides: Partial<NativeSddWorkflowManagementDetail> = {},
): NativeSddWorkflowManagementDetail {
  return {
    kind: "native_sdd_delivery",
    specId: "spec-1",
    specSlug: "native-sdd",
    specName: "Native SDD",
    attemptId: "attempt-1",
    pinnedRevisionId: "revision-1",
    pinnedRevisionNumber: 1,
    lifecycle: "draft",
    editable: true,
    isCurrentDefinition: true,
    specHref: "/projects/repo/specs/native-sdd",
    builderHref: "/projects/repo/workflows?definition=workflow-1",
    executionHref: null,
    deltaBasisExecutionId: null,
    bindingRevision: 1,
    binding: { dispositions: [], claims: [] },
    dispositionCounts: {},
    unresolvedItems: [],
    criterionRows: [],
    claims: [],
    comments: [],
    nextAct: "propose",
    currentCandidate: null,
    currentCandidateHash: null,
    currentApproval: null,
    approvedBaseline: null,
    changes: {
      workflowSettings: false,
      contexts: false,
      tasks: false,
      edges: false,
      layout: false,
      dispositions: false,
      claims: false,
    },
    capabilities: {
      canPropose: true,
      canSignOff: false,
      canReopen: false,
      canAbandon: true,
      canLaunch: false,
      refusals: {},
    },
    ...overrides,
  };
}

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
        expectedRevision: 1,
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

  it("returns a typed conflict when a replace loses the definition revision race", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    updateDefinition.mockRejectedValue(
      new StaleWorkflowDefinitionError("workflow-1", 4, 5),
    );

    const response = await handlers.UPDATE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
        expectedRevision: 4,
        name: "Stale Workflow",
        description: "A concurrently edited workflow",
        definition: createWorkflowDefinitionRecord().definition,
        layout: createWorkflowDefinitionRecord().layout,
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_workflow_definition",
      workflowId: "workflow-1",
      expectedRevision: 4,
      currentRevision: 5,
      instruction: expect.stringContaining("Re-read"),
    });
  });

  it("projects managed ownership and refuses lifecycle-frozen mutations", async () => {
    resolveProjectPath.mockResolvedValue("/repo");
    const record = createWorkflowDefinitionRecord();
    getDefinition.mockResolvedValue(record);
    listDefinitions.mockResolvedValue([record]);
    const projection = managedProjection({
      lifecycle: "in_review",
      editable: false,
      capabilities: {
        canPropose: false,
        canSignOff: true,
        canReopen: true,
        canAbandon: true,
        canLaunch: false,
        refusals: {},
      },
    });
    const managedDefinitions = {
      list: async () => new Map([[record.id, projection]]),
      get: async () => projection,
      proposeBlockingCount: async () => null,
    };
    const managedHandlers = createWorkflowDefinitionRouteHandlers({
      resolveProjectPath,
      readConfig,
      readRepoConfig,
      listDefinitions,
      getDefinition,
      createDefinition,
      updateDefinition,
      deleteDefinition,
      planReviews: unreviewedPlanReviewLookup,
      managedDefinitions,
    });

    const listResponse = await managedHandlers.LIST(
      makeRequest("/api/projects/repo/workflows", "GET"),
      makeContext({ name: "repo" }),
    );
    expect(await listResponse.json()).toMatchObject({
      items: [{ management: { lifecycle: "in_review", editable: false } }],
    });

    const updateResponse = await managedHandlers.UPDATE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
        expectedRevision: 1,
        name: record.name,
        description: record.description,
        definition: record.definition,
        layout: record.layout,
      }),
      makeContext({ name: "repo", workflowId: record.id }),
    );
    const editResponse = await managedHandlers.EDIT(
      makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
        expectedRevision: 1,
        operations: [{ type: "update-workflow", name: "Blocked" }],
      }),
      makeContext({ name: "repo", workflowId: record.id }),
    );
    const deleteResponse = await managedHandlers.DELETE(
      makeRequest("/api/projects/repo/workflows/workflow-1", "DELETE"),
      makeContext({ name: "repo", workflowId: record.id }),
    );

    await expect(updateResponse.json()).resolves.toMatchObject({
      code: "managed_workflow_definition_read_only",
      instruction: expect.stringContaining("Reopen"),
    });
    await expect(editResponse.json()).resolves.toMatchObject({
      code: "managed_workflow_definition_read_only",
    });
    await expect(deleteResponse.json()).resolves.toMatchObject({
      code: "managed_workflow_definition",
      instruction: expect.stringContaining("Abandon"),
    });
    expect(updateDefinition).not.toHaveBeenCalled();
    expect(deleteDefinition).not.toHaveBeenCalled();
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
        expectedRevision: 1,
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
      makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
        ...body,
        expectedRevision: 1,
      }),
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
        expectedRevision: 3,
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
        expectedRevision: 3,
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
        expectedRevision: 3,
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
        makeRequest("/api/projects/repo/workflows/workflow-1", "PUT", {
          ...plan,
          expectedRevision: 1,
        }),
        makeContext({ name: "repo", workflowId: "workflow-1" }),
      ),
      await handlers.EDIT(
        makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
          expectedRevision: 3,
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
                  modelSelection: {
                    modelId: "composer-2.5",
                    parameters: { fast: "true" },
                  },
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
      "definition.executionContexts.0 (context-plan).placement",
    ],
    [
      "a lane name outside the lane-id charset",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "plan lane", mode: "full" },
      },
      "definition.executionContexts.0 (context-plan).placement.lane",
    ],
    [
      "a write-capable context on the reserved session lane",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "session", mode: "full" },
      },
      "definition.executionContexts.0 (context-plan).placement.lane",
    ],
    [
      "an owned path naming repository metadata",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "plan", mode: "owned", ownedPaths: [".git/config"] },
      },
      "definition.executionContexts.0 (context-plan).placement.ownedPaths.0",
    ],
    [
      "a read-only context with no output contract",
      {
        id: "context-plan",
        title: "Plan",
        acceptanceCriteria: "Documented",
        placement: { lane: "session", mode: "readOnly" },
      },
      "definition.executionContexts.0 (context-plan).outputSchema",
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
    expectedRevision: 1,
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
        path: "definition.executionContexts.0 (context-plan).acceptanceCriteria.0 (ac-sweep).statement",
        message: expect.stringContaining("lint/open-quantifier"),
        recordId: "ac-sweep",
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
        path: "definition.executionContexts.0 (context-plan).acceptanceCriteria.0 (ac-sweep).statement",
        message: expect.stringContaining("lint/open-quantifier"),
        recordId: "ac-sweep",
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

describe("managed draft replace (one write path)", () => {
  const SOURCE_URI =
    "spec-plan://spec-1/revisions/revision-1/attempts/attempt-1/candidates/workflow-1";
  const DRAFT_WHY =
    "provenance and approval policy are stamped by the server so a signed candidate can prove where it came from";
  const CANDIDATE_WHY =
    "the signed candidate is immutable so sign-off approves exact bytes";

  /** The stored shape `spec plan open` leaves: injected sources, provenance lock, origin. */
  function storedDraft(): WorkflowDefinitionRecord {
    const record = createWorkflowDefinitionRecord();
    const finalized = finalizeDeliveryPlanLaunch({
      specId: "spec-1",
      specSlug: "native-sdd",
      pinnedRevisionId: "revision-1",
      attemptId: "attempt-1",
      candidateId: record.id,
      launch: {
        name: record.name,
        description: record.description,
        definition: record.definition,
        layout: record.layout,
      },
      stage: "draft",
    });
    return createWorkflowDefinitionRecord({ ...finalized });
  }

  /** What a planner authors: no server-owned fields, no injected sources. */
  function barePlan(record: WorkflowDefinitionRecord, expectedRevision = 1) {
    const {
      origin: _origin,
      approvalRequired: _approvalRequired,
      lockedRegions: _lockedRegions,
      ...definition
    } = record.definition;
    return {
      expectedRevision,
      name: record.name,
      description: record.description,
      definition: {
        ...definition,
        charter: {
          ...definition.charter,
          sourcesOfTruth: authoredDeliveryPlanSources(
            definition.charter.sourcesOfTruth,
          ),
        },
      },
      layout: record.layout,
    };
  }

  function draftStore(initial: WorkflowDefinitionRecord) {
    let stored = initial;
    return {
      read: () => stored,
      getDefinition: async () => stored,
      updateDefinition: vi.fn(
        async (
          _projectPath: string,
          _workflowId: string,
          expectedRevision: number,
          draft: WorkflowDefinitionDraft,
        ) => {
          stored = { ...stored, ...draft, revision: expectedRevision + 1 };
          return stored;
        },
      ),
    };
  }

  /**
   * A propose-gate reader that answers the given counts in order and records
   * the stored revision at each read, so a test can prove the before read
   * preceded the write and the after read followed it.
   */
  function gateReads(
    store: ReturnType<typeof draftStore>,
    ...counts: Array<number | null>
  ) {
    const revisionsAtRead: number[] = [];
    const pending = [...counts];
    return {
      revisionsAtRead,
      proposeBlockingCount: async () => {
        revisionsAtRead.push(store.read().revision);
        return pending.shift() ?? null;
      },
    };
  }

  function managedHandlers(
    store: ReturnType<typeof draftStore>,
    projection: NativeSddWorkflowManagementDetail | null = managedProjection(),
    gate: ReturnType<typeof gateReads> = gateReads(store, 0, 0),
    log?: CapturingLogger,
  ) {
    return createWorkflowDefinitionRouteHandlers({
      ...(log === undefined ? {} : { log }),
      resolveProjectPath: async () => "/repo",
      readConfig: async () => MOCK_CONFIG,
      readRepoConfig: async () => null,
      listDefinitions: async () => [],
      getDefinition: store.getDefinition,
      createDefinition: vi.fn(),
      updateDefinition: store.updateDefinition,
      deleteDefinition: vi.fn(),
      planReviews: unreviewedPlanReviewLookup,
      managedDefinitions: {
        list: async () => new Map(),
        get: async () => projection,
        proposeBlockingCount: gate.proposeBlockingCount,
      },
    });
  }

  function put(
    handlers: ReturnType<typeof managedHandlers>,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return handlers.UPDATE(
      makeRequest(
        "/api/projects/repo/workflows/workflow-1",
        "PUT",
        body,
        headers,
      ),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
  }

  function patch(handlers: ReturnType<typeof managedHandlers>, body: unknown) {
    return handlers.EDIT(
      makeRequest(
        "/api/projects/repo/workflows/workflow-1/edit",
        "PATCH",
        body,
      ),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
  }

  const RENAME_OPS = {
    expectedRevision: 1,
    operations: [{ type: "update-workflow", name: "Renamed" }],
  };

  it("accepts a bare plan and keeps the stored origin, approvalRequired and lockedRegions", async () => {
    const record = storedDraft();
    const store = draftStore(record);
    const handlers = managedHandlers(store);
    const plan = barePlan(record);

    const response = await put(handlers, plan);

    expect(response.status).toBe(200);
    expect(store.read().definition.origin).toEqual(record.definition.origin);
    expect(store.read().definition.approvalRequired).toBe(
      record.definition.approvalRequired,
    );
    expect(store.read().definition.lockedRegions).toEqual(
      record.definition.lockedRegions,
    );
    // The authored sources are stored as submitted: nothing re-injected here.
    expect(store.read().definition.charter.sourcesOfTruth).toEqual(
      plan.definition.charter.sourcesOfTruth,
    );

    const reread = await handlers.GET(
      makeRequest("/api/projects/repo/workflows/workflow-1", "GET"),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );
    expect(await reread.json()).toMatchObject({
      item: {
        revision: 2,
        definition: {
          origin: { sourceUri: SOURCE_URI },
          approvalRequired: false,
          lockedRegions: record.definition.lockedRegions,
        },
      },
    });
  });

  it("accepts a plan whose server-owned fields equal the stored values", async () => {
    const record = storedDraft();
    const store = draftStore(record);

    const response = await put(managedHandlers(store), {
      expectedRevision: 1,
      name: record.name,
      description: record.description,
      definition: record.definition,
      layout: record.layout,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("code");
    expect(store.updateDefinition).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["/origin", { origin: { sourceUri: "spec-plan://elsewhere" } }],
    ["/approvalRequired", { approvalRequired: true }],
    ["/lockedRegions", { lockedRegions: [] }],
  ])(
    "refuses a present-and-different %s by path with the omit instruction and its why-line",
    async (lockedPath, different) => {
      const record = storedDraft();
      const store = draftStore(record);
      const plan = barePlan(record);

      const response = await put(managedHandlers(store), {
        ...plan,
        definition: { ...plan.definition, ...different },
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "region_locked",
        lockedPath,
        instruction: `${lockedPath} is server-owned; omit it from your plan.`,
        rationale: DRAFT_WHY,
      });
      expect(store.updateDefinition).not.toHaveBeenCalled();
    },
  );

  it("refuses replace and edit on a proposed candidate with the reopen instruction and its why-line", async () => {
    const record = storedDraft();
    const store = draftStore(record);
    const handlers = managedHandlers(
      store,
      managedProjection({ lifecycle: "in_review", editable: false }),
    );

    const replaceResponse = await put(handlers, barePlan(record));
    const editResponse = await handlers.EDIT(
      makeRequest("/api/projects/repo/workflows/workflow-1/edit", "PATCH", {
        expectedRevision: 1,
        operations: [{ type: "update-workflow", name: "Blocked" }],
      }),
      makeContext({ name: "repo", workflowId: "workflow-1" }),
    );

    for (const response of [replaceResponse, editResponse]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "managed_workflow_definition_read_only",
        instruction:
          "Reopen the delivery plan before editing its workflow definition.",
        rationale: CANDIDATE_WHY,
      });
    }
    expect(store.updateDefinition).not.toHaveBeenCalled();
  });

  // #80 design 3.10: planning-phase friction has to leave telemetry, or the
  // next retrospective can count planning cost only by tallying tool calls in
  // a transcript.
  describe("planning telemetry", () => {
    /** The header a `cctl` shell running inside a conversation stamps on a write. */
    const PLANNER = { "x-cc-conversation-id": "conv-planner" };

    function eventsNamed(log: CapturingLogger, event: string) {
      return log.entries.filter((entry) => entry.message === event);
    }

    it("names the server-owned paths a bare plan's merge filled", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();

      const response = await put(
        managedHandlers(
          store,
          managedProjection(),
          gateReads(store, 0, 0),
          log,
        ),
        barePlan(record),
        PLANNER,
      );

      expect(response.status).toBe(200);
      expect(eventsNamed(log, "workflow.replace.server_fields_merged")).toEqual(
        [
          {
            level: "info",
            message: "workflow.replace.server_fields_merged",
            fields: {
              definitionId: "workflow-1",
              fields: ["/origin", "/approvalRequired", "/lockedRegions"],
              conversationId: "conv-planner",
            },
          },
        ],
      );
    });

    it("emits no merge event when the plan already carried every server-owned field", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();

      const response = await put(
        managedHandlers(
          store,
          managedProjection(),
          gateReads(store, 0, 0),
          log,
        ),
        {
          expectedRevision: 1,
          name: record.name,
          description: record.description,
          definition: record.definition,
          layout: record.layout,
        },
      );

      expect(response.status).toBe(200);
      expect(eventsNamed(log, "workflow.replace.server_fields_merged")).toEqual(
        [],
      );
    });

    it("emits workflow.validate.refused for a region_locked replace", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const plan = barePlan(record);
      const log = createCapturingLogger();

      const response = await put(
        managedHandlers(
          store,
          managedProjection(),
          gateReads(store, 0, 0),
          log,
        ),
        {
          ...plan,
          definition: { ...plan.definition, approvalRequired: true },
        },
        PLANNER,
      );

      expect(response.status).toBe(409);
      expect(eventsNamed(log, "workflow.validate.refused")).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "region_locked",
            definitionId: "workflow-1",
            conversationId: "conv-planner",
          },
        },
      ]);
      // A refused write filled nothing, so it reports no merge.
      expect(eventsNamed(log, "workflow.replace.server_fields_merged")).toEqual(
        [],
      );
    });

    it("reports no merge when the write is lost to a stale token", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();
      const handlers = managedHandlers(
        store,
        managedProjection(),
        gateReads(store, 0, 0),
        log,
      );
      store.updateDefinition.mockImplementation(() => {
        throw new StaleWorkflowDefinitionError("workflow-1", 1, 2);
      });

      expect((await put(handlers, barePlan(record))).status).toBe(409);
      expect(eventsNamed(log, "workflow.replace.server_fields_merged")).toEqual(
        [],
      );
    });

    it("emits workflow.validate.refused when the candidate is read-only", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();

      const response = await put(
        managedHandlers(
          store,
          managedProjection({ lifecycle: "in_review", editable: false }),
          gateReads(store, 0, 0),
          log,
        ),
        barePlan(record),
        PLANNER,
      );

      expect(response.status).toBe(409);
      expect(eventsNamed(log, "workflow.validate.refused")).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "managed_workflow_definition_read_only",
            definitionId: "workflow-1",
            conversationId: "conv-planner",
          },
        },
      ]);
    });

    it("emits workflow.validate.refused when the compare-and-swap token is stale", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();
      const handlers = managedHandlers(
        store,
        managedProjection(),
        gateReads(store, 0, 0),
        log,
      );
      store.updateDefinition.mockImplementation(() => {
        throw new StaleWorkflowDefinitionError("workflow-1", 1, 2);
      });

      const response = await put(handlers, barePlan(record), PLANNER);

      expect(response.status).toBe(409);
      expect(eventsNamed(log, "workflow.validate.refused")).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "stale_workflow_definition",
            definitionId: "workflow-1",
            conversationId: "conv-planner",
          },
        },
      ]);
    });

    it("emits one refusal event per issue code when the plan is invalid", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();
      const plan = barePlan(record);

      const response = await put(
        managedHandlers(
          store,
          managedProjection(),
          gateReads(store, 0, 0),
          log,
        ),
        {
          ...plan,
          definition: { ...plan.definition, executionContexts: [], tasks: [] },
        },
        PLANNER,
      );

      expect(response.status).toBe(400);
      const refusals = eventsNamed(log, "workflow.validate.refused");
      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.fields).toMatchObject({
        code: "invalid_plan",
        definitionId: "workflow-1",
        conversationId: "conv-planner",
      });
    });

    it("records a null conversation rather than dropping the field for a caller with none", async () => {
      // The workflow definition routes carry no conversationId path segment,
      // so a browser caller has no conversation anywhere to read; the field is
      // still emitted, because a retrospective grouping by it must see the
      // uncounted callers rather than lose them.
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();

      const response = await put(
        managedHandlers(
          store,
          managedProjection({ lifecycle: "in_review", editable: false }),
          gateReads(store, 0, 0),
          log,
        ),
        barePlan(record),
      );

      expect(response.status).toBe(409);
      expect(eventsNamed(log, "workflow.validate.refused")[0]?.fields).toEqual({
        code: "managed_workflow_definition_read_only",
        definitionId: "workflow-1",
        conversationId: null,
      });
    });

    it("keeps the record an accept-time assignment refusal located", async () => {
      // Validate admits a reference that storage then refuses (a profile
      // deleted between the two). Its issues are located, so the refusal event
      // must carry the record rather than degrade to the bare code.
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();
      const handlers = managedHandlers(
        store,
        managedProjection(),
        gateReads(store, 0, 0),
        log,
      );
      store.updateDefinition.mockImplementation(() => {
        throw new WorkflowAssignmentReferenceError([
          {
            path: "definition.executionContexts.0 (ctx-a).contextValidator.assignments.0 (security).profile",
            message: "Agent profile global:never-created was not found.",
            recordId: "security",
          },
        ]);
      });

      const response = await put(handlers, barePlan(record), PLANNER);

      expect(response.status).toBe(400);
      expect(eventsNamed(log, "workflow.validate.refused")).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "workflow_assignment_reference_invalid",
            recordId: "security",
            definitionId: "workflow-1",
            conversationId: "conv-planner",
          },
        },
      ]);
    });

    it("does not count an edit or a delete as validate/create/replace friction", async () => {
      // The catalogued event names three surfaces. Counting the other managed
      // refusals under the same name would inflate exactly the tally the
      // retrospective reads.
      const record = storedDraft();
      const store = draftStore(record);
      const log = createCapturingLogger();
      const handlers = managedHandlers(
        store,
        managedProjection({ lifecycle: "in_review", editable: false }),
        gateReads(store, 0, 0),
        log,
      );

      expect((await patch(handlers, RENAME_OPS)).status).toBe(409);
      expect(
        (
          await handlers.DELETE(
            makeRequest("/api/projects/repo/workflows/workflow-1", "DELETE"),
            makeContext({ name: "repo", workflowId: "workflow-1" }),
          )
        ).status,
      ).toBe(409);
      expect(eventsNamed(log, "workflow.validate.refused")).toEqual([]);
    });
  });

  it("stores the submitted plan's edge ids unchanged", async () => {
    const record = storedDraft();
    const store = draftStore(record);
    const plan = barePlan(record);
    const edges = [
      {
        id: "edge-plan-to-implement",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
      {
        id: "edge-implement-to-verify",
        sourceContextId: "context-implement",
        targetContextId: "context-verify",
      },
    ];

    const response = await put(managedHandlers(store), {
      ...plan,
      definition: { ...plan.definition, edges },
    });

    expect(response.status).toBe(200);
    expect(store.read().definition.edges).toEqual(edges);
  });

  it("stores each injected source id at most once when the plan carries them", async () => {
    const record = storedDraft();
    const store = draftStore(record);
    const pinned = record.definition.charter.sourcesOfTruth.find(
      (source) => source.id === NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
    );
    if (pinned === undefined) throw new Error("fixture lacks the pinned spec");
    const plan = barePlan(record);

    const response = await put(managedHandlers(store), {
      ...plan,
      definition: {
        ...plan.definition,
        charter: {
          ...plan.definition.charter,
          // A round-tripped `get --full` carries the pair; a second copy of
          // one of them at a free rank is what a planner's merge can produce.
          sourcesOfTruth: [
            ...record.definition.charter.sourcesOfTruth,
            { ...pinned, rank: 9 },
          ],
        },
      },
    });

    expect(response.status).toBe(200);
    const storedIds = store
      .read()
      .definition.charter.sourcesOfTruth.map((source) => source.id);
    expect(
      storedIds.filter((id) => id === NATIVE_SDD_PINNED_SPEC_SOURCE_ID),
    ).toHaveLength(1);
    expect(
      storedIds.filter((id) => id === NATIVE_SDD_CLAIMS_SOURCE_ID),
    ).toHaveLength(1);
    expect(storedIds).toContain("design-doc");
  });

  describe("propose-gate receipt", () => {
    it("reports the propose gate a replace moved, read before and after the write", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const gate = gateReads(store, 2, 1);

      const response = await put(
        managedHandlers(store, managedProjection(), gate),
        barePlan(record),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        item: { revision: 2, management: { specSlug: "native-sdd" } },
        proposeGate: { blockingBefore: 2, blockingAfter: 1 },
      });
      expect(gate.revisionsAtRead).toEqual([1, 2]);
    });

    it("reports the propose gate a persisted edit moved and carries management on its item", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const gate = gateReads(store, 1, 0);

      const response = await patch(
        managedHandlers(store, managedProjection(), gate),
        RENAME_OPS,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        item: {
          name: "Renamed",
          revision: 2,
          management: { specSlug: "native-sdd", lifecycle: "draft" },
        },
        applied: 1,
        proposeGate: { blockingBefore: 1, blockingAfter: 0 },
      });
      expect(gate.revisionsAtRead).toEqual([1, 2]);
    });

    it("reads no gate and reports none on a dry-run edit", async () => {
      const record = storedDraft();
      const store = draftStore(record);
      const gate = gateReads(store, 1, 0);

      const response = await patch(
        managedHandlers(store, managedProjection(), gate),
        { ...RENAME_OPS, dryRun: true },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ dryRun: true });
      expect(body).not.toHaveProperty("proposeGate");
      expect(gate.revisionsAtRead).toEqual([]);
    });

    it("omits the gate but keeps management when the projection cannot be read", async () => {
      const record = storedDraft();
      const store = draftStore(record);

      const response = await put(
        managedHandlers(store, managedProjection(), gateReads(store, null, 1)),
        barePlan(record),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        item: { management: { specSlug: "native-sdd" } },
      });
      expect(body).not.toHaveProperty("proposeGate");
    });

    it("reads no gate and reports none on an unmanaged definition", async () => {
      const record = createWorkflowDefinitionRecord();
      const store = draftStore(record);
      const gate = gateReads(store, 1, 0);
      const handlers = managedHandlers(store, null, gate);

      const replaced = await put(handlers, {
        expectedRevision: 1,
        name: record.name,
        description: record.description,
        definition: record.definition,
        layout: record.layout,
      });
      const edited = await patch(handlers, {
        ...RENAME_OPS,
        expectedRevision: 2,
      });

      expect(replaced.status).toBe(200);
      expect(edited.status).toBe(200);
      expect(await replaced.json()).not.toHaveProperty("proposeGate");
      expect(await edited.json()).not.toHaveProperty("proposeGate");
      expect(gate.revisionsAtRead).toEqual([]);
    });
  });
});
