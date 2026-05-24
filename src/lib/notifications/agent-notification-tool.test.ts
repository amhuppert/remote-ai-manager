import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerNotificationTool,
  type NotificationToolDeps,
} from "./agent-notification-tool";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_notification_tool_captured";

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const g = globalThis as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<string, { name: string; handler: ToolHandler }>;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function registerTools(deps: NotificationToolDeps): void {
  registerNotificationTool(
    createCapturingServer() as never,
    { projectName: "my-project", sessionName: "my-session" },
    deps,
  );
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found in captured tools`);
  }
  return tool.handler;
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

  it("registers the send_notification tool", () => {
    const deps = createMockDeps();

    registerTools(deps);

    expect(getCapturedTools().has("send_notification")).toBe(true);
    expect(getCapturedTools().size).toBe(1);
  });

  it("calls sendNotification dep with correct args on success", async () => {
    const deps = createMockDeps();
    registerTools(deps);

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
    const deps = createMockDeps();
    registerTools(deps);

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
    const deps = createMockDeps();
    deps.mockSendNotification.mockRejectedValue(new Error("Network failed"));
    registerTools(deps);

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
    const deps = createMockDeps();
    registerTools(deps);

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
