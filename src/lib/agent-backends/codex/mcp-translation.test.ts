import { describe, it, expect } from "vitest";
import {
  translatePortableMcpToCodex,
  translatePortableMcpToAnthropic,
} from "./mcp-translation";
import type { PortableMcpConfig } from "../portable-mcp";

describe("translatePortableMcpToCodex", () => {
  it("maps stdio server with all fields", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "my-server",
          transport: "stdio",
          command: "node",
          args: ["server.js", "--port", "3000"],
          env: { MY_KEY: "val" },
          cwd: "/tmp/workspace",
          enabled: true,
          enabledTools: ["tool1", "tool2"],
          disabledTools: ["bad-tool"],
          startupTimeoutSec: 30,
          toolTimeoutSec: 60,
        },
      ],
    };

    const { mcpServers, droppedFields } = translatePortableMcpToCodex(config);

    expect(mcpServers["my-server"]).toEqual({
      command: "node",
      args: ["server.js", "--port", "3000"],
      env: { MY_KEY: "val" },
      cwd: "/tmp/workspace",
      enabled: true,
      enabled_tools: ["tool1", "tool2"],
      disabled_tools: ["bad-tool"],
      startup_timeout_sec: 30,
      tool_timeout_sec: 60,
    });
    expect(droppedFields).toEqual([]);
  });

  it("maps streamable-http server with all fields", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "http-server",
          transport: "streamable-http",
          url: "https://mcp.example.com/v1",
          headers: { Authorization: "Bearer token" },
          bearerTokenEnvVar: "MY_API_KEY",
          enabled: false,
          enabledTools: ["search"],
          disabledTools: [],
          startupTimeoutSec: 10,
          toolTimeoutSec: 20,
        },
      ],
    };

    const { mcpServers, droppedFields } = translatePortableMcpToCodex(config);

    expect(mcpServers["http-server"]).toEqual({
      url: "https://mcp.example.com/v1",
      http_headers: { Authorization: "Bearer token" },
      bearer_token_env_var: "MY_API_KEY",
      enabled: false,
      enabled_tools: ["search"],
      disabled_tools: [],
      startup_timeout_sec: 10,
      tool_timeout_sec: 20,
    });
    expect(droppedFields).toEqual([]);
  });

  it("maps mixed stdio and streamable-http configs", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "stdio-server",
          transport: "stdio",
          command: "python",
          args: ["-m", "my_mcp"],
        },
        {
          id: "http-server",
          transport: "streamable-http",
          url: "https://api.example.com/mcp",
        },
      ],
    };

    const { mcpServers } = translatePortableMcpToCodex(config);

    expect(Object.keys(mcpServers)).toEqual(["stdio-server", "http-server"]);
    expect(mcpServers["stdio-server"]).toMatchObject({ command: "python" });
    expect(mcpServers["http-server"]).toMatchObject({
      url: "https://api.example.com/mcp",
    });
  });

  it("returns empty mcpServers for empty config", () => {
    const { mcpServers, droppedFields } = translatePortableMcpToCodex({
      servers: [],
    });
    expect(mcpServers).toEqual({});
    expect(droppedFields).toEqual([]);
  });

  it("only includes present (non-undefined) fields in output", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "minimal",
          transport: "stdio",
          command: "my-cmd",
        },
      ],
    };

    const { mcpServers } = translatePortableMcpToCodex(config);
    const entry = mcpServers["minimal"] as Record<string, unknown>;

    expect(entry).toHaveProperty("command", "my-cmd");
    expect(entry).not.toHaveProperty("args");
    expect(entry).not.toHaveProperty("env");
    expect(entry).not.toHaveProperty("cwd");
    expect(entry).not.toHaveProperty("enabled");
    expect(entry).not.toHaveProperty("enabled_tools");
    expect(entry).not.toHaveProperty("disabled_tools");
    expect(entry).not.toHaveProperty("startup_timeout_sec");
    expect(entry).not.toHaveProperty("tool_timeout_sec");
  });

  it("only includes present (non-undefined) fields for streamable-http", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "minimal-http",
          transport: "streamable-http",
          url: "https://example.com/mcp",
        },
      ],
    };

    const { mcpServers } = translatePortableMcpToCodex(config);
    const entry = mcpServers["minimal-http"] as Record<string, unknown>;

    expect(entry).toHaveProperty("url", "https://example.com/mcp");
    expect(entry).not.toHaveProperty("http_headers");
    expect(entry).not.toHaveProperty("bearer_token_env_var");
    expect(entry).not.toHaveProperty("enabled");
    expect(entry).not.toHaveProperty("enabled_tools");
    expect(entry).not.toHaveProperty("disabled_tools");
    expect(entry).not.toHaveProperty("startup_timeout_sec");
    expect(entry).not.toHaveProperty("tool_timeout_sec");
  });

  it("keys output record by server.id", () => {
    const config: PortableMcpConfig = {
      servers: [
        { id: "server-alpha", transport: "stdio", command: "alpha" },
        { id: "server-beta", transport: "stdio", command: "beta" },
      ],
    };

    const { mcpServers } = translatePortableMcpToCodex(config);

    expect(mcpServers).toHaveProperty("server-alpha");
    expect(mcpServers).toHaveProperty("server-beta");
    expect(
      (mcpServers["server-alpha"] as Record<string, unknown>).command,
    ).toBe("alpha");
    expect((mcpServers["server-beta"] as Record<string, unknown>).command).toBe(
      "beta",
    );
  });
});

describe("translatePortableMcpToAnthropic", () => {
  it("maps stdio server to Anthropic process transport", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "stdio-mcp",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "secret" },
        },
      ],
    };

    const { servers, rejectedServers, rejectedFields } =
      translatePortableMcpToAnthropic(config);

    expect(servers["stdio-mcp"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "secret" },
    });
    expect(rejectedServers).toEqual([]);
    expect(rejectedFields).toEqual([]);
  });

  it("maps minimal stdio server without optional fields", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "minimal-stdio",
          transport: "stdio",
          command: "my-server",
        },
      ],
    };

    const { servers } = translatePortableMcpToAnthropic(config);

    expect(servers["minimal-stdio"]).toEqual({
      type: "stdio",
      command: "my-server",
    });
  });

  it("maps streamable-http server to Anthropic HTTP transport", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "http-mcp",
          transport: "streamable-http",
          url: "https://example.com/mcp",
          headers: { "X-API-Key": "key123" },
        },
      ],
    };

    const { servers, rejectedServers, rejectedFields } =
      translatePortableMcpToAnthropic(config);

    expect(servers["http-mcp"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-API-Key": "key123" },
    });
    expect(rejectedServers).toEqual([]);
    expect(rejectedFields).toEqual([]);
  });

  it("maps minimal streamable-http server without optional headers", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "minimal-http",
          transport: "streamable-http",
          url: "https://example.com/mcp",
        },
      ],
    };

    const { servers } = translatePortableMcpToAnthropic(config);

    expect(servers["minimal-http"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
  });

  it("rejects stdio servers with Claude-unsupported fields", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "full-server",
          transport: "stdio",
          command: "my-server",
          cwd: "/workspace",
          enabledTools: ["tool1"],
          disabledTools: ["tool2"],
          startupTimeoutSec: 10,
          toolTimeoutSec: 20,
        },
      ],
    };

    const { servers, rejectedServers, rejectedFields, errorsByServer } =
      translatePortableMcpToAnthropic(config);

    expect(servers).not.toHaveProperty("full-server");
    expect(rejectedServers).toEqual(["full-server"]);
    expect(rejectedFields).toContain("full-server.cwd");
    expect(rejectedFields).toContain("full-server.enabledTools");
    expect(rejectedFields).toContain("full-server.disabledTools");
    expect(rejectedFields).toContain("full-server.startupTimeoutSec");
    expect(rejectedFields).toContain("full-server.toolTimeoutSec");
    expect(errorsByServer["full-server"]).toContain("full-server.cwd");
  });

  it("rejects streamable-http servers with bearerTokenEnvVar for Claude", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "http-auth",
          transport: "streamable-http",
          url: "https://example.com/mcp",
          bearerTokenEnvVar: "MY_TOKEN",
        },
      ],
    };

    const { servers, rejectedServers, rejectedFields } =
      translatePortableMcpToAnthropic(config);

    expect(servers).not.toHaveProperty("http-auth");
    expect(rejectedServers).toEqual(["http-auth"]);
    expect(rejectedFields).toContain("http-auth.bearerTokenEnvVar");
  });

  it("reports rejected fields for unsupported streamable-http options", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "http-full",
          transport: "streamable-http",
          url: "https://example.com",
          enabledTools: ["search"],
          disabledTools: ["restricted"],
          startupTimeoutSec: 15,
          toolTimeoutSec: 30,
        },
      ],
    };

    const { rejectedFields } = translatePortableMcpToAnthropic(config);

    expect(rejectedFields).toContain("http-full.enabledTools");
    expect(rejectedFields).toContain("http-full.disabledTools");
    expect(rejectedFields).toContain("http-full.startupTimeoutSec");
    expect(rejectedFields).toContain("http-full.toolTimeoutSec");
  });

  it("rejects entire server for unrecognized transport, recording in rejectedServers", () => {
    const config = {
      servers: [
        {
          id: "unknown-transport",
          transport: "sse",
          url: "https://example.com/sse",
        },
      ],
    } as unknown as PortableMcpConfig;

    const { servers, rejectedServers } =
      translatePortableMcpToAnthropic(config);

    expect(servers).not.toHaveProperty("unknown-transport");
    expect(rejectedServers).toContain("unknown-transport");
  });

  it("tracks rejected fields per server", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "server-a",
          transport: "stdio",
          command: "a",
          cwd: "/a",
          enabledTools: ["t1"],
        },
        {
          id: "server-b",
          transport: "stdio",
          command: "b",
          cwd: "/b",
          enabledTools: ["t2"],
        },
      ],
    };

    const { rejectedFields } = translatePortableMcpToAnthropic(config);

    expect(rejectedFields).toContain("server-a.cwd");
    expect(rejectedFields).toContain("server-a.enabledTools");
    expect(rejectedFields).toContain("server-b.cwd");
    expect(rejectedFields).toContain("server-b.enabledTools");
  });

  it("skips servers with enabled=false", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "enabled-server",
          transport: "stdio",
          command: "active",
        },
        {
          id: "disabled-server",
          transport: "stdio",
          command: "inactive",
          enabled: false,
        },
      ],
    };

    const { servers } = translatePortableMcpToAnthropic(config);

    expect(servers).toHaveProperty("enabled-server");
    expect(servers).not.toHaveProperty("disabled-server");
  });

  it("returns empty servers for empty config", () => {
    const { servers, rejectedServers, rejectedFields } =
      translatePortableMcpToAnthropic({ servers: [] });

    expect(servers).toEqual({});
    expect(rejectedServers).toEqual([]);
    expect(rejectedFields).toEqual([]);
  });
});
