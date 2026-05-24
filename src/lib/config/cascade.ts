import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeConfigWithDefaults<T>(defaults: T, overrides: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) {
    return (overrides === undefined ? defaults : overrides) as T;
  }

  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = mergeConfigWithDefaults(result[key], value);
  }
  return result as T;
}

/**
 * Recursively intersect `validated` with only the keys present in `raw`.
 * For nested plain objects, recurse so that Zod-injected defaults inside
 * nested schemas (e.g. codexConfigSchema.enabled) are stripped.
 */
export function intersectKeys(raw: unknown, validated: unknown): unknown {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof validated !== "object" ||
    validated === null ||
    Array.isArray(raw) ||
    Array.isArray(validated)
  ) {
    return validated;
  }

  const rawObj = raw as Record<string, unknown>;
  const validObj = validated as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(rawObj)) {
    if (!(key in validObj)) continue;
    const rawVal = rawObj[key];
    const validVal = validObj[key];

    if (
      typeof rawVal === "object" &&
      rawVal !== null &&
      !Array.isArray(rawVal) &&
      typeof validVal === "object" &&
      validVal !== null &&
      !Array.isArray(validVal)
    ) {
      result[key] = intersectKeys(rawVal, validVal);
    } else {
      result[key] = validVal;
    }
  }

  return result;
}

/**
 * Resolve the branch prefix from per-project and global config.
 * Per-project overrides global. Falls back to "csm".
 */
export function resolveBranchPrefix(
  globalConfig: Pick<GlobalConfig, "branchPrefix">,
  repoConfig?: Pick<PerRepoConfig, "branchPrefix"> | null,
): string {
  return repoConfig?.branchPrefix ?? globalConfig.branchPrefix ?? "csm";
}
