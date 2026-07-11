import { describe, expect, it } from "vitest";
import { mergeMarkdownDocuments } from "./markdown-document-list";

const WORKTREE = "/project/.worktrees/session";

describe("mergeMarkdownDocuments", () => {
  it("merges registered metadata by canonical path and orders recent first", () => {
    const result = mergeMarkdownDocuments(
      [
        {
          docPath: "docs/plan.md",
          origin: "edit",
          firstSeenAt: "2026-07-11T09:00:00.000Z",
          lastSeenAt: "2026-07-11T12:00:00.000Z",
        },
        {
          docPath: "/shared/runbook.md",
          origin: "read",
          firstSeenAt: "2026-07-11T10:00:00.000Z",
          lastSeenAt: "2026-07-11T10:00:00.000Z",
        },
      ],
      [
        {
          id: "ref-plan",
          filePath: `${WORKTREE}/docs/plan.md`,
          description: "Implementation plan",
          createdAt: "2026-07-11T11:00:00.000Z",
        },
        {
          id: "ref-external",
          filePath: "/shared/guide.md",
          description: "Shared guide",
          createdAt: "2026-07-11T11:30:00.000Z",
        },
      ],
      WORKTREE,
    );

    expect(result.map((item) => item.docPath)).toEqual([
      "docs/plan.md",
      "/shared/guide.md",
      "/shared/runbook.md",
    ]);
    expect(result[0]).toMatchObject({
      origin: "edit",
      registered: true,
      description: "Implementation plan",
      location: "worktree",
    });
    expect(result[1]).toMatchObject({
      title: "guide.md",
      origin: "registered",
      registered: true,
      location: "external",
    });
  });

  it("ignores registered non-Markdown files", () => {
    expect(
      mergeMarkdownDocuments(
        [],
        [
          {
            id: "text",
            filePath: "notes.txt",
            description: "Notes",
            createdAt: "2026-07-11T11:00:00.000Z",
          },
        ],
        WORKTREE,
      ),
    ).toEqual([]);
  });
});
