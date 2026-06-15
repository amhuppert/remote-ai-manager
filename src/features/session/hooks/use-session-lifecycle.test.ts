// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  useSessionLifecycle,
  autoFocusStrippedUrl,
  type UseSessionLifecycleArgs,
} from "./use-session-lifecycle";

function makeArgs(
  overrides: Partial<UseSessionLifecycleArgs> = {},
): UseSessionLifecycleArgs {
  return {
    resetConversationState: vi.fn(),
    clearDraftComposerState: vi.fn(),
    clearConversationMessages: vi.fn(),
    conversationId: "c",
    session: undefined,
    pendingQuestionId: null,
    showQuestions: vi.fn(),
    clearQuestions: vi.fn(),
    autoFocus: false,
    sendPrompt: vi.fn(() => Promise.resolve()),
    messagesLength: 0,
    selectedModel: "sonnet",
    selectedEffort: "medium",
    effortSupported: true,
    selectedBackend: "claude",
    ...overrides,
  };
}

const sessionWithObjective: SessionState = {
  sessionName: "s",
  worktreePath: "/projects/repo/.worktrees/s",
  branchName: "csm/s",
  createdAt: "2026-06-01T00:00:00Z",
  lastActivityAt: "2026-06-01T00:00:00Z",
  archived: false,
  finished: false,
  targetBranch: "main",
  parentSessionName: null,
  conversations: [],
  source: "cc",
  objective: "Build the thing",
  creationMode: "focus",
  tddEnabled: false,
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
  referenceDocuments: [],
};

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

  describe("autoFocus objective kick-off", () => {
    afterEach(() => {
      window.history.replaceState(null, "", "/");
    });

    beforeEach(() => {
      window.history.replaceState(
        null,
        "",
        "/conversations?c=c&autoFocus=true&debug=1",
      );
    });

    it("strips autoFocus from the current URL shallowly and sends the objective prompt", async () => {
      const replaceStateSpy = vi.spyOn(window.history, "replaceState");
      const sendPrompt = vi.fn(() => Promise.resolve());

      renderHook(() =>
        useSessionLifecycle(
          makeArgs({
            autoFocus: true,
            session: sessionWithObjective,
            sendPrompt,
          }),
        ),
      );

      // Same-page cleanup must keep the path and unrelated params intact.
      expect(window.location.pathname).toBe("/conversations");
      expect(window.location.search).toBe("?c=c&debug=1");
      expect(replaceStateSpy).toHaveBeenCalled();

      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
      replaceStateSpy.mockRestore();
    });

    it("fires at most once", async () => {
      const sendPrompt = vi.fn(() => Promise.resolve());
      const { rerender } = renderHook(
        (props: UseSessionLifecycleArgs) => useSessionLifecycle(props),
        {
          initialProps: makeArgs({
            autoFocus: true,
            session: sessionWithObjective,
            sendPrompt,
          }),
        },
      );
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

      rerender(
        makeArgs({
          autoFocus: true,
          session: sessionWithObjective,
          sendPrompt,
          messagesLength: 2,
        }),
      );
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    });

    it("fires again for a different conversation opened with autoFocus while the workspace stays mounted", async () => {
      const sendPrompt = vi.fn(() => Promise.resolve());
      const { rerender } = renderHook(
        (props: UseSessionLifecycleArgs) => useSessionLifecycle(props),
        {
          initialProps: makeArgs({
            conversationId: "a",
            autoFocus: true,
            session: sessionWithObjective,
            sendPrompt,
          }),
        },
      );
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));

      // The guard is keyed per conversation, not per workspace instance: a
      // newly activated conversation with autoFocus must still kick off its
      // objective even though the workspace was never remounted.
      rerender(
        makeArgs({
          conversationId: "b",
          autoFocus: true,
          session: sessionWithObjective,
          sendPrompt,
        }),
      );
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    });
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
