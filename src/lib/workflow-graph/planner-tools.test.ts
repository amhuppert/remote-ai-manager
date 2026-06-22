import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecutionEvent,
  WorkflowDefinitionRecord,
} from "@/lib/workflows/schemas";
import { registerPlannerTools, type PlannerToolDeps } from "./planner-tools";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { computeCharterHash } from "./charter/render";
import { validateAuthoredDefinition } from "./validation";
import type {
  ParameterDeclaration,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";

const TOOLS_KEY = "__test_planner_tools";
type ToolHandler = (args: unknown) => Promise<unknown>;

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[TOOLS_KEY]) {
    globalState[TOOLS_KEY] = new Map();
  }

  return globalState[TOOLS_KEY] as Map<
    string,
    { name: string; handler: ToolHandler }
  >;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function registerTools(deps: PlannerToolDeps): void {
  registerPlannerTools(
    createCapturingServer() as never,
    { projectPath: "/test", sessionName: "test-session" },
    deps,
  );
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }
  return tool.handler;
}

const MOCK_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  claudeTimeoutMs: 3600000,
  defaultModel: "opus",
  defaultAgentBackend: "claude",
};

function createMockDeps(
  overrides: Partial<PlannerToolDeps> = {},
): PlannerToolDeps {
  return {
    readConfig: vi.fn(async () => MOCK_CONFIG),
    listWorkflows: vi.fn(async () => []),
    getWorkflow: vi.fn(async () => null),
    createWorkflow: vi.fn(async (_projectPath, draft) => ({
      id: "wf-test-1",
      name: draft.name,
      description: draft.description,
      schemaVersion: 1,
      revision: 1,
      definition: draft.definition,
      layout: draft.layout,
      createdAt: "2026-03-30T00:00:00.000Z",
      updatedAt: "2026-03-30T00:00:00.000Z",
    })),
    updateWorkflow: vi.fn(async (_projectPath, _workflowId, draft) => ({
      id: "wf-test-1",
      name: draft.name,
      description: draft.description,
      schemaVersion: 1,
      revision: 2,
      definition: draft.definition,
      layout: draft.layout,
      createdAt: "2026-03-30T00:00:00.000Z",
      updatedAt: "2026-03-30T01:00:00.000Z",
    })),
    deleteWorkflow: vi.fn(async () => true),
    getActiveExecution: vi.fn(async () => null),
    publishCharterUpdated: vi.fn(() => []),
    ...overrides,
  };
}

const MINIMAL_INPUT = {
  name: "Add OAuth2",
  description: "Add OAuth2 support to the API",
  charter: makeTestCharter(),
  executionContexts: [
    {
      id: "auth-setup",
      title: "Authentication Setup",
      acceptanceCriteria: "OAuth2 middleware is in place and verified.",
    },
  ],
  tasks: [
    {
      id: "create-auth-middleware",
      contextId: "auth-setup",
      title: "Create auth middleware",
      instructions:
        "Create Express middleware that validates OAuth2 bearer tokens. Add to src/middleware/auth.ts. Verify with a unit test.",
    },
    {
      id: "add-token-refresh",
      contextId: "auth-setup",
      title: "Add token refresh",
      instructions:
        "Implement token refresh logic in src/lib/token.ts. Must handle expired tokens gracefully.",
    },
  ],
  edges: [],
};

type CreatedDraft = {
  name: string;
  description: string | null;
  definition: {
    workflowConfig: Record<string, unknown>;
    parameters: ParameterDeclaration[];
    executionContexts: Array<Record<string, unknown>>;
    tasks: Array<{ id: string; contextId: string; order: number }>;
    edges: Array<{ sourceContextId: string; targetContextId: string }>;
  };
};

function captureCreatedDraft(deps: PlannerToolDeps): CreatedDraft {
  const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
    .calls[0] as [string, CreatedDraft];
  return draft;
}

describe("graph workflow planner tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers all six planner tools", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    expect(getCapturedTools().has("create_graph_workflow")).toBe(true);
    expect(getCapturedTools().has("replace_graph_workflow")).toBe(true);
    expect(getCapturedTools().has("list_graph_workflows")).toBe(true);
    expect(getCapturedTools().has("get_graph_workflow")).toBe(true);
    expect(getCapturedTools().has("delete_graph_workflow")).toBe(true);
    expect(getCapturedTools().has("get_graph_workflow_status")).toBe(true);
  });

  it("create_graph_workflow: minimal context (id+title+AC) succeeds with no implementer/validator blocks stored", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")(
      MINIMAL_INPUT,
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const draft = captureCreatedDraft(deps);
    expect(draft.name).toBe("Add OAuth2");

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.id).toBe("auth-setup");
    expect(ctx.title).toBe("Authentication Setup");
    expect(ctx.acceptanceCriteria).toBe(
      "OAuth2 middleware is in place and verified.",
    );
    expect(ctx.implementer).toBeUndefined();
    expect(ctx.contextValidator).toBeUndefined();
    expect(ctx.humanApprovalGate).toBeUndefined();
    expect(ctx.mutability).toBeUndefined();
    expect(ctx.circuitBreaker).toBeUndefined();
    expect(ctx.iterationPolicy).toBeUndefined();
    expect(ctx.description).toBeUndefined();

    // Tasks get order from array position
    expect(draft.definition.tasks[0]?.id).toBe("create-auth-middleware");
    expect(draft.definition.tasks[0]?.contextId).toBe("auth-setup");
    expect(draft.definition.tasks[0]?.order).toBe(1);
    expect(draft.definition.tasks[1]?.id).toBe("add-token-refresh");
    expect(draft.definition.tasks[1]?.order).toBe(2);
  });

  it("create_graph_workflow: contextValidator { kind: 'disabled' } is stored verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidator: { kind: "disabled" },
        },
      ],
    });

    const draft = captureCreatedDraft(deps);
    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.contextValidator).toEqual({ kind: "disabled" });
  });

  it("create_graph_workflow: contextValidator { kind: 'use', value } is stored verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const validatorValue = {
      type: "claude" as const,
      enabled: true,
      agent: {
        backend: "claude" as const,
        model: "sonnet" as const,
        reasoningEffort: "medium" as const,
      },
      continuity: { enabled: true },
    };

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidator: { kind: "use", value: validatorValue },
        },
      ],
    });

    const draft = captureCreatedDraft(deps);
    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.contextValidator).toEqual({
      kind: "use",
      value: validatorValue,
    });
  });

  it("create_graph_workflow: per-context humanApprovalGate is stored verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          humanApprovalGate: { enabled: true },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const draft = captureCreatedDraft(deps);
    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.humanApprovalGate).toEqual({ enabled: true });
  });

  it("create_graph_workflow: top-level workflowConfig is stored on the semantic definition", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const workflowConfig = {
      implementer: {
        backend: "claude" as const,
        model: "opus" as const,
        reasoningEffort: "high" as const,
      },
      iterationPolicy: {
        maxIterations: 42,
        continuity: { enabled: true as const },
      },
    };

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      workflowConfig,
    });

    const draft = captureCreatedDraft(deps);
    expect(draft.definition.workflowConfig).toEqual(workflowConfig);
  });

  it("create_graph_workflow: omitting workflowConfig defaults to {}", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")(MINIMAL_INPUT);

    const draft = captureCreatedDraft(deps);
    expect(draft.definition.workflowConfig).toEqual({});
  });

  const MIXED_PARAMETERS: ParameterDeclaration[] = [
    {
      type: "string",
      name: "service-name",
      label: "Service name",
      required: true,
    },
    {
      type: "text",
      name: "context-notes",
      label: "Context notes",
      required: false,
      default: "none",
    },
    {
      type: "enum",
      name: "target-env",
      label: "Target environment",
      required: true,
      options: ["staging", "production"],
    },
  ];

  it("create_graph_workflow: declared parameters of mixed types are threaded onto the inflated definition", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      parameters: MIXED_PARAMETERS,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const draft = captureCreatedDraft(deps);
    expect(draft.definition.parameters).toEqual(MIXED_PARAMETERS);
  });

  it("replace_graph_workflow: declared parameters of mixed types are threaded onto the inflated definition", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("replace_graph_workflow")({
      workflowId: "wf-test-1",
      ...MINIMAL_INPUT,
      parameters: MIXED_PARAMETERS,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const [, , draft] = (deps.updateWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, CreatedDraft];
    expect(draft.definition.parameters).toEqual(MIXED_PARAMETERS);
  });

  it("create_graph_workflow: omitting parameters defaults to []", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")(MINIMAL_INPUT);

    const draft = captureCreatedDraft(deps);
    expect(draft.definition.parameters).toEqual([]);
  });

  it("planner-authored definition referencing an undeclared parameter is rejected by the shared accept-time validation", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      tasks: [
        {
          id: "create-auth-middleware",
          contextId: "auth-setup",
          title: "Create auth middleware",
          instructions:
            "Wire up middleware for {{inputs.undeclared-thing}} and verify it.",
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { definition: WorkflowSemanticDefinition }];
    const validation = validateAuthoredDefinition(draft.definition);

    expect(validation.ok).toBe(false);
    expect(
      validation.errors.some(
        (error) =>
          error.code === "undeclared-parameter-reference" &&
          error.parameterName === "undeclared-thing",
      ),
    ).toBe(true);
  });

  it("create_graph_workflow: context missing acceptanceCriteria is rejected with a targeted Zod error", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          id: "auth-setup",
          title: "Authentication Setup",
          // acceptanceCriteria intentionally omitted
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Validation error");
    expect(text).toContain("acceptanceCriteria");
  });

  it("create_graph_workflow: per-context implementer override is forwarded verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          implementer: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "xhigh",
          },
        },
      ],
    });

    const draft = captureCreatedDraft(deps);
    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.implementer).toEqual({
      backend: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "xhigh",
    });
  });

  it("create_graph_workflow: invalid claude model is rejected", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          implementer: {
            backend: "claude",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
        },
      ],
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("create_graph_workflow: invalid codex reasoning effort is rejected", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          implementer: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "max",
          },
        },
      ],
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("create_graph_workflow inflates edge context ids verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        ...MINIMAL_INPUT.executionContexts,
        {
          id: "api-routes",
          title: "API Routes",
          acceptanceCriteria: "API routes are wired up.",
        },
      ],
      edges: [{ sourceContextId: "auth-setup", targetContextId: "api-routes" }],
    });

    const draft = captureCreatedDraft(deps);
    expect(draft.definition.edges[0]?.sourceContextId).toBe("auth-setup");
    expect(draft.definition.edges[0]?.targetContextId).toBe("api-routes");
  });

  it("replace_graph_workflow forwards workflowConfig and context blocks verbatim", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const workflowConfig = {
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      humanApprovalGate: { enabled: true },
    };

    const result = (await getHandler("replace_graph_workflow")({
      workflowId: "wf-test-1",
      ...MINIMAL_INPUT,
      workflowConfig,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          mutability: { allowAgentTaskAdd: true },
          humanApprovalGate: { enabled: false },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("replaced");

    expect(deps.updateWorkflow).toHaveBeenCalledOnce();
    const [projectPath, workflowId, draft] = (
      deps.updateWorkflow as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string, CreatedDraft];

    expect(projectPath).toBe("/test");
    expect(workflowId).toBe("wf-test-1");
    expect(draft.definition.workflowConfig).toEqual(workflowConfig);
    expect(draft.definition.executionContexts[0]?.mutability).toEqual({
      allowAgentTaskAdd: true,
    });
    expect(draft.definition.executionContexts[0]?.humanApprovalGate).toEqual({
      enabled: false,
    });
  });

  it("list_graph_workflows returns formatted summaries", async () => {
    const deps = createMockDeps({
      listWorkflows: vi.fn(async () => [
        {
          id: "wf-1",
          name: "Auth Setup",
          description: "OAuth2 workflow",
          revision: 3,
          createdAt: "2026-03-30T00:00:00.000Z",
          updatedAt: "2026-03-30T01:00:00.000Z",
          parameters: [],
          prerequisites: [],
        },
      ]),
    });

    registerTools(deps);

    const result = (await getHandler("list_graph_workflows")({})) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]?.text).toContain("Auth Setup");
    expect(result.content[0]?.text).toContain("wf-1");
    expect(result.content[0]?.text).toContain("OAuth2 workflow");
  });

  it("list_graph_workflows returns message when empty", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("list_graph_workflows")({})) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]?.text).toContain("No workflow definitions found");
  });

  it("get_graph_workflow returns full definition", async () => {
    const record: WorkflowDefinitionRecord = {
      id: "wf-1",
      name: "Test",
      description: null,
      schemaVersion: 1,
      revision: 1,
      definition: {
        schemaVersion: 1,
        workflowConfig: {},
        charter: makeTestCharter(),
        parameters: [],
        prerequisites: [],
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      layout: {
        workflowId: "wf-1",
        contextPositions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      createdAt: "2026-03-30T00:00:00.000Z",
      updatedAt: "2026-03-30T00:00:00.000Z",
    };
    const deps = createMockDeps({
      getWorkflow: vi.fn(async () => record),
    });

    registerTools(deps);

    const result = (await getHandler("get_graph_workflow")({
      workflowId: "wf-1",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as { id: string };
    expect(parsed.id).toBe("wf-1");
  });

  it("get_graph_workflow returns error for missing workflow", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("get_graph_workflow")({
      workflowId: "nonexistent",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("delete_graph_workflow calls deps and confirms", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("delete_graph_workflow")({
      workflowId: "wf-1",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("deleted");
    expect(deps.deleteWorkflow).toHaveBeenCalledWith("/test", "wf-1");
  });

  it("get_graph_workflow_status returns no-execution message when idle", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("get_graph_workflow_status")({})) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]?.text).toContain("No active graph workflow");
  });

  it("create_graph_workflow returns validation error for invalid input", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      name: "",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  describe("charter requirement (task 3.2)", () => {
    type CharterUpdatedInput = Parameters<
      PlannerToolDeps["publishCharterUpdated"]
    >[0];

    function makePublishCharterUpdatedSpy() {
      return vi.fn(
        (_input: CharterUpdatedInput): GraphWorkflowExecutionEvent[] => [],
      );
    }

    function makeRecordWithCharter(
      charter: ReturnType<typeof makeTestCharter>,
      revision = 1,
    ): WorkflowDefinitionRecord {
      return {
        id: "wf-test-1",
        name: "Existing",
        description: null,
        schemaVersion: 1,
        revision,
        definition: {
          schemaVersion: 1,
          workflowConfig: {},
          charter,
          parameters: [],
          prerequisites: [],
          executionContexts: [],
          tasks: [],
          edges: [],
        },
        layout: {
          workflowId: "wf-test-1",
          contextPositions: {},
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
      };
    }

    function withoutCharter(input: Record<string, unknown>) {
      const { charter: _charter, ...rest } = input;
      return rest;
    }

    const DUP_RANK_CHARTER = {
      mission: "Deliver",
      sourcesOfTruth: [
        {
          rank: 1,
          id: "design-doc",
          label: "Design",
          type: "document" as const,
          locator: "design.md",
          description: "primary",
          accessPolicy: "worktree-relative" as const,
        },
        {
          rank: 1,
          id: "acceptance-criteria",
          label: "AC",
          type: "spec" as const,
          locator: "ac",
          description: "secondary",
          accessPolicy: "worktree-relative" as const,
        },
      ],
    };

    it("create_graph_workflow without a charter is rejected with charter_missing", async () => {
      const deps = createMockDeps();
      registerTools(deps);

      const result = (await getHandler("create_graph_workflow")(
        withoutCharter(MINIMAL_INPUT),
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("charter_missing");
      expect(deps.createWorkflow).not.toHaveBeenCalled();
    });

    it("create_graph_workflow with a duplicate-rank charter is rejected with charter_invalid naming the offending entry", async () => {
      const deps = createMockDeps();
      registerTools(deps);

      const result = (await getHandler("create_graph_workflow")({
        ...MINIMAL_INPUT,
        charter: DUP_RANK_CHARTER,
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("charter_invalid");
      expect(text).toContain("acceptance-criteria");
      expect(deps.createWorkflow).not.toHaveBeenCalled();
    });

    it("replace_graph_workflow without a charter is rejected with charter_missing", async () => {
      const deps = createMockDeps();
      registerTools(deps);

      const result = (await getHandler("replace_graph_workflow")(
        withoutCharter({ workflowId: "wf-test-1", ...MINIMAL_INPUT }),
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("charter_missing");
      expect(deps.updateWorkflow).not.toHaveBeenCalled();
    });

    it("replace_graph_workflow with a duplicate-rank charter is rejected with charter_invalid", async () => {
      const deps = createMockDeps();
      registerTools(deps);

      const result = (await getHandler("replace_graph_workflow")({
        workflowId: "wf-test-1",
        ...MINIMAL_INPUT,
        charter: DUP_RANK_CHARTER,
      })) as { content: Array<{ text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("charter_invalid");
      expect(text).toContain("acceptance-criteria");
      expect(deps.updateWorkflow).not.toHaveBeenCalled();
    });

    it("replace_graph_workflow that changes charter content emits charter.updated once with the new hash and revision", async () => {
      const existingCharter = makeTestCharter();
      const newCharter = makeTestCharter({
        mission: "A materially different mission narrative",
      });
      const publishCharterUpdated = makePublishCharterUpdatedSpy();
      const deps = createMockDeps({
        getWorkflow: vi.fn(async () => makeRecordWithCharter(existingCharter)),
        publishCharterUpdated,
      });
      registerTools(deps);

      const result = (await getHandler("replace_graph_workflow")({
        workflowId: "wf-test-1",
        ...MINIMAL_INPUT,
        charter: newCharter,
      })) as { isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(publishCharterUpdated).toHaveBeenCalledOnce();
      const call = publishCharterUpdated.mock.calls[0]![0];
      expect(call.projectPath).toBe("/test");
      expect(call.definitionId).toBe("wf-test-1");
      // updateWorkflow mock returns revision 2.
      expect(call.definitionRevision).toBe(2);
      expect(call.charterHash).toBe(computeCharterHash(newCharter));
      expect(call.charterHash).not.toBe(computeCharterHash(existingCharter));
    });

    it("replace_graph_workflow that does not change charter content does NOT emit charter.updated", async () => {
      const existingCharter = makeTestCharter();
      const publishCharterUpdated = makePublishCharterUpdatedSpy();
      const deps = createMockDeps({
        getWorkflow: vi.fn(async () => makeRecordWithCharter(existingCharter)),
        publishCharterUpdated,
      });
      registerTools(deps);

      const result = (await getHandler("replace_graph_workflow")({
        workflowId: "wf-test-1",
        ...MINIMAL_INPUT,
        charter: existingCharter,
      })) as { isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(publishCharterUpdated).not.toHaveBeenCalled();
    });
  });
});
