import { describe, expect, it } from "vitest";
import type {
  ConversationListItem,
  SessionConversationListItem,
} from "@/lib/conversations/schemas";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  buildPickerView,
  pickerHasAnyMatch,
  PICKER_SECTION_CAP,
  scopeForTrigger,
  type PickerItemRow,
  type PickerMoreRow,
  type PickerViewInput,
} from "./reference-picker";
import type {
  ReferencePickerContext,
  SpecPickerSpec,
} from "./reference-registry";

function conversation(
  overrides: Partial<SessionConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "alpha",
    projectPath: overrides.projectPath ?? "/repos/alpha",
    scope: "session" as const,
    sessionName: overrides.sessionName ?? "main",
    worktreePath: overrides.worktreePath ?? "/repos/alpha/.worktrees/main",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? "Auth token refresh review",
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2026-07-01T00:00:00.000Z",
    archived: overrides.archived ?? false,
    compactArtifactId: overrides.compactArtifactId,
    compactStatus: overrides.compactStatus,
    compactCoveredSeq: overrides.compactCoveredSeq,
    compactCreatedAt: overrides.compactCreatedAt,
  };
}

function ticket(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/repos/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "Redesign prompt autocomplete",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "in_progress",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

const SPEC: SpecPickerSpec = {
  projectName: "alpha",
  specId: "spec-1",
  slug: "prompt-autocomplete",
  name: "Prompt input reference picker",
  revision: 4,
  elements: [
    {
      type: "requirement",
      elementId: "r1",
      handle: "R1",
      name: "Unified popup shell",
      searchText: "Unified popup shell",
    },
    {
      type: "decision",
      elementId: "d1",
      handle: "D1",
      name: "Scope tabs over sectioned list",
      searchText: "Scope tabs over sectioned list",
    },
    {
      type: "task",
      elementId: "t1",
      handle: "T1",
      name: "Extract shared picker shell",
      searchText: "Extract shared picker shell",
    },
  ],
};

function notepad(
  overrides: Partial<NotepadListItem> & { id: string },
): NotepadListItem {
  const scope = overrides.scope ?? "project";
  return {
    id: overrides.id,
    scope,
    projectPath:
      overrides.projectPath ?? (scope === "project" ? "/repos/alpha" : null),
    projectName:
      overrides.projectName ?? (scope === "project" ? "alpha" : null),
    name: overrides.name ?? "Release checklist",
    revision: overrides.revision ?? 1,
    writeMode: overrides.writeMode ?? "full-edit",
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

function context(
  overrides: Partial<ReferencePickerContext> = {},
): ReferencePickerContext {
  return {
    currentProjectName: "alpha",
    currentConversationId: null,
    conversations: [],
    tickets: [],
    specs: [],
    notepads: [],
    selectedSpec: null,
    includeFinishedTickets: false,
    includeArchivedConversations: false,
    ...overrides,
  };
}

function input(overrides: Partial<PickerViewInput> = {}): PickerViewInput {
  return {
    query: "",
    trigger: "#",
    scope: "all",
    drillScope: "all",
    context: context(),
    files: [],
    canOpenDocuments: true,
    ...overrides,
  };
}

function itemRows(rows: readonly { kind: string }[]): PickerItemRow[] {
  return rows.filter((row): row is PickerItemRow => row.kind === "item");
}

describe("scopeForTrigger", () => {
  it("preselects a scope per trigger character", () => {
    expect(scopeForTrigger("@")).toBe("file");
    expect(scopeForTrigger("#")).toBe("all");
    expect(scopeForTrigger("!")).toBe("ticket");
  });
});

describe("buildPickerView — scopes", () => {
  it("sections the All scope in kind order and headers each section", () => {
    const view = buildPickerView(
      input({
        files: [{ path: "src/lib/prompt.ts" }],
        context: context({
          conversations: [conversation({ conversationId: "c1" })],
          specs: [SPEC],
          tickets: [ticket({ id: "t1" })],
          notepads: [notepad({ id: "np-1" })],
        }),
      }),
    );

    expect(view.mode).toBe("scopes");
    expect(view.sections.map((section) => section.key)).toEqual([
      "file",
      "conversation",
      "spec",
      "ticket",
      "notepad",
    ]);
    expect(view.sections.every((section) => section.showHeader)).toBe(true);
    expect(view.sections.map((section) => section.label)).toEqual([
      "Files",
      "Conversations",
      "Specs",
      "Tickets",
      "Notepads",
    ]);
  });

  it("drops the section headers and shows one kind in a narrowed scope", () => {
    const view = buildPickerView(
      input({
        trigger: "!",
        scope: "ticket",
        context: context({
          conversations: [conversation({ conversationId: "c1" })],
          tickets: [ticket({ id: "t1" })],
        }),
      }),
    );

    expect(view.sections.map((section) => section.key)).toEqual(["ticket"]);
    expect(view.sections[0]?.showHeader).toBe(false);
    expect(view.headerLabel).toBe("! reference — tickets");
  });

  it("numbers rows across sections so the active index is a flat coordinate", () => {
    const view = buildPickerView(
      input({
        files: [{ path: "a.ts" }, { path: "b.ts" }],
        context: context({ tickets: [ticket({ id: "t1" })] }),
      }),
    );

    expect(view.rows.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(view.rows).toHaveLength(
      view.sections.reduce((total, section) => total + section.rows.length, 0),
    );
  });

  it("counts every match per tab, uncapped, including the All total", () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${index}.ts`,
    }));
    const view = buildPickerView(
      input({ files, context: context({ tickets: [ticket({ id: "t1" })] }) }),
    );

    const tabs = Object.fromEntries(
      view.tabs.map((tab) => [tab.key, tab.count]),
    );
    expect(tabs["file"]).toBe(7);
    expect(tabs["ticket"]).toBe(1);
    expect(tabs["all"]).toBe(8);
    expect(view.tabs.find((tab) => tab.key === "all")?.active).toBe(true);
  });

  it("caps each All-scope section and offers a jump row to the full scope", () => {
    const files = Array.from(
      { length: PICKER_SECTION_CAP + 3 },
      (_, index) => ({
        path: `src/file-${index}.ts`,
      }),
    );
    const view = buildPickerView(input({ files }));

    const section = view.sections.find((entry) => entry.key === "file");
    expect(itemRows(section?.rows ?? [])).toHaveLength(PICKER_SECTION_CAP);

    const more = section?.rows.at(-1) as PickerMoreRow | undefined;
    expect(more?.kind).toBe("more");
    expect(more?.scope).toBe("file");
    expect(more?.hiddenCount).toBe(3);
    expect(more?.label).toBe("+3 more in Files");
  });

  it("does not cap a narrowed scope", () => {
    const files = Array.from(
      { length: PICKER_SECTION_CAP + 3 },
      (_, index) => ({
        path: `src/file-${index}.ts`,
      }),
    );
    const view = buildPickerView(input({ scope: "file", files }));

    expect(itemRows(view.rows)).toHaveLength(PICKER_SECTION_CAP + 3);
    expect(view.rows.some((row) => row.kind === "more")).toBe(false);
  });

  it("counts results rather than jump rows in the header", () => {
    const files = Array.from(
      { length: PICKER_SECTION_CAP + 3 },
      (_, index) => ({
        path: `src/file-${index}.ts`,
      }),
    );
    const view = buildPickerView(input({ files }));

    expect(view.countLabel).toBe(`${PICKER_SECTION_CAP} results`);
  });

  it("lets a type-prefixed query override the selected scope", () => {
    const view = buildPickerView(
      input({
        query: "tickets: redesign",
        scope: "all",
        context: context({
          conversations: [conversation({ conversationId: "c1" })],
          tickets: [ticket({ id: "t1" })],
        }),
      }),
    );

    expect(view.scope).toBe("ticket");
    expect(view.sections.map((section) => section.key)).toEqual(["ticket"]);
    expect(itemRows(view.rows)).toHaveLength(1);
  });

  it("treats a space-separated word as query text, not a scope filter", () => {
    const view = buildPickerView(
      input({
        query: "task list",
        scope: "all",
        context: context({ specs: [SPEC] }),
      }),
    );

    expect(view.scope).toBe("all");
  });
});

describe("buildPickerView — rows", () => {
  it("presents a file row with its directory dimmed and extension trailing", () => {
    const view = buildPickerView(
      input({ scope: "file", files: [{ path: "src/lib/prompt.ts" }] }),
    );

    const row = itemRows(view.rows)[0];
    expect(row).toMatchObject({
      itemKind: "file",
      glyph: "file",
      label: "src/lib/prompt.ts",
      dimPrefixLength: "src/lib/".length,
      meta: { kind: "text", value: ".ts" },
      completion: "src/lib/prompt.ts",
      selection: {
        kind: "file",
        path: "src/lib/prompt.ts",
        basename: "prompt.ts",
        ext: "ts",
      },
    });
  });

  it("offers the document viewer only for markdown in a session worktree", () => {
    const files = [{ path: "docs/report.md" }, { path: "src/lib/prompt.ts" }];

    const session = itemRows(
      buildPickerView(input({ scope: "file", files })).rows,
    );
    expect(session.map((row) => row.openablePath)).toEqual([
      "docs/report.md",
      null,
    ]);

    const project = itemRows(
      buildPickerView(input({ scope: "file", files, canOpenDocuments: false }))
        .rows,
    );
    expect(project.every((row) => row.openablePath === null)).toBe(true);
  });

  it("keeps a ticket's identifier, status, attachment count, and session", () => {
    const view = buildPickerView(
      input({
        scope: "ticket",
        context: context({
          tickets: [
            ticket({
              id: "t1",
              number: 142,
              status: "blocked",
              attachmentCount: 3,
              activeSessionName: "ux-lab",
            }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows)[0]).toMatchObject({
      itemKind: "ticket",
      idLabel: "alpha#142",
      label: "Redesign prompt autocomplete",
      description: "feature",
      status: { label: "blocked", tone: "red" },
      facts: [
        { label: "3 context", tone: "muted" },
        { label: "active session", tone: "accent" },
      ],
      meta: { kind: "text", value: "current" },
      completion: "alpha#142",
      muted: false,
    });
  });

  it("carries a notepad's scope, recency, and the id the chip resolves by", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        context: context({
          notepads: [
            notepad({
              id: "np-7f3a",
              name: "Release checklist",
              updatedAt: "2026-07-09T00:00:00.000Z",
            }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows)[0]).toMatchObject({
      itemKind: "notepad",
      label: "Release checklist",
      description: "alpha",
      meta: { kind: "relative-time", iso: "2026-07-09T00:00:00.000Z" },
      status: null,
      completion: "Release checklist",
      muted: false,
      // The immutable id is what the inserted chip resolves by; the name is a
      // display snapshot.
      selection: {
        kind: "reference",
        type: "notepad",
        attrs: {
          notepadId: "np-7f3a",
          name: "Release checklist",
          scope: "project",
          projectName: "alpha",
        },
      },
    });
  });

  it("labels a global notepad by its scope rather than a project", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        context: context({
          notepads: [notepad({ id: "np-1", scope: "global" })],
        }),
      }),
    );

    expect(itemRows(view.rows)[0]).toMatchObject({
      description: "Global",
      selection: {
        kind: "reference",
        type: "notepad",
        attrs: { scope: "global", projectName: "" },
      },
    });
  });

  it("flags a write mode that constrains agents, and stays silent on the default", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        context: context({
          notepads: [
            notepad({ id: "np-1", name: "Read only", writeMode: "read-only" }),
            notepad({
              id: "np-2",
              name: "Append only",
              writeMode: "append-only",
            }),
            notepad({ id: "np-3", name: "Full edit", writeMode: "full-edit" }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows).map((row) => row.status)).toEqual([
      { label: "read only", tone: "neutral" },
      { label: "append only", tone: "amber" },
      null,
    ]);
  });

  it("ranks pinned notepads ahead of the rest — pins are the working set", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        context: context({
          notepads: [
            notepad({ id: "np-1", name: "Ordinary" }),
            notepad({ id: "np-2", name: "Pinned", pinned: true }),
            notepad({ id: "np-3", name: "Also ordinary" }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows).map((row) => row.label)).toEqual([
      "Pinned",
      "Ordinary",
      "Also ordinary",
    ]);
    expect(itemRows(view.rows)[0]?.facts).toEqual([
      { label: "pinned", tone: "accent" },
    ]);
  });

  it("offers only notepads reachable from here: unarchived, global or this project", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        context: context({
          notepads: [
            notepad({ id: "np-1", name: "This project" }),
            notepad({ id: "np-2", name: "Everywhere", scope: "global" }),
            notepad({
              id: "np-3",
              name: "Another project",
              projectName: "beta",
              projectPath: "/repos/beta",
            }),
            notepad({ id: "np-4", name: "Archived", archived: true }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows).map((row) => row.label)).toEqual([
      "This project",
      "Everywhere",
    ]);
  });

  it("filters notepads by name against the query", () => {
    const view = buildPickerView(
      input({
        scope: "notepad",
        query: "check",
        context: context({
          notepads: [
            notepad({ id: "np-1", name: "Release checklist" }),
            notepad({ id: "np-2", name: "Meeting notes" }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows).map((row) => row.label)).toEqual([
      "Release checklist",
    ]);
  });

  it("carries a conversation's status and last activity instant", () => {
    const view = buildPickerView(
      input({
        scope: "conversation",
        context: context({
          conversations: [
            conversation({
              conversationId: "c1",
              status: "running",
              lastActivityAt: "2026-07-02T09:00:00.000Z",
            }),
          ],
        }),
      }),
    );

    expect(itemRows(view.rows)[0]).toMatchObject({
      itemKind: "conversation",
      label: "Auth token refresh review",
      status: { label: "running", tone: "cyan" },
      meta: { kind: "relative-time", iso: "2026-07-02T09:00:00.000Z" },
      completion: "Auth token refresh review",
    });
  });

  it("labels a spec by slug and advertises the drill-in affordance", () => {
    const view = buildPickerView(
      input({ scope: "spec", context: context({ specs: [SPEC] }) }),
    );

    expect(itemRows(view.rows)[0]).toMatchObject({
      itemKind: "spec",
      label: "prompt-autocomplete",
      description: "Prompt input reference picker",
      meta: { kind: "text", value: "rev 4 · / drill" },
      completion: "prompt-autocomplete",
    });
  });

  it("carries the registry attrs a selection inserts", () => {
    const view = buildPickerView(
      input({
        scope: "ticket",
        context: context({ tickets: [ticket({ id: "t1", number: 142 })] }),
      }),
    );

    expect(itemRows(view.rows)[0]?.selection).toEqual({
      kind: "reference",
      type: "ticket",
      attrs: {
        projectName: "alpha",
        ticketNumber: "142",
        identifier: "alpha#142",
        title: "Redesign prompt autocomplete",
      },
    });
  });
});

describe("buildPickerView — status and archive filters", () => {
  const tickets = [
    ticket({ id: "live", title: "Match live", status: "in_progress" }),
    ticket({ id: "shipped", title: "Match shipped", status: "done" }),
    ticket({ id: "dropped", title: "Match dropped", status: "closed" }),
  ];

  it("hides finished tickets and offers them through the done chip", () => {
    const view = buildPickerView(
      input({ scope: "ticket", context: context({ tickets }) }),
    );

    expect(itemRows(view.rows).map((row) => row.label)).toEqual(["Match live"]);
    expect(view.doneChip).toEqual({
      visible: true,
      active: false,
      label: "+2 done",
      hiddenCount: 2,
    });
    expect(view.sections[0]?.hint).toBe("2 done hidden · Alt+D");
  });

  it("dims finished tickets once the done chip is active", () => {
    const view = buildPickerView(
      input({
        scope: "ticket",
        context: context({ tickets, includeFinishedTickets: true }),
      }),
    );

    expect(itemRows(view.rows).map((row) => [row.label, row.muted])).toEqual([
      ["Match live", false],
      ["Match shipped", true],
      ["Match dropped", true],
    ]);
    expect(view.doneChip).toMatchObject({
      visible: true,
      active: true,
      label: "incl. done",
    });
    expect(view.sections[0]?.hint).toBe("incl. done · Alt+D");
  });

  it("hides the done chip where no ticket is in scope", () => {
    const view = buildPickerView(
      input({ scope: "conversation", context: context({ tickets }) }),
    );

    expect(view.doneChip.visible).toBe(false);
  });

  it("hides archived conversations and offers them through the archived chip", () => {
    const conversations = [
      conversation({ conversationId: "live" }),
      conversation({
        conversationId: "old",
        conversationName: "Auth token archive spike",
        archived: true,
      }),
    ];

    const hidden = buildPickerView(
      input({ scope: "conversation", context: context({ conversations }) }),
    );
    expect(itemRows(hidden.rows)).toHaveLength(1);
    expect(hidden.archivedChip).toEqual({
      visible: true,
      active: false,
      label: "+1 archived",
      hiddenCount: 1,
    });

    const shown = buildPickerView(
      input({
        scope: "conversation",
        context: context({
          conversations,
          includeArchivedConversations: true,
        }),
      }),
    );
    expect(itemRows(shown.rows)).toHaveLength(2);
    expect(
      itemRows(shown.rows).find((row) => row.label.includes("archive spike")),
    ).toMatchObject({ muted: true, meta: { kind: "text", value: "archived" } });
  });
});

describe("buildPickerView — spec drill-in", () => {
  const drillContext = context({ specs: [SPEC] });

  it("switches to the spec's elements and tabs by element kind", () => {
    const view = buildPickerView(
      input({ query: "prompt-autocomplete/", context: drillContext }),
    );

    expect(view.mode).toBe("drill");
    expect(view.headerLabel).toBe("# spec — prompt-autocomplete · rev 4");
    expect(view.countLabel).toBe("3 elements");
    expect(view.tabs.map((tab) => tab.key)).toEqual([
      "all",
      "requirement",
      "decision",
      "task",
    ]);
    expect(view.sections.map((section) => section.label)).toEqual([
      "Requirements",
      "Decisions",
      "Tasks",
    ]);
  });

  it("narrows to one element kind and completes slug-qualified handles", () => {
    const view = buildPickerView(
      input({
        query: "prompt-autocomplete/",
        drillScope: "decision",
        context: drillContext,
      }),
    );

    expect(view.sections.map((section) => section.key)).toEqual(["decision"]);
    expect(itemRows(view.rows)[0]).toMatchObject({
      itemKind: "decision",
      glyph: "spec",
      idLabel: "D1",
      label: "Scope tabs over sectioned list",
      completion: "prompt-autocomplete/D1",
    });
  });

  it("filters elements by the text after the slash", () => {
    const view = buildPickerView(
      input({ query: "prompt-autocomplete/shell", context: drillContext }),
    );

    expect(itemRows(view.rows).map((row) => row.idLabel)).toEqual(["R1", "T1"]);
  });

  it("stays in scope mode when the slug matches no spec", () => {
    const view = buildPickerView(
      input({ query: "not-a-spec/", context: drillContext }),
    );

    expect(view.mode).toBe("scopes");
  });
});

describe("pickerHasAnyMatch", () => {
  it("is true while some scope still matches the query", () => {
    expect(
      pickerHasAnyMatch(
        input({
          query: "auth token",
          scope: "file",
          context: context({
            conversations: [conversation({ conversationId: "c1" })],
          }),
        }),
      ),
    ).toBe(true);
  });

  it("is false once nothing matches in any scope", () => {
    expect(
      pickerHasAnyMatch(
        input({
          query: "nothing matches this",
          context: context({
            conversations: [conversation({ conversationId: "c1" })],
            tickets: [ticket({ id: "t1" })],
            specs: [SPEC],
          }),
          files: [{ path: "src/lib/prompt.ts" }],
        }),
      ),
    ).toBe(false);
  });
});
