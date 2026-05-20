import { describe, expect, it } from "vitest";

import {
  type AgentCapabilityCascadeKind,
  type AgentCapabilityDiscoveredItem,
  type AgentCapabilityOverrides,
  type AgentCapabilityViewResponse,
} from "@/lib/schemas";

import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import { resolveCascadeView } from "./resolver";
import { translateCodexRuntimeCapabilities } from "./codex-runtime-translator";

function discoveredCodexSkill(itemId: string): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "skill",
    source: { kind: "user-file", path: `/codex-skills/${itemId}.md` },
    nativeDefault: { enabled: true },
    runtimeVisibility: "source-only",
  };
}

function discoveredCodexPlugin(
  itemId: string,
  enabled: boolean,
): AgentCapabilityDiscoveredItem {
  return {
    itemId,
    displayName: itemId,
    capabilityKind: "plugin",
    source: { kind: "user-file", path: `/codex/config.toml` },
    nativeDefault: { enabled },
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

function resolveCodexSkills(
  discoveredItems: AgentCapabilityDiscoveredItem[],
  overrides: AgentCapabilityOverrides | undefined,
): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "codex-skills",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides }],
    discoveredItems,
    metadata: defaultAgentCapabilityMetadataRegistry.get("codex-skills"),
  });
}

function resolveCodexPlugins(
  discoveredItems: AgentCapabilityDiscoveredItem[],
  overrides: AgentCapabilityOverrides | undefined,
): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "codex-plugins",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides }],
    discoveredItems,
    metadata: defaultAgentCapabilityMetadataRegistry.get("codex-plugins"),
  });
}

describe("translateCodexRuntimeCapabilities — skills emission", () => {
  it("emits skills.config[] with every resolved skill, preserving enable/disable state", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init"), discoveredCodexSkill("spec-tasks")],
      override("codex-skills", { "spec-tasks": false }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
    });

    const emitted = result.config.skills?.config ?? [];
    const byName = Object.fromEntries(
      emitted.map((entry) => [entry.name, entry.enabled]),
    );
    expect(byName).toEqual({
      "spec-init": true,
      "spec-tasks": false,
    });
    expect(result.applySemantics).toBe("next-turn");
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a single disabled skill explicitly so the disable carries", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init")],
      override("codex-skills", { "spec-init": false }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
    });

    expect(result.config.skills?.config).toEqual([
      { enabled: false, name: "spec-init" },
    ]);
  });

  it("records a skills cascade emission entry so the composer can hash + seed pending state", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init")],
      undefined,
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
    });
    const skillsEmission = result.emissions.find(
      (e) => e.cascadeKind === "codex-skills",
    );
    expect(skillsEmission).toBeDefined();
  });
});

describe("translateCodexRuntimeCapabilities — plugins emission", () => {
  it("emits an enabled plugin into the verified plugins.NAME shape", () => {
    const pluginsView = resolveCodexPlugins(
      [discoveredCodexPlugin("oh-my-codex", true)],
      undefined,
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
    });

    expect(result.config.plugins).toEqual({
      "oh-my-codex": { enabled: true },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a disabled plugin (not omitted) when the override flips it off", () => {
    const pluginsView = resolveCodexPlugins(
      [discoveredCodexPlugin("oh-my-codex", true)],
      override("codex-plugins", { "oh-my-codex": false }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
    });

    expect(result.config.plugins).toEqual({
      "oh-my-codex": { enabled: false },
    });
  });

  it("preserves an @scoped plugin id verbatim as the emitted key", () => {
    const pluginsView = resolveCodexPlugins(
      [discoveredCodexPlugin("oh-my-codex@oh-my-codex-local", true)],
      override("codex-plugins", {
        "oh-my-codex@oh-my-codex-local": false,
      }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
    });

    expect(result.config.plugins).toEqual({
      "oh-my-codex@oh-my-codex-local": { enabled: false },
    });
  });
});

describe("translateCodexRuntimeCapabilities — both cascades", () => {
  it("emits both skills.config and plugins together when both views resolve items", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init")],
      undefined,
    );
    const pluginsView = resolveCodexPlugins(
      [discoveredCodexPlugin("oh-my-codex", true)],
      undefined,
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView,
    });

    expect(result.config.skills?.config).toEqual([
      { enabled: true, name: "spec-init" },
    ]);
    expect(result.config.plugins).toEqual({
      "oh-my-codex": { enabled: true },
    });
  });
});

describe("translateCodexRuntimeCapabilities — pass-through", () => {
  it("passes the underlying translator's config through unchanged into the runtime config (no re-keying, no flattening)", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("a"), discoveredCodexSkill("b")],
      override("codex-skills", { b: false }),
    );
    const pluginsView = resolveCodexPlugins(
      [
        discoveredCodexPlugin("plain", true),
        discoveredCodexPlugin("scoped@market", true),
      ],
      override("codex-plugins", { "scoped@market": false }),
    );

    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView,
    });

    expect(Object.keys(result.config).sort()).toEqual(["plugins", "skills"]);
    expect(result.config.skills).toEqual({
      config: expect.arrayContaining([
        { enabled: true, name: "a" },
        { enabled: false, name: "b" },
      ]),
    });
    expect(result.config.plugins).toEqual({
      plain: { enabled: true },
      "scoped@market": { enabled: false },
    });
  });
});

describe("translateCodexRuntimeCapabilities — apply semantics", () => {
  it("always returns next-turn apply semantics; never claims live application", () => {
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView: undefined,
    });
    expect(result.applySemantics).toBe("next-turn");
  });
});

describe("translateCodexRuntimeCapabilities — per-cascade failure isolation", () => {
  it("returns empty defaults when both views are undefined and emits no diagnostics", () => {
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView: undefined,
    });
    expect(result.config).toEqual({});
    expect(result.diagnostics).toEqual([]);
    expect(result.emissions).toEqual([]);
  });
});
