import type { BackendModelParameterValueEmphasis } from "./schemas";

/**
 * Catalog-authoring vocabulary for the "exceeds the scale" presentation signal.
 *
 * Only catalog PRODUCERS call this — the static Claude/Codex catalog builder and
 * the Cursor generator. Neutral code and UI read the resulting
 * `BackendModelParameterValue.emphasis` instead, so no consumer has to know that
 * Cursor spells the same tier `xhigh` on its Claude models and `extra-high` on
 * its GPT models.
 */

/** Reasoning tiers every registered provider treats as above its normal range. */
const EXCEEDS_SCALE_VALUES: ReadonlySet<string> = new Set([
  "xhigh",
  "extra-high",
  "max",
  "ultra",
]);

/**
 * Parameter ids that carry a reasoning scale. Gated on the id because the tokens
 * above are not unique to reasoning — a future context-size parameter offering a
 * `max` value would otherwise inherit a signal that means nothing there.
 */
const REASONING_PARAMETER_IDS: ReadonlySet<string> = new Set([
  "effort",
  "reasoning",
]);

/** The emphasis a catalog should record for one parameter value, if any. */
export function reasoningValueEmphasis(
  parameterId: string,
  value: string,
): BackendModelParameterValueEmphasis | undefined {
  if (!REASONING_PARAMETER_IDS.has(parameterId)) return undefined;
  return EXCEEDS_SCALE_VALUES.has(value) ? "exceeds-scale" : undefined;
}
