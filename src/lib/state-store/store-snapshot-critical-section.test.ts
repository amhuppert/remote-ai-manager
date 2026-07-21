import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Logger } from "@/lib/logging";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import { _createTestDb } from "./state-db";
import { createStateStore } from "./store";
import type { ConversationMachineSnapshotsRepo } from "./conversation-machine-snapshots-repo";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

/**
 * Ordering regression for the `no-slow-work-in-critical-section` charter
 * invariant on the snapshot-sidecar write seams.
 *
 * `upsertConversationMachineSnapshot` / `deleteConversationMachineSnapshot` wrap
 * a `timed()` mutation log around their sidecar write. `timed`'s completion log
 * is a synchronous `appendFileSync` in the production logger, so it MUST be
 * emitted only after the write-queue callback has released the lock — never
 * while the callback is still executing. If `timed` is nested INSIDE the queue
 * callback, its log fires with the write lock held (the exact violation the
 * validator flagged), blocking every other writer for the duration of the file
 * write.
 *
 * The test injects a fake write queue that marks `queue:enter` / `queue:exit`
 * around the callback (exit models the lock release before the outer promise
 * resolves), a recording snapshot repo that marks `repo:*`, and a recording
 * logger that marks each emission. A correct seam yields the write strictly
 * inside the queue window and the completion log strictly after `queue:exit`.
 */
describe("snapshot write seams — no logging inside the write-queue critical section", () => {
  let db: Db;
  let timeline: string[];

  /**
   * Fake queue: the `queue:exit` mark lands in the `finally`, before the
   * returned promise resolves — mirroring the real write queue, which calls
   * `release()` in its `finally` before `withWriteQueue` resolves. So any work
   * the caller does after `await withWriteQueue(...)` (i.e. `timed`'s emit) is
   * genuinely outside the held window.
   */
  function makeRecordingQueue(): WriteQueue {
    return {
      async withWriteQueue<T>(
        _label: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        timeline.push("queue:enter");
        try {
          return await fn();
        } finally {
          timeline.push("queue:exit");
        }
      },
      async withWriteQueueSync(_label, fn, ..._reject) {
        timeline.push("queue:enter");
        try {
          return fn();
        } finally {
          timeline.push("queue:exit");
        }
      },
      async tryWithWriteQueue<T>(_label: string, fn: () => Promise<T>) {
        return { acquired: true as const, value: await fn() };
      },
      _resetForTesting() {},
    };
  }

  function makeRecordingSnapshotsRepo(): ConversationMachineSnapshotsRepo {
    return {
      get: () => null,
      upsert: () => {
        timeline.push("repo:upsert");
      },
      deleteByConversation: () => {
        timeline.push("repo:delete");
      },
    };
  }

  function makeRecordingLogger(): Logger {
    const record = (message: string) => timeline.push(`log:${message}`);
    return {
      debug: (message) => record(message),
      info: (message) => record(message),
      warn: (message) => record(message),
      error: (message) => record(message),
    };
  }

  function makeStore() {
    return createStateStore({
      db,
      writeQueue: makeRecordingQueue(),
      repos: { conversationMachineSnapshots: makeRecordingSnapshotsRepo() },
      logger: makeRecordingLogger(),
    });
  }

  /** Keep only the marks relevant to write-vs-log ordering. */
  function orderingMarks(): string[] {
    return timeline.filter(
      (mark) =>
        mark === "queue:enter" ||
        mark === "repo:upsert" ||
        mark === "repo:delete" ||
        mark === "queue:exit" ||
        mark === "log:state.mutate.complete",
    );
  }

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    timeline = [];
  });

  afterEach(() => {
    db.close();
  });

  it("upsert emits the state.mutate completion log only after the queue releases", async () => {
    const store = makeStore();

    await store.upsertConversationMachineSnapshot("session", "conv-1", {
      token: "resume",
    });

    expect(orderingMarks()).toEqual([
      "queue:enter",
      "repo:upsert",
      "queue:exit",
      "log:state.mutate.complete",
    ]);
  });

  it("delete emits the state.mutate completion log only after the queue releases", async () => {
    const store = makeStore();

    await store.deleteConversationMachineSnapshot("project", "conv-2");

    expect(orderingMarks()).toEqual([
      "queue:enter",
      "repo:delete",
      "queue:exit",
      "log:state.mutate.complete",
    ]);
  });
});

/**
 * Same ordering invariant for the GENERIC focused mutators. `mutateSession` /
 * `mutateConversation` previously nested `timed()` INSIDE the write-queue
 * callback, so their `state.mutate.complete` log (synchronous `appendFileSync`)
 * fired with the lock held. `timed` now wraps the queue CALL, so the completion
 * log must land strictly after the queue releases. The recording queue marks
 * `queue:exit` in its `finally` — before the outer promise resolves — modelling
 * the real queue's release-before-resolve, so a log emitted after `queue:exit`
 * is genuinely outside the held window.
 */
describe("generic focused mutators — completion log after the queue releases", () => {
  let db: Db;
  let timeline: string[];

  function makeRecordingLogger(): Logger {
    const record = (message: string) => timeline.push(`log:${message}`);
    return {
      debug: (message) => record(message),
      info: (message) => record(message),
      warn: (message) => record(message),
      error: (message) => record(message),
    };
  }

  /** Recording queue that exits (releases) in `finally`, before resolving. */
  function makeRecordingQueue(): WriteQueue {
    return {
      async withWriteQueue<T>(
        _label: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        timeline.push("queue:enter");
        try {
          return await fn();
        } finally {
          timeline.push("queue:exit");
        }
      },
      async withWriteQueueSync(_label, fn, ..._reject) {
        timeline.push("queue:enter");
        try {
          return fn();
        } finally {
          timeline.push("queue:exit");
        }
      },
      async tryWithWriteQueue<T>(_label: string, fn: () => Promise<T>) {
        return { acquired: true as const, value: await fn() };
      },
      _resetForTesting() {},
    };
  }

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    timeline = [];
    seedWholeState(db, {
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            alpha: sessionStateSchema.parse({
              sessionName: "alpha",
              worktreePath: "/wt/alpha",
              branchName: "csm/alpha",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              conversations: [
                conversationStateSchema.parse({
                  id: "conv-1",
                  transcriptPath: null,
                  status: "idle",
                  promptCount: 0,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                }),
              ],
            }),
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });
  });

  afterEach(() => {
    db.close();
  });

  function orderingMarks(): string[] {
    return timeline.filter(
      (mark) =>
        mark === "queue:enter" ||
        mark === "queue:exit" ||
        mark === "log:state.mutate.complete",
    );
  }

  it("mutateConversation logs completion only after the queue exits", async () => {
    const store = createStateStore({
      db,
      writeQueue: makeRecordingQueue(),
      logger: makeRecordingLogger(),
    });

    await store.mutateConversation(
      "/proj",
      "alpha",
      "conv-1",
      "test.mutate",
      (conversation) => {
        conversation.status = "running";
      },
    );

    expect(orderingMarks()).toEqual([
      "queue:enter",
      "queue:exit",
      "log:state.mutate.complete",
    ]);
  });

  it("mutateSession logs completion only after the queue exits", async () => {
    const store = createStateStore({
      db,
      writeQueue: makeRecordingQueue(),
      logger: makeRecordingLogger(),
    });

    await store.mutateSession("/proj", "alpha", "test.mutate", (session) => {
      session.targetBranch = "ship-it";
    });

    expect(orderingMarks()).toEqual([
      "queue:enter",
      "queue:exit",
      "log:state.mutate.complete",
    ]);
  });

  // The focused capability setters (`mutate*AgentCapabilityOverrides`) route the
  // agent-capability conflict-checked commit. They previously nested `timedSync`
  // INSIDE `withWriteQueueSync`, firing their `state.mutate.complete` log
  // (synchronous `appendFileSync`) with the lock held. `timed` now wraps the
  // queue CALL through the injectable store logger, so the completion log must
  // land strictly after `queue:exit`.
  it("mutateProjectAgentCapabilityOverrides logs completion only after the queue exits", async () => {
    const store = createStateStore({
      db,
      writeQueue: makeRecordingQueue(),
      logger: makeRecordingLogger(),
    });

    await store.mutateProjectAgentCapabilityOverrides(
      "/proj",
      "test.cap",
      () => ({ write: false, result: undefined }),
    );

    expect(orderingMarks()).toEqual([
      "queue:enter",
      "queue:exit",
      "log:state.mutate.complete",
    ]);
  });
});
