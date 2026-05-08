import { describe, expect, it, vi } from "vitest";

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";

import { createResolvePortableForConversation } from "./resolve-portable-for-conversation";

const TRANSIENT_PORTABLE: PortableMcpConfig = {
  servers: [
    {
      id: "cc-graph-workflow",
      transport: "streamable-http",
      url: "https://example.test/graph",
      headers: {},
    },
  ],
};

const RESOLVED_PORTABLE: PortableMcpConfig = {
  servers: [
    {
      id: "cc-graph-workflow",
      transport: "streamable-http",
      url: "https://example.test/graph",
      headers: {},
    },
    {
      id: "cc-session-tools",
      transport: "streamable-http",
      url: "https://example.test/session",
      headers: {},
    },
  ],
};

const FALLBACK_PORTABLE: PortableMcpConfig = {
  servers: [
    {
      id: "cc-session-tools",
      transport: "streamable-http",
      url: "https://example.test/session",
      headers: {},
    },
  ],
};

describe("createResolvePortableForConversation", () => {
  it("forwards conversation runtime tooling as transientPortableMcp to the composer", async () => {
    const compose = vi.fn().mockResolvedValue(RESOLVED_PORTABLE);
    const tooling: ConversationToolingOverrides = {
      portableMcp: TRANSIENT_PORTABLE,
    };

    const resolve = createResolvePortableForConversation({
      composePortableForConversation: compose,
      getSessionWorktreePath: async () => "/path/to/session",
      getProjectDisplayName: () => "demo",
      getConversationTooling: () => tooling,
    });

    const result = await resolve({
      projectPath: "/path/to/project",
      sessionName: "session-a",
      conversationId: "conv-1",
      backend: "claude",
    });

    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "claude",
        projectPath: "/path/to/project",
        projectName: "demo",
        sessionName: "session-a",
        conversationId: "conv-1",
        worktreePath: "/path/to/session",
        transientPortableMcp: TRANSIENT_PORTABLE,
      }),
    );
    expect(result.portable).toBe(RESOLVED_PORTABLE);
  });

  it("omits transientPortableMcp when no conversation tooling is registered", async () => {
    const compose = vi.fn().mockResolvedValue(FALLBACK_PORTABLE);

    const resolve = createResolvePortableForConversation({
      composePortableForConversation: compose,
      getSessionWorktreePath: async () => "/path/to/session",
      getProjectDisplayName: () => "demo",
      getConversationTooling: () => undefined,
    });

    await resolve({
      projectPath: "/path/to/project",
      sessionName: "session-a",
      conversationId: "conv-1",
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
      getProjectDisplayName: () => "demo",
      getConversationTooling: () => undefined,
    });

    await resolve({
      projectPath: "/path/to/project",
      sessionName: "session-a",
      conversationId: "conv-1",
      backend: "claude",
    });

    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "/path/to/project" }),
    );
  });
});
