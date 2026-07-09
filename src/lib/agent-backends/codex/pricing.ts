/**
 * Cost estimation for Codex turns. The Codex SDK reports token usage only —
 * never USD — so recorded costs are computed here from published OpenAI API
 * rates. They are estimates: the long-context surcharge tier (requests above
 * ~272k input tokens) is not modeled, and users on ChatGPT-subscription auth
 * pay a flat rate, making the figure an API-equivalent estimate rather than
 * billed spend. Rates are overridable per model via `codex.pricing` in
 * config.json.
 */

import {
  getDefaultCodexModel,
  type CodexPricingTable,
} from "@/lib/agent-backends/schemas";

/**
 * Published OpenAI API rates (USD per 1M tokens, standard tier) as of
 * 2026-07. Cached input is billed at 10% of fresh input per OpenAI's
 * prompt-caching discount; the GPT-5.4-family cached rates apply that
 * published discount.
 */
export const DEFAULT_CODEX_PRICING: CodexPricingTable = {
  "gpt-5.6-sol": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
  },
  "gpt-5.5": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  },
  "gpt-5.4-nano": {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
  },
};

/** Token counts as reported by the Codex SDK's per-turn `Usage`. */
export interface CodexUsageTokens {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

/**
 * Estimate the USD cost of one Codex turn. Returns null when neither the
 * overrides nor the defaults price the model — never guesses a rate.
 * `cached_input_tokens` is the cached subset of `input_tokens` (SDK Usage
 * contract), so fresh input is priced as the difference.
 */
export function estimateCodexCostUsd(
  usage: CodexUsageTokens,
  modelId: string | undefined,
  overrides?: CodexPricingTable | null,
): number | null {
  const model = modelId ?? getDefaultCodexModel();
  const rates = overrides?.[model] ?? DEFAULT_CODEX_PRICING[model];
  if (rates === undefined) return null;

  const cachedInput = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const freshInput = usage.input_tokens - cachedInput;
  return (
    (freshInput * rates.inputPerMillion +
      cachedInput * rates.cachedInputPerMillion +
      usage.output_tokens * rates.outputPerMillion) /
    1_000_000
  );
}
