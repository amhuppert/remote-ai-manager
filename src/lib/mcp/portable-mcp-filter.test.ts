import { describe, it, expect } from "vitest";
import { createPortableMcpFilterLookup } from "./portable-mcp-filter";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";

function config(
  servers: PortableMcpConfig["servers"],
): () => PortableMcpConfig | null {
  return () => ({ servers });
}

describe("createPortableMcpFilterLookup", () => {
  it("allows a tool when the server exists with no filter fields", () => {
    const lookup = createPortableMcpFilterLookup(
      config([{ id: "srv", transport: "stdio", command: "node" }]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: true });
  });

  it("denies with server-disabled when server.enabled === false", () => {
    const lookup = createPortableMcpFilterLookup(
      config([
        { id: "srv", transport: "stdio", command: "node", enabled: false },
      ]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: false, reason: "server-disabled" });
  });

  it("denies with tool-disabled when toolName is in disabledTools", () => {
    const lookup = createPortableMcpFilterLookup(
      config([
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          disabledTools: ["tool_a"],
        },
      ]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: false, reason: "tool-disabled" });
  });

  it("denies with tool-not-in-allowlist when enabledTools is non-empty and toolName not listed", () => {
    const lookup = createPortableMcpFilterLookup(
      config([
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          enabledTools: ["tool_a"],
        },
      ]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_b",
      }),
    ).toEqual({ allowed: false, reason: "tool-not-in-allowlist" });
  });

  it("allows toolName present in enabledTools allowlist", () => {
    const lookup = createPortableMcpFilterLookup(
      config([
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          enabledTools: ["tool_a"],
        },
      ]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: true });
  });

  it("reflects live updates to the backing portable config", () => {
    let current: PortableMcpConfig | null = {
      servers: [{ id: "srv", transport: "stdio", command: "node" }],
    };
    const lookup = createPortableMcpFilterLookup(() => current);

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: true });

    current = {
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          disabledTools: ["tool_a"],
        },
      ],
    };

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: false, reason: "tool-disabled" });
  });

  it("allows when config is null (no emitted set yet)", () => {
    const lookup = createPortableMcpFilterLookup(() => null);

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows tools for servers that are not present in the config (out-of-scope)", () => {
    const lookup = createPortableMcpFilterLookup(
      config([{ id: "other", transport: "stdio", command: "node" }]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: true });
  });

  it("disabledTools takes precedence over enabledTools if both list the tool", () => {
    const lookup = createPortableMcpFilterLookup(
      config([
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          enabledTools: ["tool_a"],
          disabledTools: ["tool_a"],
        },
      ]),
    );

    expect(
      lookup.isToolAllowed({
        conversationId: "c1",
        serverKey: "srv",
        toolName: "tool_a",
      }),
    ).toEqual({ allowed: false, reason: "tool-disabled" });
  });
});
