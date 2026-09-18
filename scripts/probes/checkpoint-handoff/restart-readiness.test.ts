import { describe, expect, it } from "vitest";
import { waitForRestartApi } from "./restart-readiness";

describe("read-only daemon restart readiness", () => {
  it("recovers one stale transport connection before a healthy API read", async () => {
    let calls = 0;
    let now = 0;
    const result = await waitForRestartApi({
      async read(signal) {
        expect(signal.aborted).toBe(false);
        if (++calls === 1) throw new TypeError("fetch failed");
        return { status: 200 };
      },
      now: () => now,
      async wait(ms) {
        now += ms;
      },
    });
    expect(result).toEqual({ attempts: 2, status: 200 });
  });
  it("stops after ten seconds when the API never becomes healthy", async () => {
    let calls = 0;
    let now = 0;
    await expect(
      waitForRestartApi({
        async read() {
          calls += 1;
          throw new TypeError("fetch failed");
        },
        now: () => now,
        async wait(ms) {
          now += ms;
        },
      }),
    ).rejects.toThrow("within 10000ms");
    expect(now).toBe(10_000);
    expect(calls).toBe(40);
  });
  it("does not retry an authentication refusal", async () => {
    let calls = 0;
    await expect(
      waitForRestartApi({
        async read() {
          calls += 1;
          return { status: 401 };
        },
        now: () => 0,
        async wait() {},
      }),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});
