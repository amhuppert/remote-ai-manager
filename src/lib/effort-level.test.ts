import { describe, expect, it } from "vitest";
import {
  effortLevelSchema,
  getEffortLevelsForModel,
  clampEffortToModel,
} from "./schemas";

describe("effortLevelSchema", () => {
  it("accepts low, medium, high, and max", () => {
    expect(effortLevelSchema.parse("low")).toBe("low");
    expect(effortLevelSchema.parse("medium")).toBe("medium");
    expect(effortLevelSchema.parse("high")).toBe("high");
    expect(effortLevelSchema.parse("max")).toBe("max");
  });

  it("rejects unknown values", () => {
    const result = effortLevelSchema.safeParse("turbo");
    expect(result.success).toBe(false);
  });
});

describe("getEffortLevelsForModel", () => {
  it("returns all levels for opus", () => {
    expect(getEffortLevelsForModel("opus")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("returns low/medium/high for sonnet", () => {
    expect(getEffortLevelsForModel("sonnet")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("returns empty array for haiku", () => {
    expect(getEffortLevelsForModel("haiku")).toEqual([]);
  });
});

describe("clampEffortToModel", () => {
  it("returns the effort unchanged when supported by the model", () => {
    expect(clampEffortToModel("high", "opus")).toBe("high");
    expect(clampEffortToModel("low", "sonnet")).toBe("low");
  });

  it("clamps max down to high for sonnet", () => {
    expect(clampEffortToModel("max", "sonnet")).toBe("high");
  });

  it("returns undefined for haiku", () => {
    expect(clampEffortToModel("high", "haiku")).toBeUndefined();
  });
});
