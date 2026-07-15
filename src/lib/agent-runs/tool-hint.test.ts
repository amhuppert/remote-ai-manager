import { describe, expect, it } from "vitest";
import { getCodexToolPromptHint } from "./tool-hint";

describe("getCodexToolPromptHint", () => {
  it("returns null when disabled", () => {
    expect(getCodexToolPromptHint(false)).toBeNull();
  });

  it("returns a hint pointing at the cctl agent CLI when enabled", () => {
    const hint = getCodexToolPromptHint(true);
    expect(hint).not.toBeNull();
    expect(hint).toContain("cctl agent run");
    expect(hint).toContain('"backend": "codex"');
    expect(hint).toContain("summary");
    expect(hint).toContain("referenceDocuments");
  });
});
