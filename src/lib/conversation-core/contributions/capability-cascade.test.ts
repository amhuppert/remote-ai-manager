import { describe, it, expect, vi } from "vitest";
import {
  resolveCapabilitySeedForNewRuntime,
  type CapabilityTurnContext,
  type CapabilitySeed,
  type ProjectCapabilitySeed,
} from "./capability-cascade";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeCtx(
  overrides: Partial<CapabilityTurnContext> = {},
): CapabilityTurnContext & { streamErrors: string[] } {
  const streamErrors: string[] = [];
  return {
    projectPath: "/p",
    projectName: "proj",
    sessionName: "s",
    conversationId: "conv-1",
    worktreePath: "/p/.worktrees/s",
    backend: "claude",
    isProjectConversation: false,
    emitStreamError: (message: string) => {
      streamErrors.push(message);
    },
    streamErrors,
    ...overrides,
  };
}

describe("resolveCapabilitySeedForNewRuntime", () => {
  const sessionSeed: CapabilitySeed = {
    capabilities: { backend: "claude", kinds: [] },
    runtimeState: { cascades: {} },
  };

  it("composes the session cascade for a session conversation", async () => {
    const deps = {
      composeCapabilityConfigForConversation: vi.fn(async () => sessionSeed),
      composeCapabilityConfigForProjectConversation: vi.fn(
        async (): Promise<ProjectCapabilitySeed | undefined> => undefined,
      ),
    };
    const ctx = makeCtx();

    const seed = await resolveCapabilitySeedForNewRuntime(deps, ctx);

    expect(seed).toBe(sessionSeed);
    expect(
      deps.composeCapabilityConfigForProjectConversation,
    ).not.toHaveBeenCalled();
    expect(deps.composeCapabilityConfigForConversation).toHaveBeenCalledWith({
      projectPath: "/p",
      projectName: "proj",
      sessionName: "s",
      conversationId: "conv-1",
      worktreePath: "/p/.worktrees/s",
      backend: "claude",
    });
  });

  it("returns undefined and surfaces a non-blocking stream error when project composition throws", async () => {
    const deps = {
      composeCapabilityConfigForConversation: vi.fn(async () => sessionSeed),
      composeCapabilityConfigForProjectConversation: vi.fn(async () => {
        throw new Error("compose boom");
      }),
    };
    const ctx = makeCtx({ isProjectConversation: true });

    const seed = await resolveCapabilitySeedForNewRuntime(deps, ctx);

    expect(seed).toBeUndefined();
    expect(ctx.streamErrors).toEqual([
      "Project conversation capability configuration could not be fully composed: compose boom",
    ]);
    // Project conversations never fall back to the session cascade.
    expect(deps.composeCapabilityConfigForConversation).not.toHaveBeenCalled();
  });
});
