// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  classifyDocumentContentError,
  useDocumentContentQuery,
  useMarkdownDocumentsQuery,
} from "./queries";
import { documentContentKeys } from "./query-keys";
import { ApiCallError } from "@/lib/api/errors";

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

describe("useDocumentContentQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the content and normalized docPath for a valid path", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ content: "# Title\n\nbody", docPath: "docs/spec.md" }),
    );

    const { result } = renderHook(
      () => useDocumentContentQuery("proj", "sess", "docs/spec.md"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.content).toBe("# Title\n\nbody");
    expect(result.current.data?.docPath).toBe("docs/spec.md");

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "/api/projects/proj/sessions/sess/document-content?path=docs%2Fspec.md",
    );
  });

  it("surfaces a distinct unavailable error state when the path is unreadable/out-of-worktree (404)", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Document file not found" }, 404),
    );

    const { result } = renderHook(
      () => useDocumentContentQuery("proj", "sess", "../outside.md"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(classifyDocumentContentError(result.current.error)).toBe(
      "unavailable",
    );
  });

  it("surfaces a distinct invalid error state for a non-markdown/traversal path (400)", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Invalid path: non-markdown" }, 400),
    );

    const { result } = renderHook(
      () => useDocumentContentQuery("proj", "sess", "notes.txt"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(classifyDocumentContentError(result.current.error)).toBe("invalid");
  });

  it("does not fetch while the document path is null (disabled)", () => {
    const { result } = renderHook(
      () => useDocumentContentQuery("proj", "sess", null),
      { wrapper: wrapperFor(makeClient()) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keys the cache by document path", () => {
    expect(documentContentKeys.content("proj", "sess", "a.md")).not.toEqual(
      documentContentKeys.content("proj", "sess", "b.md"),
    );
  });
});

describe("useMarkdownDocumentsQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the session-scoped unified Markdown list", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        {
          docPath: "docs/plan.md",
          title: "plan.md",
          origin: "edit",
          firstSeenAt: "2026-07-11T10:00:00.000Z",
          lastSeenAt: "2026-07-11T11:00:00.000Z",
          location: "worktree",
          registered: false,
          description: null,
        },
      ]),
    );

    const { result } = renderHook(
      () => useMarkdownDocumentsQuery("proj", "sess"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.docPath).toBe("docs/plan.md");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "/api/projects/proj/sessions/sess/markdown-documents",
    );
  });
});

describe("classifyDocumentContentError", () => {
  it("maps 404 to unavailable, 400 to invalid, and everything else to error", () => {
    expect(
      classifyDocumentContentError(
        new ApiCallError("x", undefined, undefined, undefined, 404),
      ),
    ).toBe("unavailable");
    expect(
      classifyDocumentContentError(
        new ApiCallError("x", undefined, undefined, undefined, 400),
      ),
    ).toBe("invalid");
    expect(
      classifyDocumentContentError(
        new ApiCallError("x", undefined, undefined, undefined, 500),
      ),
    ).toBe("error");
    expect(classifyDocumentContentError(new Error("network down"))).toBe(
      "error",
    );
    expect(classifyDocumentContentError(null)).toBe("error");
  });
});
