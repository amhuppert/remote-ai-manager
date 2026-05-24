import { describe, it, expect } from "vitest";
import { pickPreferredEffort } from "./use-backend-model-effort";

describe("pickPreferredEffort", () => {
  it("returns preferred when supported", () => {
    expect(pickPreferredEffort(["low", "medium", "high"], "medium")).toBe(
      "medium",
    );
  });

  it("falls back to high when preferred unsupported and high available", () => {
    expect(pickPreferredEffort(["low", "high"], "medium")).toBe("high");
  });

  it("falls back to first level when neither preferred nor high available", () => {
    expect(pickPreferredEffort(["low", "medium"], "minimal")).toBe("low");
  });

  it("returns preferred when no levels available (effort unsupported)", () => {
    expect(pickPreferredEffort([], "high")).toBe("high");
  });
});
