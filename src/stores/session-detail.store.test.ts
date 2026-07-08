import { describe, it, expect, beforeEach } from "vitest";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  useSessionDetailStore,
  useSidebarFilter,
  useSetSidebarFilter,
  useComposerFocused,
  useSetComposerFocused,
} from "./session-detail.store";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

function textBlock(text: string): MessageContentBlock[] {
  return [{ type: "text", text }];
}

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
    useSessionDetailStore
      .getState()
      .submitPrompt(textBlock("hello"), 0, { model: "fable", effort: "max" });
    expect(
      useSessionDetailStore.getState().optimisticMessages[0],
    ).toMatchObject({ role: "user", model: "fable", effort: "max" });

    useSessionDetailStore
      .getState()
      .receiveStreamContent(textBlock("hello"), textBlock("partial answer"), {
        model: "fable",
        effort: "max",
      });
    const messages = useSessionDetailStore.getState().optimisticMessages;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      model: "fable",
      effort: "max",
    });
  });

  it("leaves optimistic rows unstamped when the turn has no explicit model/effort", () => {
    useSessionDetailStore.getState().submitPrompt(textBlock("hello"), 0);
    useSessionDetailStore
      .getState()
      .receiveStreamContent(textBlock("hello"), textBlock("partial answer"));
    const messages = useSessionDetailStore.getState().optimisticMessages;
    expect(messages[0]).not.toHaveProperty("model");
    expect(messages[1]).not.toHaveProperty("model");
    expect(messages[1]).not.toHaveProperty("effort");
  });
});

describe("session-detail.store — resetConversationState", () => {
  beforeEach(resetStore);

  it("resets conversation-scoped state to defaults", () => {
    const s = useSessionDetailStore.getState();
    s.switchMobilePanel("diff");
    s.switchRightPaneTab("docs");
    s.submitPrompt(textBlock("hello"), 3);
    s.showQuestions("q-1", []);

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.mobilePanel).toBe("chat");
    expect(after.rightPaneTab).toBe("diff");
    expect(after.sending).toBe(false);
    expect(after.optimisticMessages).toEqual([]);
    expect(after.pendingQuestionId).toBeNull();
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

  it("still resets conversation-scoped state while preserving layout", () => {
    const s = useSessionDetailStore.getState();
    s.switchLayout("panes", "cc-conversations-layout");
    s.submitPrompt(textBlock("hello"), 7);
    expect(useSessionDetailStore.getState().sending).toBe(true);
    expect(useSessionDetailStore.getState().messageCountBeforeSubmit).toBe(7);

    useSessionDetailStore.getState().resetConversationState();

    const after = useSessionDetailStore.getState();
    expect(after.layout).toBe("panes");
    expect(after.sending).toBe(false);
    expect(after.messageCountBeforeSubmit).toBe(0);
    expect(after.optimisticMessages).toEqual([]);
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
    expect(useSessionDetailStore.getState().optimisticQueue).toEqual([]);
  });

  it("addOptimisticQueueEntry appends a pending entry without touching sending", () => {
    const before = useSessionDetailStore.getState();
    expect(before.sending).toBe(false);

    useSessionDetailStore
      .getState()
      .addOptimisticQueueEntry("temp-1", textBlock("hello"));

    const after = useSessionDetailStore.getState();
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
    expect(after.optimisticMessages).toBe(before.optimisticMessages);
    expect(after.promptError).toBe(before.promptError);
  });

  it("acceptOptimisticQueueEntry records the server queue id and sets status accepted", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-a", textBlock("a"));
    store.addOptimisticQueueEntry("temp-b", textBlock("b"));

    const before = useSessionDetailStore.getState();
    expect(before.sending).toBe(false);

    store.acceptOptimisticQueueEntry("temp-b", "server-b");

    const after = useSessionDetailStore.getState();
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
    expect(after.sending).toBe(before.sending);
  });

  it("failOptimisticQueueEntry rolls back ONLY the failed entry and leaves sending unchanged (THE OBSERVABLE)", () => {
    // Arrange: a turn is running.
    useSessionDetailStore.getState().submitPrompt(textBlock("turn"), 0);
    expect(useSessionDetailStore.getState().sending).toBe(true);

    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-keep", textBlock("keep"));
    store.addOptimisticQueueEntry("temp-fail", textBlock("fail"));
    expect(useSessionDetailStore.getState().optimisticQueue).toHaveLength(2);

    // Act: fail one entry.
    store.failOptimisticQueueEntry("temp-fail");

    // Assert: only the failed entry is removed; the other remains.
    const after = useSessionDetailStore.getState();
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-keep");
    expect(after.optimisticQueue.some((e) => e.tempId === "temp-fail")).toBe(
      false,
    );

    // Assert: sending flag is STILL true (req 5.2) — the action did not change it.
    expect(after.sending).toBe(true);
  });

  it("cancelOptimisticQueueEntry removes an entry by server queue id", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-1", textBlock("one"));
    store.acceptOptimisticQueueEntry("temp-1", "server-1");
    store.addOptimisticQueueEntry("temp-2", textBlock("two"));

    const before = useSessionDetailStore.getState();
    expect(before.sending).toBe(false);

    store.cancelOptimisticQueueEntry("server-1");

    const after = useSessionDetailStore.getState();
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-2");
    expect(after.sending).toBe(before.sending);
  });

  it("cancelOptimisticQueueEntry also removes an entry by temp id", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-1", textBlock("one"));

    store.cancelOptimisticQueueEntry("temp-1");

    expect(useSessionDetailStore.getState().optimisticQueue).toHaveLength(0);
  });

  it("rollbackOptimisticQueueEntry removes the target entry by temp id without touching sending", () => {
    useSessionDetailStore.getState().submitPrompt(textBlock("turn"), 0);
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-1", textBlock("one"));
    store.addOptimisticQueueEntry("temp-2", textBlock("two"));

    const before = useSessionDetailStore.getState();
    expect(before.sending).toBe(true);

    store.rollbackOptimisticQueueEntry("temp-1");

    const after = useSessionDetailStore.getState();
    expect(after.optimisticQueue).toHaveLength(1);
    expect(after.optimisticQueue[0]?.tempId).toBe("temp-2");
    expect(after.sending).toBe(true);
  });

  it("resetStore restores optimisticQueue to empty", () => {
    const store = useSessionDetailStore.getState();
    store.addOptimisticQueueEntry("temp-1", textBlock("one"));
    expect(useSessionDetailStore.getState().optimisticQueue).toHaveLength(1);

    store.resetStore();

    expect(useSessionDetailStore.getState().optimisticQueue).toEqual([]);
  });
});

describe("session-detail.store — setQueueError", () => {
  beforeEach(resetStore);

  it("sets promptError and leaves sending unchanged (req 5.1, 5.2)", () => {
    // Arrange: a turn is running.
    useSessionDetailStore.getState().submitPrompt(textBlock("turn"), 0);
    expect(useSessionDetailStore.getState().sending).toBe(true);

    // Act: surface a queue error.
    useSessionDetailStore.getState().setQueueError("Failed to queue message");

    // Assert: error is visible, running indicator stays running.
    const after = useSessionDetailStore.getState();
    expect(after.promptError).toBe("Failed to queue message");
    expect(after.sending).toBe(true);
  });

  it("does not clear sending the way failPrompt does", () => {
    const store = useSessionDetailStore.getState();
    store.submitPrompt(textBlock("turn"), 0);

    store.failPrompt("boom");
    expect(useSessionDetailStore.getState().sending).toBe(false);

    store.submitPrompt(textBlock("turn-2"), 0);
    store.setQueueError("queue boom");
    expect(useSessionDetailStore.getState().sending).toBe(true);
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
