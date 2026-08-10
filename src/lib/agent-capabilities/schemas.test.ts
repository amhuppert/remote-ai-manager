import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  decodeCascadeKind,
  encodeCascadeKind,
  agentCapabilityCascadeOverrideSchema,
  agentCapabilityCascadeRuntimeStateSchema,
  agentCapabilityCascadesOverrideSchema,
  agentCapabilityDiagnosticSchema,
  agentCapabilityGlobalStateSchema,
  agentCapabilityItemOverrideSchema,
  agentCapabilityMetadataSchema,
  agentCapabilityOverridesSchema,
  agentCapabilityPatchRequestSchema,
  agentCapabilityRuntimeApplicationStateSchema,
  agentCapabilityScopeContextSchema,
  agentCapabilitySourceRefSchema,
  agentCapabilityViewResponseSchema,
  agentCapabilityViewRowSchema,
  agentCapabilitiesDiscoveryUpdatedEventSchema,
  agentCapabilitiesUpdatedEventSchema,
} from "./schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { projectRowSchema, projectStateSchema } from "@/lib/projects/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

// ===========================================================================
// Task 2.1 — Persistent capability override and runtime state schemas
// ===========================================================================

describe("agentCapabilityItemOverrideSchema", () => {
  it("rejects override records without enabled set", () => {
    expect(agentCapabilityItemOverrideSchema.safeParse({}).success).toBe(false);
  });
});

describe("agentCapabilityCascadeOverrideSchema", () => {
  it("preserves a populated items map", () => {
    const result = agentCapabilityCascadeOverrideSchema.safeParse({
      items: {
        "skill:project:debug-logs": { enabled: false },
        "skill:user:write-tests": { enabled: true },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items["skill:project:debug-logs"]?.enabled).toBe(
        false,
      );
    }
  });

  it("rejects items map values that omit enabled", () => {
    const result = agentCapabilityCascadeOverrideSchema.safeParse({
      items: { "skill:x": {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityCascadesOverrideSchema (sparse cascade map)", () => {
  it("accepts only the cascades that have overrides", () => {
    const result = agentCapabilityCascadesOverrideSchema.safeParse({
      "claude-skills": {
        items: { "skill:project:debug-logs": { enabled: false } },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["claude-plugins"]).toBeUndefined();
      expect(
        result.data["claude-skills"]?.items["skill:project:debug-logs"]
          ?.enabled,
      ).toBe(false);
    }
  });

  it("rejects unknown cascade kind keys", () => {
    const result = agentCapabilityCascadesOverrideSchema.safeParse({
      "codex-agents": { items: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityOverridesSchema", () => {
  it("rejects payloads missing the cascades field", () => {
    expect(agentCapabilityOverridesSchema.safeParse({}).success).toBe(false);
  });

  it("preserves cascade overrides through parse", () => {
    const result = agentCapabilityOverridesSchema.safeParse({
      cascades: {
        "claude-plugins": {
          items: { "plugin:user:debug-logs": { enabled: false } },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.cascades["claude-plugins"]?.items["plugin:user:debug-logs"]
          ?.enabled,
      ).toBe(false);
    }
  });
});

describe("agentCapabilityGlobalStateSchema", () => {
  it("requires version 1", () => {
    const result = agentCapabilityGlobalStateSchema.safeParse({
      version: 2,
      overrides: { cascades: {} },
      updatedAt: "2026-05-17T22:51:08Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires updatedAt", () => {
    const result = agentCapabilityGlobalStateSchema.safeParse({
      version: 1,
      overrides: { cascades: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityCascadeRuntimeStateSchema (per-cascade runtime apply state)", () => {
  it("carries applied/pending hashes, pending item ids, apply status, and sanitized error", () => {
    const result = agentCapabilityCascadeRuntimeStateSchema.safeParse({
      appliedHash: "h-1",
      pendingHash: "h-2",
      pendingItemIds: ["skill:a", "skill:b"],
      lastApplyStatus: "staged-idle",
      lastApplyError: "could not apply",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appliedHash).toBe("h-1");
      expect(result.data.pendingItemIds).toEqual(["skill:a", "skill:b"]);
      expect(result.data.lastApplyStatus).toBe("staged-idle");
    }
  });
});

describe("agentCapabilityRuntimeApplicationStateSchema (per-conversation aggregate)", () => {
  it("stores runtime apply state keyed by cascade kind", () => {
    const result = agentCapabilityRuntimeApplicationStateSchema.safeParse({
      cascades: {
        "claude-skills": {
          appliedHash: "h-a",
          lastApplyStatus: "applied",
        },
        "codex-skills": {
          pendingHash: "h-c",
          pendingItemIds: ["x"],
          lastApplyStatus: "staged-next-turn",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cascades["claude-skills"]?.appliedHash).toBe("h-a");
      expect(result.data.cascades["codex-skills"]?.lastApplyStatus).toBe(
        "staged-next-turn",
      );
    }
  });

  it("rejects unknown cascade kind keys in runtime state", () => {
    const result = agentCapabilityRuntimeApplicationStateSchema.safeParse({
      cascades: { "codex-agents": {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityOverrides field on persisted state schemas", () => {
  const baseConversation = {
    id: "c1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-05-17T00:00:00.000Z",
    lastActivityAt: "2026-05-17T00:00:00.000Z",
  };

  const baseSession = {
    sessionName: "test",
    worktreePath: "/tmp/test",
    branchName: "csm/test",
    createdAt: "2026-05-17T00:00:00.000Z",
    lastActivityAt: "2026-05-17T00:00:00.000Z",
  };

  it("conversationStateSchema remains valid with agentCapabilityOverrides omitted (additive)", () => {
    const result = conversationStateSchema.safeParse(baseConversation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentCapabilityOverrides).toBeUndefined();
      expect(result.data.agentCapabilitiesRuntime).toBeUndefined();
    }
  });

  it("conversationStateSchema accepts agentCapabilityOverrides and agentCapabilitiesRuntime", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      agentCapabilityOverrides: {
        cascades: {
          "claude-skills": {
            items: { "skill:project:debug-logs": { enabled: false } },
          },
        },
      },
      agentCapabilitiesRuntime: {
        cascades: {
          "claude-skills": { lastApplyStatus: "applied" },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.agentCapabilityOverrides?.cascades["claude-skills"]?.items[
          "skill:project:debug-logs"
        ]?.enabled,
      ).toBe(false);
      expect(
        result.data.agentCapabilitiesRuntime?.cascades["claude-skills"]
          ?.lastApplyStatus,
      ).toBe("applied");
    }
  });

  it("sessionStateSchema accepts agentCapabilityOverrides", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      agentCapabilityOverrides: {
        cascades: {
          "claude-plugins": {
            items: { "plugin:user:noisy": { enabled: false } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.agentCapabilityOverrides?.cascades["claude-plugins"]?.items[
          "plugin:user:noisy"
        ]?.enabled,
      ).toBe(false);
    }
  });

  it("projectStateSchema accepts agentCapabilityOverrides", () => {
    const result = projectStateSchema.safeParse({
      rootPath: "/repo",
      sessions: {},
      agentCapabilityOverrides: {
        cascades: {
          "claude-agents": {
            items: { "agent:user:reviewer": { enabled: true } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.agentCapabilityOverrides?.cascades["claude-agents"]?.items[
          "agent:user:reviewer"
        ]?.enabled,
      ).toBe(true);
    }
  });

  it("projectRowSchema accepts agentCapabilityOverrides", () => {
    const result = projectRowSchema.safeParse({
      rootPath: "/repo",
      archived: false,
      pinned: false,
      pinOrder: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      agentCapabilityOverrides: {
        cascades: {
          "codex-skills": {
            items: { "skill:project:noisy": { enabled: false } },
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.agentCapabilityOverrides?.cascades["codex-skills"]?.items[
          "skill:project:noisy"
        ]?.enabled,
      ).toBe(false);
    }
  });
});

// ===========================================================================
// Task 2.2 — API view / patch / diagnostics / SSE schemas
// ===========================================================================

describe("agentCapabilityScopeContextSchema", () => {
  it("accepts a session conversation scope with identifiers", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "session",
      sessionName: "main",
      conversationId: "c1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a project conversation scope without a session name", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "project",
      conversationId: "c1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionName).toBeUndefined();
    }
  });

  it("rejects conversation scope without an explicit conversationScope discriminator", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      sessionName: "main",
      conversationId: "c1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects the project conversation sentinel as a public session name", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "session",
      sessionName: "__project__",
      conversationId: "c1",
    });
    expect(result.success).toBe(false);
  });

  it("does not leak the project conversation sentinel in validation messages", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "session",
      sessionName: "__project__",
      conversationId: "c1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.message).join("\n"),
      ).not.toContain("__project__");
    }
  });

  it("rejects project conversation scope with a session name", () => {
    const result = agentCapabilityScopeContextSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "project",
      sessionName: "main",
      conversationId: "c1",
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilitySourceRefSchema", () => {
  it("rejects unknown source kinds", () => {
    expect(
      agentCapabilitySourceRefSchema.safeParse({ kind: "internet" }).success,
    ).toBe(false);
  });
});

describe("agentCapabilityViewRowSchema", () => {
  const baseRow = {
    itemId: "skill:project:debug-logs",
    displayName: "debug-logs",
    backend: "claude",
    capabilityKind: "skill",
    cascadeKind: "claude-skills",
    source: {
      kind: "project-file",
      path: "/repo/.agents/skills/debug-logs/SKILL.md",
    },
    nativeDefault: { enabled: true },
    ownEffectiveState: { enabled: true, originLayer: "native" },
    effectiveState: { enabled: true, originLayer: "native" },
    originLayer: "native",
    runtimeVisibility: "runtime-visible",
    runtimeEmittable: true,
    stale: false,
    applyStatus: "none",
    diagnostics: [],
  };

  it("captures inherited-disable reason with parent plugin id and origin layer", () => {
    const row = {
      ...baseRow,
      effectiveState: { enabled: false, originLayer: "session" },
      inheritedDisableReason: {
        pluginId: "plugin:user:debug-logs",
        originLayer: "session",
      },
      owningPluginId: "plugin:user:debug-logs",
    };
    const result = agentCapabilityViewRowSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inheritedDisableReason?.pluginId).toBe(
        "plugin:user:debug-logs",
      );
    }
  });

  it("captures stale state with the stored override that is no longer runtime-emittable", () => {
    const result = agentCapabilityViewRowSchema.safeParse({
      ...baseRow,
      runtimeVisibility: "stale",
      runtimeEmittable: false,
      stale: true,
      effectiveState: { enabled: false, originLayer: "global" },
      ownEffectiveState: { enabled: false, originLayer: "global" },
      originLayer: "global",
    });
    expect(result.success).toBe(true);
  });
});

describe("agentCapabilityDiagnosticSchema", () => {
  it("rejects diagnostics that try to leak native config payloads", () => {
    // Strict schema: only declared fields are allowed. Payload contents like
    // skill source text or plugin config blobs must never travel through this
    // shape.
    const result = agentCapabilityDiagnosticSchema.safeParse({
      severity: "info",
      code: "x",
      message: "y",
      configPayload: { command: "exfiltrate" },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityViewResponseSchema", () => {
  it("parses a response with metadata mirrored from the registry", () => {
    const result = agentCapabilityViewResponseSchema.safeParse({
      level: "conversation",
      projectName: "repo",
      conversationScope: "session",
      sessionName: "main",
      conversationId: "c1",
      cascadeKind: "claude-skills",
      backend: "claude",
      items: [],
      diagnostics: [],
      effectiveHash: "h",
      metadata: {
        cascadeKind: "claude-skills",
        backend: "claude",
        capabilityKind: "skill",
        applySemantics: "idle-live-apply",
        discoverySupport: "available",
        runtimeVisibility: "sdk-runtime",
        compositionSupport: "translator",
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("agentCapabilityPatchRequestSchema", () => {
  it("accepts a request with set and reset operations and an expectedHash", () => {
    const result = agentCapabilityPatchRequestSchema.safeParse({
      cascadeKind: "claude-skills",
      operations: [
        {
          type: "set-item-enabled",
          itemId: "skill:project:debug-logs",
          enabled: false,
        },
        { type: "reset-item", itemId: "skill:project:other" },
      ],
      expectedHash: "h-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown operation types", () => {
    const result = agentCapabilityPatchRequestSchema.safeParse({
      cascadeKind: "claude-skills",
      operations: [{ type: "set-server-enabled", itemId: "x", enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects operations missing enabled on set-item-enabled", () => {
    const result = agentCapabilityPatchRequestSchema.safeParse({
      cascadeKind: "claude-skills",
      operations: [{ type: "set-item-enabled", itemId: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown cascade kinds", () => {
    const result = agentCapabilityPatchRequestSchema.safeParse({
      cascadeKind: "codex-agents",
      operations: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a stale item id (discovery may recover it later)", () => {
    const result = agentCapabilityPatchRequestSchema.safeParse({
      cascadeKind: "claude-skills",
      operations: [
        {
          type: "set-item-enabled",
          itemId: "skill:vanished-from-disk",
          enabled: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("agentCapabilitiesUpdatedEventSchema (SSE)", () => {
  it("accepts a conversation-scope event with full identifiers", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: "repo",
      conversationScope: "session",
      sessionName: "main",
      conversationId: "c1",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:x"],
      effectiveHash: "h-2",
      invalidationHints: {
        level: "conversation",
        projectName: "repo",
        conversationScope: "session",
        sessionName: "main",
        conversationId: "c1",
        cascadeKind: "claude-skills",
        itemIds: ["skill:x"],
        effectiveHash: "h-2",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a project-conversation event without a session name", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: "repo",
      conversationScope: "project",
      conversationId: "c1",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:x"],
      effectiveHash: "h-2",
      invalidationHints: {
        level: "conversation",
        projectName: "repo",
        conversationScope: "project",
        conversationId: "c1",
        cascadeKind: "claude-skills",
        itemIds: ["skill:x"],
        effectiveHash: "h-2",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionName).toBeUndefined();
      expect(result.data.invalidationHints.sessionName).toBeUndefined();
    }
  });

  it("rejects project-conversation events that leak the sentinel as a session name", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: "repo",
      conversationScope: "project",
      sessionName: "__project__",
      conversationId: "c1",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:x"],
      effectiveHash: "h-2",
      invalidationHints: {
        level: "conversation",
        projectName: "repo",
        conversationScope: "project",
        sessionName: "__project__",
        conversationId: "c1",
        cascadeKind: "claude-skills",
        itemIds: ["skill:x"],
        effectiveHash: "h-2",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects events missing structured invalidation hints", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "global",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:x"],
      effectiveHash: "h",
    });
    expect(result.success).toBe(false);
  });

  it("rejects events pairing a cascade with the wrong backend", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "global",
      cascadeKind: "claude-skills",
      backend: "codex",
      changedItemIds: ["skill:x"],
      effectiveHash: "h",
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        itemIds: ["skill:x"],
        effectiveHash: "h",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects events that try to carry native config payloads", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "global",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: [],
      effectiveHash: "h",
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        itemIds: [],
        effectiveHash: "h",
      },
      configPayload: { skill: "exfiltrate" },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilitiesDiscoveryUpdatedEventSchema (SSE)", () => {
  it("accepts a discovery-refresh event with backend and invalidation hints", () => {
    const result = agentCapabilitiesDiscoveryUpdatedEventSchema.safeParse({
      type: "agent-capabilities-discovery-updated",
      level: "global",
      cascadeKind: "claude-skills",
      backend: "claude",
      refreshedAt: "2026-05-17T00:00:00.000Z",
      sourceSignature: "sig-1",
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        refreshDiscovery: true,
        sourceSignature: "sig-1",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects discovery events pairing a cascade with the wrong backend", () => {
    const result = agentCapabilitiesDiscoveryUpdatedEventSchema.safeParse({
      type: "agent-capabilities-discovery-updated",
      level: "global",
      cascadeKind: "codex-skills",
      backend: "claude",
      refreshedAt: "2026-05-17T00:00:00.000Z",
      sourceSignature: "sig-1",
      invalidationHints: {
        level: "global",
        cascadeKind: "codex-skills",
        refreshDiscovery: true,
        sourceSignature: "sig-1",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Cascade/backend ownership — enforced once at the schema boundary so no
// downstream resolver, API route, or UI hook needs to duplicate the check.
// ===========================================================================

describe("agentCapabilityViewRowSchema cascade/backend ownership", () => {
  const validRow = {
    itemId: "skill:project:debug-logs",
    displayName: "debug-logs",
    backend: "claude" as const,
    capabilityKind: "skill" as const,
    cascadeKind: "claude-skills" as const,
    source: {
      kind: "project-file" as const,
      path: "/repo/.agents/skills/debug-logs/SKILL.md",
    },
    nativeDefault: { enabled: true },
    ownEffectiveState: { enabled: true, originLayer: "native" as const },
    effectiveState: { enabled: true, originLayer: "native" as const },
    originLayer: "native" as const,
    runtimeVisibility: "runtime-visible" as const,
    runtimeEmittable: true,
    stale: false,
    applyStatus: "none" as const,
    diagnostics: [],
  };

  it("rejects claude-cascade rows paired with the codex backend", () => {
    const result = agentCapabilityViewRowSchema.safeParse({
      ...validRow,
      backend: "codex",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "backend")).toBe(
        true,
      );
    }
  });
});

describe("agentCapabilityMetadataSchema (canonical capability metadata)", () => {
  const valid = {
    cascadeKind: "claude-skills" as const,
    backend: "claude" as const,
    capabilityKind: "skill" as const,
    applySemantics: "idle-live-apply" as const,
    discoverySupport: "available" as const,
    runtimeVisibility: "sdk-runtime" as const,
    compositionSupport: "translator" as const,
  };

  it("rejects metadata pairing a claude cascade with the codex backend", () => {
    const result = agentCapabilityMetadataSchema.safeParse({
      ...valid,
      backend: "codex",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "backend")).toBe(
        true,
      );
    }
  });

  it("rejects metadata records carrying unknown extra fields (.strict guards payload leakage)", () => {
    const result = agentCapabilityMetadataSchema.safeParse({
      ...valid,
      rawSdkConfig: { secret: "should not be here" },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityViewResponseSchema cascade/backend ownership", () => {
  const valid = {
    level: "conversation" as const,
    projectName: "repo",
    sessionName: "main",
    conversationId: "c1",
    cascadeKind: "claude-skills" as const,
    backend: "claude" as const,
    items: [],
    diagnostics: [],
    effectiveHash: "h",
  };

  it("rejects response payloads pairing the wrong backend with the cascadeKind", () => {
    const result = agentCapabilityViewResponseSchema.safeParse({
      ...valid,
      backend: "codex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects responses whose metadata.cascadeKind disagrees with the response cascadeKind", () => {
    const result = agentCapabilityViewResponseSchema.safeParse({
      ...valid,
      metadata: {
        cascadeKind: "claude-plugins",
        backend: "claude",
        capabilityKind: "plugin",
        applySemantics: "idle-live-apply",
        discoverySupport: "available",
        runtimeVisibility: "sdk-runtime",
        compositionSupport: "translator",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects responses whose metadata pairs cascadeKind with the wrong backend", () => {
    // Even when the response itself is consistent, the embedded metadata must
    // also pass cascade/backend ownership. The metadata schema's own refinement
    // catches this.
    const result = agentCapabilityViewResponseSchema.safeParse({
      ...valid,
      metadata: {
        cascadeKind: "claude-skills",
        backend: "codex",
        capabilityKind: "skill",
        applySemantics: "idle-live-apply",
        discoverySupport: "available",
        runtimeVisibility: "sdk-runtime",
        compositionSupport: "translator",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityDiagnosticSchema cascade/backend ownership", () => {
  it("rejects diagnostics pairing a claude cascade with the codex backend", () => {
    const result = agentCapabilityDiagnosticSchema.safeParse({
      severity: "warning",
      code: "x",
      message: "y",
      cascadeKind: "claude-skills",
      backend: "codex",
    });
    expect(result.success).toBe(false);
  });
});

describe("cascade-kind codec ({backend, kind} ⇄ persisted string)", () => {
  it("is bijective over all five persisted cascade kinds", () => {
    for (const cascadeKind of AGENT_CAPABILITY_CASCADE_KINDS) {
      const ref = decodeCascadeKind(cascadeKind);
      expect(encodeCascadeKind(ref)).toBe(cascadeKind);
    }
  });

  it("fails loudly on an unknown persisted string", () => {
    expect(() => decodeCascadeKind("codex-agents")).toThrow();
    expect(() => decodeCascadeKind("gemini-skills")).toThrow();
  });

  it("rejects an unsupported {backend, kind} pair loudly at encode time", () => {
    expect(() =>
      encodeCascadeKind({ backend: "codex", kind: "agents" }),
    ).toThrow(/does not support/);
  });
});
