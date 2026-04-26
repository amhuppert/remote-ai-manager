import { describe, expect, it } from "vitest";

import { translatePortableMcpToClaude } from "./mcp-translation";
import type { PortableMcpConfig } from "./portable-mcp";

describe("translatePortableMcpToClaude — conversation-level tool disable on HTTP", () => {
  it("emits permission_policy: 'always_deny' for tools listed in disabledTools on a streamable-http server", () => {
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
      tools: [{ name: "resolve-library-id", permission_policy: "always_deny" }],
    });
  });
});
