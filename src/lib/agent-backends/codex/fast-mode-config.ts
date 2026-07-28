import type { CodexOptions } from "@openai/codex-sdk";

type CodexConfig = NonNullable<CodexOptions["config"]>;

function isCodexConfig(value: unknown): value is CodexConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withCodexFastMode(
  config: CodexOptions["config"] | undefined,
  fastMode: boolean,
): CodexConfig {
  const features = isCodexConfig(config?.features) ? config.features : {};

  return {
    ...config,
    service_tier: fastMode ? "fast" : "default",
    features: {
      ...features,
      fast_mode: fastMode,
    },
  };
}
