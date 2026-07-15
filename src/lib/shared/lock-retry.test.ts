import { describe, expect, it, vi } from "vitest";
import { createLockManager } from "@/lib/prompt/single-flight";
import {
  acquireProjectLockWithRetry,
  createSessionGitLock,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
} from "./lock-retry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("lock-retry defaults", () => {
  it("keeps the shared polling constants both lock consumers rely on", () => {
    expect(DEFAULT_MAX_WAIT_MS).toBe(30_000);
    expect(DEFAULT_RETRY_MS).toBe(100);
  });
});

describe("acquireProjectLockWithRetry", () => {
  it("returns the release closure on first successful acquire", async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);

    const result = await acquireProjectLockWithRetry({
      acquireProjectLock: acquire,
      projectPath: "/p",
      retryMs: 2,
      maxWaitMs: 50,
    });

    expect(result).toBe(release);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("polls until acquire succeeds, then returns the release closure", async () => {
    const release = vi.fn();
    let attempt = 0;
    const acquire = vi.fn(() => {
      attempt += 1;
      if (attempt < 3) {
        throw new Error("project busy");
      }
      return release;
    });
    const sleep = vi.fn(async () => {});

    const result = await acquireProjectLockWithRetry({
      acquireProjectLock: acquire,
      projectPath: "/p",
      retryMs: 2,
      maxWaitMs: 1_000,
      sleep,
    });

    expect(result).toBe(release);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2);
  });

  it("never acquires past the deadline, even when a sleep overshoots the remaining budget", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const release = vi.fn();
      let attempt = 0;
      const acquire = vi.fn(() => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("project busy");
        }
        return release;
      });
      // The single sleep consumes far more than the whole budget, so any
      // post-sleep attempt would land past the deadline — the lock would be
      // free by then, but taking it violates the documented maximum wait.
      const sleep = vi.fn(async () => {
        now += 200;
      });

      await expect(
        acquireProjectLockWithRetry({
          acquireProjectLock: acquire,
          projectPath: "/p",
          retryMs: 10,
          maxWaitMs: 50,
          sleep,
        }),
      ).rejects.toThrow(/Another merge is in progress/i);

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("throws when the wait window expires without success", async () => {
    const acquire = vi.fn(() => {
      throw new Error("project busy");
    });

    await expect(
      acquireProjectLockWithRetry({
        acquireProjectLock: acquire,
        projectPath: "/p",
        retryMs: 2,
        maxWaitMs: 20,
      }),
    ).rejects.toThrow(/Another merge is in progress/i);
  });
});

describe("createSessionGitLock", () => {
  const key = { projectPath: "/proj", sessionName: "session-a" };

  function gitLockOver(
    lockManager: ReturnType<typeof createLockManager>,
    policy: { retryMs?: number; maxWaitMs?: number } = {},
  ) {
    return createSessionGitLock({
      acquireSessionLock: (projectPath, sessionName) =>
        lockManager.acquireSessionLock(projectPath, sessionName),
      ...policy,
    });
  }

  it("acquires the underlying session lock and releases it on success", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager);

    const result = await gitLock.withSessionGitLock(key, async () => {
      expect(lockManager.isSessionBusy(key.projectPath, key.sessionName)).toBe(
        true,
      );
      return "ok";
    });

    expect(result).toBe("ok");
    expect(lockManager.isSessionBusy(key.projectPath, key.sessionName)).toBe(
      false,
    );
  });

  it("releases the session lock if fn throws", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager);

    await expect(
      gitLock.withSessionGitLock(key, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(lockManager.isSessionBusy(key.projectPath, key.sessionName)).toBe(
      false,
    );
  });

  it("waits and retries while another caller holds the same session lock, then runs fn after release", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager, { retryMs: 5, maxWaitMs: 5_000 });

    // Simulate a user-triggered commit/merge job holding the session lock.
    const externalRelease = lockManager.acquireSessionLock(
      key.projectPath,
      key.sessionName,
    );

    let ran = false;
    const finished = gitLock.withSessionGitLock(key, async () => {
      ran = true;
      return "after-wait";
    });

    // Give the lock a chance to retry several times while we still hold it.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ran).toBe(false);
    expect(lockManager.isSessionBusy(key.projectPath, key.sessionName)).toBe(
      true,
    );

    externalRelease();

    await expect(finished).resolves.toBe("after-wait");
    expect(ran).toBe(true);
    expect(lockManager.isSessionBusy(key.projectPath, key.sessionName)).toBe(
      false,
    );
  });

  it("queues a second caller until the first releases the lock", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager, { retryMs: 5, maxWaitMs: 5_000 });

    const order: string[] = [];
    const gate = deferred<void>();

    const first = gitLock.withSessionGitLock(key, async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });

    // Allow first to acquire the lock.
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["first-start"]);

    const second = gitLock.withSessionGitLock(key, async () => {
      order.push("second-start");
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(order).toEqual(["first-start"]);

    gate.resolve();
    await first;
    await second;

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("throws after maxWaitMs if the lock never frees", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager, { retryMs: 2, maxWaitMs: 30 });

    const release = lockManager.acquireSessionLock(
      key.projectPath,
      key.sessionName,
    );

    await expect(
      gitLock.withSessionGitLock(key, async () => "never"),
    ).rejects.toThrow(/Timed out waiting for session git lock/);

    release();
  });

  it("enters fn in the same tick when the lock is uncontended", async () => {
    const lockManager = createLockManager();
    const gitLock = gitLockOver(lockManager);

    let entered = false;
    const pending = gitLock.withSessionGitLock(key, async () => {
      entered = true;
    });

    // No suspension before fn on the uncontended path: downstream schedulers
    // (e.g. the graph execution loop's lane merges) rely on critical sections
    // starting in the same tick as the call, preserving completion order.
    expect(entered).toBe(true);
    await pending;
  });

  it("uses the injected acquire (verified via spy) so user jobs share the same gate", async () => {
    const lockManager = createLockManager();
    const acquireSpy = vi.spyOn(lockManager, "acquireSessionLock");
    const gitLock = gitLockOver(lockManager);

    await gitLock.withSessionGitLock(key, async () => {});

    expect(acquireSpy).toHaveBeenCalledWith(key.projectPath, key.sessionName);
  });
});
