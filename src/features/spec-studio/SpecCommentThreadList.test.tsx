// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging/client-logger", () => ({
  createClientLogger: () => log,
}));

import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import { specKeys } from "@/lib/specs/query-keys";
import type { SpecCommentRow } from "@/lib/specs/schemas";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import SpecCommentThreadList, {
  type SpecCommentThreadListHandle,
} from "./SpecCommentThreadList";
import type { PlacedSpecCommentThread } from "./spec-comment-placement";

const ANCHOR = {
  sectionId: "requirements",
  headingLabel: "Requirements",
  line: 4,
  charStart: 0,
  charEnd: 16,
  quote: "durable feedback",
  prefix: "",
  suffix: "",
  docRevision: "revision-2",
};

function viewRow(
  threadId: string,
  overrides: Partial<SpecCommentView> = {},
): SpecCommentView {
  return {
    id: `root-${threadId}`,
    threadId,
    parentCommentId: null,
    elementId: `requirement-${threadId}`,
    handle: threadId === "one" ? "R1" : "R2",
    revisionId: "revision-2",
    revisionNumber: 2,
    anchor: ANCHOR,
    quote: ANCHOR.quote,
    body: `Root ${threadId}`,
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function placements(): PlacedSpecCommentThread[] {
  return assembleSpecCommentThreads([viewRow("one"), viewRow("two")]).map(
    (thread) => ({
      thread,
      element: null,
      anchorState: { status: "anchored", charStart: 0, charEnd: 16 },
      fallbackReason: null,
    }),
  );
}

function invalidPlacements(withReply = false): PlacedSpecCommentThread[] {
  const rows = [
    viewRow("invalid", { id: "invalid-root-one" }),
    viewRow("invalid", { id: "invalid-root-two" }),
  ];
  if (withReply) {
    rows.push(
      viewRow("invalid", {
        id: "invalid-reply",
        parentCommentId: "invalid-root-one",
      }),
    );
  }
  return assembleSpecCommentThreads(rows).map((thread) => ({
    thread,
    element: null,
    anchorState: { status: "orphaned" },
    fallbackReason: "invalid-thread",
  }));
}

function actionRow(
  id: string,
  threadId: string,
  parentId: string | null,
): SpecCommentRow {
  return {
    id,
    spec_id: "spec-1",
    thread_id: threadId,
    parent_comment_id: parentId,
    element_id: `requirement-${threadId}`,
    anchor_json: JSON.stringify(ANCHOR),
    revision_id: "revision-2",
    body: "Agent reply body",
    author_json: JSON.stringify({ kind: "human" }),
    blocking: 0,
    resolution: "open",
    created_at: "2026-08-22T10:05:00.000Z",
    updated_at: "2026-08-22T10:05:00.000Z",
  };
}

interface Requests {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  bodies: Array<{ url: string; body: unknown }>;
  detailReads: number;
  malformedReply: boolean;
  failResolve: boolean;
}

function requestHarness(): Requests {
  const requests: Requests = {
    fetch: vi.fn<typeof fetch>(),
    bodies: [],
    detailReads: 0,
    malformedReply: false,
    failResolve: false,
  };
  requests.fetch.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/test-detail") {
      requests.detailReads += 1;
      return new Response(JSON.stringify({ version: requests.detailReads }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body)) as unknown;
    requests.bodies.push({ url, body });
    if (url.endsWith("/actions/reply")) {
      return new Response(
        JSON.stringify(
          requests.malformedReply
            ? { malformed: true }
            : actionRow("reply-1", "one", "root-one"),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/actions/resolve-thread")) {
      if (requests.failResolve) {
        return new Response(JSON.stringify({ error: "Resolve refused" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([
          { ...actionRow("root-one", "one", null), resolution: "resolved" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return requests;
}

function DetailObserver(): React.JSX.Element {
  const query = useQuery({
    queryKey: specKeys.detail("project", "spec"),
    queryFn: async () => {
      const response = await fetch("/test-detail");
      return (await response.json()) as { version: number };
    },
  });
  return (
    <span data-testid="detail-version">{query.data?.version ?? "loading"}</span>
  );
}

function ListHarness({
  onHandle,
}: {
  onHandle(handle: SpecCommentThreadListHandle | null): void;
}): React.JSX.Element {
  return (
    <>
      <DetailObserver />
      <SpecCommentThreadList
        ref={onHandle}
        projectName="project"
        slug="spec"
        specId="spec-1"
        viewedRevisionId="revision-2"
        viewedRevisionState="proposed"
        specAbandoned={false}
        humanTransport
        placements={placements()}
        label="Current review threads"
      />
    </>
  );
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("SpecCommentThreadList", () => {
  let requests: Requests;
  let handle: SpecCommentThreadListHandle | null;

  beforeEach(() => {
    requests = requestHarness();
    handle = null;
    log.info.mockReset();
    log.warn.mockReset();
    vi.stubGlobal("fetch", requests.fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderList(): void {
    render(
      <QueryClientProvider client={makeClient()}>
        <ListHarness onHandle={(next) => (handle = next)} />
      </QueryClientProvider>,
    );
  }

  it("focuses a sole annotation article or a labelled grouped gutter target", async () => {
    renderList();
    await waitFor(() => expect(handle).not.toBeNull());

    handle!.focus({ kind: "annotation", id: "one" });
    await waitFor(() =>
      expect(screen.getByTestId("review-thread-one")).toHaveFocus(),
    );

    handle!.focus({ kind: "block-group", ids: ["one", "two"] });
    expect(
      await screen.findByRole("group", {
        name: "2 review threads on this passage",
      }),
    ).toHaveFocus();
  });

  it("warns once per invalid thread shape while it remains mounted", async () => {
    const client = makeClient();
    const renderWith = (nextPlacements: PlacedSpecCommentThread[]) => (
      <QueryClientProvider client={client}>
        <SpecCommentThreadList
          projectName="project"
          slug="spec"
          specId="spec-1"
          viewedRevisionId="revision-2"
          viewedRevisionState="proposed"
          specAbandoned={false}
          humanTransport
          placements={nextPlacements}
          label="Invalid review threads"
        />
      </QueryClientProvider>
    );
    const view = render(renderWith(invalidPlacements()));

    await waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        "spec_studio.comment.invalid_thread",
        {
          specId: "spec-1",
          threadId: "invalid",
          integrity: "multiple-roots",
          rowIds: ["invalid-root-one", "invalid-root-two"],
        },
      ),
    );
    view.rerender(renderWith(invalidPlacements()));
    expect(log.warn).toHaveBeenCalledOnce();

    view.rerender(renderWith(invalidPlacements(true)));
    await waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2));
  });

  it("posts a reply, waits for detail refetch, and logs only safe identifiers", async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByText("Root one");
    const initialReads = requests.detailReads;
    const firstThread = screen.getByTestId("review-thread-one");
    await user.click(
      within(firstThread).getByRole("button", { name: "Reply" }),
    );
    await user.type(
      within(firstThread).getByRole("textbox", {
        name: "Reply to review thread",
      }),
      "Secret reply body",
    );
    await user.click(
      within(firstThread).getByRole("button", { name: "Send reply" }),
    );

    expect(await within(firstThread).findByRole("status")).toHaveTextContent(
      "Reply added",
    );
    expect(requests.detailReads).toBeGreaterThan(initialReads);
    expect(requests.bodies[0]).toEqual({
      url: "/api/specs/project/spec/actions/reply",
      body: { threadId: "one", body: "Secret reply body" },
    });
    expect(log.info).toHaveBeenCalledWith(
      "spec_studio.comment.reply.completed",
      { specId: "spec-1", threadId: "one", commentId: "reply-1" },
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(
      "Secret reply body",
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(
      "durable feedback",
    );
  });

  it("surfaces a malformed reply response without dropping local text", async () => {
    const user = userEvent.setup();
    requests.malformedReply = true;
    renderList();
    const firstThread = await screen.findByTestId("review-thread-one");
    await user.click(
      within(firstThread).getByRole("button", { name: "Reply" }),
    );
    const input = within(firstThread).getByRole("textbox", {
      name: "Reply to review thread",
    });
    await user.type(input, "Retain malformed response draft");
    await user.click(
      within(firstThread).getByRole("button", { name: "Send reply" }),
    );

    expect(await within(firstThread).findByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("Retain malformed response draft");
    expect(log.warn).toHaveBeenCalledWith(
      "spec_studio.comment.reply.failed",
      expect.objectContaining({ specId: "spec-1", threadId: "one" }),
    );
  });

  it("resolves with the root revision, focuses the article, and logs success or failure safely", async () => {
    const user = userEvent.setup();
    renderList();
    const firstThread = await screen.findByTestId("review-thread-one");
    await user.click(
      within(firstThread).getByRole("button", { name: "Resolve" }),
    );

    expect(requests.bodies[0]).toEqual({
      url: "/api/specs/project/spec/actions/resolve-thread",
      body: {
        revisionId: "revision-2",
        threadId: "one",
        resolution: "resolved",
      },
    });
    expect(firstThread).toHaveFocus();
    expect(log.info).toHaveBeenCalledWith(
      "spec_studio.comment.resolve.completed",
      {
        specId: "spec-1",
        revisionId: "revision-2",
        threadId: "one",
        updatedRowCount: 1,
      },
    );

    requests.failResolve = true;
    await user.click(
      within(firstThread).getByRole("button", { name: "Resolve" }),
    );
    expect(await within(firstThread).findByRole("alert")).toHaveTextContent(
      "Resolve refused",
    );
    expect(log.warn).toHaveBeenCalledWith(
      "spec_studio.comment.resolve.failed",
      expect.objectContaining({
        specId: "spec-1",
        revisionId: "revision-2",
        threadId: "one",
      }),
    );
  });
});
