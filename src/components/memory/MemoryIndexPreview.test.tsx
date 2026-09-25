// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { PublishFn } from "@/lib/events/publication";
import { createMemoryRepo } from "@/lib/state-store/memory-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createMemoryFreshnessEngine } from "@/lib/memory/freshness";
import {
  createMemoryIndexComposer,
  type MemoryIndexBlock,
  type MemoryIndexSubject,
} from "@/lib/memory/index-composer";
import { createMemoryService, type MemoryService } from "@/lib/memory/service";
import { openMemoryContributionGate } from "@/lib/memory/testing/contribution-gate";
import type {
  CreateMemoryNoteRequest,
  MemoryActor,
  MemoryIndexBudget,
} from "@/lib/memory/schemas";
import {
  makeConversationState,
  type ConversationStateOverrides,
} from "@/lib/conversations/testing/conversation-state-fixture";
import {
  toPublicConversationState,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";

import type { MemoryIndexRender } from "@/lib/memory/query-keys";
import type { MemoryIndexDeltaBasis } from "@/lib/memory/index-composer";
import type { MemoryIndexDeliveryKind } from "@/lib/memory/schemas";

import MemoryIndexPreview from "./MemoryIndexPreview";

/**
 * The Index Preview's whole claim is that it is not a rendering of the library
 * — it is the block itself. So these tests compose a REAL block with the real
 * composer over a real store, serve that exact response, and assert the
 * preview reproduces its text byte for byte. A preview that reformatted,
 * re-wrapped, or re-derived an omission line would still look plausible on
 * screen and would be worthless for diagnosing what an agent was told.
 */

const PROJECT_PATH = "/repos/command-center";
const PROJECT_NAME = "command-center";
const SESSION_NAME = "memory-session";
const SESSION_CREATED_AT = "2026-09-01T09:00:00.000Z";
const BASE_TIME = Date.UTC(2026, 8, 2, 12, 0, 0);
const CONVERSATION_ID = "conv-lane-1";
const OTHER_CONVERSATION_ID = "conv-lane-2";

type Db = InstanceType<typeof Database>;

const VISIBILITY = {
  projectPath: PROJECT_PATH,
  session: { sessionName: SESSION_NAME, sessionCreatedAt: SESSION_CREATED_AT },
};
const USER: MemoryActor = { kind: "user", visibility: VISIBILITY };
const AGENT: MemoryActor = {
  kind: "agent",
  conversationId: "conv-author",
  visibility: VISIBILITY,
};
const SUBJECT: MemoryIndexSubject = {
  conversation: { kind: "session", sessionName: SESSION_NAME },
  visibility: VISIBILITY,
  activeArtifacts: [],
  delivery: "ambient",
};

let db: Db;
let service: MemoryService;
let composer: ReturnType<typeof createMemoryIndexComposer>;
let clock: number;
let idSeq: number;
let api: FetchFixture;

const publish: PublishFn = () => ({ delivered: true });

function now(): string {
  return new Date(BASE_TIME + clock).toISOString();
}

function nextId(): string {
  idSeq += 1;
  return `a1b2c3d4-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const repo = createMemoryRepo(db, createWriteQueue());
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  clock = 0;
  idSeq = 0;
  const sessions = {
    async isSessionIncarnationOver() {
      return false;
    },
  };
  service = createMemoryService({
    repo,
    publish,
    contributionGate: openMemoryContributionGate(),
    sessions,
    now: () => {
      clock += 1000;
      return now();
    },
    generateId: nextId,
  });
  composer = createMemoryIndexComposer({
    repo,
    freshness: createMemoryFreshnessEngine({ repo, sessions, now }),
    now,
  });

  api = installFetchFixture();
  api.json(
    "GET",
    `/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/conversations`,
    [
      conversation(CONVERSATION_ID, "lane one"),
      conversation(OTHER_CONVERSATION_ID, "lane two"),
    ],
  );
  api.json("GET", `/api/projects/${PROJECT_NAME}/conversations`, [
    conversation("conv-project", "the project thread", {
      scope: "project",
      open: true,
    }),
  ]);
});

afterEach(() => {
  api.restore();
  cleanup();
  db.close();
});

function conversation(
  id: string,
  name: string,
  overrides: ConversationStateOverrides = {},
): PublicConversationState {
  return toPublicConversationState(
    makeConversationState({
      id,
      name,
      status: "idle",
      createdAt: SESSION_CREATED_AT,
      lastActivityAt: SESSION_CREATED_AT,
      ...overrides,
    }),
  );
}

async function createNote(
  request: CreateMemoryNoteRequest,
  actor: MemoryActor = USER,
): Promise<void> {
  const result = await service.create(request, actor);
  if (!result.ok) {
    throw new Error(
      `create refused: ${result.error.code} ${result.error.message}`,
    );
  }
}

/**
 * A library big enough to overflow a small budget, holding one record of every
 * kind the block reports without delivering: an expired note, and an
 * unapproved global proposal.
 */
async function seedOverflowingLibrary(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: `lesson-${String(index).padStart(2, "0")}`,
      hook: `Lesson ${index}: a representative one-line hook that costs a realistic number of bytes`,
      body: "Body.",
    });
  }
  await createNote({
    scope: "session",
    kind: "state",
    slug: "already-expired",
    hook: "this one lapsed and must not be delivered",
    body: "Body.",
    expiresAt: "2026-08-01T00:00:00.000Z",
  });
  await createNote(
    {
      scope: "global",
      kind: "preference",
      slug: "unapproved-house-style",
      hook: "an agent's global proposal, not yet approved",
      body: "Body.",
    },
    AGENT,
  );
}

const TIGHT_BUDGET: MemoryIndexBudget = { bytes: 1536, hooks: 80 };

/** The store's ids are UUID-shaped, so leaking one is detectable by shape. */
const INTERNAL_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

async function composeBlock(
  budget: MemoryIndexBudget = TIGHT_BUDGET,
): Promise<MemoryIndexBlock> {
  const block = await composer.compose(SUBJECT, budget);
  if (block === null) throw new Error("expected a composed block");
  return block;
}

/**
 * Registered per conversation AND per render, not as a catch-all: the switching
 * tests prove the preview asks for the conversation the human picked and for
 * the render they selected, neither of which a route that answered every
 * request identically could show.
 */
function stubIndex(
  conversationId: string,
  render: MemoryIndexRender,
  block: MemoryIndexBlock | null,
) {
  api.reply(
    "GET",
    new RegExp(
      `^/api/memory/index\\?conversation=${conversationId}${
        render === "full" ? "&full=true" : ""
      }$`,
      "u",
    ),
    { json: { block, mode: block?.kind ?? null } },
  );
}

function preview() {
  return (
    <MemoryIndexPreview
      scopeRef={{ projectName: PROJECT_NAME, sessionName: SESSION_NAME }}
      conversationId={CONVERSATION_ID}
      active
    />
  );
}

function renderPreview() {
  return renderWithQuery(preview(), createTestQueryClient());
}

describe("MemoryIndexPreview", () => {
  it("reproduces the composed block byte for byte, omission and withheld lines included", async () => {
    await seedOverflowingLibrary();
    const block = await composeBlock();
    // Guard against a vacuous assertion: the criterion is about a block that
    // actually states what it left out, so prove this one does.
    expect(block.omitted).toBeGreaterThan(0);
    expect(block.text).toContain("over budget");
    expect(block.text).toContain("withheld:");

    stubIndex(CONVERSATION_ID, "next-turn", block);
    renderPreview();

    const preview = await screen.findByTestId("memory-index-preview-block");
    expect(preview.textContent).toBe(block.text);

    // inv-slug-only-text-output: the block's own text is slug-only by
    // contract, and the entries the response also carries hold the internal
    // ids — so this surface must report the budget from them without ever
    // putting one on screen.
    expect(block.entries.length).toBeGreaterThan(0);
    expect(block.entries[0]?.memoryId).toMatch(INTERNAL_ID_PATTERN);
    expect(document.body.textContent ?? "").not.toMatch(INTERNAL_ID_PATTERN);
  });

  it("reports the budget the block was composed under", async () => {
    await seedOverflowingLibrary();
    const block = await composeBlock();
    stubIndex(CONVERSATION_ID, "next-turn", block);
    renderPreview();

    const usage = await screen.findByTestId("memory-index-preview-budget");
    expect(usage).toHaveTextContent(
      `${block.bytes} / ${block.budget.bytes} bytes`,
    );
    expect(usage).toHaveTextContent(
      `${block.entries.length} / ${block.budget.hooks} hooks`,
    );
  });

  it("names the missing block for the render that was asked for", async () => {
    stubIndex(CONVERSATION_ID, "next-turn", null);
    stubIndex(CONVERSATION_ID, "full", null);
    renderPreview();

    expect(
      await screen.findByText("No memory block for the next turn"),
    ).toBeInTheDocument();
    expect(screen.getByText(/delivery policy/iu)).toBeInTheDocument();
    expect(screen.queryByTestId("memory-index-preview-block")).toBeNull();

    await userEvent
      .setup()
      .click(screen.getByRole("radio", { name: /full index/iu }));
    expect(
      await screen.findByText("No memory block for this conversation"),
    ).toBeInTheDocument();
  });

  it("previews the conversation the human selects", async () => {
    await seedOverflowingLibrary();
    const first = await composeBlock();
    stubIndex(CONVERSATION_ID, "next-turn", first);
    await createNote({
      scope: "session",
      kind: "lesson",
      slug: "learned-after-the-fact",
      hook: "the second lane learned something the first never did",
      body: "Body.",
    });
    const second = await composeBlock();
    stubIndex(OTHER_CONVERSATION_ID, "next-turn", second);
    expect(second.text).not.toBe(first.text);

    renderPreview();
    expect(
      (await screen.findByTestId("memory-index-preview-block")).textContent,
    ).toBe(first.text);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /lane two/u }));

    await expect
      .poll(() => screen.getByTestId("memory-index-preview-block").textContent)
      .toBe(second.text);
  });
});

/**
 * A delta composed against a real delivery basis, so the label under test is
 * reading a real `since` off a real block rather than a hand-written string.
 */
async function composeDeltaBlock(
  delivered: MemoryIndexBlock,
  deliveredAt: string,
): Promise<MemoryIndexBlock> {
  const basis: MemoryIndexDeltaBasis = {
    state: { lastFullAt: deliveredAt, lastDeliveryAt: deliveredAt },
    watermarks: delivered.entries.map((entry) => ({
      conversationId: CONVERSATION_ID,
      memoryId: entry.memoryId,
      channel: "index" as const,
      revision: entry.revision,
      statusDelivered: entry.statusDelivered,
      updatedAt: deliveredAt,
    })),
  };
  return composer.composeDelta(SUBJECT, TIGHT_BUDGET, basis);
}

describe("MemoryIndexPreview — next-turn delivery vs the whole index", () => {
  it("shows the next-turn delta by default, labels it with its since instant, and refetches the full index on switch", async () => {
    await seedOverflowingLibrary();
    const delivered = await composeBlock();
    const deliveredAt = now();
    await createNote({
      scope: "project",
      kind: "lesson",
      slug: "learned-after-the-delivery",
      hook: "the conversation learned this after it was given its block",
      body: "Body.",
    });
    const full = await composeBlock();
    const delta = await composeDeltaBlock(delivered, deliveredAt);

    // Guard against a vacuous comparison: the two renders must really differ,
    // and the delta must really be a delta with an instant to be labelled by.
    const deltaKind: MemoryIndexDeliveryKind = "delta";
    expect(delta.kind).toBe(deltaKind);
    expect(delta.since).toBe(deliveredAt);
    expect(delta.text).not.toBe(full.text);

    stubIndex(CONVERSATION_ID, "next-turn", delta);
    stubIndex(CONVERSATION_ID, "full", full);
    renderPreview();

    expect(
      (await screen.findByTestId("memory-index-preview-block")).textContent,
    ).toBe(delta.text);
    expect(screen.getByTestId("memory-index-preview-render")).toHaveTextContent(
      `delta since ${deliveredAt}`,
    );
    expect(api.requestsTo("GET", /full=true/u)).toHaveLength(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /full index/iu }));

    await expect
      .poll(() => screen.getByTestId("memory-index-preview-block").textContent)
      .toBe(full.text);
    // The switch is a different question, so it is a different request: the
    // next-turn answer already in cache cannot stand in for the full index.
    expect(api.requestsTo("GET", /full=true/u)).toHaveLength(1);
    expect(screen.getByTestId("memory-index-preview-render")).toHaveTextContent(
      /full index/iu,
    );
  });

  it("states the boundary of the next-turn view, and drops it for the full index", async () => {
    // The view is the delivery due as the conversation STANDS, not a promise
    // about the turn: model, structured-output format, and a lane's write
    // envelope are handed in by whoever dispatches that turn, so a human
    // reading a delta here has to be told a differently-dispatched turn can be
    // given the full index instead. The full-index view makes no next-turn
    // claim at all, so the disclosure would only be noise on it.
    await seedOverflowingLibrary();
    const full = await composeBlock();
    stubIndex(CONVERSATION_ID, "next-turn", full);
    stubIndex(CONVERSATION_ID, "full", full);
    renderPreview();

    expect(
      await screen.findByText(
        "Preview based on this conversation's current state. Changes when a turn starts can result in a full index instead.",
      ),
    ).toBeVisible();
    // The full statement sits behind a disclosure, closed by default.
    expect(screen.queryByTestId("memory-index-preview-boundary")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Preview limits" }));
    const boundary = screen.getByTestId("memory-index-preview-boundary");
    expect(boundary).toHaveTextContent(/due as this conversation stands/iu);
    expect(boundary).toHaveTextContent(/supplied when a turn is dispatched/iu);
    expect(boundary).toHaveTextContent(/write envelope/iu);

    await user.click(screen.getByRole("radio", { name: /full index/iu }));

    await expect
      .poll(() => screen.queryByRole("button", { name: "Preview limits" }))
      .toBeNull();
    expect(screen.queryByTestId("memory-index-preview-boundary")).toBeNull();
    expect(
      screen.queryByText(/Preview based on this conversation's current state/u),
    ).toBeNull();
  });

  it("labels a full next-turn delivery as the whole index rather than a delta", async () => {
    // A conversation that holds no block yet is due the full one, and the
    // default view must not claim a delta it is not showing.
    await seedOverflowingLibrary();
    const full = await composeBlock();
    expect(full.since).toBeNull();
    stubIndex(CONVERSATION_ID, "next-turn", full);
    renderPreview();

    await screen.findByTestId("memory-index-preview-block");
    const label = screen.getByTestId("memory-index-preview-render");
    expect(label.textContent ?? "").not.toMatch(/delta/iu);
  });
});

describe("MemoryIndexPreview — freshness", () => {
  it("recomposes the block every time the surface is opened", async () => {
    // The block also depends on inputs no memory event announces — the passage
    // of time against every note's review lease, and which artifacts are active
    // for the conversation — so a preview served from the app's 30s cache can
    // assert a block the next turn would no longer inject. Opening the surface
    // is the moment the human is asking, so it is the moment to ask the
    // composer.
    await seedOverflowingLibrary();
    stubIndex(CONVERSATION_ID, "next-turn", await composeBlock());
    const queryClient = new QueryClient({
      // Mirrors the application client (src/components/Providers.tsx), so this
      // proves the override rather than a test-only default.
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    const first = renderWithQuery(preview(), queryClient);
    await screen.findByTestId("memory-index-preview-block");
    expect(api.requestsTo("GET", /^\/api\/memory\/index\?/)).toHaveLength(1);

    first.unmount();
    renderWithQuery(preview(), queryClient);

    await expect
      .poll(() => api.requestsTo("GET", /^\/api\/memory\/index\?/).length)
      .toBe(2);
  });

  it("recomposes when the pane is reopened without ever unmounting", async () => {
    // The route the running app actually takes. RightPane FORCE-MOUNTS the
    // memory tab, so switching tabs and back never remounts this component:
    // `refetchOnMount` cannot fire, and all that happens is the query being
    // disabled and re-enabled. Inside the app's 30s window the cached block
    // would otherwise be handed straight back.
    await seedOverflowingLibrary();
    stubIndex(CONVERSATION_ID, "next-turn", await composeBlock());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const paneWith = (active: boolean) => (
      <QueryClientProvider client={queryClient}>
        <MemoryIndexPreview
          scopeRef={{ projectName: PROJECT_NAME, sessionName: SESSION_NAME }}
          conversationId={CONVERSATION_ID}
          active={active}
        />
      </QueryClientProvider>
    );

    const view = renderWithQuery(preview(), queryClient);
    await screen.findByTestId("memory-index-preview-block");
    expect(api.requestsTo("GET", /^\/api\/memory\/index\?/)).toHaveLength(1);

    // Tab away, then back. The component instance never leaves the tree.
    view.rerender(paneWith(false));
    view.rerender(paneWith(true));

    await expect
      .poll(() => api.requestsTo("GET", /^\/api\/memory\/index\?/).length)
      .toBe(2);
  });
});

it("requires an explicit subject outside a conversation", async () => {
  renderWithQuery(
    <MemoryIndexPreview
      scopeRef={{ projectName: PROJECT_NAME, sessionName: null }}
      conversationId={null}
      active
    />,
  );
  expect(
    await screen.findByText("Choose a conversation to preview"),
  ).toBeTruthy();
  expect(api.requestsTo("GET", /\/api\/memory\/index/)).toHaveLength(0);
});
