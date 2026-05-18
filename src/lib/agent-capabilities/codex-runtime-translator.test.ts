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

function resolveCodexPlugins(): AgentCapabilityViewResponse {
  return resolveCascadeView({
    cascadeKind: "codex-plugins",
    scope: { level: "conversation" },
    overrideChain: [{ layer: "global", overrides: undefined }],
    discoveredItems: [],
    metadata: defaultAgentCapabilityMetadataRegistry.get("codex-plugins"),
  });
}

describe("translateCodexRuntimeCapabilities — skills", () => {
  it("emits empty config and a verification-gated diagnostic when skills are present", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init"), discoveredCodexSkill("spec-tasks")],
      override("codex-skills", { "spec-tasks": false }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
    });
    // Verification-gated translator never emits CodexOptions.config keys.
    expect(result.config).toEqual({});
    expect(result.applySemantics).toBe("next-turn");
    // The diagnostic from the underlying translator must be lifted with
    // backend + cascadeKind tags so it surfaces alongside other cascade
    // diagnostics in the composed conversation-start payload.
    const skillsDiag = result.diagnostics.find(
      (d) => d.cascadeKind === "codex-skills",
    );
    expect(skillsDiag?.code).toBe("codex-skill-config-key-unverified");
    expect(skillsDiag?.backend).toBe("codex");
  });

  it("records the skills cascade emission so the composer can hash + seed pending state", () => {
    const skillsView = resolveCodexSkills(
      [discoveredCodexSkill("spec-init")],
      override("codex-skills", { "spec-init": false }),
    );
    const result = translateCodexRuntimeCapabilities({
      skillsView,
      pluginsView: undefined,
    });
    const skillsEmission = result.emissions.find(
      (e) => e.cascadeKind === "codex-skills",
    );
    // Even though the runtime payload is empty, the emission row set still
    // reflects the resolved state of every emittable row, so the composer
    // can hash + present a deterministic pendingHash. The verification-gated
    // metadata makes `runtimeEmittable=false` for every row, so emittedRows
    // is empty.
    expect(skillsEmission?.emittedRows).toEqual([]);
  });
});

describe("translateCodexRuntimeCapabilities — plugins", () => {
  it("emits the verification-gated plugin diagnostic when the cascade was discovered with items", () => {
    // Plugin cascade is verification-gated; the underlying translator surfaces
    // a diagnostic only when the cascade was exercised with items. The runtime
    // translator builds its `pluginItemCount` from the resolved view so an
    // empty plugin view does not produce a noisy diagnostic.
    const pluginsView = resolveCodexPlugins();
    const result = translateCodexRuntimeCapabilities({
      skillsView: undefined,
      pluginsView,
    });
    // No items + no overrides means no diagnostic is generated for plugins.
    const pluginsDiag = result.diagnostics.find(
      (d) => d.cascadeKind === "codex-plugins",
    );
    expect(pluginsDiag).toBeUndefined();
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
