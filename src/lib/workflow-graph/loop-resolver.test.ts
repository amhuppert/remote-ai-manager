import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  DEFAULT_PLAN_REPAIR_POLICY,
  type GraphWorkflowPlanRepairPolicy,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowContextEdge,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowLoopGroup,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { cascadeWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  SEEDED_WORKFLOW_DEFAULTS,
  resolveWorkflowDefinition,
} from "./resolve-config";
import {
  RESERVED_LOOP_INSTANCE_ID_PATTERN,
  loopInstanceId,
  resolveLoopGroups,
  validateExpansionInitiator,
  validateExpansionPayloadLoopDeclarations,
} from "./loop-resolver";
import {
  createWorkflowDefinition,
  makeSeededImplementerAssignment,
  makeSeededValidatorCohort,
} from "./test-fixtures";
import {
  validateAuthoredDefinition,
  validateWorkflowDefinition,
} from "./definition-validation";

// The judge (exit) verdict the `until` predicate is written against.
const JUDGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    notes: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
};

const UNTIL_PASS: GraphWorkflowLoopGroup["until"] = {
  schema: {
    type: "object",
    properties: { verdict: { const: "pass" } },
    required: ["verdict"],
  },
};

function context(
  id: string,
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id,
    title: id,
    acceptanceCriteria: `${id} is done`,
    placement: { lane: id, mode: "full" },
    ...overrides,
  };
}

function task(id: string, contextId: string): GraphWorkflowTaskDefinition {
  return {
    id,
    contextId,
    order: 1,
    title: id,
    instructions: `Do ${id}`,
    source: "user",
  };
}

function edge(
  id: string,
  sourceContextId: string,
  targetContextId: string,
  when?: GraphWorkflowContextEdge["when"],
): GraphWorkflowContextEdge {
  return {
    id,
    sourceContextId,
    targetContextId,
    ...(when !== undefined ? { when } : {}),
  };
}

function loopGroup(
  overrides: Partial<GraphWorkflowLoopGroup> = {},
): GraphWorkflowLoopGroup {
  return {
    id: "refine",
    bodyContextIds: ["worker", "judge"],
    entryContextId: "worker",
    exitContextId: "judge",
    until: UNTIL_PASS,
    maxPasses: 5,
    ...overrides,
  };
}

/**
 * seed → [worker → judge] → publish, with the loop body declared as a group.
 * The judge is the exit and declares the output schema the `until` predicate
 * reads.
 */
function loopDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return createWorkflowDefinition({
    executionContexts: [
      context("seed"),
      context("worker"),
      context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      context("publish"),
    ],
    tasks: [
      task("task-seed", "seed"),
      task("task-worker", "worker"),
      task("task-judge", "judge"),
      task("task-publish", "publish"),
    ],
    edges: [
      edge("seed__worker", "seed", "worker"),
      edge("worker__judge", "worker", "judge"),
      edge("judge__publish", "judge", "publish"),
    ],
    loopGroups: [loopGroup()],
    ...overrides,
  });
}

function codes(definition: WorkflowSemanticDefinition): string[] {
  return validateWorkflowDefinition(definition).errors.map(
    (error) => error.code,
  );
}

describe("loop terminal-contract validation (R9.5)", () => {
  it("keeps infrastructure retries outside loop passes", () => {
    const definition = loopDefinition();
    definition.executionContexts.find(
      (entry) => entry.id === "worker",
    )!.scriptValidator = {
      commands: ["figma-ready"],
      purpose: "infrastructure",
    };
    expect(validateAuthoredDefinition(definition).errors).toContainEqual(
      expect.objectContaining({
        code: "infrastructure-check-in-loop",
        contextId: "worker",
      }),
    );
    definition.executionContexts.find(
      (entry) => entry.id === "worker",
    )!.scriptValidator = { commands: [] };
    definition.executionContexts.find(
      (entry) => entry.id === "seed",
    )!.scriptValidator = {
      commands: ["figma-ready"],
      purpose: "infrastructure",
    };
    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("accepts a well-formed loop group", () => {
    expect(validateAuthoredDefinition(loopDefinition()).errors).toEqual([]);
  });

  it("refuses a loop whose exit context declares no outputSchema", () => {
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("judge"),
        context("publish"),
      ],
    });

    const errors = validateWorkflowDefinition(definition).errors;
    const refusal = errors.find(
      (error) => error.code === "loop-exit-without-output-schema",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.contextId).toBe("judge");
    expect(refusal?.field).toBe("loopGroups[0].exitContextId");
  });

  it("refuses an until predicate outside the supported schema subset", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup({
          until: {
            schema: {
              type: "object",
              properties: { verdict: { type: "string", format: "email" } },
            },
          },
        }),
      ],
    });

    const refusal = validateWorkflowDefinition(definition).errors.find(
      (error) => error.code === "unsupported-loop-predicate",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.field).toContain("loopGroups[0].until.schema");
  });

  it("refuses an until predicate statically incompatible with the exit schema", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup({
          until: {
            schema: {
              type: "object",
              properties: { verdict: { const: "approved" } },
            },
          },
        }),
      ],
    });

    const refusal = validateWorkflowDefinition(definition).errors.find(
      (error) => error.code === "incompatible-loop-predicate",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.field).toBe(
      "loopGroups[0].until.schema.properties.verdict.const",
    );
  });

  it("refuses an until predicate naming a property the exit never declares", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup({
          until: {
            schema: {
              type: "object",
              properties: { verdcit: { const: "pass" } },
            },
          },
        }),
      ],
    });

    expect(codes(definition)).toContain("incompatible-loop-predicate");
  });
});

describe("v1 loop body-shape validation (R11.1)", () => {
  it("refuses overlapping bodies", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup(),
        loopGroup({
          id: "second",
          bodyContextIds: ["judge", "publish"],
          entryContextId: "judge",
          exitContextId: "publish",
        }),
      ],
    });

    expect(codes(definition)).toContain("overlapping-loop-bodies");
  });

  it("refuses a nested body", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup(),
        loopGroup({
          id: "inner",
          bodyContextIds: ["judge"],
          entryContextId: "judge",
          exitContextId: "judge",
        }),
      ],
    });

    expect(codes(definition)).toContain("nested-loop-body");
  });

  it("refuses a disconnected body", () => {
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("stray"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-stray", "stray"),
        task("task-judge", "judge"),
        task("task-publish", "publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge"),
        edge("judge__publish", "judge", "publish"),
      ],
      loopGroups: [loopGroup({ bodyContextIds: ["worker", "stray", "judge"] })],
    });

    expect(codes(definition)).toContain("disconnected-loop-body");
  });

  it("refuses a multi-entry body", () => {
    // `second` sits in the body with no internal predecessor — a second root.
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("second"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-second", "second"),
        task("task-judge", "judge"),
        task("task-publish", "publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge"),
        edge("second__judge", "second", "judge"),
        edge("judge__publish", "judge", "publish"),
      ],
      loopGroups: [
        loopGroup({ bodyContextIds: ["worker", "second", "judge"] }),
      ],
    });

    expect(codes(definition)).toContain("multi-entry-loop-body");
  });

  it("refuses a multi-exit body", () => {
    // `dead-end` is a second sink inside the body.
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("dead-end"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-dead-end", "dead-end"),
        task("task-judge", "judge"),
        task("task-publish", "publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge"),
        edge("worker__dead-end", "worker", "dead-end"),
        edge("judge__publish", "judge", "publish"),
      ],
      loopGroups: [
        loopGroup({ bodyContextIds: ["worker", "dead-end", "judge"] }),
      ],
    });

    expect(codes(definition)).toContain("multi-exit-loop-body");
  });

  it("refuses an external edge entering a body context that is not the entry", () => {
    const definition = loopDefinition({
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("seed__judge", "seed", "judge"),
        edge("worker__judge", "worker", "judge"),
        edge("judge__publish", "judge", "publish"),
      ],
    });

    const refusal = validateWorkflowDefinition(definition).errors.find(
      (error) => error.code === "external-edge-bypasses-loop-entry",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.edgeId).toBe("seed__judge");
  });

  it("refuses an external edge leaving a body context that is not the exit", () => {
    const definition = loopDefinition({
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge"),
        edge("worker__publish", "worker", "publish"),
        edge("judge__publish", "judge", "publish"),
      ],
    });

    const refusal = validateWorkflowDefinition(definition).errors.find(
      (error) => error.code === "external-edge-bypasses-loop-exit",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.edgeId).toBe("worker__publish");
  });

  it("refuses a conditional branch inside a body that does not reconverge at the exit", () => {
    // Every path from the entry to the exit crosses a guard, so a pass can skip
    // the exit outright — the loop could never settle.
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker", {
          outputSchema: {
            type: "object",
            properties: { route: { type: "string", enum: ["a", "b"] } },
            required: ["route"],
            additionalProperties: false,
          },
        }),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__judge", "worker", "judge", {
          schema: {
            type: "object",
            properties: { route: { const: "a" } },
            required: ["route"],
          },
        }),
        edge("judge__publish", "judge", "publish"),
      ],
    });

    const refusal = validateWorkflowDefinition(definition).errors.find(
      (error) => error.code === "non-reconverging-loop-branch",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.contextId).toBe("judge");
  });

  it("accepts a conditional fork inside a body that reconverges at the exit", () => {
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker", {
          outputSchema: {
            type: "object",
            properties: { route: { type: "string", enum: ["a", "b"] } },
            required: ["route"],
            additionalProperties: false,
          },
        }),
        context("fixup"),
        context("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("task-worker", "worker"),
        task("task-fixup", "fixup"),
        task("task-judge", "judge"),
        task("task-publish", "publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("worker__fixup", "worker", "fixup", {
          schema: {
            type: "object",
            properties: { route: { const: "a" } },
            required: ["route"],
          },
        }),
        edge("worker__judge", "worker", "judge"),
        edge("fixup__judge", "fixup", "judge"),
        edge("judge__publish", "judge", "publish"),
      ],
      loopGroups: [loopGroup({ bodyContextIds: ["worker", "fixup", "judge"] })],
    });

    expect(validateAuthoredDefinition(definition).errors).toEqual([]);
  });

  it("refuses an unknown body context, and an entry or exit outside the body", () => {
    const definition = loopDefinition({
      loopGroups: [
        loopGroup({
          bodyContextIds: ["worker", "ghost"],
          entryContextId: "seed",
          exitContextId: "publish",
        }),
      ],
    });

    const found = codes(definition);
    expect(found).toContain("unknown-loop-body-context");
    expect(found).toContain("loop-entry-not-in-body");
    expect(found).toContain("loop-exit-not-in-body");
  });

  it("refuses duplicate loop group ids", () => {
    const definition = loopDefinition({
      loopGroups: [loopGroup(), loopGroup()],
    });

    expect(codes(definition)).toContain("duplicate-loop-group-id");
  });
});

describe("reserved pass-instance id namespace", () => {
  it("mints ids the reserved pattern recognizes", () => {
    expect(loopInstanceId("refine", 2, "judge")).toBe("refine__p2__judge");
    expect(RESERVED_LOOP_INSTANCE_ID_PATTERN.test("refine__p2__judge")).toBe(
      true,
    );
  });

  it("refuses authored context, task, and edge ids in the reserved namespace", () => {
    const definition = loopDefinition({
      executionContexts: [
        context("seed"),
        context("worker"),
        context("refine__p1__judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
        context("publish"),
      ],
      tasks: [
        task("task-seed", "seed"),
        task("refine__p1__task-worker", "worker"),
        task("task-judge", "refine__p1__judge"),
        task("task-publish", "publish"),
      ],
      edges: [
        edge("seed__worker", "seed", "worker"),
        edge("refine__p1__worker__judge", "worker", "refine__p1__judge"),
        edge("judge__publish", "refine__p1__judge", "publish"),
      ],
      loopGroups: [
        loopGroup({
          bodyContextIds: ["worker", "refine__p1__judge"],
          exitContextId: "refine__p1__judge",
        }),
      ],
    });

    const reserved = validateWorkflowDefinition(definition).errors.filter(
      (error) => error.code === "reserved-loop-instance-id",
    );
    expect(reserved.map((error) => error.field)).toEqual([
      "executionContexts[2].id",
      "tasks[1].id",
      "tasks[2].contextId",
      "edges[1].id",
    ]);
  });

  it("refuses a loop group id in the reserved namespace", () => {
    const definition = loopDefinition({
      loopGroups: [loopGroup({ id: "outer__p1__inner" })],
    });

    expect(codes(definition)).toContain("reserved-loop-group-id");
  });
});

describe("expansion refusals (R11.1)", () => {
  it("refuses an expansion payload that declares a loop group", () => {
    const errors = validateExpansionPayloadLoopDeclarations({
      executionContexts: [{ id: "candidate-1" }],
      loopGroups: [loopGroup()],
    });

    expect(errors.map((error) => error.code)).toEqual([
      "loop-declaration-in-expansion",
    ]);
    expect(errors[0]?.field).toBe("loopGroups");
  });

  it("admits an expansion payload that declares no loop group", () => {
    expect(
      validateExpansionPayloadLoopDeclarations({
        executionContexts: [{ id: "candidate-1" }],
      }),
    ).toEqual([]);
  });

  it("refuses expansion from a pass instance inside an active body", () => {
    const resolved = resolvedLoopDefinition();
    const errors = validateExpansionInitiator({
      initiatorContextId: "refine__p1__worker",
      loopGroups: resolved.loopGroups ?? [],
      activation: { isActive: (loopGroupId) => loopGroupId === "refine" },
    });

    expect(errors.map((error) => error.code)).toEqual([
      "expansion-from-active-loop-body",
    ]);
    expect(errors[0]?.contextId).toBe("refine__p1__worker");
  });

  it("refuses expansion addressed at the declared body context of an active loop", () => {
    const resolved = resolvedLoopDefinition();
    const errors = validateExpansionInitiator({
      initiatorContextId: "worker",
      loopGroups: resolved.loopGroups ?? [],
      activation: { isActive: () => true },
    });

    expect(errors.map((error) => error.code)).toEqual([
      "expansion-from-active-loop-body",
    ]);
  });

  it("admits expansion from a body context whose loop is not active", () => {
    const resolved = resolvedLoopDefinition();
    expect(
      validateExpansionInitiator({
        initiatorContextId: "refine__p1__worker",
        loopGroups: resolved.loopGroups ?? [],
        activation: { isActive: () => false },
      }),
    ).toEqual([]);
  });

  it("admits expansion from a context outside every loop body", () => {
    const resolved = resolvedLoopDefinition();
    expect(
      validateExpansionInitiator({
        initiatorContextId: "seed",
        loopGroups: resolved.loopGroups ?? [],
        activation: { isActive: () => true },
      }),
    ).toEqual([]);
  });
});

function resolvedContext(
  id: string,
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    placement: { lane: id, mode: "full" as const },
    id,
    title: id,
    acceptanceCriteria: `${id} is done`,
    implementer: makeSeededImplementerAssignment({
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "medium" },
      },
    }),
    contextValidator: makeSeededValidatorCohort({
      enabled: false,
      assignments: [],
    }),
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3 },
    planRepair: DEFAULT_PLAN_REPAIR_POLICY,
    ...overrides,
  };
}

/** The seed-time resolution of {@link loopDefinition}. */
function resolvedLoopDefinition(): ResolvedWorkflowSemanticDefinition {
  const resolution = resolveLoopGroups({
    loopGroups: [loopGroup()],
    executionContexts: [
      resolvedContext("seed"),
      resolvedContext("worker"),
      resolvedContext("judge", { outputSchema: JUDGE_OUTPUT_SCHEMA }),
      resolvedContext("publish"),
    ],
    tasks: [
      task("task-seed", "seed"),
      task("task-worker", "worker"),
      task("task-judge", "judge"),
      task("task-publish", "publish"),
    ],
    edges: [
      edge("seed__worker", "seed", "worker"),
      edge("worker__judge", "worker", "judge"),
      edge("judge__publish", "judge", "publish"),
    ],
    resolvePlanRepair: () => DEFAULT_PLAN_REPAIR_POLICY,
  });

  return {
    schemaVersion: 1,
    laneMergeValidation: {
      strategy: "final-only",
      commands: { mode: "project" },
    },
    executionContexts: resolution.executionContexts,
    tasks: resolution.tasks,
    edges: resolution.edges,
    loopGroups: resolution.loopGroups,
  };
}

describe("accept-time loop resolution", () => {
  it("snapshots the body into a versioned template and removes it from executionContexts", () => {
    const resolved = resolvedLoopDefinition();
    const group = resolved.loopGroups?.[0];

    expect(resolved.executionContexts.map((c) => c.id)).toEqual([
      "seed",
      "refine__p1__worker",
      "refine__p1__judge",
      "publish",
    ]);
    expect(group?.templateVersion).toBe(1);
    expect(group?.planRepair).toEqual(DEFAULT_PLAN_REPAIR_POLICY);
    expect(group?.template.contexts.map((c) => c.id)).toEqual([
      "worker",
      "judge",
    ]);
    expect(group?.template.tasks.map((t) => t.id)).toEqual([
      "task-worker",
      "task-judge",
    ]);
    expect(group?.template.edges.map((e) => e.id)).toEqual(["worker__judge"]);
    expect(group?.entryContextId).toBe("worker");
    expect(group?.exitContextId).toBe("judge");
    expect(group?.until).toEqual(UNTIL_PASS);
    expect(group?.maxPasses).toBe(5);
  });

  it("materializes pass 1 with reserved ids for contexts, tasks, and edges", () => {
    const resolved = resolvedLoopDefinition();

    expect(resolved.tasks.map((t) => [t.id, t.contextId])).toEqual([
      ["task-seed", "seed"],
      ["task-publish", "publish"],
      ["refine__p1__task-worker", "refine__p1__worker"],
      ["refine__p1__task-judge", "refine__p1__judge"],
    ]);
    expect(
      resolved.edges.find((e) => e.id === "refine__p1__worker__judge"),
    ).toEqual({
      id: "refine__p1__worker__judge",
      sourceContextId: "refine__p1__worker",
      targetContextId: "refine__p1__judge",
    });
  });

  it("consumes the boundary edge into pass 1 and leaves the outgoing edge on the logical exit", () => {
    const resolved = resolvedLoopDefinition();

    expect(resolved.edges.find((e) => e.id === "seed__worker")).toEqual({
      id: "seed__worker",
      sourceContextId: "seed",
      targetContextId: "refine__p1__worker",
    });
    expect(resolved.edges.find((e) => e.id === "judge__publish")).toEqual({
      id: "judge__publish",
      sourceContextId: "judge",
      targetContextId: "publish",
    });
  });

  it("leaves a loop-free definition untouched and declares no loop groups", () => {
    const contexts = [resolvedContext("a"), resolvedContext("b")];
    const tasks = [task("task-a", "a")];
    const edges = [edge("a__b", "a", "b")];

    const resolution = resolveLoopGroups({
      loopGroups: [],
      executionContexts: contexts,
      tasks,
      edges,
      resolvePlanRepair: () => DEFAULT_PLAN_REPAIR_POLICY,
    });

    expect(resolution.executionContexts).toEqual(contexts);
    expect(resolution.tasks).toEqual(tasks);
    expect(resolution.edges).toEqual(edges);
    expect(resolution.loopGroups).toEqual([]);
  });

  it("keeps the resolved definition structurally valid, logical exit edge included", () => {
    expect(validateWorkflowDefinition(resolvedLoopDefinition()).errors).toEqual(
      [],
    );
  });

  it("resolves authored loop bodies into a parseable cascade artifact", () => {
    const workflowPlanRepair: GraphWorkflowPlanRepairPolicy = {
      enabled: false,
      maxAttemptsPerContext: 4,
    };
    const authored = loopDefinition({
      workflowConfig: { planRepair: workflowPlanRepair },
    });

    const resolved = cascadeWorkflowSemanticDefinitionSchema.parse(
      resolveWorkflowDefinition({} as GlobalConfig, authored),
    );

    expect(resolved.loopGroups?.[0]?.planRepair).toEqual(workflowPlanRepair);
    expect(resolved.executionContexts.map((c) => c.id)).toEqual([
      "seed",
      "refine__p1__worker",
      "refine__p1__judge",
      "publish",
    ]);
    // The body template clones the CASCADED context config, not the authored
    // sparse one: a pass instance must run the config the seed resolved.
    expect(resolved.loopGroups?.[0]?.template.contexts[0]?.implementer).toEqual(
      SEEDED_WORKFLOW_DEFAULTS.implementer,
    );
  });

  it("leaves a loop-free definition's resolved form without a loopGroups key", () => {
    const resolved = resolveWorkflowDefinition(
      {} as GlobalConfig,
      createWorkflowDefinition(),
    );

    expect(Object.hasOwn(resolved, "loopGroups")).toBe(false);
  });
});
