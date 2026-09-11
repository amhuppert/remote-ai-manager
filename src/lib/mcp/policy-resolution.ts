import type { McpEffectiveServerResolution } from "./resolver";
import type { McpNativeFilterFields } from "./types";

export function resolveEnabled(
  resolution: McpEffectiveServerResolution | undefined,
  native: McpNativeFilterFields | undefined,
): boolean | undefined {
  if (resolution?.enabledOriginLevel !== undefined) {
    return resolution.enabled;
  }
  if (native?.enabled !== undefined) {
    return native.enabled;
  }
  return undefined;
}

export function resolveToolFilters(
  resolution: McpEffectiveServerResolution | undefined,
  native: McpNativeFilterFields | undefined,
): { enabledTools?: readonly string[]; disabledTools?: readonly string[] } {
  const allowlist = native?.enabledTools?.length
    ? new Set(native.enabledTools)
    : undefined;
  const denied = new Set(native?.disabledTools ?? []);
  for (const name of resolution?.enabledTools ?? []) {
    allowlist?.add(name);
    denied.delete(name);
  }
  for (const name of resolution?.disabledTools ?? []) denied.add(name);
  return {
    ...(allowlist ? { enabledTools: [...allowlist] } : {}),
    ...(denied.size ||
    native?.disabledTools ||
    resolution?.enabledTools.length ||
    resolution?.disabledTools.length
      ? { disabledTools: [...denied] }
      : {}),
  };
}
