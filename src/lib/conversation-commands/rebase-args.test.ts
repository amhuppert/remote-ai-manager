import { describe, it, expect } from "vitest";
import { parseRebaseArgs } from "./rebase-args";

describe("parseRebaseArgs", () => {
  it("defaults to the session's target branch when no argument is given", () => {
    expect(parseRebaseArgs("", "main")).toEqual({
      ok: true,
      onto: { kind: "local", branch: "main" },
      label: "main",
    });
  });

  it("treats a single token as a local branch", () => {
    expect(parseRebaseArgs("develop", "main")).toEqual({
      ok: true,
      onto: { kind: "local", branch: "develop" },
      label: "develop",
    });
  });

  it("treats two tokens as <remote> <branch>", () => {
    expect(parseRebaseArgs("origin main", "main")).toEqual({
      ok: true,
      onto: { kind: "remote", remote: "origin", branch: "main" },
      label: "origin/main",
    });
  });

  it("tolerates extra internal whitespace", () => {
    expect(parseRebaseArgs("  origin   release/2.0  ", "main")).toEqual({
      ok: true,
      onto: { kind: "remote", remote: "origin", branch: "release/2.0" },
      label: "origin/release/2.0",
    });
  });

  it("rejects more than two tokens with a usage hint", () => {
    const result = parseRebaseArgs("origin main extra", "main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/usage/i);
  });
});
