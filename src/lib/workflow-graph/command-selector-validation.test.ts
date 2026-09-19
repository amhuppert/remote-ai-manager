import { describe, expect, it } from "vitest";
import {
  collectValidationCommandIssues,
  collectValidationCommandIssuesForResolvedContext,
  collectLaneMergeValidationCommandIssues,
  collectUnknownValidationCommandIssues,
  collectUnknownCommandIssuesForResolvedContext,
} from "./command-selector-validation";
import type { ValidationCommandPreflight } from "@/lib/validation/preflight";
import {
  createWorkflowDefinition,
  makeImplementerAssignment,
  makeSeededValidatorCohort,
  seedAssignment,
} from "./test-fixtures";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";

const REGISTRY = ["typecheck", "test", "lint"] as const;
const PREFLIGHT: ValidationCommandPreflight = {
  commandCosts: { typecheck: 2, test: 5, lint: 1 },
  concurrencyLimit: 4,
};

function resolvedContext(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    placement: { lane: "context-api", mode: "full" as const },
    id: "context-api",
    title: "API",
    acceptanceCriteria: "done",
    implementer: seedAssignment(
      makeImplementerAssignment({
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      }),
    ),
    contextValidator: makeSeededValidatorCohort({
      enabled: false,
      assignments: [],
    }),
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: {
      allowAgentTaskAdd: false,
      allowAgentContextAdd: false,
    },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 5 },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

describe("collectUnknownValidationCommandIssues", () => {
  it("accepts a definition whose selectors only use registered names", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "test"] },
        agentValidation: {
          implementer: { mode: "all", except: ["lint"] },
          contextValidator: { mode: "only", commands: ["test"] },
        },
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    });
    expect(collectUnknownValidationCommandIssues(definition, REGISTRY)).toEqual(
      [],
    );
  });

  it("locates unknown names in every workflow-tier selector, path-qualified", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "nope"] },
        agentValidation: {
          implementer: { mode: "all", except: ["missing-a"] },
          contextValidator: { mode: "only", commands: ["missing-b"] },
        },
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["missing-c"] },
        },
      },
    });

    const issues = collectUnknownValidationCommandIssues(definition, REGISTRY);
    expect(issues.map((issue) => issue.field)).toEqual([
      "workflowConfig.scriptValidator.commands.1",
      "workflowConfig.agentValidation.implementer.except.0",
      "workflowConfig.agentValidation.contextValidator.commands.0",
      "workflowConfig.laneMergeValidation.commands.commands.0",
    ]);
    for (const issue of issues) {
      expect(issue.code).toBe("unknown-validation-command");
      expect(issue.message).toContain(
        "registered commands: typecheck, test, lint",
      );
    }
  });

  it("locates unknown names in context-tier selectors with the context id", () => {
    const definition = createWorkflowDefinition();
    definition.executionContexts[1]!.scriptValidator = {
      commands: ["ghost"],
    };
    definition.executionContexts[1]!.agentValidation = {
      implementer: { mode: "only", commands: ["phantom"] },
    };

    const issues = collectUnknownValidationCommandIssues(definition, REGISTRY);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown-validation-command",
        contextId: "context-implement",
        field: "executionContexts.1.scriptValidator.commands.0",
      }),
      expect.objectContaining({
        code: "unknown-validation-command",
        contextId: "context-implement",
        field: "executionContexts.1.agentValidation.implementer.commands.0",
      }),
    ]);
  });

  it("treats a project-mode lane-merge selector as name-free", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "project" },
        },
      },
    });

    expect(collectUnknownValidationCommandIssues(definition, [])).toEqual([]);
  });

  it("reports every name as unknown when the project registers none", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["test"] },
      },
    });

    const issues = collectUnknownValidationCommandIssues(definition, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("registered commands: (none)");
  });
});

describe("collectUnknownCommandIssuesForResolvedContext", () => {
  it("accepts a resolved context whose selections are registered", () => {
    const context = resolvedContext({
      scriptValidator: { commands: ["typecheck"] },
      agentValidation: {
        implementer: {
          value: { mode: "all", except: ["lint"] },
          source: "workflow",
        },
        contextValidator: {
          value: { mode: "only", commands: ["test"] },
          source: "global",
        },
      },
    });

    expect(
      collectUnknownCommandIssuesForResolvedContext(context, REGISTRY),
    ).toEqual([]);
  });

  it("locates unknown names path-qualified by the context id", () => {
    const context = resolvedContext({
      scriptValidator: { commands: ["ghost"] },
      agentValidation: {
        implementer: {
          value: { mode: "all", except: ["phantom"] },
          source: "per-node",
        },
        contextValidator: {
          value: { mode: "only", commands: [] },
          source: "global",
        },
      },
    });

    const issues = collectUnknownCommandIssuesForResolvedContext(
      context,
      REGISTRY,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown-validation-command",
        contextId: "context-api",
        field: "executionContexts.context-api.scriptValidator.commands.0",
      }),
      expect.objectContaining({
        code: "unknown-validation-command",
        contextId: "context-api",
        field:
          "executionContexts.context-api.agentValidation.implementer.value.except.0",
      }),
    ]);
  });
});

describe("configured validation cost preflight", () => {
  it("locates explicit oversized selections and names the command, cost, limit, and remedy", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["test"] },
        agentValidation: {
          contextValidator: { mode: "only", commands: ["test"] },
        },
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["test"] },
        },
      },
    });
    for (const context of definition.executionContexts) {
      delete context.agentValidation;
    }

    const issues = collectValidationCommandIssues(definition, PREFLIGHT);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        field: "workflowConfig.scriptValidator.commands.0",
      }),
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        field: "workflowConfig.agentValidation.contextValidator.commands.0",
      }),
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        field: "workflowConfig.laneMergeValidation.commands.commands.0",
      }),
    ]);
    for (const issue of issues) {
      expect(issue.message).toContain('"test"');
      expect(issue.message).toContain("cost 5");
      expect(issue.message).toContain("limit 4");
      expect(issue.message).toContain("lower-worker");
    }
  });

  it('expands mode "all" but does not cost-check an excluded oversized command', () => {
    const selected = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["lint"] },
        },
      },
    });
    const excluded = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["test"] },
        },
      },
    });
    for (const context of selected.executionContexts) {
      delete context.agentValidation;
    }
    for (const context of excluded.executionContexts) {
      delete context.agentValidation;
    }

    expect(collectValidationCommandIssues(selected, PREFLIGHT)).toEqual([
      expect.objectContaining({
        code: "validation_cost_exceeds_limit",
        field: "workflowConfig.agentValidation.implementer.mode",
      }),
    ]);
    expect(collectValidationCommandIssues(excluded, PREFLIGHT)).toEqual([]);
  });

  it("accepts a configured cost equal to the limit and skips project-mode lane merge", () => {
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["test"] },
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "project" },
        },
      },
    });

    expect(
      collectValidationCommandIssues(definition, {
        commandCosts: { test: 4 },
        concurrencyLimit: 4,
      }),
    ).toEqual([]);
    expect(
      collectLaneMergeValidationCommandIssues({ mode: "project" }, PREFLIGHT),
    ).toEqual([]);
  });

  it("uses the frozen resolved command snapshot when one exists", () => {
    const context = resolvedContext({
      scriptValidator: { commands: [] },
      agentValidation: {
        implementer: {
          value: { mode: "all", except: [] },
          source: "global",
          commands: ["typecheck"],
        },
        contextValidator: {
          value: { mode: "only", commands: [] },
          source: "global",
          commands: [],
        },
      },
    });

    expect(
      collectValidationCommandIssuesForResolvedContext(context, PREFLIGHT),
    ).toEqual([]);
  });
});
