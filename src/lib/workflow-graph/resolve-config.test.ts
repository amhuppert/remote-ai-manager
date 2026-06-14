import { describe, expect, it } from "vitest";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type {
  CollaborationAutonomousResolutionThreshold,
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowIterationPolicy,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowScriptValidatorConfig,
  WorkflowCollaborationConfig,
  WorkflowConfigOverride,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import {
  resolveCollaborationConfigWithProvenance,
  resolveContext,
  resolveWorkflowConfig,
  resolveWorkflowDefinition,
} from "./resolve-config";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

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
  humanApprovalGate: { enabled: false },
  iterationPolicy: GLOBAL_ITERATION,
  circuitBreaker: GLOBAL_CB,
  mutability: GLOBAL_MUTABILITY,
  collaboration: {
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
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
    charter: makeTestCharter(),
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

  it("resolves humanApprovalGate to disabled when no layer overrides", () => {
    const resolved = resolveContext(GLOBAL_DEFAULTS, {}, makeContext());

    expect(resolved.humanApprovalGate).toEqual({ enabled: false });
  });

  it("inherits humanApprovalGate from global when neither workflow nor context override", () => {
    const resolved = resolveContext(
      { ...GLOBAL_DEFAULTS, humanApprovalGate: { enabled: true } },
      {},
      makeContext(),
    );

    expect(resolved.humanApprovalGate).toEqual({ enabled: true });
  });

  it("inherits humanApprovalGate from workflow when context omits it", () => {
    const resolved = resolveContext(
      GLOBAL_DEFAULTS,
      { humanApprovalGate: { enabled: true } },
      makeContext(),
    );

    expect(resolved.humanApprovalGate).toEqual({ enabled: true });
  });

  it("uses context humanApprovalGate verbatim when overridden", () => {
    const resolved = resolveContext(
      { ...GLOBAL_DEFAULTS, humanApprovalGate: { enabled: true } },
      { humanApprovalGate: { enabled: true } },
      makeContext({ humanApprovalGate: { enabled: false } }),
    );

    expect(resolved.humanApprovalGate).toEqual({ enabled: false });
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

  it("uses workflow-level humanApprovalGate when present, ignoring global", () => {
    const definition = makeDefinition({
      workflowConfig: { humanApprovalGate: { enabled: true } },
    });
    const resolved = resolveWorkflowConfig(makeGlobalConfig(), definition);

    expect(resolved.humanApprovalGate).toEqual({ enabled: true });
  });

  it("uses global workflowDefaults.humanApprovalGate when workflow-level gate is missing", () => {
    const global = makeGlobalConfig({
      workflowDefaults: {
        ...GLOBAL_DEFAULTS,
        humanApprovalGate: { enabled: true },
      },
    });
    const resolved = resolveWorkflowConfig(global, makeDefinition());

    expect(resolved.humanApprovalGate).toEqual({ enabled: true });
  });

  it("fills missing global blocks from seeded defaults", () => {
    const partialGlobal: WorkflowDefaults = {
      implementer: GLOBAL_IMPLEMENTER,
      contextValidator:
        undefined as unknown as GraphWorkflowAgentValidatorConfig,
      scriptValidator:
        undefined as unknown as GraphWorkflowScriptValidatorConfig,
      humanApprovalGate:
        undefined as unknown as WorkflowDefaults["humanApprovalGate"],
      iterationPolicy: undefined as unknown as GraphWorkflowIterationPolicy,
      circuitBreaker: undefined as unknown as GraphWorkflowCircuitBreakerPolicy,
      mutability: undefined as unknown as GraphWorkflowMutabilityPolicy,
      collaboration: undefined as unknown as WorkflowDefaults["collaboration"],
    };
    const global = makeGlobalConfig({ workflowDefaults: partialGlobal });

    const resolved = resolveWorkflowConfig(global, makeDefinition());

    expect(resolved.implementer).toEqual(GLOBAL_IMPLEMENTER);
    expect(resolved.contextValidator.type).toBe("claude");
    expect(resolved.scriptValidator.enabled).toBe(false);
    expect(resolved.humanApprovalGate.enabled).toBe(false);
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

  it("attaches the same workflow-global charter to every resolved context (1.5, 4.5)", () => {
    const charter = makeTestCharter({
      mission: "Single authority model across all contexts",
    });
    const definition = makeDefinition({
      charter,
      executionContexts: [
        makeContext({ id: "a", title: "A", acceptanceCriteria: "A-AC" }),
        makeContext({ id: "b", title: "B", acceptanceCriteria: "B-AC" }),
      ],
    });

    const resolved = resolveWorkflowDefinition(makeGlobalConfig(), definition);

    expect(resolved.executionContexts).toHaveLength(2);
    for (const ctx of resolved.executionContexts) {
      expect(ctx.charter).toEqual(definition.charter);
    }
    // Same charter object content on every context — implementer and validator
    // of any context read identical charter content (4.5), and the charter is
    // workflow-global with no per-context override (1.5). The semantic context
    // input (GraphWorkflowExecutionContextDefinition) has no `charter` field at
    // all, so there is structurally no per-context override path.
    expect(resolved.executionContexts[0]?.charter).toEqual(
      resolved.executionContexts[1]?.charter,
    );
    expect((makeContext() as { charter?: unknown }).charter).toBeUndefined();
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

describe("resolveCollaborationConfigWithProvenance", () => {
  const GLOBAL_SECOND_AGENT: GraphWorkflowAgentConfig = {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  };
  const WORKFLOW_SECOND_AGENT: GraphWorkflowAgentConfig = {
    backend: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high",
  };
  const CONTEXT_SECOND_AGENT: GraphWorkflowAgentConfig = {
    backend: "claude",
    model: "haiku",
    reasoningEffort: "low",
  };

  const GLOBAL_NEGOTIATION_ROUNDS = 3;
  const WORKFLOW_NEGOTIATION_ROUNDS = 5;
  const CONTEXT_NEGOTIATION_ROUNDS = 7;

  const GLOBAL_THRESHOLD: CollaborationAutonomousResolutionThreshold = "minor";
  const WORKFLOW_THRESHOLD: CollaborationAutonomousResolutionThreshold =
    "major";
  const CONTEXT_THRESHOLD: CollaborationAutonomousResolutionThreshold =
    "blocking";

  const GLOBAL_COLLAB: WorkflowCollaborationConfig = {
    secondAgent: GLOBAL_SECOND_AGENT,
    negotiationRounds: GLOBAL_NEGOTIATION_ROUNDS,
    autonomousResolutionThreshold: GLOBAL_THRESHOLD,
  };

  function globalDefaults(
    overrides: Partial<WorkflowCollaborationConfig> = {},
  ): WorkflowDefaults {
    return {
      ...GLOBAL_DEFAULTS,
      collaboration: { ...GLOBAL_COLLAB, ...overrides },
    };
  }

  describe("3-field × 3-source matrix", () => {
    it("secondAgent: per-node supplies → source = per-node", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext({ collaboration: { secondAgent: CONTEXT_SECOND_AGENT } }),
      );
      expect(resolved.secondAgent.value).toEqual(CONTEXT_SECOND_AGENT);
      expect(resolved.secondAgent.source).toBe("per-node");
    });

    it("secondAgent: workflow supplies, per-node omits → source = workflow", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        { collaboration: { secondAgent: WORKFLOW_SECOND_AGENT } },
        makeContext(),
      );
      expect(resolved.secondAgent.value).toEqual(WORKFLOW_SECOND_AGENT);
      expect(resolved.secondAgent.source).toBe("workflow");
    });

    it("secondAgent: both override layers omit → source = global", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext(),
      );
      expect(resolved.secondAgent.value).toEqual(GLOBAL_SECOND_AGENT);
      expect(resolved.secondAgent.source).toBe("global");
    });

    it("negotiationRounds: per-node supplies → source = per-node", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext({
          collaboration: { negotiationRounds: CONTEXT_NEGOTIATION_ROUNDS },
        }),
      );
      expect(resolved.negotiationRounds.value).toBe(CONTEXT_NEGOTIATION_ROUNDS);
      expect(resolved.negotiationRounds.source).toBe("per-node");
    });

    it("negotiationRounds: workflow supplies, per-node omits → source = workflow", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        { collaboration: { negotiationRounds: WORKFLOW_NEGOTIATION_ROUNDS } },
        makeContext(),
      );
      expect(resolved.negotiationRounds.value).toBe(
        WORKFLOW_NEGOTIATION_ROUNDS,
      );
      expect(resolved.negotiationRounds.source).toBe("workflow");
    });

    it("negotiationRounds: both override layers omit → source = global", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext(),
      );
      expect(resolved.negotiationRounds.value).toBe(GLOBAL_NEGOTIATION_ROUNDS);
      expect(resolved.negotiationRounds.source).toBe("global");
    });

    it("autonomousResolutionThreshold: per-node supplies → source = per-node", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext({
          collaboration: {
            autonomousResolutionThreshold: CONTEXT_THRESHOLD,
          },
        }),
      );
      expect(resolved.autonomousResolutionThreshold.value).toBe(
        CONTEXT_THRESHOLD,
      );
      expect(resolved.autonomousResolutionThreshold.source).toBe("per-node");
    });

    it("autonomousResolutionThreshold: workflow supplies, per-node omits → source = workflow", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {
          collaboration: {
            autonomousResolutionThreshold: WORKFLOW_THRESHOLD,
          },
        },
        makeContext(),
      );
      expect(resolved.autonomousResolutionThreshold.value).toBe(
        WORKFLOW_THRESHOLD,
      );
      expect(resolved.autonomousResolutionThreshold.source).toBe("workflow");
    });

    it("autonomousResolutionThreshold: both override layers omit → source = global", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext(),
      );
      expect(resolved.autonomousResolutionThreshold.value).toBe(
        GLOBAL_THRESHOLD,
      );
      expect(resolved.autonomousResolutionThreshold.source).toBe("global");
    });
  });

  describe("mixed-provenance + invariants", () => {
    it("yields three distinct sources when each layer supplies a different field", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {
          collaboration: {
            autonomousResolutionThreshold: WORKFLOW_THRESHOLD,
          },
        },
        makeContext({
          collaboration: {
            negotiationRounds: CONTEXT_NEGOTIATION_ROUNDS,
          },
        }),
      );

      expect(resolved.secondAgent.source).toBe("global");
      expect(resolved.secondAgent.value).toEqual(GLOBAL_SECOND_AGENT);

      expect(resolved.negotiationRounds.source).toBe("per-node");
      expect(resolved.negotiationRounds.value).toBe(CONTEXT_NEGOTIATION_ROUNDS);

      expect(resolved.autonomousResolutionThreshold.source).toBe("workflow");
      expect(resolved.autonomousResolutionThreshold.value).toBe(
        WORKFLOW_THRESHOLD,
      );

      const sources = new Set([
        resolved.secondAgent.source,
        resolved.negotiationRounds.source,
        resolved.autonomousResolutionThreshold.source,
      ]);
      expect(sources).toEqual(new Set(["per-node", "workflow", "global"]));
    });

    it("per-node takes precedence over workflow for the same field", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        { collaboration: { negotiationRounds: WORKFLOW_NEGOTIATION_ROUNDS } },
        makeContext({
          collaboration: { negotiationRounds: CONTEXT_NEGOTIATION_ROUNDS },
        }),
      );
      expect(resolved.negotiationRounds.value).toBe(CONTEXT_NEGOTIATION_ROUNDS);
      expect(resolved.negotiationRounds.source).toBe("per-node");
    });

    it("per-node takes precedence over global for the same field", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext({
          collaboration: {
            autonomousResolutionThreshold: CONTEXT_THRESHOLD,
          },
        }),
      );
      expect(resolved.autonomousResolutionThreshold.value).toBe(
        CONTEXT_THRESHOLD,
      );
      expect(resolved.autonomousResolutionThreshold.source).toBe("per-node");
    });

    it("workflow takes precedence over global for the same field", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        { collaboration: { secondAgent: WORKFLOW_SECOND_AGENT } },
        makeContext(),
      );
      expect(resolved.secondAgent.value).toEqual(WORKFLOW_SECOND_AGENT);
      expect(resolved.secondAgent.source).toBe("workflow");
    });

    it("returns provenance for every field even when all come from a single layer", () => {
      const resolved = resolveCollaborationConfigWithProvenance(
        globalDefaults(),
        {},
        makeContext({
          collaboration: {
            secondAgent: CONTEXT_SECOND_AGENT,
            negotiationRounds: CONTEXT_NEGOTIATION_ROUNDS,
            autonomousResolutionThreshold: CONTEXT_THRESHOLD,
          },
        }),
      );
      expect(resolved.secondAgent.source).toBe("per-node");
      expect(resolved.negotiationRounds.source).toBe("per-node");
      expect(resolved.autonomousResolutionThreshold.source).toBe("per-node");
    });

    it("respects each global field independently when only some override layers fire", () => {
      const customGlobal = globalDefaults({
        secondAgent: GLOBAL_SECOND_AGENT,
        negotiationRounds: 9,
        autonomousResolutionThreshold: "none",
      });
      const resolved = resolveCollaborationConfigWithProvenance(
        customGlobal,
        { collaboration: { negotiationRounds: WORKFLOW_NEGOTIATION_ROUNDS } },
        makeContext(),
      );
      expect(resolved.secondAgent.source).toBe("global");
      expect(resolved.secondAgent.value).toEqual(GLOBAL_SECOND_AGENT);
      expect(resolved.negotiationRounds.source).toBe("workflow");
      expect(resolved.negotiationRounds.value).toBe(
        WORKFLOW_NEGOTIATION_ROUNDS,
      );
      expect(resolved.autonomousResolutionThreshold.source).toBe("global");
      expect(resolved.autonomousResolutionThreshold.value).toBe("none");
    });
  });
});
