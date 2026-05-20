import { describe, expect, it } from "vitest";

import {
  type AgentCapabilityCascadeKind,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
} from "@/lib/schemas";

import type { ClaudePluginNativeRecord } from "./claude-plugin-translator";
import { composeConversationStartRuntime } from "./runtime-composer";

function claudeSkill(
  itemId: string,
  opts: { nativeEnabled?: boolean; owningPluginId?: string } = {},
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/skills/${itemId}/SKILL.md` },
    nativeDefault: { enabled: opts.nativeEnabled ?? true },
    owningPluginId: opts.owningPluginId,
    runtimeVisibility: "runtime-visible",
  };
}

function claudePlugin(
  itemId: string,
  nativeEnabled: boolean,
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "plugin",
    source: { kind: "plugin", pluginId: itemId },
    nativeDefault: { enabled: nativeEnabled },
    runtimeVisibility: "runtime-visible",
  };
}

function claudeAgent(
  itemId: string,
  nativeEnabled: boolean,
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "agent",
    source: { kind: "user-file", path: `/agents/${itemId}.md` },
    nativeDefault: { enabled: nativeEnabled },
    runtimeVisibility: "runtime-visible",
  };
}

function codexSkill(itemId: string): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/codex-skills/${itemId}/SKILL.md` },
    nativeDefault: { enabled: true },
    runtimeVisibility: "source-only",
  };
}

function override(
  cascadeKind: AgentCapabilityCascadeKind,
  items: Record<string, boolean>,
): AgentCapabilityOverrides {
  return {
    cascades: {
      [cascadeKind]: {
        items: Object.fromEntries(
          Object.entries(items).map(([id, enabled]) => [id, { enabled }]),
        ),
      },
    },
  };
}

function mergeOverrides(
  ...inputs: AgentCapabilityOverrides[]
): AgentCapabilityOverrides {
  const cascades: AgentCapabilityOverrides["cascades"] = {};
  for (const input of inputs) {
    for (const [cascadeKind, cascade] of Object.entries(input.cascades) as [
      AgentCapabilityCascadeKind,
      { items: Record<string, { enabled: boolean }> } | undefined,
    ][]) {
      if (!cascade) continue;
      const existing = cascades[cascadeKind];
      cascades[cascadeKind] = {
        items: { ...(existing?.items ?? {}), ...cascade.items },
      };
    }
  }
  return { cascades };
}

describe("composeConversationStartRuntime — backend scoping", () => {
  it("composes only Claude cascades when backend is claude (ignores codex discovery)", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [claudeSkill("alpha")] },
        "claude-plugins": { items: [] },
        "claude-agents": { items: [] },
        // Codex cascade discovery, even when present, must not be consulted
        // when the active backend is Claude.
        "codex-skills": { items: [codexSkill("spec-init")] },
      },
      nativePluginRecords: [],
    });
    expect(result.backend).toBe("claude");
    expect(result.claudeRuntime).toBeDefined();
    expect(result.codexRuntime).toBeUndefined();
    expect(result.claudeRuntime?.skillOverrides).toEqual({ alpha: "off" });
    // The codex view must not even be present — the composer skipped it.
    expect(result.views["codex-skills"]).toBeUndefined();
  });

  it("composes only Codex cascades when backend is codex", () => {
    const result = composeConversationStartRuntime({
      backend: "codex",
      scope: { level: "conversation" },
      overrideChain: [{ layer: "global", overrides: undefined }],
      discoveryByCascade: {
        "codex-skills": { items: [codexSkill("spec-init")] },
        "codex-plugins": { items: [] },
        "claude-skills": { items: [claudeSkill("alpha")] },
      },
    });
    expect(result.backend).toBe("codex");
    expect(result.claudeRuntime).toBeUndefined();
    expect(result.codexRuntime).toBeDefined();
    expect(result.views["claude-skills"]).toBeUndefined();
    expect(result.views["codex-skills"]).toBeDefined();
  });
});

describe("composeConversationStartRuntime — Claude composition", () => {
  it("resolves plugin enablement before children so plugin-disabled skills emit as off", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-plugins", { "owner@m": false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": {
          items: [claudeSkill("child-skill", { owningPluginId: "owner@m" })],
        },
        "claude-plugins": { items: [claudePlugin("owner@m", true)] },
        "claude-agents": { items: [] },
      },
      nativePluginRecords: [
        { pluginId: "owner@m", nativeEnabled: true, nativeRawValue: true },
      ],
    });
    expect(result.claudeRuntime?.enabledPlugins).toEqual({ "owner@m": false });
    expect(result.claudeRuntime?.skillOverrides).toEqual({
      "child-skill": "off",
    });
  });

  it("collects disabled agent names for the suppression strategy", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-agents", { reviewer: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [] },
        "claude-plugins": { items: [] },
        "claude-agents": {
          items: [claudeAgent("reviewer", true), claudeAgent("explorer", true)],
        },
      },
      nativePluginRecords: [],
    });
    expect(result.claudeRuntime?.disabledAgentNames).toEqual(["reviewer"]);
    expect(result.claudeRuntime?.agentSuppressionStrategy.kind).toBe(
      "permission-layer",
    );
  });

  it("falls back to native defaults for a cascade marked as failed (no emission, no seeded state for it)", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [claudeSkill("alpha")] },
        // claude-plugins discovery failed — composer must not call the
        // translator for this cascade, and must not seed runtime state for it.
        "claude-agents": { items: [] },
      },
      failedCascadeKinds: ["claude-plugins"],
      nativePluginRecords: [],
    });
    // Skills cascade still composed.
    expect(result.claudeRuntime?.skillOverrides).toEqual({ alpha: "off" });
    // Plugin emission omitted entirely.
    expect(result.claudeRuntime?.enabledPlugins).toEqual({});
    // Runtime state was seeded only for the cascades that emitted.
    expect(result.runtimeState.cascades["claude-skills"]).toBeDefined();
    expect(result.runtimeState.cascades["claude-plugins"]).toBeUndefined();
    expect(result.runtimeState.cascades["claude-agents"]).toBeDefined();
    // Failed cascades are surfaced so the apply service can surface them as
    // retryable rejections rather than treating them as idempotent no-ops.
    expect(result.failedCascadeKinds).toEqual(["claude-plugins"]);
  });

  it("preserves diagnostics for a cascade marked as failed while omitting its runtime config", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [{ layer: "global", overrides: undefined }],
      discoveryByCascade: {
        "claude-skills": { items: [claudeSkill("alpha")] },
        "claude-plugins": {
          items: [claudePlugin("owner@m", true)],
          diagnostics: [
            {
              severity: "error",
              code: "claude-plugin-discovery-failed",
              message: "Plugin cache could not be read",
              cascadeKind: "claude-plugins",
              backend: "claude",
            },
          ],
        },
        "claude-agents": { items: [] },
      },
      failedCascadeKinds: ["claude-plugins"],
      nativePluginRecords: [
        { pluginId: "owner@m", nativeEnabled: true, nativeRawValue: true },
      ],
    });

    expect(result.claudeRuntime?.enabledPlugins).toEqual({});
    expect(result.runtimeState.cascades["claude-plugins"]).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "claude-plugin-discovery-failed",
        cascadeKind: "claude-plugins",
        backend: "claude",
      }),
    );
  });
});

describe("composeConversationStartRuntime — runtime hash seeding", () => {
  it("seeds a deterministic pendingHash per emitted cascade", () => {
    const input = {
      backend: "claude" as const,
      scope: { level: "conversation" as const },
      overrideChain: [
        {
          layer: "global" as const,
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [claudeSkill("alpha"), claudeSkill("beta")] },
        "claude-plugins": { items: [] },
        "claude-agents": { items: [] },
      },
      nativePluginRecords: [] as ClaudePluginNativeRecord[],
    };
    const a = composeConversationStartRuntime(input);
    const b = composeConversationStartRuntime(input);
    expect(a.runtimeState.cascades["claude-skills"]?.pendingHash).toEqual(
      b.runtimeState.cascades["claude-skills"]?.pendingHash,
    );
    expect(a.runtimeState.cascades["claude-skills"]?.pendingHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(a.runtimeState.cascades["claude-skills"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
    expect(a.runtimeState.cascades["claude-skills"]?.pendingItemIds).toEqual([
      "alpha",
    ]);
  });

  it("hash changes when an override flips an item's effective state", () => {
    const baseDiscovery = {
      "claude-skills": { items: [claudeSkill("alpha")] },
      "claude-plugins": { items: [] },
      "claude-agents": { items: [] },
    };
    const off = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: baseDiscovery,
      nativePluginRecords: [],
    });
    const on = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: true }),
        },
      ],
      discoveryByCascade: baseDiscovery,
      nativePluginRecords: [],
    });
    // off has explicit override (origin: global), on equals native default so
    // no skill emission → hashes differ.
    expect(off.runtimeState.cascades["claude-skills"]?.pendingHash).not.toEqual(
      on.runtimeState.cascades["claude-skills"]?.pendingHash,
    );
  });
});

describe("composeConversationStartRuntime — diagnostics", () => {
  it("aggregates discovery diagnostics + translator diagnostics, tagged with cascade and backend", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-plugins", { "ghost@m": true }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [] },
        "claude-plugins": {
          items: [claudePlugin("known@m", true)],
          diagnostics: [
            {
              severity: "warning",
              code: "claude-plugin-discovery-warning",
              message: "discovery noticed something",
              cascadeKind: "claude-plugins",
              backend: "claude",
            },
          ],
        },
        "claude-agents": { items: [] },
      },
      nativePluginRecords: [
        { pluginId: "known@m", nativeEnabled: true, nativeRawValue: true },
      ],
    });
    // Discovery diagnostic surfaces in the composed diagnostics list.
    const discoveryDiag = result.diagnostics.find(
      (d) => d.code === "claude-plugin-discovery-warning",
    );
    expect(discoveryDiag).toBeDefined();
    // Translator diagnostic (stale ghost@m override) surfaces with backend +
    // cascadeKind.
    const staleDiag = result.diagnostics.find(
      (d) => d.code === "claude-plugin-override-stale",
    );
    expect(staleDiag?.backend).toBe("claude");
    expect(staleDiag?.cascadeKind).toBe("claude-plugins");
  });
});

describe("composeConversationStartRuntime — determinism without I/O", () => {
  it("identical inputs produce byte-identical runtime state across many invocations", () => {
    const input = {
      backend: "claude" as const,
      scope: { level: "conversation" as const },
      overrideChain: [
        {
          layer: "global" as const,
          overrides: mergeOverrides(
            override("claude-skills", { alpha: false, beta: true }),
            override("claude-plugins", { "owner@m": false }),
            override("claude-agents", { reviewer: false }),
          ),
        },
      ],
      discoveryByCascade: {
        "claude-skills": {
          items: [
            claudeSkill("alpha"),
            claudeSkill("beta", { nativeEnabled: false }),
            claudeSkill("child", { owningPluginId: "owner@m" }),
          ],
        },
        "claude-plugins": { items: [claudePlugin("owner@m", true)] },
        "claude-agents": {
          items: [claudeAgent("reviewer", true), claudeAgent("explorer", true)],
        },
      },
      nativePluginRecords: [
        {
          pluginId: "owner@m",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        },
      ] as ClaudePluginNativeRecord[],
    };
    const runs = Array.from({ length: 5 }, () =>
      composeConversationStartRuntime(input),
    );
    const first = JSON.stringify(runs[0]?.runtimeState);
    for (const run of runs) {
      expect(JSON.stringify(run.runtimeState)).toBe(first);
    }
  });
});
