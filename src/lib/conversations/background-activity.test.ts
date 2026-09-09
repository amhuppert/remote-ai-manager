import { describe, it, expect, vi } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishOutcome } from "@/lib/events/publication";
import {
  BACKGROUND_ACTIVITY_THROTTLE_MS,
  createBackgroundActivityChannel,
  type BackgroundActivityChannel,
} from "./background-activity";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import type { ConversationBackgroundActivity } from "./schemas";

const SESSION_IDENTITY = {
  projectName: "demo",
  sessionName: "feature-x",
  conversationId: "conv-1",
};

function activity(
  taskIds: string[],
  updatedAt: string,
): ConversationBackgroundActivity {
  return {
    updatedAt,
    tasks: taskIds.map((taskId) => ({
      taskId,
      description: "background work",
      taskType: null,
      workflowName: null,
      subagentType: null,
      lastToolName: null,
      totalTokens: null,
      toolUses: null,
      startedAt: "2026-07-28T10:00:00.000Z",
      lastActivityAt: updatedAt,
    })),
  };
}

interface Harness {
  channel: BackgroundActivityChannel;
  published: SSEEvent[];
  advance(ms: number): void;
  runTimers(): void;
  pendingTimerCount(): number;
  setPublishOutcome(fn: (event: SSEEvent) => PublishOutcome): void;
}

function createHarness(): Harness {
  const published: SSEEvent[] = [];
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, () => void>();
  let publishImpl: (event: SSEEvent) => PublishOutcome = () => ({
    delivered: true,
  });

  const channel = createBackgroundActivityChannel({
    publish: (event) => {
      published.push(event);
      return publishImpl(event);
    },
    nowMs: () => now,
    setTimer: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    channel,
    published,
    advance(ms) {
      now += ms;
    },
    runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) fn();
    },
    pendingTimerCount: () => timers.size,
    setPublishOutcome(fn) {
      publishImpl = fn;
    },
  };
}

describe("background activity channel — registry", () => {
  it("reads back the newest recorded snapshot", () => {
    const h = createHarness();
    const first = activity(["t1"], "2026-07-28T10:00:01.000Z");
    h.channel.record(SESSION_IDENTITY, first);
    expect(h.channel.get("conv-1")).toEqual(first);

    const second = activity(["t1", "t2"], "2026-07-28T10:00:05.000Z");
    h.channel.record(SESSION_IDENTITY, second);
    expect(h.channel.get("conv-1")).toEqual(second);
  });

  it("returns null for an unknown conversation and after the set drains", () => {
    const h = createHarness();
    expect(h.channel.get("conv-1")).toBe(null);

    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.channel.record(SESSION_IDENTITY, null);

    expect(h.channel.get("conv-1")).toBe(null);
  });

  it("keeps conversations independent", () => {
    const h = createHarness();
    const a = activity(["t1"], "a");
    h.channel.record(SESSION_IDENTITY, a);
    h.channel.record(
      { ...SESSION_IDENTITY, conversationId: "conv-2" },
      activity(["t9"], "b"),
    );

    h.channel.record({ ...SESSION_IDENTITY, conversationId: "conv-2" }, null);

    expect(h.channel.get("conv-1")).toEqual(a);
    expect(h.channel.get("conv-2")).toBe(null);
  });
});

describe("background activity channel — publication", () => {
  it("publishes immediately when the task set gains a member", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));

    expect(h.published).toEqual([
      {
        type: "conversation-background-activity",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        activity: activity(["t1"], "a"),
      },
    ]);

    h.channel.record(SESSION_IDENTITY, activity(["t1", "t2"], "b"));
    expect(h.published).toHaveLength(2);
  });

  it("publishes the drained set immediately", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.channel.record(SESSION_IDENTITY, null);

    expect(h.published).toHaveLength(2);
    expect(h.published[1]).toMatchObject({
      conversationId: "conv-1",
      activity: null,
    });
  });

  it("publishes nothing when clearing a conversation that never had activity", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, null);
    expect(h.published).toEqual([]);
  });

  it("throttles activity-only updates onto a trailing publish carrying the newest snapshot", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    expect(h.published).toHaveLength(1);

    h.advance(500);
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "b"));
    h.advance(500);
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "c"));

    // Same membership inside the window — nothing on the wire yet.
    expect(h.published).toHaveLength(1);
    expect(h.pendingTimerCount()).toBe(1);

    h.runTimers();

    expect(h.published).toHaveLength(2);
    expect(h.published[1]).toMatchObject({ activity: activity(["t1"], "c") });
  });

  it("publishes an activity-only update immediately once the throttle window has elapsed", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.advance(BACKGROUND_ACTIVITY_THROTTLE_MS);
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "b"));

    expect(h.published).toHaveLength(2);
    expect(h.pendingTimerCount()).toBe(0);
  });

  it("cancels a pending trailing publish when the set drains", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "b"));
    expect(h.pendingTimerCount()).toBe(1);

    h.channel.record(SESSION_IDENTITY, null);
    expect(h.pendingTimerCount()).toBe(0);

    h.runTimers();
    // The drain publish, and no stale trailing publish behind it.
    expect(h.published).toHaveLength(2);
  });

  it("emits the project-scope variant for the project sentinel", () => {
    const h = createHarness();
    h.channel.record(
      {
        projectName: "demo",
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: "conv-1",
      },
      activity(["t1"], "a"),
    );

    expect(h.published[0]).toEqual({
      type: "conversation-background-activity",
      scope: "project",
      projectName: "demo",
      conversationId: "conv-1",
      activity: activity(["t1"], "a"),
    });
  });
});

describe("background activity channel — failure containment", () => {
  it("swallows a thrown publish and still records the snapshot", () => {
    const h = createHarness();
    h.setPublishOutcome(() => {
      throw new Error("wire down");
    });

    const snapshot = activity(["t1"], "a");
    expect(() => h.channel.record(SESSION_IDENTITY, snapshot)).not.toThrow();
    expect(h.channel.get("conv-1")).toEqual(snapshot);
  });

  it("swallows an undelivered publish outcome", () => {
    const h = createHarness();
    h.setPublishOutcome(() => ({
      delivered: false,
      error: new Error("no subscribers"),
    }));

    expect(() =>
      h.channel.record(SESSION_IDENTITY, activity(["t1"], "a")),
    ).not.toThrow();
  });

  it("swallows a throwing trailing publish", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "b"));
    h.setPublishOutcome(() => {
      throw new Error("wire down");
    });

    expect(() => h.runTimers()).not.toThrow();
  });
});

describe("background activity channel — reset", () => {
  it("drops registry entries and pending timers", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "b"));

    h.channel._resetForTesting();

    expect(h.channel.get("conv-1")).toBe(null);
    expect(h.pendingTimerCount()).toBe(0);
  });
});

describe("background activity channel — publish argument", () => {
  it("hands the publisher exactly one event per delivery", () => {
    const publish = vi.fn(() => ({ delivered: true }) as PublishOutcome);
    const channel = createBackgroundActivityChannel({
      publish,
      nowMs: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
    });

    channel.record(SESSION_IDENTITY, activity(["t1"], "a"));

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("background activity channel — epoch", () => {
  it("advances once per recorded change and remembers a set that appeared and drained", () => {
    const h = createHarness();
    expect(h.channel.epoch("conv-1")).toBe(0);
    h.channel.record(SESSION_IDENTITY, activity(["t1"], "a"));
    const appeared = h.channel.epoch("conv-1");
    expect(appeared).toBeGreaterThan(0);
    h.channel.record(SESSION_IDENTITY, null);
    expect(h.channel.get("conv-1")).toBe(null);
    expect(h.channel.epoch("conv-1")).toBeGreaterThan(appeared);
  });

  it("does not advance for a clear that retracts nothing, and keeps conversations independent", () => {
    const h = createHarness();
    h.channel.record(SESSION_IDENTITY, null);
    expect(h.channel.epoch("conv-1")).toBe(0);
    h.channel.record(
      { ...SESSION_IDENTITY, conversationId: "conv-2" },
      activity(["t9"], "b"),
    );
    expect(h.channel.epoch("conv-1")).toBe(0);
    expect(h.channel.epoch("conv-2")).toBeGreaterThan(0);
  });
});
