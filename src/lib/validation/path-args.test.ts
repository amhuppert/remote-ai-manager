import { describe, expect, it } from "vitest";
import { validatePathArgs } from "./path-args";

const worktree = "/repo/.worktrees/session";

describe("validatePathArgs", () => {
  it("accepts an empty token list", () => {
    expect(validatePathArgs([], worktree)).toEqual({ ok: true, paths: [] });
  });

  it("accepts relative worktree-contained paths, including nested ones", () => {
    const tokens = [
      "src/lib/validation/schemas.test.ts",
      "./src/lib/config/loader.test.ts",
      "docs/design/validation-concurrency/01-design.md",
    ];

    expect(validatePathArgs(tokens, worktree)).toEqual({
      ok: true,
      paths: tokens,
    });
  });

  it("accepts a path to a file that does not exist (lexical containment only)", () => {
    expect(
      validatePathArgs(["src/just-deleted-in-this-branch.test.ts"], worktree),
    ).toEqual({ ok: true, paths: ["src/just-deleted-in-this-branch.test.ts"] });
  });

  it("accepts internal ../ segments whose resolution stays inside the worktree", () => {
    expect(validatePathArgs(["src/../src/a.test.ts"], worktree).ok).toBe(true);
  });

  it.each([["--coverage"], ["-t"], ["--pool=threads"]])(
    "rejects the option token %s",
    (token) => {
      expect(validatePathArgs(["src/a.ts", token], worktree)).toEqual({
        ok: false,
        kind: "option_token",
        token,
      });
    },
  );

  it("rejects absolute paths even when they point inside the worktree", () => {
    expect(validatePathArgs([`${worktree}/src/a.test.ts`], worktree)).toEqual({
      ok: false,
      kind: "absolute_path",
      token: `${worktree}/src/a.test.ts`,
    });
  });

  it.each([["../other-session/file.ts"], ["src/../../escape.ts"]])(
    "rejects the traversal token %s that escapes the worktree",
    (token) => {
      expect(validatePathArgs([token], worktree)).toEqual({
        ok: false,
        kind: "escapes_worktree",
        token,
      });
    },
  );

  it("rejects a sibling directory sharing the worktree path as a prefix", () => {
    // /repo/.worktrees/session-evil starts with /repo/.worktrees/session as a
    // raw string prefix; containment must compare path segments, not chars.
    expect(validatePathArgs(["../session-evil/x.ts"], worktree)).toEqual({
      ok: false,
      kind: "escapes_worktree",
      token: "../session-evil/x.ts",
    });
  });

  it("rejects empty and whitespace-only tokens", () => {
    expect(validatePathArgs([""], worktree)).toEqual({
      ok: false,
      kind: "empty_token",
      token: "",
    });
    expect(validatePathArgs(["   "], worktree).ok).toBe(false);
  });

  it("reports the first offending token when several are invalid", () => {
    expect(
      validatePathArgs(["src/a.ts", "--flag", "/etc/passwd"], worktree),
    ).toEqual({ ok: false, kind: "option_token", token: "--flag" });
  });
});
