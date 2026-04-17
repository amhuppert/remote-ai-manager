import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig, WorkflowDefinitionRecord } from "@/types";
import { registerPlannerTools, type PlannerToolDeps } from "./planner-tools";

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
  stateFilePath: "/tmp/state.json",
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
    ...overrides,
  };
}

const MINIMAL_INPUT = {
  name: "Add OAuth2",
  description: "Add OAuth2 support to the API",
  executionContexts: [
    {
      slug: "auth-setup",
      title: "Authentication Setup",
      instructions: "Set up OAuth2 middleware and token handling.",
    },
  ],
  tasks: [
    {
      slug: "create-auth-middleware",
      contextSlug: "auth-setup",
      title: "Create auth middleware",
      instructions:
        "Create Express middleware that validates OAuth2 bearer tokens. Add to src/middleware/auth.ts. Verify with a unit test.",
    },
    {
      slug: "add-token-refresh",
      contextSlug: "auth-setup",
      title: "Add token refresh",
      instructions:
        "Implement token refresh logic in src/lib/token.ts. Must handle expired tokens gracefully.",
    },
  ],
  edges: [],
};

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

  it("create_graph_workflow inflates slug-based input into internal definition and persists", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")(
      MINIMAL_INPUT,
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Add OAuth2");
    expect(result.content[0]?.text).toContain("wf-test-1");

    expect(deps.createWorkflow).toHaveBeenCalledOnce();
    const [projectPath, draft] = (
      deps.createWorkflow as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [
      string,
      {
        name: string;
        definition: {
          executionContexts: Array<{ id: string }>;
          tasks: Array<{ id: string; contextId: string; order: number }>;
        };
      },
    ];

    expect(projectPath).toBe("/test");
    expect(draft.name).toBe("Add OAuth2");

    // Slugs become internal IDs
    expect(draft.definition.executionContexts[0]?.id).toBe("auth-setup");

    // Tasks derive order from array position
    expect(draft.definition.tasks[0]?.id).toBe("create-auth-middleware");
    expect(draft.definition.tasks[0]?.contextId).toBe("auth-setup");
    expect(draft.definition.tasks[0]?.order).toBe(1);
    expect(draft.definition.tasks[1]?.id).toBe("add-token-refresh");
    expect(draft.definition.tasks[1]?.order).toBe(2);
  });

  it("create_graph_workflow applies sensible defaults for omitted config", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")(MINIMAL_INPUT);

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { model: string; reasoningEffort: string };
            mutability: { allowAgentTaskAdd: boolean };
            circuitBreaker: { consecutiveFailureThreshold: number };
            iterationPolicy: { maxIterations: number };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.model).toBe("sonnet");
    expect(ctx.agent.reasoningEffort).toBe("high");
    expect(ctx.mutability.allowAgentTaskAdd).toBe(false);
    expect(ctx.circuitBreaker).toEqual({});
    expect(ctx.iterationPolicy.maxIterations).toBe(20);
  });

  it("create_graph_workflow inflates edge slugs to internal contextIds", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        ...MINIMAL_INPUT.executionContexts,
        {
          slug: "api-routes",
          title: "API Routes",
          instructions: "Build the API routes.",
        },
      ],
      edges: [
        { sourceContextSlug: "auth-setup", targetContextSlug: "api-routes" },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          edges: Array<{ sourceContextId: string; targetContextId: string }>;
        };
      },
    ];

    expect(draft.definition.edges[0]?.sourceContextId).toBe("auth-setup");
    expect(draft.definition.edges[0]?.targetContextId).toBe("api-routes");
  });

  it("replace_graph_workflow calls updateWorkflow with full replacement", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("replace_graph_workflow")({
      workflowId: "wf-test-1",
      ...MINIMAL_INPUT,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("replaced");
    expect(result.content[0]?.text).toContain("revision: 2");

    expect(deps.updateWorkflow).toHaveBeenCalledOnce();
    const [projectPath, workflowId] = (
      deps.updateWorkflow as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string];
    expect(projectPath).toBe("/test");
    expect(workflowId).toBe("wf-test-1");
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

  it("create_graph_workflow inflates a codex context validator when type is 'codex'", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidation: {
            type: "codex",
            acceptanceCriteria: "Validate the completed context with Codex.",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            contextValidation?: {
              type: string;
              enabled: boolean;
              acceptanceCriteria: string;
              codex?: Record<string, unknown>;
              agent?: { model: string; reasoningEffort: string };
            };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.contextValidation).toBeDefined();
    expect(ctx.contextValidation!.type).toBe("codex");
    expect(ctx.contextValidation!.codex).toEqual({});
    expect(ctx.contextValidation!.agent).toBeUndefined();
    expect(ctx.contextValidation!.acceptanceCriteria).toBe(
      "Validate the completed context with Codex.",
    );
  });

  it("create_graph_workflow uses workflowDefaults from config for context validator type", async () => {
    const deps = createMockDeps({
      readConfig: vi.fn(async () => ({
        ...MOCK_CONFIG,
        workflowDefaults: {
          contextValidator: { type: "codex" as const },
        },
      })),
    });

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidation: {
            acceptanceCriteria: "Validate the context.",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            contextValidation?: { type: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.contextValidation?.type).toBe("codex");
  });

  it("codex validator defaults flow model and effort into definition", async () => {
    const deps = createMockDeps({
      readConfig: vi.fn(async () => ({
        ...MOCK_CONFIG,
        workflowDefaults: {
          contextValidator: {
            type: "codex" as const,
            model: "gpt-5.4" as const,
            reasoningEffort: "high" as const,
          },
        },
      })),
    });

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidation: { acceptanceCriteria: "Validate." },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            contextValidation?: {
              type: string;
              codex?: { model?: string; reasoningEffort?: string };
            };
          }>;
        };
      },
    ];

    const tv = draft.definition.executionContexts[0]!.contextValidation!;
    expect(tv.type).toBe("codex");
    expect(tv.codex?.model).toBe("gpt-5.4");
    expect(tv.codex?.reasoningEffort).toBe("high");
  });

  it("explicit per-context type overrides workflowDefaults", async () => {
    const deps = createMockDeps({
      readConfig: vi.fn(async () => ({
        ...MOCK_CONFIG,
        workflowDefaults: {
          contextValidator: { type: "codex" as const },
        },
      })),
    });

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          contextValidation: {
            type: "claude",
            acceptanceCriteria: "Use Claude explicitly.",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            contextValidation?: { type: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.contextValidation?.type).toBe("claude");
  });

  it("create_graph_workflow inflates codex implementer when backend is 'codex'", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4");
    expect(ctx.agent.reasoningEffort).toBe("high");
  });

  it("create_graph_workflow defaults to codex when config.defaultAgentBackend is 'codex'", async () => {
    const deps = createMockDeps({
      readConfig: vi.fn(async () => ({
        ...MOCK_CONFIG,
        defaultAgentBackend: "codex" as const,
      })),
    });

    registerTools(deps);

    await getHandler("create_graph_workflow")(MINIMAL_INPUT);

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4");
  });

  it("create_graph_workflow defaults codex model and effort when omitted", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4");
    expect(ctx.agent.reasoningEffort).toBe("high");
  });

  it("codex implementer with claude context validator uses claude defaults for validation", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
          contextValidation: {
            type: "claude",
            acceptanceCriteria: "Validate tasks.",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string };
            contextValidation?: {
              type: string;
              agent?: { model: string; reasoningEffort: string };
            };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.contextValidation?.type).toBe("claude");
    // Validator uses Claude defaults, not Codex model
    expect(ctx.contextValidation?.agent?.model).toBe("sonnet");
    expect(ctx.contextValidation?.agent?.reasoningEffort).toBe("high");
  });

  it("codex implementer accepts codex-specific reasoning effort 'xhigh'", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "xhigh",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.reasoningEffort).toBe("xhigh");
  });

  it("codex implementer accepts codex-specific reasoning effort 'minimal'", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "minimal",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4-mini");
    expect(ctx.agent.reasoningEffort).toBe("minimal");
  });

  it("codex implementer rejects claude-only reasoning effort 'max'", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "max",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("replace_graph_workflow inflates codex implementer config", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("replace_graph_workflow")({
      workflowId: "wf-test-1",
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "gpt-5.4-mini",
            reasoningEffort: "xhigh",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("replaced");

    expect(deps.updateWorkflow).toHaveBeenCalledOnce();
    const [, , draft] = (deps.updateWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string; reasoningEffort: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4-mini");
    expect(ctx.agent.reasoningEffort).toBe("xhigh");
  });

  it("codex implementer rejects invalid codex model", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "codex",
            model: "not-a-real-model",
            reasoningEffort: "high",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("claude implementer rejects invalid claude model", async () => {
    const deps = createMockDeps();

    registerTools(deps);

    const result = (await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "claude",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
        },
      ],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("explicit claude backend overrides codex defaultAgentBackend", async () => {
    const deps = createMockDeps({
      readConfig: vi.fn(async () => ({
        ...MOCK_CONFIG,
        defaultAgentBackend: "codex" as const,
      })),
    });

    registerTools(deps);

    await getHandler("create_graph_workflow")({
      ...MINIMAL_INPUT,
      executionContexts: [
        {
          ...MINIMAL_INPUT.executionContexts[0],
          agentConfig: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
        },
      ],
    });

    const [, draft] = (deps.createWorkflow as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        definition: {
          executionContexts: Array<{
            agent: { backend: string; model: string };
          }>;
        };
      },
    ];

    const ctx = draft.definition.executionContexts[0]!;
    expect(ctx.agent.backend).toBe("claude");
    expect(ctx.agent.model).toBe("opus");
  });
});
