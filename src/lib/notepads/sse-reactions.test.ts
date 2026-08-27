/**
 * The consumer half of the notepad live-update contract: a committed notepad
 * change must reach exactly the caches that show it — the affected project's
 * lists, the chip summary, and the open detail when the head advances — and
 * must surface head-advancing writes to the open-editor signal.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import type { NotepadSummaryResolution } from "./queries";
import { notepadKeys } from "./query-keys";
import type { Notepad, NotepadChangedEvent, NotepadListItem } from "./schemas";
import { registerNotepadSseReactions } from "./sse-reactions";

function listItem(overrides: Partial<NotepadListItem> = {}): NotepadListItem {
  return {
    id: "np-a",
    scope: "project",
    projectPath: "/repos/p1",
    projectName: "p1",
    name: "release 0.4 checklist",
    revision: 4,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
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
    listItem: listItem(),
    ...overrides,
  };
}

function detailData(overrides: Partial<Notepad> = {}): Notepad {
  return {
    id: "np-a",
    scope: "project",
    projectPath: "/repos/p1",
    name: "release 0.4 checklist",
    content: "# checklist",
    revision: 3,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const FOUND_SUMMARY: NotepadSummaryResolution = {
  state: "found",
  summary: {
    id: "np-a",
    name: "release 0.4 checklist",
    scope: "project",
    revision: 3,
    writeMode: "full-edit",
    archived: false,
  },
};

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const recordNotepadExternalWrite = vi.fn();
  registerNotepadSseReactions(fake as unknown as EventSource, {
    queryClient,
    recordNotepadExternalWrite,
  });
  return { fake, queryClient, recordNotepadExternalWrite };
}

describe("registerNotepadSseReactions — list caches", () => {
  it("invalidates only the owning project's lists for a project-scoped change", () => {
    const { fake, queryClient } = setup();
    const p1Key = notepadKeys.panelList("p1", "recency", false);
    const p2Key = notepadKeys.panelList("p2", "recency", false);
    const p1Picker = notepadKeys.pickerList("p1");
    queryClient.setQueryData(p1Key, []);
    queryClient.setQueryData(p2Key, []);
    queryClient.setQueryData(p1Picker, []);

    fake.emit("notepad-changed", changedEvent());

    expect(queryClient.getQueryState(p1Key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(p1Picker)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(p2Key)?.isInvalidated).toBe(false);
  });

  it("invalidates every project's lists for a global-scoped change", () => {
    const { fake, queryClient } = setup();
    const p1Key = notepadKeys.panelList("p1", "recency", false);
    const p2Key = notepadKeys.panelList("p2", "name", true);
    queryClient.setQueryData(p1Key, []);
    queryClient.setQueryData(p2Key, []);

    fake.emit(
      "notepad-changed",
      changedEvent({
        notepadId: "np-g",
        scope: "global",
        projectPath: null,
        listItem: listItem({
          id: "np-g",
          scope: "global",
          projectPath: null,
          projectName: null,
        }),
      }),
    );

    expect(queryClient.getQueryState(p1Key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(p2Key)?.isInvalidated).toBe(true);
  });
});

describe("registerNotepadSseReactions — summary cache", () => {
  it("patches an existing chip summary from the event's list item", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(notepadKeys.summary("np-a"), FOUND_SUMMARY);

    fake.emit(
      "notepad-changed",
      changedEvent({
        change: "organized",
        revision: null,
        authorKind: null,
        listItem: listItem({ name: "cutover notes", revision: 3 }),
      }),
    );

    expect(
      queryClient.getQueryData<NotepadSummaryResolution>(
        notepadKeys.summary("np-a"),
      ),
    ).toEqual({
      state: "found",
      summary: { ...FOUND_SUMMARY.summary, name: "cutover notes" },
    });
  });

  it("does not seed a summary cache no chip has asked for", () => {
    const { fake, queryClient } = setup();

    fake.emit("notepad-changed", changedEvent());

    expect(
      queryClient.getQueryData(notepadKeys.summary("np-a")),
    ).toBeUndefined();
  });

  it("flips an existing summary to missing when the notepad is deleted", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(notepadKeys.summary("np-a"), FOUND_SUMMARY);

    fake.emit(
      "notepad-changed",
      changedEvent({
        change: "deleted",
        revision: null,
        authorKind: null,
        listItem: null,
      }),
    );

    expect(
      queryClient.getQueryData<NotepadSummaryResolution>(
        notepadKeys.summary("np-a"),
      ),
    ).toEqual({ state: "missing" });
  });
});

describe("registerNotepadSseReactions — detail cache", () => {
  it("invalidates the detail (and its revisions) when the head advances", () => {
    const { fake, queryClient } = setup();
    const detailKey = notepadKeys.detail("np-a");
    const revisionsKey = notepadKeys.revisions("np-a");
    queryClient.setQueryData(detailKey, detailData());
    queryClient.setQueryData(revisionsKey, []);

    fake.emit("notepad-changed", changedEvent());

    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(revisionsKey)?.isInvalidated).toBe(true);
  });

  it("patches detail metadata in place for an organize change, without refetch", () => {
    const { fake, queryClient } = setup();
    const detailKey = notepadKeys.detail("np-a");
    queryClient.setQueryData(detailKey, detailData());

    fake.emit(
      "notepad-changed",
      changedEvent({
        change: "organized",
        revision: null,
        authorKind: null,
        listItem: listItem({
          name: "cutover notes",
          writeMode: "append-only",
          revision: 3,
        }),
      }),
    );

    const detail = queryClient.getQueryData<Notepad>(detailKey);
    expect(detail?.name).toBe("cutover notes");
    expect(detail?.writeMode).toBe("append-only");
    // Content and revision advance only via refetch — never from a list item.
    expect(detail?.content).toBe("# checklist");
    expect(detail?.revision).toBe(3);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(false);
  });

  it("removes the detail cache when the notepad is deleted", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(notepadKeys.detail("np-a"), detailData());

    fake.emit(
      "notepad-changed",
      changedEvent({
        change: "deleted",
        revision: null,
        authorKind: null,
        listItem: null,
      }),
    );

    expect(
      queryClient.getQueryData(notepadKeys.detail("np-a")),
    ).toBeUndefined();
  });
});

describe("registerNotepadSseReactions — open-editor signal", () => {
  it("records a head-advancing write with its author attribution", () => {
    const { fake, recordNotepadExternalWrite } = setup();

    fake.emit("notepad-changed", changedEvent());

    expect(recordNotepadExternalWrite).toHaveBeenCalledWith({
      notepadId: "np-a",
      revision: 4,
      authorKind: "agent",
    });
  });

  it("does not record organize changes that move no content", () => {
    const { fake, recordNotepadExternalWrite } = setup();

    fake.emit(
      "notepad-changed",
      changedEvent({
        change: "organized",
        revision: null,
        authorKind: null,
        listItem: listItem({ revision: 3, pinned: true }),
      }),
    );

    expect(recordNotepadExternalWrite).not.toHaveBeenCalled();
  });

  it("drops a frame that does not match the typed event", () => {
    const { fake, queryClient, recordNotepadExternalWrite } = setup();
    const p1Key = notepadKeys.panelList("p1", "recency", false);
    queryClient.setQueryData(p1Key, []);

    // `content` never rides the change frame; a widened frame is a contract
    // violation the strict schema refuses rather than tolerated drift.
    fake.emit("notepad-changed", {
      ...changedEvent(),
      content: "smuggled",
    });

    expect(recordNotepadExternalWrite).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(p1Key)?.isInvalidated).toBe(false);
  });
});
