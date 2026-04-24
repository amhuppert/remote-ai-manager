import { createHash } from "node:crypto";

import type { McpCanonicalServerConfig } from "./types";

export function signatureFor(config: McpCanonicalServerConfig): string {
  const normalized = stableStringify(config);
  return createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(
    ([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`,
  );
  return `{${parts.join(",")}}`;
}
