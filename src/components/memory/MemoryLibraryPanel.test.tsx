// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installFetchFixture,
  type FetchFixture,
  type PathPattern,
  type RecordedRequest,
} from "@/test/fetch-fixture";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { registerMemorySseReactions } from "@/lib/memory/sse-reactions";
import type {
  MemoryChangedEvent,
  MemoryNote,
  MemoryNoteRevision,
  MemoryReviewQueueEntry,
} from "@/lib/memory/schemas";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { listNativeMemoryExceptions } from "@/lib/agent-backends/native-memory";
import MemoryLibraryPanel from "./MemoryLibraryPanel";

/**
 * The Library is the human repair surface for a system that silently primes
 * every agent, so these tests pin what a human can actually FIX from it: a
 * wrong hook corrected under compare-and-swap, a proposed global note admitted
 * or refused, a note taken out of the next index build, and the irreversible
 * act kept behind its own confirmation.
 */

let api: FetchFixture;
/** Flipped by a test to model the merge that ends the incarnation. */
let sessionFinished: boolean;

beforeEach(() => {
  api = installFetchFixture();
  sessionFinished = false;
  // The session row supplies the incarnation: its created-at, which is half of
  // a session's identity, and whether it is over, which is what makes a
  // durable note a promotion candidate at all.
  api.reply("GET", "/api/projects/cc/sessions/s1", () => ({
    json: {
      sessionName: "s1",
      worktreePath: "/w",
      branchName: "csm/s1",
      createdAt: SESSION_CREATED_AT,
      lastActivityAt: NOW,
      finished: sessionFinished,
    },
  }));
  api.reply(
    "GET",
    /^\/api\/memory\/review\?project=cc&session=s1&promotionCandidates=true/,
    { json: { entries: [] } },
  );
});

function lastRequest(
  method: string,
  path: PathPattern,
): RecordedRequest | null {
  const calls = api.requestsTo(method, path);
  return calls[calls.length - 1] ?? null;
}
afterEach(() => {
  api.restore();
  cleanup();
});

const NOW = "2026-09-02T12:00:00.000Z";
const SESSION_CREATED_AT = "2026-08-30T00:00:00.000Z";
/** Far enough back that the rendered age is days in any runtime zone. */
const CLAIM_WRITTEN_AT = "2026-08-22T12:00:00.000Z";
const RE_LEASED_UNTIL = "2026-09-19T12:00:00.000Z";

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem-shared-db",
    slug: "shared-state-db-across-branches",
    scope: "project",
    projectPath: "/repos/cc",
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "one DB across branches; unparseable rows quarantined",
    body: "The state store is shared across every worktree.",
    statusNote: null,
    aliases: [],
    indexMode: "auto",
    lifecycle: "active",
    reviewAfter: null,
    expiresAt: null,
    supersedesId: null,
    supersededById: null,
    createdBy: "user",
    authorConversationId: null,
    revision: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A note in no lineage: the ordinary case every fixture here but one is in. */
const NO_LINEAGE = { supersedes: null, supersededBy: null };

const AGENT_PROPOSAL = note({
  id: "mem-proposal",
  slug: "house-style",
  scope: "global",
  projectPath: null,
  kind: "preference",
  hook: "prefer bun over npm in every project",
  lifecycle: "proposed",
  createdBy: "agent",
  authorConversationId: "conv-7",
  revision: 1,
});

const SESSION_NOTE = note({
  id: "mem-session",
  slug: "lane-worktrees-never-resync",
  scope: "session",
  sessionName: "s1",
  sessionCreatedAt: SESSION_CREATED_AT,
  kind: "state",
  hook: "lane worktrees never re-sync",
  revision: 2,
});

/** What the default (active) view lists; the proposal has its own filter. */
const DEFAULT_NOTES = [note(), SESSION_NOTE];

function revision(overrides: Partial<MemoryNoteRevision> = {}) {
  return {
    id: "rev-3",
    memoryId: "mem-shared-db",
    revision: 3,
    snapshot: note({ revision: 3, hook: "the older, better hook" }),
    origin: "edit",
    baseRevision: 2,
    restoredFromRevision: null,
    authorKind: "agent",
    authorConversationId: "conv-2",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  } satisfies MemoryNoteRevision;
}

function queueEntry(
  overrides: Partial<MemoryReviewQueueEntry> = {},
): MemoryReviewQueueEntry {
  return {
    note: SESSION_NOTE,
    staleness: [{ cause: "lease", target: "note" }],
    noteReviewDue: true,
    statusReviewDue: false,
    expired: false,
    promotionCandidate: false,
    ...overrides,
  };
}

/** The list read the panel opens with: project scope, archived excluded. */
function stubList(notes: MemoryNote[] = DEFAULT_NOTES) {
  api.reply(
    "GET",
    /^\/api\/memory\/notes\?project=cc&session=s1&lifecycle=active$/,
    {
      json: { notes },
    },
  );
}

function stubProposedList(notes: MemoryNote[] = [AGENT_PROPOSAL]) {
  api.reply(
    "GET",
    /^\/api\/memory\/notes\?project=cc&session=s1&lifecycle=proposed$/,
    { json: { notes } },
  );
}

function stubReviewQueue(entries: MemoryReviewQueueEntry[] = []) {
  api.reply("GET", /^\/api\/memory\/review\?project=cc&session=s1$/, {
    json: { entries },
  });
}

function renderPanel(queryClient = createTestQueryClient()) {
  return {
    queryClient,
    ...renderWithQuery(
      <MemoryLibraryPanel
        projectName="cc"
        sessionName="s1"
        conversationId="conv-1"
        active
      />,
      queryClient,
    ),
  };
}

let activeQueryClient: ReturnType<typeof createTestQueryClient>;

/** Render the panel and open the note whose hook is named. */
async function openDetail(hook: string) {
  activeQueryClient = renderPanel().queryClient;
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: `Open memory note ${hook}` }),
  );
  return user;
}

describe("MemoryLibraryPanel — browse", () => {
  it("sorts by updated date, creation date, or hook and keeps that order through search and review", async () => {
    const alpha = note({
      id: "alpha",
      slug: "alpha",
      hook: "Alpha shared lesson",
      updatedAt: "2026-09-02T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const beta = note({
      id: "beta",
      slug: "beta",
      hook: "Beta shared lesson",
      updatedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const zeta = note({
      id: "zeta",
      slug: "zeta",
      hook: "Zeta other lesson",
      body: "An unrelated detail.",
      updatedAt: "2026-09-03T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    stubList([alpha, beta, zeta]);
    stubReviewQueue([
      queueEntry({ note: zeta }),
      queueEntry({ note: alpha }),
      queueEntry({ note: beta }),
    ]);
    renderPanel();
    await screen.findByTestId("memory-row-alpha");
    const order = () =>
      screen
        .getAllByRole("button", { name: /^Open memory note / })
        .map((row) => row.getAttribute("data-testid"));
    expect(order()).toEqual([
      "memory-row-zeta",
      "memory-row-alpha",
      "memory-row-beta",
    ]);

    const user = userEvent.setup();
    async function chooseSort(label: string) {
      await user.click(
        screen.getByRole("combobox", { name: "Sort memory notes" }),
      );
      await user.click(screen.getByRole("option", { name: label }));
    }
    await chooseSort("Newest created");
    expect(order()).toEqual([
      "memory-row-beta",
      "memory-row-zeta",
      "memory-row-alpha",
    ]);
    await chooseSort("Oldest updated");
    expect(order()).toEqual([
      "memory-row-beta",
      "memory-row-alpha",
      "memory-row-zeta",
    ]);
    await chooseSort("Alphabetical");
    expect(order()).toEqual([
      "memory-row-alpha",
      "memory-row-beta",
      "memory-row-zeta",
    ]);

    await user.type(
      screen.getByRole("searchbox", { name: "Search memory notes" }),
      "shared",
    );
    expect(order()).toEqual(["memory-row-alpha", "memory-row-beta"]);
    await user.clear(
      screen.getByRole("searchbox", { name: "Search memory notes" }),
    );
    await user.click(screen.getByRole("radio", { name: "review" }));
    expect(order()).toEqual([
      "memory-row-alpha",
      "memory-row-beta",
      "memory-row-zeta",
    ]);
  });

  it("renders each note's exact hook with its scope, kind, and author", async () => {
    stubList();
    stubReviewQueue();
    renderPanel();

    const row = await screen.findByTestId("memory-row-mem-shared-db");
    expect(row).toHaveTextContent(
      "one DB across branches; unparseable rows quarantined",
    );
    expect(within(row).getByText("project")).toBeInTheDocument();
    expect(within(row).getByText("lesson")).toBeInTheDocument();

    expect(within(row).getByText("user")).toBeInTheDocument();
  });

  it("lists agent proposals under the proposed filter, badged as such", async () => {
    stubList();
    stubProposedList();
    stubReviewQueue();
    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "proposed" }));

    const proposal = await screen.findByTestId("memory-row-mem-proposal");
    expect(within(proposal).getByText("proposed")).toBeInTheDocument();
    expect(within(proposal).getByText("agent")).toBeInTheDocument();
  });

  it("marks a row the freshness engine placed in the review queue", async () => {
    // Freshness is never re-derived here: the row is flagged because the
    // engine's own queue holds it, not because the panel compared a lease.
    stubList();
    stubReviewQueue([queueEntry()]);
    renderPanel();

    const row = await screen.findByTestId("memory-row-mem-session");
    await waitFor(() =>
      expect(within(row).getByText("review due")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("memory-row-mem-shared-db")).queryByText(
        "review due",
      ),
    ).toBeNull();
  });

  it("filters rows by the typed search over hook and slug", async () => {
    stubList();
    stubReviewQueue();
    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: /search/i }), "lane");

    expect(screen.getByTestId("memory-row-mem-session")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-row-mem-shared-db")).toBeNull();
  });

  it("refetches the list when a memory change arrives on the wire", async () => {
    stubList();
    stubReviewQueue();
    const { queryClient } = renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const es = new FakeEventSource("/api/events");
    registerMemorySseReactions(es, { queryClient });

    stubList([
      ...DEFAULT_NOTES,
      note({
        id: "mem-new",
        slug: "captured-elsewhere",
        hook: "captured elsewhere",
      }),
    ]);
    const changed: MemoryChangedEvent = {
      type: "memory-changed",
      change: "created",
      memoryId: "mem-new",
      slug: "captured-elsewhere",
      scope: "project",
      projectPath: "/repos/cc",
      sessionName: null,
      sessionCreatedAt: null,
      lifecycle: "active",
      revision: 1,
      authorKind: "agent",
      link: null,
    };
    es.emit("memory-changed", changed);

    expect(await screen.findByTestId("memory-row-mem-new")).toBeInTheDocument();
  });
});

describe("MemoryLibraryPanel — repair", () => {
  beforeEach(() => {
    stubList();
    stubReviewQueue();
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: note(), links: [], lineage: NO_LINEAGE },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\/revisions\?/, {
      json: { revisions: [revision()] },
    });
  });

  it("renders a note's links as about and source chips and no watch state", async () => {
    // The chips are the Library's whole account of what a note is bound to.
    // With watches removed, `about` and `source` are the only relationships
    // that exist, and the detail must not surface any third state.
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: {
        note: note(),
        links: [
          {
            id: "link-about",
            memoryId: "mem-shared-db",
            kind: "about",
            artifact: { kind: "ticket", ticketId: "ticket-74" },
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "link-source",
            memoryId: "mem-shared-db",
            kind: "source",
            artifact: { kind: "workflow_execution", executionId: "exec-9" },
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        lineage: NO_LINEAGE,
      },
    });

    await openDetail("one DB across branches; unparseable rows quarantined");

    expect(
      await screen.findByText("about: ticket:ticket-74"),
    ).toBeInTheDocument();
    expect(screen.getByText("source: execution:exec-9")).toBeInTheDocument();
    expect(screen.queryByText(/watch/i)).toBeNull();
  });

  it("names the note that replaced this one, by slug", async () => {
    // A human repairing the library is exactly the reader who must not be shown
    // a retired note with no sign that a replacement exists.
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: {
        note: note(),
        links: [],
        lineage: { supersedes: null, supersededBy: "project:the-successor" },
      },
    });

    await openDetail("one DB across branches; unparseable rows quarantined");

    expect(
      await screen.findByText(/project:the-successor/),
    ).toBeInTheDocument();
    expect(screen.getByText(/read that note instead/i)).toBeInTheDocument();
  });

  it("edits a wrong hook under compare-and-swap, stating the base revision", async () => {
    const patched = note({ hook: "corrected hook", revision: 5 });
    api.reply("PATCH", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: patched },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    const hookField = await screen.findByRole("textbox", { name: /hook/i });
    await user.clear(hookField);
    await user.type(hookField, "corrected hook");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      const call = lastRequest(
        "PATCH",
        /^\/api\/memory\/notes\/mem-shared-db\?/,
      );
      expect(call?.jsonBody).toMatchObject({
        baseRevision: 4,
        hook: "corrected hook",
      });
    });
  });

  it("surfaces the current revision when the compare-and-swap is refused", async () => {
    api.reply("PATCH", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      status: 409,
      json: {
        error: "another writer advanced this note to revision 6",
        code: "stale_revision",
        details: {
          currentRevision: 6,
          baseRevision: 4,
          slug: "shared-state-db-across-branches",
        },
      },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    const hookField = await screen.findByRole("textbox", { name: /hook/i });
    await user.clear(hookField);
    await user.type(hookField, "losing edit");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("revision 6");
  });

  it("saves against the revision it read, not a head that moved under it", async () => {
    // A concurrent agent write arrives while the human is mid-edit. Sending the
    // refetched head as the base would silently clobber that write; sending the
    // revision the pane read is what produces the refusal the banner reports.
    api.reply("PATCH", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      status: 409,
      json: {
        error: "another writer advanced this note",
        code: "stale_revision",
        details: {
          currentRevision: 9,
          baseRevision: 4,
          slug: "shared-state-db-across-branches",
        },
      },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    const hookField = await screen.findByRole("textbox", { name: /hook/i });
    await user.clear(hookField);
    await user.type(hookField, "my in-flight edit");

    // The agent's write lands: the detail refetches to revision 9.
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: {
        note: note({ revision: 9, hook: "the agent's hook" }),
        links: [],
        lineage: NO_LINEAGE,
      },
    });
    const es = new FakeEventSource("/api/events");
    registerMemorySseReactions(es, { queryClient: activeQueryClient });
    es.emit("memory-changed", {
      type: "memory-changed",
      change: "updated",
      memoryId: "mem-shared-db",
      slug: "shared-state-db-across-branches",
      scope: "project",
      projectPath: "/repos/cc",
      sessionName: null,
      sessionCreatedAt: null,
      lifecycle: "active",
      revision: 9,
      authorKind: "agent",
      link: null,
    } satisfies MemoryChangedEvent);
    await waitFor(() =>
      expect(
        api.requestsTo("GET", /^\/api\/memory\/notes\/mem-shared-db\?/),
      ).not.toHaveLength(1),
    );
    // The dirty draft is kept — an external write must not eat typed text.
    expect(hookField).toHaveValue("my in-flight edit");

    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      const call = lastRequest(
        "PATCH",
        /^\/api\/memory\/notes\/mem-shared-db\?/,
      );
      expect(call?.jsonBody).toMatchObject({ baseRevision: 4 });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("revision 9");
  });

  it("archives a note so it leaves the next index build", async () => {
    api.reply("POST", /^\/api\/memory\/notes\/mem-shared-db\/archive\?/, {
      json: { note: note({ lifecycle: "archived", revision: 5 }) },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      const call = lastRequest(
        "POST",
        /^\/api\/memory\/notes\/mem-shared-db\/archive\?/,
      );
      expect(call?.jsonBody).toMatchObject({ baseRevision: 4 });
    });
  });

  it("marks the note reviewed against the freshness engine's lease", async () => {
    api.reply("POST", /^\/api\/memory\/notes\/mem-shared-db\/reviewed\?/, {
      json: { note: note({ revision: 5 }), statusReLease: null },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(
      await screen.findByRole("button", { name: "Mark reviewed" }),
    );

    await waitFor(() => {
      const call = lastRequest(
        "POST",
        /^\/api\/memory\/notes\/mem-shared-db\/reviewed\?/,
      );
      expect(call?.jsonBody).toMatchObject({ target: "note", baseRevision: 4 });
    });
  });

  it("names the claim a status re-lease puts back into ambient delivery", async () => {
    // R2.2/D8: re-leasing asserts "this is still true" about a line that
    // primes every conversation again the moment it holds. The evaluation
    // found a human re-lease restoring a FALSE claim with nothing on the
    // surface naming it, so the act states the claim, its age, and the lease.
    const claimed = {
      text: "cursor darwin support still unmerged",
      updatedAt: CLAIM_WRITTEN_AT,
      reviewAfter: "2026-09-05T12:00:00.000Z",
    };
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: {
        note: note({ statusNote: claimed }),
        links: [],
        lineage: NO_LINEAGE,
      },
    });
    const reLeased = { ...claimed, reviewAfter: RE_LEASED_UNTIL };
    api.reply("POST", /^\/api\/memory\/notes\/mem-shared-db\/reviewed\?/, {
      json: {
        note: note({ revision: 5, statusNote: reLeased }),
        statusReLease: reLeased,
      },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(
      await screen.findByRole("button", { name: "Mark status reviewed" }),
    );

    const receipt = await screen.findByTestId("memory-status-re-lease");
    expect(receipt).toHaveTextContent("cursor darwin support still unmerged");
    // The claim's age counts from when it was WRITTEN; a re-lease never makes
    // an old claim recent.
    expect(receipt).toHaveTextContent(/status as of \d+ days ago/);
    expect(receipt).toHaveTextContent(formatLocalTime(RE_LEASED_UNTIL));
  });

  it("restores a prior revision forward from the revision list", async () => {
    api.reply("POST", /^\/api\/memory\/notes\/mem-shared-db\/restore\?/, {
      json: { note: note({ hook: "the older, better hook", revision: 5 }) },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(
      await screen.findByRole("button", { name: "Restore revision 3" }),
    );

    await waitFor(() => {
      const call = lastRequest(
        "POST",
        /^\/api\/memory\/notes\/mem-shared-db\/restore\?/,
      );
      // Restore copies the snapshot FORWARD: it states both the revision to
      // copy and the head it is based on, so the history keeps growing.
      expect(call?.jsonBody).toMatchObject({ revision: 3, baseRevision: 4 });
    });
  });

  it("supersedes a note with a replacement created in the same act", async () => {
    api.reply("POST", /^\/api\/memory\/notes\?/, {
      json: {
        note: note({
          id: "mem-successor",
          slug: "successor",
          hook: "the replacement",
        }),
        advisories: { overlapCandidates: [], hookWarnings: [] },
      },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(await screen.findByRole("button", { name: "Supersede…" }));
    const hookField = await screen.findByRole("textbox", {
      name: /replacement hook/i,
    });
    await user.type(hookField, "the replacement");
    await user.click(screen.getByRole("button", { name: "Create successor" }));

    await waitFor(() => {
      const call = lastRequest("POST", /^\/api\/memory\/notes\?/);
      expect(call?.jsonBody).toMatchObject({
        hook: "the replacement",
        supersedes: "mem-shared-db",
      });
    });
  });

  it("permanently deletes only through the separate confirmation", async () => {
    api.reply("DELETE", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: note() },
    });

    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    // The click that names the act must not be the click that performs it.
    expect(api.requestsTo("DELETE", /^\/api\/memory\/notes\//)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.requestsTo("DELETE", /^\/api\/memory\/notes\//)).toHaveLength(
        1,
      ),
    );
  });

  it("drops an open detail when the note is deleted somewhere else", async () => {
    await openDetail("one DB across branches; unparseable rows quarantined");
    await screen.findByRole("button", { name: "Delete…" });

    // The record is gone, so the read that would confirm it now fails.
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      status: 404,
      json: { error: "no memory note matches shared-state-db-across-branches" },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\/revisions\?/, {
      status: 404,
      json: { error: "no memory note matches shared-state-db-across-branches" },
    });

    const es = new FakeEventSource("/api/events");
    registerMemorySseReactions(es, { queryClient: activeQueryClient });
    es.emit("memory-changed", {
      type: "memory-changed",
      change: "deleted",
      memoryId: "mem-shared-db",
      slug: "shared-state-db-across-branches",
      scope: "project",
      projectPath: "/repos/cc",
      sessionName: null,
      sessionCreatedAt: null,
      lifecycle: "active",
      revision: 4,
      authorKind: "agent",
      link: null,
    } satisfies MemoryChangedEvent);

    // No click, no navigation: the pane stops asserting a deleted record on
    // the strength of the frame alone.
    expect(
      await screen.findByText("Could not load this note"),
    ).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue(
        "one DB across branches; unparseable rows quarantined",
      ),
    ).toBeNull();
  });
});

describe("MemoryLibraryPanel — proposed global notes", () => {
  it("approves an agent's global proposal, activating it", async () => {
    stubList();
    stubReviewQueue();
    api.reply("GET", /^\/api\/memory\/notes\/mem-proposal\?/, {
      json: { note: AGENT_PROPOSAL, links: [], lineage: NO_LINEAGE },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-proposal\/revisions\?/, {
      json: { revisions: [] },
    });
    api.reply("POST", /^\/api\/memory\/notes\/mem-proposal\/proposal\?/, {
      json: { note: { ...AGENT_PROPOSAL, lifecycle: "active", revision: 2 } },
    });

    stubProposedList();
    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "proposed" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Open memory note prefer bun over npm in every project",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const call = lastRequest(
        "POST",
        /^\/api\/memory\/notes\/mem-proposal\/proposal\?/,
      );
      expect(call?.jsonBody).toMatchObject({
        decision: "approve",
        baseRevision: 1,
      });
    });
  });

  it("offers no proposal decision on an active note", async () => {
    stubList();
    stubReviewQueue();
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: note(), links: [], lineage: NO_LINEAGE },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\/revisions\?/, {
      json: { revisions: [] },
    });

    await openDetail("one DB across branches; unparseable rows quarantined");
    await screen.findByRole("button", { name: "Archive" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("MemoryLibraryPanel — promotion candidates", () => {
  /** The one durable session note the incarnation leaves behind. */
  const CANDIDATE = queueEntry({
    note: SESSION_NOTE,
    staleness: [],
    noteReviewDue: false,
    promotionCandidate: true,
  });

  function stubCandidates(entries: MemoryReviewQueueEntry[] = [CANDIDATE]) {
    api.reply(
      "GET",
      /^\/api\/memory\/review\?project=cc&session=s1&promotionCandidates=true&sessionName=s1&sessionCreatedAt=/,
      { json: { entries } },
    );
  }

  it("badges the candidate count and opens the prefiltered session queue", async () => {
    stubList();
    stubReviewQueue();
    stubCandidates();

    renderPanel();

    const badge = await screen.findByRole("button", {
      name: /1 promotion candidate/i,
    });
    const user = userEvent.setup();
    await user.click(badge);

    // The badge's number and the list it opens are the same query by
    // construction, so the count can never promise rows the queue lacks.
    const row = await screen.findByTestId("memory-row-mem-session");
    expect(within(row).getByText("promotion candidate")).toBeInTheDocument();
    expect(
      screen
        .getByRole("link", { name: "Open memory screen" })
        .getAttribute("href"),
    ).toContain("queue=candidates");
  });

  it("opens that queue past narrowing that would hide every candidate", async () => {
    stubList();
    stubReviewQueue();
    stubCandidates();
    // Whatever the human was reading before does not survive the badge: it is
    // a promise about what it opens, not one more filter to intersect.
    api.reply(
      "GET",
      /^\/api\/memory\/notes\?project=cc&session=s1&scope=global&lifecycle=active$/,
      { json: { notes: [] } },
    );

    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "global" }));
    await user.type(
      screen.getByRole("searchbox", { name: /search/i }),
      "matches no candidate",
    );

    await user.click(
      await screen.findByRole("button", { name: /1 promotion candidate/i }),
    );

    expect(
      await screen.findByTestId("memory-row-mem-session"),
    ).toBeInTheDocument();
    // The filters the badge cleared say so on screen, so the view the human
    // now reads is not narrowed by a control still claiming otherwise.
    expect(screen.getByRole("radio", { name: "all" })).toBeChecked();
    expect(screen.getByRole("searchbox", { name: /search/i })).toHaveValue("");
  });
});

describe("MemoryLibraryPanel — index preview", () => {
  it("switches from the library to the block this conversation's next turn carries", async () => {
    stubList();
    stubReviewQueue();
    api.json("GET", "/api/projects/cc/sessions/s1/conversations", [
      toPublicConversationState(
        makeConversationState({ id: "conv-1", name: "the open lane" }),
      ),
    ]);
    api.json("GET", "/api/projects/cc/conversations", []);
    api.reply("GET", /^\/api\/memory\/index\?conversation=conv-1$/, {
      json: {
        mode: "full",
        block: {
          kind: "full",
          since: null,
          text: "<memory-index>\nadvisory\n</memory-index>",
          bytes: 39,
          budget: { bytes: 12288, hooks: 80 },
          omitted: 0,
          total: 0,
          withheld: { reviewDue: 0, expired: 0, proposed: 0 },
          entries: [],
        },
      },
    });

    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "index" }));

    // The preview opens on the conversation the panel is mounted in, so the
    // first thing a human sees is what the lane in front of them was told.
    const block = await screen.findByTestId("memory-index-preview-block");
    expect(block.textContent).toBe("<memory-index>\nadvisory\n</memory-index>");
    expect(screen.queryByTestId("memory-row-mem-shared-db")).not.toBeVisible();
  });
});

describe("MemoryLibraryPanel — derived freshness", () => {
  it("raises the promotion badge when the session completes, with no note changing", async () => {
    // Candidacy is derived from the incarnation being over. That transition
    // writes no note, so no memory-changed frame accompanies it: a badge that
    // waited for one would stay at zero on an already-open Library.
    stubList();
    stubReviewQueue();
    const { queryClient } = renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");
    expect(
      screen.queryByRole("button", { name: /promotion candidate/iu }),
    ).toBeNull();

    sessionFinished = true;
    api.reply(
      "GET",
      /^\/api\/memory\/review\?project=cc&session=s1&promotionCandidates=true/,
      {
        json: {
          entries: [
            queueEntry({
              staleness: [],
              noteReviewDue: false,
              promotionCandidate: true,
            }),
          ],
        },
      },
    );
    await queryClient.invalidateQueries({
      queryKey: sessionKeys.detail("cc", "s1"),
    });

    expect(
      await screen.findByRole("button", { name: /1 promotion candidate/iu }),
    ).toBeInTheDocument();
  });

  it("narrows review rows by the selected scope like every other row source", async () => {
    stubList();
    // The project note is stale, the session note is a candidate: both are work
    // the queue owes, and both must obey the scope the human chose.
    stubReviewQueue([
      queueEntry({ note: note() }),
      queueEntry({
        note: SESSION_NOTE,
        staleness: [],
        noteReviewDue: false,
        promotionCandidate: true,
      }),
    ]);
    renderPanel();
    await screen.findByTestId("memory-row-mem-shared-db");

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "review" }));
    expect(
      await screen.findByTestId("memory-row-mem-shared-db"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("memory-row-mem-session")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "session" }));

    await waitFor(() =>
      expect(screen.queryByTestId("memory-row-mem-shared-db")).toBeNull(),
    );
    expect(screen.getByTestId("memory-row-mem-session")).toBeInTheDocument();
  });
});

describe("MemoryLibraryPanel — pending feedback", () => {
  beforeEach(() => {
    stubList();
    stubReviewQueue();
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: note(), links: [], lineage: NO_LINEAGE },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\/revisions\?/, {
      json: { revisions: [revision()] },
    });
  });

  it("shows a lifecycle act as in flight rather than only disabling it", async () => {
    // Archive is a lifecycle decision the server makes, so it cannot be shown
    // optimistically; the steering's remaining rung is a visible pending state,
    // and a control that merely greys out reads as broken, not as working.
    api.pending("POST", /^\/api\/memory\/notes\/mem-shared-db\/archive\?/);
    const user = await openDetail(
      "one DB across branches; unparseable rows quarantined",
    );

    const archive = await screen.findByRole("button", { name: "Archive" });
    expect(archive).not.toHaveAttribute("aria-busy");

    await user.click(archive);

    await waitFor(() => expect(archive).toHaveAttribute("aria-busy", "true"));
  });
});

/**
 * The second disclosure surface for criterion memory-crit-native-disclosure
 * (the first is the `cctl memory index` header). A backend Command Center
 * could not neutralize is running its own memory beside this library, and the
 * Library is where a human looks to understand what agents are being told —
 * so it has to say so standing, not only inside a composed block.
 */
describe("native-memory disclosure", () => {
  it("names the backend whose native memory could not be disabled", async () => {
    // Derived from the registered declarations, not restated here: the notice
    // exists because a backend declares `none`.
    const exceptions = listNativeMemoryExceptions(listBackendCatalogEntries());
    expect(exceptions.length).toBeGreaterThan(0);

    api.reply("GET", "/api/agent-backends", () => ({
      json: { backends: listBackendCatalogEntries() },
    }));
    api.reply("GET", /^\/api\/memory\/notes/, { json: { notes: [] } });
    api.reply("GET", /^\/api\/memory\/review/, { json: { entries: [] } });

    renderPanel();

    const notice = await screen.findByTestId("native-memory-disclosure");
    for (const exception of exceptions) {
      expect(notice.textContent).toContain(exception.label);
      const disclosure = within(notice).getByRole("button", {
        name: `${exception.label} native memory is not disabled`,
      });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await userEvent.setup().click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(notice.textContent).toContain(exception.reason);
    }
  });

  it("renders nothing when every registered backend is neutralized", async () => {
    // The nothing-to-disclose case: a notice that shows up for a backend CC
    // DID neutralize teaches the operator to ignore it, and then the real
    // exception is invisible too.
    api.reply("GET", "/api/agent-backends", () => ({
      json: {
        backends: listBackendCatalogEntries().map((entry) => ({
          ...entry,
          nativeMemory: {
            mechanism: "disabled" as const,
            lever: "every backend neutralized in this scenario",
          },
        })),
      },
    }));
    api.reply("GET", /^\/api\/memory\/notes/, { json: { notes: [] } });
    api.reply("GET", /^\/api\/memory\/review/, { json: { entries: [] } });

    renderPanel();

    await waitFor(() => {
      expect(screen.queryByTestId("native-memory-disclosure")).toBeNull();
    });
  });
});

describe("MemoryLibraryPanel — page context", () => {
  it("browses global notes without a project or session request", async () => {
    api.reply("GET", /^\/api\/memory\/notes\?lifecycle=active$/, {
      json: { notes: [note({ scope: "global", projectPath: null })] },
    });
    api.reply("GET", "/api/memory/review", { json: { entries: [] } });
    renderWithQuery(
      <MemoryLibraryPanel
        projectName={null}
        sessionName={null}
        conversationId={null}
        active
        layout="page"
      />,
    );
    expect(
      await screen.findByRole("button", {
        name: `Open memory note ${note().hook}`,
      }),
    ).toBeTruthy();
    expect(api.requestsTo("GET", /\/sessions\//)).toHaveLength(0);
  });
});

describe("MemoryLibraryPanel — page navigation", () => {
  it("keeps the list and search while editing and asks before discarding edits", async () => {
    stubList();
    stubReviewQueue();
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\?/, {
      json: { note: note(), links: [], lineage: NO_LINEAGE },
    });
    api.reply("GET", /^\/api\/memory\/notes\/mem-shared-db\/revisions\?/, {
      json: { revisions: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(
      <MemoryLibraryPanel
        projectName="cc"
        sessionName="s1"
        conversationId="conv-1"
        active
        layout="page"
      />,
    );
    await user.type(screen.getByRole("searchbox"), "one DB");
    await user.click(
      await screen.findByRole("button", {
        name: `Open memory note ${note().hook}`,
      }),
    );
    await screen.findByLabelText("Hook");
    expect(screen.getByRole("button", { name: "← Library" })).toHaveFocus();
    expect(screen.getByRole("searchbox")).toHaveValue("one DB");
    await user.type(screen.getByLabelText("Hook"), " draft");
    await user.click(screen.getByRole("radio", { name: "index" }));
    expect(
      await screen.findByRole("alertdialog", { name: "Discard memory edits" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Hook")).toHaveValue(`${note().hook} draft`);
    await user.click(screen.getByRole("button", { name: "← Library" }));
    await user.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(
      screen.getByRole("button", { name: `Open memory note ${note().hook}` }),
    ).toHaveFocus();
  });
});
