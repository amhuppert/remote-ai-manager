import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_VALIDATION_CONFIG,
  DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
  graphWorkflowAgentConfigSchema,
  graphWorkflowAgentValidationConfigSchema,
  graphWorkflowAgentValidationOverrideSchema,
  graphWorkflowCommandSelectorSchema,
  graphWorkflowLaneMergeValidationConfigSchema,
  graphWorkflowScriptValidatorConfigSchema,
  validatorAssignmentSchema,
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

describe("graphWorkflowAgentConfigSchema", () => {
  it("defaults an omitted backend to claude and accepts both role-capable backends", () => {
    expect(
      graphWorkflowAgentConfigSchema.parse({
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      }),
    ).toEqual({
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "medium" },
      },
    });
    expect(
      graphWorkflowAgentConfigSchema.safeParse({
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts Cursor workflow staffing with its model selection", () => {
    const assignment = {
      backend: "cursor",
      modelSelection: { modelId: "composer-2.5", parameters: { fast: "true" } },
    };
    expect(graphWorkflowAgentConfigSchema.parse(assignment)).toEqual(
      assignment,
    );
  });

  it("keeps zod's own message for an unregistered backend value", () => {
    const result = graphWorkflowAgentConfigSchema.safeParse({
      backend: "mystery",
      modelSelection: { modelId: "m", parameters: {} },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).not.toContain("task facet");
  });

  // An arm that matches and then fails on its own fields must not be
  // mislabelled as a facet problem.
  it("rejects the removed tuple fields on a matched backend", () => {
    const result = graphWorkflowAgentConfigSchema.safeParse({
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => issue.path[0] === "model"),
    ).toBe(true);
  });
});

describe("validatorAssignmentSchema", () => {
  const assignment = {
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
    authority: "advisory",
    agent: {
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    },
  };

  it("accepts an assignment without a strategy", () => {
    expect(validatorAssignmentSchema.safeParse(assignment).success).toBe(true);
  });

  // Validators run on one durable conversation each; the retired strategy is
  // an unrecognized key, not a defaulted one.
  it.each(["conversation", "task"])(
    "rejects a retired strategy %s at its own path",
    (strategy) => {
      const result = validatorAssignmentSchema.safeParse({
        ...assignment,
        strategy,
      });

      expect(result.success).toBe(false);
      expect(
        result.error?.issues.some(
          (issue) =>
            issue.code === "unrecognized_keys" &&
            "keys" in issue &&
            issue.keys.includes("strategy"),
        ),
      ).toBe(true);
    },
  );
});
