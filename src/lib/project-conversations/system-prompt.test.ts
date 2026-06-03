import { describe, it, expect } from "vitest";
import { PROJECT_CC_CONTEXT } from "./system-prompt";

describe("PROJECT_CC_CONTEXT", () => {
  it("is a non-empty command-center orientation string", () => {
    expect(PROJECT_CC_CONTEXT).toMatch(/^<command-center>/);
    expect(PROJECT_CC_CONTEXT.length).toBeGreaterThan(0);
  });

  it("does not promise a dev server (no dev-server language)", () => {
    const lower = PROJECT_CC_CONTEXT.toLowerCase();
    expect(lower).not.toContain("ensure_dev_server");
    expect(lower).not.toContain("dev server");
    expect(lower).not.toContain("dev-server");
    expect(lower).not.toContain("get_dev_servers");
  });

  it("identifies the main / repo-root worktree execution context", () => {
    expect(PROJECT_CC_CONTEXT.toLowerCase()).toContain("main");
  });
});
