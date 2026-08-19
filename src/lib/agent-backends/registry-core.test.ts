/**
 * Registry policy contract (design Blocker 4, D-B4.1): production
 * registration is closed at runtime (id-enum check in `registerBackend`),
 * `_registerBackendForTesting` is the one sanctioned bypass, the registry is
 * explicitly resettable, and `bootstrapBackends()` is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backendConversationCapabilitiesIntegritySchema,
  backendMetadataIntegritySchema,
  getBackendDescriptor,
  listBackends,
  prepareManagedSkillsCheckout,
  registerBackend,
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "./registry-core";
import { bootstrapBackends } from "./registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "./testing/testfake-backend";
import type { AgentBackendDescriptor } from "./descriptor";

describe("registry-core backend registration policy", () => {
  beforeEach(() => {
    _resetBackendRegistryForTesting();
  });

  afterEach(() => {
    _resetBackendRegistryForTesting();
    bootstrapBackends();
  });

  it("registerBackend rejects an id outside the canonical backend enum at runtime", () => {
    const fake = createTestFakeBackend();
    expect(() => registerBackend(fake.descriptor)).toThrow(
      /not a member of the canonical backend enum/,
    );
    expect(() => getBackendDescriptor(TESTFAKE_BACKEND_ID)).toThrow(
      /No backend descriptor registered/,
    );
  });

  it("registerBackend rejects a duplicate id", () => {
    bootstrapBackends();
    const [first] = listBackends();
    expect(first).toBeDefined();
    expect(() => registerBackend(first!)).toThrow(/already registered/);
  });

  it("registerBackend rejects a descriptor with neither execution facet", () => {
    bootstrapBackends();
    const claude = getBackendDescriptor("claude");
    const facetless = {
      ...claude,
      conversation: undefined,
      tasks: undefined,
    };
    _resetBackendRegistryForTesting();
    expect(() => registerBackend(facetless)).toThrow(
      /declares no execution facet/,
    );
  });

  it("_registerBackendForTesting accepts the testfake descriptor and exposes it through the read surface", () => {
    const fake = createTestFakeBackend();
    _registerBackendForTesting(fake.descriptor);

    expect(getBackendDescriptor(TESTFAKE_BACKEND_ID)).toBe(fake.descriptor);
    expect(listBackends()).toContain(fake.descriptor);
  });

  it("_resetBackendRegistryForTesting empties the registry", () => {
    bootstrapBackends();
    expect(getBackendDescriptor("claude").id).toBe("claude");

    _resetBackendRegistryForTesting();

    expect(() => getBackendDescriptor("claude")).toThrow(
      /No backend descriptor registered/,
    );
    expect(listBackends()).toEqual([]);
  });

  it("rejects a descriptor whose continuity adapter claims a different backend id", () => {
    const fake = createTestFakeBackend();
    const conversation = fake.descriptor.conversation!;
    const lying: AgentBackendDescriptor = {
      ...fake.descriptor,
      conversation: {
        ...conversation,
        continuity: { ...conversation.continuity, backend: "claude" },
      },
    };
    expect(() => _registerBackendForTesting(lying)).toThrow(
      /conversation\.continuity/,
    );
  });

  it("rejects a descriptor whose runtime-config adapter claims a different backend id", () => {
    const fake = createTestFakeBackend();
    const conversation = fake.descriptor.conversation!;
    const lying: AgentBackendDescriptor = {
      ...fake.descriptor,
      conversation: {
        ...conversation,
        runtimeConfig: { ...conversation.runtimeConfig, backend: "codex" },
      },
    };
    expect(() => _registerBackendForTesting(lying)).toThrow(
      /conversation\.runtimeConfig/,
    );
  });

  it("rejects a descriptor whose conversation factory claims a different backend id", () => {
    const fake = createTestFakeBackend();
    const conversation = fake.descriptor.conversation!;
    const lying: AgentBackendDescriptor = {
      ...fake.descriptor,
      conversation: {
        ...conversation,
        factory: { ...conversation.factory, backend: "claude" },
      },
    };
    expect(() => _registerBackendForTesting(lying)).toThrow(
      /conversation\.factory/,
    );
  });

  it("rejects a descriptor whose task runner claims a different backend id", () => {
    const fake = createTestFakeBackend();
    const lying: AgentBackendDescriptor = {
      ...fake.descriptor,
      tasks: {
        ...fake.descriptor.tasks!,
        runner: { ...fake.descriptor.tasks!.runner, backend: "claude" },
      },
    };
    expect(() => _registerBackendForTesting(lying)).toThrow(/tasks\.runner/);
  });

  it("rejects a descriptor whose MCP facet claims a different backend id", () => {
    const fake = createTestFakeBackend();
    const lying: AgentBackendDescriptor = {
      ...fake.descriptor,
      mcp: { ...fake.descriptor.mcp, backend: "codex" },
    };
    expect(() => _registerBackendForTesting(lying)).toThrow(/mcp/);
  });

  it("rejects duplicate capability-kind declarations", () => {
    const fake = createTestFakeBackend({
      capabilities: {
        capabilityKinds: [
          { kind: "agents", applyTiming: "next_turn" },
          { kind: "agents", applyTiming: "idle_live" },
        ],
      },
    });
    expect(() => _registerBackendForTesting(fake.descriptor)).toThrow(
      /duplicate capability kind/i,
    );
  });

  it("rejects a blank tone token", () => {
    const fake = createTestFakeBackend({ metadata: { toneToken: "   " } });
    expect(() => _registerBackendForTesting(fake.descriptor)).toThrow(
      /metadata/,
    );
  });

  it("rejects an empty model catalog", () => {
    const fake = createTestFakeBackend({
      metadata: { models: [], defaultModelId: "fake-1" },
    });
    expect(() => _registerBackendForTesting(fake.descriptor)).toThrow(
      /metadata/,
    );
  });

  it("accepts the coherent production descriptors and the coherent testfake", () => {
    bootstrapBackends();
    expect(listBackends().map((d) => d.id)).toEqual(["claude", "codex"]);
    const fake = createTestFakeBackend();
    _registerBackendForTesting(fake.descriptor);
    expect(getBackendDescriptor(TESTFAKE_BACKEND_ID)).toBe(fake.descriptor);
  });

  it("bootstrapBackends is idempotent and registers each production backend once", () => {
    bootstrapBackends();
    bootstrapBackends();

    const ids = listBackends().map((d) => d.id);
    expect(ids).toEqual(["claude", "codex"]);
    expect(getBackendDescriptor("claude").conversation).toBeDefined();
    expect(getBackendDescriptor("codex").tasks).toBeDefined();
  });

  it("dispatches checkout preparation through registered backend facets", async () => {
    const prepareCheckout = vi.fn(async (_checkoutPath: string) => undefined);
    const fake = createTestFakeBackend();
    const descriptor = {
      ...fake.descriptor,
      managedSkills: {
        conversations: "bundled" as const,
        tasks: "bundled" as const,
        prepareCheckout,
      },
    };
    _registerBackendForTesting(descriptor);

    await prepareManagedSkillsCheckout("/repo/.worktrees/session");

    expect(prepareCheckout).toHaveBeenCalledWith("/repo/.worktrees/session");
  });

  it("registers Codex checkout preparation without leaking it into Claude", () => {
    bootstrapBackends();

    expect(
      getBackendDescriptor("codex").managedSkills.prepareCheckout,
    ).toBeTypeOf("function");
    expect(
      getBackendDescriptor("claude").managedSkills.prepareCheckout,
    ).toBeUndefined();
  });

  it("isolates checkout preparation failures between backend adapters", async () => {
    bootstrapBackends();
    const claudePrepare = vi.fn(async () => {
      throw new Error("claude preparation failed");
    });
    const codexPrepare = vi.fn(async () => undefined);
    getBackendDescriptor("claude").managedSkills.prepareCheckout =
      claudePrepare;
    getBackendDescriptor("codex").managedSkills.prepareCheckout = codexPrepare;

    await expect(
      prepareManagedSkillsCheckout("/repo/.worktrees/session"),
    ).resolves.toBeUndefined();

    expect(claudePrepare).toHaveBeenCalledOnce();
    expect(codexPrepare).toHaveBeenCalledOnce();
    expect(claudePrepare.mock.invocationCallOrder[0]).toBeLessThan(
      codexPrepare.mock.invocationCallOrder[0]!,
    );
  });

});

describe("descriptor integrity schemas (runtime belt for values the type system cannot vouch for)", () => {
  const validMetadata = {
    label: "Fake",
    toneToken: "cyan",
    skillTriggerPrefix: "/",
    models: [
      {
        id: "m1",
        label: "M1",
        description: "test model",
        effortLevels: ["low"],
      },
    ],
    defaultModelId: "m1",
    defaultTimeoutMs: null,
  };

  it("rejects an invalid skill-trigger prefix", () => {
    const result = backendMetadataIntegritySchema.safeParse({
      ...validMetadata,
      skillTriggerPrefix: "!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an effort level outside the closed vocabulary", () => {
    const result = backendMetadataIntegritySchema.safeParse({
      ...validMetadata,
      models: [
        {
          id: "m1",
          label: "M1",
          description: "test model",
          effortLevels: ["turbo"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  const validCapabilities = {
    queue: { acceptsWhileRunning: false, deliveryTiming: "next_turn" },
    continuationStrength: "synthetic_thread",
    fork: "unsupported",
    structuredOutput: "post_validation",
    contextWindowMetrics: false,
    nativeMidTurnAskUser: false,
    externalTurns: false,
    capabilityKinds: [{ kind: "agents", applyTiming: "next_turn" }],
  };

  it("rejects an invalid capability kind", () => {
    const result = backendConversationCapabilitiesIntegritySchema.safeParse({
      ...validCapabilities,
      capabilityKinds: [{ kind: "widgets", applyTiming: "next_turn" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid apply timing", () => {
    const result = backendConversationCapabilitiesIntegritySchema.safeParse({
      ...validCapabilities,
      capabilityKinds: [{ kind: "agents", applyTiming: "sometime" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid queue delivery timing", () => {
    const result = backendConversationCapabilitiesIntegritySchema.safeParse({
      ...validCapabilities,
      queue: { acceptsWhileRunning: false, deliveryTiming: "whenever" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts the coherent capability shape", () => {
    const result =
      backendConversationCapabilitiesIntegritySchema.safeParse(
        validCapabilities,
      );
    expect(result.success).toBe(true);
  });
});
