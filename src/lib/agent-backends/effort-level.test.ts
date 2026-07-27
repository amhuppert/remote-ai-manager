import { describe, expect, it } from "vitest";
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import {
  claudeEffortLevelSchema,
  claudeModelSchema,
  codexModelSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
  getCodexReasoningLevelsForModel,
  getEffortLevelsForModel,
  clampEffortToModel,
} from "@/lib/agent-backends/schemas";

describe("effortLevelSchema", () => {
  it("accepts all unified effort levels", () => {
    expect(effortLevelSchema.parse("minimal")).toBe("minimal");
    expect(effortLevelSchema.parse("low")).toBe("low");
    expect(effortLevelSchema.parse("medium")).toBe("medium");
    expect(effortLevelSchema.parse("high")).toBe("high");
    expect(effortLevelSchema.parse("max")).toBe("max");
    expect(effortLevelSchema.parse("xhigh")).toBe("xhigh");
  });

  it("rejects unknown values", () => {
    const result = effortLevelSchema.safeParse("turbo");
    expect(result.success).toBe(false);
  });
});

describe("claudeEffortLevelSchema", () => {
  it("accepts xhigh for Opus 5", () => {
    expect(claudeEffortLevelSchema.parse("xhigh")).toBe("xhigh");
  });

  it("accepts standard Claude effort levels", () => {
    expect(claudeEffortLevelSchema.parse("low")).toBe("low");
    expect(claudeEffortLevelSchema.parse("medium")).toBe("medium");
    expect(claudeEffortLevelSchema.parse("high")).toBe("high");
    expect(claudeEffortLevelSchema.parse("max")).toBe("max");
  });

  it("rejects minimal (Codex-only)", () => {
    expect(claudeEffortLevelSchema.safeParse("minimal").success).toBe(false);
  });
});

describe("getEffortLevelsForModel", () => {
  it("returns only the supported Opus 5 levels in ascending order", () => {
    expect(getEffortLevelsForModel("opus")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns low/medium/high for sonnet (no xhigh)", () => {
    expect(getEffortLevelsForModel("sonnet")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("returns empty array for haiku", () => {
    expect(getEffortLevelsForModel("haiku")).toEqual([]);
  });

  it("returns the full range for fable (including xhigh and max)", () => {
    expect(getEffortLevelsForModel("fable")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("clampEffortToModel", () => {
  it("returns the effort unchanged when supported by the model", () => {
    expect(clampEffortToModel("high", "opus")).toBe("high");
    expect(clampEffortToModel("low", "sonnet")).toBe("low");
  });

  it("returns xhigh unchanged for opus", () => {
    expect(clampEffortToModel("xhigh", "opus")).toBe("xhigh");
  });

  it("clamps xhigh down to high for sonnet", () => {
    expect(clampEffortToModel("xhigh", "sonnet")).toBe("high");
  });

  it("clamps max down to high for sonnet", () => {
    expect(clampEffortToModel("max", "sonnet")).toBe("high");
  });

  it("returns undefined for haiku", () => {
    expect(clampEffortToModel("high", "haiku")).toBeUndefined();
  });

  it("returns max and xhigh unchanged for fable", () => {
    expect(clampEffortToModel("max", "fable")).toBe("max");
    expect(clampEffortToModel("xhigh", "fable")).toBe("xhigh");
  });
});

describe("codexModelSchema", () => {
  it("accepts the GPT-5.6 Sol, Terra, and Luna models", () => {
    expect(codexModelSchema.parse("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(codexModelSchema.parse("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(codexModelSchema.parse("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("still accepts the GPT-5.5 and GPT-5.4 family", () => {
    expect(codexModelSchema.parse("gpt-5.5")).toBe("gpt-5.5");
    expect(codexModelSchema.parse("gpt-5.4")).toBe("gpt-5.4");
    expect(codexModelSchema.parse("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(codexModelSchema.parse("gpt-5.4-nano")).toBe("gpt-5.4-nano");
  });
});

describe("codexReasoningEffortSchema", () => {
  it("accepts the GPT-5.6 max and ultra levels", () => {
    expect(codexReasoningEffortSchema.parse("max")).toBe("max");
    expect(codexReasoningEffortSchema.parse("ultra")).toBe("ultra");
  });

  it("accepts the standard Codex levels", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
      expect(codexReasoningEffortSchema.parse(level)).toBe(level);
    }
  });
});

describe("getCodexReasoningLevelsForModel (GPT-5.6)", () => {
  it("gives Sol the full range including max and ultra", () => {
    expect(getCodexReasoningLevelsForModel("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("withholds max and ultra from Terra (Sol-only levels)", () => {
    const levels = getCodexReasoningLevelsForModel("gpt-5.6-terra");
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levels).not.toContain("max");
    expect(levels).not.toContain("ultra");
  });

  it("withholds max and ultra from Luna (Sol-only levels)", () => {
    const levels = getCodexReasoningLevelsForModel("gpt-5.6-luna");
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levels).not.toContain("max");
    expect(levels).not.toContain("ultra");
  });
});

describe("getEffortLevelsForBackend (codex)", () => {
  it("surfaces max and ultra for the Sol model", () => {
    const levels = getEffortLevelsForBackend("codex", "gpt-5.6-sol");
    expect(levels).toContain("max");
    expect(levels).toContain("ultra");
  });

  it("does not surface max or ultra for Terra or Luna", () => {
    for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
      const levels = getEffortLevelsForBackend("codex", model);
      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultra");
    }
  });
});

describe("claudeModelSchema", () => {
  it("accepts the fable alias", () => {
    expect(claudeModelSchema.parse("fable")).toBe("fable");
  });

  it("still accepts opus, sonnet, and haiku", () => {
    expect(claudeModelSchema.parse("opus")).toBe("opus");
    expect(claudeModelSchema.parse("sonnet")).toBe("sonnet");
    expect(claudeModelSchema.parse("haiku")).toBe("haiku");
  });
});
