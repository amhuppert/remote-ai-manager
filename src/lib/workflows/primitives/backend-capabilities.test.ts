import { describe, expect, it } from "vitest";

import type { AgentBackendDescriptor } from "@/lib/agent-backends/descriptor";
import { createStubFailureClassifier } from "@/lib/agent-backends/errors";
import { claudeMcpCapabilities } from "@/lib/mcp/backend-capabilities";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import {
  capabilityViewForBackend,
  capabilityViewFromDescriptor,
} from "./backend-capabilities";
import { backendCapabilityViewSchema } from "./agent-call-vocabulary";

describe("capabilityViewForBackend (descriptor-derived)", () => {
  it("derives the Claude view from the registered descriptor", () => {
    const view = capabilityViewForBackend("claude");
    expect(backendCapabilityViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual({
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    });
  });

  it("derives the Codex view from the registered descriptor", () => {
    const view = capabilityViewForBackend("codex");
    expect(backendCapabilityViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual({
      backend: "codex",
      continuationStrength: "synthetic_thread",
      structuredOutputEnforcement: "backend_native",
      mcpApplicationBoundary: "per_request",
      contextMetricsAvailable: false,
      nativeMidTurnAskUser: false,
    });
  });
});

describe("capabilityViewFromDescriptor", () => {
  it("rejects a descriptor without a conversation facet instead of falling back", () => {
    const taskOnly: AgentBackendDescriptor = {
      id: "claude",
      metadata: {
        label: "Claude",
        toneToken: "cyan",
        skillTriggerPrefix: "/",
        models: [
          { id: "m", label: "M", description: "test", effortLevels: [] },
        ],
        defaultModelId: "m",
        defaultTimeoutMs: null,
      },
      modelCatalog: {
        getCatalog: async () => getStaticBackendModelCatalog("claude"),
      },
      tasks: {
        runner: {
          backend: "claude",
          run: () => Promise.reject(new Error("not driven")),
        },
        structuredOutput: "backend_native",
        transcript: {
          projectAssistantMetadata: () => null,
        },
        fsWriteRestriction: "enforced",
      },
      managedSkills: { conversations: "hermetic", tasks: "hermetic" },
      nativeMemory: {
        mechanism: "disabled",
        lever: "test fixture launches no provider",
      },
      mcp: claudeMcpCapabilities,
      errors: createStubFailureClassifier(),
    };
    expect(() => capabilityViewFromDescriptor(taskOnly)).toThrow(
      /conversation facet/i,
    );
  });
});
