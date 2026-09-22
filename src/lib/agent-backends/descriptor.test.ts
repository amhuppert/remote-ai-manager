import { describe, it, expect, beforeEach } from "vitest";

import type { AgentBackendDescriptor } from "./descriptor";
import { createTestFakeBackend } from "./testing/testfake-backend";
import type { ConversationBackendFactory } from "./conversation";
import type { BackendContinuityAdapter } from "./continuity";
import type { AgentTaskRunner } from "./task";
import type { McpBackendCapabilities } from "@/lib/agent-backends/mcp-capabilities";
import { createStubFailureClassifier } from "./errors";
import {
  registerBackend,
  getBackendDescriptor,
  listBackends,
  getConversationBackendFactory,
  getTaskRunner,
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "./registry-core";

function fakeConversationFactory(
  backend: "claude" | "codex",
): ConversationBackendFactory {
  return {
    backend,
    createRuntime: () => Promise.reject(new Error("not driven in this test")),
  };
}

function fakeContinuity(backend: "claude" | "codex"): BackendContinuityAdapter {
  return {
    backend,
    start: () => Promise.reject(new Error("not driven in this test")),
    validate: () => Promise.reject(new Error("not driven in this test")),
    resumeOrRecover: () => Promise.reject(new Error("not driven in this test")),
    fork: () => Promise.reject(new Error("not driven in this test")),
  };
}

function fakeTaskRunner(backend: "claude" | "codex"): AgentTaskRunner {
  return {
    backend,
    run: () => Promise.reject(new Error("not driven in this test")),
  };
}

function fakeMcp(backend: "claude" | "codex"): McpBackendCapabilities {
  return {
    backend,
    strictAuthoritativeConfig: true,
    serverDisable: "omit",
    betweenTurnApply: "live-when-idle",
    transports: { stdio: true, "streamable-http": true, sse: true },
    toolFiltering: {
      mode: "native",
      byTransport: {
        stdio: "native",
        "streamable-http": "native",
        sse: "native",
      },
    },
    toolDiscovery: { preferred: "probe", probeFallback: false },
  };
}

function makeDescriptor(
  backend: "claude" | "codex",
  overrides: Partial<AgentBackendDescriptor> = {},
): AgentBackendDescriptor {
  return {
    id: backend,
    metadata: {
      label: backend === "claude" ? "Claude" : "Codex",
      toneToken: backend === "claude" ? "cyan" : "violet",
      skillTriggerPrefix: backend === "claude" ? "/" : "$",
      models: [
        {
          id: "model-1",
          label: "Model 1",
          description: "test model",
          effortLevels: ["low", "high"],
        },
      ],
      defaultModelId: "model-1",
      defaultTimeoutMs: null,
    },
    modelCatalog: {
      getCatalog: async () => ({
        backend,
        defaultModelId: "model-1",
        models: [
          {
            id: "model-1",
            label: "Model 1",
            description: "test model",
            aliases: [],
            parameters: [
              {
                id: "effort",
                label: "Effort",
                values: [
                  { value: "low", label: "Low" },
                  { value: "high", label: "High" },
                ],
                prominence: "primary",
              },
            ],
            variants: [
              {
                selection: {
                  modelId: "model-1",
                  parameters: { effort: "low" },
                },
                label: "Low",
                isDefault: false,
              },
              {
                selection: {
                  modelId: "model-1",
                  parameters: { effort: "high" },
                },
                label: "High",
                isDefault: true,
              },
            ],
          },
        ],
        provenance: { source: "test" },
      }),
    },
    conversation: {
      execution: {
        classes: ["ordinary-conversation"],
        instructionDelivery: "user-message",
      },
      factory: fakeConversationFactory(backend),
      continuity: fakeContinuity(backend),
      capabilities: {
        queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },
        continuationStrength: "precise_session",
        fork: "native",
        structuredOutput: "backend_native",
        contextWindowMetrics: true,
        nativeMidTurnAskUser: true,
        externalTurns: true,
        checkpoint: false,
        checkpointFork: false,
        handoffCapture: {
          available: false,
          mode: null,
          reason: "Capture is unavailable",
        },
        capabilityKinds: [{ kind: "skills", applyTiming: "idle_live" }],
      },
      fsWriteRestriction: "unsupported",
      runtimeConfig: {
        backend,
        apply: async () => ({ status: "applied" }),
      },
      transcript: {
        persistContentEvents: false,
        projectBackendInit: () => null,
        projectTurnResult: () => null,
      },
    },
    tasks: {
      execution: {
        classes: ["nongoverned-task"],
        instructionDelivery: "privileged",
        profiles: ["standard", "isolated-one-shot"],
      },
      runner: fakeTaskRunner(backend),
      structuredOutput: "backend_native",
      transcript: {
        projectAssistantMetadata: () => undefined,
      },
      fsWriteRestriction: "enforced",
    },
    managedSkills: { conversations: "bundled", tasks: "bundled" },
    nativeMemory: {
      mechanism: "disabled",
      lever: "test fixture launches no provider",
    },
    mcp: fakeMcp(backend),
    errors: createStubFailureClassifier(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetBackendRegistryForTesting();
});

describe("registerBackend", () => {
  it("registers a complete descriptor retrievable via getBackendDescriptor", () => {
    const descriptor = makeDescriptor("claude");
    registerBackend(descriptor);
    expect(getBackendDescriptor("claude")).toBe(descriptor);
  });

  it("rejects a duplicate id", () => {
    registerBackend(makeDescriptor("claude"));
    expect(() => registerBackend(makeDescriptor("claude"))).toThrow(
      /already registered/i,
    );
  });

  it("rejects a descriptor with neither execution facet", () => {
    const descriptor = makeDescriptor("claude", {
      conversation: undefined,
      tasks: undefined,
    });
    expect(() => registerBackend(descriptor)).toThrow(/execution facet/i);
  });

  it("rejects an id outside the canonical backend enum at runtime", () => {
    const widened: Omit<AgentBackendDescriptor, "id"> & { id: string } = {
      ...makeDescriptor("claude"),
      id: "testfake",
    };
    expect(() => registerBackend(widened as AgentBackendDescriptor)).toThrow(
      /testfake/,
    );
  });

  it("rejects a descriptor whose defaultModelId is not in the model catalog", () => {
    const base = makeDescriptor("claude");
    const descriptor: AgentBackendDescriptor = {
      ...base,
      metadata: { ...base.metadata, defaultModelId: "missing-model" },
    };
    expect(() => registerBackend(descriptor)).toThrow(/defaultModelId/);
  });

  it("accepts a task-only descriptor (one execution facet suffices)", () => {
    const descriptor = makeDescriptor("claude", { conversation: undefined });
    registerBackend(descriptor);
    expect(getBackendDescriptor("claude").conversation).toBeUndefined();
  });
});

describe("getBackendDescriptor / listBackends", () => {
  it("throws on a missing backend", () => {
    expect(() => getBackendDescriptor("codex")).toThrow(/codex/);
  });

  it("lists descriptors in registration order", () => {
    const claude = makeDescriptor("claude");
    const codex = makeDescriptor("codex");
    registerBackend(codex);
    registerBackend(claude);
    expect(listBackends().map((d) => d.id)).toEqual(["codex", "claude"]);
  });
});

describe("legacy getters delegate to descriptors", () => {
  it("resolves the conversation factory and task runner from the descriptor", () => {
    const descriptor = makeDescriptor("claude");
    registerBackend(descriptor);
    expect(getConversationBackendFactory("claude")).toBe(
      descriptor.conversation?.factory,
    );
    expect(getTaskRunner("claude")).toBe(descriptor.tasks?.runner);
  });

  it("throws for a facet the descriptor does not declare", () => {
    registerBackend(makeDescriptor("claude", { conversation: undefined }));
    expect(() => getConversationBackendFactory("claude")).toThrow(
      /conversation/i,
    );
  });
});

describe("bootstrapBackends", () => {
  it("is idempotent and repopulates an explicitly reset registry", async () => {
    const { bootstrapBackends } = await import("./registry");

    bootstrapBackends();
    bootstrapBackends();
    expect(listBackends().map((d) => d.id)).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);

    _resetBackendRegistryForTesting();
    expect(listBackends()).toEqual([]);
    bootstrapBackends();
    expect(listBackends().map((d) => d.id)).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
  });
});

describe("test-only registry seams", () => {
  it("_registerBackendForTesting skips the id-enum check but keeps completeness checks", () => {
    const fake = createTestFakeBackend();
    _registerBackendForTesting(fake.descriptor);
    expect(listBackends().map((d) => String(d.id))).toContain("testfake");

    const facetless: Omit<AgentBackendDescriptor, "id"> & { id: string } = {
      ...makeDescriptor("codex"),
      id: "otherfake",
      conversation: undefined,
      tasks: undefined,
    };
    expect(() =>
      _registerBackendForTesting(facetless as AgentBackendDescriptor),
    ).toThrow(/execution facet/i);
  });

  it("_resetBackendRegistryForTesting empties the registry", () => {
    registerBackend(makeDescriptor("claude"));
    _resetBackendRegistryForTesting();
    expect(listBackends()).toEqual([]);
    expect(() => getBackendDescriptor("claude")).toThrow();
  });
});
