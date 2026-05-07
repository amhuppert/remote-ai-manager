import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";

describe("mcp-gateway/portable-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CC_SERVER_URL = "http://cc.local:4123/";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds the session tools portable MCP config with conversationId", async () => {
    const { buildSessionToolsPortableMcp } = await import("./portable-config");

    expect(
      buildSessionToolsPortableMcp("my-project", "test session", "conv-42"),
    ).toEqual({
      servers: [
        {
          id: "cc-session-tools",
          transport: "streamable-http",
          url: "http://cc.local:4123/api/projects/my-project/sessions/test%20session/conversations/conv-42/mcp",
          headers: {
            Authorization: expect.stringMatching(/^Bearer /),
          },
        },
      ],
    });
  });

  it("builds the graph workflow portable MCP config", async () => {
    const { buildGraphWorkflowPortableMcp } = await import("./portable-config");

    expect(
      buildGraphWorkflowPortableMcp(
        "my-project",
        "test session",
        "exec-1",
        "ctx-2",
      ),
    ).toEqual({
      servers: [
        {
          id: "cc-graph-workflow",
          transport: "streamable-http",
          url: "http://cc.local:4123/api/projects/my-project/sessions/test%20session/mcp/graph-workflow/exec-1/contexts/ctx-2",
          headers: {
            Authorization: expect.stringMatching(/^Bearer /),
          },
        },
      ],
    });
  });

  it("builds the workflow draft portable MCP config", async () => {
    const { buildWorkflowDraftPortableMcp } = await import("./portable-config");

    expect(buildWorkflowDraftPortableMcp("my-project", "draft-1")).toEqual({
      servers: [
        {
          id: "cc-workflow-draft",
          transport: "streamable-http",
          url: "http://cc.local:4123/api/projects/my-project/workflows/generate/mcp/draft-1",
          headers: {
            Authorization: expect.stringMatching(/^Bearer /),
          },
        },
      ],
    });
  });

  it("merges configs by server id with last-writer wins", async () => {
    const { mergePortableMcpConfigs } = await import("./portable-config");

    const base: PortableMcpConfig = {
      servers: [
        {
          id: "cc-session-tools",
          transport: "streamable-http",
          url: "http://old/session",
        },
        {
          id: "extra",
          transport: "streamable-http",
          url: "http://extra",
        },
      ],
    };
    const override: PortableMcpConfig = {
      servers: [
        {
          id: "cc-session-tools",
          transport: "streamable-http",
          url: "http://new/session",
        },
      ],
    };

    expect(mergePortableMcpConfigs(base, override)).toEqual({
      servers: [
        {
          id: "cc-session-tools",
          transport: "streamable-http",
          url: "http://new/session",
        },
        {
          id: "extra",
          transport: "streamable-http",
          url: "http://extra",
        },
      ],
    });
  });

  it("returns undefined when every config is absent or empty", async () => {
    const { mergePortableMcpConfigs } = await import("./portable-config");

    expect(mergePortableMcpConfigs(undefined, null, { servers: [] })).toBe(
      undefined,
    );
  });
});
