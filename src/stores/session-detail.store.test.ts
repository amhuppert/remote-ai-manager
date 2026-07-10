import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  useSessionDetailStore,
  useSidebarFilter,
  useSetSidebarFilter,
  useComposerFocused,
  useSetComposerFocused,
  selectInFlightFor,
  EMPTY_IN_FLIGHT,
} from "./session-detail.store";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

function textBlock(text: string): MessageContentBlock[] {
  return [{ type: "text", text }];
}

/** Read conversation A/B in-flight state directly off the store. */
function inFlightFor(conversationId: string) {
  return selectInFlightFor(useSessionDetailStore.getState(), conversationId);
}

const A = "conv-a";
const B = "conv-b";

describe("session-detail.store — sidebar UI slice", () => {
  beforeEach(resetStore);

  it("has the expected defaults", () => {
    const s = useSessionDetailStore.getState();
    expect(s.sidebarFilter).toBe("");
  });

  it("setSidebarFilter mutates only sidebarFilter", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().setSidebarFilter("auth");
    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("auth");
    expect(after.layout).toBe(before.layout);
    expect(after.sidebarCollapsed).toBe(before.sidebarCollapsed);
  });

  it("resetStore restores sidebar slice defaults", () => {
    const s = useSessionDetailStore.getState();
    s.setSidebarFilter("xyz");

    s.resetStore();

    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("");
  });

  it("selector hooks expose sidebar slice fields", () => {
    expect(useSidebarFilter).toBeTypeOf("function");
    expect(useSetSidebarFilter).toBeTypeOf("function");
  });
});

describe("session-detail.store — composer focus slice", () => {
  beforeEach(resetStore);

  it("defaults composerFocused to false", () => {
    expect(useSessionDetailStore.getState().composerFocused).toBe(false);
  });

  it("setComposerFocused(true) sets composerFocused true", () => {
    useSessionDetailStore.getState().setComposerFocused(true);
    expect(useSessionDetailStore.getState().composerFocused).toBe(true);
  });

  it("setComposerFocused(false) sets composerFocused back to false", () => {
    useSessionDetailStore.getState().setComposerFocused(true);
    expect(useSessionDetailStore.getState().composerFocused).toBe(true);

    useSessionDetailStore.getState().setComposerFocused(false);
    expect(useSessionDetailStore.getState().composerFocused).toBe(false);
  });

  it("setComposerFocused mutates only composerFocused", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().setComposerFocused(true);
    const after = useSessionDetailStore.getState();
    expect(after.composerFocused).toBe(true);
    expect(after.layout).toBe(before.layout);
    expect(after.sidebarFilter).toBe(before.sidebarFilter);
    expect(after.sidebarCollapsed).toBe(before.sidebarCollapsed);
  });

  it("resetStore restores composerFocused to false", () => {
    useSessionDetailStore.getState().setComposerFocused(true);
    useSessionDetailStore.getState().resetStore();
    expect(useSessionDetailStore.getState().composerFocused).toBe(false);
  });

  it("selector hooks expose composer focus slice fields", () => {
    expect(useComposerFocused).toBeTypeOf("function");
    expect(useSetComposerFocused).toBeTypeOf("function");
  });
});

describe("session-detail.store — mobile sidebar slice", () => {
  beforeEach(resetStore);

  it("defaults mobileSidebarOpen to false", () => {
    expect(useSessionDetailStore.getState().mobileSidebarOpen).toBe(false);
  });

  it("openMobileSidebar sets mobileSidebarOpen=true; closeMobileSidebar sets it false", () => {
    useSessionDetailStore.getState().openMobileSidebar();
    expect(useSessionDetailStore.getState().mobileSidebarOpen).toBe(true);

    useSessionDetailStore.getState().closeMobileSidebar();
    expect(useSessionDetailStore.getState().mobileSidebarOpen).toBe(false);
  });

  it("openMobileSidebar mutates only mobileSidebarOpen", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().openMobileSidebar();
    const after = useSessionDetailStore.getState();
    expect(after.sidebarCollapsed).toBe(before.sidebarCollapsed);
    expect(after.layout).toBe(before.layout);
    expect(after.mobilePanel).toBe(before.mobilePanel);
  });

  it("resetStore restores mobileSidebarOpen to false", () => {
    useSessionDetailStore.getState().openMobileSidebar();
    useSessionDetailStore.getState().resetStore();
    expect(useSessionDetailStore.getState().mobileSidebarOpen).toBe(false);
  });
});

describe("session-detail.store — optimistic agent settings stamps", () => {
  beforeEach(resetStore);

  it("stamps the optimistic user row and the streaming assistant row with the turn's model/effort", () => {
    useSessionDetailStore.getState().submitPrompt(A, textBlock("hello"), 0, {
      model: "fable",
      effort: "max",
    });
    expect(inFlightFor(A).optimisticMessages[0]).toMatchObject({
      role: "user",
      model: "fable",
      effort: "max",
    });

    useSessionDetailStore
      .getState()
      .receiveStreamContent(
        A,
        textBlock("hello"),
        textBlock("partial answer"),
        { model: "fable", effort: "max" },
      );
    const messages = inFlightFor(A).optimisticMessages;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      model: "fable",
      effort: "max",
    });
  });

  it("leaves optimistic rows unstamped when the turn has no explicit model/effort", () => {
    useSessionDetailStore.getState().submitPrompt(A, textBlock("hello"), 0);
    useSessionDetailStore
      .getState()
      .receiveStreamContent(A, textBlock("hello"), textBlock("partial answer"));
    const messages = inFlightFor(A).optimisticMessages;
    expect(messages[0]).not.toHaveProperty("model");
    expect(messages[1]).not.toHaveProperty("model");
    expect(messages[1]).not.toHaveProperty("effort");
  });
});

describe("session-detail.store — in-flight state is keyed per conversation", () => {
  beforeEach(resetStore);

  it("returns the shared default for a conversation with no in-flight state (stable identity)", () => {
    expect(inFlightFor(A)).toBe(EMPTY_IN_FLIGHT);
    expect(inFlightFor(A).sending).toBe(false);
    expect(inFlightFor(A).optimisticMessages).toEqual([]);
    expect(inFlightFor(A).optimisticQueue).toEqual([]);
    expect(inFlightFor(A).promptError).toBeNull();
    expect(inFlightFor(A).promptCancelled).toBe(false);
    expect(inFlightFor(A).messageCountBeforeSubmit).toBe(0);
  });

  it("submitPrompt sets sending + optimistic echo for its conversation only", () => {
    useSessionDetailStore.getState().submitPrompt(A, textBlock("hello"), 3);

    expect(inFlightFor(A).sending).toBe(true);
    expect(inFlightFor(A).messageCountBeforeSubmit).toBe(3);
    expect(inFlightFor(A).optimisticMessages).toHaveLength(1);

    expect(inFlightFor(B)).toBe(EMPTY_IN_FLIGHT);
  });

  it("two conversations stream independently; completing one leaves the other in flight", () => {
    const s = useSessionDetailStore.getState();
    s.submitPrompt(A, textBlock("a"), 0);
    s.submitPrompt(B, textBlock("b"), 5);
    s.receiveStreamContent(A, textBlock("a"), textBlock("partial a"));

    expect(inFlightFor(A).sending).toBe(true);
    expect(inFlightFor(A).optimisticMessages).toHaveLength(2);
    expect(inFlightFor(B).sending).toBe(true);
    expect(inFlightFor(B).optimisticMessages).toHaveLength(1);

    s.completePrompt(A);

    expect(inFlightFor(A).sending).toBe(false);
    expect(inFlightFor(B).sending).toBe(true);
    expect(inFlightFor(B).messageCountBeforeSubmit).toBe(5);
  });

  it("failPrompt surfaces the error on its conversation only", () => {
    const s = useSessionDetailStore.getState();
    s.submitPrompt(A, textBlock("a"), 0);
    s.submitPrompt(B, textBlock("b"), 0);

    s.failPrompt(A, "boom");

    expect(inFlightFor(A).promptError).toBe("boom");
    expect(inFlightFor(A).sending).toBe(false);
    expect(inFlightFor(B).promptError).toBeNull();
    expect(inFlightFor(B).sending).toBe(true);
  });

  it("dismissError clears only its conversation's error", () => {
    const s = useSessionDetailStore.getState();
    s.failPrompt(A, "a-error");
    s.failPrompt(B, "b-error");

    s.dismissError(A);

    expect(inFlightFor(A).promptError).toBeNull();
    expect(inFlightFor(B).promptError).toBe("b-error");
  });

  it("reconcileMessages clears only its conversation's optimistic echo once the server catches up", () => {
    const s = useSessionDetailStore.getState();
    s.submitPrompt(A, textBlock("a"), 2);
    s.submitPrompt(B, textBlock("b"), 2);
    s.completePrompt(A);
    s.completePrompt(B);

    s.reconcileMessages(A, 4);

    expect(inFlightFor(A).optimisticMessages).toEqual([]);
    expect(inFlightFor(B).optimisticMessages).toHaveLength(1);
  });

  it("reconcileMessages is a no-op while the server transcript has not caught up", () => {
    const s = useSessionDetailStore.getState();
    s.submitPrompt(A, textBlock("a"), 2);
    s.completePrompt(A);

    s.reconcileMessages(A, 2);

    expect(inFlightFor(A).optimisticMessages).toHaveLength(1);
  });

  it("clearConversationMessages clears only its conversation", () => {
    const s = useSessionDetailStore.getState();
    s.submitPrompt(A, textBlock("a"), 2);
    s.submitPrompt(B, textBlock("b"), 2);

    s.clearConversationMessages(A);

    expect(inFlightFor(A).optimisticMessages).toEqual([]);
    expect(inFlightFor(A).messageCountBeforeSubmit).toBe(0);
    expect(inFlightFor(B).optimisticMessages).toHaveLength(1);
  });
});

describe("session-detail.store — markCancelled per conversation", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags only its conversation and auto-clears after the banner window", () => {
    const s = useSessionDetailStore.getState();
    s.markCancelled(A);

    expect(inFlightFor(A).promptCancelled).toBe(true);
    expect(inFlightFor(B).promptCancelled).toBe(false);

    vi.advanceTimersByTime(2500);

    expect(inFlightFor(A).promptCancelled).toBe(false);
  });

  it("re-marking restarts the window without clearing another conversation's flag", () => {
    const s = useSessionDetailStore.getState();
    s.markCancelled(A);
    vi.advanceTimersByTime(2000);
    s.markCancelled(B);
    s.markCancelled(A);
    vi.advanceTimersByTime(2000);

    // A's window restarted at t=2000, so it is still visible at t=4000.
    expect(inFlightFor(A).promptCancelled).toBe(true);
    expect(inFlightFor(B).promptCancelled).toBe(true);

    vi.advanceTimersByTime(500);
    expect(inFlightFor(A).promptCancelled).toBe(false);
    expect(inFlightFor(B).promptCancelled).toBe(false);
  });

  it("dismissCancelled clears only its conversation", () => {
    const s = useSessionDetailStore.getState();
    s.markCancelled(A);
    s.markCancelled(B);

    s.dismissCancelled(A);

    expect(inFlightFor(A).promptCancelled).toBe(false);
    expect(inFlightFor(B).promptCancelled).toBe(true);
  });
});

describe("session-detail.store — resetConversationState", () => {
  beforeEach(resetStore);

  it("resets workspace-scoped state to defaults", () => {
    const s = useSessionDetailStore.getState();
    s.switchMobilePanel("diff");
    s.switchRightPaneTab("docs");
    s.showQuestions("q-1", []);

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.mobilePanel).toBe("chat");
    expect(after.rightPaneTab).toBe("diff");
    expect(after.pendingQuestionId).toBeNull();
  });

  it("preserves per-conversation in-flight state across a workspace swap", () => {
    // A turn streaming in conversation A must stay visible in every surface
    // (pane, sidebar peek) after the workspace switches to conversation B.
    useSessionDetailStore.getState().submitPrompt(A, textBlock("hello"), 3);

    useSessionDetailStore.getState().resetConversationState();

    expect(inFlightFor(A).sending).toBe(true);
    expect(inFlightFor(A).optimisticMessages).toHaveLength(1);
    expect(inFlightFor(A).messageCountBeforeSubmit).toBe(3);
  });

  it("preserves rail-owned state (collapse, mobile drawer, filters)", () => {
    const s = useSessionDetailStore.getState();
    s.toggleSidebar();
    s.openMobileSidebar();
    s.setSidebarFilter("auth");
    s.setSidebarSessionFilter({ projectName: "p", sessionName: "sess" });

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.sidebarCollapsed).toBe(true);
    expect(after.mobileSidebarOpen).toBe(true);
    expect(after.sidebarFilter).toBe("auth");
    expect(after.sidebarSessionFilter).toEqual({
      projectName: "p",
      sessionName: "sess",
    });
  });

  it("preserves the page-level layout across a workspace swap (req 3.5, 5.2)", () => {
    const s = useSessionDetailStore.getState();
    s.switchLayout("panes", "cc-conversations-layout");
    expect(useSessionDetailStore.getState().layout).toBe("panes");

    useSessionDetailStore.getState().resetConversationState();

    expect(useSessionDetailStore.getState().layout).toBe("panes");
  });

  it("preserves layout AND in-flight state while resetting workspace bits", () => {
    const s = useSessionDetailStore.getState();
    s.switchLayout("panes", "cc-conversations-layout");
    s.submitPrompt(A, textBlock("hello"), 7);
    s.switchMobilePanel("diff");

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.layout).toBe("panes");
    expect(after.mobilePanel).toBe("chat");
    expect(inFlightFor(A).sending).toBe(true);
    expect(inFlightFor(A).messageCountBeforeSubmit).toBe(7);
  });

  it("resetStore still resets layout to the default (only resetConversationState preserves it)", () => {
    const s = useSessionDetailStore.getState();
    s.switchLayout("panes", "cc-conversations-layout");
    expect(useSessionDetailStore.getState().layout).toBe("panes");

    useSessionDetailStore.getState().resetStore();

    expect(useSessionDetailStore.getState().layout).toBe("conversation");
  });
});

describe("session-detail.store — optimistic queue slice", () => {
  beforeEach(resetStore);

  it("defaults optimisticQueue to an empty array", () => {
    expect(inFlightFor(A).optimisticQueue).toEqual([]);
  });

  it("addOptimisticQueueEntry appends a pending entry without touching sending", () => {
    const before = inFlightFor(A);
    expect(before.sending).toBe(false);

    useSessionDetailStore
      .getState()
      .addOptimisticQueueEntry(A, "temp-1", textBlock("hello"));

    const after = inFlightFor(A);
    expect(after.optimisticQueue).toHaveLength(1);
    const [entry] = after.optimisticQueue;
    expect(entry).toMatchObject({
      tempId: "temp-1",
      queueId: null,
      status: "pending",
      content: textBlock("hello"),
    });
    // Touches nothing else.
    expect(after.sending).toBe(before.sending);
    expect(after.optimisticMessages).toEqual([]);
    expect(after.promptError).toBeNull();
  });

  it("acceptOptimisticQueueEntry records the server queue id and sets status accepted", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-a", textBlock("a"));
    store.addOptimisticQueueEntry(A, "temp-b", textBlock("b"));

    store.acceptOptimisticQueueEntry(A, "temp-b", "server-b");

    const after = inFlightFor(A);
    const accepted = after.optimisticQueue.find((e) => e.tempId === "temp-b");
    const untouched = after.optimisticQueue.find((e) => e.tempId === "temp-a");
    expect(accepted).toMatchObject({
      tempId: "temp-b",
      queueId: "server-b",
      status: "accepted",
    });
    expect(untouched).toMatchObject({
      tempId: "temp-a",
      queueId: null,
      status: "pending",
    });
    expect(after.sending).toBe(false);
  });

  it("failOptimisticQueueEntry rolls back ONLY the failed entry and leaves sending unchanged (THE OBSERVABLE)", () => {
    // Arrange: a turn is running.
    useSessionDetailStore.getState().submitPrompt(A, textBlock("turn"), 0);
    expect(inFlightFor(A).sending).toBe(true);

    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-keep", textBlock("keep"));
    store.addOptimisticQueueEntry(A, "temp-fail", textBlock("fail"));
    expect(inFlightFor(A).optimisticQueue).toHaveLength(2);

    // Act: fail one entry.
    store.failOptimisticQueueEntry(A, "temp-fail");

    // Assert: only the failed entry is removed; the other remains.
    const after = inFlightFor(A);
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-keep");
    expect(after.optimisticQueue.some((e) => e.tempId === "temp-fail")).toBe(
      false,
    );

    // Assert: sending flag is STILL true (req 5.2) — the action did not change it.
    expect(after.sending).toBe(true);
  });

  it("queue entries are isolated between conversations", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-a", textBlock("a"));
    store.addOptimisticQueueEntry(B, "temp-b", textBlock("b"));

    store.cancelOptimisticQueueEntry(A, "temp-a");

    expect(inFlightFor(A).optimisticQueue).toHaveLength(0);
    expect(inFlightFor(B).optimisticQueue).toHaveLength(1);
  });

  it("cancelOptimisticQueueEntry removes an entry by server queue id", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-1", textBlock("one"));
    store.acceptOptimisticQueueEntry(A, "temp-1", "server-1");
    store.addOptimisticQueueEntry(A, "temp-2", textBlock("two"));

    store.cancelOptimisticQueueEntry(A, "server-1");

    const after = inFlightFor(A);
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-2");
    expect(after.sending).toBe(false);
  });

  it("cancelOptimisticQueueEntry also removes an entry by temp id", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-1", textBlock("one"));

    store.cancelOptimisticQueueEntry(A, "temp-1");

    expect(inFlightFor(A).optimisticQueue).toHaveLength(0);
  });

  it("rollbackOptimisticQueueEntry removes the target entry by temp id without touching sending", () => {
    useSessionDetailStore.getState().submitPrompt(A, textBlock("turn"), 0);
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-1", textBlock("one"));
    store.addOptimisticQueueEntry(A, "temp-2", textBlock("two"));

    store.rollbackOptimisticQueueEntry(A, "temp-1");

    const after = inFlightFor(A);
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-2");
    expect(after.sending).toBe(true);
  });

  it("resetStore restores optimisticQueue to empty", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry(A, "temp-1", textBlock("one"));
    expect(inFlightFor(A).optimisticQueue).toHaveLength(1);

    store.resetStore();

    expect(inFlightFor(A).optimisticQueue).toEqual([]);
  });
});

describe("session-detail.store — setQueueError", () => {
  beforeEach(resetStore);

  it("sets promptError and leaves sending unchanged (req 5.1, 5.2)", () => {
    // Arrange: a turn is running.
    useSessionDetailStore.getState().submitPrompt(A, textBlock("turn"), 0);
    expect(inFlightFor(A).sending).toBe(true);

    // Act: surface a queue error.
    useSessionDetailStore
      .getState()
      .setQueueError(A, "Failed to queue message");

    // Assert: error is visible, running indicator stays running.
    const after = inFlightFor(A);
    expect(after.promptError).toBe("Failed to queue message");
    expect(after.sending).toBe(true);
  });

  it("does not clear sending the way failPrompt does", () => {
    const store = useSessionDetailStore.getState();
    store.submitPrompt(A, textBlock("turn"), 0);

    store.failPrompt(A, "boom");
    expect(inFlightFor(A).sending).toBe(false);

    store.submitPrompt(A, textBlock("turn-2"), 0);
    store.setQueueError(A, "queue boom");
    expect(inFlightFor(A).sending).toBe(true);
  });
});

describe("session-detail.store — context-artifact panel", () => {
  beforeEach(resetStore);

  it("openContextArtifactPanel switches the right pane to the artifact tab", () => {
    useSessionDetailStore.getState().openContextArtifactPanel();
    expect(useSessionDetailStore.getState().rightPaneTab).toBe("artifact");
  });

  it("reveals the right pane from the conversation-only layout via split", () => {
    expect(useSessionDetailStore.getState().layout).toBe("conversation");
    useSessionDetailStore.getState().openContextArtifactPanel();
    expect(useSessionDetailStore.getState().layout).toBe("split");
  });

  it("drops out of panes to the default layout", () => {
    useSessionDetailStore.setState({ layout: "panes" });
    useSessionDetailStore.getState().openContextArtifactPanel();
    expect(useSessionDetailStore.getState().layout).toBe("default");
  });

  it("leaves a right-pane-showing layout untouched", () => {
    useSessionDetailStore.setState({ layout: "default" });
    useSessionDetailStore.getState().openContextArtifactPanel();
    expect(useSessionDetailStore.getState().layout).toBe("default");
  });
});

describe("session-detail.store — message nav request", () => {
  beforeEach(resetStore);

  it("defaults to no pending request", () => {
    expect(useSessionDetailStore.getState().messageNavRequest).toBeNull();
  });

  it("requestMessageNav records the target conversation and message", () => {
    useSessionDetailStore.getState().requestMessageNav("conv-1", 12);
    expect(useSessionDetailStore.getState().messageNavRequest).toEqual({
      conversationId: "conv-1",
      messageIndex: 12,
    });
  });

  it("clearMessageNavRequest consumes the request", () => {
    const store = useSessionDetailStore.getState();
    store.requestMessageNav("conv-1", 3);
    store.clearMessageNavRequest();
    expect(useSessionDetailStore.getState().messageNavRequest).toBeNull();
  });

  it("resetStore clears any pending request", () => {
    useSessionDetailStore.getState().requestMessageNav("conv-1", 3);
    useSessionDetailStore.getState().resetStore();
    expect(useSessionDetailStore.getState().messageNavRequest).toBeNull();
  });
});
