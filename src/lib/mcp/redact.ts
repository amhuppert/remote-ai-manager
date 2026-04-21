/**
 * View-facing redaction of secret values inside MCP canonical server configs.
 *
 * Applied before any canonical config leaves the server boundary — API
 * responses, structured logs, view models. Raw values remain inside the
 * discovery/resolver/composer pipeline so `configSignature` and backend
 * emission still see real values.
 */

import type { McpCanonicalServerConfig } from "./types";

/** Sentinel replacing every secret-bearing field value in view output. */
export const REDACTED_VALUE = "<redacted>";

function redactRecord(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    redacted[key] = REDACTED_VALUE;
  }
  return redacted;
}

export function redactConfigForView(
  config: McpCanonicalServerConfig,
): McpCanonicalServerConfig {
  if (config.transport === "stdio") {
    return {
      ...config,
      ...(config.env !== undefined ? { env: redactRecord(config.env) } : {}),
    };
  }
  if (config.transport === "streamable-http") {
    return {
      ...config,
      ...(config.headers !== undefined
        ? { headers: redactRecord(config.headers) }
        : {}),
    };
  }
  return {
    ...config,
    ...(config.headers !== undefined
      ? { headers: redactRecord(config.headers) }
      : {}),
  };
}
