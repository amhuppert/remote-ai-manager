import { describe, expect, it } from "vitest";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowIterationPolicy,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowScriptValidatorConfig,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import {
  resolveContext,
  resolveWorkflowConfig,
  resolveWorkflowDefinition,
} from "./resolve-config";

const GLOBAL_IMPLEMENTER: GraphWorkflowAgentConfig = {
  backend: "claude",
  model: "opus",
  reasoningEffort: "medium",
};

const GLOBAL_VALIDATOR: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
};

const GLOBAL_ITERATION: GraphWorkflowIterationPolicy = {
  maxIterations: 20,
  continuity: { enabled: true },
};

const GLOBAL_CB: GraphWorkflowCircuitBreakerPolicy = {
  consecutiveFailureThreshold: 3,
};

const GLOBAL_MUTABILITY: GraphWorkflowMutabilityPolicy = {
  allowAgentTaskAdd: false,
};

const GLOBAL_SCRIPT_VALIDATOR: GraphWorkflowScriptValidatorConfig = {
  enabled: false,
};

const GLOBAL_DEFAULTS: WorkflowDefaults = {
  implementer: GLOBAL_IMPLEMENTER,
  contextValidator: GLOBAL_VALIDATOR,
  scriptValidator: GLOBAL_SCRIPT_VALIDATOR,
  iterationPolicy: GLOBAL_ITERATION,
  circuitBreaker: GLOBAL_CB,
  mutability: GLOBAL_MUTABILITY,
};

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    workflowDefaults: GLOBAL_DEFAULTS,
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx-1",
    title: "Context 1",
    acceptanceCriteria: "must pass",
    ...overrides,
  };
}

function makeDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    executionContexts: [makeContext()],
    tasks: [],
    edges: [],
    ...overrides,
  };
}

describe("resolveContext", () => {
  it("inherits all blocks from workflow-level effective values when all context blocks are omitted", () => {
    const workflowConfig: WorkflowConfigOverride = {
      implementer: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      iterationPolicy: { maxIterations: 5, continuity: { enabled: false } },
    };
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      workflowConfig,
      makeContext(),
    );

    expect(resolved.implementer).toEqual(workflowConfig.implementer);
    expect(resolved.iterationPolicy).toEqual(workflowConfig.iterationPolicy);
    expect(resolved.contextValidator).toEqual(GLOBAL_VALIDATOR);
    expect(resolved.circuitBreaker).toEqual(GLOBAL_CB);
    expect(resolved.mutability).toEqual(GLOBAL_MUTABILITY);
  });

  it("uses context implementer verbatim when overridden", () => {
    const ctxImpl: GraphWorkflowAgentConfig = {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "low",
    };
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      { implementer: GLOBAL_IMPLEMENTER },
      makeContext({ implementer: ctxImpl }),
    );

    expect(resolved.implementer).toEqual(ctxImpl);
    expect(resolved.contextValidator).toEqual(GLOBAL_VALIDATOR);
  });

  it("resolves contextValidator to null when the context opts out with { kind: 'disabled' }", () => {
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      {},
      makeContext({ contextValidator: { kind: "disabled" } }),
    );

    expect(resolved.contextValidator).toBeNull();
  });

  it("resolves contextValidator using kind: 'use' value when overridden", () => {
    const custom: GraphWorkflowAgentValidatorConfig = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
    };
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      {},
      makeContext({ contextValidator: { kind: "use", value: custom } }),
    );

    expect(resolved.contextValidator).toEqual(custom);
  });

  it("inherits workflow-level validator when context omits contextValidator", () => {
    const workflowValidator: GraphWorkflowAgentValidatorConfig = {
      type: "claude",
      enabled: false,
      continuity: { enabled: true },
      agent: {
        backend: "claude",
        model: "haiku",
        reasoningEffort: "low",
      },
    };
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      { contextValidator: workflowValidator },
      makeContext(),
    );

    expect(resolved.contextValidator).toEqual(workflowValidator);
  });

  it("always reads acceptance criteria from the context, never from inheritance", () => {
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      {},
      makeContext({ acceptanceCriteria: "ctx-specific AC" }),
    );

    expect(resolved.acceptanceCriteria).toBe("ctx-specific AC");
  });

  it("inherits scriptValidator from global when neither workflow nor context override", () => {
    const resolved = resolveContext(
      { ...GLOBAL_DEFAULTS, scriptValidator: { enabled: true } },
      {},
      makeContext(),
    );

    expect(resolved.scriptValidator).toEqual({ enabled: true });
  });

  it("inherits scriptValidator from workflow when context omits it", () => {
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      { scriptValidator: { enabled: true } },
      makeContext(),
    );

    expect(resolved.scriptValidator).toEqual({ enabled: true });
  });

  it("uses context scriptValidator verbatim when overridden", () => {
    const resolved = resolveContext(
      { ...GLOBAL_DEFAULTS, scriptValidator: { enabled: true } },
      { scriptValidator: { enabled: true } },
      makeContext({ scriptValidator: { enabled: false } }),
    );

    expect(resolved.scriptValidator).toEqual({ enabled: false });
  });
});

describe("resolveWorkflowConfig", () => {
  it("uses global workflowDefaults.implementer when workflow-level implementer is missing", () => {
    const global = makeGlobalConfig();
    const resolved = resolveWorkflowConfig(global, makeDefinition());

    expect(resolved.implementer).toEqual(GLOBAL_IMPLEMENTER);
  });

  it("uses workflow-level implementer when present, ignoring global", () => {
    const workflowImpl: GraphWorkflowAgentConfig = {
      backend: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    };
    const definition = makeDefinition({
      workflowConfig: { implementer: workflowImpl },
    });
    const resolved = resolveWorkflowConfig(makeGlobalConfig(), definition);

    expect(resolved.implementer).toEqual(workflowImpl);
  });

  it("fills missing global blocks from seeded defaults", () => {
    const partialGlobal: WorkflowDefaults = {
      implementer: GLOBAL_IMPLEMENTER,
      contextValidator:
        undefined as unknown as GraphWorkflowAgentValidatorConfig,
      scriptValidator:
        undefined as unknown as GraphWorkflowScriptValidatorConfig,
      iterationPolicy: undefined as unknown as GraphWorkflowIterationPolicy,
      circuitBreaker: undefined as unknown as GraphWorkflowCircuitBreakerPolicy,
      mutability: undefined as unknown as GraphWorkflowMutabilityPolicy,
    };
    const global = makeGlobalConfig({ workflowDefaults: partialGlobal });

    const resolved = resolveWorkflowConfig(global, makeDefinition());

    expect(resolved.implementer).toEqual(GLOBAL_IMPLEMENTER);
    expect(resolved.contextValidator.type).toBe("claude");
    expect(resolved.scriptValidator.enabled).toBe(false);
    expect(resolved.iterationPolicy.maxIterations).toBeGreaterThan(0);
    expect(resolved.circuitBreaker.consecutiveFailureThreshold).toBe(3);
    expect(resolved.mutability.allowAgentTaskAdd).toBe(false);
  });
});

describe("resolveWorkflowDefinition", () => {
  it("resolves every context to global effective values when workflowConfig is empty", () => {
    const definition = makeDefinition({
      executionContexts: [
        makeContext({ id: "a", title: "A", acceptanceCriteria: "A-AC" }),
        makeContext({ id: "b", title: "B", acceptanceCriteria: "B-AC" }),
      ],
    });

    const resolved = resolveWorkflowDefinition(makeGlobalConfig(), definition);

    expect(resolved.executionContexts).toHaveLength(2);
    for (const ctx of resolved.executionContexts) {
      expect(ctx.implementer).toEqual(GLOBAL_IMPLEMENTER);
      expect(ctx.contextValidator).toEqual(GLOBAL_VALIDATOR);
      expect(ctx.scriptValidator).toEqual(GLOBAL_SCRIPT_VALIDATOR);
      expect(ctx.iterationPolicy).toEqual(GLOBAL_ITERATION);
      expect(ctx.circuitBreaker).toEqual(GLOBAL_CB);
      expect(ctx.mutability).toEqual(GLOBAL_MUTABILITY);
    }
    expect(resolved.executionContexts[0]?.acceptanceCriteria).toBe("A-AC");
    expect(resolved.executionContexts[1]?.acceptanceCriteria).toBe("B-AC");
  });

  it("treats a definition with absent workflowConfig as all-inherited from global", () => {
    const definition = {
      schemaVersion: 1,
      executionContexts: [makeContext()],
      tasks: [],
      edges: [],
    } as unknown as WorkflowSemanticDefinition;
    expect(
      (definition as { workflowConfig?: unknown }).workflowConfig,
    ).toBeUndefined();

    const resolved = resolveWorkflowDefinition(makeGlobalConfig(), definition);

    expect(resolved.executionContexts[0]?.implementer).toEqual(
      GLOBAL_IMPLEMENTER,
    );
    expect(resolved.executionContexts[0]?.contextValidator).toEqual(
      GLOBAL_VALIDATOR,
    );
    expect(resolved.executionContexts[0]?.iterationPolicy).toEqual(
      GLOBAL_ITERATION,
    );
    expect(resolved.executionContexts[0]?.circuitBreaker).toEqual(GLOBAL_CB);
    expect(resolved.executionContexts[0]?.mutability).toEqual(
      GLOBAL_MUTABILITY,
    );
  });

  it("never inherits acceptanceCriteria across cascade tiers", () => {
    const workflowImpl: GraphWorkflowAgentConfig = {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    };
    const definition = makeDefinition({
      workflowConfig: { implementer: workflowImpl },
      executionContexts: [
        makeContext({
          id: "ctx-1",
          acceptanceCriteria: "context-level AC",
        }),
      ],
    });

    const resolved = resolveWorkflowDefinition(makeGlobalConfig(), definition);

    expect(resolved.executionContexts[0]?.acceptanceCriteria).toBe(
      "context-level AC",
    );
  });
});
