import { describe, expect, it } from "vitest";

import {
  agentCapabilityViewResponseSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeRuntimeState,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
  type AgentCapabilityRuntimeApplicationState,
} from "./schemas";

import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import {
  resolveCascadeView,
  resolvePluginEnablement,
  type ResolveCascadeViewInput,
} from "./resolver";

function override(items: Record<string, boolean>): AgentCapabilityOverrides {
  return {
    cascades: {
      "claude-skills": {
        items: Object.fromEntries(
          Object.entries(items).map(([id, enabled]) => [id, { enabled }]),
        ),
      },
    },
  };
}

function overrideFor(
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

function discoveredSkill(
  itemId: string,
  nativeEnabled: boolean,
  opts: {
    owningPluginId?: string;
    displayName?: string;
  } = {},
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: opts.displayName ?? itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/skills/${itemId}.md` },
    nativeDefault: { enabled: nativeEnabled },
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

function baseInput(
  partial: Partial<ResolveCascadeViewInput> & {
    cascadeKind: AgentCapabilityCascadeKind;
  },
): ResolveCascadeViewInput {
  return {
    cascadeKind: partial.cascadeKind,
    scope: partial.scope ?? { level: "conversation" },
    overrideChain: partial.overrideChain ?? [],
    discoveredItems: partial.discoveredItems ?? [],
    metadata:
      partial.metadata ??
      defaultAgentCapabilityMetadataRegistry.get(partial.cascadeKind),
    pluginResolution: partial.pluginResolution,
    runtimeApplyState: partial.runtimeApplyState,
    discoveryDiagnostics: partial.discoveryDiagnostics ?? [],
  };
}

describe("resolveCascadeView — four-layer inheritance (task 4.1)", () => {
  it("falls back to native default when no CC override exists at any layer", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    expect(view.items).toHaveLength(1);
    const row = view.items[0]!;
    expect(row.effectiveState).toEqual({
      enabled: true,
      originLayer: "native",
    });
    expect(row.originLayer).toBe("native");
    expect(row.ownEffectiveState).toEqual({
      enabled: true,
      originLayer: "native",
    });
  });

  it("narrowest explicit override wins over broader layers", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "conversation" },
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": false }) },
          { layer: "project", overrides: override({ "skill:a": true }) },
          { layer: "session", overrides: override({ "skill:a": false }) },
          { layer: "conversation", overrides: override({ "skill:a": true }) },
        ],
        discoveredItems: [discoveredSkill("skill:a", false)],
      }),
    );
    expect(view.items[0]!.effectiveState).toEqual({
      enabled: true,
      originLayer: "conversation",
    });
  });

  it("a broader layer wins when narrower layers have no override for the item", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "conversation" },
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": false }) },
          { layer: "project", overrides: undefined },
          { layer: "session", overrides: undefined },
          { layer: "conversation", overrides: undefined },
        ],
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    expect(view.items[0]!.effectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });
  });

  it("preserves the current-layer ownEffectiveState separately from inherited effectiveState", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "session" },
        overrideChain: [
          { layer: "global", overrides: undefined },
          { layer: "project", overrides: override({ "skill:a": false }) },
          { layer: "session", overrides: undefined },
        ],
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
    expect(row.ownEffectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
    expect(row.currentLayerValue).toBeUndefined();
    expect(row.inheritedEffectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
  });

  it("ownEffectiveState reflects the current-layer override when present", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "session" },
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": false }) },
          { layer: "project", overrides: undefined },
          { layer: "session", overrides: override({ "skill:a": true }) },
        ],
        discoveredItems: [discoveredSkill("skill:a", false)],
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState).toEqual({
      enabled: true,
      originLayer: "session",
    });
    expect(row.ownEffectiveState).toEqual({
      enabled: true,
      originLayer: "session",
    });
    expect(row.currentLayerValue).toEqual({
      enabled: true,
      originLayer: "session",
    });
    expect(row.inheritedEffectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });
  });

  it("falls through to native as the inherited state for a current-layer global override", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "global" },
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": false }) },
        ],
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    const row = view.items[0]!;
    expect(row.currentLayerValue).toEqual({
      enabled: false,
      originLayer: "global",
    });
    expect(row.inheritedEffectiveState).toEqual({
      enabled: true,
      originLayer: "native",
    });
  });

  it("produces deterministic effective hashes for identical inputs", () => {
    const a = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          {
            layer: "global",
            overrides: override({ "skill:b": false, "skill:a": true }),
          },
        ],
        discoveredItems: [
          discoveredSkill("skill:b", true),
          discoveredSkill("skill:a", true),
        ],
      }),
    );
    const b = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          {
            layer: "global",
            overrides: override({ "skill:a": true, "skill:b": false }),
          },
        ],
        discoveredItems: [
          discoveredSkill("skill:a", true),
          discoveredSkill("skill:b", true),
        ],
      }),
    );
    expect(a.effectiveHash).toBe(b.effectiveHash);
  });

  it("changes the effective hash when an override flips", () => {
    const a = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": true }) },
        ],
        discoveredItems: [discoveredSkill("skill:a", false)],
      }),
    );
    const b = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          { layer: "global", overrides: override({ "skill:a": false }) },
        ],
        discoveredItems: [discoveredSkill("skill:a", false)],
      }),
    );
    expect(a.effectiveHash).not.toBe(b.effectiveHash);
  });

  it("emits a parseable canonical view envelope", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [],
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    const parsed = agentCapabilityViewResponseSchema.safeParse(view);
    expect(parsed.success).toBe(true);
  });
});

describe("resolveCascadeView — stale override preservation (task 4.2)", () => {
  it("includes a stale row for an override id missing from discovery", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          { layer: "global", overrides: override({ "skill:gone": false }) },
        ],
        discoveredItems: [],
      }),
    );
    expect(view.items).toHaveLength(1);
    const row = view.items[0]!;
    expect(row.itemId).toBe("skill:gone");
    expect(row.stale).toBe(true);
    expect(row.runtimeVisibility).toBe("stale");
    expect(row.runtimeEmittable).toBe(false);
  });

  it("preserves the stale row's stored value and origin layer", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          { layer: "global", overrides: override({ "skill:gone": false }) },
          { layer: "project", overrides: override({ "skill:gone": true }) },
        ],
        discoveredItems: [],
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState).toEqual({
      enabled: true,
      originLayer: "project",
    });
    expect(row.ownEffectiveState).toEqual({
      enabled: true,
      originLayer: "project",
    });
  });

  it("preserves stale current-layer intent separately from inherited state", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "session" },
        overrideChain: [
          { layer: "global", overrides: override({ "skill:gone": false }) },
          { layer: "session", overrides: override({ "skill:gone": true }) },
        ],
        discoveredItems: [],
      }),
    );
    const row = view.items[0]!;
    expect(row.stale).toBe(true);
    expect(row.currentLayerValue).toEqual({
      enabled: true,
      originLayer: "session",
    });
    expect(row.inheritedEffectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });
  });

  it("reactivates a stale row when discovery returns the item again", () => {
    const overridesChain = [
      { layer: "global" as const, overrides: override({ "skill:a": false }) },
    ];

    const stale = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: overridesChain,
        discoveredItems: [],
      }),
    );
    expect(stale.items[0]!.stale).toBe(true);
    expect(stale.items[0]!.runtimeEmittable).toBe(false);

    const recovered = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: overridesChain,
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    const row = recovered.items[0]!;
    expect(row.stale).toBe(false);
    expect(row.runtimeVisibility).toBe("runtime-visible");
    expect(row.runtimeEmittable).toBe(true);
    expect(row.effectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });
  });

  it("emits a stale-override diagnostic per stale row", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          { layer: "session", overrides: override({ "skill:gone": false }) },
        ],
        discoveredItems: [],
      }),
    );
    expect(
      view.diagnostics.some(
        (d) => d.code === "agent-capability-stale-override",
      ),
    ).toBe(true);
  });

  it("marks discovered unavailable rows as not runtime-emittable", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          {
            ...discoveredSkill("skill:unavailable", true),
            runtimeVisibility: "unavailable",
          },
        ],
      }),
    );
    const row = view.items[0]!;
    expect(row.stale).toBe(false);
    expect(row.runtimeVisibility).toBe("unavailable");
    expect(row.runtimeEmittable).toBe(false);
  });
});

describe("resolveCascadeView — plugin parent-child disable (task 4.3)", () => {
  it("forces a plugin-owned child disabled when the parent plugin resolves disabled", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "global",
          overrides: overrideFor("claude-plugins", { "plugin:p": false }),
        },
      ],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution,
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState.enabled).toBe(false);
    expect(row.inheritedDisableReason).toEqual({
      pluginId: "plugin:p",
      originLayer: "global",
    });
    expect(row.ownEffectiveState.enabled).toBe(true);
  });

  it("re-enables children when a narrower layer re-enables the parent plugin", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "global",
          overrides: overrideFor("claude-plugins", { "plugin:p": false }),
        },
        {
          layer: "session",
          overrides: overrideFor("claude-plugins", { "plugin:p": true }),
        },
      ],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution,
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState.enabled).toBe(true);
    expect(row.inheritedDisableReason).toBeUndefined();
  });

  it("preserves the child's own override so re-enabling the parent restores it", () => {
    const childOverride: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    };

    const disabledPlugin = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "global",
          overrides: overrideFor("claude-plugins", { "plugin:p": false }),
        },
      ],
    });

    const childForcedDisabled = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [{ layer: "global", overrides: childOverride }],
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution: disabledPlugin,
      }),
    );
    expect(childForcedDisabled.items[0]!.ownEffectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });

    const enabledPlugin = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [],
    });

    const childAfterReenable = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [{ layer: "global", overrides: childOverride }],
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution: enabledPlugin,
      }),
    );
    expect(childAfterReenable.items[0]!.effectiveState).toEqual({
      enabled: false,
      originLayer: "global",
    });
    expect(childAfterReenable.items[0]!.inheritedDisableReason).toBeUndefined();
  });

  it("does not let a child override re-enable through a disabled parent plugin", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "project",
          overrides: overrideFor("claude-plugins", { "plugin:p": false }),
        },
      ],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        scope: { level: "conversation" },
        overrideChain: [
          {
            layer: "conversation",
            overrides: override({ "skill:a": true }),
          },
        ],
        discoveredItems: [
          discoveredSkill("skill:a", false, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution,
      }),
    );

    const row = view.items[0]!;
    expect(row.ownEffectiveState).toEqual({
      enabled: true,
      originLayer: "conversation",
    });
    expect(row.effectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
    expect(row.inheritedDisableReason).toEqual({
      pluginId: "plugin:p",
      originLayer: "project",
    });
  });

  it("does not force-disable siblings owned by a different plugin", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [
        discoveredPlugin("plugin:p", true),
        discoveredPlugin("plugin:q", true),
      ],
      overrideChain: [
        {
          layer: "global",
          overrides: overrideFor("claude-plugins", { "plugin:p": false }),
        },
      ],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
          discoveredSkill("skill:b", true, { owningPluginId: "plugin:q" }),
          discoveredSkill("skill:c", true),
        ],
        pluginResolution,
      }),
    );
    const rowsById = new Map(view.items.map((r) => [r.itemId, r]));
    expect(rowsById.get("skill:a")!.effectiveState.enabled).toBe(false);
    expect(rowsById.get("skill:b")!.effectiveState.enabled).toBe(true);
    expect(rowsById.get("skill:c")!.effectiveState.enabled).toBe(true);
    expect(rowsById.get("skill:c")!.inheritedDisableReason).toBeUndefined();
  });

  it("forces a plugin-bundled codex-skill disabled when its parent codex-plugin resolves disabled", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "codex-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "project",
          overrides: overrideFor("codex-plugins", { "plugin:p": false }),
        },
      ],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "codex-skills",
        discoveredItems: [
          discoveredSkill("codex-skill:a", true, {
            owningPluginId: "plugin:p",
          }),
        ],
        pluginResolution,
      }),
    );
    const row = view.items[0]!;
    expect(row.ownEffectiveState).toEqual({
      enabled: true,
      originLayer: "native",
    });
    expect(row.effectiveState).toEqual({
      enabled: false,
      originLayer: "project",
    });
    expect(row.inheritedDisableReason).toEqual({
      pluginId: "plugin:p",
      originLayer: "project",
    });
  });

  it("leaves plugin-bundled codex-skills with their own toggle when the codex-plugin is enabled", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "codex-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [],
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "codex-skills",
        overrideChain: [
          {
            layer: "session",
            overrides: overrideFor("codex-skills", {
              "codex-skill:a": false,
            }),
          },
        ],
        discoveredItems: [
          discoveredSkill("codex-skill:a", true, {
            owningPluginId: "plugin:p",
          }),
        ],
        pluginResolution,
      }),
    );
    const row = view.items[0]!;
    expect(row.effectiveState).toEqual({
      enabled: false,
      originLayer: "session",
    });
    expect(row.inheritedDisableReason).toBeUndefined();
  });

  it("ignores codex-plugins overrides when resolving Claude parent enablement", () => {
    const sharedChain = [
      {
        layer: "global" as const,
        overrides: overrideFor("codex-plugins", { "plugin:p": false }),
      },
    ];

    const claudePluginMap = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: sharedChain,
    });

    expect(claudePluginMap.get("plugin:p")).toEqual({
      enabled: true,
      originLayer: "native",
    });

    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          discoveredSkill("skill:a", true, { owningPluginId: "plugin:p" }),
        ],
        pluginResolution: claudePluginMap,
      }),
    );
    expect(view.items[0]!.effectiveState.enabled).toBe(true);
    expect(view.items[0]!.inheritedDisableReason).toBeUndefined();
  });

  it("does not let unrelated cascade overrides on the same layer pollute the plugin map", () => {
    const map = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: [
        {
          layer: "session",
          overrides: {
            cascades: {
              "claude-skills": { items: { "plugin:p": { enabled: false } } },
              "codex-plugins": { items: { "plugin:p": { enabled: false } } },
              "codex-skills": { items: { "plugin:p": { enabled: false } } },
              "claude-agents": { items: { "plugin:p": { enabled: false } } },
            },
          },
        },
      ],
    });
    expect(map.get("plugin:p")).toEqual({
      enabled: true,
      originLayer: "native",
    });
  });

  it("resolves Claude and Codex plugin enablement independently from one shared chain", () => {
    const sharedChain = [
      {
        layer: "global" as const,
        overrides: {
          cascades: {
            "claude-plugins": { items: { "plugin:p": { enabled: false } } },
            "codex-plugins": { items: { "plugin:p": { enabled: true } } },
          },
        },
      },
    ];

    const claudeMap = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", true)],
      overrideChain: sharedChain,
    });
    const codexMap = resolvePluginEnablement({
      pluginCascadeKind: "codex-plugins",
      discoveredPlugins: [discoveredPlugin("plugin:p", false)],
      overrideChain: sharedChain,
    });

    expect(claudeMap.get("plugin:p")).toEqual({
      enabled: false,
      originLayer: "global",
    });
    expect(codexMap.get("plugin:p")).toEqual({
      enabled: true,
      originLayer: "global",
    });
  });

  it("resolves a large plugin-owned inventory deterministically without leaking parent disables to unrelated children", () => {
    const pluginResolution = resolvePluginEnablement({
      pluginCascadeKind: "claude-plugins",
      discoveredPlugins: [
        discoveredPlugin("plugin:disabled", true),
        discoveredPlugin("plugin:enabled", true),
      ],
      overrideChain: [
        {
          layer: "global",
          overrides: overrideFor("claude-plugins", {
            "plugin:disabled": false,
          }),
        },
      ],
    });
    const discoveredItems = Array.from({ length: 1_000 }, (_, index) =>
      discoveredSkill(`skill:${index.toString().padStart(4, "0")}`, true, {
        owningPluginId: index % 2 === 0 ? "plugin:disabled" : "plugin:enabled",
      }),
    );

    const first = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems,
        pluginResolution,
      }),
    );
    const second = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [...discoveredItems].reverse(),
        pluginResolution,
      }),
    );

    expect(first.items).toHaveLength(1_000);
    expect(first.effectiveHash).toBe(second.effectiveHash);
    expect(
      first.items.filter((row) => row.effectiveState.enabled),
    ).toHaveLength(500);
    expect(
      first.items.filter((row) => row.inheritedDisableReason !== undefined),
    ).toHaveLength(500);
  });
});

describe("resolveCascadeView — runtime status attachment (task 4.4)", () => {
  function runtimeWith(
    cascadeKind: AgentCapabilityCascadeKind,
    state: AgentCapabilityCascadeRuntimeState,
  ): AgentCapabilityRuntimeApplicationState {
    return { cascades: { [cascadeKind]: state } };
  }

  it("Claude items reflect staged-idle status from pending apply records", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
        overrideChain: [
          { layer: "conversation", overrides: override({ "skill:a": false }) },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          pendingHash: "h1",
          pendingItemIds: ["skill:a"],
          lastApplyStatus: "staged-idle",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("staged-idle");
  });

  it("Claude items reflect applied status when no pending state lingers", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
        overrideChain: [
          { layer: "conversation", overrides: override({ "skill:a": false }) },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "applied",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("applied");
  });

  it("Codex items reflect staged-next-turn when pending and Codex apply semantics is next-turn", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "codex-skills",
        discoveredItems: [
          {
            itemId: "codex-skill:a",
            displayName: "codex-skill:a",
            capabilityKind: "skill",
            source: { kind: "user-file", path: "/x.md" },
            nativeDefault: { enabled: true },
            runtimeVisibility: "source-only",
          },
        ],
        overrideChain: [
          {
            layer: "conversation",
            overrides: overrideFor("codex-skills", { "codex-skill:a": false }),
          },
        ],
        runtimeApplyState: runtimeWith("codex-skills", {
          pendingHash: "h1",
          pendingItemIds: ["codex-skill:a"],
          lastApplyStatus: "staged-next-turn",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("staged-next-turn");
  });

  it("stale rows do not report runtime-applied status from cascade-level state", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        overrideChain: [
          {
            layer: "conversation",
            overrides: override({ "skill:gone": false }),
          },
        ],
        discoveredItems: [],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "applied",
        }),
      }),
    );
    expect(view.items[0]!.runtimeEmittable).toBe(false);
    expect(view.items[0]!.applyStatus).toBe("none");
  });

  it("unavailable rows do not report runtime-applied status from cascade-level state", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          {
            ...discoveredSkill("skill:unavailable", true),
            runtimeVisibility: "unavailable",
          },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "applied",
        }),
      }),
    );
    expect(view.items[0]!.runtimeEmittable).toBe(false);
    expect(view.items[0]!.applyStatus).toBe("none");
  });

  it("Claude sub-agents report deferred-next-conversation when the change is pending", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-agents",
        discoveredItems: [
          {
            itemId: "agent:a",
            displayName: "agent:a",
            capabilityKind: "agent",
            source: { kind: "sdk-runtime" },
            nativeDefault: { enabled: true },
            runtimeVisibility: "runtime-visible",
          },
        ],
        overrideChain: [
          {
            layer: "conversation",
            overrides: overrideFor("claude-agents", { "agent:a": false }),
          },
        ],
        runtimeApplyState: runtimeWith("claude-agents", {
          pendingHash: "h1",
          pendingItemIds: ["agent:a"],
          lastApplyStatus: "deferred-next-conversation",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("deferred-next-conversation");
  });

  it("rejected status surfaces from runtime apply records when not in pending list", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
        overrideChain: [
          { layer: "conversation", overrides: override({ "skill:a": false }) },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "rejected",
          lastApplyError: "boom",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("rejected");
  });

  it("rejected rows surface lastApplyError as a per-row and response-level diagnostic", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
        overrideChain: [
          { layer: "conversation", overrides: override({ "skill:a": false }) },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "rejected",
          lastApplyError: "plugin reload failed: timeout",
        }),
      }),
    );
    const row = view.items[0]!;
    expect(row.applyStatus).toBe("rejected");
    expect(row.diagnostics).toHaveLength(1);
    const rowDiag = row.diagnostics[0]!;
    expect(rowDiag.code).toBe("agent-capability-apply-failed");
    expect(rowDiag.severity).toBe("error");
    expect(rowDiag.message).toBe("plugin reload failed: timeout");
    expect(rowDiag.itemId).toBe("skill:a");
    expect(rowDiag.cascadeKind).toBe("claude-skills");
    expect(rowDiag.backend).toBe("claude");
    expect(
      view.diagnostics.some(
        (d) =>
          d.code === "agent-capability-apply-failed" && d.itemId === "skill:a",
      ),
    ).toBe(true);
  });

  it("does not emit an apply-failed diagnostic when there is no lastApplyError", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          lastApplyStatus: "rejected",
        }),
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("rejected");
    expect(view.items[0]!.diagnostics).toHaveLength(0);
    expect(
      view.diagnostics.some((d) => d.code === "agent-capability-apply-failed"),
    ).toBe(false);
  });

  it("only attaches apply-failed diagnostics to rejected rows, not to siblings", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [
          discoveredSkill("skill:a", true),
          discoveredSkill("skill:b", true),
        ],
        overrideChain: [
          {
            layer: "conversation",
            overrides: override({ "skill:a": false }),
          },
        ],
        runtimeApplyState: runtimeWith("claude-skills", {
          appliedHash: "h0",
          pendingHash: "h1",
          pendingItemIds: ["skill:a"],
          lastApplyStatus: "rejected",
          lastApplyError: "denied by guard",
        }),
      }),
    );
    const rowsById = new Map(view.items.map((r) => [r.itemId, r]));
    expect(rowsById.get("skill:a")!.applyStatus).toBe("rejected");
    expect(rowsById.get("skill:a")!.diagnostics).toHaveLength(1);
    expect(rowsById.get("skill:b")!.applyStatus).toBe("rejected");
    expect(rowsById.get("skill:b")!.diagnostics).toHaveLength(0);
  });

  it("reports none when there is no runtime apply record", () => {
    const view = resolveCascadeView(
      baseInput({
        cascadeKind: "claude-skills",
        discoveredItems: [discoveredSkill("skill:a", true)],
      }),
    );
    expect(view.items[0]!.applyStatus).toBe("none");
  });
});
