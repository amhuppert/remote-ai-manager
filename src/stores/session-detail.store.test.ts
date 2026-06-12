import { describe, it, expect, beforeEach } from "vitest";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  useSessionDetailStore,
  useSidebarFilter,
  useSetSidebarFilter,
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
