/**
 * R2.2 — the Cursor descriptor's declarations are the honest ones.
 *
 * Consumers read these declarations to select execution mechanisms and show
 * limitations. Governed tasks and managed skills are available; filesystem
 * policies use instructions, and native metrics, asks, forks and strict MCP
 * authority are not claimed.
 */

import { describe, expect, it } from "vitest";
import {
  createCursorBackendDescriptor,
  cursorBackendMetadata,
  cursorConversationCapabilities,
  cursorConversationFsWriteRestriction,
  cursorConversationTranscriptProjection,
} from "./descriptor";
import { CURSOR_DEFAULT_MODEL } from "./model-policy";
import { CURSOR_TURN_STALL_TIMEOUT_MS } from "./worker/bounds";
import { cursorMcpCapabilities } from "@/lib/mcp/backend-capabilities";
import { createCursorFailureClassifier } from "./failure-classifier";
import { claudeBackendMetadata } from "../claude/descriptor";
import { codexBackendMetadata } from "../codex/descriptor";
import type {
  AgentBackendDescriptor,
  BackendModelCatalogFacet,
} from "../descriptor";
import type { ConversationBackendFactory } from "../conversation";
import type { BackendContinuityAdapter } from "../continuity";
import type { BackendRuntimeConfigAdapter } from "../runtime-config";

function inertFactory(): ConversationBackendFactory {
  return {
    backend: "cursor",
    createRuntime: () => Promise.reject(new Error("not driven in this test")),
  };
}

function inertContinuity(): BackendContinuityAdapter {
  return {
    backend: "cursor",
    start: () => Promise.reject(new Error("not driven in this test")),
    validate: () => Promise.reject(new Error("not driven in this test")),
    resumeOrRecover: () => Promise.reject(new Error("not driven in this test")),
    fork: () => Promise.reject(new Error("not driven in this test")),
  };
}

function inertRuntimeConfig(): BackendRuntimeConfigAdapter {
  return {
    backend: "cursor",
    apply: async () => ({ status: "applied" }),
  };
}

const modelCatalog: BackendModelCatalogFacet = {
  getCatalog: async () => ({
    backend: "cursor",
    defaultModelId: "composer-2.5",
    models: [
      {
        id: "composer-2.5",
        label: "Composer 2.5",
        aliases: [],
        parameters: [],
        variants: [
          {
            selection: { modelId: "composer-2.5", parameters: {} },
            label: "Composer 2.5",
            isDefault: true,
          },
        ],
      },
    ],
    provenance: { source: "test" },
  }),
};

function descriptor(): AgentBackendDescriptor {
  return createCursorBackendDescriptor({
    taskRunner: {
      backend: "cursor",
      async run() {
        throw new Error("descriptor test does not execute tasks");
      },
    },
    conversationFactory: inertFactory(),
    continuity: inertContinuity(),
    modelCatalog,
    runtimeConfig: inertRuntimeConfig(),
    mcp: cursorMcpCapabilities,
    failureClassifier: createCursorFailureClassifier(),
  });
}

describe("cursor descriptor — facets", () => {
  it("declares governed and nongoverned task execution", () => {
    const cursor = descriptor();
    expect(cursor.id).toBe("cursor");
    expect(cursor.conversation).toBeDefined();
    expect(cursor.tasks?.execution).toEqual({
      classes: ["nongoverned-task", "governed-execution"],
      profiles: ["standard", "isolated-one-shot"],
      instructionDelivery: "user-message",
    });
  });

  it("publishes the injected generated model catalog facet", async () => {
    expect(descriptor().modelCatalog).toBe(modelCatalog);
    await expect(
      descriptor().modelCatalog.getCatalog({}),
    ).resolves.toMatchObject({
      backend: "cursor",
      defaultModelId: "composer-2.5",
    });
  });

  it("declares instruction-only filesystem limits on the conversation facet", () => {
    expect(cursorConversationFsWriteRestriction).toBe("instruction-only");
    expect(descriptor().conversation?.fsWriteRestriction).toBe(
      "instruction-only",
    );
  });

  it("declares managed skills bundled for normal launches", () => {
    const { managedSkills } = descriptor();
    expect(managedSkills.conversations).toBe("bundled");
    expect(managedSkills.tasks).toBe("bundled");
    expect(managedSkills.prepareCheckout).toBeUndefined();
  });
});

describe("cursor descriptor — conversation capabilities", () => {
  it("declares exactly the Phase 1 capability values", () => {
    expect(cursorConversationCapabilities).toEqual({
      queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },
      continuationStrength: "precise_session",
      fork: "synthetic",
      structuredOutput: "post_validation",
      contextWindowMetrics: false,
      nativeMidTurnAskUser: false,
      externalTurns: false,
      checkpoint: false,
      checkpointFork: false,
      handoffCapture: {
        available: false,
        mode: null,
        reason: "Capture is unavailable",
      },
      capabilityKinds: [
        { kind: "skills", applyTiming: "next_conversation" },
        { kind: "plugins", applyTiming: "next_conversation" },
        { kind: "agents", applyTiming: "next_conversation" },
      ],
    });
  });

  it("carries those same literals on the registered facet", () => {
    expect(descriptor().conversation?.capabilities).toBe(
      cursorConversationCapabilities,
    );
  });
});

describe("cursor descriptor — metadata", () => {
  it("declares composer-2.5 as its only model and its default", () => {
    expect(cursorBackendMetadata.models.map((m) => m.id)).toEqual([
      CURSOR_DEFAULT_MODEL,
    ]);
    expect(cursorBackendMetadata.defaultModelId).toBe(CURSOR_DEFAULT_MODEL);
  });

  it("declares no effort levels — composer-2.5 takes no reasoning effort", () => {
    for (const model of cursorBackendMetadata.models) {
      expect(model.effortLevels).toEqual([]);
    }
  });

  it("declares a tone token distinct from the other registered backends", () => {
    expect(cursorBackendMetadata.toneToken.trim().length).toBeGreaterThan(0);
    expect(cursorBackendMetadata.toneToken).not.toBe(
      claudeBackendMetadata.toneToken,
    );
    expect(cursorBackendMetadata.toneToken).not.toBe(
      codexBackendMetadata.toneToken,
    );
  });

  it("declares the metadata canonical command/capability surfaces require", () => {
    expect(cursorBackendMetadata.label).toBe("Cursor");
    expect(cursorBackendMetadata.skillTriggerPrefix).toBe("/");
    expect(cursorBackendMetadata.defaultTimeoutMs).toBeNull();
    expect(cursorBackendMetadata.defaultStallTimeoutMs).toBe(
      CURSOR_TURN_STALL_TIMEOUT_MS,
    );
  });
});

describe("cursor descriptor — MCP and transcript declarations", () => {
  it("reports strict MCP authority unsupported", () => {
    expect(descriptor().mcp.backend).toBe("cursor");
    expect(descriptor().mcp.strictAuthoritativeConfig).toBe(false);
  });

  // The runtime's own native envelopes already carry every visible frame and
  // the per-turn usage record, so a CC-authored init/result frame would be a
  // second, competing record of the same turn.
  it("adds no CC-authored transcript frames around a turn", () => {
    expect(cursorConversationTranscriptProjection.persistContentEvents).toBe(
      false,
    );
    expect(
      cursorConversationTranscriptProjection.projectBackendInit({
        timestamp: "2026-01-01T00:00:00.000Z",
        backendRef: { backend: "cursor", ref: "agent-1" },
      }),
    ).toBeNull();
    expect(
      cursorConversationTranscriptProjection.projectTurnResult({
        timestamp: "2026-01-01T00:00:00.000Z",
        backendRef: { backend: "cursor", ref: "agent-1" },
        durationMs: 1,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        costUsd: null,
        cumulativeCostUsd: null,
        aborted: false,
        error: null,
      }),
    ).toBeNull();
  });

  // Billed cost is the one figure the native envelopes cannot carry, so a
  // lineage with a billed figure leaves the lineage-cumulative result frame
  // every cost-reporting backend persists — and only then.
  it("persists one lineage-cumulative result frame once billing has a figure", () => {
    expect(
      cursorConversationTranscriptProjection.projectTurnResult({
        timestamp: "2026-01-01T00:00:00.000Z",
        backendRef: { backend: "cursor", ref: "agent-1" },
        durationMs: 1,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        costUsd: 0.0425,
        cumulativeCostUsd: 0.1,
        aborted: false,
        error: null,
      }),
    ).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "result",
      raw: {
        backend: "cursor",
        backendRef: { backend: "cursor", ref: "agent-1" },
        costUsd: 0.0425,
        cumulativeCostUsd: 0.1,
        numTurns: 1,
        durationMs: 1,
        aborted: false,
        error: null,
      },
    });
  });
});
