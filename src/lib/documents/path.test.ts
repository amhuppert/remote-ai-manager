import { describe, expect, it } from "vitest";
import {
  isMarkdownPath,
  normalizeMarkdownLocator,
  normalizeDocPath,
  resolveWithinWorktree,
} from "./path";

const WORKTREE = "/Users/alex/github/command-center/.worktrees/wt";

describe("isMarkdownPath", () => {
  it("accepts .md (case-insensitively)", () => {
    expect(isMarkdownPath("design.md")).toBe(true);
    expect(isMarkdownPath("a/b/Design.MD")).toBe(true);
  });

  it("rejects non-markdown paths", () => {
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
    expect(isMarkdownPath("x.mdx")).toBe(false);
  });
});

describe("normalizeDocPath", () => {
  it("normalizes an absolute path inside the worktree to relative", () => {
    expect(
      normalizeDocPath(`${WORKTREE}/.kiro/specs/x/design.md`, WORKTREE),
    ).toEqual({ ok: true, docPath: ".kiro/specs/x/design.md" });
  });

  it("treats an absolute path outside the worktree as unavailable", () => {
    expect(normalizeDocPath("/etc/passwd.md", WORKTREE)).toEqual({
      ok: false,
      reason: "outside-worktree",
    });
    expect(normalizeDocPath("/Users/alex/other/notes.md", WORKTREE)).toEqual({
      ok: false,
      reason: "outside-worktree",
    });
  });

  it("treats an absolute path that resolves outside via .. as unavailable", () => {
    expect(
      normalizeDocPath(`${WORKTREE}/../sibling/secret.md`, WORKTREE),
    ).toEqual({ ok: false, reason: "outside-worktree" });
  });

  it("accepts a relative Kiro spec/steering path", () => {
    expect(normalizeDocPath(".kiro/steering/tech.md", WORKTREE)).toEqual({
      ok: true,
      docPath: ".kiro/steering/tech.md",
    });
    expect(normalizeDocPath("memory-bank/focus.md", WORKTREE)).toEqual({
      ok: true,
      docPath: "memory-bank/focus.md",
    });
  });

  it("collapses ./ and inner ../ that stay inside the worktree", () => {
    expect(normalizeDocPath("./docs/../design.md", WORKTREE)).toEqual({
      ok: true,
      docPath: "design.md",
    });
  });

  it("rejects a relative path that escapes via .. as traversal", () => {
    expect(normalizeDocPath("../outside.md", WORKTREE)).toEqual({
      ok: false,
      reason: "traversal",
    });
    expect(normalizeDocPath("a/../../escape.md", WORKTREE)).toEqual({
      ok: false,
      reason: "traversal",
    });
  });

  it("rejects non-markdown paths", () => {
    expect(normalizeDocPath("notes.txt", WORKTREE)).toEqual({
      ok: false,
      reason: "non-markdown",
    });
    expect(normalizeDocPath(`${WORKTREE}/build/output.js`, WORKTREE)).toEqual({
      ok: false,
      reason: "non-markdown",
    });
  });
});

describe("normalizeMarkdownLocator", () => {
  it("returns a worktree-relative identity for paths inside the worktree", () => {
    expect(
      normalizeMarkdownLocator(`${WORKTREE}/docs/../README.md`, WORKTREE),
    ).toEqual({ ok: true, docPath: "README.md", location: "worktree" });
  });

  it("returns a canonical absolute identity for paths outside the worktree", () => {
    expect(
      normalizeMarkdownLocator(
        "/Users/alex/shared/../notes/runbook.md",
        WORKTREE,
      ),
    ).toEqual({
      ok: true,
      docPath: "/Users/alex/notes/runbook.md",
      location: "external",
    });
  });

  it("resolves a relative escape to a canonical external identity", () => {
    expect(normalizeMarkdownLocator("../shared/guide.md", WORKTREE)).toEqual({
      ok: true,
      docPath: "/Users/alex/github/command-center/.worktrees/shared/guide.md",
      location: "external",
    });
  });

  it("rejects empty and non-markdown locators", () => {
    expect(normalizeMarkdownLocator("", WORKTREE)).toEqual({
      ok: false,
      reason: "non-markdown",
    });
    expect(normalizeMarkdownLocator("../shared/guide.mdx", WORKTREE)).toEqual({
      ok: false,
      reason: "non-markdown",
    });
  });
});

describe("resolveWithinWorktree", () => {
  it("joins a relative .md docPath onto the worktree root", () => {
    expect(resolveWithinWorktree(".kiro/specs/x/design.md", WORKTREE)).toBe(
      `${WORKTREE}/.kiro/specs/x/design.md`,
    );
  });

  it("returns null for a traversal docPath", () => {
    expect(resolveWithinWorktree("../escape.md", WORKTREE)).toBeNull();
  });

  it("returns null for a non-markdown docPath", () => {
    expect(resolveWithinWorktree("notes.txt", WORKTREE)).toBeNull();
  });
});
