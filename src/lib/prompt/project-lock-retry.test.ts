import { describe, expect, it, vi } from "vitest";
import { acquireProjectLockWithRetry } from "./project-lock-retry";

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
