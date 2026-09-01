import { describe, expect, it } from "vitest";

import {
  CAPTURE_INBOX_NAME,
  resolveCaptureDestination,
  type CaptureDestinationInput,
} from "./capture-destination";
import type { NotepadListItem } from "./schemas";

const TODAY = "2026-08-31";

function listItem(overrides: Partial<NotepadListItem> & { id: string }) {
  const scope = overrides.scope ?? "project";
  return {
    scope,
    projectPath: scope === "project" ? "/repos/command-center" : null,
    projectName: scope === "project" ? "command-center" : null,
    name: `Notepad ${overrides.id}`,
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } satisfies NotepadListItem;
}

function resolve(overrides: Partial<CaptureDestinationInput> = {}) {
  return resolveCaptureDestination({
    openNotepad: null,
    candidates: [],
    ambientProject: { name: "command-center" },
    today: TODAY,
    ...overrides,
  });
}

describe("resolveCaptureDestination — tier order (R23.1)", () => {
  it("lands in the open right-pane notepad, whatever the listing says", () => {
    expect(
      resolve({
        openNotepad: { id: "np-open" },
        candidates: [
          listItem({ id: "np-recent", updatedAt: "2026-08-30T12:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-open" });
  });

  it("falls back to the ambient project's most recently updated notepad", () => {
    expect(
      resolve({
        candidates: [
          listItem({ id: "np-older", updatedAt: "2026-08-20T09:00:00Z" }),
          listItem({ id: "np-newest", updatedAt: "2026-08-30T18:00:00Z" }),
          listItem({ id: "np-middle", updatedAt: "2026-08-25T09:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-newest" });
  });

  it("creates a project Inbox when the project has no eligible notepad", () => {
    expect(resolve({ candidates: [] })).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: CAPTURE_INBOX_NAME,
    });
  });

  it("never lands in an archived notepad, however recent", () => {
    expect(
      resolve({
        candidates: [
          listItem({
            id: "np-archived",
            archived: true,
            updatedAt: "2026-08-31T08:00:00Z",
          }),
          listItem({ id: "np-live", updatedAt: "2026-08-10T08:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-live" });
  });

  it("creates rather than reusing when every candidate is archived", () => {
    expect(
      resolve({
        candidates: [
          listItem({
            id: "np-archived",
            archived: true,
            updatedAt: "2026-08-31T08:00:00Z",
          }),
        ],
      }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: CAPTURE_INBOX_NAME,
    });
  });

  it("ignores another project's notepads", () => {
    expect(
      resolve({
        candidates: [
          listItem({
            id: "np-other-project",
            projectName: "other-app",
            projectPath: "/repos/other-app",
            updatedAt: "2026-08-31T08:00:00Z",
          }),
          listItem({ id: "np-ours", updatedAt: "2026-08-10T08:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-ours" });
  });

  it("ignores global notepads while a project is ambient", () => {
    expect(
      resolve({
        candidates: [
          listItem({
            id: "np-global",
            scope: "global",
            updatedAt: "2026-08-31T08:00:00Z",
          }),
          listItem({ id: "np-project", updatedAt: "2026-08-10T08:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-project" });
  });
});

describe("resolveCaptureDestination — pinning does not participate (D21)", () => {
  it("prefers the recently updated unpinned notepad over a stale pinned one", () => {
    expect(
      resolve({
        // Server listings order pinned-first; recency alone decides here.
        candidates: [
          listItem({
            id: "np-pinned-stale",
            pinned: true,
            updatedAt: "2026-07-01T08:00:00Z",
          }),
          listItem({ id: "np-fresh", updatedAt: "2026-08-30T08:00:00Z" }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-fresh" });
  });
});

describe("resolveCaptureDestination — name collision (R23.1)", () => {
  it("date-suffixes the new notepad when an archived one holds the name", () => {
    expect(
      resolve({ candidates: [], takenNames: [CAPTURE_INBOX_NAME] }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: `${CAPTURE_INBOX_NAME} (${TODAY})`,
    });
  });

  it("keeps the plain name when the taken names do not collide", () => {
    expect(
      resolve({ candidates: [], takenNames: ["Scratch", "inbox"] }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: CAPTURE_INBOX_NAME,
    });
  });
});

describe("resolveCaptureDestination — a promised name (D21, R25.1)", () => {
  it("appends to the notepad that took the promised name mid-capture", () => {
    expect(
      resolve({
        promisedName: CAPTURE_INBOX_NAME,
        candidates: [
          listItem({ id: "np-took-the-name", name: CAPTURE_INBOX_NAME }),
        ],
        takenNames: [CAPTURE_INBOX_NAME],
      }),
    ).toEqual({ kind: "existing", id: "np-took-the-name" });
  });

  it("creates the promised name rather than a notepad that became more recent", () => {
    expect(
      resolve({
        promisedName: CAPTURE_INBOX_NAME,
        candidates: [
          listItem({
            id: "np-newer",
            name: "Newer notes",
            updatedAt: "2026-08-31T23:00:00Z",
          }),
        ],
        takenNames: ["Newer notes"],
      }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: CAPTURE_INBOX_NAME,
    });
  });

  it("suffixes only when an archived notepad in scope holds the promised name", () => {
    expect(
      resolve({
        promisedName: CAPTURE_INBOX_NAME,
        candidates: [
          listItem({
            id: "np-archived-inbox",
            name: CAPTURE_INBOX_NAME,
            archived: true,
          }),
        ],
        takenNames: [CAPTURE_INBOX_NAME],
      }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: `${CAPTURE_INBOX_NAME} (${TODAY})`,
    });
  });

  it("creates a promised name that is already suffixed, exactly as promised", () => {
    // The promise was made against an archived Inbox that has since gone; the
    // name the pill showed is still the name the capture lands under.
    expect(
      resolve({
        promisedName: `${CAPTURE_INBOX_NAME} (${TODAY})`,
        candidates: [],
        takenNames: [],
      }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: `${CAPTURE_INBOX_NAME} (${TODAY})`,
    });
  });

  it("ignores another scope's holder of the promised name", () => {
    expect(
      resolve({
        promisedName: CAPTURE_INBOX_NAME,
        candidates: [
          listItem({
            id: "np-global-inbox",
            scope: "global",
            name: CAPTURE_INBOX_NAME,
          }),
        ],
        takenNames: [],
      }),
    ).toEqual({
      kind: "create",
      scope: "project",
      projectName: "command-center",
      name: CAPTURE_INBOX_NAME,
    });
  });
});

describe("resolveCaptureDestination — global fallback (R23.2)", () => {
  it("runs the recency tier over global notepads with no ambient project", () => {
    expect(
      resolve({
        ambientProject: null,
        candidates: [
          listItem({
            id: "np-project",
            updatedAt: "2026-08-31T08:00:00Z",
          }),
          listItem({
            id: "np-global-old",
            scope: "global",
            updatedAt: "2026-07-01T08:00:00Z",
          }),
          listItem({
            id: "np-global-new",
            scope: "global",
            updatedAt: "2026-08-20T08:00:00Z",
          }),
        ],
      }),
    ).toEqual({ kind: "existing", id: "np-global-new" });
  });

  it("creates a global Inbox rather than refusing outside any project", () => {
    expect(resolve({ ambientProject: null, candidates: [] })).toEqual({
      kind: "create",
      scope: "global",
      projectName: null,
      name: CAPTURE_INBOX_NAME,
    });
  });

  it("still honours the open notepad outside any project context", () => {
    expect(
      resolve({ ambientProject: null, openNotepad: { id: "np-open" } }),
    ).toEqual({ kind: "existing", id: "np-open" });
  });
});
