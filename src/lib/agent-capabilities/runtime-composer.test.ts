import { describe, expect, it } from "vitest";

import {
  type AgentCapabilityCascadeKind,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
} from "./schemas";

import type { ResolvedCapabilityItem } from "@/lib/agent-backends/runtime-config";
import type { CapabilityKind } from "@/lib/agent-backends/descriptor";
import {
  composeConversationStartRuntime,
  type ComposeConversationStartResult,
} from "./runtime-composer";

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

function codexSkill(
  itemId: string,
  opts: { owningPluginId?: string } = {},
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/codex-skills/${itemId}/SKILL.md` },
    nativeDefault: { enabled: true },
    owningPluginId: opts.owningPluginId,
    runtimeVisibility: "source-only",
  };
}

function codexPlugin(
  itemId: string,
  nativeEnabled: boolean,
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "plugin",
    source: { kind: "plugin", pluginId: itemId },
    nativeDefault: { enabled: nativeEnabled },
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

function kindItems(
  result: ComposeConversationStartResult,
  kind: CapabilityKind,
): readonly ResolvedCapabilityItem[] | undefined {
  return result.capabilities.kinds.find((entry) => entry.kind === kind)?.items;
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
    });
    expect(result.backend).toBe("claude");
    expect(result.capabilities.backend).toBe("claude");
    expect(kindItems(result, "skills")).toContainEqual({
      itemId: "alpha",
      enabled: false,
      originLayer: "global",
    });
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
    expect(result.capabilities.backend).toBe("codex");
    expect(result.views["claude-skills"]).toBeUndefined();
    expect(result.views["codex-skills"]).toBeDefined();
    expect(kindItems(result, "skills")).toContainEqual({
      itemId: "spec-init",
      enabled: true,
      originLayer: "native",
    });
  });
});

describe("composeConversationStartRuntime — Claude composition", () => {
  it("resolves plugin enablement before children so plugin-disabled skills project as off", () => {
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
    });
    expect(kindItems(result, "plugins")).toContainEqual({
      itemId: "owner@m",
      enabled: false,
      originLayer: "global",
    });
    expect(kindItems(result, "skills")).toContainEqual({
      itemId: "child-skill",
      enabled: false,
      originLayer: "global",
    });
  });

  it("carries disabled agents with their deciding layer for adapter-side suppression", () => {
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
    });
    expect(kindItems(result, "agents")).toEqual([
      { itemId: "explorer", enabled: true, originLayer: "native" },
      { itemId: "reviewer", enabled: false, originLayer: "global" },
    ]);
  });

  it("falls back to native defaults for a cascade marked as failed (no cascade entry, no seeded state for it)", () => {
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
        // claude-plugins discovery failed — composer must not project the
        // cascade, and must not seed runtime state for it.
        "claude-agents": { items: [] },
      },
      failedCascadeKinds: ["claude-plugins"],
    });
    // Skills cascade still composed.
    expect(kindItems(result, "skills")).toContainEqual({
      itemId: "alpha",
      enabled: false,
      originLayer: "global",
    });
    // Plugin cascade omitted entirely.
    expect(kindItems(result, "plugins")).toBeUndefined();
    // Runtime state was seeded only for the cascades that composed.
    expect(result.runtimeState.cascades["claude-skills"]).toBeDefined();
    expect(result.runtimeState.cascades["claude-plugins"]).toBeUndefined();
    expect(result.runtimeState.cascades["claude-agents"]).toBeDefined();
    // Failed cascades are surfaced so the apply service can surface them as
    // retryable rejections rather than treating them as idempotent no-ops.
    expect(result.failedCascadeKinds).toEqual(["claude-plugins"]);
  });

  it("preserves diagnostics for a cascade marked as failed while omitting its cascade entry", () => {
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
    });

    expect(kindItems(result, "plugins")).toBeUndefined();
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

describe("composeConversationStartRuntime — project conversations", () => {
  it("composes Claude PLCs from global, project, and conversation layers without session plugin overrides", () => {
    const result = composeConversationStartRuntime({
      backend: "claude",
      scope: {
        level: "conversation",
        projectName: "Repo",
        conversationScope: "project",
        conversationId: "plc-1",
      },
      overrideChain: [
        {
          layer: "global",
          overrides: mergeOverrides(
            override("claude-skills", { alpha: false }),
            override("claude-plugins", { "owner@m": true }),
          ),
        },
        {
          layer: "project",
          overrides: mergeOverrides(
            override("claude-skills", { alpha: true }),
            override("claude-plugins", { "owner@m": true }),
          ),
        },
        {
          layer: "session",
          overrides: mergeOverrides(
            override("claude-skills", { alpha: false }),
            override("claude-plugins", { "owner@m": false }),
          ),
        },
        {
          layer: "conversation",
          overrides: override("claude-agents", { reviewer: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": {
          items: [
            claudeSkill("alpha"),
            claudeSkill("child", { owningPluginId: "owner@m" }),
          ],
        },
        "claude-plugins": { items: [claudePlugin("owner@m", true)] },
        "claude-agents": {
          items: [claudeAgent("reviewer", true), claudeAgent("helper", true)],
        },
      },
    });

    const alpha = result.views["claude-skills"]?.items.find(
      (row) => row.itemId === "alpha",
    );
    const child = result.views["claude-skills"]?.items.find(
      (row) => row.itemId === "child",
    );

    expect(result.views["claude-skills"]?.conversationScope).toBe("project");
    expect(result.views["claude-skills"]?.sessionName).toBeUndefined();
    expect(alpha?.effectiveState).toEqual({
      enabled: true,
      originLayer: "project",
    });
    expect(child?.effectiveState.enabled).toBe(true);
    expect(child?.inheritedDisableReason).toBeUndefined();
    expect(kindItems(result, "skills")).toContainEqual({
      itemId: "alpha",
      enabled: true,
      originLayer: "project",
    });
    expect(kindItems(result, "agents")).toContainEqual({
      itemId: "reviewer",
      enabled: false,
      originLayer: "conversation",
    });
    expect(result.runtimeState.cascades["claude-skills"]?.pendingHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("composes Codex PLCs from global, project, and conversation layers without session plugin overrides", () => {
    const result = composeConversationStartRuntime({
      backend: "codex",
      scope: {
        level: "conversation",
        projectName: "Repo",
        conversationScope: "project",
        conversationId: "plc-2",
      },
      overrideChain: [
        {
          layer: "global",
          overrides: override("codex-skills", { alpha: true }),
        },
        {
          layer: "project",
          overrides: override("codex-plugins", { "codex-owner": true }),
        },
        {
          layer: "session",
          overrides: mergeOverrides(
            override("codex-skills", { alpha: true }),
            override("codex-plugins", { "codex-owner": false }),
          ),
        },
        {
          layer: "conversation",
          overrides: override("codex-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "codex-skills": {
          items: [
            codexSkill("alpha"),
            codexSkill("child", { owningPluginId: "codex-owner" }),
          ],
        },
        "codex-plugins": { items: [codexPlugin("codex-owner", true)] },
        "claude-skills": { items: [claudeSkill("alpha")] },
      },
    });

    const child = result.views["codex-skills"]?.items.find(
      (row) => row.itemId === "child",
    );

    expect(result.views["codex-skills"]?.conversationScope).toBe("project");
    expect(result.views["codex-skills"]?.sessionName).toBeUndefined();
    expect(result.views["claude-skills"]).toBeUndefined();
    expect(child?.effectiveState.enabled).toBe(true);
    expect(child?.inheritedDisableReason).toBeUndefined();
    expect(kindItems(result, "skills")).toEqual([
      { itemId: "alpha", enabled: false, originLayer: "conversation" },
      { itemId: "child", enabled: true, originLayer: "native" },
    ]);
    expect(kindItems(result, "plugins")).toEqual([
      { itemId: "codex-owner", enabled: true, originLayer: "project" },
    ]);
  });
});

describe("composeConversationStartRuntime — runtime hash seeding", () => {
  it("seeds a deterministic pendingHash per composed cascade over its non-native rows", () => {
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
    });
    // off has an explicit override (origin: global); on equals the native
    // default so the row resolves at native and stays out of the hash basis.
    expect(off.runtimeState.cascades["claude-skills"]?.pendingHash).not.toEqual(
      on.runtimeState.cascades["claude-skills"]?.pendingHash,
    );
  });

  it("hash ignores native-origin rows (native drift does not perturb idempotency)", () => {
    const withNativeOnly = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": { items: [claudeSkill("alpha"), claudeSkill("beta")] },
      },
    });
    const withExtraNative = composeConversationStartRuntime({
      backend: "claude",
      scope: { level: "conversation" },
      overrideChain: [
        {
          layer: "global",
          overrides: override("claude-skills", { alpha: false }),
        },
      ],
      discoveryByCascade: {
        "claude-skills": {
          items: [
            claudeSkill("alpha"),
            claudeSkill("beta"),
            claudeSkill("gamma"),
          ],
        },
      },
    });
    expect(
      withNativeOnly.runtimeState.cascades["claude-skills"]?.pendingHash,
    ).toEqual(
      withExtraNative.runtimeState.cascades["claude-skills"]?.pendingHash,
    );
  });
});

describe("composeConversationStartRuntime — diagnostics", () => {
  it("aggregates discovery and resolver diagnostics, tagged with cascade and backend", () => {
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
    });
    // Discovery diagnostic surfaces in the composed diagnostics list.
    const discoveryDiag = result.diagnostics.find(
      (d) => d.code === "claude-plugin-discovery-warning",
    );
    expect(discoveryDiag).toBeDefined();
    // Resolver stale-row diagnostic (ghost@m override matches no discovered
    // plugin) surfaces with backend + cascadeKind.
    const staleDiag = result.diagnostics.find(
      (d) => d.code === "agent-capability-stale-override",
    );
    expect(staleDiag?.backend).toBe("claude");
    expect(staleDiag?.cascadeKind).toBe("claude-plugins");
    // Stale rows never reach the neutral cascade.
    expect(kindItems(result, "plugins")).toEqual([
      { itemId: "known@m", enabled: true, originLayer: "native" },
    ]);
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
