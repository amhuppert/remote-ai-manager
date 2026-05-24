import { describe, expect, it } from "vitest";
import {
  IterationFailureWithProgressError,
  hasPartialIterationProgress,
} from "./iteration-failure-with-progress";

describe("IterationFailureWithProgressError", () => {
  it("preserves the original error message", () => {
    const original = new Error("upstream failure");
    const wrapped = new IterationFailureWithProgressError(original, 2);

    expect(wrapped.message).toBe("upstream failure");
    expect(wrapped.originalError).toBe(original);
    expect(wrapped.completedTurnCount).toBe(2);
  });

  it("normalizes non-Error originals via getErrorMessage", () => {
    const wrapped = new IterationFailureWithProgressError("string failure", 1);

    expect(wrapped.message).toBe("string failure");
  });
});

describe("hasPartialIterationProgress", () => {
  it("returns true for an IterationFailureWithProgressError with completedTurnCount > 0", () => {
    const wrapped = new IterationFailureWithProgressError(new Error("boom"), 1);
    expect(hasPartialIterationProgress(wrapped)).toBe(true);
  });

  it("returns false when completedTurnCount is zero", () => {
    const wrapped = new IterationFailureWithProgressError(new Error("boom"), 0);
    expect(hasPartialIterationProgress(wrapped)).toBe(false);
  });

  it("returns false for plain Error instances", () => {
    expect(hasPartialIterationProgress(new Error("boom"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(hasPartialIterationProgress("oops")).toBe(false);
    expect(hasPartialIterationProgress(undefined)).toBe(false);
    expect(hasPartialIterationProgress(null)).toBe(false);
  });
});
