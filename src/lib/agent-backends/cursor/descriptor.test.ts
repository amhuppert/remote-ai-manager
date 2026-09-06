/**
 * R2.2 — the Cursor descriptor's declarations are the honest ones.
 *
 * Every assertion here is a NEGATIVE claim the rest of Command Center reads
 * instead of branching on backend identity: no task facet, no native mid-turn
 * ask, no external turns, no context-window metrics, no managed skills, no
 * strict MCP authority, no write confinement, no native fork. A descriptor is
 * the only place those can be stated, so this suite is where an over-claim gets
 * caught before a consumer acts on it.
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
    conversationFactory: inertFactory(),
    continuity: inertContinuity(),
    modelCatalog,
    runtimeConfig: inertRuntimeConfig(),
    mcp: cursorMcpCapabilities,
    failureClassifier: createCursorFailureClassifier(),
  });
}

describe("cursor descriptor — facets", () => {
  it("declares a conversation facet and no task facet", () => {
    const cursor = descriptor();
    expect(cursor.id).toBe("cursor");
    expect(cursor.conversation).toBeDefined();
    expect(cursor.tasks).toBeUndefined();
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

  it("declares filesystem write confinement unsupported on the conversation facet", () => {
    expect(cursorConversationFsWriteRestriction).toBe("unsupported");
    expect(descriptor().conversation?.fsWriteRestriction).toBe("unsupported");
  });

  it("declares managed skills hermetic for both facets — nothing is bundled", () => {
    const { managedSkills } = descriptor();
    expect(managedSkills.conversations).toBe("hermetic");
    expect(managedSkills.tasks).toBe("hermetic");
    expect(managedSkills.prepareCheckout).toBeUndefined();
  });
});

describe("cursor descriptor — conversation capabilities", () => {
  it("declares exactly the Phase 1 capability values", () => {
    expect(cursorConversationCapabilities).toEqual({
      queue: { acceptsWhileRunning: true, deliveryTiming: "next_turn" },
      continuationStrength: "precise_session",
      fork: "synthetic",
      structuredOutput: "post_validation",
      contextWindowMetrics: false,
      nativeMidTurnAskUser: false,
      externalTurns: false,
      capabilityKinds: [],
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
});
