import { describe, it, expect } from "vitest";
import type {
  GraphWorkflowAgentValidationConfig,
  GraphWorkflowLaneMergeValidationConfig,
} from "@/lib/workflow-graph/config-schemas";
import {
  resolveContextAgentValidation,
  resolveWorkflowAgentValidation,
  resolveWorkflowLaneMergeValidation,
} from "./validation-cascade";

const GLOBAL: GraphWorkflowAgentValidationConfig = {
  implementer: { mode: "all", except: [] },
  contextValidator: { mode: "only", commands: [] },
};

const GLOBAL_LANE_MERGE: GraphWorkflowLaneMergeValidationConfig = {
  strategy: "final-only",
  commands: { mode: "project" },
};

describe("resolveContextAgentValidation (per-leaf, 3 layers)", () => {
  it("falls back to global for both roles when nothing overrides", () => {
    const result = resolveContextAgentValidation(undefined, undefined, GLOBAL);
    expect(result.implementer).toEqual({
      value: GLOBAL.implementer,
      source: "global",
    });
    expect(result.contextValidator).toEqual({
      value: GLOBAL.contextValidator,
      source: "global",
    });
    expect(result.blockSource).toBe("global");
  });

  it("a context role override wins for that role only; the other role inherits workflow", () => {
    const result = resolveContextAgentValidation(
      { implementer: { mode: "only", commands: ["test"] } },
      { contextValidator: { mode: "only", commands: ["typecheck"] } },
      GLOBAL,
    );
    expect(result.implementer).toEqual({
      value: { mode: "only", commands: ["test"] },
      source: "context-override",
    });
    expect(result.contextValidator).toEqual({
      value: { mode: "only", commands: ["typecheck"] },
      source: "workflow",
    });
    expect(result.blockSource).toBe("context-override");
  });

  it("a workflow role override applies per role; the untouched role stays global", () => {
    const result = resolveContextAgentValidation(
      undefined,
      { implementer: { mode: "all", except: ["format"] } },
      GLOBAL,
    );
    expect(result.implementer).toEqual({
      value: { mode: "all", except: ["format"] },
      source: "workflow",
    });
    expect(result.contextValidator).toEqual({
      value: GLOBAL.contextValidator,
      source: "global",
    });
    expect(result.blockSource).toBe("workflow");
  });

  it("an empty context override object claims the block without touching either role", () => {
    // Whole-block replacement is exactly the trap the per-leaf cascade
    // prevents: an override object with no roles must not erase anything.
    const result = resolveContextAgentValidation(
      {},
      { contextValidator: { mode: "only", commands: ["test"] } },
      GLOBAL,
    );
    expect(result.implementer.source).toBe("global");
    expect(result.contextValidator).toEqual({
      value: { mode: "only", commands: ["test"] },
      source: "workflow",
    });
    expect(result.blockSource).toBe("context-override");
  });
});

describe("resolveWorkflowAgentValidation (per-leaf, 2 layers)", () => {
  it("falls back to global when the workflow layer does not override", () => {
    const result = resolveWorkflowAgentValidation(undefined, GLOBAL);
    expect(result.implementer.source).toBe("global");
    expect(result.contextValidator.source).toBe("global");
    expect(result.blockSource).toBe("global");
  });

  it("resolves each role independently and reports the block as overridden", () => {
    const result = resolveWorkflowAgentValidation(
      { implementer: { mode: "only", commands: ["lint"] } },
      GLOBAL,
    );
    expect(result.implementer).toEqual({
      value: { mode: "only", commands: ["lint"] },
      source: "workflow",
    });
    expect(result.contextValidator).toEqual({
      value: GLOBAL.contextValidator,
      source: "global",
    });
    expect(result.blockSource).toBe("context-override");
  });
});

describe("resolveWorkflowLaneMergeValidation (per-leaf, 2 layers)", () => {
  it("falls back to global when the workflow layer does not override", () => {
    const result = resolveWorkflowLaneMergeValidation(
      undefined,
      GLOBAL_LANE_MERGE,
    );
    expect(result.value).toEqual(GLOBAL_LANE_MERGE);
    expect(result.source).toBe("global");
  });

  it("merges a partial override per leaf over global", () => {
    const result = resolveWorkflowLaneMergeValidation(
      { strategy: "every-merge" },
      GLOBAL_LANE_MERGE,
    );
    expect(result.value).toEqual({
      strategy: "every-merge",
      commands: { mode: "project" },
    });
    expect(result.source).toBe("context-override");
  });

  it("a commands-only override keeps the inherited strategy", () => {
    const result = resolveWorkflowLaneMergeValidation(
      { commands: { mode: "only", commands: [] } },
      GLOBAL_LANE_MERGE,
    );
    expect(result.value).toEqual({
      strategy: "final-only",
      commands: { mode: "only", commands: [] },
    });
    expect(result.source).toBe("context-override");
  });
});
