import { describe, expect, it } from "vitest";
import {
  imageMediaType,
  resolveWorktreeLink,
  worktreeImageUrl,
} from "./worktree-links";

const WORKTREE = "/Users/alex/repo/.worktrees/sess";

describe("resolveWorktreeLink", () => {
  it("resolves an absolute Markdown path inside the worktree to its relative docPath", () => {
    expect(
      resolveWorktreeLink(
        `${WORKTREE}/docs/design/agent-subscriptions-controls.md`,
        WORKTREE,
      ),
    ).toEqual({
      kind: "markdown",
      docPath: "docs/design/agent-subscriptions-controls.md",
      location: "worktree",
      fileName: "agent-subscriptions-controls.md",
    });
  });

  it("resolves a relative Markdown path against the worktree root", () => {
    expect(resolveWorktreeLink("./docs/guide.md", WORKTREE)).toEqual({
      kind: "markdown",
      docPath: "docs/guide.md",
      location: "worktree",
      fileName: "guide.md",
    });
  });

  it("keeps a Markdown path outside the worktree as an external identity", () => {
    expect(
      resolveWorktreeLink("/Users/alex/.claude/plans/plan.md", WORKTREE),
    ).toEqual({
      kind: "markdown",
      docPath: "/Users/alex/.claude/plans/plan.md",
      location: "external",
      fileName: "plan.md",
    });
  });

  it("decodes percent-encoded path segments", () => {
    expect(
      resolveWorktreeLink(`${WORKTREE}/docs/my%20notes.md`, WORKTREE),
    ).toMatchObject({ kind: "markdown", docPath: "docs/my notes.md" });
  });

  it("drops a fragment, a query, and an editor-style line suffix", () => {
    for (const href of [
      `${WORKTREE}/docs/guide.md#usage`,
      `${WORKTREE}/docs/guide.md?plain=1`,
      `${WORKTREE}/docs/guide.md:12`,
      `${WORKTREE}/docs/guide.md:12:4`,
    ]) {
      expect(resolveWorktreeLink(href, WORKTREE)).toMatchObject({
        kind: "markdown",
        docPath: "docs/guide.md",
      });
    }
  });

  it("resolves an image inside the worktree to its worktree-relative path", () => {
    expect(
      resolveWorktreeLink(
        `${WORKTREE}/.cc/temp/controls-live/held-wake-desktop.png`,
        WORKTREE,
      ),
    ).toEqual({
      kind: "image",
      imagePath: ".cc/temp/controls-live/held-wake-desktop.png",
      fileName: "held-wake-desktop.png",
    });
    expect(resolveWorktreeLink("shots/Home.JPEG", WORKTREE)).toMatchObject({
      kind: "image",
      imagePath: "shots/Home.JPEG",
    });
  });

  it("does not resolve an image outside the worktree", () => {
    expect(resolveWorktreeLink("/tmp/shot.png", WORKTREE)).toBeNull();
    expect(resolveWorktreeLink("../other/shot.png", WORKTREE)).toBeNull();
  });

  it("resolves HTML reports inside the worktree", () => {
    for (const href of [
      `${WORKTREE}/reports/my%20report.html`,
      "./reports/my%20report.html",
      "reports/my%20report.html:12",
    ]) {
      expect(resolveWorktreeLink(href, WORKTREE)).toEqual({
        kind: "html",
        htmlPath: "reports/my report.html",
        fileName: "my report.html",
      });
    }
    expect(resolveWorktreeLink("report.HTM", WORKTREE)).toMatchObject({
      kind: "html",
      htmlPath: "report.HTM",
    });
  });

  it("leaves external HTML URLs and files outside the worktree alone", () => {
    for (const href of [
      "https://example.com/report.html",
      "//example.com/report.html",
      "/tmp/report.html",
      "../report.html",
    ]) {
      expect(resolveWorktreeLink(href, WORKTREE)).toBeNull();
    }
  });

  it("leaves web links, anchors, and other files alone", () => {
    for (const href of [
      undefined,
      "",
      "#usage",
      "https://example.com/guide.md",
      "https://example.com/shot.png",
      "//example.com/shot.png",
      "mailto:alex@example.com",
      "/projects/command-center/Notifications",
      `${WORKTREE}/src/index.ts`,
      `${WORKTREE}/docs/%E0%A4%A.md`,
    ]) {
      expect(resolveWorktreeLink(href, WORKTREE)).toBeNull();
    }
  });
});

describe("imageMediaType", () => {
  it("maps supported image extensions case-insensitively", () => {
    expect(imageMediaType("a/b.png")).toBe("image/png");
    expect(imageMediaType("a/b.JPG")).toBe("image/jpeg");
    expect(imageMediaType("a/b.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("a/b.gif")).toBe("image/gif");
    expect(imageMediaType("a/b.webp")).toBe("image/webp");
    expect(imageMediaType("a/b.svg")).toBe("image/svg+xml");
  });

  it("returns null for a non-image path", () => {
    expect(imageMediaType("a/b.md")).toBeNull();
    expect(imageMediaType("a/png")).toBeNull();
  });
});

describe("worktreeImageUrl", () => {
  it("addresses the session image endpoint with an encoded path", () => {
    expect(
      worktreeImageUrl(
        { projectName: "command-center", sessionName: "My Session" },
        ".cc/temp/a b.png",
      ),
    ).toBe(
      "/api/projects/command-center/sessions/My%20Session/worktree-images?path=.cc%2Ftemp%2Fa%20b.png",
    );
  });

  it("addresses the project image endpoint for a project conversation", () => {
    expect(
      worktreeImageUrl(
        { projectName: "command-center", sessionName: null },
        ".cc/temp/shot.png",
      ),
    ).toBe(
      "/api/projects/command-center/worktree-images?path=.cc%2Ftemp%2Fshot.png",
    );
  });
});
