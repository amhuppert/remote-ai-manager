// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via ConversationWorkspace.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
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
