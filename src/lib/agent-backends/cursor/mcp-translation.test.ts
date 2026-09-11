import { describe, expect, it } from "vitest";
import type { PortableMcpServerConfig } from "../portable-mcp";
import {
  CURSOR_MCP_MAX_ENV_ENTRIES,
  CURSOR_MCP_MAX_ENV_VALUE_LENGTH,
  translatePortableMcpToCursor,
} from "./mcp-translation";

/**
 * The portable→SDK inline stdio translation (spec D18).
 *
 * Every case here is a claim about what the worker — and therefore the SDK —
 * is allowed to receive: which servers the cascade admits, which fields the
 * Phase 1 inline path can express, and what happens to the ones it cannot.
 */

function stdio(
  overrides: Partial<Extract<PortableMcpServerConfig, { transport: "stdio" }>> &
    Pick<PortableMcpServerConfig, "id">,
): PortableMcpServerConfig {
  return {
    transport: "stdio",
    command: "node",
    ...overrides,
  };
}

describe("translatePortableMcpToCursor — stdio entries", () => {
  it("maps command, args, env, and cwd onto the SDK inline stdio entry", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({
          id: "fixture",
          command: "/usr/bin/node",
          args: ["server.mjs", "--marker", "abc"],
          env: { FIXTURE_MARKER: "abc" },
          cwd: "/repo/.worktrees/s1",
        }),
      ],
    });

    expect(result.servers).toEqual({
      fixture: {
        command: "/usr/bin/node",
        args: ["server.mjs", "--marker", "abc"],
        env: { FIXTURE_MARKER: "abc" },
        cwd: "/repo/.worktrees/s1",
      },
    });
    expect(result.rejectedServers).toEqual([]);
    expect(result.errorsByServer).toEqual({});
  });

  it("emits explicit empty args and env rather than leaving them for the SDK to infer", () => {
    const result = translatePortableMcpToCursor({
      servers: [stdio({ id: "bare", command: "bare-server" })],
    });

    expect(result.servers.bare).toEqual({
      command: "bare-server",
      args: [],
      env: {},
    });
    // Absent, not `undefined`: the wire schema rejects an explicit undefined.
    expect(Object.keys(result.servers.bare ?? {})).toEqual([
      "command",
      "args",
      "env",
    ]);
  });

  it("returns an empty map for an empty portable config", () => {
    const result = translatePortableMcpToCursor({ servers: [] });

    expect(result.servers).toEqual({});
    expect(result.rejectedServers).toEqual([]);
    expect(result.rejectedFields).toEqual([]);
    expect(result.errorsByServer).toEqual({});
  });
});

describe("translatePortableMcpToCursor — enable/disable cascade", () => {
  it("omits a disabled server from the SDK config without reporting it as a failure", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({ id: "kept", enabled: true }),
        stdio({ id: "dropped", enabled: false }),
      ],
    });

    expect(Object.keys(result.servers)).toEqual(["kept"]);
    expect(result.rejectedServers).toEqual([]);
    expect(result.errorsByServer).toEqual({});
  });

  it("keeps a server whose enabled flag the cascade never set", () => {
    const result = translatePortableMcpToCursor({
      servers: [stdio({ id: "unset" })],
    });

    expect(Object.keys(result.servers)).toEqual(["unset"]);
  });
});

describe("translatePortableMcpToCursor — fields the inline path cannot express", () => {
  it("carries allow and deny filters to the enforcing worker bridge", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({ id: "filtered", disabledTools: ["dangerous"] }),
        stdio({ id: "allowlisted", enabledTools: ["safe"] }),
      ],
    });

    expect(result.servers.filtered).toMatchObject({
      disabledTools: ["dangerous"],
    });
    expect(result.servers.allowlisted).toMatchObject({
      enabledTools: ["safe"],
    });
    expect(result.rejectedServers).toEqual([]);
  });

  it("treats an empty tool filter as no restriction", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({ id: "unfiltered", enabledTools: [], disabledTools: [] }),
      ],
    });

    expect(Object.keys(result.servers)).toEqual(["unfiltered"]);
    expect(result.rejectedFields).toEqual([]);
  });

  it("carries startup and tool deadlines to the worker bridge", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({ id: "timed", startupTimeoutSec: 30, toolTimeoutSec: 60 }),
      ],
    });

    expect(result.servers.timed).toMatchObject({
      startupTimeoutSec: 30,
      toolTimeoutSec: 60,
    });
    expect(result.rejectedFields).toEqual([]);
  });

  it("translates remote HTTP headers without dropping restrictions", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        {
          id: "remote",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer fixture-secret" },
          disabledTools: ["write"],
        },
      ],
    });

    expect(result.servers.remote).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      disabledTools: ["write"],
    });
    expect(result.rejectedServers).toEqual([]);
  });
});

describe("translatePortableMcpToCursor — bounded environment values", () => {
  it("refuses a server whose environment value exceeds the bound without echoing the value", () => {
    const secret = "s".repeat(CURSOR_MCP_MAX_ENV_VALUE_LENGTH + 1);
    const result = translatePortableMcpToCursor({
      servers: [stdio({ id: "oversized", env: { BIG: secret } })],
    });

    expect(result.servers).toEqual({});
    expect(result.rejectedServers).toEqual(["oversized"]);
    const error = result.errorsByServer.oversized ?? "";
    expect(error).toContain("BIG");
    expect(error).not.toContain(secret);
  });

  it("refuses a server carrying more environment entries than the bound admits", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i <= CURSOR_MCP_MAX_ENV_ENTRIES; i += 1)
      env[`VAR_${i}`] = "v";
    const result = translatePortableMcpToCursor({
      servers: [stdio({ id: "crowded", env })],
    });

    expect(result.servers).toEqual({});
    expect(result.errorsByServer.crowded).toContain(
      String(CURSOR_MCP_MAX_ENV_ENTRIES),
    );
  });

  it("accepts an environment sitting exactly on the bounds", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({
          id: "edge",
          env: { EDGE: "e".repeat(CURSOR_MCP_MAX_ENV_VALUE_LENGTH) },
        }),
      ],
    });

    expect(Object.keys(result.servers)).toEqual(["edge"]);
  });
});

describe("translatePortableMcpToCursor — duplicate ids", () => {
  it("refuses all entries sharing an id so duplicate order cannot choose permissions", () => {
    const result = translatePortableMcpToCursor({
      servers: [
        stdio({ id: "same", command: "first" }),
        stdio({ id: "same", command: "second" }),
      ],
    });

    expect(result.servers).toEqual({});
    expect(result.rejectedServers).toEqual(["same"]);
    expect(result.errorsByServer.same).toMatch(/duplicate/i);
  });
});

describe("Cursor MCP authentication", () => {
  it("resolves bearer credentials before the worker environment is scrubbed", () => {
    const result = translatePortableMcpToCursor(
      {
        servers: [
          {
            id: "remote",
            transport: "streamable-http",
            url: "https://example.test/mcp",
            bearerTokenEnvVar: "MCP_TOKEN",
          },
        ],
      },
      { MCP_TOKEN: "fixture-secret" },
    );
    expect(result.servers.remote).toMatchObject({
      headers: { authorization: "Bearer fixture-secret" },
    });
  });
  it("refuses a missing bearer credential instead of connecting anonymously", () => {
    const result = translatePortableMcpToCursor(
      {
        servers: [
          {
            id: "remote",
            transport: "streamable-http",
            url: "https://example.test/mcp",
            bearerTokenEnvVar: "MCP_TOKEN",
          },
        ],
      },
      {},
    );
    expect(result.servers).toEqual({});
    expect(result.errorsByServer.remote).toContain("MCP_TOKEN");
  });
});
