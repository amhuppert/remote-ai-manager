import { describe, expect, it } from "vitest";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  seedAssignment,
} from "./test-fixtures";
import {
  getEligibleContextIds,
  getEntryContextIds,
  getTerminalContextIds,
  isContextLanded,
  validateAuthoredDefinition,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
} from "./validation";

function requiredStringParam(name: string): ParameterDeclaration {
  return { type: "string", name, label: name, required: true };
}

const PLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["ship", "hold"] } },
  required: ["verdict"],
  additionalProperties: false,
};

/** The base fixture with `context-plan` declaring an output contract. */
function withPlanOutputSchema(
  definition = createWorkflowDefinition(),
): ReturnType<typeof createWorkflowDefinition> {
  return createWorkflowDefinition({
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      context.id === "context-plan"
        ? { ...context, outputSchema: { ...PLAN_OUTPUT_SCHEMA } }
        : context,
    ),
  });
}

describe("workflow-graph validation", () => {
  it("accepts a valid execution-context DAG", () => {
    const definition = createWorkflowDefinition();
    const result = validateWorkflowDefinition(definition);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(getEntryContextIds(definition)).toEqual(["context-plan"]);
    expect(getTerminalContextIds(definition)).toEqual(["context-verify"]);
  });

  it("rejects cycles, duplicate task ids, and missing references", () => {
    const definition = createWorkflowDefinition({
      tasks: [
        ...createWorkflowDefinition().tasks,
        {
          id: "task-plan-1",
          contextId: "context-missing",
          order: 2,
          title: "Duplicate",
          instructions: "Bad task",
          source: "user",
        },
      ],
      edges: [
        ...createWorkflowDefinition().edges,
        {
          id: "edge-cycle",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
        {
          id: "edge-missing",
          sourceContextId: "context-plan",
          targetContextId: "context-missing",
        },
      ],
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "duplicate-task-id",
        "unknown-task-context",
        "unknown-edge-target",
        "cycle-detected",
      ]),
    );
  });

  it("rejects empty task instructions and empty task titles", () => {
    const definition = createWorkflowDefinition({
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "",
          instructions: "",
          source: "user",
        },
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Has title",
          instructions: "",
          source: "user",
        },
      ],
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);

    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("empty-task-title");
    expect(codes).toContain("empty-task-instructions");

    const instructionErrors = result.errors.filter(
      (e) => e.code === "empty-task-instructions",
    );
    expect(instructionErrors).toHaveLength(2);
    expect(instructionErrors[0]?.taskId).toBe("task-plan-1");
    expect(instructionErrors[1]?.taskId).toBe("task-plan-2");
  });

  it("rejects empty context title", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan" ? { ...ctx, title: "" } : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "empty-context-title")).toBe(
      true,
    );
  });

  it("rejects empty context-level acceptanceCriteria", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) =>
        ctx.id === "context-plan" ? { ...ctx, acceptanceCriteria: "" } : ctx,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "empty-context-acceptance-criteria" &&
          e.contextId === "context-plan",
      ),
    ).toBe(true);
  });

  it("does not emit the removed validator-AC rule", () => {
    const definition = createWorkflowDefinition();
    const result = validateWorkflowDefinition(definition);
    expect(
      result.errors.some(
        (e) => e.code === "empty-context-validator-acceptance-criteria",
      ),
    ).toBe(false);
  });

  it("finds all currently eligible contexts for MVP scheduling", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("requires worktree-isolation upstream to be merged before unlocking downstream", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "pending",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([]);
  });

  it("unlocks downstream once worktree-isolation upstream reports merged-success", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "merged-success",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("holds a guarded target while its completed source's merge is unresolved (D4 R2.5)", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: { verdict: { type: "string" } },
                required: ["verdict"],
              },
            }
          : context,
      ),
      edges: base.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { const: "go" } },
                  required: ["verdict"],
                },
              },
            }
          : edge,
      ),
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        executionContexts: definition.executionContexts.map((context) => ({
          ...createWorkflowExecution().workingDefinition.executionContexts.find(
            (resolved) => resolved.id === context.id,
          )!,
          ...(context.outputSchema
            ? { outputSchema: context.outputSchema }
            : {}),
        })),
        edges: definition.edges,
      },
      contextOutputs: {
        "context-plan": {
          value: { verdict: "go" },
          capturedAt: "2026-08-04T10:00:00.000Z",
          iteration: 1,
          parse: { source: "native" },
        },
      },
    });
    const blocked = createWorkflowExecution({
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "pending",
        },
      },
    });

    // The guard is TRUE — the branch was taken — but the source's work has not
    // landed, so the target must not be scheduled and must not be skipped.
    expect(getEligibleContextIds(blocked.workingDefinition, blocked)).toEqual(
      [],
    );

    const merged = createWorkflowExecution({
      ...blocked,
      contextStates: {
        ...blocked.contextStates,
        "context-plan": {
          ...blocked.contextStates["context-plan"]!,
          mergeStatus: "merged-success",
        },
      },
    });
    expect(getEligibleContextIds(merged.workingDefinition, merged)).toEqual([
      "context-implement",
    ]);
  });

  it("isContextLanded treats session isolation as landed when completed", () => {
    const baseExecution = createWorkflowExecution();
    const state = {
      ...baseExecution.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "session" as const,
      mergeStatus: "not-applicable" as const,
    };
    expect(isContextLanded(state)).toBe(true);
  });

  it("isContextLanded requires merged-success for worktree isolation", () => {
    const baseExecution = createWorkflowExecution();
    const state = {
      ...baseExecution.contextStates["context-plan"]!,
      status: "completed" as const,
      isolation: "worktree" as const,
      mergeStatus: "pending" as const,
    };
    expect(isContextLanded(state)).toBe(false);
    expect(
      isContextLanded({ ...state, mergeStatus: "merged-success" as const }),
    ).toBe(true);
  });

  it("blocks a lane-pinned downstream when upstream output is on an unrelated worktree lane", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      ...baseExecution,
      executionLanes: {
        "lane-up": {
          laneId: "lane-up",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/up",
          branchName: "csm/test-up",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
        "lane-down": {
          laneId: "lane-down",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/down",
          branchName: "csm/test-down",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([]);
  });

  it("unlocks a lane-pinned downstream once a join merges the upstream lane into the downstream lane", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      ...baseExecution,
      executionLanes: {
        "lane-up": {
          laneId: "lane-up",
          kind: "worktree",
          status: "merged",
          worktreePath: "/tmp/up",
          branchName: "csm/test-up",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
        "lane-down": {
          laneId: "lane-down",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/down",
          branchName: "csm/test-down",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      joins: {
        "join-up-down": {
          joinId: "join-up-down",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-down",
          sourceLaneIds: ["lane-up"],
          mergedSourceLaneIds: ["lane-up"],
          validationDebtSourceLaneIds: [],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });
});

describe("validateAuthoredDefinition (composite accept-time validator)", () => {
  it("accepts a clean parameterized definition", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      parameters: [requiredStringParam("feature-name")],
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Build {{inputs.feature-name}} now" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a clean zero-parameter (static) definition", () => {
    const result = validateAuthoredDefinition(createWorkflowDefinition());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a clean definition with valid prerequisites (R4.4, R4.6)", () => {
    const definition = createWorkflowDefinition({
      prerequisites: [
        { kind: "path", path: ".kiro/specs", label: "Kiro specs" },
        { kind: "skill", skill: "kiro-spec-design" },
        { kind: "skill", skill: "kiro-impl", backend: "claude" },
      ],
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an invalid prerequisite through the shared accept-time path (R4.4)", () => {
    const definition = createWorkflowDefinition({
      prerequisites: [{ kind: "path", path: "/etc/passwd" }],
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "prerequisite-path-not-worktree-relative",
    );
  });

  it("composes prerequisite checks ALONGSIDE parameter checks, collecting both (R4.4)", () => {
    const definition = createWorkflowDefinition({
      parameters: [
        requiredStringParam("shared"),
        { type: "text", name: "shared", label: "shared", required: true },
      ],
      prerequisites: [{ kind: "skill", skill: "/" }],
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const codes = result.errors.map((error) => error.code);
    expect(codes).toContain("duplicate-parameter-name");
    expect(codes).toContain("prerequisite-empty-skill-reference");
  });

  it("rejects a duplicate parameter name (shape check, R1.5)", () => {
    const definition = createWorkflowDefinition({
      parameters: [
        requiredStringParam("shared"),
        { type: "text", name: "shared", label: "shared", required: true },
      ],
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "duplicate-parameter-name",
    );
  });

  it("rejects a grammar-violating token (lint, R2.8)", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Use {{execution.id}} now" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "invalid-placeholder-token",
    );
  });

  it("rejects internal whitespace inside a placeholder token (lint, R2.8)", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      parameters: [requiredStringParam("feature-name")],
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Use {{ inputs.feature-name }} now" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "invalid-placeholder-token",
    );
  });

  it("rejects an undeclared parameter reference (lint, R2.3)", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Build {{inputs.unknown-name}} now" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const error = result.errors.find(
      (e) => e.code === "undeclared-parameter-reference",
    );
    expect(error?.parameterName).toBe("unknown-name");
  });

  it("rejects a reference to a declared-but-valueless parameter (lint, R2.7)", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      parameters: [
        {
          type: "string",
          name: "feature-name",
          label: "Feature",
          required: false,
        },
      ],
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Build {{inputs.feature-name}} now" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const error = result.errors.find(
      (e) => e.code === "referenced-parameter-without-value",
    );
    expect(error?.parameterName).toBe("feature-name");
  });

  it("collects shape, lint, and structural errors together (no short-circuit)", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      parameters: [
        requiredStringParam("shared"),
        { type: "text", name: "shared", label: "shared", required: true },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-missing",
          order: 1,
          title: "Bad",
          instructions: "Use {{inputs.unknown}} now",
          source: "user",
        },
        ...base.tasks.slice(1),
      ],
    });

    const result = validateAuthoredDefinition(definition);
    const codes = result.errors.map((error) => error.code);
    // Shape (parameters), lint (reference), and structural (graph) errors all surface.
    expect(codes).toContain("duplicate-parameter-name");
    expect(codes).toContain("undeclared-parameter-reference");
    expect(codes).toContain("unknown-task-context");
  });

  it("orders errors shape → lint → structural", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      parameters: [
        requiredStringParam("shared"),
        { type: "text", name: "shared", label: "shared", required: true },
      ],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-missing",
          order: 1,
          title: "Bad",
          instructions: "Use {{inputs.unknown}} now",
          source: "user",
        },
        ...base.tasks.slice(1),
      ],
    });

    const codes = validateAuthoredDefinition(definition).errors.map(
      (error) => error.code,
    );
    const shapeIndex = codes.indexOf("duplicate-parameter-name");
    const lintIndex = codes.indexOf("undeclared-parameter-reference");
    const structuralIndex = codes.indexOf("unknown-task-context");
    expect(shapeIndex).toBeLessThan(lintIndex);
    expect(lintIndex).toBeLessThan(structuralIndex);
  });
});

describe("structural validator stays lint-free (R5.1, R5.5)", () => {
  // Pins the binding invariant task 4.2 relies on: validateWorkflowDefinition is
  // PURELY structural. A literal `{{...}}` in a content field — which is exactly
  // what a substituted launcher value may contain — must NOT raise a grammar lint
  // error from the structural validator; only the authoring-time composite does.
  it("does not raise a placeholder lint error from validateWorkflowDefinition", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Run ${{ matrix.os }} and {{inputs.x}}" }
          : task,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(true);
    const lintCodes = [
      "invalid-placeholder-token",
      "undeclared-parameter-reference",
      "referenced-parameter-without-value",
    ];
    for (const error of result.errors) {
      expect(lintCodes).not.toContain(error.code);
    }
  });

  it("the same literal-{{ definition is rejected by validateAuthoredDefinition", () => {
    // Proves the lint lives in the composite, not the structural validator, so
    // the two paths genuinely diverge on launcher-shaped content.
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      tasks: base.tasks.map((task, index) =>
        index === 0
          ? { ...task, instructions: "Run ${{ matrix.os }} and {{inputs.x}}" }
          : task,
      ),
    });

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "invalid-placeholder-token",
    );
  });
});

describe("validator write-restriction refusal at the authoring gate (R7.2)", () => {
  it("refuses an authored validator assignment on a backend without an enforceable envelope", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  {
                    id: "unsandboxed-reviewer",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    strategy: "task",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  },
                ],
              },
            }
          : ctx,
      ),
    });

    // The authoring gate (`cctl workflow validate`, create/replace, the
    // builder) sees the assignment before any execution exists; refusing only
    // at seed time would let an unsandboxable validator sit in a saved plan.
    const result = validateAuthoredDefinition(definition, {
      fsWriteRestrictionFor: (backend) =>
        backend === "codex" ? "unsupported" : "enforced",
    });

    expect(result.ok).toBe(false);
    const errors = result.errors.filter(
      (e) => e.code === "validator-write-restriction-unsupported",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe(
      "executionContexts.0.contextValidator.assignments.0.agent.backend",
    );
    expect(errors[0]?.message).toContain("codex");
  });

  it("refuses a workflow-tier cohort on a backend without an enforceable envelope", () => {
    // The workflow tier is a real use site, not a comment: a context that names
    // no cohort of its own inherits this one verbatim (assignments replace as
    // whole units), so an unsandboxable assignment here reaches every such
    // context's lanes. Checking only `executionContexts` would admit the
    // definition and defer the refusal to launch-time resolution.
    const definition = createWorkflowDefinition({
      workflowConfig: {
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "unsandboxed-reviewer",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    });

    const result = validateAuthoredDefinition(definition, {
      fsWriteRestrictionFor: (backend) =>
        backend === "codex" ? "unsupported" : "enforced",
    });

    expect(result.ok).toBe(false);
    const errors = result.errors.filter(
      (e) => e.code === "validator-write-restriction-unsupported",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe(
      "workflowConfig.contextValidator.assignments.0.agent.backend",
    );
    expect(errors[0]?.contextId).toBeUndefined();
    expect(errors[0]?.message).toContain("codex");
    expect(errors[0]?.message).toContain('"unsandboxed-reviewer"');
  });

  it("admits a workflow-tier cohort whose backends all enforce", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general-reviewer",
              profile: { tier: "builtin", id: "general-reviewer" },
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    });

    const result = validateAuthoredDefinition(definition, {
      fsWriteRestrictionFor: () => "enforced",
    });

    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toEqual([]);
  });

  it("admits an authored definition that names no cohort at all", () => {
    // Cohorts are cascade-supplied when the document omits them; the authoring
    // gate has nothing to check and must not invent a refusal.
    const result = validateAuthoredDefinition(createWorkflowDefinition(), {
      fsWriteRestrictionFor: () => "unsupported",
    });

    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toEqual([]);
  });
});

describe("validateResolvedWorkflow", () => {
  it("passes when every resolved context's implementer effort is supported", () => {
    const resolved = createResolvedWorkflowDefinition();
    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags implementer-effort-unsupported for a claude model that does not support the effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              implementer: {
                id: "implementer",
                profile: { tier: "builtin", id: "general-implementer" },
                profileSnapshot: makeProfileSnapshot(),
                agent: {
                  backend: "claude",
                  model: "haiku",
                  reasoningEffort: "xhigh",
                },
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "implementer-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("flags implementer-effort-unsupported for a codex model that does not support the effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              implementer: {
                id: "implementer",
                profile: { tier: "builtin", id: "general-implementer" },
                profileSnapshot: makeProfileSnapshot(),
                agent: {
                  backend: "codex",
                  model: "gpt-5.4",
                  reasoningEffort: "minimal",
                },
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "implementer-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("flags validator-effort-unsupported for a codex-type validator whose effort the model rejects", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  {
                    id: "general",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    profileSnapshot: makeProfileSnapshot(),
                    strategy: "task",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "minimal",
                    },
                    continuity: { enabled: true },
                  },
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "validator-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("flags validator-effort-unsupported for a claude-type validator backed by a codex agent with a rejected effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  {
                    id: "general",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    profileSnapshot: makeProfileSnapshot(),
                    strategy: "conversation",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "minimal",
                    },
                    continuity: { enabled: true },
                  },
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "validator-effort-unsupported" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("addresses the offending cohort entry by index and skips a disabled cohort", () => {
    const base = createResolvedWorkflowDefinition();
    const reviewer = (id: string, reasoningEffort: "medium" | "minimal") => ({
      id,
      profile: { tier: "builtin" as const, id: "general-reviewer" },
      strategy: "task" as const,
      authority: "blocking" as const,
      agent: {
        backend: "codex" as const,
        model: "gpt-5.4" as const,
        reasoningEffort,
      },
      continuity: { enabled: true },
    });
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                // Entry 0 is fine; entry 1 is the one that cannot run.
                assignments: [
                  seedAssignment(reviewer("ok", "medium")),
                  seedAssignment(reviewer("bad", "minimal")),
                ],
              },
            }
          : index === 1
            ? {
                ...ctx,
                // Disabled: dormant config, so it contributes no error.
                contextValidator: {
                  enabled: false,
                  assignments: [seedAssignment(reviewer("dormant", "minimal"))],
                },
              }
            : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);

    const errors = result.errors.filter(
      (e) => e.code === "validator-effort-unsupported",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe(
      "executionContexts.0.contextValidator.assignments.1.agent.reasoningEffort",
    );
    expect(errors[0]?.message).toContain('"bad"');
  });

  it("refuses a validator assignment on a backend without an enforceable write envelope (R7.2)", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  seedAssignment({
                    id: "ok-reviewer",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    strategy: "task",
                    authority: "blocking",
                    agent: {
                      backend: "claude",
                      model: "sonnet",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  }),
                  seedAssignment({
                    id: "unsandboxed-reviewer",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    strategy: "conversation",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  }),
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved, {
      fsWriteRestrictionFor: (backend) =>
        backend === "codex" ? "unsupported" : "enforced",
    });

    expect(result.ok).toBe(false);
    const errors = result.errors.filter(
      (e) => e.code === "validator-write-restriction-unsupported",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.contextId).toBe(resolved.executionContexts[0]?.id);
    // The use site, not just the context: a cohort can hold several
    // assignments and only one of them may be unsandboxable.
    expect(errors[0]?.field).toBe(
      "executionContexts.0.contextValidator.assignments.1.agent.backend",
    );
    expect(errors[0]?.message).toContain("codex");
    expect(errors[0]?.message).toContain('"unsandboxed-reviewer"');
  });

  it("does not refuse an implementer assignment on a backend without an enforceable envelope", () => {
    // Implementers are write-capable by design; the envelope constrains
    // validators only, so an unsupported backend must not block one.
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx) => ({
        ...ctx,
        contextValidator: { enabled: false, assignments: [] },
      })),
    });

    const result = validateResolvedWorkflow(resolved, {
      fsWriteRestrictionFor: () => "unsupported",
    });

    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toEqual([]);
    expect(base.executionContexts[0]?.implementer).toBeDefined();
  });

  it("accepts every validator assignment when the default lookup is used", () => {
    // The registered backends both declare an enforceable envelope, so the
    // production default refuses nothing — the refusal above is the rule, not
    // a standing rejection of a shipped backend.
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  seedAssignment({
                    id: "codex-reviewer",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    strategy: "task",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  }),
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);

    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toEqual([]);
  });

  it("skips a disabled cohort's dormant assignments", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: false,
                assignments: [
                  seedAssignment({
                    id: "dormant-reviewer",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    strategy: "task",
                    authority: "blocking",
                    agent: {
                      backend: "codex",
                      model: "gpt-5.4",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  }),
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved, {
      fsWriteRestrictionFor: () => "unsupported",
    });

    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toEqual([]);
  });

  it("refuses duplicate edge ids", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      edges: base.edges.map((edge) => ({ ...edge, id: "same" })),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(
      result.errors.filter((error) => error.code === "duplicate-edge-id"),
    ).toEqual([
      {
        code: "duplicate-edge-id",
        message: expect.stringContaining("same"),
        edgeId: "same",
        field: "edges[1].id",
      },
    ]);
  });

  it("passes a validator whose model supports the configured effort", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((ctx, index) =>
        index === 0
          ? {
              ...ctx,
              contextValidator: {
                enabled: true,
                assignments: [
                  {
                    id: "general",
                    profile: { tier: "builtin", id: "general-reviewer" },
                    profileSnapshot: makeProfileSnapshot(),
                    strategy: "conversation",
                    authority: "blocking",
                    agent: {
                      backend: "claude",
                      model: "sonnet",
                      reasoningEffort: "medium",
                    },
                    continuity: { enabled: true },
                  },
                ],
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(true);
  });
});

describe("workflow-graph validation — edge activation guards", () => {
  it("accepts a guarded edge whose source declares a compatible outputSchema", () => {
    const definition = withPlanOutputSchema();
    const guarded = createWorkflowDefinition({
      ...definition,
      edges: definition.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { const: "ship" } },
                  required: ["verdict"],
                },
              },
            }
          : edge,
      ),
    });

    expect(validateWorkflowDefinition(guarded)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("refuses a guarded edge whose source declares no outputSchema", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      edges: base.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? { ...edge, when: { schema: { type: "object" } } }
          : edge,
      ),
    });

    const result = validateWorkflowDefinition(definition);
    expect(result.ok).toBe(false);
    expect(
      result.errors.map((error) => ({
        code: error.code,
        edgeId: error.edgeId,
        field: error.field,
      })),
    ).toEqual([
      {
        code: "guard-source-without-output-schema",
        edgeId: "edge-plan-implement",
        field: "edges[0].when",
      },
    ]);
  });

  it("refuses a guard document outside the supported schema subset", () => {
    const definition = withPlanOutputSchema();
    const guarded = createWorkflowDefinition({
      ...definition,
      edges: definition.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { type: "string", format: "email" } },
                },
              },
            }
          : edge,
      ),
    });

    const result = validateWorkflowDefinition(guarded);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("unsupported-guard-schema");
    expect(result.errors[0]?.field).toBe(
      "edges[0].when.schema.properties.verdict.format",
    );
  });

  it("refuses a second else edge on one source", () => {
    const definition = withPlanOutputSchema();
    const guarded = createWorkflowDefinition({
      ...definition,
      edges: [
        {
          id: "else-a",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
          when: { else: true },
        },
        {
          id: "else-b",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
          when: { else: true },
        },
      ],
    });

    const result = validateWorkflowDefinition(guarded);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual([
      "duplicate-else-edge",
    ]);
    expect(result.errors[0]?.edgeId).toBe("else-b");
  });

  it("refuses the same guard defects on the resolved (live) tier", () => {
    const base = createResolvedWorkflowDefinition();
    const resolved = createResolvedWorkflowDefinition({
      edges: base.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? { ...edge, when: { schema: { type: "object" } } }
          : edge,
      ),
    });

    const result = validateWorkflowDefinition(resolved);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual([
      "guard-source-without-output-schema",
    ]);
  });

  it("carries guard refusals through the composite authoring gate", () => {
    const base = createWorkflowDefinition();
    const definition = createWorkflowDefinition({
      edges: base.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? { ...edge, when: { else: true } }
          : edge,
      ),
    });

    expect(
      validateAuthoredDefinition(definition).errors.map((error) => error.code),
    ).toEqual(["guard-source-without-output-schema"]);
  });
});
