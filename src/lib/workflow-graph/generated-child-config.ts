/**
 * The generated-child config compiler (D4 R7, decision D6).
 *
 * A context created by a running lane inherits its operational config, and the
 * whole question is WHICH config and from WHERE. The answer splits every block
 * into two classes:
 *
 * - **PROTECTED** — `contextValidator`, `humanApprovalGate`, `askUserQuestions`,
 *   `collaboration`, `planRepair`, `mutability`, `agentValidation`. These always
 *   derive from the INVOKER's resolved config, and a payload override of one is
 *   refused.
 *   Deriving them from the invoker (rather than from the payload's
 *   `configFromContextId`) is what closes the laundering hole: pointing a
 *   generated child's seed at a validator-disabled context would otherwise let a
 *   lane weaken its own children's gates without ever naming the weakening.
 *
 * - **TUNING** — `implementer`, `iterationPolicy`, `circuitBreaker`,
 *   `scriptValidator`. These seed from `configFromContextId` when the payload
 *   names one (else the invoker) and accept payload overrides, because "run this
 *   child on a cheaper model with a shorter leash" is exactly the judgment the
 *   generating agent is there to make. `scriptValidator` is the exception that
 *   proves the rule: it is a GATE that happens to live in the tuning class, so
 *   it is MONOTONIC — every step of the composition may add command names,
 *   none may remove an inherited name. That covers both weakening paths, the
 *   override and the seed.
 *
 * After composition, `mutability.allowAgentContextAdd` is stamped `false`,
 * touching only that key: expansion authority is granted per context by a human
 * author and must never propagate down a generated subgraph, but the sibling
 * flags a child legitimately inherits must survive the stamp intact (R7.1).
 *
 * The module is pure and value-in/value-out, so the whole policy is table
 * testable against the four inheritance sources without a repository.
 */

import { z } from "zod";
import {
  agentAssignmentSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  DEFAULT_AGENT_VALIDATION_CONFIG,
  type AgentAssignment,
} from "@/lib/workflow-graph/config-schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowResolvedContext,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type { ResolvedContextConfig } from "./runtime-edits";

/**
 * Blocks a generated child always takes from the INVOKER, whatever the payload
 * says and whatever context it seeds from. Every one of them is a validation,
 * approval, or authority gate.
 */
export const PROTECTED_CHILD_CONFIG_BLOCKS = [
  "contextValidator",
  "humanApprovalGate",
  "askUserQuestions",
  "collaboration",
  "planRepair",
  "mutability",
  "agentValidation",
] as const;

/** Blocks a generating agent may seed from another context and override. */
export const TUNING_CHILD_CONFIG_BLOCKS = [
  "implementer",
  "iterationPolicy",
  "circuitBreaker",
  "scriptValidator",
  "scriptValidatorSource",
] as const;

export type ProtectedChildConfigBlock =
  (typeof PROTECTED_CHILD_CONFIG_BLOCKS)[number];

/**
 * The config half of an expansion payload's context entry.
 *
 * The protected keys are declared here on purpose. `.strict()` would already
 * reject them, but then "protected-block overrides are refused" would be
 * indistinguishable from "your JSON did not parse" — and a refusal the payload
 * cannot express is a refusal nobody can test. They parse as `unknown` and the
 * compiler refuses them by name, so the lane is told which rule it broke.
 */
export const generatedChildConfigOverrideSchema = z
  .object({
    implementer: agentAssignmentSchema.optional(),
    iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
    circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
    scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
    contextValidator: z.unknown().optional(),
    humanApprovalGate: z.unknown().optional(),
    askUserQuestions: z.unknown().optional(),
    collaboration: z.unknown().optional(),
    planRepair: z.unknown().optional(),
    mutability: z.unknown().optional(),
    agentValidation: z.unknown().optional(),
  })
  .strict();

export type GeneratedChildConfigOverride = z.infer<
  typeof generatedChildConfigOverrideSchema
>;

export type GeneratedChildConfig = Omit<
  ResolvedContextConfig,
  "implementer"
> & {
  implementer: AgentAssignment;
};

export type CompileGeneratedChildConfigResult =
  | { ok: true; config: GeneratedChildConfig }
  | { ok: false; issues: WorkflowGraphValidationError[] };

export interface CompileGeneratedChildConfigInput {
  /** The invoking context's resolved config — the anchor for protected blocks. */
  invoker: ResolvedContextConfig;
  /**
   * The resolved config of the context the payload named in
   * `configFromContextId`, or null when it named none. Influences TUNING blocks
   * only.
   */
  seed?: ResolvedContextConfig | null;
  /** The payload's per-context config overrides, if any. */
  overrides?: GeneratedChildConfigOverride | undefined;
}

/**
 * Project a resolved context down to its config blocks — the shape both this
 * compiler and `add-context`'s `configFromContextId` seeding read. One
 * projection so a newly added config block cannot reach one path and miss the
 * other.
 *
 * `collaboration` is `.optional()` on executions seeded before the snapshot
 * field existed, so a fallback is required rather than inferred.
 */
export function resolvedContextConfig(
  context: GraphWorkflowResolvedContext,
  fallbackCollaboration: ResolvedCollaborationConfig,
  fallbackAgentValidation: ResolvedContextConfig["agentValidation"] = {
    implementer: {
      value: DEFAULT_AGENT_VALIDATION_CONFIG.implementer,
      source: "global",
    },
    contextValidator: {
      value: DEFAULT_AGENT_VALIDATION_CONFIG.contextValidator,
      source: "global",
    },
  },
): ResolvedContextConfig {
  return {
    implementer: context.implementer,
    contextValidator: context.contextValidator,
    scriptValidator: context.scriptValidator,
    scriptValidatorSource: context.scriptValidatorSource ?? "global",
    humanApprovalGate: context.humanApprovalGate,
    askUserQuestions: context.askUserQuestions,
    mutability: context.mutability,
    circuitBreaker: context.circuitBreaker,
    iterationPolicy: context.iterationPolicy,
    planRepair: context.planRepair,
    collaboration: context.collaboration ?? fallbackCollaboration,
    agentValidation: context.agentValidation ?? fallbackAgentValidation,
  };
}

function issue(code: string, message: string): WorkflowGraphValidationError {
  return { code, message };
}

/**
 * Which protected blocks did this payload try to override? Read through own
 * properties only: a payload whose prototype carries a `mutability` never
 * declared one, and refusing on an inherited key would be a refusal nobody
 * asked for.
 */
function declaredProtectedBlocks(
  overrides: GeneratedChildConfigOverride | undefined,
): ProtectedChildConfigBlock[] {
  if (!overrides) return [];
  return PROTECTED_CHILD_CONFIG_BLOCKS.filter(
    (block) =>
      Object.prototype.hasOwnProperty.call(overrides, block) &&
      overrides[block] !== undefined,
  );
}

function removedCommands(
  inherited: readonly string[],
  candidate: readonly string[],
): string[] {
  const candidateNames = new Set(candidate);
  return [...new Set(inherited)].filter((name) => !candidateNames.has(name));
}

/**
 * Compile the config a generated child resolves to, or refuse the request.
 * Whole-batch and fail-closed like every other expansion refusal: a config the
 * compiler will not produce is not a config anyone gets half of.
 */
export function compileGeneratedChildConfig(
  input: CompileGeneratedChildConfigInput,
): CompileGeneratedChildConfigResult {
  const { invoker, overrides } = input;
  const seed = input.seed ?? invoker;

  const smuggled = declaredProtectedBlocks(overrides);
  if (smuggled.length > 0) {
    return {
      ok: false,
      issues: smuggled.map((block) =>
        issue(
          "expansion-protected-config-override",
          `Generated contexts may not override the protected "${block}" block; it derives from the invoking context`,
        ),
      ),
    };
  }

  // MONOTONIC script validation, enforced at every step of the composition —
  // not just against the invoker. A lane must not be able to add a command
  // through a seed and drop it again through an override in the same request.
  const seededScriptValidator = seed.scriptValidator;
  const removedBySeed = removedCommands(
    invoker.scriptValidator.commands,
    seededScriptValidator.commands,
  );
  if (removedBySeed.length > 0) {
    return {
      ok: false,
      issues: [
        issue(
          "expansion-script-validator-weakened",
          `The named configFromContextId context removes inherited script validation command(s): ${removedBySeed.join(", ")}`,
        ),
      ],
    };
  }
  const overriddenScriptValidator =
    overrides?.scriptValidator ?? seededScriptValidator;
  const removedByOverride = removedCommands(
    seededScriptValidator.commands,
    overriddenScriptValidator.commands,
  );
  if (removedByOverride.length > 0) {
    return {
      ok: false,
      issues: [
        issue(
          "expansion-script-validator-weakened",
          `A generated context may add script validation commands but never remove inherited command(s): ${removedByOverride.join(", ")}`,
        ),
      ],
    };
  }

  return {
    ok: true,
    config: {
      // TUNING: seed, then override.
      implementer: overrides?.implementer ?? seed.implementer,
      iterationPolicy: overrides?.iterationPolicy ?? seed.iterationPolicy,
      circuitBreaker: overrides?.circuitBreaker ?? seed.circuitBreaker,
      scriptValidator: overriddenScriptValidator,
      scriptValidatorSource:
        overrides?.scriptValidator !== undefined
          ? "per-node"
          : seed.scriptValidatorSource,
      // PROTECTED: invoker-derived, unconditionally.
      contextValidator: invoker.contextValidator,
      humanApprovalGate: invoker.humanApprovalGate,
      askUserQuestions: invoker.askUserQuestions,
      collaboration: invoker.collaboration,
      planRepair: invoker.planRepair,
      // Give the pure compiler result its own container so a caller inspecting
      // or transforming it cannot rewrite the invoker's durable snapshot.
      agentValidation: structuredClone(invoker.agentValidation),
      // Stamped LAST, touching one key: authority never propagates down a
      // generated subgraph, and every sibling flag survives exactly as
      // inherited (R7.1).
      mutability: { ...invoker.mutability, allowAgentContextAdd: false },
    },
  };
}
