// @vitest-environment jsdom
import React, { createRef } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NotepadEditor,
  type NotepadEditorHandle,
} from "@/components/notepad/NotepadEditor";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  installFetchFixture,
  type FetchFixture,
  type RecordedRequest,
  type RouteReply,
} from "@/test/fetch-fixture";
import { createTestQueryClient } from "@/test/component-mocks";

import { CAPTURE_INBOX_NAME } from "./capture-destination";
import { buildClipFragment } from "./capture-fragment";
import {
  useLandCaptureMutation,
  type LandCaptureVariables,
} from "./capture-landing";
import { useAppendNotepadContentMutation } from "./mutations";
import { useNotepadPanelListQuery } from "./queries";
import type { Notepad, NotepadListItem, UpdateNotepadInput } from "./schemas";
import {
  createNotepadsRouteHandlers,
  type NotepadsRouteHandlers,
  type RouteContext,
} from "./route-handlers";
import { createNotepadService, type NotepadService } from "./service";

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

const PROJECT_NAME = "p1";
const PROJECT_PATH = "/repos/p1";

/**
 * The clip a capture surface would hand the landing path: a real fragment, with
 * path provenance so the parity comparison is about composition alone and no
 * chip reaches for the network.
 */
const FRAGMENT = buildClipFragment({
  text: "The destination is shown before content lands.",
  isCode: false,
  provenance: { kind: "path", path: "docs/tailwind-conventions.md" },
});

/** Stands in only for the token FILE the real auth reads; a browser capture
 * sends no bearer token, so every request resolves as the user. */
const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken(request) {
    return request.headers.get("authorization") === null
      ? { kind: "absent" }
      : { kind: "invalid" };
  },
};

let fixture: PersistenceFixture;
let service: NotepadService;
let handlers: NotepadsRouteHandlers;
let api: FetchFixture;
let queryClient: QueryClient;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  let clock = 0;
  let idSeq = 0;
  service = createNotepadService({
    repo: createNotepadsRepo(fixture.db, writeQueue),
    comments: createNotepadCommentsRepo(fixture.db, writeQueue),
    publish: () => ({ delivered: true }),
    deleteNotepadContent: async () => {},
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 31, 9, 0, 0) + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `np-gen-${idSeq}`;
    },
  });
  handlers = createNotepadsRouteHandlers({
    getService: () => service,
    resolveProjectPath: async (projectName) =>
      projectName === PROJECT_NAME ? PROJECT_PATH : null,
    auth,
  });

  api = installFetchFixture();
  api.reply("GET", /^\/api\/notepads\?/, delegate(handlers.listGET));
  api.reply("POST", "/api/notepads", delegate(handlers.createPOST));
  api.reply("GET", /^\/api\/notepads\/[^/]+$/, delegate(handlers.detailGET));
  api.reply(
    "POST",
    /^\/api\/notepads\/[^/]+\/content$/,
    delegate(handlers.contentPOST),
  );

  queryClient = createTestQueryClient();
});

afterEach(() => {
  api.restore();
  cleanup();
  fixture.close();
});

/** Carries a fixture-recorded request into a real route handler verbatim. */
function delegate(
  handler: (request: Request, context: RouteContext) => Promise<Response>,
): (req: RecordedRequest) => Promise<RouteReply> {
  return async (req) => {
    const query =
      req.searchParams.size > 0 ? `?${req.searchParams.toString()}` : "";
    const request = new Request(`http://localhost${req.pathname}${query}`, {
      method: req.method,
      ...(req.jsonBody === null
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(req.jsonBody),
          }),
    });
    const notepadId = decodeURIComponent(req.pathname.split("/")[3] ?? "");
    const params: Record<string, string> =
      notepadId === "" ? {} : { notepadId };
    const response = await handler(request, {
      params: Promise.resolve(params),
    });
    return { status: response.status, json: await response.json() };
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

async function seedNotepad(name: string, content: string): Promise<string> {
  const created = await service.create({
    scope: "project",
    projectPath: PROJECT_PATH,
    name,
    content,
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error.code}`);
  return created.value.id;
}

/** The persisted canonical text, read back through the repository. */
async function persistedContent(notepadId: string): Promise<string> {
  const read = await service.get(notepadId);
  if (!read.ok) throw new Error(`read failed: ${read.error.code}`);
  return read.value.content;
}

/** Seeding-time organization change, through the production service. */
async function organize(
  notepadId: string,
  fields: UpdateNotepadInput,
): Promise<void> {
  const updated = await service.update(notepadId, fields, { kind: "user" });
  if (!updated.ok) throw new Error(`organize failed: ${updated.error.code}`);
}

/**
 * The candidate rows a capture surface would already hold: the real listing
 * from the real route, server-ordered pinned-first.
 */
async function listThroughQuery(
  includeArchived = false,
): Promise<NotepadListItem[]> {
  const { result } = renderHook(
    () => useNotepadPanelListQuery(PROJECT_NAME, "recency", includeArchived),
    { wrapper: Wrapper },
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  return result.current.data ?? [];
}

function handleOf<T>(ref: React.RefObject<T | null>): T {
  const handle = ref.current;
  if (handle === null) throw new Error("editor handle was never attached");
  return handle;
}

describe("append through the content route (R22.1, R23.1)", () => {
  it("posts operation append and grows the persisted content", async () => {
    const notepadId = await seedNotepad("Inbox", "Existing content.");
    const { result } = renderHook(() => useAppendNotepadContentMutation(), {
      wrapper: Wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ notepadId, content: FRAGMENT });
    });

    expect(
      api.requestsTo("POST", `/api/notepads/${notepadId}/content`)[0]?.jsonBody,
    ).toEqual({ operation: "append", content: FRAGMENT });
    expect(await persistedContent(notepadId)).toBe(
      `Existing content.\n\n${FRAGMENT}`,
    );
  });
});

/**
 * The landing helper owns the whole composition — resolve, create if the
 * resolved destination does not exist yet, append — so no capture surface
 * re-derives the rule. Resolution happens at landing time by design (D21:
 * landing re-verifies rather than trusting a destination picked at record
 * start), so these drive it through the resolution inputs, never a
 * pre-resolved destination.
 */
describe("useLandCaptureMutation composes resolve → create → append (R23.1)", () => {
  const TODAY = "2026-08-31";

  function resolutionInput(
    overrides: Partial<LandCaptureVariables["resolution"]> = {},
  ): LandCaptureVariables["resolution"] {
    return {
      openNotepad: null,
      candidates: [],
      ambientProject: { name: PROJECT_NAME },
      today: TODAY,
      ...overrides,
    };
  }

  async function land(
    resolution: LandCaptureVariables["resolution"],
  ): Promise<Notepad> {
    const { result } = renderHook(() => useLandCaptureMutation(), {
      wrapper: Wrapper,
    });
    let landed: Notepad | null = null;
    await act(async () => {
      landed = await result.current.mutateAsync({
        resolution,
        fragment: FRAGMENT,
      });
    });
    if (landed === null) throw new Error("landing produced no notepad");
    return landed;
  }

  it("lands in the most recently updated candidate, pinning notwithstanding", async () => {
    const stale = await seedNotepad("Older", "Older content.");
    // The server lists pinned first; only recency may decide the destination.
    await organize(stale, { pinned: true });
    const fresh = await seedNotepad("Newer", "Newer content.");
    const candidates = await listThroughQuery();
    expect(candidates[0]?.id).toBe(stale);

    const landed = await land(resolutionInput({ candidates }));

    expect(landed.id).toBe(fresh);
    expect(api.requestsTo("POST", "/api/notepads")).toHaveLength(0);
    expect(await persistedContent(fresh)).toBe(`Newer content.\n\n${FRAGMENT}`);
    expect(await persistedContent(stale)).toBe("Older content.");
  });

  it("lands in the open notepad ahead of any listing", async () => {
    const open = await seedNotepad("Open", "Open content.");
    const fresh = await seedNotepad("Newer", "Newer content.");
    const candidates = await listThroughQuery();

    const landed = await land(
      resolutionInput({ candidates, openNotepad: { id: open } }),
    );

    expect(landed.id).toBe(open);
    expect(await persistedContent(fresh)).toBe("Newer content.");
  });

  it("creates the resolved notepad, then lands the capture in it", async () => {
    const landed = await land(resolutionInput());

    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "project",
      project: PROJECT_NAME,
      name: CAPTURE_INBOX_NAME,
    });
    expect(landed.name).toBe(CAPTURE_INBOX_NAME);
    // A created destination opens empty, so the fragment arrives with no
    // leading separator.
    expect(await persistedContent(landed.id)).toBe(FRAGMENT);
  });

  it("dodges the name an archived notepad still holds", async () => {
    const archivedInbox = await seedNotepad(CAPTURE_INBOX_NAME, "Old capture.");
    await organize(archivedInbox, { archived: true });
    const takenNames = (await listThroughQuery(true)).map((row) => row.name);

    const landed = await land(
      resolutionInput({ candidates: await listThroughQuery(), takenNames }),
    );

    // A plain "Inbox" would have been refused: names are unique per scope.
    expect(landed.name).toBe(`${CAPTURE_INBOX_NAME} (${TODAY})`);
    expect(await persistedContent(landed.id)).toBe(FRAGMENT);
    expect(await persistedContent(archivedInbox)).toBe("Old capture.");
  });

  it("creates a global notepad with no ambient project", async () => {
    const landed = await land(resolutionInput({ ambientProject: null }));

    expect(api.requestsTo("POST", "/api/notepads")[0]?.jsonBody).toEqual({
      scope: "global",
      name: CAPTURE_INBOX_NAME,
    });
    expect(landed.scope).toBe("global");
    expect(await persistedContent(landed.id)).toBe(FRAGMENT);
  });
});

describe("append composition parity: HTTP path vs editor path", () => {
  /** The persisted result of appending through the content route. */
  async function throughHttp(initialContent: string): Promise<string> {
    const notepadId = await seedNotepad(
      `Notepad ${initialContent.length}`,
      initialContent,
    );
    const { result } = renderHook(() => useAppendNotepadContentMutation(), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ notepadId, content: FRAGMENT });
    });
    return persistedContent(notepadId);
  }

  /** The canonical text the editor hands its autosave after appendFragment. */
  function throughEditor(initialContent: string): string {
    const ref = createRef<NotepadEditorHandle>();
    const changes: string[] = [];
    render(
      <NotepadEditor
        ref={ref}
        notepadId="np-editor"
        initialContent={initialContent}
        onContentChange={(text) => changes.push(text)}
      />,
      { wrapper: Wrapper },
    );

    act(() => {
      handleOf(ref).appendFragment(FRAGMENT);
    });

    const latest = changes.at(-1);
    if (latest === undefined) {
      throw new Error("appendFragment did not reach the autosave path");
    }
    return latest;
  }

  it("composes identically onto an empty destination", async () => {
    const http = await throughHttp("");

    expect(http).toBe(FRAGMENT);
    expect(throughEditor("")).toBe(http);
  });

  it("composes identically onto a non-empty destination", async () => {
    const existing = "Existing content.";
    const http = await throughHttp(existing);

    expect(http).toBe(`${existing}\n\n${FRAGMENT}`);
    expect(throughEditor(existing)).toBe(http);
  });
});

describe("NotepadEditorHandle insertText (D23)", () => {
  it("inserts at the cursor and reaches the autosave path", () => {
    const ref = createRef<NotepadEditorHandle>();
    const changes: string[] = [];
    render(
      <NotepadEditor
        ref={ref}
        notepadId="np-editor"
        initialContent="hello world"
        onContentChange={(text) => changes.push(text)}
      />,
      { wrapper: Wrapper },
    );

    act(() => {
      // Position 6 in the document is between "hello " and "world".
      handleOf(ref).editor?.commands.setTextSelection(7);
      handleOf(ref).insertText("dictated ");
    });

    expect(changes.at(-1)).toBe("hello dictated world");
    expect(handleOf(ref).serialize()).toBe("hello dictated world");
  });
});
