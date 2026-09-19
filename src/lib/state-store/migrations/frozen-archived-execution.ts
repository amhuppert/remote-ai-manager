import { z } from "zod";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

/**
 * Frozen pre-assignment archive transform for migration 0051 only.
 * Whole blobs must belong to one historical generation; mixed or malformed
 * role shapes remain untouched. Local schemas and historical defaults ensure
 * later catalog edits cannot reinterpret a past execution's runtime.
 */

/**
 * Legacy blobs carry no assignment identity — there was exactly one implementer
 * and at most one validator per context. Decoding gives them the built-in
 * identity those roles always had. These are deliberately literal rather than
 * read from the current seeds: what a historical run decodes into must not
 * drift when the seeded defaults change.
 */
const LEGACY_IMPLEMENTER_ID = "implementer";
const LEGACY_IMPLEMENTER_PROFILE = {
  tier: "builtin",
  id: "general-implementer",
} as const;
const LEGACY_VALIDATOR_ID = "general";
const LEGACY_VALIDATOR_PROFILE = {
  tier: "builtin",
  id: "general-reviewer",
} as const;

/**
 * A legacy Codex validator could omit model and effort entirely: the resolver
 * forwarded `undefined` and the task-run transport resolved the configured
 * `agentBackends.codex` profile at dispatch. An assignment's runtime is
 * concrete, so the decode materializes the values that profile supplied.
 * Frozen literals, not the live config or the current default-model helper —
 * a past run's recorded runtime cannot be allowed to change underneath it.
 */
const LEGACY_CODEX_VALIDATOR_MODEL = "gpt-5.4";
const LEGACY_CODEX_VALIDATOR_EFFORT = "high";
// Archived workflow assignments predate a per-assignment fast field. The
// frozen task-run default completes their read-only Codex selection.
const LEGACY_CODEX_FAST = "false";

/**
 * The snapshot a pre-profile archived execution decodes into.
 *
 * A working definition carries the profile bytes its run was seeded with, but
 * these runs predate agent profiles entirely — there are no delivered bytes to
 * report, and inventing the built-in profile's CURRENT text would assert that a
 * historical run received instructions it never saw. So the snapshot says
 * exactly that instead, and its hashes genuinely cover the placeholder they
 * describe: the record is self-describing rather than plausibly wrong.
 */
const LEGACY_ABSENT_PROFILE_INSTRUCTIONS =
  "This execution ran before agent profiles existed. No profile layer was composed or delivered; this placeholder records that absence and is never sent to a model.";

function legacyProfileSnapshot(profile: {
  tier: "builtin";
  id: string;
}): Record<string, unknown> {
  const renderedInstructionBlock = LEGACY_ABSENT_PROFILE_INSTRUCTIONS;
  return {
    ...profile,
    name: "No profile (pre-profile execution)",
    revision: 1,
    sourceContentHash: computeContentHash(LEGACY_ABSENT_PROFILE_INSTRUCTIONS),
    instructions: LEGACY_ABSENT_PROFILE_INSTRUCTIONS,
    renderedInstructionBlock,
    resolvedInstructionHash: computeContentHash(renderedInstructionBlock),
  };
}

// ---------------------------------------------------------------
// The pre-cutover shapes, reproduced verbatim as the decoder's gate
// ---------------------------------------------------------------

const legacyClaudeModelSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);
const legacyEffortLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);
const legacyCodexModelSchema = z.enum([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
]);
const legacyCodexEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/**
 * The per-backend runtime triple. The `backend`-defaulting preprocess is part
 * of the frozen shape: blobs written before the field existed are still in the
 * archive, and the default it applies (Claude) is the backend those runs used.
 */
const legacyAgentConfigSchema = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null && !("backend" in val)) {
      return { ...val, backend: "claude" };
    }
    return val;
  },
  z.discriminatedUnion("backend", [
    z.object({
      backend: z.literal("claude"),
      model: legacyClaudeModelSchema,
      reasoningEffort: legacyEffortLevelSchema,
    }),
    z.object({
      backend: z.literal("codex"),
      model: legacyCodexModelSchema,
      reasoningEffort: legacyCodexEffortSchema,
    }),
  ]),
);

const legacyValidatorBaseSchema = z.object({
  enabled: z.boolean().default(true),
});

const legacyClaudeValidatorSchema = legacyValidatorBaseSchema.extend({
  type: z.literal("claude"),
  agent: legacyAgentConfigSchema,
});

const legacyCodexValidatorSchema = legacyValidatorBaseSchema.extend({
  type: z.literal("codex"),
  codex: z
    .object({
      model: legacyCodexModelSchema.optional(),
      reasoningEffort: legacyCodexEffortSchema.optional(),
    })
    .default({}),
});

const legacyContextValidatorSchema = z.discriminatedUnion("type", [
  legacyClaudeValidatorSchema,
  legacyCodexValidatorSchema,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const legacyAgentParameters = {
  claude: (reasoningEffort: string) => ({ effort: reasoningEffort }),
  codex: (reasoningEffort: string) => ({
    reasoning: reasoningEffort,
    fast: LEGACY_CODEX_FAST,
  }),
} as const;

function upgradeAgent(
  legacy: z.infer<typeof legacyAgentConfigSchema>,
): Record<string, unknown> {
  return {
    backend: legacy.backend,
    modelSelection: {
      modelId: legacy.model,
      parameters: legacyAgentParameters[legacy.backend](legacy.reasoningEffort),
    },
  };
}

/**
 * The pre-cutover implementer was the bare per-backend runtime config.
 * `undefined` means "not that shape" — the caller refuses the whole blob
 * rather than upgrading this field alone.
 */
function upgradeImplementer(value: unknown): unknown {
  const legacy = legacyAgentConfigSchema.safeParse(value);
  if (!legacy.success) return undefined;
  return {
    id: LEGACY_IMPLEMENTER_ID,
    profile: LEGACY_IMPLEMENTER_PROFILE,
    profileSnapshot: legacyProfileSnapshot(LEGACY_IMPLEMENTER_PROFILE),
    // The parsed value materializes the implicit Claude backend before it is
    // projected into the current read-only presentation shape.
    agent: upgradeAgent(legacy.data),
  };
}

/**
 * The pre-cutover resolved validator was a provider-named discriminated union
 * (`type: 'claude' | 'codex'`) or `null` for "validation off". The strategy
 * each provider variant implied becomes the assignment's explicit strategy.
 * `undefined` means "not that shape", exactly as above — note that the legacy
 * `null` VALUE is a shape the floor recognizes, not a rejection.
 */
function upgradeContextValidator(value: unknown): unknown {
  if (value === null) return { enabled: false, assignments: [] };

  const legacy = legacyContextValidatorSchema.safeParse(value);
  if (!legacy.success) return undefined;

  const assignment =
    legacy.data.type === "codex"
      ? {
          strategy: "task",
          agent: upgradeAgent({
            backend: "codex",
            model: legacy.data.codex.model ?? LEGACY_CODEX_VALIDATOR_MODEL,
            reasoningEffort:
              legacy.data.codex.reasoningEffort ??
              LEGACY_CODEX_VALIDATOR_EFFORT,
          }),
        }
      : {
          strategy: "conversation",
          agent: upgradeAgent(legacy.data.agent),
        };

  return {
    enabled: legacy.data.enabled,
    assignments: [
      {
        id: LEGACY_VALIDATOR_ID,
        profile: LEGACY_VALIDATOR_PROFILE,
        profileSnapshot: legacyProfileSnapshot(LEGACY_VALIDATOR_PROFILE),
        ...assignment,
      },
    ],
  };
}

/**
 * A context upgraded as a unit, or `undefined` when it is not completely
 * pre-cutover. Both roles must be legacy: a context carrying one of each
 * generation belongs to no generation.
 */
function upgradeContext(context: unknown): Record<string, unknown> | undefined {
  if (!isRecord(context)) return undefined;
  const implementer = upgradeImplementer(context.implementer);
  if (implementer === undefined) return undefined;
  const contextValidator = upgradeContextValidator(context.contextValidator);
  if (contextValidator === undefined) return undefined;
  const collaboration = context.collaboration;
  if (!isRecord(collaboration) || !isRecord(collaboration.secondAgent)) {
    return { ...context, implementer, contextValidator };
  }
  const agent = collaboration.secondAgent.value;
  if (!isRecord(agent) || "modelSelection" in agent) {
    return { ...context, implementer, contextValidator };
  }
  const legacyAgent = legacyAgentConfigSchema.safeParse(agent);
  if (!legacyAgent.success) return undefined;
  const retained = { ...agent };
  delete retained.model;
  delete retained.reasoningEffort;
  return {
    ...context,
    implementer,
    contextValidator,
    collaboration: {
      ...collaboration,
      secondAgent: {
        ...collaboration.secondAgent,
        value: { ...retained, ...upgradeAgent(legacyAgent.data) },
      },
    },
  };
}

/**
 * Rewrites the legacy implementer and validator shapes inside an archived
 * execution blob into assignment shapes, in memory, all or nothing. Total by
 * construction: a blob that is already current, spans both generations, or is
 * malformed in a way the former shapes would themselves have refused passes
 * through unchanged for the canonical schema to accept or refuse.
 */
export function upgradeLegacyArchivedExecutionBlob(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const workingDefinition = raw.workingDefinition;
  if (!isRecord(workingDefinition)) return raw;
  const contexts = workingDefinition.executionContexts;
  if (!Array.isArray(contexts) || contexts.length === 0) return raw;

  const upgraded: Record<string, unknown>[] = [];
  for (const context of contexts) {
    const next = upgradeContext(context);
    if (next === undefined) return raw;
    upgraded.push(next);
  }

  return {
    ...raw,
    workingDefinition: {
      ...workingDefinition,
      executionContexts: upgraded,
    },
  };
}
