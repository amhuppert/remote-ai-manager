import { describe, expect, it } from "vitest";
import { resolveClaudeModelSelection } from "@/lib/agent-backends/claude/model-selection";
import { probeModelSelection } from "./model-selection";

describe("explicit probe model selection", () => {
  it("lets explicit none select Haiku through the real policy without unsupported effort", () => {
    const selection = probeModelSelection("claude", "haiku", "none");
    if (!selection) throw new Error("explicit model selection missing");
    expect(resolveClaudeModelSelection(selection).modelId).toBe("haiku");
    expect(selection.parameters).toEqual({});
  });
  it("preserves requested effort so policy can refuse unsupported combinations", () => {
    const selection = probeModelSelection("claude", "haiku", "high");
    if (!selection) throw new Error("explicit model selection missing");
    expect(() => resolveClaudeModelSelection(selection)).toThrow();
    expect(selection.parameters).toEqual({ effort: "high" });
  });
  it("omits only reasoning for Codex none while retaining explicit fast selection", () => {
    expect(probeModelSelection("codex", "gpt-6-astra", "none")).toEqual({
      modelId: "gpt-6-astra",
      parameters: { fast: "false" },
    });
  });
});
