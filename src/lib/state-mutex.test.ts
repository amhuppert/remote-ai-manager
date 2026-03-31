import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { withStateLock, _resetForTesting } from "./state-mutex";
import { createStateManager } from "./state";

const TEST_DIR = path.join("/tmp", "cc-state-mutex-test-" + Date.now());
const STATE_FILE = path.join(TEST_DIR, "state.json");

const testReadConfig = vi.fn().mockResolvedValue({
  baseDir: "/tmp/projects",
  ignorePatterns: [],
  stateFilePath: STATE_FILE,
  claudeTimeoutMs: 300_000,
});

/** State manager backed by the test config */
const testState = createStateManager({ readConfig: testReadConfig });

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  _resetForTesting();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("withStateLock", () => {
  it("serializes concurrent operations", async () => {
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
    const result = await withStateLock("test", async () => 42);
    expect(result).toBe(42);
  });

  it("releases lock after error so subsequent operations proceed", async () => {
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
    const result = await withStateLock("post-reset", async () => "clean");
    expect(result).toBe("clean");
  });
});

describe("mutateState", () => {
  it("serializes concurrent state mutations", async () => {
    // Seed state with a counter field stored as a session name
    await testState.writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
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
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    // Concurrent mutations that each toggle a different flag
    const promises = Array.from({ length: 5 }, (_, i) =>
      testState.mutateState(`concurrent-${i}`, (state) => {
        const session = state.projects["/proj"]!.sessions["counter"]!;
        // Accumulate: each mutation reads current value and adds to it
        session.objective = String(Number(session.objective ?? "0") + 1);
      }),
    );

    await Promise.all(promises);

    const finalState = await testState.readState();
    const session = finalState.projects["/proj"]!.sessions["counter"]!;
    // All 5 mutations should have been applied sequentially
    expect(session.objective).toBe("5");
  });
});

describe("mutateSession", () => {
  it("creates project if missing and mutates session", async () => {
    await testState.writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
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
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await testState.mutateSession(
      "/proj",
      "test",
      "test.archive",
      (session) => {
        session.archived = true;
      },
    );

    const state = await testState.readState();
    expect(state.projects["/proj"]!.sessions["test"]!.archived).toBe(true);
  });

  it("throws if session not found", async () => {
    await testState.writeState({
      projects: {
        "/proj": { rootPath: "/proj", roadmapItems: [], sessions: {} },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await expect(
      testState.mutateSession("/proj", "nonexistent", "test", () => {}),
    ).rejects.toThrow('Session "nonexistent" not found');
  });

  it("returns values from the mutation callback", async () => {
    await testState.writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
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
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const name = await testState.mutateSession(
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
    const now = new Date().toISOString();
    await testState.writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
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
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              workflow: null,
              workflowHistory: [],
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    // Fire both concurrently — the mutex ensures they don't race
    await Promise.all([
      testState.setSessionFinished("/proj", "target"),
      testState.mutateSession(
        "/proj",
        "target",
        "workflow.update",
        (session) => {
          session.objective = "updated-objective";
        },
      ),
    ]);

    const state = await testState.readState();
    const session = state.projects["/proj"]!.sessions["target"]!;

    // Both changes must be present
    expect(session.finished).toBe(true);
    expect(session.archived).toBe(true);
    expect(session.objective).toBe("updated-objective");
  });
});
