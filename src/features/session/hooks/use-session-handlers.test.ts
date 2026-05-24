// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useSessionHandlers } from "./use-session-handlers";
import type { SessionState } from "@/lib/sessions/schemas";

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
  objective: null,
  creationMode: "fast",
  tddEnabled: true,
  targetBranch: "main",
  parentSessionName: null,
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
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

    const { result } = renderHook(() =>
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
    );

    expect(typeof result.current.handleAnswerSubmit).toBe("function");
    expect(typeof result.current.handleDelete).toBe("function");
    expect(typeof result.current.handleFork).toBe("function");
    expect(typeof result.current.buildContext).toBe("function");

    await act(async () => {
      await result.current.handleAnswerSubmit("q1", { q1: "yes" });
    });
    expect(answerMutation.mutateAsync).toHaveBeenCalledWith({
      questionId: "q1",
      answers: { q1: "yes" },
    });
    expect(clearQuestions).toHaveBeenCalledTimes(1);
    expect(failPrompt).not.toHaveBeenCalled();
  });

  it("buildContext returns null when session is undefined", () => {
    const router = { push: vi.fn(), replace: vi.fn() } as never;
    const { result } = renderHook(() =>
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
    );
    expect(result.current.buildContext()).toBeNull();
  });
});
