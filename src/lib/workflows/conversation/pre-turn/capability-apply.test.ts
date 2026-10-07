import {
  createActorDependenciesFixture,
  groupActorFixtureDependencies,
} from "../testing/actor-deps-fixture";
import { describe, it, expect, vi } from "vitest";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { AgentCapabilityRuntimeApplicationState } from "@/lib/agent-capabilities/schemas";
import type { CapabilityTurnContext } from "@/lib/conversation-core/contributions/capability-cascade";
import {
  buildCapabilityApplyInput,
  seedRuntimeCapabilityState,
  applyCapabilityCascadeAtTurnStart,
} from "./capability-apply";

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
