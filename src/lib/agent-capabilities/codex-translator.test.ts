import { describe, expect, it } from "vitest";

import {
  translateCodexCapabilities,
  type CodexCapabilityResolvedInput,
} from "./codex-translator";

function input(
  partial: Partial<CodexCapabilityResolvedInput>,
): CodexCapabilityResolvedInput {
  return {
    skills: partial.skills ?? [],
    pluginCascadeRequested: partial.pluginCascadeRequested ?? false,
    pluginItemCount: partial.pluginItemCount ?? 0,
  };
}

describe("Codex capability translator", () => {
  it("returns empty config and no diagnostics when no skills are requested", () => {
    const result = translateCodexCapabilities(input({}));
    expect(result.config).toEqual({});
    expect(result.diagnostics).toEqual([]);
    expect(result.emittedCascadeKinds).toEqual([]);
  });

  it("never emits codex plugin keys; only emits a diagnostic if the cascade is exercised", () => {
    const result = translateCodexCapabilities(
      input({
        pluginCascadeRequested: true,
        pluginItemCount: 2,
      }),
    );

    expect(result.config).toEqual({});
    expect(result.emittedCascadeKinds).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe("codex-plugins-unavailable");
    expect(diagnostic?.cascadeKind).toBe("codex-plugins");
    expect(diagnostic?.message).toMatch(/verification/i);
  });

  it("treats an unverified Codex skill config key as a translation failure for the skills cascade and falls back to native defaults", () => {
    // Verification gate: until the implementation verifies a concrete
    // `CodexOptions.config` key for per-skill enablement on the installed SDK
    // (none is documented in the installed typings), the translator must
    // surface a diagnostic and omit the cascade rather than silently emitting
    // configuration-only flags that the agent ignores.
    const result = translateCodexCapabilities(
      input({
        skills: [
          { itemId: "spec-init", enabled: true, sourcePath: "/skills/spec" },
          { itemId: "spec-tasks", enabled: false, sourcePath: "/skills/tasks" },
        ],
      }),
    );

    expect(result.config).toEqual({});
    expect(result.emittedCascadeKinds).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe("codex-skill-config-key-unverified");
    expect(diagnostic?.cascadeKind).toBe("codex-skills");
  });

  it("does not block conversation start when both Codex cascades produce diagnostics (per-cascade fallback)", () => {
    const result = translateCodexCapabilities(
      input({
        skills: [{ itemId: "x", enabled: false, sourcePath: "/x" }],
        pluginCascadeRequested: true,
        pluginItemCount: 1,
      }),
    );

    expect(result.config).toEqual({});
    expect(result.diagnostics.map((d) => d.cascadeKind).sort()).toEqual([
      "codex-plugins",
      "codex-skills",
    ]);
    // emittedCascadeKinds remains empty: both cascades fell back to native.
    expect(result.emittedCascadeKinds).toEqual([]);
    // A `staged` flag confirms the translator never claimed live application.
    expect(result.applySemantics).toBe("next-turn");
  });
});
