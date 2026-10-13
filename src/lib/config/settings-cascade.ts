/**
 * The configuration cascade rule (design §2.4, §7.2): which tier's value a
 * setting takes, and where it came from. Pure and import-free, so the launch
 * resolver on the server and the template editor in the browser apply the same
 * rule.
 *
 * The nearest tier that sets a key wins, and its value replaces the farther
 * ones whole: a list or an object is never merged with another tier's. A key a
 * tier leaves absent (or undefined) falls through, so resetting a setting is
 * deleting it from that tier's patch. Null and false are values, not absence.
 */

export type SettingsTier = "global" | "template" | "context";

export interface ProvenancedSetting<T> {
  value: T;
  from: SettingsTier;
}

export type CascadedSettings<T extends object> = {
  [K in keyof T]-?: ProvenancedSetting<T[K]>;
};

interface SettingsTiers<T extends object> {
  /** Every key: the tier a setting falls back to when no nearer tier sets it. */
  global: T;
  /** Absent for a standalone launch, which has no template tier. */
  template?: Partial<T>;
  context?: Partial<T>;
}

function settingAt<T extends object, K extends keyof T>(
  tiers: SettingsTiers<T>,
  key: K,
): ProvenancedSetting<T[K]> {
  const context = tiers.context?.[key];
  if (context !== undefined) return { value: context, from: "context" };
  const template = tiers.template?.[key];
  if (template !== undefined) return { value: template, from: "template" };
  return { value: tiers.global[key], from: "global" };
}

export function cascadeSettings<T extends object>(
  tiers: SettingsTiers<T>,
): CascadedSettings<T> {
  const keys = Object.keys(tiers.global) as Array<keyof T>;
  // The global tier holds every key of T, so its keys enumerate the result's.
  return Object.fromEntries(
    keys.map((key) => [key, settingAt(tiers, key)]),
  ) as CascadedSettings<T>;
}
