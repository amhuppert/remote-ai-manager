import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_VALIDATION_CONFIG,
  DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
  graphWorkflowAgentValidationConfigSchema,
  graphWorkflowAgentValidationOverrideSchema,
  graphWorkflowCommandSelectorSchema,
  graphWorkflowLaneMergeValidationConfigSchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "./config-schemas";

describe("graphWorkflowCommandSelectorSchema", () => {
  it("defaults an all-selector's except list to empty", () => {
    expect(graphWorkflowCommandSelectorSchema.parse({ mode: "all" })).toEqual({
      mode: "all",
      except: [],
    });
  });

  it("parses all-except and only selectors", () => {
    expect(
      graphWorkflowCommandSelectorSchema.parse({
        mode: "all",
        except: ["format"],
      }),
    ).toEqual({ mode: "all", except: ["format"] });
    expect(
      graphWorkflowCommandSelectorSchema.parse({
        mode: "only",
        commands: ["typecheck", "test"],
      }),
    ).toEqual({ mode: "only", commands: ["typecheck", "test"] });
  });

  it("requires an explicit commands list on an only-selector", () => {
    expect(
      graphWorkflowCommandSelectorSchema.safeParse({ mode: "only" }).success,
    ).toBe(false);
  });

  it("rejects unknown modes and non-kebab command names", () => {
    expect(
      graphWorkflowCommandSelectorSchema.safeParse({ mode: "none" }).success,
    ).toBe(false);
    expect(
      graphWorkflowCommandSelectorSchema.safeParse({
        mode: "only",
        commands: ["Test Suite"],
      }).success,
    ).toBe(false);
  });
});

describe("graphWorkflowAgentValidationConfigSchema", () => {
  it("seeds implementer to all-commands and contextValidator to none", () => {
    expect(graphWorkflowAgentValidationConfigSchema.parse({})).toEqual({
      implementer: { mode: "all", except: [] },
      contextValidator: { mode: "only", commands: [] },
    });
    expect(DEFAULT_AGENT_VALIDATION_CONFIG).toEqual(
      graphWorkflowAgentValidationConfigSchema.parse({}),
    );
  });

  it("override variant keeps omitted role selectors absent (inherit)", () => {
    const parsed = graphWorkflowAgentValidationOverrideSchema.parse({
      implementer: { mode: "all", except: ["format"] },
    });

    expect(parsed.implementer).toEqual({ mode: "all", except: ["format"] });
    expect(parsed.contextValidator).toBeUndefined();
  });
});

describe("graphWorkflowLaneMergeValidationConfigSchema", () => {
  it("defaults to final-only strategy with project command selection", () => {
    expect(graphWorkflowLaneMergeValidationConfigSchema.parse({})).toEqual({
      strategy: "final-only",
      commands: { mode: "project" },
    });
    expect(DEFAULT_LANE_MERGE_VALIDATION_CONFIG).toEqual(
      graphWorkflowLaneMergeValidationConfigSchema.parse({}),
    );
  });

  it("accepts every-merge with an explicit only-selection", () => {
    expect(
      graphWorkflowLaneMergeValidationConfigSchema.parse({
        strategy: "every-merge",
        commands: { mode: "only", commands: ["typecheck", "test"] },
      }),
    ).toEqual({
      strategy: "every-merge",
      commands: { mode: "only", commands: ["typecheck", "test"] },
    });
  });

  it("accepts an empty only-selection (lane-merge validation disabled)", () => {
    expect(
      graphWorkflowLaneMergeValidationConfigSchema.parse({
        commands: { mode: "only", commands: [] },
      }).commands,
    ).toEqual({ mode: "only", commands: [] });
  });

  it("rejects an unknown strategy", () => {
    expect(
      graphWorkflowLaneMergeValidationConfigSchema.safeParse({
        strategy: "last-two",
      }).success,
    ).toBe(false);
  });
});

describe("graphWorkflowScriptValidatorConfigSchema", () => {
  it("defaults to an empty selection", () => {
    expect(graphWorkflowScriptValidatorConfigSchema.parse({})).toEqual({
      commands: [],
    });
  });

  it("accepts an ordered commands list", () => {
    expect(
      graphWorkflowScriptValidatorConfigSchema.parse({
        commands: ["typecheck", "test"],
      }),
    ).toEqual({ commands: ["typecheck", "test"] });
  });

  // The cutover leaves no path that still honours `enabled` (design §10:
  // "no intermediate state"). Persisted values reach `commands` through
  // migration 0013, so a config that still carries the flag is stale input,
  // not a supported shape.
  it("rejects the removed legacy enabled flag", () => {
    expect(
      graphWorkflowScriptValidatorConfigSchema.safeParse({ enabled: true })
        .success,
    ).toBe(false);
  });

  it("rejects non-kebab command names", () => {
    expect(
      graphWorkflowScriptValidatorConfigSchema.safeParse({
        commands: ["bun run test"],
      }).success,
    ).toBe(false);
  });
});
