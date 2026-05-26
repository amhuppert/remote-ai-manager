import { describe, expect, it } from "vitest";
import { resolveConfiguredTimeoutMs } from "./timeout";

describe("resolveConfiguredTimeoutMs", () => {
  it("returns 0 for null", () => {
    expect(resolveConfiguredTimeoutMs(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(resolveConfiguredTimeoutMs(undefined)).toBe(0);
  });

  it("returns the configured ms value unchanged", () => {
    // The codex.timeoutMs field is stored in ms (UI converts minutes → ms at
    // input). The consumer must use the value as-is and never re-scale, or it
    // overflows Node's 32-bit setTimeout cap and fires immediately.
    expect(resolveConfiguredTimeoutMs(7_200_000)).toBe(7_200_000);
  });

  it("never produces a value above setTimeout's 32-bit ms cap for a 2-hour configured timeout", () => {
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const SET_TIMEOUT_MAX_MS = 2_147_483_647;
    expect(resolveConfiguredTimeoutMs(twoHoursMs)).toBeLessThanOrEqual(
      SET_TIMEOUT_MAX_MS,
    );
  });
});
