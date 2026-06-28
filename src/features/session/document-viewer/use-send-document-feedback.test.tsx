// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useSendDocumentFeedback,
  buildFeedbackItems,
} from "./use-send-document-feedback";
import type {
  CommentAnchor,
  DocumentComment,
} from "@/lib/document-comments/schemas";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";
import type { DocumentRef } from "@/lib/document-comments/schemas";

const DOC_REF: DocumentRef = {
  projectName: "doc-proj",
  sessionName: "doc-sess",
  docPath: "design.md",
  title: "Design",
};

function target(
  overrides: Partial<DocumentFeedbackTarget> = {},
): DocumentFeedbackTarget {
  return {
    projectName: "t-proj",
    projectPath: "/abs/t-proj",
    sessionName: "t-sess",
    conversationId: "conv-1",
    backend: "claude",
    status: "awaiting",
    ...overrides,
  };
}

const anchor: CommentAnchor = {
  sectionId: "overview",
  headingLabel: "1. Overview",
  line: 7,
  charStart: 0,
  charEnd: 5,
  quote: "Hello",
  prefix: "",
  suffix: "",
  docRevision: "rev-1",
};

function cmt(
  overrides: Partial<DocumentComment> & { id: string },
): DocumentComment {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/abs/doc-proj",
    sessionName: overrides.sessionName ?? "doc-sess",
    docPath: overrides.docPath ?? "design.md",
    anchor: overrides.anchor ?? anchor,
    note: overrides.note ?? "Please clarify this.",
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    sentAt: overrides.sentAt ?? null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A successful comment mutation response (the DELETE issued after a send). */
function commentMutationOk(): Response {
  return jsonResponse({ ok: true });
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

const fetchSpy = vi.fn<typeof fetch>();

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function callsTo(substr: string): unknown[][] {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).includes(substr));
}

describe("buildFeedbackItems", () => {
  it("includes the quote, path, heading, line, and note per comment", () => {
    const items = buildFeedbackItems([cmt({ id: "a", note: "fix this" })]);
    expect(items).toEqual([
      {
        docPath: "design.md",
        path: "design.md",
        headingLabel: "1. Overview",
        line: 7,
        quote: "Hello",
        note: "fix this",
      },
    ]);
  });
});

describe("useSendDocumentFeedback", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends immediately to an idle target's own conversation and deletes the comments after sending", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/document-comments/")) return commentMutationOk();
      return new Response("", { status: 200 });
    });

    const { result } = renderHook(
      () => useSendDocumentFeedback({ docRef: DOC_REF, target: target() }),
      { wrapper: wrapper() },
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.sendFeedback([
        cmt({ id: "c1" }),
        cmt({ id: "c2" }),
      ]);
    });
    expect(ok).toBe(true);

    const promptCalls = callsTo(
      "/projects/t-proj/sessions/t-sess/conversations/conv-1/prompt",
    );
    expect(promptCalls).toHaveLength(1);
    const body = bodyOf(promptCalls[0]!);
    // The agent-facing text carries quote + path + heading + line + note (8.1).
    expect(String(body["prompt"])).toContain("Hello");
    expect(String(body["prompt"])).toContain("design.md");
    expect(String(body["prompt"])).toContain("1. Overview");
    expect(String(body["prompt"])).toContain("Please clarify this.");
    // Structured payload threaded for the transcript card path (group 7).
    expect(body["documentFeedback"]).toMatchObject({
      items: expect.any(Array),
    });

    // Both comments are DELETEd after a successful send (sent comments are
    // auto-removed so they no longer clutter the document), against the
    // document's own scope.
    const del1 = callsTo(
      "/projects/doc-proj/sessions/doc-sess/document-comments/c1",
    );
    const del2 = callsTo(
      "/projects/doc-proj/sessions/doc-sess/document-comments/c2",
    );
    expect(del1).toHaveLength(1);
    expect(del2).toHaveLength(1);
    expect((del1[0]![1] as RequestInit).method).toBe("DELETE");
    expect((del2[0]![1] as RequestInit).method).toBe("DELETE");
    // It never touches the mounted view: no session-scoped or other prompt POST.
    expect(callsTo("/conversations/conv-1/queue")).toHaveLength(0);
  });

  it("queues when the target is running (8.4)", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/document-comments/")) return commentMutationOk();
      if (url.includes("/queue")) return jsonResponse({ queued: true }, 202);
      return new Response("", { status: 200 });
    });

    const { result } = renderHook(
      () =>
        useSendDocumentFeedback({
          docRef: DOC_REF,
          target: target({ status: "running" }),
        }),
      { wrapper: wrapper() },
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.sendFeedback([cmt({ id: "c1" })]);
    });
    expect(ok).toBe(true);
    expect(callsTo("/conversations/conv-1/queue")).toHaveLength(1);
    expect(callsTo("/conversations/conv-1/prompt")).toHaveLength(0);
    expect(callsTo("/document-comments/c1")).toHaveLength(1);
  });

  it("falls back to queue when an immediate send races a now-running target", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/document-comments/")) return commentMutationOk();
      if (url.includes("/queue")) return jsonResponse({ queued: true }, 202);
      if (url.includes("/prompt")) {
        return jsonResponse(
          { error: "Conversation is busy", code: "CONVERSATION_BUSY" },
          409,
        );
      }
      return new Response("", { status: 200 });
    });

    const { result } = renderHook(
      () => useSendDocumentFeedback({ docRef: DOC_REF, target: target() }),
      { wrapper: wrapper() },
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.sendFeedback([cmt({ id: "c1" })]);
    });
    expect(ok).toBe(true);
    expect(callsTo("/conversations/conv-1/prompt")).toHaveLength(1);
    expect(callsTo("/conversations/conv-1/queue")).toHaveLength(1);
    expect(callsTo("/document-comments/c1")).toHaveLength(1);
  });

  it("starts a new conversation in the document's session when no target exists (9.5)", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/document-comments/")) return commentMutationOk();
      return new Response("", { status: 200 });
    });

    const { result } = renderHook(
      () => useSendDocumentFeedback({ docRef: DOC_REF, target: null }),
      { wrapper: wrapper() },
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.sendFeedback([cmt({ id: "c1" })]);
    });
    expect(ok).toBe(true);
    const sessionPrompt = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).endsWith("/projects/doc-proj/sessions/doc-sess/prompt"),
    );
    expect(sessionPrompt).toHaveLength(1);
    expect(callsTo("/document-comments/c1")).toHaveLength(1);
  });

  it("keeps comments pending and surfaces the error when sending fails (8.5)", async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/document-comments/")) return commentMutationOk();
      return jsonResponse({ error: "Project not found" }, 404);
    });

    const { result } = renderHook(
      () => useSendDocumentFeedback({ docRef: DOC_REF, target: target() }),
      { wrapper: wrapper() },
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.sendFeedback([cmt({ id: "c1" })]);
    });
    expect(ok).toBe(false);
    // No comment was marked sent.
    expect(callsTo("/document-comments/c1")).toHaveLength(0);
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toContain("Project not found");
  });
});
