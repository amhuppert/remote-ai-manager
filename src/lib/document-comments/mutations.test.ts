// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useCreateDocumentCommentMutation,
  useUpdateDocumentCommentMutation,
  useDeleteDocumentCommentMutation,
} from "./mutations";
import { documentCommentKeys } from "./query-keys";
import type { CommentAnchor, DocumentComment } from "./schemas";

const PROJECT = "proj";
const SESSION = "sess";
const DOC = "docs/spec.md";
const LIST_KEY = documentCommentKeys.list(PROJECT, SESSION, DOC);

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const anchor: CommentAnchor = {
  sectionId: "overview",
  headingLabel: "1. Overview",
  line: 3,
  charStart: 0,
  charEnd: 5,
  quote: "Hello",
  prefix: "",
  suffix: " world",
  docRevision: "rev-1",
};

function comment(
  overrides: Partial<DocumentComment> & { id: string },
): DocumentComment {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/abs/project",
    sessionName: overrides.sessionName ?? SESSION,
    docPath: overrides.docPath ?? DOC,
    anchor: overrides.anchor ?? anchor,
    note: overrides.note ?? "a note",
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2025-01-01T00:00:00.000Z",
    sentAt: overrides.sentAt ?? null,
  };
}

function readList(client: QueryClient): DocumentComment[] | undefined {
  return client.getQueryData<DocumentComment[]>(LIST_KEY);
}

describe("useCreateDocumentCommentMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("optimistically appends a pending comment before the server resolves, then reconciles to the persisted comment", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [comment({ id: "existing" })]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useCreateDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ anchor, note: "new note" });

    // Optimistic: list grows to 2 with a pending comment carrying the note,
    // before the POST resolves.
    await waitFor(() => expect(readList(client)).toHaveLength(2));
    const optimistic = readList(client)?.[1];
    expect(optimistic?.note).toBe("new note");
    expect(optimistic?.status).toBe("pending");

    // Server returns the canonical persisted comment (real id + projectPath).
    resolveFetch(
      jsonResponse(comment({ id: "server-id", note: "new note" }), 201),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const ids = readList(client)?.map((c) => c.id);
    expect(ids).toContain("server-id");
    expect(ids).not.toContain("existing-optimistic");
    expect(readList(client)).toHaveLength(2);
  });

  it("rolls back the optimistic comment when the server rejects", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [comment({ id: "existing" })]);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useCreateDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ anchor, note: "doomed" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readList(client)).toHaveLength(1);
    expect(readList(client)?.[0]?.id).toBe("existing");
  });
});

describe("useUpdateDocumentCommentMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("optimistically reflects a status change to sent before the server resolves", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [comment({ id: "c1", status: "pending" })]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useUpdateDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ id: "c1", status: "sent" });

    await waitFor(() => expect(readList(client)?.[0]?.status).toBe("sent"));
    expect(readList(client)?.[0]?.sentAt).not.toBeNull();

    resolveFetch(
      jsonResponse(
        comment({
          id: "c1",
          status: "sent",
          sentAt: "2025-02-02T00:00:00.000Z",
        }),
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(readList(client)?.[0]?.status).toBe("sent");
  });

  it("optimistically updates the note and rolls back on failure", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [comment({ id: "c1", note: "original" })]);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useUpdateDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate({ id: "c1", note: "edited" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readList(client)?.[0]?.note).toBe("original");
  });
});

describe("useDeleteDocumentCommentMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("optimistically removes the comment before the server resolves", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [
      comment({ id: "c1" }),
      comment({ id: "c2" }),
    ]);

    let resolveFetch: (res: Response) => void = () => {};
    fetchSpy.mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );

    const { result } = renderHook(
      () => useDeleteDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("c1");

    await waitFor(() => expect(readList(client)).toHaveLength(1));
    expect(readList(client)?.[0]?.id).toBe("c2");

    resolveFetch(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores the comment when the delete fails", async () => {
    const client = makeClient();
    client.setQueryData(LIST_KEY, [
      comment({ id: "c1" }),
      comment({ id: "c2" }),
    ]);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useDeleteDocumentCommentMutation(PROJECT, SESSION, DOC),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("c1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readList(client)?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
