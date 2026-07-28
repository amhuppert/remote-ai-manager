import { describe, expect, it } from "vitest";
import { withCodexFastMode } from "./fast-mode-config";

describe("withCodexFastMode", () => {
  it("selects the fast service tier and enables the Codex fast-mode feature", () => {
    expect(withCodexFastMode(undefined, true)).toEqual({
      service_tier: "fast",
      features: { fast_mode: true },
    });
  });

  it("explicitly selects the standard service tier", () => {
    expect(withCodexFastMode(undefined, false)).toEqual({
      service_tier: "default",
      features: { fast_mode: false },
    });
  });

  it("preserves unrelated config and feature flags", () => {
    expect(
      withCodexFastMode(
        {
          mcp_servers: { tools: { command: "tool-server" } },
          features: {
            apps: false,
            fast_mode: false,
          },
        },
        true,
      ),
    ).toEqual({
      mcp_servers: { tools: { command: "tool-server" } },
      service_tier: "fast",
      features: {
        apps: false,
        fast_mode: true,
      },
    });
  });
});
