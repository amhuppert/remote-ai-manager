import { describe, expect, it } from "vitest";

import {
  type AgentCapabilityCascadeKind,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
  type AgentCapabilityViewResponse,
} from "@/lib/schemas";

import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import { resolveCascadeView, resolvePluginEnablement } from "./resolver";
import { translateClaudeRuntimeCapabilities } from "./claude-runtime-translator";
import type { ClaudePluginNativeRecord } from "./claude-plugin-translator";

function discoveredSkill(
  itemId: string,
  opts: { nativeEnabled?: boolean; owningPluginId?: string } = {},
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/skills/${itemId}.md` },
    nativeDefault: { enabled: opts.nativeEnabled ?? true },
    owningPluginId: opts.owningPluginId,
    runtimeVisibility: "runtime-visible",
  };
}

function discoveredPlugin(
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

function discoveredAgent(
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

function resolveSkills(
  discoveredItems: AgentCapabilityDiscoveredItem[],
  overrides: AgentCapabilityOverrides | undefined,
): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "claude-skills",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides }],
    discoveredItems,
    metadata: defaultAgentCapabilityMetadataRegistry.get("claude-skills"),
  });
}

function resolvePlugins(
  discoveredItems: AgentCapabilityDiscoveredItem[],
  overrides: AgentCapabilityOverrides | undefined,
): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "claude-plugins",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides }],
    discoveredItems,
    metadata: defaultAgentCapabilityMetadataRegistry.get("claude-plugins"),
  });
}

function resolveAgents(
  discoveredItems: AgentCapabilityDiscoveredItem[],
  overrides: AgentCapabilityOverrides | undefined,
): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "claude-agents",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides }],
    discoveredItems,
    metadata: defaultAgentCapabilityMetadataRegistry.get("claude-agents"),
  });
}

describe("translateClaudeRuntimeCapabilities — skills", () => {
  it("emits only CC-explicit skill overrides; omits rows still at native default", () => {
    const skillsView = resolveSkills(
      [discoveredSkill("alpha"), discoveredSkill("beta")],
      override("claude-skills", { alpha: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
      agentsView: undefined,
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({ alpha: "off" });
  });

  it("emits both on and off for explicit overrides at non-native layers", () => {
    const skillsView = resolveSkills(
      [
        discoveredSkill("alpha", { nativeEnabled: false }),
        discoveredSkill("beta"),
      ],
      override("claude-skills", { alpha: true, beta: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
      agentsView: undefined,
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({
      alpha: "on",
      beta: "off",
    });
  });

  it("records emission rows for the composer's runtime hash", () => {
    const skillsView = resolveSkills(
      [discoveredSkill("alpha")],
      override("claude-skills", { alpha: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
      agentsView: undefined,
      nativePluginRecords: [],
    });
    const skillsEmission = result.emissions.find(
      (e) => e.cascadeKind === "claude-skills",
    );
    expect(skillsEmission?.emittedRows).toEqual([
      { itemId: "alpha", enabled: false },
    ]);
  });
});

describe("translateClaudeRuntimeCapabilities — plugins", () => {
  it("emits a minimal delta against native and preserves siblings by omission", () => {
    const pluginsView = resolvePlugins(
      [
        discoveredPlugin("formatter@m", true),
        discoveredPlugin("linter@m", true),
        discoveredPlugin("ghost@m", false),
      ],
      override("claude-plugins", { "linter@m": false, "ghost@m": true }),
    );
    const native: ClaudePluginNativeRecord[] = [
      {
        pluginId: "formatter@m",
        nativeEnabled: true,
        nativeRawValue: { version: "1.2.0" },
      },
      { pluginId: "linter@m", nativeEnabled: true, nativeRawValue: true },
      { pluginId: "ghost@m", nativeEnabled: false, nativeRawValue: false },
    ];
    const result = translateClaudeRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
      agentsView: undefined,
      nativePluginRecords: native,
    });
    // formatter omitted (no CC override, would preserve native object).
    // linter present with `false` (CC disabled a natively enabled plugin).
    // ghost present with `true` (CC enabled a natively disabled plugin).
    expect(result.config.enabledPlugins).toEqual({
      "linter@m": false,
      "ghost@m": true,
    });
  });

  it("surfaces stale-id translator diagnostics as agent-capability diagnostics with backend + cascade", () => {
    const pluginsView = resolvePlugins(
      [discoveredPlugin("known@m", true)],
      override("claude-plugins", { "known@m": false, "ghost@m": true }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
      agentsView: undefined,
      nativePluginRecords: [
        { pluginId: "known@m", nativeEnabled: true, nativeRawValue: true },
      ],
    });
    // Resolver already produced a stale-row diagnostic; translator adds the
    // plugin-translator's own stale-id diagnostic with backend metadata.
    const staleDiag = result.diagnostics.find(
      (d) => d.code === "claude-plugin-override-stale",
    );
    expect(staleDiag?.backend).toBe("claude");
    expect(staleDiag?.cascadeKind).toBe("claude-plugins");
    expect(staleDiag?.itemId).toBe("ghost@m");
  });
});

describe("translateClaudeRuntimeCapabilities — agents", () => {
  it("collects the names of every agent CC has resolved to disabled", () => {
    const agentsView = resolveAgents(
      [
        discoveredAgent("reviewer", true),
        discoveredAgent("explorer", true),
        discoveredAgent("planner", true),
      ],
      override("claude-agents", { reviewer: false, planner: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView: undefined,
      pluginsView: undefined,
      agentsView,
      nativePluginRecords: [],
    });
    expect(result.config.disabledAgentNames.slice().sort()).toEqual([
      "planner",
      "reviewer",
    ]);
  });

  it("returns the verified permission-layer suppression strategy metadata", () => {
    const agentsView = resolveAgents(
      [discoveredAgent("reviewer", true)],
      undefined,
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView: undefined,
      pluginsView: undefined,
      agentsView,
      nativePluginRecords: [],
    });
    expect(result.config.agentSuppressionStrategy.kind).toBe(
      "permission-layer",
    );
    expect(result.config.agentSuppressionStrategy.applyPoint).toBe(
      "next-conversation",
    );
  });
});

describe("translateClaudeRuntimeCapabilities — plugin parent-child preservation", () => {
  it("preserves the plugin-disabled child's effective state in emission (parent reload semantics own the removal)", () => {
    // A child skill owned by a plugin whose parent is CC-disabled.
    const skillDisco = discoveredSkill("contrib-skill", {
      owningPluginId: "owner@m",
    });
    const pluginDisco = discoveredPlugin("owner@m", true);

    const overrides = override("claude-plugins", { "owner@m": false });

    const pluginsView = resolvePlugins([pluginDisco], overrides);
    // Build the plugin map so the child resolver knows the parent is disabled.
    const pluginMap = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [pluginDisco],
      overrideChain: [{ layer: "global", overrides }],
    });
    const skillsView = resolveCascadeView({
      cascadeKind: "claude-skills",
      scope: { level: "conversation" },
      overrideChain: [{ layer: "global", overrides }],
      discoveredItems: [skillDisco],
      metadata: defaultAgentCapabilityMetadataRegistry.get("claude-skills"),
      pluginResolution: pluginMap,
    });

    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView,
      agentsView: undefined,
      nativePluginRecords: [
        { pluginId: "owner@m", nativeEnabled: true, nativeRawValue: true },
      ],
    });

    // Plugin emits `false` (CC disabled a natively enabled plugin).
    expect(result.config.enabledPlugins).toEqual({ "owner@m": false });
    // The plugin-disabled child does NOT produce its own skill override —
    // the resolved origin layer for its forced-disabled state is `global`
    // (the layer that disabled the plugin) and the effective enabled flag
    // is false. It IS emitted as an explicit `off` so the SDK reflects the
    // disabled state even if `reloadPlugins()` is delayed.
    expect(result.config.skillOverrides).toEqual({ "contrib-skill": "off" });
  });
});

describe("translateClaudeRuntimeCapabilities — per-cascade failure isolation", () => {
  it("returns empty defaults for cascades whose view is undefined and processes the others", () => {
    const skillsView = resolveSkills(
      [discoveredSkill("alpha")],
      override("claude-skills", { alpha: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
      agentsView: undefined,
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({ alpha: "off" });
    expect(result.config.enabledPlugins).toEqual({});
    expect(result.config.disabledAgentNames).toEqual([]);
    expect(
      result.emissions.find((e) => e.cascadeKind === "claude-plugins"),
    ).toBeUndefined();
    expect(
      result.emissions.find((e) => e.cascadeKind === "claude-agents"),
    ).toBeUndefined();
  });

  it("excludes stale rows from emission so a removed item no longer contributes to the runtime payload", () => {
    // The override targets `gone` which is not in current discovery: the
    // resolver produces a stale row with runtimeEmittable=false; the
    // translator must omit it.
    const skillsView = resolveSkills(
      [discoveredSkill("alpha")],
      override("claude-skills", { alpha: false, gone: false }),
    );
    const result = translateClaudeRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
      agentsView: undefined,
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({ alpha: "off" });
  });
});
