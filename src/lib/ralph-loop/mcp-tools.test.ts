import { describe, it, expect, vi, beforeEach } from "vitest";
import { createToolServer, type ToolContext } from "./mcp-tools";

/**
 * Tests for the Ralph Loop MCP tool server.
 *
 * We mock createSdkMcpServer and tool to capture the handler functions,
 * then test them directly with valid/invalid inputs.
 */

// Store captured tool handlers on globalThis for cross-scope access
const TOOLS_KEY = "__test_captured_tools";

function getCapturedTools(): Map<
  string,
  { name: string; handler: (args: unknown) => Promise<unknown> }
> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  >;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  // Access the shared global map
  const TOOLS_KEY_INNER = "__test_captured_tools";
  function getTools(): Map<
    string,
    { name: string; handler: (args: unknown) => Promise<unknown> }
  > {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g[TOOLS_KEY_INNER]) {
      g[TOOLS_KEY_INNER] = new Map();
    }
    return g[TOOLS_KEY_INNER] as Map<
      string,
      { name: string; handler: (args: unknown) => Promise<unknown> }
    >;
  }

  return {
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        const tools = getTools();
        for (const t of config.tools) {
          tools.set(t.name, t);
        }
        return { __mock: true, tools: config.tools };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({
        name,
        handler,
      }),
    ),
  };
});

function getHandler(name: string): (args: unknown) => Promise<unknown> {
  const t = getCapturedTools().get(name);
  if (!t) throw new Error(`Tool ${name} not found in captured tools`);
  return t.handler;
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    projectPath: "/home/user/my-project",
    sessionName: "feature-auth",
    iterationNumber: 1,
    isWindingDown: () => false,
    onStatusReport: vi.fn(),
    onFixPlanUpdate: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("RalphLoopMCPTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  describe("createToolServer", () => {
    it("creates a server with report_status and update_fix_plan tools", () => {
      const ctx = makeContext();
      const server = createToolServer(ctx);
      expect(server).toBeDefined();
      expect(getCapturedTools().has("report_status")).toBe(true);
      expect(getCapturedTools().has("update_fix_plan")).toBe(true);
    });
  });

  describe("report_status tool", () => {
    it("calls onStatusReport with valid input", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("report_status");

      const input = {
        status: "in_progress",
        exit_signal: false,
        work_summary: "Implemented JWT token generation",
        work_type: "implementation",
      };

      const result = (await handler(input)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain("Status report recorded");
      expect(ctx.onStatusReport).toHaveBeenCalledWith(input);
    });

    it("accepts all valid status values", async () => {
      for (const status of ["in_progress", "complete", "blocked"]) {
        const ctx = makeContext();
        createToolServer(ctx);
        const handler = getHandler("report_status");

        const result = (await handler({
          status,
          exit_signal: true,
          work_summary: "test",
          work_type: "testing",
        })) as { isError?: boolean };

        expect(result.isError).toBeUndefined();
      }
    });

    it("returns error for invalid input", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("report_status");

      const result = (await handler({
        status: "invalid",
        exit_signal: "not-boolean",
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Validation error");
      expect(ctx.onStatusReport).not.toHaveBeenCalled();
    });

    it("returns error when required fields are missing", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("report_status");

      const result = (await handler({})) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  describe("update_fix_plan tool", () => {
    it("calls onFixPlanUpdate with completed task IDs", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const input = { completedTaskIds: ["t1", "t2"] };
      const result = (await handler(input)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain("2 task(s) completed");
      expect(ctx.onFixPlanUpdate).toHaveBeenCalledWith(input);
    });

    it("calls onFixPlanUpdate with skipped tasks", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const input = {
        skippedTasks: [{ taskId: "t3", reason: "Not needed" }],
      };
      const result = (await handler(input)) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]!.text).toContain("1 task(s) skipped");
    });

    it("calls onFixPlanUpdate with new tasks", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const input = {
        newTasks: [
          { description: "Fix CORS", priority: "high" },
          { description: "Add logging", priority: "low" },
        ],
      };
      const result = (await handler(input)) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]!.text).toContain("2 task(s) added");
    });

    it("handles empty update gracefully", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]!.text).toContain("no changes");
    });

    it("returns error when onFixPlanUpdate throws", async () => {
      const ctx = makeContext({
        onFixPlanUpdate: vi.fn(async () => {
          throw new Error("State write failed");
        }),
      });
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const result = (await handler({
        completedTaskIds: ["t1"],
      })) as { content: Array<{ text: string }>; isError: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("State write failed");
    });

    it("returns error for invalid skippedTasks shape", async () => {
      const ctx = makeContext();
      createToolServer(ctx);
      const handler = getHandler("update_fix_plan");

      const result = (await handler({
        skippedTasks: [{ taskId: "t1" }], // missing reason
      })) as { isError: boolean };

      expect(result.isError).toBe(true);
    });
  });
});
