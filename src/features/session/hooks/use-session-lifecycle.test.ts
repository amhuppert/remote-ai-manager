// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { panelSessionKeyFor } from "@/stores/session-detail.store";
import {
  useSessionLifecycle,
  autoFocusStrippedUrl,
  type UseSessionLifecycleArgs,
} from "./use-session-lifecycle";

const ts = "2026-01-01T00:00:00.000Z";

function sessionWithConversation(
  conversation: Record<string, unknown>,
): SessionState {
  return sessionStateSchema.parse({
    sessionName: "sess",
    worktreePath: "/repo/.worktrees/sess",
    branchName: "csm/sess",
    createdAt: ts,
    lastActivityAt: ts,
    conversations: [
      {
        id: "c",
        scope: "session",
        transcriptPath: null,
        promptCount: 1,
        createdAt: ts,
        lastActivityAt: ts,
        ...conversation,
      },
    ],
  });
}

const PENDING_QUESTIONS = [
  { id: "q0", question: "Which?", options: [{ label: "A" }] },
];

function makeArgs(
  overrides: Partial<UseSessionLifecycleArgs> = {},
): UseSessionLifecycleArgs {
  return {
    resetConversationState: vi.fn(),
    clearDraftComposerState: vi.fn(),
    clearConversationMessages: vi.fn(),
    activatePanelSession: vi.fn(),
    projectName: "proj",
    sessionName: "sess",
    conversationId: "c",
    session: undefined,
    pendingQuestionId: null,
    showQuestions: vi.fn(),
    clearQuestions: vi.fn(),
    ...overrides,
  };
}

describe("useSessionLifecycle", () => {
  it("clears conversation messages on mount", () => {
    const args = makeArgs();
    renderHook(() => useSessionLifecycle(args));
    expect(args.clearConversationMessages).toHaveBeenCalled();
    expect(args.showQuestions).not.toHaveBeenCalled();
  });

  it("resets conversation and draft composer state when the active conversation changes, not on initial mount", () => {
    const resetConversationState = vi.fn();
    const clearDraftComposerState = vi.fn();
    const { rerender } = renderHook(
      (props: UseSessionLifecycleArgs) => useSessionLifecycle(props),
      {
        initialProps: makeArgs({
          conversationId: "a",
          resetConversationState,
          clearDraftComposerState,
        }),
      },
    );

    // The workspace is not remounted per conversation; the first mount has no
    // prior conversation to leave, so nothing is reset yet.
    expect(resetConversationState).not.toHaveBeenCalled();
    expect(clearDraftComposerState).not.toHaveBeenCalled();

    rerender(
      makeArgs({
        conversationId: "b",
        resetConversationState,
        clearDraftComposerState,
      }),
    );

    // Switching the active conversation runs the leave-cleanup exactly once.
    expect(resetConversationState).toHaveBeenCalledTimes(1);
    expect(clearDraftComposerState).toHaveBeenCalledTimes(1);
  });

  it("activates the panel session for the workspace's session identity", () => {
    const activatePanelSession = vi.fn();
    const { rerender } = renderHook(
      (props: UseSessionLifecycleArgs) => useSessionLifecycle(props),
      {
        initialProps: makeArgs({
          projectName: "proj",
          sessionName: "sess-a",
          conversationId: "a1",
          activatePanelSession,
        }),
      },
    );
    expect(activatePanelSession).toHaveBeenCalledTimes(1);
    expect(activatePanelSession).toHaveBeenCalledWith(
      panelSessionKeyFor("proj", "sess-a"),
    );

    // Conversation switches within the same session leave the panel alone.
    rerender(
      makeArgs({
        projectName: "proj",
        sessionName: "sess-a",
        conversationId: "a2",
        activatePanelSession,
      }),
    );
    expect(activatePanelSession).toHaveBeenCalledTimes(1);

    // A cross-session switch re-activates with the new session's key.
    rerender(
      makeArgs({
        projectName: "proj",
        sessionName: "sess-b",
        conversationId: "b1",
        activatePanelSession,
      }),
    );
    expect(activatePanelSession).toHaveBeenCalledTimes(2);
    expect(activatePanelSession).toHaveBeenLastCalledWith(
      panelSessionKeyFor("proj", "sess-b"),
    );
  });
});

describe("useSessionLifecycle — pending-question lifecycle (async ask)", () => {
  it("hydrates the store from persisted pending state while waiting_for_input", () => {
    const showQuestions = vi.fn();
    const args = makeArgs({
      session: sessionWithConversation({
        status: "waiting_for_input",
        pendingQuestionId: "q_b1",
        pendingQuestions: PENDING_QUESTIONS,
      }),
      pendingQuestionId: null,
      showQuestions,
    });
    renderHook(() => useSessionLifecycle(args));
    expect(showQuestions).toHaveBeenCalledWith(
      "q_b1",
      expect.arrayContaining([expect.objectContaining({ question: "Which?" })]),
    );
  });

  it("keeps the shown question while the conversation stays waiting_for_input (question survives turn end)", () => {
    // After the asking turn finalizes, status REMAINS waiting_for_input — the
    // question must not be cleared just because the turn ended.
    const clearQuestions = vi.fn();
    const args = makeArgs({
      session: sessionWithConversation({
        status: "waiting_for_input",
        pendingQuestionId: "q_b1",
        pendingQuestions: PENDING_QUESTIONS,
      }),
      pendingQuestionId: "q_b1",
      clearQuestions,
    });
    renderHook(() => useSessionLifecycle(args));
    expect(clearQuestions).not.toHaveBeenCalled();
  });

  it("clears the shown question when the status leaves waiting_for_input (answered elsewhere or superseded)", () => {
    const clearQuestions = vi.fn();
    const args = makeArgs({
      session: sessionWithConversation({ status: "running" }),
      pendingQuestionId: "q_b1",
      clearQuestions,
    });
    renderHook(() => useSessionLifecycle(args));
    expect(clearQuestions).toHaveBeenCalled();
  });
});

describe("autoFocusStrippedUrl", () => {
  it("removes autoFocus and keeps the path and other params", () => {
    expect(
      autoFocusStrippedUrl({
        pathname: "/conversations",
        search: "?c=x&autoFocus=true&debug=1",
      }),
    ).toBe("/conversations?c=x&debug=1");
  });

  it("drops the query string entirely when autoFocus was the only param", () => {
    expect(
      autoFocusStrippedUrl({
        pathname: "/conversations",
        search: "?autoFocus=true",
      }),
    ).toBe("/conversations");
  });
});
