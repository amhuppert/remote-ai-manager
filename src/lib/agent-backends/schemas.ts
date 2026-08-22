import { z } from "zod";

export const claudeModelSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

/** Returns the default Claude model. */
export function getDefaultClaudeModel(): ClaudeModel {
  return "opus";
}

export const effortLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Claude-specific effort levels (subset of EffortLevel accepted by the Claude SDK). */
export const claudeEffortLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ClaudeEffortLevel = z.infer<typeof claudeEffortLevelSchema>;

const MODEL_EFFORT_LEVELS: Record<ClaudeModel, ClaudeEffortLevel[]> = {
  fable: ["low", "medium", "high", "xhigh", "max"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

/** Returns the effort levels supported by the given model. */
export function getEffortLevelsForModel(
  model: ClaudeModel,
): ClaudeEffortLevel[] {
  return MODEL_EFFORT_LEVELS[model];
}

/**
 * Clamps an effort level to the highest supported level for the given model.
 * Returns undefined if the model doesn't support effort levels at all.
 */
export function clampEffortToModel(
  effort: EffortLevel,
  model: ClaudeModel,
): ClaudeEffortLevel | undefined {
  const supported = MODEL_EFFORT_LEVELS[model];
  if (supported.length === 0) return undefined;
  const parsed = claudeEffortLevelSchema.safeParse(effort);
  if (parsed.success && supported.includes(parsed.data)) return parsed.data;
  return supported[supported.length - 1];
}

export function isClaudeReasoningEffortSupported(
  model: ClaudeModel,
  reasoningEffort: ClaudeEffortLevel,
): boolean {
  return MODEL_EFFORT_LEVELS[model].includes(reasoningEffort);
}

export function validateClaudeBackendModelEffort(
  config: {
    model?: ClaudeModel;
    reasoningEffort?: ClaudeEffortLevel;
  },
  context: z.RefinementCtx,
): void {
  if (
    config.model === undefined ||
    config.reasoningEffort === undefined ||
    isClaudeReasoningEffortSupported(config.model, config.reasoningEffort)
  ) {
    return;
  }

  context.addIssue({
    code: "custom",
    path: ["reasoningEffort"],
    message: `Reasoning effort "${config.reasoningEffort}" is not supported by Claude model "${config.model}".`,
  });
}

export const backendTimeoutMsSchema = z.number().int().positive().nullable();

const tokenCountSchema = z.number().int().nonnegative();

/**
 * Backend-neutral per-turn token accounting. Every count is required, so a
 * partially-known record is not representable: a backend that cannot report
 * usage reports the whole record as null rather than filling gaps with zeros.
 * `totalTokens` follows the provider convention of excluding reasoning tokens,
 * and an absent `reasoningTokens` means the backend reported none.
 */
export const conversationTokenUsageSchema = z.object({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  totalTokens: tokenCountSchema,
  reasoningTokens: tokenCountSchema.optional(),
});
export type ConversationTokenUsage = z.infer<
  typeof conversationTokenUsageSchema
>;

export const claudeBackendConfigSchema = z
  .object({
    model: claudeModelSchema,
    reasoningEffort: claudeEffortLevelSchema.optional(),
    timeoutMs: backendTimeoutMsSchema,
    /**
     * Per-turn inactivity bound override; unset falls back to the Claude
     * descriptor's default, explicit null disables the bound.
     */
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
  })
  .superRefine(validateClaudeBackendModelEffort);
export type ClaudeBackendConfig = z.infer<typeof claudeBackendConfigSchema>;

// ============================================================
// Codex Config
// ============================================================

export const codexModelSchema = z.enum([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
]);
export type CodexModel = z.infer<typeof codexModelSchema>;

/** Returns the default Codex model. */
export function getDefaultCodexModel(): CodexModel {
  return "gpt-5.4";
}

export const codexReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

/** USD per 1M tokens for one Codex model. */
export const codexModelPricingSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});
export type CodexModelPricing = z.infer<typeof codexModelPricingSchema>;

export const codexPricingTableSchema = z.record(
  z.string(),
  codexModelPricingSchema,
);
export type CodexPricingTable = z.infer<typeof codexPricingTableSchema>;

// ============================================================
// Codex Model Reasoning Levels
// ============================================================

// The GPT-5.6 "max" and "ultra" levels are exclusive to the Sol flagship; Terra
// and Luna expose only the standard low→xhigh range (verified against OpenAI's
// GPT-5.6 model docs, 2026-07). "minimal" is omitted from every model — Codex
// does not accept it for these models.
//
// Codex Spark's range was read off the Codex CLI's own reasoning-level picker
// (v0.147.0): Low / Medium / High (default) / Extra high, with no minimal and
// no max/ultra. Third-party write-ups claiming Spark takes no reasoning effort
// at all are wrong.
const CODEX_MODEL_REASONING_LEVELS: Record<string, CodexReasoningEffort[]> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
};

/**
 * Returns the reasoning effort levels supported by a Codex model.
 * Returns null for unknown models (all levels are allowed).
 */
export function getCodexReasoningLevelsForModel(
  model: string,
): CodexReasoningEffort[] | null {
  return CODEX_MODEL_REASONING_LEVELS[model] ?? null;
}

export function isCodexReasoningEffortSupported(
  model: string,
  reasoningEffort: CodexReasoningEffort,
): boolean {
  const supported = getCodexReasoningLevelsForModel(model);
  return supported === null || supported.includes(reasoningEffort);
}

export function validateCodexBackendModelEffort(
  config: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  },
  context: z.RefinementCtx,
): void {
  if (
    config.model === undefined ||
    config.reasoningEffort === undefined ||
    isCodexReasoningEffortSupported(config.model, config.reasoningEffort)
  ) {
    return;
  }

  context.addIssue({
    code: "custom",
    path: ["reasoningEffort"],
    message: `Reasoning effort "${config.reasoningEffort}" is not supported by Codex model "${config.model}".`,
  });
}

// ============================================================
// Cursor Config
// ============================================================

/**
 * The global Cursor backend profile (spec D10, D12.2).
 *
 * Deliberately narrower than the Claude and Codex profiles. There is no
 * `fastMode` — the speed toggle is Codex's and Cursor gets no copy of it — no
 * `pricing`, because Phase 1 reports `costUsd` null and estimating from tokens
 * would fabricate a figure, and no credential field of any kind: the SDK key
 * comes from the server's `CURSOR_API_KEY` environment variable and never from
 * a settings document. Membership validation for `model` belongs to the
 * adapter's model policy, which is the one place that knows the project's
 * effective supported list; this schema validates shape.
 *
 * `.strict()` rather than the tolerant default: an option this profile does not
 * declare is one Command Center will never read, and stripping it silently
 * tells the operator their setting took effect when nothing did. Cursor can
 * afford to fail closed because it is new — no config file already on disk can
 * carry a stray key under it. The Claude and Codex profiles shipped tolerant,
 * so tightening those is a separate migration decision, not a side effect of
 * registering a third backend.
 */
export const cursorBackendConfigSchema = z
  .object({
    model: z.string().trim().min(1),
    reasoningEffort: effortLevelSchema.optional(),
    timeoutMs: backendTimeoutMsSchema,
  })
  .strict();
export type CursorBackendConfig = z.infer<typeof cursorBackendConfigSchema>;

export const codexConfigSchema = z
  .object({
    model: z.string().trim().min(1),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    fastMode: z.boolean().default(false),
    timeoutMs: backendTimeoutMsSchema,
    /**
     * Per-turn inactivity bound override; unset falls back to the Codex
     * descriptor's default, explicit null disables the bound.
     */
    stallTimeoutMs: backendTimeoutMsSchema.optional(),
    pricing: codexPricingTableSchema.optional(),
  })
  .superRefine(validateCodexBackendModelEffort);
export type CodexConfig = z.infer<typeof codexConfigSchema>;
