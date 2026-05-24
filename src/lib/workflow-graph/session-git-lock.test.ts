import { describe, it, expect, vi } from "vitest";
import { createSessionGitLock } from "./session-git-lock";
import { createLockManager } from "@/lib/prompt/single-flight";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSessionGitLock", () => {
  const key = { projectPath: "/proj", sessionName: "session-a" };

  it("acquires the underlying session lock and releases it on success", async () => {
    const lockManager = createLockManager();
    const gitLock = createSessionGitLock({ lockManager });

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
    const gitLock = createSessionGitLock({ lockManager });

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
    const gitLock = createSessionGitLock({
      lockManager,
      retryMs: 5,
      maxWaitMs: 5_000,
    });

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
    const gitLock = createSessionGitLock({
      lockManager,
      retryMs: 5,
      maxWaitMs: 5_000,
    });

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
    const gitLock = createSessionGitLock({
      lockManager,
      retryMs: 2,
      maxWaitMs: 30,
    });

    const release = lockManager.acquireSessionLock(
      key.projectPath,
      key.sessionName,
    );

    await expect(
      gitLock.withSessionGitLock(key, async () => "never"),
    ).rejects.toThrow();

    release();
  });

  it("uses the lockManager's acquire (verified via spy) so user jobs share the same gate", async () => {
    const lockManager = createLockManager();
    const acquireSpy = vi.spyOn(lockManager, "acquireSessionLock");
    const gitLock = createSessionGitLock({ lockManager });

    await gitLock.withSessionGitLock(key, async () => {});

    expect(acquireSpy).toHaveBeenCalledWith(key.projectPath, key.sessionName);
  });
});
