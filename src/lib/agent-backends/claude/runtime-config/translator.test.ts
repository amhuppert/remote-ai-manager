import { describe, expect, it } from "vitest";

import type { ResolvedCapabilityCascade } from "../../runtime-config";
import { CLAUDE_AGENT_SUPPRESSION_STRATEGY } from "./agent-suppression";
import { translateClaudeRuntimeCapabilities } from "./translator";

function cascade(
  kinds: ResolvedCapabilityCascade["kinds"],
): ResolvedCapabilityCascade {
  return { backend: "claude", kinds };
}

describe("translateClaudeRuntimeCapabilities — skills", () => {
  it("emits only CC-explicit skill overrides; omits rows still at native default", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([
        {
          kind: "skills",
          items: [
            { itemId: "alpha", enabled: false, originLayer: "global" },
            { itemId: "beta", enabled: true, originLayer: "native" },
          ],
        },
      ]),
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({ alpha: "off" });
  });

  it("emits both on and off for explicit overrides at non-native layers", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([
        {
          kind: "skills",
          items: [
            { itemId: "alpha", enabled: true, originLayer: "conversation" },
            { itemId: "beta", enabled: false, originLayer: "project" },
          ],
        },
      ]),
      nativePluginRecords: [],
    });
    expect(result.config.skillOverrides).toEqual({
      alpha: "on",
      beta: "off",
    });
  });
});

describe("translateClaudeRuntimeCapabilities — plugins", () => {
  it("emits a minimal delta against native records and preserves no-op overrides by omission", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([
        {
          kind: "plugins",
          items: [
            // Disagrees with native → emitted.
            { itemId: "p-on@mkt", enabled: false, originLayer: "global" },
            // Agrees with native → omitted so extended values survive.
            { itemId: "p-ext@mkt", enabled: true, originLayer: "session" },
            // Native origin → never forwarded to the flag layer.
            { itemId: "p-native@mkt", enabled: true, originLayer: "native" },
          ],
        },
      ]),
      nativePluginRecords: [
        { pluginId: "p-on@mkt", nativeEnabled: true, nativeRawValue: true },
        {
          pluginId: "p-ext@mkt",
          nativeEnabled: true,
          nativeRawValue: { version: "1.2.0" },
        },
        { pluginId: "p-native@mkt", nativeEnabled: true, nativeRawValue: true },
      ],
    });
    expect(result.config.enabledPlugins).toEqual({ "p-on@mkt": false });
    expect(result.diagnostics).toEqual([]);
  });

  it("surfaces overrides for unknown plugin ids as stale diagnostics without emitting them", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([
        {
          kind: "plugins",
          items: [
            { itemId: "ghost@mkt", enabled: false, originLayer: "global" },
          ],
        },
      ]),
      nativePluginRecords: [],
    });
    expect(result.config.enabledPlugins).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("claude-plugin-override-stale");
    expect(result.diagnostics[0]?.pluginId).toBe("ghost@mkt");
  });
});

describe("translateClaudeRuntimeCapabilities — agents", () => {
  it("collects disabled agent names and pins the verified suppression strategy", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([
        {
          kind: "agents",
          items: [
            { itemId: "reviewer", enabled: false, originLayer: "project" },
            { itemId: "helper", enabled: true, originLayer: "native" },
          ],
        },
      ]),
      nativePluginRecords: [],
    });
    expect(result.config.disabledAgentNames).toEqual(["reviewer"]);
    expect(result.config.agentSuppressionStrategy).toBe(
      CLAUDE_AGENT_SUPPRESSION_STRATEGY,
    );
  });
});

describe("translateClaudeRuntimeCapabilities — absent kinds", () => {
  it("defaults every facet when the cascade carries no kinds", () => {
    const result = translateClaudeRuntimeCapabilities({
      cascade: cascade([]),
      nativePluginRecords: [],
    });
    expect(result.config).toEqual({
      enabledPlugins: {},
      skillOverrides: {},
      disabledAgentNames: [],
      agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
    });
  });
});
