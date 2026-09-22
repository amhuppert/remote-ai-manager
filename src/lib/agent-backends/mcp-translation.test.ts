import { describe, expect, it } from "vitest";

import { translatePortableMcpToClaude } from "./mcp-translation";
import type { PortableMcpConfig } from "./portable-mcp";

describe("translatePortableMcpToClaude — conversation-level tool disable on HTTP", () => {
  it("delivers HTTP server config without unreliable permission policies", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "context7",
          transport: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          disabledTools: ["resolve-library-id"],
        },
      ],
    };

    const { servers, rejectedServers } = translatePortableMcpToClaude(config);

    expect(rejectedServers).toEqual([]);
    expect(servers["context7"]).toBeDefined();
    expect(servers["context7"]).toMatchObject({
      type: "http",
      url: "https://mcp.context7.com/mcp",
    });
  });
});

describe("Claude available delivery with partial settings support", () => {
  it("keeps a usable server when only startup timing or an allowlist cannot be applied", () => {
    const result = translatePortableMcpToClaude({
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "node",
          startupTimeoutSec: 5,
          enabledTools: ["read"],
          toolTimeoutSec: 12,
        },
      ],
    });
    expect(result.servers.srv).toEqual({
      type: "stdio",
      command: "node",
      timeout: 12000,
    });
    expect(result.rejectedServers).toEqual([]);
    expect(result.rejectedFields).toEqual(
      expect.arrayContaining(["srv.startupTimeoutSec", "srv.enabledTools"]),
    );
  });
});
