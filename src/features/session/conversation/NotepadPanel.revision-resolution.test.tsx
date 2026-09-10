// @vitest-environment jsdom
/**
 * Id-addressed revision resolution and restore-echo adjudication, proven
 * against the PRODUCTION stack: the real panel components driving the real
 * route handlers, service, and repository over a real SQLite database. The
 * fetch fixture carries requests to `createNotepadsRouteHandlers` verbatim —
 * no resolution logic lives in a test double — and SSE frames are forwarded
 * from the service's own publications, so echo timing matches the wire: the
 * change frame exists before the HTTP response resolves.
 */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { PublishFn } from "@/lib/events/publication";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import {
  createNotepadsRouteHandlers,
  type NotepadsRouteHandlers,
  type RouteContext,
} from "@/lib/notepads/route-handlers";
import {
  createNotepadService,
  USER_REVISION_COALESCE_WINDOW_MS,
  type NotepadService,
} from "@/lib/notepads/service";
import { registerNotepadSseReactions } from "@/lib/notepads/sse-reactions";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import {
  installFetchFixture,
  type FetchFixture,
  type RecordedRequest,
  type RouteReply,
} from "@/test/fetch-fixture";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import NotepadHistory from "./NotepadHistory";
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

const PROJECT_NAME = "p1";
const PROJECT_PATH = "/repos/p1";

/** Stands in only for the token FILE the real auth reads; the browser panel
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
/** Advanced by seeds that need writes to land in separate editing sessions. */
let clock = 0;
let handlers: NotepadsRouteHandlers;
let api: FetchFixture;
/** Set by setupLive: the service's publications flow to it as SSE frames. */
let fake: FakeEventSource | null = null;
/** When set, the restore route holds its response until this resolves. */
let restoreGate: Promise<void> | null = null;
/**
 * When set, a content POST is held BEFORE it reaches the service — the
 * slow-request shape where a write posted earlier arrives at the server later.
 */
let contentGate: Promise<void> | null = null;

const publish: PublishFn = (event) => {
  if (fake !== null && event.type === "notepad-changed") {
    fake.emit("notepad-changed", event);
  }
  return { delivered: true };
};

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  const repo = createNotepadsRepo(fixture.db, writeQueue);
  clock = 0;
  let idSeq = 0;
  service = createNotepadService({
    repo,
    comments: createNotepadCommentsRepo(fixture.db, writeQueue),
    publish,
    // Image bytes never enter these tests; the cleanup hook has nothing to do.
    deleteNotepadContent: async () => {},
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 27, 9, 0, 0) + clock).toISOString();
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
  api.reply("GET", /^\/api\/notepads\/[^/]+$/, delegate(handlers.detailGET));
  api.reply(
    "GET",
    /^\/api\/notepads\/[^/]+\/revisions(\?|$)/,
    delegate(handlers.revisionsGET),
  );
  api.reply("POST", /^\/api\/notepads\/[^/]+\/content$/, async (req) => {
    // The gate precedes the handler: the request has left the client but has
    // not reached the service, so later requests can overtake it.
    if (contentGate !== null) await contentGate;
    return delegate(handlers.contentPOST)(req);
  });
  api.reply("POST", /^\/api\/notepads\/[^/]+\/restore$/, async (req) => {
    // The handler runs (and publishes its SSE frame) before the gate, so a
    // held response models the echo outrunning the HTTP reply.
    const reply = await delegate(handlers.restorePOST)(req);
    if (restoreGate !== null) await restoreGate;
    return reply;
  });
  api.reply(
    "PATCH",
    /^\/api\/notepads\/[^/]+$/,
    delegate(handlers.detailPATCH),
  );

  useSessionDetailStore.getState().resetStore();
});

afterEach(() => {
  api.restore();
  cleanup();
  fixture.close();
  fake = null;
  restoreGate = null;
  contentGate = null;
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

function setupLive(queryClient: ReturnType<typeof createTestQueryClient>) {
  fake = new FakeEventSource("/api/events");
  registerNotepadSseReactions(fake as unknown as EventSource, {
    queryClient,
    recordNotepadExternalWrite: (write) =>
      useSessionDetailStore.getState().recordNotepadExternalWrite(write),
  });
}

/** Revision r's canonical content: lines `line-1` through `line-r`. */
function contentFor(revision: number): string {
  return Array.from({ length: revision }, (_, i) => `line-${i + 1}`).join("\n");
}

/** Creates a notepad whose revision history is r1..rN with contentFor(r). */
async function seedNotepad(name: string, revisions: number): Promise<string> {
  const created = await service.create({
    scope: "project",
    projectPath: PROJECT_PATH,
    name,
    content: contentFor(1),
  });
  if (!created.ok) throw new Error(`seed create failed: ${created.error.code}`);
  for (let revision = 2; revision <= revisions; revision += 1) {
    // Seeded revisions stand for separate editing sessions: consecutive saves
    // inside one session fold into a single revision by design.
    clock += USER_REVISION_COALESCE_WINDOW_MS + 1000;
    const written = await service.writeContent(created.value.id, {
      operation: "update",
      content: contentFor(revision),
      author: { kind: "user" },
    });
    if (!written.ok)
      throw new Error(`seed write failed: ${written.error.code}`);
  }
  return created.value.id;
}

async function openNotepad(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(
    await screen.findByRole("button", { name: `Open notepad ${name}` }),
  );
  await screen.findByTestId("notepad-editor-input");
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "History" }));
  await screen.findByTestId("notepad-history");
}

/** History owns the whole panel, so the editor is behind the breadcrumb. */
async function backToNotepad(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: `Back to ${name}` }));
  await screen.findByTestId("notepad-editor-input");
}

async function openNotepadAndHistory(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await openNotepad(user, name);
  await openHistory(user);
}

function diffLines(kind: "del" | "ins"): string[] {
  return [...screen.getByTestId("notepad-history").querySelectorAll(kind)].map(
    (el) => el.textContent ?? "",
  );
}

/**
 * The bottom row of the revision list — where an off-page selection lands, the
 * listing running newest first.
 */
function oldestRevisionRow(): HTMLElement {
  const rows = screen
    .getByTestId("notepad-history")
    .querySelectorAll("li > button");
  const last = rows[rows.length - 1];
  if (!(last instanceof HTMLElement)) throw new Error("no revision rows");
  return last;
}


/**
 * Shorter autosave windows than production, so an idle flush is observed in a
 * fraction of a second while a click sequence still completes inside the
 * window under fork contention.
 */
const TEST_AUTOSAVE_TIMING = { idleMs: 250, maxWaitMs: 1000, retryMs: 1000 };

/**
 * The restore-race test must click through history and restore before the
 * idle window elapses, so it gets a wider one than the flush-observing tests.
 */
const RESTORE_RACE_TIMING = { idleMs: 800, maxWaitMs: 2000, retryMs: 1000 };

describe("id-addressed revision resolution against real persistence", () => {
  it("diffs the oldest listed revision against its real out-of-page predecessor", async () => {
    await seedNotepad("deep notes", 55);
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={TEST_AUTOSAVE_TIMING}
      />,
      queryClient,
    );
    await openNotepadAndHistory(user, "deep notes");

    // The listed page is r55..r6; r6's predecessor r5 is outside it.
    await user.click(screen.getByRole("button", { name: "Select revision 6" }));
    await user.click(screen.getByRole("radio", { name: "vs previous" }));

    // What r6 actually changed: one added line — never the whole snapshot
    // marked added from an empty-string stand-in.
    await waitFor(() => expect(diffLines("ins")).toEqual(["line-6"]));
    expect(diffLines("del")).toEqual([]);
    expect(screen.getByTestId("notepad-history")).toHaveTextContent("line-1");
  });

  it("keeps a retained selection resolving after the head advances past the page", async () => {
    const notepadId = await seedNotepad("advancing notes", 55);
    const queryClient = createTestQueryClient();
    setupLive(queryClient);
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={TEST_AUTOSAVE_TIMING}
      />,
      queryClient,
    );
    await openNotepadAndHistory(user, "advancing notes");

    await user.click(screen.getByRole("button", { name: "Select revision 6" }));
    await user.click(screen.getByRole("radio", { name: "vs previous" }));
    await waitFor(() => expect(diffLines("ins")).toEqual(["line-6"]));

    // Another session writes a new head r56: the listed window slides to
    // r56..r7 and the selected r6 falls off the page.
    await act(async () => {
      const written = await service.writeContent(notepadId, {
        operation: "update",
        content: contentFor(56),
        author: { kind: "user" },
      });
      if (!written.ok) throw new Error("external write failed");
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Select revision 56" }),
      ).toBeVisible(),
    );
    // The selection is id-addressed: r6 stays selected with its real
    // versus-previous diff, not a silently rendered snapshot. Off the listed
    // page (r56…r7), it holds the bottom row in the list.
    expect(oldestRevisionRow()).toHaveAttribute(
      "aria-label",
      "Select revision 6",
    );
    expect(screen.getByRole("button", { name: "Restore r6" })).toBeVisible();
    await waitFor(() => expect(diffLines("ins")).toEqual(["line-6"]));
    expect(diffLines("del")).toEqual([]);
  });

  it("resolves a View diff target aged far past the listed page", async () => {
    // The landed-update strip passes its revision as diffTarget (the panel
    // suite proves that wiring); here the aged case: target r5 under head
    // r55, fifty revisions past the listed page.
    const notepadId = await seedNotepad("aged banner", 55);
    const queryClient = createTestQueryClient();
    renderWithQuery(
      <NotepadHistory
        notepadId={notepadId}
        headRevision={55}
        onRestore={() => {}}
        restorePending={false}
        diffTarget={5}
      />,
      queryClient,
    );

    // Landing state: the target selected, versus-previous shown, correct.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "vs previous" })).toBeChecked(),
    );
    await waitFor(() => expect(diffLines("ins")).toEqual(["line-5"]));
    expect(diffLines("del")).toEqual([]);
    expect(screen.getByRole("button", { name: "Restore r5" })).toBeVisible();
    // r5 is genuinely outside the listed page (r55…r6) — resolution, not
    // listing, produced both the preview and the row carrying it.
    expect(oldestRevisionRow()).toHaveAttribute(
      "aria-label",
      "Select revision 5",
    );
  });

  it("offers all three views for the aged target, including versus-current", async () => {
    const notepadId = await seedNotepad("aged views", 55);
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadHistory
        notepadId={notepadId}
        headRevision={55}
        onRestore={() => {}}
        restorePending={false}
        diffTarget={5}
      />,
      queryClient,
    );
    await waitFor(() => expect(diffLines("ins")).toEqual(["line-5"]));

    await user.click(screen.getByRole("radio", { name: "vs current" }));

    // What restoring r5 would change: lines 6..55 removed, nothing added.
    await waitFor(() =>
      expect(diffLines("del")).toEqual(
        Array.from({ length: 50 }, (_, i) => `line-${i + 6}`),
      ),
    );
    expect(diffLines("ins")).toEqual([]);

    await user.click(screen.getByRole("radio", { name: "snapshot" }));
    expect(
      screen.getByTestId("notepad-history").querySelectorAll("del").length,
    ).toBe(0);
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

describe("restore echo adjudication against real persistence", () => {
  it("never lets a pending autosave overwrite a requested restore", async () => {
    const notepadId = await seedNotepad("race pad", 3);
    const queryClient = createTestQueryClient();
    setupLive(queryClient);
    let releaseRestore: () => void = () => {};
    restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={RESTORE_RACE_TIMING}
      />,
      queryClient,
    );
    await openNotepad(user, "race pad");

    // An edit arms the autosave timers, then the user immediately restores an
    // older revision. The restore commits server-side at once (as r4) but its
    // response is held past the autosave idle window.
    pasteIntoEditor("draft-overwrite ");
    await openHistory(user);
    await user.click(screen.getByRole("button", { name: "Select revision 2" }));
    await user.click(screen.getByRole("button", { name: "Restore r2" }));

    // The restore has committed and its echo arrived; now the idle window
    // elapses while the response is still held.
    await waitFor(() =>
      expect(
        useSessionDetailStore.getState().notepadExternalWrite?.revision,
      ).toBe(4),
    );
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, RESTORE_RACE_TIMING.idleMs + 700),
      );
    });
    releaseRestore();

    // The requested revision remains current: the pre-restore draft was
    // abandoned, never committed over the restore.
    await backToNotepad(user, "race pad");
    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "line-2",
      ),
    );
    expect(
      screen.getByTestId("notepad-editor-input").textContent,
    ).not.toContain("draft-overwrite");
    expect(api.requestsTo("POST", /\/content$/).length).toBe(0);
    const head = await service.get(notepadId);
    if (!head.ok) throw new Error("expected notepad head");
    expect(head.value.revision).toBe(4);
    expect(head.value.content).toBe(contentFor(2));
  });

  it("never labels the user's own restore as an external write, even when its echo outruns the response", async () => {
    await seedNotepad("restorable", 3);
    const queryClient = createTestQueryClient();
    setupLive(queryClient);
    let releaseRestore: () => void = () => {};
    restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={TEST_AUTOSAVE_TIMING}
      />,
      queryClient,
    );
    await openNotepadAndHistory(user, "restorable");

    await user.click(screen.getByRole("button", { name: "Select revision 2" }));
    await user.click(screen.getByRole("button", { name: "Restore r2" }));

    // The restore committed server-side and its user-authored change frame
    // (r4) has arrived — while the HTTP response is still held open.
    await waitFor(() =>
      expect(
        useSessionDetailStore.getState().notepadExternalWrite?.revision,
      ).toBe(4),
    );
    await act(async () => {});
    // The echo must not surface as a landed or colliding external write.
    expect(screen.queryByTestId("notepad-live-banner")).not.toBeInTheDocument();

    releaseRestore();

    // The restore lands normally: history records the restore revision…
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Select revision 4" }),
      ).toBeVisible(),
    );
    // …the editor behind it adopts r2's content as head r4…
    await backToNotepad(user, "restorable");
    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "line-2",
      ),
    );
    expect(
      screen.getByTestId("notepad-editor-input").textContent,
    ).not.toContain("line-3");
    // …and the view still shows no phantom external-write banner.
    expect(screen.queryByTestId("notepad-live-banner")).not.toBeInTheDocument();
  });

  it("refuses edits while a restore is pending, then re-enables and autosaves normally", async () => {
    const notepadId = await seedNotepad("frozen pad", 3);
    const queryClient = createTestQueryClient();
    setupLive(queryClient);
    let releaseRestore: () => void = () => {};
    restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={TEST_AUTOSAVE_TIMING}
      />,
      queryClient,
    );
    await openNotepadAndHistory(user, "frozen pad");

    await user.click(screen.getByRole("button", { name: "Select revision 2" }));
    await user.click(screen.getByRole("button", { name: "Restore r2" }));

    // The restore committed server-side (r4); its response is still held.
    await waitFor(() =>
      expect(
        useSessionDetailStore.getState().notepadExternalWrite?.revision,
      ).toBe(4),
    );

    // The editor refuses input while the restore is pending: an edit typed
    // now would be clobbered the moment the restored head is adopted, so no
    // edit can be typed — nothing to discard silently.
    await backToNotepad(user, "frozen pad");
    const editorDom = screen.getByTestId("notepad-editor-input");
    expect(editorDom).toHaveAttribute("contenteditable", "false");
    pasteIntoEditor("mid-restore-edit ");
    expect(editorDom.textContent).not.toContain("mid-restore-edit");

    releaseRestore();

    // The restore lands, the editor re-enables…
    await waitFor(() => expect(editorDom.textContent).toContain("line-2"));
    await waitFor(() =>
      expect(editorDom).toHaveAttribute("contenteditable", "true"),
    );
    expect(editorDom.textContent).not.toContain("mid-restore-edit");

    // …and an edit typed after landing autosaves on top of the restore.
    pasteIntoEditor("after-restore-note ");
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_AUTOSAVE_TIMING.idleMs + 100),
      );
    });
    await waitFor(async () => {
      const head = await service.get(notepadId);
      if (!head.ok) throw new Error("expected notepad head");
      expect(head.value.revision).toBe(5);
      expect(head.value.content).toContain("after-restore-note");
    });
  });

  it("sequences a restore after an autosave already in flight, so the draft lands beneath the restored head", async () => {
    const notepadId = await seedNotepad("inflight race", 3);
    const queryClient = createTestQueryClient();
    setupLive(queryClient);
    let releaseContent: () => void = () => {};
    contentGate = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    let releaseRestore: () => void = () => {};
    restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const user = userEvent.setup();
    renderWithQuery(
      <NotepadPanel
        projectName={PROJECT_NAME}
        sessionName="s1"
        conversationId="c1"
        active
        autosaveTiming={TEST_AUTOSAVE_TIMING}
      />,
      queryClient,
    );
    await openNotepad(user, "inflight race");

    // The idle window elapses: the autosave POSTs and is now in flight, held
    // before it reaches the service — the slow-request shape.
    pasteIntoEditor("draft-inflight ");
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_AUTOSAVE_TIMING.idleMs + 100),
      );
    });
    expect(api.requestsTo("POST", /\/content$/).length).toBe(1);

    // The user restores an older revision while that autosave is in flight.
    await openHistory(user);
    await user.click(screen.getByRole("button", { name: "Select revision 2" }));
    await user.click(screen.getByRole("button", { name: "Restore r2" }));

    // The held autosave now reaches the service; the restore must commit
    // after it, never race past it.
    releaseContent();
    await waitFor(() =>
      expect(api.requestsTo("POST", /\/restore$/).length).toBe(1),
    );
    releaseRestore();

    // The requested revision remains current…
    await backToNotepad(user, "inflight race");
    await waitFor(() =>
      expect(screen.getByTestId("notepad-editor-input").textContent).toContain(
        "line-2",
      ),
    );
    expect(
      screen.getByTestId("notepad-editor-input").textContent,
    ).not.toContain("draft-inflight");
    const head = await service.get(notepadId);
    if (!head.ok) throw new Error("expected notepad head");
    expect(head.value.revision).toBe(5);
    expect(head.value.content).toBe(contentFor(2));
    // …the in-flight draft was posted exactly once and sits beneath the
    // restore in history — persisted, never silently lost.
    expect(api.requestsTo("POST", /\/content$/).length).toBe(1);
    const draft = await service.resolveRevision(notepadId, 4);
    if (!draft.ok) throw new Error("expected draft revision");
    expect(draft.value.at(-1)?.content).toContain("draft-inflight");
    // Both writes were our own: no phantom external-write banner.
    expect(screen.queryByTestId("notepad-live-banner")).not.toBeInTheDocument();
  });
});
