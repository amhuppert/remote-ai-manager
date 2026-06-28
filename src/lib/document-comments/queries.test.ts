// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useDocumentCommentsQuery } from "./queries";
import { documentCommentKeys } from "./query-keys";
import type { DocumentComment } from "./schemas";

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

function comment(
  overrides: Partial<DocumentComment> & { id: string },
): DocumentComment {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/abs/project",
    sessionName: overrides.sessionName ?? "sess",
    docPath: overrides.docPath ?? "docs/spec.md",
    anchor: overrides.anchor ?? {
      sectionId: "overview",
      headingLabel: "1. Overview",
      line: 3,
      charStart: 0,
      charEnd: 5,
      quote: "Hello",
      prefix: "",
      suffix: " world",
      docRevision: "rev-1",
    },
    note: overrides.note ?? "a note",
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2025-01-01T00:00:00.000Z",
    sentAt: overrides.sentAt ?? null,
  };
}

describe("useDocumentCommentsQuery", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and parses the comment list for a document path", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([
        comment({ id: "c1" }),
        comment({ id: "c2", status: "sent" }),
      ]),
    );

    const { result } = renderHook(
      () => useDocumentCommentsQuery("proj", "sess", "docs/spec.md"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0]?.id).toBe("c1");

    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain(
      "/api/projects/proj/sessions/sess/document-comments?docPath=docs%2Fspec.md",
    );
  });

  it("does not fetch while the document path is null (disabled)", () => {
    const { result } = renderHook(
      () => useDocumentCommentsQuery("proj", "sess", null),
      { wrapper: wrapperFor(makeClient()) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keys the cache by document path", () => {
    expect(documentCommentKeys.list("proj", "sess", "docs/a.md")).not.toEqual(
      documentCommentKeys.list("proj", "sess", "docs/b.md"),
    );
  });
});
