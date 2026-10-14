import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { describe, expect, it, vi } from "vitest";

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";

import { createResolvePortableForConversation } from "./resolve-portable-for-conversation";

const FALLBACK_PORTABLE: PortableMcpConfig = {
  servers: [
    {
      id: "gateway-alpha",
      transport: "streamable-http",
      url: "https://example.test/session",
      headers: {},
    },
  ],
};

describe("createResolvePortableForConversation", () => {
  it("omits transientPortableMcp when no conversation tooling is registered", async () => {
    const compose = vi.fn().mockResolvedValue(FALLBACK_PORTABLE);

    const resolve = createResolvePortableForConversation({
      composePortableForConversation: compose,
      getSessionWorktreePath: async () => "/path/to/session",
    });

    await resolve({
      projectPath: "/path/to/project",
      target: sessionConversationTarget("demo", "session-a", "conv-1"),
      backend: "claude",
    });

    const call = compose.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("transientPortableMcp");
  });

  it("falls back to projectPath when no session worktreePath is found", async () => {
    const compose = vi.fn().mockResolvedValue(FALLBACK_PORTABLE);

    const resolve = createResolvePortableForConversation({
      composePortableForConversation: compose,
      getSessionWorktreePath: async () => undefined,
    });

    await resolve({
      projectPath: "/path/to/project",
      target: sessionConversationTarget("demo", "session-a", "conv-1"),
      backend: "claude",
    });

    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "/path/to/project" }),
    );
  });
});
