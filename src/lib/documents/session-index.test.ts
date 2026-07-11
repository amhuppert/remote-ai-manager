import { describe, expect, it, vi } from "vitest";
import { createSessionMarkdownIndexer } from "./session-index";

describe("session Markdown indexer", () => {
  it("canonicalizes and deduplicates refs before one bulk upsert", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const index = createSessionMarkdownIndexer({
      resolveProjectPath: vi.fn().mockResolvedValue("/project"),
      getSession: vi.fn().mockResolvedValue({ worktreePath: "/worktree" }),
      upsertSessionMarkdownDocuments: upsert,
    });

    await index({
      projectName: "project",
      sessionName: "session",
      seenAt: "2026-07-11T10:00:00.000Z",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "docs/a.md" } },
        { type: "tool_use", name: "Edit", input: { file_path: "docs/a.md" } },
        {
          type: "tool_use",
          name: "Write",
          input: { file_path: "/shared/outside.md" },
        },
      ],
    });

    expect(upsert).toHaveBeenCalledWith("/project", "session", [
      {
        docPath: "docs/a.md",
        origin: "read",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
      {
        docPath: "/shared/outside.md",
        origin: "write",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
    ]);
  });

  it("skips project-level conversations and messages without refs", async () => {
    const upsert = vi.fn();
    const index = createSessionMarkdownIndexer({
      resolveProjectPath: vi.fn(),
      getSession: vi.fn(),
      upsertSessionMarkdownDocuments: upsert,
    });

    await index({
      projectName: "project",
      sessionName: "__project__",
      seenAt: "2026-07-11T10:00:00.000Z",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "docs/a.md" } },
      ],
    });
    await index({
      projectName: "project",
      sessionName: "session",
      seenAt: "2026-07-11T10:00:00.000Z",
      content: [{ type: "text", text: "No files" }],
    });

    expect(upsert).not.toHaveBeenCalled();
  });
});
