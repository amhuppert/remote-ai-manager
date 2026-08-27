// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { vi } from "vitest";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { registerNotepadSseReactions } from "@/lib/notepads/sse-reactions";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type {
  NotepadChangedEvent,
  NotepadListItem,
  NotepadRevision,
} from "@/lib/notepads/schemas";
import NotepadPanel from "./NotepadPanel";

// Tiptap needs Range measurement APIs jsdom does not implement.
beforeEach(() => {
  if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* () {},
        }) as unknown as DOMRectList;
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }
  }
});

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
  useSessionDetailStore.getState().resetStore();
});
afterEach(() => {
  api.restore();
  cleanup();
});

function listItem(overrides: Partial<NotepadListItem>): NotepadListItem {
  return {
    id: "np-x",
    scope: "project",
    projectPath: "/repos/p1",
    projectName: "p1",
    name: "unnamed",
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const PINNED = listItem({
  id: "np-pin",
  name: "slice-1 working context",
  pinned: true,
});
const PROJECT_ROW = listItem({ id: "np-a", name: "release 0.4 checklist" });
const GLOBAL_ROW = listItem({
  id: "np-g",
  scope: "global",
  projectPath: null,
  projectName: null,
  name: "global conventions",
});
const ARCHIVED_ROW = listItem({
  id: "np-arch",
  name: "old scratch",
  archived: true,
});

const DEFAULT_ROWS = [PINNED, PROJECT_ROW, GLOBAL_ROW];

function notepadBody(overrides: Record<string, unknown> = {}) {
  return {
    notepad: {
      id: "np-a",
      scope: "project",
      projectPath: "/repos/p1",
      name: "release 0.4 checklist",
      content: "# checklist\n\n- [ ] tag the release",
      revision: 3,
      writeMode: "full-edit",
      pinned: false,
      archived: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      ...overrides,
    },
  };
}

function stubDefaultList(rows: NotepadListItem[] = DEFAULT_ROWS) {
  api.reply("GET", /^\/api\/notepads\?project=p1&sort=recency$/, {
    json: { notepads: rows },
  });
}

function renderPanel(active = true, queryClient = createTestQueryClient()) {
  return renderWithQuery(
    <NotepadPanel
      projectName="p1"
      sessionName="s1"
      conversationId="c1"
      active={active}
    />,
    queryClient,
  );
}

describe("NotepadPanel — browse list", () => {
  it("renders the reachable notepads with pinned rows in their own section", async () => {
    stubDefaultList();
    renderPanel();

    expect(
      await screen.findByRole("button", {
        name: "Open notepad slice-1 working context",
      }),
    ).toBeVisible();
    expect(screen.getByText("Pinned")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open notepad global conventions" }),
    ).toBeVisible();
    // Global-scope rows carry a scope badge so scope stays readable without
    // scope sections (which would override the requested sort order).
    expect(screen.getByText("global")).toBeVisible();
  });

  it("keeps unpinned rows in the server's order across scopes", async () => {
    // Recency order interleaves scopes: the global notepad was updated most
    // recently, so the server returns it before the project one. Scope must
    // not regroup it below older project rows.
    stubDefaultList([PINNED, GLOBAL_ROW, PROJECT_ROW]);
    renderPanel();

    await screen.findByText("Pinned");
    const labels = screen
      .getAllByRole("button", { name: /^Open notepad / })
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Open notepad slice-1 working context",
      "Open notepad global conventions",
      "Open notepad release 0.4 checklist",
    ]);
  });

  it("does not fetch while the tab is inactive", async () => {
    stubDefaultList();
    renderPanel(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.requestsTo("GET", /\/api\/notepads/).length).toBe(0);
  });

  it("switches sort ordering and records the preference in the store", async () => {
    stubDefaultList();
    api.reply("GET", /^\/api\/notepads\?project=p1&sort=name$/, {
      json: { notepads: [PROJECT_ROW, GLOBAL_ROW, PINNED] },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(screen.getByRole("radio", { name: "name" }));

    await waitFor(() =>
      expect(
        api.requestsTo("GET", /^\/api\/notepads\?project=p1&sort=name$/).length,
      ).toBeGreaterThan(0),
    );
    expect(useSessionDetailStore.getState().notepadSort).toBe("name");
  });

  it("reveals archived notepads on request", async () => {
    stubDefaultList();
    api.reply(
      "GET",
      /^\/api\/notepads\?project=p1&sort=recency&archived=true$/,
      { json: { notepads: [...DEFAULT_ROWS, ARCHIVED_ROW] } },
    );
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");
    expect(screen.queryByText("old scratch")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archived" }));

    expect(
      await screen.findByRole("button", { name: "Open notepad old scratch" }),
    ).toBeVisible();
  });
});

describe("NotepadPanel — create", () => {
  it("creates a project notepad and opens it", async () => {
    stubDefaultList();
    api.reply("POST", "/api/notepads", {
      status: 201,
      json: notepadBody({ id: "np-new", name: "launch notes", content: "" }),
    });
    api.json(
      "GET",
      "/api/notepads/np-new",
      notepadBody({ id: "np-new", name: "launch notes", content: "" }),
    );
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(
      screen.getByRole("textbox", { name: "Notepad name" }),
      "launch notes",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(useSessionDetailStore.getState().openNotepadId).toBe("np-new"),
    );
    const posted = api.requestsTo("POST", "/api/notepads")[0];
    expect(posted?.jsonBody).toEqual({
      scope: "project",
      project: "p1",
      name: "launch notes",
    });
  });

  it("shows the duplicate-name refusal inline and stays browsing", async () => {
    stubDefaultList();
    api.reply("POST", "/api/notepads", {
      status: 409,
      json: {
        error: 'A project notepad named "release 0.4 checklist" already exists',
        code: "name_taken",
      },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(screen.getByRole("button", { name: "New" }));
    await user.type(
      screen.getByRole("textbox", { name: "Notepad name" }),
      "release 0.4 checklist",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/already exists/i)).toBeVisible();
    expect(useSessionDetailStore.getState().openNotepadId).toBeNull();
  });
});

describe("NotepadPanel — organization", () => {
  it("renames a notepad with immediate visual feedback", async () => {
    // The list responder tracks the rename so the hygiene refetch agrees with
    // the optimistic patch, as the real server would.
    let rows = DEFAULT_ROWS;
    api.reply("GET", /^\/api\/notepads\?project=p1&sort=recency$/, () => ({
      json: { notepads: rows },
    }));
    api.reply("PATCH", "/api/notepads/np-a", () => {
      rows = rows.map((row) =>
        row.id === "np-a" ? { ...row, name: "release 0.4 plan" } : row,
      );
      return { json: notepadBody({ name: "release 0.4 plan" }) };
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(
      screen.getByRole("button", { name: "Actions for release 0.4 checklist" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "release 0.4 plan{Enter}");

    // Optimistic: the new name is visible without waiting for the refetch.
    expect(
      await screen.findByRole("button", {
        name: "Open notepad release 0.4 plan",
      }),
    ).toBeVisible();
    const patched = api.requestsTo("PATCH", "/api/notepads/np-a")[0];
    expect(patched?.jsonBody).toEqual({ name: "release 0.4 plan" });
  });

  it("pins a notepad through its row menu", async () => {
    stubDefaultList();
    api.json("PATCH", "/api/notepads/np-a", notepadBody({ pinned: true }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(
      screen.getByRole("button", { name: "Actions for release 0.4 checklist" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));

    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a")[0]?.jsonBody,
      ).toEqual({ pinned: true }),
    );
  });

  it("archives a notepad through its row menu", async () => {
    stubDefaultList();
    api.json("PATCH", "/api/notepads/np-a", notepadBody({ archived: true }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(
      screen.getByRole("button", { name: "Actions for release 0.4 checklist" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a")[0]?.jsonBody,
      ).toEqual({ archived: true }),
    );
    // The default listing hides archived rows immediately (optimistic filter
    // keeps them, refetch removes them — either way the PATCH landed).
  });

  it("deletes only after confirmation and drops the row", async () => {
    let rows = DEFAULT_ROWS;
    api.reply("GET", /^\/api\/notepads\?project=p1&sort=recency$/, () => ({
      json: { notepads: rows },
    }));
    api.reply("DELETE", "/api/notepads/np-a", () => {
      rows = rows.filter((row) => row.id !== "np-a");
      return { json: notepadBody() };
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(
      screen.getByRole("button", { name: "Actions for release 0.4 checklist" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    // Nothing deleted until the confirm.
    expect(api.requestsTo("DELETE", /np-a/).length).toBe(0);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.requestsTo("DELETE", "/api/notepads/np-a").length).toBe(1),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Open notepad release 0.4 checklist",
        }),
      ).not.toBeInTheDocument(),
    );
  });
});

/**
 * jsdom has no constructible ClipboardEvent carrying data, so a plain Event
 * gets the minimal clipboardData surface the paste handlers read. Dispatching
 * it on the ProseMirror contenteditable drives a real edit through the real
 * editor, exactly as a user paste would.
 */
function pasteIntoEditor(text: string): void {
  const dom = screen.getByTestId("notepad-editor-input");
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      items: [],
    },
  });
  dom.dispatchEvent(event);
}

/** A stateful notepad server: content writes advance the head revision. */
function stubEditableNotepad(initialContent: string, initialRevision = 3) {
  const state = { content: initialContent, revision: initialRevision };
  api.reply("GET", "/api/notepads/np-a", () => ({
    json: notepadBody({ content: state.content, revision: state.revision }),
  }));
  api.reply("POST", "/api/notepads/np-a/content", (req) => {
    const body = req.jsonBody as { content: string };
    state.content = body.content;
    state.revision += 1;
    return {
      json: notepadBody({ content: state.content, revision: state.revision }),
    };
  });
  return state;
}

async function openNotepadRow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", {
      name: "Open notepad release 0.4 checklist",
    }),
  );
  await screen.findByTestId("notepad-editor-input");
}

describe("NotepadPanel — autosave", () => {
  it("flushes the edit when the notepad closes and shows it on reopen", async () => {
    stubDefaultList();
    stubEditableNotepad("# checklist\n\n- [ ] tag the release");
    const user = userEvent.setup();
    renderPanel();
    await openNotepadRow(user);

    pasteIntoEditor("alpha-note ");
    await user.click(screen.getByRole("button", { name: "Back to notepads" }));

    await waitFor(() => {
      const posts = api.requestsTo("POST", "/api/notepads/np-a/content");
      expect(posts.length).toBe(1);
    });
    const body = api.requestsTo("POST", "/api/notepads/np-a/content")[0]
      ?.jsonBody as {
      operation: string;
      content: string;
      baseRevision: number;
    };
    expect(body.operation).toBe("update");
    expect(body.baseRevision).toBe(3);
    expect(body.content).toContain("alpha-note");

    // Reopen: the persisted content comes back from the server.
    await openNotepadRow(user);
    expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
      "alpha-note",
    );
  });

  it("idle-flushes after a pause and adopts the returned head revision", async () => {
    stubDefaultList();
    stubEditableNotepad("base text");
    const user = userEvent.setup();
    renderPanel();
    await openNotepadRow(user);

    pasteIntoEditor("first ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );

    pasteIntoEditor("second ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(2),
      { timeout: 4000 },
    );

    const bodies = api
      .requestsTo("POST", "/api/notepads/np-a/content")
      .map((req) => req.jsonBody as { baseRevision: number });
    expect(bodies[0]?.baseRevision).toBe(3);
    // The second flush is based on the head the first flush returned.
    expect(bodies[1]?.baseRevision).toBe(4);
  });

  it("posts an edit typed during an in-flight save even when the view closes mid-flight", async () => {
    stubDefaultList();
    const state = { content: "base text", revision: 3 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ content: state.content, revision: state.revision }),
    }));
    // The first save hangs until released so a second edit and the close can
    // both land while it is in flight.
    let releaseFirstPost: (() => void) | undefined;
    let posts = 0;
    api.reply("POST", "/api/notepads/np-a/content", async (req) => {
      posts += 1;
      if (posts === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPost = resolve;
        });
      }
      const body = req.jsonBody as { content: string };
      state.content = body.content;
      state.revision += 1;
      return {
        json: notepadBody({ content: state.content, revision: state.revision }),
      };
    });
    const user = userEvent.setup();
    renderPanel();
    await openNotepadRow(user);

    pasteIntoEditor("first ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );

    // Typed while save A is in flight; the view closes before A returns.
    pasteIntoEditor("second ");
    await user.click(screen.getByRole("button", { name: "Back to notepads" }));
    releaseFirstPost?.();

    await waitFor(() =>
      expect(api.requestsTo("POST", "/api/notepads/np-a/content").length).toBe(
        2,
      ),
    );
    const followUp = api.requestsTo("POST", "/api/notepads/np-a/content")[1]
      ?.jsonBody as { content: string; baseRevision: number };
    expect(followUp.content).toContain("second");
    // Based on the head the first save returned, keeping the chain honest.
    expect(followUp.baseRevision).toBe(4);
  });
});

function revisionRow(
  revision: number,
  overrides: Partial<NotepadRevision> = {},
): NotepadRevision {
  return {
    id: `rev-${revision}`,
    notepadId: "np-a",
    revision,
    content: `content r${revision}`,
    authorKind: "user",
    authorConversationId: null,
    origin: revision === 1 ? "create" : "edit",
    baseRevision: revision > 1 ? revision - 1 : null,
    restoredFromRevision: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("NotepadPanel — history and restore", () => {
  function stubHistory() {
    const revisions: NotepadRevision[] = [
      revisionRow(3),
      revisionRow(2, {
        authorKind: "agent",
        authorConversationId: "c9",
        origin: "append",
      }),
      revisionRow(1),
    ];
    const state = { content: "content r3", revision: 3 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ content: state.content, revision: state.revision }),
    }));
    api.reply("GET", "/api/notepads/np-a/revisions", () => ({
      json: { revisions },
    }));
    api.reply("POST", "/api/notepads/np-a/restore", (req) => {
      const body = req.jsonBody as { revision: number };
      const source = revisions.find((rev) => rev.revision === body.revision);
      state.revision += 1;
      state.content = source?.content ?? state.content;
      revisions.unshift(
        revisionRow(state.revision, {
          origin: "restore",
          restoredFromRevision: body.revision,
          content: state.content,
          baseRevision: state.revision - 1,
        }),
      );
      return {
        json: notepadBody({ content: state.content, revision: state.revision }),
      };
    });
    return { revisions, state };
  }

  it("lists attributed revisions and restores one immediately, without a confirm", async () => {
    stubDefaultList();
    stubHistory();
    const user = userEvent.setup();
    renderPanel();
    await openNotepadRow(user);

    await user.click(screen.getByRole("button", { name: "History" }));
    // Attribution is visible: the agent revision names its author kind.
    const history = await screen.findByTestId("notepad-history");
    expect(history).toHaveTextContent("r2");
    expect(history).toHaveTextContent("agent");

    await user.click(screen.getByRole("button", { name: "Select revision 2" }));
    // Snapshot preview shows the selected revision's content.
    expect(await screen.findByText("content r2")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Restore r2" }));

    // No confirm dialog: the restore request fires from the single click.
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/restore")[0]?.jsonBody,
      ).toEqual({ revision: 2 }),
    );
    // The open editor now holds the restored content…
    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "content r2",
      ),
    );
    // …and history grew a restore revision while earlier rows survive.
    await waitFor(() =>
      expect(screen.getByTestId("notepad-history")).toHaveTextContent("r4"),
    );
    expect(screen.getByTestId("notepad-history")).toHaveTextContent("restore");
    expect(screen.getByTestId("notepad-history")).toHaveTextContent("r1");
  });

  it("offers no restore on the head revision", async () => {
    stubDefaultList();
    stubHistory();
    const user = userEvent.setup();
    renderPanel();
    await openNotepadRow(user);

    await user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByTestId("notepad-history");
    await user.click(screen.getByRole("button", { name: "Select revision 3" }));

    const restoreButton = screen.getByRole("button", { name: "current" });
    expect(restoreButton).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Restore r3" }),
    ).not.toBeInTheDocument();
  });
});

describe("NotepadPanel — history diff views", () => {
  /**
   * Fixture with a real revision chain: r1 → r2 edits one line, r3 (head)
   * appends one. Selected r2 then shows one replacement versus its
   * predecessor and one removal versus the head it would displace.
   */
  function stubDiffHistory() {
    const revisions: NotepadRevision[] = [
      revisionRow(3, { content: "alpha\ngamma\ndelta" }),
      revisionRow(2, { content: "alpha\ngamma" }),
      revisionRow(1, { content: "alpha\nbeta" }),
    ];
    api.reply("GET", "/api/notepads/np-a", {
      json: notepadBody({ content: "alpha\ngamma\ndelta", revision: 3 }),
    });
    api.reply("GET", "/api/notepads/np-a/revisions", { json: { revisions } });
  }

  async function openHistoryAndSelect(
    user: ReturnType<typeof userEvent.setup>,
    revision: number,
  ) {
    await openNotepadRow(user);
    await user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByTestId("notepad-history");
    await user.click(
      screen.getByRole("button", { name: `Select revision ${revision}` }),
    );
  }

  it("shows what the revision changed versus its predecessor", async () => {
    stubDefaultList();
    stubDiffHistory();
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 2);

    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    const history = screen.getByTestId("notepad-history");
    const removed = history.querySelectorAll("del");
    const added = history.querySelectorAll("ins");
    expect([...removed].map((el) => el.textContent)).toEqual(["beta"]);
    expect([...added].map((el) => el.textContent)).toEqual(["gamma"]);
    expect(history).toHaveTextContent("alpha");
  });

  it("shows what restoring would change versus the current head", async () => {
    stubDefaultList();
    stubDiffHistory();
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 2);

    await user.click(screen.getByRole("radio", { name: "vs current" }));

    const history = screen.getByTestId("notepad-history");
    // Restoring r2 over head r3 drops the appended line — nothing else.
    expect(
      [...history.querySelectorAll("del")].map((el) => el.textContent),
    ).toEqual(["delta"]);
    expect(history.querySelectorAll("ins").length).toBe(0);
  });

  it("resets to the snapshot view when the selection changes", async () => {
    stubDefaultList();
    stubDiffHistory();
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 2);
    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    await user.click(screen.getByRole("button", { name: "Select revision 1" }));

    expect(screen.getByRole("radio", { name: "snapshot" })).toBeChecked();
    const history = screen.getByTestId("notepad-history");
    expect(history.querySelectorAll("del").length).toBe(0);
    expect(history).toHaveTextContent("beta");
  });

  it("resolves the out-of-window predecessor of the oldest listed revision by id", async () => {
    stubDefaultList();
    api.reply("GET", "/api/notepads/np-a", {
      json: notepadBody({ content: "content r54", revision: 54 }),
    });
    // Listed page r54..r5 (head 54, window 50). r5's predecessor r4 is outside
    // the page, so the drawer must ask for the selection by id. r5 is a user
    // restore whose baseRevision is null — the diff must still come from the
    // real r4 content, never an empty-string stand-in.
    const listed = Array.from({ length: 50 }, (_, i) =>
      i === 49
        ? revisionRow(5, {
            origin: "restore",
            baseRevision: null,
            restoredFromRevision: 2,
          })
        : revisionRow(54 - i),
    );
    api.reply("GET", /\/api\/notepads\/np-a\/revisions/, (req) => {
      const at = req.searchParams.get("at");
      if (at === null) return { json: { revisions: listed } };
      const revision = Number(at);
      return {
        json: {
          revisions: [
            revisionRow(revision - 1),
            listed.find((row) => row.revision === revision) ??
              revisionRow(revision),
          ],
        },
      };
    });
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 5);

    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    const history = screen.getByTestId("notepad-history");
    await waitFor(() =>
      expect(
        [...history.querySelectorAll("del")].map((el) => el.textContent),
      ).toEqual(["content r4"]),
    );
    expect(
      [...history.querySelectorAll("ins")].map((el) => el.textContent),
    ).toEqual(["content r5"]);
    // The predecessor came from an id-addressed resolution, not a wider page.
    expect(
      api
        .requestsTo("GET", /\/api\/notepads\/np-a\/revisions\?/)
        .some((req) => req.searchParams.get("at") === "5"),
    ).toBe(true);
  });

  it("keeps a selection that slides out of the listed window, resolving it by id", async () => {
    stubDefaultList();
    const server = { revision: 54 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({
        content: `content r${server.revision}`,
        revision: server.revision,
      }),
    }));
    api.reply("GET", /\/api\/notepads\/np-a\/revisions/, (req) => {
      const at = req.searchParams.get("at");
      if (at !== null) {
        const revision = Number(at);
        return {
          json: {
            revisions: [revisionRow(revision - 1), revisionRow(revision)],
          },
        };
      }
      return {
        json: {
          revisions: Array.from({ length: 50 }, (_, i) =>
            revisionRow(server.revision - i),
          ),
        },
      };
    });
    api.reply("POST", "/api/notepads/np-a/restore", () => {
      server.revision += 1;
      return {
        json: notepadBody({ content: "content r5", revision: server.revision }),
      };
    });
    const user = userEvent.setup();
    renderPanel();
    // r5 is the oldest listed row (head r54, window 50).
    await openHistoryAndSelect(user, 5);
    expect(screen.getByRole("radio", { name: "vs previous" })).toBeVisible();

    // Restoring creates head r55: the listed window slides to r55..r6 and the
    // selected r5 falls off the page.
    await user.click(screen.getByRole("button", { name: "Restore r5" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Select revision 55" }),
      ).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "Select revision 5" }),
    ).not.toBeInTheDocument();
    // The selection is id-addressed, never limited to the listed page: r5
    // stays selected with its real versus-previous diff on offer.
    expect(screen.getByRole("button", { name: "Restore r5" })).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "vs previous" }));
    const history = screen.getByTestId("notepad-history");
    await waitFor(() =>
      expect(
        [...history.querySelectorAll("del")].map((el) => el.textContent),
      ).toEqual(["content r4"]),
    );
    expect(
      [...history.querySelectorAll("ins")].map((el) => el.textContent),
    ).toEqual(["content r5"]);
  });

  it("shows a retryable error instead of a snapshot lookalike when resolution fails", async () => {
    stubDefaultList();
    api.reply("GET", "/api/notepads/np-a", {
      json: notepadBody({ content: "alpha\ngamma\ndelta", revision: 3 }),
    });
    const revisions: NotepadRevision[] = [
      revisionRow(3, { content: "alpha\ngamma\ndelta" }),
      revisionRow(2, { content: "alpha\ngamma" }),
      revisionRow(1, { content: "alpha\nbeta" }),
    ];
    let failResolution = true;
    api.reply("GET", /\/api\/notepads\/np-a\/revisions/, (req) => {
      if (req.searchParams.get("at") !== null && failResolution) {
        return { status: 500, json: { error: "boom" } };
      }
      return { json: { revisions } };
    });
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 2);
    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    // A failed resolution is stated, never dressed up as a valid snapshot.
    expect(await screen.findByText(/Couldn't load this diff/)).toBeVisible();
    expect(
      screen.getByTestId("notepad-history").querySelectorAll("ins").length,
    ).toBe(0);

    failResolution = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    const history = screen.getByTestId("notepad-history");
    await waitFor(() =>
      expect(
        [...history.querySelectorAll("ins")].map((el) => el.textContent),
      ).toEqual(["gamma"]),
    );
  });

  it("offers versus-previous on the create revision as fully added", async () => {
    stubDefaultList();
    stubDiffHistory();
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 1);

    // The create revision has no predecessor by nature (baseRevision null),
    // so its versus-previous is legitimately the whole snapshot added.
    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    const history = screen.getByTestId("notepad-history");
    expect(
      [...history.querySelectorAll("ins")].map((el) => el.textContent),
    ).toEqual(["alpha", "beta"]);
    expect(history.querySelectorAll("del").length).toBe(0);
  });

  it("does not offer versus-current on the head revision", async () => {
    stubDefaultList();
    stubDiffHistory();
    const user = userEvent.setup();
    renderPanel();
    await openHistoryAndSelect(user, 3);

    expect(
      screen.queryByRole("radio", { name: "vs current" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "vs previous" })).toBeVisible();
    expect(screen.getByRole("button", { name: "current" })).toBeDisabled();
  });
});

describe("NotepadPanel — copy as Markdown", () => {
  it("places the canonical text on the clipboard, reference XML included", async () => {
    const canonical = [
      "# release",
      "",
      '- ship <ticket-ref project-name="p1" ticket-number="12" title="Add durable ticket context" read-command="cctl ticket get 12" />',
    ].join("\n");
    stubDefaultList();
    stubEditableNotepad(canonical);
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard stub, and the
    // assertion needs the component to reach this recording one.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPanel();
    await openNotepadRow(user);

    await user.click(screen.getByRole("button", { name: "Copy as Markdown" }));

    expect(writeText).toHaveBeenCalledWith(canonical);
  });

  it("copies the stored text verbatim, not a reserialization of it", async () => {
    // CRLF is the sentinel: the editor's deserialize/serialize round-trip
    // normalizes it to LF, while persistence and agent reads keep it. An
    // unedited notepad must copy byte-identical to its agent-visible form.
    const canonical = "line one\r\nline two";
    stubDefaultList();
    stubEditableNotepad(canonical);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPanel();
    await openNotepadRow(user);

    await user.click(screen.getByRole("button", { name: "Copy as Markdown" }));

    expect(writeText).toHaveBeenCalledWith(canonical);
  });
});

describe("NotepadPanel — live updates", () => {
  /**
   * The production wiring end-to-end minus the transport: the reaction module
   * registered against a fake EventSource, feeding the render's query client
   * and the real store — exactly how NotificationListener assembles it.
   */
  function setupLive() {
    const queryClient = createTestQueryClient();
    const fake = new FakeEventSource("/api/events");
    registerNotepadSseReactions(fake as unknown as EventSource, {
      queryClient,
      recordNotepadExternalWrite: (write) =>
        useSessionDetailStore.getState().recordNotepadExternalWrite(write),
    });
    return { queryClient, fake };
  }

  function changedEvent(
    overrides: Partial<NotepadChangedEvent> = {},
  ): NotepadChangedEvent {
    return {
      type: "notepad-changed",
      change: "updated",
      notepadId: "np-a",
      scope: "project",
      projectPath: "/repos/p1",
      revision: 4,
      authorKind: "agent",
      listItem: listItem({ id: "np-a", name: "release 0.4 checklist" }),
      ...overrides,
    };
  }

  it("shows an external write in the open view without refresh when clean", async () => {
    stubDefaultList();
    const state = stubEditableNotepad("base text");
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    state.content = "agent wrote this";
    state.revision = 4;
    fake.emit("notepad-changed", changedEvent());

    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "agent wrote this",
      ),
    );
    // The landed-write strip is the first agent-visible moment (page 04).
    const banner = screen.getByTestId("notepad-live-banner");
    expect(banner).toHaveTextContent("agent wrote rev 4 · just now");
    expect(screen.getByRole("button", { name: "View diff" })).toBeVisible();
  });

  it("never replaces a dirty buffer; the draft saves as the new head", async () => {
    stubDefaultList();
    const state = stubEditableNotepad("base text");
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    pasteIntoEditor("draft-in-progress ");
    state.content = "agent content";
    state.revision = 4;
    fake.emit("notepad-changed", changedEvent());

    // The collision banner appears with the page-04 copy…
    const banner = await screen.findByTestId("notepad-live-banner");
    expect(banner).toHaveTextContent(
      "agent wrote rev 4 while you were editing.",
    );
    expect(banner).toHaveTextContent(
      "Your draft is untouched and will save as the new head. Rev 4 is already in history.",
    );
    expect(screen.getByRole("button", { name: "Review rev 4" })).toBeVisible();
    // …and the local draft stays exactly as typed, never clobbered.
    const editor = screen.getByTestId("notepad-editor-input");
    expect(editor.textContent).toContain("draft-in-progress");
    expect(editor.textContent).not.toContain("agent content");

    // The next autosave flush lands the draft as the new head (rev 5)…
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );
    const body = api.requestsTo("POST", "/api/notepads/np-a/content")[0]
      ?.jsonBody as { content: string };
    expect(body.content).toContain("draft-in-progress");
    // …and the banner settles into the nothing-lost reassurance.
    await waitFor(() =>
      expect(screen.getByTestId("notepad-live-banner")).toHaveTextContent(
        "Saved as rev 5. Rev 4 (agent) is preserved in history — nothing lost.",
      ),
    );
  });

  it("adopts another session's user write that lands during a slow autosave", async () => {
    stubDefaultList();
    const server = { content: "base text", revision: 3 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ content: server.content, revision: server.revision }),
    }));
    // Our write commits as r4 server-side, but its response is delayed until
    // after the other session's r5 write and both SSE events have arrived.
    let releaseOurPost: (() => void) | undefined;
    api.reply("POST", "/api/notepads/np-a/content", async (req) => {
      await new Promise<void>((resolve) => {
        releaseOurPost = resolve;
      });
      const body = req.jsonBody as { content: string };
      return { json: notepadBody({ content: body.content, revision: 4 }) };
    });
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    pasteIntoEditor("mine ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );

    server.content = "another session wrote this";
    server.revision = 5;
    // Our own write's user-authored echo, then the genuinely external
    // user-authored write — the event stream cannot tell them apart. Flush
    // between the frames so each is observed on its own tick, as on the wire.
    await act(async () => {
      fake.emit(
        "notepad-changed",
        changedEvent({ revision: 4, authorKind: "user" }),
      );
    });
    await act(async () => {
      fake.emit(
        "notepad-changed",
        changedEvent({ revision: 5, authorKind: "user" }),
      );
    });
    releaseOurPost?.();

    // The other session's head appears without a manual refresh…
    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "another session wrote this",
      ),
    );
    // …and the landed-write strip attributes it, echo not mistaken for it.
    expect(screen.getByTestId("notepad-live-banner")).toHaveTextContent(
      "you wrote rev 5 · just now",
    );
  });

  it("reports an agent write that outranks the local save as landed, not preserved", async () => {
    stubDefaultList();
    const server = { content: "base text", revision: 3 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ content: server.content, revision: server.revision }),
    }));
    let releaseOurPost: (() => void) | undefined;
    api.reply("POST", "/api/notepads/np-a/content", async (req) => {
      await new Promise<void>((resolve) => {
        releaseOurPost = resolve;
      });
      const body = req.jsonBody as { content: string };
      return { json: notepadBody({ content: body.content, revision: 4 }) };
    });
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    pasteIntoEditor("mine ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );

    // The agent writes r5 after our r4 committed: r5 is the head, our r4 is
    // the history entry — the banner must not claim the reverse.
    server.content = "agent added a section";
    server.revision = 5;
    fake.emit(
      "notepad-changed",
      changedEvent({ revision: 5, authorKind: "agent" }),
    );
    releaseOurPost?.();

    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "agent added a section",
      ),
    );
    const banner = screen.getByTestId("notepad-live-banner");
    expect(banner).toHaveTextContent("agent wrote rev 5 · just now");
    expect(banner).not.toHaveTextContent("Saved as rev 4");
  });

  it("keeps the newest colliding revision on the banner over an older parked event", async () => {
    stubDefaultList();
    const server = { content: "base text", revision: 3 };
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ content: server.content, revision: server.revision }),
    }));
    let releaseOurPost: (() => void) | undefined;
    api.reply("POST", "/api/notepads/np-a/content", async (req) => {
      await new Promise<void>((resolve) => {
        releaseOurPost = resolve;
      });
      const body = req.jsonBody as { content: string };
      return { json: notepadBody({ content: body.content, revision: 4 }) };
    });
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    pasteIntoEditor("mine ");
    await waitFor(
      () =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-a/content").length,
        ).toBe(1),
      { timeout: 4000 },
    );

    // During our slow r4 save: another session's user write r5 (parked),
    // then an agent write r6 — r6 is the head the editor lands on, so the
    // indicator (and its View diff) must name r6, not the older parked r5.
    // Real SSE frames arrive on separate ticks; flush between them so each
    // event is observed individually rather than conflated by batching.
    server.content = "agent wrote r6";
    server.revision = 6;
    await act(async () => {
      fake.emit(
        "notepad-changed",
        changedEvent({ revision: 5, authorKind: "user" }),
      );
    });
    await act(async () => {
      fake.emit(
        "notepad-changed",
        changedEvent({ revision: 6, authorKind: "agent" }),
      );
    });
    releaseOurPost?.();

    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "agent wrote r6",
      ),
    );
    const banner = screen.getByTestId("notepad-live-banner");
    expect(banner).toHaveTextContent("agent wrote rev 6 · just now");
    expect(banner).not.toHaveTextContent("rev 5");
  });

  it("routes View diff to history with the revision selected versus previous", async () => {
    stubDefaultList();
    const state = stubEditableNotepad("base text");
    api.reply("GET", "/api/notepads/np-a/revisions", () => ({
      json: {
        revisions:
          state.revision >= 4
            ? [
                revisionRow(4, {
                  content: "agent wrote this",
                  authorKind: "agent",
                  authorConversationId: "c9",
                }),
                revisionRow(3, { content: "base text" }),
              ]
            : [revisionRow(3, { content: "base text" })],
      },
    }));
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    state.content = "agent wrote this";
    state.revision = 4;
    fake.emit("notepad-changed", changedEvent());
    await screen.findByTestId("notepad-live-banner");

    await user.click(screen.getByRole("button", { name: "View diff" }));

    // One destination for every diff affordance: history, revision selected,
    // versus-previous shown.
    const history = await screen.findByTestId("notepad-history");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Select revision 4" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByRole("radio", { name: "vs previous" })).toBeChecked();
    await waitFor(() =>
      expect(
        [...history.querySelectorAll("del")].map((el) => el.textContent),
      ).toEqual(["base text"]),
    );
    expect(
      [...history.querySelectorAll("ins")].map((el) => el.textContent),
    ).toEqual(["agent wrote this"]);
  });

  it("dismisses the collision banner without touching the draft", async () => {
    stubDefaultList();
    const state = stubEditableNotepad("base text");
    const { queryClient, fake } = setupLive();
    const user = userEvent.setup();
    renderPanel(true, queryClient);
    await openNotepadRow(user);

    pasteIntoEditor("draft ");
    state.content = "agent content";
    state.revision = 4;
    fake.emit("notepad-changed", changedEvent());
    await screen.findByTestId("notepad-live-banner");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("notepad-live-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
      "draft",
    );
  });
});

describe("NotepadPanel — open view", () => {
  it("opens a notepad into the editor with its preview and returns via back", async () => {
    stubDefaultList();
    api.json("GET", "/api/notepads/np-a", notepadBody());
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    );

    expect(useSessionDetailStore.getState().openNotepadId).toBe("np-a");
    const editor = await screen.findByTestId("notepad-editor-input");
    expect(editor.textContent).toContain("tag the release");
    expect(screen.getByTestId("notepad-preview")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to notepads" }));
    expect(useSessionDetailStore.getState().openNotepadId).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    ).toBeVisible();
  });

  it("changes the agent write mode from the open-view header", async () => {
    stubDefaultList();
    api.json("GET", "/api/notepads/np-a", notepadBody());
    api.json(
      "PATCH",
      "/api/notepads/np-a",
      notepadBody({ writeMode: "append-only" }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    );
    await screen.findByTestId("notepad-editor-input");

    await user.click(
      screen.getByRole("combobox", { name: "Agent write mode" }),
    );
    await user.click(screen.getByRole("option", { name: /append only/i }));

    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a")[0]?.jsonBody,
      ).toEqual({ writeMode: "append-only" }),
    );
  });

  it("renames inline from the open-view header", async () => {
    stubDefaultList();
    let name = "release 0.4 checklist";
    api.reply("GET", "/api/notepads/np-a", () => ({
      json: notepadBody({ name }),
    }));
    api.reply("PATCH", "/api/notepads/np-a", () => {
      name = "cutover notes";
      return { json: notepadBody({ name }) };
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    );
    await screen.findByTestId("notepad-editor-input");

    await user.click(screen.getByRole("button", { name: "Rename notepad" }));
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "cutover notes{Enter}");

    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a")[0]?.jsonBody,
      ).toEqual({ name: "cutover notes" }),
    );
    expect(await screen.findByText("cutover notes")).toBeVisible();
  });
});
