import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NotificationToolDeps } from "./agent-notification-tool";

/**
 * Tests for the agent notification MCP tool server.
 *
 * Mocks createSdkMcpServer and tool to capture handlers,
 * then tests each tool directly.
 */

const TOOLS_KEY = "__test_notification_tool_captured";

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
  const TOOLS_KEY_INNER = "__test_notification_tool_captured";
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

function createMockDeps(): NotificationToolDeps & {
  mockSendNotification: ReturnType<typeof vi.fn>;
} {
  const mockSendNotification = vi.fn().mockResolvedValue(undefined);
  return {
    sendNotification: mockSendNotification,
    mockSendNotification,
  };
}

describe("agent-notification-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("creates an MCP server with one tool (send_notification)", async () => {
    const { createNotificationToolServer } =
      await import("./agent-notification-tool");
    const deps = createMockDeps();

    const server = createNotificationToolServer(
      { projectName: "my-project", sessionName: "my-session" },
      deps,
    );

    expect(server).toBeDefined();
    expect(getCapturedTools().has("send_notification")).toBe(true);
    expect(getCapturedTools().size).toBe(1);
  });

  it("calls sendNotification dep with correct args on success", async () => {
    const { createNotificationToolServer } =
      await import("./agent-notification-tool");
    const deps = createMockDeps();

    createNotificationToolServer(
      { projectName: "my-project", sessionName: "my-session" },
      deps,
    );

    const handler = getHandler("send_notification");
    await handler({
      title: "Task Complete",
      message: "The build finished successfully",
      tags: "white_check_mark",
    });

    expect(deps.mockSendNotification).toHaveBeenCalledWith(
      "Task Complete",
      "The build finished successfully",
      "white_check_mark",
    );
  });

  it("returns success message including the title", async () => {
    const { createNotificationToolServer } =
      await import("./agent-notification-tool");
    const deps = createMockDeps();

    createNotificationToolServer(
      { projectName: "my-project", sessionName: "my-session" },
      deps,
    );

    const handler = getHandler("send_notification");
    const result = (await handler({
      title: "Task Complete",
      message: "The build finished",
      tags: "white_check_mark",
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0]?.text).toContain("Task Complete");
    expect(result.content[0]?.text).toContain("sent");
  });

  it("returns isError when sendNotification throws", async () => {
    const { createNotificationToolServer } =
      await import("./agent-notification-tool");
    const deps = createMockDeps();
    deps.mockSendNotification.mockRejectedValue(new Error("Network failed"));

    createNotificationToolServer(
      { projectName: "my-project", sessionName: "my-session" },
      deps,
    );

    const handler = getHandler("send_notification");
    const result = (await handler({
      title: "Oops",
      message: "Something broke",
    })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Network failed");
  });

  it("uses default tag 'robot' when tags not provided", async () => {
    const { createNotificationToolServer } =
      await import("./agent-notification-tool");
    const deps = createMockDeps();

    createNotificationToolServer(
      { projectName: "my-project", sessionName: "my-session" },
      deps,
    );

    const handler = getHandler("send_notification");
    await handler({
      title: "Hello",
      message: "No tags specified",
    });

    expect(deps.mockSendNotification).toHaveBeenCalledWith(
      "Hello",
      "No tags specified",
      "robot",
    );
  });
});
