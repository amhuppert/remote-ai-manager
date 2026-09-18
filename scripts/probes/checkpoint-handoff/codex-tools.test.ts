import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexToolFixture } from "./codex-tools";

describe("Codex writable tool control", () => {
  it("requires the exact positive effect and independently detects the deferred action", () => {
    const root = mkdtempSync(path.resolve(".cc/temp/codex-tool-test-"));
    try {
      const fixture = codexToolFixture(root);
      expect(fixture.snapshot()).toEqual({
        positive: false,
        pendingAbsent: true,
      });
      writeFileSync(path.join(root, "ordinary-tool-positive.txt"), "wrong");
      expect(fixture.snapshot().positive).toBe(false);
      writeFileSync(
        path.join(root, "ordinary-tool-positive.txt"),
        "CODEX-WRITABLE-CONTROL-731",
      );
      expect(fixture.snapshot()).toEqual({
        positive: true,
        pendingAbsent: true,
      });
      writeFileSync(path.join(root, "pending-action-canary.txt"), "unexpected");
      expect(fixture.snapshot()).toEqual({
        positive: true,
        pendingAbsent: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
