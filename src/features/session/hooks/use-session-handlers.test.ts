// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionHandlers } from "./use-session-handlers";
import { useToastStoreForTesting } from "@/stores/toast.store";
import type { SessionState } from "@/lib/sessions/schemas";

/**
 * `useSessionHandlers` calls `useGraphWorkflowExecutionQuery` (to source the
 * active execution for the Copy Context payload), so the hook must render under
 * a QueryClientProvider. The query never resolves in these tests — buildContext
 * tolerates an undefined execution.
 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

const fakeSession: SessionState = {
  sessionName: "s",
  worktreePath: "/tmp/w",
  branchName: "csm/s",
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  archived: false,
  finished: false,
  conversations: [],
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  targetBranch: "main",
  parentSessionName: null,
  referenceDocuments: [],
};

describe("useSessionHandlers", () => {
  it("exposes the expected handler surface and handleAnswerSubmit calls clearQuestions on ok", async () => {
    const clearQuestions = vi.fn();
    const failPrompt = vi.fn();
    const answerMutation = {
      mutateAsync: vi.fn(async () => ({ status: "ok" as const })),
    };
    const deleteMutation = { mutate: vi.fn() };
    const forkMutation = {
      mutateAsync: vi.fn(async () => ({ conversationId: "new" })),
    };
    const router = { push: vi.fn(), replace: vi.fn() } as never;

    const { result } = renderHook(
      () =>
        useSessionHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: fakeSession,
          router,
          answerMutation,
          deleteMutation,
          forkMutation,
          cancelDelete: () => {},
          clearQuestions,
          failPrompt,
        }),
      { wrapper },
    );

    expect(typeof result.current.handleAnswerSubmit).toBe("function");
    expect(typeof result.current.handleDelete).toBe("function");
    expect(typeof result.current.handleFork).toBe("function");
    expect(typeof result.current.buildContext).toBe("function");

    const answers = {
      q1: { selected: ["yes"], note: null, skipped: false },
    };
    await act(async () => {
      await result.current.handleAnswerSubmit("q1", answers);
    });
    expect(answerMutation.mutateAsync).toHaveBeenCalledWith({
      questionId: "q1",
      answers,
    });
    expect(clearQuestions).toHaveBeenCalledTimes(1);
    expect(failPrompt).not.toHaveBeenCalled();
  });

  it("handleFork routes through onOpenConversation when provided and never router.push", async () => {
    const onOpenConversation = vi.fn();
    const push = vi.fn();
    const router = { push, replace: vi.fn() } as never;
    const forkMutation = {
      mutateAsync: vi.fn(async () => ({ conversationId: "forked-1" })),
    };

    const { result } = renderHook(
      () =>
        useSessionHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: fakeSession,
          router,
          answerMutation: { mutateAsync: async () => ({ status: "ok" }) },
          deleteMutation: { mutate: () => {} },
          forkMutation,
          cancelDelete: () => {},
          clearQuestions: () => {},
          failPrompt: () => {},
          onOpenConversation,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleFork(3);
    });

    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(onOpenConversation).toHaveBeenCalledWith({
      conversationId: "forked-1",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("handleFork falls back to router.push to the per-conversation URL when the seam is absent", async () => {
    const push = vi.fn();
    const router = { push, replace: vi.fn() } as never;

    const { result } = renderHook(
      () =>
        useSessionHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: fakeSession,
          router,
          answerMutation: { mutateAsync: async () => ({ status: "ok" }) },
          deleteMutation: { mutate: () => {} },
          forkMutation: {
            mutateAsync: async () => ({ conversationId: "forked-1" }),
          },
          cancelDelete: () => {},
          clearQuestions: () => {},
          failPrompt: () => {},
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.handleFork(3);
    });

    expect(push).toHaveBeenCalledWith("/conversations?c=forked-1");
  });

  it("buildContext returns null when session is undefined", () => {
    const router = { push: vi.fn(), replace: vi.fn() } as never;
    const { result } = renderHook(
      () =>
        useSessionHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: undefined,
          router,
          answerMutation: { mutateAsync: async () => ({ status: "ok" }) },
          deleteMutation: { mutate: () => {} },
          forkMutation: {
            mutateAsync: async () => ({ conversationId: "x" }),
          },
          cancelDelete: () => {},
          clearQuestions: () => {},
          failPrompt: () => {},
        }),
      { wrapper },
    );
    expect(result.current.buildContext()).toBeNull();
  });

  it("tells the person why the session was not deleted", () => {
    useToastStoreForTesting.setState({ toasts: [] });
    const deleteMutation = {
      mutate: (
        _sessionName: string,
        options?: { onError?: (error: Error) => void },
      ) => options?.onError?.(new Error('Run run-1 is paused in session "s".')),
    };
    const { result } = renderHook(
      () =>
        useSessionHandlers({
          projectName: "p",
          sessionName: "s",
          conversationId: "c",
          session: fakeSession,
          router: { push: vi.fn(), replace: vi.fn() } as never,
          answerMutation: { mutateAsync: async () => ({ status: "ok" }) },
          deleteMutation,
          forkMutation: {
            mutateAsync: async () => ({ conversationId: "new" }),
          },
          cancelDelete: () => {},
          clearQuestions: () => {},
          failPrompt: () => {},
        }),
      { wrapper },
    );

    act(() => result.current.handleDelete());

    expect(
      useToastStoreForTesting
        .getState()
        .toasts.some((toast) =>
          toast.message.includes('Run run-1 is paused in session "s"'),
        ),
    ).toBe(true);
  });
});
