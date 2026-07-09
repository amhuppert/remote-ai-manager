import { z } from "zod";
import type { AgentBackendId } from "@/lib/shared/schemas";

export const claudeModelSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

/** Returns the default Claude model. */
export function getDefaultClaudeModel(): ClaudeModel {
  return "opus";
}

export const agentSessionRefSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("claude"), sessionId: z.string() }),
  z.object({ backend: z.literal("codex"), threadId: z.string() }),
]);
export type AgentSessionRef = z.infer<typeof agentSessionRefSchema>;

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

const MODEL_EFFORT_LEVELS: Record<ClaudeModel, EffortLevel[]> = {
  fable: ["low", "medium", "high", "xhigh", "max"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

/** Returns the effort levels supported by the given model. */
export function getEffortLevelsForModel(model: ClaudeModel): EffortLevel[] {
  return MODEL_EFFORT_LEVELS[model];
}

/**
 * Clamps an effort level to the highest supported level for the given model.
 * Returns undefined if the model doesn't support effort levels at all.
 */
export function clampEffortToModel(
  effort: EffortLevel,
  model: ClaudeModel,
): EffortLevel | undefined {
  const supported = MODEL_EFFORT_LEVELS[model];
  if (supported.length === 0) return undefined;
  if (supported.includes(effort)) return effort;
  return supported[supported.length - 1];
}

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

export const codexConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().optional().default("gpt-5.4"),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  timeoutMs: z.number().positive().nullable().optional(),
  pricing: codexPricingTableSchema.optional(),
});
export type CodexConfig = z.infer<typeof codexConfigSchema>;

// ============================================================
// Codex Model Reasoning Levels
// ============================================================

// The GPT-5.6 "max" and "ultra" levels are exclusive to the Sol flagship; Terra
// and Luna expose only the standard low→xhigh range (verified against OpenAI's
// GPT-5.6 model docs, 2026-07). "minimal" is omitted from every model — Codex
// does not accept it for these models.
const CODEX_MODEL_REASONING_LEVELS: Record<string, CodexReasoningEffort[]> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
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

/**
 * Returns the canonical default model for a backend. Callers must resolve the
 * default this way rather than indexing a display-ordered option list — model
 * ordering is a UI concern and does not encode which model is the default.
 */
export function getDefaultModelForBackend(backend: AgentBackendId): string {
  return backend === "codex" ? getDefaultCodexModel() : getDefaultClaudeModel();
}

/**
 * Returns effort/reasoning levels for the given backend and optional model.
 * Both Claude and Codex levels are subsets of the unified EffortLevel union.
 */
export function getEffortLevelsForBackend(
  backend: AgentBackendId,
  model?: string,
): EffortLevel[] {
  if (backend === "codex") {
    const levels = getCodexReasoningLevelsForModel(model ?? "gpt-5.4");
    return (levels ?? [...codexReasoningEffortSchema.options]) as EffortLevel[];
  }
  return getEffortLevelsForModel((model ?? "opus") as ClaudeModel);
}
