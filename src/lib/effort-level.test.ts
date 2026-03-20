import { describe, expect, it } from "vitest";
import { effortLevelSchema } from "./schemas";

describe("effortLevelSchema", () => {
  it("accepts low, medium, and high", () => {
    expect(effortLevelSchema.parse("low")).toBe("low");
    expect(effortLevelSchema.parse("medium")).toBe("medium");
    expect(effortLevelSchema.parse("high")).toBe("high");
  });

  it("rejects max", () => {
    const result = effortLevelSchema.safeParse("max");
    expect(result.success).toBe(false);
  });
});
