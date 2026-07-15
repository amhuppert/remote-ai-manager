import { describe, expect, it, vi } from "vitest";
import { sleep } from "./sleep";

describe("sleep", () => {
  it("resolves after the requested delay elapses", async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      const promise = sleep(1000).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves with undefined", async () => {
    vi.useFakeTimers();
    try {
      const promise = sleep(0);
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
