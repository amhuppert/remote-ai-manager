import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import type { MissingPrerequisite } from "@/lib/workflow-graph/preflight-prerequisite-service";
import {
  WorkflowDefinitionNotFoundError,
  WorkflowPrerequisitesUnmetError,
  WorkflowStartGuardError,
  WorkflowStartInputError,
} from "@/lib/workflow-graph/workflow-manager";
import {
  registerStartGraphWorkflowTool,
  type StartGraphWorkflowToolDeps,
} from "./start-graph-workflow-tool";

const TOOLS_KEY = "__test_start_graph_workflow_tools";
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

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }
  return tool.handler;
}

function makeExecution(id: string): GraphWorkflowExecution {
  // The tool only reads `id` off the started execution for its success text,
  // so a structurally-minimal cast keeps the test focused on tool behavior
  // rather than reconstructing the full runtime shape.
  return { id } as GraphWorkflowExecution;
}

function registerTool(deps: StartGraphWorkflowToolDeps): void {
  registerStartGraphWorkflowTool(
    createCapturingServer() as never,
    {
      projectPath: "/test",
      sessionName: "test-session",
      projectName: "test-project",
    },
    deps,
  );
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe("start_graph_workflow MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers only the start_graph_workflow tool (no fill/update-parameters tool)", () => {
    const deps: StartGraphWorkflowToolDeps = {
      startWorkflow: vi.fn(async () => makeExecution("exec-1")),
    };

    registerTool(deps);

    expect([...getCapturedTools().keys()]).toEqual(["start_graph_workflow"]);
  });

  it("valid launch calls startWorkflow with definitionId + parameters and returns success text with the execution id", async () => {
    const startWorkflow = vi.fn(async () => makeExecution("exec-42"));
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
      parameters: { env: "staging" },
    })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow).toHaveBeenCalledWith({
      projectPath: "/test",
      sessionName: "test-session",
      projectName: "test-project",
      definitionId: "wf-1",
      tier: "project",
      parameters: { env: "staging" },
    });
    expect(result.content[0]?.text ?? "").toContain("exec-42");
    expect(result.content[0]?.text ?? "").toContain("wf-1");
  });

  it("zero-input launch (no parameters) starts like a human zero-input launch", async () => {
    const startWorkflow = vi.fn<StartGraphWorkflowToolDeps["startWorkflow"]>(
      async () => makeExecution("exec-zero"),
    );
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-static",
    })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    const call = startWorkflow.mock.calls[0]![0];
    expect(call.definitionId).toBe("wf-static");
    expect(call.parameters).toBeUndefined();
  });

  it("missing-input rejection returns a structured error naming the offending parameter; nothing else is invoked", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowStartInputError(
        { kind: "missing_required", name: "env" },
        'Required parameter "env" was not supplied',
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("input_invalid:");
    expect(text).toContain("missing_required");
    expect(text).toContain("env");
    // startWorkflow is the only side-effecting call; the shared path guarantees
    // nothing is seeded on a rejection.
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("invalid-value rejection names the offending parameter and the invalid_value kind", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowStartInputError(
        {
          kind: "invalid_value",
          name: "tier",
          message: 'Invalid option: expected one of "a"|"b"',
        },
        'Parameter "tier" is invalid: Invalid option',
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
      parameters: { tier: "z" },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("input_invalid:");
    expect(text).toContain("invalid_value");
    expect(text).toContain("tier");
  });

  it("unknown-parameter rejection names the offending parameter and the unknown_parameter kind", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowStartInputError(
        { kind: "unknown_parameter", name: "bogus" },
        'Unknown parameter "bogus" is not declared by this workflow',
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
      parameters: { bogus: "x" },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("input_invalid:");
    expect(text).toContain("unknown_parameter");
    expect(text).toContain("bogus");
  });

  it("active-execution guard returns a conflict error", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowStartGuardError(
        "active_execution",
        'Session "test-session" already has an active graph workflow execution',
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("conflict:");
    expect(text).toContain("already has an active");
  });

  it("uncommitted-changes guard returns an uncommitted error carrying the dirty message", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowStartGuardError(
        "uncommitted_changes",
        "Cannot start the workflow while the session worktree has 2 uncommitted change(s). Commit your changes and try again.",
        [
          { path: "a.ts", statusCode: " M", tracked: true },
          { path: "b.ts", statusCode: "??", tracked: false },
        ],
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("uncommitted_changes:");
    expect(text).toContain("uncommitted change(s)");
  });

  it("not-found error returns a not_found error and reports nothing was seeded", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new Error('Workflow definition "nope" was not found');
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "nope",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("not_found:");
    expect(text).toContain("nope");
  });

  it("empty definitionId is rejected at parse time without calling startWorkflow", async () => {
    const startWorkflow = vi.fn(async () => makeExecution("exec-1"));
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "   ",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("defaults tier to project when the agent omits it", async () => {
    const startWorkflow = vi.fn<StartGraphWorkflowToolDeps["startWorkflow"]>(
      async () => makeExecution("exec-default-tier"),
    );
    registerTool({ startWorkflow });

    await getHandler("start_graph_workflow")({ definitionId: "wf-1" });

    expect(startWorkflow.mock.calls[0]![0].tier).toBe("project");
  });

  it("threads tier:'global' so the launch resolves from the global tier", async () => {
    const startWorkflow = vi.fn<StartGraphWorkflowToolDeps["startWorkflow"]>(
      async () => makeExecution("exec-global"),
    );
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-global",
      tier: "global",
    })) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow.mock.calls[0]![0].tier).toBe("global");
  });

  it("rejects an invalid tier value at parse time without calling startWorkflow", async () => {
    const startWorkflow = vi.fn(async () => makeExecution("exec-1"));
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
      tier: "nonsense",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("prerequisites-unmet rejection returns the structured itemized result and seeds nothing", async () => {
    const missing: MissingPrerequisite[] = [
      {
        kind: "path",
        path: ".kiro/specs",
        label: "specs directory",
        reason: "absent",
      },
      {
        kind: "skill",
        skill: "kiro-impl",
        backend: "codex",
        label: null,
        reason: "probe_error",
      },
    ];
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowPrerequisitesUnmetError(
        missing,
        "2 declared prerequisite(s) are unmet",
      );
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "wf-1",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("prerequisites_unmet:");
    // Itemizes each miss: kind, the path / skill+backend, and the reason.
    expect(text).toContain(".kiro/specs");
    expect(text).toContain("absent");
    expect(text).toContain("kiro-impl");
    expect(text).toContain("codex");
    expect(text).toContain("probe_error");
    // The agent must be able to recover the full structured `missing` list.
    expect(text).toContain(JSON.stringify(missing));
    // The shared start path guarantees nothing is seeded on a rejection.
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it("typed not-found error names the tier and identifier", async () => {
    const startWorkflow = vi.fn(async () => {
      throw new WorkflowDefinitionNotFoundError("missing-wf", "global");
    });
    registerTool({ startWorkflow });

    const result = (await getHandler("start_graph_workflow")({
      definitionId: "missing-wf",
      tier: "global",
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("not_found:");
    expect(text).toContain("missing-wf");
    expect(text).toContain("global");
  });
});
