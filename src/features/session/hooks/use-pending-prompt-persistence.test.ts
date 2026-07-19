// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import React, { useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { usePendingPromptPersistence } from "./use-pending-prompt-persistence";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { createPendingPromptRouteHandlers } from "@/lib/prompt/route-handlers";

function wrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  Wrapper.displayName = "TestWrapper";
  return Wrapper;
}

describe("usePendingPromptPersistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns handlePromptTextChange and submit autosave suppression callbacks", () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const { result } = renderHook(
      () => {
        const promptTextRef = useRef("");
        const editorRef = useRef(null);
        return usePendingPromptPersistence({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          activeConversation: undefined,
          promptText: "",
          setPromptText: () => {},
          promptTextRef,
          editorRef,
        });
      },
      { wrapper: wrapper(client) },
    );
    expect(typeof result.current.handlePromptTextChange).toBe("function");
    expect(typeof result.current.suppressPendingPromptAutosaveAfterSubmit).toBe(
      "function",
    );
  });

  it("hydrates persisted Markdown as rich editor content without treating it as HTML", async () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const editor = new Editor({
      extensions: [StarterKit],
      content: "",
    });
    const editorHandle: PromptEditorHandle = {
      editor,
      serialize: () => ({ prompt: "", images: [] }),
      clear: () => {},
      focus: () => {},
      insertText: () => {},
    };
    const pendingPromptText =
      "before\n```ts\nconst value = '<literal>';\n```\nafter";
    const activeConversation = {
      id: "c",
      pendingPromptText,
    } as ConversationState;

    const { result } = renderHook(
      () => {
        const [promptText, setPromptText] = useState("");
        const promptTextRef = useRef(promptText);
        promptTextRef.current = promptText;
        const editorRef = useRef<PromptEditorHandle | null>(editorHandle);
        usePendingPromptPersistence({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          activeConversation,
          promptText,
          setPromptText,
          promptTextRef,
          editorRef,
        });
        return { promptText };
      },
      { wrapper: wrapper(client) },
    );

    await waitFor(() =>
      expect(result.current.promptText).toBe(pendingPromptText),
    );
    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "before" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const value = '<literal>';" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "after" }],
        },
      ],
    });
    editor.destroy();
  });

  it("requests an immediate compare-and-clear when the prompt is submitted", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, updated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const activeConversation = {
      id: "c",
      pendingPromptText: "persisted draft",
    } as ConversationState;
    const { result } = renderHook(
      () => {
        const [promptText, setPromptText] = useState("");
        const promptTextRef = useRef(promptText);
        promptTextRef.current = promptText;
        const editorRef = useRef(null);
        const persistence = usePendingPromptPersistence({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          activeConversation,
          promptText,
          setPromptText,
          promptTextRef,
          editorRef,
        });
        return { ...persistence, promptText };
      },
      { wrapper: wrapper(client) },
    );

    await waitFor(() =>
      expect(result.current.promptText).toBe("persisted draft"),
    );
    act(() => {
      result.current.suppressPendingPromptAutosaveAfterSubmit();
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/conversations/c/pending-prompt");
    expect(JSON.parse(String(request.body))).toEqual({
      text: null,
      expectedText: "persisted draft",
    });
  });

  it("does not clear a newer draft after an accepted submit clears the local editor", async () => {
    const db = _createTestDb({ inMemory: true });
    const store = createStateStore({ db, writeQueue: createWriteQueue() });
    const projectPath = "/projects/p";
    await store.getOrCreateProject(projectPath);
    await store.mutateState("seed", (state) => {
      state.projects[projectPath]!.sessions.s = sessionStateSchema.parse({
        sessionName: "s",
        worktreePath: "/tmp/s",
        branchName: "cc/s",
        createdAt: "2026-07-13T12:00:00.000Z",
        lastActivityAt: "2026-07-13T12:00:00.000Z",
        conversations: [
          {
            id: "c",
            transcriptPath: null,
            status: "new",
            promptCount: 0,
            createdAt: "2026-07-13T12:00:00.000Z",
            lastActivityAt: "2026-07-13T12:00:00.000Z",
            pendingPromptText: "submitted draft",
          },
        ],
      });
    });
    const pendingHandlers = createPendingPromptRouteHandlers({
      resolveProjectPath: async () => projectPath,
      getSession: store.getSession,
      setConversationPendingPromptText: store.setConversationPendingPromptText,
      clearConversationPendingPromptTextIfMatches:
        store.clearConversationPendingPromptTextIfMatches,
    });
    const fetchSpy = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) =>
        pendingHandlers.POST(
          new Request(new URL(String(input), "http://test"), init),
          {
            params: Promise.resolve({
              name: "p",
              session: "s",
              conversationId: "c",
            }),
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const activeConversation = (await store.getConversation(
      projectPath,
      "s",
      "c",
    )) as ConversationState;
    const { result, unmount } = renderHook(
      () => {
        const [promptText, setPromptText] = useState("");
        const promptTextRef = useRef(promptText);
        promptTextRef.current = promptText;
        const editorRef = useRef(null);
        const persistence = usePendingPromptPersistence({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          activeConversation,
          promptText,
          setPromptText,
          promptTextRef,
          editorRef,
        });
        return { ...persistence, promptText, setPromptText };
      },
      { wrapper: wrapper(client) },
    );

    await waitFor(() =>
      expect(result.current.promptText).toBe("submitted draft"),
    );
    await store.setConversationPendingPromptText(
      projectPath,
      "s",
      "c",
      "newer draft from another client",
    );
    vi.useFakeTimers();
    act(() => {
      result.current.suppressPendingPromptAutosaveAfterSubmit();
      result.current.setPromptText("");
    });
    await act(async () => vi.runAllTimersAsync());
    unmount();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      text: null,
      expectedText: "submitted draft",
    });
    expect(
      (await store.getConversation(projectPath, "s", "c"))?.pendingPromptText,
    ).toBe("newer draft from another client");
    db.close();
  });
});
