import { afterEach, describe, expect, it } from "vitest";
import type { ConversationBackendFactory, ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import { computeCascadeRuntimeHash, seedRuntimeApplicationState } from "@/lib/agent-capabilities/runtime-hashes";
import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityCascadeKind,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  makeConversationState,
  type ConversationStateOverrides,
} from "@/lib/conversations/testing/conversation-state-fixture";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import { createMcpRuntimeApplicationStore, createMcpRuntimeApplyService } from "@/lib/mcp/runtime-apply";
import type { McpConfigUpdatedEvent } from "@/lib/mcp/schemas";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { createPersistenceFixture, type PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createAffectedConversationLister } from "@/lib/agent-capabilities/default-deps";
import { collectRuntimeTargets } from "@/lib/mcp/runtime-targets";
import { coreRuntimeIndex, createRuntimeApplicationState, withCoreRuntimes } from "./runtime-application-state";
import { createRuntimeHost } from "./runtime-host";

const PROJECT = "/repo";
const SESSION = "session";
const conversation = { projectPath: PROJECT, target: sessionConversationTarget("repo", SESSION, "conv-1") };
const acceptsOnInput = { mcpConfigDelivery: "input-accepted", capabilityConfigDelivery: "input-accepted" } as const;

function portable(...ids: string[]): PortableMcpConfig {
  return { servers: ids.map((id) => ({ id, transport: "stdio" as const, command: "/bin/true" })) };
}
const H1 = portable("docs");
const H2 = portable("docs", "x");
const H3 = portable("docs", "x", "z");

function cascade(
  backend: "claude" | "cursor",
  items: Array<{ itemId: string; enabled: boolean }>,
): ResolvedCapabilityCascade {
  return {
    backend,
    kinds: [
      {
        kind: "skills",
        items: [
          ...items.map((item) => ({ ...item, originLayer: "conversation" as const })),
          { itemId: "native-default", enabled: true, originLayer: "native" as const },
        ],
      },
    ],
  };
}

/** The baseline the conversation-start composer emits for one cascade's desired rows. */
function desiredState(
  cascadeKind: AgentCapabilityCascadeKind,
  items: Array<{ itemId: string; enabled: boolean }>,
): AgentCapabilityRuntimeApplicationState {
  return seedRuntimeApplicationState([
    {
      cascadeKind,
      pendingHash: computeCascadeRuntimeHash({ cascadeKind, rows: items }),
      pendingItemIds: items.map((item) => item.itemId),
      lastApplyStatus: "staged-next-turn",
    },
  ]);
}

const reviewOff = [{ itemId: "review", enabled: false }];

let fixture: PersistenceFixture;
afterEach(() => fixture.close());

async function harness(row: ConversationStateOverrides = {}) {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await fixture.seedConversation(PROJECT, SESSION, makeConversationState({ id: "conv-1", ...row }));
  const published: Array<McpConfigUpdatedEvent | AgentCapabilitiesUpdatedEvent> = [];
  const state = createRuntimeApplicationState({
    conversations: fixture.deps,
    publish: (event) => published.push(event),
    log: createCapturingLogger(),
  });
  // A fresh store over the same database: what a restarted server reads.
  const reload = async () => {
    const row = await fixture.recreateStore().getConversation(PROJECT, SESSION, "conv-1");
    if (row === null) throw new Error("conversation vanished");
    return row;
  };
  return { state, published, reload };
}

describe("core runtime application state", () => {
  it("records a runtime's MCP config and capabilities as applied once the backend accepts input under them", async () => {
    const h = await harness();
    await h.state.seed(
      conversation,
      { overrides: { portableMcp: H1, capabilities: cascade("claude", reviewOff) }, capabilityState: desiredState("claude-skills", reviewOff) },
      acceptsOnInput,
    );

    const seeded = await h.reload();
    expect(seeded.mcpRuntime).toEqual({
      pendingConfigHash: computeEffectiveConfigHash(H1),
      lastApplyDisposition: "deferred_to_next_turn",
    });
    expect(seeded.agentCapabilitiesRuntime?.cascades["claude-skills"]?.lastApplyStatus).toBe("staged-next-turn");

    await h.state.recordAccepted(conversation, {
      type: "input_accepted",
      mcpConfigHash: computeEffectiveConfigHash(H1),
      capabilities: cascade("claude", reviewOff),
    });

    const accepted = await h.reload();
    expect(accepted.mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H1),
      lastApplyDisposition: "applied_now",
    });
    expect(accepted.agentCapabilitiesRuntime?.cascades["claude-skills"]).toEqual({
      appliedHash: computeCascadeRuntimeHash({ cascadeKind: "claude-skills", rows: reviewOff }),
      lastApplyStatus: "applied",
    });
  });

  it("clears an MCP change saved while no runtime ran once the next runtime delivers it", async () => {
    const h = await harness({
      mcpRuntime: {
        lastAppliedConfigHash: computeEffectiveConfigHash(H1),
        pendingConfigHash: computeEffectiveConfigHash(H2),
        pendingServerKeys: ["x"],
        lastApplyDisposition: "no_active_runtime",
      },
    });
    await h.state.seed(conversation, { overrides: { portableMcp: H2 } }, acceptsOnInput);
    await h.state.recordAccepted(conversation, { type: "input_accepted", mcpConfigHash: computeEffectiveConfigHash(H2) });

    expect((await h.reload()).mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H2),
      lastApplyDisposition: "applied_now",
    });
  });

  it("re-baselines a pending change older than the config the runtime was created with", async () => {
    const h = await harness({
      mcpRuntime: {
        pendingConfigHash: computeEffectiveConfigHash(H2),
        pendingServerKeys: ["x"],
        lastApplyDisposition: "no_active_runtime",
      },
    });
    await h.state.seed(conversation, { overrides: { portableMcp: H3 } }, acceptsOnInput);
    expect((await h.reload()).mcpRuntime?.pendingConfigHash).toBe(computeEffectiveConfigHash(H3));

    await h.state.recordAccepted(conversation, { type: "input_accepted", mcpConfigHash: computeEffectiveConfigHash(H3) });
    expect((await h.reload()).mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H3),
      lastApplyDisposition: "applied_now",
    });
  });

  it("keeps a change saved after the runtime was created pending past that runtime's receipt", async () => {
    const h = await harness();
    await h.state.seed(conversation, { overrides: { portableMcp: H1 } }, acceptsOnInput);
    const saved = await createMcpRuntimeApplyService({
      applicationState: createMcpRuntimeApplicationStore(fixture.deps),
      getRuntime: () => undefined,
      resolvePortableForConversation: async () => ({ portable: H2 }),
    }).applyAfterOverrideChange({ ...conversation, backend: "claude", changedServerKeys: ["x"] });

    await h.state.recordAccepted(conversation, { type: "input_accepted", mcpConfigHash: computeEffectiveConfigHash(H1) });

    expect((await h.reload()).mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H1),
      pendingConfigHash: saved.effectiveConfigHash,
      pendingServerKeys: ["x"],
      lastApplyDisposition: "no_active_runtime",
    });
  });

  it("persists an MCP configuration failure the backend reports on acceptance", async () => {
    const h = await harness();
    await h.state.seed(conversation, { overrides: { portableMcp: H2 } }, acceptsOnInput);
    await h.state.recordAccepted(conversation, {
      type: "input_accepted",
      mcpConfigHash: computeEffectiveConfigHash(H1),
      mcpConfigError: "MCP servers could not be configured: x",
    });

    expect((await h.reload()).mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H1),
      pendingConfigHash: computeEffectiveConfigHash(H2),
      lastApplyDisposition: "rejected",
      lastApplyError: "MCP servers could not be configured: x",
    });
  });

  it("marks a selection fixed at creation that differs from the desired one as applying in a new conversation", async () => {
    const h = await harness({ agentBackend: "cursor" });
    const reviewOn = [{ itemId: "review", enabled: true }];
    await h.state.seed(
      conversation,
      { overrides: { portableMcp: H1, capabilities: cascade("cursor", reviewOff) }, capabilityState: desiredState("cursor-skills", reviewOff) },
      { ...acceptsOnInput, capabilitiesAtCreation: cascade("cursor", reviewOn) },
    );
    await h.state.recordAccepted(conversation, {
      type: "input_accepted",
      mcpConfigHash: computeEffectiveConfigHash(H1),
      capabilities: cascade("cursor", reviewOn),
    });

    expect((await h.reload()).agentCapabilitiesRuntime?.cascades["cursor-skills"]).toMatchObject({
      appliedHash: computeCascadeRuntimeHash({ cascadeKind: "cursor-skills", rows: reviewOn }),
      pendingHash: computeCascadeRuntimeHash({ cascadeKind: "cursor-skills", rows: reviewOff }),
      lastApplyStatus: "deferred-next-conversation",
    });
  });

  it("reconciles at creation a runtime that applies its configuration when it is created", async () => {
    const h = await harness();
    await h.state.seed(
      conversation,
      { overrides: { portableMcp: H1 }, capabilityState: desiredState("claude-skills", reviewOff) },
      { capabilitiesAtCreation: cascade("claude", reviewOff) },
    );

    const seeded = await h.reload();
    expect(seeded.mcpRuntime).toEqual({
      lastAppliedConfigHash: computeEffectiveConfigHash(H1),
      lastApplyDisposition: "applied_now",
    });
    expect(seeded.agentCapabilitiesRuntime?.cascades["claude-skills"]?.lastApplyStatus).toBe("applied");
  });

  it("tells clients the conversation's MCP and capability state changed when a receipt is recorded", async () => {
    const h = await harness();
    await h.state.seed(
      conversation,
      { overrides: { portableMcp: H1, capabilities: cascade("claude", reviewOff) }, capabilityState: desiredState("claude-skills", reviewOff) },
      acceptsOnInput,
    );
    expect(h.published).toEqual([]);

    await h.state.recordAccepted(conversation, {
      type: "input_accepted",
      mcpConfigHash: computeEffectiveConfigHash(H1),
      capabilities: cascade("claude", reviewOff),
    });

    expect(h.published).toEqual([
      expect.objectContaining({
        type: "mcp-config-updated",
        level: "conversation",
        target: conversation.target,
        effectiveConfigHash: computeEffectiveConfigHash(H1),
      }),
      expect.objectContaining({
        type: "agent-capabilities-updated",
        conversationId: "conv-1",
        sessionName: SESSION,
        cascadeKind: "claude-skills",
        changedItemIds: ["review"],
      }),
    ]);
  });
});

describe("core runtime index", () => {
  /** A core runtime whose live MCP apply would change the config of the turn it is running. */
  function coreHost() {
    const applied: PortableMcpConfig[] = [];
    const factory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input) {
        let status: "alive" | "dead" = "alive";
        const runtime: ConversationBackendRuntime = {
          backend: "claude",
          get status() {
            return status;
          },
          modelSelection: input.modelSelection,
          async sendTurn() {
            throw new Error("not used");
          },
          async applyPortableMcpConfig(config) {
            applied.push(config);
            return { disposition: "applied_now", droppedServerIds: [], droppedFields: [], errors: {} };
          },
          async close() {
            status = "dead";
          },
        };
        return runtime;
      },
    };
    const host = createRuntimeHost({
      factory: () => factory,
      instructions: async () => ({ sessionInstructions: [], alignmentVersion: null }),
      tooling: async () => ({ overrides: { portableMcp: H1 } }),
      seed: async () => {},
      callbacks: () => ({}),
      index: coreRuntimeIndex,
      log: createCapturingLogger(),
    });
    const obtain = () =>
      host.obtain(
        {
          ...conversation,
          conversationId: "conv-1",
          projectName: "repo",
          worktreePath: "/repo/.worktrees/session",
          backend: "claude",
          executionClass: "ordinary-conversation",
          persistedRef: null,
        },
        { modelSelection: { modelId: "sonnet", parameters: {} }, instructionSelection: { autonomous: false } },
      );
    return { host, obtain, applied };
  }

  const nothingRegistered = (): ConversationBackendRuntime | undefined => undefined;

  it("shows the change-status readers a conversation whose turn holds a core runtime, and only while it does", async () => {
    await harness();
    const core = coreHost();
    const status = withCoreRuntimes(nothingRegistered);
    const listAffected = createAffectedConversationLister({
      listProjectPaths: async () => [PROJECT],
      getProjectSessions: async () => [
        { sessionName: SESSION, worktreePath: "/repo/.worktrees/session", conversations: [makeConversationState({ id: "conv-1" })] },
      ],
      getProjectAgentCapabilityOverrides: async () => undefined,
      readGlobalOverrides: async () => undefined,
      listAllProjectConversations: async () => [],
      getRuntime: status,
      getProjectDisplayName: () => "repo",
    });
    const capabilityChange = {
      scope: { level: "conversation" as const, projectPath: PROJECT, sessionName: SESSION, conversationId: "conv-1" },
      cascadeKind: "claude-skills" as const,
      changedItemIds: ["review"],
    };
    const mcpSave = createMcpRuntimeApplyService({
      applicationState: createMcpRuntimeApplicationStore(fixture.deps),
      getRuntime: status,
      resolvePortableForConversation: async () => ({ portable: H2 }),
    });
    const saveMcp = () => mcpSave.applyAfterOverrideChange({ ...conversation, backend: "claude", changedServerKeys: ["x"] });
    const runtimeTargets = () => collectRuntimeTargets({ conversations: [conversation], getRuntime: status });

    await core.obtain();
    expect(await listAffected(capabilityChange)).toEqual([
      expect.objectContaining({ conversationId: "conv-1", sessionName: SESSION, backend: "claude" }),
    ]);
    expect(runtimeTargets()).toEqual([{ ...conversation, backend: "claude" }]);
    expect((await saveMcp()).disposition).toBe("deferred_to_next_turn");

    await core.host.release("conv-1");
    expect(await listAffected(capabilityChange)).toEqual([]);
    expect(runtimeTargets()).toEqual([]);
    expect((await saveMcp()).disposition).toBe("no_active_runtime");
  });

  it("never lets a turn-start apply act on the runtime a core turn is running", async () => {
    await harness();
    const core = coreHost();
    await core.obtain();
    try {
      const result = await createMcpRuntimeApplyService({
        applicationState: createMcpRuntimeApplicationStore(fixture.deps),
        getRuntime: withCoreRuntimes(nothingRegistered),
        resolvePortableForConversation: async () => ({ portable: H2 }),
      }).applyAtTurnStart({ ...conversation, backend: "claude" });

      expect(result.disposition).toBe("no_active_runtime");
      expect(core.applied).toEqual([]);
    } finally {
      await core.host.release("conv-1");
    }
  });
});
