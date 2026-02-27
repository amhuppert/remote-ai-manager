import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "cc-state-mutex-test-" + Date.now());
const STATE_FILE = path.join(TEST_DIR, "state.json");

vi.mock("./config", () => ({
  readConfig: vi.fn().mockResolvedValue({
    baseDir: "/tmp/projects",
    ignorePatterns: [],
    stateFilePath: STATE_FILE,
    claudeTimeoutMs: 300_000,
  }),
}));

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("withStateLock", () => {
  it("serializes concurrent operations", async () => {
    const { withStateLock, _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    let counter = 0;
    const increment = () =>
      withStateLock("increment", async () => {
        const current = counter;
        // Yield to event loop to simulate async gap
        await new Promise((r) => setTimeout(r, 1));
        counter = current + 1;
      });

    // Fire 10 concurrent increments
    await Promise.all(Array.from({ length: 10 }, () => increment()));

    // Without mutex, counter would be 1 (all read 0, all write 1)
    // With mutex, counter should be 10
    expect(counter).toBe(10);
  });

  it("maintains FIFO ordering", async () => {
    const { withStateLock, _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    const order: number[] = [];
    const promises = [1, 2, 3, 4, 5].map((n) =>
      withStateLock(`op-${n}`, async () => {
        // Random delay to prove ordering is by call order, not completion time
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        order.push(n);
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns the value from the callback", async () => {
    const { withStateLock, _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    const result = await withStateLock("test", async () => 42);
    expect(result).toBe(42);
  });

  it("releases lock after error so subsequent operations proceed", async () => {
    const { withStateLock, _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    await expect(
      withStateLock("fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // This should not deadlock
    const result = await withStateLock("after-fail", async () => "ok");
    expect(result).toBe("ok");
  });

  it("_resetForTesting clears the mutex state", async () => {
    const { withStateLock, _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    const result = await withStateLock("post-reset", async () => "clean");
    expect(result).toBe("clean");
  });
});

describe("mutateState", () => {
  it("serializes concurrent state mutations", async () => {
    const { writeState, mutateState } = await import("./state");
    const { _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    // Seed state with a counter field stored as a session name
    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            counter: {
              sessionName: "counter",
              worktreePath: "/wt",
              branchName: "csm/counter",
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              archived: false,
              finished: false,
              conversations: [],
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              workflow: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    // Concurrent mutations that each toggle a different flag
    const promises = Array.from({ length: 5 }, (_, i) =>
      mutateState(`concurrent-${i}`, (state) => {
        const session = state.projects["/proj"]!.sessions["counter"]!;
        // Accumulate: each mutation reads current value and adds to it
        session.objective = String(Number(session.objective ?? "0") + 1);
      }),
    );

    await Promise.all(promises);

    const { readState } = await import("./state");
    const finalState = await readState();
    const session = finalState.projects["/proj"]!.sessions["counter"]!;
    // All 5 mutations should have been applied sequentially
    expect(session.objective).toBe("5");
  });
});

describe("mutateSession", () => {
  it("creates project if missing and mutates session", async () => {
    const { writeState, mutateSession, readState } = await import("./state");
    const { _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/wt",
              branchName: "csm/test",
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              archived: false,
              finished: false,
              conversations: [],
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              workflow: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await mutateSession("/proj", "test", "test.archive", (session) => {
      session.archived = true;
    });

    const state = await readState();
    expect(state.projects["/proj"]!.sessions["test"]!.archived).toBe(true);
  });

  it("throws if session not found", async () => {
    const { writeState, mutateSession } = await import("./state");
    const { _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    await writeState({
      projects: { "/proj": { rootPath: "/proj", sessions: {} } },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await expect(
      mutateSession("/proj", "nonexistent", "test", () => {}),
    ).rejects.toThrow('Session "nonexistent" not found');
  });

  it("returns values from the mutation callback", async () => {
    const { writeState, mutateSession } = await import("./state");
    const { _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/wt",
              branchName: "csm/test",
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              archived: false,
              finished: false,
              conversations: [],
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              workflow: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const name = await mutateSession(
      "/proj",
      "test",
      "test.getName",
      (session) => session.sessionName,
    );
    expect(name).toBe("test");
  });
});

describe("the specific merge detection bug", () => {
  it("setSessionFinished is not overwritten by concurrent mutateSession", async () => {
    const { writeState, setSessionFinished, mutateSession, readState } =
      await import("./state");
    const { _resetForTesting } = await import("./state-mutex");
    _resetForTesting();

    const now = new Date().toISOString();
    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            target: {
              sessionName: "target",
              worktreePath: "/wt",
              branchName: "csm/target",
              createdAt: now,
              lastActivityAt: now,
              archived: false,
              finished: false,
              conversations: [],
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              workflow: null,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    // Fire both concurrently — the mutex ensures they don't race
    await Promise.all([
      setSessionFinished("/proj", "target"),
      mutateSession("/proj", "target", "workflow.update", (session) => {
        session.objective = "updated-objective";
      }),
    ]);

    const state = await readState();
    const session = state.projects["/proj"]!.sessions["target"]!;

    // Both changes must be present
    expect(session.finished).toBe(true);
    expect(session.archived).toBe(true);
    expect(session.objective).toBe("updated-objective");
  });
});
