// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ContextArtifactPanel from "./ContextArtifactPanel";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import {
  buildArtifactDetail,
  buildArtifactListItem,
  buildMaximalEnvelope,
} from "@/components/context-artifacts/fixtures";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const LIST_URL =
  "/api/projects/p1/sessions/s1/conversations/c1/context-artifacts";

function conversationRow(
  overrides: Partial<ContextArtifactListItem> = {},
): ContextArtifactListItem {
  return buildArtifactListItem({
    kind: "conversation_compaction",
    messageIndex: null,
    messageId: null,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

/** Routes list/detail GETs from fixtures; POST/DELETE resolve generically. */
function stubApi(rows: ContextArtifactListItem[]) {
  fetchSpy.mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      return Promise.resolve(
        jsonResponse({ artifactId: "art-1", status: "pending" }, 202),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(jsonResponse({ deleted: true }));
    }
    if (url === LIST_URL) return Promise.resolve(jsonResponse(rows));
    return Promise.resolve(
      jsonResponse(
        buildArtifactDetail({
          kind: "conversation_compaction",
          messageIndex: null,
          messageId: null,
          payload: buildMaximalEnvelope(),
        }),
      ),
    );
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof ContextArtifactPanel>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContextArtifactPanel target={target} {...props} />
    </QueryClientProvider>,
  );
}

describe("ContextArtifactPanel", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("empty: invites compaction and POSTs create_or_refresh on activation", async () => {
    stubApi([]);
    renderPanel();
    const compactButton = await screen.findByRole("button", {
      name: /compact conversation/i,
    });
    fireEvent.click(compactButton);

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const postCall = fetchSpy.mock.calls.find(
      (call) => call[1]?.method === "POST",
    );
    expect(String(postCall?.[0])).toBe(LIST_URL);
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      kind: "conversation_compaction",
      mode: "create_or_refresh",
    });
  });

  it("pending: shows the Compacting… state", async () => {
    stubApi([conversationRow({ status: "pending" })]);
    renderPanel();
    expect(await screen.findByText("Compacting…")).toBeInTheDocument();
  });

  it("failed: surfaces the stored error with a retry action that re-POSTs", async () => {
    stubApi([
      conversationRow({
        status: "failed",
        error: "transcript_too_large_for_single_pass",
      }),
    ]);
    renderPanel();
    expect(
      await screen.findByText(/transcript_too_large_for_single_pass/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
  });

  it("complete: renders the envelope sections and provenance", async () => {
    stubApi([conversationRow()]);
    renderPanel();

    expect(
      await screen.findByText(
        /Implemented the context_artifacts storage layer/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent brief")).toBeInTheDocument();
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.getByText("Open questions")).toBeInTheDocument();
    expect(screen.getByText("Blockers")).toBeInTheDocument();
    // Coverage footer + provenance line from the fetched row.
    expect(screen.getByText(/coverage seq 0–421/)).toBeInTheDocument();
    expect(screen.getByText(/claude · sonnet · medium/)).toBeInTheDocument();
  });

  it("complete: a source-ref chip files a transcript nav request for this conversation", async () => {
    stubApi([conversationRow()]);
    renderPanel();
    await screen.findByText("Agent brief");

    fireEvent.click(
      screen.getAllByRole("button", { name: /go to message 5/i })[0]!,
    );

    expect(useSessionDetailStore.getState().messageNavRequest).toEqual({
      conversationId: "c1",
      messageIndex: 5,
    });
  });

  it("complete + stale: shows the staleness note and a Refresh action", async () => {
    stubApi([conversationRow({ stale: true, staleBehindMessages: 6 })]);
    renderPanel();
    expect(await screen.findByText(/behind 6 messages/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /refresh/i }),
    ).toBeInTheDocument();
  });

  it("complete + outdated: refresh POSTs with force", async () => {
    stubApi([conversationRow({ outdated: true })]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /refresh/i }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const postCall = fetchSpy.mock.calls.find(
      (call) => call[1]?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      force: true,
    });
  });

  it("delete: DELETEs the artifact", async () => {
    stubApi([conversationRow()]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((call) => call[1]?.method === "DELETE"),
      ).toBe(true),
    );
    const deleteCall = fetchSpy.mock.calls.find(
      (call) => call[1]?.method === "DELETE",
    );
    expect(String(deleteCall?.[0])).toBe(`${LIST_URL}/art-1`);
  });

  it("shows the archived badge when the conversation is archived", async () => {
    stubApi([conversationRow()]);
    renderPanel({ archived: true, conversationName: "auth-refactor" });
    expect(await screen.findByText("archived")).toBeInTheDocument();
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
  });
});
