import { describe, expect, it } from "vitest";
import { getCodexToolPromptHint } from "./tool-hint";

describe("getCodexToolPromptHint", () => {
  it("always returns a hint pointing at the cctl agent CLI", () => {
    const hint = getCodexToolPromptHint();
    expect(hint).toContain("cctl agent run");
    expect(hint).toContain('"backend": "codex"');
    expect(hint).toContain("summary");
    expect(hint).toContain("referenceDocuments");
  });
});
