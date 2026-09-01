import { describe, expect, it } from "vitest";

import { resolveCaptureDestination } from "@/lib/notepads/capture-destination";
import type { NotepadListItem } from "@/lib/notepads/schemas";

import {
  ambientProjectFromRoute,
  captureDestinationName,
  quickCaptureResolution,
} from "./quick-capture-context";

function row(over: Partial<NotepadListItem> = {}): NotepadListItem {
  return {
    id: "np-1",
    scope: "project",
    projectPath: "/repos/cc",
    projectName: "cc",
    name: "Field notes",
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
    ...over,
  };
}

const TODAY = "2026-08-31";

describe("ambientProjectFromRoute (D21)", () => {
  it("reads the project out of a project route", () => {
    expect(ambientProjectFromRoute("/projects/cc/session-a", "")).toEqual({
      name: "cc",
    });
  });

  it("is null where no project is in view", () => {
    expect(ambientProjectFromRoute("/conversations", "")).toBeNull();
    expect(ambientProjectFromRoute(null, "")).toBeNull();
  });

  it("reads the ticket filter's project, as the quick-ticket host does", () => {
    expect(ambientProjectFromRoute("/tickets", "project=cc")).toEqual({
      name: "cc",
    });
  });

  it("takes the project of a conversation registered on a project-less route", () => {
    // The quick-ticket host resolves /conversations?c=… through the same
    // registry; a capture raised from that screen must not fall to global.
    expect(
      ambientProjectFromRoute("/conversations", "c=conv-1", [
        {
          token: "t1",
          projectName: "cc",
          sessionName: "notepad-slice",
          conversationId: "conv-1",
          title: "Notepad slice 3",
        },
      ]),
    ).toEqual({ name: "cc" });
  });

  it("ignores a registration the route contradicts", () => {
    expect(
      ambientProjectFromRoute("/projects/other-project", "", [
        {
          token: "t1",
          projectName: "cc",
          sessionName: null,
          conversationId: "conv-1",
          title: "Notepad slice 3",
        },
      ]),
    ).toEqual({ name: "other-project" });
  });
});

describe("quickCaptureResolution (D21)", () => {
  it("honours the open notepad while the listing still holds it", () => {
    const resolution = quickCaptureResolution({
      ambientProject: { name: "cc" },
      openNotepadId: "np-open",
      listing: [row({ id: "np-open" }), row({ id: "np-other" })],
      today: TODAY,
    });

    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "existing",
      id: "np-open",
    });
  });

  it("drops an open notepad the listing no longer has, so landing re-resolves", () => {
    const resolution = quickCaptureResolution({
      ambientProject: { name: "cc" },
      openNotepadId: "np-deleted",
      listing: [row({ id: "np-recent" })],
      today: TODAY,
    });

    expect(resolution.openNotepad).toBeNull();
    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "existing",
      id: "np-recent",
    });
  });

  it("drops an open notepad that has been archived", () => {
    const resolution = quickCaptureResolution({
      ambientProject: { name: "cc" },
      openNotepadId: "np-open",
      listing: [row({ id: "np-open", archived: true }), row({ id: "np-live" })],
      today: TODAY,
    });

    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "existing",
      id: "np-live",
    });
  });

  it("counts only the destination scope's names as taken", () => {
    const resolution = quickCaptureResolution({
      ambientProject: { name: "cc" },
      openNotepadId: null,
      listing: [
        row({
          id: "np-global",
          scope: "global",
          projectPath: null,
          projectName: null,
          name: "Inbox",
          archived: true,
        }),
      ],
      today: TODAY,
    });

    // A global notepad called Inbox does not force the project scope to suffix.
    expect(resolution.takenNames).toEqual([]);
    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "create",
      scope: "project",
      projectName: "cc",
      name: "Inbox",
    });
  });

  it("counts an archived same-scope name as taken", () => {
    const resolution = quickCaptureResolution({
      ambientProject: { name: "cc" },
      openNotepadId: null,
      listing: [row({ id: "np-old", name: "Inbox", archived: true })],
      today: TODAY,
    });

    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "create",
      scope: "project",
      projectName: "cc",
      name: `Inbox (${TODAY})`,
    });
  });

  it("resolves over global notepads with no ambient project", () => {
    const resolution = quickCaptureResolution({
      ambientProject: null,
      openNotepadId: null,
      listing: [
        row({ id: "np-project" }),
        row({
          id: "np-global",
          scope: "global",
          projectPath: null,
          projectName: null,
          name: "Scratch",
        }),
      ],
      today: TODAY,
    });

    expect(resolveCaptureDestination(resolution)).toEqual({
      kind: "existing",
      id: "np-global",
    });
  });
});

describe("captureDestinationName", () => {
  it("names an existing destination from the listing row", () => {
    expect(
      captureDestinationName({ kind: "existing", id: "np-1" }, [
        row({ id: "np-1", name: "Field notes" }),
      ]),
    ).toBe("Field notes");
  });

  it("names a destination that will be created", () => {
    expect(
      captureDestinationName(
        { kind: "create", scope: "global", projectName: null, name: "Inbox" },
        [],
      ),
    ).toBe("Inbox");
  });

  it("returns null rather than inventing a label it does not hold", () => {
    expect(
      captureDestinationName({ kind: "existing", id: "np-x" }, []),
    ).toBeNull();
  });
});
