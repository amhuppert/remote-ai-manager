import { describe, it, expect } from "vitest";
import { detectComposerMode } from "./detect-composer-mode";

describe("detectComposerMode", () => {
  it("treats plain prose as chat", () => {
    expect(detectComposerMode("fix the login bug")).toBe("chat");
    expect(detectComposerMode("Refactor the parser")).toBe("chat");
  });

  it("treats a leading slash as command", () => {
    expect(detectComposerMode("/new")).toBe("command");
    expect(detectComposerMode("/capabilities")).toBe("command");
    expect(detectComposerMode("/")).toBe("command");
  });

  it("treats each leading filter key as filter", () => {
    expect(detectComposerMode("is:running")).toBe("filter");
    expect(detectComposerMode("target:main")).toBe("filter");
    expect(detectComposerMode("branch:feature/x")).toBe("filter");
    expect(detectComposerMode("archived:true")).toBe("filter");
  });

  it("accepts status: as a filter (is: alias)", () => {
    expect(detectComposerMode("status:running")).toBe("filter");
  });

  it("treats a recognized key with a trailing colon and no value as filter", () => {
    expect(detectComposerMode("is:")).toBe("filter");
    expect(detectComposerMode("target:")).toBe("filter");
    expect(detectComposerMode("status:")).toBe("filter");
  });

  it("is case-insensitive on the filter key", () => {
    expect(detectComposerMode("IS:running")).toBe("filter");
    expect(detectComposerMode("Status:Running")).toBe("filter");
  });

  it("ignores leading/trailing whitespace", () => {
    expect(detectComposerMode("  is:running  ")).toBe("filter");
    expect(detectComposerMode("   /new")).toBe("command");
    expect(detectComposerMode("  hello there ")).toBe("chat");
  });

  it("does not treat a prose colon as filter", () => {
    expect(detectComposerMode("TODO: fix this")).toBe("chat");
    expect(detectComposerMode("note: remember to test")).toBe("chat");
  });

  it("treats empty/whitespace-only input as chat", () => {
    expect(detectComposerMode("")).toBe("chat");
    expect(detectComposerMode("   ")).toBe("chat");
  });
});
