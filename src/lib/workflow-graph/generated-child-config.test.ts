import { describe, expect, it } from "vitest";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import {
  compileGeneratedChildConfig,
  generatedChildConfigOverrideSchema,
  resolvedContextConfig,
  PROTECTED_CHILD_CONFIG_BLOCKS,
  TUNING_CHILD_CONFIG_BLOCKS,
  type GeneratedChildConfig,
} from "./generated-child-config";
import { resolveContext, SEEDED_WORKFLOW_DEFAULTS } from "./resolve-config";
import type { ResolvedContextConfig } from "./runtime-edits";
import { seedAssignment } from "./test-fixtures";

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "context-plan",
  title: "Plan",
  acceptanceCriteria: "The plan is written",
  placement: { lane: "context-plan", mode: "full" },
};

/**
 * The provenance-carrying collaboration fallback a legacy resolved context (one
 * seeded before the snapshot field existed) would fall back to. The cascade
 * below always produces its own, so this is never actually read here.
 */
const FALLBACK_COLLABORATION = resolveContext(
  SEEDED_WORKFLOW_DEFAULTS,
  {},
  CONTEXT,
).collaboration ?? {
  enabled: { value: false, source: "global" },
  secondAgent: {
    value: {
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
    },
    source: "global",
  },
  negotiationRounds: { value: 3, source: "global" },
  autonomousResolutionThreshold: { value: "minor", source: "global" },
};

const FALLBACK_AGENT_VALIDATION = resolveContext(
  SEEDED_WORKFLOW_DEFAULTS,
  {},
  CONTEXT,
).agentValidation;

/**
 * Resolve an invoker through the REAL cascade, so "which tier turned expansion
 * authority on" is a property of the fixture rather than an assertion about one.
 */
function resolveInvoker(input: {
  global?: Partial<WorkflowDefaults>;
  workflow?: WorkflowConfigOverride;
  context?: Partial<GraphWorkflowExecutionContextDefinition>;
}): ResolvedContextConfig {
  const globalDefaults: WorkflowDefaults = {
    ...SEEDED_WORKFLOW_DEFAULTS,
    ...input.global,
  };
  const resolved = resolveContext(globalDefaults, input.workflow ?? {}, {
    ...CONTEXT,
    ...input.context,
  });
  return resolvedContextConfig(
    {
      ...resolved,
      implementer: seedAssignment(resolved.implementer),
      contextValidator: {
        ...resolved.contextValidator,
        assignments: resolved.contextValidator.assignments.map((assignment) =>
          seedAssignment(assignment),
        ),
      },
    },
    FALLBACK_COLLABORATION,
    FALLBACK_AGENT_VALIDATION,
  );
}

/** A resolved config with every block explicitly distinguishable from defaults. */
function invokerConfig(
  overrides: Partial<ResolvedContextConfig> = {},
): ResolvedContextConfig {
  return {
    ...resolveInvoker({}),
    implementer: seedAssignment({
      id: "invoker-implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        modelSelection: { modelId: "opus", parameters: { effort: "high" } },
      },
    }),
    contextValidator: {
      enabled: true,
      assignments: [
        seedAssignment({
          id: "invoker-reviewer",
          profile: { tier: "builtin", id: "general-reviewer" },
          authority: "blocking",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        }),
      ],
    },
    scriptValidator: { commands: ["typecheck"] },
    scriptValidatorSource: "workflow",
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: true },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
    circuitBreaker: { consecutiveFailureThreshold: 5 },
    iterationPolicy: { maxIterations: 12 },
    planRepair: { enabled: true, maxAttemptsPerContext: 4 },
    agentValidation: {
      implementer: {
        value: { mode: "only", commands: ["test"] },
        source: "workflow",
        commands: ["test"],
      },
      contextValidator: {
        value: { mode: "only", commands: ["lint"] },
        source: "per-node",
        commands: ["lint"],
      },
    },
    ...overrides,
  };
}

/** A seed context whose gates are all WEAKER than the invoker's. */
function weakSeedConfig(
  overrides: Partial<ResolvedContextConfig> = {},
): ResolvedContextConfig {
  return {
    ...invokerConfig(),
    implementer: seedAssignment({
      id: "seed-implementer",
      profile: { tier: "project", id: "fast-implementer" },
      agent: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "low" } },
      },
    }),
    contextValidator: {
      enabled: false,
      assignments: [
        seedAssignment({
          id: "dormant-reviewer",
          profile: { tier: "project", id: "dormant-reviewer" },
          authority: "advisory",
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "haiku",
              parameters: { effort: "low" },
            },
          },
        }),
      ],
    },
    scriptValidator: { commands: ["typecheck", "lint"] },
    scriptValidatorSource: "global",
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
    circuitBreaker: { consecutiveFailureThreshold: 1 },
    iterationPolicy: { maxIterations: 99 },
    planRepair: { enabled: false, maxAttemptsPerContext: 1 },
    agentValidation: {
      implementer: {
        value: { mode: "only", commands: [] },
        source: "global",
        commands: [],
      },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
        commands: [],
      },
    },
    ...overrides,
  };
}

function compileOrThrow(
  input: Parameters<typeof compileGeneratedChildConfig>[0],
): GeneratedChildConfig {
  const result = compileGeneratedChildConfig(input);
  if (!result.ok) {
    throw new Error(
      `expected a compiled config, got ${result.issues.map((i) => i.code).join(", ")}`,
    );
  }
  return result.config;
}

describe("generated-child config compiler — block classification", () => {
  it("splits every resolved config block into exactly one class", () => {
    const blocks = [
      ...PROTECTED_CHILD_CONFIG_BLOCKS,
      ...TUNING_CHILD_CONFIG_BLOCKS,
    ].sort();

    // The compiler's classification must stay total: a block that belongs to
    // neither class would silently fall through to the seed, which is how a
    // gate gets weakened by accident.
    expect(blocks).toEqual(Object.keys(invokerConfig()).sort());
    expect(new Set(blocks).size).toBe(blocks.length);
  });
});

describe("resolvedContextConfig", () => {
  it("preserves snapshot-bearing assignments and resolved provenance", () => {
    const source = invokerConfig();
    const projected = resolvedContextConfig(
      {
        ...CONTEXT,
        ...source,
      } satisfies GraphWorkflowResolvedContext,
      FALLBACK_COLLABORATION,
      FALLBACK_AGENT_VALIDATION,
    );

    expect(projected.implementer.profileSnapshot).toEqual(
      source.implementer.profileSnapshot,
    );
    expect(projected.contextValidator.assignments[0]?.profileSnapshot).toEqual(
      source.contextValidator.assignments[0]?.profileSnapshot,
    );
    expect(projected.scriptValidatorSource).toBe("workflow");
    expect(projected.agentValidation).toEqual(source.agentValidation);
  });
});

describe("generated-child config compiler — expansion authority (R7.1)", () => {
  /**
   * The four inheritance sources R7.1 names. Each turns `allowAgentContextAdd`
   * ON somewhere different; the child must resolve it OFF in every one, and must
   * carry the invoker's `allowAgentTaskAdd` through untouched.
   */
  const enabledMutability = {
    allowAgentTaskAdd: true,
    allowAgentContextAdd: true,
  } as const;

  const sources: Array<{
    name: string;
    invoker: ResolvedContextConfig;
    seed?: ResolvedContextConfig;
  }> = [
    {
      name: "global tier enabled",
      invoker: resolveInvoker({ global: { mutability: enabledMutability } }),
    },
    {
      name: "workflow tier enabled",
      invoker: resolveInvoker({ workflow: { mutability: enabledMutability } }),
    },
    {
      name: "invoker context-local enabled",
      invoker: resolveInvoker({ context: { mutability: enabledMutability } }),
    },
    {
      name: "configFromContextId points at an enabled context",
      invoker: resolveInvoker({ context: { mutability: enabledMutability } }),
      seed: weakSeedConfig({ mutability: enabledMutability }),
    },
  ];

  for (const source of sources) {
    it(`resolves allowAgentContextAdd false when the ${source.name}`, () => {
      // The source really does grant authority — otherwise the assertion below
      // would pass vacuously.
      expect(source.invoker.mutability.allowAgentContextAdd).toBe(true);

      const config = compileOrThrow({
        invoker: source.invoker,
        seed: source.seed ?? null,
      });

      expect(config.mutability.allowAgentContextAdd).toBe(false);
      // Siblings survive the stamp exactly as inherited — the stamp touches one
      // key, it does not rebuild the block.
      expect(config.mutability.allowAgentTaskAdd).toBe(
        source.invoker.mutability.allowAgentTaskAdd,
      );
      expect(config.mutability).toEqual({
        ...source.invoker.mutability,
        allowAgentContextAdd: false,
      });
    });
  }

  it("preserves an inherited allowAgentTaskAdd of true from the invoker, not the seed", () => {
    const config = compileOrThrow({
      invoker: invokerConfig({
        mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
      }),
      seed: weakSeedConfig({
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
      }),
    });

    expect(config.mutability).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: false,
    });
  });
});

describe("generated-child config compiler — protected blocks (R7.2)", () => {
  it("derives every protected block from the invoker, ignoring configFromContextId", () => {
    const invoker = invokerConfig();
    const config = compileOrThrow({ invoker, seed: weakSeedConfig() });

    // The laundering case: seeding from a context whose validator is DISABLED
    // must not disable the child's.
    expect(config.contextValidator).toEqual(invoker.contextValidator);
    expect(config.humanApprovalGate).toEqual(invoker.humanApprovalGate);
    expect(config.askUserQuestions).toEqual(invoker.askUserQuestions);
    expect(config.collaboration).toEqual(invoker.collaboration);
    expect(config.planRepair).toEqual(invoker.planRepair);
    expect(config.agentValidation).toEqual(invoker.agentValidation);
    // Memory delivery is an independence gate (spec `memory` D7): a generated
    // child can never widen what its lanes read or may write.
    expect(config.memory).toEqual(invoker.memory);
    expect(config.memory).not.toBe(invoker.memory);
  });

  for (const block of PROTECTED_CHILD_CONFIG_BLOCKS) {
    it(`refuses a payload override of the protected ${block} block`, () => {
      const result = compileGeneratedChildConfig({
        invoker: invokerConfig(),
        seed: null,
        overrides: generatedChildConfigOverrideSchema.parse({
          [block]:
            block === "contextValidator"
              ? null
              : block === "agentValidation"
                ? { implementer: { mode: "only", commands: [] } }
                : { enabled: false },
        }),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toContain(
        "expansion-protected-config-override",
      );
      expect(result.issues[0]?.message).toContain(block);
    });
  }
});

describe("generated-child config compiler — tuning blocks (R7.2)", () => {
  it("seeds tuning blocks from configFromContextId and applies payload overrides", () => {
    const invoker = invokerConfig();
    const seed = weakSeedConfig();
    const config = compileOrThrow({
      invoker,
      seed,
      overrides: generatedChildConfigOverrideSchema.parse({
        circuitBreaker: { consecutiveFailureThreshold: 2 },
      }),
    });

    // Overridden.
    expect(config.circuitBreaker).toEqual({ consecutiveFailureThreshold: 2 });
    // Seeded from the named context, not the invoker.
    expect(config.implementer).toEqual(seed.implementer);
    expect(config.iterationPolicy).toEqual(seed.iterationPolicy);
  });

  it("seeds tuning blocks from the invoker when no configFromContextId is named", () => {
    const invoker = invokerConfig();
    const config = compileOrThrow({ invoker, seed: null });

    expect(config.implementer).toEqual(invoker.implementer);
    expect(config.iterationPolicy).toEqual(invoker.iterationPolicy);
    expect(config.circuitBreaker).toEqual(invoker.circuitBreaker);
    expect(config.scriptValidator).toEqual(invoker.scriptValidator);
  });

  it("accepts an override that adds script commands and marks it per-node", () => {
    const config = compileOrThrow({
      invoker: invokerConfig({ scriptValidator: { commands: ["typecheck"] } }),
      seed: null,
      overrides: generatedChildConfigOverrideSchema.parse({
        scriptValidator: { commands: ["typecheck", "test"] },
      }),
    });

    expect(config.scriptValidator).toEqual({ commands: ["typecheck", "test"] });
    expect(config.scriptValidatorSource).toBe("per-node");
  });

  it("accepts a seed that adds script commands and preserves its provenance", () => {
    const config = compileOrThrow({
      invoker: invokerConfig({ scriptValidator: { commands: ["typecheck"] } }),
      seed: weakSeedConfig({
        scriptValidator: { commands: ["typecheck", "lint"] },
        scriptValidatorSource: "global",
      }),
    });

    expect(config.scriptValidator).toEqual({
      commands: ["typecheck", "lint"],
    });
    expect(config.scriptValidatorSource).toBe("global");
  });

  it("refuses an override that removes an inherited script command", () => {
    const result = compileGeneratedChildConfig({
      invoker: invokerConfig({
        scriptValidator: { commands: ["typecheck", "test"] },
      }),
      seed: null,
      overrides: generatedChildConfigOverrideSchema.parse({
        scriptValidator: { commands: ["typecheck"] },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "expansion-script-validator-weakened",
    ]);
  });

  it("refuses a configFromContextId seed that removes an inherited script command", () => {
    const result = compileGeneratedChildConfig({
      invoker: invokerConfig({
        scriptValidator: { commands: ["typecheck", "test"] },
      }),
      seed: weakSeedConfig({ scriptValidator: { commands: ["typecheck"] } }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "expansion-script-validator-weakened",
    ]);
  });

  it("refuses an override that removes a command the seed added", () => {
    // Monotonic at EVERY step, not just against the invoker: a lane must not be
    // able to raise the validator through a seed and then drop it in the same
    // request.
    const result = compileGeneratedChildConfig({
      invoker: invokerConfig({ scriptValidator: { commands: ["typecheck"] } }),
      seed: weakSeedConfig({
        scriptValidator: { commands: ["typecheck", "lint"] },
      }),
      overrides: generatedChildConfigOverrideSchema.parse({
        scriptValidator: { commands: ["typecheck"] },
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "expansion-script-validator-weakened",
    ]);
  });
});

describe("generated-child config override schema", () => {
  it("accepts a current assignment override and rejects a bare agent config", () => {
    const current = generatedChildConfigOverrideSchema.safeParse({
      implementer: {
        id: "child-implementer",
        profile: { tier: "project", id: "child-specialist" },
        focus: "candidate implementation",
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      },
    });

    expect(current.success).toBe(true);
    expect(
      generatedChildConfigOverrideSchema.safeParse({
        implementer: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a key that is neither a tuning nor a protected block", () => {
    expect(
      generatedChildConfigOverrideSchema.safeParse({
        charter: { mission: "x" },
      }).success,
    ).toBe(false);
  });

  it("parses protected keys so their refusal is expressible", () => {
    // A refusal the payload cannot express is a refusal nobody can test — the
    // same reason expansion tasks are a flat, handle-keyed list.
    expect(
      generatedChildConfigOverrideSchema.safeParse({
        humanApprovalGate: { enabled: false },
      }).success,
    ).toBe(true);
  });
});
