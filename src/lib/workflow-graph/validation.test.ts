import { describe, expect, it } from "vitest";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  seedAssignment,
} from "./test-fixtures";
import { getFsWriteRestrictionForBackend } from "@/lib/agent-backends/catalog";
import { isUpstreamVisibleToDownstream } from "./lane-readiness";
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

  it("keeps a lane-placed downstream eligible when its upstream landed on a lane the join has not merged yet", () => {
    // Eligibility answers "has every upstream landed"; WHERE it landed relative
    // to this context's lane is the classifier's call (it answers wait-for-join,
    // which is what plans the merge). Filtering the context out here instead
    // would leave nobody to plan the join and strand it (R3.2).
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const timestamp = "2026-03-27T12:00:00.000Z";
    const makeLane = (laneId: string, includedContextIds: string[]) => ({
      laneId,
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: `/tmp/${laneId}`,
      branchName: `csm/${laneId}`,
      includedContextIds,
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const execution = createWorkflowExecution({
      executionLanes: {
        "lane-up": makeLane("lane-up", ["context-plan"]),
        "lane-down": makeLane("lane-down", []),
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
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

  it("makes a lane-pinned downstream's upstream visible once a join merges the upstream lane into it", () => {
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
    // Eligibility alone no longer proves the routing is satisfied — visibility
    // is the classifier's call — so assert the predicate that decides it.
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
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

  it("refuses a charter source scoped to an unknown context id (unknown-source-scope-context)", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          ...base.charter.sourcesOfTruth,
          {
            rank: 90,
            id: "scoped-source",
            label: "Scoped Source",
            type: "document" as const,
            locator: "docs/scoped.md",
            description: "A source scoped to one declared and one unknown id.",
            appliesTo: {
              contextIds: ["context-implement", "context-missing"],
            },
          },
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const error = result.errors.find(
      (entry) => entry.code === "unknown-source-scope-context",
    );
    expect(error).toBeDefined();
    expect(error?.contextId).toBe("context-missing");
    // The path locates the offending source entry and the offending id.
    const sourceIndex = definition.charter.sourcesOfTruth.length - 1;
    expect(error?.field).toBe(
      `charter.sourcesOfTruth.${sourceIndex}.appliesTo.contextIds.1`,
    );
  });

  it("accepts a charter source scoped to declared context ids", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          ...base.charter.sourcesOfTruth,
          {
            rank: 91,
            id: "well-scoped-source",
            label: "Well-Scoped Source",
            type: "document" as const,
            locator: "docs/scoped.md",
            description: "A source scoped to declared contexts only.",
            appliesTo: { contextIds: ["context-plan", "context-implement"] },
          },
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("skips legacy prose appliesTo when checking source scopes", () => {
    // A persisted-era source with prose appliesTo has no context ids to
    // check; the scope refusal must not misread the prose as an unknown id.
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          {
            rank: 92,
            id: "legacy-source",
            label: "Legacy Source",
            type: "document" as const,
            locator: "docs/legacy.md",
            description: "A pre-structured source with prose applicability.",
            appliesTo: "everything under src/",
          },
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(
      result.errors.filter(
        (entry) => entry.code === "unknown-source-scope-context",
      ),
    ).toEqual([]);
  });

  it("refuses a charter source carrying the retired accessPolicy field (retired-source-access-policy)", () => {
    // The authored gate: stored definitions tolerate the legacy field, but a
    // plan submitted for validate/create/replace must not author it — external
    // material is materialized into the worktree at plan time.
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          {
            rank: 93,
            id: "gated-source",
            label: "Gated Source",
            type: "document" as const,
            locator: "docs/gated.md",
            description: "A source still authored with the retired field.",
            accessPolicy: "external-readonly" as const,
          },
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const error = result.errors.find(
      (entry) => entry.code === "retired-source-access-policy",
    );
    expect(error).toBeDefined();
    expect(error?.field).toBe("charter.sourcesOfTruth.0.accessPolicy");
    expect(error?.message).toContain("accessPolicy");
  });

  it("refuses accessPolicy on native-SDD sources as on every authored source", () => {
    // Delivery-plan finalization injects the pinned-spec and claims sources —
    // still stamped with the legacy accessPolicy — into every spec-candidate
    // launch before admission. They are server-seeded, not authored (the spec
    // document schema refuses these reserved ids in user-submitted plans), so
    // the authored gate must not reject the engine's own finalization output.
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          {
            rank: 1,
            id: "native-sdd-pinned-spec",
            label: "Pinned native SDD specification",
            type: "spec" as const,
            locator: ".cc/graph-workflow-docs/spec/pinned.md",
            description: "The immutable specification revision.",
            accessPolicy: "worktree-relative" as const,
          },
          {
            rank: 2,
            id: "native-sdd-claims",
            label: "Native SDD candidate claims",
            type: "document" as const,
            locator: ".cc/graph-workflow-docs/spec-bindings/c1/claims.md",
            description: "The candidate-specific dispositions and claims.",
            accessPolicy: "worktree-relative" as const,
          },
          ...base.charter.sourcesOfTruth.map((source) => ({
            ...source,
            rank: source.rank + 2,
          })),
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(
      result.errors.filter(
        (entry) => entry.code === "retired-source-access-policy",
      ),
    ).toHaveLength(2);
  });

  it("refuses a charter source authored with legacy prose appliesTo (legacy-source-applies-to)", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      charter: {
        ...base.charter,
        sourcesOfTruth: [
          {
            rank: 94,
            id: "prose-source",
            label: "Prose Source",
            type: "document" as const,
            locator: "docs/prose.md",
            description: "A source still authored with prose applicability.",
            appliesTo: "everything under src/",
          },
        ],
      },
    };

    const result = validateAuthoredDefinition(definition);
    expect(result.ok).toBe(false);
    const error = result.errors.find(
      (entry) => entry.code === "legacy-source-applies-to",
    );
    expect(error).toBeDefined();
    expect(error?.field).toBe("charter.sourcesOfTruth.0.appliesTo");
    expect(error?.message).toContain("structured scope");
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "medium", fast: "false" },
                      },
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

  // The gate reads one value — the backend's TASK-facet write restriction — and
  // refuses anything but "enforced". Cursor declares "unsupported", so the gate
  // refuses it with no cursor-specific change to this code (spec R15.3).
  //
  // Cursor's declared value is fed in through the gate's own dependency seam
  // rather than by authoring a Cursor validator assignment: the workflow agent
  // config schema refuses `backend: "cursor"` outright, so such an assignment
  // is unrepresentable and never reaches this gate in the first place.
  it("refuses a cohort whose backend declares Cursor's write-restriction value, unmodified", () => {
    expect(getFsWriteRestrictionForBackend("cursor")).not.toBe("enforced");

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
                modelSelection: {
                  modelId: "gpt-5.4",
                  parameters: { reasoning: "medium", fast: "false" },
                },
              },
              continuity: { enabled: true },
            },
          ],
        },
      },
    });

    const result = validateAuthoredDefinition(definition, {
      fsWriteRestrictionFor: () => getFsWriteRestrictionForBackend("cursor"),
    });

    expect(result.ok).toBe(false);
    expect(
      result.errors.filter(
        (e) => e.code === "validator-write-restriction-unsupported",
      ),
    ).toHaveLength(1);
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
                modelSelection: {
                  modelId: "gpt-5.4",
                  parameters: { reasoning: "medium", fast: "false" },
                },
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
                modelSelection: {
                  modelId: "sonnet",
                  parameters: { effort: "medium" },
                },
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
  it("validates repair and collaboration selections in contexts and resolved loop templates", () => {
    const base = createResolvedWorkflowDefinition();
    const invalidAgent = {
      backend: "claude" as const,
      modelSelection: {
        modelId: "haiku",
        parameters: { effort: "xhigh" },
      },
    };
    const context = base.executionContexts[0]!;
    const configuredContext = {
      ...context,
      planRepair: {
        enabled: true,
        maxAttemptsPerContext: 2,
        agent: invalidAgent,
      },
      collaboration: {
        enabled: { value: true, source: "per-node" as const },
        secondAgent: { value: invalidAgent, source: "per-node" as const },
        negotiationRounds: { value: 2, source: "global" as const },
        autonomousResolutionThreshold: {
          value: "minor" as const,
          source: "global" as const,
        },
      },
    };
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: [
        configuredContext,
        ...base.executionContexts.slice(1),
      ],
      loopGroups: [
        {
          id: "repair-loop",
          entryContextId: context.id,
          exitContextId: context.id,
          until: { schema: { type: "object" } },
          maxPasses: 2,
          template: {
            contexts: [
              {
                ...context,
                implementer: {
                  ...context.implementer,
                  agent: invalidAgent,
                },
              },
            ],
            tasks: [],
            edges: [],
          },
          templateVersion: 1,
          planRepair: {
            enabled: true,
            maxAttemptsPerContext: 2,
            agent: invalidAgent,
          },
        },
      ],
    });

    expect(
      validateResolvedWorkflow(resolved).errors.map(({ code, field }) => ({
        code,
        field,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          code: "plan-repair-model-selection-invalid",
          field: "executionContexts.0.planRepair.agent.modelSelection",
        },
        {
          code: "collaboration-model-selection-invalid",
          field:
            "executionContexts.0.collaboration.secondAgent.value.modelSelection",
        },
        {
          code: "plan-repair-model-selection-invalid",
          field: "loopGroups.0.planRepair.agent.modelSelection",
        },
        {
          code: "implementer-model-selection-invalid",
          field:
            "loopGroups.0.template.contexts.0.implementer.agent.modelSelection",
        },
      ]),
    );
  });

  it("passes when every resolved context's complete model selections are valid", () => {
    const resolved = createResolvedWorkflowDefinition();
    const result = validateResolvedWorkflow(resolved);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("admits only the globally configured custom Codex model", () => {
    const base = createResolvedWorkflowDefinition();
    const customSelection = {
      modelId: "company-codex-model",
      parameters: { reasoning: "high", fast: "false" },
    };
    const resolved = createResolvedWorkflowDefinition({
      executionContexts: base.executionContexts.map((context, index) =>
        index === 0
          ? {
              ...context,
              implementer: {
                ...context.implementer,
                agent: {
                  backend: "codex" as const,
                  modelSelection: customSelection,
                },
              },
            }
          : context,
      ),
    });

    expect(
      validateResolvedWorkflow(resolved).errors.some(
        ({ code }) => code === "implementer-model-selection-invalid",
      ),
    ).toBe(true);
    expect(
      validateResolvedWorkflow(resolved, {
        configuredModelSelectionFor: (backend) =>
          backend === "codex" ? customSelection : undefined,
      }).errors,
    ).toEqual([]);
    expect(
      validateResolvedWorkflow(resolved, {
        configuredModelSelectionFor: (backend) =>
          backend === "codex"
            ? {
                modelId: "different-custom-model",
                parameters: { reasoning: "high", fast: "false" },
              }
            : undefined,
      }).errors.some(
        ({ code }) => code === "implementer-model-selection-invalid",
      ),
    ).toBe(true);
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
                  modelSelection: {
                    modelId: "haiku",
                    parameters: { effort: "xhigh" },
                  },
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
          e.code === "implementer-model-selection-invalid" &&
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
                  modelSelection: {
                    modelId: "gpt-5.4",
                    parameters: { reasoning: "minimal", fast: "false" },
                  },
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
          e.code === "implementer-model-selection-invalid" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("accepts an implementer on Spark at a level the model supports", () => {
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
                  modelSelection: {
                    modelId: "gpt-5.3-codex-spark",
                    parameters: { reasoning: "xhigh", fast: "false" },
                  },
                },
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(
      result.errors.filter(
        (e) => e.code === "implementer-model-selection-invalid",
      ),
    ).toEqual([]);
  });

  it("flags implementer-effort-unsupported for Spark at a level it does not offer", () => {
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
                  modelSelection: {
                    modelId: "gpt-5.3-codex-spark",
                    parameters: { reasoning: "ultra", fast: "false" },
                  },
                },
              },
            }
          : ctx,
      ),
    });

    const result = validateResolvedWorkflow(resolved);
    expect(
      result.errors.some(
        (e) =>
          e.code === "implementer-model-selection-invalid" &&
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "minimal", fast: "false" },
                      },
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
          e.code === "validator-model-selection-invalid" &&
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "minimal", fast: "false" },
                      },
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
          e.code === "validator-model-selection-invalid" &&
          e.contextId === resolved.executionContexts[0]?.id,
      ),
    ).toBe(true);
  });

  it("addresses every offending cohort entry by index, including dormant assignments", () => {
    const base = createResolvedWorkflowDefinition();
    const reviewer = (id: string, reasoning: "medium" | "minimal") => ({
      id,
      profile: { tier: "builtin" as const, id: "general-reviewer" },
      strategy: "task" as const,
      authority: "blocking" as const,
      agent: {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning, fast: "false" },
        },
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
                // Dormant selections are still persisted and must be valid
                // before a later edit can enable the cohort.
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
      (e) => e.code === "validator-model-selection-invalid",
    );
    expect(errors.map(({ field }) => field)).toEqual([
      "executionContexts.0.contextValidator.assignments.1.agent.modelSelection",
      "executionContexts.1.contextValidator.assignments.0.agent.modelSelection",
    ]);
    expect(errors[0]?.message).toContain('"bad"');
    expect(errors[1]?.message).toContain('"dormant"');
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
                      modelSelection: {
                        modelId: "sonnet",
                        parameters: { effort: "medium" },
                      },
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "medium", fast: "false" },
                      },
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "medium", fast: "false" },
                      },
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
                      modelSelection: {
                        modelId: "gpt-5.4",
                        parameters: { reasoning: "medium", fast: "false" },
                      },
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
                      modelSelection: {
                        modelId: "sonnet",
                        parameters: { effort: "medium" },
                      },
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
