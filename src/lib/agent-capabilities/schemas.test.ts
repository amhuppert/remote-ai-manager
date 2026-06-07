import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP,
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityApplyStatusSchema,
  agentCapabilityCascadeKindSchema,
  agentCapabilityCascadeLayerSchema,
  agentCapabilityCascadeOverrideSchema,
  agentCapabilityCascadeRuntimeStateSchema,
  agentCapabilityCascadesOverrideSchema,
  agentCapabilityDiagnosticSchema,
  agentCapabilityDiscoveredItemSchema,
  agentCapabilityGlobalStateSchema,
  agentCapabilityItemOverrideSchema,
  agentCapabilityMetadataSchema,
  agentCapabilityOriginLayerSchema,
  agentCapabilityOverridesSchema,
  agentCapabilityPatchRequestSchema,
  agentCapabilityRuntimeApplicationStateSchema,
  agentCapabilityRuntimeVisibilitySchema,
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

describe("agentCapabilityCascadeKindSchema", () => {
  it("accepts exactly the five declared cascade kinds", () => {
    for (const value of AGENT_CAPABILITY_CASCADE_KINDS) {
      expect(agentCapabilityCascadeKindSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown cascade kinds", () => {
    expect(
      agentCapabilityCascadeKindSchema.safeParse("codex-agents").success,
    ).toBe(false);
    expect(
      agentCapabilityCascadeKindSchema.safeParse("project-conversation")
        .success,
    ).toBe(false);
    expect(
      agentCapabilityCascadeKindSchema.safeParse(
        "project-conversation-capabilities",
      ).success,
    ).toBe(false);
    expect(agentCapabilityCascadeKindSchema.safeParse("plugins").success).toBe(
      false,
    );
  });

  it("exposes the five cascade kinds in the canonical order", () => {
    expect(AGENT_CAPABILITY_CASCADE_KINDS).toEqual([
      "claude-skills",
      "claude-plugins",
      "claude-agents",
      "codex-skills",
      "codex-plugins",
    ]);
  });
});

describe("agentCapabilityItemOverrideSchema", () => {
  it("requires an explicit enabled boolean when an item key is present", () => {
    expect(
      agentCapabilityItemOverrideSchema.safeParse({ enabled: true }).success,
    ).toBe(true);
    expect(
      agentCapabilityItemOverrideSchema.safeParse({ enabled: false }).success,
    ).toBe(true);
  });

  it("rejects override records without enabled set", () => {
    expect(agentCapabilityItemOverrideSchema.safeParse({}).success).toBe(false);
  });

  it("rejects non-boolean enabled values", () => {
    expect(
      agentCapabilityItemOverrideSchema.safeParse({ enabled: "yes" }).success,
    ).toBe(false);
  });
});

describe("agentCapabilityCascadeOverrideSchema", () => {
  it("accepts an empty items map", () => {
    expect(
      agentCapabilityCascadeOverrideSchema.safeParse({ items: {} }).success,
    ).toBe(true);
  });

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
  it("accepts an empty cascades record", () => {
    const result = agentCapabilityCascadesOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
  });

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
  it("requires a cascades record (empty allowed)", () => {
    const result = agentCapabilityOverridesSchema.safeParse({ cascades: {} });
    expect(result.success).toBe(true);
  });

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
  it("parses a minimal global state file", () => {
    const result = agentCapabilityGlobalStateSchema.safeParse({
      version: 1,
      overrides: { cascades: {} },
      updatedAt: "2026-05-17T22:51:08Z",
    });
    expect(result.success).toBe(true);
  });

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

describe("agentCapabilityCascadeLayerSchema", () => {
  it("accepts global, project, session, and conversation", () => {
    for (const value of ["global", "project", "session", "conversation"]) {
      expect(agentCapabilityCascadeLayerSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects layer names outside the four-layer chain", () => {
    expect(agentCapabilityCascadeLayerSchema.safeParse("native").success).toBe(
      false,
    );
    expect(agentCapabilityCascadeLayerSchema.safeParse("user").success).toBe(
      false,
    );
  });
});

describe("agentCapabilityOriginLayerSchema", () => {
  it("accepts the four cascade layers plus native", () => {
    for (const value of [
      "global",
      "project",
      "session",
      "conversation",
      "native",
    ]) {
      expect(agentCapabilityOriginLayerSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown origin layers", () => {
    expect(
      agentCapabilityOriginLayerSchema.safeParse("inherited").success,
    ).toBe(false);
  });
});

describe("agentCapabilityApplyStatusSchema", () => {
  it("accepts each documented apply status", () => {
    for (const value of [
      "applied",
      "staged-idle",
      "staged-next-turn",
      "deferred-next-conversation",
      "unsupported",
      "rejected",
      "none",
    ]) {
      expect(agentCapabilityApplyStatusSchema.safeParse(value).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown apply status values", () => {
    expect(
      agentCapabilityApplyStatusSchema.safeParse("applied_now").success,
    ).toBe(false);
    expect(agentCapabilityApplyStatusSchema.safeParse("pending").success).toBe(
      false,
    );
  });
});

describe("agentCapabilityRuntimeVisibilitySchema", () => {
  it("accepts each documented runtime visibility value", () => {
    for (const value of [
      "runtime-visible",
      "source-only",
      "unavailable",
      "stale",
    ]) {
      expect(
        agentCapabilityRuntimeVisibilitySchema.safeParse(value).success,
      ).toBe(true);
    }
  });

  it("rejects unknown runtime visibility values", () => {
    expect(
      agentCapabilityRuntimeVisibilitySchema.safeParse("loaded").success,
    ).toBe(false);
  });
});

describe("agentCapabilityCascadeRuntimeStateSchema (per-cascade runtime apply state)", () => {
  it("accepts an empty per-cascade runtime apply record", () => {
    expect(agentCapabilityCascadeRuntimeStateSchema.safeParse({}).success).toBe(
      true,
    );
  });

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

  it("rejects unknown apply status enum values", () => {
    const result = agentCapabilityCascadeRuntimeStateSchema.safeParse({
      lastApplyStatus: "applied_now",
    });
    expect(result.success).toBe(false);
  });
});

describe("agentCapabilityRuntimeApplicationStateSchema (per-conversation aggregate)", () => {
  it("accepts an empty cascades record", () => {
    expect(
      agentCapabilityRuntimeApplicationStateSchema.safeParse({ cascades: {} })
        .success,
    ).toBe(true);
  });

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
  it("accepts a global scope without project or session", () => {
    expect(
      agentCapabilityScopeContextSchema.safeParse({ level: "global" }).success,
    ).toBe(true);
  });

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
  it("accepts a native source ref with kind and path", () => {
    expect(
      agentCapabilitySourceRefSchema.safeParse({
        kind: "project-file",
        path: "/repo/.agents/skills/debug-logs/SKILL.md",
      }).success,
    ).toBe(true);
  });

  it("accepts a plugin source ref keyed by owning plugin id", () => {
    expect(
      agentCapabilitySourceRefSchema.safeParse({
        kind: "plugin",
        pluginId: "plugin:user:debug-logs",
      }).success,
    ).toBe(true);
  });

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

  it("parses a minimal row with required fields only", () => {
    expect(agentCapabilityViewRowSchema.safeParse(baseRow).success).toBe(true);
  });

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

  it("accepts the documented apply statuses including staged-next-turn", () => {
    for (const status of [
      "applied",
      "staged-idle",
      "staged-next-turn",
      "deferred-next-conversation",
      "unsupported",
      "rejected",
      "none",
    ]) {
      expect(
        agentCapabilityViewRowSchema.safeParse({
          ...baseRow,
          applyStatus: status,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown apply statuses", () => {
    expect(
      agentCapabilityViewRowSchema.safeParse({
        ...baseRow,
        applyStatus: "applied_now",
      }).success,
    ).toBe(false);
  });
});

describe("agentCapabilityDiscoveredItemSchema", () => {
  it("accepts a discovered item from a native source", () => {
    const result = agentCapabilityDiscoveredItemSchema.safeParse({
      itemId: "skill:project:debug-logs",
      displayName: "debug-logs",
      capabilityKind: "skill",
      source: {
        kind: "project-file",
        path: "/repo/.agents/skills/debug-logs/SKILL.md",
      },
      nativeDefault: { enabled: true },
      runtimeVisibility: "source-only",
    });
    expect(result.success).toBe(true);
  });
});

describe("agentCapabilityDiagnosticSchema", () => {
  it("accepts a discovery diagnostic with cascade and source context", () => {
    const result = agentCapabilityDiagnosticSchema.safeParse({
      severity: "warning",
      code: "agent-capabilities.discovery.source-unreadable",
      message: "could not read source",
      cascadeKind: "claude-skills",
      layer: "project",
      backend: "claude",
      sourceRef: {
        kind: "project-file",
        path: "/repo/.agents/skills",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects severities outside info/warning/error", () => {
    expect(
      agentCapabilityDiagnosticSchema.safeParse({
        severity: "critical",
        code: "x",
        message: "y",
      }).success,
    ).toBe(false);
  });

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
  it("parses a minimal response", () => {
    const result = agentCapabilityViewResponseSchema.safeParse({
      level: "global",
      cascadeKind: "claude-skills",
      backend: "claude",
      items: [],
      diagnostics: [],
      effectiveHash: "h",
    });
    expect(result.success).toBe(true);
  });

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
  it("accepts a global-scope event with backend and invalidation hints", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-updated",
      level: "global",
      cascadeKind: "claude-skills",
      backend: "claude",
      changedItemIds: ["skill:project:debug-logs"],
      effectiveHash: "h-1",
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        itemIds: ["skill:project:debug-logs"],
        effectiveHash: "h-1",
      },
    });
    expect(result.success).toBe(true);
  });

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

  it("requires correct literal type discriminator", () => {
    const result = agentCapabilitiesUpdatedEventSchema.safeParse({
      type: "agent-capabilities-changed",
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

  it("rejects unknown level values", () => {
    const result = agentCapabilitiesDiscoveryUpdatedEventSchema.safeParse({
      type: "agent-capabilities-discovery-updated",
      level: "user",
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
    expect(result.success).toBe(false);
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

describe("AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP", () => {
  it("maps each declared cascade kind to its owning backend exactly once", () => {
    const expected: Record<string, "claude" | "codex"> = {
      "claude-skills": "claude",
      "claude-plugins": "claude",
      "claude-agents": "claude",
      "codex-skills": "codex",
      "codex-plugins": "codex",
    };
    for (const cascadeKind of AGENT_CAPABILITY_CASCADE_KINDS) {
      expect(AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[cascadeKind]).toBe(
        expected[cascadeKind],
      );
    }
  });
});

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

  it("rejects codex-cascade rows paired with the claude backend", () => {
    const result = agentCapabilityViewRowSchema.safeParse({
      ...validRow,
      cascadeKind: "codex-skills",
      backend: "claude",
    });
    expect(result.success).toBe(false);
  });

  it("accepts every (cascadeKind, owning-backend) pair", () => {
    for (const cascadeKind of AGENT_CAPABILITY_CASCADE_KINDS) {
      const backend = AGENT_CAPABILITY_CASCADE_BACKEND_OWNERSHIP[cascadeKind];
      const result = agentCapabilityViewRowSchema.safeParse({
        ...validRow,
        cascadeKind,
        backend,
      });
      expect(result.success).toBe(true);
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

  it("parses a valid metadata record", () => {
    expect(agentCapabilityMetadataSchema.safeParse(valid).success).toBe(true);
  });

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

  it("rejects metadata pairing a codex cascade with the claude backend", () => {
    const result = agentCapabilityMetadataSchema.safeParse({
      cascadeKind: "codex-plugins",
      backend: "claude",
      capabilityKind: "plugin",
      applySemantics: "next-turn",
      discoverySupport: "available",
      runtimeVisibility: "source-only",
      compositionSupport: "translator",
    });
    expect(result.success).toBe(false);
  });

  it("rejects metadata records carrying unknown extra fields (.strict guards payload leakage)", () => {
    const result = agentCapabilityMetadataSchema.safeParse({
      ...valid,
      rawSdkConfig: { secret: "should not be here" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects metadata records missing required fields", () => {
    const partial: Record<string, unknown> = { ...valid };
    delete partial.compositionSupport;
    const result = agentCapabilityMetadataSchema.safeParse(partial);
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

  it("allows diagnostics with cascadeKind only (no backend asserted)", () => {
    const result = agentCapabilityDiagnosticSchema.safeParse({
      severity: "warning",
      code: "x",
      message: "y",
      cascadeKind: "claude-skills",
    });
    expect(result.success).toBe(true);
  });

  it("allows diagnostics with backend only (no cascade asserted)", () => {
    const result = agentCapabilityDiagnosticSchema.safeParse({
      severity: "warning",
      code: "x",
      message: "y",
      backend: "codex",
    });
    expect(result.success).toBe(true);
  });
});
