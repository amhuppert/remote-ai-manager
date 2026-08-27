// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { renderWithQuery } from "@/test/component-mocks";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import type { NotepadListItem, NotepadRevision } from "@/lib/notepads/schemas";
import MobileNotepadPanel from "./MobileNotepadPanel";

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
const LOCKED_ROW = listItem({
  id: "np-a",
  name: "release 0.4 checklist",
  writeMode: "read-only",
});
const GLOBAL_ROW = listItem({
  id: "np-g",
  scope: "global",
  projectPath: null,
  projectName: null,
  name: "cctl cheatsheet",
});
const ARCHIVED_ROW = listItem({
  id: "np-arch",
  name: "old scratch",
  archived: true,
});

const DEFAULT_ROWS = [PINNED, LOCKED_ROW, GLOBAL_ROW, ARCHIVED_ROW];

// The mobile browse always fetches with archived included: the collapsed
// Archived row shows its count before the section is expanded.
function stubList(rows: NotepadListItem[] = DEFAULT_ROWS) {
  api.reply("GET", /^\/api\/notepads\?project=p1&sort=recency&archived=true$/, {
    json: { notepads: rows },
  });
}

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

function renderPanel() {
  return renderWithQuery(<MobileNotepadPanel projectName="p1" />);
}

describe("MobileNotepadPanel — browse", () => {
  it("lists notepads pinned-first with 44px-class touch rows", async () => {
    stubList();
    renderPanel();

    expect(await screen.findByText("Pinned")).toBeVisible();
    const rows = screen.getAllByRole("button", { name: /^Open notepad / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open notepad slice-1 working context",
      "Open notepad release 0.4 checklist",
      "Open notepad cctl cheatsheet",
    ]);
    for (const row of rows) {
      expect(row.className).toContain("min-h-[48px]");
    }
  });

  it("marks rows with scope glyphs: page for project, globe for global", async () => {
    stubList();
    renderPanel();
    await screen.findByText("Pinned");

    // Pinned + locked rows are project-scoped; the cheatsheet is global.
    expect(screen.getAllByRole("img", { name: "Project scope" })).toHaveLength(
      2,
    );
    const globe = screen.getByRole("img", { name: "Global scope" });
    expect(
      screen
        .getByRole("button", { name: "Open notepad cctl cheatsheet" })
        .contains(globe),
    ).toBe(true);
  });

  it("shows a lock glyph only on rows with a non-default agent write mode", async () => {
    stubList();
    renderPanel();
    await screen.findByText("Pinned");

    const lock = screen.getByRole("img", { name: "agents: read only" });
    expect(
      screen
        .getByRole("button", { name: "Open notepad release 0.4 checklist" })
        .contains(lock),
    ).toBe(true);
    // The full-edit default carries no lock.
    expect(
      screen.queryByRole("img", { name: "agents: full edit" }),
    ).not.toBeInTheDocument();
  });

  it("collapses archived notepads behind a counted row and expands on tap", async () => {
    stubList();
    renderPanel();
    await screen.findByText("Pinned");

    expect(screen.queryByText("old scratch")).not.toBeInTheDocument();
    const archivedToggle = screen.getByRole("button", { name: "Archived 1" });
    expect(archivedToggle.getAttribute("aria-expanded")).toBe("false");

    const user = userEvent.setup();
    await user.click(archivedToggle);

    expect(
      await screen.findByRole("button", { name: "Open notepad old scratch" }),
    ).toBeVisible();
    expect(archivedToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("creates a project notepad and opens it", async () => {
    stubList();
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

  it("opens a notepad from its row", async () => {
    stubList();
    api.json("GET", "/api/notepads/np-a", notepadBody());
    api.json("GET", /\/api\/notepads\/np-a\/revisions/, { revisions: [] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Pinned");

    await user.click(
      screen.getByRole("button", {
        name: "Open notepad release 0.4 checklist",
      }),
    );

    expect(useSessionDetailStore.getState().openNotepadId).toBe("np-a");
    expect(
      await screen.findByRole("button", { name: "Back to notepads" }),
    ).toBeVisible();
  });
});

function revision(overrides: Partial<NotepadRevision>): NotepadRevision {
  return {
    id: "rev-3",
    notepadId: "np-a",
    revision: 3,
    content: "",
    authorKind: "user",
    authorConversationId: null,
    origin: "edit",
    baseRevision: 2,
    restoredFromRevision: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const REF_XML = buildNotepadRefXml({
  notepadId: "np-7f3a",
  name: "Release checklist",
  scope: "project",
  projectName: "p1",
});

const READ_CONTENT = [
  "# checklist",
  "",
  `- review ${REF_XML} today`,
  "",
  "[Image: img-42]",
].join("\n");

function openReadView(
  overrides: Record<string, unknown> = {},
  revisions: NotepadRevision[] = [revision({})],
) {
  stubList();
  api.json(
    "GET",
    "/api/notepads/np-a",
    notepadBody({ content: READ_CONTENT, ...overrides }),
  );
  api.json("GET", /\/api\/notepads\/np-a\/revisions/, { revisions });
  useSessionDetailStore.getState().openNotepad("np-a");
  return renderPanel();
}

describe("MobileNotepadPanel — reading view", () => {
  it("renders the notepad through the preview pipeline: structure, chips, images", async () => {
    openReadView();

    expect(
      await screen.findByRole("heading", { level: 1, name: "checklist" }),
    ).toBeVisible();
    const chip = await screen.findByTestId("notepad-preview-chip");
    expect(chip.getAttribute("data-ref-kind")).toBe("notepad-ref");
    const image = await screen.findByTestId("notepad-preview-image");
    expect(image.getAttribute("src")).toBe("/api/notepads/np-a/images/img-42");
  });

  it("shows identity, scope, and the revision/author meta line", async () => {
    openReadView();

    await screen.findByRole("button", { name: "Back to notepads" });
    // Header name + scope pill (frame B).
    expect(screen.getByText("release 0.4 checklist")).toBeVisible();
    expect(screen.getByText("project")).toBeVisible();
    expect(screen.getByText(/rev 3 · you ·/)).toBeVisible();
  });

  it("attributes an agent-authored head revision in the meta line", async () => {
    openReadView({}, [revision({ authorKind: "agent" })]);

    expect(await screen.findByText(/rev 3 · agent ·/)).toBeVisible();
  });

  it("changes the agent write mode through the bottom sheet and persists it", async () => {
    openReadView();
    api.json(
      "GET",
      "/api/notepads/np-a",
      notepadBody({ content: READ_CONTENT, writeMode: "read-only" }),
    );
    api.json(
      "PATCH",
      "/api/notepads/np-a",
      notepadBody({ content: READ_CONTENT, writeMode: "read-only" }).notepad,
    );
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "agents: full edit" }),
    );

    // The sheet carries the same copy as the desktop menu.
    const sheet = await screen.findByRole("dialog", {
      name: "Agent write mode",
    });
    expect(sheet).toBeVisible();
    expect(screen.getByText("agents can read, never write")).toBeVisible();
    expect(
      screen.getByText("agents add to the end, never rewrite"),
    ).toBeVisible();
    expect(
      screen.getByText("agents edit anywhere · history covers restores"),
    ).toBeVisible();
    expect(
      screen.getByText("governs agents only — you can always edit"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^read only/ }));

    await waitFor(() => {
      const patched = api.requestsTo("PATCH", "/api/notepads/np-a")[0];
      expect(patched?.jsonBody).toEqual({ writeMode: "read-only" });
    });
    // Selection applies immediately; the sheet dismisses.
    expect(
      screen.queryByRole("dialog", { name: "Agent write mode" }),
    ).not.toBeInTheDocument();
  });

  it("cancels the sheet without writing", async () => {
    openReadView();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "agents: full edit" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: "Agent write mode" }),
    ).not.toBeInTheDocument();
    expect(api.requestsTo("PATCH", "/api/notepads/np-a")).toHaveLength(0);
  });

  it("offers no content-editing affordance and states the read-first hint", async () => {
    const { container } = openReadView();

    await screen.findByRole("heading", { level: 1, name: "checklist" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(
      screen.getByText("reading view — editing lives on desktop this slice"),
    ).toBeVisible();
  });

  it("returns to the browse list from the back control", async () => {
    openReadView();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Back to notepads" }),
    );

    expect(useSessionDetailStore.getState().openNotepadId).toBeNull();
    expect(await screen.findByText("Pinned")).toBeVisible();
  });
});

describe("MobileNotepadPanel — deleted notepad", () => {
  it("shows a missing state with a way back instead of erroring", async () => {
    stubList();
    api.reply("GET", "/api/notepads/np-gone", {
      status: 404,
      json: { error: "notepad np-gone not found" },
    });
    api.json("GET", /\/api\/notepads\/np-gone\/revisions/, { revisions: [] });
    useSessionDetailStore.getState().openNotepad("np-gone");
    renderPanel();

    expect(await screen.findByText("Notepad not found")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back to notepads" }));
    expect(await screen.findByText("Pinned")).toBeVisible();
  });
});
