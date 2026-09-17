import { describe, expect, it } from "vitest";

import {
  CURSOR_AUTO_REVIEW,
  CURSOR_DISALLOWED_TOOLS,
  CURSOR_ENABLE_AGENT_RETRIES,
  CURSOR_PHASE1_POLICY,
  CURSOR_SANDBOX_OPTIONS,
  CURSOR_SETTING_SOURCES,
} from "./policy";
import { parseParentFrame } from "./worker/ipc";

describe("cursor phase 1 policy", () => {
  it("pins the exact tested policy values", () => {
    expect(CURSOR_SANDBOX_OPTIONS).toStrictEqual({ enabled: false });
    expect(CURSOR_AUTO_REVIEW).toBe(false);
    expect(CURSOR_SETTING_SOURCES).toStrictEqual([]);
    expect(CURSOR_ENABLE_AGENT_RETRIES).toBe(true);
    expect(CURSOR_DISALLOWED_TOOLS).toStrictEqual(["askQuestion", "await"]);
  });

  it("composes one policy object with no tools allowlist", () => {
    expect(CURSOR_PHASE1_POLICY).toStrictEqual({
      sandboxOptions: { enabled: false },
      autoReview: false,
      settingSources: [],
      enableAgentRetries: true,
      disallowedTools: ["askQuestion", "await"],
    });
    // A `tools` key would convert the deny list into an allowlist and silently
    // drop every tool the platform adds after this SDK.
    expect(Object.keys(CURSOR_PHASE1_POLICY).sort()).toStrictEqual([
      "autoReview",
      "disallowedTools",
      "enableAgentRetries",
      "sandboxOptions",
      "settingSources",
    ]);
  });

  it("denies both interactive tools and nothing else", () => {
    // Denying more would remove capability Command Center intends to keep
    // (shell, file operations, search, subagents through `task`, MCP).
    expect(CURSOR_DISALLOWED_TOOLS).toHaveLength(2);
    for (const kept of ["shell", "read", "edit", "task", "mcp", "grep"]) {
      expect(CURSOR_DISALLOWED_TOOLS).not.toContain(kept);
    }
  });

  it("cannot be mutated into a different policy at runtime", () => {
    // There is no user-configurable path to these values, so a caller reaching
    // for one is a bug that must not silently change what a run executes.
    expect(Object.isFrozen(CURSOR_PHASE1_POLICY)).toBe(true);
    expect(Object.isFrozen(CURSOR_PHASE1_POLICY.sandboxOptions)).toBe(true);
    expect(Object.isFrozen(CURSOR_PHASE1_POLICY.disallowedTools)).toBe(true);
    expect(Object.isFrozen(CURSOR_PHASE1_POLICY.settingSources)).toBe(true);
  });

  it("satisfies the attachAgent frame the worker is sent on create and resume", () => {
    // The frame pins the policy arms as wire-level literals, so this proves the
    // two modules agree: a policy value the frame would reject could otherwise
    // only fail once a real worker started.
    for (const mode of ["create", "resume"] as const) {
      const parsed = parseParentFrame({
        type: "attachAgent",
        mode,
        ref: mode === "resume" ? "agent-ref-1" : null,
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        disallowedTools: [...CURSOR_PHASE1_POLICY.disallowedTools],
        sandboxEnabled: CURSOR_PHASE1_POLICY.sandboxOptions.enabled,
        autoReview: CURSOR_PHASE1_POLICY.autoReview,
        settingSources: [...CURSOR_PHASE1_POLICY.settingSources],
        enableAgentRetries: CURSOR_PHASE1_POLICY.enableAgentRetries,
        mcpServers: {},
      });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.frame.type).toBe("attachAgent");
    }
  });
});
