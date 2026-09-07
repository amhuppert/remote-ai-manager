import {
  createActorDependenciesFixture,
  groupActorFixtureDependencies,
} from "../testing/actor-deps-fixture";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { AgentCapabilityRuntimeApplicationState } from "@/lib/agent-capabilities/schemas";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "@/lib/agent-backends/testing/testfake-backend";
import {
  buildCapabilityApplyInput,
  resolveCapabilitySeedForNewRuntime,
  seedRuntimeCapabilityState,
  applyCapabilityCascadeAtTurnStart,
  drainCapabilityWhenIdle,
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

beforeAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
  _registerBackendForTesting(
    createTestFakeBackend({
      capabilities: {
        capabilityKinds: [{ kind: "agents", applyTiming: "idle_live" }],
      },
    }).descriptor,
  );
});

afterAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
});

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

describe("buildCapabilityApplyInput", () => {
  it("addresses the session scope for a session conversation", () => {
    expect(buildCapabilityApplyInput(makeCtx())).toEqual({
      projectPath: "/p",
      projectName: "proj",
      sessionName: "s",
      conversationId: "conv-1",
      worktreePath: "/p/.worktrees/s",
      backend: "claude",
    });
  });

  it("addresses the project scope (session-less) for a project conversation", () => {
    expect(
      buildCapabilityApplyInput(makeCtx({ isProjectConversation: true })),
    ).toEqual({
      conversationScope: "project",
      projectPath: "/p",
      projectName: "proj",
      conversationId: "conv-1",
      worktreePath: "/p/.worktrees/s",
      backend: "claude",
    });
  });
});

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

describe("seedRuntimeCapabilityState", () => {
  it("persists the runtime seed baseline on the conversation", async () => {
    const conversation = conversationStateSchema.parse({
      id: "conv-1",
      transcriptPath: null,
      status: "idle",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    });
    const deps = {
      mutateConversation: vi.fn(
        async (
          _p: string,
          _s: string,
          _c: string,
          _label: string,
          mutate: (c: ConversationState) => void,
        ) => {
          mutate(conversation);
        },
      ),
    };
    const seed: AgentCapabilityRuntimeApplicationState = { cascades: {} };

    await seedRuntimeCapabilityState(
      groupActorFixtureDependencies(createActorDependenciesFixture(deps))
        .policy,
      makeCtx(),
      seed,
    );

    expect(conversation.agentCapabilitiesRuntime).toBe(seed);
  });
});

describe("applyCapabilityCascadeAtTurnStart", () => {
  it("applies with the turn's scope identity", async () => {
    const deps = { applyCapabilityAtTurnStart: vi.fn(async () => ({})) };
    const ctx = makeCtx();

    await applyCapabilityCascadeAtTurnStart(deps, ctx, { isNewRuntime: true });

    expect(deps.applyCapabilityAtTurnStart).toHaveBeenCalledWith(
      buildCapabilityApplyInput(ctx),
    );
  });

  it("never blocks the turn when apply throws", async () => {
    const deps = {
      applyCapabilityAtTurnStart: vi.fn(async () => {
        throw new Error("apply boom");
      }),
    };

    await expect(
      applyCapabilityCascadeAtTurnStart(deps, makeCtx(), {
        isNewRuntime: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("drainCapabilityWhenIdle", () => {
  it("drains staged-idle cascades for a Claude turn", async () => {
    const deps = { applyCapabilityWhenIdle: vi.fn(async () => ({})) };
    const ctx = makeCtx();

    await drainCapabilityWhenIdle(deps, ctx);

    expect(deps.applyCapabilityWhenIdle).toHaveBeenCalledWith(
      buildCapabilityApplyInput(ctx),
    );
  });

  it("no-ops for backends without idle-live-apply semantics", async () => {
    const deps = { applyCapabilityWhenIdle: vi.fn(async () => ({})) };

    await drainCapabilityWhenIdle(deps, makeCtx({ backend: "codex" }));

    expect(deps.applyCapabilityWhenIdle).not.toHaveBeenCalled();
  });

  it("drains a registered backend that declares idle-live apply semantics", async () => {
    const deps = { applyCapabilityWhenIdle: vi.fn(async () => ({})) };
    const ctx = makeCtx({ backend: TESTFAKE_BACKEND_ID });

    await drainCapabilityWhenIdle(deps, ctx);

    expect(deps.applyCapabilityWhenIdle).toHaveBeenCalledWith(
      buildCapabilityApplyInput(ctx),
    );
  });

  it("never rethrows a drain failure", async () => {
    const deps = {
      applyCapabilityWhenIdle: vi.fn(async () => {
        throw new Error("drain boom");
      }),
    };

    await expect(
      drainCapabilityWhenIdle(deps, makeCtx()),
    ).resolves.toBeUndefined();
  });
});
