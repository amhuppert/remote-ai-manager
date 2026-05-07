import { describe, it, expect, vi } from "vitest";
import { createCanUseTool, type McpFilterLookup } from "./native-tooling";

describe("createCanUseTool — MCP filter fallback", () => {
  it("denies a tool the filter reports as disabled with interrupt: false and sanitized message", async () => {
    const filter: McpFilterLookup = {
      isToolAllowed: vi.fn().mockReturnValue({
        allowed: false,
        reason: "tool-disabled",
      }),
    };

    const canUseTool = createCanUseTool({
      conversationId: "conv-1",
      mcpFilter: filter,
    });

    const result = await canUseTool("mcp__my_server__dangerous_tool", {
      foo: "bar",
    });

    expect(result).toEqual({
      behavior: "deny",
      message: "Tool disabled by MCP configuration",
      interrupt: false,
    });
    expect(filter.isToolAllowed).toHaveBeenCalledWith({
      conversationId: "conv-1",
      serverKey: "my_server",
      toolName: "dangerous_tool",
    });
  });

  it("allows a tool the filter reports as allowed and does not invoke any other handler", async () => {
    const filter: McpFilterLookup = {
      isToolAllowed: vi.fn().mockReturnValue({ allowed: true }),
    };

    const canUseTool = createCanUseTool({
      conversationId: "conv-1",
      mcpFilter: filter,
    });

    const result = await canUseTool("mcp__my_server__safe_tool", { foo: 1 });

    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { foo: 1 },
    });
  });

  it("passes non-MCP tool names through the filter unchanged (no serverKey resolvable)", async () => {
    const filter: McpFilterLookup = {
      isToolAllowed: vi.fn(),
    };

    const canUseTool = createCanUseTool({
      conversationId: "conv-1",
      mcpFilter: filter,
    });

    const result = await canUseTool("Read", { file_path: "/etc/passwd" });

    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/etc/passwd" },
    });
    expect(filter.isToolAllowed).not.toHaveBeenCalled();
  });

  it("denies an MCP-shaped tool name even when it matches the legacy native AskUserQuestion identifier", async () => {
    const filter: McpFilterLookup = {
      isToolAllowed: vi.fn().mockReturnValue({
        allowed: false,
        reason: "server-disabled",
      }),
    };

    const canUseTool = createCanUseTool({
      conversationId: "conv-1",
      mcpFilter: filter,
    });

    const result = await canUseTool("mcp__askq__AskUserQuestion", {
      questions: [],
    });

    expect(result).toMatchObject({ behavior: "deny", interrupt: false });
  });

  it("does not invoke MCP filter when no dep is provided (optional)", async () => {
    const canUseTool = createCanUseTool();

    const result = await canUseTool("mcp__my_server__tool", {});

    expect(result).toEqual({ behavior: "allow", updatedInput: {} });
  });
});
