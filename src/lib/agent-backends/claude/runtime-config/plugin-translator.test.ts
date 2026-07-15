import { describe, expect, it } from "vitest";

import {
  translateClaudePluginEnablement,
  type ClaudePluginNativeRecord,
  type ClaudePluginOverrideState,
} from "./plugin-translator";

function nativeRecord(
  partial: Partial<ClaudePluginNativeRecord> & { pluginId: string },
): ClaudePluginNativeRecord {
  return {
    pluginId: partial.pluginId,
    nativeEnabled: partial.nativeEnabled ?? false,
    // Adapter-private native value preserved verbatim. We capture the raw
    // settings entry so the translator can omit overrides without losing
    // extended values like version constraints.
    nativeRawValue: partial.nativeRawValue,
  };
}

describe("Claude plugin enablement translator — native setting preservation", () => {
  it("emits no enabledPlugins entries when no CC overrides are present", () => {
    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "formatter@anthropic-tools",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        }),
        nativeRecord({
          pluginId: "linter@anthropic-tools",
          nativeEnabled: false,
        }),
      ],
      overrides: new Map(),
    });

    expect(result.enabledPlugins).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  it("omits the override when the resolved CC state equals the native state (preserves extended value)", () => {
    // formatter is enabled with a version constraint natively, and CC's
    // resolved state also says enabled — so we MUST omit the entry to keep
    // the native `{ version: "1.2.0" }` intact.
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["formatter@anthropic-tools", { resolvedEnabled: true }],
    ]);

    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "formatter@anthropic-tools",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        }),
      ],
      overrides,
    });

    expect(result.enabledPlugins).toEqual({});
    expect(result.changedPluginIds).toEqual([]);
  });

  it("emits a minimal `false` disable when CC disables a natively enabled plugin", () => {
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["formatter@anthropic-tools", { resolvedEnabled: false }],
    ]);

    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "formatter@anthropic-tools",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        }),
      ],
      overrides,
    });

    expect(result.enabledPlugins).toEqual({
      "formatter@anthropic-tools": false,
    });
    expect(result.changedPluginIds).toEqual(["formatter@anthropic-tools"]);
  });

  it("emits `true` to enable a natively disabled plugin", () => {
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["linter@anthropic-tools", { resolvedEnabled: true }],
    ]);

    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "linter@anthropic-tools",
          nativeEnabled: false,
        }),
      ],
      overrides,
    });

    expect(result.enabledPlugins).toEqual({
      "linter@anthropic-tools": true,
    });
    expect(result.changedPluginIds).toEqual(["linter@anthropic-tools"]);
  });

  it("restores native behavior when CC overrides are cleared (returns no enabledPlugins entries)", () => {
    // Simulates the second translation cycle after a user has cleared every
    // CC override: the translator must produce an empty `enabledPlugins`
    // object so the SDK falls back to the native settings completely.
    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "formatter@anthropic-tools",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        }),
        nativeRecord({
          pluginId: "linter@anthropic-tools",
          nativeEnabled: false,
        }),
      ],
      overrides: new Map(),
    });

    expect(result.enabledPlugins).toEqual({});
    expect(Object.keys(result.enabledPlugins)).toHaveLength(0);
  });

  it("does not write backend-owned settings — translator returns SDK-flag-layer payload only", () => {
    // This test pins behavior: the translator must return an in-memory
    // object intended for `applyFlagSettings()` / SDK options. It never
    // mutates inputs and never references a filesystem path.
    const native = [
      nativeRecord({
        pluginId: "p@m",
        nativeEnabled: true,
        nativeRawValue: { version: "1" },
      }),
    ];
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["p@m", { resolvedEnabled: false }],
    ]);

    const before = JSON.stringify({ native, overrides: Array.from(overrides) });
    const result = translateClaudePluginEnablement({ native, overrides });
    const after = JSON.stringify({ native, overrides: Array.from(overrides) });

    expect(before).toBe(after);
    expect(result.enabledPlugins).toEqual({ "p@m": false });
    // Translator output schema is closed to native-payload leakage.
    expect("nativeRawValue" in result).toBe(false);
  });

  it("emits a diagnostic but no entry for an override that targets an unknown native plugin (stale id)", () => {
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["ghost@nowhere", { resolvedEnabled: true }],
    ]);

    const result = translateClaudePluginEnablement({
      native: [],
      overrides,
    });

    expect(result.enabledPlugins).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("claude-plugin-override-stale");
    expect(result.diagnostics[0]?.pluginId).toBe("ghost@nowhere");
  });

  it("preserves siblings when one plugin is disabled by CC", () => {
    const overrides = new Map<string, ClaudePluginOverrideState>([
      ["b@m", { resolvedEnabled: false }],
    ]);

    const result = translateClaudePluginEnablement({
      native: [
        nativeRecord({
          pluginId: "a@m",
          nativeEnabled: true,
          nativeRawValue: { version: "1.0.0" },
        }),
        nativeRecord({ pluginId: "b@m", nativeEnabled: true }),
        nativeRecord({ pluginId: "c@m", nativeEnabled: false }),
      ],
      overrides,
    });

    // Only the targeted plugin appears in the flag-layer delta. `a@m` and
    // `c@m` are omitted so native extended values and disabled state remain
    // authoritative.
    expect(result.enabledPlugins).toEqual({ "b@m": false });
  });
});
