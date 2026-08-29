import { describe, expect, it } from "vitest";

import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import {
  createNotepadInputSchema,
  notepadChangedEventSchema,
  notepadCommentAnchorSchema,
  notepadCommentSchema,
  notepadContentWriteSchema,
  notepadListQuerySchema,
  notepadSchema,
} from "./schemas";

function buildNotepad(overrides: Record<string, unknown> = {}) {
  return {
    id: "notepad-1",
    scope: "global",
    projectPath: null,
    name: "Scratch",
    content: "# Scratch",
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  };
}

function buildListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "notepad-1",
    scope: "global",
    projectPath: null,
    projectName: null,
    name: "Scratch",
    revision: 2,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:05:00.000Z",
    ...overrides,
  };
}

describe("notepadSchema scope pairing", () => {
  it("accepts a global notepad without a project and a project notepad with one", () => {
    expect(notepadSchema.safeParse(buildNotepad()).success).toBe(true);
    expect(
      notepadSchema.safeParse(
        buildNotepad({ scope: "project", projectPath: "/repos/cc" }),
      ).success,
    ).toBe(true);
  });

  it("refuses a project-scoped notepad with no project path", () => {
    const result = notepadSchema.safeParse(buildNotepad({ scope: "project" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["projectPath"]);
  });

  it("refuses a global notepad that carries a project path", () => {
    const result = notepadSchema.safeParse(
      buildNotepad({ projectPath: "/repos/cc" }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["projectPath"]);
  });
});

describe("createNotepadInputSchema", () => {
  it("defaults a new notepad to full-edit and empty content", () => {
    const parsed = createNotepadInputSchema.parse({
      scope: "global",
      projectPath: null,
      name: "Fresh",
    });
    expect(parsed.writeMode).toBe("full-edit");
    expect(parsed.content).toBe("");
  });

  it("applies the same scope pairing rule as the entity", () => {
    expect(
      createNotepadInputSchema.safeParse({
        scope: "project",
        projectPath: null,
        name: "Fresh",
      }).success,
    ).toBe(false);
  });
});

describe("notepadContentWriteSchema", () => {
  it("requires a base revision for an agent write and allows a user write without one", () => {
    expect(
      notepadContentWriteSchema.safeParse({
        operation: "update",
        content: "new body",
        author: { kind: "agent", conversationId: "conv-1" },
      }).success,
    ).toBe(false);

    expect(
      notepadContentWriteSchema.safeParse({
        operation: "update",
        content: "new body",
        author: { kind: "user" },
      }).success,
    ).toBe(true);
  });

  it("accepts an agent write that states the revision it is based on", () => {
    const parsed = notepadContentWriteSchema.parse({
      operation: "append",
      content: "more",
      author: { kind: "agent", conversationId: "conv-1" },
      baseRevision: 3,
    });
    expect(parsed.baseRevision).toBe(3);
  });
});

describe("notepadListQuerySchema", () => {
  it("hides archived notepads and sorts by recency unless asked otherwise", () => {
    const parsed = notepadListQuerySchema.parse({});
    expect(parsed.includeArchived).toBe(false);
    expect(parsed.sort).toBe("recency");
  });

  it("accepts the name ordering", () => {
    expect(notepadListQuerySchema.parse({ sort: "name" }).sort).toBe("name");
  });
});

describe("notepadChangedEventSchema", () => {
  it("carries identifiers, the change kind, and a small list projection", () => {
    const parsed = notepadChangedEventSchema.parse({
      type: "notepad-changed",
      change: "updated",
      notepadId: "notepad-1",
      scope: "global",
      projectPath: null,
      revision: 2,
      authorKind: "agent",
      listItem: buildListItem(),
    });
    expect(parsed.change).toBe("updated");
    expect(parsed.listItem?.name).toBe("Scratch");
  });

  it("refuses a frame carrying notepad content — SSE frames stay small", () => {
    const result = notepadChangedEventSchema.safeParse({
      type: "notepad-changed",
      change: "updated",
      notepadId: "notepad-1",
      scope: "global",
      projectPath: null,
      revision: 2,
      authorKind: "agent",
      listItem: buildListItem(),
      content: "the whole notepad body",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a list projection carrying content", () => {
    const result = notepadChangedEventSchema.safeParse({
      type: "notepad-changed",
      change: "updated",
      notepadId: "notepad-1",
      scope: "global",
      projectPath: null,
      revision: 2,
      authorKind: "agent",
      listItem: buildListItem({ content: "the whole notepad body" }),
    });
    expect(result.success).toBe(false);
  });
});

describe("notepadCommentAnchorSchema", () => {
  it("mirrors the document-comments block anchor, substituting the notepad revision", () => {
    // The two shapes are mirrored rather than imported (a schema the state
    // store loads at open must not reach the conversation schema graph), so
    // this parity check is what keeps them from drifting apart.
    const documentFields = Object.keys(commentAnchorSchema.shape).filter(
      (field) => field !== "docRevision",
    );

    expect(Object.keys(notepadCommentAnchorSchema.shape).sort()).toEqual(
      [...documentFields, "notepadRevision"].sort(),
    );
  });

  it("records the authored-against revision as the notepad's integer counter", () => {
    const parsed = notepadCommentAnchorSchema.parse({
      sectionId: "release-notes",
      headingLabel: "Release notes",
      line: 3,
      charStart: 4,
      charEnd: 13,
      quote: "migration",
      prefix: "The ",
      suffix: " lands",
      notepadRevision: 7,
    });
    expect(parsed.notepadRevision).toBe(7);

    expect(
      notepadCommentAnchorSchema.safeParse({
        sectionId: "release-notes",
        headingLabel: "Release notes",
        line: 3,
        charStart: 4,
        charEnd: 13,
        quote: "migration",
        prefix: "The ",
        suffix: " lands",
        notepadRevision: "sha256:abc",
      }).success,
    ).toBe(false);
  });
});

describe("notepadCommentSchema", () => {
  function buildComment(overrides: Record<string, unknown> = {}) {
    return {
      id: "comment-1",
      notepadId: "notepad-1",
      anchor: {
        sectionId: "release-notes",
        headingLabel: "Release notes",
        line: 3,
        charStart: 4,
        charEnd: 13,
        quote: "migration",
        prefix: "The ",
        suffix: " lands",
        notepadRevision: 1,
      },
      body: "Name the rollback owner.",
      status: "open",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
      resolvedAt: null,
      ...overrides,
    };
  }

  it("keeps resolvedAt an explicit null so an unresolved comment is not a dropped field", () => {
    expect(notepadCommentSchema.parse(buildComment()).resolvedAt).toBeNull();
    expect(
      notepadCommentSchema.safeParse(
        Object.fromEntries(
          Object.entries(buildComment()).filter(
            ([field]) => field !== "resolvedAt",
          ),
        ),
      ).success,
    ).toBe(false);
  });

  it("names the conversation behind an agent-authored comment", () => {
    const parsed = notepadCommentSchema.parse(
      buildComment({ authorKind: "agent", authorConversationId: "conv-1" }),
    );
    expect(parsed.authorConversationId).toBe("conv-1");
  });
});
