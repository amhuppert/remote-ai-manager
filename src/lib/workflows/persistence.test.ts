import { describe, it, expect, beforeEach } from "vitest";
import {
  persistWorkflowSnapshot,
  restoreWorkflowSnapshot,
  _resetForTesting,
} from "./persistence";

beforeEach(() => {
  _resetForTesting();
});

describe("persistWorkflowSnapshot", () => {
  it("is a no-op (legacy Ralph Loop storage removed)", () => {
    // Should not throw
    persistWorkflowSnapshot("/proj", "sess", { value: "x" } as never);
    persistWorkflowSnapshot("/proj", "sess", { value: "x" } as never, {
      immediate: true,
    });
  });
});

describe("restoreWorkflowSnapshot", () => {
  it("always returns null (legacy Ralph Loop storage removed)", async () => {
    const result = await restoreWorkflowSnapshot("/proj", "sess", 1);
    expect(result).toBeNull();
  });
});
