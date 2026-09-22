import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRuntimeCapabilityConfig } from "./translator";
import { CLAUDE_NATIVE_MEMORY_SETTINGS } from "../native-memory";

/** One flag layer for launch and updates; host delivery remains authoritative. */
export function composeClaudeCapabilitySettings(
  config: ClaudeRuntimeCapabilityConfig | undefined,
  hostOverrides: Readonly<Record<string, boolean>>,
): Settings {
  return {
    ...CLAUDE_NATIVE_MEMORY_SETTINGS,
    enabledPlugins: { ...config?.enabledPlugins, ...hostOverrides },
    skillOverrides: config?.skillOverrides ?? {},
  };
}
