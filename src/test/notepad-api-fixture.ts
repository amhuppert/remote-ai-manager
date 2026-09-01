/**
 * An in-memory notepad API for client tests, served through the fetch fixture.
 *
 * Capture behaviour turns on what the server holds *now* — a destination that
 * was deleted while the user was talking, a notepad another writer advanced
 * before undo was clicked, a listing whose recency order moved. Static route
 * replies cannot express any of that: they answer the same thing before and
 * after a write. This double keeps one mutable set of notepads, serves reads
 * from it, applies content writes to it, and lets a test act as that other
 * writer between two requests.
 */

import type { Notepad, NotepadListItem } from "@/lib/notepads/schemas";

import type { FetchFixture } from "./fetch-fixture";

export interface NotepadApiFixture {
  /** Seed a notepad, or overwrite one — the "other writer" in a race. */
  put(notepad: Partial<Notepad> & { id: string }): Notepad;
  /** Delete a notepad, as another surface would. */
  remove(notepadId: string): void;
  read(notepadId: string): Notepad | undefined;
  /** Notepads in the order the server would list them: recency, newest first. */
  list(): NotepadListItem[];
}

const BASE: Omit<Notepad, "id"> = {
  scope: "project",
  projectPath: "/repos/command-center",
  name: "Field notes",
  content: "",
  revision: 1,
  writeMode: "full-edit",
  pinned: false,
  archived: false,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-31T10:00:00.000Z",
};

function projectNameOf(notepad: Notepad): string | null {
  if (notepad.scope === "global") return null;
  const segments = (notepad.projectPath ?? "").split("/");
  return segments[segments.length - 1] ?? null;
}

function toListItem(notepad: Notepad): NotepadListItem {
  const { content: _content, ...rest } = notepad;
  return { ...rest, projectName: projectNameOf(notepad) };
}

/**
 * Serves the notepad reads and content writes a capture makes. Register it
 * before any test-specific route that must win — the fixture resolves the last
 * matching registration.
 */
export function installNotepadApi(
  api: FetchFixture,
  seed: readonly (Partial<Notepad> & { id: string })[] = [],
): NotepadApiFixture {
  const notepads = new Map<string, Notepad>();
  let clock = 0;

  /** Each write is newer than the last, so recency ordering is observable. */
  const nextWriteTime = (): string => {
    clock += 1;
    return `2026-08-31T11:00:${String(clock).padStart(2, "0")}.000Z`;
  };

  const fixture: NotepadApiFixture = {
    put(partial) {
      const existing = notepads.get(partial.id);
      const next: Notepad = { ...BASE, ...existing, ...partial };
      notepads.set(next.id, next);
      return next;
    },
    remove(notepadId) {
      notepads.delete(notepadId);
    },
    read(notepadId) {
      return notepads.get(notepadId);
    },
    list() {
      return [...notepads.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toListItem);
    },
  };

  for (const notepad of seed) fixture.put(notepad);

  api.reply("GET", "/api/notepads", (request) => {
    const project = request.searchParams.get("project");
    const scope = request.searchParams.get("scope");
    const includeArchived = request.searchParams.get("archived") === "true";
    return {
      json: {
        notepads: fixture.list().filter((row) => {
          if (!includeArchived && row.archived) return false;
          if (scope === "global") return row.scope === "global";
          if (project === null) return true;
          return row.scope === "global" || row.projectName === project;
        }),
      },
    };
  });

  api.reply("GET", /^\/api\/notepads\/[^/]+$/, (request) => {
    const notepad = notepads.get(request.pathname.split("/")[3] ?? "");
    return notepad === undefined
      ? { status: 404, json: { error: "Notepad not found" } }
      : { json: { notepad } };
  });

  api.reply("POST", "/api/notepads", (request) => {
    const body = request.jsonBody as {
      scope: "global" | "project";
      project?: string;
      name: string;
    };
    const created = fixture.put({
      id: `np-created-${notepads.size + 1}`,
      scope: body.scope,
      projectPath: body.project === undefined ? null : `/repos/${body.project}`,
      name: body.name,
      content: "",
      revision: 1,
    });
    return { json: { notepad: created } };
  });

  api.reply("POST", /^\/api\/notepads\/[^/]+\/content$/, (request) => {
    const id = request.pathname.split("/")[3] ?? "";
    const notepad = notepads.get(id);
    if (notepad === undefined) {
      return { status: 404, json: { error: "Notepad not found" } };
    }
    const body = request.jsonBody as { operation: string; content: string };
    const content =
      body.operation === "append"
        ? notepad.content === ""
          ? body.content
          : `${notepad.content}\n\n${body.content}`
        : body.content;
    return {
      json: {
        notepad: fixture.put({
          id,
          content,
          revision: notepad.revision + 1,
          updatedAt: nextWriteTime(),
        }),
      },
    };
  });

  return fixture;
}
